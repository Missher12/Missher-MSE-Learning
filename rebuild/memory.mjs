/**
 * mse-rebuild memory: ONE atomic document holding every durable fact of the small learning chain.
 *
 *  entries     — long-term memory rows (user rules, specific failure lessons, digest insights).
 *                Statuses state facts directly: user_rule / pending / check_passed / needs_revision
 *                / retired. Visibility (global|scoped) is RECALL policy and is kept SEPARATE from
 *                origin scope/environment attribution. Long-term rules never mechanically expire.
 *  problemLoop — the existing bounded failure ledger (src/problems.mjs, pure): independent-event
 *                observations, capsules, evidence revisions, tickets. Reused unchanged.
 *  turnFacts   — one row per REAL turn (injected or not): sanitized task summary + the completion
 *                fact (failed / cancelled / unknown / verified) with a non-null evidenceHash once
 *                settled. This is what the daily digest sees, and what makes settlement survive a
 *                crash without ever crediting a lesson from turn prose.
 *  receipts    — per-turn injection ledger with PERSISTENT event identity (`turnKey`), the exact
 *                entry versions injected, and the settled outcome + evidenceHash. Recurrence
 *                attribution reads THESE, not history guesses.
 *  requests    — the request audit: written BEFORE dispatch with the FROZEN facts the answer will
 *                be judged against (evidenceIds, token hashes, parent version, route identity,
 *                material key); one in-flight slot; unknown cost recorded and never auto-replayed;
 *                settled rows with unknown cost are never pruned away.
 *  materials   — per-material attempt gate: at most one audited automatic retry for a known
 *                truncation/failure; a material that ended with unknown cost is never re-issued
 *                automatically (not even across restarts) until new facts change the material.
 *  digest      — daily watermark with PER-DAY processing boundaries (throughAt), persisted summary
 *                text and produced entry ids, plus the backlog. Used ONLY for the digest, never
 *                for turn settlement.
 *
 * Importing an old lessons-v1.json is read-only and idempotent: the source file is never written,
 * and re-importing the same content digest adds nothing.
 */
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { LearningError, check } from '../src/store.mjs'
import { commitMemoryFile, prepareMemoryDirectory, readBoundedMemoryFileBytes, resolveMemoryDirectory,
  withMemoryStoreLock, encodeMemoryDocument, decodeMemoryDocument, REQUEST_AUDIT_LIMIT }
  from './storage.mjs'
import { problemLoopValid, ensureProblemLoop } from '../src/problems.mjs'
import { ADAPTIVE_TASK_OPERATION_IDS } from './adaptive-operations.mjs'

// EVOLUTION016: format 4 adds the version evidence ledger (methodStats / methodHistory /
// receipt.methodFeedback / request.methodFingerprint). Format 3 stays READ-COMPATIBLE: a pure
// read never rewrites it, and the first real write transaction migrates it atomically.
export const MEMORY_FORMAT = 4
export const READABLE_FORMATS = [3, 4]
export const ENTRY_STATUSES = ['user_rule', 'pending', 'check_passed', 'needs_revision', 'retired']
export const TURN_OUTCOMES = ['failed', 'cancelled', 'unknown', 'verified']
export const METHOD_HISTORY_LIMIT = 128
export const METHOD_HISTORY_ROW_BYTES = 6144
export const METHOD_FEEDBACK_LIMIT = 12
export const METHOD_STATS_COVERAGES = ['complete', 'since_upgrade']
export const METHOD_HISTORY_STATUSES = ['pending', 'check_passed', 'needs_revision', 'retired',
  'legacy_partial']
export const METHOD_FEEDBACK_KINDS = ['recurrence', 'check_pass', 'check_fail']
export const OFFER_MODES = ['method', 'guard']
export const RECALL_STRATEGY_LIMIT = 128
export const ADAPTIVE_RECALL_POLICY_LIMIT = 128
export const ADAPTIVE_RECALL_PROBE_LIMIT = 128
export const ADAPTIVE_RECALL_DECISION_LIMIT = 128
const ADAPTIVE_POLICY_ROW_BYTES = 16_384
const RECALL_STRATEGY_ROW_MODES = ['shadow', 'matched', 'active', 'approved', 'isolated']
const RECALL_STRATEGY_REASONS = ['candidate_difference', 'same_turn_native_failure_match',
  'native_checker_failure', 'same_signature_recurrence']
const ADAPTIVE_POLICY_MODES = ['observing', 'approved', 'isolated']
const ADAPTIVE_POLICY_REASONS = ['awaiting_independent_holdout', 'holdout_approved',
  'awaiting_negative_control', 'competing_method_failure', 'native_recurrence',
  'native_checker_failure', 'counterexample_child']
const ADAPTIVE_SAMPLE_RESULTS = ['discovery_hit', 'holdout_hit', 'negative', 'recurrence',
  'checker_failure', 'negative_control', 'unknown']
const ADAPTIVE_SAMPLE_REASONS = ['unique_native_method_match', 'independent_same_objective',
  'same_session_or_query', 'competing_method_failure', 'same_signature_recurrence',
  'native_checker_failure', 'cancelled_or_unknown', 'source_revoked', 'material_revoked',
  'policy_stale', 'independent_unmatched_objective', 'strategy_disabled', 'counterexample_child']
const ADAPTIVE_DECISION_RESULTS = ['created', 'holdout_hit', 'negative_control', 'approved',
  'rejected', 'isolated', 'unknown', 'feature_refused']
const ADAPTIVE_DECISION_REASONS = ['unique_native_method_match', 'independent_same_objective',
  'same_session_or_query', 'competing_method_failure', 'same_signature_recurrence',
  'native_checker_failure', 'cancelled_or_unknown', 'source_revoked', 'material_revoked',
  'policy_stale', 'insufficient_safe_features', 'already_tracked', 'candidate_not_additive',
  'ambiguous_native_failure', 'baseline_explains_failure', 'stale_probe', 'probe_capacity',
  'independent_unmatched_objective', 'awaiting_negative_control', 'strategy_disabled',
  'revision_limit', 'same_mechanism_rejected', 'counterexample_child']
const safeAdaptiveFeature = value => typeof value === 'string' && /^[a-z][a-z0-9]{0,15}$/u.test(value)
const ADAPTIVE_TASK_OPERATIONS = new Set(ADAPTIVE_TASK_OPERATION_IDS)
const ADAPTIVE_GENERIC_TASK_FEATURES = new Set(['null', 'empty', 'error', 'log', 'value', 'result', 'problem'])
export const ENTRY_LIMIT = 256
export const RECEIPT_LIMIT = 256
export const REQUEST_LIMIT = REQUEST_AUDIT_LIMIT
export const FACT_LIMIT = 256
const hash = text => createHash('sha256').update(text).digest('hex')
export const digestOf = value => hash(JSON.stringify(value))
/**
 * MSE20: ONE unit for every bounded text field — UTF-16 code units, the same unit every validator
 * in this file uses (`value.length`), truncated WITHOUT splitting a surrogate pair. Producers must
 * clamp with THIS helper so an emoji-heavy value can never pass a codepoint check and then fail a
 * UTF-16 validator (the invalid_memory counterexample), and nothing unbounded ever reaches a store.
 */
export const boundedUnits = (value, maxUnits) => {
  const text = String(value ?? '')
  let out = ''
  let units = 0
  for (const ch of text) {
    if (units + ch.length > maxUnits) break
    out += ch
    units += ch.length
  }
  return out
}
/**
 * REVIEW-FIX1: a code-point/byte bounded clamp for LEGACY snapshots whose original bounds are
 * unknown. It never splits a surrogate pair and never exceeds either bound; it is NOT used for a
 * legal current edition (that one is archived verbatim).
 */
export const boundedCodepoints = (value, maxCodepoints, maxBytes) => {
  const text = String(value ?? '')
  let out = ''
  let points = 0
  let bytes = 0
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (points + 1 > maxCodepoints || bytes + size > maxBytes) break
    out += ch
    points += 1
    bytes += size
  }
  return out
}
const isPlainObject = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const entryHex = value => typeof value === 'string' && /^mem_[a-f0-9]{24}$/u.test(value)
const dayText = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
const boundedLabel = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && /[\u0000-\u001f\u007f]/u.test(value) === false
const safeBrief = value => value === null || (typeof value === 'string' && value.length <= 200
  && /[\r\n\u0000-\u001f\u007f]/u.test(value) === false)
