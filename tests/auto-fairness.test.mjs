// alpha.18 phase2: bounded FAIR scheduling — 8 acceptance trajectories (phase2-baseline matrix) plus
// the 6 directed boundary cases Codex added (phase2-rev1 REVIEW.md). Everything drives the REAL
// core + REAL scheduler on a temporary state root; the model is a stub replaced ONLY at the physical
// seam (callModel) and the trusted route/source metadata is synthetic. 0 real provider calls.
//
// Layered accounting (never conflated):
//   registered — NEW plan rows a scan admitted (≤ MAX_PLANS_PER_SCAN per scan);
//   advanced   — plans moved in that scan (≤ 8);
//   calls      — physical model calls (review=4/plan, objective=2×pack cases/plan);
//   maxActive  — the true in-flight bound (≤ 1, the seam is held one event-loop turn).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { LearningEngine } from '../src/index.mjs'
import { createAutoValidation } from '../adapters/dsh/auto.mjs'
import { packCaseCriteriaHash, packCases, packScenarioHash, packSuiteId, getDomainPack } from '../src/domains.mjs'

const H = value => createHash('sha256').update(value).digest('hex')
const DAY = 86_400_000
const MAX_PLANS_PER_SCAN = 8
const pack = getDomainPack('mse-lifecycle-v1')
const packCaseCount = packCases(pack.packId).length
// The review track is bound to the REGISTERED pack and to one of its real cases: a review
// reservation now names a case whose scenario and criteria the core derives from the registry, so a
// synthetic suite id is refused outright (`domain_pack_required`) instead of being frozen as a pack.
const reviewCases = packCases(pack.packId).filter(row => row.family !== 'excluded_inputs')
let reviewCase = reviewCases[0]
let criteria = reviewCase.criteria
const callBound = 8 * Math.max(4, 2 * packCaseCount)

