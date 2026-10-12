// Stage 3b: the natural expiry of a trial licence, its one-and-only renewal window, and the
// evidence watermark that decides whether a renewal may be paid for at all.
//
// The gap this locks (audit STAGE3-ACCEPTANCE problem 2): `evaluateLessons` stopped RECALLING a trial
// after 14 days, but nothing in the product recognised the expiry itself. The lesson stayed
// `trial.state=trial`, the same `autoPlanRegister` binding stayed a duplicate for ever, and even if a
// version had been minted there was no evidence bar — one historical adoption could have paid for a
// fresh review every 14 days for ever, and a repeated timer, a settings event or a restart could
// have replayed it.
//
// Everything here drives the REAL core, the REAL adapter and the REAL scheduler on a temporary state
// root with a controllable clock. The only stand-ins are the provider transport (four deterministic
// answers: two arms and two judge passes) and the host route/source the adapter is given, which is
// exactly how the audit's own stage-3b probe drives the same code. No assertion is relaxed to make
// the product look greener: the "no evidence" cases assert ZERO physical calls, and the
// "evidence already spent" cases assert that a later expiry buys nothing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningEngine } from '../src/index.mjs'
import { createAutoValidation } from '../adapters/dsh/auto.mjs'
import { getDomainPack, packCases, packCaseCriteriaHash, packScenarioHash } from '../src/domains.mjs'

const DAY = 86_400_000
/** The trial TTL the product ships: 14 days. */
const TTL = 14 * DAY
const PACK_ID = 'mse-lifecycle-v1'
const PACK = getDomainPack(PACK_ID)
const SAMPLE = packCases(PACK_ID)[0]
const CRITERIA = SAMPLE.criteria
const ROUTE = Object.freeze({ provider: 'synthetic-renewal', model: 'fixture', reasoningEffort: 'max' })
const PROJECT = '/synthetic/renewal-project'
const IN_DOMAIN = '处理请求时先记录当前代次，提交前核对代次，迟到的旧代次结果必须丢弃。'

/**
 * One engine + the real automatic driver on a fresh state root.
 *
 * `mode` is the stand-in provider's behaviour for the NEXT call: `success` (the legal tie that grants
 * a trial), `unknown_cost` (text but no usage), `abstain` (no winner) or `model_unknown` (a provider
 * error whose cost nobody measured). None of the three failure modes may ever be replayed on the
 * same evidence.
 */
function fixture(label, { tokens = 40_000, calls = 8 } = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), `mse-renewal-${label}-`))
  let now = Date.UTC(2030, 0, 1)
  let engine = null
  let scheduler = null
  let mode = 'success'
  let adoptions = 0
  let reflections = 0
  let sequence = 0
  let enabledFlag = true
  let busyFlag = false
  const physical = []
  const source = Object.freeze({ kind: 'turn', projectKey: PROJECT, sessionId: `renewal-${label}`, turnId: '1', route: ROUTE })
  const make = () => new LearningEngine({ stateRoot, adapterId: 'dsh', now: () => now,
    evaluationTokensPerDay: tokens, evaluationCallsPerDay: calls })
  const scenario = () => ({ suite: { packId: PACK_ID, version: PACK.version }, packId: PACK_ID,
    packVersion: PACK.version, caseId: SAMPLE.caseId, criteria: CRITERIA,
    scenarioHash: packScenarioHash(PACK_ID, SAMPLE.caseId),
    // The per-CASE criteria hash is what a reservation freezes (3a); the whole-pack hash could never
    // bind one experiment.
    criteriaHash: packCaseCriteriaHash(PACK_ID, SAMPLE.caseId), shortAnswersAllowed: true,
    arm: system => ({ system, prompt: JSON.stringify({ kind: 'arm' }) }),
    judge: (_left, _right, pass) => ({ system: 'judge', prompt: JSON.stringify({ kind: 'judge', pass }),
      // The host's own ledger of which ARM each label carried in this pass: the adapter sorts the two
      // judge passes by it and only a real swap counts as a cross-check.
      labels: { armA: pass === 0 ? 'A' : 'B', armB: pass === 0 ? 'B' : 'A' } }) })
  const start = () => createAutoValidation({ engine, context: scenario, objectiveContext: () => null,
    now: () => now, source: () => source, route: () => ROUTE,
    enabled: () => enabledFlag, busy: () => busyFlag,
    callModel: async (request, ticket) => {
      // A renewal is still the ORIGINAL execution: same provider, model and reasoning effort.
      assert.deepEqual(request.route, ROUTE, 'every call keeps the original route and reasoning effort')
      const kind = JSON.parse(request.prompt).kind
      // Whose money is this? The ticket names the reservation, and the reservation names the lesson —
      // so a test can count the calls of ONE lesson without being confused by another candidate.
      const job = (engine.store.read().jobs ?? []).find(row => row.ticket === ticket)
      physical.push({ at: now, kind, mode, lessonId: job?.lessonId ?? null })
      if (mode === 'model_unknown') throw Object.assign(new Error('synthetic unknown usage'), { code: 'model_unknown' })
      if (kind === 'arm') return mode === 'unknown_cost' ? { text: 'DISCARD' } : { text: 'DISCARD', tokens: 20 }
      const text = JSON.stringify(mode === 'abstain' ? { winner: null, reason: 'insufficient evidence' }
        : { winner: 'tie', criteria: CRITERIA.map(row => ({ id: row.id, met: 'both' })) })
      return mode === 'unknown_cost' ? { text } : { text, tokens: 20 }
    } })
  engine = make()
  const record = () => engine.record({ projectKey: PROJECT, source: 'host_proposal', kind: 'method',
    eventId: `renewal-${label}:${++sequence}`,
    // Distinct topic terms per row (the same sentence would be one hypothesis): still inside the
    // registered pack's domain, which is what the review admission reads.
    instruction: `${IN_DOMAIN.slice(0, -1)}，合成编号${sequence}。` })
  const id = record().id
  scheduler = start()
  const lesson = () => engine.store.read().lessons.find(row => row.id === id)
  const lessonById = target => engine.store.read().lessons.find(row => row.id === target)
  const feed = () => engine.autoCandidates({ limit: 32 }).rows.map(row => ({ ...row, projectKey: PROJECT }))
  const scan = async () => { const before = physical.length
    const result = await scheduler.scan(feed())
    return { ...result, physical: physical.length - before } }
  // The host's real wake-up: maintenance and the automatic pass, which is exactly what a settings
  // change, a turn end or the bounded timer does.
  const tick = async () => ({ maintenance: engine.maintainLearning({}), scan: await scan() })
  /** Earn the trial through the real chain: one frozen-scenario review run (four physical calls). */
  const grant = async () => { await scan()
    assert.equal(lesson().trial?.state, 'trial', 'the fixture must really earn a trial')
    return lesson().trial.at }
  /** A real adoption: prepare → accept (adopted+1) → settle with an unknown outcome. */
  const adopt = () => {
    adoptions += 1
    const sessionId = `adoption-${label}-${adoptions}`
    const prepared = engine.prepare({ projectKey: PROJECT, sessionId, turnId: '1', origin: 'user', prompt: IN_DOMAIN })
    assert.ok(prepared.lessons.includes(id), 'the live trial must be recallable before it is adopted')
    const accepted = engine.accept({ receipt: prepared.receipt, lessonIds: [id] })
    assert.equal(engine.accept({ receipt: prepared.receipt, lessonIds: [id] }).duplicate, true,
      'a repeated accept is a duplicate, not a second adoption')
    engine.complete({ projectKey: PROJECT, sessionId, turnId: '1', outcome: 'unknown' })
    return accepted
  }
  /**
   * A real trial for one row through the core's own review contract (no scheduler): used by the
   * backlog case, where twenty licences must expire in the same instant.
   */
  const grantDirect = target => {
    const row = lessonById(target)
    const plan = engine.autoPlanRegister({ lessonId: target, version: row.version,
      environment: row.environment ?? 'default', track: 'review',
      source: { kind: 'turn', sessionId: `backlog-${target}`, turnId: '1', route: ROUTE },
      suite: { packId: PACK_ID, version: PACK.version }, criteria: CRITERIA }).plan
    const reserved = engine.reviewRequest({ projectKey: PROJECT, lessonId: target, expectedVersion: row.version,
      maxTokens: 4_000, planHash: plan.planHash, queueKey: plan.queueKey, packId: PACK_ID,
      caseId: SAMPLE.caseId, scenarioHash: packScenarioHash(PACK_ID, SAMPLE.caseId),
      criteriaHash: packCaseCriteriaHash(PACK_ID, SAMPLE.caseId), criteria: CRITERIA })
    assert.ok(reserved.ticket, 'the fixture must really reserve the review it is about to settle')
    // The two answers are the prose pair the review protocol expects unless a pack declares that a
    // fixed short answer is the whole answer: an empty pair is refused, so it could grant nothing.
    return engine.reviewResult({ ticket: reserved.ticket, projectKey: PROJECT, planHash: plan.planHash,
      first: '{"winner":"A"}', second: '{"winner":"B"}', swapped: true, structuredPassed: true,
      answers: { candidate: '先记录代次，迟到结果按代次丢弃，并说明如何处理旧结果。',
        baseline: '直接处理即可，不需要额外记录任何东西，也不用核对代次。' },
      criteria: CRITERIA, route: ROUTE, judge: 'synthetic-renewal/fixture', spent: 80, costKnown: true })
  }
  const restart = async () => { await scheduler.dispose(); engine = make(); engine.recoverAutoPlans(); scheduler = start() }
  const stateBytes = () => readFileSync(join(stateRoot, 'lessons-v1.json'), 'utf8')
  /** The store document's own revision counter: how many times it was really rewritten. */
  const revision = () => JSON.parse(stateBytes()).revision
  /**
   * Emulate a document written BEFORE the evidence watermark existed — the migration case the review
   * named. Only the field this build added is removed; no evidence is fabricated and no gate is
   * bypassed, and the assertion is that the product becomes MORE conservative, not less.
   */
  const dropWatermark = target => {
    const path = join(stateRoot, 'lessons-v1.json')
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    const row = doc.lessons.find(item => item.id === target)
    assert.ok(row?.evidenceWatermark, 'the fixture must really have a watermark to drop')
    delete row.evidenceWatermark
    writeFileSync(path, JSON.stringify(doc))
  }
  /** One trusted host failure observation, as the host reports it (stable event identity). */
  const observeFailure = (index, taskClass = 'lifecycle-submit') => {
    const observed = engine.observeProblem({ projectKey: PROJECT, sessionId: `problem-session-${index}`,
      turnId: `${index}`, eventId: `host-tool-failure-${label}-${index}`, kind: 'tool_failure',
      source: 'host_event', toolName: 'bash', failureCode: 'tool_nonzero_exit', taskClass })
    assert.equal(observed.ok, true)
    return observed.id
  }
  /** The real reflection path: two independent failures → one candidate BOUND to that problem. */
  const reflectCandidate = (problemId, instruction = IN_DOMAIN) => {
    const row = engine.problemStatus({ projectKey: PROJECT, limit: 32 }).rows.find(item => item.id === problemId)
    assert.ok(row, 'the fixture must really observe a problem before reflecting')
    // Every reflection is its own turn identity: one problem, one attempt, never a replay of an
    // earlier ticket (the core dedupes reflections on the source turn).
    reflections += 1
    const prepared = engine.reflectionRequest({ projectKey: PROJECT, sessionId: `reflect-${label}-${reflections}`,
      turnId: '1', outcome: 'failed', taskSummary: `合成任务：提交结算前需要核对当前代次（第 ${reflections} 次复核）。`,
      resultSummary: `合成结果：工具非零退出，任务未完成，根因未确定（第 ${reflections} 次复核）。`, problemId,
      evidenceRevision: row.evidenceRevision })
    assert.ok(prepared.ticket, `the fixture must really reserve the reflection: ${JSON.stringify(prepared)}`)
    const learned = engine.reflectionResult({ ticket: prepared.ticket, result: { instruction } })
    assert.ok(learned.id, 'the reflection must really produce the candidate')
    return learned.id
  }
  /**
   * The REAL bounded timer, captured instead of installed: `start` runs one pass immediately (exactly
   * as the host's startup does) and the captured callback is the interval the host would have fired.
   */
  const startTimer = () => {
    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    let callback = null
    globalThis.setInterval = fn => { callback = fn; return { unref() {} } }
    globalThis.clearInterval = () => {}
    let started = null
    try { started = scheduler.start(feed, { intervalMs: 60_000 }) }
    finally { globalThis.setInterval = realSet; globalThis.clearInterval = realClear }
    const drain = async () => { for (let round = 0; round < 12; round += 1) await new Promise(setImmediate) }
    return { started, drain, fire: async () => { callback(); await drain() } }
  }
  return { stateRoot, id, lesson, lessonById, record, feed, scan, tick, grant, grantDirect, adopt, restart,
    stateBytes, physical, callsFor: target => physical.filter(row => row.lessonId === target).length,
    observeFailure, reflectCandidate, startTimer, dropWatermark, revision,
    engine: () => engine, scheduler: () => scheduler, now: () => now,
    at: value => { now = value }, advance: ms => { now += ms }, mode: value => { mode = value },
    setBusy: value => { busyFlag = value }, setEnabled: value => { enabledFlag = value },
    // The host RAISING its allowance is the real event a parked plan waits for (a settings change):
    // the engine re-reads this field on every paid step, exactly as it does in production.
    setTokens: value => { engine.evaluationTokensPerDay = value },
    reviewPlans: () => engine.autoPlans().filter(plan => plan.track === 'review'),
    cleanup: async () => { await scheduler.dispose().catch(() => {}); rmSync(stateRoot, { recursive: true, force: true }) } }
}

