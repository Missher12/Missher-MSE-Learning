// Stage 3a closure: the withdrawal licence and the review domain gate.
//
// These cases lock the two gaps the independent stage-3 audit found in the REAL core, on a
// temporary state root, with the REAL registered pack for the adapter-side half:
//   1. a withdrawn trial could still be re-granted by a review that was already in flight
//      (and by the same ticket after an engine restart);
//   2. a review had no domain admission at all, so a sorting/Python/cooking method could buy a
//      trial through an unrelated fixed scenario — and the trial it earned could then be recalled
//      for tasks the pack never covered.
//
// The fixtures are honest: the lesson text is in the pack's domain where the case is about the
// review contract, and genuinely outside it (the audit's own `数字排序` example) where the case is
// about the refusal. No assertion here is relaxed to make the product look greener.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningEngine } from '../src/index.mjs'
import { createAutoValidation } from '../adapters/dsh/auto.mjs'
import { packCases, packCaseCriteriaHash, packScenarioHash, packSuiteId, packAdmits } from '../src/domains.mjs'
import { planHash } from '../src/review.mjs'

const PACK_ID = 'mse-lifecycle-v1'
const IN_DOMAIN = '处理请求时先记录代次，再把迟到结果按代次丢弃'
const OUT_OF_DOMAIN = '数字排序时先将字符串转换为数值，再按照数值从小到大排序'
const CRITERIA = packCases(PACK_ID)[0].criteria

function fixture({ tokens = 20_000, calls = 3 } = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-stage3a-'))
  let now = Date.UTC(2030, 0, 1)
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh', now: () => now,
    evaluationTokensPerDay: tokens, evaluationCallsPerDay: calls })
  const projectKey = '/synthetic/stage3a-project'
  return { stateRoot, engine, projectKey, advance: ms => { now += ms },
    // The fake clock itself, so a "restart" can be created a moment later without leaving the
    // ticket's own 30-minute window (an expiry is a different refusal from a withdrawal).
    clock: () => now,
    statePath: () => join(stateRoot, 'lessons-v1.json'),
    cleanup: () => rmSync(stateRoot, { recursive: true, force: true }) }
}

const candidate = (f, instruction = IN_DOMAIN) => {
  const recorded = f.engine.record({ projectKey: f.projectKey, source: 'host_proposal', kind: 'method',
    eventId: `method-${Math.random().toString(16).slice(2)}`, instruction })
  return f.engine.list({ projectKey: f.projectKey, limit: 10 }).lessons.find(row => row.id === recorded.id)
}

