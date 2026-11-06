import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { loadDefaultCases } from '../scripts/rsi/replay.mjs'
import { RebuildEngine } from './engine.mjs'

const rootBase = join(tmpdir(), 'mse-adaptive-engine-tests')
mkdirSync(rootBase, { recursive: true })
const hash = value => createHash('sha256').update(value).digest('hex')
const evidence = hash('adaptive-engine-evidence')
const failureX = { toolName: 'bash', failureCode: 'tool_nonzero_exit', exitCode: 1,
  stderr: 'Error: API request was rejected by server', command: 'curl api endpoint' }
const failureY = { toolName: 'bash', failureCode: 'tool_nonzero_exit', exitCode: 1,
  stderr: 'Error: output path resolution failed', command: 'resolve output directory' }
const failureZ = { toolName: 'bash', failureCode: 'tool_nonzero_exit', exitCode: 1,
  stderr: 'Error: chart renderer returned zero', command: 'render chart summary' }

function buildEngine() {
  const root = mkdtempSync(join(rootBase, 'state-'))
  const engine = new RebuildEngine({ stateRoot: root, now: () => 1_800_000_000_000 })
  const registered = new Set(['seed-x', 'seed-y', 'seed-z'])
  engine.setSourceGuard(session => registered.has(session), () => [...registered])
  const seed = (session, turnId, callId, details) => engine.observeToolFailure({ sessionId: session,
    turnId, projectKey: null, callId, ...details })
  const priorX = seed('seed-x', 'seed-x', 'seed-x-failure', failureX)
  const priorY = seed('seed-y', 'seed-y', 'seed-y-failure', failureY)
  const priorZ = seed('seed-z', 'seed-z', 'seed-z-failure', failureZ)
  const cases = loadDefaultCases()
  const template = cases.find(row => row.id === 'rsi-02-indent-error-exact').entries[0]
  const entry = ({ id, problemId, signature, sourceSession, applicability, instruction, failurePattern }) => ({
    ...structuredClone(template), id, type: 'lesson', status: 'pending', instruction, applicability,
    exclusions: '', visibility: 'global', originScope: hash('scope'), originEnvironment: hash('environment'),
    originSession: sourceSession, lesson: { schema: 'mse-failure-lesson-v1', applicability,
      failurePattern, rootCause: { summary: '当前版本检查步骤不足', basis: 'hypothesis',
        evidenceIds: [evidence] }, repairSteps: ['核对适用条件', '重新运行目标检查'],
      verification: { check: '目标工具调用检查', expected: '返回预期结果' }, instruction,
      problemId, evidenceRevision: 0, evidenceIds: [evidence] }, problemSignature: signature,
    version: 1, parentVersion: null, superseded: null, injected: 0, recurrences: 0,
    createdAt: 100, updatedAt: 100, lastInjectedAt: null, evidenceHash: null,
    methodStats: null, factDigest: null, digestDay: null, importedFrom: null, sourceDigest: null,
  })
  const problemX = engine.store.read().problemLoop.problems.find(row => row.id === priorX.id)
  const problemY = engine.store.read().problemLoop.problems.find(row => row.id === priorY.id)
  const problemZ = engine.store.read().problemLoop.problems.find(row => row.id === priorZ.id)
  const targetX = entry({ id: `mem_${hash('adaptive-api-to-version').slice(0, 24)}`, problemId: priorX.id,
    signature: problemX.signature, sourceSession: 'seed-x', applicability: '文档字段版本不一致时',
    instruction: '先核对字段版本，再验证发布记录', failurePattern: '文档字段版本校验未通过' })
  const targetY = entry({ id: `mem_${hash('adaptive-path-resolution').slice(0, 24)}`, problemId: priorY.id,
    signature: problemY.signature, sourceSession: 'seed-y', applicability: '路径解析异常时',
    instruction: '先检查输出路径，再核对目录权限', failurePattern: '输出路径解析未通过' })
  const targetZ = entry({ id: `mem_${hash('adaptive-chart-render').slice(0, 24)}`, problemId: priorZ.id,
    signature: problemZ.signature, sourceSession: 'seed-z', applicability: '图表生成异常时',
    instruction: '先检查图表数据，再核对图例和坐标轴', failurePattern: '图表渲染进程异常退出' })
  engine.store.transaction(doc => { doc.entries.push(targetX, targetY, targetZ); return true })
  const fail = (session, turnId, callId, details) => {
    registered.add(session)
    return seed(session, turnId, callId, details)
  }
  const prepare = (session, turnId, prompt) => {
    registered.add(session)
    return engine.prepare({ sessionId: session, turnId, projectKey: null, prompt, strategyEligible: true })
  }
  const settle = (session, turnId, outcome = 'failed') => engine.complete({ sessionId: session,
    turnId, outcome, evidence: 'settled real tool turn' })
  return { root, engine, targetX, targetY, targetZ, fail, prepare, settle, registered }
}

