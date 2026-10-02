/**
 * Read-only Host Remote: bounded projections of the local MSE learning state.
 *
 * The client half renders the Settings → Plugins → MSE detail page. Nothing here writes:
 * every method projects data the core already produced from an explicitly resolved scope,
 * and the client can never supply a scope, a path or a state root — it names one session id
 * and the Host maps that id to the Session object it observed itself.
 *
 * Endpoints are marked through the public `Remote` decorator applied with the standard
 * method-decorator context a compiler would supply (this package has no TypeScript pass),
 * and the marking is verified with the protocol's own `remoteMethods()` reader at load.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Remote, TypertRemoteService, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { MAX_PROMPT_CHARS, MAX_QUERY_CHARS, STATUSES, bool, boundedList, filterLessons, int, labelOfScope,
  oneOf, pageOf, projectCounts, projectDetail, projectRow, projectSettlement, projectTurn, shortHash, text } from './project.mjs'

/** One method marked as a direct Remote endpoint. */
function markRemote(Class, method) {
  const descriptor = Object.getOwnPropertyDescriptor(Class.prototype, method)
  if (descriptor === undefined || typeof descriptor.value !== 'function') {
    throw new TypeError(`mse-learning: cannot mark missing Remote method ${method}`)
  }
  const initializers = []
  Remote(method)(descriptor.value, { kind: 'method', name: method, static: false, private: false,
    addInitializer: initializer => { initializers.push(initializer) } })
  const probe = Object.create(Class.prototype)
  for (const initializer of initializers) initializer.call(probe)
}

const ENDPOINTS = ['overview', 'sessions', 'lessons', 'lesson', 'recall', 'diagnose']
const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const MAX_SESSIONS = 64
const MAX_SESSION_SCAN = 400
const MAX_SETTLEMENT_ROWS = 64

/** Package version, read once from the manifest that ships with this module. */
function readVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch { return 'unknown' }
}

/**
 * The read-only detail Remote of the MSE learning plugin.
 *
 * It owns no directory of its own: every call re-reads the public Host services, so a session
 * that was created before this process started (or that has just been created and not yet used)
 * is selectable, and a session that disappeared is refused instead of answered from a cache.
 * The browser contributes one opaque session id and nothing else — no project key, no path.
 */
export class MseDetails extends TypertRemoteService {
  static inject = []

  constructor(ctx) {
    super(ctx, 'mseDetails')
    this.version = readVersion()
  }

  /** The core service this projection reads, or null while it is unloaded. */
  core() {
    const service = this.ctx.get('mseLearning')
    return service === undefined || service === null ? null : service
  }

  /** The core's engine, or null when the learning half is not live. Never throws. */
  engineOf(core) {
    const engine = core?.engine
    return engine === undefined || engine === null || typeof engine.list !== 'function' ? null : engine
  }

  /** One optional public Host service; a profile without it reports itself unavailable. */
  service(key) {
    try {
      const value = this.ctx.get(key)
      return value === undefined ? null : value
    } catch { return null }
  }

