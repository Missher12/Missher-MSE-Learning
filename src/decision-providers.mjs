import { isIP } from 'node:net'
import { createHash } from 'node:crypto'
import { parseDecision, normalizeDecisionUsage } from './decision.mjs'

const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_EVIDENCE_BYTES = 16 * 1024
const MAX_DISCOVERED_MODELS = 500
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

async function boundedJson(response, signal) {
  const checkCancelled = () => {
    if (signal?.aborted) throw new Error('cancelled')
  }
  checkCancelled()
  const contentLength = response.headers?.get?.('content-length')
  const declared = contentLength === null || contentLength === undefined ? Number.NaN : Number(contentLength)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('provider_response_too_large')
  let text
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        checkCancelled()
        if (done) break
        size += value.byteLength
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel()
          checkCancelled()
          throw new Error('provider_response_too_large')
        }
        chunks.push(value)
      }
    } finally { reader.releaseLock?.() }
    const joined = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
    text = new TextDecoder().decode(joined)
  } else if (response.body?.[Symbol.asyncIterator]) {
    const chunks = []
    let size = 0
    for await (const value of response.body) {
      checkCancelled()
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
      size += chunk.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new Error('provider_response_too_large')
      chunks.push(chunk)
    }
    const joined = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
    text = new TextDecoder().decode(joined)
  } else {
    throw new Error('provider_response_unbounded')
  }
  checkCancelled()
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

const trimPath = path => path.replace(/\/+$/u, '')
const joinPath = (base, suffix) => `${trimPath(base)}/${suffix}`

/**
 * Normalize the three supported address forms to one service identity and its concrete paths.
 * A reverse-proxy prefix is retained. An OpenAI-compatible bare service root gets the standard
 * `/v1` prefix; explicit full protocol paths remain explicit. Jev and Laya use SystemOne.
 */
export function decisionEndpointRoutes(backend, endpoint) {
  if (!['openai_compatible', 'jev', 'laya'].includes(backend)) throw new TypeError('unsupported_decision_backend')
  const error = decisionEndpointError(backend, endpoint)
  if (error) throw new TypeError(error)
  const url = new URL(endpoint)
  const originalPath = url.pathname
  const path = trimPath(originalPath)
  const hasTrailingSlash = url.pathname.length > 1 && url.pathname.endsWith('/')
  let apiRoot
  let requestPath
  let discoveryPath
  let identityPath

  if (backend === 'openai_compatible') {
    if (path.endsWith('/chat/completions')) {
      const candidateRoot = trimPath(path.slice(0, -'/chat/completions'.length))
      if (candidateRoot === '/v1' || candidateRoot.endsWith('/v1')) {
        apiRoot = candidateRoot
        requestPath = originalPath
        discoveryPath = joinPath(apiRoot, 'models')
        identityPath = apiRoot
      } else {
        // Only the standard `/v1/chat/completions` shape is recognized. Preserve any other
        // configured full endpoint exactly and do not infer where its model directory lives.
        apiRoot = null
        requestPath = originalPath
        discoveryPath = null
        identityPath = originalPath
      }
    } else if (path === '' || path.endsWith('/v1')) {
      apiRoot = path.endsWith('/v1') ? path : joinPath(path, 'v1')
      requestPath = joinPath(apiRoot, 'chat/completions')
      discoveryPath = joinPath(apiRoot, 'models')
      identityPath = apiRoot
    } else {
      // Earlier releases POSTed the configured path verbatim. An unknown path is therefore a
      // legacy full endpoint, not a prefix to which this version may silently add `/v1`.
      apiRoot = null
      requestPath = originalPath
      discoveryPath = null
      identityPath = originalPath
    }
  } else if (backend === 'jev') {
    if (path.endsWith('/v1/systemone')) apiRoot = trimPath(path.slice(0, -'/systemone'.length))
    else apiRoot = path.endsWith('/v1') ? path : joinPath(path, 'v1')
    requestPath = path.endsWith('/v1/systemone') ? path : joinPath(apiRoot, 'systemone')
    discoveryPath = joinPath(apiRoot, 'models')
    identityPath = apiRoot || '/v1'
  } else {
    let prefix
    if (path.endsWith('/v1/systemone')) prefix = trimPath(path.slice(0, -'/v1/systemone'.length))
    else if (path === '' || path.endsWith('/v1') || hasTrailingSlash) {
      prefix = path.endsWith('/v1') ? trimPath(path.slice(0, -'/v1'.length)) : path
    } else {
      // Jev and Laya historically treated the configured value as a base URL and appended
      // `/v1/systemone`; retain that behavior for older non-standard proxy prefixes.
      prefix = path
    }
    apiRoot = joinPath(prefix, 'v1')
    requestPath = path.endsWith('/v1/systemone') ? path : joinPath(apiRoot, 'systemone')
    discoveryPath = joinPath(prefix, 'health')
    identityPath = apiRoot || '/v1'
  }

  const build = pathname => {
    const target = new URL(url.origin)
    target.pathname = pathname || '/'
    return target
  }
  return Object.freeze({
    requestUrl: build(requestPath).toString(),
    discoveryUrl: discoveryPath === null ? null : build(discoveryPath).toString(),
    identity: `${backend}\n${url.origin}\n${identityPath}`,
  })
}

