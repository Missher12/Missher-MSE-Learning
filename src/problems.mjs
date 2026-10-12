/**
 * Bounded problem ledger: trusted-host failure observations aggregated into durable,
 * deduplicated problem rows.
 *
 * This module is PURE LOGIC. It never reads or writes a file, never calls a model and never
 * touches the clock on its own; the engine (src/index.mjs) is the only state writer and passes
 * `now` and the owning identity into every state function. The stored shape lives under the
 * optional schema-2 field `state.problemLoop` and is validated by {@link problemLoopValid} each
 * time the state document is validated, so an old document without the field stays an empty
 * read-only view and is never initialised by a read.
 *
 * Why these rules are the way they are:
 *  • The problem key is `owner|scope|environment|kind|taskClass|toolName|failureClass`, i.e.
 *    structured HOST fields only. Raw stderr, commands, paths or whole conversations never enter
 *    the record, and two unrelated tasks can never be aggregated into one method problem by
 *    hashing arbitrary output.
 *  • Cancellation, foreground yields and provider unavailability are availability facts, never
 *    method refutations: they are refused here (see {@link observeInState}) rather than stored as
 *    negative evidence.
 *  • Deduplication is by the host's own stable event identity (a call id), with a bounded
 *    retention window. Replays inside the window are idempotent; a real second execution with a
 *    new call id is a new independent failure. A full window refuses new facts instead of
 *    evicting live ids and silently re-counting them later.
 *  • A problem becomes eligible for method reflection only after INDEPENDENT_THRESHOLD distinct
 *    evidence entries, and an attempted reflection is bound to the exact `evidenceRevision` it
 *    saw, so abstention or interruption cannot be re-charged without new evidence.
 *  • A BUDGET or COOLDOWN refusal signs no ticket, so the revision stays attemptable — but the row
 *    is parked for a POSITIVE wait derived from the window that really refused it, and it carries a
 *    bounded source binding (`origin`) of the trusted execution that produced that revision. A host
 *    that recovers the work later must re-confirm that source against live truth; when it cannot,
 *    the row waits with an explicit reason instead of borrowing a route, a project or a default.
 */
import { createHash } from 'node:crypto'
import { check } from './store.mjs'

/** One field under schema-2 `state.problemLoop`; an absent field is the empty read-only view. */
export const PROBLEM_FORMAT = 1
/** Max aggregated problem rows in one store. */
export const PROBLEM_LIMIT = 128
/** Max recent evidence references kept per problem; eviction is display-only, the cumulative count stays. */
export const EVIDENCE_LIMIT = 16
/** A problem must be seen independently this many times before method reflection may consume budget. */
export const INDEPENDENT_THRESHOLD = 2
/** Max deduplicated event identities held in the active window. */
export const SEEN_EVENT_LIMIT = 1024
/** How long an event identity stays in the active dedupe window before it may be pruned. */
export const SEEN_EVENT_TTL_MS = 90 * 24 * 60 * 60_000
/** Cumulative count cap: a problem saturates at this many observations instead of growing forever. */
export const PROBLEM_COUNT_CAP = 4096
/** Summary cap for one problem, in UTF-16 chars (240 per design); screened like a lesson. */
export const PROBLEM_SUMMARY_CHARS = 240
/** Cooldown after an abstained reflection before the SAME evidence may be asked again. */
export const ABSTAIN_RETRY_MS = 60 * 60_000
/** Cooldown a budget-skipped problem waits before asking again (mirrors the reflection rate limit). */
export const BUDGET_WAIT_MS = 30 * 60_000
/** Max recoverable rows ONE due-feed window may carry; the host pass is bounded by this. */
export const PROBLEM_FEED_LIMIT = 8
/** Rotation-cursor bound for the due feed (mirrors the automatic-candidate cursor). */
export const PROBLEM_CONSIDER_CURSOR_MAX = 4096
/** Default wait before a source fact that could not be confirmed is re-read. Never zero. */
export const SOURCE_DEFER_MS = 30 * 60_000
/** Longest a host may defer a recoverable problem for a missing/unconfirmable source fact. */
export const PROBLEM_DEFER_MAX_MS = 6 * 60 * 60_000
/**
 * Restricted vocabulary for "a fact this host had to confirm was not there". A host may park a
 * recoverable problem with one of these and a POSITIVE wait; nothing else may be written as a
 * recovery reason, so a status surface cannot be handed free text from a caller.
 *
 * A scope/environment mismatch is deliberately IN this list: a project the source session no longer
 * reports is a WAIT (the operator may restore it), and a wait is what keeps the row in the fair feed
 * instead of turning a drifted prefix into a permanently silent wall.
 */
