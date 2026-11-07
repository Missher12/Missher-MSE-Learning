import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { loadDefaultCases } from './replay.mjs'
import { RebuildEngine } from '../../rebuild/engine.mjs'

const rootBase = join(tmpdir(), 'mse-adaptive-engine-tests')
mkdirSync(rootBase, { recursive: true })
const hash = value => createHash('sha256').update(value).digest('hex')
const evidence = hash('adaptive-engine-evidence')
export const failureX = { toolName: 'bash', failureCode: 'tool_nonzero_exit', exitCode: 1,
  stderr: 'Error: API request was rejected by server', command: 'curl api endpoint' }
export const failureY = { toolName: 'bash', failureCode: 'tool_nonzero_exit', exitCode: 1,
  stderr: 'Error: output path resolution failed', command: 'resolve output directory' }
export const failureZ = { toolName: 'bash', failureCode: 'tool_nonzero_exit', exitCode: 1,
  stderr: 'Error: chart renderer returned zero', command: 'render chart summary' }
export const failureW = { toolName: 'bash', failureCode: 'tool_nonzero_exit', exitCode: 1,
  stderr: 'Error: configuration merge conflict', command: 'merge config settings' }

export function buildEngine({ includeProtected = false, root: configuredRoot = null,
  projectKey = null } = {}) {
  const root = configuredRoot === null ? mkdtempSync(join(rootBase, 'state-')) : configuredRoot
  if (configuredRoot !== null) mkdirSync(root, { recursive: true })
  const engine = new RebuildEngine({ stateRoot: root, now: () => 1_800_000_000_000 })
  const registered = new Set(['seed-x', 'seed-y', 'seed-z', 'seed-w'])
  engine.setSourceGuard(session => registered.has(session), () => [...registered])
  const seed = (session, turnId, callId, details) => engine.observeToolFailure({ sessionId: session,
    turnId, projectKey, callId, ...details })
  const priorX = seed('seed-x', 'seed-x', 'seed-x-failure', failureX)
  const priorY = seed('seed-y', 'seed-y', 'seed-y-failure', failureY)
  const priorZ = seed('seed-z', 'seed-z', 'seed-z-failure', failureZ)
  const priorW = seed('seed-w', 'seed-w', 'seed-w-failure', failureW)
  const template = loadDefaultCases().find(row => row.id === 'rsi-02-indent-error-exact').entries[0]
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
  const problemW = engine.store.read().problemLoop.problems.find(row => row.id === priorW.id)
  const targetX = entry({ id: `mem_${hash('adaptive-api-to-version').slice(0, 24)}`, problemId: priorX.id,
    signature: problemX.signature, sourceSession: 'seed-x', applicability: '文档字段版本不一致时',
    instruction: '先核对字段版本，再验证发布记录', failurePattern: '文档字段版本校验未通过' })
  const targetY = entry({ id: `mem_${hash('adaptive-path-resolution').slice(0, 24)}`, problemId: priorY.id,
    signature: problemY.signature, sourceSession: 'seed-y', applicability: '路径解析异常时',
    instruction: '先检查输出路径，再核对目录权限', failurePattern: '输出路径解析未通过' })
  const targetZ = entry({ id: `mem_${hash('adaptive-chart-render').slice(0, 24)}`, problemId: priorZ.id,
    signature: problemZ.signature, sourceSession: 'seed-z', applicability: '图表生成异常时',
    instruction: '先检查图表数据，再核对图例和坐标轴', failurePattern: '图表渲染进程异常退出' })
  const targetW = entry({ id: `mem_${hash('adaptive-config-merge').slice(0, 24)}`, problemId: priorW.id,
    signature: problemW.signature, sourceSession: 'seed-w', applicability: '配置项合并冲突时',
    instruction: '先核对配置来源，再确认覆盖顺序', failurePattern: '配置项合并发生冲突' })
  const entries = [targetX, targetY, targetZ, targetW]
  let protectedRule = null
  let warning = null
  if (includeProtected) {
    protectedRule = { ...structuredClone(template), id: `mem_${hash('adaptive-protected-rule').slice(0, 24)}`,
      type: 'rule', status: 'user_rule', instruction: 'API 调用遇到阻塞时保留用户验收规则',
      applicability: 'API 调用遇到阻塞时', exclusions: '', visibility: 'global',
      originScope: hash('scope'), originEnvironment: hash('environment'), originSession: 'seed-x',
      version: 1, problemSignature: null, lesson: null }
    warning = entry({ id: `mem_${hash('adaptive-protected-warning').slice(0, 24)}`,
      problemId: hash('adaptive-protected-warning-problem'), signature: hash('adaptive-protected-warning-signature'),
      sourceSession: 'seed-x', applicability: 'API 调用遇到阻塞时',
      instruction: '旧 API 方案有风险，执行前先复核', failurePattern: '旧 API 方案存在风险' })
    warning.status = 'needs_revision'
    entries.push(protectedRule, warning)
  }
  engine.store.transaction(doc => { doc.entries.push(...entries); return true })
  const fail = (session, turnId, callId, details) => {
    registered.add(session)
    return seed(session, turnId, callId, details)
  }
  const prepare = (session, turnId, prompt, adaptiveEligible = true) => {
    registered.add(session)
    return engine.prepare({ sessionId: session, turnId, projectKey, prompt, strategyEligible: true },
      adaptiveEligible)
  }
  const settle = (session, turnId, outcome = 'failed') => engine.complete({ sessionId: session,
    turnId, outcome, evidence: 'settled real tool turn' })
  return { root, engine, targetX, targetY, targetZ, targetW, protectedRule, warning,
    fail, prepare, settle, registered }
}

export function trainApiPolicy({ engine, fail, prepare, settle, includeDiscovery = true }) {
  const cases = [
    ...(includeDiscovery ? [['discovery-session', 'd1', 'API 调用遇到阻塞，请定位原因',
      'discovery-failure', failureX]] : []),
    ['holdout-session-1', 'h1', 'API 请求仍然阻塞，麻烦定位原因', 'independent-api-failure-1', failureX],
    ['holdout-session-2', 'h2', 'API 调用返回错误，帮我排查原因', 'independent-api-failure-2', failureX],
    ['control-session-1', 'n1', '绘制图表并调整配色', 'independent-chart-failure', failureZ],
    ['control-session-2', 'n2', '配置项合并发生冲突，请定位问题', 'independent-config-failure', failureW],
  ]
  for (const [session, turnId, prompt, callId, outcome] of cases) {
    prepare(session, turnId, prompt)
    fail(session, turnId, callId, outcome)
    settle(session, turnId)
  }
  return engine.store.read().recallStrategy.adaptive.policies
    .find(row => row.entryId.startsWith('mem_') && row.objective === engine.store.read()
      .entries.find(entry => entry.id === row.entryId)?.lesson?.problemId)
}

export function cleanupAdaptiveEngineFixture() {
  rmSync(rootBase, { recursive: true, force: true })
}
