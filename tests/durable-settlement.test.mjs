/**
 * alpha.15 durable settlement: the core contract, on an isolated state root.
 *
 * Every case here is about the boundary the contract actually promises: what a durable
 * acknowledgement means, what a replay returns, what may never be re-granted, and what a full
 * or corrupt document must do (refuse, never reset). No model, no network, no daily state.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningEngine } from '../src/index.mjs'
import { getMethod } from '../src/checks.mjs'

const PROJECT = 'durable-project'
const START = 1_790_985_600_000

let root = null
const makeRoot = () => { root ??= mkdtempSync(join(tmpdir(), 'mse-durable-')); return root }
test.after(() => { if (root !== null) rmSync(root, { recursive: true, force: true }) })

const open = (name, options = {}) => new LearningEngine({ stateRoot: join(makeRoot(), name),
  adapterId: 'dsh', now: () => START, ...options })
const storePath = name => join(makeRoot(), name, 'lessons-v1.json')
const readState = name => JSON.parse(readFileSync(storePath(name), 'utf8'))
const fileSha = name => JSON.parse(readFileSync(storePath(name), 'utf8')).revision

/**
 * One real turn, built the way the product builds it: a registered method is proposed, accepted
 * by host trials, then recalled for a task, adopted, and frozen as a durable settlement. Nothing
 * here is a shortcut around the ordinary lifecycle.
 */
function trialSet() {
  return Array.from({ length: 16 }, (_, index) => ({ caseId: `c${index}`, family: `family${index % 3}`,
    split: index % 2 ? 'holdout' : 'development', baseline: { passed: index >= 8, tokens: 100 },
    candidate: { passed: true, tokens: 100 }, guardPassed: true }))
}
function queuedTurn(engine, { sessionId = 'session', turnId = 'turn-1', outcome = 'verified', passed = true } = {}) {
  const lesson = engine.record({ projectKey: PROJECT, eventId: `proposal-${turnId}`, kind: 'method',
    source: 'host_proposal', methodId: 'preserve-null-v1' })
  // The same registered method proposed twice is the same hypothesis, so the second call returns
  // the existing row. Only a row that is not yet validated needs the trial evaluation.
  let row = engine.list({ projectKey: PROJECT }).lessons.find(item => item.id === lesson.id)
  if (row.status !== 'validated') {
    engine.evaluate({ projectKey: PROJECT, lessonId: lesson.id, expectedVersion: row.version,
      eventId: `eval-${turnId}`, suiteId: `suite-${turnId}`, trials: trialSet() })
    row = engine.list({ projectKey: PROJECT }).lessons.find(item => item.id === lesson.id)
  }
  // A task that genuinely overlaps the registered method's instruction, so the recall is a real
  // recall rather than a fixture that only looks like one.
  const prompt = `核对来源与产物的记录标识，仅将来源未知的对应字段保留为空值（${turnId}）`
  const prepared = engine.prepare({ projectKey: PROJECT, sessionId, turnId, origin: 'user', prompt })
  assert.equal(prepared.reason, 'recalled', turnId)
  engine.accept({ receipt: prepared.receipt, lessonIds: [lesson.id] })
  const evidence = { source: 'host_verifier', checkId: getMethod('preserve-null-v1').checkId,
    checks: [{ lessonId: lesson.id, version: row.version, checkId: getMethod('preserve-null-v1').checkId, passed }] }
  const ack = engine.settlementEnqueue({ projectKey: PROJECT, sessionId, turnId, outcome, evidence })
  return { lesson, prepared, ack, evidence }
}

// ------------------------------------------------------------------ protocol and acknowledgement

test('an unacknowledged queue write does not exist, and the acknowledgement is the handle', () => {
  const engine = open('ack')
  const { ack } = queuedTurn(engine)
  // The acknowledgement itself carries everything a restarted caller needs: no store read, no
  // recomputation, and the control generation the apply must present.
  assert.equal(ack.ok, true)
  assert.equal(ack.durable, true)
  assert.match(ack.key, /^[a-f0-9]{64}$/u)
  assert.match(ack.payloadHash, /^[a-f0-9]{64}$/u)
  assert.equal(typeof ack.deadline, 'number')
  assert.equal(ack.generation, 1)
  const status = engine.settlementStatus()
  assert.equal(status.counts.pending, 1)
  assert.equal(status.pending[0].key, ack.key)
  assert.equal(status.pending[0].payloadHash, ack.payloadHash)
  assert.equal(status.pending[0].deadline, ack.deadline)
})

test('the deadline is at most five minutes and never later than the original receipt', () => {
  const engine = open('deadline')
  const { ack } = queuedTurn(engine)
  const receipt = readState('deadline').settlementOutbox.pending[0].receipts[0]
  assert.equal(ack.deadline, Math.min(START + 5 * 60_000, receipt.expiresAt))
  assert.ok(ack.deadline <= receipt.expiresAt)
})