export const PROBLEM_DEFER_CODES = Object.freeze(['source_unbound', 'source_route_unbound', 'source_unavailable',
  'source_archived', 'source_route_changed', 'source_route_unavailable', 'host_state_unknown',
  'scope_mismatch', 'environment_mismatch', 'recovery_summary_unsafe', 'recovery_refused',
  // Stage 4b capability waits. They are a WAIT for the same reason a missing route is: the host has
  // no provable identity for this source, or no driver whose capability this build has demonstrated,
  // and "wait" keeps the row in the fair feed instead of spending the revision on a guess. They are
  // deliberately distinct so a status surface says WHICH fact is missing.
  'source_reasoning_unavailable', 'source_endpoint_unavailable', 'provider_driver_unsupported',
  'source_capacity'])
/**
 * The plan refusals that are a WAIT rather than a terminal fact for this revision.
 *
 * Everything else `problemRecoveryPlan` can answer (`revision_already_attempted`, `problem_closed`,
 * `problem_unknown`, `problem_foreign`, `reflection_in_flight`, ...) is either impossible for a row
 * the feed already filtered as recoverable or a race with a decision that has already been taken;
 * such a row is skipped WITHOUT a write and never consumes anything.
 */
export const PROBLEM_DEFER_PLAN_CODES = Object.freeze(['source_unbound', 'source_route_unbound',
  'source_unavailable', 'source_route_changed', 'source_route_unavailable',
  'source_reasoning_unavailable', 'source_endpoint_unavailable', 'provider_driver_unsupported',
  'host_state_unknown', 'scope_mismatch', 'environment_mismatch', 'recovery_summary_unsafe'])

export const PROBLEM_KINDS = Object.freeze(['tool_failure', 'task_failure', 'user_correction', 'checker_failure'])
/** The only states a problem row may take. `validated` is deliberately absent: a problem is not a lesson. */
export const PROBLEM_STATES = Object.freeze(['observed', 'eligible', 'reflecting', 'candidate_created',
  'abstained', 'waiting_budget', 'waiting_evidence', 'closed'])
export const PROBLEM_SOURCES = Object.freeze(['host_event', 'direct_user', 'host_checker'])
/**
 * Restricted failure vocabulary. Only these classes may be stored; `cancelled` and
 * `foreground_yield` are recognised so a host can SAY what happened, but they are refused as
 * method evidence (availability statistics are not method refutations).
 */
export const PROBLEM_FAILURE_CLASSES = Object.freeze(['tool_nonzero_exit', 'tool_error_flag', 'tool_timeout',
  'provider_unavailable', 'checker_contract_failure', 'unknown_tool_failure', 'cancelled', 'foreground_yield'])
/** These classes are NOT method evidence and may never be persisted as a problem observation. */
const AVAILABILITY_ONLY = new Set(['cancelled', 'foreground_yield', 'provider_unavailable'])
/** Whether a restricted class is an availability fact rather than method evidence. */
export const isAvailabilityClass = failureClass => AVAILABILITY_ONLY.has(failureClass)
/** Problem kinds that may consume reflection budget to produce a method candidate. */
export const REFLECTABLE_KINDS = new Set(['tool_failure', 'task_failure', 'checker_failure'])

/**
 * The same screening the lesson path applies to stored text. `token`, URLs, paths (user AND
 * system roots such as /tmp, /var, /etc, /opt), emails and credential markers inside a
 * host-provided summary must not become part of the durable record or of a model prompt.
 * Kept here AND reused by the core so the two boundaries cannot drift.
 */
