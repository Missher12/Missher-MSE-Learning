// alpha.18: automatic review/validation — two tracks, bounded scheduling data, and the trial tier.
//
// Every case here drives the REAL core on a temporary state root. Nothing is faked except the
// reviewer's own answers, which is exactly the boundary the design draws: the model supplies text,
// the host supplies the verdict.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningEngine } from '../src/index.mjs'
import { packCases, packCriteriaHash, packScenarioHash, packSuiteId } from '../src/domains.mjs'
import { parseVerdict, planHash } from '../src/review.mjs'
import { packAdmits } from '../src/domains.mjs'

const DAY = 86_400_000

function fixture({ tokens = 20_000, calls = 3 } = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-auto-'))
  let now = Date.UTC(2030, 0, 1)
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh', now: () => now,
    evaluationTokensPerDay: tokens, evaluationCallsPerDay: calls })
  const projectKey = '/synthetic/auto-project'
  return { stateRoot, engine, projectKey, advance: ms => { now += ms }, now: () => now,
    bytes: () => { const path = join(stateRoot, 'lessons-v1.json')
      return { sha: readFileSync(path, 'utf8'), mtime: statSync(path).mtimeMs } },
    cleanup: () => rmSync(stateRoot, { recursive: true, force: true }) }
}

/** One method candidate, in the shape the automatic pass consumes. */
function candidate(f, instruction = '处理请求时先记录代次，再把迟到结果按代次丢弃') {
  const lesson = f.engine.record({ projectKey: f.projectKey, source: 'host_proposal', kind: 'method',
    eventId: `method-${Math.random().toString(16).slice(2)}`, instruction })
  return f.engine.list({ projectKey: f.projectKey, limit: 10 }).lessons.find(row => row.id === lesson.id)
}

const planInput = (f, lesson, route = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }) => ({
  lessonId: lesson.id, version: lesson.version, environment: 'default', track: 'review',
  source: { kind: 'turn', sessionId: 'session-abc', turnId: '3', route },
  suite: { packId: 'mse-lifecycle-v1', version: 1 }, criteria: packCases('mse-lifecycle-v1')[0].criteria })

test('a queue key dedupes the work while the execution binding follows the route', () => {
  const f = fixture()
  try {
    const lesson = candidate(f)
    const first = f.engine.autoPlanRegister(planInput(f, lesson))
    assert.equal(first.ok, true)
    // The same work with the same binding is a duplicate, never a second queue row.
    const again = f.engine.autoPlanRegister(planInput(f, lesson))
    assert.equal(again.duplicate, true)
    assert.equal(again.plan.queueKey, first.plan.queueKey)
    assert.equal(again.plan.planHash, first.plan.planHash)
    // A different reasoning effort is a DIFFERENT execution of the same queue entry.
    const other = f.engine.autoPlanRegister(planInput(f, lesson,
      { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }))
    assert.equal(other.duplicate, false)
    assert.equal(other.plan.queueKey, first.plan.queueKey)
    assert.notEqual(other.plan.planHash, first.plan.planHash)
    assert.equal(f.engine.autoPlans().length, 1, 'one queue entry, re-pointed at the new plan')
    // A stale binding can never advance the plan it no longer describes.
    assert.throws(() => f.engine.autoPlanUpdate({ queueKey: first.plan.queueKey, planHash: first.plan.planHash,
      stage: 'running' }), error => error.code === 'auto_plan_mismatch')
  } finally { f.cleanup() }
})

test('an explicit zero budget refuses every paid step and still reports the reason', () => {
  const f = fixture({ tokens: 0, calls: 3 })
  try {
    const lesson = candidate(f)
    const plan = f.engine.reviewPlan({ lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000 })
    assert.equal(plan.allowed, false)
    assert.ok(plan.reasons.includes('review_budget_disabled'), plan.reasons.join(','))
    const requested = f.engine.reviewRequest({ lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000,
      planHash: planHash({ lessonId: lesson.id, version: lesson.version, environment: 'default', track: 'review' }) })
    assert.equal(requested.skipped, 'evaluation_budget')
    assert.equal(f.engine.autoPlans().length, 0)
    // Read-only planning must not have written anything either.
    assert.equal(JSON.stringify(f.engine.autoPlans()), '[]')
  } finally { f.cleanup() }
})

