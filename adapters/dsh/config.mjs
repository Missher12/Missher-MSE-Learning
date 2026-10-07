/**
 * The MSE bundle's editable settings schema.
 *
 * This module is the *only* place in the package that imports a DSH package that is not
 * guaranteed to exist, and it is never imported statically by the portable SDK: `src/root.mjs`
 * resolves it at load time and tolerates nothing but its absence (see that file). A process
 * with no DSH packages must still be able to `import '@missher/dsh-mse-learning'` and use the
 * whole learning core.
 *
 * Why a schema at all, and why here:
 *
 *  - Cordis reads the validator off the plugin object it is handed (`runtime.Config`), so the
 *    schema has to travel with the plugin, not with a service it starts later.
 *  - The host Settings service only serves a namespace whose entry declares at least one
 *    `.volatile()` field, and it validates every write against this schema *before* persisting.
 *    That is what makes "type 4096 into the byte box" a refusal instead of a silently clamped
 *    value, and it is why the page never needs its own copy of the range rules.
 *  - Volatile means "live": the adapter reads `config.maxContextBytes.get()` on each use, so a
 *    saved change takes effect at the next recall without restarting the plugin, and without
 *    constructing a second engine (which would forget every spent session byte).
 *
 * The non-volatile fields are deliberate. `environmentId` is an operator fingerprint that
 * changing would orphan every previously validated method, and `now`/`settlement` are the
 * controlled-verification seams the test suite injects; none of them is user-editable, and
 * declaring them here keeps Cordis from dropping them during config resolution.
 */
import z from '@deepseek-ai/schemastery'

/** Defaults mirrored by the core's own constants; the page reads them through the form. */
export const SETTINGS_DEFAULTS = Object.freeze({
  enabled: true,
  reflectionEnabled: true,
  // Automatic validation is OPT-IN and off by default: it spends the evaluation budget without a
  // person pressing anything, so it must be a decision the operator makes, not a surprise.
  autoValidationEnabled: false,
  maxContextBytes: 768,
  evaluationTokensPerDay: 0,
  evaluationCallsPerDay: 2,
})

/** Byte bounds the core itself enforces; a value outside them can never be persisted. */
export const CONTEXT_BYTES_MIN = 128
export const CONTEXT_BYTES_MAX = 1536
export const EVALUATION_TOKENS_MAX = 1_000_000
export const EVALUATION_CALLS_MAX = 8

export const Config = z.object({
  /** 总开关：user intent only. Effective running also needs no legacy controller and a live plugin. */
  enabled: z.boolean().default(SETTINGS_DEFAULTS.enabled).volatile(),
  /** Automatic reflection for qualifying turns. Never gates direct corrections or recall. */
  reflectionEnabled: z.boolean().default(SETTINGS_DEFAULTS.reflectionEnabled).volatile(),
  /** Automatic review/validation of pending method candidates, inside the evaluation budget. */
  autoValidationEnabled: z.boolean().default(SETTINGS_DEFAULTS.autoValidationEnabled).volatile(),
  /**
   * The session a HISTORICAL (source-less) candidate is verified against. A backfilled item has no
   * original turn, so its route may not be borrowed from whatever session happened to run last:
   * the operator names the verification session explicitly, and only that session's route is used.
   * An empty value means "no backfill route", and those items stay blocked with a visible reason.
   */
  verificationSessionId: z.string().max(512).default('').volatile(),
  /** Per-turn injection ceiling in UTF-8 bytes; the per-session 1536 B ceiling is separate. */
  maxContextBytes: z.number().min(CONTEXT_BYTES_MIN).max(CONTEXT_BYTES_MAX).step(1)
    .default(SETTINGS_DEFAULTS.maxContextBytes).volatile(),
  /** Independent model-evaluation allowance. 0 keeps model-based verification disabled. */
  evaluationTokensPerDay: z.number().min(0).max(EVALUATION_TOKENS_MAX).step(1)
    .default(SETTINGS_DEFAULTS.evaluationTokensPerDay).volatile(),
  evaluationCallsPerDay: z.number().min(0).max(EVALUATION_CALLS_MAX).step(1)
    .default(SETTINGS_DEFAULTS.evaluationCallsPerDay).volatile(),
  /** Operator fingerprint; not editable, because changing it orphans validated methods. */
  environmentId: z.string(),
  /** Controlled-verification seams (injected clock / settlement options). Not user settings. */
  now: z.any(),
  settlement: z.any(),
})

/**
 * Read one volatile field defensively.
 *
 * `config.x.get()` is the documented read, but a field can also arrive as a plain value when a
 * composition has no Settings service at all (a bare `ctx.plugin` in a test, or an older
 * profile row). Both shapes are accepted, and anything else falls back to the default instead
 * of throwing inside a turn handler.
 */
export function readVolatile(config, key, fallback) {
  const field = config?.[key]
  if (field === undefined || field === null) return fallback
  if (typeof field === 'object' && typeof field.get === 'function') {
    const value = field.get()
    return value === undefined ? fallback : value
  }
  return field
}

export default Config
