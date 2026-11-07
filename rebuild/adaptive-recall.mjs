/** Bounded runtime helpers for version-scoped, evidence-gated recall policies. */
import { createHash } from 'node:crypto'
import { ALIAS_GROUPS, analyze } from '../src/recall.mjs'
import { MAX_GUARDS_PER_TURN, MAX_METHODS_PER_TURN, MAX_RECALL_TOTAL, packRecall }
  from './recall.mjs'
import { ACTION_GROUPS, OPERATION_IDS, ADAPTIVE_TASK_OPERATION_IDS } from './adaptive-operations.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const offerKey = row => `${row.id}\u0000${row.version}\u0000${row.mode}`
const aliasOrder = new Map(ALIAS_GROUPS.map((group, index) => [group.id, index]))
const aliasById = new Map(ALIAS_GROUPS.map(group => [group.id, group]))
const TASK_TOPIC_GROUPS = Object.freeze([
  {id: 'acceptance', forms: ['验收', '验收单', '验收表', '交付验收', 'acceptance']},
  {id: 'handover', forms: ['交班', '交接', 'handover']},
  {id: 'plugin', forms: ['插件', 'plugin']},
  {id: 'record', forms: ['凭条', '单据', '记录', '表单', '验收单', 'receipt', 'record', 'form']},
])
const adaptiveFeatureOrder = new Map([...ALIAS_GROUPS.map(group => group.id),
  ...TASK_TOPIC_GROUPS.map(group => group.id), ...ACTION_GROUPS.map(group => group.id)]
  .map((id, index) => [id, index]))