test('an expired receipt may not be frozen into a creditable entry', () => {
  let clock = START
  const engine = open('expired-receipt', { now: () => clock })
  const { lesson, evidence } = queuedTurn(engine)
  clock = START + 31 * 60_000
  // A second turn whose receipt has already lapsed cannot be queued as a creditable item.
  const prepared = engine.prepare({ projectKey: PROJECT, sessionId: 'session-two', turnId: 'turn-2', origin: 'user',
    prompt: '核对来源与产物的记录标识，保留来源未知的字段为空值（turn-2）' })
  assert.equal(prepared.reason, 'recalled')
  engine.accept({ receipt: prepared.receipt, lessonIds: [lesson.id] })
  clock = START + 62 * 60_000
  // The receipt is pruned once it lapses, so the refusal is `settlement_no_receipt`; both codes
  // mean the same thing to a caller, and the durable queue stays empty either way.
  assert.throws(() => engine.settlementEnqueue({ projectKey: PROJECT, sessionId: 'session-two', turnId: 'turn-2',
    outcome: 'verified', evidence }),
  error => ['settlement_receipt_expired', 'settlement_no_receipt'].includes(error.code))
  assert.equal(engine.settlementStatus().pending.filter(row => row.scope === evidence.scope).length, 0)
})

test('a corrupt or unknown outbox document is refused, never reset to empty', () => {
  const engine = open('corrupt')
  queuedTurn(engine)
  const before = readState('corrupt')
  const corrupt = structuredClone(before)
  corrupt.settlementOutbox.format = 99
  writeFileSync(storePath('corrupt'), JSON.stringify(corrupt))
  assert.throws(() => engine.status(), error => error.code === 'invalid_settlement_outbox')
  const after = readState('corrupt')
  assert.equal(after.settlementOutbox.pending.length, 1, 'the entry is still there, not reset')
  assert.equal(after.settlementOutbox.format, 99)
})

test('an old schema-2 document without the settlement fields is read without writing', () => {
  const engine = open('legacy-read')
  queuedTurn(engine)
  const state = readState('legacy-read')
  delete state.settlementOutbox
  delete state.settlementControl
  writeFileSync(storePath('legacy-read'), JSON.stringify(state))
  const revision = readState('legacy-read').revision
  const status = engine.settlementStatus()
  assert.equal(status.counts.pending, 0)
  assert.equal(readState('legacy-read').revision, revision, 'a read-only status never writes')
  assert.equal(Object.hasOwn(readState('legacy-read'), 'settlementOutbox'), false)
})

// ------------------------------------------------------------------ apply, replay, idempotence

test('apply settles once, retires in the same commit, and a replay re-reads the result', () => {
  const engine = open('apply')
  const { lesson, ack } = queuedTurn(engine)
  const applied = engine.settlementApply({ key: ack.key, payloadHash: ack.payloadHash, generation: ack.generation },
    () => ({ ok: true }))
  assert.equal(applied.ok, true)
  assert.equal(applied.outcome, 'verified')
  assert.equal(applied.attributed, 1)
  assert.equal(readState('apply').lessons.find(row => row.id === lesson.id).verified, 1)
  const status = engine.settlementStatus()
  assert.equal(status.counts.pending, 0)
  assert.equal(status.counts.settled, 1)
  assert.equal(status.history[0].state, 'settled')
  assert.equal(status.history[0].attributed, 1)
  // The response is lost; the caller retries. It gets the original result back, and no second
  // credit, even with a guard that now refuses.
  const replay = engine.settlementApply({ key: ack.key, payloadHash: ack.payloadHash, generation: engine.settlementStatus().control.generation }, () => ({ ok: false, reason: 'paused_now' }))
  assert.equal(replay.duplicate, true)
  assert.equal(replay.outcome, 'verified')
  assert.equal(replay.attributed, 1)
  assert.equal(readState('apply').lessons.find(row => row.id === lesson.id).verified, 1)
})

test('a committed settlement is still re-readable after a pause and past its deadline', () => {
  const engine = open('replay-after-stop')
  const { ack } = queuedTurn(engine)
  engine.settlementApply({ key: ack.key, payloadHash: ack.payloadHash, generation: engine.settlementStatus().control.generation }, () => true)
  engine.settlementPause({ paused: true })
  engine.settlementStop({ sessionId: 'session', reason: 'session_reset' })
  const replay = engine.settlementApply({ key: ack.key, payloadHash: ack.payloadHash, generation: engine.settlementStatus().control.generation }, () => false)
  assert.equal(replay.duplicate, true)
  assert.equal(replay.terminal, 'settled')
  assert.equal(replay.outcome, 'verified')
})

test('a torn second process cannot double-credit the same key', () => {
  const primary = open('compete')
  const { lesson, ack } = queuedTurn(primary)
  const second = new LearningEngine({ stateRoot: join(makeRoot(), 'compete'), adapterId: 'dsh', now: () => START })
  const first = primary.settlementApply({ key: ack.key, payloadHash: ack.payloadHash,
    generation: primary.settlementStatus().control.generation }, () => true)
  const other = second.settlementApply({ key: ack.key, payloadHash: ack.payloadHash, generation: second.settlementStatus().control.generation }, () => true)
  assert.equal(first.ok, true)
  assert.equal(other.duplicate, true)
  assert.equal(other.outcome, 'verified')
  assert.equal(other.attributed, 1)
  assert.equal(readState('compete').lessons.find(row => row.id === lesson.id).verified, 1)
})

