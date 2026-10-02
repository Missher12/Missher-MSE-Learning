import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningEngine } from '../src/index.mjs'
import { SettlementQueue, deadlineFromReceipt, isTransient } from '../src/settlement.mjs'
import { createHarnessBridge } from '../adapters/harness.mjs'

/** Deterministic clock + scheduler: no real sleeping, every timer is inspectable. */
function fakeClock() {
  let time = 1_000, nextId = 0
  const timers = new Map()
  return {
    /** Wall clock in epoch milliseconds: distinct from the injected queue clock on purpose. */
    wallMs: 1_800_000_000_000,
    now: () => time,
    schedule: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, at: time + ms }); return id },
    cancel: id => timers.delete(id),
    advance: ms => {
      time += ms
      for (let guard = 0; guard < 64; guard++) {
        const due = [...timers].filter(([, timer]) => timer.at <= time)
        if (due.length === 0) return
        for (const [id, timer] of due) { timers.delete(id); timer.fn() }
      }
      throw new Error('timer loop did not settle')
    },
    pending: () => timers.size,
  }
}
const error = code => Object.assign(new Error(code), { code })
const settled = () => new Promise(resolve => setImmediate(resolve))

test('the queue retries only transient failures, then settles exactly once', () => {
  const clock = fakeClock()
  const calls = []
  let remainingFailures = 2
  const queue = new SettlementQueue({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    complete: payload => { calls.push(payload); if (remainingFailures-- > 0) throw error('lock_busy'); return { ok: true, attributed: 1 } } })
  const payload = { sessionId: 's', turnId: '1', outcome: 'verified' }
  assert.equal(queue.enqueue({ key: 'k', payload, sessionId: 's' }).state, 'queued')
  assert.equal(queue.attempt('k').state, 'retrying')
  assert.equal(queue.entry('k').attempts, 1)
  clock.advance(250)
  assert.equal(queue.entry('k').attempts, 2)
  clock.advance(1000)
  assert.equal(queue.size, 0, 'a settled entry leaves the queue')
  assert.equal(calls.length, 3)
  assert.equal(new Set(calls.map(entry => JSON.stringify(entry))).size, 1, 'every attempt replays the identical payload')
  assert.equal(clock.pending(), 0, 'no timer is left behind')
})

test('permanent failures stop immediately and exhausted retries report their bound', () => {
  const clock = fakeClock()
  let calls = 0
  const permanent = new SettlementQueue({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    complete: () => { calls += 1; throw error('invalid_store') } })
  permanent.enqueue({ key: 'p', payload: { sessionId: 's', turnId: '1' }, sessionId: 's' })
  assert.equal(permanent.attempt('p').state, 'failed')
  clock.advance(60_000)
  assert.equal(calls, 1, 'a permanent error is never retried')
  assert.equal(permanent.entry('p'), undefined)

  const events = []
  const exhausting = new SettlementQueue({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    onEvent: event => events.push(event.kind),
    complete: () => { calls += 1; throw error('state_unavailable') } })
  exhausting.enqueue({ key: 'x', payload: { sessionId: 's', turnId: '2' }, sessionId: 's' })
  exhausting.attempt('x')
  clock.advance(250); clock.advance(1000); clock.advance(3000)
  assert.equal(exhausting.size, 0)
  assert.equal(events.at(-1), 'exhausted')
  assert.equal(exhausting.status().length, 0)
})

test('capacity, deadline and unknown payload repeats are bounded', () => {
  const clock = fakeClock()
  const queue = new SettlementQueue({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    maxItems: 2, maxAgeMs: 1000, complete: () => { throw error('state_unavailable') } })
  assert.equal(queue.enqueue({ key: 'a', payload: { turnId: '1' }, sessionId: 's' }).state, 'queued')
  assert.equal(queue.enqueue({ key: 'b', payload: { turnId: '2' }, sessionId: 's' }).state, 'queued')
  assert.equal(queue.enqueue({ key: 'c', payload: { turnId: '3' }, sessionId: 's' }).state, 'capacity')
  assert.equal(queue.size, 2, 'capacity never silently drops an existing entry')
  // A different payload for the same turn is a conflict, not a replacement.
  assert.equal(queue.enqueue({ key: 'a', payload: { turnId: '1', outcome: 'cancelled' }, sessionId: 's' }).state, 'conflict')
  assert.deepEqual(queue.entry('a').payload, { turnId: '1' })
  // Past its age bound nothing is attempted and the entry reports expiry.
  clock.advance(2000)
  assert.equal(queue.attempt('a').state, 'expired')
})

