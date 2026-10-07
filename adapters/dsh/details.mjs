/**
 * Read-only Host Remote: bounded projections of the local MSE learning state.
 *
 * The client half renders the Settings → Plugins → MSE detail page. Nothing here writes:
 * every method projects data the core already produced, and the client can never supply a
 * scope, a path or a state root — it names one session id and the Host maps that id to the
 * Session object it observed itself.
 *
 * Two reads exist, and they answer different questions:
 *  • the SCOPE read — one Host-resolved session's own scope, unchanged (`lessons`, `lesson`,
 *    `recall`, `diagnose`);
 *  • the LIBRARY read — the whole stored library, which the 常规 counts and the 经验 list need
 *    because the default instance scope holds nothing in daily use. It is a union over the
 *    scopes this process can NAME (the instance scope plus one entry per project the Host's
 *    own session directory reports), each row leaving here with a display label and a one-way
 *    hash instead of a project path. It widens NO recall and NO write scope: nothing in this
 *    block is ever offered to recall, and the core still selects inside the caller's scope
 *    only. Where the union cannot cover the store the answer says so by count (`unattributed`,
 *    `truncated`) and by ONE completeness flag (`partial`, exactly `!complete`) rather than
 *    presenting a sample as the whole: while it is set, the scan-derived categories are lower
 *    bounds and the count block, not the whole-store totals, is what got smaller.
 *
 * Endpoints are marked through the public `Remote` decorator applied with the standard
 * method-decorator context a compiler would supply (this package has no TypeScript pass),
 * and the marking is verified with the protocol's own `remoteMethods()` reader at load.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Remote, TypertRemoteService, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { MAX_PROMPT_CHARS, MAX_QUERY_CHARS, STATUSES, bool, boundedList, filterLessons, int, labelOfScope, sessionTitle,
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
/** Distinct scopes one whole-library read may inspect; the remainder is reported, never hidden. */
const MAX_LIBRARY_SCOPES = 32
/** Rows one whole-library read may aggregate (the store itself is capped at 300 rows). */
const MAX_LIBRARY_ROWS = 512
/** Projects the 经验 guide lists before it reports how many it left out. */
const MAX_GUIDE_PROJECTS = 16
/** Plans one read may index while matching rows to the plan that covers their version. */
const MAX_AUTO_PLANS = 64
/**
 * The stable, quoted meaning of the in-process observation counter.
 *
 * `turnsObserved` is the core's own name for `bridge.trackedSessions()`, which answers
 * `statuses.size`: one entry per session this PROCESS has seen, evicted past its own bound. It
 * has never been a count of turns, and after a restart it is legitimately 0 while the stored
 * library is untouched, so the wire carries the distinction instead of leaving it to a name.
 */
const TURNS_OBSERVED_MEANING = 'in_process_sessions_since_process_start'
const AUTO_STAGES = ['queued', 'running', 'done', 'blocked', 'failed', 'interrupted']
const AUTO_TRACKS = ['objective', 'review']
const AUTO_EVIDENCE = ['host_check', 'host_pack', 'model_review', 'none']
const REVIEW_STATES = ['reviewed', 'rejected', 'inconclusive']
const REVIEW_AGREEMENTS = ['aligned', 'swapped_only', 'neutral_safe', 'disagreed', 'none']
const REVIEW_BENEFITS = ['unproven', 'none']
const TRIAL_STATES = ['trial', 'withdrawn']
/** Stages whose stored `reason` IS the code the row was parked with, not a waiting reason. */
const STOPPED_STAGES = ['blocked', 'failed', 'interrupted']

/** A number only when it really is one; `null` keeps "not recorded" distinct from "zero". */
const maybeInt = value => Number.isSafeInteger(value) && value >= 0 ? value : null

/** A call that must never take the whole read down with it; the caller reads the null. */
const safeCall = fn => { try { return fn() } catch { return null } }

/** The (lesson, version) identity a row and an automatic plan are matched on. */
const planKey = (lessonId, version) => {
  const id = text(lessonId, 40)
  return id === '' || !Number.isSafeInteger(version) ? null : `${id}:${version}`
}

