#!/usr/bin/env node
import { LearningEngine } from './index.mjs'
import { createTaskEvidenceAuthority } from './task-evidence.mjs'

// Local trusted-host transport. stdout is protocol-only; no shell commands or model calls.
const operations = new Set(['prepare', 'record', 'accept', 'cancel', 'complete', 'status', 'reflectionRequest', 'reflectionResult',
  'reflectionCancel', 'migrate', 'list', 'history', 'evaluate', 'evaluateRegistered', 'checkArtifact',
  'suspend', 'resume', 'rollback', 'exportLesson', 'importLesson', 'evaluationRequest', 'evaluationCancel',
  'diagnose',
  // Durable settlement, for the trusted adapter only. `settlementApply` is called without the
  // in-process guard: the core's own control state (pause, exact stop, owner, deadline) travels
  // in the same document and is re-read under the lock, which is the part that must be
  // authoritative across processes. The adapter re-reads its local permission before each call.
  'settlementEnqueue', 'settlementStatus', 'settlementApply', 'settlementStop', 'settlementPause',
  // Stage 4a — the bounded problem-ledger surface the Hermes adapter actually calls. Reads
  // (`problemStatus`, `recentAdoptions`, `reflectionPlan`) write nothing and call no model; the
  // write (`observeProblem`) lands in the SAME ledger and transaction the Node adapter uses. None
  // of them is registered as an Agent tool, and the config (stateRoot/adapterId/instance/budget)
  // still comes from the trusted caller, never from a model.
  //
  // Deliberately NOT opened yet: `problemDueFeed`, `problemRecoveryPlan`, `problemDefer`,
  // `problemConsiderAdvance`, `recoverProblems`, `controlGeneration`. They belong to the recovery
  // pass (4b/4c), which is also where the durable final-permission gate lands; exposing them now
  // would widen the trusted surface with entry points nothing in this stage exercises.
  'observeProblem', 'problemStatus', 'recentAdoptions', 'reflectionPlan',
  // The recovery pass's read + park pair: the Hermes adapter asks `problemRecoveryPlan` whether a
  // problem's SOURCE may be reflected on before it signs anything, and parks a source fact it could
  // not confirm with `problemDefer`. Both land in the same ledger the Node adapter uses.
  'problemRecoveryPlan', 'problemDefer',
  // Stage 4b — the due feed and the fair watermark a bounded recovery pass works through, the
  // read-only control generation, and the release of attempts a dead process left in flight.
  // Opening them is what makes a second process able to resume work the first one abandoned; the
  // attempt itself still has to pass the core's own readiness check inside `reflectionRequest`.
  'problemDueFeed', 'problemConsiderAdvance', 'controlGeneration', 'recoverProblems',
  // The bounded durable SOURCE IDENTITY a paid attempt is gated on: publishing a normalized
  // (credential-free) identity for one source session, withdrawing it with an explicit
  // compare-and-set, and reading it back. No model, no budget and no evidence threshold lives here.
  'sourcePublish', 'sourceRelease', 'sourceStatus',
  // ── Stage 4c: the two PAID tracks an automatic pass schedules ────────────────────────────────────
  // These are the existing core entry points, opened one by one rather than as a family. The two
  // REQUEST operations and the two RESULT operations are the automatic, source-bound path and are
  // guarded below: a request that states half a binding is refused at the transport instead of
  // quietly becoming a legacy call, and the released `evaluate`/`evaluationRequest` documents keep
  // their exact meaning. The plan/material reads write nothing and call no model.
  'reviewPlan', 'reviewMaterial', 'reviewJudge', 'reviewRequest', 'reviewResult',
  'evaluationPlan', 'objectiveMaterial', 'objectiveResult',
  // The automatic plan registry: registering work, reading the identity a registration WOULD carry,
  // advancing the bounded bookkeeping, and the read-only views a pass works from. None of them calls
  // a model; the paid call is the track request above, gated on the same frozen identity.
  'autoPlanProposal', 'autoPlanRegister', 'autoPlanIdentity', 'autoPlanUpdate', 'autoPlans',
  // The step-wise cost report: a multi-step run persists each step's raw usage BEFORE it awaits the
  // next provider call, so a crash between steps cannot lose tokens the provider already reported.
  // It grants no credit, signs nothing and closes nothing.
  'ticketUsage', 'ticketReserve', 'ticketStepStart', 'ticketStepComplete', 'planProgress', 'ticketContinuation',
  'autoCandidates', 'autoCandidateFacts',
  // ── Stage 4c: the scheduler/maintenance half the automatic pass actually consumes ────────────────
  // Opened only now, because only now is there a caller: the Hermes pass advances the SAME persistent
  // fair cursor the registration feed uses, releases the attempts a dead process left behind, and
  // runs the ONE natural-expiry maintenance transaction. Each is the existing core entry point with
  // its own explicit projection; none of them signs a ticket or calls a model, and none is reachable
  // from a settings/status read.
  'autoConsiderAdvance', 'recoverAutoPlans', 'maintainLearning',
  // The bounded EVIDENCE TRIAL for ordinary experience: the trusted host grants it from real
  // host-observed failures, so a candidate with no official pack and no registered checker can at
  // least be OFFERED once and earn real evidence. It validates nothing and spends nothing.
  'grantEvidenceTrial', 'recordPackageJsonArtifact', 'taskEvidenceStatus', 'taskEvidenceReplayCases'])
