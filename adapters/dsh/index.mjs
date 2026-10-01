import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { LearningEngine, reflect, guardedAction, RECALL_REASONS } from '../../src/index.mjs'
import { createHarnessBridge } from '../harness.mjs'
import { formatRecallLine, handleMseCommand } from '../../src/status.mjs'
import { apply as applyDetails } from './details.mjs'
import { apply as applyControl } from './control.mjs'
import { JobQueue } from './jobs.mjs'
import { readVolatile, SETTINGS_DEFAULTS, CONTEXT_BYTES_MIN, CONTEXT_BYTES_MAX,
  EVALUATION_TOKENS_MAX, EVALUATION_CALLS_MAX } from './config.mjs'
import { shortHash } from './project.mjs'

/**
 * The plugin-owned `/mse` command definition, built once and registered as-is.
 *
 * `input` is not decoration: the host's client command runtime only claims an *argued* slash
 * line when the definition declares it
 * (`packages/client/ui-commands/src/client/service.ts` — `matchEnter` claims the token when
 * `desc.input !== undefined`, then returns `undefined` for any non-bare line, which sends the
 * text to the model as ordinary chat). Declaring it is also what every argument-taking host
 * command does, e.g. `/goal`'s `input: { hint: '[<objective>|clear|edit <objective>|…]' }`.
 * Without it `/mse why`, `/mse detail` and `/mse now <task>` were advertised by
 * `COMMAND_USAGE` but unreachable from the composer; only the bare `/mse` worked.
 *
 * Consequences of declaring it, exactly as the host defines them: a bare `/mse` enters
 * leading-input state instead of executing immediately (Enter again submits `/mse ` and prints
 * the plain status), and attachments are refused because `attachments` stays false.
 * The handler, its scope resolution and its read-only semantics are unchanged.
 */
export function mseCommandDefinition(bridge) {
  return {
    definitionId: 'missher-dsh-mse-learning/status',
    name: 'mse',
    description: 'MSE 持久学习召回状态与原因（不进入模型上下文）',
    input: { hint: '[status|why|detail|now <任务文本>]' },
    // The trusted session header supplies the project identity, so a first command in a
    // fresh or restored session reports the right scope without a warm turn cache.
    handler: invocation => Promise.resolve(handleMseCommand(bridge, invocation.rawInput, {
      sessionId: invocation.agent?.session?.id, projectKey: invocation.agent?.session?.header?.cwd })),
  }
}

export const name = 'mse-learning'
export const inject = ['agents', 'tools', 'llm', 'dshHomePath']

/** The Settings namespace this bundle owns; it is the profile row id, not the package name. */
export const SETTINGS_NAMESPACE = 'mse-learning'
/** Rolling window and cooldown the core enforces for automatic *and* manual reflection. */
const REFLECTION_LIMIT = 3
const REFLECTION_WINDOW_MS = 86_400_000
const REFLECTION_COOLDOWN_MS = 30 * 60_000
const REFLECTION_OUTPUT_TOKENS = 384
const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

function readVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch { return 'unknown' }
}

/** A persisted value that is not a valid integer in range is a default, never a silent pass. */
const boundedInt = (value, min, max, fallback) => Number.isSafeInteger(value) && value >= min && value <= max
  ? value : fallback

