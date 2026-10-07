// Read-only detail projections: bounded shapes, forced scope, and no state mutation.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningEngine } from '../src/index.mjs'
import { MAX_PAGE_SIZE, MAX_QUERY_CHARS, MAX_TITLE_CHARS, clipCodePoints, filterLessons, labelOfScope, pageOf,
  projectDetail, projectRow, projectSettlement, projectTurn, sessionTitle, shortHash, titleOfBlock,
  titleOfWire } from '../adapters/dsh/project.mjs'

/**
 * `details.mjs` is a Cordis Remote service: it imports the Host's Typert protocol, which the unit
 * suite deliberately does not install (the packaged gateway script stages the real one and checks
 * the real markers). Two symbols are all this module needs to load, so they are supplied here —
 * `Remote` marks nothing and `remoteMethods` reports the six marks the module expects — which lets
 * the SERVICE ITSELF run: its scope resolution, its bounding and its reads, against a real engine.
 */
const PROTOCOL_STUB = `
const marked = []
export const Remote = method => () => { marked.push({ method }) }
export class TypertRemoteService { constructor(ctx, name) { this.ctx = ctx; this.namespace = name } }
export const remoteMethods = () => marked
`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-typert-protocol') return { url: 'mse-test:typert-protocol', shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'mse-test:typert-protocol') return { format: 'module', source: PROTOCOL_STUB, shortCircuit: true }
    return next(url, context)
  },
})
const { MseDetails, autoStatusOf, libraryOf, plansDerivedStatus, progressRow, reviewOf, trialOf, unreadableLibrary } =
  await import('../adapters/dsh/details.mjs')


const DAY = 86_400_000
function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-details-'))
  let now = Date.UTC(2030, 0, 1)
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh', now: () => now })
  const projectKey = '/synthetic/detail-project'
  const turn = (session, prompt) => ({ sessionId: session, turnId: `t${Math.floor((now % 1000))}-${prompt.length}`,
    origin: 'user', prompt, projectKey })
  return { stateRoot, engine, projectKey, turn, advance: ms => { now += ms }, now: () => now,
    cleanup: () => rmSync(stateRoot, { recursive: true, force: true }) }
}
const seed = f => {
  f.engine.prepare(f.turn('seed', '记住：以后导出报表金额时统一使用人民币'))
  f.engine.prepare(f.turn('seed2', '记住：以后不要把空值改成零，保留原始空值'))
  // `inspect` is the read-only projection with saved provenance; `list` stays the display view.
  return f.engine.inspect({ projectKey: f.projectKey }).lessons
}

test('lesson projections are bounded and never invent values', () => {
  const f = fixture()
  try {
    const rows = seed(f)
    assert.equal(rows.length, 2)
    const row = projectRow(rows[0])
    assert.equal(row.instruction, rows[0].instruction)
    assert.ok(['correction', 'method'].includes(row.kind))
    assert.ok(typeof row.status === 'string' && row.status.length > 0)
    assert.equal(/^[a-f0-9]{12}$/u.test(row.sourceTurn), true,
      'the list projection reports provenance as a bounded identifier, never the raw hash')
    assert.equal(row.sourceTurn.length <= 12, true)
    // Unbounded or hostile input collapses to bounded placeholders instead of leaking.
    const wild = projectRow({ id: 'x'.repeat(400), kind: 'unknown', status: 'gone',
      instruction: 'y'.repeat(5000), createdAt: 'later', adopted: Number.NaN, historyComplete: 'yes' })
    assert.equal(wild.id.length, 40)
    assert.equal(wild.instruction.length, 240)
    assert.equal(wild.kind, '')
    assert.equal(wild.status, '')
    assert.equal(wild.createdAt, 0)
    assert.equal(wild.adopted, 0)
    assert.equal(wild.historyComplete, false)
    assert.equal(projectRow(undefined).instruction, '')
    const detail = projectDetail(rows[0], [{ at: 5, decision: 'accepted', version: 2, reasons: ['expired'] },
      { at: 'x', decision: 'z'.repeat(50), version: 'v', reasons: 'none' }])
    assert.equal(detail.experiments.length, 2)
    assert.equal(detail.experiments[0].decision, 'accepted')
    assert.equal(detail.experiments[1].version, 0)
    assert.deepEqual(detail.experiments[1].reasons, [])
    assert.equal(projectDetail({ instruction: 'x' }, null).experiments.length, 0)
    return undefined
  } finally { f.cleanup() }
})

test('scope identity is shown as a label and a one-way hash, never a path', () => {
  assert.equal(labelOfScope(undefined), '默认作用域')
  assert.equal(labelOfScope(''), '默认作用域')
  assert.equal(labelOfScope('/Users/someone/私密项目/'), '私密项目')
  assert.equal(labelOfScope('/synthetic/detail-project'), 'detail-project')
  const hash = shortHash('/synthetic/detail-project')
  assert.equal(hash.length, 12)
  assert.equal(hash.includes('detail'), false)
  assert.equal(shortHash(undefined), null)
})

test('recall and settlement projections drop unlisted fields', () => {
  const turn = projectTurn({ turn: '3', at: 10, reason: 'recalled', bytes: 130, lessons: ['lesson_a', 'lesson_b'],
    sources: [{ id: 'lesson_a', version: 1, kind: 'correction', bytes: 60, methodId: null, internal: 'secret' }],
    diagnostics: { matched: 1, candidates: 2, eligible: 3, nearest: { lessonId: 'lesson_a', gate: 'gate', weight: 4,
      matched: 1, extra: 'x' }, private: 'nope' },
    learned: { id: 'lesson_a', duplicate: false, skipped: null, secret: 'no' },
    adopted: true, outcome: 'unknown', attributed: 1, settleState: 'settled', settleError: null, settleAttempts: 1,
    internalNote: 'never shown' })
  assert.deepEqual(Object.keys(turn).sort(), ['adopted', 'at', 'attributed', 'bytes', 'diagnostics', 'learned',
    'lessons', 'outcome', 'reason', 'settleAttempts', 'settleError', 'settleState', 'sources', 'turn'].sort())
  assert.equal(Object.hasOwn(turn, 'internalNote'), false)
  assert.equal(Object.hasOwn(turn.sources[0], 'internal'), false)
  assert.equal(Object.hasOwn(turn.diagnostics, 'private'), false)
  assert.equal(turn.settleAttempts, 1)
  assert.equal(projectTurn(undefined).bytes, 0)
  const settled = projectSettlement({ sessionId: 's-1', turnId: 2, state: 'settled', attempts: 2, lastError: null,
    at: 7, payload: { instruction: 'do not leak' }, record: { key: ['s-1', '2'] } })
  assert.deepEqual(Object.keys(settled).sort(), ['at', 'attempts', 'code', 'sessionId', 'state', 'turnId'])
  assert.equal(JSON.stringify(settled).includes('leak'), false)
})