/** Route-scoped reference used only inside the Host credentials provider. */
export function decisionCredentialRef(backend, endpoint) {
  const route = decisionEndpointRoutes(backend, endpoint)
  const digest = createHash('sha256').update(route.identity).digest('hex')
  return `MSE_DECISION_KEY_${digest}`
}

function projectDiscoveredModels(items, getId) {
  if (!Array.isArray(items) || items.length > MAX_DISCOVERED_MODELS) {
    throw new Error('model_discovery_invalid_response')
  }
  const seen = new Set()
  const models = []
  for (const item of items) {
    const raw = getId(item)
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (id.length === 0 || id.length > 128 || /[\u0000-\u001f\u007f]/u.test(id) || seen.has(id)) continue
    seen.add(id)
    models.push({ id })
  }
  if (items.length > 0 && models.length === 0) throw new Error('model_discovery_invalid_response')
  return models
}

/** Read-only model-directory request. It never saves settings or makes an inference request. */
export async function discoverDecisionModels({ backend, endpoint, apiKey, signal, timeoutMs = 8_000,
  fetchImpl = globalThis.fetch }) {
  const route = decisionEndpointRoutes(backend, endpoint)
  if (route.discoveryUrl === null) throw new Error('model_discovery_not_supported')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new TypeError('invalid_timeout')
  }
  if (typeof fetchImpl !== 'function') throw new Error('model_discovery_unavailable')
  if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > 4096)) {
    throw new Error('provider_secret_unavailable')
  }
  if (signal?.aborted) throw new Error('cancelled')
  const target = new URL(route.discoveryUrl)
  const origin = new URL(endpoint).origin
  if (target.origin !== origin) throw new Error('invalid_endpoint')

  const controller = new AbortController()
  const abort = () => controller.abort()
  let timedOut = false
  const assertActive = () => {
    if (timedOut) throw new Error('model_discovery_timeout')
    if (signal?.aborted || controller.signal.aborted) throw new Error('cancelled')
  }
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  try {
    const headers = { accept: 'application/json' }
    if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`
    const response = await fetchImpl(target.toString(), { method: 'GET', headers,
      signal: controller.signal, redirect: 'error' })
    assertActive()
    if (response.status === 404) throw new Error('model_discovery_not_supported')
    if (response.status === 401 || response.status === 403) throw new Error('model_discovery_auth_required')
    if (!response.ok) throw new Error('model_discovery_http_error')
    const payload = await boundedJson(response, controller.signal)
    assertActive()
    if (backend === 'laya') {
      if (!isObject(payload) || payload.status !== 'ok') throw new Error('model_discovery_invalid_response')
      if (!Array.isArray(payload.loaded)) {
        return { ok: true, code: 'model_discovery_details_unavailable', models: [], autoAvailable: true }
      }
      const models = projectDiscoveredModels(payload.loaded, item => item)
      return { ok: true, code: models.length === 0 ? 'model_discovery_no_loaded_models' : null,
        models, autoAvailable: true }
    }
    const items = backend === 'jev' ? payload?.models : payload?.data ?? payload?.models
    const models = projectDiscoveredModels(items,
      item => backend === 'jev' ? item?.name : item?.id)
    return { ok: true, code: models.length === 0 ? 'model_discovery_empty' : null,
      models, autoAvailable: false }
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' && !timedOut) throw new Error('cancelled')
    if (timedOut) throw new Error('model_discovery_timeout')
    if (['model_discovery_not_supported', 'model_discovery_auth_required', 'model_discovery_http_error',
      'model_discovery_invalid_response', 'provider_response_too_large', 'provider_invalid_json',
      'provider_response_unbounded', 'provider_secret_unavailable', 'invalid_endpoint', 'insecure_endpoint'].includes(error?.message)) throw error
    throw new Error('model_discovery_failed')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    controller.abort()
  }
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
  const routes = decisionEndpointRoutes(backend, endpoint)
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
    let requestUrl = routes.requestUrl
    let body
    if (backend === 'jev' || backend === 'laya') {
      body = { state: JSON.parse(state), model: backend === 'laya' && model === 'auto' ? undefined : model,
        questions: { action: { type: 'choice',
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
    if (['cancelled', 'provider_timeout', 'provider_response_too_large', 'provider_response_unbounded', 'provider_invalid_json',
      'provider_unavailable', 'provider_secret_unavailable', 'insecure_endpoint', 'invalid_endpoint'].includes(error?.message)) throw error
    if (error?.message === 'provider_http_error') throw error
    throw new Error('provider_failed')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    controller.abort()
  }
}
