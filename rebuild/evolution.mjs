/**
 * mse-rebuild evolution (EVOLUTION016) — PURE version evidence helpers. No I/O, no model call,
 * no clock read except the caller-supplied `now`.
 *
 * One lesson entry is a FAMILY of method editions:
 *   entry.injected / entry.recurrences  — family totals (kept forever, never reset)
 *   entry.methodStats                   — the CURRENT edition's own window (or null/unknown)
 *   doc.methodHistory                   — bounded archived editions (≤128 rows / ≤6144 B each)
 *
 * REVIEW-FIX1 guarantees held here:
 *   - one mechanism definition (case/parameter/negation/order/punctuation preserved) is used for
 *     both the live parent and archived FAILED editions;
 *   - a history row is admitted only when its OWN immutable provenance passes the CURRENT source
 *     guard AND its material passes the content guard; unknown provenance is a fixed reason;
 *   - a partial legacy snapshot can never gain a complete window or a recovered method body;
 *   - a legal current edition is archived byte-for-byte (never re-truncated with another unit);
 *   - guard wording states only what really happened (a recurrence is not a checker failure).
 */
import { createHash } from 'node:crypto'
import { boundedUnits, boundedCodepoints, METHOD_HISTORY_LIMIT, METHOD_HISTORY_ROW_BYTES } from './memory.mjs'

export const MAX_HISTORY_ENTRIES = 6
export const MAX_HISTORY_PROMPT_BYTES = 1536
export const MAX_HISTORY_SOURCES = 4
const hash = text => createHash('sha256').update(text).digest('hex')

/** Whitespace-only normalization: keeps case, parameters, order, negation and punctuation. */
export const normalizeMechanismText = value => String(value ?? '').replace(/\s+/gu, ' ').trim()

const canonicalMechanism = lesson => {
  const steps = Array.isArray(lesson?.repairSteps)
    ? lesson.repairSteps.map(step => normalizeMechanismText(step)) : []
  const verification = {
    check: normalizeMechanismText(lesson?.verification?.check),
    expected: normalizeMechanismText(lesson?.verification?.expected),
  }
  return JSON.stringify({ steps, verification })
}

/**
 * Deterministic mechanism fingerprint over the ADMITTED steps and verification only. It can
 * reject a literally identical mechanism; it never claims to recognize arbitrary re-wordings.
 */
export function mechanismKey(lesson) {
  return hash(canonicalMechanism(lesson))
}

/** The CURRENT edition's window; a missing window is honestly "since upgrade, nothing known yet". */
export function versionWindow(entry, now = Date.now()) {
  const stats = entry?.methodStats
  if (stats !== null && stats !== undefined && Number.isSafeInteger(stats.version)
    && stats.version === entry.version) {
    return { ...stats }
  }
  const since = Number.isFinite(entry?.updatedAt) ? entry.updatedAt : (Number.isFinite(now) ? now : 0)
  return { version: entry?.version ?? 1, since, coverage: 'since_upgrade',
    injected: 0, recurrences: 0, checkPasses: 0, checkFails: 0 }
}

/**
 * Live window for counter updates. Creates one on first real post-upgrade use: an entry that
 * already had family activity can only claim `since_upgrade` coverage; a brand-new edition can
 * claim `complete`.
 */
export function ensureMethodStats(entry, now) {
  const stats = entry.methodStats
  if (stats !== null && stats !== undefined && Number.isSafeInteger(stats.version)
    && stats.version === entry.version) return stats
  const prior = (entry.injected ?? 0) > 0 || (entry.recurrences ?? 0) > 0 || entry.superseded !== null
  entry.methodStats = { version: entry.version, since: now, coverage: prior ? 'since_upgrade' : 'complete',
    injected: 0, recurrences: 0, checkPasses: 0, checkFails: 0 }
  return entry.methodStats
}

/**
 * Resolve an injected offer to the EXACT edition it was injected as. `current` is the live entry
 * only while its version still matches; an archived edition resolves from methodHistory; a
 * missing edition resolves to null (unattributable, never promoted to the newest version).
 */
export function resolveMethodVersion(doc, id, version) {
  if (typeof id !== 'string' || !Number.isSafeInteger(version)) return null
  const current = doc.entries.find(entry => entry.id === id)
  if (current !== undefined && current.version === version) return { kind: 'current', record: current }
  const archived = (doc.methodHistory ?? []).find(row => row.entryId === id && row.version === version)
  if (archived !== undefined) return { kind: 'history', record: archived }
  return null
}