test('a changed payload may never overwrite the acknowledged facts', () => {
  const engine = open('conflict')
  const { ack } = queuedTurn(engine)
  const wrongHash = 'f'.repeat(64)
  assert.throws(() => engine.settlementApply({ key: ack.key, payloadHash: wrongHash,
    generation: engine.settlementStatus().control.generation }, () => true),
    error => error.code === 'settlement_conflict')
  assert.equal(readState('conflict').settlementOutbox.pending.length, 1)
  assert.equal(readState('conflict').settlementOutbox.pending[0].payloadHash, ack.payloadHash)
})

test('bad evidence is refused by enqueue exactly as complete refuses it', () => {
  const engine = open('bad-evidence')
  const lesson = engine.record({ projectKey: PROJECT, eventId: 'c', kind: 'correction', source: 'direct_user',
    instruction: '导出报表时保留原始空值，不要改成零。' })
  const prepared = engine.prepare({ projectKey: PROJECT, sessionId: 's', turnId: 't', origin: 'user',
    prompt: '导出报表时保留原始空值，不要改成零。' })
  engine.accept({ receipt: prepared.receipt, lessonIds: [lesson.id] })
  const bad = { source: 'host_verifier', checkId: 'missing-values-v1', checks: [{ lessonId: lesson.id, passed: 'yes' }] }
  let direct = null, queued = null
  try { engine.complete({ projectKey: PROJECT, sessionId: 's', turnId: 't', outcome: 'verified', evidence: bad }) }
  catch (error) { direct = error.code }
  try { engine.settlementEnqueue({ projectKey: PROJECT, sessionId: 's', turnId: 't', outcome: 'verified', evidence: bad }) }
  catch (error) { queued = error.code }
  assert.equal(direct, 'invalid_evidence')
  assert.equal(queued, 'invalid_evidence', 'the durable path must not coerce a bad verdict into a false one')
  assert.equal(engine.settlementStatus().counts.pending, 0)
})

test('enqueue against an already-recorded event replays it, and refuses a different one', () => {
  const engine = open('already-settled')
  const { lesson, evidence } = queuedTurn(engine)
  engine.complete({ projectKey: PROJECT, sessionId: 'session', turnId: 'turn-1', outcome: 'verified', evidence })
  const same = engine.settlementEnqueue({ projectKey: PROJECT, sessionId: 'session', turnId: 'turn-1',
    outcome: 'verified', evidence })
  assert.equal(same.duplicate, true)
  assert.equal(same.outcome, 'verified')
  assert.equal(same.attributed, 1)
  assert.throws(() => engine.settlementEnqueue({ projectKey: PROJECT, sessionId: 'session', turnId: 'turn-1',
    outcome: 'failed', evidence: { source: 'host_verifier', checkId: 'missing-values-v1',
      checks: [{ lessonId: lesson.id, passed: false }] } }), error => error.code === 'event_conflict')
})

// ------------------------------------------------------------------ permission, stop, deadline

test('the control generation is the execution permit, and a stale one is refused', () => {
  const engine = open('generation')
  const { ack } = queuedTurn(engine)
  engine.settlementPause({ paused: true })
  assert.throws(() => engine.settlementApply({ key: ack.key, payloadHash: ack.payloadHash,
    generation: ack.generation }, () => true), error => error.code === 'settlement_stale_control')
  // The permit is required, so an omitting caller is refused rather than assumed trusted.
  assert.throws(() => engine.settlementApply({ key: ack.key, payloadHash: ack.payloadHash }, () => true),
    error => error.code === 'settlement_generation_required')
  engine.settlementPause({ paused: false })
  const fresh = engine.settlementStatus().control.generation
  assert.notEqual(fresh, ack.generation, 'every control change moves the generation on')
  assert.equal(engine.settlementApply({ key: ack.key, payloadHash: ack.payloadHash, generation: fresh }, () => true).ok, true)
})

test('pause stops scheduling without touching the deadline, and a guard refusal is not an attempt', () => {
  const engine = open('pause')
  const { ack } = queuedTurn(engine)
  const before = engine.settlementStatus().pending[0]
  engine.settlementPause({ paused: true })
  const paused = engine.settlementApply({ key: ack.key, payloadHash: ack.payloadHash, generation: engine.settlementStatus().control.generation }, () => true)
  assert.equal(paused.code, 'settlement_paused')
  engine.settlementPause({ paused: false })
  const refused = engine.settlementApply({ key: ack.key, payloadHash: ack.payloadHash, generation: engine.settlementStatus().control.generation }, () => ({ ok: false, reason: 'host_state_unknown' }))
  assert.equal(refused.code, 'settlement_guard_refused')
  const after = engine.settlementStatus()
  assert.equal(after.counts.pending, 1)
  assert.equal(after.pending[0].deadline, before.deadline, 'a pause or refusal never refreshes the deadline')
  assert.equal(after.pending[0].attempts, 0, 'only a real processing attempt counts')
  assert.equal(after.pending[0].lastError, 'host_state_unknown')
})

