// Stage 4c — the two PAID tracks behind ONE frozen identity: review and objective.
//
// These cases drive the REAL core (`src/index.mjs`) on a temporary state root, through the same
// transactions, plan registry, source ledger and control records the adapters use. Nothing here is a
// re-implementation: a case that passes because the test computed its own answer would prove nothing,
// so every assertion reads state the engine itself wrote.
//
// The properties under test are the ones neither the Node adapter nor the Hermes driver can supply on
// its own:
//   1. a BOUND paid attempt freezes its plan, its OFFICIAL pack and its published source identity in
//      the SAME transaction that signs the ticket, and the result re-reads exactly those facts —
//      never a caller's `allowed`, and never a value the caller states at submission time;
//   2. a pause, an exact stop, a source drift, a plan re-registration or a rotated registry refuses
//      the commit, and the run's KNOWN cost stays on the ticket's own spend row;
//   3. the objective track cannot be promoted through a review ticket, and a review cannot borrow an
//      objective verdict;
//   4. the LEGACY DSH contract is byte-compatible: a registration with no binding hashes exactly what
//      it always hashed, and the released `evaluate`/`evaluationRequest` documents still work.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LearningEngine } from '../src/index.mjs'
import { getDomainPack, packCaseCriteriaHash, packCases, packScenarioHash, packSuiteId } from '../src/domains.mjs'
import { planHash } from '../src/review.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PACK_ID = 'mse-lifecycle-v1'
const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-flash'
const EFFORT = 'max'
const SESSION = 'stage4c-source-session'
// In-domain for the official pack: an artefact of the lifecycle (请求/代次/结果/锁) acted on by a
// mechanism (记录/丢弃/迟到/提交), which is exactly what the pack's predicate asks for.
const INSTRUCTION = '处理请求时先记录代次，再把迟到结果按代次丢弃'
const hash64 = value => createHash('sha256').update(value, 'utf8').digest('hex')

function fixture({ tokens = 40_000, calls = 8 } = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse4c-dual-'))
  let now = Date.UTC(2030, 0, 1)
  const engine = new LearningEngine({ stateRoot, adapterId: 'hermes', maxContextBytes: 768, now: () => now,
    evaluationTokensPerDay: tokens, evaluationCallsPerDay: calls })
  const projectKey = '/synthetic/stage4c'
  return { stateRoot, engine, projectKey, now: () => now, advance: ms => { now += ms },
    document: () => JSON.parse(readFileSync(join(stateRoot, 'lessons-v1.json'), 'utf8')),
    cleanup: () => rmSync(stateRoot, { recursive: true, force: true }) }
}

/** One in-domain method candidate, in the shape both tracks consume. */
function candidate(f) {
  const created = f.engine.record({ projectKey: f.projectKey, source: 'host_proposal', kind: 'method',
    eventId: `method-${hash64(String(Math.random())).slice(0, 12)}`, instruction: INSTRUCTION })
  return f.engine.list({ projectKey: f.projectKey, limit: 10 }).lessons.find(row => row.id === created.id)
}

/** Publish the session's source identity and return the row the core really wrote. */
function publish(f, sessionId = SESSION, overrides = {}) {
  const result = f.engine.sourcePublish({ sessionId, projectKey: f.projectKey, provider: PROVIDER, model: MODEL,
    apiMode: 'chat_completions', baseUrl: `https://stage4c.invalid/${sessionId}/v1`,
    reasoningState: 'explicit', reasoningValue: EFFORT, driver: 'async_openai_chat', ...overrides })
  assert.equal(result.published, true, JSON.stringify(result))
  return result
}

const sourceRow = (f, sessionId = SESSION) => {
  const ownerHash = f.engine.sourceStatus({ limit: 8 }).rows.find(row =>
    row.sessionHash === hash64(sessionId))
  return ownerHash
}

const criteriaOf = caseId => packCases(PACK_ID).find(row => row.caseId === caseId).criteria

/**
 * ONE fresh paid attempt: new evidence, the plan that freezes it, and its ticket.
 *
 * The evidence is genuinely new each time (a republished identity for the same session, which is how
 * a host states "this happened again"), because the core consumes the attempt at SIGNING time: the
 * same plan and the same revision are refused afterwards (`evidence_already_attempted`) — exactly what
 * makes a lost IPC answer or a crash unable to pay for the same evidence twice.
 */
function freshAttempt(f, lesson, caseId, label, requestOverrides = {}) {
  const bound = f.engine.sourcePublish({ sessionId: SESSION, projectKey: f.projectKey, provider: PROVIDER,
    model: MODEL, apiMode: 'chat_completions', baseUrl: `https://stage4c.invalid/${SESSION}/${label}/v1`,
    reasoningState: 'explicit', reasoningValue: EFFORT, driver: 'async_openai_chat' })
  assert.equal(bound.published, true, JSON.stringify(bound))
  const plan = reviewPlan(f, lesson, caseId, bound)
  const ticket = reviewRequest(f, lesson, plan, caseId, bound, requestOverrides)
  assert.equal(typeof ticket.ticket, 'string', JSON.stringify(ticket))
  return { ticket, plan, bound }
}

/** A live review plan whose execution identity freezes the published source revision. */
function reviewPlan(f, lesson, caseId, bound) {
  const result = f.engine.autoPlanRegister({ lessonId: lesson.id, version: lesson.version, environment: 'default',
    track: 'review', source: { kind: 'turn', sessionId: SESSION, turnId: '3', projectKey: f.projectKey,
      route: { provider: PROVIDER, model: MODEL, reasoningEffort: EFFORT } },
    suite: { packId: PACK_ID, version: 1 }, criteria: criteriaOf(caseId),
    sourceBinding: { revision: bound.revision, bindingHash: bound.bindingHash } })
  return { ...result, row: result.plan }
}

/** A live objective plan whose execution identity freezes the published source revision. */
function objectivePlan(f, lesson, bound) {
  const result = f.engine.autoPlanRegister({ lessonId: lesson.id, version: lesson.version, environment: 'default',
    track: 'objective', source: { kind: 'turn', sessionId: SESSION, turnId: '3', projectKey: f.projectKey,
      route: { provider: PROVIDER, model: MODEL, reasoningEffort: EFFORT } },
    suite: { packId: PACK_ID, version: 1 }, criteria: criteriaOf(packCases(PACK_ID)[0].caseId),
    sourceBinding: { revision: bound.revision, bindingHash: bound.bindingHash } })
  return { ...result, row: result.plan }
}

/** The automatic review request, exactly as the driver would send it. */
function reviewRequest(f, lesson, plan, caseId, bound, overrides = {}) {
  return f.engine.reviewRequest({ lessonId: lesson.id, expectedVersion: lesson.version,
    projectKey: f.projectKey, maxTokens: 4_000, stepwiseBudget: true, steps: 1, inputChars: 1, stepOutputTokens: 1, planHash: plan.row.planHash, queueKey: plan.row.queueKey,
    packId: PACK_ID, caseId, scenarioHash: packScenarioHash(PACK_ID, caseId),
    criteriaHash: packCaseCriteriaHash(PACK_ID, caseId), criteria: criteriaOf(caseId),
    sourceBinding: true, sessionId: SESSION, sourceRevision: bound.revision,
    sourceBindingHash: bound.bindingHash, controlGeneration: f.engine.controlGeneration(), ...overrides })
}

/** A blind review verdict that really passes the two swapped judge passes. */
const passingVerdict = () => ({ first: '{"winner":"A"}', second: '{"winner":"B"}', swapped: true,
  answers: { candidate: '先记录代次，迟到结果按代次丢弃，并在提交前再次核对当前代次与许可。',
    baseline: '直接处理即可，不需要额外记录任何东西，也不用记代次或许可。' },
  structuredPassed: true, costKnown: true, usage: { known: true, tokens: 1_200 }, spent: 1_200 })

/** The answer the pack's own checker accepts, without ever asking the model anything. */
function correctAnswer(testCase) {
  const expected = testCase.checker.expected
  if (testCase.checker.kind === 'json-deep-equal-v1') return JSON.stringify(expected)
  if (testCase.checker.kind === 'lines-present-v1') return expected.join('\n')
  return String(expected)
}

/** A baseline that passes the output guard and still fails the checker: no forbidden token, non-empty. */
const BASELINE_ANSWER = '未判断'

