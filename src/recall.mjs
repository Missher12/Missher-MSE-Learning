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

import { getMethod } from './checks.mjs'

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

/**
 * Words that flip the meaning of the term they precede. A condition that says
 * "不适用于 JSON" excludes JSON; a task that says "不用 CSV" is not a CSV task. Both are the
 * same local decision, so both sides go through this one list — otherwise a negation in the
 * sentence would silently produce the opposite rule.
 */
const NEGATION_BEFORE = /(?:不适用|不适于|不用于|不用到|不使用|不采用|不涉及|不用|不要用|不要|不能|不应|不算|没有|无|非|排除|除了|除外|不含|not\s|no\s|never\s|without\s|except\s|exclude[sd]?\s|excluding\s|non-)/giu
/** How far back a negation may sit and still govern the term. */
const NEGATION_WINDOW_CJK = 6
const NEGATION_WINDOW_ASCII = 24

/**
 * Every format named in one text, with the polarity of each mention.
 *
 * Format identity is exact — `csv` and `json` are different technologies, never synonyms — so
 * this is the one part of a free-text condition that can be decided without approximating
 * meaning. A mention is `negated` when a negation marker governs it.
 * @param text - raw text.
 * @returns `[{ id, negated }]`, first mention per format, in text order.
 */
export function formatMentions(text) {
  const normalized = typeof text === 'string' ? normalizeText(text) : ''
  if (normalized === '') return []
  const found = new Map()
  for (const group of ALIAS_GROUPS) {
    if (group.format !== true) continue
    // Per group, every alias is scanned and every occurrence is judged on its own. Facts are
    // kept SEPARATELY — a group can be positively named in one clause and negated in another,
    // and collapsing that into a single flag is what let a negated mention erase a positive one
    // (and so slip past an exclusion). Every valid occurrence of every alias is collected
    // before the group is recorded, so one alias whose hits are all boundary-invalid can no
    // longer stand in for the group.
    let hasPositive = false
    let hasNegative = false
    for (const form of group.forms) {
      const ascii = !/[\u3400-\u9fff]/u.test(form)
      for (const index of occurrencesOf(normalized, form, ascii)) {
        if (isNegatedAt(normalized, index, form)) hasNegative = true
        else hasPositive = true
      }
    }
    if (hasPositive || hasNegative) {
      found.set(group.id, { id: group.id, hasPositive, hasNegative,
        // Conflicting instructions about one format are not resolved in either direction; the
        // caller refuses instead. A purely negative mention is simply not an assertion.
        negated: !hasPositive && hasNegative, ambiguous: hasPositive && hasNegative })
    }
  }
  return [...found.values()]
}

/**
 * Every occurrence of one alias with a valid word boundary on both sides.
 *
 * The boundary test decides whether a hit EXISTS at all: `json` inside `jsonl` and `csv` inside
 * `abccsvdef` are not the format being named, so they must not create one.
 */
function occurrencesOf(normalized, form, ascii) {
  const indexes = []
  let index = normalized.indexOf(form)
  while (index !== -1) {
    const before = normalized[index - 1] ?? ' '
    const after = normalized[index + form.length] ?? ' '
    if (!ascii || (!/[a-z0-9]/u.test(before) && !/[a-z0-9]/u.test(after))) indexes.push(index)
    index = normalized.indexOf(form, index + 1)
  }
  return indexes
}