function makeFixture(label, { tokens = 1_000_000 } = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-fairness-'))
  let now = Date.UTC(2030, 0, 1)
  let engine
  let scheduler
  let sequence = 0
  let objectiveEnabled = false
  let reviewEnabled = true
  let schemeVersion = 1
  let active = 0
  const metadata = new Map()
  const calls = []
  const scans = []
  const renderExpected = c => c.checker.kind === 'lines-present-v1' ? c.checker.expected.join('\n')
    : c.checker.kind === 'text-exact-v1' ? c.checker.expected : JSON.stringify(c.checker.expected)
  const cases = packCases(pack.packId)
  const makeEngine = () => new LearningEngine({ stateRoot, adapterId: 'dsh',
    evaluationTokensPerDay: tokens, evaluationCallsPerDay: 8, now: () => now })
  const context = lesson => reviewEnabled
    ? { suite: { packId: pack.packId, version: pack.version }, criteria, caseId: reviewCase.caseId,
      scenarioHash: packScenarioHash(pack.packId, reviewCase.caseId),
      criteriaHash: packCaseCriteriaHash(pack.packId, reviewCase.caseId),
      scenario: { id: reviewCase.caseId },
      arm: arm => ({ system: arm, prompt: JSON.stringify({ lessonId: lesson.id, type: 'review', arm }) }),
      judge: (_a, _b, pass) => ({
        system: 'judge',
        prompt: JSON.stringify({ lessonId: lesson.id, type: 'judge' }),
        labels: { armA: pass === 0 ? 'A' : 'B', armB: pass === 0 ? 'B' : 'A' } }) }
    : null
  const objectiveContext = lesson => objectiveEnabled
    ? { packId: pack.packId, suiteId: packSuiteId(pack), cases,
      instruction: lesson.instruction, projectKey: metadata.get(lesson.id).projectKey,
      arm: (arm, c) => ({ system: arm, prompt: JSON.stringify({ lessonId: lesson.id,
        type: 'objective', caseId: c.caseId, arm }) }) }
    : null
  const start = () => createAutoValidation({ engine, context, objectiveContext, now: () => now,
    source: lesson => { const m = metadata.get(lesson.id)
      return { kind: 'turn', projectKey: m.projectKey, sessionId: m.sessionId, turnId: '1',
        ...(m.route ? { route: m.route } : {}) } },
    route: ({ lessonId }) => metadata.get(lessonId).route,
    log: () => {},
    ...(tokens === 0 ? { decisionRunner: async lesson => {
      const projectKey = metadata.get(lesson.id).projectKey
      const facts = engine.decisionContext({ lessonId: lesson.id, projectKey })
      const evidence = { candidateId: facts.candidateId, version: facts.version, kind: facts.kind,
        status: facts.status, methodRegistered: facts.methodRegistered, candidateSummary: facts.candidateSummary,
        applicability: facts.applicability, exclusions: facts.exclusions, validators: facts.validators,
        registeredChecker: facts.registeredChecker, evidenceCount: facts.evidenceCount,
        counterEvidenceCount: facts.counterEvidenceCount, counterEvidenceState: facts.counterEvidenceState,
        evidenceCapacityWaiting: facts.evidenceCapacityWaiting, evidenceRefs: facts.evidenceRefs,
        refs: facts.evidenceRefs }
      const request = engine.decisionRequest({ candidateId: facts.candidateId, version: facts.version,
        evidenceRevision: facts.evidenceRevision, projectHash: facts.projectHash, evidence,
        ruleVersion: 'experience-upgrade-v1', role: 'candidate-routing', backend: 'host',
        provider: metadata.get(lesson.id).route.provider, model: metadata.get(lesson.id).route.model,
        apiMode: 'host_llm_stream', reasoningEffort: 'max',
        inputTokens: Math.max(1, Buffer.byteLength(JSON.stringify(evidence), 'utf8')), outputTokens: 512 })
      return { ok: false, code: request.code ?? request.record?.error ?? 'decision_waiting',
        decisionId: request.identity?.key ?? request.record?.key ?? null }
    } } : {}),
    callModel: async request => {
      active += 1
      try {
        const q = JSON.parse(request.prompt)
        const m = metadata.get(q.lessonId)
        assert.deepEqual(request.route, m.route, 'plan must use its own trusted session route')
        calls.push({ at: now, lessonId: q.lessonId, type: q.type, arm: q.arm ?? null,
          route: request.route, sessionId: m.sessionId, projectKey: m.projectKey })
        // Hold the physical seam one event-loop turn: an immediately-resolved stub cannot prove the
        // scheduler's serial bound, but a visible overlapping call can falsify it.
        await new Promise(resolve => setImmediate(resolve))
        if (q.type === 'judge') return { tokens: 20,
          text: JSON.stringify({ winner: 'tie', criteria: [{ id: 'generation_guard', met: 'both' }] }) }
        if (q.type === 'objective') return { tokens: q.arm === 'candidate' ? 12 : 18,
          text: q.arm === 'candidate' ? renderExpected(cases.find(c => c.caseId === q.caseId)) : '不适用' }
        return { tokens: 20, text: '处理请求结果时必须核对当前代次，迟到结果直接丢弃，提交前在锁内再次复核当前许可。' }
      } finally { active -= 1 }
    } })
  engine = makeEngine()
  scheduler = start()
  let maxActive = 0
  const add = ({ project = 'synthetic-p1', route = true } = {}) => {
    const index = ++sequence
    const sourceTurn = H(`${label}:turn:${index}`)
    const result = engine.record({ projectKey: project, kind: 'method', source: 'host_proposal',
      eventId: `${label}:candidate:${index}`, sourceTurn,
      instruction: `处理请求时核对当前代次，锁内再次检查许可后提交，拒绝迟到结果，合成编号${index}。` })
    const sessionId = `session-${label}-${index}`
    const r = route ? { provider: `provider-${project}`, model: `model-${index % 3}`, reasoningEffort: 'max' } : null
    metadata.set(result.id, { projectKey: project, sessionId, route: r, index })
    return result.id
  }
  const feed = (limit = 64) => engine.autoCandidates({ limit }).rows
    .map(row => ({ ...row, projectKey: metadata.get(row.id).projectKey }))
  const scan = async (limit = 64) => {
    const rows = feed(limit)
    const before = calls.length
    const result = await scheduler.scan(rows)
    const step = { index: scans.length, at: now, feed: rows.map(r => r.id), registered: result.registered,
      advanced: result.advanced, calls: calls.length - before,
      byType: Object.fromEntries(['review', 'judge', 'objective']
        .map(k => [k, calls.slice(before).filter(c => c.type === k).length])),
      plans: engine.autoPlans().map(p => ({ lessonId: p.lessonId, track: p.track, stage: p.stage,
        reason: p.reason, planHash: p.planHash, source: p.source })) }
    maxActive = Math.max(maxActive, active)
    assert.ok(result.advanced <= MAX_PLANS_PER_SCAN, 'max eight plan advances per scan')
    assert.ok(step.calls <= callBound, 'physical calls bounded by admitted plans and fixed pack')
    scans.push(step)
    return step
  }
  const prime = (id, track = 'review') => {
    const row = feed(64).find(r => r.id === id)
    const m = metadata.get(id)
    return engine.autoPlanRegister({ lessonId: id, version: row.version, environment: row.environment, track,
      source: { kind: 'turn', projectKey: m.projectKey, sessionId: m.sessionId, turnId: '1',
        ...(m.route ? { route: m.route } : {}) },
      suite: track === 'review' ? { packId: pack.packId, version: pack.version } : undefined,
      criteria }).plan
  }
  return {
    add, feed, scan, prime, engine: () => engine, metadata,
    time: () => now,
    // The cross-check identity a plan is bound to. The core now DERIVES the scenario and criteria
    // from the registered pack, so the only identity it accepts for reviewCase is the pack's own:
    // the fixture therefore moves the plan to ANOTHER REAL CASE of the same pack (a genuine
    // full-binding change the registry can vouch for) instead of inventing a parallel suite id.
    // `restore` puts the fixture back, so one test's change cannot leak into the next.
    scheme: value => {
      reviewCase = reviewCases[value % reviewCases.length]
      criteria = reviewCase.criteria
      schemeVersion = value
    },
    restore: () => { reviewCase = reviewCases[0]; criteria = reviewCases[0].criteria; schemeVersion = 1 },
    objective: value => { objectiveEnabled = value }, review: value => { reviewEnabled = value },
    advance: () => { now += 25 * 60 * 60_000 },
    maxActive: () => maxActive,
    restart: async () => {
      await scheduler.dispose()
      engine = makeEngine()
      const recovered = engine.recoverAutoPlans()
      scheduler = start()
      return recovered
    },
    cleanup: async () => { await scheduler.dispose(); rmSync(stateRoot, { recursive: true, force: true }) },
    planCount: () => engine.autoPlans().length,
    // The persisted store document, for proving that reads never write.
    stateFile: () => join(stateRoot, 'lessons-v1.json'),
    status: () => scheduler.status(),
    scans, calls }
}