test('a bound review freezes the plan, the official pack and the source, then starts only an unproven trial', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const caseId = packCases(PACK_ID)[0].caseId
  const bound = publish(f, SESSION)
  const plan = reviewPlan(f, lesson, caseId, bound)
  assert.equal(plan.ok, true, JSON.stringify(plan))
  // The material a host needs to RUN the case is readable, and the expected values stay in the core.
  const material = f.engine.reviewMaterial({ lessonId: lesson.id, projectKey: f.projectKey, packId: PACK_ID,
    caseId })
  assert.equal(material.ok, true)
  assert.equal(typeof material.scenario.prompt, 'string')
  // The bounded per-step sizes come from the code that enforces them, not from a host's own guess.
  assert.equal(material.limits.armChars, 4000)
  assert.equal(material.limits.verdictBytes, 8192)
  const exposed = JSON.stringify(material)
  for (const leak of ['expected', 'forbidden', 'checker']) {
    assert.equal(exposed.includes(leak), false, `the material must not carry ${leak}`)
  }
  // The PLAN resolved its official case ONCE, where it was registered: a host can read it from the
  // plan instead of hardcoding a case id, and the request may then omit the case entirely.
  const stored = f.engine.autoPlans()[0]
  assert.equal(stored.caseId, caseId)
  assert.equal(stored.packId, PACK_ID)
  assert.equal(stored.scenarioHash, packScenarioHash(PACK_ID, caseId))
  const implicit = reviewRequest(f, lesson, plan, caseId, bound, { caseId: undefined,
    scenarioHash: undefined, criteriaHash: undefined })
  const request = implicit
  assert.equal(typeof request.ticket, 'string', JSON.stringify(request))
  assert.equal(request.caseId, caseId, "the ticket froze the plan own official case")
  assert.equal(request.source.sessionHash, hash64(SESSION))
  assert.equal(request.source.revision, bound.revision)
  // ...and the row is really held for as long as the ticket can still commit.
  assert.equal(sourceRow(f, SESSION).held, true, 'a live ticket holds its source row')
  assert.equal(sourceRow(f, SESSION).pinned, true)
  const result = f.engine.reviewResult({ ticket: request.ticket, lessonId: lesson.id,
    projectKey: f.projectKey, planHash: plan.row.planHash, packId: PACK_ID, caseId,
    scenarioHash: packScenarioHash(PACK_ID, caseId), criteriaHash: packCaseCriteriaHash(PACK_ID, caseId),
    criteria: criteriaOf(caseId), ...passingVerdict() })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.state, 'reviewed')
  assert.equal(result.trial, 'trial')
  const row = f.engine.list({ projectKey: f.projectKey, limit: 5 }).lessons.find(x => x.id === lesson.id)
  assert.notEqual(row.status, 'validated', 'a model review never validates')
  assert.equal(f.engine.sourceStatus({ limit: 8 }).rows[0].held, false, 'the hold is released with the ticket')
})

test('the request transaction refuses what cannot be dispatched, before any reservation', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const caseId = packCases(PACK_ID)[0].caseId
  const bound = publish(f, SESSION)
  const plan = reviewPlan(f, lesson, caseId, bound)

  // An unregistered pack is refused, never executed as a pack-less manual review.
  assert.throws(() => reviewRequest(f, lesson, plan, caseId, bound, { packId: 'not-a-registered-pack' }),
    error => error.code === 'domain_pack_required')
  // A plan that is not the one named is refused.
  const wrongPlan = reviewRequest(f, lesson, plan, caseId, bound, { planHash: hash64('another-plan') })
  assert.equal(wrongPlan.skipped, 'auto_plan_stale', JSON.stringify(wrongPlan))
  // A revision the caller read somewhere else is refused against the live row.
  const wrongRevision = reviewRequest(f, lesson, plan, caseId, bound, { sourceRevision: bound.revision + 1 })
  assert.equal(wrongRevision.skipped, 'source_stale_revision', JSON.stringify(wrongRevision))
  // A session that is not the one the PLAN runs on is refused by the plan binding...
  const otherSession = reviewRequest(f, lesson, plan, caseId, bound, { sessionId: 'never-published' })
  assert.equal(otherSession.skipped, 'source_session_mismatch', JSON.stringify(otherSession))
  // ...and a session whose published row is really GONE is a WAIT, not a licence.
  const released = f.engine.sourceRelease({ sessionId: SESSION, expectRevision: bound.revision,
    expectBindingHash: bound.bindingHash, reason: 'operator_release' })
  assert.equal(released.ok, true, JSON.stringify(released))
  const unknown = reviewRequest(f, lesson, plan, caseId, { revision: bound.revision,
    bindingHash: bound.bindingHash })
  assert.equal(unknown.skipped, 'source_unknown', JSON.stringify(unknown))
  // ...and none of those signed, reserved or spent anything.
  const state = f.document()
  assert.equal(state.jobs.length, 0, 'no ticket survived a refused request')
  assert.equal(state.spends.length, 0, 'a refused request reserves nothing')
  assert.deepEqual(state.experiments, [], 'nothing was judged')
})

test('a pause, an exact stop and a source drift each refuse the commit and keep the known cost', t => {
  const cases = [
    { label: 'pause', mutate: f => { f.engine.settlementPause({ paused: true }); f.engine.settlementPause({ paused: false }) },
      code: 'control_changed' },
    { label: 'exact stop', mutate: f => { f.engine.settlementStop({ sessionId: SESSION, reason: 'operator_stop' }) },
      code: 'control_source_stopped' },
    { label: 'source drift', mutate: (f, bound) => publish(f, SESSION, { model: 'deepseek-other' }),
      code: 'source_changed' },
  ]
  for (const scenario of cases) {
    const f = fixture()
    try {
      const lesson = candidate(f)
      const caseId = packCases(PACK_ID)[0].caseId
      const bound = publish(f, SESSION)
      const plan = reviewPlan(f, lesson, caseId, bound)
      const request = reviewRequest(f, lesson, plan, caseId, bound)
      assert.equal(typeof request.ticket, 'string', scenario.label)
      scenario.mutate(f, bound)
      const late = f.engine.reviewResult({ ticket: request.ticket, lessonId: lesson.id, projectKey: f.projectKey,
        planHash: plan.row.planHash, criteria: criteriaOf(caseId), ...passingVerdict(), spent: 1_500 })
      assert.equal(late.ok, false, scenario.label)
      assert.equal(late.code, scenario.code, `${scenario.label}: ${JSON.stringify(late)}`)
      const row = f.engine.list({ projectKey: f.projectKey, limit: 5 }).lessons.find(x => x.id === lesson.id)
      assert.equal(row.trial ?? null, null, `${scenario.label}: no trial`)
      assert.notEqual(row.status, 'validated', scenario.label)
      // THE COST IS NOT UNDONE BY THE OUTCOME: the reservation stands, the late measurement is
      // absorbed into the ticket's own row, and the row says why the ticket ended.
      const spend = f.document().spends.find(x => x.ticket === request.ticket)
      assert.equal(spend.tokens, 4_000, `${scenario.label}: the reservation is the floor`)
      assert.equal(spend.terminal, scenario.code, `${scenario.label}: the terminal reason is recorded`)
      assert.equal(f.document().jobs.length, 0, `${scenario.label}: the ticket is closed, not left open`)
    } finally { f.cleanup() }
  }
})

test('a re-registered plan invalidates the ticket it no longer describes (two transactions)', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const caseId = packCases(PACK_ID)[0].caseId
  const bound = publish(f, SESSION)
  const plan = reviewPlan(f, lesson, caseId, bound)
  const request = reviewRequest(f, lesson, plan, caseId, bound)
  // The same queue entry is re-pointed at a NEW route while the answer is in flight.
  const moved = f.engine.autoPlanRegister({ lessonId: lesson.id, version: lesson.version,
    environment: 'default', track: 'review', source: { kind: 'turn', sessionId: SESSION, turnId: '3',
      projectKey: f.projectKey, route: { provider: PROVIDER, model: MODEL, reasoningEffort: 'high' } },
    suite: { packId: PACK_ID, version: 1 }, criteria: criteriaOf(caseId),
    sourceBinding: { revision: bound.revision, bindingHash: bound.bindingHash } })
  assert.equal(moved.ok, true, JSON.stringify(moved))
  assert.equal(moved.duplicate, false, 'a new execution identity is a new plan')
  assert.equal(moved.plan.queueKey, plan.row.queueKey, 'the same work, a different execution')
  const late = f.engine.reviewResult({ ticket: request.ticket, lessonId: lesson.id, projectKey: f.projectKey,
    planHash: plan.row.planHash, criteria: criteriaOf(caseId), ...passingVerdict() })
  assert.equal(late.ok, false)
  assert.equal(late.code, 'review_plan_stale', JSON.stringify(late))
  assert.equal(f.engine.list({ projectKey: f.projectKey, limit: 5 }).lessons[0].trial ?? null, null)
})

test('the objective track commits on the pack the TICKET froze, and only there', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const bound = publish(f, SESSION)
  const plan = objectivePlan(f, lesson, bound)
  assert.equal(plan.ok, true, JSON.stringify(plan))
  const request = f.engine.evaluationRequest({ lessonId: lesson.id, expectedVersion: lesson.version,
    projectKey: f.projectKey, maxTokens: 6_000, stepwiseBudget: true, steps: 1, inputChars: 1, stepOutputTokens: 1, planHash: plan.row.planHash, queueKey: plan.row.queueKey,
    packId: PACK_ID, sourceBinding: true, sessionId: SESSION, sourceRevision: bound.revision,
    sourceBindingHash: bound.bindingHash, controlGeneration: f.engine.controlGeneration() })
  assert.equal(typeof request.ticket, 'string', JSON.stringify(request))
  assert.equal(request.suiteId, packSuiteId(getDomainPack(PACK_ID)))
  const answers = Object.fromEntries(packCases(PACK_ID).map(testCase =>
    [testCase.caseId, { candidate: correctAnswer(testCase), baseline: BASELINE_ANSWER }]))
  const usage = Object.fromEntries(packCases(PACK_ID).map(testCase =>
    [testCase.caseId, { baseline: 100, candidate: 120 }]))
  const committed = f.engine.evaluate({ ticket: request.ticket, lessonId: lesson.id, projectKey: f.projectKey,
    expectedVersion: lesson.version, answers, usage, sourceBinding: true })
  assert.equal(committed.ok, true, JSON.stringify(committed))
  assert.equal(committed.decision, 'accepted', JSON.stringify(committed))
  const row = f.engine.list({ projectKey: f.projectKey, limit: 5 }).lessons.find(x => x.id === lesson.id)
  assert.equal(row.status, 'validated')
  assert.equal(row.validation.domain.packId, PACK_ID)
  // The ticket is over: a repeated submission is answered from its own row, with no second charge.
  const before = f.document().spends.filter(x => x.kind === 'evaluation').length
  const again = f.engine.evaluate({ ticket: request.ticket, lessonId: lesson.id, projectKey: f.projectKey,
    expectedVersion: lesson.version, answers, usage, sourceBinding: true, spent: 9_999 })
  assert.equal(again.ok, false)
  assert.equal(again.code, 'evaluation_accepted', JSON.stringify(again))
  assert.equal(f.document().spends.filter(x => x.kind === 'evaluation').length, before,
    'a repeated submission never signs a second attempt')
})