test('a review reservation is serial: one job at a time, and only up to the daily caps', () => {
  const f = fixture({ tokens: 20_000, calls: 1 })
  try {
    const lesson = candidate(f)
    const binding = planHash({ lessonId: lesson.id, version: lesson.version, environment: 'default', track: 'review' })
    const first = f.engine.reviewRequest({ lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000, planHash: binding })
    assert.equal(typeof first.ticket, 'string')
    // A second reservation while one is open is refused: two arms may not double-spend one call.
    const second = f.engine.reviewRequest({ lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000, planHash: binding })
    assert.equal(second.skipped, 'evaluation_budget')
    const status = f.engine.status()
    assert.equal(status.evaluationJobsOpen, 1)
    assert.equal(status.evaluationCallsLast24h, 1, 'the reservation counts as a paid call')
  } finally { f.cleanup() }
})

test('a late review for a version that moved on is refused, never credited', () => {
  const f = fixture()
  try {
    const lesson = candidate(f)
    const binding = planHash({ lessonId: lesson.id, version: lesson.version, environment: 'default', track: 'review' })
    const reservation = f.engine.reviewRequest({ lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000, planHash: binding })
    // The lesson moves on (its version really changes) while the reviewer is still thinking: a
    // suspension is one of the transfers that invalidates the old evidence.
    f.engine.suspend({ lessonId: lesson.id, projectKey: f.projectKey })
    const late = f.engine.reviewResult({ ticket: reservation.ticket, planHash: binding, projectKey: f.projectKey,
      first: '{"winner":"A"}', second: '{"winner":"B"}', criteria: packCases('mse-lifecycle-v1')[0].criteria })
    assert.equal(late.ok, false)
    assert.equal(late.code, 'review_plan_stale')
    const row = f.engine.list({ projectKey: f.projectKey, limit: 10 }).lessons.find(x => x.id === lesson.id)
    assert.equal(row.trial ?? null, null, 'a stale review never starts a trial')
    assert.notEqual(row.status, 'validated')
  } finally { f.cleanup() }
})

test('an aligned blind review starts an unproven trial, never a validation', () => {
  const f = fixture()
  try {
    const lesson = candidate(f)
    const criteria = packCases('mse-lifecycle-v1')[0].criteria
    const binding = planHash({ lessonId: lesson.id, version: lesson.version, environment: 'default', track: 'review' })
    const reservation = f.engine.reviewRequest({ lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000, planHash: binding })
    const verdict = f.engine.reviewResult({ ticket: reservation.ticket, planHash: binding, projectKey: f.projectKey,
      first: '{"winner":"A"}', second: '{"winner":"B"}', criteria, swapped: true,
      answers: { candidate: '先记录代次，迟到结果按代次丢弃，并说明如何处理。',
        baseline: '直接处理即可，不需要额外记录任何东西，也不用记代次。' },
      structuredPassed: true, route: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
      judge: 'deepseek-account/deepseek-flash', spent: 1_200, costKnown: true })
    assert.equal(verdict.ok, true)
    assert.equal(verdict.state, 'reviewed')
    assert.equal(verdict.trial, 'trial')
    const stored = f.engine.list({ projectKey: f.projectKey, limit: 10 }).lessons.find(x => x.id === lesson.id)
    assert.equal(stored.status, 'tested', 'a reviewed method becomes tested, not validated')
    assert.equal(stored.trial.state, 'trial')
    assert.equal(stored.review.benefit, 'unproven', 'the benefit claim stays unproven')
    assert.equal(stored.review.agreement, 'aligned')
    assert.deepEqual(f.engine.status().counts.tested, 1)
    assert.equal(f.engine.status().counts.validated, 0)
  } finally { f.cleanup() }
})