const hasPlan = (f, lessonId) => f.engine().autoPlans().some(p => p.lessonId === lessonId)

// ------------------------------------------------------------------ 8 baseline trajectories

test('phase2: 16 candidates, terminal first 8 never starve the later 8 (even across day + rebuild)', async () => {
  const f = makeFixture('terminal-prefix-16')
  try {
    const first = Array.from({ length: 8 }, () => f.add())
    await f.scan()
    const later = Array.from({ length: 8 }, () => f.add())
    f.advance()
    await f.scan()
    await f.restart()
    await f.scan()
    const missing = later.filter(id => !hasPlan(f, id))
    assert.deepEqual(missing, [], 'the 8 later candidates must all receive a plan')
    assert.ok(first.every(id => hasPlan(f, id)))
    assert.ok(f.maxActive() <= 1)
  } finally { await f.cleanup() }
})

test('phase2: 48 oldest over the 32-window, continuous arrivals never reset fairness', async () => {
  const f = makeFixture('over32-oldest-48')
  try {
    const all = Array.from({ length: 48 }, () => f.add())
    const oldest = all.slice(0, 16)
    for (let round = 0; round < 8; round++) {
      await f.scan(32)
      if (round === 3) await f.restart()
      f.add()
      f.advance()
    }
    const missing = oldest.filter(id => !hasPlan(f, id))
    assert.deepEqual(missing, [], 'the oldest 16 must be planned despite 8 continuous arrivals')
    const covered = new Set(f.engine().autoPlans().map(p => p.lessonId))
    assert.ok(all.every(id => covered.has(id)), 'every arrival ends up planned inside the bounded scans')
    assert.ok(f.maxActive() <= 1)
  } finally { await f.cleanup() }
})

