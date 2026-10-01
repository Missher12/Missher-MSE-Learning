/**
 * Local, dependency-free term normalization and relevance for bounded recall.
 *
 * Design constraints:
 * - Fully offline and deterministic: no model call, no network, no embeddings.
 * - Conservative: a wrong recall costs context and trust, so every gate must be
 *   justified by a topic-bearing term, not by a lone generic verb.
 * - Stable identifiers: word tokens use the same hash input as schema-1/2
 *   stores, so lessons recorded by an older version keep matching.
 * - Bounded: token sets are capped so the persisted `terms` array keeps its
 *   existing 48-entry storage contract.
 *
 * Recall evidence, weakest to strongest:
 * 1. CJK character bigrams (`字段`, `导出`) confirm a shared substring.
 * 2. Semantic keys are either curated equivalence groups (金额/数额/amount) or
 *    literal words outside those groups.
 * 3. Strong keys are object-like topics; weak keys are generic actions and
 *    filler nouns whose match alone must never trigger a recall.
 */

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

/** Functional words that carry no topic. */
export const STOP_WORDS = new Set([
  '以后', '下次', '今后', '这次', '现在', '之前', '之后', '时候', '时时刻刻',
  '请', '不要', '不能', '必须', '应该', '需要', '可以', '可能', '记得',
  '一个', '一下', '一些', '一直', '这个', '那个', '这些', '那些', '这样', '那样',
  '我们', '你们', '他们', '咱们', '我把', '你的', '我的', '他的', '它的',
  '已经', '还是', '然后', '以及', '并且', '而且', '但是', '因为', '所以',
  '是否', '怎么', '如何', '什么', '为什么', '哪些', '哪个', '多少', '再按', '然后按',
  '进行', '需要', '希望', '麻烦', '帮忙', '谢谢', '好的', '可以',
  'the', 'a', 'an', 'and', 'or', 'is', 'are', 'be', 'to', 'of', 'for', 'in', 'on',
  'this', 'that', 'it', 'we', 'you', 'they', 'please', 'next', 'time', 'always',
  'never', 'before', 'after', 'should', 'must', 'not', 'do', 'does', 'with',
  'when', 'then', 'than', 'from', 'into', 'about', 'all', 'any', 'my', 'our',
])

/**
 * Generic actions and filler nouns. They may corroborate a topic match, but a
 * match consisting only of these must not recall a lesson.
 */
export const WEAK_WORDS = new Set([
  '使用', '处理', '结果', '内容', '信息', '数据', '系统', '功能', '方式', '方法',
  '问题', '情况', '地方', '部分', '东西', '相关', '一般', '通常', '基本',
  '输出', '输入', '生成', '添加', '删除', '修改', '更新', '获取', '读取', '写入',
  '执行', '运行', '完成', '实现', '提供', '包含', '存在', '出现', '发生',
  '开始', '结束', '返回', '保留', '支持', '检查', '确认', '注意', '确保',
  'use', 'using', 'used', 'handle', 'handling', 'data', 'result', 'results',
  'content', 'info', 'information', 'system', 'feature', 'way', 'method', 'issue',
  'make', 'made', 'run', 'running', 'add', 'remove', 'update', 'get', 'set',
  'read', 'write', 'check', 'confirm', 'support', 'implement', 'provide',
  'include', 'return', 'start', 'end', 'keep', 'value', 'item', 'items',
])

/**
 * Curated equivalence groups. `weak: true` marks an action group whose match
 * alone cannot establish a topic. Forms are matched as whole segmented words
 * (ASCII) or as substrings (CJK, length >= 2).
 */