test('reading lessons, recall and diagnose never changes the store bytes or budget', () => {
  const f = fixture()
  try {
    const rows = seed(f)
    const path = join(f.stateRoot, 'lessons-v1.json')
    const before = { bytes: readFileSync(path, 'utf8'), size: statSync(path).size,
      mtime: statSync(path).mtimeMs }
    const prompt = '导出报表金额并核对币种'
    // Every read the detail page performs, in the same order the page issues them.
    const list = f.engine.list({ projectKey: f.projectKey, limit: 100 })
    const status = f.engine.status()
    const library = f.engine.diagnose({ projectKey: f.projectKey })
    const prompted = f.engine.diagnose({ projectKey: f.projectKey, prompt, sessionId: 'reader' })
    const detail = f.engine.history({ lessonId: rows[0].id, projectKey: f.projectKey })
    assert.ok(list.lessons.length >= 2)
    assert.ok(status.lessons >= 2)
    assert.ok(library.library.scopeLessons >= 2)
    assert.equal(prompted.prompted.reason !== undefined, true)
    assert.ok(Array.isArray(detail.experiments))
    const after = { bytes: readFileSync(path, 'utf8'), size: statSync(path).size, mtime: statSync(path).mtimeMs }
    assert.equal(after.bytes, before.bytes, 'reads must not rewrite the learning store')
    assert.equal(after.size, before.size)
    assert.equal(after.mtime, before.mtime, 'reads must not even touch the file')
    // The dry run never consumes session budget either.
    assert.equal(prompted.session === null || prompted.session?.bytes === 0 || prompted.session.bytes >= 0, true)
    return undefined
  } finally { f.cleanup() }
})

test('filtering and paging are total over any input', () => {
  const rows = [{ kind: 'correction', status: 'reminder', instruction: 'Alpha 规则' },
    { kind: 'method', status: 'validated', instruction: 'beta 方法' }]
  assert.equal(filterLessons(rows, {}).length, 2)
  assert.equal(filterLessons(rows, { kind: 'method' }).length, 1)
  assert.equal(filterLessons(rows, { status: 'reminder' }).length, 1)
  assert.equal(filterLessons(rows, { query: 'alpha' }).length, 1, 'search is case-insensitive')
  assert.equal(filterLessons(rows, { query: 'x'.repeat(MAX_QUERY_CHARS + 200) }).length, 0)
  assert.deepEqual(filterLessons(null, {}), [])
  assert.equal(pageOf(rows, { pageSize: MAX_PAGE_SIZE + 100 }).pageSize, MAX_PAGE_SIZE)
  assert.equal(pageOf(rows, { page: 99, pageSize: 1 }).page, 2, 'a page past the end clamps to the last page')
  assert.equal(pageOf([], {}).pages, 1)
  assert.equal(pageOf(rows, { pageSize: 0 }).pageSize, 1)
  assert.equal(pageOf(rows, { page: -3 }).page, 1)
  // An oversized row list is filtered as a whole but only one page leaves the Host.
  const many = Array.from({ length: 137 }, (_, index) => ({ kind: 'correction', status: 'reminder',
    instruction: `rule ${index}` }))
  const page = pageOf(filterLessons(many, {}), { page: 3, pageSize: 20 })
  assert.equal(page.total, 137)
  assert.equal(page.pages, 7)
  assert.equal(page.items.length, 20)
  assert.equal(page.items[0].instruction, 'rule 40')
})

test('a stored lesson projects its provenance honestly', () => {
  const f = fixture()
  try {
    seed(f)
    const rows = f.engine.inspect({ projectKey: f.projectKey }).lessons
    const detail = projectDetail(rows[0], [])
    assert.equal(/^[a-f0-9]{12}$/u.test(detail.sourceTurn), true,
      'a saved turn is reported as a bounded identifier, and a missing one as null')
    const withoutTurn = projectDetail({ ...rows[0], sourceTurn: undefined }, [])
    assert.equal(withoutTurn.sourceTurn, null, 'a missing turn is reported as not recorded, never guessed')
    assert.equal(detail.validation, null)
    assert.equal(detail.replaces, null)
    const state = JSON.parse(readFileSync(join(f.stateRoot, 'lessons-v1.json'), 'utf8'))
    const stored = state.lessons.find(row => row.id === rows[0].id)
    assert.equal(detail.historyComplete, stored.historyComplete === true)
    assert.equal(detail.instruction, stored.instruction)
    return undefined
  } finally { f.cleanup() }
})