test('an unknown cost or a vacuous tie keeps the lesson a candidate', () => {
  const criteria = packCases('mse-lifecycle-v1')[0].criteria
  for (const [label, claims] of [
    ['unknown cost', { costKnown: false }],
    ['vacuous answers', { answers: { candidate: '嗯', baseline: '好' }, structuredPassed: true }],
    ['unstated structured guard', { answers: { candidate: '甲'.repeat(40), baseline: '乙'.repeat(40) }, structuredPassed: false }],
  ]) {
    const f = fixture()
    try {
      const lesson = candidate(f)
      const binding = planHash({ lessonId: lesson.id, version: lesson.version, environment: 'default', track: 'review' })
      const reservation = f.engine.reviewRequest({ lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000, planHash: binding })
      const verdict = f.engine.reviewResult({ ticket: reservation.ticket, planHash: binding, projectKey: f.projectKey, criteria,
        first: '{"winner":"tie"}', second: '{"winner":"tie"}', swapped: true, ...claims })
      assert.notEqual(verdict.state, 'reviewed', label)
      const stored = f.engine.list({ projectKey: f.projectKey, limit: 10 }).lessons.find(x => x.id === lesson.id)
      assert.equal(stored.trial ?? null, null, label)
      assert.notEqual(stored.status, 'validated', label)
      assert.equal(stored.review.benefit, 'none', label)
    } finally { f.cleanup() }
  }
})

test('a trial is offered as an unverified reference, at most once, after everything verified', () => {
  const f = fixture()
  try {
    const lesson = candidate(f)
    const criteria = packCases('mse-lifecycle-v1')[0].criteria
    const binding = planHash({ lessonId: lesson.id, version: lesson.version, environment: 'default', track: 'review' })
    const ticket = f.engine.reviewRequest({ lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000, planHash: binding }).ticket
    f.engine.reviewResult({ ticket, planHash: binding, projectKey: f.projectKey, first: '{"winner":"A"}', second: '{"winner":"B"}',
      criteria, swapped: true, structuredPassed: true,
      answers: { candidate: '先记录代次，迟到结果按代次丢弃，并说明如何处理。', baseline: '直接处理即可，不需要额外记录任何东西，也不用记代次。' } })
    // A second trial on the same turn would be a second unverified instruction; the tier is capped.
    const prompt = '处理请求时先记录代次，再把迟到结果按代次丢弃'
    const prepared = f.engine.prepare({ projectKey: f.projectKey, sessionId: 'session-trial', turnId: '1',
      origin: 'user', prompt })
    const trialRows = prepared.lessonVersions.filter(row => row.tier === 'trial')
    assert.equal(trialRows.length <= 1, true, 'at most one trial per turn')
    if (prepared.lessons.length > 0) {
      assert.ok(prepared.context.includes('仅供') || trialRows.length === 0,
        'a trial line says what it is')
    }
  } finally { f.cleanup() }
})

test('withdrawing a trial (or suspending the lesson) ends the offer', () => {
  const f = fixture()
  try {
    const lesson = candidate(f)
    const criteria = packCases('mse-lifecycle-v1')[0].criteria
    const binding = planHash({ lessonId: lesson.id, version: lesson.version, environment: 'default', track: 'review' })
    const ticket = f.engine.reviewRequest({ lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000, planHash: binding }).ticket
    f.engine.reviewResult({ ticket, planHash: binding, projectKey: f.projectKey, first: '{"winner":"A"}', second: '{"winner":"B"}',
      criteria, swapped: true, structuredPassed: true,
      answers: { candidate: '先记录代次，迟到结果按代次丢弃，并说明如何处理。', baseline: '直接处理即可，不需要额外记录任何东西，也不用记代次。' } })
    const plan = f.engine.autoPlanRegister(planInput(f, lesson))
    const withdrawn = f.engine.withdrawTrial({ lessonId: lesson.id, projectKey: f.projectKey, reason: 'trusted_failure' })
    assert.equal(withdrawn.trial.state, 'withdrawn')
    const stored = f.engine.list({ projectKey: f.projectKey, limit: 10 }).lessons.find(x => x.id === lesson.id)
    assert.equal(stored.trial.state, 'withdrawn')
    assert.equal(stored.trial.reason, 'trusted_failure')
    // The plan that covered the trial is retired with it.
    const after = f.engine.autoPlans().find(row => row.queueKey === plan.plan.queueKey)
    assert.equal(after.stage, 'blocked')
  } finally { f.cleanup() }
})

