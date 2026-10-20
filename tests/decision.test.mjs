import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { LearningEngine } from '../src/index.mjs'
import { decisionCredentialRef, decisionEndpointError, decisionEndpointRoutes, discoverDecisionModels,
  requestDecision } from '../src/decision-providers.mjs'

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))

function fixture(t, { tokens = 20_000, calls = 5 } = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-decision-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  let now = Date.UTC(2030, 0, 1)
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh', evaluationTokensPerDay: tokens,
    evaluationCallsPerDay: calls, now: () => now })
  const created = engine.record({ projectKey: '/synthetic/decision', source: 'host_proposal', kind: 'method',
    eventId: `decision-${Math.random().toString(16).slice(2)}`,
    instruction: '处理请求时先记录代次，再丢弃迟到结果' })
  const lesson = engine.list({ projectKey: '/synthetic/decision', limit: 10 }).lessons.find(row => row.id === created.id)
  const context = engine.decisionContext({ lessonId: lesson.id, projectKey: '/synthetic/decision' })
  const input = ({ backend = 'host', model = 'host-model', provider = 'host', endpoint = undefined,
    fallbackRoute = undefined } = {}) => ({
    candidateId: context.candidateId, version: context.version, projectHash: context.projectHash,
    evidenceRevision: context.evidenceRevision, ruleVersion: 'decision-v1', role: 'triage', backend,
    model, provider, ...(endpoint === undefined ? {} : { endpoint }),
    ...(fallbackRoute === undefined ? {} : { fallbackRoute }), evidence: { ...context },
    inputTokens: 400, outputTokens: 200,
  })
  return { engine, context, input, stateRoot, getNow: () => now, setNow: value => { now = value } }
}

function reflectedMergeCandidate(f, instruction, turnId) {
  const prepared = f.engine.reflectionRequest({ projectKey: '/synthetic/decision', sessionId: 'merge-source',
    turnId, outcome: 'supported', taskSummary: '修改 package.json 前先核对 JSON 结构和字段类型',
    resultSummary: '已检查 JSON 字段并保留无关配置，记录适用方法' })
  assertOrdinaryReflectionTicket(f.engine, prepared)
  const result = f.engine.reflectionResult({ ticket: prepared.ticket, result: { instruction },
    usage: { known: true, totalTokens: 3 } })
  assert.equal(result.ok, true)
  return result.id
}

function assertPreparedReflection(prepared) {
  assert.equal(prepared.ok, true)
  assert.equal(prepared.skipped, undefined, 'a skipped response is not a prepared reflection ticket')
  assert.equal(typeof prepared.ticket, 'string')
}

function assertOrdinaryReflectionTicket(engine, prepared) {
  assertPreparedReflection(prepared)
  assert.match(prepared.dispatchHash, /^[a-f0-9]{64}$/u)
  assert.equal(prepared.request.maxTokens, 384)
  const event = engine.store.read().events.find(row => row.reflection === true && row.ticket === prepared.ticket)
  assert.ok(event, 'the prepared reflection ticket is persisted')
  assert.equal(event.requestPolicy, 'reflection-v1')
  assert.equal(event.requestMaxTokens, 384)
  assert.equal(event.requestHash, prepared.dispatchHash)
  assert.equal(event.generationRequestHash, undefined, 'ordinary reflection does not reserve a generation request')
  assert.equal(event.requestDispatchAt, undefined, 'preparation does not count as a physical dispatch')
}

function assertGenerationTicket(prepared) {
  assertPreparedReflection(prepared)
  assert.match(prepared.dispatchHash, /^[a-f0-9]{64}$/u)
}

function proposeMerge(f, primaryId, targetId) {
  const context = f.engine.decisionContext({ lessonId: primaryId, projectKey: '/synthetic/decision' })
  const request = f.engine.decisionRequest({ candidateId: context.candidateId, version: context.version,
    projectHash: context.projectHash, evidenceRevision: context.evidenceRevision,
    ruleVersion: 'merge-core-test', role: 'candidate-routing', backend: 'host', provider: 'host',
    model: 'host-model', evidence: { refs: context.evidenceRefs, mergeCandidates: context.mergeCandidates },
    inputTokens: 80, outputTokens: 32 })
  assert.equal(request.ok, true)
  assert.equal(f.engine.decisionStarted({ ticket: request.ticket, requestHash: request.requestHash }).ok, true)
  const completed = f.engine.decisionComplete({ ticket: request.ticket, model: 'host-model',
    result: { action: 'suggest_merge', mergeTarget: { id: targetId, version: 1 }, confidence: 0.8,
      confidenceMeaning: 'advisory', reasons: ['同一登记域且适用条件一致'], riskCodes: [] },
    usage: { totalTokens: 10 }, complete: true, abstention: false,
    evidenceRevision: context.evidenceRevision, version: context.version })
  assert.equal(completed.ok, true)
  return { context, decisionId: completed.record.key }
}

function preparedMerge(f, suffix) {
  const primary = reflectedMergeCandidate(f,
    '修改 package.json 前先解析 JSON 结构，再核对 scripts 字段类型并保留无关字段。', `${suffix}-one`)
  f.setNow(f.getNow() + 31 * 60_000)
  const partner = reflectedMergeCandidate(f,
    '编辑 package.json 时先校验 JSON 字段类型，最后确认自定义字段仍然保留。', `${suffix}-two`)
  f.setNow(f.getNow() + 31 * 60_000)
  const { decisionId } = proposeMerge(f, primary, partner)
  const plan = f.engine.decisionMergePlan({ decisionId, projectKey: '/synthetic/decision' })
  const source = f.engine.sourcePublish({ sessionId: plan.source.sessionId, projectKey: '/synthetic/decision',
    provider: 'host', model: 'host-model', apiMode: null, baseUrl: null,
    reasoningState: 'unspecified', reasoningValue: null, driver: 'dsh_host_stream' })
  const prepared = f.engine.reflectionRequest({ sessionId: plan.source.sessionId, turnId: `${suffix}-ticket`,
    projectKey: '/synthetic/decision', outcome: 'supported', taskSummary: '按冻结约束生成并核验合并候选',
    resultSummary: `${suffix}: 核验来源绑定和派发状态`,
    sourceBinding: true, sourceRevision: source.revision, sourceBindingHash: source.bindingHash,
    controlGeneration: f.engine.controlGeneration(), generation: { decisionId, generationKey: plan.generationKey } })
  assertGenerationTicket(prepared)
  return { decisionId, plan, source, prepared }
}

test('decision reservation uses the shared ticket budget once and dispatch rechecks lowered allowance', t => {
  const f = fixture(t)
  const reserved = f.engine.decisionRequest(f.input())
  assert.equal(reserved.ok, true)
  assert.equal(f.engine.status().evaluationTokensReserved24h, 600)
  f.engine.configure({ evaluationTokensPerDay: 0 })
  const started = f.engine.decisionStarted({ ticket: reserved.ticket, requestHash: reserved.requestHash })
  assert.equal(started.ok, false)
  assert.equal(started.code, 'evaluation_budget')
})

test('unknown paid decision cannot be bought again by changing route on the same evidence', t => {
  const f = fixture(t)
  const first = f.engine.decisionRequest(f.input())
  assert.equal(f.engine.decisionStarted({ ticket: first.ticket, requestHash: first.requestHash }).ok, true)
  assert.equal(f.engine.decisionFail({ ticket: first.ticket, code: 'provider_failed', usage: null }).ok, true)
  const switched = f.engine.decisionRequest(f.input({ backend: 'openai_compatible', model: 'other-model',
    provider: 'compatible', endpoint: 'https://example.test/v1/chat/completions' }))
  assert.equal(switched.ok, true)
  assert.equal(switched.duplicate, true)
  assert.equal(switched.record.state, 'unknown')
  assert.equal(f.engine.status().evaluationCallsLast24h, 1)
})

test('a settled known format failure permits one new policy evaluation and cold reads do not repeat it', t => {
  const f = fixture(t)
  const oldInput = { ...f.input({ backend: 'openai_compatible', model: 'remote-model', provider: 'compatible',
    endpoint: 'https://example.test/v1' }), ruleVersion: 'experience-upgrade-v1', outputTokens: 512 }
  const old = f.engine.decisionRequest(oldInput)
  assert.equal(f.engine.decisionStarted({ ticket: old.ticket, requestHash: old.requestHash }).ok, true)
  assert.equal(f.engine.decisionFail({ ticket: old.ticket, code: 'decision_invalid_json',
    usage: { inputTokens: 40, outputTokens: 8 } }).ok, true)
  f.setNow(f.getNow() + 24 * 60 * 60_000 + 1)
  const upgradedInput = { ...f.input(), ruleVersion: 'experience-upgrade-v2-host-output-2048', outputTokens: 2048 }
  const upgraded = f.engine.decisionRequest(upgradedInput)
  assert.equal(upgraded.ok, true)
  assert.equal(upgraded.duplicate, false)
  assert.equal(f.engine.decisionStarted({ ticket: upgraded.ticket, requestHash: upgraded.requestHash }).ok, true)
  assert.equal(f.engine.decisionComplete({ ticket: upgraded.ticket, model: 'host-model',
    result: { action: 'review', confidence: 0.8, confidenceMeaning: 'advisory', reasons: [], riskCodes: [] },
    usage: { totalTokens: 16 }, evidenceRevision: f.context.evidenceRevision, version: f.context.version }).ok, true)

  const restarted = new LearningEngine({ stateRoot: f.stateRoot, adapterId: 'dsh', evaluationTokensPerDay: 20_000,
    evaluationCallsPerDay: 5, now: f.getNow })
  const duplicate = restarted.decisionRequest(upgradedInput)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.record.ticket, upgraded.ticket)
  const changedRoute = restarted.decisionRequest({ ...upgradedInput, backend: 'openai_compatible',
    model: 'other-model', provider: 'compatible', endpoint: 'https://other.example/v1' })
  assert.equal(changedRoute.duplicate, true, 'the transitioned policy does not spend again under another route')
  assert.equal(restarted.status().evaluationCallsLast24h, 1, 'the old spend aged out while its decision fact remained')
})