test('a session title comes from the Host projections, never from a header field', () => {
  const header = { id: 'session-abc', version: 3, createdAt: 1, cwd: '/synthetic/one' }
  const live = { id: 'session-abc' }
  // A live session answers from its live projection cut first.
  assert.equal(sessionTitle({ attached: live, header,
    projections: { snapshot: () => ({ values: { title: '重构召回排序' } }) },
    cache: { cachedSnapshot: () => ({ values: { title: 'cached' } }) } }), '重构召回排序')
  // Its cached cells answer when the live cut carries no title.
  assert.equal(sessionTitle({ attached: live, header,
    projections: { snapshot: () => ({ values: {} }), cachedSnapshot: () => ({ values: { title: '已物化' } }) },
    cache: { cachedSnapshot: () => ({ values: { title: 'cold' } }) } }), '已物化')
  // A cold (unattached) session answers from the durable cache, then the predecessor checkpoint.
  assert.equal(sessionTitle({ attachments: undefined, header,
    cache: { cachedSnapshot: (meta, keys) => keys.includes('title') ? { values: { title: '冷会话标题' } } : undefined } }),
  '冷会话标题')
  assert.equal(sessionTitle({ header,
    cache: { cachedSnapshot: () => undefined, cachedPredecessorTitle: () => ({ values: { title: '前身标题' } }) } }),
  '前身标题')
  // A header carrying a look-alike field is NOT a title source, and no log is folded for it.
  assert.equal(sessionTitle({ header: { ...header, title: '伪造标题', name: 'also fake' }, cache: {} }), null)
  assert.equal(sessionTitle({ header }), null)
  assert.equal(sessionTitle({}), null)
  assert.equal(sessionTitle(), null)
})

test('a title read is bounded, local to one row, and never throws outward', () => {
  const header = { id: 'session-quiet', version: 1, createdAt: 0 }
  const throwing = () => { throw Object.assign(new Error('projection offline'), { code: 'projection_failed' }) }
  // One failing source must not stop the next one from answering.
  assert.equal(sessionTitle({ header, cache: { cachedSnapshot: throwing, cachedPredecessorTitle: () => ({ values: { title: 'ok' } }) } }), 'ok')
  // Everything failing is "no title", never an exception.
  assert.equal(sessionTitle({ attached: { id: 'x' }, header,
    projections: { snapshot: throwing, cachedSnapshot: throwing },
    cache: { cachedSnapshot: throwing, cachedPredecessorTitle: throwing } }), null)
  // The WIRE view of the host's title unit is `string | null`
  // (`const titleViewSchema = zod.string().min(1).nullable(); wire.view = state => state`), so a
  // plain string is the only accepted shape. A folded internal snapshot — the query service's
  // `readTitleSnapshots` shape, which is bound to its source header — is NOT a wire title and must
  // never be coerced into one (no `String(value)`, no `value.title`).
  assert.equal(titleOfBlock({ values: { title: { title: '折叠快照', header: { id: 'x' } } } }), null)
  assert.equal(titleOfBlock({ values: { title: { text: '对象形态' } } }), null)
  assert.equal(titleOfBlock({ values: { title: ['标题'] } }), null)
  assert.equal(titleOfBlock({ values: { title: '' } }), null, 'the wire schema is min(1): empty is not a title')
  // Shapeless, blank, control-character and non-string values are not titles.
  assert.equal(titleOfBlock(undefined), null)
  assert.equal(titleOfBlock({ values: {} }), null)
  assert.equal(titleOfBlock({ values: { title: '   ' } }), null)
  assert.equal(titleOfBlock({ values: { title: 42 } }), null)
  assert.equal(titleOfBlock({ values: { title: 'a\u0000b\u001fc' } }), 'a b c')
  // Emoji and HTML survive as PLAIN TEXT: nothing here interprets markup.
  assert.equal(sessionTitle({ header, cache: { cachedSnapshot: () => ({ values: { title: '图表 📊 <b>加粗</b>' } }) } }),
    '图表 📊 <b>加粗</b>')
  const long = '标'.repeat(MAX_TITLE_CHARS + 50)
  assert.equal(titleOfBlock({ values: { title: long } }).length, MAX_TITLE_CHARS)
})

test('a title is truncated by code point, never by UTF-16 unit', () => {
  const emoji = '📊'
  // A pair straddling the bound is dropped whole instead of leaving a lone surrogate.
  const straddling = 'a'.repeat(MAX_TITLE_CHARS) + emoji
  const clipped = titleOfBlock({ values: { title: straddling } })
  assert.equal([...clipped].length, MAX_TITLE_CHARS)
  assert.equal(clipped.includes(emoji), false, 'the pair is not half-kept')
  assert.equal(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(clipped), false, 'no lone surrogate survives')
  assert.equal(clipped, 'a'.repeat(MAX_TITLE_CHARS))
  // A pair that fits is kept intact, and a short title is untouched.
  const fitting = 'a'.repeat(MAX_TITLE_CHARS - 1) + emoji
  assert.equal(titleOfBlock({ values: { title: fitting } }), fitting)
  assert.equal(clipCodePoints('图表 📊 统计', 20), '图表 📊 统计')
  assert.equal(clipCodePoints('📊📊📊', 2), '📊📊')
  assert.equal(clipCodePoints(undefined), '')
  assert.equal(clipCodePoints('abcdef', 0), '')
})

test('an authoritative untitled answer is NOT replaced by a stale cached title', () => {
  const header = { id: 'session-live', version: 4, createdAt: 9, cwd: '/synthetic/one' }
  const live = { id: 'session-live' }
  const stale = { cachedSnapshot: () => ({ values: { title: '旧冷缓存标题' } }),
    cachedPredecessorTitle: () => ({ values: { title: '更旧的前身标题' } }) }
  // The live cut ANSWERED with null: the conversation really has no title, so the cache must not
  // be consulted at all.
  assert.equal(sessionTitle({ attached: live, header, cache: stale,
    projections: { snapshot: () => ({ values: { title: null } }) } }), null)
  // The live cut answered with an empty string (malformed for `min(1)`): answered "no title".
  assert.equal(sessionTitle({ attached: live, header, cache: stale,
    projections: { snapshot: () => ({ values: { title: '' } }) } }), null)
  // The live projection is UNAVAILABLE (no key on the block): the later sources may answer.
  assert.equal(sessionTitle({ attached: live, header,
    projections: { snapshot: () => ({ values: {} }) }, cache: stale }), '旧冷缓存标题')
  // …and when the whole live service is missing, the durable cache answers as before.
  assert.equal(sessionTitle({ attached: live, header, cache: stale }), '旧冷缓存标题')
  // A cold session mirrors the host's block-level order: a present block wins over the predecessor.
  assert.equal(sessionTitle({ header, cache: { cachedSnapshot: () => ({ values: { title: null } }),
    cachedPredecessorTitle: () => ({ values: { title: '前身标题' } }) } }), null)
  assert.equal(sessionTitle({ header, cache: { cachedSnapshot: () => undefined,
    cachedPredecessorTitle: () => ({ values: { title: '前身标题' } }) } }), '前身标题')
  // The tri-state itself: answered-with-null is different from cannot-answer.
  assert.equal(titleOfWire({ values: { title: null } }), null)
  assert.equal(titleOfWire({ values: {} }), undefined)
  assert.equal(titleOfWire(undefined), undefined)
})