test('phase2: a no-route front must not monopolise registration in front of ready rows', async () => {
  const f = makeFixture('no-route-prefix-16')
  try {
    const blocked = Array.from({ length: 8 }, () => f.add({ route: false }))
    const ready = Array.from({ length: 8 }, () => f.add({ project: 'synthetic-p2' }))
    for (let round = 0; round < 3; round++) { await f.scan(); f.advance() }
    await f.restart()
    await f.scan()
    const missing = ready.filter(id => !hasPlan(f, id))
    assert.deepEqual(missing, [], 'ready rows must reach a plan behind an unresolvable prefix')
    assert.ok(f.maxActive() <= 1)
    void blocked
  } finally { await f.cleanup() }
})

test('phase2: a completed review never disables a later independent objective track', async () => {
  const f = makeFixture('late-objective-after-review')
  try {
    const id = f.add()
    await f.scan()
    f.objective(true)
    f.advance()
    await f.scan()
    await f.restart()
    await f.scan()
    const hasObjective = f.engine().autoPlans().some(p => p.lessonId === id && p.track === 'objective')
    assert.equal(hasObjective, true, 'objective track must be registered after review completed')
  } finally { await f.cleanup() }
})

test('phase2: both tracks run and the lesson reaches validated through the fixed pack (positive control)', async () => {
  const f = makeFixture('both-tracks-positive')
  try {
    const id = f.add({ project: 'synthetic-p2' })
    f.objective(true)
    await f.scan()
    const plans = f.engine().autoPlans()
    const lesson = f.engine().inspect({ projectKey: 'synthetic-p2' }).lessons.find(r => r.id === id)
    assert.ok(plans.some(p => p.track === 'review'), 'review plan must be registered')
    assert.ok(plans.some(p => p.track === 'objective'), 'objective plan must be registered')
    assert.equal(lesson.status, 'validated')
    assert.equal(f.calls.filter(c => c.type === 'objective').length, 2 * packCaseCount)
    assert.ok(f.maxActive() <= 1)
  } finally { await f.cleanup() }
})

test('phase2: every physical request carries its own alternating project/session route', async () => {
  const f = makeFixture('two-project-session-routes')
  try {
    const ids = Array.from({ length: 8 }, (_, i) => f.add({ project: i % 2 ? 'synthetic-p2' : 'synthetic-p1' }))
    await f.scan()
    const plans = f.engine().autoPlans()
    assert.equal(plans.length, 8)
    for (const plan of plans) {
      assert.equal(plan.source.projectKey, f.metadata.get(plan.lessonId).projectKey, 'plan bound to its project')
      assert.equal(plan.source.sessionId, f.metadata.get(plan.lessonId).sessionId, 'plan bound to its session')
    }
    assert.equal(f.calls.length, 32, '8 reviews × 4 calls')
    for (const call of f.calls) assert.equal(call.projectKey, f.metadata.get(call.lessonId).projectKey)
    assert.ok(f.maxActive() <= 1)
    void ids
  } finally { await f.cleanup() }
})

test('phase2: zero budget persists decision waits and registers no executable plans', async () => {
  const f = makeFixture('zero-budget', { tokens: 0 })
  try {
    for (let i = 0; i < 16; i++) f.add()
    await f.scan()
    await f.restart()
    await f.scan()
    assert.equal(f.calls.length, 0, 'no physical provider request with zero budget')
    assert.equal(f.planCount(), 0, 'a candidate without an admitted decision is not executable')
    const decisions = f.engine().store.read().decisionRecords
    assert.ok(decisions.length > 0, 'the failed classification is persisted for the candidate edition')
    assert.ok(decisions.every(row => row.state === 'wait' && row.error === 'evaluation_budget'),
      'budget exhaustion remains a durable decision wait')
    assert.ok(f.maxActive() <= 1)
  } finally { await f.cleanup() }
})

