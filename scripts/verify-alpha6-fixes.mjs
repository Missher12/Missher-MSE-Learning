// Fixed-behaviour verification for the alpha.5 review items A1..D4 (Node side).
//
// Usage: node scripts/verify-alpha6-fixes.mjs [<source-root>]
//
// These assertions describe the CORRECT behaviour. The review's own probes assert the
// alpha.5 defects on purpose, so their success only proves the defect was reproduced.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.argv[2] ?? fileURLToPathRoot())
function fileURLToPathRoot() { return new URL('..', import.meta.url).pathname }
const { LearningEngine } = await import(pathToFileURL(join(root, 'src/index.mjs')))
const { createHarnessBridge } = await import(pathToFileURL(join(root, 'adapters/harness.mjs')))
const { SettlementQueue, deadlineFromReceipt } = await import(pathToFileURL(join(root, 'src/settlement.mjs')))
const { getMethod, registeredTrials } = await import(pathToFileURL(join(root, 'src/checks.mjs')))

const DAY = 86_400_000
const results = []
const projectKey = '/synthetic/project-a'
const error = code => Object.assign(new Error(code), { code })
let turn = 0
function state(t) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-alpha6-fix-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  return stateRoot
}
function engineOf(t, options = {}) {
  return new LearningEngine({ stateRoot: state(t), adapterId: 'dsh', ...options })
}
async function run(id, fn) {
  const cleanups = []
  try {
    const detail = await fn({ after: callback => cleanups.push(callback) })
    results.push({ id, pass: true, detail })
  } catch (failure) {
    results.push({ id, pass: false, detail: failure?.message ?? String(failure) })
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup() } catch {} }
  }
}
const prepare = (engine, session, prompt, extra = {}) => engine.prepare({ sessionId: session, turnId: `t${++turn}`,
  origin: 'user', prompt, ...extra })
const instructions = engine => engine.list({ limit: 100 }).lessons.map(row => row.instruction)
function fakeClock() {
  let time = 1_000
  const timers = new Map()
  let next = 0
  return { wallMs: 1_800_000_000_000, now: () => time,
    schedule: (fn, ms) => { const id = ++next; timers.set(id, { fn, at: time + ms }); return id },
    cancel: id => timers.delete(id),
    advance: ms => { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn() } },
    pending: () => timers.size }
}

await run('a1-temporary-comma', ({ after }) => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-a1-'))
  after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh' })
  const learned = prepare(engine, 'learn', '仅这次，把报表金额统一为人民币')
  assert.equal(learned.bytes, 0)
  assert.deepEqual(instructions(engine), [], 'a one-shot clause must not become a durable rule')
  assert.equal(prepare(engine, 'task', '导出报表金额并核对币种').bytes, 0)
  return { reason: learned.reason }
})

await run('a1-temporary-colon-and-durable-restart', ({ after }) => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-a1b-'))
  after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh' })
  assert.deepEqual(instructions(engine), [])
  prepare(engine, 'colon', '仅这次：把报表金额统一为人民币')
  assert.deepEqual(instructions(engine), [], 'the colon form is still one-shot')
  prepare(engine, 'mixed', '仅这次先这样，以后报表金额统一用人民币结算')
  assert.deepEqual(instructions(engine), ['以后报表金额统一用人民币结算'],
    'an explicit future marker restarts durable collection')
  return { stored: instructions(engine) }
})

await run('a2-literal-and-inline-code-bytes', ({ after }) => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-a2-'))
  after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh' })
  const literal = '以后导出 CSV 时空值必须写成 "N/A, unknown"'
  prepare(engine, 'csv', literal)
  assert.ok(instructions(engine).includes(literal), 'the quoted comma and space survive verbatim')
  const inline = '以后导出 JSON 时空值必须写成 `{"state":"unknown","code":0}`'
  prepare(engine, 'json', inline)
  assert.ok(instructions(engine).includes(inline))
  const recalled = prepare(engine, 'json-task', '导出 JSON 空值字段怎么处理')
  const backtick = recalled.context.slice(recalled.context.indexOf('`'))
  assert.doesNotThrow(() => JSON.parse(backtick.slice(1, backtick.lastIndexOf('`'))), 'the recalled literal is still valid JSON')
  return { stored: instructions(engine), recalledBytes: recalled.bytes }
})

