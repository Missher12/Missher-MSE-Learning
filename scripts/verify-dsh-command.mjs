/**
 * `/mse` command regression through the host's REAL client claim path and REAL executor.
 *
 * Usage: node scripts/verify-dsh-command.mjs <host-node_modules> [--out <json>]
 *
 * The defect this covers: the host's client command runtime only claims an *argued* slash line
 * when the definition declares `input` (`packages/client/ui-commands/src/client/service.ts`,
 * `matchEnter`). The plugin registered `definitionId/name/description/handler` only, so
 * `/mse why` was handed to the model as ordinary chat while a bare `/mse` worked — even though
 * `COMMAND_USAGE` advertised `why`, `detail` and `now <task>`.
 *
 * Nothing here re-implements the dispatcher. It drives the host's own `CommandUiRuntime` for
 * the decision and the host's own `CommandRuntime` for the execution, with only the transport
 * between them faked; the descriptor under test is the one the plugin actually registers.
 */

import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const modules = resolve(args[0] ?? '')
const outIndex = args.indexOf('--out')
const out = outIndex === -1 ? null : resolve(args[outIndex + 1])
assert.ok(existsSync(modules), `host node_modules exists: ${modules}`)

const results = []
const check = (name, value, detail) => {
  results.push({ name, ok: value === true, detail })
  assert.equal(value, true, `${name}${detail === undefined ? '' : ` (${detail})`}`)
}
const load = name => import(new URL(`@deepseek-ai/${name}/lib/index.js`, `file://${modules}/`).href)

/** The browser bundle the shell evaluates, with the platform's own module table faked. */
function loadClientBundle(pkg) {
  const require = createRequire(join(modules, '@deepseek-ai', pkg, 'package.json'))
  const path = join(modules, '@deepseek-ai', pkg, 'lib/client.js')
  const source = readFileSync(path, 'utf8')
  let registration
  const window = { __ModuleLoader__: { load: value => { registration = value } } }
  // The shell resolves these from its static module table, so they never come from
  // node_modules here either; only the symbols this bundle names have to exist.
  const primitives = new Proxy({}, { get: (_target, key) => (key === 'rankByName'
    ? (query, rows) => rows
    : () => null) })
  const table = {
    '@deepseek-ai/cordis': require('@deepseek-ai/cordis'),
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
    '@deepseek-ai/dsh-client-store': require('@deepseek-ai/dsh-client-store'),
    react: require('react'),
    'react/jsx-runtime': require('react/jsx-runtime'),
  }
  // The bundle injects its own stylesheet at evaluation time, so the document needs just
  // enough surface for that one guarded call.
  const styleTags = []
  const documentStub = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, setAttribute: () => {}, remove: () => {} }),
    head: { appendChild: tag => styleTags.push(tag), append: tag => styleTags.push(tag) },
    body: { appendChild: () => {}, append: () => {} },
    documentElement: { getAttribute: () => null, hasAttribute: () => false, style: { setProperty: () => {} } },
    addEventListener: () => {}, removeEventListener: () => {},
  }
  // eslint-disable-next-line no-new-func -- the bundle is a browser script by contract.
  new Function('window', 'document', 'setInterval', 'clearInterval', source)(window, documentStub,
    setInterval, clearInterval)
  assert.ok(registration, `${pkg} registers itself with the module loader`)
  return registration.factory(name => {
    if (!(name in table)) throw new Error(`unstubbed module ${name}`)
    return table[name]
  })
}

