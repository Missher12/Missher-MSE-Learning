/**
 * The model path: the released bundle's real contract, kept to its reflection-relevant core.
 *
 * Same rules as adapters/dsh/control.mjs#readModel, and the SAME token accounting as
 * adapters/dsh/usage.mjs (imported, not re-typed): the provider total is trusted outright; a
 * partial field set is UNKNOWN, never summed from a subset and never treated as zero. Only a
 * clean `stop` counts as complete — `length`/`max-tokens` is TRUNCATION (returned, not success);
 * over-limit output ABORTS the physical stream and drains before releasing, so `running` never
 * frees while a request is still live. `createUserMessage` is the host's own message factory.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { usageTokens } from '../adapters/dsh/usage.mjs'

export const MSE_PRODUCER_KIND = 'plugin:mse-learning'
export const mseMessageSource = form => ({ kind: MSE_PRODUCER_KIND, ...(form === undefined ? {} : { form }) })
export const isMseSource = source => source !== null && typeof source === 'object'
  && (source.kind === MSE_PRODUCER_KIND
    || (source.kind === 'plugin' && source.plugin === 'mse-learning'))

export { usageTokens }

/** Attach only REAL observed output facts to a failure, within the strict audit bounds. */
function attachOutput(error, output, finishKind) {
  const bytes = Buffer.byteLength(output)
  if (bytes <= 65_536) error.outputBytes = bytes
  if (typeof finishKind === 'string' && /^[a-z][a-z_-]{0,23}$/u.test(finishKind)) error.finishKind = finishKind
  return error
}

function modelFailure(code, usage) {
  const error = Object.assign(new Error(code), { code })
  // Carry the REAL measured fields with the failure — never masquerade a total as output.
  if (usage !== null && usage !== undefined) error.usage = usage
  error.tokens = usageTokens(usage)
  return error
}

function toUsage(usage) {
  if (usage === null || usage === undefined) return null
  const field = key => Number.isSafeInteger(usage[key]) && usage[key] >= 0 ? usage[key] : null
  const total = usageTokens(usage)
  const out = { input: field('inputTokens'), output: field('outputTokens'),
    cached: field('cacheReadTokens'), cacheWrite: field('cacheWriteTokens'),
    reasoning: field('reasoningTokens'), total }
  const any = Object.values(out).some(value => value !== null)
  // PARTIAL fields stay recorded, but the accounting is only KNOWN when the TOTAL is trustworthy —
  // a lone output field cannot unlock an automatic retry (that would spend money we cannot price).
  return any ? { ...out, known: total !== null } : null
}

/** One bounded single-shot call over the host's `llm` service. */
export async function readModel(ctx, { route, system, prompt, maxTokens, signal,
  pluginForm = 'instructions', outputLimitBytes = 65_536 }) {
  const controller = new AbortController()
  const forward = () => controller.abort()
  signal?.addEventListener?.('abort', forward, { once: true })
  const externalAborted = () => signal?.aborted === true
  const options = { provider: route.provider, model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    messages: [createUserMessage({ content: [{ type: 'text', text: prompt }],
      source: mseMessageSource(pluginForm) })],
    system, maxTokens, signal: controller.signal }
  let output = ''
  let usage = null
  let finished = false
  let truncated = false
  let overLimit = false
  let finishKind = null // the REAL terminal kind observed on the stream (never guessed)
  // Own the iterator explicitly: an over-limit answer ABORTS the physical request and then DRAINS
  // THE SAME stream until it really ends (bounded) — the slot is never freed over a live request.
  const stream = ctx.llm.stream(options)[Symbol.asyncIterator]()
  try {
    for (;;) {
      let step
      try { step = await stream.next() } catch (error) {
        if (error.usage === undefined && usage !== null && usage !== undefined) {
          error.usage = usage
          error.tokens = usageTokens(usage)
        }
        throw error
      }
      if (step.done === true) break
      const chunk = step.value
      if (chunk.type === 'text-delta') {
        output += chunk.text
        if (Buffer.byteLength(output) > outputLimitBytes) {
          overLimit = true
          controller.abort()
          break
        }
      } else if (chunk.type === 'usage') usage = chunk.usage ?? null
      else if (chunk.type === 'finish') {
        // rc.4 really emits `length` (adapters/harness.mjs maps max-tokens→length): it is a REAL
        // end whose answer is TRUNCATED — returned with truncated=true for the caller to close
        // known-cost, never thrown away as model_incomplete. Only `stop` is complete; an
        // unsupported terminal (tool-calls…) fails honestly and can NEVER pose as length.
        finishKind = typeof chunk.reason?.kind === 'string' ? chunk.reason.kind : null
        if (chunk.reason?.kind === 'max-tokens' || chunk.reason?.kind === 'length') {
          finished = true
          truncated = true
        } else if (chunk.reason?.kind === 'stop') finished = true
        else if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
          controller.abort()
          throw attachOutput(modelFailure('model_failed', usage), output, finishKind)
        } else {
          controller.abort()
          throw attachOutput(modelFailure('model_incomplete', usage), output, finishKind)
        }
      }
    }
    if (overLimit) {
      let drained = 0
      try {
        while (drained < 64) {
          const step = await stream.next()
          if (step.done === true) break
          if (step.value?.type === 'usage') usage = step.value.usage ?? usage
          drained += 1
        }
      } catch { /* an aborted stream ending with an error is the expected shape */ }
      // bytes over the cap are NOT reported (the bound is 0..65536; nothing is clamped/faked)
      throw attachOutput(modelFailure('output_too_large', usage), output, finishKind)
    }
  } finally {
    try { await stream.return?.() } catch { /* already closed */ }
    signal?.removeEventListener?.('abort', forward)
  }
  if (!finished || externalAborted()) {
    throw attachOutput(modelFailure(externalAborted() ? 'cancelled' : 'model_incomplete', usage), output, finishKind)
  }
  const measured = toUsage(usage)
  return { output, tokens: measured === null ? null : measured.total,
    tokensKnown: measured !== null && measured.total !== null, truncated, charged: maxTokens,
    usage: measured,
    // REAL observables for the request audit (MSE17): the finish kind the provider really
    // emitted, and the output bytes actually produced (within the strict 0..65536 bound).
    finishKind,
    outputBytes: Buffer.byteLength(output) <= 65_536 ? Buffer.byteLength(output) : null }
}
