import { RECALL_REASONS } from '../src/index.mjs'
import { SettlementQueue, deadlineFromReceipt, isTransient } from '../src/settlement.mjs'

const key = (session, turn) => JSON.stringify([session, String(turn)])
/** Sessions arrive either as an object or as a bare id; both must behave identically. */
const idOf = value => typeof value === 'string' ? value : value?.id
/**
 * Internal work is recognised from trusted structure first: a non-user message
 * source, an explicit internal-review metadata flag, or an internal session origin.
 * As a defence-in-depth fallback for foreign/legacy controllers we also recognise
 * the exact internal review envelope; that text check is a heuristic, not a
 * trusted source, and is reported as such in the status.
 */
const INTERNAL_ENVELOPE = /^(?:\[\[mse-internal-review\]\]|Review the conversation above and (?:update the skill library|consider saving to memory))/iu
const INTERNAL_ORIGINS = new Set(['subagent', 'internal', 'system'])
function internalMetadata(messages) {
  return (messages ?? []).some(message => (message?.source?.kind === 'plugin' && message.source?.form === 'internal-review')
    || message?.metadata?.internalReview === true)
}
const messageText = message => typeof message.content === 'string' ? message.content
  : (message.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n')
function directText(messages) {
  return messages.filter(x => x.role === 'user' && x.source?.kind === 'user').map(messageText).join('\n').slice(0, 32768)
}
const STATUS_HISTORY = 8
const STATUS_SESSIONS = 64

/** Trusted host seam. None of its evidence callbacks are exposed as model-callable tools. */
export function createHarnessBridge({ engine, createMessage, review, warn = () => {}, now = Date.now, environmentId,
  settlement: settlementOptions = {} }) {
  const turns = new Map(), reviews = new Set(), statuses = new Map()
  let enabled = true, disposed = false, generation = 0
  // Reflection has its own generation. Closing "automatic reflection" must cancel the reviews it
  // queued without touching direct corrections, recall or settlement — bumping the main
  // generation would close every open turn and make the switch do far more than it says.
  let reflectionEpoch = 0
  const guarded = fn => { try { return fn() } catch (error) { warn(error.code ?? 'learning_unavailable') } }
  const active = epoch => enabled && !disposed && generation === epoch
  const statusFor = sessionId => {
    const existing = statuses.get(sessionId)
    if (existing) { statuses.delete(sessionId); statuses.set(sessionId, existing); return existing }
    const row = { recent: [], projectKey: undefined }
    statuses.set(sessionId, row)
    if (statuses.size > STATUS_SESSIONS) statuses.delete(statuses.keys().next().value)
    return row
  }
  /**
   * Record one recall outcome for later display. This never touches the model
   * conversation: it is read back by `/mse` and the SDK status surface only.
   */
  const note = (sessionOrId, turn, reason, extra = {}) => {
    try {
      const sessionId = idOf(sessionOrId)
      if (!sessionId) return null
      const row = statusFor(sessionId)
      if (extra.projectKey !== undefined) row.projectKey = extra.projectKey
      const last = row.recent[row.recent.length - 1]
      if (last && last.turn === String(turn) && last.reason === reason && last.outcome === undefined) return last
      const entry = { turn: String(turn), at: now(), reason, ...extra }
      delete entry.projectKey
      row.recent.push(entry)
      if (row.recent.length > STATUS_HISTORY) row.recent.splice(0, row.recent.length - STATUS_HISTORY)
      return entry
    } catch { return null }
  }
  const settle = (sessionOrId, turn, extra) => {
    const sessionId = idOf(sessionOrId)
    const row = sessionId === undefined ? undefined : statuses.get(sessionId)
    const last = row?.recent[row.recent.length - 1]
    if (last && last.turn === String(turn)) Object.assign(last, extra)
    return last ?? null
  }
  /**
   * Record the queue's own progress on the turn's status entry. The queue never re-runs
   * a model, tool, reflection or evaluation — only the frozen `complete` payload.
   */
  const settlementEvent = event => {
    const row = statuses.get(event.sessionId)
    if (!row) return
    // Results are matched on their own session/turn identity only. A late result for a
    // turn that already left the window must never be written onto the current turn.
    if (event.turnId === undefined) return
    const last = [...row.recent].reverse().find(item => item.turn === String(event.turnId))
    if (!last) return
    if (event.kind === 'settled') {
      last.outcome = event.result?.outcome ?? last.outcome
      last.attributed = event.result?.attributed ?? 0
      last.settleState = event.result?.duplicate ? 'duplicate' : 'settled'
      delete last.settleError
    } else if (event.kind === 'failed' || event.kind === 'exhausted') {
      // A durable item that the CORE retired as expired is reported as expired, not as a local
      // failure: the store already recorded the terminal row.
      last.settleState = event.code === 'settlement_expired' ? 'expired' : event.kind
      last.settleError = event.code
      last.settleAttempts = event.attempts
    } else if (event.kind === 'expired') {
      last.settleState = 'expired'
      last.settleError = 'deadline_exceeded'
    } else if (event.kind === 'unconfirmed') {
      // The deadline attempt could not be confirmed (a live writer held the lock, or the runtime
      // was unavailable). The core still holds the record and its original deadline; this says so
      // instead of claiming a terminal state nobody committed.
      last.settleState = 'unconfirmed'
      last.settleError = event.code
      last.settleAttempts = event.attempts
    } else if (event.kind === 'capacity') {
      last.settleState = 'capacity'
      last.settleError = 'settlement_capacity'
    } else if (event.kind === 'stopped') {
      last.settleState = 'stopped'
    }
  }
  // `now` is the queue's clock in its own unit; receipt deadlines arrive as epoch
  // milliseconds and are converted here, at the single boundary between the two scales.
  const wallNow = settlementOptions.wallNow ?? Date.now
  // A settlement the core has NOT acknowledged yet is retried as `enqueue → apply`, never as a
  // direct `complete`: bypassing the outbox would sidestep the core's own refusals (stopped,
  // paused, conflicting, changed receipt) and would leave the work permanently non-durable.
  //
  // `settlementApply` reports refusals as values, so they are translated here: a temporary gate
  // becomes a retryable error that keeps the original deadline and waits for an explicit resume,
  // while a terminal answer the core has already recorded stops immediately and is reported.
  const RETRYABLE_SETTLEMENT = new Set(['settlement_paused', 'settlement_guard_refused', 'settlement_stale_control'])
  const applyDurably = handle => {
    const status = engine.settlementStatus()
    const result = engine.settlementApply({ key: handle.key, payloadHash: handle.payloadHash,
      generation: status.control.generation }, trustedGuard)
    if (result?.ok === true) return { ...result, settlement: handle }
    throw Object.assign(new Error(result?.code ?? 'settlement_failed'), { code: result?.code ?? 'settlement_failed',
      terminal: !RETRYABLE_SETTLEMENT.has(result?.code) })
  }
  const settleThrough = payload => {
    // A turn that recalled nothing has no receipt to bind, and the core refuses to freeze such an
    // item — there is no durable settlement and no control to bypass. Its turn-end outcome is
    // recorded through the ordinary path and reported as durability-not-required, which is a
    // narrower fact than "durable".
    if (payload?.settlementRequired === false) return engine.complete(payload)
    const handle = payload?.settlement
    if (handle) return applyDurably(handle)
    const ack = engine.settlementEnqueue(payload)
    return applyDurably({ key: ack.key, payloadHash: ack.payloadHash })
  }
  const settlementQueue = new SettlementQueue({ complete: settleThrough, now,
    onEvent: settlementEvent,
    ...settlementOptions,
    // The queue's own transient set plus the core's temporary gates, each bounded by the same
    // absolute deadline the core enforces.
    isTransient: settlementOptions.isTransient ?? (error => isTransient(error?.code)
      || RETRYABLE_SETTLEMENT.has(error?.code)),
    ...(settlementOptions.deadlineForReceipt === undefined
      ? { deadlineForReceipt: ({ receiptExpiresAt, now: current }) => deadlineFromReceipt({ receiptExpiresAt,
        wallNow: wallNow(), now: current, maxAgeMs: settlementOptions.maxAgeMs ?? 5 * 60_000,
        clockUnit: settlementOptions.clockUnit ?? 'ms' }) }
      : {}),
    // The inverse conversion: a deadline restored from the durable document is in the store's
    // epoch milliseconds, and it keeps its original window in this process's clock unit.
    ...(settlementOptions.deadlineForEntry === undefined
      ? { deadlineForEntry: ({ deadline, now: current }) => {
        const remaining = deadline - wallNow()
        return current + ((settlementOptions.clockUnit ?? 'ms') === 'ms' ? remaining : remaining / 1000)
      } }
      : {}) })
  const close = (session, turn, cancelled = false) => {
    const sessionId = idOf(session), k = key(sessionId, turn), state = turns.get(k)
    if (!state) return
    const checks = [...state.checks.values()]
    const outcome = cancelled ? 'cancelled' : checks.some(x => !x.passed) ? 'failed' : checks.length ? 'verified' : 'unknown'
    // Freeze exactly one payload: identity, final outcome and the trusted check bindings.
    const payload = { ...state.input, outcome,
      ...(checks.length && !cancelled ? { evidence: { source: 'host_verifier', checkId: state.checkId,
        lessonIds: checks.map(x => x.lessonId), checks } } : {}) }
    // Durability is for a settlement that can carry credit, which means a turn that actually
    // recalled something. A turn with no receipt has nothing to bind and the core refuses to
    // freeze it; its outcome is still recorded through the ordinary path, and reported as
    // durability-not-required rather than as a saved settlement.
    const needsDurable = state.receiptExpiresAt !== undefined
    let durable = null
    if (needsDurable) {
      try { durable = engine.settlementEnqueue(payload) } catch (error) { durable = { ok: false, code: error?.code ?? 'store_failure' } }
    }
    const handle = durable?.durable === true ? { key: durable.key, payloadHash: durable.payloadHash } : null
    // One slot per frozen settlement: when the core acknowledged it, its durable key IS the slot
    // key, so a restored entry and a fresh one can never occupy two different slots.
    const queueKey = handle?.key ?? k
    const queued = settlementQueue.enqueue({ key: queueKey,
      payload: handle !== null ? { ...payload, settlement: handle }
        : { ...payload, settlementRequired: needsDurable },
      sessionId, receiptExpiresAt: state.receiptExpiresAt, durable: handle !== null })
    if (queued.state === 'capacity' || queued.state === 'conflict') {
      settle(sessionId, turn, { outcome: 'pending', attributed: 0,
        durable: needsDurable ? handle !== null : 'not_required',
        settleState: handle === null ? 'not_durable' : queued.state === 'capacity' ? 'capacity' : 'conflict',
        settleError: handle === null ? durable?.code ?? 'store_failure'
          : queued.state === 'capacity' ? 'settlement_capacity' : 'event_conflict' })
    } else {
      const attempt = settlementQueue.attempt(queueKey)
      if (attempt.state === 'settled') {
        settle(sessionId, turn, { outcome: attempt.result?.outcome ?? outcome,
          attributed: attempt.result?.attributed ?? 0, durable: needsDurable ? handle !== null : 'not_required',
          settleState: attempt.result?.duplicate ? 'duplicate' : 'settled' })
      } else {
        // A failed write is pending — never a settled success — and only transient
        // storage failures are retried.
        if (attempt.state === 'failed' || attempt.state === 'exhausted') warn(attempt.code ?? 'learning_unavailable')
        settle(sessionId, turn, { outcome: 'pending', attributed: 0,
          durable: needsDurable ? handle !== null : 'not_required',
          settleState: handle === null && attempt.state === 'retrying' ? 'not_durable' : attempt.state,
          settleError: attempt.code ?? 'learning_unavailable', settleAttempts: attempt.entry?.attempts ?? 1 })
      }
    }
    turns.delete(k)
    if (!cancelled && active(state.generation) && review && (checks.length || state.taskFailed || state.tools >= 2) && state.resultSummary) {
      const controller = new AbortController()
      const job = { controller, sessionId, generation: state.generation, epoch: reflectionEpoch }
      reviews.add(job)
      Promise.resolve().then(() => {
        if (!active(job.generation) || controller.signal.aborted || job.epoch !== reflectionEpoch) return
        return review({ ...state.input, taskSummary: state.taskSummary, resultSummary: state.resultSummary,
          outcome: state.taskFailed || outcome === 'failed' ? 'failed' : outcome === 'unknown' ? 'supported' : outcome },
        state.route, controller.signal)
      }).catch(() => { if (!controller.signal.aborted) warn('reflection_unavailable') }).finally(() => reviews.delete(job))
    }
  }
  /**
   * Host-local permission, read inside the core's write lock.
   *
   * It is a closure over live host truth — never a value captured before the lock — so a pause,
   * a legacy takeover or an archive that happened while the queue waited is seen. It is
   * installed by the adapter; until then the guard refuses, which is the conservative default.
   */
  let trustedGuard = () => ({ ok: false, reason: 'host_state_unknown' })
  const setTrustedGuard = fn => { trustedGuard = typeof fn === 'function' ? fn : () => ({ ok: false, reason: 'host_state_unknown' }) }
  /**
   * Re-drive durable items that this process did not acknowledge.
   *
   * It is never called from the constructor: an adapter must first establish its configuration
   * and its legacy truth, because recovering before those are known would settle work the user
   * has already paused or another plugin has taken over.
   */
  const restoreSettlements = () => {
    let status
    try { status = engine.settlementStatus() } catch (error) { return { ok: false, code: error?.code ?? 'store_failure', restored: 0 } }
    let restored = 0, expired = 0, failed = 0, waiting = 0
    for (const entry of status.pending) {
      // An entry past its deadline is still driven through the core so it is RETIRED with an
      // explicit `expired` history row. Skipping it would leave it holding a queue slot forever
      // and would let the next restart try it again.
      const payload = { settlement: { key: entry.key, payloadHash: entry.payloadHash } }
      const queued = settlementQueue.enqueue({ key: entry.key, payload, sessionId: null,
        // Durable: the core owns the deadline decision, including for an entry that is already
        // past it when this process starts.
        durable: true,
        // The original bounds travel with the entry: a restart must not hand the settlement a
        // fresh five minutes, and its attempt count is the core's, not a new one.
        queuedAt: entry.queuedAt, deadline: entry.deadline, maxAttempts: 4 })
      if (queued.state === 'capacity' || queued.state === 'conflict') continue
      const attempt = settlementQueue.attempt(entry.key)
      if (attempt.state === 'settled') restored += 1
      // A durable item past its deadline is retired BY THE CORE, so the local attempt reports a
      // terminal failure whose code is the core's own answer. Counting it as "expired" is what
      // actually happened in the document.
      else if (attempt.code === 'settlement_expired' || attempt.state === 'expired') expired += 1
      else if (attempt.state === 'failed' || attempt.state === 'exhausted') failed += 1
      else if (attempt.entry?.state === 'pending' || attempt.entry?.state === 'unconfirmed') waiting += 1
    }
    return { ok: true, restored, expired, failed, waiting, pending: status.counts.pending }
  }
  const bridge = {
    capabilities: Object.freeze({ requestAdoption: 'llm_stream_success', providerWireEvidence: false,
      trustedLessonChecks: true, artifactChecks: typeof engine.checkArtifact === 'function', reflectionCancellation: true,
      recallStatus: true, recallReasons: Object.values(RECALL_REASONS) }),
    async preStep(payload, next) {
      const epoch = generation
      const decision = await next()
      if (!active(epoch) || decision.kind === 'reject' || payload.signal?.aborted) return decision
      const session = payload.agent.session
      const prompt = directText(payload.messages ?? [])
      const projectKey = session.header?.cwd
      if (!prompt) return decision
      // Trusted structure first: nested/later-step work, an internal session origin,
      // or an explicitly marked internal-review message.
      if (payload.step !== 1 || INTERNAL_ORIGINS.has(session.header?.origin)
        || (session.header?.delegationDepth ?? 0) > 0 || internalMetadata(payload.messages)) {
        note(session, payload.turn, RECALL_REASONS.internalTask, { skipped: 'nested_or_later_step', projectKey })
        return decision
      }
      // Fallback heuristic for foreign internal prompts; reported distinctly so it is
      // never mistaken for a trusted-source classification.
      if (INTERNAL_ENVELOPE.test(prompt.trim())) {
        note(session, payload.turn, RECALL_REASONS.internalTask, { skipped: 'internal_review_text', projectKey })
        return decision
      }
      const k = key(session.id, payload.turn)
      if (turns.has(k)) return decision
      if (turns.size >= 256) { note(session, payload.turn, RECALL_REASONS.storeFailure, { code: 'turn_capacity', projectKey }); return decision }
      const input = { sessionId: session.id, turnId: String(payload.turn), prompt, origin: 'user',
        ...(projectKey ? { projectKey } : {}), ...(environmentId === undefined ? {} : { environmentId }) }
      let prepared
      try { prepared = engine.prepare(input) } catch (error) {
        note(session, payload.turn, RECALL_REASONS.storeFailure, { code: error?.code ?? 'learning_unavailable', projectKey })
        warn(error?.code ?? 'learning_unavailable')
        return decision
      }
      const message = prepared.context ? createMessage(prepared.context) : null
      // The turn keeps the same identity it was prepared with. Dropping environmentId here
      // would make the review learn a method in the default environment instead of this one.
      turns.set(k, { input: { sessionId: input.sessionId, turnId: input.turnId, projectKey: input.projectKey,
        ...(environmentId === undefined ? {} : { environmentId }) },
        receipt: prepared.receipt, lessons: prepared.lessons, lessonVersions: prepared.lessonVersions ?? [],
        context: prepared.context, messageId: message?.id, accepted: false, checks: new Map(), taskFailed: false, tools: 0,
        receiptExpiresAt: prepared.receiptExpiresAt ?? undefined,
        generation: epoch, taskSummary: prompt.slice(0, 800), resultSummary: '', route: payload.agent.options })
      note(session, payload.turn, prepared.reason ?? RECALL_REASONS.notLearned, { projectKey,
        bytes: prepared.bytes ?? 0, lessons: prepared.lessons ?? [], sources: prepared.sources ?? [],
        diagnostics: prepared.diagnostics ?? null, learned: prepared.learned ?? null })
      return message ? { ...decision, messages: [...decision.messages, message] } : decision
    },
    async *stream(options, next) {
      // Loop requests are frozen by the host. A matching final request plus a successful
      // downstream response proves use at this extension boundary, not provider HTTP delivery.
      const scoped = enabled && !disposed && !options.signal?.aborted
        ? [...turns.values()].filter(state => state.input.sessionId === options.sessionId) : []
      const candidates = scoped.filter(state => state.receipt && !state.accepted
        && (options.messages ?? []).some(message => message.id === state.messageId
          && message.source?.kind === 'plugin' && message.source?.plugin === 'mse-learning'
          && messageText(message) === state.context))
      for await (const chunk of next()) {
        if (chunk.type === 'finish' && ['stop', 'tool-calls', 'max-tokens'].includes(chunk.reason?.kind) && !options.signal?.aborted) {
          if (typeof options.provider === 'string' && typeof options.model === 'string') for (const state of scoped) {
            if (active(state.generation) && turns.get(key(state.input.sessionId, state.input.turnId)) === state) {
              state.route = { provider: options.provider, model: options.model,
                ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}) }
            }
          }
          for (const state of candidates) {
            if (!active(state.generation) || turns.get(key(state.input.sessionId, state.input.turnId)) !== state || state.accepted) continue
            const result = guarded(() => engine.accept({ receipt: state.receipt, lessonIds: state.lessons }))
            state.accepted = result?.ok === true
            if (state.accepted) settle(state.input.sessionId, state.input.turnId, { adopted: true })
          }
        }
        yield chunk
      }
    },
    sessionEvent(session, event) {
      if (!enabled || disposed) return
      if (event.type === 'turn/end') {
        const state = turns.get(key(session.id, event.data.turn))
        const reason = typeof event.data.reason === 'string' ? event.data.reason : event.data.reason?.kind
        if (state && reason === 'error') state.taskFailed = true
        close(session.id, event.data.turn, reason !== 'completed' && reason !== 'error')
      }
      if (event.type === 'assistant/message') {
        const state = turns.get(key(session.id, event.data.turn))
        if (state) state.resultSummary = messageText(event.data.message ?? event.data).slice(0, 1200)
      }
    },
    verification({ sessionId, turnId, checkId, passed, lessonIds, expectedVersion }) {
      const state = turns.get(key(sessionId, turnId))
      if (!state?.accepted || !active(state.generation) || typeof checkId !== 'string' || !checkId || checkId.length > 256
        || typeof passed !== 'boolean' || !Array.isArray(lessonIds) || !lessonIds.length
        || new Set(lessonIds).size !== lessonIds.length || !lessonIds.every(id => state.lessons.includes(id))) return false
      const versions = lessonIds.map(id => state.lessonVersions.find(row => row.id === id))
      if (versions.some(row => !row || (expectedVersion !== undefined && row.version !== expectedVersion)
        || (row.methodId && (expectedVersion === undefined || row.checkId !== checkId)))) return false
      for (const row of versions) state.checks.set(row.id, { lessonId: row.id, passed, version: row.version, checkId })
      state.checkId = checkId
      return true
    },
    verifyArtifact({ sessionId, turnId, lessonId, source, artifact }) {
      const state = turns.get(key(sessionId, turnId))
      if (!state?.accepted || !active(state.generation) || !state.lessons.includes(lessonId)) return { ok: false, code: 'lesson_not_adopted' }
      const version = state.lessonVersions.find(row => row.id === lessonId)?.version
      const result = guarded(() => engine.checkArtifact({ lessonId, ...(version ? { expectedVersion: version } : {}),
        projectKey: state.input.projectKey, source, artifact }))
      if (result?.ok && ['pass', 'fail'].includes(result.status)) {
        bridge.verification({ sessionId, turnId, lessonIds: [lessonId], checkId: result.checkId,
          expectedVersion: result.version, passed: result.status === 'pass' })
      }
      return result ?? { ok: false, code: 'artifact_check_unavailable' }
    },
    toolResult({ sessionId, turnId, failed, readOnly = false }) {
      const state = turns.get(key(sessionId, turnId))
      if (!state) return
      state.tools += 1
      if (!readOnly || failed) state.checks.clear()
      if (failed) state.taskFailed = true
    },
    toolExecution(exec, result) {
      const session = exec.agent?.session
      if (!session || typeof exec.callId !== 'string') return
      const count = session.seq ?? session.events?.length ?? 0
      for (let n = count - 1; n >= Math.max(0, count - 1000); n--) {
        const event = session.eventAt?.(n) ?? session.events?.[n]
        if (event?.type !== 'tool/call' || event.data.callId !== (exec.rootCallId ?? exec.callId)) continue
        bridge.toolResult({ sessionId: session.id, turnId: event.data.turn,
          failed: result.isError === true || exec.signal?.aborted === true || result.value?.timedOut === true
            || (typeof result.value?.exitCode === 'number' && result.value.exitCode !== 0),
          readOnly: exec.name === 'read' || exec.name === 'read_image' })
        break
      }
    },
    /** Whether the controller currently prepares turns at all. */
    isEnabled() { return enabled && !disposed },
    /**
     * Project identity for a status read. The caller may supply it from the trusted
     * session header, so a first command in a fresh or restored session does not
     * depend on a previous turn having populated the in-memory cache.
     */
    projectKeyFor(sessionId, projectKey) {
      if (projectKey !== undefined) return projectKey
      return (sessionId === undefined ? undefined : statuses.get(sessionId)?.projectKey)
    },
    /** Last recorded recall outcome from memory only: no learning-state read. */
    lastRecall(sessionId) {
      const row = sessionId === undefined ? undefined : statuses.get(sessionId)
      return row?.recent[row.recent.length - 1] ?? null
    },
    /** Recent per-turn recall outcomes, plus a read-only view of the local library. */
    recallStatus(sessionId, projectKey) {
      const row = sessionId === undefined ? undefined : statuses.get(sessionId)
      const scope = this.projectKeyFor(sessionId, projectKey)
      const report = { ok: true, sessionId: sessionId ?? null, enabled: this.isEnabled(),
        last: row?.recent[row.recent.length - 1] ?? null,
        recent: row ? [...row.recent] : [], reasons: Object.values(RECALL_REASONS),
        settlement: settlementQueue.status(), settlementCapacity: settlementQueue.maxItems }
      if (scope !== undefined) report.projectKey = scope
      try {
        report.library = engine.diagnose({ ...(scope === undefined ? {} : { projectKey: scope }),
          ...(environmentId === undefined ? {} : { environmentId }), ...(sessionId === undefined ? {} : { sessionId }) })
      } catch (error) { report.library = null; report.libraryError = error?.code ?? 'learning_unavailable' }
      return report
    },
    /** Read-only lesson rows for this session's scope, used by the expanded status view. */
    listLessons(sessionId, projectKey) {
      const scope = this.projectKeyFor(sessionId, projectKey)
      try { return engine.list({ ...(scope === undefined ? {} : { projectKey: scope }), limit: 20 }).lessons }
      catch { return [] }
    },
    /** Read-only dry run: why would (or would not) this prompt recall right now? */
    diagnose({ sessionId, prompt, projectKey }) {
      try {
        const scope = this.projectKeyFor(sessionId, projectKey)
        return engine.diagnose({ ...(prompt === undefined ? {} : { prompt }),
          ...(scope === undefined ? {} : { projectKey: scope }),
          ...(environmentId === undefined ? {} : { environmentId }), ...(sessionId === undefined ? {} : { sessionId }) })
      } catch (error) { return { ok: false, code: error?.code ?? 'learning_unavailable' } }
    },
    /** Frozen settlements still awaiting an idempotent replay, with their bounds. */
    settlementStatus() { return settlementQueue.status() },
    /**
     * The durable queue as the core sees it: pending/terminal counts, control generation and
     * pause state. Read-only, and it never writes to the document.
     */
    durableStatus() { return engine.settlementStatus() },
    /** Install the host-local permission the core reads inside its write lock. */
    setTrustedGuard,
    /** Explicit recovery entry point; the adapter decides when the host truth is ready. */
    restoreSettlements,
    /** Exact, owner-scoped stop of one session's durable settlements. */
    stopSettlements(sessionId, reason) { return engine.settlementStop({ sessionId, reason }) },
    /**
     * The same stop, addressed by an entry this engine already acknowledged.
     *
     * It exists for a session whose raw id is no longer available — a directory scan can report
     * that a session is gone without naming it again. The core derives the session from the
     * entry inside its lock, so no caller-supplied owner, scope or session hash is involved.
     */
    stopSettlementsByKey(key, payloadHash, reason) {
      return engine.settlementStop({ key, payloadHash, reason })
    },
    /** Explicit user pause over the durable queue. */
    pauseSettlements(paused) { return engine.settlementPause({ paused }) },
    /** Bounded terminal settlement history, newest last, with session/turn identity. */
    settlementHistory() { return settlementQueue.history() },
    closeSession(sessionId) {
      for (const state of [...turns.values()]) if (state.input.sessionId === sessionId) close(sessionId, state.input.turnId, true)
      for (const job of reviews) if (job.sessionId === sessionId) job.controller.abort()
      // Frozen outcomes stay as they are; only this session's retries stop.
      settlementQueue.stopSession(sessionId)
    },
    /**
     * Cancel queued and in-flight reviews only, leaving recall, corrections and settlement
     * exactly as they are. Bumping the reflection epoch also discards a queued microtask that
     * has not called the runner yet, so switching reflection off and straight back on cannot
     * revive an old job: it either never started, or its aborted ticket no longer settles.
     */
    abortReflections() {
      reflectionEpoch += 1
      const pending = [...reviews]
      for (const job of pending) job.controller.abort()
      return pending.length
    },
    /** Whether a reflection runner is currently installed and allowed. */
    isReflecting() { return enabled && !disposed && typeof review === 'function' },
    /** Sessions with an in-process status row; used for an honest "no runs yet" display. */
    trackedSessions() { return statuses.size },
    /**
     * Apply the current enablement.
     *
     * `resume` is what separates a READ from a LIFECYCLE MOMENT. Recomputing enablement while
     * answering a read-only status question must report the current configuration without
     * scheduling a single attempt — otherwise looking at the settings page would itself settle
     * work. Only an explicit lifecycle caller may pass `resume: true`.
     */
    setEnabled(value, { resume = true } = {}) {
      const next = value === true && !disposed
      if (next !== enabled) generation += 1
      enabled = next
      if (enabled && resume !== true) {
        // Read-only: the fact is recorded, nothing is scheduled. It is also NOT memoised as
        // "already resumed", so the explicit lifecycle moment still resumes.
        return undefined
      }
      if (!enabled) {
        for (const state of [...turns.values()]) close(state.input.sessionId, state.input.turnId, true)
        for (const job of reviews) job.controller.abort()
        // Pausing stops new attempts; already frozen settlements keep their snapshot
        // and deadline, and resume only replays unexpired local `complete` calls.
        settlementQueue.pause()
      } else settlementQueue.resume()
    },
    dispose() { bridge.setEnabled(false); settlementQueue.dispose(); disposed = true },
  }
  return bridge
}