test('the 14-day boundary retires the licence exactly once, and no evidence means no cost', async () => {
  const f = fixture('boundary')
  try {
    const at = await f.grant()
    const version = f.lesson().version
    const before = f.physical.length
    // One millisecond before the boundary the licence is still live: the recall path offers it, and
    // maintenance must NOT retire it (a version minted early would be a licence nobody lost).
    f.at(at + TTL - 1)
    const early = f.engine().maintainLearning({})
    assert.equal(early.retired, 0, 'a licence inside its TTL is never retired')
    assert.equal(f.lesson().version, version)
    assert.equal(f.lesson().trial.state, 'trial')
    assert.equal(f.lesson().renewal ?? null, null)
    const offered = f.engine().prepare({ projectKey: PROJECT, sessionId: 'boundary-live', turnId: '1',
      origin: 'user', prompt: IN_DOMAIN })
    assert.ok(offered.lessons.includes(f.id), 'the trial is recallable until the exact boundary')
    f.engine().cancel({ receipt: offered.receipt })
    // AT the boundary (not after it) the licence is over.
    f.at(at + TTL)
    const expired = f.engine().prepare({ projectKey: PROJECT, sessionId: 'boundary-expired', turnId: '1',
      origin: 'user', prompt: IN_DOMAIN })
    assert.equal(expired.lessons.includes(f.id), false, 'an expired trial is no longer offered')
    assert.equal(expired.diagnostics.trialExpired, 1)
    await f.tick()
    await f.tick()
    const retired = f.lesson()
    assert.equal(retired.version, version + 1, 'the expiry mints exactly one new version')
    assert.notEqual(retired.trial?.state, 'trial', 'the old licence is terminated, not left live')
    assert.equal(retired.trial.reason, 'trial_expired')
    assert.equal(retired.renewal.state, 'waiting_evidence', 'no adoption means nothing to renew for')
    assert.equal(retired.renewal.reason, 'none')
    // A restart is not a second expiry: the same licence is never retired twice.
    await f.restart()
    await f.tick()
    assert.equal(f.lesson().version, version + 1, 'a rebuild never mints a second version')
    assert.equal(f.physical.length, before, 'no evidence means zero reservations and zero calls')
  } finally { await f.cleanup() }
})

test('a repeated maintenance pass and an independent engine rebuild never pay for the same licence twice', async () => {
  const f = fixture('repeat')
  try {
    const at = await f.grant()
    const version = f.lesson().version
    f.at(at + TTL)
    const first = f.engine().maintainLearning({})
    const second = f.engine().maintainLearning({})
    assert.equal(first.retired, 1)
    assert.equal(first.rows.length, 1)
    assert.equal(second.retired, 0, 'the licence is gone; a second pass has nothing to retire')
    assert.equal(f.lesson().version, version + 1)
    // An engine built over the same document is a restart: the retired licence stays retired.
    const rebuilt = new LearningEngine({ stateRoot: f.stateRoot, adapterId: 'dsh', now: f.now })
    assert.equal(rebuilt.maintainLearning({}).retired, 0)
    assert.equal(f.lesson().version, version + 1)
    assert.equal(f.lesson().renewal.state, 'waiting_evidence')
  } finally { await f.cleanup() }
})

