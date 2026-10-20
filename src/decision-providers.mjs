import { isIP } from 'node:net'
import { parseDecision, normalizeDecisionUsage } from './decision.mjs'

const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_EVIDENCE_BYTES = 16 * 1024
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function safeModel(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null
}

function truncatedFacts(value) {
  if (!isObject(value)) return false
  for (const [key, item] of Object.entries(value)) {
    if (/truncat|collapsed|omitted/iu.test(key)
      && (item === true || (typeof item === 'number' && item > 0)
        || (Array.isArray(item) && item.length > 0))) return true
    if (isObject(item) && truncatedFacts(item)) return true
  }
  return false
}

function summarizeEvidence(evidence) {
  if (!isObject(evidence)) throw new TypeError('invalid_decision_evidence')
  const body = JSON.stringify(evidence)
  if (Buffer.byteLength(body, 'utf8') > MAX_EVIDENCE_BYTES) throw new TypeError('decision_input_too_large')
  return body
}

async function boundedJson(response) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('provider_response_too_large')
  let text
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('provider_response_too_large') }
        chunks.push(value)
      }
    } finally { reader.releaseLock?.() }
    const joined = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
    text = new TextDecoder().decode(joined)
  } else {
    text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('provider_response_too_large')
  }
  try { return JSON.parse(text) } catch { throw new Error('provider_invalid_json') }
}

function normalizedChoice(choice, confidence, meaning, reasons = [], riskCodes = [], probabilities) {
  const parsed = parseDecision({ action: choice, confidence, confidenceMeaning: meaning,
    reasons: Array.isArray(reasons) ? reasons.slice(0, 4).map(String) : [],
    riskCodes: Array.isArray(riskCodes) ? riskCodes.slice(0, 8).map(String) : [],
    ...(isObject(probabilities) ? { probabilities } : {}) })
  if (!parsed.ok) throw new Error(parsed.code)
  return parsed.value
}

function extractJev(payload, { flavor }) {
  if (!isObject(payload) || !isObject(payload.answers) || !isObject(payload.answers.action)) throw new Error('provider_invalid_shape')
  const answer = payload.answers.action
  const action = answer.choice
  if (!['prioritize_validation', 'suggest_merge', 'recheck', 'review', 'trial', 'wait', 'reject'].includes(action)) {
    throw new Error('provider_unknown_action')
  }
  const confidence = Number(answer.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('provider_missing_confidence')
  const probabilities = answer.probabilities
  if (!isObject(probabilities)) throw new Error('provider_invalid_shape')
  const meaning = flavor === 'laya'
    ? 'laya_normalized_entropy_confidence; raw probabilities retained in provider metadata'
    : 'jev_probability_distribution_confidence; raw probabilities retained in provider metadata'
  const result = normalizedChoice(action, confidence, meaning, [], [], probabilities)
  return { result, model: safeModel(payload.model), confidenceRaw: confidence,
    confidenceSemantics: meaning, probabilities: isObject(probabilities) ? probabilities : null,
    abstention: (typeof answer.abstention === 'string' && answer.abstention !== 'passed')
      || answer.abstention === true
      || answer.low_confidence === true || answer.action === 'abstain' || answer.action === 'abstained',
    complete: !truncatedFacts(payload.usage) && !truncatedFacts(answer) && payload.truncated !== true,
    usage: normalizeDecisionUsage({ inputTokens: payload.usage?.input_tokens, outputTokens: payload.usage?.output_tokens }) }
}

function extractOpenAi(payload) {
  if (payload?.choices?.[0]?.message?.refusal) throw new Error('provider_refused')
  if (payload?.choices?.[0]?.finish_reason !== 'stop') throw new Error('provider_incomplete')
  const text = payload?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || text.trim() === '') throw new Error('provider_empty_response')
  const parsed = parseDecision(text)
  if (!parsed.ok) throw new Error(parsed.code)
  const result = { ...parsed.value, confidenceMeaning: 'openai_model_self_reported_uncalibrated_advisory' }
  return { result, model: safeModel(payload.model), confidenceRaw: parsed.value.confidence,
    confidenceSemantics: result.confidenceMeaning,
    usage: normalizeDecisionUsage({ inputTokens: payload.usage?.prompt_tokens, outputTokens: payload.usage?.completion_tokens }) }
}