test('an objective ticket cannot be promoted through a review, or a review through an objective', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const caseId = packCases(PACK_ID)[0].caseId
  const bound = publish(f, SESSION)
  // ── a live REVIEW ticket, offered to the objective track ────────────────────────────────────────
  const review = reviewPlan(f, lesson, caseId, bound)
  const reviewTicket = reviewRequest(f, lesson, review, caseId, bound)
  assert.equal(typeof reviewTicket.ticket, 'string')
  assert.throws(() => f.engine.evaluate({ ticket: reviewTicket.ticket, lessonId: lesson.id,
    projectKey: f.projectKey, expectedVersion: lesson.version, basis: 'host_trial', trials: [],
    suiteId: 'legacy-suite', eventId: 'crossed-track' }), error => error.code === 'evaluation_ticket_rejected')
  // The refusal is not a consumption: the review ticket is still usable for its OWN track.
  const own = f.engine.reviewResult({ ticket: reviewTicket.ticket, lessonId: lesson.id, projectKey: f.projectKey,
    planHash: review.row.planHash, criteria: criteriaOf(caseId), ...passingVerdict() })
  assert.equal(own.ok, true, JSON.stringify(own))
  // ── and the other direction: a live OBJECTIVE ticket offered to the review track ────────────────
  const objective = objectivePlan(f, lesson, bound)
  const objectiveTicket = f.engine.evaluationRequest({ lessonId: lesson.id, expectedVersion: lesson.version,
    projectKey: f.projectKey, maxTokens: 6_000, stepwiseBudget: true, steps: 1, inputChars: 1, stepOutputTokens: 1, planHash: objective.row.planHash,
    queueKey: objective.row.queueKey, packId: PACK_ID, sourceBinding: true, sessionId: SESSION,
    sourceRevision: bound.revision, sourceBindingHash: bound.bindingHash })
  assert.equal(typeof objectiveTicket.ticket, 'string')
  assert.throws(() => f.engine.reviewResult({ ticket: objectiveTicket.ticket, lessonId: lesson.id,
    projectKey: f.projectKey, criteria: criteriaOf(caseId), ...passingVerdict() }),
  error => error.code === 'review_ticket_rejected')
  // ...which still commits on its own track.
  const answers = Object.fromEntries(packCases(PACK_ID).map(testCase =>
    [testCase.caseId, { candidate: correctAnswer(testCase), baseline: BASELINE_ANSWER }]))
  const usage = Object.fromEntries(packCases(PACK_ID).map(testCase =>
    [testCase.caseId, { baseline: 100, candidate: 120 }]))
  const committed = f.engine.evaluate({ ticket: objectiveTicket.ticket, lessonId: lesson.id,
    projectKey: f.projectKey, expectedVersion: lesson.version, answers, usage, sourceBinding: true })
  assert.equal(committed.ok, true, JSON.stringify(committed))
  assert.equal(committed.decision, 'accepted')
})

test('an expired ticket keeps its cost and answers a late measurement with the real reason', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const caseId = packCases(PACK_ID)[0].caseId
  const bound = publish(f, SESSION)
  const plan = reviewPlan(f, lesson, caseId, bound)
  const request = reviewRequest(f, lesson, plan, caseId, bound)
  assert.equal(typeof request.ticket, 'string')
  // Bound automatic tickets remain resumable across a rolling-day budget window, then expire at 48h.
  f.advance(49 * 60 * 60_000)
  const late = f.engine.reviewResult({ ticket: request.ticket, lessonId: lesson.id, projectKey: f.projectKey,
    planHash: plan.row.planHash, criteria: criteriaOf(caseId), ...passingVerdict(), spent: 7_000 })
  assert.equal(late.ok, false)
  assert.equal(late.code, 'ticket_expired', JSON.stringify(late))
  const spend = f.document().spends.find(x => x.ticket === request.ticket)
  assert.equal(spend.tokens, 7_000, 'the late measurement is absorbed, not lost')
  assert.equal(spend.terminal, 'ticket_expired')
  assert.equal(f.engine.list({ projectKey: f.projectKey, limit: 5 }).lessons[0].trial ?? null, null,
    'an expired ticket never starts a trial')
})

test('a cancelled objective ticket keeps its cost and cannot be promoted later', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const bound = publish(f, SESSION)
  const plan = objectivePlan(f, lesson, bound)
  const request = f.engine.evaluationRequest({ lessonId: lesson.id, expectedVersion: lesson.version,
    projectKey: f.projectKey, maxTokens: 6_000, stepwiseBudget: true, steps: 1, inputChars: 1, stepOutputTokens: 1, planHash: plan.row.planHash, queueKey: plan.row.queueKey,
    packId: PACK_ID, sourceBinding: true, sessionId: SESSION, sourceRevision: bound.revision,
    sourceBindingHash: bound.bindingHash })
  assert.equal(typeof request.ticket, 'string')
  const cancelled = f.engine.evaluationCancel({ ticket: request.ticket, spent: 9_000 })
  assert.equal(cancelled.ok, true)
  const spend = f.document().spends.find(x => x.ticket === request.ticket)
  assert.equal(spend.tokens, 9_000, 'a cancel absorbs the measured cost, never refunds it')
  assert.equal(spend.terminal, 'ticket_cancelled')
  const answers = Object.fromEntries(packCases(PACK_ID).map(testCase =>
    [testCase.caseId, { candidate: correctAnswer(testCase), baseline: BASELINE_ANSWER }]))
  const usage = Object.fromEntries(packCases(PACK_ID).map(testCase =>
    [testCase.caseId, { baseline: 100, candidate: 120 }]))
  const late = f.engine.evaluate({ ticket: request.ticket, lessonId: lesson.id, projectKey: f.projectKey,
    expectedVersion: lesson.version, answers, usage, sourceBinding: true })
  assert.equal(late.ok, false)
  assert.equal(late.code, 'ticket_cancelled', JSON.stringify(late))
  const row = f.engine.list({ projectKey: f.projectKey, limit: 5 }).lessons.find(x => x.id === lesson.id)
  assert.notEqual(row.status, 'validated')
})

test('a completed paid step resumes from its durable checkpoint, while an in-flight step becomes unknown', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const caseId = packCases(PACK_ID)[0].caseId
  const completed = freshAttempt(f, lesson, caseId, 'checkpoint-completed')
  f.engine.autoPlanUpdate({ queueKey: completed.plan.row.queueKey, planHash: completed.plan.row.planHash,
    stage: 'running', ticket: completed.ticket.ticket, attempts: 1 })
  const requestHash = hash64('effective provider request with reasoning and output bound')
  assert.equal(f.engine.ticketReserve({ ticket: completed.ticket.ticket, stepKey: 'review:candidate', requestHash,
    inputTokens: 100, outputTokens: 128 }).ok, true)
  assert.equal(f.engine.ticketStepStart({ ticket: completed.ticket.ticket, stepKey: 'review:candidate', requestHash }).ok, true)
  assert.equal(f.engine.ticketStepComplete({ ticket: completed.ticket.ticket, stepKey: 'review:candidate', requestHash,
    text: 'saved answer', truncated: false, tokens: 91 }).ok, true)
  const recovery = f.engine.recoverAutoPlans()
  assert.equal(recovery.interrupted, 1)
  const checkpoint = f.engine.planProgress({ ticket: completed.ticket.ticket, stepKey: 'review:candidate' })
  assert.equal(checkpoint.step.text, 'saved answer')
  assert.equal(checkpoint.step.tokens, 91)
  f.engine.evaluationCancel({ ticket: completed.ticket.ticket, spent: 91 })

  const uncertain = freshAttempt(f, lesson, caseId, 'checkpoint-unknown')
  f.engine.autoPlanUpdate({ queueKey: uncertain.plan.row.queueKey, planHash: uncertain.plan.row.planHash,
    stage: 'running', ticket: uncertain.ticket.ticket, attempts: 1 })
  const uncertainHash = hash64('second physical request')
  assert.equal(f.engine.ticketReserve({ ticket: uncertain.ticket.ticket, stepKey: 'review:candidate',
    requestHash: uncertainHash, inputTokens: 100, outputTokens: 128 }).ok, true)
  assert.equal(f.engine.ticketStepStart({ ticket: uncertain.ticket.ticket, stepKey: 'review:candidate',
    requestHash: uncertainHash }).ok, true)
  f.engine.recoverAutoPlans()
  const row = f.engine.autoPlans().find(plan => plan.queueKey === uncertain.plan.row.queueKey)
  assert.equal(row.stage, 'blocked')
  assert.equal(row.reason, 'ticket_usage_unknown')
  assert.equal(f.engine.planProgress({ ticket: uncertain.ticket.ticket, stepKey: 'review:candidate' }).ok, false)
})

