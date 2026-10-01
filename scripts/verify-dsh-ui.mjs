/**
 * Isolated detail-page verification: real `dsh web` host, real profile, real browser.
 *
 * Usage:
 *   node scripts/verify-dsh-ui.mjs --tgz <package.tgz> --out <evidence-dir> [--port 4399] [--keep]
 *
 * The script never touches the daily installation: it creates its own DSH_HOME under a
 * temporary directory, installs the packed bundle through the real CLI, seeds a synthetic
 * learning store, boots the web profile, drives 设置 → 插件 → MSE → 学习详情 in Chromium and
 * records screenshots plus a JSON report. It also hashes the learning store before and after
 * every page interaction, which is the read-only evidence.
 */
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const artifact = resolve(option('tgz', ''))
const out = resolve(option('out', join(tmpdir(), 'mse-ui-evidence')))
const port = Number(option('port', '4399'))
const keep = args.includes('--keep')
const source = process.env.MSE_DSH_SOURCE
  ?? '/Users/missher/Documents/Projects/03-DeepSeek-Harness/升级候选/cordis-0.2.0-rc.2-20260930'
// Host packages the bundle's Host half imports (cordis, the Typert protocol, dsh-llm) are
// provided by the application, not by the profile: the temporary home is seated under a root
// whose node_modules stands in for the installed app's tree, exactly as a real install sees it.
const hostModules = process.env.MSE_DSH_HOST_MODULES ?? ''
const playwrightRequire = createRequire(process.env.MSE_PLAYWRIGHT_ANCHOR
  ?? '/Users/missher/Documents/Projects/03-DeepSeek-Harness/源码仓库/Deepseek-harness-Cordis/plugins/dsh-usage-statistics/package.json')
const cli = join(source, 'apps/cli/lib/bin.js')
assert.ok(existsSync(artifact), `artifact exists: ${artifact}`)
assert.ok(existsSync(cli), `DSH CLI exists: ${cli}`)
mkdirSync(out, { recursive: true })

const work = mkdtempSync(join(tmpdir(), 'mse-ui-verify-'))
const home = join(work, 'home')
if (hostModules !== '' && existsSync(hostModules)) symlinkSync(resolve(hostModules), join(work, 'node_modules'), 'dir')
const profile = 'mse-ui'
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
const run = command => execFileSync(process.execPath, [cli, ...command], { env, cwd: work, encoding: 'utf8', timeout: 300_000 })
const report = { artifact, work, profile, phases: [], screenshots: [], assertions: [], modelCalls: 0 }
const shot = async (page, name) => {
  const file = join(out, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  report.screenshots.push(file)
  return file
}
const storeState = () => {
  const path = join(home, 'mse-learning/lessons-v1.json')
  if (!existsSync(path)) return null
  const bytes = readFileSync(path)
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, mtimeMs: statSync(path).mtimeMs }
}
const check = (name, value, detail) => {
  report.assertions.push({ name, ok: value === true, detail })
  assert.equal(value, true, `${name}${detail === undefined ? '' : ` (${detail})`}`)
}