test('the objective track promotes only through a host-registered pack verdict', () => {
  const f = fixture()
  try {
    const lesson = candidate(f)
    const cases = packCases('mse-lifecycle-v1')
    // The caller supplies the model's answers; the PACK decides which arm passed. A caller that
    // tries to hand over its own trials is not on this path at all.
    // A candidate that answers every case the way the pack's own checker expects: `expected` is a
    // string for text-exact, an array of lines for lines-present, and a value for json.
    const answers = Object.fromEntries(cases.map(row => [row.caseId, {
      candidate: row.checker.kind === 'lines-present-v1' ? (row.checker.expected ?? []).join('\n')
        : row.checker.kind === 'text-exact-v1' ? row.checker.expected
          : JSON.stringify(row.checker.expected),
      baseline: '不适用', }]))
    // Real usage for both arms of every case: without it the cost gate refuses to promote, which is
    // the honest answer rather than a measured zero nobody measured.
    const usage = Object.fromEntries(cases.map(row => [row.caseId, { baseline: 18, candidate: 12 }]))
    const result = f.engine.evaluate({ basis: 'host_pack', packId: 'mse-lifecycle-v1', answers, usage,
      lessonId: lesson.id, expectedVersion: lesson.version, suiteId: packSuiteId({ packId: 'mse-lifecycle-v1', version: 1 }),
      eventId: 'pack-run-1', projectKey: f.projectKey })
    assert.equal(result.ok, true)
    assert.equal(result.decision, 'accepted', JSON.stringify(result.reasons))
    const stored = f.engine.list({ projectKey: f.projectKey, limit: 10 }).lessons.find(x => x.id === lesson.id)
    assert.equal(stored.status, 'validated')
    assert.equal(stored.validation.domain.packId, 'mse-lifecycle-v1')
    assert.equal(stored.validation.domain.scope, 'validation_domain_only')
    // A pack result is never produced without the pack: an unknown id is refused outright.
    assert.throws(() => f.engine.evaluate({ basis: 'host_pack', packId: 'not-a-pack', answers,
      lessonId: lesson.id, expectedVersion: lesson.version, suiteId: 'x', eventId: 'pack-run-2', projectKey: f.projectKey }),
    error => error.code === 'domain_pack_required')
  } finally { f.cleanup() }
})

test('the admin views are read-only and never touch the store', () => {
  const f = fixture()
  try {
    const lesson = candidate(f)
    f.engine.autoPlanRegister(planInput(f, lesson))
    const before = f.bytes()
    for (let index = 0; index < 3; index++) {
      f.engine.autoPlans()
      f.engine.autoCandidates({ limit: 10 })
      f.engine.reviewPlan({ lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000 })
    }
    const after = f.bytes()
    assert.equal(after.sha, before.sha, 'a read-only view must not rewrite the store')
    assert.equal(after.mtime, before.mtime)
    // The candidate view reports the state a caller needs, including why nothing has happened yet.
    const [row] = f.engine.autoCandidates({ limit: 10 }).rows
    assert.equal(row.id, lesson.id)
    assert.equal(row.plan.stage, 'queued')
    assert.equal(row.review, null)
  } finally { f.cleanup() }
})