/**
 * Minimal, EXPLICIT projections for the operations this stage newly exposes.
 *
 * Every operation NOT named here keeps its released behaviour exactly: its `input` document is
 * passed to `engine[op]` verbatim, which is what the published CLI contract promises and what
 * every existing caller already relies on (`record`, `list`, `history`, `evaluate`, `migrate`,
 * `settlementEnqueue`, the settlement controls, and every other pre-4a entry point). This table is
 * NOT a global input sanitiser: turning it into one silently emptied documents that legitimately
 * carry fields this file does not know about (`record` loses `source`/`kind` and refuses), which is
 * a behavioural change to released operations and is not this stage's business.
 *
 * For the operations it does name, the projection is the point: a field invented for one entry
 * point cannot be smuggled into another, and an unknown or oversized field never reaches the core
 * through a newly opened door.
 */
const projections = new Map([
  ['observeProblem', ['sessionId', 'turnId', 'projectKey', 'environmentId', 'eventId', 'kind', 'source',
    'toolName', 'failureCode', 'taskClass', 'summary', 'route']],
  ['problemStatus', ['projectKey', 'limit']],
  ['problemRecoveryPlan', ['problemId', 'projectKey', 'environmentId', 'ticket', 'evidenceRevision']],
  ['problemDefer', ['problemId', 'evidenceRevision', 'code', 'waitMs']],
  ['recentAdoptions', ['projectKey', 'environmentId']],
  ['reflectionPlan', ['sessionId', 'turnId', 'projectKey', 'environmentId', 'taskSummary', 'resultSummary', 'outcome']],
  ['problemDueFeed', ['limit']],
  ['problemConsiderAdvance', ['step']],
  ['recoverProblems', ['limit']],
  ['sourcePublish', ['sessionId', 'projectKey', 'environmentId', 'provider', 'model', 'apiMode', 'baseUrl',
    'reasoningState', 'reasoningValue', 'driver', 'expectRevision', 'expectEpoch', 'relatedSessionIds']],
  ['sourceRelease', ['sessionId', 'expectRevision', 'expectBindingHash', 'reason']],
  ['sourceStatus', ['limit']],
  // `reflectionRequest` is a RELEASED operation: it keeps its verbatim document for the explicit
  // legacy path, and the binding rule below is the only new thing it must satisfy.
  ['reflectionCancel', ['ticket', 'usage']],
  // `reflectionResult` is a RELEASED operation, so its document stays verbatim; the arithmetic of
  // what `usage` may contain is the core's `normalizedUsage`, not a second copy here.
  //
  // Stage 4c. Each of these is a NEW operation name, so the projection is the whole contract: a
  // field invented for one entry point cannot be smuggled into another, and an unknown or oversized
  // field never reaches the core through a newly opened door.
  ['reviewPlan', ['lessonId', 'projectKey', 'environmentId', 'maxTokens']],
  ['reviewMaterial', ['lessonId', 'projectKey', 'environmentId', 'packId', 'packVersion', 'caseId',
    'scenarioHash', 'criteriaHash', 'criteria', 'ticket']],
  // The per-pass judge request: the ticket names the frozen scenario/criteria, the two answers are
  // the arms' raw text, and the LABELS come back from the core — the caller never chooses the order.
  ['reviewJudge', ['ticket', 'armA', 'armB', 'pass']],
  // The objective track's execution material, one frozen case at a time through the caller's cursor.
  ['objectiveMaterial', ['ticket', 'cursor']],
  // `steps` and `inputChars` are the caller's WHOLE-PLAN claim: how many physical steps it will run and
  // the largest host-visible input any one of them sends. The core checks the claim against the
  // reservation and refuses an unbounded or under-reserved plan (`usage_unprovable`,
  // `reservation_insufficient`) instead of letting the daily cap be passed mid-run.
  ['reviewRequest', ['lessonId', 'expectedVersion', 'projectKey', 'environmentId', 'maxTokens', 'planHash',
    'queueKey', 'packId', 'packVersion', 'caseId', 'scenarioHash', 'criteriaHash', 'criteria', 'stepwiseBudget',
    'shortAnswersAllowed', 'sourceBinding', 'sessionId', 'sourceRevision', 'sourceBindingHash',
    'controlGeneration', 'steps', 'inputChars', 'stepOutputTokens']],
  ['reviewResult', ['ticket', 'lessonId', 'projectKey', 'environmentId', 'planHash', 'packId', 'packVersion',
    'scenarioHash', 'criteriaHash', 'criteria', 'first', 'second', 'truncated', 'costKnown', 'answers',
    'swapped', 'structuredPassed', 'shortAnswersAllowed', 'judge', 'source', 'spent', 'usage',
    'sourceBinding']],
  ['evaluationPlan', ['lessonId', 'projectKey', 'environmentId', 'maxTokens', 'expectedVersion']],
  // The objective track's RESULT entry for the automatic path. It is the same core commit as
  // `evaluate`, reached under a name that is ONLY the bound path: the basis, the pack, the plan, the
  // manifest and the source identity all come from the ticket, so the caller carries answers and a
  // ticket and nothing else that could re-point the comparison.
  ['objectiveResult', ['ticket', 'lessonId', 'projectKey', 'environmentId', 'expectedVersion', 'eventId',
    'answers', 'usage', 'policy', 'spent', 'ticketUsage', 'sourceBinding', 'taskReplayResults']],
  // The objective REQUEST carries the same whole-plan claim (`cases × 2 arms`, plus the largest input
  // any one step sends), so a plan that cannot be bounded waits instead of overspending.
  ['evaluationRequest', ['lessonId', 'expectedVersion', 'projectKey', 'environmentId', 'maxTokens',
    'planHash', 'queueKey', 'packId', 'packVersion', 'suiteId', 'cases', 'inputChars', 'stepOutputTokens', 'stepwiseBudget', 'sourceBinding',
    'sessionId', 'sourceRevision', 'sourceBindingHash', 'controlGeneration', 'taskReplayCases']],
  // The cold-start discovery read: a host names the candidate, its scope and the source turn, and the
  // core answers with the pack it admits the lesson to, the bounded case references, the case this
  // proposal uses, and the registration document plus identity it would carry.
  ['autoPlanProposal', ['lessonId', 'version', 'environment', 'projectKey', 'environmentId', 'track',
    'source', 'caseId', 'criteria', 'sourceBinding']],
  ['autoPlanRegister', ['lessonId', 'version', 'environment', 'track', 'source', 'suite', 'caseId',
    'criteria', 'sourceBinding', 'requestHashes']],
  ['autoPlanIdentity', ['lessonId', 'version', 'environment', 'track', 'source', 'suite', 'caseId',
    'criteria', 'sourceBinding', 'requestHashes']],
  ['autoPlanUpdate', ['queueKey', 'planHash', 'stage', 'evidence', 'ticket', 'reason', 'attempts',
    'nextAttemptAt']],
  ['ticketUsage', ['ticket', 'spent', 'usage']],
  ['ticketReserve', ['ticket', 'stepKey', 'requestHash', 'inputTokens', 'outputTokens']],
  ['ticketStepStart', ['ticket', 'stepKey', 'requestHash']],
  ['ticketStepComplete', ['ticket', 'stepKey', 'requestHash', 'text', 'truncated', 'tokens']],
  ['planProgress', ['ticket', 'stepKey']],
  ['ticketContinuation', ['ticket', 'kind']],
  ['autoPlans', []],
  ['autoCandidates', ['limit']],
  ['autoCandidateFacts', ['lessonId', 'version', 'environment', 'track', 'source', 'suite', 'criteria']],
  // The fair-cursor advance takes ONLY the bounded step it is asked for: the caller cannot name a
  // cursor value, only how far the persistent rotation record moves (0 reads it without moving).
  // The fair-cursor advance takes the bounded step AND the due-plan window's own movement, both as
  // counts the caller really observed; a caller cannot name a cursor value or a plan.
  ['autoConsiderAdvance', ['step', 'due', 'dueCount']],
  // Recovery takes no arguments at all in the core; the projection is empty on purpose, so a caller
  // cannot aim it at one plan or one ticket it names.
  ['recoverAutoPlans', []],
  ['maintainLearning', ['limit']],
  // The licence is granted from the lesson's OWN identity and the evidence already bound to it: the
  // caller cannot state a reason, an evidence revision, a status or a note.
  ['grantEvidenceTrial', ['lessonId', 'expectedVersion', 'projectKey', 'environmentId']],
  ['recordPackageJsonArtifact', ['adapterId', 'content', 'environmentId', 'eventId', 'fileHash', 'filename',
    'lessonId', 'lessonVersion', 'model', 'projectKey', 'provider', 'reasoningEffort', 'sessionId', 'toolchain', 'turnId']],
  ['taskEvidenceStatus', []],
  ['taskEvidenceReplayCases', ['projectKey', 'environmentId', 'limit', 'ids', 'ticket']],
])
const HEX64 = /^[a-f0-9]{64}$/u
const isPlainObject = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
/**
 * Transport names that are the AUTOMATIC path's own name for an existing core method.
 *
 * `objectiveResult` and `evaluate` are the same commit by design: the difference is the contract at
 * this boundary, not a second implementation. The released `evaluate` keeps its verbatim document
 * (its trusted, ticket-less runner path), while the automatic one is refused unless it carries the
 * ticket and the binding marker below.
 */