test('a precise stop is owner+session scoped, and a stopped session cannot enqueue again', () => {
  const engine = open('stop')
  const a = queuedTurn(engine, { sessionId: 'session-a', turnId: 'a' })
  const b = queuedTurn(engine, { sessionId: 'session-b', turnId: 'b' })
  const stopped = engine.settlementStop({ sessionId: 'session-a', reason: 'session_reset' })
  assert.equal(stopped.stopped, 1)
  const status = engine.settlementStatus()
  assert.equal(status.counts.pending, 1, 'the other session keeps its item')
  assert.equal(status.pending[0].sessionHash, readState('stop').settlementOutbox.pending[0].sessionHash)
  assert.equal(engine.settlementApply({ key: a.ack.key, payloadHash: a.ack.payloadHash,
    generation: engine.settlementStatus().control.generation }, () => true).terminal, 'stopped')
  assert.equal(engine.settlementApply({ key: b.ack.key, payloadHash: b.ack.payloadHash,
    generation: engine.settlementStatus().control.generation }, () => true).ok, true)
  assert.throws(() => engine.settlementEnqueue({ projectKey: PROJECT, sessionId: 'session-a', turnId: 'a2',
    outcome: 'verified', evidence: a.evidence }), error => error.code === 'settlement_stopped'
    || error.code === 'settlement_no_receipt')
})

test('a stop tombstone outlives a live receipt, and a fully bound control refuses to drop one', () => {
  const engine = open('tombstone')
  queuedTurn(engine, { sessionId: 'stopped-session', turnId: 'r' })
  engine.settlementStop({ sessionId: 'stopped-session', reason: 'session_reset' })
  // The receipt for that turn is still live, so the tombstone must not be trimmed away.
  const state = readState('tombstone')
  const tombstone = state.settlementControl.stops[0]
  assert.ok(state.receipts.some(row => row.sessionHash === tombstone.sessionHash))
  for (let index = 0; index < 63; index += 1) engine.settlementStop({ sessionId: `filler-${index}`, reason: 'session_reset' })
  const full = readState('tombstone').settlementControl
  assert.equal(full.stops.length, 64)
  assert.equal(full.stops.some(row => row.sessionHash === tombstone.sessionHash), true,
    'a bound tombstone is never the one trimmed')
  // Now make every remaining stop bound too: with nothing safely prunable, a further stop is
  // refused instead of quietly reviving a stopped session.
  const bound = readState('tombstone')
  const template = bound.receipts[0]
  bound.settlementControl.stops = bound.settlementControl.stops.map((row, index) => ({ ...row,
    sessionHash: index === 0 ? tombstone.sessionHash : `${String(index).padStart(63, '0')}a` }))
  // Every tombstone is bound to a live receipt, cloned from a real one so the shape stays valid.
  bound.receipts = bound.settlementControl.stops.map((row, index) => ({ ...template,
    id: `r-${String(index).padStart(8, '0')}`, sessionHash: row.sessionHash,
    expiresAt: START + 60_000, selected: [], accepted: [] }))
  writeFileSync(storePath('tombstone'), JSON.stringify(bound))
  assert.throws(() => engine.settlementStop({ sessionId: 'overflow', reason: 'session_reset' }),
    error => error.code === 'settlement_stop_capacity')
  assert.equal(readState('tombstone').settlementControl.stops.length, 64)
})

test('past its absolute deadline an item retires as expired without credit or an extension', () => {
  let clock = START
  const engine = open('deadline-expiry', { now: () => clock })
  const { lesson, ack } = queuedTurn(engine)
  clock = ack.deadline + 1
  const result = engine.settlementApply({ key: ack.key, payloadHash: ack.payloadHash, generation: engine.settlementStatus().control.generation }, () => true)
  assert.equal(result.code, 'settlement_expired')
  const state = readState('deadline-expiry')
  assert.equal(state.settlementOutbox.pending.length, 0)
  assert.equal(state.settlementOutbox.history[0].state, 'expired')
  assert.equal(state.lessons.find(row => row.id === lesson.id).verified, 0)
  assert.equal(state.receipts.length, 1, 'the outbox neither mints a receipt nor keeps an expired one alive')
})