test('one historical adoption pays for exactly one renewal, never for the next 14 days', async () => {
  const f = fixture('old-adoption')
  try {
    const at = await f.grant()
    f.advance(DAY)
    f.adopt()
    f.at(at + TTL)
    const before = f.physical.length
    await f.tick()
    assert.equal(f.physical.length - before, 4, 'the authorised renewal is exactly one review run')
    const renewed = f.lesson()
    assert.equal(renewed.trial.state, 'trial', 'the renewal grants a fresh trial licence')
    assert.equal(renewed.renewal.state, 'consumed', 'the evidence the run was signed for is spent')
    assert.equal(renewed.review.state, 'reviewed')
    assert.equal(renewed.review.benefit, 'unproven', 'a renewal never claims a proven benefit')
    assert.equal(renewed.review.packId, PACK_ID, 'the renewal is judged inside the registered domain')
    assert.equal(renewed.trial.packId, PACK_ID, 'and the licence keeps that domain')
    assert.equal(renewed.status, 'tested', 'a renewal never validates the method')
    assert.equal(renewed.adopted, 1, 'and it never invents an adoption')
    // The SAME adoption must not pay again: the next expiry has no new evidence.
    const version = renewed.version
    const paid = f.physical.length
    f.at(renewed.trial.at + TTL)
    await f.tick()
    await f.restart()
    await f.tick()
    f.advance(TTL)
    await f.tick()
    assert.equal(f.physical.length, paid, 'a consumed adoption can never loop into a second payment')
    assert.equal(f.lesson().version, version + 1, 'the second expiry is still retired exactly once')
    assert.equal(f.lesson().renewal.state, 'waiting_evidence')
    assert.equal(f.lesson().renewal.reason, 'none')
    assert.notEqual(f.lesson().trial?.state, 'trial')
  } finally { await f.cleanup() }
})

test('a new adoption buys exactly one round even under concurrent wake-ups and a restart', async () => {
  const f = fixture('new-adoption')
  try {
    const at = await f.grant()
    f.advance(DAY)
    f.adopt()
    f.at(at + TTL)
    await f.tick()
    assert.equal(f.lesson().trial.state, 'trial')
    // A SECOND real adoption at the new version: this is the only thing that may reopen payment.
    f.advance(DAY)
    f.adopt()
    assert.equal(f.lesson().adopted, 2)
    f.at(f.lesson().trial.at + TTL)
    const before = f.physical.length
    // A settings change, a turn end and the bounded timer can all wake up together; the scheduler is
    // serial by construction, so the renewal is still ONE round.
    await Promise.all([f.tick(), f.tick(), f.tick()])
    await f.restart()
    await f.tick()
    assert.equal(f.physical.length - before, 4, 'the new adoption buys one review run, not three')
    assert.equal(f.lesson().trial.state, 'trial')
    assert.equal(f.lesson().renewal.state, 'consumed')
    assert.ok(f.reviewPlans().every(plan => plan.source.sessionId === 'renewal-new-adoption'),
      'every plan keeps the original source session')
    assert.ok(f.reviewPlans().every(plan => plan.source.turnId === '1'), 'and the original turn')
    assert.ok(f.reviewPlans().every(plan => plan.source.projectKey === PROJECT), 'and the original project')
  } finally { await f.cleanup() }
})

for (const mode of ['unknown_cost', 'abstain', 'model_unknown']) {
  test(`a renewal that failed as ${mode} consumes the attempt identity it was signed for`, async () => {
    const f = fixture(mode)
    try {
      const at = await f.grant()
      f.advance(DAY)
      f.adopt()
      f.mode(mode)
      f.at(at + TTL)
      const before = f.physical.length
      await f.tick()
      const attempted = f.physical.length - before
      assert.ok(attempted > 0, 'the authorised renewal really reached the provider')
      assert.notEqual(f.lesson().trial?.state, 'trial', 'a failed renewal grants nothing')
      assert.equal(f.lesson().renewal.state, 'consumed', 'the evidence is spent even when the run failed')
      // Success on a later day must not replay the same evidence: neither the clock moving, nor a
      // restart, nor the next 14 days may buy another attempt for it.
      f.mode('success')
      f.advance(DAY)
      await f.tick()
      await f.restart()
      await f.tick()
      f.advance(TTL)
      await f.tick()
      assert.equal(f.physical.length - before, attempted, 'the same evidence is never replayed')
      assert.notEqual(f.lesson().trial?.state, 'trial', 'and it never quietly grants a trial later')
    } finally { await f.cleanup() }
  })
}

for (const reason of ['manual', 'regression', 'user_correction']) {
  test(`a ${reason} withdrawal is never reopened by a natural expiry`, async () => {
    const f = fixture(`withdraw-${reason}`)
    try {
      const at = await f.grant()
      f.advance(DAY)
      f.adopt()
      f.engine().withdrawTrial({ projectKey: PROJECT, lessonId: f.id,
        expectedVersion: f.lesson().version, reason })
      const version = f.lesson().version
      const before = f.physical.length
      f.at(at + TTL)
      await f.tick()
      await f.restart()
      f.advance(TTL)
      await f.tick()
      assert.equal(f.lesson().version, version, 'an operator withdrawal is not an expiry to retire')
      assert.equal(f.lesson().trial.state, 'withdrawn')
      assert.equal(f.lesson().trial.reason, reason, 'the human reason is conserved, not overwritten')
      assert.equal(f.lesson().renewal ?? null, null, 'no renewal window is opened for a withdrawal')
      assert.equal(f.physical.length, before, 'a withdrawal never buys a renewal')
    } finally { await f.cleanup() }
  })
}

test('a ticket reserved before the expiry cannot re-grant the licence, before or after a restart', async () => {
  const f = fixture('late-ticket')
  try {
    const at = await f.grant()
    const stored = f.lesson()
    const plan = f.reviewPlans().find(row => row.version === stored.version)
    f.at(at + TTL - 600_000)
    const reserved = f.engine().reviewRequest({ projectKey: PROJECT, lessonId: f.id, expectedVersion: stored.version,
      maxTokens: 4_000, planHash: plan.planHash, queueKey: plan.queueKey, packId: PACK_ID,
      caseId: SAMPLE.caseId, scenarioHash: packScenarioHash(PACK_ID, SAMPLE.caseId),
      criteriaHash: packCaseCriteriaHash(PACK_ID, SAMPLE.caseId), criteria: CRITERIA })
    assert.ok(reserved.ticket, 'the ticket really exists before the licence expires')
    // The core answers a stale submission BOTH ways (a refusal row, or a thrown ticket rejection),
    // so the honest assertion is the one an operator sees: it is never accepted.
    const submit = () => {
      try {
        return f.engine().reviewResult({ ticket: reserved.ticket, projectKey: PROJECT,
          planHash: plan.planHash, first: '{"winner":"A"}', second: '{"winner":"B"}', swapped: true,
          structuredPassed: true, answers: { candidate: 'DISCARD', baseline: 'APPLY' }, criteria: CRITERIA,
          route: ROUTE, judge: 'synthetic-renewal/fixture', spent: 80, costKnown: true })
      } catch (error) { return { ok: false, code: error.code ?? 'thrown' } }
    }
    const version = f.lesson().version
    f.at(at + TTL)
    f.engine().maintainLearning({})
    assert.equal(f.lesson().version, version + 1)
    const first = submit()
    assert.equal(first.ok, false, `a ticket signed for the retired licence cannot re-grant it: ${JSON.stringify(first)}`)
    assert.ok(['review_plan_stale', 'review_ticket_rejected'].includes(first.code), first.code)
    assert.notEqual(f.lesson().trial?.state, 'trial')
    await f.restart()
    const second = submit()
    assert.equal(second.ok, false, `a restart does not resurrect it: ${JSON.stringify(second)}`)
    assert.ok(['review_plan_stale', 'review_ticket_rejected'].includes(second.code), second.code)
    assert.notEqual(f.lesson().trial?.state, 'trial')
  } finally { await f.cleanup() }
})