test('pause stops attempts, resume replays only unexpired local completions, dispose is inert', () => {
  const clock = fakeClock()
  let calls = 0
  const queue = new SettlementQueue({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    complete: () => { calls += 1; throw error('state_unavailable') } })
  queue.enqueue({ key: 'p', payload: { sessionId: 's', turnId: '1' }, sessionId: 's' })
  queue.attempt('p')
  assert.equal(calls, 1)
  queue.pause()
  clock.advance(10_000)
  assert.equal(calls, 1, 'a paused queue starts no attempt')
  assert.equal(queue.entry('p').payload.turnId, '1', 'the frozen snapshot survives the pause')
  queue.resume()
  clock.advance(0)
  assert.equal(calls, 2, 'resume replays the frozen completion')
  queue.dispose()
  clock.advance(60_000)
  assert.equal(calls, 2, 'nothing runs after dispose')
  assert.equal(queue.enqueue({ key: 'q', payload: { sessionId: 's', turnId: '2' }, sessionId: 's' }).state, 'disposed')
  assert.equal(isTransient('lock_busy'), true)
  assert.equal(isTransient('invalid_store'), false)
})

test('stopping one session leaves other sessions retrying', () => {
  const clock = fakeClock()
  const calls = []
  const queue = new SettlementQueue({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    complete: payload => { calls.push(payload.sessionId); throw error('lock_busy') } })
  queue.enqueue({ key: 'one', payload: { sessionId: 'closed', turnId: '1' }, sessionId: 'closed' })
  queue.enqueue({ key: 'two', payload: { sessionId: 'live', turnId: '1' }, sessionId: 'live' })
  queue.attempt('one'); queue.attempt('two')
  assert.deepEqual(queue.stopSession('closed'), ['one'])
  clock.advance(10_000)
  assert.deepEqual(calls, ['closed', 'live', 'live'], 'only the live session keeps retrying')
  // A stopped settlement leaves the live retry set immediately and is kept only as a
  // bounded history record, so it can never hold capacity for the rest of the process.
  assert.equal(queue.entry('one'), undefined)
  assert.deepEqual(queue.status().map(entry => entry.key), ['two'])
  assert.deepEqual(queue.history().map(row => [row.key, row.sessionId, row.turnId, row.state]),
    [['one', 'closed', '1', 'stopped']])
})

function fixture(t, options = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-settlement-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const clock = fakeClock()
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh' })
  const lesson = engine.record({ eventId: 'seed', source: 'direct_user', kind: 'correction',
    instruction: '以后导出金额前先转换为数值，再按金额排序' })
  let id = 0
  const bridge = createHarnessBridge({ engine, now: clock.now,
    settlement: { schedule: clock.schedule, cancel: clock.cancel, maxAgeMs: 5 * 60_000, ...options.settlement },
    createMessage: text => ({ id: `m-${++id}`, role: 'user', source: { kind: 'plugin', plugin: 'mse-learning' }, content: [{ type: 'text', text }] }),
    ...options })
  const session = { id: 'settle-session', header: {}, events: [] }
  const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '导出金额并排序' }] }
  const step = async (turn = 1) => bridge.preStep({ agent: { session }, step: 1, turn, messages: [message],
    signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [message] }))
  const adopt = async messages => { for await (const _chunk of bridge.stream({ sessionId: session.id, messages },
    async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })) {} }
  const verify = () => bridge.verification({ sessionId: session.id, turnId: 1, checkId: 'numeric-check',
    passed: true, lessonIds: [lesson.id] })
  const end = (reason = 'completed') => bridge.sessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: reason } } })
  // The core refuses to settle under unknown host permission, which is the safe default; these
  // tests are about the queue and its ordering, so they state the permission explicitly.
  bridge.setTrustedGuard(() => true)
  return { engine, bridge, session, lesson, clock, step, adopt, verify, end }
}