await run('b1-preference-returns-to-a-previous-value', ({ after }) => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-b1-'))
  after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh' })
  prepare(engine, 'usd', '以后导出报表金额时统一使用美元', { projectKey })
  prepare(engine, 'cny', '纠正一下，以后导出报表金额时统一使用人民币', { projectKey })
  const pending = prepare(engine, 'consumer', '导出报表金额并核对币种', { projectKey })
  engine.accept({ receipt: pending.receipt, lessonIds: pending.lessons })
  prepare(engine, 'usd-again', '纠正一下，以后导出报表金额时统一使用美元', { projectKey })
  const rows = engine.list({ projectKey, limit: 50 }).lessons.filter(row => row.topicKey === 'report.currency')
  const active = rows.filter(row => row.status !== 'suspended')
  assert.equal(active.length, 1)
  assert.equal(active[0].value, 'USD')
  assert.equal(active[0].version, 3, 'returning to a value opens a new generation')
  const served = prepare(engine, 'task', '导出报表金额并核对币种', { projectKey })
  assert.match(served.context, /美元/u)
  assert.equal(served.context.includes('人民币'), false)
  const settled = engine.complete({ sessionId: 'consumer', turnId: pending.lessonVersions ? 't0' : 't0', outcome: 'unknown' })
  assert.equal(settled.ok, true)
  assert.equal(engine.list({ projectKey, limit: 50 }).lessons.find(row => row.value === 'USD').verified, 0,
    'the previous generation earns no credit for the new one')
  return { active: active.map(row => ({ value: row.value, version: row.version })), bytes: served.bytes }
})

await run('b2-independent-precision-instruction', ({ after }) => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-b2-'))
  after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh' })
  prepare(engine, 'currency', '以后导出报表金额时统一使用人民币', { projectKey })
  const precision = prepare(engine, 'precision', '以后人民币金额必须保留两位小数', { projectKey })
  const lessons = engine.list({ projectKey, limit: 50 }).lessons
  assert.equal(lessons.length, 2, 'the precision rule must not be swallowed by the currency slot')
  assert.equal(lessons.filter(row => row.topicKey === 'report.currency').length, 1)
  assert.ok(lessons.some(row => /保留两位小数/u.test(row.instruction) && row.topicKey === undefined))
  const served = prepare(engine, 'precision-task', '人民币金额怎么保留两位小数', { projectKey })
  assert.match(served.context, /两位小数/u)
  return { reason: precision.reason, lessons: lessons.map(row => ({ slot: row.topicKey ?? null, status: row.status })) }
})

await run('b3-stale-and-already-applied-supersedes', ({ after }) => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-b3-'))
  after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh' })
  const a = engine.record({ eventId: 'a', kind: 'correction', source: 'direct_user', projectKey,
    instruction: '以后导出报表金额时统一使用美元' })
  engine.record({ eventId: 'b', kind: 'correction', source: 'direct_user', projectKey,
    instruction: '以后导出报表金额时统一使用人民币', supersedes: a.id, expectedSupersededVersion: 1 })
  const before = JSON.stringify(engine.store.read().lessons)
  assert.throws(() => engine.record({ eventId: 'c', kind: 'correction', source: 'direct_user', projectKey,
    instruction: '以后导出报表金额时统一使用欧元', supersedes: a.id, expectedSupersededVersion: 1 }),
  /stale_replacement/)
  assert.equal(JSON.stringify(engine.store.read().lessons), before, 'a refused replacement changes nothing')
  assert.throws(() => engine.record({ eventId: 'd', kind: 'correction', source: 'direct_user', projectKey,
    instruction: '以后导出报表金额时统一使用欧元', supersedes: a.id }), /invalid_replacement/)
  assert.equal(JSON.stringify(engine.store.read().lessons), before)
  return { lessons: engine.list({ projectKey, limit: 10 }).lessons.length }
})