test('adaptive discovery needs an independent holdout and a real, additive negative control', () => {
  const { root, engine, targetX, targetZ, fail, prepare, settle } = buildEngine()
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
    assert.deepEqual(adaptive.policies[0].features, ['api'],
      'the query-to-method association does not require lexical overlap with the method')

    const repeated = prepare('discovery-session', 'd2', 'RPC-123456789abc\nAPI 调用遇到阻塞，请定位原因')
    assert.ok(!repeated.offered.some(row => row.id === targetX.id), 'repeated query remains shadow only')
    fail('discovery-session', 'd2', 'same-query-failure', failureX)
    settle('discovery-session', 'd2')
    adaptive = engine.store.read().recallStrategy.adaptive
    assert.equal(adaptive.policies[0].positives, 1, 'same session and same substantive query are not independent')

    const holdout = prepare('holdout-session', 'h1', '请检查接口 API 的返回状态与调用结果')
    assert.ok(!holdout.offered.some(row => row.id === targetX.id), 'holdout remains shadow only')
    fail('holdout-session', 'h1', 'independent-api-failure', failureX)
    settle('holdout-session', 'h1')
    adaptive = engine.store.read().recallStrategy.adaptive
    assert.equal(adaptive.policies[0].positives, 2)
    assert.equal(adaptive.policies[0].mode, 'observing', 'a positive holdout alone cannot activate')
    assert.equal(adaptive.policies[0].samples[1].replay.expected, true)

    const control = prepare('control-session', 'n1', '绘制图表并调整配色')
    const controlProbe = engine.store.read().recallStrategy.adaptive.probes
      .find(row => row.turnKey === control.turnKey)
    assert.ok(controlProbe.controlPolicies.includes(policyId),
      'only a physically addable candidate can use this turn as a negative control')
    assert.ok(control.offered.some(row => row.id === targetZ.id),
      'the real control objective is explained by its own baseline method')
    fail('control-session', 'n1', 'independent-chart-failure', failureZ)
    settle('control-session', 'n1')
    adaptive = engine.store.read().recallStrategy.adaptive
    const policy = adaptive.policies.find(row => row.id === policyId)
    assert.equal(policy.negativeControls, 1)
    assert.equal(policy.mode, 'approved', 'offline replay requires both a gain and a real negative control')
    assert.equal(policy.samples[2].replay.expected, false)
    assert.deepEqual(engine.statusView().recallStrategy.adaptive.recent
      .find(row => row.id === policyId).replay.candidate, { hits: 1, misses: 0, falseOffers: 0 })

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
    prepare('discovery-session', 'd1', 'API 调用遇到阻塞，请定位原因')
    fail('discovery-session', 'd1', 'discovery-failure', failureX)
    settle('discovery-session', 'd1')
    prepare('holdout-session', 'h1', '请检查接口 API 的返回状态与调用结果')
    fail('holdout-session', 'h1', 'independent-api-failure', failureX)
    settle('holdout-session', 'h1')
    prepare('control-session', 'n1', '绘制图表并调整配色')
    fail('control-session', 'n1', 'independent-chart-failure', failureZ)
    settle('control-session', 'n1')
    const before = engine.store.read().entries.find(row => row.id === targetX.id)
    assert.equal(before.status, 'pending')
    const active = prepare('active-session', 'a1', 'API 调用返回意外状态，请分析原因')
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
    assert.equal(targetAfter.status, before.status)
    assert.equal(targetAfter.version, before.version)
    assert.equal(engine.store.read().entries.find(row => row.id === targetY.id).status, 'pending')
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

test.after(() => rmSync(rootBase, { recursive: true, force: true }))