const aliases = new Map([['objectiveResult', 'evaluate']])
/** An error the transport reports with its own protocol code instead of the generic fallback. */
const refuse = code => {
  const error = new Error(code)
  error.code = code
  return error
}
/**
 * One reflection requested FOR A PROBLEM is bound or it is refused — never quietly generic.
 *
 * `reflectionRequest` accepts an optional `problemId`/`evidenceRevision` pair, and its own body
 * treats a missing or malformed id as "no binding". That is exactly right for the released explicit
 * path, but wrong for an automatic host path: a truncated id would silently mint a candidate that
 * never crossed the independent-evidence gate. The marker is the PRESENCE of either field, so this
 * strictness cannot change what a caller that never sends them does. A pair that is present is
 * either fully valid or the whole call is refused as `invalid_problem_binding`, and nothing is
 * read, written or charged.
 */
const boundReflection = input => {
  const hasId = Object.hasOwn(input, 'problemId')
  const hasRevision = Object.hasOwn(input, 'evidenceRevision')
  if (!hasId && !hasRevision) return true
  return hasId && hasRevision && typeof input.problemId === 'string' && HEX64.test(input.problemId)
    && Number.isSafeInteger(input.evidenceRevision) && input.evidenceRevision >= 0
}
/**
 * The AUTOMATIC reflection path's final-permission request, bound or refused — never partially
 * gated.
 *
 * The core itself enforces the whole gate inside its write transaction, so this is the transport's
 * own shape check and not a second policy: it exists so a caller cannot ask for the gate and then
 * send half of the binding, and so a caller cannot state a control generation without asking for the
 * gate it belongs to. A request that carries none of these fields is the RELEASED explicit path and
 * is passed through exactly as before.
 */