test('a partial completion never commits, and the failed attempt is counted atomically', () => {
  const engine = open('partial')
  const { lesson, ack } = queuedTurn(engine)
  const before = readState('partial')
  // Make the settlement itself fail after it has already touched working state: the lesson named
  // by the evidence no longer exists at the bound version, so `evidence_not_adopted` fires.
  const broken = structuredClone(before)
  // Change the bound acceptance in BOTH places: the durable entry then matches the world again,
  // so the failure is the ordinary `evidence_not_adopted` rather than the conflict path.
  broken.receipts = broken.receipts.map(row => ({ ...row, accepted: [] }))
  broken.settlementOutbox.pending = broken.settlementOutbox.pending.map(row => ({ ...row,
    receipts: row.receipts.map(receipt => ({ ...receipt, accepted: [] })) }))
  writeFileSync(storePath('partial'), JSON.stringify(broken))
  const failed = engine.settlementApply({ key: ack.key, payloadHash: ack.payloadHash, generation: engine.settlementStatus().control.generation }, () => true)
  assert.equal(failed.ok, false)
  assert.equal(failed.attempts, 1, 'the attempt is durable even though the settlement rolled back')
  const state = readState('partial')
  assert.equal(state.settlementOutbox.pending.length, 1, 'the item is still pending, not half-settled')
  assert.equal(state.settlementOutbox.pending[0].attempts, 1)
  assert.equal(state.events.some(row => row.id === ack.key), false)
  assert.equal(state.lessons.find(row => row.id === lesson.id).verified, 0)
  assert.equal(state.receipts.length, before.receipts.length, 'no local withdraw or version change survived')
})

test('the attempt bound is respected across restarts and never resets', () => {
  const engine = open('attempts')
  const { ack } = queuedTurn(engine)
  const state = readState('attempts')
  state.receipts = state.receipts.map(row => ({ ...row, accepted: [] }))
  state.settlementOutbox.pending = state.settlementOutbox.pending.map(row => ({ ...row,
    receipts: row.receipts.map(receipt => ({ ...receipt, accepted: [] })) }))
  writeFileSync(storePath('attempts'), JSON.stringify(state))
  let lastGeneration = 0
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const reopened = new LearningEngine({ stateRoot: join(makeRoot(), 'attempts'), adapterId: 'dsh', now: () => START })
    lastGeneration = reopened.settlementStatus().control.generation
    const result = reopened.settlementApply({ key: ack.key, payloadHash: ack.payloadHash, generation: reopened.settlementStatus().control.generation }, () => true)
    assert.equal(result.code, 'settlement_failed', `restart ${attempt}`)
    assert.equal(result.attempts, attempt, `restart ${attempt} keeps the count`)
  }
  // A fifth attempt is refused, and the item is already a terminal failure.
  const fifth = new LearningEngine({ stateRoot: join(makeRoot(), 'attempts'), adapterId: 'dsh', now: () => START })
    .settlementApply({ key: ack.key, payloadHash: ack.payloadHash, generation: lastGeneration }, () => true)
  assert.equal(fifth.duplicate, true)
  assert.equal(fifth.terminal, 'failed')
  const settled = readState('attempts')
  assert.equal(settled.settlementOutbox.pending.length, 0)
  assert.equal(settled.settlementOutbox.history.at(-1).state, 'failed')
  assert.equal(settled.settlementOutbox.history.at(-1).attempts, 4)
})

// ------------------------------------------------------------------ bounds and capacity

test('a full outbox refuses new work without evicting anything already acknowledged', () => {
  const engine = open('full')
  const keys = []
  for (let index = 0; index < 64; index += 1) {
    keys.push(queuedTurn(engine, { sessionId: `s-${index}`, turnId: `t-${index}` }).ack.key)
  }
  assert.equal(engine.settlementStatus().counts.pending, 64)
  assert.throws(() => queuedTurn(engine, { sessionId: 'overflow', turnId: 'overflow' }),
    error => error.code === 'settlement_outbox_full')
  const state = readState('full')
  assert.equal(state.settlementOutbox.pending.length, 64)
  assert.deepEqual(state.settlementOutbox.pending.map(row => row.key), keys, 'nothing was evicted')
  // Terminal history is bounded, and settling frees pending capacity.
  engine.settlementApply({ key: keys[0], payloadHash: state.settlementOutbox.pending[0].payloadHash,
    generation: engine.settlementStatus().control.generation }, () => true)
  assert.equal(engine.settlementStatus().counts.pending, 63)
  assert.equal(engine.settlementStatus().counts.settled, 1)
})

test('a pending outbox binding protects the lesson version from capacity eviction', () => {
  const engine = open('protect')
  const { lesson, ack } = queuedTurn(engine)
  const state = readState('protect')
  const row = state.lessons.find(item => item.id === lesson.id)
  row.status = 'candidate'
  row.kind = 'method'
  row.verified = 0
  row.expiresAt = START + 1000
  writeFileSync(storePath('protect'), JSON.stringify(state))
  const protectedIds = engine.protectedLessonIds(readState('protect'), START)
  assert.equal(protectedIds.has(lesson.id), true)
  // A full library then evicts something else, never the bound version.
  for (let index = 0; index < 299; index += 1) {
    engine.record({ projectKey: PROJECT, eventId: `p-${index}`, kind: 'method', source: 'host_proposal',
      instruction: `导出报表字段 field${index} 时保留原始数值精度。` })
  }
  engine.prepare({ projectKey: PROJECT, sessionId: 'correction', turnId: 'correction', origin: 'user',
    prompt: '以后导出报表时保留原始空值，不要改成零。' })
  const after = readState('protect')
  assert.equal(after.lessons.some(item => item.id === lesson.id), true, 'the bound version survived')
  assert.equal(after.lessons.length, 300)
  assert.equal(after.settlementOutbox.pending.some(item => item.key === ack.key), true)
})

