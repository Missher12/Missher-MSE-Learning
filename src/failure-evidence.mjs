/**
 * Bounded failure evidence: extraction from trusted host tool results, scrubbing BEFORE any
 * persistence or prompt use, deterministic UTF-8 bounds and validation.
 *
 * The problem ledger (src/problems.mjs) stores ONE optional capsule per observation under
 * `problem.capsules`. A capsule carries only what the host itself observed about the failure —
 * exit code, restricted failure class, a scrubbed command/parameter summary, and the first part of
 * the tool's own stderr/error message — after secrets, absolute paths, URLs, emails and
 * instruction-injection text have been replaced by safe placeholders. Technical value (error words,
 * file names with extensions, positions like `:12:3`, exit codes) is deliberately KEPT: an evidence
 * record that only says "non-zero exit" cannot ground a specific reflection.
 *
 * Bounds are part of the contract, not tuning:
 *  • one serialized capsule is at most CAPSULE_MAX_BYTES (2048 UTF-8 B);
 *  • each problem keeps at most the newest CAPSULES_PER_PROBLEM (3) distinct-event capsules;
 *  • the WHOLE ledger keeps at most CAPSULES_TOTAL_BYTES (128 KiB) of capsules. Crossing that line
 *    evicts the OLDEST capsules through `enforceCapsuleBudget` — an explicit bounded diagnostic
 *    window. Problem identities, cumulative counts, summaries and the ledger itself survive; the
 *    store is never silently cleared, and every eviction is counted in `capsuleDropped`.
 *
 * Identity rules:
 *  • a capsule id is deterministic from (host event id, tool, failure class, diagnostic signature),
 *    so re-delivering the same call adds no new capsule;
 *  • the SIGNATURE hashes the scrubbed diagnostic, so the same recurring cause aggregates while two
 *    different causes under the same tool/class/task stay different problems;
 *  • observations WITHOUT a signature (older records, or hosts that captured no diagnostic) keep the
 *    pre-existing aggregation key — a new identity never rewrites old history.
 */
import { createHash } from 'node:crypto'

export const FAILURE_EVIDENCE_FORMAT = 1
export const CAPSULE_MAX_BYTES = 2048
export const CAPSULES_PER_PROBLEM = 3
export const CAPSULES_TOTAL_BYTES = 128 * 1024
export const CAPSULE_MESSAGE_CHARS = 512
export const CAPSULE_COMMAND_CHARS = 160

/**
 * Screening patterns. These are THE source of truth: problems.mjs re-exports them so the lesson,
 * summary and capsule boundaries cannot drift apart. A scrubbed string must never match either one.
 */