test('a 20k rolling window resumes only remaining steps and does not recount one task', t => {
  const f = fixture({ tokens: 20_000, calls: 2 })
  t.after(f.cleanup)
  const lesson = candidate(f)
  const caseId = packCases(PACK_ID)[0].caseId
  const run = freshAttempt(f, lesson, caseId, 'rolling-resume', { maxTokens: 2 })
  f.engine.autoPlanUpdate({ queueKey: run.plan.row.queueKey, planHash: run.plan.row.planHash,
    stage: 'running', ticket: run.ticket.ticket, attempts: 1 })
  const saveStep = (stepKey, inputTokens, tokens) => {
    const requestHash = hash64(JSON.stringify([stepKey, inputTokens, tokens]))
    assert.equal(f.engine.ticketReserve({ ticket: run.ticket.ticket, stepKey, requestHash,
      inputTokens, outputTokens: 128 }).ok, true)
    assert.equal(f.engine.ticketStepStart({ ticket: run.ticket.ticket, stepKey, requestHash }).ok, true)
    assert.equal(f.engine.ticketStepComplete({ ticket: run.ticket.ticket, stepKey, requestHash,
      text: `saved:${stepKey}`, truncated: false, tokens }).ok, true)
    return requestHash
  }
  saveStep('review:candidate', 9_000, 8_800)
  saveStep('review:baseline', 10_000, 9_800)
  const overWindow = run.ticket.ticket
  const nextHash = hash64('remaining-judge-step')
  const refused = f.engine.ticketReserve({ ticket: overWindow, stepKey: 'review:judge:0', requestHash: nextHash,
    inputTokens: 1_000, outputTokens: 128 })
  assert.equal(refused.code, 'evaluation_budget')
  f.engine.autoPlanUpdate({ queueKey: run.plan.row.queueKey, planHash: run.plan.row.planHash,
    stage: 'queued', ticket: overWindow, reason: 'budget_window_wait' })
  assert.equal(f.engine.status().evaluationTasksLast24h, 1)
  assert.equal(f.engine.status().evaluationRequestsLast24h, 2)

  f.advance(24 * 60 * 60_000 + 1)
  assert.equal(f.engine.planProgress({ ticket: overWindow, stepKey: 'review:candidate' }).step.text,
    'saved:review:candidate')
  const next = saveStep('review:judge:0', 1_000, 900)
  assert.equal(typeof next, 'string')
  assert.equal(f.engine.status().evaluationTasksLast24h, 1,
    'a resumed ticket counts once in the new rolling window after it dispatches')
  assert.equal(f.engine.status().evaluationRequestsLast24h, 1,
    'physical requests remain a separate rolling count')
})

test('an undispatched reservation is re-admitted atomically after restart and a rolling window', t => {
  const f = fixture({ tokens: 20_000, calls: 2 })
  t.after(f.cleanup)
  const lesson = candidate(f)
  const run = freshAttempt(f, lesson, packCases(PACK_ID)[0].caseId, 'start-after-window', { maxTokens: 2 })
  f.engine.autoPlanUpdate({ queueKey: run.plan.row.queueKey, planHash: run.plan.row.planHash,
    stage: 'running', ticket: run.ticket.ticket, attempts: 1 })
  const stepKey = 'review:candidate'
  const requestHash = hash64('reserved before restart, not yet dispatched')
  assert.equal(f.engine.ticketReserve({ ticket: run.ticket.ticket, stepKey, requestHash,
    inputTokens: 100, outputTokens: 128 }).ok, true)
  assert.equal(f.engine.status().evaluationRequestsLast24h, 0)

  f.advance(24 * 60 * 60_000 + 1)
  const reopen = (tokens, calls) => new LearningEngine({ stateRoot: f.stateRoot, adapterId: 'hermes',
    maxContextBytes: 768, now: f.now, evaluationTokensPerDay: tokens, evaluationCallsPerDay: calls })
  f.engine = reopen(0, 0)
  assert.equal(f.engine.ticketStepStart({ ticket: run.ticket.ticket, stepKey, requestHash }).code,
    'evaluation_budget_calls', 'a tightened task limit is checked at the dispatch transaction')
  f.engine = reopen(0, 2)
  assert.equal(f.engine.ticketStepStart({ ticket: run.ticket.ticket, stepKey, requestHash }).code,
    'evaluation_budget', 'a tightened token limit is checked at the dispatch transaction')
  f.engine = reopen(20_000, 2)
  assert.equal(f.engine.ticketReserve({ ticket: run.ticket.ticket, stepKey, requestHash,
    inputTokens: 100, outputTokens: 128 }).duplicate, true,
  'a duplicate reservation does not itself spend, but cannot bypass start-time admission')
  assert.equal(f.engine.ticketStepStart({ ticket: run.ticket.ticket, stepKey, requestHash }).ok, true)
  const debit = f.document().spends.find(row => row.ticket === run.ticket.ticket)
  const entry = debit.budgetEntries.find(row => row.stepKey === stepKey)
  assert.equal(entry.dispatched, true)
  assert.equal(entry.at, f.now())
  assert.equal(entry.tokens, 228)
  assert.equal(f.engine.status().evaluationTasksLast24h, 1)
  assert.equal(f.engine.status().evaluationRequestsLast24h, 1)
})

test('an ordinary binding is refused whole, and the legacy DSH identity does not move', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const caseId = packCases(PACK_ID)[0].caseId
  const bound = publish(f, SESSION)
  const plan = reviewPlan(f, lesson, caseId, bound)
  // Half a binding is refused by the CORE, not silently treated as the legacy path.
  assert.throws(() => reviewRequest(f, lesson, plan, caseId, bound, { sourceBinding: false }),
    error => error.code === 'invalid_review')
  assert.throws(() => reviewRequest(f, lesson, plan, caseId, bound, { sourceBindingHash: undefined,
    sourceRevision: undefined, sourceBinding: false }), error => error.code === 'invalid_review')

  // ── the legacy execution identity, recomputed independently from the documented sequence ────────
  const legacyInput = { lessonId: lesson.id, version: lesson.version, environment: 'default', track: 'review',
    source: { kind: 'turn', sessionId: 'session-legacy', turnId: '3', projectKey: f.projectKey,
      route: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' } },
    suite: { packId: PACK_ID, version: 1 }, criteria: criteriaOf(caseId) }
  const legacyExpected = hash64(JSON.stringify([lesson.id, lesson.version, 'default', 'review',
    ['deepseek-account', 'deepseek-flash', 'max'], ['turn', 'session-legacy', '3', false],
    [PACK_ID, 1], criteriaOf(caseId).map(row => [row.id, row.kind, row.statement])]))
  const legacy = f.engine.autoPlanIdentity(legacyInput)
  assert.equal(legacy.planHash, legacyExpected,
    'a registration with NO binding hashes exactly the legacy sequence — nothing is appended')
  const legacyRegistered = f.engine.autoPlanRegister(legacyInput)
  assert.equal(legacyRegistered.plan.planHash, legacyExpected)
  // The SAME registration with a binding is a genuinely different execution identity.
  const boundIdentity = f.engine.autoPlanIdentity({ ...legacyInput,
    sourceBinding: { revision: bound.revision, bindingHash: bound.bindingHash } })
  assert.notEqual(boundIdentity.planHash, legacyExpected)
  assert.equal(boundIdentity.planHash, hash64(JSON.stringify([lesson.id, lesson.version, 'default', 'review',
    ['deepseek-account', 'deepseek-flash', 'max'], ['turn', 'session-legacy', '3', false], [PACK_ID, 1],
    criteriaOf(caseId).map(row => [row.id, row.kind, row.statement]),
    [bound.revision, bound.bindingHash]])))
  // An update without an execution identity can never advance a plan.
  assert.throws(() => f.engine.autoPlanUpdate({ queueKey: legacyRegistered.plan.queueKey, stage: 'running' }),
    error => error.code === 'invalid_auto_plan')
  assert.throws(() => f.engine.autoPlanUpdate({ queueKey: legacyRegistered.plan.queueKey,
    planHash: hash64('stale'), stage: 'done' }), error => error.code === 'auto_plan_mismatch')
})

test('the released legacy documents still work: a ticket-less evaluation and a caller-stated case list', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const cases = packCases(PACK_ID).map(row => ({ caseId: row.caseId, family: row.family, split: row.split,
    prompt: row.prompt }))
  // The released request keeps its exact shape: the CALLER states the case list, no binding is named.
  const request = f.engine.evaluationRequest({ lessonId: lesson.id, expectedVersion: lesson.version,
    projectKey: f.projectKey, maxTokens: 6_000, stepwiseBudget: true, steps: 1, inputChars: 1, stepOutputTokens: 1, suiteId: 'legacy-suite', cases })
  assert.equal(typeof request.ticket, 'string', JSON.stringify(request))
  const trials = packCases(PACK_ID).map(testCase => ({ caseId: testCase.caseId, family: testCase.family,
    split: testCase.split, baseline: { passed: false, tokens: 10 }, candidate: { passed: true, tokens: 10 },
    guardPassed: true }))
  const committed = f.engine.evaluate({ ticket: request.ticket, lessonId: lesson.id, projectKey: f.projectKey,
    expectedVersion: lesson.version, basis: 'host_trial', trials, suiteId: 'legacy-suite', eventId: 'legacy-run-1' })
  assert.equal(committed.ok, true, JSON.stringify(committed))
  assert.notEqual(committed.code, 'evaluation_ticket_rejected')
})