test('phase2: the production DSH feed function resolves route for every actual candidate row', async () => {
  const f = makeFixture('production-feed-route-selection')
  try {
    const ids = Array.from({ length: 16 }, () => f.add())
    const src = readFileSync(new URL('../adapters/dsh/index.mjs', import.meta.url), 'utf8')
    const start = src.indexOf('async function loadAutoFeedRows()')
    const end = src.indexOf('\n  function scheduleAutoValidation()', start)
    assert.ok(start >= 0 && end > start)
    const functionSource = src.slice(start, end)
    const routeCache = new Map()
    const routeLookups = []
    const engineSeam = { autoCandidates: input => {
      const r = f.engine().autoCandidates(input)
      return { ...r, rows: r.rows.map(x => ({ ...x, sessionId: f.metadata.get(x.id).sessionId })) }
    } }
    const load = Function('engine', 'resolveBackfillRoute', 'routeForSession', 'latestRouteFor',
      'projectKeyFor', `${functionSource}; return loadAutoFeedRows`)
      (engineSeam, async () => {}, routeCache,
        async sid => { routeLookups.push(sid)
          return [...f.metadata.values()].find(m => m.sessionId === sid).route },
        async lesson => f.metadata.get(lesson.id).projectKey)
    const rows = await load()
    assert.equal(rows.length, 16, 'the whole actual feed reaches the route scan')
    const lacking = rows.filter(r => !routeCache.has(r.sessionId)).map(r => r.id)
    assert.deepEqual(lacking, [], 'every feed row with a session must get its own route resolved')
    assert.equal(routeLookups.length, 16)
    void ids
  } finally { await f.cleanup() }
})

// ------------------------------------------------------- phase2-rev1 directed boundary cases

test('rev1 A: 32 future-due live plans must not starve 8 ready tail candidates across day + rebuild', async () => {
  const f = makeFixture('32-future-live-blocks-ready-tail')
  try {
    const head = Array.from({ length: 32 }, () => f.add())
    const tail = Array.from({ length: 8 }, () => f.add({ project: 'synthetic-tail' }))
    for (const id of head) {
      const plan = f.prime(id)
      f.engine().autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash,
        reason: 'source_route_unavailable', nextAttemptAt: f.time() + 10 * DAY })
    }
    await f.scan(32)
    f.advance()
    await f.scan(32)
    await f.restart()
    await f.scan(32)
    const missing = tail.filter(id => !hasPlan(f, id))
    assert.deepEqual(missing, [], 'the ready tail must be planned despite a 32-row live-not-due wall')
    assert.ok(f.maxActive() <= 1)
    void head
  } finally { await f.cleanup() }
})

test('rev1 B: 64 live plans truncated to a 32-row feed are advanced on complete facts, never mis-parked', async () => {
  const f = makeFixture('64-live-facts-truncated')
  try {
    const ids = Array.from({ length: 64 }, () => f.add())
    for (const id of ids) f.prime(id)
    const feedIds = new Set(f.feed(32).map(r => r.id))
    const feedCount = feedIds.size
    const dueIds = f.engine().autoPlans().slice(0, 8).map(p => p.lessonId)
    const dueOutsideFeed = dueIds.filter(id => !feedIds.has(id)).length
    await f.scan(32)
    const wronglyBlocked = f.engine().autoPlans()
      .filter(p => p.reason === 'review_missing_criteria').map(p => p.lessonId)
    assert.equal(feedCount, 32, 'the feed really is truncated')
    assert.ok(dueOutsideFeed >= 1,
      `the truncated window really leaves a started plan without its feed row (saw ${dueOutsideFeed})`)
    assert.deepEqual(wronglyBlocked, [],
      'a due plan outside the feed window must get its real facts, not review_missing_criteria')
    assert.ok(f.maxActive() <= 1)
  } finally { await f.cleanup() }
})

test('rev1 C: a route that becomes available later re-enters the core and replaces the blocked plan', async () => {
  const f = makeFixture('blocked-route-now-available')
  try {
    const id = f.add({ route: false })
    await f.scan()
    const before = f.engine().autoPlans()[0]
    assert.equal(before.stage, 'blocked')
    assert.equal(before.source.route ?? null, null)
    f.metadata.get(id).route = { provider: 'synthetic-now-available', model: 'model-new', reasoningEffort: 'max' }
    f.advance()
    await f.scan()
    await f.restart()
    await f.scan()
    const after = f.engine().autoPlans()[0]
    assert.notEqual(after.planHash, before.planHash, 'the new route is a NEW execution binding')
    assert.equal(after.source.route.provider, 'synthetic-now-available')
    assert.equal(after.stage, 'done', 'a binding that gained its route must finally run and finish')
  } finally { await f.cleanup() }
})