const guardedReflection = input => {
  const hasBinding = Object.hasOwn(input, 'sourceBinding')
  const hasRevision = Object.hasOwn(input, 'sourceRevision')
  const hasHash = Object.hasOwn(input, 'sourceBindingHash')
  const hasGeneration = Object.hasOwn(input, 'controlGeneration')
  if (!hasBinding && !hasRevision && !hasHash && !hasGeneration) return true
  if (!hasBinding || input.sourceBinding !== true) return false
  if (hasRevision !== hasHash) return false
  if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 1) return false
  if (typeof input.sourceBindingHash !== 'string' || !HEX64.test(input.sourceBindingHash)) return false
  if (hasGeneration && (!Number.isSafeInteger(input.controlGeneration) || input.controlGeneration < 0)) return false
  return true
}
/**
 * The AUTOMATIC paid path's SOURCE-BOUND request, bound or refused — never partially gated.
 *
 * `sourceBinding: true` is REQUIRED, not optional: on this transport the two paid tracks are the
 * automatic path, and a request that omits the marker would otherwise be executed as the released
 * legacy shape instead of being refused. The whole binding travels together — the session, the exact
 * revision and the binding hash the caller read, and (optionally) the control generation it signs
 * under — and the core re-reads all of it inside the write transaction. This is the transport's own
 * shape check, never a second policy.
 */
const guardedBound = input => {
  if (input.sourceBinding !== true) return false
  if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) return false
  if (!Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 1) return false
  if (typeof input.sourceBindingHash !== 'string' || !HEX64.test(input.sourceBindingHash)) return false
  if (Object.hasOwn(input, 'controlGeneration')
    && (!Number.isSafeInteger(input.controlGeneration) || input.controlGeneration < 0)) return false
  return true
}
/**
 * The AUTOMATIC paid path's RESULT, bound or refused.
 *
 * The ticket is the whole authorisation — the binding, the plan, the pack and the source identity are
 * re-read from it — so this check is deliberately small: a named ticket and the marker that says
 * which path this is. A caller cannot reach the automatic result entry with a ticket-less document.
 */
