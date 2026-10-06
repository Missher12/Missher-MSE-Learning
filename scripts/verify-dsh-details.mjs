/**
 * Read-only detail Remote over the real gateway: directory, scope ownership, bounding, errors.
 *
 * Usage: node scripts/verify-dsh-details.mjs <host-node_modules> [--out <report.json>]
 *
 * The package is staged the way an install sees it (own directory plus the application's
 * node_modules), the real `TypertGatewayService` dispatches every call, and the Host services
 * it reads from are real service objects with the documented rc.2 contracts
 * (`sessionQuery.listSessions`, `workspaceRegistry.archivedSessionIds`, `sessions.get`,
 * `agents.get`). Assertions cover the directory (including a session created before this
 * process existed), scope ownership, A/B isolation, honest error propagation and the
 * read-only guarantee: the store bytes, size and mtime never change.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const modules = resolve(args[0] ?? '')
const outIndex = args.indexOf('--out')
const out = outIndex === -1 ? null : resolve(args[outIndex + 1])
assert.ok(existsSync(modules), `host node_modules exists: ${modules}`)
const load = name => import(new URL(`@deepseek-ai/${name}/lib/index.js`, `file://${modules}/`).href)
const { Context } = await load('cordis')
const { default: Gateway } = await load('dsh-api-gateway')
const { default: TypertRegistry } = await load('dsh-typert-registry')
const { remoteMethods } = await load('dsh-typert-protocol')

const results = []
const check = (name, value, detail) => {
  results.push({ name, ok: value === true, detail })
  assert.equal(value, true, `${name}${detail === undefined ? '' : ` (${detail})`}`)
}

const work = mkdtempSync(join(tmpdir(), 'mse-details-gateway-'))
try {
  const stage = join(work, 'package')
  mkdirSync(stage, { recursive: true })
  for (const entry of ['src', 'adapters', 'package.json', 'cordis.patch.yml']) {
    cpSync(join(here, entry), join(stage, entry), { recursive: true })
  }
  symlinkSync(modules, join(stage, 'node_modules'), 'dir')

  const manifest = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'))
  const { TYPERT } = await import(new URL('./adapters/dsh/typert.mjs', `file://${stage}/`).href)
  const { MseDetails } = await import(new URL('./adapters/dsh/details.mjs', `file://${stage}/`).href)
  const { MseControl } = await import(new URL('./adapters/dsh/control.mjs', `file://${stage}/`).href)
  const core = await import(new URL('./src/index.mjs', `file://${stage}/`).href)
  const root = await import(new URL('./src/root.mjs', `file://${stage}/`).href)
  const { LearningEngine } = core

  // --- the package root stays a portable SDK and only loads the Host adapter when mounted ---
  check('the package root re-exports the portable core',
    typeof root.LearningEngine === 'function' && typeof root.reflect === 'function'
      && typeof root.RECALL_REASONS === 'object' && typeof root.apply === 'function'
      && root.name === 'mse-learning' && Array.isArray(root.inject))
  const coreKeys = new Set(Object.keys(core))
  check('every package-root export except the plugin trio and the optional schema comes from the portable core',
    Object.keys(root).filter(key => !['apply', 'name', 'inject', 'default', 'Config'].includes(key)).every(key => coreKeys.has(key)))
  // The settings schema is resolved at load time and is optional: with a Host beside the
  // package it must be a real schemastery schema, and without one the root still imports.
  check('the package root exposes the host settings schema when it can be resolved',
    root.Config !== undefined && typeof root.Config['~standard']?.validate === 'function'
      && root.default.Config === root.Config, 'the Loader reads `default.Config`, so both must agree')

  const byService = service => TYPERT.invocations.filter(row => row.service === service)
  const markers = remoteMethods(Object.create(MseDetails.prototype))
  const detailsDeclared = byService('mseDetails')
  check('the read-only class marks every endpoint its manifest declares',
    markers.length === detailsDeclared.length
      && markers.map(row => row.method).sort().join() === detailsDeclared.map(row => row.method).sort().join())
  const controlMarkers = remoteMethods(Object.create(MseControl.prototype))
  const controlDeclared = byService('mseControl')
  check('the control class marks every endpoint its manifest declares',
    controlMarkers.length === controlDeclared.length && controlMarkers.length > 0
      && controlMarkers.map(row => row.method).sort().join() === controlDeclared.map(row => row.method).sort().join())
  check('one manifest carries both namespaces',
    new Set(TYPERT.invocations.map(row => row.namespace)).size === 2
      && TYPERT.model.services.map(row => row.key).sort().join() === 'mseControl,mseDetails')
  check('the manifest is owned by this package, host face, strict codecs',
    TYPERT.package === '@missher/dsh-mse-learning' && TYPERT.face === 'host'
      && TYPERT.invocations.every(row => row.result.mode === 'strict' && typeof row.result.create === 'function'))

  // --- a real learning store, a second environment and two projects ---
  const stateRoot = join(work, 'state')
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh' })
  const projectKey = '/synthetic/alpha-project'
  engine.prepare({ sessionId: 's-live', turnId: '1', origin: 'user', projectKey,
    prompt: '记住：以后导出报表金额时统一使用人民币' })
  engine.prepare({ sessionId: 's-live', turnId: '2', origin: 'user', projectKey,
    prompt: '记住：以后不要把空值改成零，保留原始空值' })
  engine.record({ eventId: 'method-here', kind: 'method', source: 'host_proposal', projectKey,
    methodId: 'numeric-sort-v1' })
  engine.record({ eventId: 'method-elsewhere', kind: 'method', source: 'host_proposal', projectKey,
    instruction: '按来源日期覆盖目标日期后再比较版本号，只有来源更新时才写入。',
    applicability: '多来源日期字段合并写入时', exclusions: '来源日期缺失或格式无法解析',
    environmentId: 'other-environment' })
  const other = engine.record({ eventId: 'other-scope', kind: 'correction', source: 'direct_user',
    projectKey: '/synthetic/beta-project', instruction: '以后日志时间一律使用 UTC 时区并标注后缀' })
  const rows = engine.inspect({ projectKey }).lessons

  // --- Host services with the documented rc.2 shapes ---
  const createdAt = 1_700_000_000_000
  const titleReads = []
  const directoryEntries = [
    { header: { id: 's-created-early', createdAt: createdAt - 5000, cwd: projectKey, origin: 'user', version: 3, isSeeded: false }, live: false, persisted: true },
    { header: { id: 's-live', createdAt, cwd: projectKey, origin: 'user', version: 3, isSeeded: false }, live: true, persisted: true },
    { header: { id: 's-subagent', createdAt: createdAt + 1, cwd: projectKey, origin: 'subagent', delegationDepth: 1 }, live: true, persisted: true },
    { header: { id: 's-instance', createdAt: createdAt + 2, origin: 'user', version: 3, isSeeded: false }, live: true, persisted: false },
    // One cold conversation the durable cache can title, one only its predecessor checkpoint can,
    // and one whose projection throws: a title failure is that row's null, never a failed list.
    { header: { id: 's-cold-cached', createdAt: createdAt + 3, cwd: projectKey, origin: 'user', version: 3, isSeeded: false }, live: false, persisted: true },
    { header: { id: 's-cold-predecessor', createdAt: createdAt + 4, cwd: projectKey, origin: 'user', version: 3, isSeeded: false }, live: false, persisted: true },
    { header: { id: 's-broken-title', createdAt: createdAt + 5, cwd: projectKey, origin: 'user', version: 3, isSeeded: false }, live: false, persisted: true },
  ]
  // The Host's own projection shapes: `projections.snapshot(session, keys)` for an attached
  // session, `cache.cachedSnapshot(header, keys)` / `cachedPredecessorTitle(header)` for a cold
  // one, every answer `{ values: { title } }`.
  const snapshotOf = title => ({ asOfSeq: 1, values: title === undefined ? {} : { title } })
  const sessionProjections = {
    snapshot: (session, keys) => { titleReads.push(['snapshot', session?.id, keys?.join(',')])
      return session?.id === 's-live' ? snapshotOf('实时标题：重构召回排序') : snapshotOf(undefined) },
    cachedSnapshot: (session, keys) => { titleReads.push(['projections.cachedSnapshot', session?.id, keys?.join(',')])
      return undefined },
  }
  const sessionProjectionCache = {
    cachedSnapshot: (header, keys) => { titleReads.push(['cache.cachedSnapshot', header?.id, keys?.join(',')])
      if (header?.id === 's-cold-cached') return snapshotOf('冷会话标题 📊')
      if (header?.id === 's-broken-title') throw Object.assign(new Error('projection cache offline'), { code: 'projection_failed' })
      return undefined },
    cachedPredecessorTitle: header => { titleReads.push(['cache.cachedPredecessorTitle', header?.id, ''])
      return header?.id === 's-cold-predecessor' ? snapshotOf('前身标题') : undefined },
  }
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(Gateway)
  ctx.provide('dshHomePath', (...parts) => join(work, ...parts))
  ctx.provide('sessionQuery', { listSessions: async signal => { signal?.throwIfAborted?.(); return directoryEntries } })
  ctx.provide('workspaceRegistry', { archivedSessionIds: ['s-created-early'] })
  ctx.provide('sessions', { get: id => id === 's-live' ? { id, header: directoryEntries[1].header } : undefined })
  ctx.provide('sessionProjections', sessionProjections)
  ctx.provide('sessionProjectionCache', sessionProjectionCache)
  ctx.provide('agents', { get: id => id === 's-live' ? { status: 'running' } : undefined })
  ctx.typert.register(TYPERT)
  const recallCalls = []
  const state = { diagnosis: 'ok' }
  const jobs = []
  ctx.provide('mseLearning', {
    engine,
    version: manifest.version,
    // The control plane reads the same service through a different face; a stub that only
    // satisfied the read-only half used to make a settings read throw instead of answering.
    settings: () => ({ namespace: 'mse-learning', pluginVersion: manifest.version, settingsSource: 'plugin_config',
      user: { enabled: true, reflectionEnabled: true, maxContextBytes: 768, evaluationTokensPerDay: 0, evaluationCallsPerDay: 2 },
      effective: { learning: true, reflection: true, reasons: [], legacyOwner: false, disposed: false },
      budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2, evaluationTokensPerDay: 0, evaluationCallsPerDay: 2 },
      review: { autoEnabled: true, savedAutoEnabled: true, perDay: 3, windowMs: 86_400_000, cooldownMs: 1_800_000,
        maxTokens: 384, sharedWithManual: true, usedLast24h: 0, allowance: 3 },
      settlement: null, jobs: { pending: 0, running: null, retained: 0, capacity: 8, inMemoryOnly: true } }),
    permissions: () => ({ allowed: true, code: null }),
    resolveScope: async sessionId => ({ ok: true, code: null, projectKey: '/synthetic/alpha-project', sessionId: sessionId ?? null }),
    scopeHashFor: value => typeof value === 'string' ? createHash('sha256').update(value).digest('hex').slice(0, 12) : null,
    jobs: { list: () => jobs, status: () => ({ pending: 0, running: null, retained: jobs.length, capacity: 8, inMemoryOnly: true }) },
    capabilities: { recallReasons: ['recalled', 'not_learned'] },
    isEnabled: () => true,
    recallStatus: (sessionId, scopeKey) => {
      recallCalls.push({ sessionId, scopeKey })
      return { enabled: true, sessionId, reasons: ['recalled'],
        recent: [{ turn: '1', at: 5, reason: 'recalled', bytes: 130, lessons: [rows[0].id],
          sources: [{ id: rows[0].id, version: 1, kind: 'correction', bytes: 60, methodId: null }],
          diagnostics: { matched: 1, candidates: 1, eligible: 3, sessionBytes: 130, remainingBytes: 1406 },
          settleState: 'settled', settleError: null, settleAttempts: 1 }],
        last: { turn: '1', at: 5, reason: 'recalled', bytes: 130, lessons: [rows[0].id] } }
    },
    settlementStatus: () => [
      { sessionId: 's-live', turnId: '1', state: 'settled', attempts: 1, lastError: null },
      { sessionId: 's-other-session', turnId: '9', state: 'retrying', attempts: 3, lastError: 'lock_busy' },
    ],
    diagnose: input => {
      if (state.diagnosis === 'refused') return { ok: false, code: 'migration_required' }
      if (state.diagnosis === 'threw') throw Object.assign(new Error('store unreadable'), { code: 'store_unavailable' })
      return { ok: true, prompted: { reason: 'recalled', wouldInjectBytes: 130, fitted: 1,
        wouldInjectLessons: [rows[0].id], eligible: 3, candidates: 1, matched: 1, budgetBytes: 768 },
      session: { bytes: 0, budgetBytes: 1536, remainingBytes: 1536, offered: 0 },
      library: { total: rows.length, scopeLessons: rows.length } }
    },
  })
  await ctx.plugin(MseDetails)
  await ctx.plugin(MseControl)
  const gateway = ctx.get('typertGateway')
  const invoke = (method, input = {}) => gateway.invoke({ namespace: 'mseDetails', method, args: { input } })
  const control = (method, input = {}) => gateway.invoke({ namespace: 'mseControl', method, args: { input } })

  const storePath = join(stateRoot, 'lessons-v1.json')
  const snapshot = () => ({ sha256: createHash('sha256').update(readFileSync(storePath)).digest('hex'),
    size: statSync(storePath).size, mtimeMs: statSync(storePath).mtimeMs })
  const before = snapshot()

  // The control namespace is reachable, and without a learning core it refuses instead of
  // inventing a state: "I could not read it" must never arrive as "it is paused".
  const controlStatus = await control('status')
  check('the control namespace reports the saved settings and the effective state',
    controlStatus?.ok === true && controlStatus.settings?.user?.enabled === true
      && controlStatus.effective?.learning === true && controlStatus.settings.namespace === 'mse-learning',
    JSON.stringify(controlStatus).slice(0, 300))
  check('the control status carries no scope path or state root',
    !JSON.stringify(controlStatus).includes(stateRoot) && !JSON.stringify(controlStatus).includes('/synthetic'))
  check('a manual review on a session with no readable log is refused with a code',
    (await control('startReview', { sessionId: 's-live', turnId: 1, requestId: 'abcdefgh' })).ok === false,
    'no session log means no job')
  check('an unknown request id never starts a job',
    (await control('startReview', { sessionId: 's-live', turnId: 1, requestId: 'x' })).code === 'invalid_request_id')
  const crossNamespace = await control('overview').then(() => 'answered', error => String(error?.code ?? error))
  check('the control namespace is not the read-only namespace', crossNamespace === 'gateway/invocation-unavailable',
    crossNamespace)

  const overview = await invoke('overview')
  check('overview reports version, store readability and the byte budget', overview.ok === true
    && overview.version === manifest.version && overview.store.readable === true
    && overview.budget.turnBytes === 768 && overview.budget.sessionBytes === 1536)
  check('overview shows the session directory state instead of a guessed count',
    overview.sessionDirectory.available === true && overview.sessionDirectory.archivedKnown === true
      && overview.sessionDirectory.excludedInternal === 1 && overview.sessionsKnown === 6,
    JSON.stringify(overview.sessionDirectory))
  check('overview keeps settlement as aggregates, never another session detail',
    typeof overview.settlement.live === 'number'
      && !JSON.stringify(overview.settlement).includes('s-other-session')
      && !JSON.stringify(overview.settlement).includes('turnId'))
  check('overview never exposes a scope path or state root',
    !JSON.stringify(overview).includes('/synthetic') && !JSON.stringify(overview).includes(stateRoot))

  const sessions = await invoke('sessions')
  check('the directory lists Host sessions created before this process existed',
    sessions.ok === true && sessions.sessions.some(row => row.id === 's-created-early' && row.archived === true))
  check('the directory lists a session that has not sent a model message yet',
    sessions.sessions.some(row => row.id === 's-instance' && row.persisted === false && row.scope === 'instance'))
  check('the directory excludes sub-agent work instead of showing it as a conversation',
    sessions.excludedInternal === 1 && sessions.sessions.every(row => row.id !== 's-subagent'))
  // The conversation title is DISPLAY-ONLY: it comes from the Host's own public projections, it
  // never becomes a selection value or a scope identity, and one unreadable title is one null.
  const titleOf = id => sessions.sessions.find(row => row.id === id)?.title ?? null
  check('every listed conversation carries a bounded title field',
    sessions.sessions.every(row => Object.hasOwn(row, 'title')
      && (row.title === null || (typeof row.title === 'string' && row.title.length <= 200))))
  check('an attached conversation is titled from its live projection cut',
    titleOf('s-live') === '实时标题：重构召回排序', titleOf('s-live'))
  check('a cold conversation is titled from the durable projection cache',
    titleOf('s-cold-cached') === '冷会话标题 📊', titleOf('s-cold-cached'))
  check('a cold conversation falls back to its predecessor-title checkpoint',
    titleOf('s-cold-predecessor') === '前身标题', titleOf('s-cold-predecessor'))
  check('a look-alike header field is never used as a title',
    !Object.hasOwn(directoryEntries[3].header, 'title') || titleOf('s-instance') === null, titleOf('s-instance'))
  check('a throwing title projection degrades to null instead of failing the directory',
    titleOf('s-broken-title') === null && sessions.ok === true)
  check('titles never enter the scope identity or the selection value',
    sessions.sessions.every(row => typeof row.id === 'string' && row.id.length > 0
      && (row.scopeHash === null || /^[a-f0-9]{12}$/u.test(row.scopeHash))
      && !JSON.stringify(row.scopeHash ?? '').includes('标题')))
  check('the directory reports a label and a one-way scope hash, never the path',
    sessions.sessions.every(row => !JSON.stringify(row).includes('/synthetic')
      && (row.scopeHash === null || row.scopeHash.length === 12)))
  check('the directory reports run state and live/persisted separately',
    sessions.sessions.find(row => row.id === 's-live').running === true
      && sessions.sessions.find(row => row.id === 's-created-early').running === null)

  const list = await invoke('lessons', { sessionId: 's-live', kind: 'correction', pageSize: 10 })
  check('lessons resolves the scope from the session and separates filtered from scoped totals',
    list.ok === true && list.scope.kind === 'project' && list.items.length === 2 && list.total === 2
      && list.complete === true && list.scopeTotal === 4 && list.storeCap === 300
      && list.libraryTotal === 5,
    JSON.stringify({ items: list.items.length, total: list.total, scopeTotal: list.scopeTotal }))
  check('lessons never returns another scope', list.items.every(row => row.id !== other.id))
  check('lesson rows carry the saved provenance, not a stripped projection',
    list.items.every(row => /^[a-f0-9]{12}$/u.test(row.sourceTurn) && typeof row.environment === 'string')
      && list.items.every(row => row.currentEnvironment === null))
  const methods = await invoke('lessons', { sessionId: 's-live', kind: 'method', pageSize: 10 })
  check('methods from another environment are marked inapplicable here',
    methods.ok === true && methods.items.length === 2
      && methods.items.some(row => row.currentEnvironment === true)
      && methods.items.some(row => row.currentEnvironment === false),
    JSON.stringify(methods.items.map(row => [row.methodId, row.currentEnvironment])))
  const ignored = await invoke('lessons', { sessionId: 's-live', projectKey: '/synthetic/beta-project', pageSize: 10 })
  check('a browser-supplied project key cannot widen the scope',
    ignored.ok === true && ignored.total === list.scopeTotal
      && ignored.items.every(row => row.id !== other.id) && ignored.items.length === list.scopeTotal)
  const unknown = await invoke('lessons', { sessionId: 'never-seen', pageSize: 10 })
  check('an unknown session is refused instead of answered from a cache', unknown.ok === false && unknown.code === 'session_unknown')
  const instance = await invoke('lessons', { pageSize: 50 })
  check('no session means the instance scope, still bounded', instance.ok === true && instance.items.length === 0)
  check('an oversized page is clamped', (await invoke('lessons', { sessionId: 's-live', pageSize: 5000 })).pageSize <= 50)
  const clamped = await invoke('lessons', { sessionId: 's-live', page: 9999, pageSize: 1 })
  check('a client page beyond the end clamps to the last page',
    clamped.page === clamped.pages && clamped.pages === clamped.scopeTotal, JSON.stringify(clamped.pages))

  const detail = await invoke('lesson', { sessionId: 's-live', id: rows[0].id })
  check('lesson detail stays inside the resolved scope and keeps its metadata',
    detail.ok === true && detail.lesson.id === rows[0].id && detail.lesson.sourceTurn !== null
      && /^[a-f0-9]{12}$/u.test(detail.lesson.environment))
  check('a lesson from another scope is refused',
    (await invoke('lesson', { sessionId: 's-live', id: other.id })).code === 'lesson_not_in_scope')

  const recall = await invoke('recall', { sessionId: 's-live' })
  check('recall reports the in-process window and its scope',
    recall.ok === true && recall.memory === 'in-process' && recall.recent.length === 1
      && recall.recent[0].diagnostics.matched === 1)
  check('recall returns only the selected session settlement',
    recall.settlement.live.length === 1 && recall.settlement.live[0].sessionId === 's-live'
      && !JSON.stringify(recall).includes('s-other-session'), JSON.stringify(recall.settlement))
  check('recall carries the session byte ledger', recall.session !== null && recall.session.budgetBytes === 1536
    && recall.session.remainingBytes === 1536)
  check('recall resolution used the Host-side project identity',
    recallCalls.at(-1).sessionId === 's-live' && recallCalls.at(-1).scopeKey === projectKey)
  check('recall requires a session instead of answering for the instance scope',
    (await invoke('recall', {})).code === 'session_required')

  const dry = await invoke('diagnose', { sessionId: 's-live', prompt: '导出报表金额并核对币种' })
  check('diagnose is a dry run and says so', dry.ok === true && dry.modelCalls === 0
    && dry.contextBytesAppended === 0 && dry.budgetConsumed === 0 && dry.prompted.wouldInjectBytes === 130)
  check('an oversized prompt is truncated, not rejected',
    (await invoke('diagnose', { sessionId: 's-live', prompt: 'x'.repeat(4000) })).ok === true)

  state.diagnosis = 'refused'
  const refused = await invoke('diagnose', { sessionId: 's-live', prompt: 'x' })
  check('a refused core read is reported, never wrapped in a success',
    refused.ok === false && refused.code === 'migration_required')
  // An unreadable store must be reported, never rendered as zero counts.
  const originalDiagnose = engine.diagnose
  engine.diagnose = () => { throw Object.assign(new Error('store unreadable'), { code: 'store_unavailable' }) }
  const countsRefused = await invoke('overview')
  check('an unreadable store reports countsError instead of zero counts',
    countsRefused.ok === true && countsRefused.counts === null && countsRefused.countsError === 'store_unavailable',
    JSON.stringify({ counts: countsRefused.counts, countsError: countsRefused.countsError }))
  const recallRefused = await invoke('recall', { sessionId: 's-live' })
  check('an unreadable session ledger is reported next to the rest of the recall view',
    recallRefused.ok === true && recallRefused.session === null && recallRefused.sessionError === 'store_unavailable')
  const lessonsRefused = await invoke('lessons', { sessionId: 's-live' })
  check('an unreadable store keeps the lesson list from claiming a count',
    lessonsRefused.ok === true && lessonsRefused.items.length > 0
      && lessonsRefused.scope.countsError === 'store_unavailable')
  engine.diagnose = originalDiagnose
  state.diagnosis = 'ok'

  const after = snapshot()
  check('every read left the learning store byte-identical',
    JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} vs ${JSON.stringify(after)}`)

  // --- the package root mounts the Host adapter in a real Cordis lifecycle ---
  const mounted = new Context()
  for (const key of ['agents', 'tools', 'llm']) mounted.provide(key, {})
  mounted.provide('dshHomePath', (...parts) => join(work, ...parts))
  await mounted.plugin(root.default)
  const service = mounted.get('mseLearning')
  check('mounting the package root loads the DSH adapter lazily',
    typeof service === 'object' && service !== null && typeof service.engine === 'object',
    typeof service)

  // --- without the learning half the page must say so instead of showing zeroes ---
  const bare = new Context()
  await bare.plugin(TypertRegistry)
  await bare.plugin(Gateway)
  bare.typert.register(TYPERT)
  await bare.plugin(MseDetails)
  const bareGateway = bare.get('typertGateway')
  const missing = await bareGateway.invoke({ namespace: 'mseDetails', method: 'overview', args: { input: {} } })
  check('an unloaded core reports core_unavailable rather than a zeroed success',
    missing.ok === false && missing.code === 'core_unavailable')
  const noDirectory = await bareGateway.invoke({ namespace: 'mseDetails', method: 'sessions', args: { input: {} } })
  check('a missing session directory reports its code instead of an empty list',
    noDirectory.ok === false && noDirectory.code === 'session_directory_unavailable')
} finally {
  const report = { ok: results.every(row => row.ok), checked: results.length, results }
  if (out !== null) writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
  rmSync(work, { recursive: true, force: true })
  console.log(JSON.stringify({ ok: report.ok, checked: report.checked,
    failed: results.filter(row => !row.ok).map(row => row.name) }, null, 2))
  if (!report.ok) process.exitCode = 1
}