test('read surfaces never maintain, never write and never spend', async () => {
  const f = fixture('reads')
  try {
    const at = await f.grant()
    const version = f.lesson().version
    const paid = f.physical.length
    f.at(at + TTL)
    const before = f.stateBytes()
    // Every read surface an operator or the settings page has: status, list, diagnose, the feed, the
    // plan rows, the review "why" planner and the scheduler's own status card.
    f.engine().status()
    f.engine().list({ projectKey: PROJECT, limit: 10 })
    f.engine().diagnose({ projectKey: PROJECT, prompt: IN_DOMAIN })
    f.engine().autoCandidates({ limit: 32 })
    f.engine().autoPlans()
    f.scheduler().status()
    assert.equal(f.engine().reviewPlan({ lessonId: f.id, projectKey: PROJECT, maxTokens: 4_000 }).allowed, true,
      'the expired-but-unretired licence is still reviewable: only maintenance retires it')
    assert.equal(f.stateBytes(), before, 'no read may rewrite the store')
    assert.equal(f.lesson().version, version, 'a read is not a maintenance pass')
    assert.equal(f.lesson().trial.state, 'trial', 'the licence is still live until something maintains')
    assert.equal(f.physical.length, paid, 'a read never reaches the provider')
    // And the real write path does retire it, exactly once.
    assert.equal(f.engine().maintainLearning({}).retired, 1)
  } finally { await f.cleanup() }
})

test('more expired licences than one window are drained in bounded passes, once each', async () => {
  const f = fixture('backlog')
  try {
    const ids = []
    // Twenty REAL trials, four per day so the shared evaluation budget can really pay for them.
    for (let index = 0; index < 20; index += 1) {
      if (index > 0 && index % 4 === 0) f.advance(DAY)
      const lesson = f.record()
      ids.push(lesson.id)
      const verdict = f.grantDirect(lesson.id)
      assert.equal(verdict.trial, 'trial', 'each fixture row really earns a trial')
    }
    const paid = f.physical.length
    const latest = Math.max(...ids.map(id => f.lessonById(id).trial.at))
    f.at(latest + TTL)
    const expired = ids.filter(id => f.lessonById(id).trial.at + TTL <= f.now())
    assert.equal(expired.length, 20, 'every licence is past its own TTL')
    const seen = new Set()
    const passes = []
    for (let pass = 0; pass < 8; pass += 1) {
      const result = f.engine().maintainLearning({})
      assert.ok(result.retired <= 8, 'one maintenance pass is bounded by its window')
      assert.equal(result.rows.length, result.retired, 'every retired licence is reported once')
      for (const row of result.rows) {
        assert.equal(seen.has(row.lessonId), false, 'a licence is retired exactly once across passes')
        seen.add(row.lessonId)
      }
      passes.push(result.retired)
      if (result.retired === 0) break
    }
    assert.equal(seen.size, 20, 'the fair rotation drains the whole backlog')
    assert.ok(passes.filter(count => count > 0).length >= 3, `bounded passes, got ${passes.join(',')}`)
    assert.equal(f.engine().maintainLearning({}).retired, 0, 'and then it stops')
    assert.equal(f.physical.length, paid, 'maintenance itself never calls the provider')
    for (const id of ids) {
      const row = f.lessonById(id)
      assert.equal(row.version, 2, 'each licence mints exactly one new version')
      assert.equal(row.trial.state, 'withdrawn')
      assert.equal(row.trial.reason, 'trial_expired')
      assert.equal(row.renewal.state, 'waiting_evidence', 'no adoption means no renewal anywhere')
    }
  } finally { await f.cleanup() }
})

test('independent evidence bound to the lesson buys one renewal, and nothing older does', async () => {
  const f = fixture('independent')
  try {
    // Two independent host failures → the real reflection links ONE candidate to that problem.
    f.observeFailure(1)
    const problemId = f.observeFailure(2)
    const lessonId = f.reflectCandidate(problemId)
    const verdict = f.grantDirect(lessonId)
    assert.equal(verdict.trial, 'trial', 'the fixture must really earn a trial')
    // The problem evidence that CREATED the lesson predates the review attempt, so it is NOT new
    // evidence: a bar that only compared revisions could have paid for the same old failures again.
    f.at(f.lessonById(lessonId).review.at + TTL)
    const retired = f.engine().maintainLearning({})
    assert.equal(retired.retired, 1)
    assert.equal(f.lessonById(lessonId).renewal.state, 'waiting_evidence')
    assert.equal(f.lessonById(lessonId).renewal.reason, 'none')
    const paid = f.callsFor(lessonId)
    await f.scan()
    assert.equal(f.callsFor(lessonId), paid, 'the evidence that created the lesson never buys a renewal')
    // ONE genuinely new independent failure, recorded AFTER the attempt was signed, is the bar — and
    // the window is re-decided on the real maintenance pass rather than staying a dead end.
    f.observeFailure(3)
    const reopened = f.engine().maintainLearning({})
    assert.equal(reopened.reopened, 1, 'a waiting window is re-decided from the CURRENT facts')
    assert.equal(reopened.retired, 0)
    const window = f.lessonById(lessonId).renewal
    assert.equal(window.state, 'authorised')
    assert.equal(window.reason, 'independent_evidence')
    assert.equal(window.evidence.kind, 'problem')
    assert.equal(window.evidence.problemId, problemId)
    assert.equal(window.evidence.revision, 3)
    await f.scan()
    assert.equal(f.callsFor(lessonId) - paid, 4, 'the independent evidence buys exactly one review run')
    const renewed = f.lessonById(lessonId)
    assert.equal(renewed.trial.state, 'trial')
    assert.equal(renewed.renewal.state, 'consumed', 'and the observation it was signed for is spent')
    assert.ok((renewed.evidenceWatermark.problems ?? []).some(row => row.problemId === problemId),
      'the bounded audit records the identity the attempt consumed')
    // No new observation between now and the next expiry: nothing is paid again.
    const attempts = f.callsFor(lessonId)
    f.at(renewed.trial.at + TTL)
    await f.tick()
    await f.restart()
    await f.tick()
    f.advance(TTL)
    await f.tick()
    assert.equal(f.callsFor(lessonId), attempts, 'the same problem revision is never replayed')
    assert.equal(f.lessonById(lessonId).renewal.state, 'waiting_evidence')
  } finally { await f.cleanup() }
})

test('an abstained independent-evidence renewal consumes that observation for good', async () => {
  const f = fixture('independent-abstain')
  try {
    f.observeFailure(11)
    const problemId = f.observeFailure(12)
    const lessonId = f.reflectCandidate(problemId)
    f.grantDirect(lessonId)
    const worked = f.lessonById(lessonId).review.at
    f.at(worked + TTL)
    f.engine().maintainLearning({})
    assert.equal(f.lessonById(lessonId).renewal.state, 'waiting_evidence')
    f.observeFailure(13)
    f.mode('abstain')
    const reopened = f.engine().maintainLearning({})
    assert.equal(reopened.reopened, 1)
    assert.equal(f.lessonById(lessonId).renewal.state, 'authorised')
    const before = f.callsFor(lessonId)
    await f.scan()
    assert.ok(f.callsFor(lessonId) - before > 0, 'the authorised renewal really reached the provider')
    assert.notEqual(f.lessonById(lessonId).trial?.state, 'trial', 'an abstention grants nothing')
    assert.equal(f.lessonById(lessonId).renewal.state, 'consumed')
    // The SAME observation can never be signed for again: the window is spent, and no later clock or
    // restart re-opens it (a new window would need a new expired licence, which does not exist).
    const spent = f.callsFor(lessonId)
    f.advance(DAY)
    await f.tick()
    await f.restart()
    await f.tick()
    f.advance(TTL)
    await f.tick()
    assert.equal(f.callsFor(lessonId), spent)
    assert.equal(f.lessonById(lessonId).renewal.state, 'consumed')
  } finally { await f.cleanup() }
})

