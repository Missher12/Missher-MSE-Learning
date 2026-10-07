// The automatic scheduler itself: two tracks, one queue, and the permission discipline.
//
// These run the REAL `auto.mjs` against a recording stand-in for the core, so the wiring — which
// fields a reservation carries, how many calls a run makes, what happens when the switch closes —
// is exercised exactly as the adapter drives it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAutoValidation } from '../adapters/dsh/auto.mjs'

const CRITERIA = [{ id: 'lifecycle_scope', kind: 'structured', statement: '回答必须区分请求代次与并发提交' }]
const CASES = [{ caseId: 'c1', family: 'generation_ordering', split: 'holdout', prompt: '写出一条按代次丢弃迟到结果的规则' },
  { caseId: 'c2', family: 'concurrency_evidence', split: 'development', prompt: '说明如何在锁内复核提交状态' }]

/** A core stand-in that records what the scheduler asked for and answers like the real one. */
function fakeEngine({ plans = [], reviewVerdict = { ok: true, state: 'reviewed', trial: 'trial', reasons: [] },
  evaluateResult = { ok: true, decision: 'accepted', reasons: [] } } = {}) {
  const calls = []
  const queue = plans.map(plan => ({ ...plan }))
  const engine = {
    calls,
    autoPlans: () => queue.map(plan => ({ ...plan })),
    autoPlanRegister: input => {
      calls.push(['register', input.track])
      const plan = { queueKey: `q-${input.track}`, planHash: `p-${input.track}`, ...input, stage: 'queued',
        attempts: 0, maxAttempts: 2, nextAttemptAt: 0 }
      if (!queue.some(row => row.queueKey === plan.queueKey)) queue.push({ ...plan })
      return { ok: true, duplicate: false, plan }
    },
    autoPlanUpdate: input => { calls.push(['update', input.stage, input.reason ?? null])
      const row = queue.find(item => item.queueKey === input.queueKey)
      if (row !== undefined) Object.assign(row, input)
      return { ok: true, plan: row ?? input } },
    reviewPlan: () => { calls.push(['reviewPlan']); return { allowed: true, reasons: [] } },
    reviewRequest: input => { calls.push(['reviewRequest', input.queueKey, Array.isArray(input.criteria)])
      return { ok: true, ticket: 't-review' } },
    reviewResult: input => { calls.push(['reviewResult', input.structuredPassed, input.swapped]); return reviewVerdict },
    evaluationRequest: input => { calls.push(['evaluationRequest', input.cases.length]); return { ok: true, ticket: 't-objective' } },
    evaluate: input => { calls.push(['evaluate', input.basis, Object.keys(input.answers).length]); return evaluateResult },
    evaluationCancel: input => { calls.push(['cancel', input.spent ?? null]); return { ok: true } },
  }
  return engine
}

const packContext = () => ({
  packId: 'mse-lifecycle-v1', suiteId: 'domain-pack:mse-lifecycle-v1:v1', cases: CASES,
  instruction: '处理请求时先记录代次，迟到结果按代次丢弃', projectKey: '/synthetic/p',
  arm: kind => ({ system: kind === 'candidate' ? '方法：…' : '直接作答', prompt: 'p' }),
})

const reviewContext = () => ({
  suite: { packId: 'mse-lifecycle-v1', version: 1 }, criteria: CRITERIA,
  scenarioHash: 'a'.repeat(64), criteriaHash: 'b'.repeat(64), scenario: { id: 'c1' },
  arm: kind => ({ system: kind === 'candidate' ? '方法：…' : '直接作答', prompt: 'p' }),
  judge: (armA, armB, pass) => ({ system: 'judge', prompt: 'j', labels: { armA: pass === 0 ? 'A' : 'B', armB: pass === 0 ? 'B' : 'A' } }),
})

const plan = (track, extra = {}) => ({ queueKey: `q-${track}`, planHash: `p-${track}`, lessonId: 'lesson_1', version: 1,
  environment: 'default', track, stage: 'queued', evidence: 'none', source: { kind: 'turn' }, ticket: null,
  attempts: 0, maxAttempts: 2, nextAttemptAt: 0, reason: null, updatedAt: 0, ...extra })