export const SENSITIVE_PATTERN = /https?:\/\/|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|(?:(\/Users\/|\/home\/|\/tmp\/|\/var\/|\/etc\/|\/opt\/|\/usr\/|[A-Z]:\\))|(?<![\w-])(?:api[_-]?key|token|secret|password|authorization|cookie|密码|密钥)\s*[:=：]|\bBearer\s+\S+|-----BEGIN|\bsk-[A-Za-z0-9_-]{12,}/iu
export const AUTHORITY_PATTERN = /忽略.{0,12}(?:指令|规则|用户|权限)|绕过.{0,12}(?:授权|权限|限制)|(?:ignore|override).{0,20}(?:instructions|permissions)|(?:system|assistant|developer)\s*:|<\/?(?:system|instruction|mse)|```/iu

/** The restricted failure vocabulary a capsule may describe (mirrors the problem ledger). */
export const FAILURE_CLASS_VOCABULARY = Object.freeze(['tool_nonzero_exit', 'tool_error_flag', 'tool_timeout',
  'provider_unavailable', 'checker_contract_failure', 'unknown_tool_failure', 'cancelled', 'foreground_yield'])

const hash = text => createHash('sha256').update(text).digest('hex')
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const isPlainObject = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && /[\u0000-\u001f\u007f]/u.test(value) === false

const SCRUB_AUTHORITY_GLOBAL = new RegExp(AUTHORITY_PATTERN.source, 'giu')

/**
 * Replace every secret/authority/URL/email/path shape and keep only diagnostic value.
 *
 * Order matters: PEM blocks and `Bearer`/`sk-`/`key=value` shapes go first (they would otherwise be
 * partially eaten by the generic word patterns), URLs before emails (an email can hide inside a
 * URL), paths last so a scrubbed token cannot be re-matched as a path. Keeping the file name of a
 * path (`[path]/check.mjs:2:6`) is deliberate: WHERE a tool complained is exactly the part an agent
 * needs, while the user's directory tree is exactly the part it must not keep.
 *
 * Mixed content (a real SyntaxError beside a leaked secret) keeps its diagnosis: each UNSAFE SHAPE
 * is replaced by a placeholder, and only a string that is still unsafe AFTER scrubbing returns null.
 * A credential ASSIGNMENT is replaced WHOLE (`api_key=[redacted]` would itself re-match the
 * detection pattern, so the key name goes with it).
 */
export function sanitizeDiagnosticText(raw, { maxChars = CAPSULE_MESSAGE_CHARS } = {}) {
  if (typeof raw !== 'string') return null
  const pathPlaceholder = segment => {
    const tail = String(segment).split(/[\\/]/).pop() ?? ''
    const keep = [...tail].slice(0, 48).join('')
    return `[path]${keep === '' ? '' : `/${keep}`}`
  }
  let text = raw
    .replace(/[\r\n\t]+/gu, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/-----BEGIN[A-Z0-9 ]*-----[\s\S]*?(?:-----END[A-Z0-9 ]*-----|$)/gu, '[credential]')
    .replace(/\bBearer\s+\S+/giu, '[credential]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gu, '[credential]')
    .replace(/(?<![\w-])(?:api[_-]?key|token|secret|password|authorization|cookie|密码|密钥)\s*[:=：]\s*(?:"[^"]*"|'[^']*'|[^\s;,'"]+)/giu,
      '[credential]')
    .replace(/https?:\/\/\S+/giu, '[url]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/giu, '[email]')
    .replace(/[A-Za-z]:\\[^\s'"`;|]*/gu, pathPlaceholder)
    .replace(/\/(?:Users|home|private|tmp|var|etc|opt|usr|Library|Applications)\/[^\s'"`;|()]*/gu,
      pathPlaceholder)
    .replace(SCRUB_AUTHORITY_GLOBAL, '[redacted]')
    .replace(/\s{2,}/gu, ' ').trim()
  if (text === '') return null
  // Slice by CODE POINTS, then verify again: the cut itself can only remove characters, but a
  // double check keeps the "scrubbed before persistence" rule mechanically true for every caller.
  const chars = [...text]
  if (chars.length > maxChars) text = chars.slice(0, maxChars).join('')
  text = text.trim()
  if (text === '' || SENSITIVE_PATTERN.test(text) || AUTHORITY_PATTERN.test(text)) return null
  return text
}

/**
 * A deterministic signature of the diagnostic CATEGORY. Two observations of the same cause —
 * same error class and message even if the failing INPUT VALUE, byte position or the call STACK
 * changed — aggregate into one problem; a different error class never does.
 *
 * Node's stderr stacks source text and frames, so hashing the whole message would split one root
 * cause every time a byte or a file moves, and the independent-evidence threshold would never be
 * crossed. Therefore the signature only sees: the message BEFORE the first stack frame, quoted
 * source fragments collapsed, digits collapsed (positions/line numbers are instance noise), and the
 * failure class + exit code. The FULL scrubbed diagnosis stays in the capsule message.
 */
