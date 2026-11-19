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

const CONFIGURATION_STAGE = {
  key: 'project_configuration',
  todo: /配置文件|项目配置|构建配置|依赖设置|\b(?:project config|build config|configuration files?)\b/iu,
  prompt: '编辑项目配置 配置文件 参数 构建设置 project configuration',
}

const STYLE_STAGES = [
  { key: 'gradient', todo: /渐变|\bgradients?\b/iu,
    change: /\b(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(|\bbg-(?:gradient-|linear-|radial\b|conic\b)|\bvar\(\s*--[\w-]{0,64}gradient\b/iu,
    prompt: '界面配色 背景渐变 按钮渐变 CSS gradient palette' },
  { key: 'color', todo: /配色|颜色|色板|主题色|\b(?:palette|colou?rs?|theme colors?)\b/iu,
    change: /\b(?:color|background(?:-color)?|border-color|fill|stroke)\s*:|\b(?:bg|text|border)-(?:primary|secondary|[a-z]+-\d{2,3})\b/iu,
    prompt: '界面配色 颜色 主题色 背景颜色 color palette' },
  { key: 'layout', todo: /布局|对齐|间距|\b(?:layout|alignment|spacing)\b/iu,
    change: /\b(?:display|grid-template(?:-columns)?|align-items|justify-content|gap|padding|margin)\s*:|\b(?:grid-cols|justify|items|gap)-[a-z0-9]/iu,
    prompt: '界面布局 对齐 间距 排列 layout alignment spacing' },
  { key: 'typography', todo: /字体|字号|行距|排版|\b(?:typography|font size)\b/iu,
    change: /\b(?:font(?:-family|-size|-weight)?|line-height|letter-spacing)\s*:|\btext-(?:xs|sm|base|lg|xl|\dxl)\b/iu,
    prompt: '界面字体 字号 排版 行距 typography font size' },
  { key: 'motion', todo: /动画|动效|过渡|\b(?:animations?|transitions?|motion)\b/iu,
    change: /\b(?:animation|transition)(?:-[a-z-]+)?\s*:|\b(?:animate|transition|duration)-[a-z0-9]/iu,
    prompt: '界面动画 动效 过渡 animation transition motion' },
]

/** A live todo gives a search phrase even for stages with no file-specific detector. */
export function plannedRecallStage(title) {
  if (typeof title !== 'string' || title.length > 160 || /[\u0000-\u001f\u007f]/u.test(title)) return null
  const text = title.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (text.length < 4 || text.length > 160) return null
  const stage = [...STYLE_STAGES, CONFIGURATION_STAGE].find(row => row.todo.test(text))
  return { key: stage?.key ?? `todo:${text.toLowerCase()}`,
    prompt: stage === undefined ? text : `${text} ${stage.prompt}` }
}

/** Only parsed native file mutations provide an actionable write-before-recall signal. */
export function nativeFileChange(exec) {
  const args = exec?.arguments
  if (args === null || typeof args !== 'object') return null
  if (exec.name === 'write' && typeof args.file_path === 'string' && typeof args.content === 'string') {
    return { path: args.file_path, text: args.content }
  }
  if (exec.name === 'edit' && typeof args.file_path === 'string' && typeof args.old_string === 'string'
    && typeof args.new_string === 'string') return { path: args.file_path, text: args.new_string }
  if (exec.name !== 'str_replace_editor' || !['create', 'str_replace', 'insert'].includes(args.command)
    || typeof args.path !== 'string') return null
  const text = args.command === 'create' ? args.file_text : args.new_str
  return { path: args.path, text: typeof text === 'string' ? text : '' }
}

export function fileRecallStages(change) {
  const name = change.path.split(/[\\/]/u).at(-1)
  if (/^(?:package\.json|[jt]sconfig(?:\.[a-z0-9_-]+)?\.json|(?:[a-z0-9_-]+\.)?config\.(?:[cm]?[jt]s|json|ya?ml|toml))$/iu.test(name)) {
    return [CONFIGURATION_STAGE]
  }
  if (!/\.(?:css|scss|sass|less|[jt]sx?|vue|svelte|astro|html)$/iu.test(name)) return []
  const text = change.text.slice(0, 65_536)
  return STYLE_STAGES.filter(stage => stage.change.test(text))
}

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