/**
 * The step-wise cost report, shaped at the boundary: a named ticket and at least one of the two
 * measurement fields. It is deliberately usable on EITHER track (the ticket names the attempt), and
 * it can never carry enough to authorise anything — the core only merges the numbers.
 */
const guardedUsage = input => typeof input.ticket === 'string' && input.ticket.length > 0
  && input.ticket.length <= 64
  && (Object.hasOwn(input, 'spent') || Object.hasOwn(input, 'usage'))
  && (input.spent === undefined || (Number.isSafeInteger(input.spent) && input.spent >= 0))
const guardedBoundResult = input => input.sourceBinding === true && typeof input.ticket === 'string'
  && input.ticket.length > 0 && input.ticket.length <= 64
/**
 * The RELEASED objective request (`evaluationRequest`) carries an OPTIONAL binding.
 *
 * Its legacy document — a caller-stated case list for the trusted runner — must keep working exactly
 * as it always has, so a document that mentions none of the gate's fields is passed through. A
 * document that mentions ANY of them is the automatic path and must be a whole binding: the marker,
 * the session, the exact revision and the binding hash. Half of one is refused rather than executed
 * as the released shape, which is what stops a truncated automatic request from silently becoming a
 * ticket-less legacy evaluation.
 */
const guardedPartialBinding = input => {
  const names = ['sourceBinding', 'sourceRevision', 'sourceBindingHash', 'controlGeneration']
  if (!names.some(name => Object.hasOwn(input, name))) return true
  return guardedBound(input)
}
if (process.argv.includes('--help')) {  process.stdout.write('MSE trusted-host JSON CLI\nSend one JSON object on stdin: {"config":{"stateRoot":"/absolute/private/state","adapterId":"generic"},"op":"status","input":{}}\nOperations: '
    + [...operations].join(', ') + '\nDo not expose evidence, migration or evaluation operations directly as model tools.\n')
  process.exit(0)
}
let input = ''
try {
  process.stdin.setEncoding('utf8')
  for await (const part of process.stdin) {
    input += part
    // Unchanged 65,536-byte request budget: the newly opened entry points are small by contract,
    // so widening the transport for them would only widen what every other operation can send.
    if (Buffer.byteLength(input) > 65_536) throw refuse('input_too_large')
  }
  const request = JSON.parse(input)
  if (!operations.has(request.op)) throw refuse('invalid_operation')
  const raw = isPlainObject(request.input) ? request.input : {}
  const projection = projections.get(request.op)
  const value = projection === undefined ? raw
    : projection.reduce((picked, name) => {
      if (Object.hasOwn(raw, name)) picked[name] = raw[name]
      return picked
    }, {})
  if (request.op === 'reflectionRequest' && (!boundReflection(value) || !guardedReflection(value))) {
    throw refuse('invalid_problem_binding')
  }
  if (request.op === 'reviewRequest' && !guardedBound(value)) {
    throw refuse('invalid_source_binding')
  }
  if (request.op === 'evaluationRequest' && !guardedPartialBinding(value)) {
    throw refuse('invalid_source_binding')
  }
  if ((request.op === 'reviewResult' || request.op === 'objectiveResult') && !guardedBoundResult(value)) {
    throw refuse('invalid_source_binding')
  }
  if (request.op === 'ticketUsage' && !guardedUsage(value)) throw refuse('invalid_usage')
  const engine = new LearningEngine(request.config)
  const method = aliases.get(request.op) ?? request.op
  const result = request.op === 'recordPackageJsonArtifact'
    ? engine.recordPackageJsonArtifact(createTaskEvidenceAuthority(engine), value)
    : engine[method](value)
  // Hermes uses this read only to recover the frozen source identity for an existing ticket. The
  // core result also contains a full lesson and replay fixtures; returning those here is redundant
  // and can exceed the bridge's unchanged 8 KiB protocol cap. Keep the driver's complete contract
  // while bounding this transport projection to the one identity it consumes.
  const output = request.op === 'ticketContinuation' && result?.ok === true
    ? { ok: true, job: { source: result.job?.source ?? null } }
    : result
  process.stdout.write(JSON.stringify(output) + '\n')
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? 'invalid_request' }) + '\n')
  process.exitCode = 1
}