const STACK_FRAME = /\s+at\s+(?:\[path\]|<anonymous>|\S+\([^\)]*\)|\S+\.[a-z][a-z0-9]*)/iu
export function diagnosticSignature({ failureClass, exitCode, message }) {
  if (typeof message !== 'string' || message === '') return null
  const core = message.split(STACK_FRAME, 1)[0]
    .replace(/["'`][^"'`]*["'`]/gu, '…')
    .replace(/\d+/gu, '#')
    .replace(/\s+/gu, ' ')
    .trim()
  if (core === '') return null
  return hash(JSON.stringify([failureClass, Number.isSafeInteger(exitCode) ? exitCode : '',
    core.normalize('NFKC').toLocaleLowerCase('und')]))
}

/**
 * Build one capsule. Inputs may be raw (unsafe): everything text-bearing is scrubbed HERE, and a
 * value that cannot be scrubbed safely degrades to `null` instead of poisoning the capsule — the
 * remaining facts (class, exit code, tool) are still worth recording. Returns `null` only for an
 * unusable input (no/oversized event id, unknown class).
 */
export function buildFailureCapsule(input = {}) {
  if (!isPlainObject(input)) return null
  const eventId = typeof input.eventId === 'string' && input.eventId.length > 0
    && input.eventId.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(input.eventId) ? input.eventId : null
  if (eventId === null) return null
  if (!FAILURE_CLASS_VOCABULARY.includes(input.failureClass)) return null
  const at = Number.isFinite(input.at) ? input.at : 0
  const toolName = input.toolName === null || input.toolName === undefined ? null
    : (typeof input.toolName === 'string' && input.toolName.length > 0 && input.toolName.length <= 64
      && !/[\u0000-\u001f\u007f]/u.test(input.toolName) ? input.toolName : null)
  const exitCode = Number.isSafeInteger(input.exitCode) ? input.exitCode : null
  const checkId = input.checkId === null || input.checkId === undefined ? null
    : (bounded(input.checkId, 128) ? input.checkId : null)
  const message = sanitizeDiagnosticText(input.message)
  const command = sanitizeDiagnosticText(input.command, { maxChars: CAPSULE_COMMAND_CHARS })
  const signature = diagnosticSignature({ failureClass: input.failureClass, exitCode, message })
  // MSE21-FIX1: the capsule carries its OWN immutable source (host session + exact turn) so a
  // later problem.origin change can never re-attribute this evidence. Optional (old capsules keep
  // loading) and bounded; no path or content is introduced, only the host handle + turn hash.
  const originSessionId = typeof input.originSessionId === 'string' && input.originSessionId.length > 0
    && input.originSessionId.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(input.originSessionId)
    ? input.originSessionId : null
  const turnKey = typeof input.turnKey === 'string' && /^[a-f0-9]{64}$/u.test(input.turnKey)
    ? input.turnKey : null
  const capsule = { format: FAILURE_EVIDENCE_FORMAT,
    id: hash(JSON.stringify(['failure-capsule', originSessionId ?? '', turnKey ?? '', eventId,
      toolName ?? '', input.failureClass, signature ?? ''])),
    eventIdHash: hash(eventId), at, toolName, failureClass: input.failureClass, exitCode, signature,
    command, message, checkId, ...(originSessionId === null ? {} : { originSessionId }),
    ...(turnKey === null ? {} : { turnKey }) }
  // Shrink the free-text halves until the WHOLE serialized capsule fits the 2048 B contract. The
  // structured facts (id, class, exit code, signature) are never sacrificed for text.
  const fits = () => Buffer.byteLength(JSON.stringify(capsule), 'utf8') <= CAPSULE_MAX_BYTES
  for (const field of ['message', 'command']) {
    while (!fits() && capsule[field] !== null) {
      const chars = [...capsule[field]]
      capsule[field] = chars.length <= 16 ? null : chars.slice(0, Math.floor(chars.length / 2)).join('')
    }
  }
  if (!fits()) return null
  return capsule
}

/**
 * Extract the REAL rc.4 tool-result facts: exit code, the tool's stderr text (never stdout — tool
 * stdout is task data, not failure diagnostics), an error-flag message, and a scrubbed scalar
 * summary of the call arguments. This runs at capture time so nothing raw survives to the store.
 * `failureClass` is the trusted harness classification when it states one (the harness classifies
 * from host structure; this module only extracts the evidence for that class). Without a caller
 * class the fallback follows the EXACT host precedence — cancellation, timeout, error flag, then
 * non-zero exit — so the capsule and the problem can never disagree. A cancellation never produces
 * a failure capsule: it is an availability fact, not method evidence.
 */
export function failureCapsuleFromHostResult({ exec, result, event, at = 0, failureClass = null } = {}) {
  if (!exec || typeof exec.callId !== 'string' || !result) return null
  const cancelled = exec.signal?.aborted === true || result.value?.cancelled === true
    || result.value?.aborted === true
    || (result.isError === true && ['ABORTED', 'ABORTED_BEFORE_DISPATCH'].includes(result.error?.info?.code))
  const resolved = failureClass !== null && FAILURE_CLASS_VOCABULARY.includes(failureClass) ? failureClass
    : (cancelled ? 'cancelled'
      : (result.value?.timedOut === true || result.value?.timeout === true ? 'tool_timeout'
        : (result.isError === true ? 'tool_error_flag'
          : (typeof result.value?.exitCode === 'number' && result.value.exitCode !== 0
            ? 'tool_nonzero_exit' : null))))
  if (resolved === null || resolved === 'cancelled' || cancelled) return null
  const stderr = typeof result.value?.stderr?.text === 'string' ? result.value.stderr.text : null
  const errMessage = result.error && typeof result.error.message === 'string' ? result.error.message : null
  let command = null
  const rawArguments = typeof event?.data?.arguments === 'string' ? event.data.arguments : null
  if (rawArguments !== null) {
    try {
      const parsed = JSON.parse(rawArguments)
      if (isPlainObject(parsed)) {
        const scalars = Object.entries(parsed)
          .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
          .slice(0, 4).map(([key, value]) => `${key}=${value}`).join(' ')
        command = scalars === '' ? null : scalars
      }
    } catch { /* unparseable arguments simply carry no summary */ }
  }
  return buildFailureCapsule({ eventId: exec.callId, at, toolName: typeof exec.name === 'string'
    ? exec.name : null, failureClass: resolved,
    exitCode: Number.isSafeInteger(result.value?.exitCode) ? result.value.exitCode : null,
    message: stderr ?? errMessage, command })
}

/** Whether a stored capsule passes every bounded shape rule (also the persistence gate). */
export function capsuleValid(capsule) {
  return isPlainObject(capsule)
    && Object.keys(capsule).every(key => ['format', 'id', 'eventIdHash', 'at', 'toolName', 'failureClass',
      'exitCode', 'signature', 'command', 'message', 'checkId', 'followUp', 'originSessionId',
      'turnKey'].includes(key))
    // MSE21-FIX1: optional immutable capsule provenance; absent in old capsules.
    && (capsule.originSessionId === undefined || (typeof capsule.originSessionId === 'string'
      && capsule.originSessionId.length > 0 && capsule.originSessionId.length <= 512
      && !/[\u0000-\u001f\u007f]/u.test(capsule.originSessionId)))
    && (capsule.turnKey === undefined || (typeof capsule.turnKey === 'string'
      && /^[a-f0-9]{64}$/u.test(capsule.turnKey)))
    && capsule.format === FAILURE_EVIDENCE_FORMAT && hex64(capsule.id) && hex64(capsule.eventIdHash)
    && Number.isFinite(capsule.at)
    && (capsule.toolName === null || bounded(capsule.toolName, 64))
    && FAILURE_CLASS_VOCABULARY.includes(capsule.failureClass)
    && (capsule.exitCode === null || Number.isSafeInteger(capsule.exitCode))
    && (capsule.signature === null || hex64(capsule.signature))
    && (capsule.checkId === null || bounded(capsule.checkId, 128))
    && (capsule.command === null || (bounded(capsule.command, CAPSULE_COMMAND_CHARS)
      && !SENSITIVE_PATTERN.test(capsule.command) && !AUTHORITY_PATTERN.test(capsule.command)))
    && (capsule.message === null || (bounded(capsule.message, CAPSULE_MESSAGE_CHARS)
      && [...capsule.message].length <= CAPSULE_MESSAGE_CHARS
      && !SENSITIVE_PATTERN.test(capsule.message) && !AUTHORITY_PATTERN.test(capsule.message)))
    && (capsule.followUp === undefined || capsule.followUp === null || (isPlainObject(capsule.followUp)
      && Object.keys(capsule.followUp).every(key => ['kind', 'checkId', 'at'].includes(key))
      && capsule.followUp.kind === 'check' && bounded(capsule.followUp.checkId, 128)
      && Number.isFinite(capsule.followUp.at)))
    && Buffer.byteLength(JSON.stringify(capsule), 'utf8') <= CAPSULE_MAX_BYTES
}

export const capsuleBytes = capsule => Buffer.byteLength(JSON.stringify(capsule), 'utf8')

export const capsulesByteTotal = loop => loop.problems.reduce(
  (sum, row) => sum + (row.capsules ?? []).reduce((s, capsule) => s + capsuleBytes(capsule), 0), 0)

/**
 * Append the newest capsule to one problem row: distinct events only, newest CAPSULES_PER_PROBLEM
 * kept, every eviction counted. Duplicate capsule ids (the same host call) are refused here as a
 * second safety net under the ledger's own event dedup.
 */
export function appendCapsuleToRow(row, capsule) {
  const capsules = row.capsules ?? []
  if (capsules.some(existing => existing.id === capsule.id)) return 'duplicate'
  const kept = [...capsules, capsule].slice(-CAPSULES_PER_PROBLEM)
  const dropped = capsules.length + 1 - kept.length
  if (dropped > 0) row.capsuleDropped = (row.capsuleDropped ?? 0) + dropped
  row.capsules = kept
  return 'appended'
}

/**
 * The ledger-wide bounded diagnostic window. When the capsule total crosses the 128 KiB budget the
 * OLDEST capsules are evicted (across rows, oldest `at` first) until the total fits; the newest
 * evidence can never be the one evicted while older evidence remains. Only capsule text leaves:
 * problem identities, counts, summaries and the ledger itself stay intact, and each row counts
 * exactly how much it lost.
 */
export function enforceCapsuleBudget(loop) {
  let evicted = 0
  while (capsulesByteTotal(loop) > CAPSULES_TOTAL_BYTES) {
    let oldest = null
    for (const row of loop.problems) {
      const capsules = row.capsules ?? []
      if (capsules.length === 0) continue
      if (oldest === null || capsules[0].at < oldest.row.capsules[0].at) oldest = { row }
    }
    if (oldest === null) break
    oldest.row.capsules = oldest.row.capsules.slice(1)
    oldest.row.capsuleDropped = (oldest.row.capsuleDropped ?? 0) + 1
    evicted += 1
  }
  return evicted
}