const usageValid = value => value === null || (isPlainObject(value)
  && Object.keys(value).every(key => ['input', 'output', 'cached', 'cacheWrite', 'reasoning', 'total',
    'known'].includes(key))
  && ['input', 'output', 'cached', 'cacheWrite', 'reasoning', 'total'].every(key => value[key] === null
    || (Number.isSafeInteger(value[key]) && value[key] >= 0))
  && typeof value.known === 'boolean')

/** The CURRENT version's own statistics window (EVOLUTION016). Family totals stay on the entry. */
const methodStatsValid = value => isPlainObject(value)
  && Object.keys(value).every(key => ['version', 'since', 'coverage', 'injected', 'recurrences',
    'checkPasses', 'checkFails'].includes(key))
  && Number.isSafeInteger(value.version) && value.version >= 1
  && Number.isFinite(value.since)
  && METHOD_STATS_COVERAGES.includes(value.coverage)
  && Number.isSafeInteger(value.injected) && value.injected >= 0
  && Number.isSafeInteger(value.recurrences) && value.recurrences >= 0
  && Number.isSafeInteger(value.checkPasses) && value.checkPasses >= 0
  && Number.isSafeInteger(value.checkFails) && value.checkFails >= 0

/** One archived method edition: instruction/lesson kept, statistics only when they were real. */
const historyRowValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['entryId', 'version', 'instruction', 'applicability', 'exclusions',
    'visibility', 'lesson', 'originScope', 'originEnvironment', 'originSession', 'originSessions',
    'stats', 'status', 'reason', 'archivedAt', 'evidenceHash'].includes(key))
  && entryHex(row.entryId)
  && Number.isSafeInteger(row.version) && row.version >= 1
  && typeof row.instruction === 'string' && [...row.instruction].length >= 1
  && [...row.instruction].length <= 240 && Buffer.byteLength(row.instruction, 'utf8') <= 480
  && (row.applicability === '' || boundedLabel(row.applicability, 160))
  && (row.exclusions === '' || boundedLabel(row.exclusions, 160))
  && ['global', 'scoped'].includes(row.visibility)
  && (row.lesson === null || (isPlainObject(row.lesson) && hex64(row.lesson.problemId)
    && Array.isArray(row.lesson.evidenceIds) && row.lesson.evidenceIds.every(hex64)
    && Array.isArray(row.lesson.repairSteps) && row.lesson.repairSteps.length >= 1
    && isPlainObject(row.lesson.verification) && typeof row.lesson.verification.check === 'string'
    && Buffer.byteLength(JSON.stringify(row.lesson), 'utf8') <= 4096))
  && hex64(row.originScope) && hex64(row.originEnvironment)
  && (row.originSession === null || boundedLabel(row.originSession, 512))
  // REVIEW-FIX1: the bounded provenance frozen with the evidence capsules (≤4 sessions). Old
  // rows without it keep loading; unknown provenance is admitted only as a fixed reason.
  && (row.originSessions === undefined || (Array.isArray(row.originSessions)
    && row.originSessions.length <= 4 && row.originSessions.every(session => boundedLabel(session, 512))))
  && (row.stats === null || methodStatsValid(row.stats))
  && METHOD_HISTORY_STATUSES.includes(row.status)
  && (row.reason === null || boundedLabel(row.reason, 64))
  && Number.isFinite(row.archivedAt)
  && (row.evidenceHash === null || hex64(row.evidenceHash))

/** The per-turn proof that a version was already counted — survives checkEvents rotation. */
const methodFeedbackValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['entryId', 'version', 'kind', 'checkId', 'at', 'voided'].includes(key))
  && entryHex(row.entryId) && Number.isSafeInteger(row.version) && row.version >= 1
  && METHOD_FEEDBACK_KINDS.includes(row.kind)
  && (row.checkId === null || boundedLabel(row.checkId, 128))
  && Number.isFinite(row.at)
  // REVIEW-FIX1: a cancelled turn rolls its credit back but KEEPS the proof row (voided), so the
  // same turn can never be counted twice after the rollback.
  && (row.voided === undefined || typeof row.voided === 'boolean')

const entryValid = entry => isPlainObject(entry)
  && Object.keys(entry).every(key => ['id', 'type', 'status', 'instruction', 'applicability', 'exclusions',
    'visibility', 'originScope', 'originEnvironment', 'originSession', 'originSessions', 'lesson', 'problemSignature',
    'version', 'parentVersion', 'superseded', 'injected', 'recurrences', 'createdAt', 'updatedAt',
    'lastInjectedAt', 'evidenceHash', 'methodStats', 'factDigest', 'digestDay', 'importedFrom',
    'sourceDigest'].includes(key))
  && entryHex(entry.id)
  && ['rule', 'lesson', 'digest'].includes(entry.type)
  && ENTRY_STATUSES.includes(entry.status)
  && typeof entry.instruction === 'string' && [...entry.instruction].length >= 8
  && [...entry.instruction].length <= 240 && Buffer.byteLength(entry.instruction, 'utf8') <= 480
  && (entry.applicability === '' || boundedLabel(entry.applicability, 160))
  && (entry.exclusions === '' || boundedLabel(entry.exclusions, 160))
  && ['global', 'scoped'].includes(entry.visibility)
  && hex64(entry.originScope) && hex64(entry.originEnvironment)
  && (entry.originSession === null || boundedLabel(entry.originSession, 512))
  // REVIEW-FIX2: the edition's OWN bounded birth-source snapshot (2..4 sessions). Absent means
  // explicitly unknown; old libraries without it stay valid. Overflow is stored as unknown, not
  // as a silently truncated subset.
  && (entry.originSessions === undefined || (Array.isArray(entry.originSessions)
    && entry.originSessions.length >= 2 && entry.originSessions.length <= 4
    && entry.originSessions.every(session => boundedLabel(session, 512))
    && new Set(entry.originSessions).size === entry.originSessions.length))
  && (entry.lesson === null || (isPlainObject(entry.lesson) && hex64(entry.lesson.problemId)
    && Array.isArray(entry.lesson.evidenceIds) && entry.lesson.evidenceIds.every(hex64)
    && Array.isArray(entry.lesson.repairSteps) && entry.lesson.repairSteps.length >= 1
    && isPlainObject(entry.lesson.verification) && typeof entry.lesson.verification.check === 'string'
    && Buffer.byteLength(JSON.stringify(entry.lesson), 'utf8') <= 4096))
  && (entry.problemSignature === null || hex64(entry.problemSignature))
  && Number.isSafeInteger(entry.version) && entry.version > 0
  && (entry.parentVersion === null || Number.isSafeInteger(entry.parentVersion))
  && (entry.superseded === null || (isPlainObject(entry.superseded) && typeof entry.superseded.instruction === 'string'
    && Number.isSafeInteger(entry.superseded.version)
    // Optional revision provenance (bounded); old libraries without it stay valid.
    && (entry.superseded.reason === undefined || (typeof entry.superseded.reason === 'string'
      && entry.superseded.reason.length <= 160))
    && (entry.superseded.at === undefined || Number.isSafeInteger(entry.superseded.at))))
  && Number.isSafeInteger(entry.injected) && entry.injected >= 0
  && Number.isSafeInteger(entry.recurrences) && entry.recurrences >= 0
  && Number.isFinite(entry.createdAt) && Number.isFinite(entry.updatedAt)
  && (entry.lastInjectedAt === null || Number.isFinite(entry.lastInjectedAt))
  && (entry.evidenceHash === null || hex64(entry.evidenceHash))
  // EVOLUTION016: the CURRENT version's own window. Optional — a format3 entry keeps loading.
  && (entry.methodStats === undefined || entry.methodStats === null
    || methodStatsValid(entry.methodStats))
  && (entry.factDigest === undefined || entry.factDigest === null || hex64(entry.factDigest))
  && (entry.digestDay === undefined || entry.digestDay === null || dayText(entry.digestDay))
  && (entry.importedFrom === null || (isPlainObject(entry.importedFrom) && hex64(entry.importedFrom.sourceDigest)
    && boundedLabel(entry.importedFrom.batch, 64)))
  && (entry.sourceDigest === undefined || entry.sourceDigest === null || hex64(entry.sourceDigest))

const receiptValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['id', 'turnKey', 'at', 'bytes', 'offered', 'settled', 'outcome',
    'evidenceHash', 'source', 'methodFeedback'].includes(key))
  && hex64(row.id) && hex64(row.turnKey) && Number.isFinite(row.at)
  && Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= 1536
  && Array.isArray(row.offered) && row.offered.length <= 4
  && row.offered.every(x => isPlainObject(x) && entryHex(x.id) && Number.isSafeInteger(x.version)
    && Object.keys(x).every(key => ['id', 'version', 'mode'].includes(key))
    && (x.mode === undefined || OFFER_MODES.includes(x.mode)))
  && typeof row.settled === 'boolean'
  && (row.outcome === null || TURN_OUTCOMES.includes(row.outcome))
  && (row.evidenceHash === null || hex64(row.evidenceHash))
  && (row.source === null || (isPlainObject(row.source) && hex64(row.source.routeId)))
  // EVOLUTION016: per-turn feedback identity. Old receipts have NO array and keep loading; a
  // 4-offer turn can carry at most 12 (entry,version,kind) rows.
  && (row.methodFeedback === undefined
    || (Array.isArray(row.methodFeedback) && row.methodFeedback.length <= METHOD_FEEDBACK_LIMIT
      && row.methodFeedback.every(methodFeedbackValid)
      && new Set(row.methodFeedback.map(x => `${x.entryId}\u0000${x.version}\u0000${x.kind}`)).size
        === row.methodFeedback.length))

const factValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['id', 'turnKey', 'sessionId', 'day', 'at', 'settledAt',
    'taskSummary', 'outcome', 'evidenceBrief', 'evidenceHash', 'failures', 'cancellations',
    'diagnostic'].includes(key))
  && hex64(row.id) && hex64(row.turnKey) && dayText(row.day) && Number.isFinite(row.at)
  // DAILY21: settlement time (late/in-flight turns); absent in old libraries.
  && (row.settledAt === undefined || Number.isFinite(row.settledAt))
  && (row.sessionId === null || boundedLabel(row.sessionId, 512))
  && safeBrief(row.taskSummary)
  && (row.outcome === null || TURN_OUTCOMES.includes(row.outcome))
  && safeBrief(row.evidenceBrief)
  && (row.evidenceHash === null || hex64(row.evidenceHash))
  && Number.isSafeInteger(row.failures) && row.failures >= 0
  && Number.isSafeInteger(row.cancellations) && row.cancellations >= 0
  // MSE22: optional SAME-TURN forward diagnostic (unverified assistant_report clue). Bounded by
  // the SAME units the producer uses (≤512 UTF-16 units AND ≤1024 UTF-8 bytes); old rows load.
  && (row.diagnostic === undefined || row.diagnostic === null
    || (isPlainObject(row.diagnostic)
      && Object.keys(row.diagnostic).every(key => ['text', 'hash', 'seq', 'at'].includes(key))
      && typeof row.diagnostic.text === 'string' && row.diagnostic.text.length >= 1
      && row.diagnostic.text.length <= 512
      && Buffer.byteLength(row.diagnostic.text, 'utf8') <= 1024
      && hex64(row.diagnostic.hash) && Number.isSafeInteger(row.diagnostic.seq)
      && row.diagnostic.seq >= 0 && Number.isFinite(row.diagnostic.at)))

/** Extraction candidates: audit BEFORE any call, deduplicated by session+turn+content. */
const CORRECTION_STATUSES = ['pending', 'dispatched', 'saved', 'ignored', 'unknown_cost']
// A frozen revision reference: either the exact target (entry id + version + instruction
// fingerprint) or an ambiguous marker. Metadata only; extra/oversized keys are refused.
const REVISION_STATES = ['unique', 'ambiguous']
const revisionRefValid = ref => isPlainObject(ref)
  && Object.keys(ref).every(key => ['state', 'id', 'version', 'digest', 'count',
    'intentEvidence', 'action'].includes(key))
  // OPTIONAL action (MSE20-FIX1): 'retire' = explicit stop order, 'replace' = correction that may
  // supersede the old edition only when a new rule really lands. Old snapshots without it load.
  && (ref.action === undefined || ref.action === 'retire' || ref.action === 'replace')
  && REVISION_STATES.includes(ref.state)
  // OPTIONAL bounded directive evidence from the trusted user body (MSE19); pre-MSE19
  // snapshots without it must keep loading unchanged.
  && (ref.intentEvidence === undefined || (typeof ref.intentEvidence === 'string'
    && ref.intentEvidence.length >= 1 && ref.intentEvidence.length <= 512))
  && (ref.state === 'unique'
    ? (typeof ref.id === 'string' && /^mem_[0-9a-f]{24}$/u.test(ref.id)
      && Number.isSafeInteger(ref.version) && ref.version >= 1 && hex64(ref.digest))
    : (Number.isSafeInteger(ref.count) && ref.count >= 2 && ref.count <= 8))

const correctionContextItemValid = item => isPlainObject(item)
  && Object.keys(item).every(key => ['role', 'turn', 'text', 'source'].includes(key))
  && (item.role === 'user' || item.role === 'assistant')
  && (item.turn === null || Number.isSafeInteger(item.turn))
  && typeof item.text === 'string' && item.text.length > 0 && item.text.length <= 512
  && (item.source === 'messages' || item.source === 'events')
const correctionDecisionValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['durability', 'scope', 'basis', 'result', 'reason'].includes(key))
  && ['durable', 'one_off', 'uncertain'].includes(row.durability)
  && ['global', 'project', 'uncertain'].includes(row.scope)
  && (row.basis === undefined || boundedLabel(row.basis, 160))
  && (row.result === 'saved' || row.result === 'ignored')
  && (row.reason === null || row.reason === undefined || boundedLabel(row.reason, 64))
const correctionValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['id', 'sessionId', 'turnId', 'at', 'day', 'userText', 'assistantBrief',
    'cwd', 'contentDigest', 'status', 'reason', 'ticket', 'entryIds', 'revision', 'context',
    'decisions', 'contextOmitted'].includes(key))
  // rows written before this field stay valid: absent OR null are both accepted
  && (row.revision === undefined || row.revision === null || revisionRefValid(row.revision))
  && (row.cwd === null || boundedLabel(row.cwd, 512))
  && hex64(row.id) && hex64(row.contentDigest)
  && boundedLabel(row.sessionId, 512) && boundedLabel(String(row.turnId), 64)
  && Number.isFinite(row.at) && dayText(row.day)
  && typeof row.userText === 'string' && row.userText.length > 0 && row.userText.length <= 1536
  && (row.assistantBrief === null || (typeof row.assistantBrief === 'string'
    && row.assistantBrief.length <= 768))
  && CORRECTION_STATUSES.includes(row.status)
  && (row.reason === null || boundedLabel(row.reason, 64))
  && (row.ticket === null || boundedLabel(row.ticket, 64))
  && Array.isArray(row.entryIds) && row.entryIds.length <= 2
  // CONTEXT-SCOPE-016 optional bounded fields: absent in old candidates (format 3/4 stays valid).
  && (row.context === undefined || row.context === null || (Array.isArray(row.context)
    && row.context.length <= 4 && row.context.every(correctionContextItemValid)
    && row.context.reduce((units, item) => units + item.text.length, 0) <= 1536))
  && (row.decisions === undefined || row.decisions === null || (Array.isArray(row.decisions)
    && row.decisions.length <= 2 && row.decisions.every(correctionDecisionValid)))
  && (row.contextOmitted === undefined || row.contextOmitted === null
    || boundedLabel(row.contextOmitted, 160))

const requestValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['ticket', 'kind', 'at', 'problemId', 'entryId', 'digestDay', 'requestHash',
    'dispatchHash', 'dispatchedAt', 'settled', 'terminal', 'usage', 'maxTokens', 'evidenceIds', 'tokenHashes',
    'parentVersion', 'routeId', 'material', 'retryOf', 'digestFacts', 'digestThrough', 'sourceSessionId',
    'sourceRoute', 'outputBytes', 'finishKind', 'digestKeys', 'digestExcluded', 'digestAdmission',
    'verdictCode', 'verdictFields', 'methodFingerprint'].includes(key))
  // OPTIONAL MSE17 output audit: absent in pre-MSE17 libraries — they must keep loading as-is.
  && (row.outputBytes === undefined || (Number.isSafeInteger(row.outputBytes)
    && row.outputBytes >= 0 && row.outputBytes <= 65_536))
  && (row.finishKind === undefined || (typeof row.finishKind === 'string'
    && /^[a-z][a-z_-]{0,23}$/u.test(row.finishKind)))
  && (row.digestFacts === null || (Array.isArray(row.digestFacts) && row.digestFacts.length <= 64
    && row.digestFacts.every(fact => isPlainObject(fact) && Number.isSafeInteger(fact.at)
      && boundedLabel(String(fact.kind ?? ''), 24))))
  && (row.digestThrough === null || Number.isSafeInteger(row.digestThrough))
  && (row.sourceSessionId === null || boundedLabel(row.sourceSessionId, 512))
  && (row.sourceRoute === null || (isPlainObject(row.sourceRoute) && Object.keys(row.sourceRoute)
    .every(key => ['provider', 'model', 'reasoningEffort'].includes(key))
    && boundedLabel(row.sourceRoute.provider, 32) && boundedLabel(row.sourceRoute.model, 64)
    && (row.sourceRoute.reasoningEffort === undefined || boundedLabel(row.sourceRoute.reasoningEffort, 16))))
  && boundedLabel(row.ticket, 64) && ['reflect', 'revise', 'digest', 'extract'].includes(row.kind)
  && Number.isFinite(row.at)
  && (row.problemId === null || hex64(row.problemId))
  && (row.entryId === null || entryHex(row.entryId))
  && (row.digestDay === null || dayText(row.digestDay))
  && hex64(row.requestHash) && (row.dispatchHash === null || hex64(row.dispatchHash))
  && (row.dispatchedAt === null || Number.isFinite(row.dispatchedAt))
  && typeof row.settled === 'boolean'
  && (row.terminal === null || boundedLabel(row.terminal, 64))
  && usageValid(row.usage)
  // MSE17: the staged extract retry hard-caps at 4096; every other kind stayed within 2048.
  // MSE21/22: extract's staged retry (4096) and method generation (8192) are the two documented
  // hard caps; nothing may exceed them.
  && Number.isSafeInteger(row.maxTokens) && row.maxTokens > 0 && row.maxTokens <= 8192
  && Array.isArray(row.evidenceIds) && row.evidenceIds.length <= 4 && row.evidenceIds.every(hex64)
  // evidenceTokenHashes() freezes at most 96 hashes; the audit must accept that same bound.
  && Array.isArray(row.tokenHashes) && row.tokenHashes.length <= 96 && row.tokenHashes.every(hex64)
  && (row.parentVersion === null || Number.isSafeInteger(row.parentVersion))
  && (row.routeId === null || boundedLabel(row.routeId, 128))
  && hex64(row.material)
  && (row.retryOf === null || boundedLabel(row.retryOf, 64))
  // DAILY21: the frozen set of fact identities this digest really covered, and the safely
  // excluded ones (`key|reason`). Optional; old requests keep loading.
  && (row.digestKeys === undefined || row.digestKeys === null
    || (Array.isArray(row.digestKeys) && row.digestKeys.length <= 64
      && row.digestKeys.every(key => boundedLabel(key, 256))))
  && (row.digestExcluded === undefined || row.digestExcluded === null
    || (Array.isArray(row.digestExcluded) && row.digestExcluded.length <= 1024
      && row.digestExcluded.every(key => boundedLabel(key, 256))))
  // MSE21-ADMISSION: the frozen admission evidence a digest action may rely on.
  && (row.digestAdmission === undefined || row.digestAdmission === null
    || (Array.isArray(row.digestAdmission) && row.digestAdmission.length <= 64
      && row.digestAdmission.every(ref => isPlainObject(ref)
        && Object.keys(ref).every(key => ['key', 'kind', 'contentHash', 'scope', 'environment',
          'visibility', 'temporary', 'entryId', 'entryVersion', 'entryStatus', 'instruction',
          'problemId', 'evidenceIds', 'evidenceDigest', 'passed'].includes(key))
        && boundedLabel(ref.key, 256) && boundedLabel(ref.kind, 16) && hex64(ref.contentHash)
        && (ref.scope === null || hex64(ref.scope))
        && (ref.environment === undefined || ref.environment === null || hex64(ref.environment))
        && (ref.visibility === 'global' || ref.visibility === 'scoped')
        && typeof ref.temporary === 'boolean'
        && (ref.entryId === undefined || ref.entryId === null || entryHex(ref.entryId))
        && (ref.entryVersion === undefined || ref.entryVersion === null
          || (Number.isSafeInteger(ref.entryVersion) && ref.entryVersion >= 1))
        && (ref.entryStatus === undefined || ref.entryStatus === null || boundedLabel(ref.entryStatus, 24))
        && (ref.instruction === undefined || typeof ref.instruction === 'string'
          && Buffer.byteLength(ref.instruction, 'utf8') <= 480)
        && (ref.problemId === undefined || ref.problemId === null || hex64(ref.problemId))
        && (ref.evidenceIds === undefined || (Array.isArray(ref.evidenceIds)
          && ref.evidenceIds.length <= 4 && ref.evidenceIds.every(hex64)))
        && (ref.evidenceDigest === undefined || ref.evidenceDigest === null || hex64(ref.evidenceDigest))
        && (ref.passed === undefined || typeof ref.passed === 'boolean'))))
  // MSE21: bounded verdict diagnostics (fixed codes/field names only).
  && (row.verdictCode === undefined || row.verdictCode === null || boundedLabel(row.verdictCode, 32))
  && (row.verdictFields === undefined || row.verdictFields === null
    || (Array.isArray(row.verdictFields) && row.verdictFields.length <= 8
      && row.verdictFields.every(name => boundedLabel(name, 24))))
  // EVOLUTION016: the frozen parent mechanism this revision was requested against.
  && (row.methodFingerprint === undefined || row.methodFingerprint === null
    || hex64(row.methodFingerprint))

const materialValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['key', 'terminal', 'attempts', 'autoRetriesUsed', 'unknownCost',
    'updatedAt', 'manualAllowed', 'autoRetryAllowed', 'ticket'].includes(key))
  && (row.ticket === null || boundedLabel(row.ticket, 64))
  && typeof row.autoRetryAllowed === 'boolean'
  && hex64(row.key) && (row.terminal === null || boundedLabel(row.terminal, 64))
  && Number.isSafeInteger(row.attempts) && row.attempts >= 0
  && Number.isSafeInteger(row.autoRetriesUsed) && row.autoRetriesUsed >= 0 && row.autoRetriesUsed <= 1
  && typeof row.unknownCost === 'boolean' && Number.isFinite(row.updatedAt)