test('zero-dispatch budget waits can continue after the allowance is restored', t => {
  const f = fixture(t, { tokens: 300 })
  const old = f.engine.decisionRequest({ ...f.input(), ruleVersion: 'experience-upgrade-v1', outputTokens: 512 })
  assert.equal(old.ok, false)
  assert.equal(old.code, 'evaluation_budget')
  assert.equal(f.engine.status().evaluationCallsLast24h, 0)
  f.engine.configure({ evaluationTokensPerDay: 0 })
  const policyWait = f.engine.decisionRequest({ ...f.input(), ruleVersion: 'experience-upgrade-v2-host-output-2048',
    outputTokens: 2048 })
  assert.equal(policyWait.ok, false)
  assert.equal(policyWait.code, 'evaluation_budget', 'the Host fallback guard does not mislabel a zero-dispatch wait')
  f.engine.configure({ evaluationTokensPerDay: 20_000 })
  const next = f.engine.decisionRequest({ ...f.input({ model: 'host-model-after-budget' }),
    ruleVersion: 'experience-upgrade-v2-host-output-2048', outputTokens: 2048 })
  assert.equal(next.ok, true)
  assert.equal(next.duplicate, false)
  assert.equal(f.engine.status().evaluationCallsLast24h, 0, 'the resumed request remains undispatched')
  assert.equal(f.engine.store.read().jobs.find(row => row.ticket === next.ticket)?.stepReservations[0].outputTokens, 2048)
})

test('an existing queued reservation is preserved when its output cap changes without a policy identity change', t => {
  const f = fixture(t)
  const old = f.engine.decisionRequest({ ...f.input(), ruleVersion: 'experience-upgrade-v2-host-output-2048',
    outputTokens: 512 })
  assert.equal(old.ok, true)
  const changedCap = f.engine.decisionRequest({ ...f.input(), ruleVersion: 'experience-upgrade-v2-host-output-2048',
    outputTokens: 2048 })
  assert.equal(changedCap.duplicate, true)
  assert.equal(changedCap.record.ticket, old.ticket)
  const job = f.engine.store.read().jobs.find(row => row.ticket === old.ticket)
  const reservation = job.stepReservations.find(row => row.stepKey === 'decision')
  assert.equal(reservation.outputTokens, 512)
  assert.equal(reservation.requestHash, old.requestHash)
})

test('a zero-dispatch wait under the new policy does not block a later route after an old known failure', t => {
  const f = fixture(t)
  const old = f.engine.decisionRequest({ ...f.input(), ruleVersion: 'experience-upgrade-v1', outputTokens: 512 })
  assert.equal(f.engine.decisionStarted({ ticket: old.ticket, requestHash: old.requestHash }).ok, true)
  assert.equal(f.engine.decisionFail({ ticket: old.ticket, code: 'decision_invalid_json',
    usage: { inputTokens: 40, outputTokens: 8 } }).ok, true)

  f.engine.configure({ evaluationTokensPerDay: 0 })
  const firstPolicyAttempt = f.engine.decisionRequest({ ...f.input(),
    ruleVersion: 'experience-upgrade-v2-host-output-2048', outputTokens: 2048 })
  assert.equal(firstPolicyAttempt.ok, false)
  assert.equal(firstPolicyAttempt.code, 'evaluation_budget')
  f.engine.configure({ evaluationTokensPerDay: 20_000 })
  const changedRoute = f.engine.decisionRequest({ ...f.input({ model: 'alternate-host-model' }),
    ruleVersion: 'experience-upgrade-v2-host-output-2048', outputTokens: 2048 })
  assert.equal(changedRoute.ok, true)
  assert.equal(changedRoute.duplicate, false)
  assert.equal(f.engine.store.read().jobs.find(row => row.ticket === changedRoute.ticket)
    ?.stepReservations[0].outputTokens, 2048)
})

test('generic settled decisions remain eligible under a later explicit rule version', t => {
  const f = fixture(t)
  const old = f.engine.decisionRequest({ ...f.input(), ruleVersion: 'generic-rule-v1' })
  assert.equal(f.engine.decisionStarted({ ticket: old.ticket, requestHash: old.requestHash }).ok, true)
  assert.equal(f.engine.decisionComplete({ ticket: old.ticket, model: 'host-model',
    result: { action: 'wait', confidence: 0.5, confidenceMeaning: 'advisory', reasons: [], riskCodes: [] },
    usage: { totalTokens: 10 }, evidenceRevision: f.context.evidenceRevision, version: f.context.version }).ok, true)
  const changedRule = f.engine.decisionRequest({ ...f.input(), ruleVersion: 'generic-rule-v2',
    role: 'new-policy-role' })
  assert.equal(changedRule.ok, true)
  assert.equal(changedRule.duplicate, false)
})

test('unknown old decisions stay fenced across backend, route, prompt identity, restart, and rolling prune', t => {
  for (const [oldBackend, newBackend] of [['host', 'openai_compatible'],
    ['openai_compatible', 'host'], ['openai_compatible', 'jev']]) {
    const f = fixture(t)
    const backendInput = backend => backend === 'host' ? f.input() : f.input({ backend,
      model: `${backend}-model`, provider: backend, endpoint: `https://${backend}.example/v1` })
    const old = f.engine.decisionRequest({ ...backendInput(oldBackend), ruleVersion: 'experience-upgrade-v1',
      outputTokens: 512 })
    assert.equal(f.engine.decisionStarted({ ticket: old.ticket, requestHash: old.requestHash }).ok, true)
    assert.equal(f.engine.decisionFail({ ticket: old.ticket, code: 'provider_failed', usage: null }).ok, true)
    f.setNow(f.getNow() + 31 * 60_000)
    const restarted = new LearningEngine({ stateRoot: f.stateRoot, adapterId: 'dsh', evaluationTokensPerDay: 20_000,
      evaluationCallsPerDay: 5, now: f.getNow })
    assert.equal(restarted.recoverAutoPlans().ok, true)
    f.setNow(f.getNow() + 24 * 60 * 60_000 + 1)
    const changed = { ...backendInput(newBackend), ruleVersion: 'experience-upgrade-v2-host-output-2048',
      role: 'changed-role', evidence: { ...f.input().evidence, screeningPolicy: 'synthetic-v2' }, outputTokens: 2048 }
    const fenced = restarted.decisionRequest(changed)
    assert.equal(fenced.duplicate, true, `${oldBackend} to ${newBackend}`)
    assert.equal(fenced.record.state, 'unknown')
    const state = restarted.store.read()
    assert.equal(state.decisionRecords.length, 1)
    assert.equal(state.jobs.length, 0)
    assert.equal(state.spends.some(row => row.ticket === old.ticket), false,
      'the 24-hour spend prune does not erase the unknown decision fence')
  }
})

