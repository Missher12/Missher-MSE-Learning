import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from './dsh.mjs'

const PROBE_PARENT = fileURLToPath(new URL('.probes', import.meta.url))
mkdirSync(PROBE_PARENT, { recursive: true })
const PROBES = mkdtempSync(join(PROBE_PARENT, 'route-recovery-'))
after(() => rmSync(PROBES, { recursive: true, force: true }))
const symlinkDirectory = (target, link) => symlinkSync(target, link,
  process.platform === 'win32' ? 'junction' : 'dir')

function freshCorrection({ config, agentRoute }) {
  const dir = mkdtempSync(join(PROBES, 'source-route-'))
  const cwd = realpathSync(dir)
  const handlers = new Map()
  const calls = []
  const sessionIds = new Set(['fresh-correction'])
  const ctx = {
    workspaceRegistry: { list: () => [{ path: cwd, sessionIds: [...sessionIds] }] },
    on(name, fn) {
      const rows = handlers.get(name) ?? []
      rows.push(fn)
      handlers.set(name, rows)
      return () => handlers.set(name, rows.filter(item => item !== fn))
    },
    effect() {}, provide() {}, get() { return undefined }, reflect: { provide() { return true } },
    plugin() {}, logger: { warn() {} }, dshHomePath(name) { return join(dir, name) },
    llm: { async * stream(options) {
      calls.push(options)
      yield { type: 'text-delta', text: JSON.stringify({ schema: 'mse-correction-extract-v1', corrections: [] }) }
      yield { type: 'usage', usage: { total: 20 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
  }
  const plugin = apply(ctx, { wakeIntervalMs: 3_600_000, dailyHour: 23, ...config })
  const session = { id: 'fresh-correction', header: { cwd }, events: [],
    get seq() { return this.events.length }, eventAt(index) { return this.events[index] } }
  const emit = async (name, ...args) => Promise.all((handlers.get(name) ?? []).map(fn => fn(...args)))
  const append = async (type, data) => {
    const event = { seq: session.events.length, type, data }
    session.events.push(event)
    await emit('session/event', session, event)
  }
  return { calls, plugin, session, dispose() {
    plugin.dispose()
    rmSync(dir, { recursive: true, force: true })
  }, async run({ reason = 'completed', wake = true } = {}) {
    await append('turn/start', { turn: 1 })
    await emit('agent/pre-step', { agent: { session, options: agentRoute }, step: 1, turn: 1,
      messages: [{ id: 'fresh-user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text',
        text: '你又把数字算错了，应该先读取实际配置再按要求计算。' }] }] },
    async payload => ({ kind: 'enter', messages: payload.messages }))
    await append('turn/end', { turn: 1, reason: { kind: reason } })
    if (wake) await plugin.wake()
  } }
}

test('fresh correction still extracts on the explicit 1.3.14 route', async () => {
  const h = freshCorrection({ config: { modelProvider: 'configured-provider', modelId: 'configured-model' },
    agentRoute: { provider: 'session-provider', model: 'session-model' } })
  try {
    await h.run()
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].provider, 'configured-provider')
    assert.equal(h.calls[0].model, 'configured-model')
  } finally { h.dispose() }
})

test('fresh correction still extracts on its observed source route without effort', async () => {
  const h = freshCorrection({ config: {},
    agentRoute: { provider: 'session-provider', model: 'session-model' } })
  try {
    await h.run()
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].provider, 'session-provider')
    assert.equal(h.calls[0].model, 'session-model')
    assert.equal(Object.hasOwn(h.calls[0], 'reasoningEffort'), false)
  } finally { h.dispose() }
})