const checkSummaryValid = (checkId, summary, passed) => {
  if (!isPlainObject(summary)) return false
  if (checkId === 'node-test-runner-spec-v1') return Object.keys(summary).every(key =>
    ['kind', 'tests', 'passed', 'failed', 'skipped', 'cancelled', 'todo'].includes(key))
    && summary.kind === 'node_test_runner'
    && ['tests', 'passed', 'failed', 'skipped', 'cancelled', 'todo'].every(key =>
      Number.isSafeInteger(summary[key]) && summary[key] >= 0 && summary[key] <= 1_000_000)
    && summary.tests === summary.passed + summary.failed + summary.skipped
      + summary.cancelled + summary.todo
  if (checkId === 'typescript-noemit-v1') return Object.keys(summary).every(key =>
    ['kind', 'diagnostics'].includes(key))
    && summary.kind === 'typescript_noemit' && Number.isSafeInteger(summary.diagnostics)
    && summary.diagnostics >= 0 && summary.diagnostics <= 256
  if (checkId === 'pytest-summary-v1') return Object.keys(summary).every(key =>
    ['kind', 'tests', 'passed', 'failed', 'errors', 'skipped', 'xfailed', 'xpassed', 'deselected'].includes(key))
    && summary.kind === 'pytest'
    && ['tests', 'passed', 'failed', 'errors', 'skipped', 'xfailed', 'xpassed', 'deselected'].every(key =>
      Number.isSafeInteger(summary[key]) && summary[key] >= 0 && summary[key] <= 1_000_000)
    && summary.tests > 0 && summary.errors === 0
    && summary.tests === summary.passed + summary.failed + summary.skipped
      + summary.xfailed + summary.xpassed
    && (passed ? summary.passed === summary.tests && summary.failed === 0 && summary.skipped === 0
      && summary.xfailed === 0 && summary.xpassed === 0 && summary.deselected === 0
      : summary.failed > 0)
  return false
}
const checkEventValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['id', 'at', 'checkId', 'turnKey', 'entryId', 'entryVersion',
    'passed', 'summary'].includes(key))
  && hex64(row.id) && Number.isFinite(row.at) && boundedLabel(row.checkId, 128) && hex64(row.turnKey)
  && entryHex(row.entryId) && Number.isSafeInteger(row.entryVersion) && typeof row.passed === 'boolean'
  && (row.summary === undefined || checkSummaryValid(row.checkId, row.summary, row.passed))

const recallStrategyRowValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['turnKey', 'scope', 'session', 'qualification', 'id', 'version',
    'mode', 'generation', 'reason', 'problemId'].includes(key))
  && hex64(row.turnKey) && hex64(row.scope) && hex64(row.session) && hex64(row.qualification)
  && entryHex(row.id)
  && Number.isSafeInteger(row.version) && row.version >= 1
  && RECALL_STRATEGY_ROW_MODES.includes(row.mode)
  && (row.mode === 'matched' ? hex64(row.problemId) : row.problemId === undefined)
  && Number.isSafeInteger(row.generation) && row.generation >= 0
  && RECALL_STRATEGY_REASONS.includes(row.reason)
const adaptiveOfferValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['id', 'version', 'mode'].includes(key))
  && entryHex(row.id) && Number.isSafeInteger(row.version) && row.version >= 1
  && ['method', 'guard'].includes(row.mode)
const adaptiveOfferListValid = rows => Array.isArray(rows) && rows.length <= 3
  && rows.every(adaptiveOfferValid)
  && new Set(rows.map(row => `${row.id}\u0000${row.version}\u0000${row.mode}`)).size === rows.length
  && rows.filter(row => row.mode === 'method').length <= 2
  && rows.filter(row => row.mode === 'guard').length <= 1
const adaptiveReplayProjectionValid = row => isPlainObject(row)
  && ['baselineOffers', 'candidateOffers', 'protectedOffers', 'baselineBytes', 'candidateBytes',
    'matched', 'observedEntry'].every(key => Object.hasOwn(row, key))
  && adaptiveOfferListValid(row.baselineOffers) && adaptiveOfferListValid(row.candidateOffers)
  && adaptiveOfferListValid(row.protectedOffers)
  && Number.isSafeInteger(row.baselineBytes) && row.baselineBytes >= 0 && row.baselineBytes <= 768
  && Number.isSafeInteger(row.candidateBytes) && row.candidateBytes >= 0 && row.candidateBytes <= 768
  && typeof row.matched === 'boolean'
  && isPlainObject(row.observedEntry) && entryHex(row.observedEntry.id)
  && Number.isSafeInteger(row.observedEntry.version) && row.observedEntry.version >= 1
  && row.protectedOffers.every(offer => row.baselineOffers.some(base => base.id === offer.id
    && base.version === offer.version && base.mode === offer.mode)
    && row.candidateOffers.some(next => next.id === offer.id
      && next.version === offer.version && next.mode === offer.mode))
const adaptiveSampleValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['turnKey', 'session', 'query', 'result', 'reason', 'at', 'replay'].includes(key))
  && hex64(row.turnKey) && hex64(row.session) && hex64(row.query)
  && ADAPTIVE_SAMPLE_RESULTS.includes(row.result) && ADAPTIVE_SAMPLE_REASONS.includes(row.reason)
  && (row.replay === undefined || (isPlainObject(row.replay)
    && Object.keys(row.replay).every(key => ['features', 'baselineHasTarget', 'canAdd', 'expected',
      'matched', 'baselineOffers', 'candidateOffers', 'protectedOffers', 'baselineBytes',
      'candidateBytes', 'observedEntry'].includes(key))
    && Array.isArray(row.replay.features) && row.replay.features.length <= 8
    && row.replay.features.every(safeAdaptiveFeature)
    && new Set(row.replay.features).size === row.replay.features.length
    && typeof row.replay.baselineHasTarget === 'boolean' && typeof row.replay.canAdd === 'boolean'
    && typeof row.replay.expected === 'boolean'
    && (row.replay.baselineOffers === undefined
      ? ['matched', 'candidateOffers', 'protectedOffers', 'baselineBytes', 'candidateBytes', 'observedEntry']
        .every(key => row.replay[key] === undefined)
      : adaptiveReplayProjectionValid(row.replay))))
  && Number.isFinite(row.at)
const adaptivePolicyValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['id', 'schema', 'scope', 'qualification', 'entryId', 'version',
    'objective', 'features', 'mode', 'generation', 'positives', 'negativeControls', 'rejections', 'firstSession',
    'firstQuery', 'reason', 'createdAt', 'updatedAt', 'samples', 'excludedFeatures', 'familyId',
    'familyGeneration', 'parentId'].includes(key))
  && hex64(row.id) && ['mse-adaptive-recall-v1', 'mse-adaptive-recall-v2'].includes(row.schema)
  && hex64(row.scope) && hex64(row.qualification) && entryHex(row.entryId)
  && Number.isSafeInteger(row.version) && row.version >= 1 && hex64(row.objective)
  && Array.isArray(row.features) && row.features.length >= (row.schema === 'mse-adaptive-recall-v2' ? 2 : 1)
  && row.features.length <= 4
  && row.features.every(safeAdaptiveFeature) && new Set(row.features).size === row.features.length
  && (row.schema === 'mse-adaptive-recall-v1'
    ? row.excludedFeatures === undefined && row.familyId === undefined
      && row.familyGeneration === undefined && row.parentId === undefined
    : Array.isArray(row.excludedFeatures) && row.excludedFeatures.length <= 2
      && row.excludedFeatures.every(id => safeAdaptiveFeature(id)
        && !ADAPTIVE_TASK_OPERATIONS.has(id) && !ADAPTIVE_GENERIC_TASK_FEATURES.has(id)
        && !row.features.includes(id))
      && new Set(row.excludedFeatures).size === row.excludedFeatures.length
      && row.features.some(id => !ADAPTIVE_TASK_OPERATIONS.has(id)
        && !ADAPTIVE_GENERIC_TASK_FEATURES.has(id))
      && row.features.some(id => ADAPTIVE_TASK_OPERATIONS.has(id))
      && hex64(row.familyId) && Number.isSafeInteger(row.familyGeneration)
      && row.familyGeneration >= 0 && row.familyGeneration <= 2
      && (row.parentId === null ? row.familyGeneration === 0 : hex64(row.parentId)
        && row.familyGeneration >= 1))
  && ADAPTIVE_POLICY_MODES.includes(row.mode)
  && Number.isSafeInteger(row.generation) && row.generation >= 0
  && Number.isSafeInteger(row.positives) && row.positives >= 1 && row.positives <= 1_000_000
  && Number.isSafeInteger(row.negativeControls) && row.negativeControls >= 0
  && row.negativeControls <= 1_000_000
  && Number.isSafeInteger(row.rejections) && row.rejections >= 0 && row.rejections <= 1_000_000
  && hex64(row.firstSession) && hex64(row.firstQuery)
  && ADAPTIVE_POLICY_REASONS.includes(row.reason)
  && Number.isFinite(row.createdAt) && Number.isFinite(row.updatedAt)
  && Array.isArray(row.samples) && row.samples.length >= 1 && row.samples.length <= 8
  && row.samples.every(sample => adaptiveSampleValid(sample)
    && (row.schema !== 'mse-adaptive-recall-v2'
      || !['holdout_hit', 'negative_control', 'negative'].includes(sample.result)
      || sample.replay !== undefined && adaptiveReplayProjectionValid(sample.replay)))
  && new Set(row.samples.map(sample => sample.turnKey)).size === row.samples.length
  && Buffer.byteLength(JSON.stringify(row), 'utf8') <= ADAPTIVE_POLICY_ROW_BYTES
const adaptiveComparisonValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['policyId', 'baselineHasTarget', 'canAdd', 'matched',
    'baselineOffers', 'candidateOffers', 'protectedOffers', 'baselineBytes', 'candidateBytes'].includes(key))
  && hex64(row.policyId) && typeof row.baselineHasTarget === 'boolean' && typeof row.canAdd === 'boolean'
  && (row.baselineOffers === undefined
    ? ['matched', 'candidateOffers', 'protectedOffers', 'baselineBytes', 'candidateBytes']
      .every(key => row[key] === undefined)
    : typeof row.matched === 'boolean' && adaptiveOfferListValid(row.baselineOffers)
      && adaptiveOfferListValid(row.candidateOffers) && adaptiveOfferListValid(row.protectedOffers)
      && Number.isSafeInteger(row.baselineBytes) && row.baselineBytes >= 0 && row.baselineBytes <= 768
      && Number.isSafeInteger(row.candidateBytes) && row.candidateBytes >= 0 && row.candidateBytes <= 768
      && row.protectedOffers.every(offer => row.baselineOffers.some(base => base.id === offer.id
        && base.version === offer.version && base.mode === offer.mode)
        && row.candidateOffers.some(next => next.id === offer.id
          && next.version === offer.version && next.mode === offer.mode)))
const adaptiveSignalValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['policyId', 'kind', 'entryId', 'version', 'objective',
    'problemId', 'signature', 'features', 'reason', 'at'].includes(key))
  && hex64(row.policyId)
  && ['discovery', 'holdout', 'negative', 'negative_control', 'recurrence', 'checker_failure'].includes(row.kind)
  && entryHex(row.entryId) && Number.isSafeInteger(row.version) && row.version >= 1
  && hex64(row.objective)
  && (row.problemId === null || hex64(row.problemId))
  && (row.signature === null || hex64(row.signature))
  && Array.isArray(row.features) && row.features.length <= 4
  && row.features.every(safeAdaptiveFeature) && new Set(row.features).size === row.features.length
  && ADAPTIVE_DECISION_REASONS.includes(row.reason) && Number.isFinite(row.at)
const adaptiveProbeValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['turnKey', 'scope', 'projectScope', 'environment', 'session',
    'query', 'taskQuery', 'features', 'taskFeatures', 'baselineOffers', 'offered', 'shadowPolicies', 'controlPolicies',
    'activePolicies', 'comparisons', 'pending', 'at'].includes(key))
  && hex64(row.turnKey) && hex64(row.scope) && hex64(row.projectScope) && hex64(row.environment)
  && hex64(row.session) && hex64(row.query)
  && (row.taskQuery === undefined || hex64(row.taskQuery))
  && Array.isArray(row.features) && row.features.length <= 8
  && row.features.every(safeAdaptiveFeature) && new Set(row.features).size === row.features.length
  && (row.taskFeatures === undefined || (Array.isArray(row.taskFeatures) && row.taskFeatures.length <= 8
    && row.taskFeatures.every(safeAdaptiveFeature) && new Set(row.taskFeatures).size === row.taskFeatures.length))
  && Array.isArray(row.baselineOffers) && row.baselineOffers.length <= 3
  && row.baselineOffers.every(adaptiveOfferValid)
  && Array.isArray(row.offered) && row.offered.length <= 3 && row.offered.every(adaptiveOfferValid)
  && Array.isArray(row.shadowPolicies) && row.shadowPolicies.length <= 8
  && row.shadowPolicies.every(hex64) && new Set(row.shadowPolicies).size === row.shadowPolicies.length
  && Array.isArray(row.controlPolicies) && row.controlPolicies.length <= 8
  && row.controlPolicies.every(hex64) && new Set(row.controlPolicies).size === row.controlPolicies.length
  && Array.isArray(row.activePolicies) && row.activePolicies.length <= 1
  && row.activePolicies.every(hex64) && new Set(row.activePolicies).size === row.activePolicies.length
  && Array.isArray(row.comparisons) && row.comparisons.length <= 8
  && row.comparisons.every(adaptiveComparisonValid)
  && new Set(row.comparisons.map(item => item.policyId)).size === row.comparisons.length
  && Array.isArray(row.pending) && row.pending.length <= 8 && row.pending.every(adaptiveSignalValid)
  && Number.isFinite(row.at)
  && Buffer.byteLength(JSON.stringify(row), 'utf8') <= 4096
const adaptiveDecisionValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['turnKey', 'scope', 'policyId', 'entryId', 'version',
    'result', 'reason', 'at'].includes(key))
  && hex64(row.turnKey) && hex64(row.scope)
  && (row.policyId === null || hex64(row.policyId))
  && (row.entryId === null || entryHex(row.entryId))
  && (row.version === null || (Number.isSafeInteger(row.version) && row.version >= 1))
  && ADAPTIVE_DECISION_RESULTS.includes(row.result)
  && ADAPTIVE_DECISION_REASONS.includes(row.reason) && Number.isFinite(row.at)
function adaptiveFamiliesValid(policies) {
  const task = policies.filter(row => row.schema === 'mse-adaptive-recall-v2')
  const byId = new Map(task.map(row => [row.id, row]))
  const familyCounts = new Map()
  const children = new Map()
  for (const policy of task) {
    familyCounts.set(policy.familyId, (familyCounts.get(policy.familyId) ?? 0) + 1)
    if (policy.parentId === null) continue
    const parent = byId.get(policy.parentId)
    if (parent === undefined || parent.familyId !== policy.familyId
      || parent.familyGeneration + 1 !== policy.familyGeneration) return false
    children.set(parent.id, (children.get(parent.id) ?? 0) + 1)
  }
  return [...familyCounts.values()].every(count => count <= 3)
    && [...children.values()].every(count => count <= 2)
}
const adaptiveStateValid = state => isPlainObject(state)
  && Object.keys(state).every(key => ['generation', 'policies', 'probes', 'decisions'].includes(key))
  && Number.isSafeInteger(state.generation) && state.generation >= 0
  && Array.isArray(state.policies) && state.policies.length <= ADAPTIVE_RECALL_POLICY_LIMIT
  && state.policies.every(adaptivePolicyValid)
  && new Set(state.policies.map(row => row.id)).size === state.policies.length
  && adaptiveFamiliesValid(state.policies)
  && Array.isArray(state.probes) && state.probes.length <= ADAPTIVE_RECALL_PROBE_LIMIT
  && state.probes.every(adaptiveProbeValid)
  && new Set(state.probes.map(row => row.turnKey)).size === state.probes.length
  && Array.isArray(state.decisions) && state.decisions.length <= ADAPTIVE_RECALL_DECISION_LIMIT
  && state.decisions.every(adaptiveDecisionValid)
  && Buffer.byteLength(JSON.stringify(state), 'utf8') <= 512_000
const defaultAdaptiveRecall = () => ({ generation: 0, policies: [], probes: [], decisions: [] })
const recallStrategyValid = state => isPlainObject(state)
  && Object.keys(state).every(key => ['generation', 'rows', 'adaptive'].includes(key))
  && Number.isSafeInteger(state.generation) && state.generation >= 0
  && Array.isArray(state.rows) && state.rows.length <= RECALL_STRATEGY_LIMIT
  && state.rows.every(recallStrategyRowValid)
  && new Set(state.rows.map(row => `${row.turnKey}\u0000${row.scope}\u0000${row.qualification}`
    + `\u0000${row.id}\u0000${row.version}`)).size
    === state.rows.length
  && (state.adaptive === undefined || adaptiveStateValid(state.adaptive))