test('a problem in another project, or a user correction, is never renewal evidence', async () => {
  const f = fixture('foreign-evidence')
  try {
    f.observeFailure(1)
    const problemId = f.observeFailure(2)
    const lessonId = f.reflectCandidate(problemId)
    f.grantDirect(lessonId)
    const worked = f.lessonById(lessonId).review.at
    f.at(worked + TTL)
    const retired = f.engine().maintainLearning({})
    assert.equal(retired.retired, 1)
    assert.equal(f.lessonById(lessonId).renewal.state, 'waiting_evidence')
    const paid = f.callsFor(lessonId)
    // A failure in ANOTHER project is a different scope, and a user correction is a different signal:
    // neither is bound to this lesson's method, project and environment.
    f.engine().observeProblem({ projectKey: '/synthetic/other-project', sessionId: 'foreign', turnId: '1',
      eventId: 'host-tool-failure-foreign-1', kind: 'tool_failure', source: 'host_event', toolName: 'bash',
      failureCode: 'tool_nonzero_exit', taskClass: 'lifecycle-submit' })
    const foreign = f.engine().observeProblem({ projectKey: '/synthetic/other-project', sessionId: 'foreign',
      turnId: '2', eventId: 'host-tool-failure-foreign-2', kind: 'tool_failure', source: 'host_event',
      toolName: 'bash', failureCode: 'tool_nonzero_exit', taskClass: 'lifecycle-submit' })
    assert.notEqual(foreign.id, problemId)
    const correction = f.engine().observeProblem({ projectKey: PROJECT, sessionId: 'correction-session',
      turnId: '1', eventId: 'host-correction-1', kind: 'user_correction', source: 'direct_user',
      summary: '用户指出上一次的做法不对' })
    assert.equal(correction.ok, true)
    assert.equal(f.engine().maintainLearning({}).reopened, 0, 'no foreign or conversational evidence counts')
    assert.equal(f.lessonById(lessonId).renewal.state, 'waiting_evidence')
    await f.scan()
    assert.equal(f.callsFor(lessonId), paid)
  } finally { await f.cleanup() }
})

test('the formal verifier identity is the only source of a verifier renewal reason', async () => {
  const { verifierIdentityMoved } = await import('../src/index.mjs')
  const hash = seed => seed.repeat(64).slice(0, 64)
  const lesson = { id: 'lesson_aaaaaaaaaaaaaaaaaaaaaaaa', version: 2 }
  const watermark = { adopted: 0, at: 1, version: 1,
    verifier: { packId: 'p', version: 1, scenarioHash: hash('a'), criteriaHash: hash('b') } }
  const case_ = { caseId: 'p.1' }
  const registry = {
    pack: () => ({ packId: 'p', version: 1 }),
    cases: () => [case_],
    scenarioHash: () => hash('a'),
    criteriaHash: () => hash('b'),
  }
  // Still the registered oracle: no reason, and never a guess.
  assert.equal(verifierIdentityMoved(lesson, watermark, registry), null)
  // The registry moved on: verifiable, and named with the identity that was replaced.
  const bumped = { ...registry, pack: () => ({ packId: 'p', version: 2 }) }
  assert.deepEqual(verifierIdentityMoved(lesson, watermark, bumped),
    { packId: 'p', fromVersion: 1, toVersion: 2, fromScenarioHash: hash('a'), fromCriteriaHash: hash('b'),
      scenarioMoved: true })
  // Same version number, but the case's criteria were edited under it: a different oracle wearing the
  // same number, and the record names BOTH the frozen hashes and the fact that the case moved.
  const edited = { ...registry, criteriaHash: () => hash('c') }
  const drift = verifierIdentityMoved(lesson, watermark, edited)
  assert.equal(drift.fromVersion, 1)
  assert.equal(drift.toVersion, 1)
  assert.equal(drift.fromCriteriaHash, hash('b'))
  assert.equal(drift.fromScenarioHash, hash('a'))
  assert.equal(drift.scenarioMoved, true)
  // A frozen scenario the registry no longer holds is NOT a verifiable move: there is nothing to
  // compare, and a conservative migration never guesses a new verifier identity.
  const removed = { ...registry, cases: () => [] }
  assert.equal(verifierIdentityMoved(lesson, watermark, removed), null)
  // Nothing verifiable: no domain claim, or a pack the registry does not hold. Never invented.
  assert.equal(verifierIdentityMoved(lesson, { adopted: 0, at: 1, version: 1 }, registry), null)
  assert.equal(verifierIdentityMoved(lesson, watermark, { ...registry, pack: () => undefined }), null)
  // CONSUMED: an attempt signed after the move froze the NEW identity, so the same move is not a
  // reason again — the verifier source cannot replay itself any more than the adoption source can.
  const consumed = { adopted: 0, at: 9, version: 2,
    verifier: { packId: 'p', version: 2, scenarioHash: hash('a'), criteriaHash: hash('b') } }
  assert.equal(verifierIdentityMoved(lesson, consumed, bumped), null)
  // A legacy lesson with no watermark falls back to its OWN review row's frozen domain, and the same
  // consumption rule applies: an unchanged registry is not a reason.
  const legacy = { id: lesson.id, version: 2, review: { state: 'reviewed', at: 5, planHash: hash('d'),
    scenarioHash: hash('a'), criteriaHash: hash('b'), baselineHash: hash('e'), candidateHash: hash('f'),
    agreement: 'neutral_safe', benefit: 'unproven', reasons: [], source: 'auto', packId: 'p', packVersion: 1 } }
  assert.equal(verifierIdentityMoved(legacy, undefined, registry), null)
  assert.deepEqual(verifierIdentityMoved(legacy, undefined, bumped),
    { packId: 'p', fromVersion: 1, toVersion: 2, fromScenarioHash: hash('a'), fromCriteriaHash: hash('b'),
      scenarioMoved: true })
})

test('a scan that maintains drops the stale feed row instead of registering for a retired version', async () => {
  const f = fixture('stale-feed')
  try {
    const at = await f.grant()
    const paid = f.physical.length
    f.at(at + TTL)
    // The host builds its feed BEFORE the scan runs, so the row it hands over still says version 1.
    const stale = f.feed()
    assert.equal(stale.length, 1)
    assert.equal(stale[0].version, 1)
    const result = await f.scheduler().scan(stale)
    assert.equal(result.maintenance.retired, 1, 'the pass really retired the licence')
    assert.equal(result.registered, 0, 'no plan is registered for the edition that just disappeared')
    assert.equal(result.advanced, 0)
    // The plan that already delivered version 1's review stays as history and is untouched; what must
    // NOT exist is any NEW work for the edition that just disappeared.
    assert.deepEqual(f.engine().autoPlans().map(plan => [plan.version, plan.stage]), [[1, 'done']])
    assert.equal(f.physical.length, paid, 'and no provider call')
    assert.equal(f.lesson().version, 2)
    // The next wake-up carries the fresh row: the new edition may not even REGISTER a review plan
    // while its window has no evidence, so there is nothing to retry and nothing to revive later.
    const next = await f.scan()
    assert.equal(next.registered, 0)
    assert.deepEqual(f.engine().autoPlans().map(plan => [plan.version, plan.stage]), [[1, 'done']])
    const reasons = (f.scheduler().status().events ?? []).map(row => row.code)
    assert.ok(reasons.includes('renewal_waiting_evidence'),
      `the wait states why nothing is registered: ${JSON.stringify(reasons)}`)
    await f.scan()
    assert.equal(f.engine().autoPlans().length, 1, 'and a repeated scan creates no work')
    assert.equal(f.physical.length, paid)
  } finally { await f.cleanup() }
})

test('maintenance respects the switch, the foreground and disposal', async () => {
  const f = fixture('gates')
  try {
    const at = await f.grant()
    const version = f.lesson().version
    const paid = f.physical.length
    f.at(at + TTL)
    const untouched = f.stateBytes()
    // A person owns the session right now: the whole pass stands down, exactly as paid work does.
    f.setBusy(true)
    const foreground = await f.scan()
    assert.equal(foreground.ok, true)
    assert.equal(foreground.maintenance, null, 'no maintenance write while the foreground is active')
    // The licence is untouched: no new version, no renewal window, and the trial is still live state.
    assert.equal(f.lesson().version, version)
    assert.equal(f.lesson().renewal ?? null, null)
    assert.equal(f.lesson().trial.state, 'trial')
    assert.equal(f.physical.length, paid, 'and a foreground pass buys nothing')
    f.setBusy(false)
    // A foreground pass may still REGISTER free work (that is not maintenance), so the baseline for
    // "nothing runs at all" is taken after it.
    const settled = f.stateBytes()
    // The automatic switch being off means nothing runs at all.
    f.setEnabled(false)
    const off = await f.scheduler().scan(f.feed())
    assert.equal(off.ok, false)
    assert.equal(f.stateBytes(), settled)
    assert.equal(f.lesson().version, version)
    assert.equal(f.lesson().renewal ?? null, null)
    f.setEnabled(true)
    // Disposal is final.
    await f.scheduler().dispose()
    const disposed = await f.scheduler().scan(f.feed())
    assert.equal(disposed.code, 'disposed')
    assert.equal(f.stateBytes(), settled)
    assert.equal(f.lesson().version, version)
    assert.equal(f.lesson().renewal ?? null, null)
  } finally { await f.cleanup() }
})

