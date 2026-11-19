import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { buildEngine, cleanupAdaptiveEngineFixture, failureX, failureY, failureZ, failureW,
  trainApiPolicy } from '../scripts/rsi/adaptive-engine-fixture.mjs'
import { RECALL_QUALIFICATION } from './recall-qualification.mjs'
import { synthesizeAdaptivePolicy } from './adaptive-recall.mjs'

test('status exposes only the newest eight fixed-field persisted adaptive decisions', () => {
  const { root, engine, targetX } = buildEngine()
  try {
    engine.store.transaction(doc => {
      doc.recallStrategy.adaptive.decisions = Array.from({ length: 10 }, (_, index) => ({
        turnKey: index.toString(16).padStart(64, '0'), scope: 'a'.repeat(64),
        policyId: 'b'.repeat(64), entryId: targetX.id, version: 1,
        result: 'unknown', reason: 'cancelled_or_unknown', at: index + 1 }))
      return true
    })
    const decisions = engine.statusView().recallStrategy.adaptive.decisions
    assert.equal(decisions.length, 8)
    assert.equal(decisions[0].at, 10)
    assert.deepEqual(decisions[0], { policyId: 'b'.repeat(12), entryId: targetX.id.slice(4, 12),
      version: 1, result: 'unknown', reason: 'cancelled_or_unknown', at: 10 })
    assert.deepEqual(Object.keys(decisions[0]).sort(),
      ['at', 'entryId', 'policyId', 'reason', 'result', 'version'])
    assert.ok(!JSON.stringify(decisions).includes('turnKey'))
    assert.ok(!JSON.stringify(decisions).includes('scope'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('paired structured checks supply independent controls while preserving the promotion and rollback gates', () => {
  const fixture = buildEngine()
  const { root, engine, targetX, targetZ, targetW, fail, prepare, settle } = fixture
  try {
    const train = [
      ['seed-api', 'API 调用遇到阻塞，请定位原因'],
      ['held-api-a', 'API 请求仍然阻塞，麻烦定位原因'],
      ['held-api-b', 'API 调用返回错误，帮我排查原因'],
    ]
    for (const [session, prompt] of train) {
      prepare(session, '1', prompt)
      fail(session, '1', session, failureX)
      settle(session, '1')
    }
    const chart = 'node --test chart.test.mjs'
    const config = 'pytest -q config_test.py'
    engine.store.transaction(doc => {
      doc.entries.find(row => row.id === targetZ.id).lesson.verification.check = chart
      doc.entries.find(row => row.id === targetW.id).lesson.verification.check = config
      return true
    })
    const policy = () => engine.store.read().recallStrategy.adaptive.policies
      .find(row => row.entryId === targetX.id)
    const node = { kind: 'node_test_runner', tests: 1, passed: 1, failed: 0,
      skipped: 0, cancelled: 0, todo: 0 }
    const pytest = { kind: 'pytest', tests: 1, passed: 1, failed: 0, errors: 0,
      skipped: 0, xfailed: 0, xpassed: 0, deselected: 0 }
    function checkTurn(session, { entry = targetZ, checkId = 'node-test-runner-spec-v1',
      command = chart, summary = node, prompt = '绘制图表并调整配色', native = true,
      outcome = 'unknown', beforeSettle = null } = {}) {
      const result = prepare(session, '1', prompt)
      assert.ok(result.offered.some(offer => offer.id === entry.id && offer.mode === 'method'))
      const recorded = engine.recordCheck({ sessionId: session, turnId: '1', entryId: entry.id,
        entryVersion: entry.version, checkId, passed: true, evidence: summary, summary, sourceRequired: true,
        eventId: session, ...(native ? { nativeResult: { callSeq: 4, resultSeq: 6, command } } : {}) })
      assert.equal(recorded.settled, true)
      beforeSettle?.()
      settle(session, '1', outcome)
      return result
    }
    assert.equal(policy().positives, 3)
    checkTurn('standalone-check', { native: false })
    checkTurn('wrong-command', { command: 'node --test unrelated.test.mjs' })
    checkTurn('cancelled-check', { outcome: 'cancelled' })
    checkTurn('revoked-check', { beforeSettle: () => fixture.registered.delete('revoked-check') })
    assert.equal(policy().negativeControls, 0)
    const turn = checkTurn('chart-check')
    assert.equal(policy().negativeControls, 1)
    assert.equal(policy().mode, 'observing')
    const sample = policy().samples.at(-1)
    const recorded = engine.store.read().checkEvents.find(row => row.turnKey === turn.turnKey)
    assert.deepEqual(recorded.nativePair, { callSeq: 4, resultSeq: 6 })
    assert.equal(sample.replay.nativeCheckEvent, recorded.id)
    assert.deepEqual(sample.replay.observedEntry, { id: targetZ.id, version: 1 })
    assert.deepEqual(sample.replay.baselineOffers, sample.replay.candidateOffers)
    checkTurn('chart-repeat', { prompt: '请检查图表数据和图例渲染' })
    assert.equal(policy().negativeControls, 1, 'another run of the same checked method is not a second control')
    checkTurn('config-check', { prompt: '配置项合并发生冲突，请核对配置来源',
      entry: targetW, checkId: 'pytest-summary-v1', command: config, summary: pytest })
    assert.equal(policy().negativeControls, 2)
    assert.equal(policy().mode, 'approved')
    const active = prepare('live-api', '1', 'API 请求返回错误，请定位原因')
    assert.ok(active.offered.some(row => row.id === targetX.id))
    fail('live-api', '1', 'live-api-recurrence', failureX)
    settle('live-api', '1')
    assert.equal(policy().mode, 'isolated')
    assert.ok(!prepare('after-regression', '1', 'API 请求返回错误，请定位原因')
      .offered.some(row => row.id === targetX.id))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('adaptive discovery needs two independent gains and two feasible full-offer controls', () => {
  const { root, engine, targetX, targetY, targetZ, targetW, fail, prepare, settle } = buildEngine()
  try {
    const discovery = prepare('discovery-session', 'd1', 'API 调用遇到阻塞，请定位原因')
    assert.ok(!discovery.offered.some(row => row.id === targetX.id), 'discovery remains shadow only')
    fail('discovery-session', 'd1', 'discovery-failure', failureX)
    settle('discovery-session', 'd1')
    let adaptive = engine.store.read().recallStrategy.adaptive
    assert.equal(adaptive.policies.length, 1)
    const policyId = adaptive.policies[0].id
    assert.equal(adaptive.policies[0].mode, 'observing')
    assert.equal(adaptive.policies[0].positives, 1)
    assert.deepEqual(adaptive.policies[0].features, ['api', 'opdebug'],
      'the query-to-method association does not require lexical overlap with the method')

    const repeated = prepare('discovery-session', 'd2', 'RPC-123456789abc\nAPI 调用遇到阻塞，请定位原因')
    assert.ok(!repeated.offered.some(row => row.id === targetX.id), 'repeated query remains shadow only')
    const repeatedProbe = engine.store.read().recallStrategy.adaptive.probes
      .find(row => row.turnKey === repeated.turnKey)
    assert.notEqual(repeatedProbe.taskQuery, repeatedProbe.query,
      'v2 independence is based on its task-aware query identity')
    fail('discovery-session', 'd2', 'same-query-failure', failureX)
    settle('discovery-session', 'd2')
    adaptive = engine.store.read().recallStrategy.adaptive
    assert.equal(adaptive.policies[0].positives, 1, 'same session and same substantive query are not independent')
    const earlyReadiness = engine.statusView().recallStrategy.adaptive.recent
      .find(row => row.id === policyId).readiness
    assert.equal(earlyReadiness.schema, 'v2')
    assert.equal(earlyReadiness.independentGains, 0,
      'the discovery seed and same-session repeat are not presented as independent gains')
    assert.equal(earlyReadiness.independentControls, 0)

    const holdout = prepare('holdout-session-1', 'h1', 'API 请求仍然阻塞，麻烦定位原因')
    assert.ok(!holdout.offered.some(row => row.id === targetX.id), 'holdout remains shadow only')
    fail('holdout-session-1', 'h1', 'independent-api-failure-1', failureX)
    settle('holdout-session-1', 'h1')
    adaptive = engine.store.read().recallStrategy.adaptive
    assert.equal(adaptive.policies[0].positives, 2)
    assert.equal(adaptive.policies[0].mode, 'observing', 'a positive holdout alone cannot activate')
    assert.equal(adaptive.policies[0].samples[1].replay.expected, true)

    const holdout2 = prepare('holdout-session-2', 'h2', 'API 调用返回错误，帮我排查原因')
    assert.ok(!holdout2.offered.some(row => row.id === targetX.id), 'the second holdout remains shadow only')
    fail('holdout-session-2', 'h2', 'independent-api-failure-2', failureX)
    settle('holdout-session-2', 'h2')

    const control = prepare('control-session-1', 'n1', '绘制图表并调整配色')
    const controlProbe = engine.store.read().recallStrategy.adaptive.probes
      .find(row => row.turnKey === control.turnKey)
    assert.ok(controlProbe.controlPolicies.includes(policyId),
      'only a physically addable candidate can use this turn as a negative control')
    assert.ok(control.offered.some(row => row.id === targetZ.id),
      'the real control objective is explained by its own baseline method')
    fail('control-session-1', 'n1', 'independent-chart-failure', failureZ)
    settle('control-session-1', 'n1')
    const control2 = prepare('control-session-2', 'n2', '输出路径解析失败，请定位问题')
    const controlProbe2 = engine.store.read().recallStrategy.adaptive.probes
      .find(row => row.turnKey === control2.turnKey)
    assert.ok(controlProbe2.controlPolicies.includes(policyId))
    fail('control-session-2', 'n2', 'independent-path-failure', failureY)
    settle('control-session-2', 'n2')
    adaptive = engine.store.read().recallStrategy.adaptive
    const policy = adaptive.policies.find(row => row.id === policyId)
    assert.equal(policy.schema, 'mse-adaptive-recall-v2')
    assert.equal(policy.positives, 3, 'the discovery seed does not count as a frozen-condition holdout')
    assert.equal(policy.negativeControls, 2)
    assert.equal(policy.mode, 'approved', 'v2 requires two gains and two complete negative controls')
    assert.equal(policy.samples[3].replay.expected, false)
    assert.equal(policy.samples[3].replay.observedEntry.id, targetZ.id,
      'the control records the exact lesson matched by its real failure')
    assert.equal(policy.samples[4].replay.observedEntry.id, targetY.id)
    const approvedReadiness = engine.statusView().recallStrategy.adaptive.recent
      .find(row => row.id === policyId).readiness
    assert.equal(approvedReadiness.independentGains, 2)
    assert.equal(approvedReadiness.requiredIndependentGains, 2)
    assert.equal(approvedReadiness.independentControls, 2)
    assert.equal(approvedReadiness.requiredIndependentControls, 2)
    assert.equal(approvedReadiness.sourceAdmitted, true)
    assert.deepEqual(approvedReadiness.blockers, [])
    assert.deepEqual(engine.statusView().recallStrategy.adaptive.recent
      .find(row => row.id === policyId).replay.candidate, { hits: 2, misses: 0, falseOffers: 0 })

    const active = prepare('active-session', 'a1', 'API 调用返回意外状态，请分析原因')
    assert.ok(active.offered.some(row => row.id === targetX.id && row.mode === 'method'),
      'policy is active after independent positive, negative control and strict replay')
    assert.ok(active.bytes <= 768 && active.offered.filter(row => row.mode === 'method').length <= 2
      && active.offered.filter(row => row.mode === 'guard').length <= 1)
    const activeProbe = engine.store.read().recallStrategy.adaptive.probes
      .find(row => row.turnKey === active.turnKey)
    assert.ok(activeProbe.baselineOffers.every(row => activeProbe.offered.some(item =>
      item.id === row.id && item.version === row.version && item.mode === row.mode)))
    assert.ok(!JSON.stringify(engine.store.read().recallStrategy.adaptive).includes('API 调用'),
      'adaptive state stores no prompt text')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('RRSI compares same-turn hits and misses and activates one winner independent of settlement order', () => {
  function run(reversePending) {
    const { root, engine, targetY, targetZ, targetW, fail, prepare, settle } = buildEngine()
    try {
      const turn = (session, id, prompt, failure) => {
        prepare(session, id, prompt)
        fail(session, id, `${session}-failure`, failure)
        if (reversePending) engine.store.transaction(doc => {
          const probe = doc.recallStrategy.adaptive.probes.find(row => row.turnKey
            === createHash('sha256').update(JSON.stringify([session, id])).digest('hex'))
          probe.pending.reverse()
          return true
        })
        settle(session, id)
      }
      turn('rrsi-discovery', 'd', '请审核 API 记录并核对失败原因。', failureY)
      let policies = engine.store.read().recallStrategy.adaptive.policies
      assert.equal(policies.length, 2)
      assert.deepEqual(policies.map(row => row.features).sort((a, b) => a.length - b.length), [
        ['api', 'opcheck'], ['api', 'record', 'opcheck'],
      ])
      assert.ok(policies.every(row => row.entryId === targetY.id && row.version === targetY.version
        && row.mode === 'observing' && row.samples.length === 1
        && row.samples[0].result === 'discovery_hit'))

      turn('rrsi-hit-one', 'h1', '请复核 API 记录并核对失败原因。', failureY)
      turn('rrsi-hit-two', 'h2', '麻烦检查 API 记录后排查这次失败。', failureY)
      turn('rrsi-miss', 'm1', '请核对 API 字段版本，并分析失败。', failureY)
      turn('rrsi-control-one', 'c1', '绘制图表并调整配色。', failureZ)
      turn('rrsi-control-two', 'c2', '配置项合并发生冲突，请定位问题。', failureW)

      policies = engine.store.read().recallStrategy.adaptive.policies
      const winner = policies.find(row => row.mode === 'approved')
      const waiting = policies.find(row => row.mode === 'observing')
      assert.ok(winner, 'one qualified candidate becomes active')
      assert.ok(waiting, 'the other candidate remains available for later rounds')
      const winnerReplay = engine.statusView().recallStrategy.adaptive.recent
        .find(row => row.id === winner.id).replay
      const waitingReplay = engine.statusView().recallStrategy.adaptive.recent
        .find(row => row.id === waiting.id).replay
      assert.equal(winnerReplay.independentGains, 3)
      assert.equal(winnerReplay.independentControls, 2)
      assert.equal(waitingReplay.independentGains, 2)
      assert.equal(waitingReplay.independentControls, 2)
      assert.equal(waitingReplay.candidate.misses, 1)
      assert.deepEqual(winnerReplay.evidenceKeys, waitingReplay.evidenceKeys)
      assert.equal(winner.id, policies.find(row => row.features.length === 2).id,
        'the narrower overlap wins because it recovers the additional real target turn')
      const active = prepare('rrsi-live', 'live', '请检查 API 路径记录，核对失败原因。')
      assert.ok(active.offered.some(row => row.id === targetY.id && row.mode === 'method'))
      assert.ok(active.bytes <= 768 && active.offered.filter(row => row.mode === 'method').length <= 2
        && active.offered.filter(row => row.mode === 'guard').length <= 1)
      return { winnerFeatures: winner.features, hits: winnerReplay.candidate.hits,
        misses: winnerReplay.candidate.misses, controls: winnerReplay.independentControls }
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
  assert.deepEqual(run(false), run(true))
})

test('a broader candidate is isolated by a real false trigger while the nonmatching condition stays observing', () => {
  const { root, engine, targetY, targetZ, fail, prepare, settle } = buildEngine()
  try {
    prepare('wide-discovery', 'd', '请审核 API 记录并核对失败原因。')
    fail('wide-discovery', 'd', 'wide-discovery-failure', failureY)
    settle('wide-discovery', 'd')
    const initial = engine.store.read().recallStrategy.adaptive.policies
    assert.equal(initial.length, 2)
    const broader = initial.find(row => row.features.length === 2)
    const narrower = initial.find(row => row.features.length === 3)

    const turn = prepare('wide-counterexample', 'c', '请核对 API 字段版本，并分析失败。')
    assert.ok(!turn.offered.some(row => row.id === targetY.id), 'candidate remains shadow-only')
    fail('wide-counterexample', 'c', 'wide-chart-failure', failureZ)
    const pending = engine.store.read().recallStrategy.adaptive.probes
      .find(row => row.turnKey === turn.turnKey).pending
    assert.ok(pending.some(row => row.policyId === broader.id && row.kind === 'negative'))
    assert.ok(pending.some(row => row.policyId === narrower.id && row.kind === 'negative_control'))
    settle('wide-counterexample', 'c')

    const rows = engine.store.read().recallStrategy.adaptive.policies
    assert.equal(rows.find(row => row.id === broader.id).mode, 'isolated')
    assert.equal(rows.find(row => row.id === broader.id).reason, 'competing_method_failure')
    assert.equal(rows.find(row => row.id === broader.id).samples.at(-1).replay.observedEntry.id, targetZ.id)
    assert.equal(rows.find(row => row.id === narrower.id).mode, 'observing',
      'the condition that did not match the real counterexample remains available')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('adaptive candidates remain isolated to their frozen project scope', () => {
  const { root, engine, targetY, fail, prepare, settle, registered } = buildEngine({
    projectKey: 'rrsi-scope-a' })
  try {
    prepare('scope-seed', 'd', '请审核 API 记录并核对失败原因。')
    fail('scope-seed', 'd', 'scope-seed-failure', failureY)
    settle('scope-seed', 'd')
    const ids = engine.store.read().recallStrategy.adaptive.policies.map(row => row.id)
    assert.equal(ids.length, 2)
    engine.store.transaction(doc => {
      for (const row of doc.recallStrategy.adaptive.policies) if (ids.includes(row.id)) {
        row.mode = 'approved'
        row.generation = ++doc.recallStrategy.adaptive.generation
        row.reason = 'holdout_approved'
      }
      return true
    })
    registered.add('scope-b-session')
    const other = engine.prepare({ sessionId: 'scope-b-session', turnId: 'other',
      projectKey: 'rrsi-scope-b', prompt: '请审核 API 记录并核对失败原因。',
      strategyEligible: true }, true)
    assert.ok(!other.offered.some(row => row.id === targetY.id && row.mode === 'method'))
    const otherProbe = engine.store.read().recallStrategy.adaptive.probes
      .find(row => row.turnKey === other.turnKey)
    assert.deepEqual(otherProbe.activePolicies, [])
    assert.deepEqual(otherProbe.shadowPolicies, [])

    const same = prepare('scope-a-session', 'same', '请审核 API 记录并核对失败原因。')
    assert.ok(same.offered.some(row => row.id === targetY.id && row.mode === 'method'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a triggered adaptive method that uniquely fails on a different objective isolates only its strategy', () => {
  const { root, engine, targetX, targetY, fail, prepare, settle } = buildEngine()
  try {
    trainApiPolicy({ engine, fail, prepare, settle })
    const before = engine.store.read().entries.find(row => row.id === targetX.id)
    assert.equal(before.status, 'pending')
    const active = prepare('active-session', 'a1', 'API 调用返回意外状态，请分析原因，同时排查图表渲染')
    assert.ok(active.offered.some(row => row.id === targetX.id && row.mode === 'method'),
      'candidate must be active before the competing native failure')
    const competing = fail('active-session', 'a1', 'competing-chart-failure', failureY)
    assert.equal(competing.id, targetY.lesson.problemId,
      `competing failure should bind to Y: ${JSON.stringify(competing)}`)
    assert.notEqual(competing.duplicate, true, `failure event must be new: ${JSON.stringify(competing)}`)
    const beforeSettle = engine.store.read().recallStrategy.adaptive.probes
      .find(row => row.turnKey === active.turnKey)
    assert.ok(beforeSettle.pending.some(row => row.kind === 'negative'),
      'a unique competing objective stages an adaptive strategy negative')
    settle('active-session', 'a1')
    const adaptive = engine.store.read().recallStrategy.adaptive
    const isolated = adaptive.policies.find(row => row.entryId === targetX.id)
    const targetAfter = engine.store.read().entries.find(row => row.id === targetX.id)
    assert.equal(isolated.mode, 'isolated')
    assert.equal(isolated.reason, 'competing_method_failure')
    assert.equal(isolated.samples.at(-1).replay.observedEntry.id, targetY.id,
      'the counterexample replay is bound to the actual competing lesson')
    assert.equal(targetAfter.status, before.status)
    assert.equal(targetAfter.version, before.version)
    assert.equal(engine.store.read().entries.find(row => row.id === targetY.id).status, 'pending')
    const children = adaptive.policies.filter(row => row.schema === 'mse-adaptive-recall-v2'
      && row.parentId === isolated.id)
    assert.ok(children.length >= 1 && children.length <= 2)
    assert.ok(children.every(row => row.mode === 'observing' && row.familyGeneration === 1
      && row.samples.length === 1 && row.samples[0].result === 'discovery_hit'
      && row.samples[0].reason === 'counterexample_child'))
    assert.ok(children.some(row => row.excludedFeatures.includes('chart')),
      'the real counterexample freezes a narrower child that rejects its specific distracting object')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('native settlement ignores guarded competitors but keeps healthy ambiguity', () => {
  for (const duplicateStatus of ['pending', 'needs_revision']) {
    const h = buildEngine()
    const { root, engine, targetZ, fail, prepare, settle } = h
    try {
      const duplicate = structuredClone(targetZ)
      duplicate.id = `mem_${createHash('sha256').update(`duplicate-${duplicateStatus}`).digest('hex').slice(0, 24)}`
      duplicate.status = duplicateStatus
      engine.store.transaction(doc => { doc.entries.push(duplicate); return true })

      const policy = trainApiPolicy({ engine, fail, prepare, settle })
      assert.equal(policy.mode, duplicateStatus === 'needs_revision' ? 'approved' : 'observing')
      if (duplicateStatus === 'needs_revision') assert.equal(policy.negativeControls, 2)
      else assert.ok(policy.negativeControls < 2)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('an exact offered-version native recurrence still settles after its method is guarded', () => {
  const h = buildEngine()
  const { root, engine, targetX, fail, prepare, settle } = h
  try {
    const policy = trainApiPolicy({ engine, fail, prepare, settle })
    const turn = prepare('guarded-recurrence-session', 'r1', 'API 调用返回意外状态，请分析原因，同时排查图表渲染')
    assert.ok(turn.offered.some(row => row.id === targetX.id && row.version === 1 && row.mode === 'method'))
    fail('guarded-recurrence-session', 'r1', 'guarded-recurrence-failure', failureX)
    const guarded = engine.store.read().entries.find(row => row.id === targetX.id)
    assert.equal(guarded.status, 'needs_revision')
    assert.ok(engine.store.read().receipts.find(row => row.turnKey === turn.turnKey)
      .methodFeedback.some(row => row.entryId === targetX.id && row.version === 1 && row.kind === 'recurrence'))

    settle('guarded-recurrence-session', 'r1')
    const settled = engine.store.read().recallStrategy.adaptive.policies.find(row => row.id === policy.id)
    assert.equal(settled.mode, 'isolated')
    assert.equal(settled.reason, 'native_recurrence')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a retired offered method cannot use recurrence receipt proof at settlement', () => {
  const h = buildEngine()
  const { root, engine, targetX, fail, prepare, settle } = h
  try {
    const policy = trainApiPolicy({ engine, fail, prepare, settle })
    prepare('retired-recurrence-session', 'r1', 'API 调用返回意外状态，请分析原因，同时排查图表渲染')
    fail('retired-recurrence-session', 'r1', 'retired-recurrence-failure', failureX)
    engine.store.transaction(doc => {
      doc.entries.find(row => row.id === targetX.id).status = 'retired'
      return true
    })

    settle('retired-recurrence-session', 'r1')
    const state = engine.store.read().recallStrategy.adaptive
    assert.equal(state.policies.find(row => row.id === policy.id).mode, 'approved')
    assert.ok(state.decisions.some(row => row.policyId === policy.id
      && row.result === 'unknown' && row.reason === 'policy_stale'))
    const readiness = engine.statusView().recallStrategy.adaptive.recent
      .find(row => row.id === policy.id).readiness
    assert.equal(readiness.sourceAdmitted, null, 'a stale target does not claim its source was revoked')
    assert.ok(readiness.blockers.includes('target_retired'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('revoking an admitted source before settlement cannot promote the policy', () => {
  const { root, engine, targetX, fail, prepare, settle, registered } = buildEngine()
  try {
    prepare('discovery-session', 'd1', 'API 调用遇到阻塞，请定位原因')
    fail('discovery-session', 'd1', 'discovery-failure', failureX)
    settle('discovery-session', 'd1')
    prepare('holdout-session', 'h1', '请检查接口 API 的返回状态与调用结果')
    fail('holdout-session', 'h1', 'independent-api-failure', failureX)
    registered.delete('seed-x')
    settle('holdout-session', 'h1')
    const policy = engine.store.read().recallStrategy.adaptive.policies
      .find(row => row.entryId === targetX.id)
    assert.equal(policy.positives, 1)
    assert.equal(policy.mode, 'observing')
    const readiness = engine.statusView().recallStrategy.adaptive.recent
      .find(row => row.id === policy.id).readiness
    assert.equal(readiness.sourceAdmitted, false)
    assert.ok(readiness.blockers.includes('source_unadmitted'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('legacy v1 history permits a distinct task-aware v2 successor without inherited evidence', () => {
  const { root, engine, targetX, targetY, fail, prepare, settle } = buildEngine()
  const legacyPolicy = (target, session, turnId, mode) => {
    const prepared = prepare(session, turnId, target === targetX ? '测试 JSON 输出。' : '部署 API 服务。')
    const probe = engine.store.read().recallStrategy.adaptive.probes
      .find(row => row.turnKey === prepared.turnKey)
    const legacy = synthesizeAdaptivePolicy({ scope: probe.scope, qualification: RECALL_QUALIFICATION.id,
      entry: target, queryFeatures: ['null'], turnKey: probe.turnKey, session: probe.session,
      queryKey: probe.taskQuery ?? probe.query, now: 1_800_000_000_000 })
    assert.deepEqual(legacy.features, ['null'], 'the fixture preserves the observed legacy v1 condition')
    legacy.mode = mode
    if (mode === 'isolated') {
      legacy.generation = 1
      legacy.rejections = 1
      legacy.reason = 'native_recurrence'
    }
    engine.store.transaction(doc => { doc.recallStrategy.adaptive.policies.push(legacy); return true })
    return { prepared, legacy }
  }
  try {
    const { prepared, legacy } = legacyPolicy(targetX, 'legacy-null-session', 'legacy-null-turn', 'isolated')
    fail('legacy-null-session', 'legacy-null-turn', 'legacy-null-failure', failureX)
    settle('legacy-null-session', 'legacy-null-turn')
    let policies = engine.store.read().recallStrategy.adaptive.policies
    const created = policies.find(row => row.entryId === targetX.id && row.schema === 'mse-adaptive-recall-v2')
    assert.ok(created, 'a real miss reaches a new v2 condition despite the isolated v1 history')
    assert.deepEqual(created.features, ['json', 'test'])
    assert.equal(created.positives, 1, 'legacy evidence is not inherited')
    assert.equal(created.samples.length, 1)
    assert.equal(created.samples[0].turnKey, prepared.turnKey)
    assert.equal(policies.find(row => row.id === legacy.id).mode, 'isolated')

    const repeat = prepare('legacy-null-session-2', 'legacy-null-turn-2', '这次测试 JSON 输出仍失败。')
    fail('legacy-null-session-2', 'legacy-null-turn-2', 'legacy-null-repeat-failure', failureX)
    settle('legacy-null-session-2', 'legacy-null-turn-2')
    policies = engine.store.read().recallStrategy.adaptive.policies
    assert.equal(policies.filter(row => row.entryId === targetX.id
      && row.schema === 'mse-adaptive-recall-v2').length, 1,
    'the same observing v2 mechanism is not duplicated')

    const blocked = legacyPolicy(targetY, 'legacy-observing-session', 'legacy-observing-turn', 'observing')
    const legacyReadiness = engine.statusView().recallStrategy.adaptive.recent
      .find(row => row.id === blocked.legacy.id).readiness
    assert.equal(legacyReadiness.schema, 'v1')
    assert.equal(legacyReadiness.independentGains, null,
      'legacy replay scores do not become v2 candidate gains')
    assert.equal(legacyReadiness.requiredIndependentGains, null)
    assert.equal(legacyReadiness.legacySuccessor, false)
    fail('legacy-observing-session', 'legacy-observing-turn', 'legacy-observing-failure', failureY)
    settle('legacy-observing-session', 'legacy-observing-turn')
    policies = engine.store.read().recallStrategy.adaptive.policies
    assert.equal(policies.find(row => row.id === blocked.legacy.id).mode, 'observing')
    const successor = policies.find(row => row.entryId === targetY.id
      && row.schema === 'mse-adaptive-recall-v2')
    assert.ok(successor, 'an observing v1 row cannot permanently block a real distinct v2 discovery')
    assert.equal(successor.positives, 1)
    assert.equal(successor.negativeControls, 0)
    assert.deepEqual(successor.samples.map(row => row.turnKey), [blocked.prepared.turnKey])
    const successorReadiness = engine.statusView().recallStrategy.adaptive.recent
      .find(row => row.id === blocked.legacy.id).readiness
    assert.equal(successorReadiness.legacySuccessor, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('one legacy discovery turn is not counted as an independent v1 holdout', () => {
  const { root, engine, targetX, fail, prepare, settle } = buildEngine()
  try {
    const seed = prepare('legacy-seed-session', 'legacy-seed-turn', 'API 调用遇到阻塞，请定位原因')
    const seedProbe = engine.store.read().recallStrategy.adaptive.probes
      .find(row => row.turnKey === seed.turnKey)
    const legacy = synthesizeAdaptivePolicy({ scope: seedProbe.scope,
      qualification: RECALL_QUALIFICATION.id, entry: targetX, queryFeatures: ['api'],
      turnKey: seedProbe.turnKey, session: seedProbe.session, queryKey: seedProbe.query,
      now: 1_800_000_000_000 })
    engine.store.transaction(doc => {
      doc.entries = doc.entries.filter(row => row.id === targetX.id)
      doc.recallStrategy.adaptive.policies.push(legacy)
      doc.recallStrategy.adaptive.probes = doc.recallStrategy.adaptive.probes
        .filter(row => row.turnKey !== seed.turnKey)
      return true
    })

    const turn = prepare('legacy-successor-session', 'successor-turn',
      'API 请求返回异常结果，帮我排查接口调用问题')
    const probe = engine.store.read().recallStrategy.adaptive.probes
      .find(row => row.turnKey === turn.turnKey)
    assert.ok(probe.shadowPolicies.includes(legacy.id), 'the legacy observer is actually shadowed')
    assert.notEqual(probe.query, legacy.firstQuery, 'the real user query is independent')
    fail('legacy-successor-session', 'successor-turn', 'legacy-successor-failure', failureX)
    settle('legacy-successor-session', 'successor-turn')

    const policies = engine.store.read().recallStrategy.adaptive.policies
    const oldPolicy = policies.find(row => row.id === legacy.id)
    const successor = policies.find(row => row.entryId === targetX.id
      && row.schema === 'mse-adaptive-recall-v2')
    assert.equal(oldPolicy.positives, 1, 'the discovery event cannot also grow the legacy holdout count')
    assert.equal(oldPolicy.samples.length, 1)
    assert.equal(successor.positives, 1, 'the new v2 discovery is not an independent gain')
    assert.equal(successor.negativeControls, 0)
    assert.equal(successor.samples.length, 1)
    assert.equal(successor.samples[0].result, 'discovery_hit')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a bridged v1 observer stops collecting later holdouts and controls', () => {
  const { root, engine, targetX, fail, prepare, settle } = buildEngine()
  try {
    const seed = prepare('legacy-bridge-seed', 'seed', '测试 JSON 输出。')
    const seedProbe = engine.store.read().recallStrategy.adaptive.probes
      .find(row => row.turnKey === seed.turnKey)
    const legacy = synthesizeAdaptivePolicy({ scope: seedProbe.scope,
      qualification: RECALL_QUALIFICATION.id, entry: targetX, queryFeatures: ['json', 'test'],
      turnKey: seed.turnKey, session: seedProbe.session, queryKey: seedProbe.query,
      now: 1_800_000_000_000 })
    legacy.positives = 3
    legacy.negativeControls = 4
    engine.store.transaction(doc => { doc.recallStrategy.adaptive.policies.push(legacy); return true })
    const originalLegacy = structuredClone(legacy)
    settle('legacy-bridge-seed', 'seed', 'unknown')

    prepare('legacy-bridge-discovery', 'discovery', '测试 JSON 输出。')
    fail('legacy-bridge-discovery', 'discovery', 'legacy-bridge-discovery-failure', failureX)
    settle('legacy-bridge-discovery', 'discovery')
    let state = engine.store.read().recallStrategy.adaptive
    let successor = state.policies.find(row => row.entryId === targetX.id
      && row.schema === 'mse-adaptive-recall-v2')
    assert.ok(successor)
    assert.equal(successor.positives, 1)

    const holdout = prepare('legacy-bridge-holdout', 'holdout', 'JSON 单测输出')
    const holdoutProbe = engine.store.read().recallStrategy.adaptive.probes
      .find(row => row.turnKey === holdout.turnKey)
    assert.deepEqual(holdoutProbe.taskFeatures, ['json', 'test'])
    assert.ok(holdoutProbe.shadowPolicies.includes(successor.id))
    assert.ok(!holdoutProbe.shadowPolicies.includes(legacy.id), 'the bridged v1 observer is no longer tracked')
    fail('legacy-bridge-holdout', 'holdout', 'legacy-bridge-holdout-failure', failureX)
    settle('legacy-bridge-holdout', 'holdout')

    const control = prepare('legacy-bridge-control', 'control', '绘制图表并调整配色')
    const controlProbe = engine.store.read().recallStrategy.adaptive.probes
      .find(row => row.turnKey === control.turnKey)
    assert.ok(controlProbe.controlPolicies.includes(successor.id))
    assert.ok(!controlProbe.controlPolicies.includes(legacy.id), 'the bridged v1 gets no duplicate control')
    fail('legacy-bridge-control', 'control', 'legacy-bridge-control-failure', failureZ)
    settle('legacy-bridge-control', 'control')

    state = engine.store.read().recallStrategy.adaptive
    successor = state.policies.find(row => row.id === successor.id)
    assert.equal(successor.positives, 2, 'only the v2 successor gains the independent holdout')
    assert.equal(successor.negativeControls, 1, 'only the v2 successor receives the control')
    assert.equal(successor.mode, 'observing', 'one holdout/control pair cannot auto-approve')
    assert.deepEqual(state.policies.find(row => row.id === legacy.id), originalLegacy,
      'the previous v1 evidence is retained verbatim')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('settlement refuses a legacy holdout when its v2 successor appeared after preparation', () => {
  const { root, engine, targetX, fail, prepare, settle } = buildEngine()
  try {
    const seed = prepare('legacy-race-seed', 'seed', '测试 JSON 输出。')
    const seedProbe = engine.store.read().recallStrategy.adaptive.probes
      .find(row => row.turnKey === seed.turnKey)
    const legacy = synthesizeAdaptivePolicy({ scope: seedProbe.scope,
      qualification: RECALL_QUALIFICATION.id, entry: targetX, queryFeatures: ['json', 'test'],
      turnKey: seed.turnKey, session: seedProbe.session, queryKey: seedProbe.query,
      now: 1_800_000_000_000 })
    legacy.positives = 3
    legacy.negativeControls = 4
    engine.store.transaction(doc => { doc.recallStrategy.adaptive.policies.push(legacy); return true })
    const originalLegacy = structuredClone(legacy)
    settle('legacy-race-seed', 'seed', 'unknown')

    prepare('legacy-race-inflight', 'holdout', 'JSON 单测输出')
    const oldProbe = engine.store.read().recallStrategy.adaptive.probes.at(-1)
    assert.ok(oldProbe.shadowPolicies.includes(legacy.id))
    prepare('legacy-race-discovery', 'discovery', '测试 JSON 输出。')
    fail('legacy-race-discovery', 'discovery', 'legacy-race-discovery-failure', failureX)
    settle('legacy-race-discovery', 'discovery')
    let state = engine.store.read().recallStrategy.adaptive
    const successor = state.policies.find(row => row.entryId === targetX.id
      && row.schema === 'mse-adaptive-recall-v2')
    assert.ok(successor)

    fail('legacy-race-inflight', 'holdout', 'legacy-race-holdout-failure', failureX)
    settle('legacy-race-inflight', 'holdout')
    state = engine.store.read().recallStrategy.adaptive
    assert.deepEqual(state.policies.find(row => row.id === legacy.id), originalLegacy,
      'settlement checks the successor even when the prepared probe only knew v1')
    assert.equal(state.policies.find(row => row.id === successor.id).positives, 1,
      'a pre-successor probe cannot manufacture v2 holdout evidence')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an observing same-feature legacy v1 can bridge while an isolated one remains blocked', () => {
  const makeCase = mode => {
    const fixture = buildEngine()
    const { root, engine, targetX, fail, prepare, settle } = fixture
    try {
      const seed = prepare(`legacy-${mode}-seed`, 'seed', '请测试 JSON 输出是否正确')
      const seedProbe = engine.store.read().recallStrategy.adaptive.probes
        .find(row => row.turnKey === seed.turnKey)
      let entry
      engine.store.transaction(doc => {
        doc.entries = doc.entries.filter(row => row.id === targetX.id)
        entry = doc.entries.find(row => row.id === targetX.id)
        doc.recallStrategy.adaptive.probes = doc.recallStrategy.adaptive.probes
          .filter(row => row.turnKey !== seed.turnKey)
        return true
      })
      const legacy = synthesizeAdaptivePolicy({ scope: seedProbe.scope,
        qualification: RECALL_QUALIFICATION.id, entry, queryFeatures: ['json', 'test'],
        turnKey: seed.turnKey, session: seedProbe.session, queryKey: seedProbe.query, now: 1_800_000_000_000 })
      legacy.mode = mode
      if (mode === 'isolated') {
        legacy.generation = 1
        legacy.rejections = 1
        legacy.reason = 'native_recurrence'
      }
      engine.store.transaction(doc => { doc.recallStrategy.adaptive.policies.push(legacy); return true })

      const turn = prepare(`legacy-${mode}-successor`, 'successor', '测试一下 JSON 输出是否正确')
      const candidateProbe = engine.store.read().recallStrategy.adaptive.probes
        .find(row => row.turnKey === turn.turnKey)
      assert.deepEqual(candidateProbe.taskFeatures, ['json', 'test'])
      assert.notEqual(candidateProbe.query, legacy.firstQuery)
      if (mode === 'observing') assert.ok(candidateProbe.shadowPolicies.includes(legacy.id),
        JSON.stringify({ features: legacy.features, entryId: legacy.entryId,
          offered: candidateProbe.offered, baseline: candidateProbe.baselineOffers,
          comparisons: candidateProbe.comparisons, controls: candidateProbe.controlPolicies }))
      fail(`legacy-${mode}-successor`, 'successor', 'legacy-successor-failure', failureX)
      settle(`legacy-${mode}-successor`, 'successor')
      const policies = engine.store.read().recallStrategy.adaptive.policies
      const successor = policies.find(row => row.entryId === targetX.id
        && row.schema === 'mse-adaptive-recall-v2')
      if (mode === 'observing') {
        assert.ok(successor, 'same-feature v1 observing history permits a fresh v2 candidate')
        assert.deepEqual(successor.features, legacy.features)
        assert.equal(successor.positives, 1)
        assert.equal(successor.negativeControls, 0)
      } else {
        assert.equal(successor, undefined, 'same-feature isolated v1 remains a discovery boundary')
      }
      assert.equal(policies.find(row => row.id === legacy.id).mode, mode)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
  makeCase('observing')
  makeCase('isolated')
})

test('legacy evidence survives a normal revision and cannot discover against needs_revision', () => {
  const { root, engine, targetX, fail, prepare, settle } = buildEngine()
  try {
    engine.setRoute({ provider: 'test', model: 'local' })
    const seed = prepare('legacy-revision-seed', 'seed', '测试 JSON 输出。')
    const seedProbe = engine.store.read().recallStrategy.adaptive.probes
      .find(row => row.turnKey === seed.turnKey)
    const legacy = synthesizeAdaptivePolicy({ scope: seedProbe.scope,
      qualification: RECALL_QUALIFICATION.id, entry: targetX, queryFeatures: ['json', 'test'],
      turnKey: seed.turnKey, session: seedProbe.session, queryKey: seedProbe.query,
      now: 1_800_000_000_000 })
    legacy.positives = 3
    legacy.negativeControls = 4
    engine.store.transaction(doc => { doc.recallStrategy.adaptive.policies.push(legacy); return true })
    const originalLegacy = structuredClone(legacy)

    const recurrence = prepare('revision-session', 'recurrence',
      '文档字段版本不一致时，先核对字段版本，再验证发布记录')
    assert.ok(recurrence.offered.some(row => row.id === targetX.id && row.version === 1
      && row.mode === 'method'))
    fail('revision-session', 'recurrence', 'revision-recurrence', failureX)
    settle('revision-session', 'recurrence')
    assert.equal(engine.store.read().entries.find(row => row.id === targetX.id).status, 'needs_revision')
    const readiness = engine.statusView().recallStrategy.adaptive.recent
      .find(row => row.id === legacy.id).readiness
    assert.ok(readiness.blockers.includes('needs_revision'))

    const guarded = prepare('guarded-legacy-session', 'guarded', '测试 JSON 输出。')
    assert.ok(!guarded.offered.some(row => row.id === targetX.id && row.mode === 'method'))
    fail('guarded-legacy-session', 'guarded', 'guarded-legacy-failure', failureX)
    settle('guarded-legacy-session', 'guarded')
    let state = engine.store.read()
    assert.equal(state.recallStrategy.adaptive.policies.find(row => row.id === legacy.id)
      .positives, 3, 'the guarded target cannot extend legacy evidence')
    assert.equal(state.recallStrategy.adaptive.policies.filter(row => row.schema === 'mse-adaptive-recall-v2')
      .length, 0, 'needs_revision cannot seed a v2 successor')

    const work = engine.beginWork()
    assert.equal(work?.kind, 'revise')
    const evidenceIds = JSON.parse(work.request.text).evidenceIds
    engine.markDispatched(work.ticket)
    const revised = engine.finishWork({ ticket: work.ticket,
      usage: { input: 10, output: 20, total: 30 }, result: {
        schema: 'mse-failure-lesson-v1', applicability: 'API endpoint rejected by server',
        failurePattern: 'API request was rejected by server',
        rootCause: { summary: 'API server rejected the endpoint request', basis: 'observed',
          evidenceIds: [evidenceIds[0]] },
        repairSteps: ['Check the API endpoint and server response',
          'Retry the request with the current field version'],
        verification: { check: 'Run API endpoint validation', expected: 'Server accepts the request' },
        instruction: 'When the API server rejects a request, verify the endpoint and current field version',
      } })
    assert.equal(revised.revision, 'replaced')
    assert.equal(revised.version, 2)

    prepare('legacy-current-v2-session', 'new-discovery', '测试 JSON 输出。')
    fail('legacy-current-v2-session', 'new-discovery', 'current-v2-failure', failureX)
    settle('legacy-current-v2-session', 'new-discovery')
    state = engine.store.read()
    const retainedLegacy = state.recallStrategy.adaptive.policies.find(row => row.id === legacy.id)
    assert.deepEqual(retainedLegacy, originalLegacy, 'archiving the old version preserves its v1 row verbatim')
    const successor = state.recallStrategy.adaptive.policies.find(row => row.entryId === targetX.id
      && row.version === 2 && row.schema === 'mse-adaptive-recall-v2')
    assert.ok(successor, 'a new current edition can learn through a normal revision')
    assert.equal(successor.positives, 1)
    assert.equal(successor.negativeControls, 0)
    assert.equal(successor.mode, 'observing')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.after(cleanupAdaptiveEngineFixture)