/** Shared HTTP endpoint policy for provider dispatch and the DSH preflight gate. */
export function decisionEndpointError(backend, endpoint) {
  if (typeof endpoint !== 'string') return 'invalid_endpoint'
  let url
  try { url = new URL(endpoint) } catch { return 'invalid_endpoint' }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    return 'invalid_endpoint'
  }
  if (url.protocol === 'https:') return null
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null
  if (backend !== 'laya') return 'insecure_endpoint'

  // A private DNS name can rebind between validation and fetch. Permit only a canonical,
  // explicitly written IPv4 literal, and only within RFC1918 ranges.
  const authority = /^https?:\/\/([^/?#]*)/iu.exec(endpoint)?.[1]
  const literal = /^((?:[0-9]{1,3}\.){3}[0-9]{1,3})(?::[0-9]{1,5})?$/u.exec(authority ?? '')?.[1]
  if (!literal || literal !== url.hostname || isIP(literal) !== 4) return 'insecure_endpoint'
  const [first, second] = literal.split('.').map(Number)
  const privateAddress = first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
  return privateAddress ? null : 'insecure_endpoint'
}

/** One bounded request with caller-controlled cancellation. No SDK retries or hidden replay. */
export async function requestDecision({ backend, endpoint, model, evidence, signal, timeoutMs = 30_000,
  fetchImpl = globalThis.fetch, resolveSecret, secretRef, hostCall, outputTokens = 512,
  isAllowed = () => true, onDispatch = () => ({ ok: true }) }) {
  if (signal?.aborted) throw new Error('cancelled')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new TypeError('invalid_timeout')
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 1 || outputTokens > 4096) {
    throw new TypeError('invalid_decision_budget')
  }
  const state = summarizeEvidence(evidence)
  if (backend === 'host') {
    if (typeof hostCall !== 'function') throw new Error('provider_unavailable')
    let hostAllowed = false
    try { hostAllowed = isAllowed() !== false } catch { hostAllowed = false }
    if (!hostAllowed || signal?.aborted) throw new Error('cancelled')
    const dispatched = onDispatch()
    if (dispatched?.ok !== true) throw new Error(dispatched?.code ?? 'decision_dispatch_refused')
    let response
    try { response = await hostCall({ model, state, signal, outputTokens }) }
    catch (error) {
      return { ok: false, code: signal?.aborted ? 'cancelled' : 'provider_failed', model: safeModel(model),
        usage: Number.isSafeInteger(error?.tokens) && error.tokens >= 0 ? { totalTokens: error.tokens } : null }
    }
    const usage = normalizeDecisionUsage(response?.usage)
    const actualModel = safeModel(response?.model ?? model)
    if (response?.complete === false) return { ok: false, code: 'provider_incomplete',
      model: actualModel, usage, complete: false }
    const parsed = parseDecision(response?.result ?? response)
    if (!parsed.ok) return { ok: false, code: parsed.code, model: actualModel, usage, complete: true }
    if (!actualModel) return { ok: false, code: 'provider_model_unreported', model: null,
      usage, complete: true }
    const result = { ...parsed.value, confidenceMeaning: 'host_model_self_reported_uncalibrated_advisory' }
    return { result, model: actualModel,
      confidenceRaw: parsed.value.confidence, confidenceSemantics: result.confidenceMeaning,
      complete: true, abstention: response?.abstention === true, usage }
  }
  if (!['openai_compatible', 'jev', 'laya'].includes(backend)) throw new TypeError('unsupported_decision_backend')
  if (typeof fetchImpl !== 'function' || (secretRef && typeof resolveSecret !== 'function')) throw new Error('provider_unavailable')
  const endpointError = decisionEndpointError(backend, endpoint)
  if (endpointError) throw new TypeError(endpointError)
  const url = new URL(endpoint)
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, timeoutMs)
  try {
    const active = () => {
      let allowed = false
      try { allowed = isAllowed() !== false } catch { allowed = false }
      return !signal?.aborted && !controller.signal.aborted && allowed
    }
    if (!active()) throw new Error('cancelled')
    let secret = null
    if (secretRef) {
      let resolved
      try {
        const aborted = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve(Symbol.for('mse-aborted')),
          { once: true }))
        resolved = await Promise.race([Promise.resolve().then(() => resolveSecret(secretRef)), aborted])
      } catch { throw new Error('provider_secret_unavailable') }
      if (resolved === Symbol.for('mse-aborted') || !active()) throw new Error('cancelled')
      secret = resolved
    }
    if (!active()) throw new Error('cancelled')
    if (secretRef && (typeof secret !== 'string' || secret.length === 0 || secret.length > 4096)) {
      throw new Error('provider_secret_unavailable')
    }
    const headers = { 'content-type': 'application/json', accept: 'application/json' }
    if (secret) headers.authorization = `Bearer ${secret}`
    let requestUrl = url.toString()
    let body
    if (backend === 'jev' || backend === 'laya') {
      requestUrl = requestUrl.replace(/\/$/u, '')
      if (!requestUrl.endsWith('/v1/systemone')) requestUrl += '/v1/systemone'
      body = { state: JSON.parse(state), model, questions: { action: { type: 'choice',
        instructions: 'Classify the candidate disposition from the supplied evidence. This is advisory only. Choose exactly one action.',
        criteria: { prioritize_validation: 'Prioritize this candidate for existing trusted objective validation; does not assert success.',
          suggest_merge: 'Suggest generating a new candidate only with a mergeTarget copied exactly from state.mergeCandidates. If there is no unique safe target, choose wait.',
          recheck: 'Recheck because evidence or the candidate appears changed or conflicting.',
          review: 'Evidence merits trusted objective review; does not assert success.',
          trial: 'Evidence merits a bounded unverified trial; does not authorize promotion.',
          wait: 'Evidence is insufficient, conflicting, stale, or uncertain.',
          reject: 'Evidence contradicts the proposed candidate.' } } } }
    } else {
      body = { model, temperature: 0, max_tokens: 512, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: 'Return only JSON with action, confidence, confidenceMeaning, reasons, riskCodes, evidenceRefs, and optional mergeTarget {id,version}. If action is suggest_merge, mergeTarget must copy exactly one id/version from supplied mergeCandidates; if none is unambiguous choose wait. Advisory only. Never claim validation or promotion. Actions: prioritize_validation, suggest_merge, recheck, review, trial, wait, reject.' },
          { role: 'user', content: state }] }
    }
    if (!active()) throw new Error('cancelled')
    const dispatched = onDispatch()
    if (dispatched?.ok !== true) throw new Error(dispatched?.code ?? 'decision_dispatch_refused')
    const response = await fetchImpl(requestUrl, { method: 'POST', headers, body: JSON.stringify(body),
      signal: controller.signal, redirect: 'error' })
    const payload = await boundedJson(response)
    if (!response.ok) {
      const usageRaw = payload?.usage
      const usage = backend === 'openai_compatible'
        ? normalizeDecisionUsage({ inputTokens: usageRaw?.prompt_tokens, outputTokens: usageRaw?.completion_tokens })
        : normalizeDecisionUsage({ inputTokens: usageRaw?.input_tokens, outputTokens: usageRaw?.output_tokens })
      return { ok: false, code: 'provider_http_error', model: safeModel(payload?.model), usage }
    }
    try {
      const result = backend === 'openai_compatible' ? extractOpenAi(payload) : extractJev(payload, { flavor: backend })
      if (!result.model) return { ok: false, code: 'provider_model_unreported', model: null, usage: result.usage }
      return result
    } catch (error) {
      const usageRaw = payload?.usage
      const usage = backend === 'openai_compatible'
        ? normalizeDecisionUsage({ inputTokens: usageRaw?.prompt_tokens, outputTokens: usageRaw?.completion_tokens })
        : normalizeDecisionUsage({ inputTokens: usageRaw?.input_tokens, outputTokens: usageRaw?.output_tokens })
      return { ok: false, code: ['provider_refused', 'provider_incomplete', 'provider_empty_response',
        'provider_invalid_shape', 'provider_unknown_action', 'provider_missing_confidence',
        'decision_invalid_json', 'decision_invalid_shape'].includes(error?.message) ? error.message : 'provider_invalid_response',
        model: safeModel(payload?.model), usage }
    }
  } catch (error) {
    if (signal?.aborted) throw new Error('cancelled')
    if (controller.signal.aborted) throw new Error('provider_timeout')
    if (['cancelled', 'provider_timeout', 'provider_response_too_large', 'provider_invalid_json',
      'provider_unavailable', 'provider_secret_unavailable', 'insecure_endpoint', 'invalid_endpoint'].includes(error?.message)) throw error
    if (error?.message === 'provider_http_error') throw error
    throw new Error('provider_failed')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