  /**
   * Bounded, trusted session directory from the public Host services.
   *
   * `sessionQuery.listSessions` merges persisted and in-memory headers, so it covers sessions
   * created before this process started as well as one created moments ago. The archive set is
   * a different dimension and is reported separately; when a service is missing or the listing
   * fails, the caller sees a code instead of an empty list that would read as "no sessions".
   */
  async directory() {
    const query = this.service('sessionQuery')
    if (query === null || typeof query.listSessions !== 'function') {
      return { ok: false, code: 'session_directory_unavailable', records: [], excluded: 0, archivedKnown: false }
    }
    let listed
    try { listed = await query.listSessions() } catch (error) {
      return { ok: false, code: text(error?.code ?? 'session_directory_failed', 60), records: [], excluded: 0,
        archivedKnown: false }
    }
    let archived = null
    let archivedError = null
    try {
      const registry = this.service('workspaceRegistry')
      const ids = registry?.archivedSessionIds
      archived = new Set(Array.isArray(ids) ? ids.map(String) : [])
    } catch (error) { archivedError = text(error?.code ?? 'archive_unavailable', 60) }
    const sessions = this.service('sessions')
    const agents = this.service('agents')
    const scan = boundedList(listed, MAX_SESSION_SCAN)
    const records = []
    const seen = new Set()
    let excluded = 0
    for (const entry of scan) {
      const header = entry?.header
      const id = text(header?.id, 512)
      if (id === '' || seen.has(id)) continue
      seen.add(id)
      const origin = text(header?.origin ?? '', 24)
      const depth = int(header?.delegationDepth)
      // Sub-agent sessions are internal work, not conversations a person picks here.
      if (depth > 0 || origin === 'subagent') { excluded += 1; continue }
      const cwd = typeof header?.cwd === 'string' && header.cwd.length > 0 && header.cwd.length <= 512
        ? header.cwd : null
      const live = entry?.live === true
        || (typeof sessions?.get === 'function' && sessions.get(id) !== undefined)
      const agent = typeof agents?.get === 'function' ? agents.get(id) : undefined
      records.push({ id, createdAt: int(header?.createdAt), at: int(header?.createdAt), origin,
        label: labelOfScope(cwd), projectKey: cwd, scope: cwd === null ? 'instance' : 'project',
        scopeHash: cwd === null ? null : shortHash(cwd),
        live: live === true, persisted: entry?.persisted === true,
        archived: archived === null ? null : archived.has(id),
        running: agent === undefined || agent === null ? null : agent.status === 'running' })
    }
    records.sort((left, right) => right.createdAt - left.createdAt || (left.id < right.id ? -1 : 1))
    return { ok: true, code: null, records: records.slice(0, MAX_SESSIONS), scanned: scan.length,
      excluded, truncated: records.length > MAX_SESSIONS || scan.length > MAX_SESSION_SCAN,
      archivedKnown: archived !== null, archivedError }
  }

  /** The scope one request may read: a Host-observed session, or this plugin's instance scope. */
  async resolveScope(sessionId) {
    if (sessionId === undefined || sessionId === null || sessionId === '') {
      return { ok: true, scope: { kind: 'instance', projectKey: undefined, sessionId: null,
        label: '默认作用域', scopeHash: null, record: null } }
    }
    const directory = await this.directory()
    if (directory.ok !== true) return { ok: false, code: directory.code }
    const id = text(sessionId, 512)
    const record = directory.records.find(row => row.id === id)
    if (record === undefined) return { ok: false, code: 'session_unknown' }
    return { ok: true, scope: { kind: record.scope, projectKey: record.projectKey ?? undefined,
      sessionId: id, label: record.label, scopeHash: record.scopeHash, record } }
  }

  /** Scope descriptor plus the counts the page may show; an unreadable store reports its code. */
  scopeInfo(engine, scope, core) {
    let counts = null
    let countsError = null
    try {
      const report = engine.diagnose({ ...(scope.projectKey === undefined ? {} : { projectKey: scope.projectKey }),
        ...(core?.environmentId === undefined ? {} : { environmentId: core.environmentId }) })
      counts = projectCounts(report?.library)
      if (counts === null) countsError = 'library_counts_unavailable'
    } catch (error) { countsError = text(error?.code ?? 'store_unavailable', 60) }
    const record = scope.record ?? null
    return { kind: scope.kind, sessionId: scope.sessionId, label: scope.label, scopeHash: scope.scopeHash,
      archived: record === null || record.archived === undefined ? null : record.archived,
      running: record === null || record.running === undefined ? null : record.running,
      counts, countsError }
  }