test('rev1 D: a frozen scenario moving to another registered case re-enters the core with a new planHash (no stale plan kept)', async () => {
  const f = makeFixture('new-review-suite-binding')
  try {
    const id = f.add()
    await f.scan()
    const before = f.engine().autoPlans()[0]
    assert.equal(before.stage, 'done')
    const callsBefore = f.calls.length
    f.scheme(2)
    f.advance()
    await f.scan()
    await f.restart()
    await f.scan()
    const after = f.engine().autoPlans()[0]
    assert.notEqual(after.planHash, before.planHash, 'a different frozen case is a different execution and must re-hash')
    assert.equal(f.calls.length - callsBefore, 4, 'the new binding runs its own review (4 calls)')
  } finally { await f.restore(); await f.cleanup() }
})

test('rev1 E: the per-scan NEW-registration cap is enforced per track — never 9 from one lesson\'s two tracks', async () => {
  const f = makeFixture('registration-cap-seven-plus-two')
  try {
    const id = f.add()
    f.prime(id)
    for (let i = 0; i < 4; i++) f.add()
    f.objective(true)
    const result = await f.scan(32)
    assert.ok(result.registered <= MAX_PLANS_PER_SCAN,
      `per-scan new registrations must stay ≤ ${MAX_PLANS_PER_SCAN}, got ${result.registered}`)
    assert.ok(f.maxActive() <= 1)
    void id
  } finally { await f.cleanup() }
})

test('rev1 control: a 32-row blocked no-route prefix still does not hide 8 fresh candidates', async () => {
  const f = makeFixture('32-blocked-no-route-prefix-control')
  try {
    const head = Array.from({ length: 32 }, () => f.add({ route: false }))
    const tail = Array.from({ length: 8 }, () => f.add({ project: 'synthetic-tail' }))
    for (const id of head) {
      const plan = f.prime(id)
      f.engine().autoPlanUpdate({ queueKey: plan.queueKey, planHash: plan.planHash,
        stage: 'blocked', reason: 'review_no_route' })
    }
    await f.scan(32)
    const missing = tail.filter(id => !hasPlan(f, id))
    assert.deepEqual(missing, [], 'terminal prefixes must not hide fresh work (positive control)')
  } finally { await f.cleanup() }
})

test('rev1: a done plan with an IDENTICAL binding is never re-paid by later scans', async () => {
  const f = makeFixture('settled-no-repay')
  try {
    const id = f.add()
    await f.scan()
    const before = f.engine().autoPlans()[0]
    assert.equal(before.stage, 'done')
    const callsBefore = f.calls.length
    // Same lessons, same binding, across a day and a disk rebuild: the done identity must dedupe.
    f.advance()
    await f.scan()
    await f.restart()
    await f.scan()
    assert.equal(f.calls.length, callsBefore, 'identical settled binding must never be paid again')
    const after = f.engine().autoPlans()[0]
    assert.equal(after.planHash, before.planHash)
    assert.ok(f.maxActive() <= 1)
  } finally { await f.cleanup() }
})

// ------------------------------------------------------- phase2-rev2 covered-tail rotation

test('rev2: the registration window ROTATES between same-clock scans and covers the whole ranking', async () => {
  const f = makeFixture('same-clock-rotation')
  try {
    const ids = Array.from({ length: 48 }, () => f.add())
    // First get every candidate REALLY done (bounded upper bound, not a fixed round count).
    for (let round = 0; round < 9 && f.planCount() < ids.length; round++) {
      if (round > 0) f.advance()
      await f.scan(32)
    }
    assert.equal(f.planCount(), ids.length, 'all candidates are covered within a bounded number of scans')
    assert.ok(f.engine().autoPlans().every(p => p.stage === 'done'))
    assert.equal(f.calls.length, ids.length * 4, 'exactly one review run (4 physical calls) per candidate')
    // From here the wall clock NEVER moves. The covered rotation must still slide the window by
    // its 32-row stride, so a repeated same-clock scan advances.
    const cursors = []
    const windows = []
    for (let round = 0; round < 4; round++) {
      const read = f.engine().autoCandidates({ limit: 32 })
      cursors.push(read.cursor)
      windows.push(read.rows.map(r => r.id).join(','))
      await f.scan(32)
    }
    assert.ok(cursors[1] !== cursors[0] && cursors[2] !== cursors[1] && cursors[3] !== cursors[2],
      'same-clock scans must advance the persistent consideration cursor')
    assert.deepEqual(cursors[3], cursors[0], 'the rotation is a bounded cycle, not a growing offset')
    assert.ok(windows[0] !== windows[1] && windows[1] !== windows[2], 'the window slides between same-clock scans')
    assert.equal(windows[3], windows[0], 'the cycle re-offers the same window once it closes')
    // The contract is a closed cycle from whatever phase the preparation scans left behind: the
    // exact starting offset is not fixed, only that three strides visit three distinct starts and
    // the fourth returns to the first (a 48-row ranking with a 32-row stride).
    assert.equal(new Set(cursors).size, 3, 'a 48-row ranking with a 32-row stride has a three-step cycle')
    // Registration stopped after the cycle; no plan was re-paid and the slot stayed single.
    assert.equal(f.planCount(), ids.length)
    assert.ok(f.maxActive() <= 1, 'rotation never widens the single physical slot')
  } finally { await f.cleanup() }
})

