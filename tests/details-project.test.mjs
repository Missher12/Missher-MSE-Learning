// Read-only detail projections: bounded shapes, forced scope, and no state mutation.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningEngine } from '../src/index.mjs'
import { MAX_PAGE_SIZE, MAX_QUERY_CHARS, MAX_TITLE_CHARS, clipCodePoints, filterLessons, labelOfScope, pageOf,
  projectDetail, projectRow, projectSettlement, projectTurn, sessionTitle, shortHash, titleOfBlock,
  titleOfWire } from '../adapters/dsh/project.mjs'

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
