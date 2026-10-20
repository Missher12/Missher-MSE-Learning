import { createHash } from 'node:crypto'

const ACTIONS = new Set(['prioritize_validation', 'suggest_merge', 'recheck', 'review', 'trial', 'wait', 'reject'])
const BACKENDS = new Set(['host', 'openai_compatible', 'jev', 'laya'])
const MAX_INPUT_BYTES = 24 * 1024

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max

/** Canonical evidence identity for a decision. Caller supplied hashes are never trusted. */
export function decisionIdentity(input = {}) {
  if (!isObject(input) || !bounded(input.candidateId, 64) || !Number.isSafeInteger(input.version) || input.version < 1
    || !Number.isSafeInteger(input.evidenceRevision) || input.evidenceRevision < 0
    || !bounded(input.ruleVersion, 64) || !BACKENDS.has(input.backend)
    || !bounded(input.model, 128) || !bounded(input.provider, 128) || !bounded(input.role, 32)
    || !bounded(input.apiMode ?? 'default', 32) || (input.projectHash !== undefined && !/^[a-f0-9]{64}$/u.test(input.projectHash))) {
    throw new TypeError('invalid_decision_identity')
  }
  const endpointFingerprint = input.endpoint === undefined || input.endpoint === ''
    ? 'none' : digest(String(input.endpoint))
  if (input.endpoint !== undefined && input.endpoint !== '') {
    let endpoint
    try { endpoint = new URL(input.endpoint) } catch { throw new TypeError('invalid_decision_route') }
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash) throw new TypeError('invalid_decision_route')
  }
  const evidence = input.evidence
  if (!isObject(evidence)) throw new TypeError('invalid_decision_evidence')
  const mergeCandidates = evidence.mergeCandidates === undefined ? [] : evidence.mergeCandidates
  if (!Array.isArray(mergeCandidates) || mergeCandidates.length > 4
    || !mergeCandidates.every(row => isObject(row) && /^lesson_[a-f0-9]{24}$/u.test(row.id)
      && Number.isSafeInteger(row.version) && row.version > 0)) throw new TypeError('invalid_decision_merge_candidates')
  const supportedEvidenceRefs = evidence.refs === undefined ? [] : evidence.refs
  if (!Array.isArray(supportedEvidenceRefs) || supportedEvidenceRefs.length > 8
    || !supportedEvidenceRefs.every(ref => /^[a-f0-9]{64}$/u.test(ref))) throw new TypeError('invalid_decision_evidence_refs')
  const serialized = JSON.stringify(evidence)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_INPUT_BYTES) throw new TypeError('decision_input_too_large')
  const inputDigest = digest(serialized)
  const reasoningEffort = bounded(input.reasoningEffort, 32) ? input.reasoningEffort : 'unspecified'
  let fallbackRoute = null
  if (input.fallbackRoute !== undefined && input.fallbackRoute !== null) {
    const route = input.fallbackRoute
    if (!isObject(route) || !bounded(route.provider, 128) || !bounded(route.model, 128)
      || !bounded(route.apiMode ?? 'default', 32)
      || (route.reasoningEffort !== undefined && !bounded(route.reasoningEffort, 32))) {
      throw new TypeError('invalid_decision_fallback_route')
    }
    fallbackRoute = { provider: route.provider, model: route.model, apiMode: route.apiMode ?? 'default',
      reasoningEffort: route.reasoningEffort ?? 'unspecified' }
  }
  const key = digest(JSON.stringify([input.candidateId, input.version, input.evidenceRevision,
    input.projectHash ?? 'none', inputDigest, input.ruleVersion, input.role, input.backend, input.provider,
    input.model, endpointFingerprint, input.apiMode ?? 'default', reasoningEffort, fallbackRoute]))
  return { key, inputDigest, candidateId: input.candidateId, version: input.version,
    evidenceRevision: input.evidenceRevision, ruleVersion: input.ruleVersion, role: input.role,
    projectHash: input.projectHash ?? null, backend: input.backend, provider: input.provider, model: input.model,
    endpointFingerprint, apiMode: input.apiMode ?? 'default', reasoningEffort, fallbackRoute,
    supportedEvidenceRefs: [...new Set(supportedEvidenceRefs)],
    mergeCandidates: mergeCandidates.map(row => ({ id: row.id, version: row.version })) }
}

