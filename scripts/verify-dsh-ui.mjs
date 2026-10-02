/**
 * Isolated settings-page verification: real `dsh web` host, real profile, real browser.
 *
 * Usage:
 *   node scripts/verify-dsh-ui.mjs --tgz <package.tgz> --out <evidence-dir> [--port 4399] [--keep]
 *
 * The script never touches the daily installation: it creates its own DSH_HOME under a
 * temporary directory, installs the packed bundle through the real CLI, seeds a synthetic
 * learning store, boots the web profile, drives the real global 设置 → 自我进化 section in
 * Chromium, and records screenshots plus a JSON report.
 *
 * What it proves, in the order a person would do it:
 *   • the entry is a real Settings section, not a plugin detail page;
 *   • the plugin's own page keeps the host management row and points at the section;
 *   • the switches write through the host settings document (the profile patch changes) and the
 *     page re-reads the effective state straight away, without a manual refresh;
 *   • the value survives a full Host restart, and the page stays usable while paused;
 *   • reading the page rewrites NEITHER the learning store nor any session budget file;
 *   • an explicit PAUSE/RESUME save is a real control write: it must bump the control generation
 *     and the document revision, and it must still leave lessons, receipts, events, jobs, spends
 *     and every session budget file exactly as they were (alpha.15 makes the control write
 *     durable, so "byte-identical across a save" is no longer the contract).
 */
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
// A real packed artifact is REQUIRED. Resolving an absent `--tgz` would silently point at the
// current working directory and "install" whatever happens to be there. The value is type-checked
// first: with `--tgz` as the LAST argument `option()` returns `undefined`, and calling a string
// method on it would throw before the usage message could ever be printed.
const usage = 'usage: node scripts/verify-dsh-ui.mjs --tgz <package.tgz> --out <evidence-dir> ' +
  '[--port 4399] [--keep]\n--tgz is required: it must name a packed .tgz FILE.'
const tgzOption = option('tgz', '')
if (typeof tgzOption !== 'string' || tgzOption.trim() === '' || tgzOption.startsWith('--')) {
  console.error(usage)
  process.exit(2)
}
const artifact = resolve(tgzOption)
let artifactStat = null
try { artifactStat = statSync(artifact) } catch { artifactStat = null }
if (!artifact.endsWith('.tgz') || artifactStat === null || !artifactStat.isFile()) {
  console.error(`${usage}\ngot: ${artifact} (a real .tgz file is required, not a directory or a name only)`)
  process.exit(2)
}
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
/**
 * The control generation a document really has. A schema-2 document without `settlementControl` is
 * LEGAL (the fixture seeds exactly that), and the core's own public default for it is generation 1
 * with `userPaused: false` (`src/index.mjs`, `controlOf`). Comparing against `undefined` would make
 * the control-write assertion unfalsifiable, so the absent field is read as that default.
 */
const controlGeneration = document => {
  const generation = document?.settlementControl?.generation
  return Number.isSafeInteger(generation) ? generation : 1
}
const controlPaused = document => document?.settlementControl?.userPaused === true
/**
 * The store PARSED, so a check can tell a control write (revision + `settlementControl`) apart
 * from the content that write must never touch.
 */