test('the transport refuses a half-bound automatic request instead of running it as legacy', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const run = (op, input) => {
    const answer = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.mjs')], { encoding: 'utf8',
      input: JSON.stringify({ config: { stateRoot: f.stateRoot, adapterId: 'hermes', maxContextBytes: 768,
        evaluationTokensPerDay: 40_000, evaluationCallsPerDay: 8 }, op, input }) })
    return { status: answer.status, body: JSON.parse(answer.stdout) }
  }
  // A bound request without the marker is refused at the transport.
  const unmarked = run('reviewRequest', { lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000,
    planHash: hash64('plan'), queueKey: hash64('queue'), packId: PACK_ID })
  assert.equal(unmarked.body.code, 'invalid_source_binding', JSON.stringify(unmarked))
  // ...and so is a document that names half of one.
  const half = run('evaluationRequest', { lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000,
    suiteId: 'legacy-suite', cases: [], sourceRevision: 3 })
  assert.equal(half.body.code, 'invalid_source_binding', JSON.stringify(half))
  // A legacy document that names none of the gate's fields still reaches the core (and fails there
  // for its own reason), which is what "the released document is untouched" means.
  const legacy = run('evaluationRequest', { lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000,
    suiteId: 'legacy-suite', cases: [] })
  assert.equal(legacy.body.code, 'invalid_evaluation', JSON.stringify(legacy))
  // The automatic RESULT entries cannot be reached without their ticket.
  const noTicket = run('objectiveResult', { lessonId: lesson.id, projectKey: f.projectKey })
  assert.equal(noTicket.body.code, 'invalid_source_binding', JSON.stringify(noTicket))
  // No generic scheduler alias is opened; each adapter uses only its enumerated production calls.
  const closed = run('autoPlanScan', {})
  assert.equal(closed.body.code, 'invalid_operation', JSON.stringify(closed))
})

test('the pack material is a read-only projection: repeated reads change no byte of the document', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const caseId = packCases(PACK_ID)[0].caseId
  const path = join(f.stateRoot, 'lessons-v1.json')
  const before = readFileSync(path, 'utf8')
  for (let index = 0; index < 3; index += 1) {
    const material = f.engine.reviewMaterial({ lessonId: lesson.id, projectKey: f.projectKey, packId: PACK_ID,
      caseId })
    assert.equal(material.ok, true)
    assert.equal(material.caseId, caseId)
    assert.ok(material.criteria.length >= 1)
  }
  assert.equal(readFileSync(path, 'utf8'), before, 'a read-only projection writes nothing')
  // A foreign-domain method cannot borrow the pack's material at all.
  const outside = f.engine.record({ projectKey: f.projectKey, source: 'host_proposal', kind: 'method',
    eventId: 'outside-method', instruction: '导出金额前先转换为数值，再按金额排序' })
  const refused = f.engine.reviewMaterial({ lessonId: outside.id, projectKey: f.projectKey, packId: PACK_ID,
    caseId })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'domain_outside_pack')
})

test('every STEP re-reads the original ticket permission, not just the final commit', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const caseId = packCases(PACK_ID)[0].caseId
  const bound = publish(f, SESSION)
  const plan = reviewPlan(f, lesson, caseId, bound)
  const ticket = reviewRequest(f, lesson, plan, caseId, bound)
  assert.equal(typeof ticket.ticket, 'string')
  // The material is bound to the TICKET's own case and is only handed out while it may still run.
  const material = f.engine.reviewMaterial({ ticket: ticket.ticket })
  assert.equal(material.ok, true, JSON.stringify(material))
  assert.equal(material.caseId, caseId)
  assert.equal(typeof material.arms.candidate.system, 'string')
  assert.equal(material.arms.baseline.prompt, material.scenario.prompt)
  assert.equal(JSON.stringify(material).includes('expected'), false)
  // A DIFFERENT case cannot be pulled through this ticket's material.
  const other = packCases(PACK_ID)[1].caseId
  assert.equal(f.engine.reviewMaterial({ ticket: ticket.ticket, caseId: other }).ok, false)
  // ...and the judge request is built by the core, with the CORE's label ledger.
  const judge = f.engine.reviewJudge({ ticket: ticket.ticket, armA: '答案甲'.repeat(20),
    armB: '答案乙'.repeat(20), pass: 0 })
  assert.equal(judge.ok, true, JSON.stringify(judge).slice(0, 200))
  assert.ok(['A', 'B'].includes(judge.labels.armA))
  const second = f.engine.reviewJudge({ ticket: ticket.ticket, armA: '答案甲'.repeat(20),
    armB: '答案乙'.repeat(20), pass: 1 })
  assert.equal(second.ok, true)
  assert.notEqual(second.labels.armA, judge.labels.armA, 'the second pass really swaps the labels')
  assert.equal(second.swapped, true)
  // ── and after a pause, EVERY subsequent step is refused before it can be paid for ──────────────
  f.engine.settlementPause({ paused: true })
  assert.equal(f.engine.reviewMaterial({ ticket: ticket.ticket }).code, 'control_paused')
  assert.equal(f.engine.reviewJudge({ ticket: ticket.ticket, armA: 'a', armB: 'b' }).code, 'control_paused')
  // A resume does NOT revive a ticket signed under the previous control generation: that is the same
  // rule the final commit follows, and it is what keeps a paused run's steps from being paid for.
  f.engine.settlementPause({ paused: false })
  assert.equal(f.engine.reviewMaterial({ ticket: ticket.ticket }).code, 'control_changed',
    'the resumed lifecycle does not revive the old ticket')
  // The stale ticket is then closed by its own result (refused, never credited), which is what frees
  // the shared serial slot for work signed AFTER the resume.
  const stale = f.engine.reviewResult({ ticket: ticket.ticket, lessonId: lesson.id, projectKey: f.projectKey,
    criteria: criteriaOf(caseId), ...passingVerdict(), costKnown: true, usage: { known: true, tokens: 0 } })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'control_changed')
  const renewed = freshAttempt(f, lesson, caseId, 'renewed').ticket
  assert.equal(f.engine.reviewMaterial({ ticket: renewed.ticket }).ok, true)
  // A source that drifted refuses the next step even though the ticket is still open.
  publish(f, SESSION, { model: 'deepseek-other' })
  assert.equal(f.engine.reviewMaterial({ ticket: renewed.ticket }).code, 'source_changed')
  assert.equal(f.engine.reviewJudge({ ticket: renewed.ticket, armA: 'a', armB: 'b' }).code, 'source_changed')
})

test('the objective material walks the frozen cases one bounded page at a time', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const bound = publish(f, SESSION)
  const plan = objectivePlan(f, lesson, bound)
  const ticket = f.engine.evaluationRequest({ lessonId: lesson.id, expectedVersion: lesson.version,
    projectKey: f.projectKey, maxTokens: 6_000, stepwiseBudget: true, steps: 1, inputChars: 1, stepOutputTokens: 1, planHash: plan.row.planHash, queueKey: plan.row.queueKey,
    packId: PACK_ID, sourceBinding: true, sessionId: SESSION, sourceRevision: bound.revision,
    sourceBindingHash: bound.bindingHash })
  assert.equal(typeof ticket.ticket, 'string')
  const count = packCases(PACK_ID).length
  const seen = new Set()
  let cursor = 0
  while (cursor !== null) {
    const page = f.engine.objectiveMaterial({ ticket: ticket.ticket, cursor })
    assert.equal(page.ok, true, JSON.stringify(page).slice(0, 160))
    assert.equal(page.count, count)
    assert.equal(page.next, cursor + 1 < count ? cursor + 1 : null)
    assert.ok(page.caseId)
    assert.equal(typeof page.arms.candidate.system, 'string')
    assert.equal(JSON.stringify(page).includes('expected'), false, 'expected values never leave the core')
    seen.add(page.caseId)
    cursor = page.next
  }
  assert.equal(seen.size, count, 'every frozen case was handed out exactly once')
  assert.equal(f.engine.objectiveMaterial({ ticket: ticket.ticket, cursor: count }).code,
    'objective_cursor_out_of_range')
  // A FOREIGN track's ticket cannot pull objective material. The objective ticket is released first:
  // the two tracks share one serial slot, so a review cannot be signed while it is open.
  assert.equal(f.engine.evaluationCancel({ ticket: ticket.ticket, spent: 100 }).ok, true)
  const reviewTicket = reviewRequest(f, lesson, reviewPlan(f, lesson, packCases(PACK_ID)[0].caseId, bound),
    packCases(PACK_ID)[0].caseId, bound)
  assert.equal(typeof reviewTicket.ticket, 'string', JSON.stringify(reviewTicket))
  assert.equal(f.engine.objectiveMaterial({ ticket: reviewTicket.ticket }).code, 'ticket_kind_mismatch')
})