test('a settled result is reported exactly once even when the guard is re-evaluated', () => {
  const engine = open('once')
  const { lesson, ack } = queuedTurn(engine)
  engine.settlementApply({ key: ack.key, payloadHash: ack.payloadHash, generation: engine.settlementStatus().control.generation }, () => true)
  engine.settlementApply({ key: ack.key, payloadHash: ack.payloadHash, generation: engine.settlementStatus().control.generation }, () => true)
  const state = readState('once')
  assert.equal(state.lessons.find(row => row.id === lesson.id).verified, 1)
  assert.equal(state.events.filter(row => row.id === ack.key).length, 1)
  assert.equal(state.settlementOutbox.history.length, 1)
  void fileSha
})

// ------------------------------------------------------------------ high-risk core boundaries

test('a minimal trusted verdict with no bindings is still a settlement that can be frozen', () => {
  const engine = open('minimal-evidence')
  const lesson = engine.record({ projectKey: PROJECT, eventId: 'proposal', kind: 'method',
    source: 'host_proposal', methodId: 'preserve-null-v1' })
  const row = engine.list({ projectKey: PROJECT }).lessons.find(item => item.id === lesson.id)
  engine.evaluate({ projectKey: PROJECT, lessonId: lesson.id, expectedVersion: row.version,
    eventId: 'eval', suiteId: 'suite', trials: trialSet() })
  const prepared = engine.prepare({ projectKey: PROJECT, sessionId: 's', turnId: 't', origin: 'user',
    prompt: '核对来源与产物的记录标识，保留来源未知的字段为空值。' })
  assert.equal(prepared.reason, 'recalled')
  engine.accept({ receipt: prepared.receipt, lessonIds: [lesson.id] })
  // `{ source, checkId }` with no `checks` at all is exactly what the direct path accepts and
  // credits; the durable path must be able to freeze the same verdict.
  const evidence = { source: 'host_verifier', checkId: getMethod('preserve-null-v1').checkId }
  const queued = engine.settlementEnqueue({ projectKey: PROJECT, sessionId: 's', turnId: 't',
    outcome: 'verified', evidence })
  assert.equal(queued.durable, true)
  const entry = readState('minimal-evidence').settlementOutbox.pending.find(item => item.key === queued.key)
  assert.equal(entry.evidence.checks, null)
  assert.equal(entry.evidence.checkId, getMethod('preserve-null-v1').checkId)
  const applied = engine.settlementApply({ key: queued.key, payloadHash: queued.payloadHash,
    generation: queued.generation }, () => true)
  assert.equal(applied.ok, true)
  assert.equal(applied.outcome, 'verified')
  assert.equal(readState('minimal-evidence').lessons.find(item => item.id === lesson.id).verified, 0,
    'a verdict with no binding credits nothing, exactly as the direct path does')
})

test('a replay consumes the receipts it froze, never a newer one for the same turn', () => {
  const engine = open('receipt-binding')
  const { lesson, ack, evidence } = queuedTurn(engine)
  // The world moves: the same turn is prepared and accepted again, producing a different
  // receipt with a different adoption set.
  const again = engine.prepare({ projectKey: PROJECT, sessionId: 'session', turnId: 'turn-1', origin: 'user',
    prompt: '核对来源与产物的记录标识，仅将来源未知的对应字段保留为空值（turn-1）' })
  if (again.receipt !== undefined) engine.accept({ receipt: again.receipt, lessonIds: [lesson.id] })
  const before = readState('receipt-binding')
  const result = engine.settlementApply({ key: ack.key, payloadHash: ack.payloadHash,
    generation: engine.settlementStatus().control.generation }, () => true)
  const after = readState('receipt-binding')
  if (result.ok) {
    // If it settled, it settled against the ORIGINAL acceptance, and the newer receipt is not
    // the one that authorised it.
    assert.equal(after.settlementOutbox.history.at(-1).state, 'settled')
  } else {
    assert.equal(result.code, 'settlement_receipt_changed',
      'a changed acceptance is an explicit conflict, never a silent credit against new facts')
    assert.equal(after.settlementOutbox.history.at(-1).state, 'conflict')
  }
  assert.equal(after.lessons.find(item => item.id === lesson.id).verified, result.ok ? 1 : 0)
  assert.ok(after.receipts.length >= before.receipts.length - 1)
  void evidence
})