test('a transient write failure recovers on retry and credits the lesson exactly once', async t => {
  const f = fixture(t)
  const payloads = []
  // The harness now settles through the durable apply, which is the boundary these tests inject at.
  const original = f.engine.settlementApply.bind(f.engine)
  let failures = 2
  f.engine.settlementApply = (...args) => { payloads.push(JSON.stringify(args[0]));
    if (failures-- > 0) throw error('lock_busy'); return original(...args) }
  const decision = await f.step()
  await f.adopt(decision.messages)
  assert.equal(f.verify(), true)
  const bytesAfterAdoption = f.engine.diagnose({ sessionId: f.session.id }).session.bytes
  f.end()
  assert.equal(f.engine.status().verified, 0, 'the write has not succeeded yet')
  const pending = f.bridge.lastRecall(f.session.id)
  assert.equal(pending.outcome, 'pending')
  assert.equal(pending.settleError, 'lock_busy')
  assert.equal(f.bridge.settlementStatus().length, 1)
  f.clock.advance(250)
  f.clock.advance(1000)
  await settled()
  assert.equal(f.engine.status().verified, 1, 'the retry settles exactly once')
  assert.equal(f.engine.status().adopted, 1)
  assert.equal(f.engine.diagnose({ sessionId: f.session.id }).session.bytes, bytesAfterAdoption, 'retries never re-consume recall budget')
  assert.equal(new Set(payloads).size, 1, 'every attempt replays the identical frozen payload')
  assert.equal(payloads.length, 3)
  assert.equal(f.bridge.settlementStatus().length, 0)
  const last = f.bridge.lastRecall(f.session.id)
  assert.equal(last.outcome, 'verified')
  assert.equal(last.attributed, 1)
})

test('a commit that succeeded before the response failed is reported with the recorded result', async t => {
  const f = fixture(t)
  // The harness now settles through the durable apply, which is the boundary these tests inject at.
  const original = f.engine.settlementApply.bind(f.engine)
  let threw = false
  f.engine.settlementApply = (...args) => {
    const result = original(...args)
    if (!threw) { threw = true; throw error('state_unavailable') }
    return result
  }
  const decision = await f.step()
  await f.adopt(decision.messages)
  f.verify()
  f.end()
  assert.equal(f.engine.status().verified, 1, 'the first attempt committed')
  assert.equal(f.bridge.lastRecall(f.session.id).settleError, 'state_unavailable')
  f.clock.advance(250)
  await settled()
  assert.equal(f.engine.status().verified, 1, 'the replay must not double count')
  const last = f.bridge.lastRecall(f.session.id)
  assert.equal(last.outcome, 'verified', 'the recorded outcome is restored, not rewritten')
  assert.equal(last.attributed, 1)
  assert.equal(last.settleState, 'duplicate')
})

test('repeated events and timers keep exactly one queued settlement', async t => {
  const f = fixture(t)
  // The harness now settles through the durable apply, which is the boundary these tests inject at.
  const original = f.engine.settlementApply.bind(f.engine)
  let calls = 0
  f.engine.settlementApply = payload => { calls += 1; throw error('lock_busy') }
  const decision = await f.step()
  await f.adopt(decision.messages)
  f.verify()
  f.end()
  assert.equal(calls, 1)
  // Repeat delivery of the same turn end: no second queue item, no second attempt.
  f.bridge.sessionEvent(f.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  f.bridge.sessionEvent(f.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(f.bridge.settlementStatus().length, 1)
  f.clock.advance(250)
  assert.equal(calls, 2, 'the retry schedule is still single-flight')
  assert.equal(f.bridge.settlementStatus().length, 1)
})

test('pausing, closing a session and disposing stop retries without rewriting the frozen outcome', async t => {
  const f = fixture(t)
  // The harness now settles through the durable apply, which is the boundary these tests inject at.
  const original = f.engine.settlementApply.bind(f.engine)
  let calls = 0
  f.engine.settlementApply = payload => { calls += 1; throw error('state_unavailable') }
  const decision = await f.step()
  await f.adopt(decision.messages)
  f.verify()
  f.end()
  assert.equal(calls, 1)
  f.bridge.setEnabled(false)
  f.clock.advance(60_000)
  assert.equal(calls, 1, 'a paused controller starts no settlement attempt')
  assert.equal(f.bridge.lastRecall(f.session.id).outcome, 'pending', 'the frozen outcome is never rewritten')
  f.bridge.setEnabled(true)
  f.clock.advance(0)
  assert.equal(calls, 2, 'resume replays the unexpired frozen completion')
  f.bridge.closeSession(f.session.id)
  f.clock.advance(60_000)
  assert.equal(calls, 2, 'a closed session stops retrying')
  assert.equal(f.bridge.lastRecall(f.session.id).settleState, 'stopped')
  const other = { id: 'other-session', header: {}, events: [] }
  const otherMessage = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '导出金额并排序' }] }
  await f.bridge.preStep({ agent: { session: other }, step: 1, turn: 1, messages: [otherMessage],
    signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [otherMessage] }))
  f.bridge.sessionEvent(other, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(f.bridge.settlementStatus().some(entry => entry.sessionId === 'other-session'), true,
    'another session keeps its own retry')
  f.bridge.dispose()
  const before = calls
  f.clock.advance(60_000)
  assert.equal(calls, before, 'nothing runs after dispose')
})