test('a measured zero, a known part plus unknown, and a repeated IPC stay three different facts', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const caseId = packCases(PACK_ID)[0].caseId
  const bound = publish(f, SESSION)
  // ── a MISSING measurement quality is refused on the automatic path, never assumed known ────────
  const first = reviewRequest(f, lesson, reviewPlan(f, lesson, caseId, bound), caseId, bound)
  assert.throws(() => f.engine.reviewResult({ ticket: first.ticket, lessonId: lesson.id,
    projectKey: f.projectKey, criteria: criteriaOf(caseId), ...passingVerdict(), costKnown: undefined, usage: undefined }),
  error => error.code === 'invalid_review', 'a bound run must state its measurement quality')
  // `costKnown: false` is an honest report: the run is refused a trial even when the judges agree.
  const unmeasured = f.engine.reviewResult({ ticket: first.ticket, lessonId: lesson.id,
    projectKey: f.projectKey, criteria: criteriaOf(caseId), ...passingVerdict(),
    costKnown: false, usage: { known: false }, spent: 2_500 })
  assert.equal(unmeasured.ok, true, JSON.stringify(unmeasured))
  assert.equal(unmeasured.state, 'inconclusive')
  assert.equal(unmeasured.trial, null)
  const row = f.document().spends.find(x => x.ticket === first.ticket)
  assert.equal(row.reserved, 4_000, 'the reservation is remembered as the reservation')
  assert.deepEqual(row.usage, { known: false, tokens: 0 }, 'an unreadable measurement is not a zero')
  assert.equal(row.tokens, 4_000, 'the budget keeps the conservative occupation')
  // ── a legitimate measured ZERO is a measurement: it is recorded as known 0 ─────────────────────
  const second = freshAttempt(f, lesson, caseId, 'measure-zero').ticket
  const zero = f.engine.reviewResult({ ticket: second.ticket, lessonId: lesson.id, projectKey: f.projectKey,
    criteria: criteriaOf(caseId), ...passingVerdict(), costKnown: true, usage: { known: true, tokens: 0 },
    spent: 0 })
  assert.equal(zero.ok, true, JSON.stringify(zero))
  const zeroRow = f.document().spends.find(x => x.ticket === second.ticket)
  assert.deepEqual(zeroRow.usage, { known: true, tokens: 0 })
  assert.equal(zeroRow.tokens, 4_000, 'a measured zero never refunds the reservation of the budget')
  // ── a partially known run latches unknown and keeps the known part ─────────────────────────────
  const third = freshAttempt(f, lesson, caseId, 'partial-known').ticket
  const partial = f.engine.reviewResult({ ticket: third.ticket, lessonId: lesson.id, projectKey: f.projectKey,
    criteria: criteriaOf(caseId), ...passingVerdict(), costKnown: true, usage: { known: true, tokens: 900 },
    spent: 900 })
  assert.equal(partial.ok, true, JSON.stringify(partial))
  const repeated = f.engine.reviewResult({ ticket: third.ticket, lessonId: lesson.id, projectKey: f.projectKey,
    criteria: criteriaOf(caseId), ...passingVerdict(), costKnown: false, usage: { known: false }, spent: 900 })
  assert.equal(repeated.ok, false, 'the ticket is over; a repeat only reports it')
  const thirdRow = f.document().spends.find(x => x.ticket === third.ticket)
  assert.deepEqual(thirdRow.usage, { known: false, tokens: 900 },
    'the known part is kept and the unknown latches')
  assert.equal(thirdRow.tokens, 4_000, 'a repeated IPC cannot charge the same run twice')
  assert.equal(f.document().spends.filter(x => x.ticket === third.ticket).length, 1)
})

test('an undispatched plan ticket survives recovery, while the evidence cannot be signed twice', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const caseId = packCases(PACK_ID)[0].caseId
  const bound = publish(f, SESSION)
  const plan = reviewPlan(f, lesson, caseId, bound)
  const first = reviewRequest(f, lesson, plan, caseId, bound)
  assert.equal(typeof first.ticket, 'string', JSON.stringify(first))
  const spendsBefore = f.document().spends.length
  // No physical step was started. Recovery keeps the plan-bound ticket so its first dispatch can
  // happen later; evidence itself is still consumed at signing and cannot mint a second ticket.
  const released = f.engine.recoverAutoPlans()
  assert.equal(released.releasedTickets, 0, JSON.stringify(released))
  const voided = f.document().spends.find(x => x.ticket === first.ticket)
  assert.equal(voided.terminal, undefined)
  // The SAME evidence on the SAME plan is refused: it was already paid for at signing time.
  const replay = reviewRequest(f, lesson, plan, caseId, bound)
  assert.equal(replay.ok, true, JSON.stringify(replay))
  assert.equal(replay.skipped, 'evidence_already_attempted')
  assert.equal(f.document().spends.length, spendsBefore,
    'a refused replay reserves nothing new')
  // The retained undispatched ticket remains bound to its original plan and can be settled once.
  const settled = f.engine.reviewResult({ ticket: first.ticket, lessonId: lesson.id, projectKey: f.projectKey,
    criteria: criteriaOf(caseId), ...passingVerdict() })
  assert.equal(settled.ok, true, JSON.stringify(settled))
  // A newer source revision permits a distinct later attempt.
  const second = freshAttempt(f, lesson, caseId, 'after-void').ticket
  assert.equal(typeof second.ticket, 'string')
})

test('a refusal records the measurement quality as well as the cost', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const caseId = packCases(PACK_ID)[0].caseId
  const bound = publish(f, SESSION)
  const plan = reviewPlan(f, lesson, caseId, bound)
  const ticket = reviewRequest(f, lesson, plan, caseId, bound)
  f.engine.settlementStop({ sessionId: SESSION, reason: 'operator_stop' })
  const late = f.engine.reviewResult({ ticket: ticket.ticket, lessonId: lesson.id, projectKey: f.projectKey,
    criteria: criteriaOf(caseId), ...passingVerdict(), costKnown: true, usage: { known: true, tokens: 1_200 },
    spent: 1_200 })
  assert.equal(late.ok, false)
  assert.equal(late.code, 'control_source_stopped')
  const row = f.document().spends.find(x => x.ticket === ticket.ticket)
  assert.equal(row.terminal, 'control_source_stopped')
  assert.equal(row.tokens, 4_000, 'the conservative occupation stays at the reservation floor')
  assert.deepEqual(row.usage, { known: true, tokens: 1_200 }, 'the measured part is recorded')
  assert.equal(row.reserved, 4_000)
})

test('cold start: the candidate and its source are enough to get an official plan and material', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const bound = publish(f, SESSION)
  // ── the host knows only its OWN trusted facts: the candidate, the scope, the source turn ───────
  const proposal = f.engine.autoPlanProposal({ lessonId: lesson.id, projectKey: f.projectKey,
    track: 'review', source: { kind: 'turn', sessionId: SESSION, turnId: '3', projectKey: f.projectKey,
      route: { provider: PROVIDER, model: MODEL, reasoningEffort: EFFORT } } })
  assert.equal(proposal.ok, true, JSON.stringify(proposal).slice(0, 200))
  assert.equal(proposal.suite.packId, PACK_ID)
  assert.equal(proposal.suite.suiteId, packSuiteId(getDomainPack(PACK_ID)))
  assert.ok(proposal.caseId, 'the core chose an official case')
  assert.ok(proposal.criteria.length >= 1, 'the criteria come from the registry, not from the host')
  assert.ok(proposal.cases.length >= 12, 'the bounded case REFERENCES travel with the proposal')
  assert.equal(JSON.stringify(proposal).includes('expected'), false)
  assert.equal(JSON.stringify(proposal).includes('forbidden'), false)
  // Registering EXACTLY what the core proposed is the same execution, never a second one.
  const registered = f.engine.autoPlanRegister(proposal.registration)
  assert.equal(registered.ok, true, JSON.stringify(registered))
  assert.equal(registered.plan.queueKey, proposal.queueKey)
  assert.equal(registered.plan.planHash, proposal.planHash)
  assert.equal(registered.plan.caseId, proposal.caseId)
  const again = f.engine.autoPlanRegister(proposal.registration)
  assert.equal(again.duplicate, true, 'the same execution is never queued twice')
  const identity = f.engine.autoPlanIdentity(proposal.registration)
  assert.equal(identity.planHash, proposal.planHash)
  // The request then needs NO case and NO criteria of its own: the plan carries them.
  const ticket = f.engine.reviewRequest({ lessonId: lesson.id, expectedVersion: lesson.version,
    projectKey: f.projectKey, maxTokens: 4_000, stepwiseBudget: true, steps: 1, inputChars: 1, stepOutputTokens: 1, planHash: proposal.planHash, queueKey: proposal.queueKey,
    sourceBinding: true, sessionId: SESSION, sourceRevision: bound.revision,
    sourceBindingHash: bound.bindingHash })
  assert.equal(typeof ticket.ticket, 'string', JSON.stringify(ticket))
  assert.equal(ticket.caseId, proposal.caseId)
  assert.equal(ticket.packId, PACK_ID)
  const material = f.engine.reviewMaterial({ ticket: ticket.ticket })
  assert.equal(material.ok, true, JSON.stringify(material))
  assert.equal(material.caseId, proposal.caseId)
  assert.equal(material.limits.armChars, 4000)
  // ...and the DISCOVERY form of the material works before any plan exists at all.
  const discovered = f.engine.reviewMaterial({ lessonId: lesson.id, projectKey: f.projectKey })
  assert.equal(discovered.ok, true, JSON.stringify(discovered).slice(0, 200))
  assert.equal(discovered.packId, PACK_ID)
  assert.equal(discovered.caseId, proposal.cases[0].caseId, 'the pack picks its own first case')
  // A case the registry does not hold is refused instead of quietly being replaced.
  assert.equal(f.engine.autoPlanProposal({ lessonId: lesson.id, projectKey: f.projectKey, track: 'review',
    caseId: 'no-such-case', source: { kind: 'turn', sessionId: SESSION, turnId: '3' } }).code,
  'domain_pack_required')
  // A method OUTSIDE the official domain gets no proposal and no material at all.
  const outside = f.engine.record({ projectKey: f.projectKey, source: 'host_proposal', kind: 'method',
    eventId: 'outside-cold', instruction: '导出金额前先转换为数值，再按金额排序' })
  assert.equal(f.engine.autoPlanProposal({ lessonId: outside.id, projectKey: f.projectKey, track: 'review',
    source: { kind: 'turn', sessionId: SESSION, turnId: '3' } }).code, 'domain_outside_pack')
  assert.equal(f.engine.reviewMaterial({ lessonId: outside.id, projectKey: f.projectKey }).code,
    'domain_outside_pack')
  // The objective track's proposal carries the same official suite and identity.
  const objectiveTicket = f.engine.evaluationCancel({ ticket: ticket.ticket })
  assert.equal(objectiveTicket.ok, true)
  const objective = f.engine.autoPlanProposal({ lessonId: lesson.id, projectKey: f.projectKey,
    track: 'objective', source: { kind: 'turn', sessionId: SESSION, turnId: '3', projectKey: f.projectKey,
      route: { provider: PROVIDER, model: MODEL, reasoningEffort: EFFORT } } })
  assert.equal(objective.ok, true, JSON.stringify(objective).slice(0, 160))
  assert.equal(objective.suite.packId, PACK_ID)
  assert.notEqual(objective.queueKey, proposal.queueKey, 'the two tracks are separate queue entries')
})