/** A history row is only fully attributable when its method body AND its window are real. */
export const historyRecordComplete = row => row !== null && row !== undefined
  && row.lesson !== null && row.lesson !== undefined
  && row.stats !== null && row.stats !== undefined
  && row.status !== 'legacy_partial'

/** Any lesson explicitly waiting for revision is a warning — never a recommended method. */
export function methodNeedsGuard(entry) {
  return entry !== null && entry !== undefined && entry.type === 'lesson'
    && entry.status === 'needs_revision'
}

/**
 * Bounded, concrete warning for a guard offer. It reports ONLY observed facts: a matched
 * recurrence is a recurrence (the checker may never have run); a checker failure is named only
 * when checkFails > 0. Unknown counts say so instead of inventing zeroes.
 */
export function guardSummary(entry, now = Date.now(), { materialAdmit = null } = {}) {
  const stats = entry?.methodStats
  const known = stats !== null && stats !== undefined && Number.isSafeInteger(stats.version)
    && stats.version === entry.version
  const window = versionWindow(entry, now)
  const parts = []
  if (known) {
    if ((window.recurrences ?? 0) > 0) parts.push(`同类复发 ${window.recurrences} 次`)
    if ((window.checkFails ?? 0) > 0) {
      const check = boundedUnits(normalizeMechanismText(entry.lesson?.verification?.check ?? ''), 80)
      parts.push(check === '' ? `检查失败 ${window.checkFails} 次`
        : `检查「${check}」失败 ${window.checkFails} 次`)
    }
    if ((window.checkPasses ?? 0) > 0) parts.push(`该检查此前通过 ${window.checkPasses} 次`)
    if (parts.length === 0) parts.push('本版失败次数未记录')
  } else if ((entry?.recurrences ?? 0) > 0) {
    parts.push(`家族累计复发 ${entry.recurrences} 次（版本归属未知）`)
  } else {
    parts.push('失败次数未记录')
  }
  // REVIEW-FIX2: keep a BOUNDED, ADMITTED concrete failure context so the warning is not a
  // generic reminder. Old repair steps are never replayed; an unrun checker is never called a
  // failure. 60 code points / 180 bytes keeps two guards inside the shared 2×768 B budget.
  const pattern = boundedCodepoints(normalizeMechanismText(entry?.lesson?.failurePattern ?? ''), 60, 180)
  if (pattern !== '' && (materialAdmit === null || materialAdmit(pattern) === true)) {
    parts.push(`具体失败模式：${pattern}`)
  }
  return `该旧办法此前已被判定待修订${parts.length > 0 ? `（${parts.join('，')}）` : ''}`
    + '；旧修复步骤不再推荐，请先重新诊断同一机制。'
}

/**
 * The SINGLE attribution judgment every feedback entry point (tool failure, checker, JSON
 * checker selection) must use: the receipt must not be a cancelled terminal, the offer must
 * exist, a guard is not a method, the exact edition must resolve, and a partial archived
 * snapshot is unattributable. Each caller keeps its own audit row/dedupe.
 */
export function methodAttribution(doc, receipt, entryId, version = null) {
  if (receipt === undefined || receipt === null) {
    return { admitted: false, reason: 'no_injection_this_turn' }
  }
  const offered = version === null
    ? receipt.offered.find(row => row.id === entryId)
    : receipt.offered.find(row => row.id === entryId && row.version === version)
  if (receipt.settled === true && receipt.outcome === 'cancelled') {
    // The audit row still needs the exact offered version; without an offer the checker simply
    // was not for this turn.
    if (offered === undefined) return { admitted: false, reason: 'version_not_injected_this_turn' }
    return { admitted: false, reason: 'cancelled_turn_not_creditable', offered }
  }
  if (offered === undefined) return { admitted: false, reason: 'version_not_injected_this_turn' }
  if (offered.mode === 'guard') return { admitted: false, reason: 'guard_not_method_credit' }
  const target = resolveMethodVersion(doc, entryId, offered.version)
  if (target === null) return { admitted: false, reason: 'version_evidence_missing' }
  if (target.kind === 'history' && (target.record.lesson === null
    || target.record.lesson === undefined || target.record.status === 'legacy_partial')) {
    return { admitted: false, reason: 'version_evidence_partial', target, offered }
  }
  return { admitted: true, reason: null, target, offered }
}

/**
 * ONE window rule for both tool and checker feedback: a complete archived method whose original
 * counters are unknown starts at `since_upgrade`; a partial snapshot is refused before this call.
 */
export function creditWindow(target, now) {
  const record = target.record
  if (target.kind === 'current') return ensureMethodStats(record, now)
  if (record.stats === null || record.stats === undefined) {
    record.stats = { version: record.version, since: Number.isFinite(now) ? now : Date.now(),
      coverage: 'since_upgrade', injected: 0, recurrences: 0, checkPasses: 0, checkFails: 0 }
  }
  return record.stats
}