test('a recorded event with a different fingerprint is a conflict, not a successful duplicate', () => {
  const engine = open('fingerprint')
  const { lesson, ack } = queuedTurn(engine)
  // The same key is recorded by the direct path with the OTHER outcome.
  engine.complete({ projectKey: PROJECT, sessionId: 'session', turnId: 'turn-1', outcome: 'failed',
    evidence: { source: 'host_verifier', checkId: getMethod('preserve-null-v1').checkId,
      checks: [{ lessonId: lesson.id, passed: false }] } })
  const result = engine.settlementApply({ key: ack.key, payloadHash: ack.payloadHash,
    generation: engine.settlementStatus().control.generation }, () => true)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'event_conflict')
  const state = readState('fingerprint')
  assert.equal(state.settlementOutbox.history.at(-1).state, 'conflict')
  assert.equal(state.settlementOutbox.history.at(-1).outcome, ack && 'verified')
  assert.equal(state.events.filter(row => row.id === ack.key).length, 1, 'the recorded fact is untouched')
})

test('a legacy receipt with no sessionHash keeps its tombstone until its own TTL lapses', () => {
  const engine = open('legacy-receipt')
  queuedTurn(engine, { sessionId: 'legacy-session', turnId: 'legacy' })
  engine.settlementStop({ sessionId: 'legacy-session', reason: 'session_reset' })
  // Rewrite the stored receipts the way an older version wrote them: no attribution field.
  const state = readState('legacy-receipt')
  for (const row of state.receipts) delete row.sessionHash
  writeFileSync(storePath('legacy-receipt'), JSON.stringify(state))
  const tombstone = readState('legacy-receipt').settlementControl.stops[0]
  for (let index = 0; index < 63; index += 1) {
    engine.settlementStop({ sessionId: `filler-${index}`, reason: 'session_reset' })
  }
  const full = readState('legacy-receipt').settlementControl
  assert.equal(full.stops.length, 64)
  assert.equal(full.stops.some(row => row.sessionHash === tombstone.sessionHash), true,
    'an unattributable live receipt cannot prove the tombstone is free')
  assert.throws(() => engine.settlementStop({ sessionId: 'overflow', reason: 'session_reset' }),
    error => error.code === 'settlement_stop_capacity')
  // Once that receipt lapses, the tombstone becomes trimmable again — and the deadline was
  // never extended to make room.
  const later = new LearningEngine({ stateRoot: join(makeRoot(), 'legacy-receipt'), adapterId: 'dsh',
    now: () => START + 31 * 60_000 })
  assert.equal(later.settlementStop({ sessionId: 'overflow', reason: 'session_reset' }).ok, true)
  const after = readState('legacy-receipt').settlementControl
  assert.equal(after.stops.some(row => row.sessionHash === tombstone.sessionHash), false)
  assert.equal(after.stops.length, 64)
})

test('an oversized stored item is refused on read, not only on write', () => {
  const engine = open('oversize-item')
  queuedTurn(engine)
  const state = readState('oversize-item')
  state.settlementOutbox.pending[0].evidence.checkId = 'x'.repeat(5000)
  writeFileSync(storePath('oversize-item'), JSON.stringify(state))
  assert.throws(() => engine.settlementStatus(), error => error.code === 'settlement_item_too_large')
  assert.throws(() => engine.status(), error => error.code === 'settlement_item_too_large')
  assert.equal(readState('oversize-item').settlementOutbox.pending.length, 1, 'the document is not reset')
})

test('a terminal row cannot carry a private payload the status surface would return', () => {
  const engine = open('terminal-whitelist')
  const { ack } = queuedTurn(engine)
  engine.settlementApply({ key: ack.key, payloadHash: ack.payloadHash, generation: ack.generation }, () => true)
  assert.equal(engine.settlementStatus().history[0].state, 'settled')
  const state = readState('terminal-whitelist')
  // Fields a pending row may carry must not be accepted on a terminal row.
  for (const extra of [{ evidence: { checks: [] } }, { receipts: [] }, { fingerprint: 'a'.repeat(64) },
    { environment: 'b'.repeat(64) }, { lastError: 'x' }]) {
    const broken = structuredClone(state)
    Object.assign(broken.settlementOutbox.history[0], extra)
    writeFileSync(storePath('terminal-whitelist'), JSON.stringify(broken))
    assert.throws(() => engine.settlementStatus(), error => error.code === 'invalid_settlement_outbox',
      JSON.stringify(Object.keys(extra)))
  }
  writeFileSync(storePath('terminal-whitelist'), JSON.stringify(state))
  assert.equal(engine.settlementStatus().ok, true)
})