test('cancelled correction loses its evicted route and stays pending without historical proof', async () => {
  const h = freshCorrection({ config: {},
    agentRoute: { provider: 'session-provider', model: 'session-model' } })
  try {
    await h.run({ reason: 'aborted', wake: false })
    for (let index = 0; index < 16; index += 1) {
      h.plugin.engine.recordTurnFactsAndRoute({ sessionId: `later-${index}`, turnId: '1',
        taskSummary: '', route: { provider: 'later-provider', model: `later-${index}` } })
    }
    assert.equal(h.plugin.engine.store.read().routes.some(row => row.sessionId === 'fresh-correction'), false)
    await h.plugin.wake()
    assert.equal(h.calls.length, 0)
    assert.equal(h.plugin.engine.store.read().corrections[0].status, 'pending')
    assert.equal(Object.hasOwn(h.plugin.engine.store.read().corrections[0], 'sourceRoute'), false)
  } finally { h.dispose() }
})

function historicalSession(id, cwd, { effort = 'high' } = {}) {
  const events = []
  const append = (type, data) => events.push({ seq: events.length, type, data })
  append('turn/start', { turn: 1 })
  append('step/start', { turn: 1, step: 1 })
  append('request/header', { reason: 'initial', header: { config: {
    provider: `provider-${id}`, model: `model-${id}`,
    ...(effort === null ? {} : { reasoningEffort: effort }),
  } } })
  append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', source: {
    kind: 'model', provider: `provider-${id}`, model: `model-${id}`,
  } } })
  append('step/end', { turn: 1, step: 1 })
  append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { id, header: { id, cwd }, events, get seq() { return events.length },
    eventAt(index) { return events[index] } }
}

function historicalSessionWithPriorTurnRoute(id, cwd) {
  const events = []
  const append = (type, data) => events.push({ seq: events.length, type, data })
  append('turn/start', { turn: 0 })
  append('step/start', { turn: 0, step: 1 })
  append('request/header', { reason: 'initial', header: { config: {
    provider: `provider-${id}`, model: `model-${id}`, reasoningEffort: 'high',
  } } })
  append('assistant/message', { turn: 0, step: 1, message: { role: 'assistant', source: {
    kind: 'model', provider: `provider-${id}`, model: `model-${id}`,
  } } })
  append('step/end', { turn: 0, step: 1 })
  append('turn/end', { turn: 0, reason: { kind: 'completed' } })
  append('turn/start', { turn: 1 })
  append('step/start', { turn: 1, step: 1 })
  append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', source: {
    kind: 'model', provider: `provider-${id}`, model: `model-${id}`,
  } } })
  append('step/end', { turn: 1, step: 1 })
  append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { id, header: { id, cwd }, events, get seq() { return events.length },
    eventAt(index) { return events[index] } }
}

