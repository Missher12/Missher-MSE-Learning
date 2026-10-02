import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createHash } from 'node:crypto'
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
  /**
   * Recompute what is in force.
   *
   * @param options.resume - `true` only from an explicit lifecycle moment (a real settings save,
   *   service readiness, a turn boundary). A read-only status or settings question passes
   *   `false`: it may report the current configuration, but it must not schedule a settlement,
   *   and it must not memoise the state as already-resumed either — otherwise the later real
   *   event would look unchanged and the queue would never resume.
   */
  function sync({ resume = false } = {}) {
    const p = readPolicy()
    if (seen !== null && seen.enabled === p.enabled && seen.reflectionEnabled === p.reflectionEnabled
      && seen.maxContextBytes === p.maxContextBytes && seen.evaluationTokensPerDay === p.evaluationTokensPerDay
      && seen.evaluationCallsPerDay === p.evaluationCallsPerDay && seen.legacy === legacyOwner
      && seen.disposed === disposed) {
      // Nothing changed, but a read-only recompute must not swallow the explicit lifecycle moment
      // that follows it: the enablement is re-applied so the queue can actually resume.
      if (resume) bridge.setEnabled(reasons.length === 0, { resume: true })
      return reasons
    }
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
    bridge.setEnabled(next.length === 0, { resume })
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
      // The durable pause the user asked for, and — if the control write has not been confirmed —
      // the exact pending fact. The settings document being saved is not this confirmation.
      settlementControl: { userPaused: lastControlPaused, pending: pendingControl },
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
    /** The durable queue as the core sees it: counts, control generation and pause state. */
    durableStatus: () => bridge.durableStatus(),
    /** Read-only durable/control view for the status card; never a recovery entry point. */
    durableSettlement: () => durableStatusView(),
    /** Explicit recovery/stop entry points, for the host and for controlled verification. */
    restoreSettlements: () => bridge.restoreSettlements(),
    stopSettlements: (sessionId, reason) => bridge.stopSettlements(sessionId, reason),
    /** Host-local permission is installed by the adapter; a controlled fixture may state it. */
    setTrustedGuard: fn => bridge.setTrustedGuard(fn),
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
    // The host emits this event with a `void` return, so it is a notification, not a receipt:
    // the settings document being saved proves nothing about the durable settlement control.
    // The control transaction is attempted here and its outcome is reported separately.
    // A saved settings document is an explicit lifecycle moment.
    invalidateHostFacts()
    void refreshHostFacts().catch(() => {})
    sync({ resume: true })
    const wanted = !(volatileSettings().enabled ?? SETTINGS_DEFAULTS.enabled)
    if (wanted !== lastControlPaused) applySettlementControl(wanted)
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
    // A takeover changes who may settle, so every confirmed fact is dropped rather than reused.
    invalidateHostFacts()
    sync()
    ctx.logger.warn('mse-learning: legacy MSE active; new learning paused')
    return () => { legacyOwner = false; invalidateHostFacts(); sync() }
  }))
  // The user's own pause is a durable fact about settlements, and it is kept apart from the
  // enablement that governs learning: releasing a legacy takeover must never lift it.
  let lastControlPaused = null
  let pendingControl = null
  const volatileSettings = () => {
    try { return { enabled: readVolatile(config, 'enabled', SETTINGS_DEFAULTS.enabled) !== false } }
    catch { return { ...SETTINGS_DEFAULTS } }
  }
  /**
   * Attempt the control transaction and record what actually happened.
   *
   * A failure is NOT presented as a confirmed pause: the state stays `pending` with its cause
   * and attempt count, and the read-only status surface reports exactly that.
   */
  const applySettlementControl = paused => {
    const attempts = (pendingControl?.paused === paused ? pendingControl.attempts : 0) + 1
    try {
      const result = bridge.pauseSettlements(paused)
      if (result?.ok === true) {
        lastControlPaused = paused
        pendingControl = null
        return { ok: true, paused }
      }
      pendingControl = { paused, attempts, error: result?.code ?? 'control_failed' }
    } catch (error) {
      pendingControl = { paused, attempts, error: error?.code ?? 'control_failed' }
    }
    ctx.logger.warn('mse-learning: settlement control pending (%s)', pendingControl.error)
    return { ok: false, paused, ...pendingControl }
  }
  // A bounded retry, driven only by an explicit lifecycle moment. A read-only settings or status
  // read never retries, and never writes.
  const retrySettlementControl = () => {
    if (pendingControl === null || pendingControl.attempts >= 3) return
    applySettlementControl(pendingControl.paused)
  }
  /**
   * The permission the core reads INSIDE its write lock.
   *
   * It re-reads live host truth every time: the configured enablement, the legacy takeover, this
   * plugin's own disposal, and the workspace's persisted archive truth. A value captured before
   * the lock would let a settlement land after the user paused or archived the work.
   */
  /**
   * Confirmed host facts, and their lifetime.
   *
   * `listSessions` is asynchronous, so its result cannot be consulted inside the synchronous
   * guard. Instead a refresh produces a short-lived snapshot: the guard reads only the CURRENT
   * confirmed snapshot, and anything that changes the truth (disposal, a legacy takeover, a
   * settings save) invalidates it immediately. A stale or absent snapshot is `host_state_unknown`,
   * which refuses — it is never evidence that a session still exists.
   */
  const FACTS_TTL_MS = 30_000
  let hostFacts = null
  let factsEpoch = 0
  const invalidateHostFacts = () => { hostFacts = null; factsEpoch += 1 }
  const currentFacts = () => {
    if (hostFacts === null) return null
    if (Date.now() - hostFacts.at > FACTS_TTL_MS) return null
    return hostFacts
  }
  const refreshHostFacts = async () => {
    const epoch = factsEpoch
    let facts = null
    try {
      const registry = ctx.get('workspaceRegistry')
      const ids = registry?.archivedSessionIds
      if (ids === undefined) return null
      if (!(ids instanceof Set) && !Array.isArray(ids)) return null
      const archived = new Set([...ids].map(id => createHash('sha256').update(String(id)).digest('hex')))
      const query = ctx.get('sessionQuery')
      if (query === undefined || typeof query.listSessions !== 'function') return null
      // A real, awaited complete directory. A bounded UI scan is not one, and a rejection is
      // unknown rather than "nothing is there".
      const listed = await query.listSessions(new AbortController().signal)
      const rows = Array.isArray(listed) ? listed : Array.isArray(listed?.sessions) ? listed.sessions : null
      if (rows === null || listed?.truncated === true || listed?.complete === false) return null
      const known = new Set()
      for (const row of rows) {
        const id = row?.header?.id ?? row?.id ?? row?.sessionId
        if (typeof id !== 'string' || id.length === 0) return null
        known.add(createHash('sha256').update(id).digest('hex'))
      }
      facts = { ok: true, archived, known, at: Date.now() }
    } catch { return null }
    // A refresh that lands after the world moved must not authorise anything: the epoch is
    // compared across the await, so a disposal or a settings change discards the result.
    if (epoch !== factsEpoch || disposed) return null
    hostFacts = facts
    return facts
  }

  /**
   * Permanent stops the host confirmed but the CORE has not accepted yet.
   *
   * An archive or a confirmed deletion is a fact about the session, not a request that may be
   * dropped because a writer happened to hold the store lock: a settled settlement would then
   * credit work the user has permanently ended. Each record keeps its own original window and
   * attempt count, is re-checked against LIVE host truth before every retry, and is retried only
   * at legitimate lifecycle moments (never from a read-only status call). A stop that was not
   * confirmed is never counted as one.
   */
  // The retry budget is SPREAD over the window instead of being spent in the first seconds: an
  // outage that outlives a fixed one-second cadence would otherwise exhaust the budget while the
  // lock is still held, which is exactly the failure this convergence exists to prevent. The
  // delays sum to just under the window, so the last attempt lands at its end.
  const STOP_ATTEMPTS = 6
  const STOP_RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 14_000]
  const STOP_WINDOW_MS = 30_000
  const pendingStops = new Map()
  let stopTimer = null
  const hashId = value => createHash('sha256').update(String(value)).digest('hex')

  const archivedHashes = () => {
    const ids = ctx.get('workspaceRegistry')?.archivedSessionIds
    if (ids === undefined || (!(ids instanceof Set) && !Array.isArray(ids))) return null
    return new Set([...ids].map(hashId))
  }

  /** Is this stop still justified by the host's CURRENT truth? */
  const stopStillJustified = record => {
    const archived = archivedHashes()
    if (archived === null) return false
    // A deferred stop may name the session by its raw id or only by the identity the core's own
    // public record carries (a sweep has no raw id at all). Either form is compared against the
    // SAME archive truth, so an already-archived item is never withdrawn just because the record
    // happens to lack a raw id.
    const identity = typeof record.sessionHash === 'string' && record.sessionHash.length > 0
      ? record.sessionHash
      : record.sessionId !== undefined ? hashId(record.sessionId) : null
    if (identity === null) return false
    if (record.reason === 'archived') return archived.has(identity)
    const facts = currentFacts()
    if (facts === null) return false
    return !archived.has(identity) && !facts.known.has(identity)
  }

  const submitStop = record => {
    try {
      return record.key !== undefined
        ? bridge.stopSettlementsByKey(record.key, record.payloadHash, record.reason)
        : bridge.stopSettlements(record.sessionId, record.reason)
    } catch (error) {
      return { ok: false, code: error?.code ?? 'control_failed' }
    }
  }

  /** One bounded submission. Only the core's own `ok` counts; anything else stays visible. */
  const attemptPermanentStop = record => {
    if (!stopStillJustified(record)) {
      pendingStops.delete(record.id)
      return { ...record, withdrawn: true }
    }
    if (record.attempts >= STOP_ATTEMPTS || Date.now() >= record.deadline) {
      record.error = record.error ?? 'stop_unconfirmed'
      record.exhausted = true
      return record
    }
    record.attempts += 1
    const result = submitStop(record)
    if (result?.ok === true) {
      pendingStops.delete(record.id)
      return { ...record, confirmed: true, stopped: result.stopped ?? 0, sessionHash: result.sessionHash }
    }
    record.error = result?.code ?? 'control_failed'
    return record
  }

  /** Records that still deserve an attempt: bounded by their own attempts and window. */
  const stoppable = () => [...pendingStops.values()]
    .filter(record => record.exhausted !== true && record.attempts < STOP_ATTEMPTS && Date.now() < record.deadline)

  /**
   * Drive the unconfirmed permanent stops on this process's own timer.
   *
   * The original failure was that an archive or a delete converged only if the user happened to
   * start another turn. A confirmed permanent stop must not depend on that: it retries here,
   * bounded by each record's own attempts and window, and the chain ends by itself once nothing
   * is left to try. Read-only status calls never start it.
   */
  const nextStopDelay = () => {
    const waiting = stoppable()
    if (waiting.length === 0) return null
    return waiting.reduce((soonest, record) => {
      const index = Math.max(0, Math.min(record.attempts - 1, STOP_RETRY_DELAYS.length - 1))
      const planned = STOP_RETRY_DELAYS[index]
      return soonest === null ? planned : Math.min(soonest, planned)
    }, null)
  }

  const scheduleStopRetry = () => {
    if (disposed || stopTimer !== null) return
    const delay = nextStopDelay()
    if (delay === null) return
    stopTimer = setTimeout(() => {
      stopTimer = null
      retryPendingStops()
      scheduleStopRetry()
    }, delay)
    if (typeof stopTimer?.unref === 'function') stopTimer.unref()
  }

  const requestPermanentStop = (id, seed) => {
    const existing = pendingStops.get(id)
    // A repeated notice for the same identity never resets its attempts or its window.
    const record = existing ?? { ...seed, id, attempts: 0, deadline: Date.now() + STOP_WINDOW_MS, error: null }
    pendingStops.set(id, record)
    const outcome = attemptPermanentStop(record)
    if (outcome.confirmed !== true && outcome.withdrawn !== true) {
      // Keep the record visible with its exact cause instead of reporting a stop that never landed,
      // and keep the bounded retry running so it converges without another turn.
      ctx.logger.warn('mse-learning: settlement stop unconfirmed (%s)', record.error)
      scheduleStopRetry()
    }
    return outcome
  }

  /** Retry the confirmed-but-unaccepted stops. Called from lifecycle moments only. */
  const retryPendingStops = () => {
    for (const record of [...pendingStops.values()]) attemptPermanentStop(record)
    return pendingStops.size
  }

  /** Stop the pending settlements of sessions the host has permanently ended. */
  const sweepSettlements = () => {
    const facts = currentFacts()
    if (facts === null) return { ok: false, reason: 'host_state_unknown', stopped: 0, failed: 0 }
    let status
    try { status = bridge.durableStatus() } catch { return { ok: false, reason: 'store_failure', stopped: 0, failed: 0 } }
    let stopped = 0
    let failed = 0
    for (const entry of status.pending ?? []) {
      const reason = facts.archived.has(entry.sessionHash) ? 'archived'
        : facts.known.has(entry.sessionHash) ? null : 'session_deleted'
      if (reason === null) continue
      // Addressed by the acknowledged handle: the raw id may no longer exist to name.
      const outcome = requestPermanentStop('entry:' + entry.key, { key: entry.key, payloadHash: entry.payloadHash,
        sessionHash: entry.sessionHash, reason })
      if (outcome.confirmed === true) stopped += 1
      else failed += 1
    }
    return { ok: true, stopped, failed }
  }

  /**
   * Read-only durable status for the plugin's own status card.
   *
   * It is a pure read: nothing here recovers, restores, retries or writes, and a read-only
   * question never becomes the entry point that finishes a pending control change. It carries
   * counts and control facts only — no payload, no receipt, no path, no session identity — so the
   * card can say whether the durable queue is really empty and whether a pause was really
   * confirmed, instead of presenting a saved settings document as an effective control.
   */
  const durableStatusView = () => {
    let local = null
    let core = null
    try { local = bridge.settlementStatus() } catch { local = null }
    try {
      const status = bridge.durableStatus()
      const counts = status?.counts ?? {}
      const whole = name => (Number.isSafeInteger(counts[name]) ? counts[name] : null)
      core = { ok: status?.ok === true,
        pending: whole('pending'), expired: whole('expired'), terminal: whole('terminal'),
        settled: whole('settled'), stopped: whole('stopped'),
        generation: Number.isSafeInteger(status?.control?.generation) ? status.control.generation : null,
        userPaused: typeof status?.control?.userPaused === 'boolean' ? status.control.userPaused : null,
        stopTombstones: Number.isSafeInteger(status?.control?.stops) ? status.control.stops : null }
    } catch { core = { ok: false, code: 'store_unavailable' } }
    const states = {}
    for (const row of local ?? []) states[row.state] = (states[row.state] ?? 0) + 1
    const stops = [...pendingStops.values()]
    return { readOnly: true, core,
      local: { live: local === null ? null : local.length, states },
      pause: { userPaused: lastControlPaused,
        // The pending fact says WHICH change is unconfirmed: a first pause can leave
        // `userPaused` null, and a resume is a different statement from a pause.
        pending: pendingControl === null ? null : { paused: pendingControl.paused === true,
          attempts: pendingControl.attempts, error: pendingControl.error } },
      stops: { unconfirmed: stops.length, exhausted: stops.filter(record => record.exhausted === true).length,
        // Bounded diagnostics only: how far the retries have got, never an identity or a payload.
        attempts: stops.reduce((most, record) => Math.max(most, record.attempts ?? 0), 0),
        errors: [...new Set(stops.map(record => record.error).filter(error => typeof error === 'string'))].slice(0, 4) } }
  }

  /** Confirm the facts, then sweep and restore inside that one confirmed burst. */
  const refreshAndRecover = async () => {
    const facts = await refreshHostFacts()
    if (facts === null) return { ok: false, reason: 'host_state_unknown' }
    const swept = sweepSettlements()
    let restored = null
    try { restored = bridge.restoreSettlements() } catch (error) {
      ctx.logger.warn('mse-learning: settlement restore: %s', error?.code ?? 'unknown')
    }
    return { ok: true, swept, restored }
  }

  // Recovery waits for the host services it depends on. The session directory and the archive
  // registry can appear well after this plugin is applied, and they arrive through the same
  // injection this effect subscribes to — so a late service still triggers the restore, with no
  // dependence on the user opening settings or running a read-only command.
  ctx.inject(['sessionQuery', 'workspaceRegistry'], child => child.effect(() => {
    // Services becoming available is an explicit readiness moment.
    sync({ resume: true })
    // The services can appear long after this plugin is applied, so the refresh is driven by
    // their arrival — not by the user opening settings or running a read-only command.
    refreshAndRecover().catch(error => ctx.logger.warn('mse-learning: settlement recover: %s',
      error?.code ?? 'unknown'))
    return () => invalidateHostFacts()
  }))

  bridge.setTrustedGuard(({ entry }) => {
    if (disposed) return { ok: false, reason: 'plugin_disposed' }
    if (!bridge.isEnabled()) return { ok: false, reason: 'learning_disabled' }
    if (legacyOwner) return { ok: false, reason: 'legacy_owner' }
    // Archive truth is synchronous and in-memory, so it is read LIVE here — not from a snapshot
    // that a lock wait could have outlived. A control write that failed under `lock_busy` must
    // still be honoured on the retry that follows it.
    let archivedNow
    try {
      const registry = ctx.get('workspaceRegistry')
      const ids = registry?.archivedSessionIds
      if (ids === undefined || (!(ids instanceof Set) && !Array.isArray(ids))) {
        return { ok: false, reason: 'host_state_unknown' }
      }
      archivedNow = new Set([...ids].map(id => createHash('sha256').update(String(id)).digest('hex')))
    } catch { return { ok: false, reason: 'host_state_unknown' } }
    if (archivedNow.has(entry.sessionHash)) return { ok: false, reason: 'session_archived' }
    // Existence comes from the awaited directory snapshot, which cannot be read here.
    const facts = currentFacts()
    if (facts === null) return { ok: false, reason: 'host_state_unknown' }
    if (!facts.known.has(entry.sessionHash)) return { ok: false, reason: 'session_deleted' }
    return { ok: true }
  })
  ctx.on('agent/pre-step', (payload, next) => {
    // An explicit turn boundary is a lifecycle moment: it may resume scheduling, and it is also
    // the refresh entry point that keeps the directory snapshot from ageing out with no way back.
    if (currentFacts() === null) void refreshHostFacts().catch(() => {})
    sync({ resume: true })
    // An explicit turn boundary is the only place a failed control write is retried.
    if (payload.step === 1) {
      retrySettlementControl()
      retryPendingStops()
    }
    return bridge.preStep(payload, next)
  })
  ctx.on('llm/stream', (options, next) => bridge.stream(options, next))
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') sync({ resume: true })
    return bridge.sessionEvent(session, event)
  })
  // The api-level removal notice is the same kind of fact: it invalidates, it does not delete.
  // It is also the moment a now-missing session's still-pending settlements are swept, using the
  // freshly confirmed directory rather than the notice itself as the evidence.
  ctx.on('api-session/removed', session => {
    const sessionId = typeof session === 'string' ? session : session?.id
    if (typeof sessionId === 'string') bridge.closeSession(sessionId)
    invalidateHostFacts()
    void refreshHostFacts().then(facts => { if (facts !== null) sweepSettlements() }).catch(() => {})
  })
  ctx.on('session/disposed', session => {
    bridge.closeSession(session.id)
    // A disposed run-time object is not proof the session was deleted: it invalidates the
    // directory snapshot and asks for a fresh one, and the guard decides on the answer.
    invalidateHostFacts()
    void refreshHostFacts().then(facts => { if (facts !== null) sweepSettlements() }).catch(() => {})
  })
  // A session's run-time object being disposed is NOT proof the user deleted or archived it; it
  // is the paired destruction notice for the live object. Only the workspace's own persisted
  // archive truth permanently stops a session's durable settlements, and only by its exact id.
  ctx.inject(['workspaceRegistry'], child => child.effect(() => {
    const stopExact = (sessionId, reason) => requestPermanentStop('session:' + sessionId,
      { sessionId, sessionHash: hashId(sessionId), reason })
    return child.on('workspace/session-stop', request => {
      const sessionId = request?.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      // The workspace's persisted archive truth is the fact; the stop is what makes it real for
      // the durable queue. It is retried, bounded and truth-checked, if the store was busy.
      stopExact(sessionId, 'archived')
      bridge.closeSession(sessionId)
    })
  }))
  ctx.on('tools/result', (exec, result) => bridge.toolExecution(exec, result))
  ctx.on('agent/error', payload => bridge.toolResult({ sessionId: payload.agent.session.id,
    turnId: payload.turn, failed: true }))
  sync()
  ctx.effect(() => () => {
    // Disposal stops this process; it does not convert acknowledged settlements into permanent
    // cancellations. Their durable records stay, and the next process decides with fresh truth.
    disposed = true
    if (stopTimer !== null) { clearTimeout(stopTimer); stopTimer = null }
    invalidateHostFacts()
    jobs.dispose()
    lifetime.abort()
    bridge.dispose()
  })
}

export default { name, inject, apply }