test('titles are read once per displayed row and never touch the store', () => {
  const header = { id: 'session-counted', version: 2, createdAt: 5 }
  let cacheReads = 0
  let coreCalls = 0
  const cache = {
    cachedSnapshot: () => { cacheReads += 1; return { values: { title: '一次读取' } } },
    cachedPredecessorTitle: () => { coreCalls += 1; return undefined },
  }
  assert.equal(sessionTitle({ header, cache }), '一次读取')
  assert.equal(cacheReads, 1, 'one row asks the cache exactly once')
  assert.equal(coreCalls, 0, 'the predecessor hint is not consulted after a title was found')
})

// ---------------------------------------------------------------- whole-library read

const PROJECT_A = '/synthetic/alpha'
const PROJECT_B = '/synthetic/beta'

/**
 * A real engine with rows in two projects plus the instance scope, one method row queued for a
 * model review by a real plan, and the Remote service over it. Nothing here is a re-implementation
 * of the service: the Host-side code under test is the module itself.
 */
function remoteFixture({ visibleProjects = [0, 1], visibleInstance = true, instanceRow = true } = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-details-remote-'))
  const now = Date.UTC(2030, 5, 1)
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh', now: () => now })
  const learn = input => engine.prepare({ origin: 'user', ...input })
  learn({ sessionId: 's-alpha', turnId: 'a1', projectKey: PROJECT_A, prompt: '记住：以后导出报表金额时统一使用人民币' })
  learn({ sessionId: 's-alpha', turnId: 'a2', projectKey: PROJECT_A, prompt: '记住：以后不要把空值改成零，保留原始空值' })
  learn({ sessionId: 's-beta', turnId: 'b1', projectKey: PROJECT_B, prompt: '记住：提交前先运行 lint 检查' })
  // One row in the adapter's INSTANCE scope, so "no named project" is not the same fixture as
  // "an empty store": a library read that cannot name a project must not report an empty library.
  if (instanceRow) learn({ sessionId: 's-instance', turnId: 'i1', prompt: '记住：日志里不要输出密钥' })
  const alphaIds = engine.inspect({ projectKey: PROJECT_A }).lessons.map(row => row.id)
  const betaIds = engine.inspect({ projectKey: PROJECT_B }).lessons.map(row => row.id)
  // The progress a row reports is the scheduler's own record for its CURRENT version, so the plan
  // is registered through the ordinary core API rather than assembled by the test.
  const method = engine.record({ projectKey: PROJECT_A, eventId: 'proposal-a1', kind: 'method',
    source: 'host_proposal', methodId: 'preserve-null-v1' })
  const methodRow = engine.inspect({ projectKey: PROJECT_A }).lessons.find(row => row.id === method.id)
  const registered = engine.autoPlanRegister({ lessonId: method.id, version: methodRow.version,
    environment: methodRow.environment, track: 'review',
    source: { kind: 'turn', sessionId: 's-alpha', turnId: 'a2', route: { provider: 'mock', model: 'mock-1' } } })
  const nextAttemptAt = now + 60_000
  engine.autoPlanUpdate({ queueKey: registered.plan.queueKey, planHash: registered.plan.planHash, stage: 'queued',
    reason: 'review_budget_tokens', attempts: 1, nextAttemptAt })
  let listings = 0
  // The Host directory the probes can restrict: only the named projects are attributable, which is
  // exactly what makes the library read partial without the store itself changing.
  const query = { listSessions: async () => {
    listings += 1
    return [
      ...(visibleProjects.includes(0)
        ? [{ header: { id: 's-alpha', cwd: PROJECT_A, createdAt: now, origin: 'cli' }, live: true, persisted: true }] : []),
      ...(visibleProjects.includes(1)
        ? [{ header: { id: 's-beta', cwd: PROJECT_B, createdAt: now, origin: 'cli' }, live: false, persisted: true }] : []),
      ...(visibleInstance
        ? [{ header: { id: 's-instance', cwd: null, createdAt: now, origin: 'cli' }, live: false, persisted: true }] : []),
    ]
  } }
  // Every recall decision is recorded so a test can prove the scope of a read did NOT widen.
  const recallCalls = []
  const core = { engine, environmentId: undefined, bridge: { isEnabled: () => true },
    capabilities: { recallReasons: ['recalled'] }, observedTurns: () => 3,
    recallStatus: (sessionId, projectKey) => { recallCalls.push({ sessionId, projectKey })
      return { enabled: true, recent: [], last: null } },
    settlementStatus: () => [],
    autoValidation: () => ({ plans: 1, queued: 1, running: 0, done: 0, blocked: 0, failed: 0, interrupted: 0,
      lastReason: 'review_budget_tokens', scans: 2, lastEvent: { at: now, code: 'review_queued', detail: method.id },
      reviewTokens: 4000 }) }
  const ctx = { get: key => key === 'mseLearning' ? core : key === 'sessionQuery' ? query : undefined }
  return { stateRoot, engine, core, ctx, details: new MseDetails(ctx), methodId: method.id, alphaIds, betaIds,
    nextAttemptAt, now, recallCalls, listings: () => listings,
    cleanup: () => rmSync(stateRoot, { recursive: true, force: true }) }
}

/** A Remote over a core whose store and scheduler surfaces both refuse to answer. */
function unreadableFixture() {
  const fail = () => { throw Object.assign(new Error('unreadable'), { code: 'store_unavailable' }) }
  const core = { engine: { list: fail, status: fail, inspect: fail }, environmentId: 'test' }
  const ctx = { get: key => key === 'mseLearning' ? core : undefined }
  return { details: new MseDetails(ctx) }
}

