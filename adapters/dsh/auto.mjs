/**
 * Bounded automatic validation: the review track's driver.
 *
 * It owns no state of its own. Every stage, attempt, ticket and reason lives in the shared core
 * (`state.autoPlans`, `state.jobs`, `lesson.review` / `lesson.trial`), so a restart resumes the
 * queue instead of losing it, two processes cannot both spend the same reservation, and a late
 * answer cannot be credited to a plan that changed underneath it.
 *
 * What this module deliberately does NOT do:
 *  • it never calls a model for a plan whose route is unknown or whose reservation was refused;
 *  • it never promotes a lesson to `validated` — that is the objective track's business;
 *  • it never runs when the automatic switch is off, when a legacy owner is active, or when the
 *    evaluation budget is exhausted (a paid call is a paid call, whoever asked for it).
 */
import { parseVerdict, REVIEW_REASONS } from '../../src/review.mjs'
import { objectiveRequestHashes } from './evaluation-request.mjs'

/** At most this many plans are advanced in one scan; the loop is serial by construction. */
const MAX_PLANS_PER_SCAN = 8
/** A plan retries at most this many times before it is parked as `blocked` with a reason. */
const MAX_ATTEMPTS = 2
/** Bounded backoff between attempts, in milliseconds: transient trouble is not a busy loop. */
const BACKOFF_MS = [60_000, 5 * 60_000]
/** How long a plan waits on a budget/quota condition before asking again. */
const BUDGET_RETRY_MS = 15 * 60_000
/** How long a run that yielded to the foreground (or was cancelled) waits before asking again. */
const YIELD_RETRY_MS = 30_000
/** How long one review run may take before it is treated as failed and its ticket released. */
const RUN_TIMEOUT_MS = 120_000
/** Reserved tokens per review run: two arm answers plus the judge, bounded. */
const STEP_OUTPUT_TOKENS = 128
const JUDGE_OUTPUT_TOKENS = 256
const REVIEW_TOKENS = 2
/** Both tracks share the queue; the scheduler must never silently skip one of them. */
const AUTO_TRACKS = Object.freeze(['review', 'objective'])
/**
 * How a stop is classified, in ONE place.
 *
 * A cancellation is the host (or its operator) changing its mind: the run stops, the plan goes back
 * to the queue and NO attempt is consumed, because no comparison was completed. A provider that
 * really failed is a failed attempt and stays one. Folding the two together is what turned an
 * operator pause into `review_judge_failed` and burned the plan's retry budget.
 */
const CANCELLED_CODES = Object.freeze(['review_cancelled', 'cancelled', 'aborted', 'control_changed'])
/** Yields: the foreground owns the provider right now. Not a failure, not an attempt. */
const YIELD_CODES = Object.freeze(['review_yielded', 'job_in_progress', 'slot_busy'])
/** A fact the host could not confirm. Refused conservatively, retried later without spending one. */
const UNKNOWN_FACT_CODES = Object.freeze(['host_state_unknown', 'source_route_unavailable'])
/** A real provider-side failure that is worth the plan's bounded retry. */
const TRANSIENT_CODES = Object.freeze(['review_interrupted', 'review_judge_failed', 'model_failed',
  'model_incomplete', 'model_unknown'])
/** Tokens reserved per pack case, both arms: the objective run's own bound. */
const OBJECTIVE_TOKENS_PER_CASE = 600
/** Wall-clock bound for one objective run; a run that exceeds it is cancelled, not promoted. */
const OBJECTIVE_DEADLINE_MS = 300_000

const sleep = ms => new Promise(done => setTimeout(done, ms))
const stopError = code => Object.assign(new Error(code), { code })

/**
 * @param options.engine - the shared core; every state change goes through it.
 * @param options.context - a callable that builds the frozen scenario/criteria for a plan, or
 *   `null` when the lesson's own conditions cannot be turned into a bounded scenario yet.
 * @param options.reviewAdmission - a read-only `(lesson) => { ok, reason }` that answers whether the
 *   method belongs to the registered pack's domain at all. It is consulted BEFORE any reservation,
 *   so an unrelated method waits with the predicate's own reason (`review_out_of_domain`) instead of
 *   paying for a scenario it can never be credited against. Defaults to "no answer supplied", which
 *   leaves the context callable as the only gate.
 * @param options.route - the trusted host route `{provider, model, reasoningEffort}` for a lesson,
 *   or `null` when the host cannot name one. Never invented here.
 * @param options.callModel - `(request, signal) => Promise<string>`; the only model entry point.
 * @param options.enabled - re-read before EVERY paid step, so an operator switch takes effect now.
 * @param options.dueWork - an optional bounded pass that runs on the SAME wake-ups and under the same
 *   serial guard as the queue work, and BEFORE the automatic switch is consulted. It exists for the
 *   problem due-recovery pump: reflection has its own switch (`reflectionEnabled`) and its own rolling
 *   allowance, so a device with automatic validation off must still recover a refused reflection. It
 *   never runs beside a scan (the `scanning` guard is held) and never creates a second timer or a
 *   second paid queue.
 * @param options.now - injectable clock (tests only).
 * @param options.schedule - injectable repeating timer `(fn, ms) => handle`; the ONE wake-up timer
 *   this scheduler owns is created through it, so a controlled verification drives the real timer
 *   path instead of a test-only branch. Defaults to `setInterval`.
 * @param options.cancelTimer - injectable cancellation for that handle. Defaults to `clearInterval`.
 * @param options.log - `(code, detail) => void`, reasoning codes only, never lesson text.
 */