test('pending Host fallback continues the old logical ticket with its existing 512-token reservation', t => {
  const f = fixture(t)
  const fallbackRoute = { provider: 'host', model: 'host-model', apiMode: 'host_llm_stream',
    reasoningEffort: 'unspecified' }
  const oldInput = { ...f.input({ backend: 'openai_compatible', model: 'remote-model', provider: 'compatible',
    endpoint: 'https://example.test/v1', fallbackRoute }), ruleVersion: 'experience-upgrade-v1', outputTokens: 512 }
  const primary = f.engine.decisionRequest(oldInput)
  assert.equal(f.engine.decisionStarted({ ticket: primary.ticket, requestHash: primary.requestHash }).ok, true)
  assert.equal(f.engine.decisionComplete({ ticket: primary.ticket, model: 'remote-model',
    result: { action: 'wait', confidence: 0.4, confidenceMeaning: 'advisory', reasons: ['uncertain'], riskCodes: [] },
    usage: { inputTokens: 80, outputTokens: 20 }, evidenceRevision: f.context.evidenceRevision,
    version: f.context.version, fallbackPending: true }).needsHostFallback, true)
  const requestHash = 'e'.repeat(64)
  const reserved = f.engine.decisionReserveFallback({ ticket: primary.ticket, inputTokens: 400,
    outputTokens: 512, requestHash, provider: fallbackRoute.provider, model: fallbackRoute.model,
    apiMode: fallbackRoute.apiMode, reasoningEffort: fallbackRoute.reasoningEffort })
  assert.equal(reserved.ok, true)

  const upgraded = f.engine.decisionRequest({ ...f.input(), ruleVersion: 'experience-upgrade-v2-host-output-2048',
    outputTokens: 2048 })
  assert.equal(upgraded.resumeFallback, true)
  assert.equal(upgraded.record.ticket, primary.ticket)
  assert.equal(upgraded.record.ruleVersion, 'experience-upgrade-v1')
  const resumedReservation = f.engine.decisionReserveFallback({ ticket: primary.ticket, inputTokens: 400,
    outputTokens: 512, requestHash, provider: fallbackRoute.provider, model: fallbackRoute.model,
    apiMode: fallbackRoute.apiMode, reasoningEffort: fallbackRoute.reasoningEffort })
  assert.equal(resumedReservation.duplicate, true)
  assert.equal(f.engine.decisionStarted({ ticket: primary.ticket, stepKey: 'decision:host', requestHash }).ok, true)
  assert.equal(f.engine.decisionComplete({ ticket: primary.ticket, stepKey: 'decision:host', model: 'host-model',
    result: { action: 'review', confidence: 0.8, confidenceMeaning: 'advisory', reasons: [], riskCodes: [] },
    usage: { totalTokens: 10 }, evidenceRevision: f.context.evidenceRevision, version: f.context.version }).ok, true)
  const after = f.engine.decisionRequest({ ...f.input(), ruleVersion: 'experience-upgrade-v2-host-output-2048',
    outputTokens: 2048 })
  assert.equal(after.ok, false)
  assert.equal(after.code, 'decision_policy_transition_fenced')
  assert.equal(f.engine.status().evaluationCallsLast24h, 1)
  assert.equal(f.engine.status().evaluationRequestsLast24h, 2)
})

test('decision CLI projects long opinions and dual checkpoints while durable paid audit remains intact', t => {
  const f = fixture(t)
  const input = f.input({ backend: 'openai_compatible', model: 'decision-model', provider: 'compatible',
    endpoint: 'https://example.test/v1/chat/completions' })
  const queued = f.engine.decisionRequest(input)
  assert.equal(queued.ok, true)
  const checkpoint = 'paid-checkpoint-' + '原始审计'.repeat(600)
  const opinion = { action: 'wait', confidence: 0.5, confidenceMeaning: 'advisory',
    reasons: ['风险依据'.repeat(40)], riskCodes: ['风险代码'.repeat(10)], evidenceRefs: [] }
  f.engine.store.update(state => {
    const row = state.decisionRecords.find(item => item.key === queued.identity.key)
    row.checkpoint = { stepKey: 'decision', requestHash: 'a'.repeat(64), text: checkpoint,
      truncated: false, tokens: 100 }
    row.fallbackCheckpoint = { stepKey: 'decision:host', requestHash: 'b'.repeat(64), text: checkpoint,
      truncated: false, tokens: 80 }
    row.primaryResult = opinion
    row.fallbackResult = opinion
    row.finalResult = opinion
    row.usage = { inputTokens: 120, outputTokens: 60, totalTokens: 180 }
    row.primaryUsage = { inputTokens: 80, outputTokens: 20, totalTokens: 100 }
    row.fallbackUsage = { inputTokens: 40, outputTokens: 40, totalTokens: 80 }
  })
  const child = spawnSync(process.execPath, [cli], { encoding: 'utf8', input: JSON.stringify({
    config: { stateRoot: f.stateRoot, adapterId: 'dsh' }, op: 'decisionGet', input,
  }) })
  assert.equal(child.status, 0, child.stderr)
  assert.ok(Buffer.byteLength(child.stdout) < 8192, `bridge response was ${Buffer.byteLength(child.stdout)} bytes`)
  assert.doesNotMatch(child.stdout, /paid-checkpoint|原始审计/u)
  const projected = JSON.parse(child.stdout).record
  assert.deepEqual(projected.result, { action: 'wait', confidence: 0.5, confidenceMeaning: 'advisory',
    reasons: ['风险依据'.repeat(40)], riskCodes: ['风险代码'.repeat(10)], evidenceRefs: [] })
  assert.deepEqual(projected.primaryResult, projected.result)
  assert.equal(projected.usage.totalTokens, 180, 'paid aggregate remains visible to the caller')
  const durable = f.engine.store.read().decisionRecords.find(item => item.key === queued.identity.key)
  assert.equal(durable.checkpoint.text, checkpoint)
  assert.equal(durable.fallbackCheckpoint.text, checkpoint)
  assert.equal(durable.finalResult.reasons[0], opinion.reasons[0])
  assert.equal(durable.usage.totalTokens, 180)
})

test('stale evidence revision is refused and malformed opinions still settle measured usage', t => {
  const f = fixture(t)
  const stale = f.engine.decisionRequest({ ...f.input(), evidenceRevision: 1 })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'decision_evidence_changed')

  const ticket = f.engine.decisionRequest(f.input())
  assert.equal(f.engine.decisionStarted({ ticket: ticket.ticket, requestHash: ticket.requestHash }).ok, true)
  const failed = f.engine.decisionComplete({ ticket: ticket.ticket, result: '{bad json', evidenceRevision: 0,
    version: f.context.version, usage: { inputTokens: 410, outputTokens: 12 }, model: 'host-model' })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'decision_invalid_json')
  const status = f.engine.status()
  assert.equal(status.evaluationTokensKnown24h, 422, 'parser failure usage must be written to the dispatched step')
  assert.equal(status.evaluationCallsLast24h, 1)
})

test('decision context carries applicability, exclusions, and validator admission facts without silent truncation', t => {
  const f = fixture(t)
  const created = f.engine.record({ projectKey: '/synthetic/decision', source: 'host_proposal', kind: 'method',
    eventId: 'decision-context-conditions',
    instruction: '提交前核对当前代次与票据状态，发现重复请求时停止提交并核对结算记录',
    applicability: '仅适用于同一会话内的可重试提交',
    exclusions: '不适用于不可撤销或状态未知的外部写入' })
  const context = f.engine.decisionContext({ lessonId: created.id, projectKey: '/synthetic/decision' })
  assert.equal(context.applicability, '仅适用于同一会话内的可重试提交')
  assert.equal(context.exclusions, '不适用于不可撤销或状态未知的外部写入')
  assert.equal(context.contextIncomplete, false)
  assert.ok(Array.isArray(context.validators))
  assert.ok(context.validators.every(pack => typeof pack.packId === 'string'
    && Number.isSafeInteger(pack.version) && Number.isSafeInteger(pack.cases) && pack.cases >= 0
    && typeof pack.admitted === 'boolean'))

  const fullCondition = `仅适用于${'甲'.repeat(170)}`
  const long = f.engine.record({ projectKey: '/synthetic/decision', source: 'host_proposal', kind: 'method',
    eventId: 'decision-context-long-condition',
    instruction: '提交前核对当前代次与票据状态，发现重复请求时停止提交并核对结算记录',
    applicability: fullCondition })
  const incomplete = f.engine.decisionContext({ lessonId: long.id, projectKey: '/synthetic/decision' })
  assert.equal(incomplete.contextIncomplete, false)
  assert.equal(incomplete.applicability, fullCondition, 'the maximum supported condition is returned whole')
})

test('decision history defaults to the requested owner scope and lesson filtering only narrows it', t => {
  const f = fixture(t)
  const makeDecision = (projectKey, eventId) => {
    const created = f.engine.record({ ...(projectKey ? { projectKey } : {}), source: 'host_proposal', kind: 'method',
      eventId, instruction: '提交前核对当前代次并丢弃迟到结果。' })
    const context = f.engine.decisionContext({ lessonId: created.id, ...(projectKey ? { projectKey } : {}) })
    const route = { provider: 'host', model: 'host-model' }
    const queued = f.engine.decisionRequest({ candidateId: context.candidateId, version: context.version,
      projectHash: context.projectHash, evidenceRevision: context.evidenceRevision,
      ruleVersion: 'decision-history-test', role: 'triage', backend: 'host', ...route,
      evidence: { refs: context.evidenceRefs }, inputTokens: 20, outputTokens: 10 })
    assert.equal(queued.ok, true)
    assert.equal(f.engine.decisionStarted({ ticket: queued.ticket, requestHash: queued.requestHash }).ok, true)
    assert.equal(f.engine.decisionComplete({ ticket: queued.ticket, model: route.model,
      result: { action: 'wait', confidence: 0.5, confidenceMeaning: 'test', reasons: [], riskCodes: [] },
      usage: { totalTokens: 1 }, evidenceRevision: context.evidenceRevision, version: context.version }).ok, true)
    return created.id
  }
  const projectA = makeDecision('/synthetic/project-a', 'decision-history-a')
  const projectB = makeDecision('/synthetic/project-b', 'decision-history-b')
  const instance = makeDecision(undefined, 'decision-history-instance')
  assert.deepEqual(f.engine.decisionHistory({ projectKey: '/synthetic/project-a' }).rows.map(row => row.candidateId), [projectA])
  assert.deepEqual(f.engine.decisionHistory({ projectKey: '/synthetic/project-b' }).rows.map(row => row.candidateId), [projectB])
  assert.deepEqual(f.engine.decisionHistory({}).rows.map(row => row.candidateId), [instance],
    'an omitted project key means instance scope, never all project scopes')
  assert.deepEqual(f.engine.decisionHistory({ lessonId: projectA }).rows.map(row => row.candidateId), [],
    'lessonId is an additional filter inside the default instance scope')
  assert.deepEqual(f.engine.decisionHistory({ lessonId: projectA, projectKey: '/synthetic/project-a' })
    .rows.map(row => row.candidateId), [projectA])
})