export const SENSITIVE_PATTERN = /https?:\/\/|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|(?:\/Users\/|\/home\/|\/tmp\/|\/var\/|\/etc\/|\/opt\/|\/usr\/|[A-Z]:\\)|(?:api[_-]?key|token|secret|password|authorization|cookie|密码|密钥)\s*[:=：]|\bBearer\s+\S+|-----BEGIN|\bsk-[A-Za-z0-9_-]{12,}/iu
export const AUTHORITY_PATTERN = /忽略.{0,12}(?:指令|规则|用户|权限)|绕过.{0,12}(?:授权|权限|限制)|(?:ignore|override).{0,20}(?:instructions|permissions)|(?:system|assistant|developer)\s*:|<\/?(?:system|instruction|mse)|```/iu

/**
 * A summary a model may later see: short in CODE POINTS (the "max 240 characters" contract),
 * non-blank, and free of secrets and authority changes. The validator shares the same measure,
 * so a summary that passes screening always passes storage.
 */
export function screenProblemSummary(summary) {
  check(typeof summary === 'string' && [...summary].length >= 1 && [...summary].length <= PROBLEM_SUMMARY_CHARS
    && summary.trim() !== '' && /[\r\n\u0000-\u001f\u007f]/u.test(summary) === false, 'unsafe_or_oversized_summary')
  check(!SENSITIVE_PATTERN.test(summary) && !AUTHORITY_PATTERN.test(summary), 'unsafe_or_oversized_summary')
  return summary.trim()
}

const hash = text => createHash('sha256').update(text).digest('hex')
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && /[\u0000-\u001f\u007f]/u.test(value) === false
const isPlainObject = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

/** Read-only default; never creates the field. */
export const problemLoopOf = state => state.problemLoop ?? { format: PROBLEM_FORMAT, problems: [], seenEvents: [] }
/** Write-side constructor; only called inside a write transaction. */
export function ensureProblemLoop(state) {
  state.problemLoop ??= { format: PROBLEM_FORMAT, problems: [], seenEvents: [] }
  return state.problemLoop
}

/**
 * The aggregation key. Structured host fields ONLY: owner + scope + environment + kind +
 * taskClass + toolName + the restricted failure class. `null` slots render as the empty string
 * so different absences stay different keys.
 */
export function problemKey({ owner, scope, environment, kind, taskClass = null, toolName = null, failureClass = null }) {
  check(hex64(owner) && hex64(scope) && hex64(environment) && PROBLEM_KINDS.includes(kind)
    && (taskClass === null || bounded(taskClass, 64)) && (toolName === null || bounded(toolName, 64))
    && (failureClass === null || problemClassOf(kind, failureClass)), 'invalid_problem')
  return hash(JSON.stringify([owner, scope, environment, kind, taskClass ?? '', toolName ?? '', failureClass ?? '']))
}

/** The failure vocabulary a kind may carry: corrections carry none, checker verdicts one. */
function problemClassOf(kind, failureClass) {
  if (kind === 'user_correction') return failureClass === null
  if (kind === 'checker_failure') return failureClass === null || failureClass === 'checker_contract_failure'
  return failureClass === null || PROBLEM_FAILURE_CLASSES.includes(failureClass)
}

/**
 * The bounded SOURCE BINDING of one problem revision — which trusted host execution made the
 * evidence that IS this revision attemptable.
 *
 * It is the minimum a separate process needs to resume the work instead of guessing:
 *  • `sessionId` — the host's own session handle. It is NOT the project: the project is only ever
 *    re-derived by asking the trusted directory, so a hash can never be inverted back into a path.
 *  • `turnHash` — the hashed turn identity (never the raw transcript, and never reusable as a
 *    lookup key on its own; it exists so a recovering host can prove it is binding the SAME turn).
 *  • `provider`/`model`/`reasoningEffort` — the route the turn really ran on. A recovered attempt
 *    may only use this frozen route; a session whose route later changed is a DIFFERENT execution
 *    and must wait instead of silently running on the new model.
 *  • `routeId` — OPTIONAL. The digest of the host's full normalized source identity (endpoint,
 *    api mode, the exact reasoning state) once the trusted source ledger has one
 *    (`src/sources.mjs`). The three scalars above cannot tell two dispatches apart when they agree
 *    on provider and model but differ in protocol, endpoint or whether an effort is sent at all;
 *    a ticket bound to this problem can then require the identity it dispatches through to be the
 *    one the evidence was produced under. Absent means "this deployment never published one" —
 *    an old document stays valid, and a gate that needs it says so instead of guessing.
 *  • `at` — when the binding was taken (the observation).
 *
 * No transcript, no command line, no stderr, no credential: `sessionId` is a host handle that the
 * adapter already receives, and the summary stays the screened 240-character one on the row.
 */
export function problemOriginValid(origin) {
  return isPlainObject(origin)
    && Object.keys(origin).every(key => ['sessionId', 'turnHash', 'provider', 'model', 'reasoningEffort',
      'routeId', 'at'].includes(key))
    && typeof origin.sessionId === 'string' && origin.sessionId.length > 0 && origin.sessionId.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(origin.sessionId)
    && (origin.turnHash === null || hex64(origin.turnHash))
    && (origin.provider === null || bounded(origin.provider, 32))
    && (origin.model === null || bounded(origin.model, 64))
    && (origin.reasoningEffort === null || bounded(origin.reasoningEffort, 16))
    && (origin.routeId === undefined || origin.routeId === null || hex64(origin.routeId))
    && Number.isFinite(origin.at)
}

/**
 * Build the binding a trusted host supplied, or `null` when it named no session.
 *
 * A route is optional here and stays optional in the row: an observation whose turn route was
 * never recorded produces a binding that CANNOT be recovered (the plan says `source_route_unbound`),
 * which is the honest answer — guessing a default model is exactly what this field exists to stop.
 */
export function problemOriginOf(input, fallbackAt) {
  if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) return null
  const route = isPlainObject(input.route) ? input.route : null
  const text = (value, max) => (typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null)
  return { sessionId: input.sessionId.slice(0, 512),
    turnHash: hex64(input.turnHash) ? input.turnHash : null,
    provider: text(route?.provider, 32), model: text(route?.model, 64),
    reasoningEffort: text(route?.reasoningEffort, 16),
    // The full-identity digest, when the host could state one: `null` means it could not, never a
    // digest this core invented from the three scalars (that would look like proof and be none).
    routeId: hex64(input.routeId) ? input.routeId : null,
    at: Number.isFinite(fallbackAt) ? fallbackAt : 0 }
}

/** Whether a stored problem row passes every bounded shape rule. */
export function problemRowValid(row) {
  return isPlainObject(row)
    && Object.keys(row).every(key => ['id', 'key', 'kind', 'state', 'source', 'scope', 'environment', 'owner',
      'taskClass', 'toolName', 'failureClass', 'summary', 'evidenceRevision', 'attemptedRevision',
      'lessonId', 'lessonVersion', 'evidence', 'count', 'firstAt', 'lastAt', 'updatedAt', 'reason',
      'nextAttemptAt', 'ticket', 'origin'].includes(key))
    // `origin` is written by this build for every NEW row and tolerated as ABSENT for a document
    // written before it existed: an old store must keep validating (it simply has nothing to
    // recover from, and the plan says so instead of borrowing a route).
    && (row.origin === undefined || row.origin === null || problemOriginValid(row.origin))
    && hex64(row.id) && hex64(row.key) && PROBLEM_KINDS.includes(row.kind) && PROBLEM_STATES.includes(row.state)
    && PROBLEM_SOURCES.includes(row.source) && hex64(row.scope) && hex64(row.environment) && hex64(row.owner)
    && (row.taskClass === null || bounded(row.taskClass, 64)) && (row.toolName === null || bounded(row.toolName, 64))
    && (row.failureClass === null || PROBLEM_FAILURE_CLASSES.includes(row.failureClass))
    // Same measure as screenProblemSummary: code points up to the 240-character contract, and the
    // stored value must not be blank. The two functions are the two halves of ONE boundary.
    && typeof row.summary === 'string' && [...row.summary].length >= 1 && [...row.summary].length <= PROBLEM_SUMMARY_CHARS
    && row.summary.trim() !== ''
    && Number.isSafeInteger(row.evidenceRevision) && row.evidenceRevision >= 0
    && Number.isSafeInteger(row.attemptedRevision) && row.attemptedRevision >= 0
    && (row.lessonId === null || (typeof row.lessonId === 'string' && row.lessonId.length <= 40))
    && (row.lessonVersion === null || (Number.isSafeInteger(row.lessonVersion) && row.lessonVersion > 0))
    && Array.isArray(row.evidence) && row.evidence.length <= EVIDENCE_LIMIT
    && row.evidence.every(entry => isPlainObject(entry)
      && Object.keys(entry).every(key => ['eventId', 'turnHash', 'at'].includes(key))
      && hex64(entry.eventId) && hex64(entry.turnHash) && Number.isFinite(entry.at))
    && Number.isSafeInteger(row.count) && row.count >= 0 && row.count <= PROBLEM_COUNT_CAP
    && Number.isFinite(row.firstAt) && Number.isFinite(row.lastAt) && Number.isFinite(row.updatedAt)
    && Number.isFinite(row.nextAttemptAt)
    && (row.reason === null || bounded(row.reason, 64))
    && (row.ticket === null || bounded(row.ticket, 64))
}

/** Whole-ledger shape validation, run wherever the document is validated. */
export function problemLoopValid(state) {
  if (state.problemLoop === undefined) return true
  const loop = state.problemLoop
  check(isPlainObject(loop) && Object.keys(loop).every(key => ['format', 'problems', 'seenEvents'].includes(key))
    && loop.format === PROBLEM_FORMAT
    && Array.isArray(loop.problems) && loop.problems.length <= PROBLEM_LIMIT
    && Array.isArray(loop.seenEvents) && loop.seenEvents.length <= SEEN_EVENT_LIMIT, 'invalid_problem_loop')
  const ids = new Set()
  for (const row of loop.problems) {
    check(problemRowValid(row) && !ids.has(row.id), 'invalid_problem_loop')
    ids.add(row.id)
  }
  for (const entry of loop.seenEvents) {
    check(isPlainObject(entry) && hex64(entry.eventId) && Number.isFinite(entry.at), 'invalid_problem_loop')
  }
  check(new Set(loop.seenEvents.map(row => row.eventId)).size === loop.seenEvents.length, 'invalid_problem_loop')
  return true
}

/** Prune expired dedupe identities; called inside the write transaction before an observation. */
function pruneSeenEvents(loop, now) {
  loop.seenEvents = loop.seenEvents.filter(entry => entry.at > now - SEEN_EVENT_TTL_MS)
}

/**
 * Apply one trusted host observation to a state the caller already holds the write lock for.
 *
 * @param state - working state (must already carry problemLoop from ensureProblemLoop).
 * @param now - engine clock.
 * @param input - validated observation: `{ eventId, kind, source, scope, environment, owner,
 *   taskClass, toolName, failureClass, summary, turnHash, routeId? }`.
 * @returns `{ ok, duplicate?, skipped?, id?, problem?, ready? }` — `ready` is true only when
 *   this problem may consume reflection budget right now.
 */
export function observeInState(state, now, input) {
  check(AVAILABILITY_ONLY.has(input.failureClass) === false, 'availability_not_a_problem')
  const loop = ensureProblemLoop(state)
  pruneSeenEvents(loop, now)
  const { eventId, kind, source, scope, environment, owner, taskClass, toolName, failureClass, summary, turnHash } = input
  const id = problemKey({ owner, scope, environment, kind, taskClass, toolName, failureClass })
  // The dedupe identity is scoped to the FULL host context, never the bare call id: the same
  // locally-numbered call in another project, session or environment is a different fact, and a
  // replay of THIS context must dedupe against THIS problem only.
  const identity = hash(JSON.stringify([owner, scope, environment, kind, turnHash, eventId]))
  const prior = loop.seenEvents.find(entry => entry.eventId === identity)
  if (prior !== undefined) {
    // Same host event identity, inside the active window: an idempotent replay, never a new fact.
    return { ok: true, duplicate: true, id, ready: false }
  }
  if (loop.seenEvents.length >= SEEN_EVENT_LIMIT) {
    // The window is provably full AFTER pruning: refuse rather than evict live ids and re-count.
    check(false, 'problem_ledger_saturated')
  }
  loop.seenEvents.push({ eventId: identity, at: now })
  // The binding travels with the observation that produced this revision: the source of the
  // CURRENT revision is the evidence that actually made it attemptable, never the first one.
  const origin = problemOriginOf({ ...input, turnHash, routeId: input.routeId ?? null }, now)
  let row = loop.problems.find(problem => problem.id === id)
  if (row === undefined) {
    check(loop.problems.length < PROBLEM_LIMIT, 'problem_ledger_full')
    row = { id, key: id, kind, state: 'observed', source, scope, environment, owner,
      taskClass: taskClass ?? null, toolName: toolName ?? null, failureClass: failureClass ?? null,
      summary, evidenceRevision: 0, attemptedRevision: 0, lessonId: null, lessonVersion: null,
      evidence: [], count: 0, firstAt: now, lastAt: now, updatedAt: now, reason: null,
      nextAttemptAt: 0, ticket: null, origin }
    loop.problems.push(row)
  } else if (origin !== null) {
    row.origin = origin
  }
  const entry = { eventId: identity, turnHash, at: now }
  const appended = row.evidence.length >= EVIDENCE_LIMIT
    ? [...row.evidence.slice(1), entry] : [...row.evidence, entry]
  row.evidence = appended
  row.count = Math.min(PROBLEM_COUNT_CAP, row.count + 1)
  row.evidenceRevision += 1
  row.lastAt = now
  row.updatedAt = now
  // A reflection is IN FLIGHT: the new fact is counted, but the current ticket, attempted revision
  // and state stay untouched — a second reflection over the same problem must not start while the
  // first is still authorised. The settling result decides what the new evidence means.
  if (row.state === 'reflecting') {
    row.reason = null
    return { ok: true, duplicate: false, id, problem: { ...row }, ready: false }
  }
  row.reason = null
  row.ticket = null
  // Re-state only when the new evidence actually changes the problem's meaning. The linked
  // candidate (lessonId/version) is HISTORY and is NEVER cleared by a new observation: the old
  // method stays referenced by its problem, and only a NEW reflection may link a newer candidate.
  if (row.state === 'observed' && row.evidenceRevision >= INDEPENDENT_THRESHOLD) {
    row.state = 'eligible'
  } else if (row.state === 'closed' || row.state === 'abstained' || row.state === 'waiting_evidence'
    || (row.state === 'candidate_created' && row.evidenceRevision > row.attemptedRevision)) {
    row.state = row.evidenceRevision >= INDEPENDENT_THRESHOLD ? 'eligible' : 'observed'
  }
  const ready = reflectionReady(row, now)
  if (ready) row.reason = 'ready_for_reflection'
  return { ok: true, duplicate: false, id, problem: { ...row }, ready }
}

/**
 * Whether this row may EVER be attempted again for the revision it currently holds — time excluded.
 *
 * This is the durable half of the recovery contract, and it is deliberately about the REVISION:
 * `evidenceRevision > attemptedRevision` is the whole rule that makes a ticket consume an attempt.
 * Once a ticket has been signed, `attemptedRevision` equals the revision that was reflected, so the
 * same evidence is never replayable — not after a crash before the send, not across a restart, not
 * across a day boundary, and not after an abstention, a timeout, a cancellation or an unknown
 * usage. Only genuinely NEW independent host evidence advances the revision and buys a new chance.
 */
export function problemRecoverable(row) {
  return problemRecoveryRefusal(row) === null
}

/** The bounded reason a row cannot be attempted right now, or `null` when it can. */
export function problemRecoveryRefusal(row) {
  if (!REFLECTABLE_KINDS.has(row.kind)) return 'problem_kind_not_reflectable'
  if (row.state === 'reflecting') return 'reflection_in_flight'
  if (row.state === 'closed') return 'problem_closed'
  if (row.evidenceRevision < INDEPENDENT_THRESHOLD) return 'evidence_below_threshold'
  if (row.evidenceRevision <= row.attemptedRevision) return 'revision_already_attempted'
  if (!['eligible', 'observed', 'waiting_budget'].includes(row.state)) return 'problem_not_eligible'
  return null
}

/**
 * Whether a problem may consume reflection budget right now.
 *
 * Requires a reflectable kind, the independent-evidence threshold, NEW evidence since the last
 * attempt (`evidenceRevision > attemptedRevision`, so an abstained or interrupted reflection is
 * not re-charged on its own) and an elapsed wait. A `waiting_budget` problem whose cooldown has
 * passed is asked again: the daily/cooldown gate re-reads live budget inside the request.
 */
export function reflectionReady(row, now) {
  return problemRecoverable(row) && now >= row.nextAttemptAt
}

/** Bind a reflection ticket to the problem INSIDE the same transaction that issued the ticket. */
export function beginReflectionInState(row, now, ticket) {
  check(row.ticket === null && reflectionReady(row, now), 'problem_not_reflectable')
  row.state = 'reflecting'
  row.attemptedRevision = row.evidenceRevision
  row.ticket = ticket
  row.reason = null
  row.nextAttemptAt = 0
  row.updatedAt = now
}

/**
 * The reflection gate refused this problem (budget/cooldown): park it with a visible reason.
 *
 * `until` must be the moment the refusal REALLY ends. The gate's cooldown is only half of it: when
 * the rolling 3-per-24h allowance is what refused, the cooldown is usually already in the past and
 * copying it wrote a `nextAttemptAt` in the past — `reflectionReady` then answered "yes" on the very
 * next tick, which is a zero-delay retry over evidence that cannot be charged (audit problem-pump
 * baseline). This function therefore CLAMPS: a park is always a positive wait, so an idle process
 * polls on its own bounded timer instead of spinning.
 */
export function parkProblemInState(row, code, now, until) {
  row.state = code === 'reflection_budget' ? 'waiting_budget' : row.state
  row.reason = String(code ?? 'reflection_budget').slice(0, 64)
  const requested = Number.isFinite(until) ? until : now + BUDGET_WAIT_MS
  const safe = requested > now ? requested : now + BUDGET_WAIT_MS
  row.nextAttemptAt = Math.max(row.nextAttemptAt, safe)
  row.updatedAt = now
}

/** Whether a settlement left untried evidence behind (a mid-flight observation advanced the revision). */
const hasUntriedEvidence = row => row.evidenceRevision > row.attemptedRevision

/**
 * A reflection finished without a method: record the attempt so only new evidence re-asks.
 *
 * A settlement that finds NEW evidence that arrived while the reflection was in flight must leave
 * the problem eligible again — the untried revision was never reflected. Without this, a stale
 * result rejection plus an in-flight observation would strand the problem in `abstained` and
 * `reflectionReady` would never revisit it (audit matrix rev2, inflight-new-evidence). The
 * attempted revision is untouched, so already-tried evidence is never re-charged.
 */
export function abstainInState(row, now) {
  if (row.ticket !== null) row.ticket = null
  if (hasUntriedEvidence(row)) {
    row.state = row.evidenceRevision >= INDEPENDENT_THRESHOLD ? 'eligible' : 'observed'
    row.reason = 'new_evidence_after_attempt'
  } else {
    row.state = 'abstained'
    row.reason = 'abstained_no_method'
    row.nextAttemptAt = Math.max(row.nextAttemptAt, now + ABSTAIN_RETRY_MS)
  }
  row.updatedAt = now
}

/**
 * A reflection produced a method candidate: link it atomically with the lesson write.
 *
 * The candidate link is kept even when new in-flight evidence leaves the problem eligible for a
 * fresh reflection — the old method stays referenced by the problem (never cleared), and only the
 * newest method may claim the newest revision. Without in-flight evidence it parks in
 * `candidate_created` exactly as before.
 */
export function linkCandidateInState(row, lessonId, version, now) {
  if (row.ticket !== null) row.ticket = null
  row.lessonId = lessonId
  row.lessonVersion = version
  if (hasUntriedEvidence(row)) {
    row.state = row.evidenceRevision >= INDEPENDENT_THRESHOLD ? 'eligible' : 'observed'
    row.reason = 'new_evidence_after_attempt'
  } else {
    row.state = 'candidate_created'
    row.reason = null
  }
  row.updatedAt = now
}

/**
 * An interrupted/cancelled reflection: keep the attempted revision, ask again only on new evidence.
 *
 * New evidence that landed mid-flight is untried, so the problem returns to `eligible` (never
 * stranded in `waiting_evidence`); with no new evidence it keeps the original waiting semantics.
 */
export function interruptInState(row, now, code) {
  if (row.ticket !== null) row.ticket = null
  if (row.state === 'reflecting') {
    if (hasUntriedEvidence(row)) {
      row.state = row.evidenceRevision >= INDEPENDENT_THRESHOLD ? 'eligible' : 'observed'
      row.reason = `new_evidence_${code}`.slice(0, 64)
    } else {
      row.state = 'waiting_evidence'
      row.reason = code
      row.nextAttemptAt = Math.max(row.nextAttemptAt, now + BUDGET_WAIT_MS)
    }
  } else {
    row.reason = code
  }
  row.updatedAt = now
}

/** Close a problem (one linked lesson was withdrawn/validated, or the operator closed it). */
export function closeInState(row, now, reason) {
  if (row.ticket !== null) row.ticket = null
  row.state = 'closed'
  row.reason = String(reason ?? 'closed').slice(0, 64)
  row.updatedAt = now
}

/**
 * Read-only status view of the ledger.
 *
 * Writes nothing, calls no model and never injects lesson text or summaries into a task. The
 * `reason`/`nextAction` fields are what an operator needs to see when nothing is moving.
 */
export function problemStatusView(loop, { now, owner, scope, limit = 20 } = {}) {
  const scoped = loop.problems.filter(row => row.owner === owner
    && (scope === undefined || row.scope === scope))
  const byState = Object.fromEntries(PROBLEM_STATES.map(state => [state, 0]))
  for (const row of scoped) byState[row.state] += 1
  const view = row => {
    const ready = reflectionReady(row, now)
    const refusal = problemRecoveryRefusal(row)
    const nextAction = row.state === 'reflecting' ? 'reflection_in_flight'
      : ready ? 'reflection_ready'
      // A row that is recoverable but parked says WHICH fact it is waiting for and until when,
      // instead of looking like a row that merely needs more evidence.
      : refusal === null && row.nextAttemptAt > now ? `waiting_${row.reason ?? 'retry'}_until_${row.nextAttemptAt}`
      : refusal !== null ? refusal
      : row.state === 'waiting_budget' ? `waiting_budget_until_${row.nextAttemptAt}`
      : row.state === 'observed' || row.state === 'eligible' ? `needs_${INDEPENDENT_THRESHOLD}_independent_observations`
      : row.state === 'candidate_created' ? 'candidate_linked'
      : row.state === 'abstained' ? 'waiting_new_evidence'
      : row.state === 'waiting_evidence' ? 'waiting_new_evidence'
      : row.state === 'closed' ? 'closed'
      : row.state
    return { id: row.id, kind: row.kind, state: row.state, source: row.source, taskClass: row.taskClass,
      toolName: row.toolName, failureClass: row.failureClass,
      evidenceRevision: row.evidenceRevision, attemptedRevision: row.attemptedRevision,
      count: row.count, firstAt: row.firstAt, lastAt: row.lastAt,
      lessonId: row.lessonId, lessonVersion: row.lessonVersion, recoverable: refusal === null, refusal,
      ready, reason: row.reason, nextAction, nextAttemptAt: row.nextAttemptAt,
      // The binding is reported as BOUNDED FACTS, never as the raw material a model would see: the
      // session handle and the frozen route are what a recovery needs, and the summary is not part
      // of this view at all (a status read must not become a prompt).
      origin: row.origin === undefined || row.origin === null ? null
        : { sessionId: row.origin.sessionId, turnHash: row.origin.turnHash,
          provider: row.origin.provider, model: row.origin.model,
          reasoningEffort: row.origin.reasoningEffort,
          routeId: row.origin.routeId ?? null, at: row.origin.at },
      evidence: row.evidence.slice(-EVIDENCE_LIMIT) }
  }
  return { ok: true, format: loop.format, total: loop.problems.length, scoped: scoped.length,
    recoverable: scoped.filter(row => problemRecoverable(row)).length,
    due: scoped.filter(row => reflectionReady(row, now)).length,
    dedupeWindow: SEEN_EVENT_TTL_MS, dedupeCapacity: SEEN_EVENT_LIMIT, dedupeActive: loop.seenEvents.length,
    byState, rows: scoped.slice(-limit).map(view) }
}

/** All problems of one owner that are ready to reflect now; used by the host lifecycle pass. */
export function readyProblems(loop, { now, owner }) {
  return loop.problems.filter(row => row.owner === owner && reflectionReady(row, now))
}

/**
 * Read-only default for the rotation cursor; never creates the field.
 *
 * The cursor is the PERSISTENT FAIRNESS WATERMARK of the due feed: the ranked recoverable rows are
 * walked from wherever the last real pass stopped, so a row that keeps being refused (an archived
 * session, a missing route, a park for the rolling window) can never occupy the whole bounded
 * window for ever, and rows beyond the window are still considered within a bounded number of
 * passes. It is advanced by the real pass only — a read never moves it.
 */
export function problemConsiderOf(state) {
  const cursor = state.problemConsider?.cursor
  return Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= PROBLEM_CONSIDER_CURSOR_MAX ? cursor : 0
}
/** Write-side constructor; only called inside a write transaction. */
export function ensureProblemConsider(state) {
  state.problemConsider ??= { cursor: 0 }
  return state.problemConsider
}
/** Whether the optional rotation record passes its bounded shape rule. */
export function problemConsiderValid(state) {
  if (state.problemConsider === undefined) return true
  const record = state.problemConsider
  return isPlainObject(record) && Object.keys(record).every(key => key === 'cursor')
    && Number.isSafeInteger(record.cursor) && record.cursor >= 0 && record.cursor <= PROBLEM_CONSIDER_CURSOR_MAX
}

/** The recoverable rows of one owner, in the ONE stable ranking the feed rotates over. */
export function rankedRecoverableProblems(loop, owner) {
  return loop.problems.filter(row => row.owner === owner && problemRecoverable(row))
    .sort((left, right) => (left.nextAttemptAt - right.nextAttemptAt) || (left.lastAt - right.lastAt)
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/**
 * The bounded due feed one host pass may work on.
 *
 * `rows` is a rotated window over the ranked recoverable rows, so the caller's local checks and its
 * remote source reads are bounded per pass, and no row can starve. Each row says whether it is DUE
 * right now (`due`): a pass may consider a not-yet-due row and must not attempt it — that is what
 * keeps a parked row from becoming a hot scan while still moving the watermark forward.
 */
export function problemFeedView(loop, { now, owner, limit = PROBLEM_FEED_LIMIT, cursor = 0 } = {}) {
  const ranked = rankedRecoverableProblems(loop, owner)
  const start = ranked.length === 0 ? 0 : Math.max(0, cursor) % ranked.length
  const rotated = ranked.length === 0 ? [] : [...ranked.slice(start), ...ranked.slice(0, start)]
  const rows = rotated.slice(0, limit).map(row => ({
    id: row.id, kind: row.kind, state: row.state, scope: row.scope, environment: row.environment,
    taskClass: row.taskClass, toolName: row.toolName, failureClass: row.failureClass,
    evidenceRevision: row.evidenceRevision, attemptedRevision: row.attemptedRevision, count: row.count,
    firstAt: row.firstAt, lastAt: row.lastAt, reason: row.reason, nextAttemptAt: row.nextAttemptAt,
    due: reflectionReady(row, now),
    origin: row.origin === undefined || row.origin === null ? null
      : { sessionId: row.origin.sessionId, turnHash: row.origin.turnHash,
        provider: row.origin.provider, model: row.origin.model, reasoningEffort: row.origin.reasoningEffort,
        routeId: row.origin.routeId ?? null },
  }))
  const upcoming = ranked.reduce((soonest, row) => row.nextAttemptAt > now
    ? Math.min(soonest, row.nextAttemptAt) : soonest, Infinity)
  return { rows, cursor: start, eligible: ranked.length, due: rows.filter(row => row.due).length,
    // Due rows in the WHOLE ranking, not only in the window: a rotated window that happens to start
    // inside the parked segment must still be able to tell that real work is waiting outside it.
    dueTotal: ranked.filter(row => reflectionReady(row, now)).length,
    nextDueAt: Number.isFinite(upcoming) ? upcoming : null, now }
}

export { hash as problemHash }