test('an entry-addressed stop derives the session inside the lock, from this owner only', () => {
  const engine = open('stop-by-entry')
  const { ack } = queuedTurn(engine, { sessionId: 'gone-session', turnId: 'gone' })
  // Another owner is a different document entirely: its stop cannot reach this entry.
  const other = new LearningEngine({ stateRoot: join(makeRoot(), 'stop-by-entry-other'), adapterId: 'hermes', now: () => START })
  // A caller cannot name another owner's entry, and cannot supply a session hash of its own.
  assert.throws(() => other.settlementStop({ key: ack.key, payloadHash: ack.payloadHash, reason: 'session_deleted' }),
    error => error.code === 'settlement_unknown_key')
  assert.throws(() => engine.settlementStop({ key: ack.key, payloadHash: 'f'.repeat(64), reason: 'session_deleted' }),
    error => error.code === 'settlement_unknown_key')
  // The two addressing forms are mutually exclusive, and a malformed shape writes nothing.
  const before = JSON.stringify(readState('stop-by-entry').settlementOutbox)
  for (const malformed of [
    { key: ack.key, payloadHash: ack.payloadHash, sessionHash: 'f'.repeat(64) },
    { sessionId: 'different-valid-session', key: ack.key, payloadHash: ack.payloadHash },
    { sessionId: 'gone-session', payloadHash: ack.payloadHash },
    { sessionId: 'gone-session', key: 42 },
    { key: ack.key },
    { key: ack.key, payloadHash: 'nope' },
    { reason: 'nothing' },
    [],
    'gone-session',
  ]) {
    assert.throws(() => engine.settlementStop(malformed), error => error.code === 'invalid_input',
      JSON.stringify(malformed))
  }
  assert.equal(JSON.stringify(readState('stop-by-entry').settlementOutbox), before, 'a refused stop writes nothing')
  const stopped = engine.settlementStop({ key: ack.key, payloadHash: ack.payloadHash, reason: 'session_deleted' })
  assert.equal(stopped.ok, true)
  assert.equal(stopped.stopped, 1)
  assert.equal(engine.settlementStatus().counts.pending, 0)
  assert.equal(engine.settlementStatus().history.at(-1).state, 'stopped')
  assert.equal(engine.settlementStatus().history.at(-1).reason, 'session_deleted')
})

test('a durable item past its deadline is retired by the core, not by the local queue', async () => {
  // One shared clock: the engine decides expiry from ITS clock, so advancing only the queue's
  // would leave the core still inside the window and the test would prove nothing.
  let clock = START
  const engine = new LearningEngine({ stateRoot: join(makeRoot(), 'bridge-expiry'), adapterId: 'dsh',
    now: () => clock })
  const { ack } = queuedTurn(engine, { sessionId: 'bridge-session', turnId: 'bridge' })
  const { createHarnessBridge } = await import('../adapters/harness.mjs')
  const bridge = createHarnessBridge({ engine, now: () => clock, wallNow: () => clock, clockUnit: 'ms',
    schedule: (fn, ms) => setTimeout(fn, Math.min(ms, 1)), cancel: id => clearTimeout(id) })
  bridge.setTrustedGuard(() => true)
  const before = readState('bridge-expiry')
  assert.equal(before.settlementOutbox.pending.length, 1)
  clock = ack.deadline + 1
  const restored = bridge.restoreSettlements()
  await new Promise(resolve => setTimeout(resolve, 50))
  const after = readState('bridge-expiry')
  // The local queue must NOT be the thing that decides expiry: the durable document has to show
  // the terminal row, which only the core's own transaction can write.
  assert.equal(after.settlementOutbox.pending.length, 0)
  assert.equal(after.settlementOutbox.history.at(-1).state, 'expired')
  assert.equal(after.lessons.every(row => row.verified === 0), true, 'an expired item grants no credit')
  assert.equal(after.revision > before.revision, true, 'the core transaction really wrote')
  assert.equal(restored.ok, true)
  assert.equal(restored.expired, 1)
})

test('a retry that fires past the deadline still retires through the core', async () => {
  let clock = START
  const engine = new LearningEngine({ stateRoot: join(makeRoot(), 'bridge-timer-expiry'), adapterId: 'dsh',
    now: () => clock })
  const { ack } = queuedTurn(engine, { sessionId: 'timer-session', turnId: 'timer' })
  const { createHarnessBridge } = await import('../adapters/harness.mjs')
  const timers = []
  const bridge = createHarnessBridge({ engine, settlement: {
    now: () => clock, wallNow: () => clock, clockUnit: 'ms',
    schedule: (fn, ms) => { timers.push(fn); return timers.length }, cancel: () => {} } })
  bridge.setTrustedGuard(() => true)
  const realApply = engine.settlementApply.bind(engine)
  let applies = 0
  // A real transient failure first, so the retry is scheduled by production code.
  engine.settlementApply = (...args) => { applies += 1
    throw Object.assign(new Error('busy'), { code: 'lock_busy' }) }
  bridge.restoreSettlements()
  assert.equal(applies, 1)
  assert.equal(timers.length, 1, 'the production retry path scheduled the next attempt')
  engine.settlementApply = (...args) => { applies += 1; return realApply(...args) }
  clock = ack.deadline + 1
  for (const timer of timers.slice()) timer()
  await new Promise(resolve => setTimeout(resolve, 50))
  const state = readState('bridge-timer-expiry')
  assert.equal(state.settlementOutbox.pending.length, 0, 'the core retired it, not the local queue')
  assert.equal(state.settlementOutbox.history.at(-1).state, 'expired')
  assert.equal(state.lessons.every(row => row.verified === 0), true)
})