test('the real bounded timer retires the licence with no explicit maintenance call', async () => {
  const f = fixture('timer')
  try {
    const at = await f.grant()
    const paid = f.physical.length
    f.at(at + TTL)
    const timer = f.startTimer()
    assert.equal(timer.started.ok, true)
    // `start` runs its own first pass, exactly as the host's startup does.
    await timer.drain()
    assert.equal(f.lesson().version, 2)
    assert.equal(f.lesson().trial.reason, 'trial_expired')
    assert.equal(f.lesson().renewal.state, 'waiting_evidence')
    // ...and the interval the host would fire later never retires it a second time.
    await timer.fire()
    assert.equal(f.lesson().version, 2)
    assert.equal(f.physical.length, paid, 'neither pass bought anything: there was no new evidence')
  } finally { await f.cleanup() }
})

test('maintenance is bounded, writes nothing twice and keeps the whole document valid', async () => {
  const f = fixture('bounds')
  try {
    const at = await f.grant()
    f.at(at + TTL)
    const first = f.engine().maintainLearning({ limit: 1 })
    assert.equal(first.retired, 1)
    assert.equal(first.rows.length, 1, 'the audit row is bounded to the window that really ran')
    const bytes = f.stateBytes()
    assert.equal(f.engine().maintainLearning({}).retired, 0)
    assert.equal(f.stateBytes(), bytes, 'a pass with nothing to do does not rewrite the document')
    // The stored rows pass the shipped validator: every read re-validates the whole document.
    assert.equal(typeof f.engine().status(), 'object')
    const row = f.lesson()
    assert.equal(row.renewal.version, row.version, 'the window belongs to the version it minted')
    assert.equal(row.evidenceWatermark.adopted, 0, 'the first attempt consumed zero adoptions')
    assert.equal(row.evidenceWatermark.version, 1)
  } finally { await f.cleanup() }
})

test('independent evidence is a monotone revision bar, never a wall clock', async () => {
  const f = fixture('revision-bar')
  try {
    f.observeFailure(21)
    const problemId = f.observeFailure(22)
    const lessonId = f.reflectCandidate(problemId)
    f.grantDirect(lessonId)
    const worked = f.lessonById(lessonId).review.at
    // The new failure lands in the SAME MILLISECOND as the attempt that consumed revision 2: only a
    // counter can tell these apart, and it must.
    f.observeFailure(23)
    assert.equal(f.now(), worked, 'the observation really shares the attempt millisecond')
    assert.equal(f.engine().maintainLearning({}).retired, 0)
    f.at(worked + TTL)
    const retired = f.engine().maintainLearning({})
    assert.equal(retired.retired, 1)
    assert.equal(f.lessonById(lessonId).renewal.state, 'authorised')
    assert.equal(f.lessonById(lessonId).renewal.reason, 'independent_evidence')
    assert.equal(f.lessonById(lessonId).renewal.evidence.problemId, problemId)
    assert.equal(f.lessonById(lessonId).renewal.evidence.revision, 3)
  } finally { await f.cleanup() }
})

test('a clock that moves backwards cannot buy the same independent evidence twice', async () => {
  const f = fixture('rollback')
  try {
    f.observeFailure(31)
    const problemId = f.observeFailure(32)
    const lessonId = f.reflectCandidate(problemId)
    f.grantDirect(lessonId)
    const worked = f.lessonById(lessonId).review.at
    f.at(worked + 20 * DAY)
    f.observeFailure(33)
    // The clock now moves BACKWARDS, to the day the licence expired, where the renewal is signed.
    f.at(worked + TTL)
    const first = await f.tick()
    assert.equal(first.maintenance.retired, 1)
    assert.equal(f.lessonById(lessonId).renewal.state, 'consumed')
    assert.equal(f.lessonById(lessonId).renewal.attempts, 1, 'the licence signed exactly one attempted renewal')
    const paid = f.callsFor(lessonId)
    assert.ok(paid > 0, 'the authorised renewal really ran')
    assert.equal(f.lessonById(lessonId).trial.state, 'trial', 'and earned a fresh licence')
    // Day 28 (the licence the reviewed attempt earned expires): the SAME revision 3 is not new
    // evidence, however the clock behaved in between.
    f.at(worked + 28 * DAY)
    const second = await f.tick()
    assert.equal(second.maintenance.retried, 0, 'a rolled-back bar never re-authorises')
    assert.equal(f.lessonById(lessonId).renewal.state, 'waiting_evidence')
    assert.equal(f.callsFor(lessonId), paid, 'and it buys nothing')
  } finally { await f.cleanup() }
})

test('a failed renewal consumes its evidence, and genuinely new evidence buys a bounded new attempt', async () => {
  const f = fixture('retry')
  try {
    f.observeFailure(41)
    const problemId = f.observeFailure(42)
    const lessonId = f.reflectCandidate(problemId)
    f.grantDirect(lessonId)
    const worked = f.lessonById(lessonId).review.at
    f.observeFailure(43)
    f.at(worked + TTL)
    f.mode('abstain')
    await f.tick()
    const first = f.callsFor(lessonId)
    assert.ok(first >= 4, 'the authorised renewal really reached the provider')
    assert.equal(f.lessonById(lessonId).renewal.state, 'consumed')
    assert.equal(f.lessonById(lessonId).renewal.attempts, 1)
    assert.notEqual(f.lessonById(lessonId).trial?.state, 'trial', 'an abstention grants nothing')
    // The SAME evidence is spent for good: no clock, no restart and no scan may replay it.
    f.advance(DAY)
    await f.tick()
    await f.restart()
    await f.tick()
    assert.equal(f.callsFor(lessonId), first, 'the same revision is spent for good')
    assert.equal(f.lessonById(lessonId).renewal.attempts, 1)
    // GENUINELY new independent evidence: one bounded new attempt, under its own execution identity.
    f.observeFailure(44)
    const reopened = f.engine().maintainLearning({})
    assert.equal(reopened.retried, 1, 'new evidence reopens a failed window exactly once')
    assert.equal(reopened.retired, 0)
    assert.equal(f.lessonById(lessonId).renewal.state, 'authorised')
    assert.equal(f.lessonById(lessonId).renewal.attempts, 1, 'the counter advances only when an attempt is signed')
    f.mode('success')
    await f.scan()
    assert.equal(f.callsFor(lessonId) - first, 4, 'the new attempt is one review run')
    const plans = f.engine().autoPlans().filter(plan => plan.track === 'review' && plan.lessonId === lessonId)
    assert.equal(plans.length, 2, 'the new attempt is a NEW plan identity; the settled one stays as history')
    assert.notEqual(plans[0].planHash, plans[1].planHash)
    assert.equal(f.lessonById(lessonId).renewal.attempts, 2)
    assert.equal(f.lessonById(lessonId).trial.state, 'trial', 'the second attempt earned a licence')
    // ...and the very same revision 4 can never be signed for again.
    const second = f.callsFor(lessonId)
    f.advance(DAY)
    await f.tick()
    assert.equal(f.callsFor(lessonId), second)
  } finally { await f.cleanup() }
})

test('one expired licence signs at most a bounded number of renewal attempts', async () => {
  const f = fixture('attempt-cap')
  try {
    f.observeFailure(61)
    const problemId = f.observeFailure(62)
    const lessonId = f.reflectCandidate(problemId)
    f.grantDirect(lessonId)
    const worked = f.lessonById(lessonId).review.at
    f.at(worked + TTL)
    f.mode('abstain')
    // Attempt 1 at the expiry itself, then one bounded new attempt per genuinely new revision.
    for (const index of [63, 64, 65, 66, 67]) {
      f.observeFailure(index)
      await f.tick()
    }
    const window = f.lessonById(lessonId).renewal
    assert.equal(window.state, 'consumed')
    assert.equal(window.attempts, 3, 'the cap is a real bound on paid attempts')
    const paid = f.callsFor(lessonId)
    assert.equal(paid, 3 * 4, 'each authorised attempt was exactly one review run')
    // Beyond the cap even a brand-new revision buys nothing: the window is spent for this licence.
    f.observeFailure(68)
    const after = f.engine().maintainLearning({})
    assert.equal(after.retried, 0)
    await f.scan()
    assert.equal(f.callsFor(lessonId), paid)
    assert.equal(f.lessonById(lessonId).renewal.attempts, 3)
  } finally { await f.cleanup() }
})