test('ordinary reflected package candidates expose their shared registered verifier and merge plan', t => {
  const f = fixture(t)
  const primary = reflectedMergeCandidate(f,
    '修改 package.json 前先解析 JSON 结构，再核对 scripts 字段类型并保留无关字段。', 'merge-source-one')
  f.setNow(Date.UTC(2030, 0, 1) + 31 * 60_000)
  const partner = reflectedMergeCandidate(f,
    '编辑 package.json 时先校验 JSON 字段类型，最后确认自定义字段仍然保留。', 'merge-source-two')
  f.setNow(f.getNow() + 31 * 60_000)
  assert.notEqual(primary, partner)
  const context = f.engine.decisionContext({ lessonId: primary, projectKey: '/synthetic/decision' })
  assert.equal(context.registeredChecker, false)
  assert.ok(context.registeredVerifiers.includes('package-json-structure-v1@2'))
  assert.ok(context.mergeCandidates.some(row => row.id === partner && row.version === 1))
  const { decisionId } = proposeMerge(f, primary, partner)
  const plan = f.engine.decisionMergePlan({ decisionId, projectKey: '/synthetic/decision' })
  assert.equal(plan.ok, true)
  assert.equal(plan.registeredVerifier, 'package-json-structure-v1@2')
  assert.deepEqual(plan.parents.map(row => row.id), [primary, partner])
})

test('merge generation requires a frozen verifier/source and creates only an independent candidate', t => {
  const f = fixture(t)
  const primary = reflectedMergeCandidate(f,
    '修改 package.json 前先解析 JSON 结构，再核对 scripts 字段类型并保留无关字段。', 'merge-run-one')
  f.setNow(Date.UTC(2030, 0, 1) + 31 * 60_000)
  const partner = reflectedMergeCandidate(f,
    '编辑 package.json 时先校验 JSON 字段类型，最后确认自定义字段仍然保留。', 'merge-run-two')
  f.setNow(f.getNow() + 31 * 60_000)
  const { decisionId } = proposeMerge(f, primary, partner)
  const plan = f.engine.decisionMergePlan({ decisionId, projectKey: '/synthetic/decision' })
  const source = f.engine.sourcePublish({ sessionId: plan.source.sessionId, projectKey: '/synthetic/decision',
    provider: 'host', model: 'host-model', apiMode: null, baseUrl: null,
    reasoningState: 'unspecified', reasoningValue: null, driver: 'dsh_host_stream' })
  assert.equal(source.ok, true)
  const prepared = f.engine.reflectionRequest({ sessionId: plan.source.sessionId, turnId: `merge:${plan.generationKey}`,
    projectKey: '/synthetic/decision', outcome: 'supported', taskSummary: '按冻结的两条 package.json 方法形成新候选',
    resultSummary: '只保留同一登记验证域和相同适用条件', sourceBinding: true,
    sourceRevision: source.revision, sourceBindingHash: source.bindingHash,
    controlGeneration: f.engine.controlGeneration(), generation: { decisionId, generationKey: plan.generationKey } })
  assertGenerationTicket(prepared)
  assert.equal(f.engine.status().evaluationCallsLast24h, 1, 'the decision request is in the shared paid-call ledger')
  assert.equal(f.engine.reflectionDispatch({ ticket: prepared.ticket, dispatchHash: prepared.dispatchHash }).ok, true)
  const before = f.engine.store.read().lessons.length
  const generated = f.engine.reflectionResult({ ticket: prepared.ticket,
    result: { instruction: '处理 package.json 时先解析 JSON，再核对 scripts 类型并保留所有无关字段。' },
    expected: { routeId: source.routeId, revision: source.revision, bindingHash: source.bindingHash,
      epoch: source.epoch, controlGeneration: f.engine.controlGeneration(), sessionHash: source.sessionHash },
    usage: { known: true, totalTokens: 27 } })
  assert.equal(generated.ok, true)
  assert.equal(generated.mergeStatus.state, 'complete')
  assert.equal(f.engine.store.read().lessons.length, before + 1)
  const candidate = f.engine.store.read().lessons.find(row => row.id === generated.id)
  assert.ok(candidate)
  assert.equal(candidate.status, 'candidate')
  assert.equal(candidate.methodId, null)
  assert.equal(candidate.sessionId, plan.source.sessionId)
  assert.equal(candidate.validation, undefined)
  assert.equal(candidate.verified, 0)
  assert.equal(candidate.derivation.mode, 'merge')
  assert.equal(candidate.derivation.parents.length, 2)
  assert.equal(f.engine.status().evaluationCallsLast24h, 2, 'generation dispatch shares the same call budget')
  assert.equal(f.engine.decisionMergePlan({ decisionId, projectKey: '/synthetic/decision' }).code,
    'merge_generation_already_settled')
})

test('startup recovery releases a merge reservation that never dispatched', t => {
  const f = fixture(t)
  const primary = reflectedMergeCandidate(f,
    '修改 package.json 前先解析 JSON 结构，再核对 scripts 字段类型并保留无关字段。', 'recover-before-one')
  f.setNow(f.getNow() + 31 * 60_000)
  const partner = reflectedMergeCandidate(f,
    '编辑 package.json 时先校验 JSON 字段类型，最后确认自定义字段仍然保留。', 'recover-before-two')
  f.setNow(f.getNow() + 31 * 60_000)
  const { decisionId } = proposeMerge(f, primary, partner)
  const plan = f.engine.decisionMergePlan({ decisionId, projectKey: '/synthetic/decision' })
  const source = f.engine.sourcePublish({ sessionId: plan.source.sessionId, projectKey: '/synthetic/decision',
    provider: 'host', model: 'host-model', apiMode: null, baseUrl: null,
    reasoningState: 'unspecified', reasoningValue: null, driver: 'dsh_host_stream' })
  const prepared = f.engine.reflectionRequest({ sessionId: plan.source.sessionId, turnId: 'recover-before',
    projectKey: '/synthetic/decision', outcome: 'supported', taskSummary: '按冻结约束生成并核验合并候选',
    resultSummary: '请求尚未派发，恢复时应释放额度',
    sourceBinding: true, sourceRevision: source.revision, sourceBindingHash: source.bindingHash,
    controlGeneration: f.engine.controlGeneration(), generation: { decisionId, generationKey: plan.generationKey } })
  assertGenerationTicket(prepared)
  const restarted = new LearningEngine({ stateRoot: f.stateRoot, adapterId: 'dsh', evaluationTokensPerDay: 20_000,
    evaluationCallsPerDay: 5, now: f.getNow })
  const recovery = restarted.recoverAutoPlans()
  assert.equal(recovery.generationsReleased, 1)
  assert.equal(recovery.generationsUnknown, 0)
  assert.equal(restarted.status().evaluationCallsLast24h, 1, 'the completed decision remains charged')
  assert.equal(restarted.status().reflectionsLast24h, 2, 'only the two parent-creation reflections remain charged')
  assert.equal(restarted.decisionHistory({ projectKey: '/synthetic/decision' }).rows[0].mergeStatus.state, 'waiting')
})

test('startup recovery records a dispatched merge as unknown and never replays it', t => {
  const f = fixture(t)
  const primary = reflectedMergeCandidate(f,
    '修改 package.json 前先解析 JSON 结构，再核对 scripts 字段类型并保留无关字段。', 'recover-after-one')
  f.setNow(f.getNow() + 31 * 60_000)
  const partner = reflectedMergeCandidate(f,
    '编辑 package.json 时先校验 JSON 字段类型，最后确认自定义字段仍然保留。', 'recover-after-two')
  f.setNow(f.getNow() + 31 * 60_000)
  const { decisionId } = proposeMerge(f, primary, partner)
  const plan = f.engine.decisionMergePlan({ decisionId, projectKey: '/synthetic/decision' })
  const source = f.engine.sourcePublish({ sessionId: plan.source.sessionId, projectKey: '/synthetic/decision',
    provider: 'host', model: 'host-model', apiMode: null, baseUrl: null,
    reasoningState: 'unspecified', reasoningValue: null, driver: 'dsh_host_stream' })
  const prepared = f.engine.reflectionRequest({ sessionId: plan.source.sessionId, turnId: 'recover-after',
    projectKey: '/synthetic/decision', outcome: 'supported', taskSummary: '按冻结约束生成并核验合并候选',
    resultSummary: '请求已经派发，恢复时应记为未知',
    sourceBinding: true, sourceRevision: source.revision, sourceBindingHash: source.bindingHash,
    controlGeneration: f.engine.controlGeneration(), generation: { decisionId, generationKey: plan.generationKey } })
  assertGenerationTicket(prepared)
  assert.equal(f.engine.reflectionDispatch({ ticket: prepared.ticket, dispatchHash: prepared.dispatchHash }).ok, true)
  const restarted = new LearningEngine({ stateRoot: f.stateRoot, adapterId: 'dsh', evaluationTokensPerDay: 20_000,
    evaluationCallsPerDay: 5, now: f.getNow })
  const recovery = restarted.recoverAutoPlans()
  assert.equal(recovery.generationsUnknown, 1)
  assert.equal(restarted.status().evaluationUnknown24h, 1)
  assert.equal(restarted.decisionHistory({ projectKey: '/synthetic/decision' }).rows[0].mergeStatus.state, 'unknown')
  assert.equal(restarted.reflectionDispatch({ ticket: prepared.ticket, dispatchHash: prepared.dispatchHash }).ok, false)
})