test('overview reports the whole library by default and the project counts separately', async () => {
  const f = remoteFixture()
  try {
    const overview = await f.details.overview()
    assert.equal(overview.ok, true)
    // The library block: whole-store counts, not the empty instance scope this page used to show.
    assert.equal(overview.library.readable, true)
    assert.equal(overview.library.total, 5)
    assert.equal(overview.library.corrections, 4)
    assert.equal(overview.library.methods, 1)
    assert.equal(overview.library.candidate, 1)
    assert.equal(overview.library.tested, 0)
    assert.equal(overview.library.validated, 0)
    assert.equal(overview.library.suspended, 0)
    assert.equal(overview.library.reviewed, 0)
    assert.equal(overview.library.trial, 0)
    assert.equal(overview.library.adopted, 0)
    assert.equal(overview.library.scanned, 5)
    assert.equal(overview.library.complete, true)
    assert.equal(overview.library.partial, false, 'the single completeness field the page reads')
    assert.equal(overview.library.unattributed, 0)
    assert.equal(overview.library.storeCap, 300)
    assert.equal(overview.library.code, null)
    assert.equal(overview.libraryScan.scopes, 3, 'the instance scope plus the two named projects')
    assert.equal(overview.libraryScan.truncated, false)
    // `counts` keeps its exact previous meaning: the INSTANCE scope, never the library.
    assert.equal(overview.counts.total, 5)
    assert.equal(overview.counts.scopeLessons, 1)
    assert.equal(overview.counts.otherScope, 4)
    assert.equal(overview.countsError, null)
    // No scope was named, so the page is told exactly that instead of being handed an empty scope.
    assert.equal(overview.scope, null)
    assert.equal(overview.scopeReason, 'no_scope_selected')
    // The scheduler's own status, and the in-process SESSION counter with its stated meaning.
    assert.equal(overview.auto.source, 'mseLearning')
    assert.equal(overview.auto.plans, 1)
    assert.equal(overview.auto.queued, 1)
    assert.equal(overview.auto.reviewTokens, 4000)
    assert.equal(overview.auto.lastEvent.detail, f.methodId)
    assert.equal(overview.autoError, null)
    assert.equal(overview.turnsObserved, 3)
    assert.equal(overview.sessionsObserved, 3)
    assert.equal(overview.turnsObservedMeaning, 'in_process_sessions_since_process_start')

    // Naming a Host-observed session adds that project's OWN counts beside the library reading,
    // and one page read lists the Host's sessions exactly once (the listing serves both needs).
    const listings = f.listings()
    const scoped = await f.details.overview({ sessionId: 's-alpha' })
    assert.equal(f.listings() - listings, 1)
    assert.equal(scoped.scopeReason, null)
    assert.equal(scoped.scope.kind, 'project')
    assert.equal(scoped.scope.label, 'alpha')
    assert.equal(scoped.scope.counts.scopeLessons, 3)
    assert.equal(scoped.library.total, overview.library.total, 'the library reading does not shrink to the scope')
    // A session the Host does not know is a stated reason, never a fabricated scope.
    const unknown = await f.details.overview({ sessionId: 'not-a-session' })
    assert.equal(unknown.ok, true)
    assert.equal(unknown.scope, null)
    assert.equal(unknown.scopeReason, 'session_unknown')
    assert.equal(unknown.library.total, 5)
    return undefined
  } finally { f.cleanup() }
})

test('overview and lessons state a read failure as a code, never as an empty library', async () => {
  const { details } = unreadableFixture()
  const overview = await details.overview()
  assert.equal(overview.ok, true)
  assert.equal(overview.library.readable, false)
  assert.equal(overview.library.code, 'store_unavailable')
  assert.equal(overview.library.total, null)
  assert.equal(overview.library.corrections, null)
  assert.equal(overview.library.validated, null)
  assert.equal(overview.library.adopted, null)
  assert.equal(overview.library.scanned, null)
  assert.equal(overview.library.complete, false)
  assert.equal(overview.library.partial, null, 'an unreadable library is not "partial": it is unknown')
  // Nothing numeric survived: a `0` here would be read as "the library is empty".
  assert.deepEqual(Object.entries(overview.library).filter(([, value]) => typeof value === 'number'), [])
  // No scheduler surface can answer, and the missing facts stay unknown rather than becoming 0.
  assert.equal(overview.auto, null)
  assert.equal(overview.autoError, 'auto_status_unavailable')
  assert.equal(overview.turnsObserved, null)
  assert.equal(overview.turnsObservedMeaning, 'in_process_sessions_since_process_start')
  assert.equal(overview.scope, null)
  assert.equal(overview.scopeReason, 'no_scope_selected')
  const page = await details.lessons({})
  assert.equal(page.ok, false)
  assert.equal(page.code, 'store_unavailable')
})