/** The edition's OWN frozen source snapshot (single or multi); [] means unknown. */
export function editionSources(entry) {
  const sessions = []
  if (typeof entry?.originSession === 'string' && entry.originSession !== '') sessions.push(entry.originSession)
  for (const session of provenanceList(entry?.originSessions)) {
    if (!sessions.includes(session)) sessions.push(session)
  }
  return sessions
}

/**
 * Freeze the REAL source sessions of the capsules an edition was born from. All-or-nothing:
 * more distinct sessions than the bounded snapshot can hold yields an explicit unknown (empty),
 * never a silently truncated set. `limit` matches the capsule/evidence bounds.
 */
export function sourceSnapshot(capsules, limit = MAX_HISTORY_SOURCES) {
  const sessions = []
  for (const capsule of capsules ?? []) {
    const session = capsule?.originSessionId
    if (typeof session !== 'string' || session === '') continue
    const bounded = session.slice(0, 512)
    if (!sessions.includes(bounded)) sessions.push(bounded)
  }
  if (sessions.length > limit) return { sessions: [], overflow: true }
  return { sessions, overflow: false }
}

const historyRowText = row => `${row.instruction}\n${row.applicability}\n${row.exclusions}\n`
  + `${row.lesson?.verification?.check ?? ''}\n${row.lesson?.failurePattern ?? ''}`

const provenanceList = value => {
  const out = []
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== 'string' || item === '') continue
    const bounded = item.slice(0, 512)
    if (!out.includes(bounded)) out.push(bounded)
    if (out.length >= MAX_HISTORY_SOURCES) break
  }
  return out
}

/**
 * Whether a history row's OWN immutable provenance is admitted by the CURRENT source guard.
 * Unknown provenance (no session at all) is never silently treated as the current revision's
 * source: it is not admitted, and the caller must show only a fixed reason.
 */
export function historySourceAdmitted(row, sourceAdmit) {
  if (typeof sourceAdmit !== 'function') return true
  const sessions = []
  if (typeof row?.originSession === 'string' && row.originSession !== '') sessions.push(row.originSession)
  for (const session of provenanceList(row?.originSessions)) sessions.push(session)
  if (sessions.length === 0) return false
  return sessions.every(session => sourceAdmit(session) === true)
}

/** Combined admission for one history row: material content AND its own provenance. */
export function historyAdmission(row, { materialAdmit = () => true, sourceAdmit = null } = {}) {
  if (materialAdmit(historyRowText(row)) !== true) return { admitted: false, reason: 'material_unverified' }
  if (!historySourceAdmitted(row, sourceAdmit)) return { admitted: false, reason: 'source_unverified' }
  return { admitted: true, reason: null }
}

/**
 * Related archived editions for a revision prompt: at most 6 rows / 1536 UTF-8 bytes total.
 * A refused row contributes only a FIXED reason (never its path, body, source or hash).
 */
export function selectHistory(doc, entry, admit = () => true, options = {}) {
  const { sourceAdmit = null } = options
  const candidates = (doc.methodHistory ?? [])
    .filter(row => row.entryId === entry.id && row.version < entry.version && row.status !== 'retired')
    .map(row => {
      const sameEnvironment = row.originEnvironment === entry.originEnvironment
      const failed = (row.stats?.recurrences ?? 0) > 0 || (row.stats?.checkFails ?? 0) > 0
        || row.status === 'needs_revision'
      const passed = (row.stats?.checkPasses ?? 0) > 0
      const priority = (failed ? 4 : 0) + (sameEnvironment ? 2 : 0) + (passed ? 1 : 0)
      return { row, priority }
    })
    .sort((left, right) => right.priority - left.priority
      || (right.row.archivedAt - left.row.archivedAt))
  const out = []
  for (const { row } of candidates) {
    if (out.length >= MAX_HISTORY_ENTRIES) break
    const admission = historyAdmission(row, { materialAdmit: admit, sourceAdmit })
    const stats = row.stats ?? null
    const baseReason = row.status === 'legacy_partial' ? 'legacy_partial'
      : stats === null ? 'no_observed_result'
        : (stats.recurrences ?? 0) > 0 ? 'matched_failure'
          : (stats.checkFails ?? 0) > 0 ? 'check_failed'
            : (stats.checkPasses ?? 0) > 0 ? 'check_passed'
              : 'no_observed_result'
    const check = boundedUnits(row.lesson?.verification?.check ?? '', 160)
    const summary = {
      version: row.version,
      status: row.status,
      recurrences: stats?.recurrences ?? 0,
      checkFails: stats?.checkFails ?? 0,
      checkPasses: stats?.checkPasses ?? 0,
      instruction: admission.admitted ? boundedUnits(row.instruction, 160) : null,
      check: admission.admitted && check !== '' ? check : null,
      reason: admission.admitted ? baseReason : admission.reason,
    }
    const next = [...out, summary]
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_HISTORY_PROMPT_BYTES) break
    out.push(summary)
  }
  return out
}