test('a document written before the watermark adopts its current evidence conservatively', async () => {
  const f = fixture('legacy-bar')
  try {
    f.observeFailure(51)
    const problemId = f.observeFailure(52)
    const lessonId = f.reflectCandidate(problemId)
    f.grantDirect(lessonId)
    const worked = f.lessonById(lessonId).review.at
    f.dropWatermark(lessonId)
    f.at(worked + TTL)
    const retired = f.engine().maintainLearning({})
    assert.equal(retired.retired, 1, JSON.stringify(retired))
    // The evidence that already existed is ADOPTED as the bar, never paid for...
    assert.equal(f.lessonById(lessonId).renewal.state, 'waiting_evidence',
      JSON.stringify({ renewal: f.lessonById(lessonId).renewal, watermark: f.lessonById(lessonId).evidenceWatermark }))
    assert.equal(f.lessonById(lessonId).evidenceWatermark.adopted, 0)
    assert.ok(f.lessonById(lessonId).evidenceWatermark.problems
      .some(row => row.problemId === problemId && row.revision === 2), 'the current revision becomes the bar')
    const paid = f.callsFor(lessonId)
    await f.scan()
    assert.equal(f.callsFor(lessonId), paid)
    // ...and only a later independent observation (revision 3) may authorise a renewal.
    f.observeFailure(53)
    assert.equal(f.engine().maintainLearning({}).reopened, 1)
    assert.equal(f.lessonById(lessonId).renewal.state, 'authorised')
    assert.equal(f.lessonById(lessonId).renewal.evidence.revision, 3)
  } finally { await f.cleanup() }
})

/**
 * The registry half, run the way the independent probe runs it: TWO real trees and THREE real
 * processes. The licence is earned against the pack as released; the maintenance that must recognise a
 * DRIFTED oracle runs against a copy whose registered criteria changed while the version number and
 * the scenario hash did not. A same-version criteria drift used to make the maintenance transaction
 * throw (`invalid_renewal_record`), and a consumed window used to swallow the registry path entirely.
 */
test('a criteria drift under the same pack version opens one renewal, and never replays', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mse-renewal-drift-'))
  try {
    const before = join(root, 'before')
    const after = join(root, 'after')
    for (const dir of [before, after]) {
      mkdirSync(dir, { recursive: true })
      cpSync(new URL('../src', import.meta.url), join(dir, 'src'), { recursive: true })
    }
    const original = readFileSync(join(after, 'src/domains.mjs'), 'utf8')
    const drifted = original.replace('不得声称旧代次结果被应用、部分应用或合并。',
      '不得声称旧代次结果被应用、部分应用、合并或改写。')
    assert.notEqual(drifted, original, 'the drift patch must really change the registered criteria')
    writeFileSync(join(after, 'src/domains.mjs'), drifted)
    const runner = `import { LearningEngine } from './src/index.mjs'
import { getDomainPack, packCases, packCaseCriteriaHash, packScenarioHash } from './src/domains.mjs'
const [phase, stateRoot, offset] = process.argv.slice(2)
const DAY = 86_400_000, BASE = Date.UTC(2030, 0, 1), PACK_ID = 'mse-lifecycle-v1'
let now = BASE
const pack = getDomainPack(PACK_ID), sample = packCases(PACK_ID)[0], criteria = sample.criteria
const PROJECT = '/synthetic/drift-project'
const route = { provider: 'synthetic-drift', model: 'fixture', reasoningEffort: 'max' }
const engine = new LearningEngine({ stateRoot, adapterId: 'dsh', now: () => now,
  evaluationTokensPerDay: 40000, evaluationCallsPerDay: 8 })
const id = phase === 'earn'
  ? engine.record({ projectKey: PROJECT, source: 'host_proposal', kind: 'method', eventId: 'drift-lesson',
      instruction: '处理请求时先记录当前代次，提交前核对代次，迟到的旧代次结果必须丢弃。' }).id
  : engine.store.read().lessons[0].id
const lesson = () => engine.store.read().lessons.find(row => row.id === id)
const attempt = () => {
  const row = lesson()
  const plan = engine.autoPlanRegister({ lessonId: id, version: row.version,
    environment: row.environment ?? 'default', track: 'review',
    source: { kind: 'turn', sessionId: 'drift-session', turnId: '1', route },
    suite: { packId: PACK_ID, version: pack.version }, criteria }).plan
  const reserved = engine.reviewRequest({ projectKey: PROJECT, lessonId: id, expectedVersion: row.version,
    maxTokens: 4000, planHash: plan.planHash, queueKey: plan.queueKey, packId: PACK_ID, caseId: sample.caseId,
    scenarioHash: packScenarioHash(PACK_ID, sample.caseId),
    criteriaHash: packCaseCriteriaHash(PACK_ID, sample.caseId), criteria })
  if (reserved.ticket === undefined) return { refused: reserved.code ?? 'no_ticket' }
  return engine.reviewResult({ ticket: reserved.ticket, projectKey: PROJECT, planHash: plan.planHash,
    first: '{"winner":"A"}', second: '{"winner":"B"}', swapped: true, structuredPassed: true,
    answers: { candidate: '先记录代次，迟到结果按代次丢弃，并说明如何处理旧结果。',
      baseline: '直接处理即可，不需要额外记录任何东西，也不用核对代次。' },
    criteria, route, judge: 'synthetic-drift/fixture', spent: 80, costKnown: true })
}
const out = { phase, version: lesson().version,
  scenarioHash: packScenarioHash(PACK_ID, sample.caseId),
  criteriaHash: packCaseCriteriaHash(PACK_ID, sample.caseId) }
if (phase === 'earn') out.earned = attempt().trial
else {
  now = BASE + Number(offset) * DAY
  const retired = engine.maintainLearning({})
  out.retired = retired.retired
  out.renewal = lesson().renewal ?? null
  if (phase === 'maintain-and-sign') { out.signed = attempt().trial; out.afterSign = lesson().renewal }
  else { out.retried = engine.maintainLearning({}).retried; out.after = lesson().renewal ?? null }
}
process.stdout.write(JSON.stringify(out))
`
    for (const dir of [before, after]) writeFileSync(join(dir, 'runner.mjs'), runner)
    const stateRoot = join(root, 'state')
    const run = (dir, phase, offset) => JSON.parse(execFileSync(process.execPath, ['runner.mjs', phase, stateRoot, offset],
      { cwd: dir, encoding: 'utf8' }))
    const earned = run(before, 'earn', '0')
    assert.equal(earned.earned, 'trial', 'the fixture must really earn a licence against the released pack')
    const signed = run(after, 'maintain-and-sign', '14')
    assert.equal(signed.retired, 1, 'the expiry is recognised in the drifted tree')
    assert.equal(signed.renewal.state, 'authorised')
    assert.equal(signed.renewal.reason, 'verifier_identity')
    assert.equal(signed.renewal.evidence.fromVersion, signed.renewal.evidence.toVersion,
      'the version number did NOT move')
    assert.equal(signed.renewal.evidence.scenarioMoved, true, 'the frozen criteria identity did')
    assert.equal(signed.renewal.evidence.fromCriteriaHash, earned.criteriaHash,
      'the record keeps the criteria identity the attempt was signed against')
    assert.notEqual(signed.criteriaHash, earned.criteriaHash, 'and the registry really drifted')
    assert.equal(signed.signed, 'trial', 'the drifted oracle buys exactly one bounded renewal')
    assert.equal(signed.afterSign.state, 'consumed')
    assert.equal(signed.afterSign.attempts, 1)
    // A NEW PROCESS on the same drifted tree: the identity it already consumed is not a reason again.
    const again = run(after, 'maintain-again', '29')
    assert.equal(again.retried, 0, 'the consumed drifted identity never replays')
    assert.equal(again.renewal.state, 'waiting_evidence')
    assert.equal(again.renewal.reason, 'none')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a watermark at capacity converges, waits explicitly, and still rewards a real new revision', async () => {
  const f = fixture('capacity')
  try {
    // NINE independent problems, each really observed twice and each really linked to the SAME
    // candidate by its own reflection — the shape the independent capacity probe built. The bounded
    // watermark can hold eight identities, so the ninth is a capacity question, not a bookkeeping one.
    const target = f.lesson()
    const instruction = target.instruction
    const bound = []
    for (let n = 1; n <= 9; n += 1) {
      if (n > 1) f.advance(DAY)
      const taskClass = `lifecycle-case-${n}`
      f.observeFailure(`${n}a`, taskClass)
      const problem = f.observeFailure(`${n}b`, taskClass)
      const linked = f.reflectCandidate(problem, instruction)
      assert.equal(linked, f.id, 'every reflection links its problem to the same candidate')
      bound.push({ problem, taskClass })
    }
    assert.equal(new Set(bound.map(row => row.problem)).size, 9)
    await f.grant()
    const worked = f.lesson().trial.at
    // The expiry recognises the licence, records the bounded bar, and says WHY it is waiting.
    f.at(worked + TTL)
    const retired = f.engine().maintainLearning({})
    assert.equal(retired.retired, 1)
    assert.equal(retired.authorised, 0)
    assert.equal(retired.waitingEvidence, 1)
    assert.equal(retired.capacityWaiting, 1)
    assert.equal(f.lesson().renewal.state, 'waiting_evidence')
    assert.equal(f.lesson().renewal.capacityWait, true, 'the wait on capacity is explicit')
    assert.equal(f.lesson().evidenceWatermark.problems.length, 8, 'the bar itself stays bounded')
    // IDLE CONVERGENCE: nothing new happened, so nothing may be rewritten — not by a repeated pass, not
    // by a restart. A saturated baseline that re-offers its extra identity every minute would rewrite
    // the document for ever (zero cost, but a write every scan).
    const settled = f.stateBytes()
    assert.equal(f.engine().maintainLearning({}).retired, 0)
    assert.equal(f.engine().maintainLearning({}).retired, 0)
    assert.equal(f.stateBytes(), settled, 'an idle saturated pass writes nothing')
    const paid = f.callsFor(f.id)
    // The SCAN path is a write path of its own (phase 2's bounded consideration cursor), so what is
    // asserted here is that maintenance adds NOTHING to it: one revision bump for the cursor, while
    // the lesson, its bar and its window all stay exactly as they were — and no provider call.
    const before = f.revision()
    await f.scan()
    assert.equal(f.revision() - before, 1, 'the scan records only its bounded consideration cursor')
    assert.equal(f.callsFor(f.id), paid, 'and buys nothing')
    const stored = JSON.parse(settled).lessons[0]
    assert.equal(JSON.stringify(f.lesson().evidenceWatermark), JSON.stringify(stored.evidenceWatermark))
    assert.equal(JSON.stringify(f.lesson().renewal), JSON.stringify(stored.renewal))
    await f.restart()
    // The restart itself is a real recovery step (phase 2's `recoverAutoPlans`), so the baseline is
    // taken after it: what must not write is the maintenance pass on the same, unchanged document.
    const recovered = f.revision()
    assert.equal(f.engine().maintainLearning({}).retired, 0)
    assert.equal(f.revision(), recovered, 'a rebuild over the same document rewrites nothing either')
    // A genuinely new observation on the UNTRACKED identity moves it INTO the bounded bar: that is a
    // real change (one write), recorded as a baseline — never a payment for evidence already there.
    const trackedNow = () => f.lesson().evidenceWatermark.problems.map(row => row.problemId)
    const missing = bound.find(row => !trackedNow().includes(row.problem))
    assert.ok(missing, 'exactly one identity is outside the bounded bar')
    assert.equal(f.lesson().renewal.reason, 'none', 'and it is not a reason while it sits outside')
    // Two independent observations on THAT identity lift it into the bounded bar: a real change (one
    // write) recorded as a baseline — never a payment for evidence that already existed.
    f.observeFailure('outside-c', missing.taskClass)
    f.observeFailure('outside-d', missing.taskClass)
    const shifted = f.engine().maintainLearning({})
    assert.equal(trackedNow().includes(missing.problem), true, 'its revision now earns a place in the bar')
    assert.equal(f.lesson().renewal.state, 'waiting_evidence', 'a baseline is not a payment')
    assert.equal(shifted.authorised, 0)
    assert.equal(shifted.retried, 0)
    assert.equal(f.lesson().renewal.capacityWait, true)
    // ...and ONE more independent observation authorises exactly one bounded attempt, under its own
    // identity: the deferred identity is not stuck for ever.
    f.observeFailure('outside-e', missing.taskClass)
    const authorised = f.engine().maintainLearning({})
    assert.equal(authorised.reopened, 1)
    assert.equal(f.lesson().renewal.state, 'authorised')
    assert.equal(f.lesson().renewal.reason, 'independent_evidence')
    assert.equal(f.lesson().renewal.evidence.problemId, missing.problem)
    const paidAgain = f.callsFor(f.id)
    await f.scan()
    assert.equal(f.callsFor(f.id) - paidAgain, 4, 'the deferred identity buys one review run, once')
    assert.equal(f.lesson().renewal.state, 'consumed')
    const spent = f.callsFor(f.id)
    await f.scan()
    await f.restart()
    await f.scan()
    assert.equal(f.callsFor(f.id), spent, 'and never replays that revision')
  } finally { await f.cleanup() }
})