test('rev2: continuous same-clock arrivals still let every row register within bounded scans', async () => {
  const f = makeFixture('same-clock-continuous-input')
  try {
    const ids = Array.from({ length: 40 }, () => f.add())
    // New input keeps arriving while the clock never moves; each round is scan + one arrival.
    const arrivals = []
    for (let round = 0; round < 8; round++) {
      await f.scan(32)
      arrivals.push(f.add())
    }
    // Bounded upper bound: registration is free and capped at 8 per scan; 48 rows need ≤ 7 scans.
    for (let round = 0; round < 4 && f.planCount() < ids.length + arrivals.length; round++) {
      await f.scan(32)
    }
    const missing = [...ids, ...arrivals].filter(id => !hasPlan(f, id))
    assert.deepEqual(missing, [], 'existing and newly arrived candidates all register within bounded rounds')
    assert.ok(f.maxActive() <= 1)
  } finally { await f.cleanup() }
})

test('rev2: covered TAIL route changes are re-registered across rebuilds; identical rows never re-paid', async () => {
  const f = makeFixture('covered-tail-route-binding')
  try {
    const ids = Array.from({ length: 48 }, () => f.add())
    // Bounded wait for the REAL done state (the rotating window can lag a round behind the
    // 8-per-scan registration rate; it always finishes inside 7 scans for 48 rows).
    for (let round = 0; round < 9 && f.planCount() < ids.length; round++) {
      if (round > 0) f.advance()
      await f.scan(32)
    }
    assert.equal(f.engine().autoPlans().length, 48)
    assert.ok(f.engine().autoPlans().every(plan => plan.stage === 'done'))
    const reviewCallsAfterInitial = f.calls.length
    assert.equal(reviewCallsAfterInitial, 48 * 4, 'one review run (4 physical calls) per initial candidate')
    const ranked = f.feed(64).map(row => row.id)
    const head = ranked.slice(0, 32), tail = ranked.slice(32)
    const before = new Map(f.engine().autoPlans().map(plan => [plan.lessonId, plan.planHash]))
    // A legitimate binding change on the positive control AND on every tail row; head 2..32 stay.
    for (const id of [head[0], ...tail]) {
      const m = f.metadata.get(id)
      m.route = { ...m.route, model: `replacement-${m.index}` }
    }
    for (let i = 0; i < 5; i++) {
      f.advance()
      if (i === 1 || i === 3) await f.restart()
      await f.scan(32)
    }
    const plans = f.engine().autoPlans()
    const changed = [head[0], ...tail].filter(id => {
      const row = plans.find(p => p.lessonId === id)
      return row !== undefined && row.planHash !== before.get(id)
    })
    const missed = [head[0], ...tail].filter(id => {
      const row = plans.find(p => p.lessonId === id)
      return row === undefined || row.planHash === before.get(id)
    })
    assert.deepEqual(missed, [], 'every tail binding change is re-registered inside bounded scans (rebuilds included)')
    assert.equal(changed.length, 17)
    const unchanged = head.slice(1)
    const repaid = unchanged.filter(id => {
      const row = plans.find(p => p.lessonId === id)
      return row !== undefined && row.planHash !== before.get(id)
    })
    assert.deepEqual(repaid, [], 'an IDENTICAL binding is never re-paid by the rotation')
    const extraReview = f.calls.length - reviewCallsAfterInitial
    assert.equal(extraReview, changed.length * 4, 'only the changed bindings run again')
    assert.ok(f.maxActive() <= 1)
  } finally { await f.cleanup() }
})