  /** Aggregate settlement state: counts only, never another session's identifiers. */
  settlementSummary(core) {
    let live = []
    try { live = boundedList(typeof core.settlementStatus === 'function' ? core.settlementStatus() : [], 64) } catch { live = [] }
    const byState = {}
    for (const row of live) {
      const state = text(row?.state, 24) || 'unknown'
      byState[state] = int(byState[state]) + 1
    }
    // The durable queue is a different fact from the in-process retry list: an entry can be
    // acknowledged and durable while this process has not attempted it yet, and a terminal row
    // remembers what actually happened even after a restart.
    let durable = null
    try {
      const status = typeof core.durableStatus === 'function' ? core.durableStatus() : null
      if (status?.ok === true) {
        durable = { pending: int(status.counts?.pending), expired: int(status.counts?.expired),
          terminal: int(status.counts?.terminal), settled: int(status.counts?.settled),
          stopped: int(status.counts?.stopped),
          paused: status.control?.userPaused === true, generation: int(status.control?.generation),
          history: boundedList(status.history ?? [], 8).map(row => ({ key: text(row?.key, 80),
            state: text(row?.state, 24), outcome: text(row?.outcome, 24), attributed: int(row?.attributed),
            reason: text(row?.reason, 64), at: int(row?.at) })) }
      }
    } catch { durable = null }
    return { live: live.length, byState, capacity: MAX_SETTLEMENT_ROWS, durable }
  }

  /** Version, enablement, store readability, instance-scope counts and budget. No cross-session detail. */
  async overview() {
    const core = this.core()
    const engine = core === null ? null : this.engineOf(core)
    if (engine === null) return { ok: false, code: 'core_unavailable', version: this.version }
    let status = null
    let storeError = null
    try { status = engine.status() } catch (error) { storeError = text(error?.code ?? 'store_unavailable', 60) }
    const scope = { kind: 'instance', projectKey: undefined, sessionId: null, label: '默认作用域', scopeHash: null }
    const info = this.scopeInfo(engine, scope, core)
    const directory = await this.directory()
    return {
      ok: true,
      version: this.version,
      generatedAt: Date.now(),
      runtime: 'dsh',
      enabled: core.bridge?.isEnabled?.() === true,
      paused: core.bridge?.isEnabled?.() === false,
      legacyOwner: this.ctx.get('missherEvolutionCore') !== undefined,
      reasons: boundedList(core.capabilities?.recallReasons, 24).map(reason => text(reason, 40)),
      store: {
        readable: storeError === null,
        schema: status === null ? null : int(status.schema),
        migrationRequired: storeError === 'migration_required' || status?.migrationRequired === true,
        error: storeError,
      },
      counts: info.counts,
      countsError: info.countsError,
      budget: { turnBytes: int(status?.budgetBytes ?? engine.budget), sessionBytes: int(status?.sessionBudgetBytes ?? 1536),
        maxLessons: int(status?.maxLessons ?? engine.maxLessons) },
      lessonsTotal: int(status?.lessons),
      adopted: int(status?.adopted), verified: int(status?.verified),
      settlement: this.settlementSummary(core),
      sessionsKnown: directory.ok === true ? directory.records.length : null,
      sessionDirectory: { available: directory.ok === true, code: directory.code ?? null,
        archivedKnown: directory.archivedKnown === true, archivedError: directory.archivedError ?? null,
        excludedInternal: int(directory.excluded), truncated: directory.truncated === true },
      capabilities: status?.capabilities === undefined || status.capabilities === null ? null : {
        protocol: int(status.capabilities.protocol),
        persistentRecall: bool(status.capabilities.persistentRecall),
        requestEvidence: text(status.capabilities.requestEvidence ?? '', 32),
        registeredCheckers: boundedList(status.capabilities.registeredCheckers, 16).map(name => text(name, 64)),
        isolatedEvaluation: bool(status.capabilities.isolatedEvaluation),
        portableMethods: bool(status.capabilities.portableMethods),
        automaticArbitraryTaskVerification: bool(status.capabilities.automaticArbitraryTaskVerification),
        environmentBound: bool(status.capabilities.environmentBound),
      },
      note: 'installed_active_is_not_learned_or_injected',
    }
  }

  /** The Host's own session directory: ids, trusted scope labels, live/persisted/archived. */
  async sessions() {
    const directory = await this.directory()
    if (directory.ok !== true) return { ok: false, code: directory.code, sessions: [] }
    return { ok: true, generatedAt: Date.now(), archivedKnown: directory.archivedKnown,
      archivedError: directory.archivedError ?? null, excludedInternal: directory.excluded,
      truncated: directory.truncated === true,
      sessions: directory.records.map(record => ({ id: record.id, createdAt: record.createdAt, at: record.at,
        label: record.label, scope: record.scope, scopeHash: record.scopeHash, live: record.live,
        persisted: record.persisted, archived: record.archived, running: record.running })) }
  }