function routeRecoveryHarness({ sessions, sessionIds = Object.keys(sessions), cwdBySession = {},
  statBySession = {}, beforeInspect = null }) {
  const dir = mkdtempSync(join(PROBES, 'route-groups-'))
  const workspace = join(dir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const handlers = new Map()
  const inspections = []
  const calls = []
  let manualHandler = null
  const query = { async inspectSession(id, read, signal) {
    inspections.push(id)
    await beforeInspect?.({ id, signal, attempt: inspections.length })
    signal?.throwIfAborted()
    return read(sessions[id])
  } }
  const persistence = { async stat(id, { signal } = {}) {
    signal?.throwIfAborted()
    return { header: { id, cwd: cwdBySession[id] ?? workspace },
      sizeBytes: statBySession[id]?.sizeBytes ?? 1024,
      ...(statBySession[id]?.eventCount === undefined ? { eventCount: sessions[id]?.seq }
        : { eventCount: statBySession[id].eventCount }) }
  } }
  const ctx = {
    workspaceRegistry: { list: () => [{ path: workspace, sessionIds }] },
    on(name, fn) {
      const rows = handlers.get(name) ?? []
      rows.push(fn)
      handlers.set(name, rows)
      return () => handlers.set(name, rows.filter(item => item !== fn))
    },
    effect() {}, provide() {}, get() { return undefined }, reflect: { provide() { return true } },
    plugin() {}, logger: { warn() {} }, dshHomePath(name) { return join(dir, name) },
    inject(names, callback) {
      if (names.includes('sessionQuery') && names.includes('sessionPersistence')) {
        const cleanup = []
        callback({ sessionQuery: query, sessionPersistence: persistence,
          effect(register) { const fn = register(); if (typeof fn === 'function') cleanup.push(fn) } })
        return { dispose() { for (const fn of cleanup) fn() } }
      }
      if (names.includes('commands')) {
        callback({ commands: { register(spec) { manualHandler = spec.handler } } })
        return { dispose() { manualHandler = null } }
      }
      return { dispose() {} }
    },
    llm: { async * stream(options) {
      calls.push(options)
      yield { type: 'text-delta', text: options.provider === 'manual-provider'
        ? JSON.stringify({ status: 'insufficient' })
        : JSON.stringify({ schema: 'mse-correction-extract-v1', corrections: [] }) }
      yield { type: 'usage', usage: { total: 20 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
  }
  const plugin = apply(ctx, { wakeIntervalMs: 3_600_000, dailyHour: 23 })
  return { dir, workspace, plugin, inspections, calls,
    async emit(name, ...args) { return Promise.all((handlers.get(name) ?? []).map(fn => fn(...args))) },
    runManual(session) {
      assert.equal(typeof manualHandler, 'function')
      return manualHandler({ agent: { session, options: { provider: 'manual-provider', model: 'manual-model' } },
        rawInput: '', signal: new AbortController().signal })
    },
    dispose() { plugin.dispose(); rmSync(dir, { recursive: true, force: true }) } }
}

function blockedFirstInspection() {
  let startedResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  return { started, beforeInspect({ signal, attempt }) {
    if (attempt !== 1) return
    startedResolve(signal)
    return new Promise((_, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
  } }
}

test('route-less first session rotates after a completed turn lacks effort, then recovers the next complete route', async () => {
  const sessions = {}
  const h = routeRecoveryHarness({ sessions, sessionIds: ['first', 'second'] })
  try {
    sessions.first = historicalSession('first', h.workspace, { effort: null })
    sessions.second = historicalSession('second', h.workspace)
    for (const id of ['first', 'second']) {
      assert.equal(h.plugin.engine.recordCorrectionCandidate({ sessionId: id, turnId: '1', cwd: h.workspace,
        userText: '你又把资料核错了，应该按来源原文确认后再交付。' }).ok, true)
    }
    await h.plugin.wake()
    assert.deepEqual(h.inspections, ['first'])
    assert.equal(h.calls.length, 0)
    await h.plugin.wake()
    assert.deepEqual(h.inspections, ['first', 'second'])
    assert.equal(h.calls.length, 1)
    assert.deepEqual({ provider: h.calls[0].provider, model: h.calls[0].model,
      reasoningEffort: h.calls[0].reasoningEffort }, {
      provider: 'provider-second', model: 'model-second', reasoningEffort: 'high',
    })
    const rows = h.plugin.engine.store.read().corrections
    assert.equal(rows.find(row => row.sessionId === 'first').status, 'pending')
    assert.equal(Object.hasOwn(rows.find(row => row.sessionId === 'first'), 'sourceRoute'), false)
  } finally {
    h.dispose()
  }
})

test('a route from an earlier turn is never borrowed for a later route-less correction', async () => {
  const sessions = {}
  const h = routeRecoveryHarness({ sessions, sessionIds: ['stale', 'valid'] })
  try {
    sessions.stale = historicalSessionWithPriorTurnRoute('stale', h.workspace)
    sessions.valid = historicalSession('valid', h.workspace)
    for (const [id, turnId] of [['stale', '1'], ['valid', '1']]) {
      h.plugin.engine.recordCorrectionCandidate({ sessionId: id, turnId, cwd: h.workspace,
        userText: '你又把资料核错了，应该先按来源原文确认后再交付。' })
    }
    await h.plugin.wake()
    assert.deepEqual(h.inspections, ['stale'])
    assert.equal(h.calls.length, 0)
    await h.plugin.wake()
    assert.deepEqual(h.inspections, ['stale', 'valid'])
    assert.equal(h.calls.length, 1)
    assert.equal(Object.hasOwn(h.plugin.engine.store.read().corrections
      .find(row => row.sessionId === 'stale'), 'sourceRoute'), false)
  } finally { h.dispose() }
})

test('oversized and symlink-escaped source groups rotate without a provider call or queue mutation', async () => {
  const sessions = {}
  const h = routeRecoveryHarness({ sessions, sessionIds: ['large', 'escaped', 'valid'],
    statBySession: { large: { sizeBytes: 24 * 1024 * 1024 + 1 } } })
  const outside = join(h.dir, 'outside')
  mkdirSync(outside)
  const escapedCwd = join(h.workspace, 'alias')
  symlinkDirectory(outside, escapedCwd)
  sessions.large = historicalSession('large', h.workspace)
  sessions.escaped = historicalSession('escaped', escapedCwd)
  sessions.valid = historicalSession('valid', h.workspace)
  try {
    for (const [id, cwd] of [['large', h.workspace], ['escaped', escapedCwd], ['valid', h.workspace]]) {
      assert.equal(h.plugin.engine.recordCorrectionCandidate({ sessionId: id, turnId: '1', cwd,
        userText: '你又把资料核错了，应该先按来源原文确认后再交付。' }).ok, true)
    }
    await h.plugin.wake()
    await h.plugin.wake()
    assert.deepEqual(h.inspections, [], 'large and realpath-escaped groups are rejected before cold reads')
    assert.equal(h.calls.length, 0)
    await h.plugin.wake()
    assert.deepEqual(h.inspections, ['valid'])
    assert.equal(h.calls.length, 1)
    const rows = h.plugin.engine.store.read().corrections
    for (const id of ['large', 'escaped']) {
      const row = rows.find(candidate => candidate.sessionId === id)
      assert.equal(row.status, 'pending')
      assert.equal(Object.hasOwn(row, 'sourceRoute'), false)
    }
  } finally { h.dispose() }
})

test('a replaced registered workspace root symlink cannot authorize historical recovery', async () => {
  const sessions = { source: null }
  const h = routeRecoveryHarness({ sessions })
  sessions.source = historicalSession('source', h.workspace)
  const outside = join(h.dir, 'outside-root')
  mkdirSync(outside)
  try {
    h.plugin.engine.recordCorrectionCandidate({ sessionId: 'source', turnId: '1', cwd: h.workspace,
      userText: '你又把资料核错了，应该先按来源原文确认后再交付。' })
    rmSync(h.workspace, { recursive: true, force: true })
    symlinkDirectory(outside, h.workspace)
    await h.plugin.wake()
    assert.deepEqual(h.inspections, [])
    assert.equal(h.calls.length, 0)
    const row = h.plugin.engine.store.read().corrections[0]
    assert.equal(row.status, 'pending')
    assert.equal(Object.hasOwn(row, 'sourceRoute'), false)
  } finally { h.dispose() }
})

test('foreground turn aborts awaited recovery without marking the source; next idle wake retries', async () => {
  const gate = blockedFirstInspection()
  const sessions = { source: null }
  const h = routeRecoveryHarness({ sessions, sessionIds: ['source', 'current'], beforeInspect: gate.beforeInspect })
  sessions.source = historicalSession('source', h.workspace)
  const current = { id: 'current', header: { cwd: h.workspace }, events: [],
    get seq() { return this.events.length }, eventAt(index) { return this.events[index] } }
  try {
    h.plugin.engine.recordCorrectionCandidate({ sessionId: 'source', turnId: '1', cwd: h.workspace,
      userText: '你又把资料核错了，应该先按来源原文确认后再交付。' })
    const firstWake = h.plugin.wake()
    const signal = await gate.started
    await h.emit('session/event', current, { type: 'turn/start', data: { turn: 2 } })
    assert.equal(signal.aborted, true)
    await firstWake
    assert.equal(h.calls.length, 0)
    assert.equal(Object.hasOwn(h.plugin.engine.store.read().corrections[0], 'sourceRoute'), false)
    await h.emit('session/event', current, { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted' } } })
    await h.plugin.wake()
    assert.deepEqual(h.inspections, ['source', 'source'])
    assert.equal(h.calls.length, 1)
  } finally { h.dispose() }
})

test('pause aborts awaited recovery without marking the source; unpause retries', async () => {
  const gate = blockedFirstInspection()
  const sessions = { source: null }
  const h = routeRecoveryHarness({ sessions, beforeInspect: gate.beforeInspect })
  sessions.source = historicalSession('source', h.workspace)
  try {
    h.plugin.engine.recordCorrectionCandidate({ sessionId: 'source', turnId: '1', cwd: h.workspace,
      userText: '你又把资料核错了，应该先按来源原文确认后再交付。' })
    const firstWake = h.plugin.wake()
    const signal = await gate.started
    h.plugin.pause(true)
    assert.equal(signal.aborted, true)
    await firstWake
    assert.equal(h.calls.length, 0)
    h.plugin.pause(false)
    await h.plugin.wake()
    assert.deepEqual(h.inspections, ['source', 'source'])
    assert.equal(h.calls.length, 1)
  } finally { h.dispose() }
})

test('unload aborts awaited recovery without attaching a route or dispatching', async () => {
  const gate = blockedFirstInspection()
  const sessions = { source: null }
  const h = routeRecoveryHarness({ sessions, beforeInspect: gate.beforeInspect })
  sessions.source = historicalSession('source', h.workspace)
  h.plugin.engine.recordCorrectionCandidate({ sessionId: 'source', turnId: '1', cwd: h.workspace,
    userText: '你又把资料核错了，应该先按来源原文确认后再交付。' })
  const firstWake = h.plugin.wake()
  const signal = await gate.started
  h.plugin.dispose()
  assert.equal(signal.aborted, true)
  await firstWake
  assert.equal(h.calls.length, 0)
  assert.equal(Object.hasOwn(h.plugin.engine.store.read().corrections[0], 'sourceRoute'), false)
  h.dispose()
})

test('/mse manual work cancels awaited route recovery and leaves extraction for the next idle wake', async () => {
  const gate = blockedFirstInspection()
  const sessions = { source: null }
  const h = routeRecoveryHarness({ sessions, sessionIds: ['source', 'current'], beforeInspect: gate.beforeInspect })
  sessions.source = historicalSession('source', h.workspace)
  const current = { id: 'current', header: { cwd: h.workspace }, events: [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '检查交付资料时先对照原始记录，再确认结果后回复。' }] } },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ], get seq() { return this.events.length }, eventAt(index) { return this.events[index] } }
  try {
    h.plugin.engine.recordCorrectionCandidate({ sessionId: 'source', turnId: '1', cwd: h.workspace,
      userText: '你又把资料核错了，应该先按来源原文确认后再交付。' })
    const firstWake = h.plugin.wake()
    const signal = await gate.started
    await h.runManual(current)
    assert.equal(signal.aborted, true)
    await firstWake
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].provider, 'manual-provider')
    assert.equal(Object.hasOwn(h.plugin.engine.store.read().corrections[0], 'sourceRoute'), false)
    await h.plugin.wake()
    assert.deepEqual(h.inspections, ['source', 'source'])
    assert.equal(h.calls.length, 2)
    assert.deepEqual(h.calls.map(call => call.provider), ['manual-provider', 'provider-source'])
  } finally { h.dispose() }
})

test('real package root mounts when optional sessionQuery is absent', async () => {
  const { Context, Service } = await import('@deepseek-ai/cordis')
  const dir = mkdtempSync(join(PROBES, 'root-without-query-'))
  const ctx = new Context().root
  class WorkspaceRegistry extends Service {
    constructor(runtime) { super(runtime, 'workspaceRegistry') }
    list() { return [] }
  }
  ctx.provide('agents', {})
  ctx.provide('tools', {})
  ctx.provide('llm', { async * stream() { throw new Error('not called') } })
  ctx.provide('dshHomePath', name => join(dir, name))
  const registryFiber = ctx.registry.plugin(WorkspaceRegistry)
  await registryFiber
  let fiber
  try {
    const bundle = (await import('./root.mjs')).default
    assert.deepEqual(bundle.inject, ['agents', 'tools', 'llm', 'dshHomePath', 'workspaceRegistry'])
    fiber = ctx.registry.plugin(bundle, {})
    await fiber
    assert.ok(ctx.get('mseRebuild'), 'the package root finishes loading without sessionQuery')
  } finally {
    fiber?.dispose()
    registryFiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('real package root recovers one exact completed route from a native cold session and leaves aborted turns waiting', async () => {
  const { Context, Service } = await import('@deepseek-ai/cordis')
  const { Session, SESSION_FORMAT_VERSION } = await import('@deepseek-ai/dsh-session')
  const SessionStore = (await import('@deepseek-ai/dsh-session')).SessionStore
  const jsonl = await import('@deepseek-ai/dsh-session-persistence-jsonl')
  const { SqliteSessionQueryEngine } = await import('@deepseek-ai/dsh-session-query-sqlite')
  const dir = mkdtempSync(join(PROBES, 'native-root-query-'))
  const workspace = join(dir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const sourceId = 'persisted-source-session'
  const currentId = 'current-wake-session'
  let calls = 0
  let resolveCall
  const called = new Promise(resolve => { resolveCall = resolve })
  const llmCalls = []
  const ctx = new Context().root
  class WorkspaceRegistry extends Service {
    constructor(runtime) { super(runtime, 'workspaceRegistry') }
    list() { return [{ path: workspace, sessionIds: [sourceId, currentId] }] }
  }
  ctx.provide('agents', {})
  ctx.provide('tools', {})
  ctx.provide('llm', { async * stream(options) {
    calls += 1
    llmCalls.push(options)
    resolveCall()
    yield { type: 'text-delta', text: JSON.stringify({ schema: 'mse-correction-extract-v1', corrections: [] }) }
    yield { type: 'usage', usage: { total: 20 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } })
  ctx.provide('dshHomePath', name => join(dir, name))
  const fibers = []
  try {
    fibers.push(ctx.registry.plugin(WorkspaceRegistry))
    await fibers.at(-1)
    fibers.push(ctx.registry.plugin(SessionStore))
    await fibers.at(-1)
    fibers.push(ctx.registry.plugin({ name: jsonl.name, Config: jsonl.Config, apply: jsonl.apply },
      { root: join(dir, 'sessions'), compression: 'none' }))
    await fibers.at(-1)
    fibers.push(ctx.registry.plugin(SqliteSessionQueryEngine,
      { path: join(dir, 'query.sqlite'), openAt: 'never' }))
    await fibers.at(-1)
    const query = ctx.get('sessionQuery')
    const persistence = ctx.get('sessionPersistence')
    const nativeStat = persistence.stat.bind(persistence)
    let statCalls = 0
    let lastStat = null
    persistence.stat = async (...args) => {
      statCalls += 1
      lastStat = await nativeStat(...args)
      return lastStat
    }
    const inspect = query.inspectSession.bind(query)
    query.inspectSession = (sessionId, read, signal) => {
      query.inspectCount = (query.inspectCount ?? 0) + 1
      assert.ok(statCalls > 0, 'bounded persistence.stat runs before native inspectSession')
      assert.ok(Number.isSafeInteger(lastStat?.sizeBytes) && lastStat.sizeBytes <= 24 * 1024 * 1024)
      return inspect(sessionId, read, signal)
    }

    const source = Session.create(sourceId, undefined, { id: sourceId, version: SESSION_FORMAT_VERSION,
      cwd: workspace, createdAt: Date.now(), isSeeded: false })
    for (let turn = 1; turn <= 9_100; turn += 1) {
      source.append('turn/start', { turn })
      source.append('turn/end', { turn, reason: { kind: 'blocked' } })
    }
    const goodTurn = 9_101
    source.append('turn/start', { turn: goodTurn })
    source.append('step/start', { turn: goodTurn, step: 1 })
    source.append('request/header', { header: { config: { provider: 'historic-provider',
      model: 'historic-model', reasoningEffort: 'high' }, adapterDefaults: { reasoningEffort: true } },
    reason: 'initial' })
    source.append('assistant/message', { turn: goodTurn, step: 1, message: { id: 'historic-assistant',
      role: 'assistant', source: { kind: 'model', provider: 'historic-provider', model: 'historic-model' },
      content: [] }, stream: [] }, { surfaceOp: 'append' })
    source.append('step/end', { turn: goodTurn, step: 1 })
    source.append('turn/end', { turn: goodTurn, reason: { kind: 'completed' } })
    const abortedTurn = 9_102
    source.append('turn/start', { turn: abortedTurn })
    source.append('step/start', { turn: abortedTurn, step: 1 })
    source.append('assistant/attempt', { turn: abortedTurn, step: 1, stream: [] })
    source.append('step/end', { turn: abortedTurn, step: 1 })
    source.append('turn/end', { turn: abortedTurn, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    assert.equal(source.eventAt(18_205).type, 'turn/end', 'the exact completed source turn is at seq 18,205')

    const handle = await persistence.create({ id: sourceId, version: SESSION_FORMAT_VERSION,
      cwd: workspace, createdAt: Date.now(), isSeeded: false })
    await handle.append(Array.from({ length: source.seq }, (_, index) => source.eventAt(index)))
    await handle.close()
    assert.equal(ctx.sessions.get(sourceId), undefined, 'the query target is cold, not attached')

    const bundle = (await import('./root.mjs')).default
    fibers.push(ctx.registry.plugin(bundle, { wakeIntervalMs: 3_600_000, dailyHour: 23 }))
    await fibers.at(-1)
    const api = ctx.get('mseRebuild')
    const good = api.engine.recordCorrectionCandidate({ sessionId: sourceId, turnId: String(goodTurn),
      cwd: workspace, userText: '你又把资料核错了，应该先按原始配置核对再交付。' })
    const aborted = api.engine.recordCorrectionCandidate({ sessionId: sourceId, turnId: String(abortedTurn),
      cwd: workspace, userText: '你又把检查结果写错了，应该先确认完成状态再交付。' })
    assert.equal(good.ok, true)
    assert.equal(aborted.ok, true)
    const trigger = { id: currentId, header: { cwd: workspace } }
    await ctx.emit('session/event', trigger, { type: 'turn/start', data: { turn: 1 } })
    await ctx.emit('session/event', trigger, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    let timeout
    try {
      await Promise.race([called, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`route recovery did not dispatch (stat=${statCalls}, inspect=${query.inspectCount ?? 0})`)), 5_000)
        timeout.unref?.()
      })])
    } finally { clearTimeout(timeout) }
    assert.equal(query.inspectCount, 1, 'same-source candidates share one native inspection')
    assert.equal(calls, 1)
    assert.deepEqual({ provider: llmCalls[0].provider, model: llmCalls[0].model,
      reasoningEffort: llmCalls[0].reasoningEffort }, {
      provider: 'historic-provider', model: 'historic-model', reasoningEffort: 'high',
    })
    const rows = api.engine.store.read().corrections
    assert.deepEqual(rows.find(row => row.id === good.id).sourceRoute, {
      provider: 'historic-provider', model: 'historic-model', reasoningEffort: 'high',
    })
    const abortedRow = rows.find(row => row.id === aborted.id)
    assert.equal(abortedRow.status, 'pending')
    assert.equal(Object.hasOwn(abortedRow, 'sourceRoute'), false, 'an aborted turn stays route-less')
    assert.equal(ctx.sessions.get(sourceId), undefined, 'cold inspection does not resume or publish the old session')
  } finally {
    for (const fiber of fibers.reverse()) fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