/** Whether a negation marker governs the mention at `index`, within its own clause. */
function isNegatedAt(normalized, index, form) {
  const window = /[\u3400-\u9fff]/u.test(form) ? NEGATION_WINDOW_CJK : NEGATION_WINDOW_ASCII
  const clauseStart = Math.max(0, ...[...']，。；、！？,.;!?\n'].map(delimiter => normalized.lastIndexOf(delimiter, index - 1) + 1))
  const head = normalized.slice(Math.max(clauseStart, index - window), index)
  NEGATION_BEFORE.lastIndex = 0
  return NEGATION_BEFORE.test(head)
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
  const mentions = formatMentions(text)
  const view = {
    // The normalized prompt itself travels with the view: a domain predicate must read the task's
    // actual words, not a bag of terms that already dropped the ones the domain needs.
    raw: normalized,
    semantic: [...aliases, ...semantic],
    weak: new Set(weak),
    // Only a format the text actually ASSERTS counts as the task's format: "不用 CSV" must not
    // make this a CSV task. A format named both ways is neither asserted nor dismissed, so it
    // lands in `ambiguousFormats` and the condition gate refuses rather than choosing a side.
    formats: aliases.filter(id => groupById.get(id)?.format === true)
      .filter(id => mentions.find(item => item.id === id)?.hasPositive === true
        && mentions.find(item => item.id === id)?.hasNegative !== true),
    ambiguousFormats: mentions.filter(item => item.ambiguous === true).map(item => item.id),
    formatMentions: mentions,
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

/**
 * The condition forms this module will act on.
 *
 * Every other condition — free prose, a number, an arbitrary identifier — is `unsupported`,
 * and an unsupported condition makes the lesson **not recallable**. Refusing is the honest
 * answer: this module cannot read the condition, and offering the lesson anyway would mean
 * injecting a rule whose stated scope nobody checked. It is not a claim that the condition is
 * wrong; it is a statement that the plugin will not guess.
 *
 *   - `empty`       — no condition stated.
 *   - `universal`   — the condition says it always applies.
 *   - `format`      — one of the curated format groups (csv, json, …).
 *   - `registered`  — the canonical condition pair of a registered checker method, compared
 *                     against the registry entry so an arbitrary identifier is NOT accepted.
 *   - `unsupported` — everything else.
 */
export const CONDITION_KINDS = Object.freeze(['empty', 'universal', 'format', 'registered', 'unsupported'])

/**
 * Universal wording, matched against the WHOLE condition.
 *
 * A substring test was wrong in both directions: "仅适用于所有 CSV 报表导出" is a CSV
 * condition, not an unconditional one, and in an exclusion field "任何…不排除" says nothing is
 * excluded while "不适用于所有报表导出" excludes everything. Polarity belongs to the field, so
 * each field has its own complete-match form and anything else is not universal.
 */
const UNIVERSAL_APPLY = /^(?:任何|所有|全部)(?:任务|情况|场景|任务场景)?(?:都|均|一律)?(?:完全)?适用[。.!！]?$/u
const UNIVERSAL_EXCLUDE_NONE = /^(?:任何|所有|全部)(?:情况|场景|任务)?(?:都|均|一律)?(?:完全)?不排除[。.!！]?$/u

/**
 * The condition grammar.
 *
 * A condition is understood only when one of these templates matches it **in full**. That is the
 * whole point: a keyword list that is merely deleted before inspection cannot tell
 * "仅适用于 CSV 报表" from "仅当 CSV 报表包含字段时" — the second one names a predicate
 * (`包含字段`) that no deletion should be able to hide. Only the format wrapper, an explicit
 * quantifier, a short tail of report/export words and a trailing full stop are allowed.
 *
 * The vocabulary is deliberately closed. Extending it is a deliberate act with a test, never a
 * side effect of reusing the topic tokenizer's word tables.
 */
const FORMAT_FORM_ALTERNATION = (() => {
  const forms = ALIAS_GROUPS.filter(group => group.format === true)
    .flatMap(group => group.forms.map(form => ({ form, id: group.id })))
  // Longest first so `jsonl` is not read as `json` followed by a stray `l`.
  return forms.sort((left, right) => right.form.length - left.form.length)
})()
const FORMAT_ATOM = `(?:${FORMAT_FORM_ALTERNATION.map(entry => entry.form).join('|')})`
const FORMAT_LIST = `${FORMAT_ATOM}(?:\\s*(?:、|,|，|/|和|与|或|及|以及)\\s*${FORMAT_ATOM})*`
const FORMAT_TAIL = '(?:\\s*格式)?(?:\\s*的)?(?:\\s*(?:报表|数据|文件|内容|文本))?(?:\\s*(?:导出|导入|转换|处理))?(?:\\s*(?:任务|场景|情况))?'
const OPTIONAL_QUANTIFIER = '(?:\\s*(?:所有|任何|全部))?'
const STOP = '[。.!！]?'
// The short `仅`/`只` prefix is part of the same wrapper family as `仅适用于`: "仅 CSV 导出" is
// an explicit format template, not an unknown predicate. It stays a FULL-match alternative, so
// "仅当 CSV 报表包含字段时。" still fails the template and is refused.
const ALLOW_MARK = '(?:仅适用于|只适用于|适用于|仅用于|只用于|用于|仅|只)'
const EXCLUDE_MARK = '(?:并不适用于|不适用于|不用于|不能用于|不可用于|排除掉|排除)'

/** Field-specific complete templates. Each one consumes the entire condition. */
const CONDITION_TEMPLATES = Object.freeze([
  // "仅适用于 CSV 格式的报表导出" / "适用于 CSV、TSV 的导出"
  { re: new RegExp(`^${ALLOW_MARK}${OPTIONAL_QUANTIFIER}\\s*(${FORMAT_LIST})${FORMAT_TAIL}${STOP}$`, 'iu'),
    verdict: 'allow' },
  // "CSV 导出场景" / "CSV 格式的任务"
  { re: new RegExp(`^(${FORMAT_LIST})${FORMAT_TAIL}${STOP}$`, 'iu'), verdict: 'allow' },
  // "不适用于 JSON 格式的报表导出" written in the applicability field is the exclusion it is.
  { re: new RegExp(`^${EXCLUDE_MARK}${OPTIONAL_QUANTIFIER}\\s*(${FORMAT_LIST})${FORMAT_TAIL}${STOP}$`, 'iu'),
    verdict: 'exclude' },
])

/** Templates that only make sense in the exclusions field. */
const EXCLUSION_TEMPLATES = Object.freeze([
  { re: new RegExp(`^${EXCLUDE_MARK}${OPTIONAL_QUANTIFIER}\\s*(${FORMAT_LIST})${FORMAT_TAIL}${STOP}$`, 'iu'),
    verdict: 'exclude' },
  // "CSV 除外"
  { re: new RegExp(`^(${FORMAT_LIST})\\s*(?:除外)${STOP}$`, 'iu'), verdict: 'exclude' },
  // A bare format template in THIS field. The same words mean "limited to" in the applicability
  // field and "not for" here, because the field is what states the polarity — that is a reading
  // of the field's own semantics, not a guess about arbitrary prose.
  { re: new RegExp(`^(${FORMAT_LIST})${FORMAT_TAIL}${STOP}$`, 'iu'), verdict: 'exclude' },
])

/** Exact form -> group id, for mapping an already-matched atom back to its format. */
const formatIdByForm = new Map(FORMAT_FORM_ALTERNATION.map(entry => [entry.form, entry.id]))
const FORMAT_SEPARATOR = /\s*(?:、|,|，|\/|和|与|或|及|以及)\s*/u

/**
 * Map one matched format list back to the format ids it names.
 *
 * The list has already been matched by the grammar, so each atom is looked up EXACTLY. A
 * substring scan would read `jsonl` as `json` and `xlsx` as `xls`, which would let a JSONL-only
 * rule answer a plain JSON task — a different technology, and exactly the confusion the format
 * groups exist to prevent.
 */
function formatIdsOf(phrase) {
  const ids = []
  for (const atom of String(phrase).split(FORMAT_SEPARATOR)) {
    const id = formatIdByForm.get(atom.trim().toLowerCase())
    if (id !== undefined && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Clause-scoped view of one applicability or exclusion sentence.
 *
 * @param text - raw condition text.
 * @param field - `'applicability'` or `'exclusions'`; the field decides which templates apply
 *   and what a universal phrasing means.
 * @returns `{ kind, allow, exclude }`; `allow`/`exclude` are format ids.
 */
export function parseCondition(text, field = 'applicability') {
  const raw = typeof text === 'string' ? text.trim() : ''
  const empty = { text: '', kind: 'empty', allow: [], exclude: [] }
  if (raw === '') return empty
  if (field === 'exclusions') {
    if (UNIVERSAL_EXCLUDE_NONE.test(raw)) return { text: raw, kind: 'universal', allow: [], exclude: [] }
    for (const template of EXCLUSION_TEMPLATES) {
      const match = template.re.exec(raw)
      if (match === null) continue
      const ids = formatIdsOf(match[1] ?? '')
      if (ids.length > 0) return { text: raw, kind: 'format', allow: [], exclude: ids }
    }
    // "不适用于所有报表导出" names no format, so it is not a format exclusion this module can
    // act on — it is a sentence it does not understand, and it is refused as one.
    return { text: raw, kind: 'unsupported', allow: [], exclude: [] }
  }
  if (UNIVERSAL_APPLY.test(raw)) return { text: raw, kind: 'universal', allow: [], exclude: [] }
  for (const template of CONDITION_TEMPLATES) {
    const match = template.re.exec(raw)
    if (match === null) continue
    const ids = formatIdsOf(match[1] ?? '')
    if (ids.length === 0) continue
    return template.verdict === 'exclude'
      ? { text: raw, kind: 'format', allow: [], exclude: ids }
      : { text: raw, kind: 'format', allow: ids, exclude: [] }
  }
  return { text: raw, kind: 'unsupported', allow: [], exclude: [] }
}

/**
 * The registered condition pair for a lesson, or `null` when it is not an exact match.
 *
 * Compatibility is deliberately limited to rows that carry a registered `methodId` **and**
 * whose applicability and exclusions are exactly the registry's. Any other identifier is
 * ordinary text: accepting arbitrary snake_case would let a caller mint a "registered" look
 * for conditions nothing has ever validated.
 * @param lesson - stored row.
 * @returns `{ applicability, exclusions }` for an exact match, else `null`.
 */
export function registeredConditions(lesson) {
  if (typeof lesson?.methodId !== 'string' || lesson.methodId === '') return null
  // An unknown id is simply not a registration; it must not throw here, because the caller is
  // deciding whether a stored row recalls and an unknown method is a reason to refuse, not to fail.
  let method
  try { method = getMethod(lesson.methodId) } catch { return null }
  const applicability = lesson.applicability ?? ''
  const exclusions = lesson.exclusions ?? ''
  return applicability === (method.applicability ?? '') && exclusions === (method.exclusions ?? '')
    ? { applicability, exclusions } : null
}

/**
 * Decide whether a lesson's own conditions admit one query.
 *
 * Exclusions are evaluated first: a stated reason not to apply beats any reason to apply.
 * Only conditions written in a supported form are acted on; a condition this module cannot
 * read refuses the lesson rather than being handed to the model as a guess.
 *
 * @param lesson - stored row with `applicability` and `exclusions`.
 * @param query - `analyze(prompt)` view.
 * @returns `{ ok, gate, detail, verified, kind }` with `gate` from {@link CONDITION_GATES}.
 */
export function conditionVerdict(lesson, query) {
  const registered = registeredConditions(lesson)
  if (registered !== null) {
    // The checker owns these preconditions and validates them when it runs; they are not
    // prose for this module to interpret, so they neither gate nor count as unverified.
    return { ok: true, gate: null, detail: [], verified: true, kind: 'registered' }
  }
  const applicability = parseCondition(lesson?.applicability ?? '', 'applicability')
  const exclusions = parseCondition(lesson?.exclusions ?? '', 'exclusions')
  if (applicability.kind === 'unsupported' || exclusions.kind === 'unsupported') {
    // Before refusing, try the REGISTERED domain sentences: a candidate whose conditions are in the
    // table is decidable, and one whose conditions are not stays refused exactly as before.
    const domain = domainConditionVerdict(lesson, query)
    if (domain !== null) return domain
    return { ok: false, gate: CONDITION_GATES.unclear, detail: [], verified: false, kind: 'unsupported' }
  }
  const positive = new Set((query.formatMentions ?? []).filter(item => item.hasPositive === true).map(item => item.id))
  // A format the task names BOTH ways is not decided here. The lesson's condition refers to that
  // format, so the honest answer is that the task's format is unknown — refusing, rather than
  // letting the positive mention satisfy the lesson or the negative one dismiss it.
  const referenced = [...applicability.allow, ...applicability.exclude, ...exclusions.exclude]
  const ambiguous = (query.ambiguousFormats ?? []).filter(id => referenced.includes(id))
  if (ambiguous.length > 0) {
    return { ok: false, gate: CONDITION_GATES.unclear, detail: ambiguous, verified: false, kind: 'ambiguous' }
  }
  // 1. A format the lesson excludes. Exclusions are decided first: a stated reason not to apply
  //    beats any reason to apply, and the applicability field can state one too.
  const excludedFormats = [...exclusions.exclude, ...applicability.exclude].filter(id => positive.has(id))
  if (excludedFormats.length > 0) {
    return { ok: false, gate: CONDITION_GATES.excluded, detail: excludedFormats, verified: true, kind: 'format' }
  }
  // 2. A format the lesson is limited to: a positive mention admits, none refuses.
  const required = applicability.allow
  if (required.length > 0 && !required.some(id => positive.has(id))) {
    return { ok: false, gate: CONDITION_GATES.notApplicable, detail: required, verified: true, kind: 'format' }
  }
  return { ok: true, gate: null, detail: [], verified: true,
    kind: applicability.kind === 'format' || exclusions.kind === 'format' ? 'format' : 'empty' }
}

/**
 * Registered DOMAIN conditions: a closed, operator-visible set of condition sentences whose meaning
 * this module is allowed to decide.
 *
 * The format templates above cover conditions about a data FORMAT (CSV, JSON…). A working method
 * from a development domain instead carries prose like "同一会话切换筛选或快速展开多条经验详情时",
 * which nothing could decide — so every such row refused itself and the candidate could never be
 * used, however well it had been reviewed. Registering the sentence HERE keeps the closed-grammar
 * promise: a sentence is decidable only because it appears verbatim in this table, with the task
 * terms that decide it. Anything else stays `unsupported` and refuses the lesson, so registering a
 * phrase is a deliberate, reviewable act rather than a loosening of the gate.
 *
 * Semantics, in order (exclusions first, exactly as everywhere else):
 *  • `excludeWhen` — any listed task term present means the method must NOT be offered;
 *  • `requireAll`  — every listed term must be present;
 *  • `requireAny`  — at least one listed term must be present when the list is non-empty.
 * The sentences are the ones the domain's own candidates carry, kept verbatim so a stored row can
 * be matched without rewriting the user's text.
 */
export const DOMAIN_CONDITION_PAIRS = Object.freeze([
  Object.freeze({
    // "列表与详情请求应绑定当前会话、筛选条件和请求代次…" — the request-generation method.
    applicability: '同一会话切换筛选或快速展开多条经验详情时',
    exclusions: '同步且没有共享状态的纯函数无需请求代次',
    requireAll: ['会话'],
    requireAny: ['筛选', '详情', '切换'],
    excludeWhen: ['纯函数'],
  }),
  Object.freeze({
    // "后台结算与前台写入共享同一串行化边界…" — the serialisation-boundary method.
    applicability: '后台结算与前台写入并发且任务可能暂停关闭或到期时',
    exclusions: '锁外检查不能替代提交时的生命周期复核',
    requireAll: [],
    requireAny: ['结算', '写入', '并发', '锁'],
    // The exclusion is a statement about the method's own discipline, not a task property, so it
    // contributes no task term: the pair is decidable purely by its applicability.
    excludeWhen: [],
  }),
])

/** The registered pair a stored row matches verbatim, or null. */
export function registeredDomainCondition(lesson) {
  const applicability = typeof lesson?.applicability === 'string' ? lesson.applicability.trim() : ''
  const exclusions = typeof lesson?.exclusions === 'string' ? lesson.exclusions.trim() : ''
  if (applicability === '') return null
  return DOMAIN_CONDITION_PAIRS.find(pair => pair.applicability === applicability
    && (pair.exclusions ?? '') === exclusions) ?? null
}

/** Decide one registered domain pair against a task view. Returns null when no pair matches. */
function domainConditionVerdict(lesson, query) {
  const pair = registeredDomainCondition(lesson)
  if (pair === null) return null
  const terms = new Set(query?.semantic ?? [])
  const excluded = (pair.excludeWhen ?? []).filter(term => terms.has(term))
  if (excluded.length > 0) {
    return { ok: false, gate: CONDITION_GATES.excluded, detail: excluded, verified: true, kind: 'domain' }
  }
  const missing = (pair.requireAll ?? []).filter(term => !terms.has(term))
  const anyOf = pair.requireAny ?? []
  const anyHit = anyOf.length === 0 || anyOf.some(term => terms.has(term))
  if (missing.length > 0 || !anyHit) {
    return { ok: false, gate: CONDITION_GATES.notApplicable,
      detail: missing.length > 0 ? missing : anyOf, verified: true, kind: 'domain' }
  }
  return { ok: true, gate: null, detail: [], verified: true, kind: 'domain' }
}

/** Gate names reported by {@link conditionVerdict}. */
export const CONDITION_GATES = Object.freeze({
  excluded: 'condition_excluded',
  notApplicable: 'condition_not_applicable',
  unclear: 'condition_unclear',
})

/** Human-readable topic keys for diagnostics; never contains the raw prompt. */
export function topicLabels(view, limit = 6) {
  return [...view.semantic.slice(0, limit), ...view.bigrams.slice(0, 4).map(bigram => `…${bigram}…`)].slice(0, limit)
}
