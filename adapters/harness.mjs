import { RECALL_REASONS } from '../src/index.mjs'
import { SettlementQueue, deadlineFromReceipt, isTransient } from '../src/settlement.mjs'

const key = (session, turn) => JSON.stringify([session, String(turn)])
/** Sessions arrive either as an object or as a bare id; both must behave identically. */
const idOf = value => typeof value === 'string' ? value : value?.id
/**
 * MSE's own producer identity, in BOTH the released wrapper and the current producer-owned kind.
 *
 * The session document is format v4 now, and its admission rule is explicit: every message source
 * must name a PRODUCER-OWNED kind, and the retired `{ kind: 'plugin', plugin: ... }` wrapper is
 * refused on write (`format v4 message requires a producer-owned source kind`). The host's own
 * V3→V4 converter lifts a released plugin wrapper into `plugin:<name>` and DROPS the `plugin`
 * field, so `{ kind: 'plugin', plugin: 'mse-learning', form: 'instructions' }` becomes
 * `{ kind: 'plugin:mse-learning', form: 'instructions' }`.
 *
 * Therefore the plugin WRITES only the producer-owned shape (`mseMessageSource`) and RECOGNISES
 * both: a session written before the migration, an older controller still in memory, and a row the
 * host has already converted all carry one of the two. This is structural identity, never a text
 * heuristic: an unrelated `plugin:<other>` producer, a plain user message, or anything without that
 * exact identity is never treated as MSE's own.
 */