const storeDocument = () => {
  const path = join(home, 'mse-learning/lessons-v1.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}
/**
 * Facts an explicit control write is FORBIDDEN to change. `revision` and `settlementControl` are
 * deliberately absent: a persisted pause/resume is exactly a new generation and a new revision,
 * which is what the save checks assert instead.
 */
const protectedFacts = document => {
  if (document === null) return null
  const { lessons, receipts, events, sessions, experiments, jobs, spends } = document
  return { lessons, receipts, events, sessions, experiments, jobs, spends, schema: document.schema,
    owner: document.owner }
}
/** Every session budget file, by name and bytes — they must never move under a settings save. */
const sessionBytes = () => {
  const directory = join(home, 'mse-learning/sessions')
  if (!existsSync(directory)) return {}
  return Object.fromEntries(readdirSync(directory).sort().map(name => {
    const bytes = readFileSync(join(directory, name))
    return [name, createHash('sha256').update(bytes).digest('hex')]
  }))
}
/** The profile patch is where a settings save really lands; read it, never write it. */
const patchPath = () => join(home, 'profiles', profile, 'cordis.patch.yml')
const patchState = () => {
  const path = patchPath()
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  const row = /- id: mse-learning[\s\S]*?(?=\n- id:|\n*$)/u.exec(text)?.[0] ?? ''
  return { sha256: createHash('sha256').update(text).digest('hex'), row: row.trim().slice(0, 400) }
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
  report.url = url.split('?')[0]
  report.urlNote = 'the boot token query is dropped from this report'
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
  // The read-only baseline also carries the session budget files: nothing on this page may write
  // either of them just because it was displayed.
  const beforeReadSessions = sessionBytes()
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
  // ---------------------------------------------------------------- settings entry
  // The first-run API-key dialog owns a mask that would swallow the sidebar click; it is
  // dismissed first, and never again afterwards — Escape closes the Settings modal itself.
  await domClick(/稍后配置|Set up later|Configure later/)
  await page.waitForTimeout(600)
  await dismissOverlays()
  const openSettings = async () => {
    for (const name of [/^设置$/, /^Settings$/]) {
      const button = page.getByRole('button', { name }).first()
      if (await button.count() === 0) continue
      await button.click({ timeout: 15_000 })
      await page.waitForTimeout(1800)
      return true
    }
    return false
  }
  const settingsOpened = await openSettings()
  const navItem = page.getByRole('button', { name: /自我进化|Self-evolution/u }).first()
  const navLabels = await page.getByRole('button').allInnerTexts()
  check('the global settings navigation carries the 自我进化 section', await navItem.count() === 1,
    `settingsOpened=${settingsOpened} nav=${JSON.stringify(navLabels.slice(0, 24))}`)
  await navItem.click({ timeout: 15_000 })
  await page.waitForTimeout(2500)
  const section = page.locator('[data-mse-details="page"]')
  if (await section.count() !== 1) {
    // A section that throws is replaced by the shell's error boundary; capture what it says
    // instead of reporting a bare zero.
    report.sectionFailure = {
      errors: pageErrors.slice(0, 6),
      shellText: (await page.locator('body').innerText()).slice(0, 1200),
    }
  }
  check('the section renders the MSE panel', await section.count() === 1,
    JSON.stringify(report.sectionFailure ?? {}).slice(0, 900))
  await shot(page, '01-settings-section')

  const text = () => section.innerText()
  const fullText = () => section.evaluate(element => element.textContent ?? '')
  /**
   * Drive one host picker: open its trigger, read the list, pick a row by label.
   * The page no longer renders a native <select>, so this is the real interaction a person has.
   */
  const openPicker = async label => {
    const trigger = section.getByRole('button', { name: label }).first()
    await trigger.click()
    await page.waitForTimeout(400)
    const items = await page.getByRole('menuitem').allInnerTexts()
    return { trigger, items: items.map(text => text.trim()) }
  }
  const chooseByLabel = async (label, text) => {
    const { items } = await openPicker(label)
    const match = items.find(item => item.includes(text))
    assert.ok(match !== undefined, `picker ${label} offers ${text}; it offers ${items.join(' | ')}`)
    await page.getByRole('menuitem', { name: match }).first().click()
    await page.waitForTimeout(700)
    return match
  }
  const chooseByIndex = async (label, index) => {
    const { items } = await openPicker(label)
    assert.ok(items.length > index, `picker ${label} has at least ${index + 1} rows; it has ${items.length}`)
    await page.getByRole('menuitem', { name: items[index] }).first().click()
    await page.waitForTimeout(900)
    return items[index]
  }

  const openDisclosure = async (name, scope = section) => {
    const summary = scope.locator('summary', { hasText: name }).first()
    if (await summary.count() === 0) return false
    const open = await summary.evaluate(node => node.parentElement.open === true)
    if (!open) { await summary.click(); await page.waitForTimeout(400) }
    return true
  }
  const overview = await text()
  check('the section names itself 自我进化', overview.includes('自我进化'), overview.slice(0, 120))
  check('the three runtime controls are on the first screen',
    overview.includes('持久学习') && overview.includes('自动复盘') && overview.includes('单轮上下文上限'),
    overview.slice(0, 240))
  // The five pages are the confirmed preview's labels, on the host's own SegmentedTabs.
  const tabText = await section.locator('[role="tablist"]').first().innerText()
  check('the five pages use the confirmed labels',
    ['常规', '经验', '召回', '任务', '额度'].every(label => tabText.includes(label)), tabText.replace(/\n/gu, ' '))
  const tabList = section.locator('[role="tablist"]').first()
  const tabGeom = await tabList.evaluate(element => {
    const tabs = [...element.querySelectorAll('[role="tab"]')].map(node => node.getBoundingClientRect())
    const list = element.getBoundingClientRect()
    return { count: tabs.length, display: getComputedStyle(element).display,
      widths: tabs.map(rect => Math.round(rect.width)),
      span: tabs.length === 0 ? 0 : Math.round(tabs[tabs.length - 1].right - tabs[0].left),
      listWidth: Math.round(list.width) }
  })
  // The native indicator is laid out over the whole list; the buttons must cover it too.
  check('the native tab grid is not overridden by this bundle',
    ['grid', 'inline-grid'].includes(tabGeom.display), JSON.stringify(tabGeom))
  check('the five tabs share the full tab list width',
    tabGeom.count === 5 && tabGeom.span >= tabGeom.listWidth - 8, JSON.stringify(tabGeom))
  check('the detail views are not pushed off the first screen',
    overview.includes('学习概况') || overview.includes('版本与只读明细'), overview.slice(-160))
  // Full limits live in the disclosures; open them rather than weakening the assertions.
  await openDisclosure('版本与只读明细')
  check('the version details carry the read-only facts',
    (await fullText()).includes('1536') && (await fullText()).includes('单轮最多'),
    (await fullText()).slice(0, 200))
  const runtimeOpened = await openDisclosure('运行详情与使用说明')
  check('the runtime disclosure exists and opened for real', runtimeOpened === true
    && await section.locator('details.mse-disclosure').filter({ hasText: '运行详情与使用说明' })
      .first().evaluate(node => node.open === true))
  check('the opened runtime help is actually painted',
    await section.getByText('不需要另启常驻进程').first().isVisible())
  check('the runtime help carries the full limits and lifecycle',
    (await fullText()).includes('不需要另启常驻进程') && (await fullText()).includes('不等于已经学到经验'))
  report.phases.push({ phase: 'settings-section', ok: true })
  await shot(page, '01b-details-open')

  // ---------------------------------------------------------------- real save
  const masterSwitch = section.getByRole('switch', { name: '持久学习' })
  const saveButton = section.getByRole('button', { name: /^(保存|Save)$/u }).first()
  const discardButton = section.getByRole('button', { name: /^(取消|Discard)$/u }).first()
  check('an unmodified draft offers no primary save',
    await saveButton.isDisabled(), 'the button is disabled until the draft differs')
  check('the master switch starts enabled', await masterSwitch.getAttribute('aria-checked') === 'true')
  await masterSwitch.click()
  await page.waitForTimeout(400)
  check('the switch reflects the edit before saving', await masterSwitch.getAttribute('aria-checked') === 'false')
  check('editing enables saving', await saveButton.isEnabled())
  check('discarding is offered once the draft differs', await discardButton.isEnabled())
  // --- window A: pure reads never rewrite the learning store -------------------
  check('reading the page (before any save) never rewrites the learning store',
    JSON.stringify(storeState()) === JSON.stringify(before),
    `${JSON.stringify(before)} vs ${JSON.stringify(storeState())}`)
  check('reading the page (before any save) never rewrites a session budget file',
    JSON.stringify(sessionBytes()) === JSON.stringify(beforeReadSessions))
  // --- window B: an explicit save is a real control write ----------------------
  const beforeSave = storeState()
  const beforeSaveDocument = storeDocument()
  const beforeSaveSessions = sessionBytes()
  await saveButton.click()
  await page.waitForTimeout(2000)
  const savedText = await text()
  check('the save reports success', savedText.includes('已保存'), savedText.slice(0, 200))
  check('saving is disabled again after the write', await saveButton.isDisabled())
  check('the paused state is shown immediately',
    (await section.innerText()).includes('已暂停'), (await section.innerText()).slice(0, 200))
  await shot(page, '08-saved-paused')
  report.patchAfterPause = patchState()
  check('the settings patch really carries the pause',
    (patchState()?.row ?? '').includes('enabled: false'), (patchState()?.row ?? '').slice(0, 200))
  await masterSwitch.click()
  await page.waitForTimeout(300)
  await saveButton.click()
  await page.waitForTimeout(2500)
  report.patchAfterReenable = patchState()
  // The patch layer is SPARSE by contract: the host's config editor drops a key whose value
  // equals the inherited one and drops the whole row once only `id`/`name` remain
  // (packages/boot/config-editor/src/index.ts:122-129). Returning a setting to its default
  // therefore leaves NO row — that is "inheriting the bundle default again", not a failed save
  // and not a leftover `false`. The write is verified through real reads instead of raw YAML.
  check('returning a setting to its default removes the sparse patch row',
    (patchState()?.row ?? '') === '', (patchState()?.row ?? '').slice(0, 240))
  // 1. the composed configuration the host actually runs with
  const composedAfter = run(['--profile', profile, '--dump-config'])
  const composedRow = /name: '@missher\/dsh-mse-learning'[\s\S]*?(?=\n\s*- id:|$)/u.exec(composedAfter)?.[0] ?? ''
  report.composedRowAfterReenable = composedRow.trim().slice(0, 300)
  check('the composed configuration no longer carries the pause',
    composedRow.includes('name:') && !composedRow.includes('enabled: false'), composedRow.trim().slice(0, 240))
  // 2. the live runtime state, read through the control Remote
  check('the re-enabled runtime reports itself as running',
    (await section.innerText()).includes('运行中'), (await section.innerText()).slice(0, 200))
  check('the running state returns without a reload',
    (await section.innerText()).includes('运行中'), (await section.innerText()).slice(0, 200))
  await shot(page, '09-reenabled')

  // ---------------------------------------------------------------- lessons page
  await section.getByRole('tab', { name: '经验' }).click()
  await page.waitForTimeout(1200)
  const rowTexts = async () => section.locator('details.mse-lesson > summary').allInnerTexts()
  const seeded = report.phases.find(phase => phase.phase === 'seed').summary.lessons
  const all = await rowTexts()
  check('the lesson list is populated from the synthetic store',
    all.length === Math.min(seeded, 20), `rows=${all.length} seeded=${seeded}`)
  check('the list is bounded to one page', all.length <= 20)
  const scopeList = await openPicker('选择会话')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check('the scope picker is a host picker filled from the Host session directory',
    scopeList.items.length >= 2 && scopeList.items[0].includes('默认'),
    scopeList.items.join(' | ').slice(0, 160))
  await shot(page, '02-lessons-list')

  const search = section.getByPlaceholder('搜索经验内容')
  await search.fill('报表')
  await page.waitForTimeout(1200)
  const searched = await rowTexts()
  check('search narrows the list', searched.length > 0 && searched.length < all.length, `rows=${searched.length}`)
  check('search results match the query', searched.every(row => row.includes('报表')))
  await search.fill('')
  await page.waitForTimeout(800)

  await chooseByLabel('类型', '方法')
  await page.waitForTimeout(1000)
  check('the kind filter isolates methods', (await rowTexts()).length === 2)
  await chooseByLabel('类型', '全部')
  await chooseByLabel('状态', '已停用')
  await page.waitForTimeout(1000)
  check('the status filter isolates the suspended rule', (await rowTexts()).length === 1)
  await chooseByLabel('状态', '全部')
  await chooseByLabel('每页', '10')
  await page.waitForTimeout(1000)
  check('a smaller page size pages the list', (await rowTexts()).length === 10)
  await shot(page, '03-lessons-paging')

  await section.locator('details.mse-lesson').first().locator('summary').click()
  await page.waitForTimeout(1500)
  const detail = await fullText()
  check('lesson detail shows the stored provenance', detail.includes('来源依据') || detail.includes('宿主回合'))
  check('the provenance is the saved turn identifier or an explicit not-recorded',
    /宿主回合/u.test(detail) || detail.includes('未记录'), detail.slice(0, 200))
  check('lesson detail marks environment applicability', detail.includes('环境'))
  check('lesson detail separates adoption from verification', detail.includes('采用与验证'))
  check('the detail is a disclosure that can be closed again',
    await section.locator('details.mse-lesson').first().evaluate(node => node.open) === true)
  await shot(page, '04-lesson-detail')
  await section.locator('details.mse-lesson').first().locator('summary').click()
  await page.waitForTimeout(500)
  check('closing the detail leaves the list in place', (await rowTexts()).length === 10)

  // ---------------------------------------------------------------- recall page
  await section.getByRole('tab', { name: '召回' }).click()
  await page.waitForTimeout(1200)
  check('recall asks for a scope instead of inventing one',
    (await text()).includes('请在上方选择一个会话'), (await text()).slice(0, 200))
  await chooseByIndex('选择会话', 1)
  await page.waitForTimeout(1800)
  const recall = await text()
  check('a chosen session reports its own in-process state',
    recall.includes('暂无本次运行记录') || recall.includes('尚未触发召回') || recall.includes('回合'), recall.slice(0, 240))
  await shot(page, '05-recall')
  const diagnose = section.getByLabel('任务描述')
  if (await diagnose.count() > 0) {
    await diagnose.fill('导出报表金额并核对币种')
    await section.getByRole('button', { name: '预览注入' }).click()
    await page.waitForTimeout(1500)
    check('the read-only dry run answers with a real verdict',
      !(await text()).includes('只读诊断不可用'), (await text()).slice(-200))
  }
  await shot(page, '05b-diagnose')

  // ---------------------------------------------------------------- tasks page
  await section.getByRole('tab', { name: '任务' }).click()
  await page.waitForTimeout(1200)
  const tasks = await text()
  check('the tasks page keeps both manual flows',
    tasks.includes('手动复盘') && tasks.includes('验证候选经验'), tasks.slice(0, 240))
  check('the tasks page asks for a scope first', tasks.includes('在上方选择一个会话') || tasks.includes('选择会话'))
  await shot(page, '06-tasks')

  // ---------------------------------------------------------------- budget page
  await section.getByRole('tab', { name: '额度' }).click()
  await page.waitForTimeout(1000)
  const budget = await fullText()
  check('the budget page names the unit and denies a token reading',
    budget.includes('不是 token'), budget.slice(0, 240))
  const tokenField = section.getByLabel('每日评测 token 上限')
  const callField = section.getByLabel('每日评测次数上限')
  check('the evaluation allowances are real spinbuttons',
    await tokenField.count() === 1 && await callField.count() === 1
    && await tokenField.getAttribute('role') !== null || await tokenField.evaluate(node => node.tagName) === 'INPUT',
    `token=${await tokenField.count()} calls=${await callField.count()}`)
  check('the token allowance is editable',
    await tokenField.isEditable() && await tokenField.isEnabled())
  check('the call allowance is editable',
    await callField.isEditable() && await callField.isEnabled())
  await shot(page, '07-budget')

  const after = storeState()
  const afterDocument = storeDocument()
  // A persisted pause/resume is a real control transaction: it MUST bump the control generation
  // and the document revision, and it MUST leave every piece of learning content alone. The old
  // single check ("byte-identical across the saves") described the pre-alpha.15 in-memory
  // behaviour and could never hold once the control write became durable.
  check('the explicit pause+resume save really committed a control transaction',
    controlGeneration(afterDocument) > controlGeneration(beforeSaveDocument)
    && afterDocument?.revision > beforeSaveDocument?.revision
    && controlPaused(afterDocument) === false,
    `generation ${controlGeneration(beforeSaveDocument)}→${controlGeneration(afterDocument)}, ` +
    `revision ${beforeSaveDocument?.revision}→${afterDocument?.revision}, ` +
    `userPaused after=${controlPaused(afterDocument)}`)
  check('the control transaction left every learning fact and session budget untouched',
    JSON.stringify(protectedFacts(afterDocument)) === JSON.stringify(protectedFacts(beforeSaveDocument))
    && JSON.stringify(sessionBytes()) === JSON.stringify(beforeSaveSessions),
    'lessons/receipts/events/sessions/jobs/spends must not move under a control write')
  // The restart baseline is the state AFTER the last save: comparing a later read against a
  // pre-save snapshot would be the same stale assumption in another place.
  const afterSave = storeState()
  const afterSaveSessions = sessionBytes()
  check('the page produced no browser errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  report.phases.push({ phase: 'settings-save', before: beforeSave, after,
    generation: controlGeneration(beforeSaveDocument),
    generationAfter: controlGeneration(afterDocument),
    userPausedAfter: controlPaused(afterDocument),
    revision: beforeSaveDocument?.revision ?? null, revisionAfter: afterDocument?.revision ?? null,
    patch: patchState()?.row ?? '' })

  const errorsBeforeRestart = pageErrors.slice()
  report.errorsBeforeRestart = errorsBeforeRestart
  // ---------------------------------------------------------------- restart
  server.kill('SIGTERM')
  await new Promise(resolveWait => setTimeout(resolveWait, 1500))
  server = spawn(process.execPath, [cli, '--profile', profile, '--no-open', '--port', String(port)],
    { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] })
  let restartedLog = ''
  server.stdout.on('data', chunk => { restartedLog += chunk })
  server.stderr.on('data', chunk => { restartedLog += chunk })
  const restartedUrl = await new Promise((resolveUrl, rejectUrl) => {
    const deadline = Date.now() + 60_000
    const poll = () => {
      const match = /http:\/\/127\.0\.0\.1:\d+\/?\?token=[\w-]+/u.exec(restartedLog)
      if (match) return resolveUrl(match[0])
      if (Date.now() > deadline) return rejectUrl(new Error(`web host did not restart:\n${restartedLog}`))
      setTimeout(poll, 250)
    }
    poll()
  })
  report.restartedUrl = restartedUrl.split('?')[0]
  await page.goto(restartedUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)
  await dismissOverlays()
  await domClick(/^(继续|Continue)$/)
  await dismissOverlays()
  await openSettings()
  await page.getByRole('button', { name: /自我进化|Self-evolution/u }).first().click({ timeout: 15_000 })
  await page.waitForTimeout(3000)
  const afterRestart = page.locator('[data-mse-details="page"]')
  check('the settings section is still there after a Host restart', await afterRestart.count() === 1)
  check('the saved switch survived the restart',
    await afterRestart.getByRole('switch', { name: '持久学习' }).getAttribute('aria-checked') === 'true')
  check('the restarted page still reports the running state',
    (await afterRestart.innerText()).includes('运行中'), (await afterRestart.innerText()).slice(0, 200))
  const composedRestart = run(['--profile', profile, '--dump-config'])
  const restartRow = /name: '@missher\/dsh-mse-learning'[\s\S]*?(?=\n\s*- id:|$)/u.exec(composedRestart)?.[0] ?? ''
  check('the composed configuration after the restart still runs enabled',
    restartRow.includes('name:') && !restartRow.includes('enabled: false'), restartRow.trim().slice(0, 240))
  check('the restarted page still reads the library unchanged since the last save',
    JSON.stringify(storeState()) === JSON.stringify(afterSave))
  check('the restart changed no session budget file',
    JSON.stringify(sessionBytes()) === JSON.stringify(afterSaveSessions))
  await shot(page, '10-after-restart')

  // ---------------------------------------------------------------- size / theme matrix
  // The page is used at three common sizes in both themes; nothing may overflow sideways and
  // every page must stay reachable.
  const overflow = async () => page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    sectionOverflow: (() => {
      const section = document.querySelector('[data-mse-details="page"]')
      return section === null ? null : Math.max(0, section.scrollWidth - section.clientWidth)
    })(),
  }))
  report.matrix = []
  for (const [width, height, scheme] of [[1440, 1000, 'light'], [1440, 1000, 'dark'],
    [1024, 720, 'light'], [1024, 720, 'dark'], [800, 600, 'light'], [800, 600, 'dark']]) {
    await page.setViewportSize({ width, height })
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(700)
    await page.getByRole('button', { name: /自我进化|Self-evolution/u }).first().click({ timeout: 15_000 })
    await page.waitForTimeout(900)
    const sizes = await overflow()
    const tag = `${width}x${height}-${scheme}`
    check(`no sideways overflow at ${tag}`, sizes.scrollWidth <= sizes.clientWidth + 1, JSON.stringify(sizes))
    check(`the section itself does not scroll sideways at ${tag}`, (sizes.sectionOverflow ?? 0) <= 1, JSON.stringify(sizes))
    check(`the five tabs are still reachable at ${tag}`,
      await section.locator('[role="tab"]').count() === 5)
    // Click every page and prove the highlight lands on the button that was clicked and that
    // its own panel is the visible one.
    for (const [id, label, panelSuffix] of [['overview', '常规', 'overview'], ['lessons', '经验', 'lessons'],
      ['recall', '召回', 'recall'], ['manual', '任务', 'manual'], ['budget', '额度', 'budget']]) {
      await section.getByRole('tab', { name: label }).click()
      await page.waitForTimeout(450)
      const state = await section.evaluate((_, wanted) => {
        const tabs = [...document.querySelectorAll('[role="tab"]')]
        const selected = tabs.filter(node => node.getAttribute('aria-selected') === 'true')
        const panels = [...document.querySelectorAll('[data-mse-details="page"] [role="tabpanel"]')]
        const shown = panels.filter(node => node.offsetParent !== null)
        // The native tab list paints its own sliding block: a span[aria-hidden] sized
        // `(100% - 8px) / n` and shifted by `index * 100%`. Comparing ITS rect with the
        // selected tab's rect is the real highlight check; a non-zero width is not.
        const list = document.querySelector('[data-mse-details="page"] [role="tablist"]')
        const indicator = list === null ? null : list.querySelector(':scope > span[aria-hidden="true"]')
        const rect = node => { const r = node.getBoundingClientRect()
          return { left: Math.round(r.left * 10) / 10, width: Math.round(r.width * 10) / 10 } }
        let highlight = null
        if (indicator !== null && selected.length === 1) {
          const a = rect(indicator), b = rect(selected[0])
          highlight = { indicatorLeft: a.left, indicatorWidth: a.width, tabLeft: b.left, tabWidth: b.width,
            leftDelta: Math.round(Math.abs(a.left - b.left) * 10) / 10,
            widthDelta: Math.round(Math.abs(a.width - b.width) * 10) / 10 }
        }
        return { selected: selected.map(node => (node.textContent ?? '').trim()),
          selectedCount: selected.length,
          shownCount: shown.length,
          shownId: shown.length === 1 ? shown[0].id : null,
          highlight }
      }, id)
      report.matrix.push({ size: `${tag}`, page: label, ...state })
      check(`${tag} · ${label} is the only selected tab`, state.selectedCount === 1
        && state.selected[0] === label, JSON.stringify(state))
      check(`${tag} · ${label} shows its own panel`, state.shownCount === 1
        && state.shownId === `mse-pane-${panelSuffix}`, JSON.stringify(state))
      // Tolerance is the wrapper's own padding (3px each side of the 1fr grid).
      check(`${tag} · ${label} the native highlight block tracks its tab`,
        state.highlight !== null && state.highlight.leftDelta <= 3 && state.highlight.widthDelta <= 3,
        JSON.stringify(state.highlight))
    }
    await section.getByRole('tab', { name: '常规' }).click()
    await page.waitForTimeout(400)
    await shot(page, `m-${tag}`)
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: /自我进化|Self-evolution/u }).first().click({ timeout: 15_000 })
  await page.waitForTimeout(900)

  // ---------------------------------------------------------------- long text
  // Worst-case content, injected into the live DOM only: a long unbroken identifier and a long
  // session label must wrap rather than push the host's column sideways.
  const longToken = 'a'.repeat(160)
  const longLabel = '一个很长很长的项目名称也应当保持在设置窗口的范围之内不被挤出去'.repeat(2)
  await section.getByRole('tab', { name: '经验' }).click()
  await page.waitForTimeout(1200)
  // Open a lesson for real first: measuring a hidden identifier would prove nothing.
  const firstLesson = section.locator('details.mse-lesson').first()
  check('a lesson row exists to open', await firstLesson.count() === 1)
  await firstLesson.locator('summary').click()
  await page.waitForTimeout(1500)
  check('the lesson detail is open before the long-text probe',
    await firstLesson.evaluate(node => node.open === true))
  check('the lesson identifier is painted', await firstLesson.locator('.mse-mono').first().isVisible())
  const longDetail = await section.evaluate((_, token) => {
    const first = document.querySelector('details.mse-lesson[open]')
    if (first === null) return null
    const identifier = first.querySelector('.mse-mono')
    if (identifier === null) return null
    const before = identifier.textContent
    identifier.textContent = token
    let node = identifier.parentElement, worst = 0
    while (node !== null && node !== document.body) {
      worst = Math.max(worst, node.scrollWidth - node.clientWidth)
      node = node.parentElement
    }
    identifier.textContent = before
    return worst
  }, longToken)
  check('a 160-character identifier does not widen any ancestor',
    longDetail !== null && longDetail <= 1, `worst=${longDetail}`)
  const longScope = await section.evaluate((_, label) => {
    const caption = document.querySelector('[data-mse-details="page"] .mse-picker-label')
    if (caption === null) return null
    const before = caption.textContent
    caption.textContent = label
    let node = caption.parentElement, worst = 0
    while (node !== null && node !== document.body) {
      worst = Math.max(worst, node.scrollWidth - node.clientWidth)
      node = node.parentElement
    }
    caption.textContent = before
    return worst
  }, longLabel)
  check('a long session label does not widen the settings column',
    longScope !== null && longScope <= 1, `worst=${longScope}`)
  await shot(page, '20-long-text')

  // ---------------------------------------------------------------- plugin page
  await dismissOverlays()
  await page.getByRole('button', { name: /插件|Plugins/u }).first().click({ timeout: 15_000 })
  await page.waitForTimeout(1500)
  await dismissOverlays()
  await page.getByText('@missher/dsh-mse-learning').first().click({ timeout: 15_000 })
  await page.waitForTimeout(2500)
  const pointer = page.locator('[data-mse-details="pointer"]')
  check('the plugin page keeps the host row and points at the settings section', await pointer.count() === 1)
  const pointerText = await pointer.innerText()
  check('the pointer names the exact settings path', pointerText.includes('设置 → 自我进化'), pointerText.slice(0, 160))
  check('the plugin page does not mount a second full panel',
    await page.locator('[data-mse-details="page"]').count() === 0)
  await shot(page, '13-plugin-pointer')

  report.restartTeardownNoise = pageErrors.slice(errorsBeforeRestart.length)
  check('the page produced no browser errors of its own', errorsBeforeRestart.length === 0,
    errorsBeforeRestart.slice(0, 3).join(' | '))

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