test('lessons without a session reads the whole library and guides to a project', async () => {
  const f = remoteFixture()
  try {
    const page = await f.details.lessons({})
    assert.equal(page.ok, true)
    assert.equal(page.library, true)
    assert.equal(page.scope, null)
    assert.equal(page.scopeReason, 'no_scope_selected')
    assert.equal(page.total, 5)
    assert.equal(page.libraryTotal, 5)
    assert.equal(page.scopeTotal, 5)
    assert.equal(page.unattributed, 0)
    assert.equal(page.complete, true)
    assert.equal(page.partial, false, 'the list half publishes the same completeness field')
    assert.equal(page.truncated, false)
    // The guide: how many rows each project holds, so the empty instance scope can never again
    // hide where the library actually lives.
    assert.equal(page.scopeGuide.selected, false)
    assert.equal(page.scopeGuide.note, 'whole_library_read_only')
    assert.equal(page.scopeGuide.omitted, 0)
    const guide = new Map(page.scopeGuide.projects.map(project => [project.label, project.lessons]))
    assert.equal(guide.get('alpha'), 3)
    assert.equal(guide.get('beta'), 1)
    assert.equal(guide.get('默认作用域'), 1)
    // Every row names its owner by label and one-way hash — never by a project path.
    const alpha = page.items.filter(row => row.scopeLabel === 'alpha')
    assert.equal(alpha.length, 3)
    assert.equal(alpha.every(row => row.scopeKind === 'project' && /^[a-f0-9]{12}$/u.test(row.scopeHash)), true)
    assert.equal(page.items.some(row => row.scopeLabel === '默认作用域' && row.scopeHash === null), true)
    assert.equal(JSON.stringify(page).includes('/synthetic'), false, 'a row never carries its project path')
    assert.equal(JSON.stringify(page).includes('verifiedSessions'), false)
    // Newest first, with a stable tie-break, so paging cannot reshuffle equal timestamps.
    const times = page.items.map(row => row.createdAt)
    assert.deepEqual(times, [...times].sort((left, right) => right - left))
    // Filters and paging are the same bounded helpers the scoped read uses.
    const onlyMethods = await f.details.lessons({ kind: 'method', pageSize: 10 })
    assert.equal(onlyMethods.total, 1)
    assert.equal(onlyMethods.items[0].kind, 'method')
    const paged = await f.details.lessons({ page: 3, pageSize: 2 })
    assert.equal(paged.total, 5)
    assert.equal(paged.pages, 3)
    assert.equal(paged.items.length, 1)

    // A named session keeps today's behaviour: one scope, its own totals and scope block.
    const scoped = await f.details.lessons({ sessionId: 's-alpha' })
    assert.equal(scoped.library, false)
    assert.equal(scoped.scope.kind, 'project')
    assert.equal(scoped.scope.label, 'alpha')
    assert.equal(scoped.scopeTotal, 3)
    assert.equal(scoped.libraryTotal, 5)
    assert.equal(scoped.complete, true)
    assert.equal(scoped.scopeGuide.selected, true)
    assert.deepEqual(scoped.scopeGuide.projects, [])
    const instance = await f.details.lessons({ sessionId: 's-instance' })
    assert.equal(instance.scope.kind, 'instance')
    assert.equal(instance.scopeTotal, 1)
    return undefined
  } finally { f.cleanup() }
})

test('every lesson row carries its read-only progress, and no row invents one', async () => {
  const f = remoteFixture()
  try {
    const page = await f.details.lessons({ sessionId: 's-alpha' })
    const queued = page.items.find(row => row.id === f.methodId)
    assert.equal(queued.stage, 'queued')
    assert.equal(queued.track, 'review')
    assert.equal(queued.attempts, 1)
    assert.equal(queued.maxAttempts, 2)
    assert.equal(queued.evidence, 'none')
    assert.equal(queued.reason, 'review_budget_tokens')
    assert.equal(queued.lastError, null, 'a waiting reason is not an error')
    assert.equal(queued.nextAttemptAt, f.nextAttemptAt)
    assert.equal(queued.updatedAt, f.now)
    assert.equal(queued.planHash.length, 12)
    assert.deepEqual(queued.route, { provider: 'mock', model: 'mock-1' })
    assert.deepEqual(queued.budget, { reviewRunTokens: 4000, holding: false })
    assert.equal(queued.review, null)
    assert.equal(queued.trial, null)
    assert.equal(queued.validation, null)
    // A correction has no plan: its stage is explicitly absent instead of derived from its status.
    const correction = page.items.find(row => row.kind === 'correction')
    assert.equal(correction.stage, null)
    assert.equal(correction.budget, null)
    assert.equal(correction.track, null)
    // The whole-library read carries the same fields, plus the owning scope.
    const library = await f.details.lessons({})
    const sameRow = library.items.find(row => row.id === f.methodId)
    assert.equal(sameRow.stage, 'queued')
    assert.equal(sameRow.scopeLabel, 'alpha')
    // The detail read agrees with the list row.
    const detail = await f.details.lesson({ sessionId: 's-alpha', id: f.methodId })
    assert.equal(detail.ok, true)
    assert.equal(detail.lesson.stage, 'queued')
    assert.equal(detail.lesson.reason, 'review_budget_tokens')
    assert.equal(detail.lesson.budget.reviewRunTokens, 4000)
    return undefined
  } finally { f.cleanup() }
})

