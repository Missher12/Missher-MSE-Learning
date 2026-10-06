/**
 * Pure, bounded projections for the read-only MSE detail page.
 *
 * This module has no Host dependency on purpose: the Cordis service imports it, the test
 * suite imports it, and it decides what shape of data may ever reach the browser. Every
 * function is total — unknown input becomes a bounded, explicit placeholder instead of
 * leaking a raw object, a path or an unbounded string.
 */
import { createHash } from 'node:crypto'

export const STATUSES = ['reminder', 'candidate', 'tested', 'validated', 'suspended']
export const KINDS = ['correction', 'method']
export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 50
export const MAX_QUERY_CHARS = 64
export const MAX_PROMPT_CHARS = 512
export const MAX_INSTRUCTION_CHARS = 240
export const MAX_EXPERIMENTS = 8

export const int = value => Number.isSafeInteger(value) ? value : 0
export const bool = value => value === true
export const text = (value, max = MAX_INSTRUCTION_CHARS) => typeof value === 'string' ? value.slice(0, max) : ''
export const boundedList = (value, max) => Array.isArray(value) ? value.slice(0, max) : []
export const oneOf = (value, allowed, fallback = '') => allowed.includes(value) ? value : fallback
export const clampInt = (value, min, max) => {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : min
  return Math.min(Math.max(parsed, min), max)
}
/** Stable display id for a resolved identity; one-way, so no path reaches the browser. */
export const shortHash = value => typeof value === 'string' && value.length > 0
  ? createHash('sha256').update(value).digest('hex').slice(0, 12) : null

/** Basename-style label for a resolved scope; never the full path. */
export function labelOfScope(projectKey) {
  if (typeof projectKey !== 'string' || projectKey.length === 0) return '默认作用域'
  const parts = projectKey.split('/').filter(Boolean)
  return parts.length === 0 ? '默认作用域' : parts[parts.length - 1].slice(0, 48)
}

/** How much of a Host title is ever carried to the browser; display only. */
export const MAX_TITLE_CHARS = 200

/**
 * Truncate to a number of UNICODE CODE POINTS, never UTF-16 units.
 *
 * `String.prototype.slice` counts UTF-16 units, so cutting an emoji-terminated title at an odd
 * boundary would leave a lone surrogate — a broken glyph that also breaks any later comparison.
 * The bound is measured in code points instead, so a pair is always kept or dropped whole.
 */
export function clipCodePoints(value, max = MAX_TITLE_CHARS) {
  if (typeof value !== 'string') return ''
  if (value.length <= max) return value      // UTF-16 length is never below the code-point count
  const points = [...value]
  return points.length <= max ? value : points.slice(0, max).join('')
}

/**
 * The wire title of one projection block, in three DISTINCT answers:
 *  • a string — the title the Host itself would show;
 *  • `null` — the projection ANSWERED and the session really has no title;
 *  • `undefined` — this projection cannot answer for this session (no block, no `values`, no
 *    `title` key, or a non-string value), so a later source may still be consulted.
 *
 * The accepted shape is the Host's own WIRE view of the title unit:
 * `titleViewSchema = zod.string().min(1).nullable()` with `wire.view = state => state`. A folded
 * per-session snapshot — the internal shape `readTitleSnapshots(ids)` returns, bound to its source
 * header — is NOT a wire title and is rejected instead of coerced (no `String(value)`, no
 * `value.title`), which reads as "cannot answer" rather than as a title.
 *
 * A title is display-only: never stored, never part of a scope identity, never compared with
 * anything the learning core writes. Control characters are neutralised and blank input is an
 * answered "no title".
 */
export function titleOfWire(block) {
  const values = block?.values
  if (values === null || typeof values !== 'object') return undefined
  if (!Object.hasOwn(values, 'title')) return undefined
  const value = values.title
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim()
  return trimmed === '' ? null : clipCodePoints(trimmed)
}

/** The same answer flattened for callers that only need a display string. */
export function titleOfBlock(block) {
  const answered = titleOfWire(block)
  return typeof answered === 'string' ? answered : null
}

/**
 * Resolve one session's title through the Host's OWN public projections, in the Host's own
 * order, and never by guessing a header field.
 *
 * The services arrive as values (not read from a context) so the decision stays pure:
 *  • an ATTACHED session answers from its live projection cut (`projections.snapshot`), then
 *    from its already-materialized cells (`projections.cachedSnapshot`);
 *  • a COLD session answers from the durable projection cache (`cache.cachedSnapshot(header)`),
 *    then from the predecessor-title checkpoint (`cache.cachedPredecessorTitle(header)`);
 *  • nothing else is attempted: folding a cold session's log would cost the whole log, and
 *    `header.title` / `header.name` are not part of the public projection contract.
 *
 * An ATTACHED session's live cut is authoritative: if it answers (a title OR an explicit null,
 * which means the conversation really has no title), that answer is final and the durable cache is
 * NOT consulted — replacing an authoritative "untitled" with a stale cached title would show a
 * name the live session no longer has. Only an UNAVAILABLE live projection falls through.
 *
 * A cold session mirrors the Host's own order, block for block:
 * `cache.cachedSnapshot(header) ?? cache.cachedPredecessorTitle(header)` — the predecessor hint is
 * consulted only when there is no current block at all.
 *
 * Every source is optional and every failure stays local — a missing service, an unknown key or a
 * throwing projection degrades THIS row to `null` instead of failing the directory.
 * @returns the bounded title, or null when no public projection can answer for this session.
 */