/** The bounded prompt fragment (data, not instructions) for the existing revise `system` slot. */
export function renderHistoryPrompt(rows) {
  const body = JSON.stringify(rows ?? [])
  return Buffer.byteLength(body, 'utf8') <= MAX_HISTORY_PROMPT_BYTES ? body : '[]'
}

/**
 * One archive row for the CURRENT edition. A legal current instruction/applicability/exclusion is
 * copied VERBATIM (the entry schema already guaranteed the same units); nothing is re-truncated.
 * Statistics are stored only when they really existed; provenance is the bounded set of sessions
 * frozen with the evidence capsules that requested this edition.
 */
export function historyRowFor(entry, { now, reason = 'matched_recurrence' } = {}) {
  const stats = entry.methodStats !== null && entry.methodStats !== undefined
    && Number.isSafeInteger(entry.methodStats.version) && entry.methodStats.version === entry.version
    ? { ...versionWindow(entry, now) } : null
  const row = {
    entryId: entry.id,
    version: entry.version,
    instruction: entry.instruction,
    applicability: entry.applicability ?? '',
    exclusions: entry.exclusions ?? '',
    visibility: entry.visibility,
    lesson: entry.lesson === null || entry.lesson === undefined
      ? null : JSON.parse(JSON.stringify(entry.lesson)),
    originScope: entry.originScope,
    originEnvironment: entry.originEnvironment,
    originSession: entry.originSession ?? null,
    stats,
    status: entry.status,
    reason: boundedUnits(String(reason), 64),
    archivedAt: Number.isFinite(now) ? now : Date.now(),
    evidenceHash: entry.evidenceHash ?? null,
  }
  // REVIEW-FIX2: the archived edition keeps ITS OWN birth snapshot (never the newer revision's
  // evidence). An overflowed/legacy snapshot stays absent = explicitly unknown.
  const sessions = provenanceList(entry.originSessions)
  if (sessions.length > 0) row.originSessions = sessions
  return row
}

/** Whether one archive row can be represented at all (same bounds the validator enforces). */
export const historyRowRepresentable = row => {
  const instruction = row?.instruction
  if (typeof instruction !== 'string') return false
  if ([...instruction].length < 1 || [...instruction].length > 240) return false
  if (Buffer.byteLength(instruction, 'utf8') > 480) return false
  return Buffer.byteLength(JSON.stringify(row), 'utf8') <= METHOD_HISTORY_ROW_BYTES
}

/** Pre-flight estimate used BEFORE any model call: exact bytes of the row that would be archived. */
export function historyRowPreview(entry, options = {}) {
  const row = historyRowFor(entry, options)
  const bytes = Buffer.byteLength(JSON.stringify(row), 'utf8')
  return { row, bytes, tooLarge: bytes > METHOD_HISTORY_ROW_BYTES
    || !historyRowRepresentable(row) }
}

/**
 * Archive the CURRENT edition. Caller must already be inside the existing store transaction; a
 * refusal is a readable code (never a half update, never a silent truncation/delete).
 */
export function archiveVersion(doc, entry, { now, reason = 'matched_recurrence' } = {}) {
  if (!Array.isArray(doc.methodHistory)) doc.methodHistory = []
  if (doc.methodHistory.length >= METHOD_HISTORY_LIMIT) {
    return { ok: false, code: 'method_history_full' }
  }
  if (doc.methodHistory.some(row => row.entryId === entry.id && row.version === entry.version)) {
    return { ok: true, duplicate: true }
  }
  const row = historyRowFor(entry, { now, reason })
  if (!historyRowRepresentable(row)) return { ok: false, code: 'method_history_row_too_large' }
  doc.methodHistory.push(row)
  return { ok: true, row }
}

/** Bound used by the pre-flight capacity check before a revise request may spend model tokens. */
export function historyCapacity(doc) {
  const rows = doc.methodHistory ?? []
  return { count: rows.length, limit: METHOD_HISTORY_LIMIT,
    full: rows.length >= METHOD_HISTORY_LIMIT, reserveBytes: METHOD_HISTORY_ROW_BYTES }
}
