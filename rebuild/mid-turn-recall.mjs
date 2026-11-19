import { SENSITIVE_PATTERN, AUTHORITY_PATTERN } from '../src/failure-evidence.mjs'

const FAILURE_LABELS = Object.freeze({
  json_parse_error: 'JSON parse syntax error',
  json_trailing_comma: 'JSON trailing comma syntax error',
  syntax_error: 'syntax error',
  missing_dependency: 'missing dependency import',
  permission_error: 'permission denied access',
  test_failure: 'test assertion failure',
  type_error: 'type error',
  network_error: 'network connection error',
  tool_timeout: 'tool timeout',
  tool_error: 'tool execution error',
  nonzero_exit: 'nonzero exit',
})

const FAILURE_PATTERNS = Object.freeze([
  ['json_trailing_comma', /trailing comma|尾逗号/iu],
  ['json_parse_error', /json(?:decode)?error|json\.parse|json\.loads|json.{0,24}(?:语法|解析).{0,12}(?:错|失败)|(?:语法|解析).{0,12}(?:错|失败).{0,24}json/iu],
  ['missing_dependency', /module not found|cannot find module|no module named|importerror|找不到模块|缺少依赖/iu],
  ['permission_error', /permission denied|eacces|eperm|not permitted|权限不足|无权访问/iu],
  ['test_failure', /assertionerror|assertion failed|tests? failed|test failure|测试断言失败|测试失败/iu],
  ['type_error', /typeerror|typescript.{0,16}(?:error|failed)|类型错误|类型检查失败/iu],
  ['network_error', /econnrefused|enotfound|network.{0,16}(?:error|unreachable)|连接被拒绝|网络错误/iu],
  ['syntax_error', /syntaxerror|syntax error|unexpected token|语法错误/iu],
])

const OPERATION_FIXTURES = Object.freeze({
  'python-json-loader-v1': { category: 'json_check', taskFeatures: ['json', 'jsonl'], label: 'JSON validation parse check' },
  'node-test-runner-spec-v1': { category: 'test_stage', taskFeatures: ['test'], label: 'suite validation stage' },
  'pytest-summary-v1': { category: 'test_stage', taskFeatures: ['test'], label: 'suite validation stage' },
  'typescript-noemit-v1': { category: 'typecheck', taskFeatures: ['optypecheck', 'typecheck'], label: 'TypeScript type check' },
  'python-receipt-contract-v1': { category: 'receipt_check', taskFeatures: ['acceptance', 'record', 'receipt'], label: 'receipt contract validation' },
})

export const MID_TURN_OPERATION_FIXTURE_IDS = Object.freeze(Object.keys(OPERATION_FIXTURES))
export const MID_TURN_FAILURE_FIXTURE_IDS = Object.freeze(Object.keys(FAILURE_LABELS))

/** Return only closed-vocabulary evidence; source output is inspected transiently and never returned. */
export function classifyMidTurnFailure(failureCode, diagnostic = '') {
  if (!['tool_nonzero_exit', 'tool_error_flag', 'tool_timeout'].includes(failureCode)) return null
  const text = typeof diagnostic === 'string' ? diagnostic.slice(0, 16_384) : ''
  if (SENSITIVE_PATTERN.test(text)
    || AUTHORITY_PATTERN.test(text.replace(/^\s*\x60{3}[^\n]*$/gmu, ' '))) return null
  for (const [category, pattern] of FAILURE_PATTERNS) {
    if (pattern.test(text)) return { category, label: FAILURE_LABELS[category] }
  }
  const category = failureCode === 'tool_timeout' ? 'tool_timeout'
    : failureCode === 'tool_error_flag' ? 'tool_error' : 'nonzero_exit'
  return { category, label: FAILURE_LABELS[category] }
}

/** A repetition class exists only for an objectively parsed public native check result. */
export function midTurnOperation(checkId, taskFeatures) {
  const fixture = OPERATION_FIXTURES[checkId]
  if (fixture === undefined || !Array.isArray(taskFeatures)
    || !fixture.taskFeatures.some(id => taskFeatures.includes(id))) return null
  return { category: fixture.category, label: fixture.label }
}

export function midTurnRecallPrompt(taskLabels, trigger) {
  const labels = [...new Set((Array.isArray(taskLabels) ? taskLabels : [])
    .filter(label => typeof label === 'string' && label.length > 0))].slice(0, 8)
  const triggers = Array.isArray(trigger) ? trigger : [trigger]
  const categories = [...new Set(triggers.map(row => row?.category).filter(category =>
    Object.hasOwn(FAILURE_LABELS, category)
      || Object.values(OPERATION_FIXTURES).some(fixture => fixture.category === category)))].slice(0, 5)
  const categoryLabels = categories.map(category => FAILURE_LABELS[category]
    ?? Object.values(OPERATION_FIXTURES).find(row => row.category === category)?.label)
    .filter(label => typeof label === 'string')
  return [...labels, ...categoryLabels].join(' ').slice(0, 256)
}
