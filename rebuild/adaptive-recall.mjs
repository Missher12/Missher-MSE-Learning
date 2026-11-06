/** Bounded runtime helpers for version-scoped, evidence-gated recall policies. */
import { createHash } from 'node:crypto'
import { ALIAS_GROUPS, analyze } from '../src/recall.mjs'
import { MAX_GUARDS_PER_TURN, MAX_METHODS_PER_TURN, MAX_RECALL_TOTAL, packRecall }
  from './recall.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const aliasOrder = new Map(ALIAS_GROUPS.map((group, index) => [group.id, index]))
const aliasById = new Map(ALIAS_GROUPS.map(group => [group.id, group]))
export const ADAPTIVE_FEATURE_IDS = Object.freeze(ALIAS_GROUPS.map(group => group.id))
// An explicit refusal anywhere in the same sentence is weak evidence at best. Omit that
// feature rather than treating a distant modifier or a coordinated negative list as assent.
const refusal = /不|没有|没用|无需|无须|未(?:使用|包含|选择|启用)|排除|禁止|避免|并非|\b(?:not|never|no|without|exclud(?:e|ed|ing)|except|avoid|don['’]t)\b/iu
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
const mentions = new Map(ALIAS_GROUPS.map(({id, forms}) => [id, new RegExp(forms.map(form =>
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

export function adaptiveEntryFeatures(entry) {
  const lesson = entry?.lesson
  return safeFeatureIds(analyze(`${entry?.applicability ?? ''} ${entry?.instruction ?? ''} `
    + `${lesson?.failurePattern ?? ''} ${lesson?.verification?.check ?? ''}`)).slice(0, 8)
}

/** Digest used only to distinguish independent query samples; source text is never persisted. */
export function adaptiveQueryKey(prompt) {
  const normalized = analyze(queryBody(prompt)).raw
    .replace(/\[[^\]]{0,96}\b(?:rpc|request|ticket|trace|call|turn|session|task|job)(?:[-_ ]?(?:id|key|marker))?\s*[:=#]\s*[\w.-]{4,}[^\]]*\]/giu, ' ')
    .replace(/\b(?:rpc|request|ticket|trace|call|turn|session|task|job)(?:[-_ ]?(?:id|key|marker))?\s*[:=#]\s*[\w.-]{4,}/giu, ' ')
    .replace(/\b(?:rpc|req|ticket|tkt|trace|call|turn|run|job|task)[-_][a-z0-9][a-z0-9._-]{3,}\b/giu, ' ')
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu, ' ')
    .replace(/\b[0-9a-f]{20,}\b/giu, ' ')
    .toLocaleLowerCase().replace(/[\p{P}\p{S}\p{White_Space}]+/gu, '')
  return hash(`mse-adaptive-query-v1\u0000${normalized}`)
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

export function adaptivePolicyMatches(policy, queryFeatures) {
  if (!Array.isArray(policy?.features) || policy.features.length === 0) return false
  const query = new Set(queryFeatures)
  return policy.features.every(id => query.has(id))
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