test('the review track runs two arms and two swapped judge passes, then commits', async () => {
  const engine = fakeEngine({ plans: [] })
  const prompts = []
  const scheduler = createAutoValidation({ engine, context: reviewContext, objectiveContext: () => null,
    route: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }),
    callModel: async request => {
      prompts.push(request.prompt)
      return { text: '{"winner":"A","criteria":[{"id":"lifecycle_scope","met":"both"}]}', tokens: 100 }
    },
    enabled: () => true, now: () => 1000 })
  const result = await scheduler.scan([{ id: 'lesson_1', version: 1, projectKey: '/synthetic/p', instruction: '方法' }])
  assert.equal(result.ok, true)
  // Two arm answers and two judge verdicts: the swapped pair is a real cross-check.
  assert.equal(prompts.length, 4, `expected four calls, got ${prompts.length}`)
  assert.ok(engine.calls.some(([name]) => name === 'reviewRequest'))
  const committed = engine.calls.find(([name]) => name === 'reviewResult')
  assert.ok(committed, 'the verdict is committed through the core')
  assert.equal(committed[1], true, 'the host-side structured guard is stated explicitly')
  assert.equal(committed[2], true, 'the pair really was swapped')
  const updates = engine.calls.filter(([name]) => name === 'update')
  assert.deepEqual(updates.slice(-1)[0].slice(0, 2), ['update', 'done'],
    `the run finishes as done, got ${JSON.stringify(updates.map(row => row[1]))}`)
})

test('the objective track reserves a pack ticket, answers every case and settles as host_pack', async () => {
  const engine = fakeEngine({ plans: [] })
  let calls = 0
  const scheduler = createAutoValidation({ engine, context: () => null, objectiveContext: packContext,
    route: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }),
    callModel: async () => { calls += 1; return { text: '答案', tokens: 50 } },
    enabled: () => true, now: () => 1000 })
  await scheduler.scan([{ id: 'lesson_1', version: 1, projectKey: '/synthetic/p', instruction: '代次 锁 提交' }])
  // Two arms per case, and nothing else: the pack's own checker does the judging inside the core.
  assert.equal(calls, CASES.length * 2, `expected ${CASES.length * 2} arms, got ${calls}`)
  const reserved = engine.calls.find(([name]) => name === 'evaluationRequest')
  assert.equal(reserved[1], CASES.length)
  const settled = engine.calls.find(([name]) => name === 'evaluate')
  assert.equal(settled[1], 'host_pack')
  assert.equal(settled[2], CASES.length, 'every case carries an answer')
})

test('closing the switch stops the run at the next paid step', async () => {
  const engine = fakeEngine({ plans: [plan('objective')] })
  let allowed = true
  let calls = 0
  const scheduler = createAutoValidation({ engine, context: reviewContext, objectiveContext: packContext,
    route: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }),
    callModel: async () => { calls += 1; if (calls === 2) allowed = false; return { text: '答案', tokens: 50 } },
    enabled: () => allowed, now: () => 1000 })
  await scheduler.scan([{ id: 'lesson_1', version: 1, projectKey: '/synthetic/p', instruction: '代次 锁 提交' }])
  // The first case's two arms run; the second case never starts.
  assert.equal(calls, 2, `a closed switch must stop the run, got ${calls} calls`)
  assert.ok(engine.calls.some(([name]) => name === 'cancel'), 'the ticket is released')
  assert.equal(engine.calls.some(([name]) => name === 'evaluate'), false, 'no verdict is settled')
  const update = engine.calls.filter(([name]) => name === 'update').slice(-1)[0]
  assert.equal(update[1], 'queued', 'a cancellation returns the plan to the queue')
  assert.equal(update[2], 'review_cancelled')
})

test('a plan with no route or no pack stays parked with a reason', async () => {
  const engine = fakeEngine({ plans: [plan('objective')] })
  const noRoute = createAutoValidation({ engine, context: reviewContext, objectiveContext: packContext,
    route: () => null, callModel: async () => ({ text: 'x', tokens: 1 }), enabled: () => true, now: () => 1000 })
  await noRoute.scan([{ id: 'lesson_1', version: 1, instruction: '代次 锁 提交' }])
  assert.equal(engine.calls.filter(([name]) => name === 'update').slice(-1)[0][2], 'review_no_route')

  // A candidate the pack does not admit gets NO objective plan at all, so nothing can be promoted
  // by a pack that never described it.
  const outOfDomainEngine = fakeEngine({ plans: [] })
  const outOfDomain = createAutoValidation({ engine: outOfDomainEngine, context: reviewContext,
    objectiveContext: () => null, route: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }),
    callModel: async () => ({ text: 'x', tokens: 1 }), enabled: () => true, now: () => 1000 })
  await outOfDomain.scan([{ id: 'lesson_1', version: 1, instruction: '导出金额' }])
  assert.deepEqual(outOfDomainEngine.calls.filter(([name]) => name === 'register').map(row => row[1]), ['review'],
    'only the review plan is registered for an out-of-domain candidate')

  // And a queued objective plan with no pack context parks with its own reason before any call.
  const nothingToDo = fakeEngine({ plans: [plan('objective')] })
  const parked = createAutoValidation({ engine: nothingToDo, context: reviewContext, objectiveContext: () => null,
    route: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }),
    callModel: async () => ({ text: 'x', tokens: 1 }), enabled: () => true, now: () => 1000 })
  await parked.scan([{ id: 'lesson_1', version: 1, instruction: '导出金额' }])
  assert.ok(nothingToDo.calls.some(([name, stage, reason]) => name === 'update' && stage === 'blocked'
    && reason === 'review_missing_criteria'), JSON.stringify(nothingToDo.calls))
})