test('merge dispatch gate rechecks pause, source revision, and ticket expiry before charging', t => {
  for (const scenario of ['pause', 'source', 'expiry']) {
    const f = fixture(t)
    const { source, prepared } = preparedMerge(f, `gate-${scenario}`)
    if (scenario === 'pause') f.engine.settlementPause({ paused: true })
    if (scenario === 'source') f.engine.sourceRelease({ sessionId: 'merge-source',
      expectRevision: source.revision, expectBindingHash: source.bindingHash, reason: 'test_source_change' })
    if (scenario === 'expiry') f.setNow(f.getNow() + 5 * 60_000 + 1)
    const refused = f.engine.reflectionDispatch({ ticket: prepared.ticket, dispatchHash: prepared.dispatchHash })
    assert.equal(refused.ok, false, `${scenario} must refuse dispatch`)
    assert.equal(refused.dispatched, false)
    assert.equal(f.engine.status().evaluationCallsLast24h, 1, `${scenario} must not charge generation`)
    assert.equal(f.engine.status().reflectionsLast24h, 2, `${scenario} must release both generation attempt reservations`)
  }
})

test('OpenAI-compatible decision adapter needs no secret resolver when no secret is configured', async () => {
  let sent = null
  const answer = await requestDecision({ backend: 'openai_compatible', endpoint: 'https://example.test/v1/chat/completions',
    model: 'model-a', evidence: { candidateId: 'lesson', refs: [] }, fetchImpl: async (url, options) => {
      sent = { url, options }
      return new Response(JSON.stringify({ model: 'model-a', choices: [{ finish_reason: 'stop',
        message: { content: JSON.stringify({ action: 'wait', confidence: 0.5,
          confidenceMeaning: 'advisory', reasons: [], riskCodes: [] }) } }],
      usage: { prompt_tokens: 17, completion_tokens: 8 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    } })
  assert.equal(answer.result.action, 'wait')
  assert.deepEqual(answer.usage, { inputTokens: 17, outputTokens: 8, totalTokens: 25 })
  assert.equal(sent.url, 'https://example.test/v1/chat/completions')
  assert.equal(sent.options.redirect, 'error')
})

test('OpenAI requests preserve exact legacy and complete endpoint paths including trailing slashes', async () => {
  const sent = []
  for (const endpoint of ['https://example.test/custom/decision/',
    'https://example.test/v1/chat/completions/']) {
    await requestDecision({ backend: 'openai_compatible', endpoint, model: 'model-a', evidence: { refs: [] },
      fetchImpl: async (url, options) => {
        sent.push({ url, options })
        return new Response(JSON.stringify({ model: 'model-a', choices: [{ finish_reason: 'stop',
          message: { content: JSON.stringify({ action: 'wait', confidence: 0.5,
            confidenceMeaning: 'advisory', reasons: [], riskCodes: [] }) } }] }), { status: 200 })
      } })
  }
  assert.deepEqual(sent.map(item => item.url), [
    'https://example.test/custom/decision/', 'https://example.test/v1/chat/completions/',
  ])
})

test('provider routes normalize supported bases and keep legacy custom OpenAI endpoints exact', () => {
  const openRoot = decisionEndpointRoutes('openai_compatible', 'https://example.test')
  assert.equal(new URL(openRoot.requestUrl).pathname, '/v1/chat/completions')
  assert.equal(new URL(openRoot.discoveryUrl).pathname, '/v1/models')
  for (const base of ['https://example.test/proxy/v1', 'https://example.test/proxy/v1/']) {
    const route = decisionEndpointRoutes('openai_compatible', base)
    assert.equal(new URL(route.requestUrl).pathname, '/proxy/v1/chat/completions')
    assert.equal(new URL(route.discoveryUrl).pathname, '/proxy/v1/models')
  }
  const proxySlash = decisionEndpointRoutes('openai_compatible', 'https://example.test/proxy/')
  assert.equal(proxySlash.requestUrl, 'https://example.test/proxy/')
  assert.equal(proxySlash.discoveryUrl, null, 'unknown paths with trailing slashes stay legacy endpoints')
  assert.equal(new URL(decisionEndpointRoutes('openai_compatible',
    'https://example.test/proxy/v1/chat/completions').requestUrl).pathname,
  '/proxy/v1/chat/completions')
  assert.equal(decisionEndpointRoutes('openai_compatible',
    'https://example.test/proxy/v1/chat/completions/').requestUrl,
  'https://example.test/proxy/v1/chat/completions/', 'a full standard endpoint keeps its configured trailing slash')
  const unknownCompletionPath = decisionEndpointRoutes('openai_compatible', 'https://example.test/custom/chat/completions')
  assert.equal(new URL(unknownCompletionPath.requestUrl).pathname, '/custom/chat/completions')
  assert.equal(unknownCompletionPath.discoveryUrl, null)
  const unknownTrailingPath = decisionEndpointRoutes('openai_compatible', 'https://example.test/custom/decision/')
  assert.equal(unknownTrailingPath.requestUrl, 'https://example.test/custom/decision/')
  assert.equal(unknownTrailingPath.discoveryUrl, null)
  const legacy = decisionEndpointRoutes('openai_compatible', 'https://example.test/custom/decision')
  assert.equal(new URL(legacy.requestUrl).pathname, '/custom/decision')
  assert.equal(legacy.discoveryUrl, null)
  const legacyRef = decisionCredentialRef('openai_compatible', 'https://example.test/custom/decision')
  assert.match(legacyRef, /^MSE_DECISION_KEY_[a-f0-9]{64}$/u)
  assert.notEqual(legacyRef, decisionCredentialRef('openai_compatible', 'https://example.test/custom/other'),
    'legacy custom routes still receive distinct route-scoped credential identities')

  for (const endpoint of ['https://example.test/proxy', 'https://example.test/proxy/v1',
    'https://example.test/proxy/v1/systemone']) {
    const route = decisionEndpointRoutes('jev', endpoint)
    assert.equal(new URL(route.requestUrl).pathname, '/proxy/v1/systemone')
    assert.equal(new URL(route.discoveryUrl).pathname, '/proxy/v1/models')
  }
  const jevLegacyBase = decisionEndpointRoutes('jev', 'https://example.test/proxy/custom')
  assert.equal(new URL(jevLegacyBase.requestUrl).pathname, '/proxy/custom/v1/systemone')
  assert.equal(new URL(jevLegacyBase.discoveryUrl).pathname, '/proxy/custom/v1/models')
  for (const endpoint of ['https://example.test/proxy/', 'https://example.test/proxy/v1',
    'https://example.test/proxy/v1/systemone']) {
    const route = decisionEndpointRoutes('laya', endpoint)
    assert.equal(new URL(route.requestUrl).pathname, '/proxy/v1/systemone')
    assert.equal(new URL(route.discoveryUrl).pathname, '/proxy/health')
  }
  const layaLegacyBase = decisionEndpointRoutes('laya', 'https://example.test/proxy/custom')
  assert.equal(new URL(layaLegacyBase.requestUrl).pathname, '/proxy/custom/v1/systemone')
  assert.equal(new URL(layaLegacyBase.discoveryUrl).pathname, '/proxy/custom/health')
})

test('model discovery uses bounded read-only provider directories and never runs inference', async () => {
  const calls = []
  const openAi = await discoverDecisionModels({ backend: 'openai_compatible', endpoint: 'https://example.test/proxy/v1',
    apiKey: 'synthetic-openai-key', fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url).pathname, options })
      return new Response(JSON.stringify({ data: [{ id: 'gpt-synthetic' }, { id: 'other' }] }), { status: 200 })
    } })
  assert.deepEqual(openAi.models, [{ id: 'gpt-synthetic' }, { id: 'other' }])
  assert.equal(calls[0].url, '/proxy/v1/models')
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.body, undefined)
  assert.equal(calls[0].options.headers.authorization, 'Bearer synthetic-openai-key')

  const jev = await discoverDecisionModels({ backend: 'jev', endpoint: 'https://example.test/proxy',
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url).pathname, options })
      return new Response(JSON.stringify({ models: [{ name: 'jev-synthetic' }] }), { status: 200 })
    } })
  assert.deepEqual(jev.models, [{ id: 'jev-synthetic' }])
  assert.equal(calls[1].url, '/proxy/v1/models')
  assert.equal(calls[1].options.method, 'GET')

  const laya = await discoverDecisionModels({ backend: 'laya', endpoint: 'http://192.168.0.2:60008/proxy',
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url).pathname, options })
      return new Response(JSON.stringify({ status: 'ok', loaded: ['laya-synthetic'] }), { status: 200 })
    } })
  assert.deepEqual(laya.models, [{ id: 'laya-synthetic' }])
  assert.equal(laya.autoAvailable, true)
  assert.equal(laya.models.some(model => model.id === 'auto'), false, 'auto is a separate choice, not a discovered model')
  assert.equal(calls[2].url, '/proxy/health')
  assert.equal(calls[2].options.method, 'GET')

  const layaNoDetails = await discoverDecisionModels({ backend: 'laya', endpoint: 'http://192.168.0.2:60008',
    fetchImpl: async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }) })
  assert.equal(layaNoDetails.code, 'model_discovery_details_unavailable')
  assert.equal(layaNoDetails.autoAvailable, true)
  let missingSignal
  await assert.rejects(discoverDecisionModels({ backend: 'laya', endpoint: 'http://192.168.0.2:60008',
    fetchImpl: async (_url, options) => {
      missingSignal = options.signal
      return new Response('missing', { status: 404 })
    } }), { message: 'model_discovery_not_supported' })
  assert.equal(missingSignal.aborted, true, 'even unsupported-directory exits close the transport signal')

  await assert.rejects(discoverDecisionModels({ backend: 'openai_compatible',
    endpoint: 'https://example.test/custom/decision', fetchImpl: async () => { throw new Error('must_not_probe') } }),
  { message: 'model_discovery_not_supported' })
  let oversizedSignal
  await assert.rejects(discoverDecisionModels({ backend: 'openai_compatible', endpoint: 'https://example.test/v1',
    fetchImpl: async (_url, options) => {
      oversizedSignal = options.signal
      return { status: 200, ok: true,
        headers: { get: name => name === 'content-length' ? String(64 * 1024 + 1) : null }, body: null }
    } }), { message: 'provider_response_too_large' })
  assert.equal(oversizedSignal.aborted, true, 'oversized declarations also close the transport signal')
  await assert.rejects(discoverDecisionModels({ backend: 'openai_compatible', endpoint: 'https://example.test/v1',
    fetchImpl: async () => ({ status: 200, ok: true, headers: { get: () => null }, body: null,
      text: async () => 'must-not-read-unbounded-body' }) }), { message: 'provider_response_unbounded' })
  await assert.rejects(discoverDecisionModels({ backend: 'openai_compatible', endpoint: 'https://example.test/v1',
    fetchImpl: async () => new Response(JSON.stringify({ data: Array.from({ length: 501 }, (_, index) => ({ id: `m-${index}` })) }),
      { status: 200 }) }), { message: 'model_discovery_invalid_response' })
})