export const ADAPTIVE_FEATURE_IDS = Object.freeze([...adaptiveFeatureOrder.keys()])
// An explicit refusal anywhere in the same sentence is weak evidence at best. Omit that
// feature rather than treating a distant modifier or a coordinated negative list as assent.
const refusal = /不|没有|没用|无需|无须|未(?:使用|包含|选择|启用)|排除|禁止|避免|并非|撤销|作废|忘记|取消|撤回|\b(?:not|never|no|without|exclud(?:e|ed|ing)|except|avoid|revoke[sd]?|forget|don['’]t)\b/iu
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const mentions = new Map(ALIAS_GROUPS.map(({id, forms}) => [id, new RegExp(forms.map(form =>
  /[a-z0-9]/iu.test(form) ? '(?<![a-z0-9])' + escaped(form) + '(?![a-z0-9])' : escaped(form)
).join('|'), 'iu')]))
const topicMentions = new Map(TASK_TOPIC_GROUPS.map(({id, forms}) => [id, new RegExp(forms.map(form =>
  /[a-z0-9]/iu.test(form) ? '(?<![a-z0-9])' + escaped(form) + '(?![a-z0-9])' : escaped(form)
).join('|'), 'iu')]))
const actionMentions = new Map(ACTION_GROUPS.map(({id, forms}) => [id, new RegExp(forms.map(form =>
  /[a-z0-9]/iu.test(form) ? '(?<![a-z0-9])' + escaped(form) + '(?![a-z0-9])' : escaped(form)
).join('|'), 'iu')]))
const zhWords = new Intl.Segmenter('zh', {granularity: 'word'})
function hasRefusal(sentence) {
  if (refusal.test(sentence)) return true
  if (/[别无非]/u.test(sentence)) {
    for (const {segment} of zhWords.segment(sentence)) {
      if (/^(?:别(?:用|再|让|做)?|无|无意|非)$/u.test(segment)) return true
    }
  }
  return false
}
function refusedClauses(raw) {
  return raw.split(/[。！？；.!?;]|[，,]\s*(?=(?:只(?:看|用|需|考虑)|改(?:用|查|看)|应(?:当|该|核对)|(?:instead|only)\b|不要|无需|不需要))/iu)
    .filter(hasRefusal)
}

// Native RPC prepends a standalone, opaque job marker. Transport text is neither a topic
// nor evidence that an otherwise identical human query is independent.
function queryBody(prompt) {
  const text = String(prompt ?? '').trim()
  const first = /^([A-Za-z0-9][A-Za-z0-9._-]{3,63})[ \t]*\r?\n/u.exec(text)
  return first && /[0-9_.-]/u.test(first[1]) ? text.slice(first[0].length) : text
}

function safeFeatureIds(view) {
  const refused = refusedClauses(view.raw ?? '')
  return [...new Set((view.semantic ?? []).filter(id => {
    const group = aliasById.get(id)
    if (group === undefined || group.weak === true || view.weak?.has(id)) return false
    if (refused.some(clause => mentions.get(id).test(clause))) return false
    return group.format !== true || view.formats?.includes(id) === true
  }))].sort((left, right) => aliasOrder.get(left) - aliasOrder.get(right))
}

/** A finite vocabulary of non-weak, positively asserted concepts. No source words are returned. */
export function adaptiveQueryFeatures(prompt) {
  return safeFeatureIds(analyze(queryBody(prompt))).slice(0, 8)
}

const TASK_REFERENCE = /(?:这个|这一|此(?:项|事|次|处)?|上面|此前|之前|刚才|继续|同一|这件事|它|这些|那件事|上述|前面|\b(?:this|that|it|same|continue|above|earlier|previous)\b)/iu
const CLOSED_TASK_TOPIC = /(?:话题|主题|任务|事项).{0,24}(?:到此为止|就此结束|结束了?|不再讨论|不再处理|不再继续)|(?:到此为止|就此结束|结束了?|不再讨论|不再处理|不再继续).{0,24}(?:话题|主题|任务|事项)|\b(?:topic|task)\b.{0,24}\b(?:done|closed|over|finished|ended)\b/iu
const GENERIC_TASK_OBJECTS = new Set(['null', 'empty', 'error', 'log', 'value', 'result', 'problem'])
function taskStatements(raw) {
  const sentences = String(raw ?? '').split(/[。！？；.!?;\n]+/u)
  return sentences.flatMap(sentence => sentence.split(/[，,]\s*(?=(?:上一轮|上轮|前一轮|之前|此前|刚才|旧(?:的)?|现在|换到|改到|切到|转到|the previous|earlier))/iu))
    .map(text => text.trim()).filter(text => text !== '' && !CLOSED_TASK_TOPIC.test(text))
}

function positiveTaskParts(raw) {
  const topics = new Set()
  const operations = new Set()
  for (const statement of taskStatements(raw)) {
    const view = analyze(statement)
    const refused = refusedClauses(statement)
    for (const id of safeFeatureIds(view)) if (!OPERATION_IDS.has(id)) topics.add(id)
    for (const {id} of TASK_TOPIC_GROUPS) {
      if (!refused.some(clause => topicMentions.get(id).test(clause))
        && topicMentions.get(id).test(view.raw ?? '')) topics.add(id)
    }
    for (const id of (view.semantic ?? []).filter(value => OPERATION_IDS.has(value)
      && !refused.some(clause => mentions.get(value)?.test(clause)))) operations.add(id)
    for (const {id} of ACTION_GROUPS) {
      if (!refused.some(clause => actionMentions.get(id).test(clause))
        && actionMentions.get(id).test(view.raw ?? '')) operations.add(id)
    }
  }
  return {topics: [...topics], operations: [...operations]}
}

function refusedCurrentTask(raw) {
  return taskStatements(raw).some(statement => hasRefusal(statement)
    && ([...topicMentions.values(), ...actionMentions.values(), ...mentions.values()]
      .some(pattern => pattern.test(statement))))
}

const stripContextQuotes = text => String(text ?? '')
  .replace(/\x60{3}[\s\S]*?\x60{3}/gu, ' ')
  .replace(/\x60[^\x60\n]*\x60/gu, ' ')
  .replace(/[「『“"'][^」』”"']{0,512}[」』”"']/gu, ' ')
  .split('\n').filter(line => !/^\s*>/u.test(line)
    && !/^\s*(?:\[[0-9]{2,4}[-:][0-9]|(?:WARN|ERROR|INFO|DEBUG|FATAL)\b|Traceback\b|at [\w.$]+ ?\()/iu.test(line))
  .join(' ')

/** Borrow only a missing task half or related task details from an admitted recent user turn. */
export function adaptiveTaskFeatures(prompt, context = []) {
  const currentText = queryBody(prompt)
  const current = positiveTaskParts(currentText)
  let topics = [...current.topics]
  let operations = [...current.operations]
  const refusedCurrent = refusedCurrentTask(currentText)
  const valid = (Array.isArray(context) ? context : []).filter(row => row?.role === 'user'
    && ['events', 'messages'].includes(row?.source) && Number.isSafeInteger(row?.turn)
    && typeof row?.text === 'string' && row.text.length > 0 && row.text.length <= 512)
  const turns = [...new Set(valid.map(row => row.turn))].sort((a, b) => b - a).slice(0, 2)
  let units = 0
  const byTurn = new Map()
  for (const row of valid.filter(item => turns.includes(item.turn)).slice(0, 4)) {
    if (units + row.text.length > 1536) continue
    units += row.text.length
    const text = stripContextQuotes(row.text)
    if (text === '') continue
    const parts = positiveTaskParts(text)
    // A trusted earlier user turn may supply only the object ("this is an Excel report").
    // The final task still needs a positive operation, supplied by either current or prior text.
    if (parts.topics.length === 0) continue
    const prior = byTurn.get(row.turn) ?? {topics: new Set(), operations: new Set()}
    for (const id of parts.topics) prior.topics.add(id)
    for (const id of parts.operations) prior.operations.add(id)
    byTurn.set(row.turn, prior)
  }
  const anchors = new Set(['acceptance', 'handover', 'plugin', 'record', 'json', 'jsonl', 'yaml',
    'xml', 'toml', 'csv', 'tsv', 'excel', 'test', 'doc', 'api', 'path', 'table', 'config',
    'cache', 'permission', 'backup', 'deploy', 'index', 'encoding', 'naming', 'layout', 'chart',
    'color', 'stats', 'user'])
  const referenced = TASK_REFERENCE.test(currentText)
  const related = [...byTurn].sort((a, b) => b[0] - a[0]).find(([, prior]) =>
    [...prior.topics].some(id => current.topics.includes(id) && anchors.has(id)))
  const latestTurn = [...byTurn.keys()].sort((a, b) => b - a)[0]
  const contextParts = refusedCurrent ? null : related?.[1] ?? (referenced ? byTurn.get(latestTurn) : null)
  if (contextParts !== null && contextParts !== undefined) {
    // Explicit current-task terms always win. Related context may clarify extra task objects,
    // but it cannot replace the current operation or turn an unrelated history into a task.
    if (topics.length === 0) topics = [...contextParts.topics]
    else if (related !== undefined) {
      for (const id of contextParts.topics) if (!topics.includes(id)) topics.push(id)
    }
    if (operations.length === 0) operations = [...contextParts.operations]
  }
  if (topics.length === 0 || operations.length === 0
    || !topics.some(id => !GENERIC_TASK_OBJECTS.has(id))) return []
  const orderedTopics = [...new Set(topics)].sort((a, b) =>
    (adaptiveFeatureOrder.get(a) ?? 999) - (adaptiveFeatureOrder.get(b) ?? 999))
  return [...orderedTopics.slice(0, 7), ...[...new Set(operations)].sort().slice(0, 4)].slice(0, 8)
}

export function adaptiveEntryFeatures(entry) {
  const lesson = entry?.lesson
  return safeFeatureIds(analyze(`${entry?.applicability ?? ''} ${entry?.instruction ?? ''} `
    + `${lesson?.failurePattern ?? ''} ${lesson?.verification?.check ?? ''}`)).slice(0, 8)
}

/** Digest used only to distinguish independent query samples; source text is never persisted. */
export function adaptiveQueryKey(prompt, taskFeatures = []) {
  const normalized = analyze(queryBody(prompt)).raw
    .replace(/\[[^\]]{0,96}\b(?:rpc|request|ticket|trace|call|turn|session|task|job)(?:[-_ ]?(?:id|key|marker))?\s*[:=#]\s*[\w.-]{4,}[^\]]*\]/giu, ' ')
    .replace(/\b(?:rpc|request|ticket|trace|call|turn|session|task|job)(?:[-_ ]?(?:id|key|marker))?\s*[:=#]\s*[\w.-]{4,}/giu, ' ')
    .replace(/\b(?:rpc|req|ticket|tkt|trace|call|turn|run|job|task)[-_][a-z0-9][a-z0-9._-]{3,}\b/giu, ' ')
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu, ' ')
    .replace(/\b[0-9a-f]{20,}\b/giu, ' ')
    .toLocaleLowerCase().replace(/[\p{P}\p{S}\p{White_Space}]+/gu, '')
  const task = [...new Set((Array.isArray(taskFeatures) ? taskFeatures : [])
    .filter(id => adaptiveFeatureOrder.has(id)))].sort()
  return hash('mse-adaptive-query-v1\u0000' + normalized
    + (task.length === 0 ? '' : '\u0000task:' + task.join(',')))
}

/** Freeze one rule to the current query's safe features and one exact method edition. */
export function synthesizeAdaptivePolicy({ scope, qualification, entry, queryFeatures,
  turnKey = null, session, queryKey, now }) {
  if (!Array.isArray(queryFeatures) || typeof entry?.lesson?.problemId !== 'string') return null
  const query = new Set(queryFeatures.filter(id => aliasById.has(id)))
  const overlap = adaptiveEntryFeatures(entry).filter(id => query.has(id))
  const features = (overlap.length > 0 ? overlap : [...query]).slice(0, 4)
  if (features.length === 0) return null
  const objective = entry.lesson.problemId
  const identity = { schema: 'mse-adaptive-recall-v1', scope, qualification,
    entryId: entry.id, version: entry.version, objective, features }
  const id = hash(JSON.stringify(identity))
  const sample = { turnKey, session, query: queryKey, result: 'discovery_hit',
    reason: 'unique_native_method_match', at: now }
  return { id, ...identity, entryId: entry.id, version: entry.version, objective,
    mode: 'observing', generation: 0, positives: 1, negativeControls: 0, rejections: 0,
    firstSession: session, firstQuery: queryKey, reason: 'awaiting_independent_holdout',
    createdAt: now, updatedAt: now, samples: [sample] }
}

const taskOperationIds = new Set(ADAPTIVE_TASK_OPERATION_IDS)
function boundedTaskCondition(taskFeatures) {
  const features = [...new Set((Array.isArray(taskFeatures) ? taskFeatures : [])
    .filter(id => adaptiveFeatureOrder.has(id)))]
  const topics = features.filter(id => !taskOperationIds.has(id) && !GENERIC_TASK_OBJECTS.has(id))
  const operation = features.find(id => taskOperationIds.has(id))
  if (topics.length === 0 || operation === undefined) return null
  return [...topics.slice(0, 3), operation].slice(0, 4)
}

/** Freeze a task-aware v2 condition; child revisions only add an exclusion after a counterexample. */
export function synthesizeAdaptiveTaskPolicy({ scope, qualification, entry, taskFeatures,
  turnKey, session, queryKey, now, parent = null, excludeFeature = null }) {
  const base = parent === null ? boundedTaskCondition(taskFeatures) : [...parent.features]
  if (base === null || typeof entry?.lesson?.problemId !== 'string') return null
  const excludedFeatures = parent === null ? [] : [...parent.excludedFeatures]
  if (excludeFeature !== null) {
    if (!adaptiveFeatureOrder.has(excludeFeature) || taskOperationIds.has(excludeFeature)
      || GENERIC_TASK_OBJECTS.has(excludeFeature) || excludedFeatures.includes(excludeFeature)
      || base.includes(excludeFeature) || excludedFeatures.length >= 2) return null
    excludedFeatures.push(excludeFeature)
  }
  const objective = entry.lesson.problemId
  const familyGeneration = parent === null ? 0 : parent.familyGeneration + 1
  if (familyGeneration > 2) return null
  const familyId = parent?.familyId ?? hash(JSON.stringify({ scope, qualification,
    entryId: entry.id, version: entry.version, objective, firstQuery: queryKey }))
  const identity = { schema: 'mse-adaptive-recall-v2', scope, qualification,
    entryId: entry.id, version: entry.version, objective, features: base,
    excludedFeatures, familyId, familyGeneration, parentId: parent?.id ?? null }
  const id = hash(JSON.stringify(identity))
  const sample = { turnKey, session, query: queryKey, result: 'discovery_hit',
    reason: parent === null ? 'unique_native_method_match' : 'counterexample_child', at: now }
  return { id, ...identity, mode: 'observing', generation: 0, positives: 1,
    negativeControls: 0, rejections: 0, firstSession: session, firstQuery: queryKey,
    reason: 'awaiting_independent_holdout', createdAt: now, updatedAt: now, samples: [sample] }
}

/** At most two immutable children, each excluding a distinct concrete object from a real failure. */
export function narrowAdaptivePolicy(parent, taskFeatures, context = {}) {
  if (parent?.schema !== 'mse-adaptive-recall-v2' || parent.mode !== 'isolated'
    || parent.familyGeneration >= 2 || !Array.isArray(taskFeatures)) return []
  const used = new Set([...parent.features, ...parent.excludedFeatures])
  const exclusions = [...new Set(taskFeatures.filter(id => adaptiveFeatureOrder.has(id)
    && !taskOperationIds.has(id) && !GENERIC_TASK_OBJECTS.has(id) && !used.has(id)))].slice(0, 2)
  return exclusions.map(excludeFeature => synthesizeAdaptiveTaskPolicy({
    ...context, scope: parent.scope, qualification: parent.qualification,
    entry: { id: parent.entryId, version: parent.version, lesson: { problemId: parent.objective } },
    taskFeatures: parent.features, parent, excludeFeature,
  })).filter(Boolean)
}

export function adaptivePolicyMatches(policy, queryFeatures) {
  if (!Array.isArray(policy?.features) || policy.features.length === 0) return false
  const query = new Set(queryFeatures)
  return policy.features.every(id => query.has(id))
    && !(policy.excludedFeatures ?? []).some(id => query.has(id))
}

/** Add one method while preserving each incumbent line, offer and byte-for-byte body. */
export function addAdaptiveCandidate(incumbent, entry, { maxBytes = 768, now = Date.now(),
  guardAdmit = null, prompt = '' } = {}) {
  const limit = Math.min(768, Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : 768)
  const offered = incumbent?.offered ?? []
  const methods = offered.filter(row => row.mode === 'method').length
  const guards = offered.filter(row => row.mode === 'guard').length
  if (offered.some(row => row.id === entry?.id)) return { ok: false, reason: 'already_offered' }
  if (methods >= MAX_METHODS_PER_TURN || guards > MAX_GUARDS_PER_TURN
    || offered.length >= MAX_RECALL_TOTAL) return { ok: false, reason: 'offer_cap' }
  if (!entry || entry.type !== 'lesson' || entry.status === 'retired') {
    return { ok: false, reason: 'method_unavailable' }
  }
  if (entry.exclusions !== '' && entry.exclusions !== undefined) {
    const excluded = new Set(analyze(entry.exclusions).keys)
    if (analyze(prompt).keys.some(token => excluded.has(token))) {
      return { ok: false, reason: 'candidate_excluded' }
    }
  }
  const remaining = limit - (incumbent?.bytes ?? 0)
  if (remaining <= 0) return { ok: false, reason: 'byte_cap' }
  const candidate = packRecall([{ entry }], { maxBytes: remaining, maxEntries: 1, now, guardAdmit })
  if (candidate.offered.length !== 1 || candidate.offered[0].mode !== 'method') {
    return { ok: false, reason: 'candidate_not_method_or_over_budget' }
  }
  const lines = [...incumbent.lines]
  const rows = [...offered]
  const beforeGuard = rows.findIndex(row => row.mode === 'guard')
  const insertion = beforeGuard < 0 ? rows.length : beforeGuard
  lines.splice(insertion, 0, candidate.lines[0])
  rows.splice(insertion, 0, candidate.offered[0])
  const bytes = incumbent.bytes + candidate.bytes
  if (bytes > limit || rows.filter(row => row.mode === 'method').length > MAX_METHODS_PER_TURN
    || rows.filter(row => row.mode === 'guard').length > MAX_GUARDS_PER_TURN
    || rows.length > MAX_RECALL_TOTAL) return { ok: false, reason: 'offer_cap' }
  return { ok: true, reason: 'additive_candidate', selection: { ...incumbent, lines,
    offered: rows, bytes } }
}

/** Add or replace one lower-ranked automatic method while preserving rules and all warnings. */
export function competeAdaptiveCandidate(incumbent, entry, entries = [], { maxBytes = 768,
  now = Date.now(), guardAdmit = null, prompt = '', protectedOffers = [] } = {}) {
  const limit = Math.min(768, Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : 768)
  const offered = incumbent?.offered ?? []
  const methods = offered.filter(row => row.mode === 'method').length
  if (offered.some(row => row.id === entry?.id && row.version === entry?.version)) {
    return { ok: false, reason: 'already_offered' }
  }
  if (!entry || entry.type !== 'lesson' || entry.status === 'retired'
    || methods > MAX_METHODS_PER_TURN || offered.length > MAX_RECALL_TOTAL) {
    return { ok: false, reason: 'method_unavailable' }
  }
  if (entry.exclusions !== '' && entry.exclusions !== undefined
    && analyze(prompt).keys.some(token => analyze(entry.exclusions).keys.includes(token))) {
    return { ok: false, reason: 'candidate_excluded' }
  }
  const packed = packRecall([{ entry }], { maxBytes: limit, maxEntries: 1, now, guardAdmit })
  if (packed.offered.length !== 1 || packed.offered[0].mode !== 'method') {
    return { ok: false, reason: 'candidate_not_method_or_over_budget' }
  }
  const protectedKeys = new Set(protectedOffers.map(offerKey))
  const beforeGuard = offered.findIndex(row => row.mode === 'guard')
  if (methods < MAX_METHODS_PER_TURN && offered.length < MAX_RECALL_TOTAL
    && (incumbent.bytes ?? 0) + packed.bytes <= limit) {
    const insertion = beforeGuard < 0 ? offered.length : beforeGuard
    const lines = [...incumbent.lines]
    const rows = [...offered]
    lines.splice(insertion, 0, packed.lines[0])
    rows.splice(insertion, 0, packed.offered[0])
    return { ok: true, reason: 'additive_candidate', selection: { ...incumbent,
      lines, offered: rows, bytes: incumbent.bytes + packed.bytes }, replaced: [] }
  }
  const byId = new Map((entries ?? []).map(row => [row.id, row]))
  const rank = new Map((incumbent.ranked ?? []).map((row, index) => [row.entry.id, index]))
  const removable = offered.map((row, index) => ({ row, index, entry: byId.get(row.id) }))
    .filter(({row, entry}) => row.mode === 'method' && entry?.type === 'lesson'
      && entry.status !== 'retired' && !protectedKeys.has(offerKey(row)))
    .sort((left, right) => (rank.get(right.row.id) ?? -1) - (rank.get(left.row.id) ?? -1))
  for (const candidate of removable) {
    const bytes = incumbent.bytes - Buffer.byteLength(incumbent.lines[candidate.index], 'utf8')
      + packed.bytes
    if (bytes > limit) continue
    const lines = [...incumbent.lines]
    const rows = [...offered]
    lines.splice(candidate.index, 1, packed.lines[0])
    rows.splice(candidate.index, 1, packed.offered[0])
    if (rows.filter(row => row.mode === 'method').length > MAX_METHODS_PER_TURN
      || rows.filter(row => row.mode === 'guard').length > MAX_GUARDS_PER_TURN
      || rows.length > MAX_RECALL_TOTAL) continue
    if (offered.some(row => (row.mode === 'guard' || byId.get(row.id)?.type === 'rule')
      && !rows.some(item => offerKey(item) === offerKey(row)))) continue
    return { ok: true, reason: 'replace_automatic_method', selection: { ...incumbent,
      lines, offered: rows, bytes }, replaced: [candidate.row] }
  }
  return { ok: false, reason: 'no_safe_slot' }
}