let server
try {
  mkdirSync(home, { recursive: true })
  run(['--profile', profile, '--from-default-profile', 'web', '--dump-config'])
  const install = run(['plugin', '--profile', profile, 'add', artifact, '--offline'])
  report.phases.push({ phase: 'install', ok: /Done in/u.test(install) || install.length > 0 })
  const composed = run(['--profile', profile, '--dump-config'])
  check('installed row names the bundle package', composed.includes("name: '@missher/dsh-mse-learning'"))

  // Synthetic store: 14 live corrections, 2 methods (one validated, one candidate), 1
  // suspended, 2 written with a past clock so they read as expired.
  const seed = spawn(process.execPath, [join(here, 'scripts/seed-ui-fixture.mjs'), join(home, 'mse-learning')],
    { encoding: 'utf8' })
  let seedOut = ''
  seed.stdout.on('data', chunk => { seedOut += chunk })
  await new Promise((resolveSeed, rejectSeed) => {
    seed.on('exit', code => code === 0 ? resolveSeed() : rejectSeed(new Error(`seed failed: ${code} ${seedOut}`)))
  })
  report.phases.push({ phase: 'seed', summary: JSON.parse(seedOut.trim().split('\n').at(-1)) })

  server = spawn(process.execPath, [cli, '--profile', profile, '--no-open', '--port', String(port)],
    { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  server.stdout.on('data', chunk => { log += chunk })
  server.stderr.on('data', chunk => { log += chunk })
  const url = await new Promise((resolveUrl, rejectUrl) => {
    const deadline = Date.now() + 60_000
    const poll = () => {
      const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/u.exec(log)
      if (match) return resolveUrl(match[0])
      if (Date.now() > deadline) return rejectUrl(new Error(`web host did not start:\n${log}`))
      setTimeout(poll, 250)
    }
    poll()
  })
  report.url = url
  report.phases.push({ phase: 'boot', ok: true })

  const { chromium } = playwrightRequire('playwright')
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(String(error).slice(0, 300)))
  page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text().slice(0, 200)) })

  /** Host-owned overlays are dismissed at DOM level so their mask cannot swallow clicks. */
  const domClick = async pattern => {
    const button = page.getByRole('button', { name: pattern }).first()
    if (await button.count() === 0) return false
    await button.evaluate(element => element.click())
    await page.waitForTimeout(400)
    return true
  }

  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  // Host-owned first-run overlays: dismissed at DOM level, never through the page under test.
  await domClick(/^(继续|Continue)$/)
  const graph = await page.evaluate(() => (globalThis.__DSH_BOOT__?.entries ?? []).map(row => row.id))
  check('the client half is in the boot module graph', graph.includes('@missher/dsh-mse-learning'),
    JSON.stringify(graph.filter(id => id.includes('mse'))))
  report.phases.push({ phase: 'client-module', modules: graph.length })
  await domClick(/稍后配置|Set up later|Configure later/)
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await page.locator('[role="presentation"]').count() === 0) break
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
  }
  report.phases.push({ phase: 'shell', overlays: await page.locator('[role="presentation"]').count() })

  // One chat turn so this process observed a session (the model itself is not configured).
  // A shell that refuses the turn is fine: the recall tab then reports its honest empty state.
  try {
    const composer = page.locator('[contenteditable="true"], textarea').first()
    await composer.waitFor({ timeout: 8000 })
    await composer.click()
    await page.keyboard.type('导出报表金额并核对币种')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(5000)
    report.phases.push({ phase: 'chat-turn', ok: true })
  } catch (error) {
    report.phases.push({ phase: 'chat-turn', ok: false, detail: String(error).slice(0, 120) })
  }
  await shot(page, '01-host-chat-turn')

  const before = storeState()
  // Any host dialog raised by the turn (for example "no model configured") owns a mask that
  // would swallow the navigation click; clear overlays before each step of the page under test.
  const dismissOverlays = async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      if (await page.locator('[role="presentation"]').count() === 0) return true
      const closed = await domClick(/稍后配置|Set up later|Configure later|关闭|Close|我知道了|Got it|继续|Continue/)
      if (!closed) await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    }
    return (await page.locator('[role="presentation"]').count()) === 0
  }
  await dismissOverlays()
  await page.getByRole('button', { name: /插件|Plugins/ }).first().click({ timeout: 15_000 })
  await page.waitForTimeout(1500)
  await dismissOverlays()
  await page.getByText('@missher/dsh-mse-learning').first().click({ timeout: 15_000 })
  await page.waitForTimeout(2500)
  const section = page.locator('[data-mse-details="page"]')
  check('the MSE bundle page carries the read-only details section', await section.count() === 1)
  // The picker reads the Host's own session directory, so it fills without page-local state.
  const pickerOptions = await section.locator('select[aria-label="选择会话"] option').allTextContents()
  check('the scope picker is filled from the Host session directory',
    pickerOptions.length >= 2 && pickerOptions[0].includes('默认'), pickerOptions.join(' | ').slice(0, 160))
  await shot(page, '02-plugin-detail-overview')

  const text = () => section.innerText()
  const overview = await text()
  check('overview shows the bundle version', overview.includes('0.9.0-alpha.10'), overview.slice(0, 120))
  check('overview labels both byte budgets with their unit',
    overview.includes('单轮上限') && overview.includes('会话上限') && /768 B/u.test(overview) && /1536 B/u.test(overview),
    overview.slice(0, 300))
  check('overview separates plugin state from learned state',
    overview.includes('不等于已经学到经验') || overview.includes('不等于'), overview.slice(0, 200))
  report.phases.push({ phase: 'overview', ok: true })

  await section.getByRole('tab', { name: '经验' }).click()
  await page.waitForTimeout(1200)
  const rowTexts = async () => section.locator('tbody tr').allInnerTexts()
  const seeded = report.phases.find(phase => phase.phase === 'seed').summary.lessons
  const all = await rowTexts()
  check('the lesson list is populated from the synthetic store',
    all.length === Math.min(seeded, 20), `rows=${all.length} seeded=${seeded}`)
  check('the list is bounded to one page', all.length <= 20)
  await shot(page, '03-lessons-list')

  const search = section.getByPlaceholder('搜索正文')
  await search.fill('报表')
  await page.waitForTimeout(1200)
  const searched = await rowTexts()
  check('search narrows the list', searched.length > 0 && searched.length < all.length, `rows=${searched.length}`)
  check('search results match the query', searched.every(row => row.includes('报表')))
  await shot(page, '04-lessons-search')

  await search.fill('')
  await page.waitForTimeout(800)
  await section.getByLabel('类型').selectOption('method')
  await page.waitForTimeout(1000)
  const methods = await rowTexts()
  check('the kind filter isolates methods', methods.length === 2, `rows=${methods.length}`)
  await shot(page, '05-lessons-kind-filter')

  await section.getByLabel('类型').selectOption('')
  await section.getByLabel('状态').selectOption('suspended')
  await page.waitForTimeout(1000)
  const suspended = await rowTexts()
  check('the status filter isolates the suspended rule', suspended.length === 1, `rows=${suspended.length}`)
  await shot(page, '06-lessons-status-filter')

  await section.getByLabel('状态').selectOption('')
  await section.getByLabel('每页').selectOption('10')
  await page.waitForTimeout(1000)
  const pageOne = await rowTexts()
  check('a smaller page size pages the list', pageOne.length === 10, `rows=${pageOne.length}`)
  await section.getByRole('button', { name: '下一页' }).click()
  await page.waitForTimeout(1000)
  const pageTwo = await rowTexts()
  check('paging moves to the next window',
    pageTwo.length > 0 && pageTwo[0] !== pageOne[0], `first=${pageTwo[0]?.slice(0, 20)}`)
  await shot(page, '07-lessons-paging')

  await section.locator('tbody tr').first().click()
  await page.waitForTimeout(1200)
  const detail = await text()
  check('lesson detail shows the stored provenance', detail.includes('来源依据') && detail.includes('宿主回合'))
  check('the provenance is the saved turn identifier or an explicit not-recorded',
    /宿主回合 [a-f0-9]{12}/u.test(detail) || detail.includes('未记录'), detail.slice(0, 200))
  check('lesson detail marks environment applicability', detail.includes('环境'))
  check('lesson detail separates adoption from verification', detail.includes('采用与验证'))
  await shot(page, '08-lesson-detail')
  await section.getByRole('button', { name: '返回列表' }).click()
  await page.waitForTimeout(800)

  await section.getByRole('tab', { name: '召回' }).click()
  await page.waitForTimeout(1200)
  const recallUnselected = await text()
  check('recall asks for a scope instead of inventing one', recallUnselected.includes('请在上方选择一个会话'))
  await section.getByLabel('选择会话').selectOption({ index: 1 })
  await page.waitForTimeout(1800)
  const recall = await text()
  check('a chosen session shows its own scope line and in-process state',
    recall.includes('作用域') && (recall.includes('本次运行的最近轮次') || recall.includes('暂无本次运行记录')))
  check('the recall view never claims another session', !recall.includes('未记录 结算'))
  await shot(page, '09-recall')

  await section.getByRole('tab', { name: '预算' }).click()
  await page.waitForTimeout(800)
  const budget = await text()
  check('budget names the unit and denies a token reading',
    budget.includes('768 B') && budget.includes('1536 B') && budget.includes('不是 token'))
  check('budget shows the selected session ledger instead of a dash',
    /\d+ B \/ 1536 B/u.test(budget) && budget.includes('当前会话剩余'), budget.slice(0, 200))
  check('budget explains the non-injection reasons', budget.includes('预算不足') && budget.includes('方法未验证'))
  await shot(page, '10-budget')

  await section.getByRole('tab', { name: '总览' }).click()
  await section.getByRole('button', { name: '刷新' }).click()
  await page.waitForTimeout(1800)
  check('refresh re-reads without an error banner', !(await text()).includes('读取失败'))
  check('refresh keeps the page rendered', await section.count() === 1)

  const after = storeState()
  check('page reads never rewrite the learning store', JSON.stringify(before) === JSON.stringify(after),
    `${JSON.stringify(before)} vs ${JSON.stringify(after)}`)
  check('the page produced no browser errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  report.phases.push({ phase: 'read-only', before, after })
  await shot(page, '11-final-overview')

  await browser.close()
  report.ok = report.assertions.every(row => row.ok)
} catch (error) {
  report.ok = false
  report.error = String(error?.stack ?? error).slice(0, 2000)
} finally {
  if (server !== undefined) server.kill('SIGTERM')
  await new Promise(resolveWait => setTimeout(resolveWait, 800))
  writeFileSync(join(out, 'ui-report.json'), JSON.stringify(report, null, 2) + '\n')
  if (!keep) rmSync(work, { recursive: true, force: true })
  else console.log(`kept work dir: ${work}`)
}
console.log(JSON.stringify({ ok: report.ok, url: report.url, assertions: report.assertions.length,
  failed: report.assertions.filter(row => !row.ok).map(row => row.name), screenshots: report.screenshots.length,
  error: report.error?.split('\n')[0] ?? null, report: join(out, 'ui-report.json') }, null, 2))
process.exit(report.ok === true ? 0 : 1)
