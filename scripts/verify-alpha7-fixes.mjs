// Correct-behaviour verification for the alpha.6 review items F1..F4 (Node side).
//
// Usage: node scripts/verify-alpha7-fixes.mjs [<source-root>]
//
// These assertions describe the CORRECT behaviour of the fixed build. The review's own
// probes assert the alpha.6 defects on purpose, so their success only proves the defect was
// reproduced; this script is the versioned new-contract acceptance for the one documented
// compatibility change (re-opening an expired row now needs verifiable generation evidence).
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.argv[2] ?? new URL('..', import.meta.url).pathname)
const { LearningEngine } = await import(pathToFileURL(join(root, 'src/index.mjs')))
const { createHarnessBridge } = await import(pathToFileURL(join(root, 'adapters/harness.mjs')))
const { SettlementQueue, deadlineFromReceipt } = await import(pathToFileURL(join(root, 'src/settlement.mjs')))

const DAY = 86_400_000
const results = []
const error = code => Object.assign(new Error(code), { code })
let turn = 0
const resultsFor = stateRoot => JSON.parse(readFileSync(join(stateRoot, 'lessons-v1.json'), 'utf8'))
function run(id, fn) {
  try { results.push({ id, pass: true, detail: fn() }) }
  catch (failure) { results.push({ id, pass: false, detail: failure?.message ?? String(failure) }) }
}
async function runAsync(id, fn) {
  try { results.push({ id, pass: true, detail: await fn() }) }
  catch (failure) { results.push({ id, pass: false, detail: failure?.message ?? String(failure) }) }
}
function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-alpha7-fix-'))
  let now = Date.UTC(2030, 0, 1)
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh', now: () => now })
  return { stateRoot, engine, advance: ms => { now += ms }, at: () => now,
    cleanup: () => rmSync(stateRoot, { recursive: true, force: true }) }
}
const prepare = (engine, session, prompt, extra = {}) => engine.prepare({ sessionId: session, turnId: `t${++turn}`,
  origin: 'user', prompt, ...extra })
const stored = (engine, projectKey) => engine.list({ limit: 100, ...(projectKey === undefined ? {} : { projectKey }) }).lessons
function fakeClock(start) {
  let time = start
  const timers = new Map()
  let next = 0
  return { now: () => time,
    schedule: (fn, ms) => { const id = ++next; timers.set(id, { fn, at: time + ms }); return id },
    cancel: id => timers.delete(id),
    advance: ms => { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn() } },
    pending: () => timers.size }
}

// --- F1: original offsets, negation and literals -----------------------------------------
run('f1-stored-text-keeps-negation-and-exact-bytes', () => {
  const cases = [
    { id: 'comma-space', prompt: '记住：不要把空值改成零 ，保留原始空值', expect: '不要把空值改成零 ，保留原始空值',
      query: '导出数据时处理空值并保留原始空值', visible: /保留原始空值/u },
    { id: 'leading-space', prompt: '  记住：不要把空值改成零 ，保留原始空值', expect: '不要把空值改成零 ，保留原始空值',
      query: '导出数据时处理空值并保留原始空值', visible: /保留原始空值/u },
    { id: 'trailing-space-only', prompt: '记住：不要把空值改成零 ', expect: '不要把空值改成零',
      query: '数值列的空值要不要改成零', visible: /不要把空值改成零/u },
    { id: 'no-space-control', prompt: '记住：不要把空值改成零，保留原始空值', expect: '不要把空值改成零，保留原始空值',
      query: '导出数据时处理空值并保留原始空值', visible: /保留原始空值/u },
  ]
  const seen = []
  for (const item of cases) {
    const f = fixture()
    try {
      prepare(f.engine, 'learn', item.prompt)
      const rows = stored(f.engine)
      assert.equal(rows.length, 1, `${item.id}: exactly one correction is stored`)
      assert.equal(rows[0].instruction, item.expect, `${item.id}: the stored slice keeps the original bytes`)
      assert.equal(rows[0].instruction.includes('不'), true, `${item.id}: the negation survives`)
      // The same rule must be recallable in a fresh session, still carrying the negation.
      const recalled = prepare(new LearningEngine({ stateRoot: f.stateRoot, adapterId: 'dsh' }), 'next', item.query)
      assert.ok(recalled.bytes > 0, `${item.id}: the rule is recalled`)
      assert.match(recalled.context, item.visible, `${item.id}: recall serves the stored bytes verbatim`)
      assert.equal(recalled.context.includes('要把空值改成零') && !recalled.context.includes('不要把空值改成零'), false,
        `${item.id}: the negation is never dropped from the served context`)
      seen.push({ id: item.id, instruction: rows[0].instruction, bytes: recalled.bytes })
    } finally { f.cleanup() }
  }
  return seen
})