test('a terminal plan, a withdrawn licence and an oversized answer all stop the NEXT paid step', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const caseId = packCases(PACK_ID)[0].caseId
  const first = freshAttempt(f, lesson, caseId, 'terminal-plan')
  // ── the plan is BLOCKED while the attempt is in flight ─────────────────────────────────────────
  const blocked = f.engine.autoPlanUpdate({ queueKey: first.plan.row.queueKey,
    planHash: first.plan.row.planHash, stage: 'blocked', reason: 'audit_blocked' })
  assert.equal(blocked.ok, true, JSON.stringify(blocked))
  assert.equal(f.engine.reviewMaterial({ ticket: first.ticket.ticket }).code, 'auto_plan_stale')
  assert.equal(f.engine.reviewJudge({ ticket: first.ticket.ticket, armA: 'a', armB: 'b' }).code,
    'auto_plan_stale')
  // The refusal hands out no material, and the attempt can still REPORT and settle its own cost.
  const settled = f.engine.reviewResult({ ticket: first.ticket.ticket, lessonId: lesson.id,
    projectKey: f.projectKey, criteria: criteriaOf(caseId), ...passingVerdict() })
  assert.equal(settled.ok, false)
  // The MATERIAL path names the plan cause (`auto_plan_stale`); the released review RESULT keeps its
  // own long-standing code for "the plan this ticket froze is not the live one".
  assert.equal(settled.code, 'review_plan_stale')
  // The two numbers stay separate: the budget keeps the reservation as its floor, while the MEASURED
  // part of the run is what was really read.
  assert.equal(settled.spent, 4_000, 'the conservative budget occupation is the reservation')
  assert.equal(settled.reserved, 4_000)
  assert.deepEqual(settled.measured, { known: true, tokens: 1_200 })
  const row = f.engine.list({ projectKey: f.projectKey, limit: 5 }).lessons.find(x => x.id === lesson.id)
  assert.equal(row.trial ?? null, null)

  // ── the whole response is bounded, not just its text ───────────────────────────────────────────
  const heavy = freshAttempt(f, lesson, caseId, 'wire-size')
  const noisy = ("\"\\\\".repeat(900)).slice(0, 2_000)
  const judge = f.engine.reviewJudge({ ticket: heavy.ticket.ticket, armA: noisy, armB: noisy, pass: 0 })
  assert.equal(judge.ok, false, JSON.stringify(judge).slice(0, 120))
  assert.equal(judge.code, 'response_too_large')
  assert.ok(judge.bytes > judge.limit, JSON.stringify(judge))
  assert.ok(Buffer.byteLength(JSON.stringify(judge), 'utf8') < 512, 'the refusal itself stays small')
  // A small answer of the same shape still fits and carries the real limits.
  const small = f.engine.reviewJudge({ ticket: heavy.ticket.ticket, armA: '答案甲'.repeat(20),
    armB: '答案乙'.repeat(20), pass: 0 })
  assert.equal(small.ok, true, JSON.stringify(small).slice(0, 120))
  assert.equal(small.limits.responseBytes, 8192)
  // The wire-size attempt is settled (its cost recorded, no trial) so the shared serial slot is free.
  const closed = f.engine.reviewResult({ ticket: heavy.ticket.ticket, lessonId: lesson.id,
    projectKey: f.projectKey, criteria: criteriaOf(caseId), ...passingVerdict() })
  assert.equal(closed.ok, true, JSON.stringify(closed))
  assert.equal(closed.state, 'reviewed')

  // ── the licence is withdrawn while an attempt is in flight ─────────────────────────────────────
  const revoked = freshAttempt(f, lesson, caseId, 'revoked-licence')
  // A real review first earns the trial that the withdrawal then moves.
  const earned = f.engine.reviewResult({ ticket: revoked.ticket.ticket, lessonId: lesson.id,
    projectKey: f.projectKey, criteria: criteriaOf(caseId), ...passingVerdict() })
  assert.equal(earned.ok, true, JSON.stringify(earned))
  assert.equal(earned.trial, 'trial')
  const live = freshAttempt(f, lesson, caseId, 'revoked-live')
  assert.equal(f.engine.reviewMaterial({ ticket: live.ticket.ticket }).ok, true)
  const withdrawn = f.engine.withdrawTrial({ lessonId: lesson.id, projectKey: f.projectKey,
    reason: 'user_correction' })
  assert.equal(withdrawn.trial.state, 'withdrawn', JSON.stringify(withdrawn))
  // A withdrawal invalidates the lesson's plans AND moves its licence counter; either fact refuses the
  // next paid step, and the plan predicate is simply the first one to see it.
  for (const code of [f.engine.reviewMaterial({ ticket: live.ticket.ticket }).code,
    f.engine.reviewJudge({ ticket: live.ticket.ticket, armA: 'a', armB: 'b' }).code]) {
    assert.ok(['auto_plan_stale', 'review_plan_stale'].includes(code),
      `a withdrawn licence takes the remaining paid steps with it, got ${code}`)
  }
  // The stale attempt can still report what it cost (no promotion, no second charge).
  const lateAfterWithdrawal = f.engine.reviewResult({ ticket: live.ticket.ticket, lessonId: lesson.id,
    projectKey: f.projectKey, criteria: criteriaOf(caseId), ...passingVerdict() })
  assert.equal(lateAfterWithdrawal.ok, false)
  assert.equal(lateAfterWithdrawal.measured.known, true)
})

test('the persisted measurement decides the credit: an overrun and an unknown both refuse it', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const caseId = packCases(PACK_ID)[0].caseId
  // ── a known measurement ABOVE the reservation refuses the promotion and raises the budget floor ─
  const over = freshAttempt(f, lesson, caseId, 'known-overrun').ticket
  const refused = f.engine.reviewResult({ ticket: over.ticket, lessonId: lesson.id, projectKey: f.projectKey,
    criteria: criteriaOf(caseId), ...passingVerdict(), spent: 600, usage: { known: true, tokens: 4_600 } })
  assert.equal(refused.ok, false, JSON.stringify(refused))
  assert.equal(refused.code, 'budget_exceeded')
  const overRow = f.document().spends.find(x => x.ticket === over.ticket)
  assert.equal(overRow.tokens, 4_600, 'the known measurement is the budget floor, not the caller`s 600')
  assert.deepEqual(overRow.usage, { known: true, tokens: 4_600 })
  assert.equal(overRow.terminal, 'budget_exceeded')
  const afterOverrun = f.engine.list({ projectKey: f.projectKey, limit: 5 })
    .lessons.find(x => x.id === lesson.id)
  assert.equal(afterOverrun.trial ?? null, null, 'an overrun never earns a trial')
  // An OMITTED spent with the same known usage is the same fact.
  const omitted = freshAttempt(f, lesson, caseId, 'known-overrun-omitted').ticket
  const refusedAgain = f.engine.reviewResult({ ticket: omitted.ticket, lessonId: lesson.id,
    projectKey: f.projectKey, criteria: criteriaOf(caseId), ...passingVerdict(), spent: undefined,
    usage: { known: true, tokens: 4_600 } })
  assert.equal(refusedAgain.code, 'budget_exceeded', JSON.stringify(refusedAgain))

  // ── an UNKNOWN measurement cannot be overridden by a boolean travelling beside it ──────────────
  const unknown = freshAttempt(f, lesson, caseId, 'unknown-usage').ticket
  const quiet = f.engine.reviewResult({ ticket: unknown.ticket, lessonId: lesson.id, projectKey: f.projectKey,
    criteria: criteriaOf(caseId), ...passingVerdict(), spent: 600, costKnown: true,
    usage: { known: false, tokens: 600 } })
  assert.equal(quiet.ok, true, JSON.stringify(quiet))
  assert.equal(quiet.state, 'inconclusive', 'the persisted unknown decides, not the caller`s boolean')
  assert.equal(quiet.trial, null)
  const unknownRow = f.document().spends.find(x => x.ticket === unknown.ticket)
  assert.deepEqual(unknownRow.usage, { known: false, tokens: 600 })
  assert.equal(unknownRow.terminal, 'review_settled')
})