/** Strictly parse the decision envelope. It can route work but cannot attest to objective success. */
export function parseDecision(value) {
  let row = value
  if (typeof row === 'string') {
    if (Buffer.byteLength(row, 'utf8') > 4096) return { ok: false, code: 'decision_response_too_large' }
    try { row = JSON.parse(row) } catch { return { ok: false, code: 'decision_invalid_json' } }
  }
  if (!isObject(row) || Object.keys(row).some(key => !['action', 'confidence', 'confidenceMeaning', 'reasons', 'riskCodes', 'probabilities', 'evidenceRefs', 'mergeTarget'].includes(key))
    || !ACTIONS.has(row.action) || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1
    || !bounded(row.confidenceMeaning, 160) || !Array.isArray(row.reasons) || row.reasons.length > 4
    || !row.reasons.every(reason => bounded(reason, 160)) || !Array.isArray(row.riskCodes) || row.riskCodes.length > 8
    || !row.riskCodes.every(code => bounded(code, 48))
    || (row.evidenceRefs !== undefined && (!Array.isArray(row.evidenceRefs) || row.evidenceRefs.length > 8
      || !row.evidenceRefs.every(ref => /^[a-f0-9]{64}$/u.test(ref))))
    || (row.mergeTarget !== undefined && (row.action !== 'suggest_merge' || !isObject(row.mergeTarget)
      || Object.keys(row.mergeTarget).some(key => !['id', 'version'].includes(key))
      || !/^lesson_[a-f0-9]{24}$/u.test(row.mergeTarget.id)
      || !Number.isSafeInteger(row.mergeTarget.version) || row.mergeTarget.version < 1))) {
    return { ok: false, code: 'decision_invalid_shape' }
  }
  let probabilities
  if (row.probabilities !== undefined) {
    if (!isObject(row.probabilities) || Object.keys(row.probabilities).length < 2
      || Object.keys(row.probabilities).length > 16 || Object.entries(row.probabilities)
        .some(([key, score]) => !bounded(key, 48) || !Number.isFinite(score) || score < 0 || score > 1)) {
      return { ok: false, code: 'decision_invalid_probabilities' }
    }
    probabilities = { ...row.probabilities }
  }
  return { ok: true, value: { action: row.action, confidence: row.confidence,
    confidenceMeaning: row.confidenceMeaning, reasons: [...row.reasons], riskCodes: [...new Set(row.riskCodes)],
    ...(probabilities === undefined ? {} : { probabilities }),
    ...(row.evidenceRefs === undefined ? {} : { evidenceRefs: [...new Set(row.evidenceRefs)] }),
    ...(row.mergeTarget === undefined ? {} : { mergeTarget: { id: row.mergeTarget.id, version: row.mergeTarget.version } }) } }
}

/** Normalize provider usage without retaining provider payloads, prompts, or candidate text. */
export function normalizeDecisionUsage(value) {
  if (!isObject(value)) return null
  if (Number.isSafeInteger(value.inputTokens) && value.inputTokens >= 0
    && Number.isSafeInteger(value.outputTokens) && value.outputTokens >= 0
    && Number.isSafeInteger(value.inputTokens + value.outputTokens)) {
    return { inputTokens: value.inputTokens, outputTokens: value.outputTokens,
      totalTokens: value.inputTokens + value.outputTokens }
  }
  const missingBreakdown = (value.inputTokens === undefined && value.outputTokens === undefined)
    || (value.inputTokens === null && value.outputTokens === null)
  if (missingBreakdown
    && Number.isSafeInteger(value.totalTokens) && value.totalTokens >= 0) {
    return { inputTokens: null, outputTokens: null, totalTokens: value.totalTokens }
  }
  return null
}

export const DECISION_BACKENDS = Object.freeze([...BACKENDS])
export const DECISION_ACTIONS = Object.freeze([...ACTIONS])