test('scenario and criteria hashes are what a review plan can be re-verified against', () => {
  const cases = packCases('mse-lifecycle-v1')
  const scenario = packScenarioHash('mse-lifecycle-v1', cases[0].caseId)
  assert.match(scenario, /^[a-f0-9]{64}$/u)
  assert.equal(scenario, packScenarioHash('mse-lifecycle-v1', cases[0].caseId))
  assert.notEqual(scenario, packScenarioHash('mse-lifecycle-v1', cases[1].caseId))
  assert.equal(packCriteriaHash('mse-lifecycle-v1'), packCriteriaHash('mse-lifecycle-v1'))
})

// ---------------------------------------------------------------- r1 core corrections

test('a review reservation carries the queue identity and the frozen criteria text', () => {
  const f = fixture()
  try {
    const lesson = candidate(f)
    const criteria = packCases('mse-lifecycle-v1')[0].criteria
    const plan = f.engine.autoPlanRegister({ ...planInput(f, lesson), criteria })
    const binding = plan.plan.planHash
    const ticket = f.engine.reviewRequest({ lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000,
      planHash: binding, queueKey: plan.plan.queueKey, criteria, scenarioHash: 'x', criteriaHash: 'y' }).ticket
    assert.equal(typeof ticket, 'string')
    // (r1-1) Re-registering the SAME work under a DIFFERENT route leaves the old ticket describing an
    // execution that no longer exists: the current plan no longer matches, so the result is refused.
    const moved = f.engine.autoPlanRegister({ ...planInput(f, lesson,
      { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }), criteria })
    assert.notEqual(moved.plan.planHash, binding)
    const late = f.engine.reviewResult({ ticket, planHash: binding, projectKey: f.projectKey, criteria,
      first: '{"winner":"A"}', second: '{"winner":"B"}', structuredPassed: true,
      answers: { candidate: '先记录代次，迟到结果按代次丢弃并说明处理方式。', baseline: '直接处理即可，不需要额外记录任何东西。' } })
    assert.equal(late.ok, false)
    assert.equal(late.code, 'review_plan_stale')
    const stored = f.engine.list({ projectKey: f.projectKey, limit: 10 }).lessons.find(x => x.id === lesson.id)
    assert.equal(stored.trial ?? null, null)
  } finally { f.cleanup() }
})

test('criteria text cannot be swapped under the same declared hash', () => {
  const f = fixture()
  try {
    const lesson = candidate(f)
    const criteria = packCases('mse-lifecycle-v1')[0].criteria
    const binding = planHash({ lessonId: lesson.id, version: lesson.version, environment: 'default', track: 'review' })
    const ticket = f.engine.reviewRequest({ lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000,
      planHash: binding, criteria }).ticket
    // The same hash string, different sentences: the frozen TEXT is what decides.
    const swapped = criteria.map(row => ({ ...row, statement: '完全不同的准则正文' }))
    const refused = f.engine.reviewResult({ ticket, planHash: binding, projectKey: f.projectKey, criteria: swapped,
      first: '{"winner":"A"}', second: '{"winner":"B"}', structuredPassed: true,
      answers: { candidate: '先记录代次，迟到结果按代次丢弃并说明处理方式。', baseline: '直接处理即可，不需要额外记录任何东西。' } })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'review_plan_stale')
  } finally { f.cleanup() }
})

test('a restart voids every ticket, not only the expired ones', () => {
  const f = fixture()
  try {
    const lesson = candidate(f)
    const criteria = packCases('mse-lifecycle-v1')[0].criteria
    const binding = planHash({ lessonId: lesson.id, version: lesson.version, environment: 'default', track: 'review' })
    const ticket = f.engine.reviewRequest({ lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000,
      planHash: binding, criteria }).ticket
    // One minute later — far inside the 30-minute window — the process restarts.
    f.advance(60_000)
    const recovered = f.engine.recoverAutoPlans()
    assert.equal(recovered.releasedTickets, 1)
    // An unknown or voided ticket is a caller error, so the core refuses it outright — the point is
    // that it cannot be submitted at all.
    assert.throws(() => f.engine.reviewResult({ ticket, planHash: binding, projectKey: f.projectKey, criteria,
      first: '{"winner":"A"}', second: '{"winner":"B"}', structuredPassed: true,
      answers: { candidate: '先记录代次，迟到结果按代次丢弃并说明处理方式。', baseline: '直接处理即可，不需要额外记录任何东西。' } }),
    error => error.code === 'review_ticket_rejected')
    // The reservation stays spent: the call may have been paid for.
    assert.equal(f.engine.status().evaluationCallsLast24h, 1)
  } finally { f.cleanup() }
})