const defaultRecallStrategy = () => ({ generation: 0, rows: [], adaptive: defaultAdaptiveRecall() })

export function createDoc() {
  return { format: MEMORY_FORMAT, updatedAt: 0, entries: [], receipts: [], requests: [], turnFacts: [],
    materials: [], checkEvents: [], routes: [], corrections: [], methodHistory: [],
    recallStrategy: defaultRecallStrategy(),
    controls: { userPaused: false },
    digest: { lastDoneDay: null, backlog: [], lastRunAt: null, waitReason: null, days: [] },
    turnUsage: [], problemLoop: undefined }
}

export function validateDoc(doc) {
  if (!isPlainObject(doc) || !READABLE_FORMATS.includes(doc.format)) throw new LearningError('invalid_memory')
  if (!Array.isArray(doc.entries) || doc.entries.length > ENTRY_LIMIT || !doc.entries.every(entryValid)) {
    throw new LearningError('invalid_memory')
  }
  if (!Array.isArray(doc.receipts) || doc.receipts.length > RECEIPT_LIMIT || !doc.receipts.every(receiptValid)) {
    throw new LearningError('invalid_memory')
  }
  if (!Array.isArray(doc.turnFacts) || doc.turnFacts.length > FACT_LIMIT || !doc.turnFacts.every(factValid)) {
    throw new LearningError('invalid_memory')
  }
  if (!Array.isArray(doc.requests) || doc.requests.length > REQUEST_LIMIT || !doc.requests.every(requestValid)) {
    throw new LearningError('invalid_memory')
  }
  if (!Array.isArray(doc.materials) || doc.materials.length > 64 || !doc.materials.every(materialValid)) {
    throw new LearningError('invalid_memory')
  }
  if (!Array.isArray(doc.checkEvents) || doc.checkEvents.length > 128
    || !doc.checkEvents.every(checkEventValid)) throw new LearningError('invalid_memory')
  if (doc.recallStrategy === undefined) doc.recallStrategy = defaultRecallStrategy()
  if (doc.recallStrategy.adaptive === undefined) doc.recallStrategy.adaptive = defaultAdaptiveRecall()
  if (!recallStrategyValid(doc.recallStrategy)) throw new LearningError('invalid_memory')
  // EVOLUTION016: the archived method ledger. Absent in a format3 library (defaulted, never
  // written on a pure read); bounded by count, by unique (entryId,version) and by row bytes.
  if (doc.methodHistory === undefined) doc.methodHistory = []
  if (!Array.isArray(doc.methodHistory) || doc.methodHistory.length > METHOD_HISTORY_LIMIT
    || !doc.methodHistory.every(row => historyRowValid(row)
      && Buffer.byteLength(JSON.stringify(row), 'utf8') <= METHOD_HISTORY_ROW_BYTES)
    || new Set(doc.methodHistory.map(row => `${row.entryId}\u0000${row.version}`)).size
      !== doc.methodHistory.length) throw new LearningError('invalid_memory')
  if (!isPlainObject(doc.controls) || typeof doc.controls.userPaused !== 'boolean'
    || Object.keys(doc.controls).some(key => key !== 'userPaused')) throw new LearningError('invalid_memory')
  if (doc.corrections === undefined) doc.corrections = [] // additive default: old docs migrate, nothing lost
  if (!Array.isArray(doc.corrections) || doc.corrections.length > 64
    || !doc.corrections.every(correctionValid)) throw new LearningError('invalid_memory')
  if (!Array.isArray(doc.routes) || doc.routes.length > 16
    || !doc.routes.every(row => isPlainObject(row) && boundedLabel(row.sessionId, 512)
      && Number.isFinite(row.at) && isPlainObject(row.route)
      && Object.keys(row.route).every(key => ['provider', 'model', 'reasoningEffort'].includes(key))
      && boundedLabel(row.route.provider, 32) && boundedLabel(row.route.model, 64)
      && (row.route.reasoningEffort === undefined || boundedLabel(row.route.reasoningEffort, 16)))) {
    throw new LearningError('invalid_memory')
  }
  if (!isPlainObject(doc.digest) || (doc.digest.lastDoneDay !== null && !dayText(doc.digest.lastDoneDay))
    || !Array.isArray(doc.digest.backlog) || doc.digest.backlog.length > 30
    || !doc.digest.backlog.every(dayText)
    || (doc.digest.lastRunAt !== null && !Number.isFinite(doc.digest.lastRunAt))
    || !(doc.digest.waitReason === null || boundedLabel(doc.digest.waitReason, 128))
    || !Array.isArray(doc.digest.days) || doc.digest.days.length > 31
    || !doc.digest.days.every(row => isPlainObject(row) && dayText(row.day) && Number.isFinite(row.throughAt)
      && ['summarized', 'empty', 'partial'].includes(row.status) && safeBrief(row.summary)
      && Array.isArray(row.entryIds) && row.entryIds.length <= 4 && row.entryIds.every(entryHex)
      // MSE21-FIX1: the ledger holds EVERY identity the document can present (turnFacts 256 +
      // capsules 128×3 + entries 256 + checkEvents 128 = 1024), so nothing is dropped to fit.
      && (row.factKeys === undefined || (Array.isArray(row.factKeys) && row.factKeys.length <= 1024
        && row.factKeys.every(key => boundedLabel(key, 256))))
      && (row.unprovenKeys === undefined || (Array.isArray(row.unprovenKeys)
        && row.unprovenKeys.length <= 1024 && row.unprovenKeys.every(key => boundedLabel(key, 256))))
      && (row.excludedKeys === undefined || (Array.isArray(row.excludedKeys)
        && row.excludedKeys.length <= 1024 && row.excludedKeys.every(key => boundedLabel(key, 256))))
      && (row.rejectedActions === undefined || (Array.isArray(row.rejectedActions)
        && row.rejectedActions.length <= 8 && row.rejectedActions.every(code => boundedLabel(code, 40))))
      )) {
    throw new LearningError('invalid_memory')
  }
  if (!Array.isArray(doc.turnUsage) || doc.turnUsage.length > 128
    || !doc.turnUsage.every(row => isPlainObject(row) && hex64(row.turnKey) && Number.isFinite(row.at))) {
    throw new LearningError('invalid_memory')
  }
  if (doc.problemLoop !== undefined && !problemLoopValid(doc)) throw new LearningError('invalid_memory')
  const ids = new Set(doc.entries.map(entry => entry.id))
  if (ids.size !== doc.entries.length) throw new LearningError('invalid_memory')
}

export const memoryOf = doc => (doc.problemLoop === undefined ? ensureProblemLoop(doc) : doc.problemLoop)

const NO_COMMIT = Symbol('mse-rebuild.no-commit')
export const noCommit = value => ({ [NO_COMMIT]: value })

/**
 * EVOLUTION016 format3 → format4 migration, executed ONLY inside the first real write transaction
 * (a pure read never calls this). Old text/status/counters/gates are untouched. The one existing
 * `superseded` snapshot of a LESSON becomes a partial history row — no statistics, no evidence
 * hash and no lesson body are invented. User-rule snapshots never enter the method ledger.
 */
export function upgradeDocFormat(doc, now) {
  if (doc.format !== 3) return doc
  if (!Array.isArray(doc.methodHistory)) doc.methodHistory = []
  for (const entry of doc.entries) {
    if (entry.type !== 'lesson' || entry.superseded === null || entry.superseded === undefined) continue
    const version = entry.superseded.version
    if (!Number.isSafeInteger(version) || version < 1 || version >= entry.version) continue
    if (doc.methodHistory.some(row => row.entryId === entry.id && row.version === version)) continue
    if (doc.methodHistory.length >= METHOD_HISTORY_LIMIT) break
    const row = {
      entryId: entry.id, version,
      instruction: boundedCodepoints(String(entry.superseded.instruction ?? ''), 240, 480),
      applicability: boundedUnits(String(entry.applicability ?? ''), 160),
      exclusions: boundedUnits(String(entry.exclusions ?? ''), 160),
      visibility: entry.visibility, lesson: null,
      originScope: entry.originScope, originEnvironment: entry.originEnvironment,
      originSession: entry.originSession ?? null,
      ...(Array.isArray(entry.originSessions) && entry.originSessions.length > 0
        ? { originSessions: [...entry.originSessions] } : {}),
      stats: null, status: 'legacy_partial', reason: 'legacy_superseded_partial',
      archivedAt: Number.isFinite(now) ? now : Date.now(), evidenceHash: null,
    }
    if (row.instruction === '') continue // never fabricate a body that was not there
    doc.methodHistory.push(row)
  }
  doc.format = MEMORY_FORMAT
  return doc
}