run('f1-literals-and-punctuation-are-byte-exact', () => {
  const f = fixture()
  try {
    prepare(f.engine, 'learn', '记住：字段 `{"state":"unknown","code":0}` 与 "N/A, unknown" 一律按原样保留')
    const row = stored(f.engine)[0]
    assert.ok(row, 'the rule is stored')
    assert.ok(row.instruction.includes('`{"state":"unknown","code":0}`'), `backtick literal kept: ${row.instruction}`)
    assert.ok(row.instruction.includes('"N/A, unknown"'), `quoted literal kept: ${row.instruction}`)
    const literal = row.instruction.match(/`([^`]*)`/u)
    assert.equal(JSON.parse(literal[1]).state, 'unknown', 'the literal is still valid JSON')
    // A sentence that opens with a replacement cue must not store the delimiter as content.
    const g = fixture()
    try {
      prepare(g.engine, 'learn', '纠正一下，以后导出报表金额时统一使用美元')
      assert.equal(stored(g.engine)[0].instruction, '以后导出报表金额时统一使用美元',
        'the leading cue and its delimiter are not part of the stored rule')
    } finally { g.cleanup() }
    return { instruction: row.instruction }
  } finally { f.cleanup() }
})

// --- F2: a reworded selection stays in its slot ------------------------------------------
run('f2-reworded-selection-stays-in-the-slot-and-is-replaced', () => {
  const f = fixture()
  try {
    const projectKey = '/synthetic/report'
    prepare(f.engine, 'first', '以后导出报表金额时统一使用人民币', { projectKey })
    const reworded = prepare(f.engine, 'reworded', '以后报表金额都用人民币结算', { projectKey })
    assert.equal(reworded.learned?.topicKey, 'report.currency', 'the reworded selection still owns the slot')
    assert.equal(reworded.learned?.value, 'CNY')
    assert.equal(stored(f.engine, projectKey).filter(row => row.topicKey === 'report.currency' && row.status === 'reminder').length, 1,
      'the slot keeps exactly one active owner')
    prepare(f.engine, 'replacement', '纠正一下，以后导出报表金额时统一使用美元', { projectKey })
    const served = prepare(f.engine, 'query', '导出报表金额并核对币种', { projectKey })
    assert.ok(served.bytes > 0, 'the surviving rule is served')
    assert.match(served.context, /美元/u)
    assert.equal(served.context.includes('人民币'), false, 'no superseded value is served next to the new one')
    const rows = stored(f.engine, projectKey).filter(row => row.topicKey === 'report.currency')
    assert.equal(rows.filter(row => row.status === 'reminder').length, 1, 'only the new value stays active')
    return { bytes: served.bytes, context: served.context, slotRows: rows.map(row => [row.value, row.status]) }
  } finally { f.cleanup() }
})

run('f2-independent-requirement-is-never-swallowed', () => {
  const f = fixture()
  try {
    const projectKey = '/synthetic/report'
    prepare(f.engine, 'currency', '以后导出报表金额时统一使用人民币', { projectKey })
    const precision = prepare(f.engine, 'precision', '以后人民币金额必须保留两位小数', { projectKey })
    assert.notEqual(precision.learned?.topicKey, 'report.currency', 'an independent requirement does not claim the slot')
    const rows = stored(f.engine, projectKey)
    assert.equal(rows.length, 2, 'the precision requirement is stored as its own rule')
    const plain = rows.find(row => row.topicKey === undefined)
    assert.match(plain.instruction, /保留两位小数/u)
    assert.equal(precision.reason, 'correction_learned')
    const served = prepare(f.engine, 'query', '人民币金额怎么保留两位小数', { projectKey })
    assert.ok(served.bytes > 0, 'the independent requirement is recallable')
    assert.match(served.context, /两位小数/u)
    // A bare mention is neither a selection nor a slot conflict: it stays ordinary text.
    prepare(f.engine, 'mention', '以后美元金额也要一起核对，不要漏掉', { projectKey })
    const after = stored(f.engine, projectKey)
    assert.equal(after.filter(row => row.topicKey === 'report.currency' && row.status === 'reminder').length, 1,
      'a mention never opens a second slot owner')
    assert.ok(after.some(row => row.topicKey === undefined && /一起核对/u.test(row.instruction)),
      'the mention is stored as an ordinary correction instead of being dropped')
    return { rows: after.map(row => [row.topicKey ?? null, row.value ?? null, row.status]) }
  } finally { f.cleanup() }
})

run('f2-replacement-retires-every-value-the-slot-held', () => {
  const f = fixture()
  try {
    const projectKey = '/synthetic/report'
    prepare(f.engine, 'first', '以后导出报表金额时统一使用人民币', { projectKey })
    prepare(f.engine, 'second', '以后导出报表金额时统一使用人民币', { projectKey })
    // Historical stores can hold more than one row for the same slot value (a member written
    // by an older build, or a synonym that was never folded). The replacement must retire all
    // of them, not only the row whose wording appears in the incoming sentence.
    const path = join(f.stateRoot, 'lessons-v1.json')
    const state = resultsFor(f.stateRoot)
    const owner = state.lessons.find(row => row.topicKey === 'report.currency')
    const member = { ...owner, id: `lesson_${'a1b2c3d4e5f6a7b8c9d0e1f2'}`,
      instruction: '以后报表金额都用人民币结算', createdAt: owner.createdAt + 1 }
    state.lessons.push(member)
    writeFileSync(path, JSON.stringify(state))
    const engine = new LearningEngine({ stateRoot: f.stateRoot, adapterId: 'dsh', now: () => f.at() })
    assert.equal(stored(engine, projectKey).filter(row => row.value === 'CNY' && row.status === 'reminder').length, 2, 'two CNY members')
    prepare(engine, 'replacement', '纠正一下，以后导出报表金额时统一使用美元', { projectKey })
    const rows = stored(engine, projectKey)
    assert.equal(rows.filter(row => row.value === 'CNY' && row.status !== 'suspended').length, 0,
      'every superseded value in the slot is retired')
    assert.equal(rows.filter(row => row.value === 'USD' && row.status === 'reminder').length, 1)
    const served = prepare(engine, 'query', '导出报表金额并核对币种', { projectKey })
    assert.match(served.context, /美元/u)
    assert.equal(served.context.includes('人民币'), false)
    return { slot: rows.filter(row => row.topicKey === 'report.currency').map(row => [row.value, row.status]) }
  } finally { f.cleanup() }
})

// --- F3: a re-open needs verifiable generation evidence ----------------------------------
run('f3-evicted-events-cannot-renew-a-row', () => {
  const f = fixture()
  try {
    const proposal = { kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' }
    const first = f.engine.record({ eventId: 'initial', ...proposal })
    f.engine.evaluateRegistered({ lessonId: first.id })
    for (let index = 1; index <= 9; index++) f.engine.record({ eventId: `additional-${index}`, ...proposal })
    const before = stored(f.engine)[0]
    f.advance(91 * DAY)
    const replay = f.engine.record({ eventId: 'additional-1', ...proposal })
    assert.equal(replay.skipped, 'new_observation_required', 'an evicted event is never trusted as new')
    const after = stored(f.engine)[0]
    assert.equal(after.version, before.version)
    assert.equal(after.expiresAt, before.expiresAt)
    return { skipped: replay.skipped, version: after.version, ring: after.eventIds.length }
  } finally { f.cleanup() }
})

run('f3-historical-generations-cannot-renew-a-row', () => {
  const f = fixture()
  try {
    const proposal = { kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' }
    const first = f.engine.record({ eventId: 'origin', ...proposal })
    f.engine.evaluateRegistered({ lessonId: first.id })
    f.advance(91 * DAY)
    f.engine.record({ eventId: 'generation-two', ...proposal })
    f.engine.evaluateRegistered({ lessonId: first.id })
    f.advance(91 * DAY)
    f.engine.record({ eventId: 'generation-three', ...proposal })
    f.engine.evaluateRegistered({ lessonId: first.id })
    for (let index = 1; index <= 8; index++) f.engine.record({ eventId: `extra-${index}`, ...proposal })
    const before = stored(f.engine)[0]
    assert.equal(before.generation, 3, 'three generations were opened')
    f.advance(91 * DAY)
    const replay = f.engine.record({ eventId: 'generation-two', ...proposal })
    assert.equal(replay.skipped, 'new_observation_required')
    // A restart reads the same store and must reach the same conclusion.
    const restarted = new LearningEngine({ stateRoot: f.stateRoot, adapterId: 'dsh', now: () => f.at() })
    const after = restarted.list({ limit: 10 }).lessons[0]
    assert.equal(after.version, before.version)
    assert.equal(after.expiresAt, before.expiresAt)
    return { skipped: replay.skipped, generation: after.generation, version: after.version }
  } finally { f.cleanup() }
})

run('f3-verified-observation-reopens-and-stale-condition-is-refused', () => {
  const f = fixture()
  try {
    const proposal = { kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' }
    const first = f.engine.record({ eventId: 'initial', ...proposal })
    f.engine.evaluateRegistered({ lessonId: first.id })
    for (let index = 1; index <= 8; index++) f.engine.record({ eventId: `additional-${index}`, ...proposal })
    f.advance(91 * DAY)
    const observed = stored(f.engine)[0]
    assert.equal(observed.generation, 1)
    // No evidence: refused. A bare boolean is explicitly not evidence.
    assert.equal(f.engine.record({ eventId: 'bare', newGeneration: true, ...proposal }).skipped, 'new_observation_required')
    assert.equal(f.engine.record({ eventId: 'denied', newGeneration: false, expectedVersion: observed.version,
      expectedGeneration: observed.generation, ...proposal }).skipped, 'new_observation_required')
    // Bound condition: accepted, and it opens exactly one generation.
    const reopened = f.engine.record({ eventId: 'observed-new', newGeneration: true,
      expectedVersion: observed.version, expectedGeneration: observed.generation, ...proposal })
    assert.equal(reopened.status, 'candidate')
    const renewed = stored(f.engine)[0]
    assert.equal(renewed.version, observed.version + 1)
    assert.equal(renewed.generation, observed.generation + 1)
    assert.ok(renewed.expiresAt > f.at(), 'the verified observation renews the row')
    // An event id is bound to the claims it was recorded with: re-using it with other
    // expectations is a conflict, never a second generation.
    assert.throws(() => f.engine.record({ eventId: 'observed-new', newGeneration: true,
      expectedVersion: renewed.version, expectedGeneration: renewed.generation, ...proposal }), /event_conflict/)
    assert.equal(stored(f.engine)[0].generation, renewed.generation, 'the conflict changed nothing')
    // The new generation is evaluated on its own; evaluation opens no further generation.
    const evaluated = f.engine.evaluateRegistered({ lessonId: first.id })
    assert.equal(evaluated.decision, 'accepted', 'the new generation is evaluable on its own')
    assert.equal(stored(f.engine)[0].generation, renewed.generation)
    // The same condition cannot be replayed once the row has moved on.
    f.advance(91 * DAY)
    const stale = f.engine.record({ eventId: 'stale', newGeneration: true,
      expectedVersion: observed.version, expectedGeneration: observed.generation, ...proposal })
    assert.equal(stale.skipped, 'stale_generation')
    assert.ok(stored(f.engine)[0].expiresAt <= f.at(), 'a stale condition renews nothing')
    return { skippedBare: 'new_observation_required', reopened: reopened.status, reEvaluated: evaluated.decision }
  } finally { f.cleanup() }
})

run('f3-complete-history-observation-and-legacy-rows', () => {
  const f = fixture()
  try {
    // While the ring still holds every applied event, an unseen event is provably new.
    const proposal = { kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' }
    const first = f.engine.record({ eventId: 'initial', ...proposal })
    f.engine.evaluateRegistered({ lessonId: first.id })
    f.advance(91 * DAY)
    const fresh = f.engine.record({ eventId: 'fresh', ...proposal })
    assert.equal(fresh.duplicate, false)
    assert.equal(fresh.status, 'candidate', 'a provably new observation reopens the row')
    assert.equal(fresh.generation ?? stored(f.engine)[0].generation, 2)
    // Legacy shape: nothing proves the event is new, and the row reports generation 0.
    const path = join(f.stateRoot, 'lessons-v1.json')
    const state = resultsFor(f.stateRoot)
    for (const lesson of state.lessons) { delete lesson.originEvent; delete lesson.generationEvent
      delete lesson.eventIds; delete lesson.generation }
    writeFileSync(path, JSON.stringify(state))
    f.advance(91 * DAY)
    const legacy = new LearningEngine({ stateRoot: f.stateRoot, adapterId: 'dsh', now: () => f.at() })
    const untouched = JSON.stringify(legacy.list({ limit: 10 }).lessons[0])
    assert.equal(legacy.record({ eventId: 'unprovable', ...proposal }).skipped, 'new_observation_required')
    assert.equal(legacy.record({ eventId: 'bare-bool', newGeneration: true, ...proposal }).skipped,
      'new_observation_required')
    assert.equal(JSON.stringify(legacy.list({ limit: 10 }).lessons[0]), untouched, 'a refusal changes nothing')
    const observed = legacy.list({ limit: 10 }).lessons[0]
    assert.equal(observed.generation, undefined, 'a pre-contract row reports no generation')
    const reopened = legacy.record({ eventId: 'legacy-observed', newGeneration: true,
      expectedVersion: observed.version, expectedGeneration: 0, ...proposal })
    assert.equal(reopened.status, 'candidate')
    const row = legacy.list({ limit: 10 }).lessons[0]
    assert.equal(row.generation, 1, 'the row carries the contract after a verified re-open')
    return { provableReopen: fresh.status, legacyReopen: reopened.status, legacyGeneration: row.generation }
  } finally { f.cleanup() }
})

// --- F4: the receipt deadline actually reaches the queue --------------------------------
run('f4-queue-applies-the-injected-receipt-conversion', () => {
  const wall = 1_800_000_000_000
  const clock = fakeClock(1000)
  let calls = 0
  // The queue clock is monotonic seconds while the receipt is epoch milliseconds.
  const queue = new SettlementQueue({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    deadlineForReceipt: ({ receiptExpiresAt, now }) => deadlineFromReceipt({ receiptExpiresAt, wallNow: wall,
      now, maxAgeMs: 300_000, clockUnit: 's' }),
    complete: () => { calls += 1; throw error('lock_busy') } })
  queue.enqueue({ key: 'near', payload: { sessionId: 's', turnId: '1', outcome: 'unknown' }, sessionId: 's',
    receiptExpiresAt: wall + 100 })
  const entry = queue.entry('near')
  assert.ok(entry.deadline <= 1000.1 + 1e-9, `the receipt bound is applied: ${entry.deadline}`)
  queue.attempt('near')
  clock.advance(250)
  assert.equal(calls, 1, 'no retry may outlive the receipt')
  assert.equal(queue.history().at(-1).state, 'exhausted')
  // Without the conversion the queue clock cannot compare scales, so only the age bound holds.
  const plain = new SettlementQueue({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    complete: () => { calls += 1; throw error('lock_busy') } })
  plain.enqueue({ key: 'plain', payload: { sessionId: 's', turnId: '2', outcome: 'unknown' }, sessionId: 's',
    receiptExpiresAt: wall + 100 })
  assert.equal(plain.entry('plain').deadline, clock.now() + 300_000, 'omitting the conversion keeps the age bound')
  queue.dispose()
  plain.dispose()
  return { nearDeadline: entry.deadline, calls, ageBoundDeadline: 300_000 }
})

await runAsync('f4-bridge-receipt-deadline-stops-the-second-write', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-alpha7-bridge-'))
  const clock = fakeClock(Date.now())
  try {
    const engine = new LearningEngine({ stateRoot, adapterId: 'dsh', now: clock.now })
    const lesson = engine.record({ eventId: 'seed', source: 'direct_user', kind: 'correction',
      instruction: '以后导出金额前先转换为数值，再按金额排序' })
    let messageId = 0
    const bridge = createHarnessBridge({ engine, now: clock.now,
      settlement: { schedule: clock.schedule, cancel: clock.cancel, wallNow: clock.now },
      createMessage: text => ({ id: `p${++messageId}`, role: 'user', source: { kind: 'plugin', plugin: 'mse-learning' },
        content: text }) })
    const session = { id: 'receipt-session', header: {} }
    const step = async (turnId, prompt) => {
      const messages = [{ role: 'user', source: { kind: 'user' }, content: prompt }]
      return bridge.preStep({ agent: { session }, step: 1, turn: turnId, messages,
        signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }))
    }
    const stream = decision => bridge.stream({ sessionId: session.id, messages: decision.messages },
      async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })
    const calls = []
    const original = engine.complete.bind(engine)
    const failedTurns = new Set()
    engine.complete = payload => {
      calls.push({ turn: payload.turnId, outcome: payload.outcome })
      if (!failedTurns.has(payload.turnId)) { failedTurns.add(payload.turnId); throw error('lock_busy') }
      return original(payload)
    }
    // Turn 1: the receipt has 100ms left when the turn ends; the first write fails.
    const decision = await step(1, '导出金额并排序')
    for await (const _ of stream(decision)) { /* drain */ }
    assert.equal(bridge.verification({ sessionId: session.id, turnId: 1, lessonIds: [lesson.id],
      checkId: 'receipt-check', passed: true, expectedVersion: 1 }), true)
    const receiptDeadline = engine.store.read().receipts.at(-1).expiresAt
    clock.advance(receiptDeadline - clock.now() - 100)
    bridge.sessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: 'completed' } })
    assert.equal(calls.length, 1, 'the first attempt ran')
    clock.advance(250)
    assert.equal(calls.length, 1, 'the retry must not outlive the receipt deadline')
    const first = bridge.lastRecall(session.id)
    assert.equal(first.settleState, 'exhausted')
    assert.equal(first.settleError, 'lock_busy')
    assert.equal(bridge.settlementStatus().length, 0, 'a bounded terminal state holds no delivery slot')
    // Control: a receipt that is far away still allows the ordinary retry to land.
    const decision2 = await step(2, '导出金额并排序')
    for await (const _ of stream(decision2)) { /* drain */ }
    bridge.verification({ sessionId: session.id, turnId: 2, lessonIds: [lesson.id], checkId: 'receipt-check',
      passed: true, expectedVersion: 1 })
    bridge.sessionEvent(session, { type: 'turn/end', data: { turn: 2, reason: 'completed' } })
    assert.equal(calls.length, 2)
    clock.advance(250)
    assert.equal(calls.length, 3, 'a far receipt leaves the ordinary retry intact')
    assert.equal(bridge.lastRecall(session.id).settleState, 'settled')
    bridge.dispose()
    return { receiptBoundCalls: 1, retriedCalls: 3, queued: bridge.settlementHistory().map(row => row.state) }
  } finally { rmSync(stateRoot, { recursive: true, force: true }) }
})

const report = { source: root, passed: results.filter(row => row.pass).length,
  failed: results.filter(row => !row.pass).length, modelCalls: 0, results }
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (report.failed > 0) process.exitCode = 1