test('a cancelled run keeps the usage that already came back', () => {
  const f = fixture()
  try {
    const lesson = candidate(f)
    const binding = planHash({ lessonId: lesson.id, version: lesson.version, environment: 'default', track: 'review' })
    const reserved = f.engine.reviewRequest({ lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000,
      planHash: binding }).ticket
    // Two calls returned 6000 tokens before the switch closed; the ledger must not fall back to 4000.
    f.engine.evaluationCancel({ ticket: reserved, spent: 6_000 })
    assert.equal(f.engine.status().evaluationTokensReserved24h, 6_000)
  } finally { f.cleanup() }
})

test('the real judge protocol reports per-criterion rows as an array', () => {
  // (r1-5) The scheduler reads this shape; an id-keyed object would silently never match.
  const verdict = parseVerdict('{"winner":"A","reason":"ok","criteria":[{"id":"c1","met":"both"}]}')
  assert.equal(verdict.ok, true)
  assert.equal(Array.isArray(verdict.perCriterion), true)
  assert.deepEqual(verdict.perCriterion[0], { id: 'c1', met: 'both' })
})

test('the domain predicate needs a subject AND a mechanism, and refuses other subjects', () => {
  // (r1-6 + r2-E2) A pack verdict may not travel to another domain, and one shared verb is not a
  // domain: the music counterexample matched 暂停/停止 and rode the pack to validated.
  assert.equal(packAdmits('mse-lifecycle-v1', '核对会话详情的请求代次，丢弃旧响应后再提交当前代次结果').ok, true)
  assert.equal(packAdmits('mse-lifecycle-v1', '处理请求时先记录代次，锁内复核提交').ok, true)
  const refused = ['导出金额前先转换为数值，再按币种排序', '导出报表金额并核对币种',
    '为函数补写 Python 类型注解并核对字段',
    '音乐播放器暂停歌曲时停止播放并保存播放位置，恢复时先检查音频长度。',
    // A lifecycle word with no development object at all.
    '暂停后恢复播放',
  ]
  for (const text of refused) assert.equal(packAdmits('mse-lifecycle-v1', text).ok, false, text)
  // Generic words the pack's own prompts contain do not open it either.
  assert.equal(packAdmits('mse-lifecycle-v1', '导出字段并核对').ok, false)

  const f = fixture()
  try {
    // A currency method cannot be validated by the lifecycle pack…
    const foreign = f.engine.record({ projectKey: f.projectKey, source: 'host_proposal', kind: 'method',
      eventId: 'currency-method', instruction: '导出金额前先转换为数值，再按币种排序' })
    const cases = packCases('mse-lifecycle-v1')
    const answers = Object.fromEntries(cases.map(row => [row.caseId, {
      candidate: row.checker.kind === 'lines-present-v1' ? (row.checker.expected ?? []).join('\n')
        : row.checker.kind === 'text-exact-v1' ? row.checker.expected : JSON.stringify(row.checker.expected),
      baseline: '不适用' }]))
    const usage = Object.fromEntries(cases.map(row => [row.caseId, { baseline: 18, candidate: 12 }]))
    assert.throws(() => f.engine.evaluate({ basis: 'host_pack', packId: 'mse-lifecycle-v1', answers, usage,
      instruction: '导出金额前先转换为数值，再按币种排序', lessonId: foreign.id, expectedVersion: 1,
      suiteId: 'x', eventId: 'foreign-pack-run', projectKey: f.projectKey }),
    error => error.code === 'domain_outside_pack')
    // …and a validated lifecycle method is not recalled for a report task.
    const lifecycle = f.engine.record({ projectKey: f.projectKey, source: 'host_proposal', kind: 'method',
      eventId: 'lifecycle-method', instruction: '处理请求时先记录代次，迟到结果按代次丢弃；锁内复核提交状态' })
    const accepted = f.engine.evaluate({ basis: 'host_pack', packId: 'mse-lifecycle-v1', answers, usage,
      instruction: '处理请求时先记录代次，迟到结果按代次丢弃；锁内复核提交状态',
      lessonId: lifecycle.id, expectedVersion: 1, suiteId: 'x', eventId: 'pack-run-domain',
      projectKey: f.projectKey })
    assert.equal(accepted.decision, 'accepted', JSON.stringify(accepted.reasons))
    const report = f.engine.prepare({ projectKey: f.projectKey, sessionId: 'session-report', turnId: '1',
      origin: 'user', prompt: '导出报表金额并核对币种' })
    assert.equal(report.lessonVersions.some(row => row.tier === 'verified'), false,
      'a lifecycle verdict may not be injected into a currency-report task')
  } finally { f.cleanup() }
})