test('a refusal that mints no ticket consumes no evidence, and the recovery is exactly one round', async () => {
  const f = fixture('budget-refusal')
  try {
    f.observeFailure(71)
    const problemId = f.observeFailure(72)
    const lessonId = f.reflectCandidate(problemId)
    f.grantDirect(lessonId)
    const worked = f.lessonById(lessonId).review.at
    const bar = () => JSON.stringify(f.lessonById(lessonId).evidenceWatermark)
    const consumed = f.lessonById(lessonId).evidenceWatermark.problems.find(row => row.problemId === problemId)
    assert.equal(consumed.revision, 2, 'the attempt that granted the licence consumed revision 2')
    // A REAL new observation (revision 3) while the evaluation allowance is exhausted.
    f.observeFailure(73)
    f.setTokens(0)
    f.at(worked + TTL)
    await f.tick()
    const refused = f.lessonById(lessonId)
    assert.equal(refused.renewal.state, 'authorised', 'the evidence really authorises a renewal')
    assert.equal(refused.renewal.attempts, 0, 'and nothing was signed for it')
    // THE CONSUMPTION RULE: no ticket means no consumption. A maintenance pass may only adopt
    // baselines for identities the bar has never seen.
    assert.equal(bar(), JSON.stringify(f.lessonById(lessonId).evidenceWatermark), 'the bar is one object')
    assert.equal(f.lessonById(lessonId).evidenceWatermark.problems.find(row => row.problemId === problemId).revision, 2,
      'a refused pass leaves the consumed revision untouched')
    const paid = f.callsFor(lessonId)
    await f.tick()
    await f.restart()
    await f.tick()
    assert.equal(f.callsFor(lessonId), paid, 'a zero allowance buys no call')
    assert.equal(f.lessonById(lessonId).evidenceWatermark.problems.find(row => row.problemId === problemId).revision, 2,
      'and no number of refused passes consumes it either')
    // The host raises the allowance: the evidence that was never consumed is still there, and it buys
    // exactly ONE round — after which it is consumed (by the reservation, at last).
    f.setTokens(40_000)
    // The host raising the allowance is a settings write, and that is exactly what re-arms the plans a
    // budget refusal parked before scheduling the scan (the product's own `rearm` path).
    f.scheduler().rearm()
    await f.scan()
    assert.equal(f.callsFor(lessonId) - paid, 4, 'the preserved evidence buys exactly one review run')
    assert.equal(f.lessonById(lessonId).renewal.state, 'consumed')
    assert.equal(f.lessonById(lessonId).renewal.attempts, 1)
    assert.equal(f.lessonById(lessonId).evidenceWatermark.problems.find(row => row.problemId === problemId).revision, 3,
      'the signed attempt is what consumes revision 3')
    // ...and the same revision never replays.
    const after = f.callsFor(lessonId)
    await f.scan()
    await f.restart()
    await f.scan()
    assert.equal(f.callsFor(lessonId), after)
  } finally { await f.cleanup() }
})