await run('c1-replay-contract-and-legacy-rows', ({ after }) => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-c1-'))
  after(() => rmSync(stateRoot, { recursive: true, force: true }))
  let now = Date.UTC(2030, 0, 1)
  const options = { stateRoot, adapterId: 'dsh', now: () => now }
  const engine = new LearningEngine(options)
  const proposal = { kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' }
  const first = engine.record({ eventId: 'initial', ...proposal })
  engine.evaluateRegistered({ lessonId: first.id })
  for (let index = 1; index <= 8; index++) engine.record({ eventId: `additional-${index}`, ...proposal })
  now += 91 * DAY
  assert.equal(engine.record({ eventId: 'initial', ...proposal }).duplicate, true,
    'the opening event is remembered beyond the bounded ring')
  assert.equal(engine.list({ limit: 10 }).lessons[0].status, 'validated')
  const fresh = engine.record({ eventId: 'fresh-observation', ...proposal })
  assert.equal(fresh.status, 'candidate', 'a new observation reopens the method')
  // Legacy shape: a row written before the generation contract existed.
  const path = join(stateRoot, 'lessons-v1.json')
  const stored = JSON.parse(readFileSync(path, 'utf8'))
  for (const lesson of stored.lessons) { delete lesson.originEvent; delete lesson.generationEvent; delete lesson.eventIds }
  writeFileSync(path, JSON.stringify(stored))
  const legacy = new LearningEngine(options)
  now += 91 * DAY
  const untouched = JSON.stringify(legacy.list({ limit: 10 }).lessons[0])
  assert.equal(legacy.record({ eventId: 'unprovable', ...proposal }).skipped, 'new_observation_required')
  assert.equal(JSON.stringify(legacy.list({ limit: 10 }).lessons[0]), untouched,
    'a missing old field is never treated as a new observation')
  const asserted = legacy.record({ eventId: 'asserted', newGeneration: true, ...proposal })
  assert.equal(asserted.duplicate, false)
  assert.equal(asserted.status, 'candidate', 'an asserted new observation reopens explicitly')
  return { legacyContract: 'new_observation_required', explicitContract: 'reopened' }
})

await run('c2-historical-replacement-and-controls', ({ after }) => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-c2-'))
  after(() => rmSync(stateRoot, { recursive: true, force: true }))
  let now = Date.UTC(2030, 0, 1)
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh', now: () => now })
  const descriptor = getMethod('numeric-sort-v1')
  const a = engine.record({ eventId: 'generic', kind: 'method', source: 'host_proposal', instruction: descriptor.instruction })
  engine.evaluate({ lessonId: a.id, expectedVersion: 1, eventId: 'generic-eval', suiteId: 'fixture',
    trials: registeredTrials('numeric-sort-v1') })
  const b = engine.record({ eventId: 'canonical', kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1', supersedes: a.id })
  assert.equal(engine.evaluateRegistered({ lessonId: b.id }).decision, 'accepted')
  now += 91 * DAY
  assert.equal(engine.record({ eventId: 'canonical-again', kind: 'method', source: 'host_proposal',
    methodId: 'numeric-sort-v1' }).status, 'candidate')
  const reEvaluated = engine.evaluateRegistered({ lessonId: b.id })
  assert.equal(reEvaluated.decision, 'accepted', JSON.stringify(reEvaluated.reasons))
  assert.ok(engine.prepare({ sessionId: 'recall', turnId: `t${++turn}`, origin: 'user',
    prompt: descriptor.instruction }).bytes > 0, 'the restored method is recallable again')
  // Controls: a manual suspension never reopens through a repeated proposal.
  const manual = engine.record({ eventId: 'manual', kind: 'method', source: 'host_proposal', methodId: 'copy-source-date-v1' })
  engine.suspend({ lessonId: manual.id })
  engine.record({ eventId: 'manual-again', kind: 'method', source: 'host_proposal', methodId: 'copy-source-date-v1' })
  assert.equal(engine.list({ limit: 20 }).lessons.find(row => row.id === manual.id).status, 'suspended')
  return { reEvaluated: reEvaluated.decision, manualStaysSuspended: true }
})

await run('d1-late-result-updates-its-own-turn', async ({ after }) => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-d1-'))
  after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const clock = fakeClock()
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh' })
  const lesson = engine.record({ eventId: 'seed', source: 'direct_user', kind: 'correction',
    instruction: '以后导出金额前先转换为数值，再按金额排序' })
  let id = 0
  const bridge = createHarnessBridge({ engine, now: clock.now, settlement: { schedule: clock.schedule, cancel: clock.cancel },
    createMessage: text => ({ id: `m-${++id}`, role: 'user', source: { kind: 'plugin', plugin: 'mse-learning' }, content: [{ type: 'text', text }] }) })
  const session = { id: 'interleaved', header: {}, events: [] }
  const step = async (turnId, text) => {
    const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
    return bridge.preStep({ agent: { session }, step: 1, turn: turnId, messages: [message],
      signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [message] }))
  }
  const original = engine.complete.bind(engine)
  let fail = true
  engine.complete = payload => { if (payload.turnId === '1' && fail) { fail = false; throw error('lock_busy') } return original(payload) }
  const first = await step(1, '导出金额并排序')
  for await (const _chunk of bridge.stream({ sessionId: session.id, messages: first.messages },
    async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })) {}
  assert.equal(bridge.verification({ sessionId: session.id, turnId: 1, checkId: 'numeric-check', passed: true,
    lessonIds: [lesson.id] }), true)
  bridge.sessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await step(2, '查询明天的天气情况')
  bridge.sessionEvent(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  clock.advance(250)
  const rows = bridge.recallStatus(session.id).recent.map(row => ({ turn: row.turn, outcome: row.outcome }))
  assert.deepEqual(rows, [{ turn: '1', outcome: 'verified' }, { turn: '2', outcome: 'unknown' }])
  assert.equal(engine.status().verified, 1)
  bridge.dispose()
  return { turns: rows }
})