test('model discovery enforces its timeout and cancels when the caller changes routes', async () => {
  await assert.rejects(discoverDecisionModels({ backend: 'openai_compatible', endpoint: 'https://example.test/v1',
    timeoutMs: 100, fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }) }), { message: 'model_discovery_timeout' })

  const routeController = new AbortController()
  let markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  const pending = discoverDecisionModels({ backend: 'openai_compatible', endpoint: 'https://example.test/v1',
    signal: routeController.signal, fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      markStarted()
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }) })
  await started
  routeController.abort()
  await assert.rejects(pending, { message: 'cancelled' })

  const lateFetchController = new AbortController()
  let markLateFetchStarted
  const lateFetchStarted = new Promise(resolve => { markLateFetchStarted = resolve })
  let resolveLateFetch
  let lateFetchSignal
  const lateFetch = discoverDecisionModels({ backend: 'openai_compatible', endpoint: 'https://example.test/v1',
    signal: lateFetchController.signal, fetchImpl: (_url, options) => {
      lateFetchSignal = options.signal
      markLateFetchStarted()
      return new Promise(resolve => { resolveLateFetch = resolve })
    } })
  await lateFetchStarted
  lateFetchController.abort()
  resolveLateFetch(new Response(JSON.stringify({ data: [{ id: 'too-late' }] }), { status: 200 }))
  await assert.rejects(lateFetch, { message: 'cancelled' })
  assert.equal(lateFetchSignal.aborted, true)

  const lateBodyController = new AbortController()
  let markLateBodyStarted
  const lateBodyStarted = new Promise(resolve => { markLateBodyStarted = resolve })
  let resolveBodyRead
  let lateBodySignal
  const lateBody = discoverDecisionModels({ backend: 'openai_compatible', endpoint: 'https://example.test/v1',
    signal: lateBodyController.signal, fetchImpl: async (_url, options) => {
      lateBodySignal = options.signal
      markLateBodyStarted()
      return { status: 200, ok: true, headers: { get: () => null }, body: { getReader: () => {
        let first = true
        return { read: () => {
          if (!first) return Promise.resolve({ done: true })
          first = false
          return new Promise(resolve => { resolveBodyRead = resolve })
        }, releaseLock() {} }
      } } }
    } })
  await lateBodyStarted
  await new Promise(resolve => setImmediate(resolve))
  lateBodyController.abort()
  resolveBodyRead({ done: false, value: new TextEncoder().encode(JSON.stringify({ data: [{ id: 'too-late' }] })) })
  await assert.rejects(lateBody, { message: 'cancelled' })
  assert.equal(lateBodySignal.aborted, true)
})

test('Host, JEV, and Laya dispatchers preserve their own transport contract', async () => {
  let hostCalls = 0, hostDispatches = 0
  let hostRequest = null
  const host = await requestDecision({ backend: 'host', model: 'host-model', evidence: { refs: [] },
    outputTokens: 2048,
    onDispatch: () => { hostDispatches += 1; return { ok: true } },
    hostCall: async request => { hostCalls += 1; hostRequest = request; return { model: 'host-model', usage: { totalTokens: 11 },
      result: { action: 'review', confidence: 0.8, confidenceMeaning: 'test advisory', reasons: [], riskCodes: [] } } } })
  assert.equal(host.result.action, 'review')
  assert.equal(hostCalls, 1)
  assert.equal(hostDispatches, 1)
  assert.equal(hostRequest.outputTokens, 2048)

  for (const backend of ['jev', 'laya']) {
    let sent = null
    const answer = await requestDecision({ backend, endpoint: 'https://example.test/root', model: `${backend}-model`,
      evidence: { candidateId: 'candidate', refs: [] }, fetchImpl: async (url, options) => {
        sent = { url, body: JSON.parse(options.body) }
        return new Response(JSON.stringify({ model: `${backend}-model`, answers: { action: {
          choice: 'review', confidence: 0.8, probabilities: { review: 0.8, wait: 0.2 } } },
          usage: { input_tokens: 12, output_tokens: 4 } }),
        { status: 200, headers: { 'content-type': 'application/json' } })
      } })
    assert.equal(answer.result.action, 'review')
    assert.equal(sent.url, 'https://example.test/root/v1/systemone')
    assert.equal(sent.body.state.candidateId, 'candidate')
  }
})

test('Host incomplete valid JSON is refused before parsing and complete malformed JSON keeps measured usage', async () => {
  let sentTokens = null
  const validPartial = JSON.stringify({ action: 'review', confidence: 0.8, confidenceMeaning: 'advisory',
    reasons: [], riskCodes: [] })
  const incomplete = await requestDecision({ backend: 'host', model: 'host-model', evidence: { refs: [] },
    outputTokens: 2048, hostCall: async request => {
      sentTokens = request.outputTokens
      return { model: 'host-model', result: validPartial, complete: false, usage: { totalTokens: 21 } }
    } })
  assert.equal(incomplete.ok, false)
  assert.equal(incomplete.code, 'provider_incomplete')
  assert.equal(incomplete.complete, false)
  assert.equal(incomplete.usage.totalTokens, 21)
  assert.equal(sentTokens, 2048)

  const malformed = await requestDecision({ backend: 'host', model: 'host-model', evidence: { refs: [] },
    hostCall: async () => ({ model: 'host-model', result: '{partial', complete: true,
      usage: { totalTokens: 17 } }) })
  assert.equal(malformed.ok, false)
  assert.equal(malformed.code, 'decision_invalid_json')
  assert.equal(malformed.complete, true)
  assert.equal(malformed.usage.totalTokens, 17)
})