export const ALIAS_GROUPS = [
  { id: 'amount', forms: ['金额', '数额', '总额', '合计', '价格', '单价', 'amount', 'total', 'price', 'sum'] },
  { id: 'currency', forms: ['货币', '币种', '币值', '人民币', '美元', '港元', '日元', '欧元', 'currency', 'cny', 'usd', 'rmb'] },
  { id: 'number', forms: ['数值', '数字', '整数', '浮点', '小数', 'numeric', 'number', 'integer', 'float', 'decimal'] },
  { id: 'decimal', forms: ['精度', '小数位', '四舍五入', '保留两位', 'precision', 'round', 'rounding'] },
  { id: 'date', forms: ['日期', '时间戳', '日期格式', 'date', 'timestamp', 'datetime', 'iso8601'] },
  { id: 'zonetime', forms: ['时区', '时区偏移', 'timezone', 'utc', 'gmt'] },
  { id: 'null', forms: ['空值', '缺失', '留空', '空字符串', 'null', 'empty', 'missing', 'nil', 'nan'] },
  { id: 'field', forms: ['字段', '表头', '属性', 'field', 'column', 'header', 'property'] },
  { id: 'table', forms: ['表格', '报表', '数据表', '工作表', 'sheet', 'table', 'spreadsheet'] },
  // Formats are separate technologies, not synonyms: a JSON-only rule must never
  // answer a YAML task. Only genuinely interchangeable spellings share a group.
  // `format: true` groups additionally act as applicability constraints: a lesson
  // bound to one format never answers a task about a different one.
  { id: 'json', format: true, forms: ['json'] },
  { id: 'jsonl', format: true, forms: ['jsonl', 'ndjson'] },
  { id: 'yaml', format: true, forms: ['yaml', 'yml'] },
  { id: 'xml', format: true, forms: ['xml'] },
  { id: 'toml', format: true, forms: ['toml'] },
  { id: 'csv', format: true, forms: ['csv'] },
  { id: 'tsv', format: true, forms: ['tsv'] },
  { id: 'excel', format: true, forms: ['excel', 'xlsx', 'xls'] },
  { id: 'test', forms: ['测试', '用例', '单测', '断言', 'test', 'tests', 'spec', 'assert'] },
  { id: 'doc', forms: ['文档', '注释', '说明', 'readme', 'doc', 'docs', 'comment', 'comments'] },
  { id: 'log', forms: ['日志', '报错', '异常', '错误信息', 'log', 'logs', 'error', 'exception', 'traceback'] },
  { id: 'api', forms: ['接口', '端点', '调用', 'api', 'endpoint', 'request', 'response'] },
  { id: 'path', forms: ['路径', '目录', 'path', 'directory', 'dirname', 'folder'] },
  { id: 'config', forms: ['配置', '设置项', '参数', 'config', 'configuration', 'setting', 'settings', 'option', 'options'] },
  { id: 'version', forms: ['版本', '版本号', 'version', 'revision'] },
  { id: 'cache', forms: ['缓存', 'cache', 'cached'] },
  { id: 'concurrency', forms: ['并发', '线程', '进程', '锁', 'concurrent', 'thread', 'process', 'lock', 'race'] },
  { id: 'permission', forms: ['权限', '授权', '令牌', 'permission', 'permissions', 'auth', 'token'] },
  { id: 'backup', forms: ['备份', '归档', '快照', 'backup', 'archive', 'snapshot'] },
  { id: 'deploy', forms: ['部署', '发布', '上线', 'deploy', 'deployment', 'release', 'publish'] },
  { id: 'index', forms: ['索引', '下标', 'index', 'indices'] },
  { id: 'encoding', forms: ['编码', '乱码', '字符集', 'encoding', 'charset', 'utf8', 'utf-8', 'gbk'] },
  { id: 'naming', forms: ['命名', '驼峰', '下划线', '大小写', 'naming', 'camel', 'snake', 'kebab', 'identifier'] },
  { id: 'layout', forms: ['布局', '对齐', '间距', '样式', 'layout', 'align', 'spacing', 'style'] },
  { id: 'color', forms: ['颜色', '配色', '色阶', 'color', 'colour', 'theme', 'palette'] },
  { id: 'chart', forms: ['图表', '柱状图', '折线图', '散点图', 'chart', 'plot', 'graph', 'histogram'] },
  { id: 'stats', forms: ['统计', '汇总', '分组统计', '平均值', '中位数', 'statistics', 'summary', 'aggregate', 'average', 'median'] },
  { id: 'percent', forms: ['百分比', '占比', '比例', 'percent', 'percentage', 'ratio'] },
  { id: 'unit', forms: ['单位', '量纲', 'unit', 'units'] },
  { id: 'limit', forms: ['限额', '上限', '阈值', '容量', 'limit', 'limits', 'threshold', 'capacity', 'quota'] },
  { id: 'user', forms: ['用户', '账户', '账号', 'user', 'users', 'account', 'profile'] },
  { id: 'export', weak: true, forms: ['导出', '另存', 'export', 'dump'] },
  { id: 'sort', weak: true, forms: ['排序', '排列', '升序', '降序', 'sort', 'sorted', 'order', 'ascending', 'descending'] },
  { id: 'convert', weak: true, forms: ['转换', '转为', '转成', '变换', 'convert', 'transform', 'cast'] },
  { id: 'validate', weak: true, forms: ['校验', '验证', 'validate', 'validation', 'verify'] },
  { id: 'filter', weak: true, forms: ['过滤', '筛选', 'filter', 'exclude'] },
  { id: 'query', weak: true, forms: ['查询', '检索', '搜索', 'query', 'search', 'select'] },
  { id: 'dedup', weak: true, forms: ['去重', '重复项', '唯一值', 'dedup', 'deduplicate', 'unique', 'distinct', 'duplicate'] },
  { id: 'format', weak: true, forms: ['格式化', '格式', '对齐格式', 'format', 'formatting', 'pretty'] },
  { id: 'retry', weak: true, forms: ['重试', '超时', '重连', 'retry', 'timeout', 'backoff'] },
  { id: 'merge', weak: true, forms: ['合并', '拆分', '拼接', 'merge', 'split', 'concat', 'join'] },
]