export function apply(ctx, config = {}) {
  const version = readVersion()
  // Every read goes through the live volatile snapshot, so a saved change is picked up by the
  // next use without a restart and without constructing a second engine (which would forget
  // every byte this session already spent).
  const readPolicy = () => ({
    enabled: readVolatile(config, 'enabled', SETTINGS_DEFAULTS.enabled) !== false,
    reflectionEnabled: readVolatile(config, 'reflectionEnabled', SETTINGS_DEFAULTS.reflectionEnabled) !== false,
    maxContextBytes: boundedInt(readVolatile(config, 'maxContextBytes', SETTINGS_DEFAULTS.maxContextBytes),
      CONTEXT_BYTES_MIN, CONTEXT_BYTES_MAX, SETTINGS_DEFAULTS.maxContextBytes),
    evaluationTokensPerDay: boundedInt(readVolatile(config, 'evaluationTokensPerDay', SETTINGS_DEFAULTS.evaluationTokensPerDay),
      0, EVALUATION_TOKENS_MAX, SETTINGS_DEFAULTS.evaluationTokensPerDay),
    evaluationCallsPerDay: boundedInt(readVolatile(config, 'evaluationCallsPerDay', SETTINGS_DEFAULTS.evaluationCallsPerDay),
      0, EVALUATION_CALLS_MAX, SETTINGS_DEFAULTS.evaluationCallsPerDay),
  })
  const initial = readPolicy()
  // Environment identity stays the SDK default (`default`) unless the operator opts
  // into a narrower fingerprint. Changing the default would silently orphan every
  // validated method recorded by an older version of this plugin.
  const environmentId = typeof config.environmentId === 'string' ? config.environmentId : undefined
  const engine = new LearningEngine({ stateRoot: ctx.dshHomePath('mse-learning'), adapterId: 'dsh',
    maxContextBytes: initial.maxContextBytes,
    evaluationTokensPerDay: initial.evaluationTokensPerDay, evaluationCallsPerDay: initial.evaluationCallsPerDay })
  const lifetime = new AbortController()
  const jobs = new JobQueue({ onEvent: event => { if (event.kind === 'failed' || event.kind === 'cancelled') ctx.logger.warn('mse-learning: job %s %s', event.jobKind, event.code ?? '') } })
  let disposed = false
  let legacyOwner = false
  // Identity of the last volatile snapshots seen. Volatile reads return a new frozen object per
  // committed write, so a reference change is exactly "the operator saved something".
  let seen = null
  let reasons = Object.freeze(['plugin_not_started'])
  const bridge = createHarnessBridge({ engine, environmentId,
    // Optional controlled-verification seams: an injected clock/timer lets a host exercise the
    // bounded settlement retry without real sleeping. Unset in normal use.
    ...(config.now === undefined ? {} : { now: config.now }),
    ...(config.settlement === undefined ? {} : { settlement: config.settlement }),
    createMessage: text => createUserMessage({ content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'mse-learning', form: 'instructions' } }),
    warn: code => ctx.logger.warn('mse-learning: %s', code),
    // The callback is installed once and decides for itself, so closing "automatic reflection"
    // in the settings takes effect on the next qualifying turn *and* cancels what is already
    // queued — rebuilding the bridge to drop the callback would discard in-flight turns.
    review: (input, route, signal) => {
      if (!mayReflect()) return { ok: false, code: 'reflection_disabled' }
      if (typeof route?.provider !== 'string' || typeof route?.model !== 'string') return { ok: false, code: 'route_unavailable' }
      return reflect(engine, input, async (request, signal_) => {
        let text = '', finished = false
        for await (const chunk of ctx.llm.stream({ provider: route.provider, model: route.model,
          ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}),
          messages: [createUserMessage({ content: [{ type: 'text', text: request.text }],
            source: { kind: 'plugin', plugin: 'mse-learning', form: 'instructions' } })],
          system: request.system, maxTokens: request.maxTokens, signal: signal_ })) {
          if (chunk.type === 'text-delta') { text += chunk.text; if (Buffer.byteLength(text) > 2048) throw new Error('reflection_too_large') }
          if (chunk.type === 'finish') { if (['error', 'aborted'].includes(chunk.reason.kind)) throw new Error('reflection_failed'); finished = true }
        }
        if (!finished) throw new Error('reflection_incomplete')
        // Last line of defence, after the answer is already in hand and before the core is
        // allowed to turn it into a lesson. A settings write and its subscription callback can
        // both be delivered while this provider request is in flight, so a decision made before
        // the call cannot be the one the result is committed under. Throwing settles the ticket
        // in `reflect`'s own cleanup, so a late result has nothing left to write.
        if (!mayReflect()) throw new Error('reflection_cancelled')
        return text
      }, AbortSignal.any([lifetime.signal, signal]))
    } })

  /** Whether automatic reflection may run and may still be committed, re-read at both ends. */
  function mayReflect() {
    if (disposed) return false
    if (sync().length > 0) return false
    return readPolicy().reflectionEnabled
  }

  /**
   * Recompute the effective running state from the three independent conditions.
   *
   * `userEnabled`, "a legacy controller holds MSE" and "this plugin is disposed" are kept apart
   * on purpose: folding them into one boolean is how a legacy release ends up silently
   * overriding a pause the operator asked for. The saved user intent is only ever changed by
   * the operator, and this function never writes it.
   */
  function sync() {
    const p = readPolicy()
    if (seen !== null && seen.enabled === p.enabled && seen.reflectionEnabled === p.reflectionEnabled
      && seen.maxContextBytes === p.maxContextBytes && seen.evaluationTokensPerDay === p.evaluationTokensPerDay
      && seen.evaluationCallsPerDay === p.evaluationCallsPerDay && seen.legacy === legacyOwner
      && seen.disposed === disposed) return reasons
    seen = { ...p, legacy: legacyOwner, disposed }
    try {
      engine.configure({ maxContextBytes: p.maxContextBytes, evaluationTokensPerDay: p.evaluationTokensPerDay,
        evaluationCallsPerDay: p.evaluationCallsPerDay })
    } catch (error) { ctx.logger.warn('mse-learning: %s', error?.code ?? 'invalid_configuration') }
    const next = []
    if (disposed) next.push('plugin_disposed')
    if (legacyOwner) next.push('legacy_controller')
    if (!p.enabled) next.push('user_paused')
    reasons = Object.freeze(next)
    bridge.setEnabled(next.length === 0)
    // A closed reflection switch cancels queued and in-flight reviews immediately; a late
    // runner result lands on an already-settled ticket and cannot become a lesson.
    if (next.length > 0 || !p.reflectionEnabled) bridge.abortReflections()
    if (next.length > 0) jobs.cancelAll(next[0])
    return reasons
  }

  /** One bounded, JSON-safe description of what is saved and what is actually in force. */
  function settingsSnapshot() {
    const p = readPolicy()
    const current = sync()
    let settlement = null
    try { settlement = bridge.settlementStatus() } catch { settlement = null }
    const review = { autoEnabled: p.reflectionEnabled && current.length === 0, savedAutoEnabled: p.reflectionEnabled,
      perDay: REFLECTION_LIMIT, windowMs: REFLECTION_WINDOW_MS, cooldownMs: REFLECTION_COOLDOWN_MS,
      maxTokens: REFLECTION_OUTPUT_TOKENS, sharedWithManual: true }
    try {
      const status = engine.status()
      review.usedLast24h = Number.isSafeInteger(status.reflectionsLast24h) ? status.reflectionsLast24h : 0
      review.allowance = Math.max(0, REFLECTION_LIMIT - review.usedLast24h)
    } catch { review.usedLast24h = null; review.allowance = null }
    return {
      namespace: SETTINGS_NAMESPACE, pluginVersion: version, settingsSource: 'plugin_config',
      user: { enabled: p.enabled, reflectionEnabled: p.reflectionEnabled, maxContextBytes: p.maxContextBytes,
        evaluationTokensPerDay: p.evaluationTokensPerDay, evaluationCallsPerDay: p.evaluationCallsPerDay },
      effective: { learning: current.length === 0, reflection: current.length === 0 && p.reflectionEnabled,
        reasons: [...current], legacyOwner, disposed },
      budget: { turnBytes: p.maxContextBytes, sessionBytes: 1536, maxLessons: 2, storeCap: null,
        evaluationTokensPerDay: p.evaluationTokensPerDay, evaluationCallsPerDay: p.evaluationCallsPerDay },
      review, settlement, jobs: jobs.status(),
    }
  }

  /** The single permission decision every job and every queued review travels through. */
  const permissions = () => {
    const current = sync()
    return current.length === 0 ? { allowed: true, code: null } : { allowed: false, code: current[0] }
  }

  /** Map a browser-supplied session id to a scope, using only Host-observed data. */
  async function resolveScope(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId.slice(0, 512) : ''
    if (id === '') return { ok: true, code: null, projectKey: undefined, sessionId: null, record: null }
    let query = null
    try { query = ctx.get('sessionQuery') ?? null } catch { query = null }
    if (query === null || typeof query.readSession !== 'function') return { ok: false, code: 'session_query_unavailable' }
    let snapshot
    try { snapshot = await query.readSession(id) } catch (error) {
      return { ok: false, code: typeof error?.code === 'string' ? error.code.slice(0, 64) : 'session_read_failed' }
    }
    const header = snapshot?.session
    if (header === undefined || header === null || header.id !== id) return { ok: false, code: 'session_unknown' }
    // Sub-agent sessions are internal work, not conversations a person picks here.
    if ((header.delegationDepth ?? 0) > 0 || header.origin === 'subagent') return { ok: false, code: 'session_internal' }
    const cwd = typeof header.cwd === 'string' && header.cwd.length > 0 && header.cwd.length <= 512 ? header.cwd : undefined
    return { ok: true, code: null, projectKey: cwd, sessionId: id, record: { archived: null } }
  }

  const service = { version, engine, bridge, environmentId, jobs, capabilities: bridge.capabilities,
    settings: () => settingsSnapshot(), permissions, resolveScope, scopeHashFor: shortHash,
    observedTurns: () => bridge.trackedSessions(),
    verifyArtifact: input => bridge.verifyArtifact(input),
    guardedAction: (input, action) => guardedAction(engine, input, action),
    recallStatus: (sessionId, projectKey) => ({ ...bridge.recallStatus(sessionId, projectKey), environmentId }),
    lastRecall: sessionId => bridge.lastRecall(sessionId),
    settlementStatus: () => bridge.settlementStatus(),
    diagnose: input => bridge.diagnose(input) }
  ctx.provide('mseLearning', service)
  // The Settings surfaces are separate Cordis services beside the core. `mseDetails` only reads;
  // `mseControl` is the human, authenticated write path and is never a model tool.
  applyDetails(ctx)
  applyControl(ctx)
  // Settings presentation policy only: this bundle ships its own page, so a schema-driven
  // generator must not also render one. It does not make the schema editable by itself.
  ctx.inject(['settings'], child => child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)))
  // A committed write to this namespace must take effect immediately — including while a
  // provider request is already in flight — rather than at the next turn or page refresh.
  // Without this, a pause was only observed by the next `sync()` call site, so an automatic
  // review could be started, and its result written, long after the operator paused.
  ctx.effect(() => ctx.on('settings/document-updated', namespace => {
    if (disposed) return
    if (typeof namespace === 'string' && namespace !== SETTINGS_NAMESPACE) return
    sync()
  }), 'mse-learning: settings subscription')
  // A visible slash command is the plugin-owned status surface: it is logged as a
  // command row, never appended to the model conversation, and costs no recall budget.
  ctx.inject(['commands'], child => child.effect(() => {
    if (typeof child.commands?.register !== 'function') return () => {}
    return child.commands.register(mseCommandDefinition(bridge))
  }))
  // Local, bounded visibility for the host log; diagnostics never enter the conversation.
  const noted = new Set()
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    // Memory-only read: the routine log line must not touch the learning store.
    const last = bridge.lastRecall(session.id)
    if (!last) return
    if (last.reason === RECALL_REASONS.storeFailure) ctx.logger.warn('mse-learning: %s', formatRecallLine({ last }))
    else if ((last.lessons ?? []).length > 0 && !noted.has(session.id)) {
      noted.add(session.id)
      if (noted.size > 512) noted.clear()
      ctx.logger.info('mse-learning: %s', formatRecallLine({ last }))
    }
  })
  // Do not run two automatic MSE controllers in the same host. A legacy controller appearing is
  // a temporary block, and its release only recomputes: an operator pause survives it.
  ctx.inject(['missherEvolutionCore'], child => child.effect(() => {
    legacyOwner = true
    sync()
    ctx.logger.warn('mse-learning: legacy MSE active; new learning paused')
    return () => { legacyOwner = false; sync() }
  }))
  ctx.on('agent/pre-step', (payload, next) => { sync(); return bridge.preStep(payload, next) })
  ctx.on('llm/stream', (options, next) => bridge.stream(options, next))
  ctx.on('session/event', (session, event) => { if (event.type === 'turn/start') sync(); return bridge.sessionEvent(session, event) })
  ctx.on('session/disposed', session => bridge.closeSession(session.id))
  ctx.on('tools/result', (exec, result) => bridge.toolExecution(exec, result))
  ctx.on('agent/error', payload => bridge.toolResult({ sessionId: payload.agent.session.id,
    turnId: payload.turn, failed: true }))
  sync()
  ctx.effect(() => () => {
    disposed = true
    jobs.dispose()
    lifetime.abort()
    bridge.dispose()
  })
}

export default { name, inject, apply }