test('a step-wise cost report persists usage without closing the attempt, and an overrun stops it', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const caseId = packCases(PACK_ID)[0].caseId
  const live = freshAttempt(f, lesson, caseId, 'step-usage')
  // ── one step's measurement is persisted while the attempt stays OPEN ───────────────────────────
  const first = f.engine.ticketUsage({ ticket: live.ticket.ticket, spent: 80,
    usage: { known: true, tokens: 80 } })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(first.live, true, 'a cost report never closes the attempt')
  assert.equal(first.terminal, null)
  assert.equal(first.spent, 4_000, 'the reservation is still the budget floor')
  assert.deepEqual(first.measured, { known: true, tokens: 80 })
  assert.equal(f.engine.reviewMaterial({ ticket: live.ticket.ticket }).ok, true,
    'the next step is still permitted')
  // Idempotent and order-independent: a repeated or smaller report changes nothing that was higher.
  f.engine.ticketUsage({ ticket: live.ticket.ticket, spent: 80, usage: { known: true, tokens: 80 } })
  f.engine.ticketUsage({ ticket: live.ticket.ticket, spent: 20, usage: { known: true, tokens: 20 } })
  const steady = f.engine.ticketUsage({ ticket: live.ticket.ticket, usage: { known: false } })
  assert.deepEqual(steady.measured, { known: false, tokens: 80 },
    'the known part is kept and the unknown latches')
  // ── a step that really went past the reservation is visible to the NEXT step ────────────────────
  const over = f.engine.ticketUsage({ ticket: live.ticket.ticket, spent: 4_600,
    usage: { known: true, tokens: 4_600 } })
  assert.equal(over.ok, true, JSON.stringify(over))
  assert.equal(over.spent, 4_600, 'the persisted cost is the real one')
  assert.equal(f.engine.ticketContinuation(live.ticket.ticket, { kind: 'review' }).code, 'budget_exceeded')
  assert.equal(f.engine.reviewMaterial({ ticket: live.ticket.ticket }).code, 'budget_exceeded')
  assert.equal(f.engine.reviewJudge({ ticket: live.ticket.ticket, armA: 'a', armB: 'b' }).code,
    'budget_exceeded')
  // The final result refuses too, and grants nothing — but it still records what was spent.
  const settled = f.engine.reviewResult({ ticket: live.ticket.ticket, lessonId: lesson.id,
    projectKey: f.projectKey, criteria: criteriaOf(caseId), ...passingVerdict(), spent: 80,
    usage: { known: true, tokens: 80 } })
  assert.equal(settled.ok, false, JSON.stringify(settled))
  assert.equal(settled.code, 'budget_exceeded')
  assert.equal(settled.spent, 4_600)
  const row = f.engine.list({ projectKey: f.projectKey, limit: 5 }).lessons.find(x => x.id === lesson.id)
  assert.equal(row.trial ?? null, null, 'an overrun never earns a trial')
  // A late measurement for a ticket that is already over is still absorbed, and reports its terminal.
  const late = f.engine.ticketUsage({ ticket: live.ticket.ticket, spent: 4_800 })
  assert.equal(late.ok, true)
  assert.equal(late.live, false)
  assert.equal(late.terminal, 'budget_exceeded')
  assert.equal(late.spent, 4_800)
  // The objective track shares the same report and the same merger.
  const objectivePlanRow = objectivePlan(f, lesson, f.engine.sourceStatus({ limit: 4 }).rows[0])
  assert.equal(objectivePlanRow.ok, true, JSON.stringify(objectivePlanRow).slice(0, 120))
})

test('the response bound counts the terminating newline the CLI really writes', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const caseId = packCases(PACK_ID)[0].caseId
  const attempt = freshAttempt(f, lesson, caseId, 'newline-bound')
  const arm = length => ('x"\\'.repeat(Math.ceil(length / 3))).slice(0, length)
  // Find the exact edge with REAL calls: the largest arm length the core still answers, and the
  // smallest one it refuses. Two arms of the same length move the document by two bytes per step.
  const sizeOf = result => Buffer.byteLength(JSON.stringify(result), 'utf8')
  const probe = length => f.engine.reviewJudge({ ticket: attempt.ticket.ticket, armA: arm(length),
    armB: arm(length), pass: 0 })
  // A bounded binary search over the arm length finds the EXACT edge: the largest answer the core
  // still hands out, and the smallest one it refuses.
  let low = 1
  let high = 4_000
  assert.equal(probe(low).ok, true, 'a small answer always fits')
  assert.equal(probe(high).ok, false, 'the largest legal arm cannot fit')
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2)
    if (probe(mid).ok === true) low = mid
    else high = mid
  }
  const accepted = { length: low, result: probe(low) }
  const refused = { length: high, result: probe(high) }
  // The accepted document plus the newline is INSIDE the limit...
  assert.ok(sizeOf(accepted.result) + 1 <= 8_192,
    `accepted response ${sizeOf(accepted.result) + 1} must fit the protocol limit`)
  assert.ok(sizeOf(accepted.result) + 1 > 8_192 - 4, 'and it is really at the edge')
  // ...and the next one is refused as a WHOLE-RESPONSE overflow, with a small refusal that reports
  // the true size (the document the transport would have written, plus its newline).
  assert.equal(refused.result.ok, false)
  assert.equal(refused.result.code, 'response_too_large')
  assert.ok(refused.result.bytes > 8_192, JSON.stringify(refused.result))
  assert.ok(refused.result.bytes <= sizeOf(accepted.result) + 1 + 8, JSON.stringify(refused.result))
  assert.equal(refused.result.limit, 8_192)
  assert.ok(sizeOf(refused.result) + 1 < 512, 'the refusal itself stays small')
  // The document the caller receives is exactly the boundary case the reviewer hit: a payload that
  // would have crossed the limit ONLY because of the newline is refused, not handed out.
  assert.ok(accepted.length >= 1_000, 'the edge is a realistic answer size: ' + accepted.length)
  assert.equal(refused.result.code, 'response_too_large')
})

test('an unknown step already reported cannot be overwritten by a later known frame (both tracks)', t => {
  const f = fixture()
  t.after(f.cleanup)
  const lesson = candidate(f)
  const caseId = packCases(PACK_ID)[0].caseId
  // ── review: unknown first, then a frame that looks known ───────────────────────────────────────
  const attempt = freshAttempt(f, lesson, caseId, 'unknown-then-known')
  const first = f.engine.ticketUsage({ ticket: attempt.ticket.ticket, spent: 300,
    usage: { known: false, tokens: 300 } })
  assert.equal(first.live, true)
  const second = f.engine.ticketUsage({ ticket: attempt.ticket.ticket, spent: 600,
    usage: { known: true, tokens: 600 } })
  assert.equal(second.live, true)
  assert.deepEqual(second.measured, { known: false, tokens: 600 },
    'the unknown latches while the known part keeps growing')
  const settled = f.engine.reviewResult({ ticket: attempt.ticket.ticket, lessonId: lesson.id,
    projectKey: f.projectKey, criteria: criteriaOf(caseId), ...passingVerdict(), spent: 600,
    costKnown: true, usage: { known: true, tokens: 600 } })
  assert.equal(settled.ok, true, JSON.stringify(settled))
  assert.equal(settled.state, 'inconclusive', 'the persisted unknown decides the credit')
  assert.equal(settled.trial, null)
  const reviewRow = f.document().spends.find(x => x.ticket === attempt.ticket.ticket)
  assert.deepEqual(reviewRow.usage, { known: false, tokens: 600 }, 'the persisted quality still latches')
  assert.equal(reviewRow.terminal, 'review_settled')
  const reviewed = f.engine.list({ projectKey: f.projectKey, limit: 5 }).lessons.find(x => x.id === lesson.id)
  assert.notEqual(reviewed.status, 'validated')

  // ── objective: the same rule, through the ticket's own usage report ────────────────────────────
  const plan = objectivePlan(f, lesson, f.engine.sourceStatus({ limit: 4 }).rows[0])
  const objective = f.engine.evaluationRequest({ lessonId: lesson.id, expectedVersion: lesson.version,
    projectKey: f.projectKey, maxTokens: 6_000, stepwiseBudget: true, steps: 1, inputChars: 1, stepOutputTokens: 1, planHash: plan.row.planHash, queueKey: plan.row.queueKey,
    packId: PACK_ID, sourceBinding: true, sessionId: SESSION,
    sourceRevision: f.engine.sourceStatus({ limit: 4 }).rows[0].revision,
    sourceBindingHash: f.engine.sourceStatus({ limit: 4 }).rows[0].bindingHash })
  assert.equal(typeof objective.ticket, 'string', JSON.stringify(objective))
  f.engine.ticketUsage({ ticket: objective.ticket, spent: 300, usage: { known: false, tokens: 300 } })
  f.engine.ticketUsage({ ticket: objective.ticket, spent: 600, usage: { known: true, tokens: 600 } })
  const answers = Object.fromEntries(packCases(PACK_ID).map(testCase =>
    [testCase.caseId, { candidate: correctAnswer(testCase), baseline: BASELINE_ANSWER }]))
  const usage = Object.fromEntries(packCases(PACK_ID).map(testCase =>
    [testCase.caseId, { baseline: 100, candidate: 120 }]))
  const committed = f.engine.evaluate({ ticket: objective.ticket, lessonId: lesson.id,
    projectKey: f.projectKey, expectedVersion: lesson.version, answers, usage, ticketUsage:
      { known: true, tokens: 3_600 }, sourceBinding: true })
  assert.equal(committed.ok, true, JSON.stringify(committed).slice(0, 200))
  assert.equal(committed.decision, 'inconclusive', 'an unknown step cannot be validated through')
  assert.ok(committed.reasons.includes('unknown_cost'), JSON.stringify(committed.reasons))
  const objectiveRow = f.document().spends.find(x => x.ticket === objective.ticket)
  assert.equal(objectiveRow.usage.known, false, 'the persisted quality latches on this track too')
  const afterObjective = f.engine.list({ projectKey: f.projectKey, limit: 5 })
    .lessons.find(x => x.id === lesson.id)
  assert.notEqual(afterObjective.status, 'validated')
})