test('only Laya can use explicit RFC1918 IPv4 HTTP endpoints, without exposing the secret in request data', async () => {
  for (const host of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.255.254']) {
    assert.equal(decisionEndpointError('laya', `http://${host}/v1/systemone`), null, host)
  }
  const syntheticSecret = 'synthetic-test-secret-never-a-real-credential'
  const secretRef = 'SYNTHETIC_LAYA_TOKEN'
  let sent = null, dispatches = 0, secretLookups = 0
  const answer = await requestDecision({ backend: 'laya', endpoint: 'http://192.168.0.2:8080/root',
    model: 'laya-model', evidence: { candidateId: 'candidate', refs: [] }, secretRef,
    resolveSecret: async name => { secretLookups += 1; assert.equal(name, secretRef); return syntheticSecret },
    onDispatch: () => { dispatches += 1; return { ok: true } },
    fetchImpl: async (url, options) => {
      sent = { url, options, body: JSON.parse(options.body) }
      return new Response(JSON.stringify({ model: 'laya-model', answers: { action: {
        choice: 'review', confidence: 0.8, probabilities: { review: 0.8, wait: 0.2 } } },
        usage: { input_tokens: 12, output_tokens: 4 } }),
      { status: 200, headers: { 'content-type': 'application/json' } })
    } })
  assert.equal(answer.result.action, 'review')
  assert.equal(sent.url, 'http://192.168.0.2:8080/root/v1/systemone')
  assert.equal(sent.options.headers.authorization, `Bearer ${syntheticSecret}`)
  assert.equal(sent.options.redirect, 'error')
  assert.equal(JSON.stringify({ url: sent.url, body: sent.body, secretRef }).includes(syntheticSecret), false)
  assert.equal(secretLookups, 1)
  assert.equal(dispatches, 1)

  for (const endpoint of ['http://172.15.0.2/v1/systemone', 'http://172.32.0.2/v1/systemone',
    'http://8.8.8.8/v1/systemone', 'http://laya.internal/v1/systemone',
    'http://192.168.000.002/v1/systemone']) {
    let fetches = 0, rejectedDispatches = 0
    await assert.rejects(requestDecision({ backend: 'laya', endpoint, model: 'laya-model',
      evidence: { candidateId: 'candidate', refs: [] }, onDispatch: () => {
        rejectedDispatches += 1; return { ok: true }
      }, fetchImpl: async () => { fetches += 1; throw new Error('unexpected_fetch') } }),
    { message: 'insecure_endpoint' })
    assert.equal(fetches, 0, endpoint)
    assert.equal(rejectedDispatches, 0, endpoint)
  }

  for (const backend of ['openai_compatible', 'jev']) {
    let fetches = 0
    await assert.rejects(requestDecision({ backend, endpoint: 'http://192.168.0.2/v1', model: 'model',
      evidence: { candidateId: 'candidate', refs: [] }, fetchImpl: async () => {
        fetches += 1; throw new Error('unexpected_fetch')
      } }), { message: 'insecure_endpoint' })
    assert.equal(fetches, 0, backend)
  }

  for (const endpoint of ['http://user:pass@192.168.0.2/v1', 'http://192.168.0.2/v1?token=x',
    'http://192.168.0.2/v1#fragment']) {
    let fetches = 0
    await assert.rejects(requestDecision({ backend: 'laya', endpoint, model: 'laya-model',
      evidence: { candidateId: 'candidate', refs: [] }, fetchImpl: async () => {
        fetches += 1; throw new Error('unexpected_fetch')
      } }), { message: 'invalid_endpoint' })
    assert.equal(fetches, 0, endpoint)
  }
})

test('decision endpoint policy keeps existing loopback HTTP support for every remote backend', () => {
  for (const backend of ['openai_compatible', 'jev', 'laya']) {
    for (const endpoint of ['http://localhost:8080/v1', 'http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1']) {
      assert.equal(decisionEndpointError(backend, endpoint), null, `${backend} ${endpoint}`)
    }
  }
})

test('Host total-token usage is retained without fabricating input/output fields', t => {
  const f = fixture(t)
  const ticket = f.engine.decisionRequest(f.input())
  assert.equal(f.engine.decisionStarted({ ticket: ticket.ticket, requestHash: ticket.requestHash }).ok, true)
  const settled = f.engine.decisionComplete({ ticket: ticket.ticket, model: 'host-model',
    result: { action: 'prioritize_validation', confidence: 0.7, confidenceMeaning: 'advisory', reasons: [], riskCodes: [] },
    usage: { totalTokens: 275 }, evidenceRevision: f.context.evidenceRevision, version: f.context.version })
  assert.equal(settled.ok, true)
  assert.deepEqual(settled.record.usage, { inputTokens: null, outputTokens: null, totalTokens: 275 })
  assert.equal(f.engine.status().evaluationTokensKnown24h, 275)
})

test('a pre-dispatch refusal releases the reservation without an API call and can be retried', t => {
  const f = fixture(t)
  const first = f.engine.decisionRequest(f.input())
  assert.equal(first.ok, true)
  const released = f.engine.decisionAbortBeforeDispatch({ ticket: first.ticket })
  assert.equal(released.ok, true)
  const status = f.engine.status()
  assert.equal(status.evaluationCallsLast24h, 0)
  assert.equal(status.evaluationTokensReserved24h, 0)
  const retry = f.engine.decisionRequest(f.input())
  assert.equal(retry.ok, true)
  assert.equal(retry.duplicate, false)
})

test('known settled decisions may be reevaluated after changing the endpoint', t => {
  const f = fixture(t)
  const ticket = f.engine.decisionRequest(f.input({ backend: 'openai_compatible', model: 'model-a',
    provider: 'compatible', endpoint: 'https://one.example/v1' }))
  assert.equal(f.engine.decisionStarted({ ticket: ticket.ticket, requestHash: ticket.requestHash }).ok, true)
  assert.equal(f.engine.decisionComplete({ ticket: ticket.ticket, model: 'model-a',
    result: { action: 'wait', confidence: 0.7, confidenceMeaning: 'advisory', reasons: [], riskCodes: [] },
    usage: { inputTokens: 100, outputTokens: 20 }, evidenceRevision: f.context.evidenceRevision,
    version: f.context.version }).ok, true)
  const changedRoute = f.engine.decisionRequest(f.input({ backend: 'openai_compatible', model: 'model-b',
    provider: 'compatible', endpoint: 'https://two.example/v1' }))
  assert.equal(changedRoute.ok, true)
  assert.equal(changedRoute.duplicate, false)
})

test('cancellation while resolving a secret never reaches fetch', async () => {
  const controller = new AbortController()
  let finishSecret
  let fetches = 0, dispatches = 0
  const pending = requestDecision({ backend: 'openai_compatible', endpoint: 'https://example.test/v1', model: 'm',
    evidence: { refs: [] }, signal: controller.signal, secretRef: 'DECISION_KEY',
    resolveSecret: () => new Promise(resolve => { finishSecret = resolve }),
    onDispatch: () => { dispatches += 1; return { ok: true } },
    fetchImpl: async () => { fetches += 1; return new Response('{}') } })
  await Promise.resolve()
  controller.abort()
  finishSecret('synthetic-secret')
  await assert.rejects(pending, /cancelled/u)
  assert.equal(fetches, 0)
  assert.equal(dispatches, 0, 'cancellation before physical dispatch is not counted')
})

test('secret resolution failure is refused before the dispatch callback', async () => {
  let dispatches = 0, fetches = 0
  await assert.rejects(requestDecision({ backend: 'openai_compatible', endpoint: 'https://example.test/v1', model: 'm',
    evidence: { refs: [] }, secretRef: 'DECISION_KEY', resolveSecret: async () => '',
    onDispatch: () => { dispatches += 1; return { ok: true } },
    fetchImpl: async () => { fetches += 1; return new Response('{}') } }), /provider_secret_unavailable/u)
  assert.equal(dispatches, 0)
  assert.equal(fetches, 0)
})