test('the settlement queue never reruns a model, tool, reflection or evaluation callback', async t => {
  let reviews = 0
  const f = fixture(t, { review: async () => { reviews += 1 } })
  // The harness now settles through the durable apply, which is the boundary these tests inject at.
  const original = f.engine.settlementApply.bind(f.engine)
  let completeCalls = 0
  f.engine.settlementApply = (...args) => { completeCalls += 1;
    if (completeCalls < 2) throw error('lock_busy'); return original(...args) }
  const guard = { prepare: f.engine.prepare, accept: f.engine.accept, verifyArtifact: f.engine.checkArtifact,
    evaluate: f.engine.evaluate, reflectRequest: f.engine.reflectionRequest }
  let extra = 0
  f.engine.prepare = (...args) => { extra += 1; return guard.prepare.apply(f.engine, args) }
  f.engine.accept = (...args) => { extra += 1; return guard.accept.apply(f.engine, args) }
  f.engine.checkArtifact = (...args) => { extra += 1; return guard.verifyArtifact.apply(f.engine, args) }
  f.engine.evaluate = (...args) => { extra += 1; return guard.evaluate.apply(f.engine, args) }
  f.engine.reflectionRequest = (...args) => { extra += 1; return guard.reflectRequest.apply(f.engine, args) }
  const decision = await f.step()
  await f.adopt(decision.messages)
  f.verify()
  const extraBefore = extra
  f.end()
  f.clock.advance(250)
  await settled()
  assert.equal(completeCalls, 2)
  assert.equal(extra, extraBefore, 'the retry only replays complete')
  assert.equal(reviews, 0, 'no reflection is restarted by a settlement retry')
})

test('a late result is written to its own turn and never onto the newest turn', async t => {
  const f = fixture(t)
  // The harness now settles through the durable apply, which is the boundary these tests inject at.
  const original = f.engine.settlementApply.bind(f.engine)
  // The durable apply is addressed by its frozen handle, not by turn identity, so the injected
  // failure is keyed on the call order: the first attempt (turn 1) fails, the retry succeeds.
  let failures = 1
  f.engine.settlementApply = (...args) => {
    if (failures-- > 0) throw error('lock_busy')
    return original(...args)
  }
  const first = await f.step(1)
  await f.adopt(first.messages)
  assert.equal(f.bridge.verification({ sessionId: f.session.id, turnId: 1, checkId: 'numeric-check',
    passed: true, lessonIds: [f.lesson.id] }), true)
  f.end()
  const secondMessage = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '查询明天的天气情况' }] }
  await f.bridge.preStep({ agent: { session: f.session }, step: 1, turn: 2, messages: [secondMessage],
    signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [secondMessage] }))
  f.bridge.sessionEvent(f.session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  const before = f.bridge.recallStatus(f.session.id).recent.map(row => ({ turn: row.turn, outcome: row.outcome }))
  assert.deepEqual(before, [{ turn: '1', outcome: 'pending' }, { turn: '2', outcome: 'unknown' }])
  f.clock.advance(250)
  await settled()
  const after = f.bridge.recallStatus(f.session.id).recent.map(row => ({ turn: row.turn, outcome: row.outcome,
    settleState: row.settleState }))
  assert.deepEqual(after[0], { turn: '1', outcome: 'verified', settleState: 'settled' }, 'the retry credits its own turn')
  // Turn 2 settled its own unknown outcome; the late result for turn 1 never touched it.
  assert.deepEqual(after[1], { turn: '2', outcome: 'unknown', settleState: 'settled' })
  assert.equal(f.engine.status().verified, 1)
})