  /** One bounded page of lessons inside a Host-resolved scope, complete over the stored library. */
  async lessons(input = {}) {
    const core = this.core()
    const engine = core === null ? null : this.engineOf(core)
    if (engine === null) return { ok: false, code: 'core_unavailable', version: this.version }
    const resolved = await this.resolveScope(input.sessionId)
    if (resolved.ok !== true) return { ok: false, code: resolved.code }
    const scope = resolved.scope
    let inspected = null
    try {
      inspected = engine.inspect({ ...(scope.projectKey === undefined ? {} : { projectKey: scope.projectKey }),
        ...(core.environmentId === undefined ? {} : { environmentId: core.environmentId }) })
    } catch (error) { return { ok: false, code: text(error?.code ?? 'store_unavailable', 60), version: this.version } }
    const filtered = filterLessons(inspected.lessons.map(projectRow),
      { kind: oneOf(input.kind, ['correction', 'method']), status: oneOf(input.status, STATUSES),
        query: text(input.query, MAX_QUERY_CHARS) })
    const page = pageOf(filtered, { page: input.page, pageSize: input.pageSize })
    return { ok: true, generatedAt: Date.now(), scope: this.scopeInfo(engine, scope, core),
      total: page.total, scopeTotal: inspected.scopeTotal, libraryTotal: inspected.libraryTotal,
      storeCap: inspected.storeCap, complete: inspected.scopeTotal <= inspected.storeCap,
      page: page.page, pageSize: page.pageSize, pages: page.pages, items: page.items }
  }

  /** One lesson's stored detail inside the same Host-resolved scope. */
  async lesson(input = {}) {
    const core = this.core()
    const engine = core === null ? null : this.engineOf(core)
    if (engine === null) return { ok: false, code: 'core_unavailable', version: this.version }
    const resolved = await this.resolveScope(input.sessionId)
    if (resolved.ok !== true) return { ok: false, code: resolved.code }
    const scope = resolved.scope
    const id = text(input.id, 40)
    let inspected = null
    try {
      inspected = engine.inspect({ ...(scope.projectKey === undefined ? {} : { projectKey: scope.projectKey }),
        ...(core.environmentId === undefined ? {} : { environmentId: core.environmentId }), id })
    } catch (error) { return { ok: false, code: text(error?.code ?? 'store_unavailable', 60), version: this.version } }
    const row = inspected.lessons[0]
    if (row === undefined) return { ok: false, code: 'lesson_not_in_scope' }
    let experiments = []
    let historyError = null
    try {
      experiments = engine.history({ lessonId: id, ...(scope.projectKey === undefined ? {} : { projectKey: scope.projectKey }) })
        .experiments ?? []
    } catch (error) { historyError = text(error?.code ?? 'history_unavailable', 60) }
    return { ok: true, generatedAt: Date.now(), scope: this.scopeInfo(engine, scope, core),
      lesson: projectDetail(row, experiments), historyError }
  }

