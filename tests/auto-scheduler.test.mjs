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
    autoPlanEconomicAdmission: input => {
      calls.push(['economicAdmission', input.queueKey, input.planHash, input.requestHashes?.length ?? 0])
      return { ok: true }
    },
    autoPlanUpdate: input => { calls.push(['update', input.stage, input.reason ?? null])
      const row = queue.find(item => item.queueKey === input.queueKey)
      if (row !== undefined) Object.assign(row, input)
      return { ok: true, plan: row ?? input } },
    reviewPlan: () => { calls.push(['reviewPlan']); return { allowed: true, reasons: [] } },
    reviewRequest: input => { calls.push(['reviewRequest', input.queueKey, Array.isArray(input.criteria)])
      return { ok: true, ticket: 't-review' } },
    reviewResult: input => { calls.push(['reviewResult', input.structuredPassed, input.swapped]); return reviewVerdict },
    evaluationRequest: input => { calls.push(['evaluationRequest', input.packId, input.suiteId,
      Object.hasOwn(input, 'cases')]); return { ok: true, ticket: 't-objective' } },
    evaluate: input => { calls.push(['evaluate', input.basis, Object.keys(input.answers).length]); return evaluateResult },
    evaluationCancel: input => { calls.push(['cancel', input.spent ?? null]); return { ok: true } },
  }
  return engine
}

const packContext = () => ({
  packId: 'mse-lifecycle-v1',
  suite: { packId: 'mse-lifecycle-v1', version: 1 },
  suiteId: 'domain-pack:mse-lifecycle-v1:v1', cases: CASES,
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
  assert.deepEqual(reserved, ['evaluationRequest', 'mse-lifecycle-v1', 'domain-pack:mse-lifecycle-v1:v1', false],
    'the core owns registered cases; the adapter supplies pack identity, not a caller-authored case list')
  const settled = engine.calls.find(([name]) => name === 'evaluate')
  assert.equal(settled[1], 'host_pack')
  assert.equal(settled[2], CASES.length, 'every case carries an answer')
  assert.ok(engine.calls.some(([name, queueKey, planHash, hashes]) => name === 'economicAdmission'
    && queueKey === 'q-objective' && planHash === 'p-objective' && hashes === CASES.length * 2),
  'the scheduler admits the exact set of actual objective request hashes before reserving')
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

// ── Stage 4c: a read that cannot answer says so, and a read never cancels ────────────────────────
// Both cases come from the independent read-only probe (`audit/ui-review/read-only-probes`): a real
// store that became unreadable while a queued plan existed was reported as `plans: 0, idle: true`,
// and a settings snapshot taken while the config was already visible cancelled a running job.
test('an unreadable queue is reported as unknown, never as an empty queue', async () => {
  const auto = createAutoValidation({
    engine: { autoPlans() { const error = new Error('invalid_store'); error.code = 'invalid_store'; throw error } },
    context: () => null, route: () => null, callModel: async () => null,
    enabled: () => true, busy: () => false })
  const status = auto.status()
  assert.equal(status.plans, null, 'a false zero is a false statement about work that exists')
  assert.equal(status.queued, null)
  assert.equal(status.idle, null, 'an unreadable queue is not idle')
  assert.equal(status.queueError, 'invalid_store', "the core's own code travels to the surface")
})

test('an empty queue still reports REAL zeros and no error', async () => {
  const auto = createAutoValidation({
    engine: { autoPlans() { return [] } },
    context: () => null, route: () => null, callModel: async () => null,
    enabled: () => true, busy: () => false })
  const status = auto.status()
  assert.equal(status.plans, 0)
  assert.equal(status.queued, 0)
  assert.equal(status.idle, true)
  assert.equal(status.queueError, null)
})

// ── Stage 4c: a READ never performs the permission transition ───────────────────────────────────
// The DSH adapter's `sync()` is reached from read-only surfaces (`settings()`, the permission
// callback). Before this fix it applied the whole transition from a read: with the saved config
// already visible and the lifecycle notification not yet delivered, a plain settings read cancelled a
// running automatic job and bumped the abort generation, while nothing on disk had changed. The
// transition now belongs to the explicit lifecycle call; a read recomputes and REPORTS only.
test('the lifecycle flag is what authorises a transition, and a read applies nothing', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../adapters/dsh/index.mjs', import.meta.url), 'utf8')
  // Every side effect of the transition sits behind `lifecycle`: none of them may run on the path a
  // read takes. This is a structural assertion on purpose — the behaviour is exercised by the real
  // host suites (`stage3d-pump`), while this pins the invariant that made it possible.
  const raw = source.slice(source.indexOf('function sync('), source.indexOf('/**\n   * Does the queue hold work'))
  // Comments describe the gate; only CODE counts.
  const body = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gmu, '')
  // ONE early return is what makes a read safe: it sits INSIDE the changed-policy branch, before the
  // block that applies the transition, and it returns the recomputed reasons without touching the
  // bridge, the jobs or the automatic queue.
  // The CHANGED-POLICY early return is the one that hands back `reasons`; the other gate is the
  // no-change branch, which is a different (harmless) site and must not be confused with this one.
  const gate = body.search(/if \(!lifecycle\) \{\s*\n[\s\S]*?return reasons/)
  assert.ok(gate > 0, 'the changed-policy branch must have its own early return for a read')
  const applyBlock = body.slice(gate)
  for (const effect of ['bridge.setEnabled', 'bridge.abortReflections', 'jobs.cancelAll']) {
    assert.ok(applyBlock.includes(effect), `${effect} is applied by the lifecycle path`)
  }
  // No transition call appears BEFORE that early return, so a read can reach the return and nothing
  // else. (`bridge.setEnabled` appears above it only inside the no-change branch, guarded by its own
  // `if (lifecycle)`, which the per-site check above already covered.)
  const beforeGate = body.slice(0, gate)
  for (const effect of ['bridge.abortReflections', 'jobs.cancelAll']) {
    assert.ok(!beforeGate.includes(effect), `${effect} must not run before the gate`)
  }
  const enabledCalls = [...beforeGate.matchAll(/bridge\.setEnabled\s*\(/gu)]
  for (const call of enabledCalls) {
    const line = beforeGate.slice(beforeGate.lastIndexOf("\n", call.index) + 1, call.index)
    assert.match(line, /lifecycle/, `an earlier setEnabled must be lifecycle-guarded: ${line.trim()}`)
  }
})
