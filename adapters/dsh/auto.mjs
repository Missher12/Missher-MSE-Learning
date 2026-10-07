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
const REVIEW_TOKENS = 4_000
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
 * @param options.route - the trusted host route `{provider, model, reasoningEffort}` for a lesson,
 *   or `null` when the host cannot name one. Never invented here.
 * @param options.callModel - `(request, signal) => Promise<string>`; the only model entry point.
 * @param options.enabled - re-read before EVERY paid step, so an operator switch takes effect now.
 * @param options.now - injectable clock (tests only).
 * @param options.log - `(code, detail) => void`, reasoning codes only, never lesson text.
 */
export function createAutoValidation({ engine, context, objectiveContext = () => null, route, callModel,
  source = () => ({}), permit = () => ({ ok: true }), enabled = () => true, now = Date.now, log = () => {},
  busy = () => false, onAbort = null, slot = null }) {
  let disposed = false
  let scanning = false
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
    engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'queued', ticket: null,
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
      .then(() => { if (run.outstanding !== undefined) run.outstanding(1); return callModel({ ...request, signal: controller.signal }, ticket) })
      // A provider that reported usage and THEN aborted still reported usage: the count travels on
      // the error so the ledger keeps it instead of discarding it as unknown.
      .catch(error => ({ text: '', tokens: Number.isSafeInteger(error?.tokens) ? error.tokens : null,
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
        if (answer !== null && Number.isSafeInteger(answer?.tokens) && answer.tokens > 0) spend.known += answer.tokens
        else if (answer !== null && answer.failed === undefined) spend.unknown += 1
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
    try { plans = engine.autoPlans() } catch { plans = [] }
    const count = stage => plans.filter(plan => plan.stage === stage).length
    return { plans: plans.length, queued: count('queued'), running: count('running'), done: count('done'),
      blocked: count('blocked'), failed: count('failed'), interrupted: count('interrupted'),
      // The newest reason is what an operator needs to see when nothing is moving.
      lastReason: plans.filter(plan => plan.reason).slice(-1)[0]?.reason ?? null,
      // Which cancellation generation is in force, and why the last one happened: a card that says
      // "waiting" is not the same statement as "stopped by a pause" or "yielded to a live turn".
      abortGeneration: cancelEpoch, lastAbortReason,
      idle: plans.every(plan => plan.stage !== 'running'),
      scans: events.length, lastEvent: events.slice(-1)[0] ?? null, reviewTokens: REVIEW_TOKENS }
  }

  /**
   * Register the review plans a set of candidate methods needs, bounded and idempotent.
   *
   * A lesson that already has a plan for its current version is left alone; a lesson whose
   * version moved gets a new plan because its old evidence is about a different row.
   */
  const enqueue = (lessons, baseSource) => {
    let registered = 0
    for (const lesson of lessons.slice(0, MAX_PLANS_PER_SCAN)) {
      if (!enabled()) break
      // The two tracks have independent contexts: a lesson whose REVIEW scenario cannot be built may
      // still be a perfectly good objective candidate, and vice versa.
      const scenario = context(lesson)
      if (scenario === null) record('review_missing_criteria', lesson.id)
      // The plan records WHERE the item came from and WHICH route its run must use. A candidate with
      // a source turn is bound to that turn; a historical one is bound to the verification session
      // the operator named, marked as backfilled, and never borrows another session's route.
      const withScope = { ...baseSource,
        ...(typeof lesson.projectKey === 'string' && lesson.projectKey !== '' ? { projectKey: lesson.projectKey } : {}),
        ...sourceOf(lesson) }
      if (scenario !== null) {
        const plan = engine.autoPlanRegister({ lessonId: lesson.id, version: lesson.version,
          environment: lesson.environment ?? 'default', track: 'review',
          source: { ...withScope, route: withScope.route ?? undefined }, suite: scenario.suite,
          criteria: scenario.criteria })
        if (plan.ok !== true) record(plan.code ?? 'auto_plan_rejected', lesson.id)
        else if (plan.settled === true) record('review_settled', lesson.id)
        else if (plan.duplicate !== true) registered += 1
      }
      // Already reviewed at this version? Then the plan does not need to exist: the lesson carries
      // the outcome (and its plan hash), so evicting a finished plan cannot make the queue pay for
      // the same comparison a second time.
      const alreadyReviewed = lesson.review?.state === 'reviewed' && lesson.trial?.state === 'trial'
      if (alreadyReviewed) continue
      // The objective half: only a candidate the pack's own predicate admits may be sent down the
      // promotion track, and it is a SEPARATE plan because it is a different execution.
      const objective = objectiveContext(lesson)
      if (objective !== null) {
        const plan = engine.autoPlanRegister({ lessonId: lesson.id, version: lesson.version,
          environment: lesson.environment ?? 'default', track: 'objective',
          source: { ...withScope, route: withScope.route ?? undefined },
          suite: objective.suite, criteria: scenario?.criteria ?? [] })
        if (plan.ok !== true) record(plan.code ?? 'auto_plan_rejected', lesson.id)
        else if (plan.settled === true) record('objective_settled', lesson.id)
        else if (plan.duplicate !== true) registered += 1
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
  const settleStoppedPlan = (plan, code) => {
    const cancelled = CANCELLED_CODES.includes(code)
    const yielded = YIELD_CODES.includes(code)
    const unknown = UNKNOWN_FACT_CODES.includes(code)
    const transient = TRANSIENT_CODES.includes(code)
    const attempts = plan.attempts + 1
    const keepAttempts = cancelled || yielded || unknown
    const stage = keepAttempts ? 'queued' : transient && attempts < MAX_ATTEMPTS ? 'queued' : 'blocked'
    const nextAttemptAt = cancelled || yielded ? now() + YIELD_RETRY_MS
      : unknown ? now() + BUDGET_RETRY_MS
      : now() + BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), BACKOFF_MS.length - 1)]
    engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage, ticket: null,
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
    const planView = engine.reviewPlan({ lessonId: plan.lessonId, projectKey: scope, maxTokens: REVIEW_TOKENS })
    if (planView.allowed !== true) return parkTemporarily(plan, planView.reasons[0] ?? 'review_not_allowed')
    const reservation = engine.reviewRequest({ lessonId: plan.lessonId, projectKey: scope, expectedVersion: plan.version,
      maxTokens: REVIEW_TOKENS, planHash: plan.planHash, queueKey: plan.queueKey,
      scenarioHash: scenario.scenarioHash, criteriaHash: scenario.criteriaHash, criteria: scenario.criteria })
    if (reservation.ok !== true || reservation.ticket === undefined) {
      // A refused reservation is not a failure: the budget may free up later, so the plan stays
      // queued and the reason is visible.
      return parkTemporarily(plan, reservation.skipped ?? reservation.code ?? 'review_budget')
    }
    engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'running',
      ticket: reservation.ticket, attempts: plan.attempts + 1 })
    // Known spend is accumulated the moment a call returns: a cancellation, a failed judge or a
    // crash must not throw away token counts the provider already told us about.
    // Known spend is accumulated the moment a call returns, and the QUALITY of the run is tracked
    // alongside it: an unknown measurement or a cut-off answer must never be reported as a clean run.
    const spend = { known: 0, unknown: 0, truncated: 0 }
    const run = newRun(plan, runContext)
    try {
      // Two isolated answers, same route, no shared context: the arms must not see each other.
      if (!stillPermitted()) throw stopError('review_cancelled')
      const candidate = await paidCall({ ...scenario.arm('candidate'), route: decisionRoute }, reservation.ticket, run, spend)
      // The switch may have been closed while that answer was in flight: the NEXT call must not be
      // issued just because the first one was.
      if (!stillPermitted()) throw stopError('review_cancelled')
      const baseline = await paidCall({ ...scenario.arm('baseline'), route: decisionRoute }, reservation.ticket, run, spend)
      if (candidate === null || baseline === null) throw stopError('review_interrupted')
      // Two judge passes over the SAME two answers with the labels swapped. The ledger returned with
      // each prompt says which label the candidate carried in that pass, so the pair can be handed
      // to the core in the documented order: the pass where the candidate was `A` comes first.
      const firstPass = scenario.judge(candidate.text, baseline.text, 0)
      const secondPass = scenario.judge(candidate.text, baseline.text, 1)
      if (!stillPermitted()) throw stopError('review_cancelled')
      const firstJudged = await paidCall({ ...firstPass, route: decisionRoute }, reservation.ticket, run, spend)
      if (!stillPermitted()) throw stopError('review_cancelled')
      const secondJudged = await paidCall({ ...secondPass, route: decisionRoute }, reservation.ticket, run, spend)
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
        scenarioHash: scenario.scenarioHash, criteriaHash: scenario.criteriaHash,
        route: decisionRoute, judge: `${decisionRoute.provider}/${decisionRoute.model}`, swapped,
        // Every step must have reported a real measurement for the cost to count as known, and a
        // single truncated answer makes the comparison unusable.
        spent: spend.known > 0 ? spend.known : undefined,
        costKnown: spend.unknown === 0 && spend.known > 0,
        shortAnswersAllowed: scenario.shortAnswersAllowed === true,
        source: 'auto', truncated: spend.truncated > 0 })
      if (verdict.ok !== true) {
        engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'blocked', reason: verdict.code })
        return 'blocked'
      }
      engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'done',
        evidence: 'model_review', reason: verdict.state === 'reviewed' ? null : (verdict.reasons[0] ?? verdict.state) })
      record(verdict.state === 'reviewed' ? 'review_done' : `review_${verdict.state}`, plan.lessonId)
      return 'done'
    } catch (error) {
      const code = error?.code ?? 'review_judge_failed'
      // Release the ticket. The core's cancel rule is deliberately one-way: the debit moves UP to
      // the larger of the reservation and what was actually measured, never down — an unknown
      // usage therefore keeps the conservative reservation instead of refunding a call that may
      // already have been paid for. The drain comes FIRST, so the release cannot race a request
      // that is still in flight, and the spend is settled exactly once, here.
      try {
        await drainPending()
        engine.evaluationCancel({ ticket: reservation.ticket, spent: spend.known > 0 ? spend.known : undefined })
      } catch { record('review_cancel_failed', plan.lessonId) }
      const settled = settleStoppedPlan(plan, code)
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
    const pack = lesson === null ? null : objectiveContext(lesson)
    if (pack === null) {
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
    // Foreground first, before the reservation: a person's turn owns the provider, and a yield must
    // cost neither a ticket nor one of the plan's bounded attempts.
    if (busy()) return yieldToForeground(plan)
    const reserved = pack.cases.length * OBJECTIVE_TOKENS_PER_CASE
    const prepared = engine.evaluationRequest({ lessonId: plan.lessonId, projectKey: pack.projectKey,
      expectedVersion: plan.version, suiteId: pack.suiteId, cases: pack.cases, maxTokens: reserved })
    if (prepared.ok !== true || prepared.ticket === undefined) {
      return parkTemporarily(plan, prepared.skipped ?? prepared.code ?? 'review_budget')
    }
    engine.autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash, stage: 'running',
      ticket: prepared.ticket, attempts: plan.attempts + 1 })
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
          const answer = await paidCall({ ...pack.arm(arm, testCase), route: decisionRoute }, prepared.ticket, run, spend)
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
        engine.evaluationCancel({ ticket: prepared.ticket, spent: spend.known > 0 ? spend.known : undefined })
      } catch { record('objective_cancel_failed', plan.lessonId) }
      const stage = settleStoppedPlan(plan, code)
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
    if (disposed || scanning || !enabled()) return { ok: false, code: disposed ? 'disposed' : 'busy' }
    scanning = true
    // The candidate rows ARE the lesson facts an automatic run needs; a stripped {id, version}
    // stub cannot describe a method, so the run looks its lesson up here.
    // `lessons` is the full candidate feed (the caller must NOT pre-filter already-reviewed rows):
    // a plan that is still queued needs its lesson facts, and dropping the row here parked it as
    // `review_missing_criteria` — the starvation this fixes.
    const byId = new Map(lessons.map(lesson => [lesson.id, lesson]))
    const lessonOf = plan => byId.get(plan.lessonId) ?? null
    try {
      const registered = enqueue(lessons, { kind: 'turn' })
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
      return { ok: true, registered, advanced, status: status() }
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
      if (disposed || !enabled()) return
      let lessons = []
      try { lessons = (await lessonsProvider?.()) ?? [] } catch { lessons = [] }
      try { await scan(lessons) } catch { record('scan_failed') }
      // A queued plan whose retry time has come is worth another look even when a foreground turn is
      // quiet; the scan itself re-checks every permission before a paid step.
      const due = engine.autoPlans().some(plan => (plan.stage === 'queued' || plan.stage === 'interrupted')
        && plan.nextAttemptAt <= now())
      if (!due) return
      try { await scan(lessons) } catch { record('scan_failed') }
    }
    timer = setInterval(() => { void tick() }, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    void tick()
    return { ok: true, intervalMs }
  }

  return { scan, enqueue, rearm, start, abort, status, drain: drainPending,
    dispose: async () => {
      disposed = true
      if (timer !== null) { clearInterval(timer); timer = null }
      abort('review_cancelled')
      await drainPending()
      currentRun = null
    },
    events: () => [...events] }
}