export class MemoryStore {
  // One bounded document with a private directory, exclusive cross-process writer lease, and an
  // explicit post-rename durability status. The public constructor/signatures stay unchanged.
  constructor({ stateRoot }) {
    check(typeof stateRoot === 'string' && isAbsolute(stateRoot) && stateRoot.length > 0, 'invalid_state_root')
    this.stateRoot = stateRoot
    this.root = null
    this.path = join(stateRoot, 'memory-v1.json')
    this.lastCommitDurability = 'none'
    this.hasObservedStore = false
    this.onCommit = null
  }
  #recordCommit(durability) {
    this.lastCommitDurability = durability
    try { this.onCommit?.(durability) } catch { /* an observer must not change commit semantics */ }
  }
  #resolveRoot({ writable = false } = {}) {
    try {
      this.root = writable ? prepareMemoryDirectory(this.stateRoot) : resolveMemoryDirectory(this.stateRoot)
    } catch (error) {
      if (error?.storePresent === true) this.hasObservedStore = true
      throw error
    }
    this.path = join(this.root, 'memory-v1.json')
    return this.root
  }
  #readSnapshotAt(root, compareLogical = false) {
    let bytes
    try { bytes = readBoundedMemoryFileBytes(join(root, 'memory-v1.json')) }
    catch (error) {
      if (error.storePresent === true || error.code !== 'ENOENT') this.hasObservedStore = true
      if (error.code === 'ENOENT') {
        if (this.hasObservedStore) throw new LearningError('state_unavailable')
        return { doc: createDoc(), exists: false, bytes: null }
      }
      if (error instanceof LearningError) throw error
      throw new LearningError('state_unavailable')
    }
    this.hasObservedStore = true
    let doc
    let logicalBody
    try {
      doc = decodeMemoryDocument(bytes)
      if (compareLogical) logicalBody = JSON.stringify(doc)
      validateDoc(doc)
    }
    catch { throw new LearningError('invalid_memory') }
    return { doc, exists: true, bytes, logicalBody }
  }
  #readAt(root) { return this.#readSnapshotAt(root).doc }
  read() { return this.#readAt(this.#resolveRoot()) }
  /** One validated document plus its exact bounded source bytes; reads never create or migrate. */
  readSnapshot() {
    const snapshot = this.#readSnapshotAt(this.#resolveRoot())
    return { doc: snapshot.doc, exists: snapshot.exists,
      bytes: snapshot.bytes === null ? null : Buffer.from(snapshot.bytes) }
  }
  transaction(mutate) {
    const root = this.#resolveRoot({ writable: true })
    return withMemoryStoreLock(root, () => {
      const source = this.#readSnapshotAt(root, true)
      const doc = source.doc
      // EVOLUTION016: migrate format3 only inside the one locked commit; pure reads do not rewrite.
      if (doc.format === 3) upgradeDocFormat(doc, Date.now())
      const out = mutate(doc, { exists: source.exists,
        bytes: source.bytes === null ? null : Buffer.from(source.bytes) })
      if (out !== null && (typeof out === 'object' || typeof out === 'function')
        && typeof out.then === 'function') {
        Promise.resolve(out).catch(() => {})
        throw new LearningError('transaction_async')
      }
      if (out === ROLLBACK) return { ok: false, rolledBack: true }
      const requestedNoCommit = out !== null && typeof out === 'object'
        && Object.hasOwn(out, NO_COMMIT)
      const result = requestedNoCommit ? out[NO_COMMIT] : out
      validateDoc(doc)
      // An empty optional ledger is losslessly reconstructed on read. Do not charge an old,
      // nearly-full library for carrying no policies: even pausing must remain writable.
      const adaptive = doc.recallStrategy.adaptive
      if (adaptive?.generation === 0 && !adaptive.policies.length && !adaptive.probes.length
        && !adaptive.decisions.length) delete doc.recallStrategy.adaptive
      if (requestedNoCommit) {
        const unchangedBody = JSON.stringify(doc)
        if (source.bytes !== null && unchangedBody === source.logicalBody) return result
      }
      doc.updatedAt = Date.now()
      const body = encodeMemoryDocument(doc)
      try {
        commitMemoryFile(join(root, 'memory-v1.json'), body)
        this.hasObservedStore = true
        this.#recordCommit('confirmed')
      } catch (error) {
        if (error?.committed === true) {
          this.hasObservedStore = true
          this.#recordCommit('unconfirmed')
        } else this.lastCommitDurability = 'not_committed'
        throw error
      }
      return result
    })
  }
}
export const ROLLBACK = Symbol.for('mse-rebuild.rollback')

/** Deterministic entry id: the same imported/observed body never duplicates. */
export function entryIdFor(kind, originScope, body) {
  return `mem_${hash(JSON.stringify([kind, originScope, body])).slice(0, 24)}`
}

/**
 * Read-only, idempotent import from an old lessons-v1.json. The FILE IS NEVER WRITTEN; the digest
 * of the exact bytes read is recorded, and importing the same content again adds nothing.
 */
export function importOldLessons(doc, rawText, { batch, now }) {
  let old = null
  try { old = JSON.parse(rawText) } catch { return { ok: false, code: 'unreadable_source' } }
  if (!isPlainObject(old) || !Array.isArray(old.lessons)) return { ok: false, code: 'unreadable_source' }
  const sourceDigest = digestOf(rawText)
  if (doc.entries.some(entry => entry.importedFrom?.sourceDigest === sourceDigest
    && entry.importedFrom?.batch === batch)) return { ok: true, added: 0, skipped: 'already_imported' }
  let added = 0
  for (const lesson of old.lessons) {
    if (!isPlainObject(lesson) || lesson.status === 'suspended') continue
    if (typeof lesson.instruction !== 'string' || [...lesson.instruction].length < 8
      || Buffer.byteLength(lesson.instruction, 'utf8') > 480) continue
    const id = entryIdFor('import', lesson.scope ?? '', lesson.instruction)
    if (doc.entries.some(entry => entry.id === id)) continue
    // A generic user correction stays a GLOBAL user rule. An old UNVERIFIED method candidate
    // keeps its original scope/environment (recall only under matching conditions) and stays
    // history — it never gets promoted to a global digest entry on import.
    doc.entries.push({ id, type: lesson.kind === 'correction' ? 'rule' : 'digest',
      status: lesson.kind === 'correction' ? 'user_rule' : 'pending',
      instruction: [...lesson.instruction].slice(0, 240).join(''),
      applicability: typeof lesson.applicability === 'string' ? lesson.applicability.slice(0, 160) : '',
      exclusions: typeof lesson.exclusions === 'string' ? lesson.exclusions.slice(0, 160) : '',
      visibility: lesson.kind === 'correction' ? 'global' : 'scoped',
      originScope: hex64(lesson.scope) ? lesson.scope : hash(`import:${batch}`),
      originEnvironment: hex64(lesson.environment) ? lesson.environment : hash('default'),
      originSession: typeof lesson.sessionId === 'string' ? lesson.sessionId.slice(0, 512) : null,
      lesson: null, problemSignature: null, version: 1, parentVersion: null, superseded: null,
      injected: 0, recurrences: 0, createdAt: now, updatedAt: now, lastInjectedAt: null,
      evidenceHash: lesson.validation?.evidenceHash ?? null, factDigest: null, digestDay: null,
      importedFrom: { sourceDigest, batch } })
    added += 1
  }
  return { ok: true, added, sourceDigest }
}