test('retired settlements release capacity and stay visible as bounded history', () => {
  const clock = fakeClock()
  const queue = new SettlementQueue({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    complete: () => { throw error('lock_busy') } })
  for (let index = 0; index < 64; index++) {
    const sessionId = `closed-${index}`
    queue.enqueue({ key: `k${index}`, payload: { sessionId, turnId: '1', outcome: 'unknown' }, sessionId })
    queue.attempt(`k${index}`)
    queue.stopSession(sessionId)
  }
  assert.equal(queue.size, 0, 'stopped settlements hold no live capacity')
  clock.advance(300_001)
  const fresh = queue.enqueue({ key: 'healthy-new', payload: { sessionId: 'live', turnId: '1', outcome: 'unknown' }, sessionId: 'live' })
  assert.equal(fresh.state, 'queued', 'a healthy turn can still settle')
  assert.equal(queue.history().length, 32, 'terminal history stays bounded')
  assert.deepEqual(queue.history().at(-1), { key: 'k63', sessionId: 'closed-63', turnId: '1', state: 'stopped',
    attempts: 1, lastError: 'lock_busy', at: 1_000 }, 'the record keeps when it was retired')
  queue.dispose()
})

test('a receipt deadline is converted into the queue clock unit at one boundary', () => {
  const wall = 1_800_000_000_000
  // The Hermes queue runs on monotonic seconds while the core reports epoch milliseconds.
  const seconds = { wallNow: wall, now: 1000, maxAgeMs: 300_000, clockUnit: 's' }
  assert.equal(deadlineFromReceipt({ receiptExpiresAt: wall + 100, ...seconds }), 1000.1)
  assert.equal(deadlineFromReceipt({ receiptExpiresAt: wall - 5_000, ...seconds }), 1000,
    'an expired receipt allows only the current attempt')
  assert.equal(deadlineFromReceipt({ receiptExpiresAt: undefined, ...seconds }), 1300,
    'without a receipt the age bound remains the only limit')
  assert.equal(deadlineFromReceipt({ receiptExpiresAt: wall + 3_600_000, ...seconds }), 1300,
    'a far receipt never exceeds the total age bound')
  // The DSH queue clock is epoch milliseconds, so the remaining time is used unchanged.
  assert.equal(deadlineFromReceipt({ receiptExpiresAt: wall + 100, wallNow: wall, now: wall, maxAgeMs: 300_000 }),
    wall + 100)
  assert.equal(deadlineFromReceipt({ receiptExpiresAt: undefined, wallNow: wall, now: wall, maxAgeMs: 300_000 }),
    wall + 300_000)

  const clock = fakeClock()
  let calls = 0
  const queue = new SettlementQueue({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    maxAgeMs: 300_000, complete: () => { calls += 1; throw error('lock_busy') } })
  queue.enqueue({ key: 'receipt', payload: { sessionId: 's', turnId: '1', outcome: 'unknown' }, sessionId: 's',
    deadline: deadlineFromReceipt({ receiptExpiresAt: clock.wallMs + 100, wallNow: clock.wallMs,
      now: clock.now(), maxAgeMs: 300_000, clockUnit: 's' }) })
  queue.attempt('receipt')
  clock.advance(250)
  assert.equal(calls, 1, 'a retry beyond the receipt deadline is never sent')
  assert.equal(queue.history().at(-1).state, 'exhausted')
  queue.dispose()
})

