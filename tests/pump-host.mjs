// The controlled host boundary the stage-3d problem-recovery tests drive.
//
// Nothing below the host boundary is faked: the plugin (`apply`) is the shipped one, the core store,
// the ticket/allowance/cooldown rules, the job queue and the bounded scheduler are production code.
// Only the host transport (`ctx.llm.stream`), the session directory, the archive flag and the
// clock/timer are controlled — and the clock/timer are the CONTROLLED-VERIFICATION seams the plugin
// itself reads, so the real production timer path runs instead of a test-only branch.
//
// The provider counter increments at the stream entry point the product actually calls, never at a
// scan or a callback: "physical calls" is the number of provider requests that were really started.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../adapters/dsh/index.mjs'
import { LearningEngine } from '../src/index.mjs'
import { mseMessageSource } from '../adapters/harness.mjs'

export const DAY = 86_400_000
export const COOLDOWN_MS = 30 * 60_000
/** The one wake-up period the adapter's scheduler is started with (its own production default). */
export const TICK_MS = 60_000

/** Let every queued microtask and job settle; no real time passes. */
export const flush = async (rounds = 32) => {
  for (let index = 0; index < rounds; index += 1) await new Promise(setImmediate)
}

export const sha = bytes => createHash('sha256').update(bytes).digest('hex')

/** Bounded digest of every byte under one state root (a read must not change it). */
export function stateDigest(root) {
  const rows = []
  const walk = (dir, rel = '') => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), key = join(rel, name)
      const stat = lstatSync(path)
      assert.equal(stat.isSymbolicLink(), false, 'synthetic state must not escape through symlinks')
      if (stat.isDirectory()) walk(path, key)
      else rows.push([key, sha(readFileSync(path))])
    }
  }
  walk(root)
  return { sha256: sha(JSON.stringify(rows)), rows }
}

const promptOf = options => (options?.messages ?? []).map(message => (message?.content ?? [])
  .filter(block => block?.type === 'text').map(block => block.text).join('')).join('\n')

/**
 * A provider DOUBLE that counts its own invocations.
 *
 * `held: true` makes the request ignore its AbortSignal until `record.release()` is called, which is
 * exactly the provider the physical-slot guarantee must survive: the queue's slot has to stay held,
 * and a late answer must never become a candidate.
 */
export function countedProvider({ instruction = '复盘得到的方法：先核对输入条件与边界值，再重试原任务' } = {}) {
  const calls = []
  const replies = []
  let active = 0, peak = 0
  const textOf = reply => reply.text ?? JSON.stringify({ instruction })
  return {
    calls,
    enqueue: reply => replies.push(reply),
    queued: () => replies.length,
    last: () => calls[calls.length - 1] ?? null,
    stats: () => ({ physicalCalls: calls.length, active, peak }),
    stream(options) {
      assert.ok(replies.length > 0, 'unexpected physical model call: no synthetic reply queued')
      const reply = replies.shift()
      let release = null
      const gate = reply.held === true ? new Promise(resolve => { release = resolve }) : Promise.resolve()
      // `stall: true` stops the stream AFTER its first chunk until `releaseStall()`: exactly the
      // transport that is still alive while this side has already decided to stop reading.
      let releaseStall = null
      const stallGate = reply.stall === true ? new Promise(resolve => { releaseStall = resolve }) : Promise.resolve()
      const record = { provider: options?.provider ?? null, model: options?.model ?? null,
        reasoningEffort: options?.reasoningEffort ?? null, maxTokens: options?.maxTokens ?? null,
        system: String(options?.system ?? ''), prompt: promptOf(options),
        abortedAtDispatch: options?.signal?.aborted === true, held: reply.held === true,
        released: false, settled: false,
        release: () => { record.released = true; release?.() },
        releaseStall: () => { releaseStall?.() } }
      calls.push(record)
      active += 1
      peak = Math.max(peak, active)
      return (async function * () {
        try {
          await gate
          if (reply.error !== undefined) throw Object.assign(new Error(String(reply.error)), { code: reply.error })
          if (Array.isArray(reply.chunks)) {
            for (const [index, chunk] of reply.chunks.entries()) {
              yield chunk
              if (reply.stall === true && index === 0) await stallGate
            }
            return
          }
          yield { type: 'text-delta', text: textOf(reply) }
          if (reply.usage !== undefined) yield { type: 'usage', usage: reply.usage }
          yield { type: 'finish', reason: { kind: reply.finish ?? 'stop' } }
        } finally { record.settled = true; active -= 1 }
      })()
    },
  }
}

/**
 * The ONE timer the plugin owns, under the test's control.
 *
 * The plugin reads these two functions as its controlled-verification seam, so `fire({ ms })` runs
 * the production interval callback itself (the job queue's own deadlines and the scheduler's
 * wake-up share the seam, which is why the caller selects a period).
 */