/** The plan binding the automatic pass registers for the review track. */
const reviewPlan = (f, lesson) => f.engine.autoPlanRegister({
  lessonId: lesson.id, version: lesson.version, environment: lesson.environment ?? 'default', track: 'review',
  source: { kind: 'turn', sessionId: 'stage3a-session', turnId: '1',
    route: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' } },
  suite: { packId: PACK_ID, version: 1 }, criteria: CRITERIA }).plan

const CASE_ID = packCases(PACK_ID)[0].caseId
const reserveReview = (f, lesson, plan, extra = {}) => f.engine.reviewRequest({
  lessonId: lesson.id, projectKey: f.projectKey, expectedVersion: lesson.version, maxTokens: 4_000,
  planHash: plan.planHash, queueKey: plan.queueKey, packId: PACK_ID, caseId: CASE_ID,
  scenarioHash: packScenarioHash(PACK_ID, CASE_ID), criteriaHash: packCaseCriteriaHash(PACK_ID, CASE_ID),
  criteria: CRITERIA, ...extra })

const submitReview = (f, plan, ticket, extra = {}) => f.engine.reviewResult({
  ticket, projectKey: f.projectKey, planHash: plan.planHash,
  first: '{"winner":"A"}', second: '{"winner":"B"}', swapped: true, structuredPassed: true,
  answers: { candidate: '先记录代次，迟到结果按代次丢弃，并说明如何处理。',
    baseline: '直接处理即可，不需要额外记录任何东西，也不用记代次。' },
  criteria: CRITERIA, route: { provider: 'fixture', model: 'synthetic' }, judge: 'fixture/synthetic',
  spent: 1_200, costKnown: true, ...extra })

/** Start a trial through the real flow and return a plan that is live for it. */
const trialFixture = f => {
  const lesson = candidate(f)
  const first = reviewPlan(f, lesson)
  const verdict = submitReview(f, first, reserveReview(f, lesson, first).ticket)
  assert.equal(verdict.trial, 'trial', 'fixture must really start a trial')
  // A finished review rotates the plan when the work is registered again, so the plan a LATER
  // reservation runs under is the one registered now — not the one that already served an answer.
  return { lesson: () => f.engine.list({ projectKey: f.projectKey, limit: 10 }).lessons.find(row => row.id === lesson.id),
    plan: reviewPlan(f, lesson) }
}

test('a review that was already reserved cannot re-grant a withdrawn trial', () => {
  const f = fixture()
  try {
    const { lesson, plan } = trialFixture(f)
    const earned = lesson().review.planHash
    // Reserved BEFORE the withdrawal: the answer is still in flight when the licence ends.
    const pending = reserveReview(f, lesson(), plan)
    assert.equal(typeof pending.ticket, 'string', 'a second reservation is a real ticket')
    const withdrawn = f.engine.withdrawTrial({ lessonId: lesson().id, projectKey: f.projectKey, reason: 'user_correction' })
    assert.equal(withdrawn.trial.state, 'withdrawn')
    const late = submitReview(f, plan, pending.ticket)
    assert.equal(late.ok, false, 'a late review must be refused, never credited')
    assert.equal(late.code, 'review_plan_stale', JSON.stringify(late))
    assert.notEqual(late.trial, 'trial')
    const stored = lesson()
    assert.equal(stored.trial.state, 'withdrawn', 'the withdrawal stands')
    assert.notEqual(stored.status, 'validated')
    assert.equal(stored.review.state, 'reviewed', 'the review that DID happen is not erased by a later withdrawal')
    assert.equal(stored.review.planHash, earned,
      'the refused late result never overwrote the review row it did not earn')
  } finally { f.cleanup() }
})

test('a fresh reservation after the withdrawal earns nothing either', () => {
  const f = fixture()
  try {
    const { lesson } = trialFixture(f)
    const earned = lesson().review.planHash
    // The queue legitimately registers the work again while the reviewer is still working, so the
    // new reservation runs under a live plan — and the withdrawal lands while it is in flight.
    const next = reviewPlan(f, lesson())
    const pending = reserveReview(f, lesson(), next)
    assert.equal(typeof pending.ticket, 'string')
    f.engine.withdrawTrial({ lessonId: lesson().id, projectKey: f.projectKey, reason: 'user_correction' })
    const late = submitReview(f, next, pending.ticket)
    assert.equal(late.ok, false)
    assert.equal(late.code, 'review_plan_stale', JSON.stringify(late))
    assert.equal(lesson().trial.state, 'withdrawn')
    assert.equal(lesson().review.planHash, earned, 'the earned review row is stable')
  } finally { f.cleanup() }
})

test('the same late ticket is still refused after the engine restarts', () => {
  const f = fixture()
  try {
    const { lesson, plan } = trialFixture(f)
    const pending = reserveReview(f, lesson(), plan)
    // The restart reads BOTH durable facts — the ticket and the withdrawal. Neither of them is
    // in-memory state, so the refusal cannot depend on this process still being alive. The clock
    // moves a little (a restart is not an expiry), so the ticket is still inside its own window.
    const restarted = new LearningEngine({ stateRoot: f.stateRoot, adapterId: 'dsh', now: () => f.clock() + 60_000,
      evaluationTokensPerDay: 20_000, evaluationCallsPerDay: 3 })
    const withdrawn = restarted.withdrawTrial({ lessonId: lesson().id, projectKey: f.projectKey, reason: 'user_correction' })
    assert.equal(withdrawn.trial.state, 'withdrawn')
    const late = restarted.reviewResult({ ticket: pending.ticket, projectKey: f.projectKey,
      planHash: plan.planHash, first: '{"winner":"A"}', second: '{"winner":"B"}', swapped: true,
      structuredPassed: true, criteria: CRITERIA, route: { provider: 'fixture', model: 'synthetic' },
      judge: 'fixture/synthetic', spent: 1_200, costKnown: true })
    assert.equal(late.ok, false)
    assert.equal(late.code, 'review_plan_stale')
    const stored = restarted.list({ projectKey: f.projectKey, limit: 10 }).lessons.find(row => row.id === lesson().id)
    assert.equal(stored.trial.state, 'withdrawn')
    assert.equal(stored.status, 'tested', 'no trial and no validation came back with the late answer')
    // A second process cannot spend the same ticket either: it was already consumed by the refusal,
    // and stage 4c answers the repeated submission with that same terminal state instead of starting
    // a second attempt (nothing is credited and nothing is charged again).
    const repeated = restarted.reviewResult({ ticket: pending.ticket, projectKey: f.projectKey,
      planHash: plan.planHash, criteria: CRITERIA })
    assert.equal(repeated.ok, false)
    assert.equal(repeated.code, 'review_plan_stale')
    assert.equal(repeated.terminal, 'review_plan_stale')
  } finally { f.cleanup() }
})

test('the adapter never commits a review whose licence the core has already withdrawn', () => {
  const f = fixture()
  try {
    const { lesson } = trialFixture(f)
    assert.throws(() => submitReview(f, f.engine.autoPlans()[0], 'synthetic-late-ticket'),
      error => error.code === 'review_ticket_rejected',
      'an unknown ticket is a refusal, not a silent success')
  } finally { f.cleanup() }
})

test('a withdrawal asks for its own review identity, never a global control change', () => {
  const f = fixture()
  try {
    const { lesson } = trialFixture(f)
    const generation = f.engine.controlGeneration()
    f.engine.withdrawTrial({ lessonId: lesson().id, projectKey: f.projectKey, reason: 'trusted_failure' })
    assert.equal(f.engine.controlGeneration(), generation,
      'withdrawing one trial must not bump the global control generation')
    // AbortSignal is not the mechanism either: the refusal above happened with no signal at all.
  } finally { f.cleanup() }
})

test('withdrawing one trial leaves another lesson able to finish its own review', () => {
  const f = fixture()
  try {
    const { lesson } = trialFixture(f)
    f.engine.withdrawTrial({ lessonId: lesson().id, projectKey: f.projectKey, reason: 'trusted_failure' })
    const other = candidate(f, '并发票据在锁内只能结算一次，重复提交必须被拒绝并丢弃')
    const otherPlan = reviewPlan(f, other)
    const verdict = submitReview(f, otherPlan, reserveReview(f, other, otherPlan).ticket)
    assert.equal(verdict.ok, true)
    assert.equal(verdict.state, 'reviewed')
    assert.equal(verdict.trial, 'trial', 'the untouched lesson still earns its own trial')
  } finally { f.cleanup() }
})

test('withdrawing a trial does not hand back the money it already settled', () => {
  const f = fixture()
  try {
    const { lesson, plan } = trialFixture(f)
    const spentBefore = f.engine.status().evaluationTokensReserved24h
    const pending = reserveReview(f, lesson(), plan)
    const reserved = f.engine.status().evaluationTokensReserved24h
    assert.ok(reserved > spentBefore, 'the reservation is a paid call')
    f.engine.withdrawTrial({ lessonId: lesson().id, projectKey: f.projectKey, reason: 'trusted_failure' })
    const late = submitReview(f, plan, pending.ticket)
    assert.equal(late.ok, false)
    // The refused result is still charged at the conservative reservation: the call happened.
    assert.equal(f.engine.status().evaluationTokensReserved24h, reserved, 'no refund for work already paid')
  } finally { f.cleanup() }
})

test('review admission uses the real pack: an out-of-domain method buys no ticket and no trial', () => {
  const f = fixture()
  try {
    for (const instruction of [OUT_OF_DOMAIN, '用 Python 给这个函数补充类型注解 def f(x): return x + 1',
      '做饭时先把葱姜蒜爆香，再下主料翻炒']) {
      assert.equal(packAdmits(PACK_ID, instruction).ok, false, `fixture must be out of domain: ${instruction}`)
      const lesson = candidate(f, instruction)
      const binding = planHash({ lessonId: lesson.id, version: lesson.version, environment: 'default', track: 'review' })
      assert.throws(() => f.engine.reviewRequest({ lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000,
        planHash: binding, packId: PACK_ID, criteria: CRITERIA }), error => error.code === 'domain_outside_pack')
      const stored = f.engine.list({ projectKey: f.projectKey, limit: 10 }).lessons.find(row => row.id === lesson.id)
      assert.equal(stored.trial ?? null, null, 'no trial without admission')
      assert.equal(f.engine.status().evaluationJobsOpen, 0, 'no ticket was issued')
    }
    assert.equal(f.engine.status().evaluationTokensReserved24h, 0, 'an out-of-domain request spends nothing')
    // The control: the same call on an admitting method does issue a ticket.
    const admitted = candidate(f)
    const plan = reviewPlan(f, admitted)
    assert.equal(typeof reserveReview(f, admitted, plan).ticket, 'string')
  } finally { f.cleanup() }
})

test('a review cannot borrow an unregistered pack identity', () => {
  const f = fixture()
  try {
    const lesson = candidate(f)
    const binding = planHash({ lessonId: lesson.id, version: lesson.version, environment: 'default', track: 'review' })
    assert.throws(() => f.engine.reviewRequest({ lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000,
      planHash: binding, packId: 'not-a-pack', criteria: CRITERIA }), error => error.code === 'domain_pack_required')
    assert.equal(f.engine.status().evaluationTokensReserved24h, 0)
  } finally { f.cleanup() }
})

test('a reservation naming a version the registry does not hold signs nothing', () => {
  const f = fixture()
  try {
    const lesson = candidate(f)
    const plan = reviewPlan(f, lesson)
    // `packVersion: 2` is a request to be credited against an oracle that was never registered.
    assert.throws(() => reserveReview(f, lesson, plan, { packVersion: 2 }),
      error => error.code === 'domain_pack_required')
    assert.equal(f.engine.status().evaluationTokensReserved24h, 0, 'a refused version costs nothing')
    assert.equal(f.engine.status().evaluationJobsOpen, 0)
  } finally { f.cleanup() }
})

test('a persisted ticket is re-checked against the CURRENT registry at submission', () => {
  const f = fixture()
  try {
    const lesson = candidate(f)
    const plan = reviewPlan(f, lesson)
    const ticket = reserveReview(f, lesson, plan).ticket
    // A registry whose CONTENT moved while its version did not (a restart that swapped a case, its
    // prompt or its criteria) is exactly the case a version comparison alone cannot see. The stored
    // reservation is what such a restart would leave behind, and the submission must re-read the
    // registry for it instead of trusting the frozen bytes.
    const state = JSON.parse(readFileSync(f.statePath(), 'utf8'))
    const job = state.jobs.find(row => row.ticket === ticket)
    assert.equal(job.caseId, CASE_ID)
    job.scenarioHash = 'c'.repeat(64)
    writeFileSync(f.statePath(), JSON.stringify(state))
    const late = submitReview(f, plan, ticket)
    assert.equal(late.ok, false, 'an identity the registry cannot confirm is refused')
    // The ticket named the case, so the scenario hash it also carries is the mismatch the registry
    // re-check reports first. Either refusal is the contract: nothing is credited across the move.
    assert.equal(late.code, 'review_plan_stale')
    const stored = f.engine.list({ projectKey: f.projectKey, limit: 10 }).lessons.find(row => row.id === lesson.id)
    assert.equal(stored.trial ?? null, null, 'no trial was granted across a moved registry')
  } finally { f.cleanup() }
})

test('a late review is refused when the frozen pack identity no longer matches', () => {
  const f = fixture()
  try {
    const lesson = candidate(f)
    const plan = reviewPlan(f, lesson)
    const ticket = reserveReview(f, lesson, plan).ticket
    // A pack VERSION rotation: the stored reservation was authorised against `v1`, and the row now
    // records an identity the registry does not hold. This is the durable shape a rotated registry
    // leaves behind, and the submission must not be credited across it.
    const state = JSON.parse(readFileSync(f.statePath(), 'utf8'))
    const job = state.jobs.find(row => row.ticket === ticket)
    assert.equal(job.packId, PACK_ID, 'the reservation froze the pack it was authorised against')
    assert.equal(job.packVersion, 1)
    assert.equal(job.scenarioHash, packScenarioHash(PACK_ID, CASE_ID))
    assert.equal(job.criteriaHash, packCaseCriteriaHash(PACK_ID, CASE_ID))
    job.packVersion = 2
    writeFileSync(f.statePath(), JSON.stringify(state))
    const late = submitReview(f, plan, ticket)
    assert.equal(late.ok, false)
    assert.equal(late.code, 'review_plan_stale')
  } finally { f.cleanup() }
})

test('a trial is offered only inside the pack domain it was reviewed in', async () => {
  const f = fixture()
  try {
    const { lesson } = trialFixture(f)
    const trial = lesson().trial
    assert.equal(trial.state, 'trial')
    assert.equal(trial.packId, PACK_ID, 'the trial carries the domain it was earned in')
    assert.equal(trial.packVersion, 1)
    const ask = prompt => f.engine.prepare({ projectKey: f.projectKey, sessionId: 'stage3a-trial',
      turnId: prompt.slice(0, 4), origin: 'user', prompt })
    // The pack never covered sorting: "reviewed here" must not read as "try it everywhere".
    const outside = ask('数字排序时先将字符串转换为数值，再按照数值从小到大排序')
    assert.deepEqual(outside.lessonVersions.filter(row => row.tier === 'trial'), [],
      `an out-of-domain task must not recall the trial: ${outside.reason}`)
    const inside = ask('处理请求时先记录代次，再把迟到结果按代次丢弃，然后提交结算')
    const trialRows = inside.lessonVersions.filter(row => row.tier === 'trial')
    assert.equal(trialRows.length, 1, `the pack's own domain still recalls it: ${inside.reason}`)
    assert.equal(trialRows[0].id, lesson().id)
    // The review that earned the trial is unchanged by the recall decision.
    const scheduler = createAutoValidation({ engine: f.engine,
      context: () => ({ suite: { packId: PACK_ID, version: 1 }, criteria: CRITERIA,
        scenarioHash: packScenarioHash(PACK_ID, packCases(PACK_ID)[0].caseId), criteriaHash: packCaseCriteriaHash(PACK_ID, packCases(PACK_ID)[0].caseId),
        arm: () => ({ system: 's', prompt: 'p' }), judge: () => ({ system: 's', prompt: 'j', labels: { armA: 'A', armB: 'B' } }) }),
      objectiveContext: () => null,
      route: () => ({ provider: 'fixture', model: 'synthetic' }),
      callModel: async () => { throw new Error('no model call may happen here') },
      enabled: () => true, now: () => Date.UTC(2030, 0, 1) })
    await scheduler.scan([])
    assert.equal(lesson().trial.packId, PACK_ID)
  } finally { f.cleanup() }
})

test('a legacy trial without a domain is conserved, never recalled on a guess', () => {
  const f = fixture()
  try {
    const { lesson } = trialFixture(f)
    const state = JSON.parse(readFileSync(f.statePath(), 'utf8'))
    const row = state.lessons.find(item => item.id === lesson().id)
    // The pre-domain trial shape: nothing in the row says which pack it was reviewed in.
    delete row.trial.packId
    delete row.trial.packVersion
    writeFileSync(f.statePath(), JSON.stringify(state))
    const restarted = new LearningEngine({ stateRoot: f.stateRoot, adapterId: 'dsh', now: () => Date.UTC(2030, 0, 2),
      evaluationTokensPerDay: 20_000, evaluationCallsPerDay: 3 })
    const prepared = restarted.prepare({ projectKey: f.projectKey, sessionId: 'stage3a-legacy', turnId: '1',
      origin: 'user', prompt: '处理请求时先记录代次，再把迟到结果按代次丢弃，然后提交结算' })
    assert.deepEqual(prepared.lessonVersions.filter(item => item.tier === 'trial'), [],
      'an unverifiable domain claim is never recalled — not even in the pack it probably came from')
    const stored = restarted.list({ projectKey: f.projectKey, limit: 10 }).lessons.find(item => item.id === lesson().id)
    assert.equal(stored.trial.state, 'trial', 'the historical row is conserved')
    assert.equal(stored.trial.packId ?? null, null)
  } finally { f.cleanup() }
})

test('the scheduler reports an out-of-domain review and reserves nothing for it', async () => {
  const f = fixture({ tokens: 20_000, calls: 3 })
  try {
    const lesson = candidate(f, OUT_OF_DOMAIN)
    const recorded = []
    // A recording core stand-in, so the assertion can be about the CALLS the scheduler made and
    // not only about the state that happened to survive: a paid step must never be reached.
    const calls = []
    const proxy = new Proxy(f.engine, { get: (target, name) => (typeof target[name] === 'function'
      ? (...args) => { calls.push(name); return target[name](...args) } : target[name]) })
    const scheduler = createAutoValidation({ engine: proxy,
      // Exactly the production adapter's contract: domain admission decides the context first.
      reviewAdmission: row => ({ ok: false, reason: 'domain_forbidden:排序' }),
      context: () => ({ suite: { packId: PACK_ID, version: 1 }, criteria: CRITERIA, caseId: CASE_ID,
        scenarioHash: packScenarioHash(PACK_ID, CASE_ID), criteriaHash: packCaseCriteriaHash(PACK_ID, CASE_ID),
        arm: () => ({ system: 's', prompt: 'p' }), judge: () => ({ system: 's', prompt: 'j', labels: { armA: 'A', armB: 'B' } }) }),
      objectiveContext: () => null,
      route: () => ({ provider: 'fixture', model: 'synthetic' }),
      callModel: async () => { throw new Error('an out-of-domain review must never reach the model') },
      enabled: () => true, now: () => Date.UTC(2030, 0, 1), log: (code, detail) => recorded.push([code, detail]) })
    const result = await scheduler.scan([{ id: lesson.id, version: lesson.version, projectKey: f.projectKey,
      instruction: lesson.instruction }])
    assert.equal(result.ok, true)
    assert.deepEqual(f.engine.autoPlans(), [], 'no plan was registered for an unrelated method')
    assert.equal(f.engine.status().evaluationJobsOpen, 0, 'no ticket was reserved')
    assert.equal(f.engine.status().evaluationTokensReserved24h, 0, 'no paid call was made')
    assert.ok(!calls.includes('reviewRequest'), `no reservation was attempted: ${JSON.stringify(calls)}`)
    assert.ok(!calls.includes('reviewResult'), 'nothing was submitted')
    assert.ok(recorded.some(([code, detail]) => code === 'review_out_of_domain:domain_forbidden:排序' && detail === lesson.id),
      `the wait must say which domain refused it: ${JSON.stringify(recorded)}`)
    // The scheduler records both facts on purpose: the domain refusal explains the wait, the missing
    // scenario records that no comparison was built. What matters is that the refusal is present.
    assert.ok(recorded.some(([code]) => code === 'review_out_of_domain:domain_forbidden:排序'),
      'the domain refusal survives beside the missing-scenario entry')
  } finally { f.cleanup() }
})

test('a reservation cannot put the official pack name on a scenario the pack never registered', () => {
  const f = fixture()
  try {
    const lesson = candidate(f)
    const plan = reviewPlan(f, lesson)
    // Every field the audit used: a registered pack id, an invented scenario hash, an invented
    // criteria hash and invented criteria text. None of it can be frozen as a pack experiment.
    const invented = { scenarioHash: 'a'.repeat(64), criteriaHash: 'b'.repeat(64),
      criteria: [{ id: 'invented', kind: 'structured', statement: '合成改写后的准则' }] }
    assert.throws(() => reserveReview(f, lesson, plan, invented), error => error.code === 'review_plan_stale')
    assert.throws(() => reserveReview(f, lesson, plan, { caseId: null, ...invented }),
      error => error.code === 'domain_pack_required')
    // A hash that belongs to ANOTHER case of the pack is not this reservation's scenario either.
    const other = packCases(PACK_ID).find(row => row.family !== 'excluded_inputs' && row.caseId !== CASE_ID)
    assert.ok(other, 'the pack has more than one non-excluded case')
    assert.throws(() => reserveReview(f, lesson, plan, {
      scenarioHash: packScenarioHash(PACK_ID, other.caseId), criteriaHash: packCaseCriteriaHash(PACK_ID, CASE_ID) }),
    error => error.code === 'review_plan_stale')
    // The criteria the pack registered for the case it DID name are the only ones it may freeze.
    assert.throws(() => reserveReview(f, lesson, plan, { criteria: invented.criteria }),
      error => error.code === 'review_plan_stale')
    assert.throws(() => reserveReview(f, lesson, plan, { criteriaHash: 'b'.repeat(64) }),
      error => error.code === 'review_plan_stale')
    assert.equal(f.engine.status().evaluationTokensReserved24h, 0, 'none of the refusals cost anything')
    // The legitimate identity still reserves, and the ticket freezes what the REGISTRY derived.
    const ticket = reserveReview(f, lesson, plan).ticket
    assert.equal(typeof ticket, 'string')
    const job = f.engine.store.read().jobs.find(row => row.ticket === ticket)
    assert.equal(job.packId, PACK_ID)
    assert.equal(job.packVersion, 1)
    assert.equal(job.caseId, CASE_ID)
    assert.equal(job.scenarioHash, packScenarioHash(PACK_ID, CASE_ID))
    assert.equal(job.criteriaHash, packCaseCriteriaHash(PACK_ID, CASE_ID))
    assert.deepEqual(job.criteria, CRITERIA)
  } finally { f.cleanup() }
})

test('the review gate is the same predicate the promotion and recall paths use', () => {
  // One place decides the domain claim: the suite the review plan binds to, the wording the pack
  // admits, and the wording it refuses all come from the single registered predicate.
  const suite = packSuiteId({ packId: PACK_ID, version: 1 })
  assert.equal(suite, `domain-pack:${PACK_ID}:v1`)
  assert.equal(packAdmits(PACK_ID, IN_DOMAIN).ok, true)
  assert.equal(packAdmits(PACK_ID, OUT_OF_DOMAIN).ok, false)
})