export const MSE_PRODUCER_KIND = 'plugin:mse-learning'
/** The released V3 wrapper's plugin name, as it appears in historical and not-yet-migrated rows. */
const MSE_PLUGIN_NAME = 'mse-learning'
/** The one source every message this plugin writes carries. */
export function mseMessageSource(form) {
  return form === undefined ? { kind: MSE_PRODUCER_KIND } : { kind: MSE_PRODUCER_KIND, form }
}
/** Is this message source MSE's own, in either shape? */
export function isMseSource(source) {
  if (source === null || typeof source !== 'object' || typeof source.kind !== 'string') return false
  if (source.kind === MSE_PRODUCER_KIND) return true
  return source.kind === 'plugin' && source.plugin === MSE_PLUGIN_NAME
}
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
  return (messages ?? []).some(message => {
    if (message?.metadata?.internalReview === true) return true
    const source = message?.source
    if (source === null || typeof source !== 'object') return false
    // The internal-review envelope, in the released universal wrapper AND in the producer-owned kinds
    // that replace it (`plugin:<name>`, which is what the Host's converter maps a wrapper to). This
    // stays a guard on the ENVELOPE, not an adoption claim: another producer's internal work being
    // treated as internal work is the safe direction (less learning), while no user source is ever
    // upgraded to an internal origin.
    return source.form === 'internal-review' && typeof source.kind === 'string'
      && (source.kind === 'plugin' || source.kind.startsWith('plugin:'))
  })
}
const messageText = message => typeof message.content === 'string' ? message.content
  : (message.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n')
function directText(messages) {
  return messages.filter(x => x.role === 'user' && x.source?.kind === 'user').map(messageText).join('\n').slice(0, 32768)
}
const STATUS_HISTORY = 8
const STATUS_SESSIONS = 64
/** Per-turn failure roster is bounded; overflow is dropped, never unbounded memory. */
const FAILURE_ROSTER = 16
/** Availability facts are not method evidence and never enter the roster (mirrors the core). */
const AVAILABILITY_FAILURES = new Set(['cancelled', 'foreground_yield', 'provider_unavailable'])
/**
 * Record one host-verified failure for the turn. Memory-only, bounded, deduplicated on host
 * identity: a stable call id keeps its one slot; without one the identity degrades to a
 * per-turn per-tool per-class slot, so a flood of anonymous failures never looks like fresh
 * independent evidence each time. The roster is later persisted by close() through
 * `engine.observeProblem` — never here, so a reflection-request failure cannot write problems.
 */
function recordFailure(state, { eventId, toolName, failureCode }) {
  const failures = state.failures ?? (state.failures = [])
  if (failures.length >= FAILURE_ROSTER) return
  const code = typeof failureCode === 'string' && failureCode.length > 0 && failureCode.length <= 40
    ? failureCode : 'unknown_tool_failure'
  if (AVAILABILITY_FAILURES.has(code)) return
  const name = typeof toolName === 'string' && toolName.length > 0 && toolName.length <= 64 ? toolName : null
  const identity = typeof eventId === 'string' && eventId.length > 0 && eventId.length <= 512
    ? eventId : `degraded:${state.input?.turnId ?? '?'}:${name ?? 'tool'}:${code}`
  if (failures.some(failure => failure.identity === identity)) return
  failures.push({ identity, eventId: identity, toolName: name, failureCode: code })
}

/** Trusted host seam. None of its evidence callbacks are exposed as model-callable tools. */
export function createHarnessBridge({ engine, createMessage, review, onRoute = () => {}, warn = () => {}, now = Date.now, environmentId,
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
  /**
   * Persist host-verified failure facts for one closed turn into the problem ledger, before
   * settlement, so a settlement write can never mask what the host actually saw. Cancelled
   * turns are skipped by the caller. Returns the problem reference (id + evidenceRevision +
   * ready flag) of the LAST verified observation, or null when nothing verifiable happened.
   */
  const persistProblems = state => {
    if (typeof engine.observeProblem !== 'function') return null
    const base = { sessionId: state.input.sessionId, turnId: state.input.turnId,
      ...(state.input.projectKey === undefined ? {} : { projectKey: state.input.projectKey }),
      ...(state.input.environmentId === undefined ? {} : { environmentId: state.input.environmentId }),
      // The TRUSTED route of this turn travels into the ledger as a bounded source binding: it is the
      // route the host itself reported (agent options, or the provider/model a successful stream
      // really used). It is what a later, independent process needs to resume a refused reflection on
      // the SAME execution — a recovered attempt may never borrow another session or a default model.
      // `undefined` binds nothing, and the recovery then says so instead of guessing.
      ...(state.route === undefined || state.route === null ? {} : { route: state.route }) }
    const observe = payload => { try { return engine.observeProblem(payload) } catch { return null } }
    const result = { id: null, evidenceRevision: undefined, ready: false, failures: 0 }
    const seen = new Set()
    const adopt = outcome => {
      if (outcome?.ok !== true || outcome.duplicate === true) return
      result.failures += 1
      // A READY observation locks the exact problem tuple (id + revision) for the review to bind.
      // An unready observation is recorded but never overwrites a ready reference, so a later
      // unready read cannot starve the bash problem that really crossed the threshold (rev4 #2).
      if (outcome.ready === true) {
        result.id = outcome.id
        result.evidenceRevision = outcome.evidenceRevision ?? outcome.problem?.evidenceRevision
        result.ready = true
      } else if (result.ready === false && result.id === null) {
        result.id = outcome.id
        result.evidenceRevision = outcome.evidenceRevision ?? outcome.problem?.evidenceRevision
      }
    }
    for (const failure of state.failures) {
      if (seen.has(failure.eventId)) continue
      seen.add(failure.eventId)
      adopt(observe({ ...base, eventId: failure.eventId, kind: 'tool_failure', source: 'host_event',
        toolName: failure.toolName ?? undefined, failureCode: failure.failureCode,
        summary: `工具失败：${failure.toolName ?? '未知工具'}（${failure.failureCode}）` }))
    }
    // A failed verifier check is the host checker's own fact. Task-level failure is NOT
    // synthesised here: a generic turn/end 'error' or agent error is a diagnostic, never method
    // evidence, and a trusted task failure can only be reported by a real business checker
    // (its own kind), so nothing is invented from an unknown Error object (native contract).
    for (const check of state.checks.values()) {
      if (check.passed || typeof check.checkId !== 'string' || !check.checkId) continue
      adopt(observe({ ...base, eventId: `checker:${state.input.turnId}:${check.checkId}`,
        kind: 'checker_failure', source: 'host_checker', taskClass: check.checkId,
        summary: `宿主校验未通过：${check.checkId}` }))
    }
    return result.failures > 0 || result.id !== null ? result : null
  }
  const close = (session, turn, cancelled = false) => {
    const sessionId = idOf(session), k = key(sessionId, turn), state = turns.get(k)
    if (!state) return
    const checks = [...state.checks.values()]
    const outcome = cancelled ? 'cancelled' : checks.some(x => !x.passed) ? 'failed' : checks.length ? 'verified' : 'unknown'
    // Persist host-verified failures BEFORE settlement, so a settlement write can never mask
    // what the host actually saw. Cancelled turns are skipped entirely.
    const problemRef = cancelled ? null : persistProblems(state)
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
    // A review needs an assistant result summary to reflect on. When the host closed with
    // verified failures and the assistant produced none (broke off, hard error, empty output),
    // the failures THEMSELVES are evidence: synthesize a bounded, data-only summary from the
    // trusted failure roster and reflect on that. Never reflects on cancellation.
    const reflectable = !cancelled && active(state.generation) && review && !state.diagnosticError
      && (checks.length || state.taskFailed || state.tools >= 2)
    // A FAILURE-observed turn may only reflect through the problem ledger, bound to a problem
    // that is REALLY ready. Reflecting a single partial fact on the generic path — even when an
    // assistant summary exists — would mint a candidate that bypasses the independent-evidence
    // gate (audit matrix rev4 #1). Success/supported turns with no failure evidence keep their
    // historical reflection channel unchanged.
    const hasFailure = state.failures.length > 0 || state.taskFailed
    const blockedByProblem = hasFailure && (problemRef === null || problemRef.ready !== true)
    if (!blockedByProblem && reflectable && !state.resultSummary && state.failures.length) {
      const classes = [...new Set(state.failures.map(failure => failure.failureCode))].slice(0, 3).join('、')
      state.resultSummary = `宿主验证收集到 ${state.failures.length} 条工具失败（${classes}），未收到助手总结，需要复盘失败条件`.slice(0, 1200)
    }
    if (!blockedByProblem && reflectable && state.resultSummary) {
      const controller = new AbortController()
      const job = { controller, sessionId, generation: state.generation, epoch: reflectionEpoch }
      reviews.add(job)
      Promise.resolve().then(() => {
        if (!active(job.generation) || controller.signal.aborted || job.epoch !== reflectionEpoch) return
        return review({ ...state.input, taskSummary: state.taskSummary, resultSummary: state.resultSummary,
          outcome: state.taskFailed || outcome === 'failed' ? 'failed' : outcome === 'unknown' ? 'supported' : outcome,
          ...(problemRef && problemRef.id && problemRef.ready
            ? { problemId: problemRef.id, evidenceRevision: problemRef.evidenceRevision } : {}) },
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
        failures: [], availabilityOnly: false, diagnosticError: false, receiptExpiresAt: prepared.receiptExpiresAt ?? undefined,
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
          // MSE's OWN producer identity, in the current producer-owned kind or the released wrapper:
          // a user message, or another plugin's `plugin:<name>` producer, can never be credited as
          // this plugin's injection even if it happens to carry the same text.
          && isMseSource(message.source)
          && messageText(message) === state.context))
      for await (const chunk of next()) {
        if (chunk.type === 'finish' && ['stop', 'tool-calls', 'max-tokens'].includes(chunk.reason?.kind) && !options.signal?.aborted) {
          for (const state of scoped) {
            if (!active(state.generation) || turns.get(key(state.input.sessionId, state.input.turnId)) !== state) continue
            // Prefer the concrete llm/stream route. The pre-step route is retained only when the
            // Host stream hook omits route fields; the adapter must still validate it against the
            // session's own request/header before publishing a source identity.
            const streamHasRoute = typeof options.provider === 'string' && typeof options.model === 'string'
            const streamEffortPresent = Object.hasOwn(options, 'reasoningEffort') && options.reasoningEffort !== undefined
            const streamEffortValid = !streamEffortPresent || (typeof options.reasoningEffort === 'string'
              && options.reasoningEffort.length > 0 && options.reasoningEffort.length <= 16
              && /[\u0000-\u001f\u007f]/u.test(options.reasoningEffort) === false)
            const route = streamHasRoute
              ? (streamEffortValid ? { provider: options.provider, model: options.model,
                  ...(typeof options.reasoningEffort === 'string' ? { reasoningEffort: options.reasoningEffort } : {}) } : null)
              : state.route
            if (route && typeof route.provider === 'string' && typeof route.model === 'string') {
              state.route = route
              try { await onRoute({ ...state.input, route: { ...route } }) } catch { /* source publication fails closed */ }
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
        if (state && reason === 'error') {
        // A trailing turn/end 'error' with NO trusted tool-failure evidence is a generic host
        // error: it voids success credit but is not method evidence (rev4 #3 / native error
        // contract). Real tool failures already set taskFailed through toolResult and are
        // unaffected; an availability-only turn likewise never becomes a task failure.
        if (!state.taskFailed && state.failures.length === 0) state.diagnosticError = true
      }
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
    taskContext(sessionId, turnId) {
      const state = turns.get(key(sessionId, turnId))
      if (!state || !active(state.generation)) return null
      return Object.freeze({ sessionId, turnId, projectKey: state.input.projectKey,
        environmentId: state.input.environmentId, model: state.route?.model ?? null,
        provider: state.route?.provider ?? null, reasoningEffort: state.route?.reasoningEffort ?? null,
        accepted: state.accepted === true,
        lessons: Object.freeze(state.lessonVersions.map(row => Object.freeze({ id: row.id,
          version: row.version, methodId: row.methodId ?? null, checkId: row.checkId ?? null }))) })
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
    toolResult({ sessionId, turnId, failed, readOnly = false, failureCode, cancelled = false, eventId, toolName, diagnostic = false }) {
      const state = turns.get(key(sessionId, turnId))
      if (!state) return
      state.tools += 1
      if (!readOnly || failed) state.checks.clear()
      // A GENERIC host/model error (no trusted tool-result structure) is a diagnostic, never
      // method evidence: it voids any success credit for the turn but must not become a problem,
      // mint a candidate, or be rewritten into a task failure by a trailing turn/end 'error'.
      if (diagnostic === true) { state.diagnosticError = true; return }
      if (failed) {
        // A host cancellation / foreground yield / provider unavailability is an availability
        // fact, not a method failure: it must not mark the task failed and must not become a
        // problem observation later. The class is honoured whether the caller passed the flag or
        // the failureCode, because DSH's agent/error callback only has the code (rev4).
        if (cancelled === true || AVAILABILITY_FAILURES.has(failureCode ?? '')) {
          // Remember the turn was ONLY availability-aborted, so a trailing host turn/end 'error'
          // cannot rewrite it into a generic task failure (rev4 #3).
          state.availabilityOnly = true
          return
        }
        state.taskFailed = true
        recordFailure(state, { eventId: eventId ?? null, toolName: toolName ?? null,
          failureCode: failureCode ?? 'unknown_tool_failure' })
      }
    },
    toolExecution(exec, result, onTrustedResult = undefined) {
      const session = exec.agent?.session
      if (!session || typeof exec.callId !== 'string') return
      const count = session.seq ?? session.events?.length ?? 0
      for (let n = count - 1; n >= Math.max(0, count - 1000); n--) {
        const event = session.eventAt?.(n) ?? session.events?.[n]
        if (event?.type !== 'tool/call' || event.data.callId !== (exec.rootCallId ?? exec.callId)) continue
        // Classify from trusted host STRUCTURE only: an abort is a cancellation (never taskFailed),
        // a timeout, an error flag and a non-zero exit are real failures with restricted classes.
        // A successful write (exitCode 0) is not a failure but STILL reaches toolResult: it must
        // invalidate earlier verifier checks and count toward the turn's tool usage, exactly like
        // the original wiring — a successful mutation after a verification voids that verification.
        let failureCode = null
        if (exec.signal?.aborted === true || result.value?.cancelled === true) failureCode = 'cancelled'
        else if (result.value?.timedOut === true || result.value?.timeout === true) failureCode = 'tool_timeout'
        else if (result.isError === true) failureCode = 'tool_error_flag'
        else if (typeof result.value?.exitCode === 'number' && result.value.exitCode !== 0) failureCode = 'tool_nonzero_exit'
        bridge.toolResult({ sessionId: session.id, turnId: event.data.turn,
          failed: failureCode !== null && failureCode !== 'cancelled',
          cancelled: failureCode === 'cancelled',
          readOnly: exec.name === 'read' || exec.name === 'read_image',
          failureCode, eventId: exec.rootCallId ?? exec.callId, toolName: exec.name })
        if (typeof onTrustedResult === 'function') {
          try { onTrustedResult({ sessionId: session.id, turnId: String(event.data.turn), callId: exec.rootCallId ?? exec.callId,
            toolName: exec.name, value: result.isError === true ? undefined : result.value,
            isError: result.isError === true }) } catch { /* task evidence is best effort; tool result accounting remains authoritative */ }
        }
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
      try { report.decisions = engine.decisionHistory({ ...(scope === undefined ? {} : { projectKey: scope }),
        ...(environmentId === undefined ? {} : { environmentId }), limit: 4 }).rows }
      catch { report.decisions = [] }
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
    /** Per-lesson decision explanations and costs from the durable decision ledger. */
    decisionHistory(lessonId, sessionId, projectKey) {
      const scope = this.projectKeyFor(sessionId, projectKey)
      try { return engine.decisionHistory({ ...(lessonId ? { lessonId } : {}),
        ...(scope === undefined ? {} : { projectKey: scope }),
        ...(environmentId === undefined ? {} : { environmentId }), limit: 8 }).rows }
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