test('a cold start runs on the plan route, with no warm-up of its own', async () => {
  // The plan carries everything a run needs, including the route, so the scheduler never has to ask
  // a process-wide "last observed" value — which is empty on a cold start.
  const engine = fakeEngine({ plans: [] })
  const seen = []
  const scheduler = createAutoValidation({ engine, context: reviewContext, objectiveContext: () => null,
    route: ({ source }) => source?.route ?? null,
    callModel: async (request, ticket) => {
      seen.push({ route: request.route, ticket })
      return { text: '{"winner":"A","criteria":[{"id":"lifecycle_scope","met":"both"}]}', tokens: 10 }
    },
    source: () => ({ kind: 'turn', sessionId: 'session-cold', turnId: '7',
      route: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' } }),
    enabled: () => true, now: () => 1000 })
  await scheduler.scan([{ id: 'lesson_1', version: 1, projectKey: '/synthetic/p', instruction: '核对会话请求代次并丢弃旧响应' }])
  assert.equal(seen.length, 4, `the review run must make its four calls, got ${seen.length}`)
  for (const call of seen) {
    assert.equal(call.route?.provider, 'deepseek-account', 'every call carries the plan route')
    assert.equal(call.route?.reasoningEffort, 'max', 'including the reasoning effort')
  }
  // The plan itself now records that route, so a restart can run it again without a warm-up.
  const plan = engine.autoPlans()[0]
  assert.equal(plan.source.route.model, 'deepseek-flash')
})

test('a pause between two arms stops the very next request', async () => {
  // The auditor's r6 case: the switch closes between the first arm and the second, and the second
  // must never be sent.
  const engine = fakeEngine({ plans: [] })
  let allowed = true
  const seen = []
  const scheduler = createAutoValidation({ engine, context: reviewContext, objectiveContext: () => null,
    route: ({ source }) => source?.route ?? null,
    callModel: async request => { seen.push(request.prompt); return { text: '{"winner":"A"}', tokens: 100 } },
    source: () => ({ kind: 'turn', route: { provider: 'p', model: 'm' } }),
    enabled: () => allowed, now: () => 1000 })
  // The first call closes the switch as it returns.
  const original = scheduler
  let calls = 0
  const gate = createAutoValidation({ engine, context: reviewContext, objectiveContext: () => null,
    route: ({ source }) => source?.route ?? null,
    callModel: async request => { calls += 1; if (calls === 1) allowed = false; return { text: '{"winner":"A"}', tokens: 100 } },
    source: () => ({ kind: 'turn', route: { provider: 'p', model: 'm' } }),
    enabled: () => allowed, now: () => 1000 })
  await gate.scan([{ id: 'lesson_1', version: 1, projectKey: '/synthetic/p', instruction: '核对会话请求代次' }])
  assert.equal(calls, 1, `a paused run must not send the next arm, got ${calls}`)
  assert.ok(engine.calls.some(([name]) => name === 'cancel' || name === 'update'),
    'the run reports its cancellation rather than a verdict')
  void original
})

test('an archived source stops the next paid step and the commit', async () => {
  // The auditor archived the source session between the 4th and 5th request; the 5th must not go out.
  const engine = fakeEngine({ plans: [] })
  let calls = 0
  let archived = false
  const scheduler = createAutoValidation({ engine, context: reviewContext, objectiveContext: () => null,
    route: ({ source }) => source?.route ?? null,
    callModel: async () => {
      calls += 1
      // The archive lands while the first answer is in flight.
      if (calls === 1) archived = true
      return { text: '{"winner":"A","criteria":[{"id":"lifecycle_scope","met":"both"}]}', tokens: 10 }
    },
    source: () => ({ kind: 'turn', sessionId: 'session-src', route: { provider: 'p', model: 'm' } }),
    permit: () => (archived ? { ok: false, reason: 'source_archived' } : { ok: true }),
    enabled: () => true, now: () => 1000 })
  await scheduler.scan([{ id: 'lesson_1', version: 1, projectKey: '/synthetic/p', instruction: '核对会话请求代次' }])
  assert.equal(calls, 1, `an archived source must stop the run, got ${calls} calls`)
  assert.equal(engine.calls.some(([name]) => name === 'reviewResult'), false, 'nothing is committed')
  assert.ok(engine.calls.some(([name]) => name === 'cancel'), 'the reservation is released')
})

// The measured P1 from the real Host: every paid step had already answered (the last objective
// request had returned), and the operator closed the automatic switch WHILE the final permit was
// awaiting the session directory. The queue really cancelled the job (`auto_disabled`, `draining`),
// yet the pack verdict was still written. A permission read before an await is not a permission to
// commit after it, so the commit re-reads the switch, the run generation, the run signal and the
// slot's own `allowed()` reader synchronously, immediately before the core is asked to record.
test('a permission withdrawn during the final permit never commits a result', async () => {
  // The plan carries the scope its run belongs to, exactly as the adapter fills it.
  const engine = fakeEngine({ plans: [plan('review', { source: { kind: 'turn', projectKey: '/synthetic/p',
    route: { provider: 'deepseek-account', model: 'deepseek-flash' } } })] })
  let allowed = true
  let permitCalls = 0
  let releasePermit = null
  let insideFinalPermit = null
  const enteredFinalPermit = new Promise(resolve => { insideFinalPermit = resolve })
  const suspendedPermit = new Promise(resolve => { releasePermit = resolve })
  let settleJob = null
  const scheduler = createAutoValidation({ engine, context: reviewContext, objectiveContext: () => null,
    route: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }),
    callModel: async () => ({ text: '{"winner":"A","criteria":[{"id":"lifecycle_scope","met":"both"}]}', tokens: 10 }),
    source: () => ({ kind: 'turn', sessionId: 'session-src', route: { provider: 'p', model: 'm' } }),
    // The host permits every paid step, then really suspends inside the FINAL permit (the commit
    // gate) and answers with the licence it read before the switch closed — which is exactly what
    // must no longer be enough.
    permit: async () => {
      permitCalls += 1
      if (permitCalls === 5) { insideFinalPermit(); await suspendedPermit }
      return { ok: true }
    },
    enabled: () => allowed, now: () => 1000,
    slot: { submit: spec => {
      const controller = new AbortController()
      const context = { signal: controller.signal, allowed: () => allowed, outstanding: () => {} }
      Promise.resolve().then(() => spec.run(context)).then(
        value => settleJob?.({ id: 'job-final', state: value === 'blocked' ? 'blocked' : 'done' }),
        error => settleJob?.({ id: 'job-final', state: 'failed', code: error?.code ?? 'failed' }))
      return { ok: true, job: { id: 'job-final' } }
    },
      whenSettled: () => new Promise(resolve => { settleJob = resolve }) } })
  const scan = scheduler.scan([{ id: 'lesson_1', version: 1, projectKey: '/synthetic/p', instruction: '核对会话请求代次' }])
  // Bounded: a run that never reaches the final permit must FAIL here instead of hanging the suite.
  const reached = await Promise.race([enteredFinalPermit.then(() => 'permit'), new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))])
  assert.equal(reached, 'permit', `the run must reach the commit gate, got ${JSON.stringify(engine.calls)}`)
  assert.equal(engine.calls.some(([name]) => name === 'reviewResult'), false, 'nothing is committed yet')
  // The operator closes the automatic switch while the final permit is still awaiting.
  allowed = false
  releasePermit()
  const finished = await Promise.race([scan, new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))])
  assert.notEqual(finished, 'timeout', 'the scan must finish after the permit is released')
  assert.equal(permitCalls, 5, `the commit gate is the fifth permit read, got ${permitCalls}`)
  assert.equal(engine.calls.some(([name]) => name === 'reviewResult'), false,
    `a revoked permission must not be committed, got ${JSON.stringify(engine.calls.filter(([name]) => name === 'reviewResult'))}`)
  assert.ok(engine.calls.some(([name]) => name === 'cancel'), 'the reservation is released')
  const last = engine.calls.filter(([name]) => name === 'update').slice(-1)[0]
  assert.equal(last[1], 'queued', 'a cancelled commit returns the plan to the queue')
  assert.equal(last[2], 'review_cancelled')
})
