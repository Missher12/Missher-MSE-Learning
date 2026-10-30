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
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { LearningError, MAX_STORE_BYTES, check } from '../src/store.mjs'
import { problemLoopValid, ensureProblemLoop } from '../src/problems.mjs'

export const MEMORY_FORMAT = 3
export const ENTRY_STATUSES = ['user_rule', 'pending', 'check_passed', 'needs_revision', 'retired']
export const TURN_OUTCOMES = ['failed', 'cancelled', 'unknown', 'verified']
export const ENTRY_LIMIT = 256
export const RECEIPT_LIMIT = 256
export const REQUEST_LIMIT = 96
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

const entryValid = entry => isPlainObject(entry)
  && Object.keys(entry).every(key => ['id', 'type', 'status', 'instruction', 'applicability', 'exclusions',
    'visibility', 'originScope', 'originEnvironment', 'originSession', 'lesson', 'problemSignature',
    'version', 'parentVersion', 'superseded', 'injected', 'recurrences', 'createdAt', 'updatedAt',
    'lastInjectedAt', 'evidenceHash', 'factDigest', 'digestDay', 'importedFrom',
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
  && (entry.factDigest === undefined || entry.factDigest === null || hex64(entry.factDigest))
  && (entry.digestDay === undefined || entry.digestDay === null || dayText(entry.digestDay))
  && (entry.importedFrom === null || (isPlainObject(entry.importedFrom) && hex64(entry.importedFrom.sourceDigest)
    && boundedLabel(entry.importedFrom.batch, 64)))
  && (entry.sourceDigest === undefined || entry.sourceDigest === null || hex64(entry.sourceDigest))

const receiptValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['id', 'turnKey', 'at', 'bytes', 'offered', 'settled', 'outcome',
    'evidenceHash', 'source'].includes(key))
  && hex64(row.id) && hex64(row.turnKey) && Number.isFinite(row.at)
  && Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= 1536
  && Array.isArray(row.offered) && row.offered.length <= 4
  && row.offered.every(x => entryHex(x.id) && Number.isSafeInteger(x.version))
  && typeof row.settled === 'boolean'
  && (row.outcome === null || TURN_OUTCOMES.includes(row.outcome))
  && (row.evidenceHash === null || hex64(row.evidenceHash))
  && (row.source === null || (isPlainObject(row.source) && hex64(row.source.routeId)))

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

const correctionValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['id', 'sessionId', 'turnId', 'at', 'day', 'userText', 'assistantBrief',
    'cwd', 'contentDigest', 'status', 'reason', 'ticket', 'entryIds', 'revision'].includes(key))
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

const requestValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['ticket', 'kind', 'at', 'problemId', 'entryId', 'digestDay', 'requestHash',
    'dispatchHash', 'dispatchedAt', 'settled', 'terminal', 'usage', 'maxTokens', 'evidenceIds', 'tokenHashes',
    'parentVersion', 'routeId', 'material', 'retryOf', 'digestFacts', 'digestThrough', 'sourceSessionId',
    'sourceRoute', 'outputBytes', 'finishKind', 'digestKeys', 'digestExcluded', 'digestAdmission',
    'verdictCode', 'verdictFields'].includes(key))
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

const materialValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['key', 'terminal', 'attempts', 'autoRetriesUsed', 'unknownCost',
    'updatedAt', 'manualAllowed', 'autoRetryAllowed', 'ticket'].includes(key))
  && (row.ticket === null || boundedLabel(row.ticket, 64))
  && typeof row.autoRetryAllowed === 'boolean'
  && hex64(row.key) && (row.terminal === null || boundedLabel(row.terminal, 64))
  && Number.isSafeInteger(row.attempts) && row.attempts >= 0
  && Number.isSafeInteger(row.autoRetriesUsed) && row.autoRetriesUsed >= 0 && row.autoRetriesUsed <= 1
  && typeof row.unknownCost === 'boolean' && Number.isFinite(row.updatedAt)

const checkEventValid = row => isPlainObject(row)
  && Object.keys(row).every(key => ['id', 'at', 'checkId', 'turnKey', 'entryId', 'entryVersion', 'passed'].includes(key))
  && hex64(row.id) && Number.isFinite(row.at) && boundedLabel(row.checkId, 128) && hex64(row.turnKey)
  && entryHex(row.entryId) && Number.isSafeInteger(row.entryVersion) && typeof row.passed === 'boolean'

export function createDoc() {
  return { format: MEMORY_FORMAT, updatedAt: 0, entries: [], receipts: [], requests: [], turnFacts: [],
    materials: [], checkEvents: [], routes: [], corrections: [],
    controls: { userPaused: false },
    digest: { lastDoneDay: null, backlog: [], lastRunAt: null, waitReason: null, days: [] },
    turnUsage: [], problemLoop: undefined }
}

export function validateDoc(doc) {
  if (!isPlainObject(doc) || doc.format !== MEMORY_FORMAT) throw new LearningError('invalid_memory')
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

export class MemoryStore {
  // Own tiny atomic store: temp+rename durability, one writer (the plugin process). A mutation is
  // committed ONLY when it completes without throwing and does not return the explicit rollback
  // sentinel — a failed begin* branch can never leave a half-signed request on disk.
  constructor({ stateRoot }) {
    check(typeof stateRoot === 'string' && isAbsolute(stateRoot) && stateRoot.length > 0, 'invalid_state_root')
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
    this.path = join(stateRoot, 'memory-v1.json')
  }
  read() {
    let text
    try { text = readFileSync(this.path, 'utf8') }
    catch (error) {
      if (error.code === 'ENOENT') return createDoc()
      throw new LearningError('state_unavailable')
    }
    let doc
    try { doc = JSON.parse(text) } catch { throw new LearningError('invalid_memory') }
    validateDoc(doc)
    return doc
  }
  transaction(mutate) {
    const doc = this.read()
    const out = mutate(doc)
    if (out === ROLLBACK) return { ok: false, rolledBack: true }
    validateDoc(doc)
    doc.updatedAt = Date.now()
    const body = JSON.stringify(doc)
    check(Buffer.byteLength(body) <= MAX_STORE_BYTES, 'capacity')
    const temporary = `${this.path}.${process.pid}.tmp`
    try {
      writeFileSync(temporary, body)
      renameSync(temporary, this.path)
    } finally {
      try { unlinkSync(temporary) } catch { /* renamed away */ }
    }
    return out
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