export function manualScheduler() {
  const tasks = new Map()
  const scheduled = []
  let sequence = 0
  return {
    scheduled,
    schedule(fn, ms) {
      sequence += 1
      const handle = { id: sequence, ms, fn, unref() { return this } }
      tasks.set(sequence, handle)
      scheduled.push({ id: sequence, ms })
      return handle
    },
    cancelTimer(handle) { tasks.delete(typeof handle === 'number' ? handle : handle?.id) },
    pending: () => [...tasks.values()].map(task => ({ id: task.id, ms: task.ms })),
    async fire({ ms = null, times = 1 } = {}) {
      let fired = 0
      for (let round = 0; round < times; round += 1) {
        for (const task of [...tasks.values()]) {
          if (ms !== null && task.ms !== ms) continue
          fired += 1
          task.fn()
        }
        await flush()
      }
      return fired
    },
  }
}

/**
 * The host the plugin is loaded into: one live session directory, one archive flag, one provider.
 *
 * `sessions` and `archived` are live values the test may mutate (a route change, an archive, a
 * deletion) — every reader in the product is written to answer "unknown" rather than to assume, so
 * mutating them is how a real host fact changes.
 */
export function stage3dHost({ provider, scheduler = manualScheduler(), clock = { now: Date.UTC(2030, 0, 7, 9, 0) },
  stateRoot = null, config = {}, sessions = [], archived = new Set(), hooks = {} } = {}) {
  const root = stateRoot ?? mkdtempSync(join(tmpdir(), 'mse-stage3d-'))
  const services = new Map()
  const listeners = []
  const effects = []
  const injections = []
  const disposers = []
  const warnings = [], infos = []
  const localCalls = { listSessions: 0, readSession: 0 }
  const now = () => clock.now
  const ctx = {
    dshHomePath: () => root,
    logger: {
      warn: (...args) => warnings.push(args.map(String).join(' ')),
      info: (...args) => infos.push(args.map(String).join(' ')),
      error: (...args) => warnings.push(args.map(String).join(' ')),
      debug: () => {},
    },
    llm: { stream: options => provider.stream(options) },
    get: name => services.get(name),
    provide: (name, value) => { services.set(name, value) },
    on: (name, handler) => { listeners.push({ name, handler }); return () => {} },
    // cordis runs an effect callback after the plugin loaded, so the fixture records them and runs
    // them on demand (a synchronous run would reach plugin state declared later in `apply`).
    effect: fn => { effects.push(fn); return () => {} },
    inject: (names, run) => {
      // A service the host does NOT provide must not be injected: running the callback for
      // `missherEvolutionCore` on a host without it would fabricate a legacy takeover and pause all
      // learning. The real cordis injection waits for the service to appear.
      if (!names.every(name => services.has(name) || ['settings', 'commands'].includes(name))) return () => {}
      const child = Object.assign(Object.create(ctx), {
        settings: { configure: () => {} },
        commands: { register: () => () => {} },
        sessionQuery: services.get('sessionQuery'),
        workspaceRegistry: services.get('workspaceRegistry'),
      })
      injections.push(() => run(child))
      return () => {}
    },
    plugin: () => () => {},
    fiber: undefined,
  }
  const findSession = id => sessions.find(row => row?.header?.id === id) ?? null
  services.set('sessionQuery', {
    listSessions: async () => {
      localCalls.listSessions += 1
      if (typeof hooks.onDirectoryRead === 'function') hooks.onDirectoryRead('listSessions')
      return sessions.map(row => ({ header: row.header }))
    },
    // The REAL `dsh-session-query` contract: a cloned header plus the complete raw event log. The
    // live session object is a different value (that is what the turn events carry).
    readSession: async id => {
      localCalls.readSession += 1
      // A hook runs BEFORE the session is looked up, so a test can change a real host fact (or write a
      // stale snapshot) exactly while a read is in flight — the race the commit gate must survive.
      if (typeof hooks.onSessionRead === 'function') hooks.onSessionRead(id)
      const found = findSession(id)
      if (found === null) throw Object.assign(new Error('session_unknown'), { code: 'session_unknown' })
      return { session: { ...found.header }, inheritedEventCount: 0, events: found.events }
    },
  })
  services.set('workspaceRegistry', { archivedSessionIds: archived })
  // The LIVE settings policy. Each field is exposed the way the Settings service exposes it (a
  // volatile `.get()`), so flipping one below is a real settings write to the running plugin.
  const policy = { enabled: true, reflectionEnabled: true, autoValidationEnabled: false }
  const host = { stateRoot: root, ctx, services, listeners, warnings, infos, localCalls, clock, scheduler,
    provider, sessions, archived, effects, injections, policy, hooks }
  const resolve = {}
  const ready = new Promise(done => { resolve.ready = done })
  host.start = (overrides = {}) => {
    apply(ctx, { maxContextBytes: 768, evaluationTokensPerDay: 0, evaluationCallsPerDay: 2,
      now, schedule: scheduler.schedule, cancelTimer: scheduler.cancelTimer,
      enabled: { get: () => policy.enabled }, reflectionEnabled: { get: () => policy.reflectionEnabled },
      autoValidationEnabled: { get: () => policy.autoValidationEnabled }, ...config, ...overrides })
    host.service = services.get('mseLearning')
    assert.ok(host.service, 'the plugin must provide its service')
    for (const fn of injections) fn()
    for (const fn of effects) { const disposer = fn(); if (typeof disposer === 'function') disposers.push(disposer) }
    // A read-back engine on the SAME root: exactly what a second process would open.
    host.reader = new LearningEngine({ stateRoot: root, adapterId: 'dsh', maxContextBytes: 768,
      evaluationTokensPerDay: 0, evaluationCallsPerDay: 2, now })
    return host
  }
  host.close = async () => {
    for (const disposer of [...disposers].reverse()) { try { await disposer() } catch { /* already closed */ } }
    disposers.length = 0
  }
  host.cleanup = async () => { await host.close() }
  host.remove = () => rmSync(root, { recursive: true, force: true })
  host.emit = (name, ...args) => listeners.filter(row => row.name === name).map(row => row.handler(...args))
  host.state = () => {
    const doc = host.reader.store.read()
    return { doc, problems: doc.problemLoop?.problems ?? [], lessons: doc.lessons ?? [],
      spends: (doc.spends ?? []).filter(row => row.kind === 'reflection'),
      events: (doc.events ?? []).filter(row => row.reflection === true) }
  }
  host.problem = id => host.state().problems.find(row => row.id === id) ?? null
  return host
}