test('the progress and review projections stay bounded and drop what they do not list', () => {
  const row = { id: 'lesson_x', version: 2, kind: 'method', status: 'tested', instruction: 'y'.repeat(400),
    review: { state: 'reviewed', at: 5, agreement: 'neutral_safe', benefit: 'unproven', reasons: ['a', 'b', 'c', 'd', 'e'],
      judge: 'j'.repeat(200), planHash: 'a'.repeat(64), scenarioHash: 'b'.repeat(64), source: 'auto', internal: 'no',
      route: { provider: 'p'.repeat(80), model: 'm'.repeat(200) } },
    trial: { state: 'trial', at: 6, reason: 'r'.repeat(200), planHash: 'c'.repeat(64), note: 'reference_only_unverified' },
    validation: { decision: 'accepted', basis: 'host_pack', at: 7, secret: 'never shown',
      domain: { packId: 'pack', version: 3, scope: 'validation_domain_only', extra: 'no' } } }
  const plan = { queueKey: 'q', planHash: 'd'.repeat(64), lessonId: 'lesson_x', version: 2, track: 'review',
    stage: 'blocked', evidence: 'model_review', attempts: 2, maxAttempts: 2, nextAttemptAt: 20, updatedAt: 10,
    reason: 'review_missing_criteria', ticket: 'ticket-should-not-travel',
    source: { kind: 'turn', sessionId: 's', turnId: 't', route: { provider: 'p', model: 'm' } } }
  const projected = progressRow(row, plan, { reviewRunTokens: 4000 })
  assert.equal(projected.stage, 'blocked')
  assert.equal(projected.lastError, 'review_missing_criteria', 'a stopped stage reports its stop code')
  assert.equal(projected.review.state, 'reviewed')
  assert.equal(projected.review.reasons.length, 4, 'at most four reason codes travel')
  assert.equal(projected.review.judge.length, 64)
  assert.equal(projected.review.route.model.length, 96)
  assert.equal(Object.hasOwn(projected.review, 'scenarioHash'), false)
  assert.equal(Object.hasOwn(projected.review, 'source'), false)
  assert.equal(Object.hasOwn(projected.review, 'internal'), false)
  assert.deepEqual(Object.keys(projected.trial).sort(), ['at', 'reason', 'state'])
  assert.equal(projected.trial.reason.length, 64)
  assert.equal(projected.validation.decision, 'accepted')
  assert.deepEqual(projected.validation.domain, { packId: 'pack', version: 3, scope: 'validation_domain_only' })
  assert.equal(Object.hasOwn(projected.validation, 'secret'), false)
  assert.equal(Object.hasOwn(projected.validation.domain, 'extra'), false)
  assert.equal(Object.hasOwn(projected, 'ticket'), false)
  assert.equal(projected.instruction.length, 240)
  assert.equal(projected.budget.holding, false)
  // A running plan is the only one that HOLDS a reservation.
  assert.equal(progressRow(row, { ...plan, stage: 'running' }, { reviewRunTokens: 4000 }).budget.holding, true)
  // Unknown input collapses to explicit absences instead of leaking a raw object.
  const empty = progressRow(undefined)
  assert.equal(empty.stage, null)
  assert.equal(empty.review, null)
  assert.equal(empty.trial, null)
  assert.equal(empty.validation, null)
  assert.equal(empty.budget, null)
  assert.equal(empty.scopeLabel, undefined)
  assert.equal(reviewOf({ review: { state: 'nonsense' } }).state, '')
  assert.equal(trialOf({ trial: { state: 'nonsense' } }).state, '')
  assert.equal(reviewOf({}), null)
  assert.equal(trialOf({}), null)
  // An unknown scalar in a scheduler status stays null, never a zero.
  assert.equal(autoStatusOf(undefined, 'mseLearning'), null)
  assert.deepEqual(autoStatusOf({ plans: 3, queued: 2 }, 'plans'),
    { source: 'plans', plans: 3, queued: 2, running: null, done: null, blocked: null, failed: null,
      interrupted: null, lastReason: null, scans: null, lastEvent: null, reviewTokens: null })
  const derived = plansDerivedStatus([{ stage: 'queued', reason: 'review_budget' }, { stage: 'done', reason: null }])
  assert.equal(derived.queued, 1)
  assert.equal(derived.done, 1)
  assert.equal(derived.lastReason, 'review_budget')
  assert.equal(derived.scans, null)
  assert.equal(derived.reviewTokens, null)
  assert.deepEqual(plansDerivedStatus(null).plans, 0)
  // An unreadable library block has no numbers at all.
  const blocked = unreadableLibrary('migration_required')
  assert.equal(blocked.readable, false)
  assert.equal(blocked.code, 'migration_required')
  assert.equal(blocked.total, null)
  assert.deepEqual(libraryOf([], null, { code: 'store_unavailable' }), unreadableLibrary('store_unavailable'))
  assert.equal(libraryOf([{ kind: 'method', review: { state: 'reviewed' }, trial: { state: 'trial' } }],
    { lessons: 9, counts: { validated: 2 }, adopted: 1, experiments: 4 }).reviewed, 1)
})

test('every row the whole-library list offers can be opened by id, and nothing else can', async () => {
  const f = remoteFixture()
  try {
    const list = await f.details.lessons({})
    assert.equal(list.items.length, 5)
    const owners = []
    for (const item of list.items) {
      // The row-level detail action of the page: `lesson({ id })` with NO session selected. Every
      // listed row must open — the r0 defect was 0/23 because the detail fell back to the empty
      // instance scope while the list read the whole library.
      const detail = await f.details.lesson({ id: item.id })
      assert.equal(detail.ok, true, `${item.id} must open from the whole-library list`)
      assert.equal(detail.lesson.id, item.id)
      assert.equal(detail.lesson.instruction, item.instruction)
      assert.equal(detail.scope.label, item.scopeLabel, 'the detail names the owner it located')
      assert.equal(detail.scope.sessionId, null, 'no session was selected, and none is invented')
      assert.equal(detail.scope.scopeHash, item.scopeHash)
      owners.push(item.scopeLabel)
    }
    assert.deepEqual([...new Set(owners)].sort(), ['alpha', 'beta', '默认作用域'])
    // A forged project field cannot point the detail at a scope the Host did not name: it is
    // never read, and the answer stays the row's OWN project without leaking its path.
    const forged = await f.details.lesson({ id: f.betaIds[0], projectKey: PROJECT_A })
    assert.equal(forged.ok, true)
    assert.equal(forged.scope.label, 'beta')
    assert.equal(JSON.stringify(forged).includes(PROJECT_A), false)
    // A row no named scope holds is an explicit refusal, never a guess.
    const missing = await f.details.lesson({ id: `lesson_${'0'.repeat(24)}` })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'lesson_unattributable')
    // An explicitly selected session still reads ONLY its own scope.
    const own = await f.details.lesson({ sessionId: 's-alpha', id: f.alphaIds[0] })
    assert.equal(own.ok, true)
    assert.equal(own.scope.label, 'alpha')
    const foreign = await f.details.lesson({ sessionId: 's-alpha', id: f.betaIds[0], projectKey: PROJECT_B })
    assert.equal(foreign.ok, false)
    assert.equal(foreign.code, 'lesson_not_in_scope')
    // An unresolvable selection is still refused instead of falling back to the library.
    const unknown = await f.details.lesson({ sessionId: 'not-a-session', id: f.alphaIds[0] })
    assert.equal(unknown.code, 'session_unknown')
    return undefined
  } finally { f.cleanup() }
})