export function sessionTitle({ attached = undefined, projections = undefined, cache = undefined, header = undefined } = {}) {
  const ask = reader => {
    try { return reader() } catch { return undefined }
  }
  if (attached !== undefined && attached !== null) {
    if (typeof projections?.snapshot === 'function') {
      const answered = titleOfWire(ask(() => projections.snapshot(attached, ['title'])))
      if (answered !== undefined) return answered
    }
    if (typeof projections?.cachedSnapshot === 'function') {
      const answered = titleOfWire(ask(() => projections.cachedSnapshot(attached, ['title'])))
      if (answered !== undefined) return answered
    }
  }
  if (header === undefined || header === null) return null
  if (typeof cache?.cachedSnapshot === 'function') {
    const block = ask(() => cache.cachedSnapshot(header, ['title']))
    if (block !== undefined && block !== null) return titleOfWire(block) ?? null
  }
  if (typeof cache?.cachedPredecessorTitle === 'function') {
    const answered = titleOfWire(ask(() => cache.cachedPredecessorTitle(header)))
    if (answered !== undefined) return answered
  }
  return null
}

/** One lesson row in list form, including the saved provenance the page must explain. */
export function projectRow(row) {
  return {
    id: text(row?.id, 40), kind: oneOf(row?.kind, KINDS), status: oneOf(row?.status, STATUSES),
    instruction: text(row?.instruction),
    version: int(row?.version), generation: Number.isSafeInteger(row?.generation) ? row.generation : 0,
    createdAt: int(row?.createdAt), expiresAt: int(row?.expiresAt),
    topicKey: typeof row?.topicKey === 'string' ? row.topicKey : null,
    value: typeof row?.value === 'string' ? row.value : null,
    methodId: row?.methodId ?? null,
    adopted: int(row?.adopted), verified: int(row?.verified), failed: int(row?.failed), inconclusive: int(row?.inconclusive),
    suspensionReason: row?.suspensionReason ?? null,
    historyComplete: row?.historyComplete === true,
    // Provenance: what the row actually saved, never inferred from its text.
    sourceTurn: typeof row?.sourceTurn === 'string' && /^[a-f0-9]{64}$/u.test(row.sourceTurn)
      ? row.sourceTurn.slice(0, 12) : null,
    environment: typeof row?.environment === 'string' && /^[a-f0-9]{64}$/u.test(row.environment)
      ? row.environment.slice(0, 12) : null,
    // true: this method belongs to the caller's environment; false: another environment's
    // method; null: not environment-bound (a correction) or not evaluated.
    currentEnvironment: row?.currentEnvironment === undefined || row.currentEnvironment === null
      ? null : row.currentEnvironment === true,
    applicability: text(row?.applicability ?? '', 240),
    exclusions: text(row?.exclusions ?? '', 240),
    validation: row?.validation?.decision === undefined ? null
      : { decision: text(row.validation.decision, 24), basis: text(row.validation.basis ?? '', 32), at: int(row.validation.at) },
    replaces: text(row?.replaces ?? '', 40) || null,
    replacedBy: text(row?.replacedBy ?? '', 40) || null,
    reopenedAt: Number.isFinite(row?.reopenedAt) ? int(row.reopenedAt) : null,
  }
}

/** One lesson row plus its summarized experiment history. */
export function projectDetail(row, experiments) {
  const base = projectRow(row)
  return {
    ...base,
    hypothesis: typeof row?.hypothesis === 'string' && /^[a-f0-9]{64}$/u.test(row.hypothesis)
      ? row.hypothesis.slice(0, 12) : null,
    experiments: boundedList(experiments, MAX_EXPERIMENTS).map(record => ({ at: int(record?.at),
      decision: text(record?.decision, 24), version: int(record?.version),
      reasons: boundedList(record?.reasons, 4).map(reason => text(reason, 48)) })),
  }
}