/** A session row in the shape `latestRoute`/`resolveScope` really read. */
export function sessionRow(id, { cwd, route = null, seq = 0 } = {}) {
  const events = []
  if (route !== null) {
    events.push({ seq: 1, type: 'request/header',
      data: { header: { config: { provider: route.provider, model: route.model,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) } } } })
  }
  for (let n = 0; n < seq; n += 1) events.push({ seq: n + 2, type: 'note', data: {} })
  // The real host session carries BOTH its own id and the header the directory reports.
  return { id, header: { id, cwd }, events }
}

/** Change the route one session's own history records (a real host fact, read live). */
export function setRoute(session, route) {
  session.events = [{ seq: 1, type: 'request/header',
    data: { header: { config: { provider: route.provider, model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) } } } }]
  return session
}

/**
 * Drive ONE real host turn through the plugin's own listeners.
 *
 * `tools` is the roster of tool calls the host reports through `tools/result`: a non-zero exit is a
 * trusted failure (two independent call ids of the same tool = one ready problem), and a zero exit is
 * a plain successful tool call. The turn ends through `session/event`, which is exactly where the
 * harness persists the problem ledger and asks for a reflection.
 */
export async function runTurn(host, { session, turn, prompt = '整理报表并核对金额', options, tools = [],
  summary = '已完成本轮任务并核对结果', end = 'error' } = {}) {
  const userMessage = { id: `user-${session.header.id}-${turn}`, role: 'user',
    source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }
  const decision = await host.emit('agent/pre-step', { agent: { session, options },
    step: 1, turn, messages: [userMessage], signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [userMessage] }))[0]
  // The source licence is created only by a successful Host-owned llm/stream carrying this turn's
  // actual route. Drive that production hook with a deterministic upstream stream; calling
  // sourcePublish directly here would bypass the contract these recovery tests are meant to prove.
  if (typeof options?.provider === 'string' && typeof options?.model === 'string') {
    const streamOptions = { sessionId: session.id, provider: options.provider, model: options.model,
      ...(typeof options.reasoningEffort === 'string' ? { reasoningEffort: options.reasoningEffort } : {}) }
    const stream = host.emit('llm/stream', streamOptions, async function * () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })[0]
    for await (const _chunk of stream) { /* deterministic Host response; no provider transport */ }
  }
  tools.forEach((tool, index) => {
    // Deterministic call ids: the same trajectory on two hosts must produce the same state bytes,
    // and an id is the host's own stable event identity (never a freshly minted random one).
    const callId = tool.callId ?? `${session.id}-${turn}-${tool.name}-${index}`
    session.events.push({ type: 'tool/call', seq: session.events.length + 1,
      data: { callId, turn, name: tool.name } })
    host.emit('tools/result', { agent: { session }, callId, rootCallId: callId, name: tool.name },
      { isError: false, value: { exitCode: tool.exitCode ?? 0 } })
  })
  host.emit('session/event', session, { type: 'assistant/message',
    data: { turn, message: { role: 'assistant', content: [{ type: 'text', text: summary }] } } })
  host.emit('session/event', session, { type: 'turn/end', data: { turn, reason: { kind: end } } })
  await flush()
  return decision
}

/**
 * A turn whose tool calls all succeeded: the generic reflection channel (no problem evidence).
 * `options` is the trusted route the host reports for this turn, which is also what binds a problem
 * origin — a turn without it can only ever produce an unbound (unrecoverable) observation.
 */
export async function successTurn(host, { session, turn, prompt = '整理报表并核对金额', options } = {}) {
  return runTurn(host, { session, turn, prompt, options,
    tools: [{ name: 'read', exitCode: 0 }, { name: 'write', exitCode: 0 }], end: 'completed' })
}

/** The two independent failures that make ONE ready problem for `toolName`. */
export const failures = (toolName, count = 2, prefix = 'call') => Array.from({ length: count },
  (_, index) => ({ name: toolName, exitCode: 1, callId: `${prefix}-${toolName}-${index}` }))