test('dispatch callback runs exactly once immediately before the physical request', async () => {
  const order = []
  await requestDecision({ backend: 'openai_compatible', endpoint: 'https://example.test/v1', model: 'm',
    evidence: { refs: [] }, onDispatch: () => { order.push('dispatch'); return { ok: true } },
    fetchImpl: async () => {
      order.push('fetch')
      return new Response(JSON.stringify({ model: 'm', choices: [{ finish_reason: 'stop',
        message: { content: JSON.stringify({ action: 'wait', confidence: 0.5,
          confidenceMeaning: 'advisory', reasons: [], riskCodes: [] }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })
    } })
  assert.deepEqual(order, ['dispatch', 'fetch'])
})

test('HTTP error response retains bounded reported token usage', async () => {
  const answer = await requestDecision({ backend: 'openai_compatible', endpoint: 'https://example.test/v1', model: 'm',
    evidence: { refs: [] }, fetchImpl: async () => new Response(JSON.stringify({ model: 'm',
      error: { message: 'private provider detail' }, usage: { prompt_tokens: 31, completion_tokens: 4 } }),
    { status: 429, headers: { 'content-type': 'application/json' } }) })
  assert.equal(answer.ok, false)
  assert.equal(answer.code, 'provider_http_error')
  assert.deepEqual(answer.usage, { inputTokens: 31, outputTokens: 4, totalTokens: 35 })
})

test('uncertain remote opinion gets one Host fallback step on the same logical ticket', t => {
  const f = fixture(t)
  const primary = f.engine.decisionRequest(f.input({ backend: 'openai_compatible', model: 'remote-model',
    provider: 'compatible', endpoint: 'https://example.test/v1', fallbackRoute: { provider: 'host',
      model: 'host-model', apiMode: 'host_llm_stream', reasoningEffort: 'unspecified' } }))
  assert.equal(f.engine.decisionStarted({ ticket: primary.ticket, requestHash: primary.requestHash }).ok, true)
  const held = f.engine.decisionComplete({ ticket: primary.ticket, model: 'remote-model',
    result: { action: 'wait', confidence: 0.4, confidenceMeaning: 'advisory', reasons: ['uncertain'], riskCodes: [] },
    usage: { inputTokens: 80, outputTokens: 20 }, evidenceRevision: f.context.evidenceRevision,
    version: f.context.version, fallbackPending: true })
  assert.equal(held.needsHostFallback, true)
  const fallback = f.engine.decisionReserveFallback({ ticket: primary.ticket, inputTokens: 400,
    outputTokens: 200, requestHash: 'a'.repeat(64), provider: 'host', model: 'host-model',
    apiMode: 'host_llm_stream', reasoningEffort: 'unspecified' })
  assert.equal(fallback.ok, true)
  assert.equal(fallback.stepKey, 'decision:host')
  assert.equal(f.engine.decisionStarted({ ticket: primary.ticket, stepKey: fallback.stepKey,
    requestHash: fallback.requestHash }).ok, true)
  const final = f.engine.decisionComplete({ ticket: primary.ticket, stepKey: fallback.stepKey,
    model: 'host-model', result: { action: 'prioritize_validation', confidence: 0.8,
      confidenceMeaning: 'host advisory', reasons: [], riskCodes: [] }, usage: { totalTokens: 99 },
    evidenceRevision: f.context.evidenceRevision, version: f.context.version })
  assert.equal(final.ok, true)
  assert.equal(final.record.ticket, primary.ticket)
  assert.equal(final.record.result.action, 'prioritize_validation')
  assert.deepEqual(final.record.usage, { inputTokens: null, outputTokens: null, totalTokens: 199 })
  const status = f.engine.status()
  assert.equal(status.evaluationCallsLast24h, 1)
  assert.equal(status.evaluationRequestsLast24h, 2)
  assert.equal(status.evaluationTokensKnown24h, 199)
})

test('malformed Host fallback settles known usage as a primary plus fallback aggregate', t => {
  const f = fixture(t)
  const primary = f.engine.decisionRequest(f.input({ backend: 'openai_compatible', model: 'remote-model',
    provider: 'compatible', endpoint: 'https://example.test/v1', fallbackRoute: { provider: 'host',
      model: 'host-model', apiMode: 'host_llm_stream', reasoningEffort: 'unspecified' } }))
  f.engine.decisionStarted({ ticket: primary.ticket, requestHash: primary.requestHash })
  f.engine.decisionComplete({ ticket: primary.ticket, model: 'remote-model',
    result: { action: 'wait', confidence: 0.4, confidenceMeaning: 'advisory', reasons: [], riskCodes: [] },
    usage: { inputTokens: 80, outputTokens: 20 }, evidenceRevision: f.context.evidenceRevision,
    version: f.context.version, fallbackPending: true })
  const fallback = f.engine.decisionReserveFallback({ ticket: primary.ticket, inputTokens: 400,
    outputTokens: 200, requestHash: 'c'.repeat(64), provider: 'host', model: 'host-model',
    apiMode: 'host_llm_stream', reasoningEffort: 'unspecified' })
  f.engine.decisionStarted({ ticket: primary.ticket, stepKey: fallback.stepKey, requestHash: fallback.requestHash })
  f.engine.decisionComplete({ ticket: primary.ticket, stepKey: fallback.stepKey, model: 'host-model',
    result: '{bad json', usage: { inputTokens: 40, outputTokens: 40 },
    evidenceRevision: f.context.evidenceRevision, version: f.context.version })
  const record = f.engine.decisionHistory({ lessonId: f.context.candidateId,
    projectKey: '/synthetic/decision' }).rows[0]
  assert.equal(record.state, 'wait')
  assert.equal(record.primaryUsage.totalTokens, 100)
  assert.equal(record.fallbackUsage.totalTokens, 80)
  assert.equal(record.usage.totalTokens, 180)
})

test('unknown Host fallback usage remains unknown while preserving measured primary usage', t => {
  const f = fixture(t)
  const primary = f.engine.decisionRequest(f.input({ backend: 'openai_compatible', model: 'remote-model',
    provider: 'compatible', endpoint: 'https://example.test/v1', fallbackRoute: { provider: 'host',
      model: 'host-model', apiMode: 'host_llm_stream', reasoningEffort: 'unspecified' } }))
  f.engine.decisionStarted({ ticket: primary.ticket, requestHash: primary.requestHash })
  f.engine.decisionComplete({ ticket: primary.ticket, model: 'remote-model',
    result: { action: 'wait', confidence: 0.4, confidenceMeaning: 'advisory', reasons: [], riskCodes: [] },
    usage: { inputTokens: 80, outputTokens: 20 }, evidenceRevision: f.context.evidenceRevision,
    version: f.context.version, fallbackPending: true })
  const fallback = f.engine.decisionReserveFallback({ ticket: primary.ticket, inputTokens: 400,
    outputTokens: 200, requestHash: 'd'.repeat(64), provider: 'host', model: 'host-model',
    apiMode: 'host_llm_stream', reasoningEffort: 'unspecified' })
  f.engine.decisionStarted({ ticket: primary.ticket, stepKey: fallback.stepKey, requestHash: fallback.requestHash })
  f.engine.decisionFail({ ticket: primary.ticket, stepKey: fallback.stepKey, code: 'provider_failed', usage: null })
  const record = f.engine.decisionHistory({ lessonId: f.context.candidateId,
    projectKey: '/synthetic/decision' }).rows[0]
  assert.equal(record.state, 'unknown')
  assert.equal(record.usage, null)
  assert.equal(record.primaryUsage.totalTokens, 100)
  assert.equal(record.fallbackUsage, null)
  const changedPolicy = f.engine.decisionRequest({ ...f.input(), ruleVersion: 'experience-upgrade-v2-host-output-2048',
    role: 'changed-role', outputTokens: 2048 })
  assert.equal(changedPolicy.duplicate, true)
  assert.equal(changedPolicy.record.state, 'unknown')
  assert.equal(f.engine.status().evaluationCallsLast24h, 1)
})

test('fallback budget wait survives restart and retries only the Host step', t => {
  const f = fixture(t, { tokens: 700 })
  const primary = f.engine.decisionRequest(f.input({ backend: 'openai_compatible', model: 'remote-model',
    provider: 'compatible', endpoint: 'https://example.test/v1', fallbackRoute: { provider: 'host',
      model: 'host-model', apiMode: 'host_llm_stream', reasoningEffort: 'unspecified' } }))
  assert.equal(f.engine.decisionStarted({ ticket: primary.ticket, requestHash: primary.requestHash }).ok, true)
  const held = f.engine.decisionComplete({ ticket: primary.ticket, model: 'remote-model',
    result: { action: 'wait', confidence: 0.4, confidenceMeaning: 'advisory', reasons: ['uncertain'], riskCodes: [] },
    usage: { inputTokens: 80, outputTokens: 20 }, evidenceRevision: f.context.evidenceRevision,
    version: f.context.version, fallbackPending: true })
  assert.equal(held.needsHostFallback, true)
  const inputTokens = 400, outputTokens = 200, requestHash = 'b'.repeat(64)
  assert.equal(f.engine.decisionReserveFallback({ ticket: primary.ticket, inputTokens, outputTokens, requestHash,
    provider: 'host', model: 'host-model', apiMode: 'host_llm_stream', reasoningEffort: 'unspecified' }).code,
  'evaluation_budget')
  const restarted = new LearningEngine({ stateRoot: f.stateRoot, adapterId: 'dsh', evaluationTokensPerDay: 700,
    evaluationCallsPerDay: 5 })
  assert.equal(restarted.recoverAutoPlans().ok, true)
  assert.equal(restarted.status().decisions.pending, 1)
  restarted.configure({ evaluationTokensPerDay: 2000 })
  const resumed = restarted.decisionReserveFallback({ ticket: primary.ticket, inputTokens, outputTokens, requestHash,
    provider: 'host', model: 'host-model', apiMode: 'host_llm_stream', reasoningEffort: 'unspecified' })
  assert.equal(resumed.ok, true)
  assert.equal(restarted.decisionStarted({ ticket: primary.ticket, stepKey: resumed.stepKey, requestHash }).ok, true)
  const final = restarted.decisionComplete({ ticket: primary.ticket, stepKey: resumed.stepKey, model: 'host-model',
    result: { action: 'recheck', confidence: 0.8, confidenceMeaning: 'host advisory', reasons: [], riskCodes: [] },
    usage: { totalTokens: 99 }, evidenceRevision: f.context.evidenceRevision, version: f.context.version })
  assert.equal(final.ok, true)
  assert.equal(final.record.primaryResult.action, 'wait')
  assert.equal(final.record.primaryModel, 'remote-model')
  assert.equal(final.record.fallbackResult.action, 'recheck')
})