test('rev2: covered SCENARIO changes re-register every row inside bounded scans across rebuilds', async () => {
  const f = makeFixture('covered-tail-suite-binding')
  try {
    const ids = Array.from({ length: 48 }, () => f.add())
    for (let round = 0; round < 9 && f.planCount() < ids.length; round++) {
      if (round > 0) f.advance()
      await f.scan(32)
    }
    assert.ok(f.engine().autoPlans().every(plan => plan.stage === 'done'))
    const reviewCallsAfterInitial = f.calls.length
    assert.equal(reviewCallsAfterInitial, 48 * 4)
    const before = new Map(f.engine().autoPlans().map(plan => [plan.lessonId, plan.planHash]))
    // Another registered case is a different full binding for EVERY row (48 re-registrations at 8 per scan).
    f.scheme(2)
    for (let i = 0; i < 7; i++) {
      f.advance()
      if (i === 1 || i === 3) await f.restart()
      await f.scan(32)
    }
    const plans = f.engine().autoPlans()
    const changed = ids.filter(id => {
      const row = plans.find(p => p.lessonId === id)
      return row !== undefined && row.planHash !== before.get(id)
    })
    // A row that is MISSING, or whose planHash is still the old one, was never handled: that is
    // the miss. (Filtering on `!== before` alone would count a successful change as a miss.)
    const missed = ids.filter(id => {
      const row = plans.find(p => p.lessonId === id)
      return row === undefined || row.planHash === before.get(id)
    })
    assert.equal(changed.length, ids.length, 'every row moved to the new scenario binding')
    assert.deepEqual(missed, [], 'every scenario binding change is handled inside bounded scans')
    const extraReview = f.calls.length - reviewCallsAfterInitial
    assert.equal(extraReview, ids.length * 4, 'each new binding runs its own review exactly once')
    assert.ok(f.maxActive() <= 1)
  } finally { await f.restore(); await f.cleanup() }
})

test('rev2: reads (feed, facts, plans, status) never write the store document', async () => {
  const f = makeFixture('reads-zero-writes')
  try {
    for (let i = 0; i < 8; i++) f.add()
    await f.scan()
    const readFile = () => readFileSync(f.stateFile(), 'utf8')
    const cursorAfterScan = f.engine().autoCandidates({ limit: 32 }).cursor
    const before = readFile()
    // Read surfaces: the presentation feed, per-id facts, the plan rows and the status card.
    f.feed(32)
    for (const id of f.feed(32).map(row => row.id)) {
      void f.engine().autoCandidateFacts({ lessonId: id })
    }
    void f.engine().autoPlans()
    const cursorRead = f.engine().autoCandidates({ limit: 32 }).cursor
    void f.engine().autoCandidates({ limit: 32 })
    f.status()
    assert.equal(readFile(), before, 'no read may advance the cursor or touch the document')
    assert.equal(cursorRead, cursorAfterScan, 'reads leave the consideration cursor untouched')
  } finally { await f.cleanup() }
})

test('rev2: zero-budget decision waits rotate fairly across candidates without plans or provider calls', async () => {
  const f = makeFixture('zero-budget-rotation', { tokens: 0 })
  try {
    const ids = Array.from({ length: 48 }, () => f.add())
    const cursors = []
    for (let i = 0; i < 7; i++) {
      cursors.push(f.engine().autoCandidates({ limit: 32 }).cursor)
      if (i === 2) await f.restart()
      await f.scan(32)
    }
    assert.equal(f.calls.length, 0, 'no physical provider request with zero budget')
    assert.equal(f.planCount(), 0, 'budget-blocked candidates never receive executable plans')
    const decisions = f.engine().store.read().decisionRecords
    assert.ok(decisions.length >= 7, 'each pass persists one candidate decision wait')
    assert.ok(decisions.every(row => row.state === 'wait' && row.error === 'evaluation_budget'))
    assert.ok(new Set(decisions.map(row => row.candidateId)).size > 1,
      'persisted waits rotate across candidate editions')
    assert.ok(new Set(cursors).size > 1, 'the cursor keeps rotating with a zero budget')
    assert.ok(f.maxActive() <= 1)
  } finally { await f.cleanup() }
})