test('an injected receipt conversion bounds the settlement the queue actually retries', () => {
  const clock = fakeClock()
  let calls = 0
  // The queue clock is monotonic seconds while the receipt arrives in epoch milliseconds:
  // the conversion must be applied by the queue itself, not by the caller passing a deadline.
  const queue = new SettlementQueue({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    deadlineForReceipt: ({ receiptExpiresAt, now }) => deadlineFromReceipt({ receiptExpiresAt,
      wallNow: clock.wallMs, now, maxAgeMs: 300_000, clockUnit: 's' }),
    complete: () => { calls += 1; throw error('lock_busy') } })
  queue.enqueue({ key: 'near', payload: { sessionId: 's', turnId: '1', outcome: 'unknown' }, sessionId: 's',
    receiptExpiresAt: clock.wallMs + 100 })
  assert.ok(queue.entry('near').deadline <= clock.now() + 0.1 + Number.EPSILON,
    'the receipt bound is applied at enqueue time')
  queue.attempt('near')
  clock.advance(250)
  assert.equal(calls, 1, 'no retry may outlive the receipt')
  assert.equal(queue.history().at(-1).state, 'exhausted')
  // A far receipt leaves the five-minute age bound in charge: 300 seconds on this clock.
  queue.enqueue({ key: 'far', payload: { sessionId: 's', turnId: '2', outcome: 'unknown' }, sessionId: 's',
    receiptExpiresAt: clock.wallMs + 3_600_000 })
  assert.equal(queue.entry('far').deadline, clock.now() + 300)
  // A conversion that cannot complete never loses the age bound.
  const broken = new SettlementQueue({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    deadlineForReceipt: () => { throw error('clock_unavailable') }, complete: () => ({ ok: true }) })
  broken.enqueue({ key: 'broken', payload: { sessionId: 's', turnId: '3', outcome: 'unknown' }, sessionId: 's',
    receiptExpiresAt: clock.wallMs + 100 })
  assert.equal(broken.entry('broken').deadline, clock.now() + 300_000)
  queue.dispose()
  broken.dispose()
})

test('a read-only enablement recompute neither writes nor resumes the queue', async t => {
  const f = fixture(t)
  const realApply = f.engine.settlementApply.bind(f.engine)
  let applies = 0
  // The first attempt fails transiently, so one item is waiting when the read happens.
  f.engine.settlementApply = (...args) => { applies += 1
    throw Object.assign(new Error('busy'), { code: 'lock_busy' }) }
  const decision = await f.step()
  await f.adopt(decision.messages)
  f.verify()
  f.end()
  assert.equal(applies, 1)
  assert.equal(f.bridge.settlementStatus().length, 1, 'one item is waiting')
  f.engine.settlementApply = (...args) => { applies += 1; return realApply(...args) }

  // Recomputing enablement while answering a read must not schedule anything: looking at the
  // settings page cannot be what settles work.
  f.bridge.setEnabled(false, { resume: false })
  f.bridge.setEnabled(true, { resume: false })
  await settled()
  assert.equal(applies, 1, 'a read-only recompute never attempts a settlement')
  assert.equal(f.bridge.settlementStatus().length, 1)

  // The explicit lifecycle moment still resumes the same item, with its original deadline.
  const deadline = f.bridge.settlementStatus()[0].deadline
  f.bridge.setEnabled(true, { resume: true })
  f.clock.advance(250)
  await settled()
  assert.equal(applies, 2, 'an explicit resume retries the pending item')
  assert.ok(f.bridge.settlementStatus().length <= 1)
  void deadline
})

test('an entry that waits behind a temporary gate is bounded by its deadline, not by four tries', () => {
  const clock = fakeClock()
  let attempts = 0
  const queue = new SettlementQueue({ now: clock.now, schedule: clock.schedule, cancel: clock.cancel,
    complete: () => { attempts += 1; throw Object.assign(new Error('paused'), { code: 'settlement_paused' }) },
    isTransient: error => error?.code === 'settlement_paused', maxAgeMs: 60_000 })
  queue.enqueue({ key: 'k', payload: { turnId: '1' }, sessionId: 's', deadline: clock.now() + 60_000, maxAttempts: 20 })
  queue.attempt('k')
  for (let round = 0; round < 8; round++) clock.advance(4000)
  assert.ok(attempts > 4, 'a gate refusal keeps waiting for its resume instead of exhausting at four')
  assert.equal(queue.status().length, 1)
  assert.equal(queue.status()[0].state, 'pending')
})