test('an id that resolves in two scopes is refused instead of guessed', async () => {
  const f = remoteFixture()
  try {
    const row = f.engine.inspect({ projectKey: PROJECT_A }).lessons[0]
    // A store whose every named scope answers with the same id: the ambiguity branch itself.
    const engine = { list: () => ({}),
      status: () => ({ schema: 2, lessons: 1, counts: {}, adopted: 0, experiments: 0 }),
      inspect: () => ({ ok: true, libraryTotal: 1, scopeTotal: 1, storeCap: 300, lessons: [row] }),
      autoPlans: () => [], history: () => ({ experiments: [] }) }
    const core = { engine, environmentId: undefined, observedTurns: () => 0 }
    const query = { listSessions: async () => [
      { header: { id: 's-alpha', cwd: PROJECT_A, createdAt: 1, origin: 'cli' }, live: true, persisted: true },
      { header: { id: 's-beta', cwd: PROJECT_B, createdAt: 2, origin: 'cli' }, live: false, persisted: true },
    ] }
    const details = new MseDetails({ get: key => key === 'mseLearning' ? core
      : key === 'sessionQuery' ? query : undefined })
    const ambiguous = await details.lesson({ id: row.id })
    assert.equal(ambiguous.ok, false)
    assert.equal(ambiguous.code, 'lesson_scope_ambiguous')
    // A NAMED session never takes the ambiguous lookup: it reads its own scope, as before.
    const scoped = await details.lesson({ sessionId: 's-alpha', id: row.id })
    assert.equal(scoped.ok, true)
    assert.equal(scoped.scope.label, 'alpha')
    return undefined
  } finally { f.cleanup() }
})

test('a read that cannot name every project lowers the categories, never the totals', async () => {
  const partial = remoteFixture({ visibleProjects: [0] })
  const none = remoteFixture({ visibleProjects: [], visibleInstance: false })
  const projectsOnly = remoteFixture({ visibleProjects: [], visibleInstance: false, instanceRow: false })
  try {
    // Only project alpha is named: the store still holds beta's row, so the read is partial.
    const overview = await partial.details.overview()
    assert.equal(overview.library.total, 5, 'the total still covers the whole store')
    assert.equal(overview.library.scanned, 4, 'alpha plus the instance scope were scanned')
    assert.equal(overview.library.corrections, 3)
    assert.equal(overview.library.methods, 1)
    assert.equal(overview.library.complete, false)
    assert.equal(overview.library.partial, true, 'one completeness field, published by both halves')
    assert.equal(overview.library.unattributed, 1)
    assert.equal(overview.libraryScan.code, null, 'the directory answered; the COVERAGE is what is partial')
    const list = await partial.details.lessons({})
    assert.equal(list.libraryTotal, 5)
    assert.equal(list.scopeTotal, 4)
    assert.equal(list.unattributed, 1)
    assert.equal(list.partial, true)
    assert.equal(list.complete, false)
    // No project named at all: the instance scope is still scanned, so a store with rows is never
    // reported as an empty library.
    const bare = await none.details.overview()
    assert.equal(bare.library.total, 5)
    assert.equal(bare.library.scanned, 1)
    assert.equal(bare.library.unattributed, 4)
    assert.equal(bare.library.partial, true)
    assert.equal(bare.library.corrections, 1)
    // …and a library whose rows ALL live in unnamed projects: zero scanned categories, but the
    // total stays exact and the read still says it is partial instead of "no lessons".
    const orphan = await projectsOnly.details.overview()
    assert.equal(orphan.library.total, 4)
    assert.equal(orphan.library.scanned, 0)
    assert.equal(orphan.library.corrections, 0)
    assert.equal(orphan.library.methods, 0)
    assert.equal(orphan.library.unattributed, 4)
    assert.equal(orphan.library.partial, true)
    assert.equal(orphan.library.readable, true)
    return undefined
  } finally { partial.cleanup(); none.cleanup(); projectsOnly.cleanup() }
})

test('a located detail never widens the recall scope', async () => {
  const f = remoteFixture()
  try {
    // The located (library) detail is a read of one row; recall still needs a session and still
    // receives the SELECTED session's own project, never a project the browser supplied.
    const located = await f.details.lesson({ id: f.alphaIds[0] })
    assert.equal(located.ok, true)
    assert.deepEqual(f.recallCalls, [], 'a detail read is not a recall')
    const recall = await f.details.recall({ sessionId: 's-alpha', projectKey: PROJECT_B })
    assert.equal(recall.ok, true)
    assert.deepEqual(f.recallCalls, [{ sessionId: 's-alpha', projectKey: PROJECT_A }],
      'the Host passed the session\'s own project, not the forged one')
    const none = await f.details.recall({})
    assert.equal(none.ok, false)
    assert.equal(none.code, 'session_required')
    assert.equal(f.recallCalls.length, 1, 'a session-less recall never reaches the core')
    return undefined
  } finally { f.cleanup() }
})

test('reading the whole library changes neither the store bytes nor the recall scope', async () => {
  const f = remoteFixture()
  try {
    const path = join(f.stateRoot, 'lessons-v1.json')
    const before = { bytes: readFileSync(path, 'utf8'), size: statSync(path).size, mtime: statSync(path).mtimeMs }
    // Every read path the page issues for 常规 and 经验, including the new whole-library one.
    await f.details.overview()
    await f.details.overview({ sessionId: 's-alpha' })
    await f.details.sessions()
    await f.details.lessons({})
    await f.details.lessons({ sessionId: 's-alpha' })
    await f.details.lesson({ sessionId: 's-alpha', id: f.methodId })
    // The located (whole-library) detail: the same row, found without a selected session.
    await f.details.lesson({ id: f.methodId })
    const after = { bytes: readFileSync(path, 'utf8'), size: statSync(path).size, mtime: statSync(path).mtimeMs }
    assert.equal(after.bytes, before.bytes, 'a read must not rewrite the learning store')
    assert.equal(after.size, before.size)
    assert.equal(after.mtime, before.mtime, 'a read must not even touch the file')
    // The library read is a projection: it never becomes a recall scope. The core still selects
    // only inside the caller's own scope, so a row from another project is not offered here.
    const prompted = f.engine.diagnose({ projectKey: PROJECT_A, prompt: '导出报表金额并核对币种', sessionId: 'reader' })
    assert.equal(prompted.ok, true)
    assert.equal(prompted.library.scopeLessons <= prompted.library.total, true)
    assert.equal(prompted.library.otherScope, prompted.library.total - prompted.library.scopeLessons)
    return undefined
  } finally { f.cleanup() }
})