const aliasByForm = new Map()
const groupById = new Map()
for (const group of ALIAS_GROUPS) {
  groupById.set(group.id, group)
  for (const form of group.forms) if (!aliasByForm.has(form)) aliasByForm.set(form, group)
}
/** Format groups that constrain applicability rather than merely describing a topic. */
export const FORMAT_GROUPS = Object.freeze(ALIAS_GROUPS.filter(group => group.format === true).map(group => group.id))
const cjkForms = ALIAS_GROUPS.flatMap(group => group.forms
  .filter(form => /[\u3400-\u9fff]/u.test(form) && [...form].length >= 2)
  .map(form => [form, group]))

const cache = new Map()
const MAX_WORDS = 24
const MAX_ALIASES = 12
const MAX_BIGRAMS = 32
const TOKEN_LIMIT = 48
const CACHE_LIMIT = 1024

/** Normalize presentation without changing meaning or case-sensitivity of code. */
export function normalizeText(text) {
  return text.normalize('NFKC').toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/gu, '')
    .replace(/[`*_#>]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function cjkRuns(text) {
  return text.match(/[\u3400-\u9fff]{2,}/gu) ?? []
}

/**
 * Derive the recall view of one text.
 * @param text - instruction or user prompt.
 * @returns semantic keys, weak subset, CJK bigrams, and the hashed storage tokens.
 */
export function analyze(text) {
  const cached = cache.get(text)
  if (cached) return cached
  const normalized = normalizeText(text)
  const words = []
  for (const part of segmenter.segment(normalized)) {
    if (!part.isWordLike) continue
    const word = part.segment
    if ([...word].length < 2 || STOP_WORDS.has(word) || /^\d+(?:[.,:_-]\d+)*$/u.test(word)) continue
    if (!words.includes(word)) words.push(word)
    if (words.length >= MAX_WORDS) break
  }
  const aliases = []
  for (const word of words) {
    const group = aliasByForm.get(word)
    if (group && !aliases.includes(group.id)) aliases.push(group.id)
  }
  // Multi-word CJK forms (人民币, 时间戳) never segment into one word; scan the text.
  for (const [form, group] of cjkForms) {
    if (!aliases.includes(group.id) && normalized.includes(form)) aliases.push(group.id)
    if (aliases.length >= MAX_ALIASES) break
  }
  const semantic = []
  for (const word of words) {
    const group = aliasByForm.get(word)
    if (!group && !semantic.includes(word)) semantic.push(word)
  }
  const weak = []
  for (const group of aliases) if (groupById.get(group)?.weak === true) weak.push(group)
  for (const word of semantic) if (WEAK_WORDS.has(word)) weak.push(word)
  const bigrams = []
  for (const run of cjkRuns(normalized)) {
    for (let index = 0; index + 2 <= run.length && bigrams.length < MAX_BIGRAMS; index++) {
      const bigram = run.slice(index, index + 2)
      if (!bigrams.includes(bigram)) bigrams.push(bigram)
    }
    if (bigrams.length >= MAX_BIGRAMS) break
  }
  const view = {
    semantic: [...aliases, ...semantic],
    weak: new Set(weak),
    formats: aliases.filter(id => groupById.get(id)?.format === true),
    bigrams,
    keys: [...aliases.map(id => `@${id}`), ...semantic, ...bigrams.map(bigram => `\u00a7${bigram}`)].slice(0, TOKEN_LIMIT),
  }
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(text, view)
  return view
}

function intersect(left, right) {
  const set = new Set(right)
  return left.filter(value => set.has(value))
}

/**
 * Score one lesson against one query.
 * @param query - `analyze(prompt)` view.
 * @param lesson - `analyze(instruction)` view.
 * @returns bounded comparison evidence used by the recall gates.
 */
export function relevance(query, lesson) {
  const matched = intersect(query.semantic, lesson.semantic)
  const matchedWeak = matched.filter(key => query.weak.has(key) || lesson.weak.has(key))
  const matchedStrong = matched.filter(key => !matchedWeak.includes(key))
  const bigramMatches = intersect(query.bigrams, lesson.bigrams).length
  // An unmatched generic action or filler word (处理/输出/use) says nothing about
  // topic distance, so it must not dilute the user's task coverage.
  const unmatchedWeak = query.semantic.filter(key => query.weak.has(key) && !matched.includes(key)).length
  const effectiveQueryCount = Math.max(matched.length, query.semantic.length - unmatchedWeak)
  const queryStrongCount = query.semantic.filter(key => !query.weak.has(key)).length
  const lessonCount = lesson.semantic.length
  const queryCoverage = effectiveQueryCount === 0 ? 0 : matched.length / effectiveQueryCount
  const strongCoverage = queryStrongCount === 0 ? 0 : matchedStrong.length / queryStrongCount
  const lessonCoverage = lessonCount === 0 ? 0 : matched.length / lessonCount
  const weight = matchedStrong.length * 2 + matchedWeak.length + bigramMatches
  const queryFormats = query.formats ?? []
  const lessonFormats = lesson.formats ?? []
  return {
    matched: matched.length, matchedStrong: matchedStrong.length, matchedWeak: matchedWeak.length,
    bigramMatches, queryCoverage, strongCoverage, lessonCoverage, weight,
    queryFormats, lessonFormats,
    formatOverlap: lessonFormats.filter(id => queryFormats.includes(id)),
    lessonHasStrong: lesson.semantic.some(key => !lesson.weak.has(key)),
  }
}

/** Recall gates. Every threshold is calibrated by `tests/recall.test.mjs`. */
export const GATES = Object.freeze({
  minMatched: 2,
  minStrong: 1,
  minQueryCoverage: 0.45,
  minLessonCoverage: 0.2,
  minWeight: 4,
  shortQueryBigrams: 2,
})

/**
 * Decide whether comparison evidence is strong enough to offer the lesson.
 * @param evidence - result of {@link relevance}.
 * @returns whether the lesson may be offered, plus the gate that refused it.
 */
export function admits(evidence) {
  if (evidence.matched === 0) return { ok: false, gate: 'no_overlap' }
  // A rule bound to one concrete format does not apply to a task about another.
  // Conversion and comparison tasks name several formats, so any overlap admits the lesson.
  if (evidence.lessonFormats.length > 0 && evidence.queryFormats.length > 0 && evidence.formatOverlap.length === 0) {
    return { ok: false, gate: 'format_mismatch' }
  }
  if (!evidence.lessonHasStrong && evidence.matchedWeak < 2) return { ok: false, gate: 'weak_only' }
  if (evidence.lessonHasStrong && evidence.matchedStrong < GATES.minStrong) return { ok: false, gate: 'no_topic_term' }
  if (evidence.matched < GATES.minMatched && evidence.bigramMatches < GATES.shortQueryBigrams) {
    return { ok: false, gate: 'single_term' }
  }
  if (evidence.weight < GATES.minWeight) return { ok: false, gate: 'too_thin' }
  if (evidence.queryCoverage < GATES.minQueryCoverage) return { ok: false, gate: 'query_coverage' }
  if (evidence.lessonCoverage < GATES.minLessonCoverage) return { ok: false, gate: 'lesson_coverage' }
  return { ok: true, gate: null }
}

/** Human-readable topic keys for diagnostics; never contains the raw prompt. */
export function topicLabels(view, limit = 6) {
  return [...view.semantic.slice(0, limit), ...view.bigrams.slice(0, 4).map(bigram => `…${bigram}…`)].slice(0, limit)
}