await run('d3-stopped-settlements-release-capacity', () => {
  const clock = fakeClock()
  const queue = new SettlementQueue({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    complete: () => { throw error('lock_busy') } })
  for (let index = 0; index < 64; index++) {
    const sessionId = `closed-${index}`
    queue.enqueue({ key: `k${index}`, payload: { sessionId, turnId: '1', outcome: 'unknown' }, sessionId })
    queue.attempt(`k${index}`)
    queue.stopSession(sessionId)
  }
  const live = queue.size
  clock.advance(300_001)
  const fresh = queue.enqueue({ key: 'healthy', payload: { sessionId: 'live', turnId: '1', outcome: 'unknown' }, sessionId: 'live' })
  assert.equal(live, 0, 'stopped settlements hold no live capacity')
  assert.equal(fresh.state, 'queued')
  assert.equal(queue.history().length, 32)
  queue.dispose()
  return { liveAfterStop: live, fresh: fresh.state, history: queue.history().length }
})

await run('d4-clock-unit-conversion-and-receipt-bound', () => {
  const wall = 1_800_000_000_000
  assert.equal(deadlineFromReceipt({ receiptExpiresAt: wall + 100, wallNow: wall, now: 1000, maxAgeMs: 300_000,
    clockUnit: 's' }), 1000.1)
  assert.equal(deadlineFromReceipt({ receiptExpiresAt: wall + 3_600_000, wallNow: wall, now: 1000, maxAgeMs: 300_000,
    clockUnit: 's' }), 1300)
  const clock = fakeClock()
  let calls = 0
  const queue = new SettlementQueue({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    complete: () => { calls += 1; throw error('lock_busy') } })
  queue.enqueue({ key: 'receipt', payload: { sessionId: 's', turnId: '1', outcome: 'unknown' }, sessionId: 's',
    deadline: deadlineFromReceipt({ receiptExpiresAt: clock.wallMs + 100, wallNow: clock.wallMs, now: clock.now(),
      maxAgeMs: 300_000, clockUnit: 's' }) })
  queue.attempt('receipt')
  clock.advance(250)
  assert.equal(calls, 1, 'no retry may outlive the receipt')
  assert.equal(queue.history().at(-1).state, 'exhausted')
  queue.dispose()
  return { receiptDeadlineSeconds: 1000.1, retries: calls }
})

const report = { source: root, passed: results.filter(row => row.pass).length,
  failed: results.filter(row => !row.pass).length, modelCalls: 0, results }
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (report.failed > 0) process.exitCode = 1