/** One recall-status entry; never the raw bridge object. */
export function projectTurn(entry) {
  return {
    turn: text(entry?.turn, 64),
    at: int(entry?.at),
    reason: text(entry?.reason, 40),
    bytes: int(entry?.bytes),
    lessons: boundedList(entry?.lessons, 4).map(id => text(id, 40)),
    sources: boundedList(entry?.sources, 4).map(row => ({ id: text(row?.id, 40), version: int(row?.version),
      kind: oneOf(row?.kind, KINDS), bytes: int(row?.bytes), methodId: row?.methodId ?? null })),
    diagnostics: entry?.diagnostics && typeof entry.diagnostics === 'object' ? {
      libraryLessons: int(entry.diagnostics.libraryLessons), scopeLessons: int(entry.diagnostics.scopeLessons),
      otherScope: int(entry.diagnostics.otherScope), expired: int(entry.diagnostics.expired),
      suspended: int(entry.diagnostics.suspended), methodUnvalidated: int(entry.diagnostics.methodUnvalidated),
      otherEnvironment: int(entry.diagnostics.otherEnvironment), alreadyOffered: int(entry.diagnostics.alreadyOffered),
      sameTurn: int(entry.diagnostics.sameTurn), eligible: int(entry.diagnostics.eligible),
      candidates: int(entry.diagnostics.candidates), matched: int(entry.diagnostics.matched),
      queryTopics: int(entry.diagnostics.queryTopics), selectedBytes: int(entry.diagnostics.selectedBytes),
      budgetBytes: int(entry.diagnostics.budgetBytes), sessionBytes: int(entry.diagnostics.sessionBytes),
      remainingBytes: int(entry.diagnostics.remainingBytes),
      nearest: entry.diagnostics.nearest === null || entry.diagnostics.nearest === undefined ? null : {
        lessonId: text(entry.diagnostics.nearest.lessonId, 40), gate: text(entry.diagnostics.nearest.gate, 40),
        weight: int(entry.diagnostics.nearest.weight), matched: int(entry.diagnostics.nearest.matched) },
    } : null,
    learned: entry?.learned && typeof entry.learned === 'object' ? {
      id: text(entry.learned.id, 40), duplicate: bool(entry.learned.duplicate),
      skipped: entry.learned.skipped ?? null, topicKey: entry.learned.topicKey ?? null,
      value: entry.learned.value ?? null } : null,
    adopted: entry?.adopted === undefined ? null : bool(entry.adopted),
    outcome: entry?.outcome ?? null,
    attributed: entry?.attributed === undefined ? null : int(entry.attributed),
    settleState: entry?.settleState ?? null,
    settleError: entry?.settleError ?? null,
    settleAttempts: entry?.settleAttempts === undefined ? null : int(entry.settleAttempts),
  }
}

/** Bounded library/scope counts; null when the caller had no readable diagnosis. */
export function projectCounts(library) {
  if (library === null || library === undefined || typeof library !== 'object') return null
  return {
    total: int(library.total), scopeLessons: int(library.scopeLessons), otherScope: int(library.otherScope),
    activeCorrections: int(library.activeCorrections), methods: int(library.methods),
    methodsValidated: int(library.methodsValidated), methodsUnvalidated: int(library.methodsUnvalidated),
    otherEnvironment: int(library.otherEnvironment), suspended: int(library.suspended), expired: int(library.expired),
    byStatus: library.byStatus && typeof library.byStatus === 'object'
      ? Object.fromEntries(STATUSES.map(status => [status, int(library.byStatus[status])])) : {},
  }
}

/** One settlement record; the frozen payload never leaves the core. */
export const projectSettlement = row => ({
  sessionId: row?.sessionId === undefined ? null : text(String(row.sessionId), 64),
  turnId: row?.turnId === null || row?.turnId === undefined ? null : text(String(row.turnId), 64),
  state: text(row?.state, 24), attempts: int(row?.attempts), code: row?.lastError ?? row?.code ?? null,
  at: int(row?.at),
})

/** Kind, status and case-insensitive substring filter over projected rows. */
export function filterLessons(rows, { kind = '', status = '', query = '' } = {}) {
  const needle = text(query, MAX_QUERY_CHARS).trim().toLowerCase()
  return boundedList(rows, Number.MAX_SAFE_INTEGER).filter(row =>
    (kind === '' || row?.kind === kind) && (status === '' || row?.status === status)
    && (needle === '' || String(row?.instruction ?? '').toLowerCase().includes(needle)))
}

/** Bounded page of a filtered list; `page` is clamped to the existing range. */
export function pageOf(items, { page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const size = clampInt(pageSize, 1, MAX_PAGE_SIZE) || DEFAULT_PAGE_SIZE
  const list = boundedList(items, Number.MAX_SAFE_INTEGER)
  const pages = Math.max(1, Math.ceil(list.length / size))
  const current = Math.min(clampInt(page, 1, pages), pages)
  return { page: current, pageSize: size, pages, total: list.length,
    items: list.slice((current - 1) * size, current * size) }
}
