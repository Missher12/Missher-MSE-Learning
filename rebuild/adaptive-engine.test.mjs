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
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an isolated legacy v1 null policy permits one distinct task-aware v2 discovery', () => {
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
    fail('legacy-observing-session', 'legacy-observing-turn', 'legacy-observing-failure', failureY)
    settle('legacy-observing-session', 'legacy-observing-turn')
    policies = engine.store.read().recallStrategy.adaptive.policies
    assert.equal(policies.find(row => row.id === blocked.legacy.id).mode, 'observing')
    assert.equal(policies.some(row => row.entryId === targetY.id
      && row.schema === 'mse-adaptive-recall-v2'), false,
    'an existing non-isolated legacy method is not duplicated')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test.after(cleanupAdaptiveEngineFixture)