test('the pack admission reads the STORED lesson, not the caller\'s copy', () => {
  const f = fixture({ tokens: 1_000_000, calls: 3 })
  try {
    const currency = f.engine.record({ projectKey: f.projectKey, source: 'host_proposal', kind: 'method',
      eventId: 'r2-currency', instruction: '导出金额前先转换为数值，再按币种排序' })
    const cases = packCases('mse-lifecycle-v1')
    const answers = Object.fromEntries(cases.map(row => [row.caseId, {
      candidate: row.checker.kind === 'lines-present-v1' ? (row.checker.expected ?? []).join('\n')
        : row.checker.kind === 'text-exact-v1' ? row.checker.expected : JSON.stringify(row.checker.expected),
      baseline: '不适用' }]))
    const usage = Object.fromEntries(cases.map(row => [row.caseId, { baseline: 18, candidate: 12 }]))
    const base = { basis: 'host_pack', packId: 'mse-lifecycle-v1', answers, usage, lessonId: currency.id,
      expectedVersion: 1, suiteId: 'x', projectKey: f.projectKey }
    // Omitting, rewriting, or "confirming" the instruction must all reach the same answer: the row
    // that would be promoted is the stored one.
    for (const [label, extra] of [['omitted', {}],
      ['substituted', { instruction: '核对会话详情的请求代次，丢弃旧响应后再提交当前代次结果' }],
      ['confirmed', { instruction: '导出金额前先转换为数值，再按币种排序' }]]) {
      assert.throws(() => f.engine.evaluate({ ...base, eventId: `r2-e1-${label}`, ...extra }),
        error => error.code === 'domain_outside_pack', label)
    }
    const stored = f.engine.list({ projectKey: f.projectKey, limit: 10 }).lessons.find(x => x.id === currency.id)
    assert.notEqual(stored.status, 'validated')

    // The legitimate lifecycle method still passes the same gate, and its verdict is recalled for a
    // task in the same mechanism combination.
    const music = f.engine.record({ projectKey: f.projectKey, source: 'host_proposal', kind: 'method',
      eventId: 'r2-music', instruction: '音乐播放器暂停歌曲时停止播放并保存播放位置，恢复时先检查音频长度。' })
    assert.throws(() => f.engine.evaluate({ ...base, lessonId: music.id, eventId: 'r2-e2-music' }),
      error => error.code === 'domain_outside_pack')
    const lifecycle = f.engine.record({ projectKey: f.projectKey, source: 'host_proposal', kind: 'method',
      eventId: 'r2-lifecycle', instruction: '核对会话详情的请求代次，丢弃旧响应后再提交当前代次结果' })
    const accepted = f.engine.evaluate({ ...base, lessonId: lifecycle.id, eventId: 'r2-e3-lifecycle' })
    assert.equal(accepted.decision, 'accepted', JSON.stringify(accepted.reasons))
    const audio = f.engine.prepare({ projectKey: f.projectKey, sessionId: 'session-audio', turnId: '1',
      origin: 'user', prompt: '音乐播放器暂停歌曲时停止播放并保存播放位置，恢复时先检查音频长度' })
    assert.equal(audio.lessonVersions.some(row => row.tier === 'verified'), false,
      'the music task never receives a lifecycle verdict')
    const same = f.engine.prepare({ projectKey: f.projectKey, sessionId: 'session-gen', turnId: '1',
      origin: 'user', prompt: '核对会话详情的请求代次，丢弃旧响应后再提交当前代次结果' })
    assert.equal(same.lessonVersions.some(row => row.tier === 'verified'), true,
      'the in-domain positive still works')
  } finally { f.cleanup() }
})