  /** In-process recall for one Host-resolved session, plus that session's own byte ledger. */
  async recall(input = {}) {
    const core = this.core()
    const engine = core === null ? null : this.engineOf(core)
    if (core === null || engine === null) return { ok: false, code: 'core_unavailable', version: this.version }
    const resolved = await this.resolveScope(input.sessionId)
    if (resolved.ok !== true) return { ok: false, code: resolved.code }
    const scope = resolved.scope
    if (scope.sessionId === null) return { ok: false, code: 'session_required' }
    const status = core.recallStatus(scope.sessionId, scope.projectKey)
    let settlement = []
    try { settlement = typeof core.settlementStatus === 'function' ? core.settlementStatus() : [] } catch { settlement = [] }
    let ledger = null
    let ledgerError = null
    try {
      const report = engine.diagnose({ sessionId: scope.sessionId,
        ...(scope.projectKey === undefined ? {} : { projectKey: scope.projectKey }) })
      ledger = report?.session === null || report?.session === undefined ? null : {
        bytes: int(report.session.bytes), budgetBytes: int(report.session.budgetBytes),
        remainingBytes: int(report.session.remainingBytes), offered: int(report.session.offered) }
    } catch (error) { ledgerError = text(error?.code ?? 'session_ledger_unavailable', 60) }
    return { ok: true, generatedAt: Date.now(), memory: 'in-process', scope: this.scopeInfo(engine, scope, core),
      enabled: status?.enabled === true,
      recent: boundedList(status?.recent, 8).map(projectTurn),
      last: status?.last === null || status?.last === undefined ? null : projectTurn(status.last),
      // Only this session's settlement: another session's identifiers never travel together.
      settlement: { live: settlement.filter(row => text(String(row?.sessionId ?? ''), 512) === scope.sessionId)
        .slice(0, 16).map(projectSettlement) },
      session: ledger,
      sessionError: ledgerError,
      reasons: boundedList(status?.reasons, 24).map(reason => text(reason, 40)),
      note: status === undefined ? 'unavailable' : 'memory_only_since_process_start' }
  }

  /** Read-only dry run: what would this prompt recall, and what would it cost. */
  async diagnose(input = {}) {
    const core = this.core()
    const engine = core === null ? null : this.engineOf(core)
    if (core === null || engine === null) return { ok: false, code: 'core_unavailable', version: this.version }
    const resolved = await this.resolveScope(input.sessionId)
    if (resolved.ok !== true) return { ok: false, code: resolved.code }
    const scope = resolved.scope
    const prompt = text(input.prompt, MAX_PROMPT_CHARS)
    let report = null
    try {
      report = core.diagnose({ ...(prompt === '' ? {} : { prompt }),
        ...(scope.projectKey === undefined ? {} : { projectKey: scope.projectKey }),
        ...(scope.sessionId === null ? {} : { sessionId: scope.sessionId }) })
    } catch (error) { return { ok: false, code: text(error?.code ?? 'diagnose_unavailable', 60) } }
    // A refused read (migration required, unreadable store) must stay visible: never a
    // success envelope around an empty result.
    if (report === null || report === undefined || report.ok === false) {
      return { ok: false, code: text(report?.code ?? 'diagnose_unavailable', 60) }
    }
    return { ok: true, generatedAt: Date.now(), scope: this.scopeInfo(engine, scope, core),
      modelCalls: 0, contextBytesAppended: 0, budgetConsumed: 0,
      prompted: report.prompted === undefined ? null : {
        reason: text(report.prompted.reason, 40), wouldInjectBytes: int(report.prompted.wouldInjectBytes),
        fitted: int(report.prompted.fitted),
        wouldInjectLessons: boundedList(report.prompted.wouldInjectLessons, 4).map(id => text(id, 40)),
        eligible: int(report.prompted.eligible), candidates: int(report.prompted.candidates),
        matched: int(report.prompted.matched), alreadyOffered: int(report.prompted.alreadyOffered),
        sameTurn: int(report.prompted.sameTurn), expired: int(report.prompted.expired),
        suspended: int(report.prompted.suspended), otherScope: int(report.prompted.otherScope),
        methodUnvalidated: int(report.prompted.methodUnvalidated), budgetBytes: int(report.prompted.budgetBytes),
        nearest: report.prompted.nearest ?? null },
      session: report.session === null || report.session === undefined ? null : { bytes: int(report.session.bytes),
        budgetBytes: int(report.session.budgetBytes), remainingBytes: int(report.session.remainingBytes),
        offered: int(report.session.offered) },
      library: projectCounts(report.library) }
  }
}

for (const method of ENDPOINTS) markRemote(MseDetails, method)
if (remoteMethods(Object.create(MseDetails.prototype)).length !== ENDPOINTS.length) {
  throw new Error('mse-learning: the Remote endpoint markers did not register')
}

/** Cordis plugin form: one read-only detail Remote beside the learning core. */
export function apply(ctx) {
  return ctx.plugin(MseDetails)
}

export const name = 'mse-learning-details'
export const inject = []
export default { name, inject, apply }