/** A bounded provider/model route, or null; never the raw stored object. */
export function routeOf(value) {
  if (value === null || value === undefined || typeof value !== 'object') return null
  const provider = text(value.provider, 64)
  const model = text(value.model, 96)
  const effort = text(value.reasoningEffort, 32)
  if (provider === '' && model === '' && effort === '') return null
  return { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
}

/**
 * One stored model review, whitelisted and clipped.
 *
 * The stored row also carries scenario/criteria/baseline/candidate hashes and a source; those stay
 * in the core, because nothing on the page can act on them and a hash that cannot be verified here
 * is exactly the kind of field that starts to look like proof. `reviewed` is reported as what it
 * is — a licence to try — never as validation.
 */
export function reviewOf(row) {
  const review = row?.review
  if (review === null || review === undefined || typeof review !== 'object') return null
  return {
    state: oneOf(text(review.state, 24), REVIEW_STATES),
    at: maybeInt(review.at),
    agreement: oneOf(text(review.agreement ?? '', 24), REVIEW_AGREEMENTS) || null,
    benefit: oneOf(text(review.benefit ?? '', 16), REVIEW_BENEFITS) || null,
    reasons: boundedList(review.reasons, 4).map(code => text(code, 40)),
    judge: typeof review.judge === 'string' && review.judge !== '' ? text(review.judge, 64) : null,
    route: routeOf(review.route),
  }
}

/** One stored trial licence; `trial` is a reference-only offer, never a validation. */
export function trialOf(row) {
  const trial = row?.trial
  if (trial === null || trial === undefined || typeof trial !== 'object') return null
  return {
    state: oneOf(text(trial.state, 16), TRIAL_STATES),
    at: maybeInt(trial.at),
    reason: typeof trial.reason === 'string' && trial.reason !== '' ? text(trial.reason, 64) : null,
  }
}

/** One validation verdict's domain: a pack verdict covers a DOMAIN, never "everywhere". */
function domainOf(domain) {
  if (domain === null || domain === undefined || typeof domain !== 'object') return null
  return {
    packId: text(domain.packId, 64),
    version: maybeInt(domain.version),
    scope: domain.scope === 'validation_domain_only' ? 'validation_domain_only' : null,
  }
}

/** What the automatic scheduler recorded about one lesson version, or the explicit absence. */
function progressFields(base, row, plan, reviewRunTokens) {
  const stage = plan === null ? null : oneOf(text(plan.stage, 16), AUTO_STAGES) || null
  const reason = plan === null || plan.reason === null || plan.reason === undefined
    ? null : text(plan.reason, 64)
  return {
    // null stage = "no plan covers this version". It is deliberately NOT derived from the row's
    // status: "queued for a review" and "nothing was ever scheduled" are different facts, and a
    // page that merged them would report progress that does not exist.
    stage,
    track: plan === null ? null : oneOf(text(plan.track, 16), AUTO_TRACKS) || null,
    planHash: plan === null || typeof plan.planHash !== 'string' ? null : plan.planHash.slice(0, 12),
    attempts: plan === null ? null : maybeInt(plan.attempts),
    maxAttempts: plan === null ? null : maybeInt(plan.maxAttempts),
    evidence: plan === null ? null : oneOf(text(plan.evidence, 16), AUTO_EVIDENCE) || null,
    updatedAt: plan === null ? null : maybeInt(plan.updatedAt),
    nextAttemptAt: plan === null ? null : maybeInt(plan.nextAttemptAt),
    reason,
    // The store keeps ONE reason per plan. For a stopped stage that reason IS the stop code, so it
    // is reported as the last error as well instead of inventing a second, separate field.
    lastError: stage !== null && STOPPED_STAGES.includes(stage) ? reason : null,
    route: plan === null ? null : routeOf(plan.source?.route),
    // A review run's reservation is minted per run and released when it settles, so only a
    // RUNNING plan holds one; the per-run size is published once by the scheduler and is never
    // apportioned per row. Nothing here invents a cost the store did not record.
    budget: plan === null ? null : { reviewRunTokens: maybeInt(reviewRunTokens), holding: stage === 'running' },
    review: reviewOf(row),
    trial: trialOf(row),
    // The shared projection's verdict (decision/basis/at), plus the domain it was reached in.
    validation: base.validation === null || base.validation === undefined ? null
      : { ...base.validation, domain: domainOf(row?.validation?.domain) },
  }
}

/**
 * One lesson row as the detail page reads it: the shared list projection, the read-only progress
 * of the version the row currently has, and — in the whole-library read — the owning scope.
 *
 * The owning scope travels as a display label plus the same one-way hash the session directory
 * already uses for a project; the project PATH never crosses this boundary, so a row cannot leak
 * where it was learned.
 */
export function progressRow(row, plan = null, { reviewRunTokens = null, scope = null } = {}) {
  const base = projectRow(row)
  return {
    ...base,
    ...(scope === null ? {} : { scopeLabel: text(scope.label, 48), scopeHash: scope.scopeHash ?? null,
      scopeKind: scope.kind === 'project' ? 'project' : 'instance' }),
    ...progressFields(base, row, plan, reviewRunTokens),
  }
}

/**
 * Whole-library counts.
 *
 * Two sources, each used for what it can actually prove: the core's own `status()` for the
 * library total, the per-status counts and the adoption counters (it aggregates the WHOLE store,
 * not a scope), and the inspected rows for the facts `status()` does not split — corrections vs
 * methods, reviewed rows and live trials. When the rows do not cover the store the block says so
 * (`complete`, `scanned`, `unattributed`) instead of presenting partial detail as the library.
 *
 * ONE completeness field is published, not two competing ones: `partial` is exactly `!complete`,
 * so a reader (the page included) can test either name and always get the same answer. Its meaning
 * is precise: the scan-derived categories (`corrections`, `methods`, `reviewed`, `trial`) are then
 * LOWER BOUNDS, while `total`, the status counts and `adopted` still cover the whole store and must
 * NOT be downgraded to unknown.
 *
 * A read failure is `code` + `readable: false` with every count null — never zeros, which would
 * report "unreadable" as "empty library".
 */
export function libraryOf(rows, status, { storeCap = null, code = null } = {}) {
  if (code !== null && code !== undefined) return unreadableLibrary(code)
  const list = boundedList(rows, MAX_LIBRARY_ROWS)
  const rawCounts = status === null || status === undefined ? null : status.counts ?? null
  const counts = rawCounts !== null && typeof rawCounts === 'object' ? rawCounts : null
  const byStatus = key => counts === null ? null : maybeInt(counts[key])
  const total = maybeInt(status?.lessons)
  const complete = total !== null && list.length >= total
  return {
    total,
    corrections: list.filter(row => row?.kind === 'correction').length,
    methods: list.filter(row => row?.kind === 'method').length,
    candidate: byStatus('candidate'),
    tested: byStatus('tested'),
    validated: byStatus('validated'),
    suspended: byStatus('suspended'),
    reviewed: list.filter(row => row?.review?.state === 'reviewed').length,
    trial: list.filter(row => row?.trial?.state === 'trial').length,
    adopted: maybeInt(status?.adopted),
    experiments: maybeInt(status?.experiments),
    storeCap: maybeInt(storeCap),
    scanned: list.length,
    complete,
    partial: complete !== true,
    unattributed: total === null ? null : Math.max(0, total - list.length),
    readable: true,
    code: null,
  }
}

/** The same block when nothing could be read: nulls and a code, never a zero that reads as empty. */
export function unreadableLibrary(code) {
  return { total: null, corrections: null, methods: null, candidate: null, tested: null, validated: null,
    suspended: null, reviewed: null, trial: null, adopted: null, experiments: null, storeCap: null,
    scanned: null, complete: false, partial: null, unattributed: null, readable: false,
    code: text(code ?? 'store_unavailable', 60) }
}

/**
 * What the stored plans alone prove about the automatic queue.
 *
 * Used only when no scheduler status surface answers: the stage counts and the newest reason are
 * real, while `scans`, `lastEvent` and `reviewTokens` stay NULL because the plans do not carry
 * them. A zero there would claim "nothing was ever scanned" for a scheduler that is merely out of
 * this projection's reach.
 */
export function plansDerivedStatus(plans) {
  const list = boundedList(plans, MAX_AUTO_PLANS)
  const count = stage => list.filter(plan => plan?.stage === stage).length
  const reasons = list.map(plan => text(plan?.reason, 64)).filter(reason => reason !== '')
  return { plans: list.length, queued: count('queued'), running: count('running'), done: count('done'),
    blocked: count('blocked'), failed: count('failed'), interrupted: count('interrupted'),
    lastReason: reasons.length === 0 ? null : reasons[reasons.length - 1], scans: null, lastEvent: null,
    reviewTokens: null }
}

/** Bounded projection of one scheduler status object; every unpublished scalar stays null. */
export function autoStatusOf(status, source) {
  if (status === null || status === undefined || typeof status !== 'object') return null
  const event = status.lastEvent
  return {
    source: text(source, 24),
    plans: maybeInt(status.plans), queued: maybeInt(status.queued), running: maybeInt(status.running),
    done: maybeInt(status.done), blocked: maybeInt(status.blocked), failed: maybeInt(status.failed),
    interrupted: maybeInt(status.interrupted), lastReason: text(status.lastReason ?? '', 64) || null,
    scans: maybeInt(status.scans),
    lastEvent: event === null || event === undefined || typeof event !== 'object' ? null
      : { at: maybeInt(event.at), code: text(event.code, 40), detail: text(event.detail, 60) || null },
    reviewTokens: maybeInt(status.reviewTokens),
  }
}


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
      const record = { id, createdAt: int(header?.createdAt), at: int(header?.createdAt), origin,
        label: labelOfScope(cwd), projectKey: cwd, scope: cwd === null ? 'instance' : 'project',
        scopeHash: cwd === null ? null : shortHash(cwd),
        live: live === true, persisted: entry?.persisted === true,
        archived: archived === null ? null : archived.has(id),
        running: agent === undefined || agent === null ? null : agent.status === 'running' }
      // The listed header rides along for the projection-cache lookup — its lifecycle identity
      // needs the real version/createdAt/cwd/isSeeded — but it is NOT enumerable, so it can never
      // appear in an RPC payload, a spread of the row, or a JSON dump of the directory.
      Object.defineProperty(record, 'header', { value: header, enumerable: false })
      records.push(record)
    }
    records.sort((left, right) => right.createdAt - left.createdAt || (left.id < right.id ? -1 : 1))
    return { ok: true, code: null, records: records.slice(0, MAX_SESSIONS), scanned: scan.length,
      excluded, truncated: records.length > MAX_SESSIONS || scan.length > MAX_SESSION_SCAN,
      archivedKnown: archived !== null, archivedError }
  }

  /**
   * The scope one request may read: a Host-observed session, or this plugin's instance scope.
   *
   * `listed` lets a caller that has already read the session directory hand it over, so one page
   * read does not list the Host's sessions twice; a caller without one gets a fresh read, which is
   * what makes a session created moments ago selectable.
   */
  async resolveScope(sessionId, listed = null) {
    if (sessionId === undefined || sessionId === null || sessionId === '') {
      return { ok: true, scope: { kind: 'instance', projectKey: undefined, sessionId: null,
        label: '默认作用域', scopeHash: null, record: null } }
    }
    const directory = listed ?? await this.directory()
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

  /**
   * The automatic plan covering each (lesson, version), newest bookkeeping last.
   *
   * Matching is by lesson id AND its current version: a plan that covered a version the row has
   * since left cannot explain the row any more and is not offered as its progress. Two tracks may
   * legitimately hold a plan for the same version — the most recently updated one is reported and
   * `track` says which it is, so the page never has to guess. An unreadable plan store yields an
   * empty index, i.e. "no plan", rather than a fabricated stage.
   */
  planIndex(engine) {
    const index = new Map()
    const plans = safeCall(() => engine.autoPlans())
    for (const plan of boundedList(plans, MAX_AUTO_PLANS)) {
      const key = planKey(plan?.lessonId, plan?.version)
      if (key === null) continue
      const current = index.get(key)
      if (current === undefined || int(plan.updatedAt) >= int(current.updatedAt)) index.set(key, plan)
    }
    return index
  }

  /**
   * The automatic scheduler's own status, from the first surface that can answer.
   *
   * The learning core's `autoValidation()` is asked first: it is the scheduler's own read-only
   * accessor on the live plan store, so it needs no settings read and no second service. The
   * control service's `runtime.auto` is the documented card payload and is used when the core
   * does not expose one; the stored plans are the last resort, and then only their stage counts
   * are claimed (see `plansDerivedStatus`). No surface answering is `auto: null` plus a code —
   * never a zero-filled block that would read as "the queue is empty".
   */
  autoOf(core, engine) {
    const direct = safeCall(() => typeof core?.autoValidation === 'function' ? core.autoValidation() : null)
    const fromCore = autoStatusOf(direct, 'mseLearning')
    if (fromCore !== null) return { auto: fromCore, autoError: null }
    const control = this.service('mseControl')
    const payload = safeCall(() => control !== null && typeof control.status === 'function' ? control.status() : null)
    const fromControl = autoStatusOf(payload?.runtime?.auto, 'mseControl')
    if (fromControl !== null) return { auto: fromControl, autoError: null }
    const plans = safeCall(() => typeof engine?.autoPlans === 'function' ? engine.autoPlans() : null)
    if (Array.isArray(plans)) return { auto: autoStatusOf(plansDerivedStatus(plans), 'plans'), autoError: null }
    return { auto: null, autoError: 'auto_status_unavailable' }
  }

  /**
   * How many sessions this process holds an in-process row for — NOT a count of turns.
   *
   * `observedTurns()` is the core's name for `bridge.trackedSessions()`, i.e. `statuses.size`.
   * A missing or non-numeric surface is null, and the page renders that as unknown: showing 0
   * after a restart would tell the operator their library is empty when nothing was read.
   */
  inProcessSessions(core) {
    const value = safeCall(() => typeof core?.observedTurns === 'function' ? core.observedTurns() : null)
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }

  /**
   * Every scope this process can NAME, bounded: this adapter's instance scope, then one entry
   * per distinct project the Host's own session directory reports (the directory already merges
   * persisted and in-memory headers, so a project seen in an earlier run is still named here).
   *
   * A directory that cannot be read is a code on the listing, not an empty list that would read
   * as an empty library; the instance scope is still scanned, so the answer is a partial read
   * with an explicit cause rather than no read at all.
   */
  libraryScopes(directory) {
    const scopes = [{ projectKey: undefined, label: '默认作用域', scopeHash: null, kind: 'instance', sessions: 0 }]
    const byProject = new Map()
    for (const record of directory.ok === true ? directory.records : []) {
      const projectKey = record.projectKey
      if (typeof projectKey !== 'string' || projectKey === '') continue
      const existing = byProject.get(projectKey)
      if (existing === undefined) {
        byProject.set(projectKey, { projectKey, label: record.label, scopeHash: record.scopeHash, kind: 'project', sessions: 1 })
      } else existing.sessions += 1
    }
    const all = [...scopes, ...byProject.values()]
    return { scopes: all.slice(0, MAX_LIBRARY_SCOPES), truncated: all.length > MAX_LIBRARY_SCOPES,
      named: all.length, code: directory.ok === true ? null : (directory.code ?? 'session_directory_unavailable') }
  }

  /**
   * One whole-library read: the rows of every scope this process can name, bounded and labelled.
   *
   * `inspect` answers for exactly one scope and the store exposes no cross-scope listing, so the
   * library view is the union over named scopes. Each row leaves through `progressRow`, which
   * projects, bounds and labels it — no stored document, no scope hash of the store's own making
   * and no terms/verifiedSessions ring reaches the caller. The first scope that cannot be read
   * fails the whole read with its code: a union that silently dropped a scope would understate
   * the library while looking complete.
   */
  readLibrary(engine, core, scopes) {
    const plans = this.planIndex(engine)
    const reviewRunTokens = this.autoOf(core, engine).auto?.reviewTokens ?? null
    const rows = []
    const projects = []
    let libraryTotal = null
    let storeCap = null
    let truncated = false
    for (const scope of scopes) {
      let inspected = null
      try {
        inspected = engine.inspect({ ...(scope.projectKey === undefined ? {} : { projectKey: scope.projectKey }),
          ...(core.environmentId === undefined ? {} : { environmentId: core.environmentId }) })
      } catch (error) { return { ok: false, code: text(error?.code ?? 'store_unavailable', 60) } }
      if (inspected === null || inspected === undefined || inspected.ok !== true) {
        return { ok: false, code: 'store_unavailable' }
      }
      libraryTotal = maybeInt(inspected.libraryTotal)
      storeCap = maybeInt(inspected.storeCap)
      const owned = boundedList(inspected.lessons, MAX_LIBRARY_ROWS)
      projects.push({ label: scope.label, scopeHash: scope.scopeHash, kind: scope.kind, sessions: scope.sessions,
        lessons: Array.isArray(inspected.lessons) ? inspected.lessons.length : 0 })
      for (const row of owned) {
        if (rows.length >= MAX_LIBRARY_ROWS) { truncated = true; break }
        rows.push(progressRow(row, plans.get(planKey(row.id, row.version)) ?? null, { reviewRunTokens, scope }))
      }
      if (truncated) break
    }
    // Newest first: a library view is read for "what happened lately", and the tie-break keeps
    // two rows with the same creation time in a stable order, so paging cannot reshuffle them.
    rows.sort((left, right) => right.createdAt - left.createdAt || (left.id < right.id ? -1 : 1))
    return { ok: true, code: null, rows, projects, libraryTotal, storeCap, truncated }
  }

  /**
   * The 经验 tab's guide: how many rows each named project holds, biggest first, bounded.
   *
   * It answers "where is the rest of the library" without pretending to be a scope selector —
   * selection stays with the Host's own session picker, and the count is the scope's own total,
   * not the filtered page.
   */
  guideOf(projects) {
    const named = boundedList(projects, MAX_LIBRARY_SCOPES)
      .map(project => ({ label: text(project.label, 48) || '默认作用域', scopeHash: project.scopeHash ?? null,
        kind: project.kind === 'project' ? 'project' : 'instance', lessons: int(project.lessons) }))
      .sort((left, right) => right.lessons - left.lessons || (left.label < right.label ? -1 : 1))
    return { selected: false, projects: named.slice(0, MAX_GUIDE_PROJECTS),
      omitted: Math.max(0, named.length - MAX_GUIDE_PROJECTS), note: 'whole_library_read_only' }
  }

  /**
   * Version, enablement, store readability, the WHOLE-LIBRARY counts, the selected project's own
   * counts, the automatic queue and the in-process session counter. No cross-session detail.
   *
   * The library block is the default answer on purpose: the instance scope is empty in daily use,
   * so reporting only it showed 0/0/0 while the real library sat unread. Reading the library here
   * widens no recall and no write scope — it is a count block plus, through `lessons()`, bounded
   * per-row projections that carry a label instead of a path.
   *
   * `counts`/`countsError` keep their exact previous meaning (the INSTANCE scope), so an existing
   * reader is unaffected; the selected project's numbers are added beside it as `scope`, and
   * `scope: null` with a `scopeReason` is the explicit "no project was selected".
   */
  async overview(input = {}) {
    const core = this.core()
    const engine = core === null ? null : this.engineOf(core)
    if (engine === null) return { ok: false, code: 'core_unavailable', version: this.version }
    let status = null
    let storeError = null
    try { status = engine.status() } catch (error) { storeError = text(error?.code ?? 'store_unavailable', 60) }
    const instanceScope = { kind: 'instance', projectKey: undefined, sessionId: null, label: '默认作用域', scopeHash: null,
      record: null }
    const info = this.scopeInfo(engine, instanceScope, core)
    const directory = await this.directory()
    const listing = this.libraryScopes(directory)
    const scan = this.readLibrary(engine, core, listing.scopes)
    const libraryCode = storeError ?? (scan.ok === true ? null : scan.code)
    const wanted = typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : null
    const resolved = wanted === null ? null : await this.resolveScope(wanted, directory)
    const selected = resolved !== null && resolved.ok === true ? resolved.scope : null
    const { auto, autoError } = this.autoOf(core, engine)
    const observed = this.inProcessSessions(core)
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
      // The whole library, scope-independent, plus the explicit statement of what was scanned.
      library: libraryCode === null ? libraryOf(scan.rows, status, { storeCap: scan.storeCap }) : unreadableLibrary(libraryCode),
      libraryScan: { scopes: listing.scopes.length, named: listing.named, rows: scan.ok === true ? scan.rows.length : null,
        truncated: listing.truncated || (scan.ok === true && scan.truncated === true), code: listing.code },
      // null + a reason, never the empty instance scope presented as the library.
      scope: selected === null ? null : this.scopeInfo(engine, selected, core),
      scopeReason: selected !== null ? null : (resolved === null ? 'no_scope_selected' : resolved.code),
      budget: { turnBytes: int(status?.budgetBytes ?? engine.budget), sessionBytes: int(status?.sessionBudgetBytes ?? 1536),
        maxLessons: int(status?.maxLessons ?? engine.maxLessons) },
      lessonsTotal: int(status?.lessons),
      adopted: int(status?.adopted), verified: int(status?.verified),
      // Two names for one measured fact: the accurate `sessionsObserved` and the historical
      // `turnsObserved` its consumers already read, both accompanied by the stable meaning string.
      sessionsObserved: observed,
      turnsObserved: observed,
      turnsObservedMeaning: TURNS_OBSERVED_MEANING,
      auto,
      autoError,
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

  /**
   * The Host's own title for one listed session, or null when no public projection can answer.
   *
   * It is read the way the Host's own listings read it (see `sessionTitle`): the live projection
   * cut for an attached session, the durable cache for a cold one. `header.title` is never
   * consulted, no log is folded, and one unreadable title is that row's null rather than a failed
   * directory. Only the rows actually being displayed are asked (the directory is already bounded
   * to `MAX_SESSIONS`), so a scope resolution never pays for titles.
   */
  sessionTitleOf(record) {
    return sessionTitle({ attached: this.attachedSession(record.id), header: record.header,
      projections: this.service('sessionProjections'), cache: this.service('sessionProjectionCache') })
  }

  /** The attached Session object for one id, or undefined when it is not live in this process. */
  attachedSession(id) {
    try {
      const sessions = this.service('sessions')
      return typeof sessions?.get === 'function' ? sessions.get(id) ?? undefined : undefined
    } catch { return undefined }
  }

  /**
   * The Host's own session directory: ids, trusted scope labels, titles, live/persisted/archived.
   *
   * `title` is display-only: it never takes part in the selection value (`id`), the scope identity
   * (`projectKey`/`scopeHash`/`scope`) or any core identity. A missing title is reported as null
   * and rendered by the client as an explicit untitled label.
   */
  async sessions() {
    const directory = await this.directory()
    if (directory.ok !== true) return { ok: false, code: directory.code, sessions: [] }
    return { ok: true, generatedAt: Date.now(), archivedKnown: directory.archivedKnown,
      archivedError: directory.archivedError ?? null, excludedInternal: directory.excluded,
      truncated: directory.truncated === true,
      sessions: directory.records.map(record => ({ id: record.id, createdAt: record.createdAt, at: record.at,
        label: record.label, title: this.sessionTitleOf(record), scope: record.scope,
        scopeHash: record.scopeHash, live: record.live,
        persisted: record.persisted, archived: record.archived, running: record.running })) }
  }

  /**
   * One bounded page of lessons, in one of two explicitly different reads.
   *
   * With a Host-resolved session: exactly that session's scope, as before. Without one: the WHOLE
   * LIBRARY — never the empty instance scope dressed up as the library, which is why the 经验 tab
   * opened empty while 23 records were in daily use. Every library row carries the display label
   * and one-way hash of the project that owns it, plus the guide that says how many records each
   * named project holds. Reading the library widens no recall and no write scope: recall still
   * selects inside the caller's own scope, and no row here is ever offered to it.
   */
  async lessons(input = {}) {
    const core = this.core()
    const engine = core === null ? null : this.engineOf(core)
    if (engine === null) return { ok: false, code: 'core_unavailable', version: this.version }
    const filter = { kind: oneOf(input.kind, ['correction', 'method']), status: oneOf(input.status, STATUSES),
      query: text(input.query, MAX_QUERY_CHARS) }
    const wanted = typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : null
    if (wanted === null) return this.libraryLessons(engine, core, input, filter)
    const resolved = await this.resolveScope(wanted)
    if (resolved.ok !== true) return { ok: false, code: resolved.code, version: this.version }
    const scope = resolved.scope
    let inspected = null
    try {
      inspected = engine.inspect({ ...(scope.projectKey === undefined ? {} : { projectKey: scope.projectKey }),
        ...(core.environmentId === undefined ? {} : { environmentId: core.environmentId }) })
    } catch (error) { return { ok: false, code: text(error?.code ?? 'store_unavailable', 60), version: this.version } }
    const plans = this.planIndex(engine)
    const reviewRunTokens = this.autoOf(core, engine).auto?.reviewTokens ?? null
    const filtered = filterLessons(inspected.lessons.map(row => progressRow(row,
      plans.get(planKey(row.id, row.version)) ?? null, { reviewRunTokens })), filter)
    const page = pageOf(filtered, { page: input.page, pageSize: input.pageSize })
    return { ok: true, generatedAt: Date.now(), version: this.version,
      library: false, scope: this.scopeInfo(engine, scope, core), scopeReason: null,
      scopeGuide: { selected: true, projects: [], omitted: 0, note: null },
      total: page.total, scopeTotal: inspected.scopeTotal, libraryTotal: inspected.libraryTotal,
      storeCap: inspected.storeCap, complete: inspected.scopeTotal <= inspected.storeCap,
      page: page.page, pageSize: page.pageSize, pages: page.pages, items: page.items }
  }

  /**
   * The whole-library page: the union over every scope this process can name, filtered and paged
   * with the same bounded helpers the scoped read uses.
   *
   * `scopeTotal` here is what this read could ATTRIBUTE to a named scope, and `unattributed` is
   * the rest of the store (rows whose project no observed session names): the page states the
   * difference instead of implying it listed everything. `partial` is the same single completeness
   * field the overview publishes (exactly `!complete`), so both halves of the library read can be
   * checked by one name.
   */
  async libraryLessons(engine, core, input, filter) {
    const directory = await this.directory()
    const listing = this.libraryScopes(directory)
    const scan = this.readLibrary(engine, core, listing.scopes)
    if (scan.ok !== true) return { ok: false, code: scan.code, version: this.version }
    const page = pageOf(filterLessons(scan.rows, filter), { page: input.page, pageSize: input.pageSize })
    const attached = scan.rows.length
    const complete = scan.libraryTotal !== null && attached >= scan.libraryTotal
    return { ok: true, generatedAt: Date.now(), version: this.version, library: true,
      scope: null, scopeReason: 'no_scope_selected', scopeGuide: this.guideOf(scan.projects),
      total: page.total, scopeTotal: attached, libraryTotal: scan.libraryTotal,
      partial: complete !== true,
      unattributed: scan.libraryTotal === null ? null : Math.max(0, scan.libraryTotal - attached),
      storeCap: scan.storeCap, complete,
      truncated: listing.truncated || scan.truncated === true, scanCode: listing.code,
      page: page.page, pageSize: page.pageSize, pages: page.pages, items: page.items }
  }

  /**
   * One lesson row located by id inside the scopes this process can NAME, read-only.
   *
   * This is the detail half of the whole-library read, and it exists because the two halves have
   * to agree: `lessons()` without a session offers rows from every named scope, so a detail that
   * resolved an empty session to the instance scope offered rows nobody could open (the r0 defect,
   * 0/23). The id is still the ONLY thing the browser contributes — a `projectKey` in the request
   * is never read here — so the browser cannot point this read at a scope the Host did not name,
   * and nothing here becomes a write, evaluation or recall scope.
   *
   * A row no named scope holds is refused as `lesson_unattributable` (it may belong to a project
   * no observed session names, which is exactly what the library read reports as `unattributed`),
   * and one id answered by two scopes is refused as `lesson_scope_ambiguous` instead of picking
   * one and showing the wrong record under this id.
   */
  async locateLesson(engine, core, id) {
    const directory = await this.directory()
    const listing = this.libraryScopes(directory)
    let found = null
    for (const scope of listing.scopes) {
      let inspected = null
      try {
        inspected = engine.inspect({ ...(scope.projectKey === undefined ? {} : { projectKey: scope.projectKey }),
          ...(core.environmentId === undefined ? {} : { environmentId: core.environmentId }), id })
      } catch (error) { return { ok: false, code: text(error?.code ?? 'store_unavailable', 60) } }
      if (inspected === null || inspected === undefined || inspected.ok !== true) {
        return { ok: false, code: 'store_unavailable' }
      }
      if (inspected.lessons.length === 0) continue
      // A second answer already decides it; no remaining scope can make the id unambiguous.
      if (found !== null) return { ok: false, code: 'lesson_scope_ambiguous' }
      found = { scope, row: inspected.lessons[0] }
    }
    if (found === null) return { ok: false, code: 'lesson_unattributable' }
    return { ok: true, scope: { kind: found.scope.kind, projectKey: found.scope.projectKey, sessionId: null,
      label: found.scope.label, scopeHash: found.scope.scopeHash, record: null }, row: found.row }
  }

  /**
   * One lesson's stored detail: inside one Host-resolved session's own scope when a session is
   * named, and inside the trusted named-scope set when it is not — the same set the whole-library
   * list reads, so every listed row can be opened. Both reads stay read-only.
   */
  async lesson(input = {}) {
    const core = this.core()
    const engine = core === null ? null : this.engineOf(core)
    if (engine === null) return { ok: false, code: 'core_unavailable', version: this.version }
    const id = text(input.id, 40)
    const wanted = typeof input.sessionId === 'string' && input.sessionId !== '' ? input.sessionId : null
    let scope = null
    let row = null
    if (wanted === null) {
      const located = await this.locateLesson(engine, core, id)
      if (located.ok !== true) return { ok: false, code: located.code, version: this.version }
      scope = located.scope
      row = located.row
    } else {
      const resolved = await this.resolveScope(wanted)
      if (resolved.ok !== true) return { ok: false, code: resolved.code }
      scope = resolved.scope
      let inspected = null
      try {
        inspected = engine.inspect({ ...(scope.projectKey === undefined ? {} : { projectKey: scope.projectKey }),
          ...(core.environmentId === undefined ? {} : { environmentId: core.environmentId }), id })
      } catch (error) { return { ok: false, code: text(error?.code ?? 'store_unavailable', 60), version: this.version } }
      row = inspected.lessons[0]
      if (row === undefined) return { ok: false, code: 'lesson_not_in_scope' }
    }
    let experiments = []
    let historyError = null
    try {
      experiments = engine.history({ lessonId: id, ...(scope.projectKey === undefined ? {} : { projectKey: scope.projectKey }) })
        .experiments ?? []
    } catch (error) { historyError = text(error?.code ?? 'history_unavailable', 60) }
    const reviewRunTokens = this.autoOf(core, engine).auto?.reviewTokens ?? null
    const plan = this.planIndex(engine).get(planKey(row.id, row.version)) ?? null
    return { ok: true, generatedAt: Date.now(), scope: this.scopeInfo(engine, scope, core),
      lesson: { ...projectDetail(row, experiments), ...progressFields(projectRow(row), row, plan, reviewRunTokens) },
      historyError }
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