const work = mkdtempSync(join(tmpdir(), 'mse-command-'))
try {
  // --- the package staged beside the host tree, exactly as a real install sees it ---
  const stage = join(work, 'package')
  mkdirSync(stage, { recursive: true })
  for (const entry of ['src', 'adapters', 'package.json', 'cordis.patch.yml']) {
    cpSync(join(here, entry), join(stage, entry), { recursive: true })
  }
  symlinkSync(modules, join(stage, 'node_modules'), 'dir')
  const { LearningEngine } = await import(new URL('./src/index.mjs', `file://${stage}/`).href)
  const { createHarnessBridge } = await import(new URL('./adapters/harness.mjs', `file://${stage}/`).href)
  const { mseCommandDefinition } = await import(new URL('./adapters/dsh/index.mjs', `file://${stage}/`).href)

  const { Context: Cordis } = await load('cordis')
  const sessionModule = await load('dsh-session')
  const SessionStore = sessionModule.default
  const { SessionId } = sessionModule
  const CommandRuntime = (await load('dsh-commands')).default
  const { parseCommand } = await load('dsh-commands')
  const { createScope } = await load('dsh-scope')
  const { RemoteError } = await import(new URL('@deepseek-ai/dsh-typert-protocol/lib/index.js', `file://${modules}/`).href)
  const { CommandUiRuntime } = loadClientBundle('dsh-client-ui-commands')

  // --- a real engine + bridge: the command must stay read-only ---
  const stateRoot = join(work, 'learning')
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh' })
  const bridge = createHarnessBridge({ engine, environmentId: undefined })
  const definition = mseCommandDefinition(bridge)
  // `MSE_CMD_DEFINITION_MODE=legacy` runs the SAME harness against the descriptor shape the
  // previous release registered (no `input`), which is how the before/after pair is produced.
  const legacyMode = process.env.MSE_CMD_DEFINITION_MODE === 'legacy'
  const primary = legacyMode ? { ...definition, input: undefined } : definition
  check(legacyMode
    ? 'the legacy descriptor shape carries no input declaration (pre-fix baseline)'
    : 'the registered definition declares free-form input',
  legacyMode ? primary.input === undefined
    : (typeof primary.input?.hint === 'string' && primary.input.hint.length > 0),
  JSON.stringify(primary.input))

  const ctx = new Cordis()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)

  // --- host side: one agent whose session owns the command lifecycle ---
  const sessionId = 's1'
  const session = ctx.sessions.create(SessionId(sessionId))
  const agent = { id: session.id, session }
  let scope
  const scopeFiber = ctx.plugin(Object.assign(inner => { scope = createScope(inner, agent) }, { inject: ['commands'] }))
  if (typeof scopeFiber.await === 'function') await scopeFiber.await()
  assert.ok(scope !== undefined && scope.ctx.commands !== undefined,
    'the scoped fiber resolved with the commands service visible')
  // `createScope` returns a Scope whose `.ctx` carries the agent-scoped registry.
  const scoped = scope.ctx.commands
  // The very definition the plugin registers — not a copy written for the test.
  scoped.register(primary)
  // Counterexample kept in the same catalog: the identical shape WITHOUT `input`, which is
  // what the plugin registered before the fix. The client directory caches one snapshot per
  // session, so both must be registered before the catalog is first pulled.
  scoped.register({ ...definition, definitionId: 'missher-dsh-mse-learning/legacy',
    name: 'mselegacy', input: undefined, ...(legacyMode ? { name: 'mselegacy2' } : {}) })
  const lifecycle = () => session.snapshotEvents()
    .filter(event => event.type === 'command/run' || event.type === 'command/done')
    .map(event => ({ type: event.type, data: event.data }))
  const chatEvents = () => session.snapshotEvents()
    .filter(event => event.type === 'user/message' || event.type === 'turn/start')
  const storeFile = () => join(stateRoot, 'lessons-v1.json')
  const storeDigest = () => existsSync(storeFile())
    ? createHash('sha256').update(readFileSync(storeFile())).digest('hex') : null

  // --- client side: the host's real CommandUiRuntime, transport faked ---
  const registered = new Map()
  const executeCalls = []
  const listCalls = []
  const carried = async produce => {
    try { return { ok: true, value: await produce() } } catch (error) {
      return { ok: false, error: new RemoteError('gateway/internal', String(error?.message ?? error), {}) }
    }
  }
  const commandsRemote = {
    list: async id => {
      listCalls.push(id)
      // The real catalog the host would send for this agent.
      return await carried(async () => scoped.list(agent).map(row => ({
        name: row.name, description: row.description, ...(row.input === undefined ? {} : { input: row.input }),
      })))
    },
    execute: async (id, line, attachments = []) => {
      executeCalls.push({ sessionId: id, line, attachments: attachments.length })
      // The REAL executor, with its real lifecycle events on the real session.
      return await carried(async () => {
        const result = await scoped.execute(agent, line, attachments, new AbortController().signal)
        return result === undefined ? undefined : { commandId: result.commandId, result: result.result }
      })
    },
  }
  ctx.provide('inputTriggers', { registerSource: source => { registered.set(`${source.trigger} ${source.name}`, source); return () => registered.delete(`${source.trigger} ${source.name}`) } })
  ctx.provide('locale', { bind: ns => (key, params) => `${ns}:${key}${params === undefined ? '' : JSON.stringify(params)}` })
  // The host's own spec uses TestSessions here; that package cannot be loaded outside the
  // source tree, so the session directory is doubled instead. Nothing about the dispatcher
  // under test changes: `matchEnter` never consults it on the paths exercised below.
  const notices = []
  // SessionStore already owns the `sessions` key, so the session-directory double the client
  // runtime expects (the host's own spec injects TestSessions here) is attached to that
  // instance instead of being registered twice. The dispatcher under test is untouched; only
  // the retained-session bookkeeping the catalog fetch reads is doubled.
  const sessionBinding = { session: { getSnapshot: () => ({ openState: 'open' }) } }
  ctx.sessions.binding = id => String(id) === sessionId ? sessionBinding : undefined
  ctx.sessions.using = (_id, _meta, run) => run({ binding: sessionBinding })
  ctx.sessions.scope = () => ctx
  // Must stay undefined for a normal session: a defined address makes the client directory
  // return an EMPTY catalog (the compiled fetch returns [] for subagent addresses).
  ctx.sessions.subagentAddress = () => undefined
  ctx.sessions.retainFor = id => ({ binding: sessionBinding })
  // The client service injects the `remote` service and the generated `remote.commands` key.
  ctx.provide('remote', { commands: commandsRemote, $on: () => () => {}, $mount: async () => async () => {} })
  ctx.provide('remote.commands', commandsRemote)
  ctx.provide('conversation', { input: { for: () => ({ notify: (level, text) => notices.push({ level, text }), focus: () => {} }) } })
  const fiber = ctx.plugin(CommandUiRuntime)
  await fiber.await()
  const source = registered.get('/ command')
  check('the host client runtime registered its "/" source', source !== undefined)
  const sessionContext = { sessionId }

  const catalog = await commandsRemote.list(sessionId)
  const signal = () => new AbortController().signal
  const isClaim = value => value !== undefined && value !== null && typeof value === 'object'
    && typeof value.claim?.submit === 'function'
  const doneEvents = () => lifecycle().filter(row => row.type === 'command/done').map(row => row.data)

  // The bare form is claimed as well: 'leadingInput' covers both spellings.
  const bare = await source.matchEnter(sessionContext, '/mse', signal(), { attachments: 0 })
  if (legacyMode) {
    // Without `input` the bare form is dispatched immediately instead of claimed.
    check('a bare /mse still runs when the descriptor declares no input', bare === 'handled',
      JSON.stringify(bare)?.slice(0, 160))
  } else {
    check('a bare /mse is claimed as a command', isClaim(bare), JSON.stringify(bare)?.slice(0, 160))
    // The composer hands the claim the draft text after the token, so the argument is the
    // trimmed remainder — `leadingClaim.submit` re-joins it as `<token> <args>`.
    const bareRun = await bare.claim.submit(parseCommand('/mse').rawInput.trim())
    check('a bare /mse submits and is admitted', bareRun?.kind === 'success', JSON.stringify(bareRun)?.slice(0, 120))
    check('a bare /mse produced command/run + command/done',
      doneEvents().length === 1 && lifecycle().some(row => row.type === 'command/run'))
  }

  // The defect: an argued line must be claimed, not handed to the model as chat.
  for (const line of ['/mse why', '/mse detail', '/mse status', '/mse now 导出报表金额', '/mse bogus', '/mse   why']) {
    const outcome = await source.matchEnter(sessionContext, line, signal(), { attachments: 0 })
    check(`the argued line "${line}" is claimed as a command (not chat)`, isClaim(outcome),
      JSON.stringify(outcome)?.slice(0, 160))
  }

  // A command that does NOT declare input keeps the old behaviour — the counterexample that
  // proves `input` is what changes the outcome.
  const legacyBare = await source.matchEnter(sessionContext, '/mselegacy', signal(), { attachments: 0 })
  check('the legacy (no input) descriptor still runs bare', legacyBare === 'handled' || isClaim(legacyBare),
    JSON.stringify(legacyBare)?.slice(0, 120))
  const legacyArgued = await source.matchEnter(sessionContext, '/mselegacy why', signal(), { attachments: 0 })
  check('the legacy (no input) descriptor refuses the argued line — this is the pre-fix behaviour',
    legacyArgued === undefined, JSON.stringify(legacyArgued)?.slice(0, 120))

  // Attachments: the host REJECTS the attempt for a command that does not accept them.
  const executionsBefore = executeCalls.length
  await assert.rejects(
    () => source.matchEnter(sessionContext, '/mse why', signal(), { attachments: 1 }),
    error => /附件|attachment/iu.test(String(error?.message ?? error)),
    'an attachment on a no-attachment command rejects')
  check('a refused attachment never reached the executor', executeCalls.length === executionsBefore)

  // Ordinary chat is never claimed.
  const chat = await source.matchEnter(sessionContext, '帮我看一下这个报表', signal(), { attachments: 0 })
  check('ordinary chat is never claimed by the command source', chat === undefined, JSON.stringify(chat))

  // --- the same descriptors, executed for real ---
  const cases = [
    ['/mse status', 'success', 'status'],
    ['/mse why', 'success', 'why'],
    ['/mse detail', 'success', 'why'],
    ['/mse now 导出报表金额并核对币种', 'success', 'now'],
    ['/mse bogus', 'error', 'usage'],
  ]
  for (const [line, kind, label] of cases) {
    const before = lifecycle().length
    const digestBefore = storeDigest()
    const outcome = await source.matchEnter(sessionContext, line, signal(), { attachments: 0 })
    assert.ok(isClaim(outcome), `${line} is claimed`)
    // Admission success is NOT the handler outcome: the host reports the handler result
    // through the durable command/done record (service.ts:401-415).
    const admission = await outcome.claim.submit(parseCommand(line).rawInput.trim())
    check(`"${line}" is admitted as a command (${label})`, admission?.kind === 'success',
      JSON.stringify(admission)?.slice(0, 120))
    const added = lifecycle().slice(before)
    check(`"${line}" produced command/run + command/done`,
      added.length === 2 && added[0].type === 'command/run' && added[1].type === 'command/done',
      JSON.stringify(added.map(row => row.type)))
    check(`"${line}" reports the handler outcome ${kind} in command/done`,
      added[1]?.data?.kind === kind, JSON.stringify(added[1]?.data)?.slice(0, 160))
    check(`"${line}" never appended a user message or opened a turn`, chatEvents().length === 0,
      String(chatEvents().length))
    check(`"${line}" left the learning store untouched`, digestBefore === storeDigest(),
      `${digestBefore} vs ${storeDigest()}`)
  }
  // bare /mse, the legacy counterexample's bare form, then the five argued cases.
  check('every command execution went through the real executor',
    executeCalls.length === cases.length + 2 && listCalls.length > 0,
    `executions=${executeCalls.length} catalogs=${listCalls.length}`)
  // `leadingClaim` re-joins `<token> ` + args, so a bare command arrives as "/mse " with the
  // host's own trailing space; the lines are compared trimmed for that reason.
  check('the executor saw exactly the submitted command lines',
    executeCalls.map(call => call.line.trim()).join('|') ===
      ['/mse', '/mselegacy', ...cases.map(([line]) => line)].join('|'),
    executeCalls.map(call => JSON.stringify(call.line)).join('|'))
  const texts = doneEvents().map(data => String(data.text ?? ''))
  check('the successful runs returned real status text',
    texts.some(text => text.includes('MSE') || text.includes('召回') || text.includes('未学到')), texts[0]?.slice(0, 80))
  check('the unknown argument reports the usage line',
    texts.some(text => text.includes('/mse why')), texts.find(text => text.includes('/mse why'))?.slice(0, 80))
  check('no model turn was opened by any command', chatEvents().length === 0)

  await fiber.dispose()
  await ctx.fiber.dispose()
} catch (error) {
  results.push({ name: 'probe', ok: false, detail: String(error?.stack ?? error).slice(0, 800) })
} finally {
  if (out !== null) mkdirSync(dirname(out), { recursive: true })
  const passed = results.filter(row => row.ok).length
  const report = { checked: results.length, passed, failed: results.filter(row => !row.ok).map(row => row.name), results }
  if (out !== null) writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ checked: report.checked, passed: report.passed, failed: report.failed,
    detail: results.find(row => !row.ok)?.detail ?? null }, null, 2))
  rmSync(work, { recursive: true, force: true })
}
process.exit(results.every(row => row.ok) ? 0 : 1)
