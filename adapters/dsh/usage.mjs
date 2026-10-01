/**
 * Real token accounting for one model call.
 *
 * This module is deliberately free of Host imports: it is the one piece of the control plane
 * whose whole job is to decide what a call cost, and it must stay unit-testable without a DSH
 * installation.
 */
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Real total token usage, or `null` — never `0`.
 *
 * The provider total is the only figure that can be trusted outright. When it is missing the
 * protocol's `inputTokens` covers *uncached* input only, so `input + output` silently omits
 * every cache read and write; that sum is therefore reported only when both cache counters are
 * present. A missing field is "unknown", not zero, and a cost the host cannot measure must not
 * be recorded as a free one.
 *
 * @param usage - the `usage` payload of one `usage` stream chunk.
 * @returns the measured total, or `null` when it cannot be established.
 */
export function usageTokens(usage) {
  if (!isPlainObject(usage)) return null
  if (Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= 0) return usage.totalTokens
  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
  if (!fields.every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0)) return null
  return fields.reduce((sum, key) => sum + usage[key], 0)
}

export default usageTokens