export function createAutoValidation({ engine, context, objectiveContext = () => null, route, callModel,
  source = () => ({}), permit = () => ({ ok: true }), enabled = () => true, now = Date.now, log = () => {},
  busy = () => false, onAbort = null, slot = null, reviewAdmission = null, dueWork = null,
  // The ALREADY-REGISTERED checker path. It is the host's own `evaluateRegistered`: a registered
  // method is scored against its frozen fixtures, with NO model call, NO provider and NO budget. This
  // is the first thing tried for a candidate whose domain has no official scenario, because it is
  // real objective evidence that already exists — not a second evidence engine.
  registeredCheck = null,
  // The BOUNDED EVIDENCE TRIAL: the trusted host grants a temporary, explicitly unverified licence
  // from real host-observed failures, so a candidate with no official scenario can at least be
  // OFFERED once and earn real evidence on a real turn. It validates nothing and spends nothing; a
  // grant the core refuses (no evidence, a covered domain, a registered checker, an expired or
  // withdrawn licence) comes back as a bounded code the pass reports.
  evidenceTrial = null,
  schedule = (fn, ms) => setInterval(fn, ms), cancelTimer = handle => clearInterval(handle) }) {
  let disposed = false
  let scanning = false
  /** Bounded per-scan counters: candidates settled by their own registered checker, and candidates
   *  waiting for an applicable validator. Both are READABLE in the scan audit and the status. */
  let finishedByChecker = 0
  let waitingValidator = 0
  /** Bounded per-scan counts of the evidence trial: newly granted, and already held. */
  let evidenceTrialsGranted = 0
  let evidenceTrialsExisting = 0
  /** The last completed pass's own audit, or null before the first one. Read-only state. */
  let lastScan = null
  /** The scheduler's single wake-up timer; owned here and cleared on dispose. */
  let timer = null
  /**
   * The CANCELLATION GENERATION.
   *
   * Every abort increments it, and every run captures the value in force when it started. A run
   * whose generation is stale may not issue another paid step or commit a result — while a run
   * that starts AFTER the abort (i.e. after the old provider has been drained) carries the current
   * generation and is allowed to work. A single sticky `aborted` flag could not express that: it
   * either blocked the queue for ever or had to be silently cleared, and "silently cleared" is how
   * a late answer from a cancelled run gets credited to the next one.
   */
  let cancelEpoch = 0
  /** The reason of the newest abort, for the log and the status surface only. Never a permission. */
  let lastAbortReason = null
  /** The controller of the run currently in flight, so an abort can reach the provider itself. */
  let currentRun = null
  const events = []
  /** Calls still in flight. The scheduler never starts the next plan while one is draining. */
  const pending = new Set()

  /** The run is stale: cancelled by an abort that happened after it started. */
  const staleRun = run => run.cancelled === true || run.epoch !== cancelEpoch

  /**
   * One paid call, with the run's own timeout contract.
   *
   * It mirrors the queue's discipline rather than inventing a weaker one:
   *  • the timeout timer is CLEARED on every exit — a successful call leaves no stray timer behind;
   *  • a timeout ABORTS the provider request and DRAINS it before returning, so the next attempt
   *    cannot overlap a call whose ticket has already been released;
   *  • what the provider reported is accumulated immediately, including unknown and truncated
   *    answers, because a cancelled run must still account for what it already spent.
   */

  /** Is this plan still allowed to spend money? Re-read at every step, never cached across calls. */
  const permitFor = async (plan, run = null) => {
    try {
      // The host's answer may be asynchronous: a source permit has to consult live session truth,
      // and a permission that cannot be awaited would have to be cached — which is exactly the
      // stale licence this replaces.
      const verdict = await permit({ lessonId: plan.lessonId, source: plan.source, planHash: plan.planHash,
        version: plan.version, environment: plan.environment, track: plan.track,
        controlGeneration: run?.controlGeneration ?? null })
      const answer = verdict === undefined || verdict === null ? { ok: true } : verdict
      // A host may hand back a TRUSTED SYNCHRONOUS re-check beside its permission. It is kept on the
      // run and consulted inside the commit's own synchronous block: the caller resuming from an
      // `await` is not a promise that no other microtask ran in between.
      if (run !== null && answer.ok === true && typeof answer.recheck === 'function') run.hostRecheck = answer.recheck
      return answer
    } catch { return { ok: false, reason: 'source_unavailable' } }
  }

  /** The generation the durable control is in, when the core can answer. Never invented. */
  const controlGenerationNow = () => {
    try {
      return typeof engine.controlGeneration === 'function' ? engine.controlGeneration() : null
    } catch { return null }
  }

  /**
   * Park a plan that is only waiting for something outside its control — an allowance, a rolling
   * window, a route that is not recorded yet.
   *
   * It stays `queued` with a REAL `nextAttemptAt`, so raising the allowance or saving a setting can
   * actually revive it; `blocked` is reserved for facts that will not change by themselves (a stale
   * version, a missing pack, an unsafe suggestion). Retrying stays inside the same attempt budget.
   */
  const parkTemporarily = (plan, reason, delay = BUDGET_RETRY_MS) => {
    // Waiting for an allowance or a window is not a failed attempt: no model call was made, so the
    // attempt count is written back UNCHANGED. Incrementing it here (even with the stage left
    // `queued`) still exhausted the scan's `attempts < MAX_ATTEMPTS` filter and parked the plan for
    // ever, which is exactly the bug this replaces.
    engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'queued',
      ...(plan.ticket === undefined ? { ticket: null } : { ticket: plan.ticket }),
      attempts: plan.attempts, reason, nextAttemptAt: now() + delay })
    return 'queued'
  }

  /**
   * Yield to the foreground: a person's turn (or a manual job) owns the provider right now.
   *
   * The plan goes back to the queue with its attempts UNCHANGED and asks again shortly after. It is
   * not a failure, so it must not consume the bounded retry budget, and it is not a cancellation
   * either: nothing was started and nothing was thrown away.
   */
  const yieldToForeground = (plan, reason = 'review_yielded') => parkTemporarily(plan, reason, YIELD_RETRY_MS)

  const paidCall = async (request, ticket, run, spend) => {
    // THE gate in front of every physical provider request, both tracks: a pause, a closed switch, a
    // disposed scheduler, an archived source session or a plan that is no longer current all stop the
    // very next call — not the next case. The settlement guard protects settlements; this protects
    // the automatic queue, which is a different caller.
    if (staleRun(run)) throw stopError('review_cancelled')
    if (!stillPermitted()) throw stopError('review_cancelled')
    // The foreground (a user turn or a manual job) wins: an automatic paid step yields instead of
    // competing for the provider, and a yield is not a failed attempt.
    if (busy()) throw stopError('review_yielded')
    // The host's own permit reader — the shared job slot's decision, not a copy of it.
    if (run.allowed !== undefined && run.allowed() !== true) {
      run.cancelled = true
      run.aborted?.abort()
      throw stopError('review_cancelled')
    }
    const permit = run.permit === undefined ? null : await run.permit()
    if (permit !== null && permit.ok !== true) {
      // A permit that lapsed DURING the run ends the whole run: the source the plan was bound to is
      // no longer the one the host holds, so the remaining cases (and the commit) must not happen.
      run.cancelled = true
      run.aborted?.abort()
      throw stopError(permit.reason ?? 'source_unavailable')
    }
    // The abort may have landed while the permit was being awaited — the reference is re-checked
    // here, after the await, so a stale run cannot slip one more request through.
    if (staleRun(run)) throw stopError('review_cancelled')
    const controller = run.aborted ?? new AbortController()
    run.aborted = controller
    // The HOST's job signal (pause / unload / dispose trip it) is chained onto this run ONCE, so the
    // provider request is really aborted instead of waiting for the deadline timer.
    if (slotSignal !== null && run.chained !== true) {
      run.chained = true
      if (slotSignal.aborted === true) controller.abort()
      else slotSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    let timer = null
    const timeout = new Promise(resolve => { timer = setTimeout(() => { run.timedOut = true; controller.abort(); resolve(null) }, RUN_TIMEOUT_MS) })
    const started = Promise.resolve()
      .then(() => { if (run.outstanding !== undefined) run.outstanding(1); return callModel({
        ...request, maxTokens: request.stepKey?.startsWith('review:judge:')
          ? JUDGE_OUTPUT_TOKENS : STEP_OUTPUT_TOKENS, signal: controller.signal }, ticket) })
      // A provider that reported usage and THEN aborted still reported usage: the count travels on
      // the error so the ledger keeps it instead of discarding it as unknown.
      .catch(error => ({ text: '', tokens: Number.isSafeInteger(error?.tokens) ? error.tokens : null,
        physicalDispatch: error?.physicalDispatch !== false,
        // The host aborted this request (a pause, the switch, the foreground, disposal): whatever the
        // provider reported afterwards is a CONSEQUENCE of that stop, so the run is cancelled rather
        // than counted as a failed comparison. A provider that really failed on its own keeps its own
        // code, which is what the plan's bounded retry is for.
        failed: run.cancelled === true || controller.signal.aborted === true || run.epoch !== cancelEpoch
          ? 'review_cancelled' : (error?.code ?? 'review_judge_failed') }))
    pending.add(started)
    try {
      const answer = await Promise.race([started, timeout])
      // A timeout ENDS the run: the caller must not issue another arm, because the first provider
      // call is still in flight and its ticket has not been settled yet.
      if (answer === null) throw stopError('review_interrupted')
      if (answer.failed !== undefined) throw stopError(answer.failed)
      // Usage is NOT counted here: the settled handler owns the single accounting point, so a normal
      // answer and a late one are both charged exactly once.
      if (answer?.truncated === true) spend.truncated += 1
      return answer
    } finally {
      if (timer !== null) clearTimeout(timer)
      if (run.outstanding !== undefined) run.outstanding(0)
      // The call may still be in flight after an abort. Its settlement is tracked in `pending` and
      // settled LATE (real usage stays real even when the run gave up), but the caller is not made
      // to wait here: a cancellation must return promptly. The core is never spoken to again until
      // `drainPending()` has seen every in-flight call finish.
      const settled = started.then(answer => {
        // A checkpoint is a previously paid response, not a physical call charged to this ticket.
        // Likewise, a refusal before ticketStepStart never reached the provider and cannot make
        // this ticket's usage unknown. Only a dispatched request contributes to this run's spend.
        if (answer?.resumed !== true && answer?.physicalDispatch !== false) {
          if (answer !== null && Number.isSafeInteger(answer?.tokens) && answer.tokens > 0) spend.known += answer.tokens
          else if (answer !== null && !Number.isSafeInteger(answer?.tokens)) spend.unknown += 1
          try { engine.ticketUsage({ ticket, spent: spend.known,
            usage: { known: spend.unknown === 0, tokens: spend.known } }) } catch { /* final settlement preserves unknown */ }
        }
        return answer
      }).finally(() => pending.delete(settled))
      pending.add(settled)
      pending.delete(started)
    }
  }

  /**
   * Wait until every provider call this scheduler started has really finished.
   *
   * It is awaited before the core is told anything — the settle and the release of a reservation —
   * so a request that is still in flight can never overlap the next attempt (or a manual run that
   * grabs the freed ticket). `dispose()` aborts what it can and then drains the same set.
   */
  const drainPending = async () => {
    while (pending.size > 0) await Promise.allSettled([...pending])
  }

  /**
   * Abort what this scheduler has in flight.
   *
   * Two things happen, and both are needed:
   *  • the generation advances, so the run(s) that were in flight may not issue another paid step
   *    and may not commit a result — including a provider answer that arrives late;
   *  • the run's own AbortSignal is tripped, so the provider request is really cancelled rather
   *    than merely stopped being useful.
   *
   * The generation is NOT sticky: work that starts after this call (once the old provider has
   * physically drained, which `drainPending()` guarantees before anything else is told anything)
   * carries the new generation and may run. A permanently stuck flag could never resume.
   */
  const abort = reason => {
    lastAbortReason = reason ?? 'review_cancelled'
    cancelEpoch += 1
    if (currentRun?.aborted !== null && currentRun?.aborted !== undefined) {
      try { currentRun.aborted.abort() } catch { /* already aborted */ }
    }
    if (typeof onAbort === 'function') { try { onAbort(lastAbortReason) } catch { /* the abort itself is enough */ } }
    return { ok: true, reason: lastAbortReason, generation: cancelEpoch }
  }

  /** Where this item came from, resolved by the caller (session + turn, or the backfill session). */
  const sourceOf = lesson => {
    try { return source(lesson) ?? {} } catch { return {} }
  }
  const record = (code, detail = null) => {
    events.push({ at: now(), code, detail })
    if (events.length > 32) events.splice(0, events.length - 32)
    log(code, detail)
  }

  /** Read-only view for the status card; never advances anything. */
  const status = () => {
    let plans = []
    // A READ that could not answer is reported as "unknown", never as an empty queue. An unreadable
    // store (a corrupt document, a lock that could not be taken) used to be swallowed into `[]`, so
    // the card said `plans: 0, idle: true` while the core's own read said `invalid_store` — a false
    // zero is a false statement about work that really exists. The counts are `null` in that case and
    // `queueError` carries the core's own code; a genuinely empty queue still reports real zeros.
    let queueError = null
    try { plans = engine.autoPlans() } catch (error) { plans = null; queueError = error?.code ?? 'auto_plans_unavailable' }
    if (plans === null) {
      return { plans: null, queued: null, running: null, done: null, blocked: null, failed: null,
        interrupted: null, lastReason: null, abortGeneration: cancelEpoch, lastAbortReason,
        idle: null, queueError, scans: events.length, lastEvent: events.slice(-1)[0] ?? null,
        events: events.slice(-8).map(row => ({ ...row })), reviewTokens: REVIEW_TOKENS }
    }
    const count = stage => plans.filter(plan => plan.stage === stage).length
    return { plans: plans.length, queued: count('queued'), running: count('running'), done: count('done'),
      blocked: count('blocked'), failed: count('failed'), interrupted: count('interrupted'), queueError: null,
      // The newest reason is what an operator needs to see when nothing is moving.
      lastReason: plans.filter(plan => plan.reason).slice(-1)[0]?.reason ?? null,
      // Which cancellation generation is in force, and why the last one happened: a card that says
      // "waiting" is not the same statement as "stopped by a pause" or "yielded to a live turn".
      abortGeneration: cancelEpoch, lastAbortReason,
      // What the LAST pass did about candidates that have no official scenario: how many were settled
      // by their own registered checker (zero-cost objective evidence) and how many are waiting for an
      // applicable validator. `null` until a pass has run, so "not yet known" is not reported as 0.
      registeredChecker: lastScan === null ? null : lastScan.registeredChecker,
      waitingValidator: lastScan === null ? null : lastScan.waitingValidator,
      evidenceTrialsGranted: lastScan === null ? null : lastScan.evidenceTrialsGranted,
      evidenceTrialsExisting: lastScan === null ? null : lastScan.evidenceTrialsExisting,
      idle: plans.every(plan => plan.stage !== 'running'),
      scans: events.length, lastEvent: events.slice(-1)[0] ?? null,
      // The bounded recent reasons, newest last. One `lastEvent` is not enough to tell WHY a scan
      // registered nothing: an operator (or an audit) needs the domain refusal beside the "no
      // scenario yet" entry rather than only whichever of the two happened to be written last.
      events: events.slice(-8).map(row => ({ ...row })),
      reviewTokens: REVIEW_TOKENS }
  }

  /**
   * Register the review plans a set of candidate methods needs, bounded and idempotent.
   *
   * A lesson that already has a plan for its current version is left alone; a lesson whose
   * version moved gets a new plan because its old evidence is about a different row.
   */
  const enqueue = (lessons, baseSource) => {
    let registered = 0
    // The CORE is the only dedupe authority, and it keys on the FULL execution binding, not on a
    // coarse (lesson, version, track) triple: a stored plan whose route, source, suite or criteria
    // differ from the would-be registration hashes differently and must re-enter autoPlanRegister,
    // which invalidates the old plan and registers the new binding (phase2-rev1 C/D). An IDENTICAL
    // binding — including one whose outcome is already settled — hashes the same and stays
    // untouched, so a paid result is never charged twice. `autoPlanIdentity` is the read-only twin
    // of that hasher: comparing against it is cheap and needs no store write.
    const plans = (() => { try { return engine.autoPlans() } catch { return [] } })()
    const existing = new Map()
    for (const plan of plans) existing.set(`${plan.lessonId}:${plan.version}:${plan.track}`, plan)
    for (const lesson of lessons) {
      if (!enabled()) break
      if (registered >= MAX_PLANS_PER_SCAN) break
      // The two tracks have INDEPENDENT contexts and completions: a lesson whose REVIEW scenario
      // cannot be built — or whose review already completed — may still be a perfectly good
      // objective candidate, and vice versa (fair-queue design point 5).
      //
      // Domain admission is checked FIRST and reported on its own: an unrelated method must not be
      // listed as "waiting for criteria" as if a fixture were still being prepared. The refusal is
      // read-only and costs nothing — no plan, no ticket, no call.
      const admitted = reviewAdmission === null ? null : (() => {
        try { return reviewAdmission(lesson) } catch { return { ok: false, reason: 'domain_pack_unknown' } }
      })()
      // ── (A) THE REGISTERED CHECKER, BEFORE ANYTHING PAID ─────────────────────────────────────────
      // A method that carries a registered `methodId` has a frozen, host-owned checker. Settling it
      // costs nothing and is objective evidence, so it is tried FIRST — including for a method no
      // official scenario admits. Its outcome is the core's own verdict; this layer never calls the
      // method validated itself, and never falls back to a model when the checker says no.
      if (registeredCheck !== null) {
        let checked = null
        try { checked = registeredCheck(lesson) } catch (error) { checked = { ok: false, code: error?.code ?? 'registered_check_failed' } }
        if (checked?.ok === true) {
          record(checked.state === 'accepted' ? 'registered_checker_validated' : `registered_checker_${checked.state ?? 'settled'}`, lesson.id)
          finishedByChecker += 1
          continue
        }
        if (checked?.attempted === true) {
          // The checker RAN and refused (or reported a bounded reason): that is a terminal fact about
          // this edition, and it must not be retried as a paid review.
          record(`registered_checker_refused:${checked.code ?? 'unknown'}`, lesson.id)
          continue
        }
        // `attempted` is false for "this method has no registered checker": fall through to the
        // domain path below, which is the right home for a method that belongs to an official pack.
      }
      if (admitted !== null && admitted.ok !== true) {
        // ── (B) NO APPLICABLE VALIDATOR: AN EXPLICIT WAITING STATE, NOT AN ERROR ──────────────────
        // Ordinary development experience with no official scenario and no registered checker is
        // parked as a READABLE WAIT: `waiting_validator_evidence` is reported, counted, and surfaced
        // in the effective state, so the user sees "waiting for applicable evidence" instead of a
        // stuck queue or a fake zero. Nothing is promoted from here — the only things that move it
        // are a registered checker or real task evidence the host really produced.
        // The RELEASED code shape is kept: `review_out_of_domain:<predicate reason>` already means
        // exactly "no official domain admits this method", and the predicate's own refusal travels in
        // it (`domain_forbidden:排序`, `domain_mechanism_missing:1`, …). The NEW facts are additive and
        // live in the counters and the effective state (`waitingValidator`, `evidenceTrialsGranted`),
        // so a bounded event ring is not crowded with two codes for one candidate.
        record(`review_out_of_domain:${admitted.reason ?? 'unknown'}`, lesson.id)
        // THE BOUNDED EVIDENCE TRIAL. Without a licence the row can never be OFFERED, so no real turn
        // can ever use it and the host can never check it: an ordinary candidate would wait for ever
        // however the switches and the budget are set. The core grants the licence ONLY from real
        // host-observed failures in the lesson's own scope and environment, and refuses it outright
        // when an official domain or a registered checker covers the row. Nothing is promoted here and
        // nothing is spent; every refusal is a bounded code the pass reports.
        let trial = null
        try { trial = evidenceTrial === null ? null : evidenceTrial(lesson) } catch (error) {
          trial = { ok: false, code: error?.code ?? 'evidence_trial_failed' }
        }
        if (trial?.ok === true) {
          if (trial.duplicate === true) evidenceTrialsExisting += 1
          else evidenceTrialsGranted += 1
          record('evidence_trial_granted', lesson.id)
        } else {
          waitingValidator += 1
          record(`evidence_trial_refused:${trial?.code ?? 'unavailable'}`, lesson.id)
        }
        continue
      }
      const scenario = admitted !== null && admitted.ok !== true ? null : context(lesson)
      if (scenario === null) record('review_missing_criteria', lesson.id)
      // The plan records WHERE the item came from and WHICH route its run must use. A candidate with
      // a source turn is bound to that turn; a historical one is bound to the verification session
      // the operator named, marked as backfilled, and never borrows another session's route.
      const withScope = { ...baseSource,
        ...(typeof lesson.projectKey === 'string' && lesson.projectKey !== '' ? { projectKey: lesson.projectKey } : {}),
        ...sourceOf(lesson) }
      const registerFor = (track, suite, criteria, requestHashes) => engine.autoPlanRegister({ lessonId: lesson.id,
        version: lesson.version, environment: lesson.environment ?? 'default', track,
        source: { ...withScope, route: withScope.route ?? undefined }, suite, criteria,
        ...(requestHashes === null || requestHashes === undefined ? {} : { requestHashes }) })
      const coveredByIdentity = (track, suite, criteria, requestHashes) => {
        try {
          const identity = engine.autoPlanIdentity({ lessonId: lesson.id, version: lesson.version,
            environment: lesson.environment ?? 'default', track,
            source: { ...withScope, route: withScope.route ?? undefined }, suite, criteria,
            ...(requestHashes === null || requestHashes === undefined ? {} : { requestHashes }) })
          return identity?.ok === true
            && existing.get(`${lesson.id}:${lesson.version}:${track}`)?.planHash === identity.planHash
        } catch { return false }
      }
      // Register ONE track, bounded to the per-scan NEW-plan quota. The cap is checked BEFORE each
      // possible registration (not once per lesson), so one lesson's two tracks can never push the
      // scan's new registrations past MAX_PLANS_PER_SCAN (phase2-rev1 E). A duplicate or an
      // already-settled identity does not consume the quota.
      const registerTrack = (track, suite, criteria) => {
        if (registered >= MAX_PLANS_PER_SCAN) return
        const plan = registerFor(track, suite, criteria)
        if (plan.ok !== true) record(plan.code ?? 'auto_plan_rejected', lesson.id)
        else if (plan.settled === true) record(track === 'review' ? 'review_settled' : 'objective_settled', lesson.id)
        else if (plan.duplicate !== true) registered += 1
      }
      // Already reviewed at this version? The lesson carries the outcome (and its plan hash), so a
      // finished review plan is not re-paid — but the OBJECTIVE half must still be registered when
      // the pack now admits this candidate. The two tracks are independent completions, so the old
      // `reviewed && trial → continue` that skipped objective registration is gone (audit
      // phase2-baseline "late-objective-after-review").
      if (scenario !== null && !coveredByIdentity('review', scenario.suite, scenario.criteria)) {
        registerTrack('review', scenario.suite, scenario.criteria)
      }
      const objective = objectiveContext(lesson)
      // The objective plan is authorised by the objective pack itself. Reusing review criteria
      // here can leave the pack unresolved (notably when review has no matching scenario), which
      // makes the queued plan lose the pack identity that its later evaluation ticket requires.
      const objectiveCase = objective?.cases?.[0] ?? null
      const objectiveSuite = objective === null ? null : { ...objective.suite,
        ...(typeof objectiveCase?.caseId === 'string' ? { caseId: objectiveCase.caseId } : {}) }
      const objectiveCriteria = Array.isArray(objectiveCase?.criteria) ? objectiveCase.criteria : []
      if (objective !== null) {
        // A request manifest is a bounded set of hashes only. It lets the core distinguish a
        // metadata-only plan migration from genuinely new paid work without retaining prompts.
        const hashes = objectiveRequestHashes(objective, withScope.route, STEP_OUTPUT_TOKENS)
        if (coveredByIdentity('objective', objectiveSuite, objectiveCriteria, hashes)) continue
        if (registered < MAX_PLANS_PER_SCAN) {
          const plan = registerFor('objective', objectiveSuite, objectiveCriteria, hashes)
          if (plan.ok !== true) record(plan.code ?? 'auto_plan_rejected', lesson.id)
          else if (plan.settled === true) record('objective_settled', lesson.id)
          else if (plan.duplicate !== true) registered += 1
        }
      }
    }
    return registered
  }

  /** One plan's review run. Returns the plan's final stage for this scan. */
  /** Re-check the switch immediately before AND after a paid step, and never continue when off. */
  const stillPermitted = () => !disposed && enabled()

  /**
   * The per-run state, built in ONE place so both tracks carry the same discipline.
   *
   * `epoch` is the cancellation generation this run belongs to: an abort that lands after this
   * point makes the run stale, and a run started after the abort carries the new generation.
   * `allowed` is the shared slot's own permission reader, `outstanding` its physical-count reporter
   * and `controlGeneration` the durable control the permit is compared against — all three are the
   * host's facts, never a copy this module keeps for itself.
   */
  const newRun = (plan, runContext = {}) => {
    const run = { aborted: null, timedOut: false, cancelled: false, chained: false,
      epoch: cancelEpoch, controlGeneration: controlGenerationNow(),
      allowed: typeof runContext.allowed === 'function'
        ? () => { try { return runContext.allowed() === true } catch { return false } } : () => true,
      ...(typeof runContext.outstanding === 'function'
        ? { outstanding: count => { try { runContext.outstanding(count) } catch { /* a counter is not a permission */ } } }
        : {}) }
    run.permit = () => permitFor(plan, run)
    currentRun = run
    return run
  }

  /**
   * The ONE place a stopped run is written back.
   *
   * Four outcomes, kept apart on purpose:
   *  • cancelled — the host changed its mind (a pause, the switch, the foreground, disposal). The
   *    plan returns to the queue with its attempts UNCHANGED: no comparison was completed, so
   *    nothing was tried and the bounded retry budget must not be spent on it.
   *  • yielded — the foreground owns the provider right now. Same, and it asks again shortly.
   *  • unknown — a host fact could not be confirmed. Refused conservatively, retried on the waiting
   *    cadence, and again not counted as a failed attempt.
   *  • failed — a REAL provider-side failure, which is exactly what the retry budget is for.
   */
  const settleStoppedPlan = (plan, code, ticket = null) => {
    const cancelled = CANCELLED_CODES.includes(code)
    const yielded = YIELD_CODES.includes(code)
    const unknown = UNKNOWN_FACT_CODES.includes(code)
    const waitingBudget = ['evaluation_budget', 'evaluation_budget_calls', 'review_budget', 'review_budget_calls',
      'review_budget_tokens', 'review_budget_disabled'].includes(code)
    const transient = TRANSIENT_CODES.includes(code)
    const attempts = plan.attempts + 1
    const keepAttempts = cancelled || yielded || unknown || waitingBudget
    const stage = keepAttempts ? 'queued' : transient && attempts < MAX_ATTEMPTS ? 'queued' : 'blocked'
    const nextAttemptAt = cancelled || yielded ? now() + YIELD_RETRY_MS
      : unknown || waitingBudget ? now() + BUDGET_RETRY_MS
      : now() + BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1)]
    const resumable = ['evaluation_budget', 'evaluation_budget_calls', 'review_budget'].includes(code)
    engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage,
      ticket: resumable ? ticket : null,
      attempts: keepAttempts ? plan.attempts : attempts, reason: code, nextAttemptAt })
    return stage
  }

  const runReview = async (plan, lesson, runContext = {}) => {
    const scenario = lesson === null ? null : context(lesson)
    if (scenario === null) {
      engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'blocked',
        reason: 'review_missing_criteria' })
      return 'blocked'
    }
    const decisionRoute = route({ lessonId: plan.lessonId, source: plan.source })
    if (decisionRoute === null || typeof decisionRoute.provider !== 'string' || typeof decisionRoute.model !== 'string') {
      engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'blocked', reason: 'review_no_route' })
      return 'blocked'
    }
    if (!enabled()) return 'queued'
    // A person is working right now. Checked BEFORE the reservation, so a yield costs neither a
    // ticket nor an attempt: the plan simply asks again shortly.
    if (busy()) return yieldToForeground(plan)
    // The scope comes from the plan, which the adapter filled from the TRUSTED directory. A plan
    // without one cannot be run: defaulting to the instance scope would look up a project lesson in
    // the wrong scope (and silently find nothing).
    const scope = plan.source?.projectKey
    if (typeof scope !== 'string' || scope === '') {
      engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'blocked',
        reason: 'scope_unresolved' })
      return 'blocked'
    }
    const existing = typeof plan.ticket === 'string'
      ? engine.ticketContinuation({ ticket: plan.ticket, kind: 'review' }) : null
    if (existing?.code === 'ticket_usage_unknown') {
      engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'blocked', ticket: null,
        reason: 'ticket_usage_unknown' })
      return 'blocked'
    }
    const planView = existing?.ok === true ? { allowed: true, reasons: [] }
      : engine.reviewPlan({ lessonId: plan.lessonId, projectKey: scope, maxTokens: REVIEW_TOKENS })
    if (planView.allowed !== true) {
      // An expired licence whose renewal window has no new evidence behind it is a TERMINAL fact, not
      // an allowance that may free up: parking it would ask again for ever for a run that must never
      // be bought. It is blocked once, with its own reason, and the lesson keeps that outcome.
      if (planView.reasons.includes('renewal_waiting_evidence')) {
        engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'blocked',
          ticket: null, reason: 'renewal_waiting_evidence' })
        record('renewal_waiting_evidence', plan.lessonId)
        return 'blocked'
      }
      return parkTemporarily(plan, planView.reasons[0] ?? 'review_not_allowed')
    }
    const reservation = existing?.ok === true ? { ok: true, ticket: plan.ticket } : engine.reviewRequest({ lessonId: plan.lessonId, projectKey: scope, expectedVersion: plan.version,
      maxTokens: REVIEW_TOKENS, stepwiseBudget: true, planHash: plan.planHash, queueKey: plan.queueKey,
      // The pack identity travels WITH the reservation: the core freezes it, checks the method
      // against the registered predicate, and refuses the submission if either moved on. A
      // queue-driven review without it is refused outright (`domain_pack_required`),
      // because the whole point of the frozen scenario is that a host-owned domain authorised it.
      packId: scenario.suite?.packId ?? null, packVersion: scenario.suite?.version ?? null,
      // The case is named, not asserted: the core derives the scenario and criteria identity from
      // the registered pack itself and refuses anything that does not match what it derives.
      caseId: scenario.caseId ?? null,
      scenarioHash: scenario.scenarioHash, criteriaHash: scenario.criteriaHash, criteria: scenario.criteria })
    if (reservation.ok !== true || reservation.ticket === undefined) {
      // A refused reservation is not a failure: the budget may free up later, so the plan stays
      // queued and the reason is visible.
      return parkTemporarily(plan, reservation.skipped ?? reservation.code ?? 'review_budget')
    }
    engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'running',
      ticket: reservation.ticket, attempts: plan.attempts + (existing?.ok === true ? 0 : 1) })
    // Known spend is accumulated the moment a call returns: a cancellation, a failed judge or a
    // crash must not throw away token counts the provider already told us about.
    // Known spend is accumulated the moment a call returns, and the QUALITY of the run is tracked
    // alongside it: an unknown measurement or a cut-off answer must never be reported as a clean run.
    const spend = { known: 0, unknown: 0, truncated: 0 }
    const run = newRun(plan, runContext)
    try {
      // Two isolated answers, same route, no shared context: the arms must not see each other.
      if (!stillPermitted()) throw stopError('review_cancelled')
      const candidate = await paidCall({ ...scenario.arm('candidate'), route: decisionRoute, stepKey: 'review:candidate' }, reservation.ticket, run, spend)
      // The switch may have been closed while that answer was in flight: the NEXT call must not be
      // issued just because the first one was.
      if (!stillPermitted()) throw stopError('review_cancelled')
      const baseline = await paidCall({ ...scenario.arm('baseline'), route: decisionRoute, stepKey: 'review:baseline' }, reservation.ticket, run, spend)
      if (candidate === null || baseline === null) throw stopError('review_interrupted')
      // Two judge passes over the SAME two answers with the labels swapped. The ledger returned with
      // each prompt says which label the candidate carried in that pass, so the pair can be handed
      // to the core in the documented order: the pass where the candidate was `A` comes first.
      const firstPass = scenario.judge(candidate.text, baseline.text, 0)
      const secondPass = scenario.judge(candidate.text, baseline.text, 1)
      if (!stillPermitted()) throw stopError('review_cancelled')
      const firstJudged = await paidCall({ ...firstPass, route: decisionRoute, stepKey: 'review:judge:0' }, reservation.ticket, run, spend)
      if (!stillPermitted()) throw stopError('review_cancelled')
      const secondJudged = await paidCall({ ...secondPass, route: decisionRoute, stepKey: 'review:judge:1' }, reservation.ticket, run, spend)
      const judged = [firstJudged, secondJudged]
      if (judged[0] === null || judged[1] === null) throw stopError('review_interrupted')
      const ordered = [firstPass, secondPass]
        .map((built, index) => ({ built, verdict: judged[index], parsed: parseVerdict(judged[index].text) }))
        .sort((left, right) => (left.built.labels.armA === 'A' ? 0 : 1) - (right.built.labels.armA === 'A' ? 0 : 1))
      // A real cross-check only exists when the labels really were swapped; claiming otherwise would
      // let one presentation be counted twice.
      const swapped = firstPass.labels.armA !== secondPass.labels.armA
      // The structured guard is the host's own reading: every structured criterion must have been
      // reported as met by BOTH arms in at least one pass. Nothing reported is nothing passed, so a
      // criterion the judge never answered keeps the neutral-safe promotion closed.
      const structuredIds = scenario.criteria.filter(row => row.kind === 'structured').map(row => row.id)
      const metBoth = (entry, id) => {
        const rows = Array.isArray(entry.parsed?.perCriterion) ? entry.parsed.perCriterion : []
        const row = rows.find(item => item?.id === id)
        return row?.met === 'both'
      }
      // Every structured criterion must have been reported as met by BOTH arms in at least one of
      // the two passes, and the two passes must describe the same fixed criteria.
      const structuredPassed = structuredIds.length > 0 && structuredIds.every(id =>
        ordered.some(entry => entry.parsed.ok === true && metBoth(entry, id)))
      // The COMMIT is also a step the operator switch governs: a review whose answer arrived after
      // the switch closed must not turn into a trial.
      if (!stillPermitted()) throw stopError('review_cancelled')
      if (staleRun(run)) throw stopError('review_cancelled')
      await drainPending()
      const gate = await permitFor(plan, run)
      if (gate.ok !== true) {
        engine.evaluationCancel({ ticket: reservation.ticket, spent: spend.known > 0 ? spend.known : undefined })
        engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'blocked',
          ticket: null, reason: gate.reason ?? 'source_unavailable' })
        return 'blocked'
      }
      // The permit answered, but the world may have moved while it was awaiting. The commit is the
      // one step that must never happen on a permission read from before that wait.
      const refused = commitRefusal(run)
      if (refused !== null) throw stopError(refused)
      const verdict = engine.reviewResult({ ticket: reservation.ticket, projectKey: scope, planHash: plan.planHash,
        first: ordered[0].verdict.text, second: ordered[1].verdict.text,
        answers: { candidate: candidate.text, baseline: baseline.text },
        structuredPassed, criteria: scenario.criteria,
        // The submission re-states the SAME identity the reservation froze. The core refuses a
        // submission that names a different pack or version, so a caller can never re-declare the
        // domain its answer is credited to.
        packId: scenario.suite?.packId ?? null, packVersion: scenario.suite?.version ?? null,
        caseId: scenario.caseId ?? null,
        scenarioHash: scenario.scenarioHash, criteriaHash: scenario.criteriaHash,
        route: decisionRoute, judge: `${decisionRoute.provider}/${decisionRoute.model}`, swapped,
        // Every step must have reported a real measurement for the cost to count as known, and a
        // single truncated answer makes the comparison unusable.
        spent: spend.known > 0 ? spend.known : undefined,
        costKnown: spend.unknown === 0 && spend.known > 0,
        shortAnswersAllowed: scenario.shortAnswersAllowed === true,
        source: 'auto', truncated: spend.truncated > 0 })
      if (verdict.ok !== true) {
        record(`review_refused:${verdict.code ?? 'unknown'}`, plan.lessonId)
        engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'blocked', reason: verdict.code })
        return 'blocked'
      }
      engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'done',
        evidence: 'model_review', reason: verdict.state === 'reviewed' ? null : (verdict.reasons[0] ?? verdict.state) })
      record(verdict.state === 'reviewed' ? 'review_done' : `review_${verdict.state}`, plan.lessonId)
      return 'done'
    } catch (error) {
      const code = error?.code ?? 'review_judge_failed'
      // A renewal gate refusal happens BEFORE the reservation: no ticket was minted, so there is
      // nothing to cancel and nothing to retry — the plan is blocked with its own reason and the
      // spent evidence is never asked for again.
      if (code === 'renewal_waiting_evidence') {
        engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'blocked',
          ticket: null, reason: code })
        record(code, plan.lessonId)
        return 'blocked'
      }
      // Release the ticket. The core's cancel rule is deliberately one-way: the debit moves UP to
      // the larger of the reservation and what was actually measured, never down — an unknown
      // usage therefore keeps the conservative reservation instead of refunding a call that may
      // already have been paid for. The drain comes FIRST, so the release cannot race a request
      // that is still in flight, and the spend is settled exactly once, here.
      try {
        await drainPending()
        // A budget-window refusal happened before the next physical request. Keep this same open
        // ticket so the plan can resume its completed checkpoints when the rolling allowance frees.
        if (!['evaluation_budget', 'evaluation_budget_calls', 'review_budget'].includes(code)) {
          engine.evaluationCancel({ ticket: reservation.ticket, spent: spend.known > 0 ? spend.known : undefined })
        }
      } catch { record('review_cancel_failed', plan.lessonId) }
      const settled = settleStoppedPlan(plan, code, reservation.ticket)
      record(code, plan.lessonId)
      return settled
    } finally {
      if (currentRun === run) currentRun = null
    }
  }

  /**
   * One objective run: the pack's own cases, answered by both arms on the trusted route, scored by
   * the HOST pack and settled through the core's `host_pack` basis.
   *
   * The model never supplies an expected value: it answers the frozen prompt, and the pack's fixed
   * checker decides whether that answer counts. A run that cannot finish — a closed switch, a
   * cancelled ticket, a deadline, an overrun — is cancelled with the spend it really made and is
   * never reported as an improvement.
   */
  const runObjective = async (plan, lesson, runContext = {}) => {
    let pack = lesson === null ? null : objectiveContext(lesson)
    if (pack === null) {
      if (typeof plan.ticket === 'string') {
        try { engine.evaluationCancel({ ticket: plan.ticket }) } catch {}
      }
      engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'blocked',
        ticket: null, reason: 'review_missing_criteria' })
      return 'blocked'
    }
    const decisionRoute = route({ lessonId: plan.lessonId, source: plan.source })
    if (decisionRoute === null || typeof decisionRoute.provider !== 'string' || typeof decisionRoute.model !== 'string') {
      engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'blocked', reason: 'review_no_route' })
      return 'blocked'
    }
    if (!enabled()) return 'queued'
    // Foreground first, before the reservation: a person's turn owns the provider, and a yield must
    // cost neither a ticket nor one of the plan's bounded attempts.
    if (busy()) return yieldToForeground(plan)
    const reserved = 2
    const existing = typeof plan.ticket === 'string'
      ? engine.ticketContinuation({ ticket: plan.ticket, kind: 'evaluation' }) : null
    if (existing?.ok === true && pack.packId === 'package-json-structure-v1') {
      let frozenReplay
      try { frozenReplay = engine.taskEvidenceReplayCases({ ticket: plan.ticket, projectKey: pack.projectKey }) }
      catch { frozenReplay = { ok: false, code: 'task_replay_unverifiable' } }
      if (frozenReplay?.ok !== true || !Array.isArray(frozenReplay.cases) || frozenReplay.cases.length === 0) {
        try { engine.evaluationCancel({ ticket: plan.ticket }) } catch {}
        engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'blocked', ticket: null,
          reason: frozenReplay?.code ?? 'task_replay_evidence_changed' })
        return 'blocked'
      }
      pack = { ...pack, replayCases: frozenReplay.cases }
    }
    const requestHashes = objectiveRequestHashes(pack, decisionRoute, STEP_OUTPUT_TOKENS)
    const economic = requestHashes === null ? { ok: false, code: 'auto_plan_terminal_economic_identity_unknown' }
      : engine.autoPlanEconomicAdmission({ queueKey: plan.queueKey, planHash: plan.planHash, requestHashes })
    if (economic?.ok !== true) {
      engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'blocked',
        reason: economic?.code ?? 'auto_plan_terminal_economic_identity_unknown' })
      return 'blocked'
    }
    if (existing?.code === 'ticket_usage_unknown') {
      engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'blocked', ticket: null,
        reason: 'ticket_usage_unknown' })
      return 'blocked'
    }
    const prepared = existing?.ok === true ? { ok: true, ticket: plan.ticket } : engine.evaluationRequest({ lessonId: plan.lessonId, projectKey: pack.projectKey,
      expectedVersion: plan.version, packId: pack.packId, suiteId: pack.suiteId, maxTokens: reserved,
      stepwiseBudget: true, planHash: plan.planHash, queueKey: plan.queueKey,
      ...(pack.replayCases?.length ? { taskReplayCases: pack.replayCases.map(({ id, badFixtureHash, controlFixtureHash }) =>
        ({ id, badFixtureHash, controlFixtureHash })) } : {}) })
    if (prepared.ok !== true || prepared.ticket === undefined) {
      return parkTemporarily(plan, prepared.skipped ?? prepared.code ?? 'review_budget')
    }
    engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'running',
      ticket: prepared.ticket, attempts: plan.attempts + (existing?.ok === true ? 0 : 1) })
    const answers = {}, usage = {}
    const spend = { known: 0, unknown: 0, truncated: 0 }
    const run = newRun(plan, runContext)
    const started = now()
    try {
      for (const testCase of pack.cases) {
        if (!stillPermitted()) throw stopError('review_cancelled')
        if (now() - started > OBJECTIVE_DEADLINE_MS) throw stopError('review_interrupted')
        const pair = {}, measured = { baseline: null, candidate: null }
        for (const arm of ['baseline', 'candidate']) {
          const answer = await paidCall({ ...pack.arm(arm, testCase), route: decisionRoute,
            stepKey: `objective:${testCase.caseId}:${arm}` }, prepared.ticket, run, spend)
          if (answer === null) throw stopError('review_interrupted')
          pair[arm] = answer.text
          // A cut-off arm is stated to the pack, which refuses to score it as a pass.
          if (answer.truncated === true) pair.truncated = true
          // The real measurement travels with the answer: an unreported one stays null, which the
          // pack reports as an unknown-cost pair rather than as a measured zero.
          measured[arm] = Number.isSafeInteger(answer.tokens) && answer.tokens >= 0 ? answer.tokens : null
        }
        answers[testCase.caseId] = pair
        usage[testCase.caseId] = measured
      }
      const taskReplayResults = []
      for (const replay of pack.replayCases ?? []) {
        const outputs = {}
        for (const role of ['bad', 'control']) {
          if (!stillPermitted()) throw stopError('review_cancelled')
          const input = role === 'bad' ? replay.badInput : replay.controlInput
          const answer = await paidCall({
            system: `你是 package.json 结构修复器。只返回修复后的完整 JSON 对象，不要解释。方法：${pack.instruction}`,
            prompt: input, route: decisionRoute,
            stepKey: `objective:task-replay:${replay.id.slice(0, 16)}:${role}`,
          }, prepared.ticket, run, spend)
          if (answer === null) throw stopError('review_interrupted')
          if (answer.truncated === true) throw stopError('model_incomplete')
          outputs[role] = answer.text
        }
        taskReplayResults.push({ id: replay.id, badOutput: outputs.bad, controlOutput: outputs.control })
      }
      // The core re-scores every answer with the pack's own checker and applies the shared policy;
      // the adapter never sees a verdict it could report as its own.
      if (staleRun(run)) throw stopError('review_cancelled')
      await drainPending()
      const gate = await permitFor(plan, run)
      if (gate.ok !== true) {
        engine.evaluationCancel({ ticket: prepared.ticket, spent: spend.known > 0 ? spend.known : undefined })
        engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'blocked',
          ticket: null, reason: gate.reason ?? 'source_unavailable' })
        return 'blocked'
      }
      // The pack's own verdict would PROMOTE the lesson, so the licence is re-read here, after every
      // await and immediately before the settlement: a switch, an archive, a control change or a
      // slot cancellation that landed while the final permit was waiting refuses the commit.
      const refused = commitRefusal(run)
      if (refused !== null) throw stopError(refused)
      const settled = engine.evaluate({ basis: 'host_pack', packId: pack.packId, answers, usage,
        ...(taskReplayResults.length ? { taskReplayResults } : {}),
        instruction: pack.instruction, lessonId: plan.lessonId, expectedVersion: plan.version,
        suiteId: pack.suiteId, ticket: prepared.ticket, projectKey: pack.projectKey,
        eventId: `auto:${plan.queueKey}:${plan.attempts + 1}`, spent: spend.known })
      if (settled.ok !== true) {
        engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'blocked', reason: settled.code })
        return 'blocked'
      }
      engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'done', evidence: 'host_pack',
        reason: settled.decision === 'accepted' ? null : (settled.reasons ?? [])[0] ?? settled.decision })
      record(settled.decision === 'accepted' ? 'objective_validated' : `objective_${settled.decision}`, plan.lessonId)
      return 'done'
    } catch (error) {
      const code = error?.code ?? 'review_judge_failed'
      try {
        await drainPending()
        if (!['evaluation_budget', 'evaluation_budget_calls', 'review_budget'].includes(code)) {
          engine.evaluationCancel({ ticket: prepared.ticket, spent: spend.known > 0 ? spend.known : undefined })
        }
      } catch { record('objective_cancel_failed', plan.lessonId) }
      const stage = settleStoppedPlan(plan, code, prepared.ticket)
      record(code, plan.lessonId)
      return stage
    } finally {
      if (currentRun === run) currentRun = null
    }
  }

  /**
   * The LAST, SYNCHRONOUS read in front of a commit.
   *
   * EVERY check below is re-read here, after the final suspension point and immediately before the
   * core is asked to record anything: the run's cancellation generation, the operator switch, the
   * run's own AbortSignal, the shared slot's permission reader and the durable control generation.
   * A permission read BEFORE an await is not a permission to commit AFTER it — that is exactly how a
   * switch that was closed while the final permit was awaiting the session directory still wrote a
   * validated row (the run had already answered all 40 pack calls; only the commit was left).
   */
  const commitRefusal = run => {
    // The HOST's current synchronous facts first, through the very same block its permit used: the
    // plan, the stored lesson row, the explicit verification session, the live archive truth and the
    // durable control generation. This is what catches a fact that changed after the permit's own
    // last await — the caller resuming from that await is not an atomic handover.
    if (typeof run.hostRecheck === 'function') {
      let verdict = null
      try { verdict = run.hostRecheck() } catch { return 'host_state_unknown' }
      if (verdict !== null && verdict !== undefined && verdict.ok !== true) return verdict.reason ?? 'source_unavailable'
    }
    if (staleRun(run)) return 'review_cancelled'
    if (!stillPermitted()) return 'review_cancelled'
    if (run.aborted !== null && run.aborted.signal?.aborted === true) return 'review_cancelled'
    if (run.allowed !== undefined && run.allowed() !== true) return 'review_cancelled'
    if (Number.isSafeInteger(run.controlGeneration)) {
      const nowGeneration = controlGenerationNow()
      if (Number.isSafeInteger(nowGeneration) && nowGeneration !== run.controlGeneration) return 'control_changed'
    }
    return null
  }

  /**
   * One bounded scan. Serial by construction: a second call while one is running returns
   * immediately, and each plan is awaited to completion before the next one starts.
   */
  /**
   * Make every plan that is merely waiting on a budget condition — or that yielded to the
   * foreground, was cancelled, or could not have a host fact confirmed — eligible right now.
   * Called when the operator changes a setting, because that is the event that may have changed
   * the allowance or ended the foreground turn.
   */
  const rearm = () => {
    const waiting = ['review_budget', 'evaluation_budget', 'review_budget_calls', 'review_budget_tokens',
      'review_budget_disabled', 'review_not_allowed', ...CANCELLED_CODES, ...YIELD_CODES, ...UNKNOWN_FACT_CODES]
    let armed = 0
    for (const plan of engine.autoPlans()) {
      if (plan.stage !== 'queued' && plan.stage !== 'blocked') continue
      if (!waiting.includes(plan.reason)) continue
      engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'queued',
        attempts: 0, nextAttemptAt: 0, reason: null })
      armed += 1
    }
    return armed
  }

  /**
   * Run one automatic plan inside the HOST's own job slot when the adapter supplies one.
   *
   * `slot.submit` is the same queue a manual evaluation or reflection uses, so the physical provider
   * is never entered twice: the queue starts us only when its single slot is free, owns the
   * AbortSignal that pause/unload/dispose trip, and holds the slot until our work settles. Without a
   * slot (tests, SDK) the work simply runs here.
   */
  /** The AbortSignal of the job currently holding the slot. */
  let slotSignal = null

  const withinSlot = async (plan, work) => {
    if (slot === null || typeof slot.submit !== 'function') return work({ signal: undefined, allowed: () => stillPermitted() })
    // The physical-completion handle comes from the QUEUE (created with the job, before `pump()`), so
    // a job refused by the gate or cancelled before its runner microtask still completes here — a
    // deferred resolved inside `run` would hang in exactly those cases.
    const waitSettled = typeof slot.whenSettled === 'function' ? slot.whenSettled : null
    // The execution identity carries the ATTEMPT: the same wake-up is idempotent (the queue answers
    // `duplicate`), while a legitimate retry is a genuinely new job instead of a stale `done` row.
    const executionId = Number.isSafeInteger(plan.generation) ? plan.generation : 0
    const submitted = slot.submit({
      requestId: `mseauto-${plan.track}-${plan.planHash.replace(/[^a-zA-Z0-9]/gu, '').slice(0, 20)}-${executionId}`,
      kind: plan.track === 'objective' ? 'evaluation' : 'review',
      fingerprint: plan.planHash,
      label: plan.track === 'objective' ? 'MSE 自动验证' : 'MSE 自动评审',
      run: async context => {
        slotSignal = context.signal ?? null
        try {
          // The queue's OWN readers travel into the run: `allowed()` is the live permission decision
          // and `outstanding()` the physical request count. They are consulted inside the run, so a
          // job whose permission was withdrawn mid-flight cannot record a result of its own.
          return await work({ signal: context.signal, allowed: context.allowed, outstanding: context.outstanding })
        } finally {
          slotSignal = null
        }
      },
      gate: () => stillPermitted() ? { allowed: true } : { allowed: false, code: 'permission_revoked' }
    })
    if (submitted?.ok !== true) {
      // The queue already has somebody else's job: this is a YIELD, not a failure, and the plan
      // keeps its attempts for a later wake-up.
      throw stopError(submitted?.code ?? 'slot_busy')
    }
    const jobId = submitted?.job?.id
    // COMPLETION = the queue's own terminal state. There is no second wait (a deferred resolved
    // inside `run` never resolves when the job is cancelled before its runner, which parked the
    // scan for ever). The plan's outcome lives in the core, so the view is all the caller needs.
    const view = waitSettled !== null && typeof jobId === 'string' ? await waitSettled(jobId) : null
    if (view !== null && view.state === 'cancelled') {
      // The reason the QUEUE recorded wins: a foreground abort and an operator pause are different
      // facts, and the plan's own reason must say which one stopped it.
      throw stopError(view.cancelledReason === 'foreground' ? 'review_yielded' : (view.cancelledReason ?? 'review_cancelled'))
    }
    if (view !== null && view.state === 'failed') {
      throw stopError(view.code ?? 'auto_failed')
    }
    if (view !== null && view.state === 'blocked') {
      throw stopError(view.code ?? 'review_yielded')
    }
    return view
  }

  const scan = async (lessons = []) => {
    if (disposed || scanning) return { ok: false, code: disposed ? 'disposed' : 'busy' }
    scanning = true
    // Per-SCAN counters: the audit describes this pass, not the process's lifetime.
    finishedByChecker = 0
    waitingValidator = 0
    evidenceTrialsGranted = 0
    evidenceTrialsExisting = 0
    try {
      // (0) THE PROBLEM DUE-RECOVERY PASS. It shares this one wake-up, this one serial guard and the
      // one physical slot, but NOT the automatic-validation switch: a refused reflection must come
      // back on its own even on a device that never turned automatic validation on. A failure here is
      // recorded and never swallows the queue work that follows.
      let problems = null
      if (typeof dueWork === 'function') {
        try { problems = await dueWork() } catch (error) { record(`problem_pump_failed:${error?.code ?? 'unknown'}`) }
      }
      if (!enabled()) return { ok: false, code: 'auto_disabled', problems }
      // THE licence maintenance step, on the SAME real background wake-up as the queue work (a settings
      // change, a turn end, the bounded timer, startup). A trial that expired naturally has to be
      // recognised without the user asking again, and a pass with nothing to retire writes nothing —
      // this is a write path, never a read: the status card and the settings page only call `status()`.
      // A person's turn owns the session right now, so the pass stands down exactly as the paid work
      // does; the next wake-up (the turn's own end, a settings change or the timer) runs it. A
      // maintenance failure is recorded and does NOT swallow the queue work that follows.
      let maintenance = null
      if (!busy()) {
        try { maintenance = engine.maintainLearning({}) }
        catch (error) { record(`maintain_failed:${error?.code ?? 'unknown'}`) }
      }
      // A licence THIS pass retired means the caller's feed was built BEFORE the version moved: its row
      // describes an edition that no longer exists, and registering a plan for it would be work for a
      // version nobody can answer for. Those rows are dropped (the fresh rows arrive on the next
      // wake-up), so a stale feed costs one deferred scan, never a stale registration or a retry loop.
      const retired = new Set((maintenance?.rows ?? []).map(row => row.lessonId))
      const current = retired.size === 0 ? lessons : lessons.filter(lesson => !retired.has(lesson.id))
      // The candidate rows ARE the lesson facts an automatic run needs; a stripped {id, version}
      // stub cannot describe a method, so the run looks its lesson up here.
      // `lessons` is the full candidate feed (the caller must NOT pre-filter already-reviewed rows):
      // a plan that is still queued needs its lesson facts, and dropping the row here parked it as
      // `review_missing_criteria` — the starvation this fixes. The feed is a BOUNDED registration
      // window, so a plan it did not carry can NEVER be advanced (or mis-parked) on a truncated set:
      // facts for ANY live plan fall back to the core's complete per-id index (phase2-rev1 B).
      const byId = new Map(current.map(lesson => [lesson.id, lesson]))
      const lessonOf = plan => {
        const known = byId.get(plan.lessonId)
        if (known !== undefined && known !== null) return known
        try {
          const fetched = engine.autoCandidateFacts?.({ lessonId: plan.lessonId })
          return fetched?.ok === true ? (fetched.row ?? null) : null
        } catch { return null }
      }
      const registered = enqueue(current, { kind: 'turn' })
      let advanced = 0
      const plans = engine.autoPlans().filter(plan => AUTO_TRACKS.includes(plan.track)
        && (plan.stage === 'queued' || plan.stage === 'interrupted')
        && plan.attempts < MAX_ATTEMPTS && plan.nextAttemptAt <= now())
      for (const plan of plans.slice(0, MAX_PLANS_PER_SCAN)) {
        if (!enabled()) break
        // A person's turn owns the provider right now. Submitting a job only to cancel it again
        // would burn a slot round-trip and write the plan twice, so the whole scan stands down and
        // waits for the next wake-up — which the turn's own end is.
        if (busy()) break
        // Two tracks, one queue: a review run compares two answers blind, an objective run answers
        // a HOST-REGISTERED scenario set whose expected values the pack owns.
        // The whole plan runs as ONE host job: the slot is held from the first paid step until the
        // core has settled the outcome, so a manual evaluation cannot overlap it.
        try {
          await withinSlot(plan, slotContext => (plan.track === 'objective'
            ? runObjective(plan, lessonOf(plan), slotContext)
            : runReview(plan, lessonOf(plan), slotContext)))
        } catch (error) {
          if (error?.code === 'review_yielded' || error?.code === 'job_in_progress') break
          record(error?.code ?? 'auto_failed', plan.lessonId)
        }
        advanced += 1
      }
      // THE bounded persistent rotation record. This scan just considered `lessons.length` rows
      // of the core's current feed, so the consideration cursor moves on — even when the wall
      // clock did not move, and even when nothing was registered or advanced. The cursor lives in
      // the core's durable store (survives restart) and is advanced modulo the eligible count
      // (bounded). Marking a window "considered" is NOT a licence to re-pay: the next scan still
      // has to pass the FULL planHash identity compare before any plan is created or paid.
      try { if (current.length > 0) engine.autoConsiderAdvance?.({ step: current.length }) }
      catch { record('consider_advance_failed') }
      const audit = { ok: true, registered, advanced, maintenance, problems,
        // The two new facts travel with every scan, so an operator can tell "nothing to do" from
        // "settled by its own checker" and from "waiting for an applicable validator".
        registeredChecker: finishedByChecker, waitingValidator,
        evidenceTrialsGranted, evidenceTrialsExisting }
      lastScan = audit
      return { ...audit, status: status() }
    } finally { scanning = false }
  }

  /**
   * Start the bounded wake-ups: one pass at startup (so a restarted process resumes its queue) and a
   * single repeating timer that only fires early when a plan's own `nextAttemptAt` has come due.
   * The timer is owned by this scheduler and cleared on dispose; a page read never reaches it.
   */
  const start = (lessonsProvider, { intervalMs = 60_000 } = {}) => {
    if (timer !== null || disposed) return { ok: false, code: 'already_started' }
    const tick = async () => {
      if (disposed) return
      // The automatic feed is only prepared when automatic validation is actually on. The due-recovery
      // pass still runs through `scan` below: it answers to `reflectionEnabled`, not to this switch,
      // and re-checking is what keeps a device that never enabled automatic validation able to
      // recover a reflection its own rolling allowance refused.
      const automatic = enabled()
      let lessons = []
      if (automatic) {
        try { lessons = (await lessonsProvider?.()) ?? [] } catch { lessons = [] }
      }
      try { await scan(lessons) } catch { record('scan_failed') }
      if (!automatic) return
      // A queued plan whose retry time has come is worth another look even when a foreground turn is
      // quiet; the scan itself re-checks every permission before a paid step.
      const due = engine.autoPlans().some(plan => (plan.stage === 'queued' || plan.stage === 'interrupted')
        && plan.nextAttemptAt <= now())
      if (!due) return
      try { await scan(lessons) } catch { record('scan_failed') }
    }
    timer = schedule(() => { void tick() }, intervalMs)
    if (timer !== null && timer !== undefined && typeof timer.unref === 'function') timer.unref()
    void tick()
    return { ok: true, intervalMs }
  }

  return { scan, enqueue, rearm, start, abort, status, drain: drainPending,
    dispose: async () => {
      disposed = true
      if (timer !== null) { cancelTimer(timer); timer = null }
      abort('review_cancelled')
      await drainPending()
      currentRun = null
    },
    events: () => [...events] }
}