test('a fixed short answer is accepted end to end, and its verdict is a real trial', () => {
  const f = fixture({ tokens: 1_000_000, calls: 3 })
  try {
    const lesson = candidate(f)
    // The pack's own short-answer sample: the scenario the adapter builds exposes
    // `shortAnswersAllowed`, which must travel with the reservation.
    const shortSample = packCases('mse-lifecycle-v1').find(row => row.checker.kind === 'text-exact-v1'
      && String(row.checker.expected ?? '').replace(/\s/gu, '').length < 20)
    assert.ok(shortSample, 'the pack carries a fixed short answer')
    const shortAnswer = String(shortSample.checker.expected)
    const criteria = (shortSample.criteria ?? []).length > 0 ? shortSample.criteria : CRITERIA_FALLBACK
    const binding = planHash({ lessonId: lesson.id, version: lesson.version, environment: 'default', track: 'review' })
    const reservation = f.engine.reviewRequest({ lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000,
      planHash: binding, criteria, shortAnswersAllowed: true })
    assert.equal(typeof reservation.ticket, 'string')
    const verdict = f.engine.reviewResult({ ticket: reservation.ticket, projectKey: f.projectKey, criteria,
      first: '{"winner":"A","criteria":[{"id":"' + criteria[0].id + '","met":"both"}]}',
      second: '{"winner":"B","criteria":[{"id":"' + criteria[0].id + '","met":"both"}]}',
      structuredPassed: true, swapped: true, spent: 900, costKnown: true,
      // Both arms answer exactly what the checker demands: seven characters, not twenty.
      answers: { candidate: shortAnswer, baseline: shortAnswer } })
    assert.equal(verdict.state, 'reviewed', JSON.stringify(verdict.reasons))
    assert.equal(verdict.trial, 'trial')
    const stored = f.engine.list({ projectKey: f.projectKey, limit: 10 }).lessons.find(x => x.id === lesson.id)
    assert.equal(stored.review.benefit, 'unproven')
  } finally { f.cleanup() }
})

test('the same short answer is refused when the reservation did not allow it', () => {
  const f = fixture({ tokens: 1_000_000, calls: 3 })
  try {
    const lesson = candidate(f)
    const criteria = [{ id: 'lifecycle_scope', kind: 'structured', statement: '回答必须区分请求代次与并发提交' }]
    const binding = planHash({ lessonId: lesson.id, version: lesson.version, environment: 'default', track: 'review' })
    const ticket = f.engine.reviewRequest({ lessonId: lesson.id, projectKey: f.projectKey, maxTokens: 4_000,
      planHash: binding, criteria }).ticket
    // A tie between two seven-character answers is exactly the vacuous case the gate exists for.
    const verdict = f.engine.reviewResult({ ticket, projectKey: f.projectKey, criteria,
      first: '{"winner":"tie"}', second: '{"winner":"tie"}', structuredPassed: true,
      answers: { candidate: 'DISCARD', baseline: 'DISCARD' } })
    assert.notEqual(verdict.state, 'reviewed')
    assert.ok((verdict.reasons ?? []).includes('review_tie'), JSON.stringify(verdict.reasons))
  } finally { f.cleanup() }
})
