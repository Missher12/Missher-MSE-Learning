import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { RebuildEngine } from './engine.mjs'
import { MAX_STORE_BYTES } from '../src/store.mjs'

const day = '2026-11-23'
const time = new Date(2026, 10, 23, 12, 0, 0).getTime()

function engineFor(t) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-digest-audit-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const engine = new RebuildEngine({ stateRoot, now: () => time })
  engine.setRoute({ provider: 'local-fixture', model: 'no-provider' })
  return engine
}
function settledFact(engine, sessionId = 'admitted', turnId = 'turn-1') {
  engine.recordTurnFacts({ sessionId, turnId, taskSummary: '检查配置格式' })
  engine.complete({ sessionId, turnId, outcome: 'unknown' })
}
const digestRow = (date, keys = []) => ({ day: date, status: 'partial', throughAt: 0,
  summary: null, entryIds: [], factKeys: keys, unprovenKeys: [], excludedKeys: [] })

test('a partial day with fully accounted facts leaves the pending queue and retains its record', t => {
  const engine = engineFor(t)
  settledFact(engine)
  engine.store.transaction(doc => {
    doc.digest.backlog = [day]
    const row = digestRow(day)
    row.unprovenKeys = ['turn:' + doc.turnFacts[0].id]
    row.summary = '当天要点仍可查看'
    doc.digest.days = [row]
    return true
  })
  const before = engine.store.read().digest.days
  assert.equal(engine.reviewDayPlan(day).reason, 'done_today')
  const result = engine.beginReviewDay(day)
  assert.equal(result.reason, 'done_today')
  const after = engine.store.read()
  assert.deepEqual(after.digest.days, before, 'the recorded partial summary remains visible')
  assert.equal(after.requests.length, 0)
  assert.equal(after.digest.backlog.length, 0, 'accounted day must no longer be pending')
})

test('a day with 1024 accounted facts waits before issuing a new paid digest', t => {
  const engine = engineFor(t)
  settledFact(engine)
  engine.store.transaction(doc => {
    doc.digest.backlog = [day]
    doc.digest.days = [digestRow(day,
      Array.from({ length: 1024 }, (_, i) => 'accounted-' + i))]
    return true
  })
  const before = engine.store.read()
  const result = engine.beginReviewDay(day)
  assert.equal(result.ticket, undefined, 'dispatch can never advance the full day ledger')
  assert.equal(result.reason, 'digest_ledger_full')
  const after = engine.store.read()
  assert.deepEqual(after.requests, before.requests)
  assert.deepEqual(after.digest.days, before.digest.days)
  assert.ok(after.digest.backlog.includes(day))
})

test('large digest exclusions cannot commit a request without dispatching it', t => {
  const engine = engineFor(t)
  settledFact(engine, 'admitted', 'turn-1')
  settledFact(engine, 'revoked', 'turn-2')
  engine.setSourceGuard(id => id === 'admitted')
  const target = MAX_STORE_BYTES - 20300
  engine.store.transaction(doc => {
    const sample = doc.turnFacts.find(r => r.sessionId === 'revoked')
    for (let i = 0; i < 254; i++) {
      const id = createHash('sha256').update('historical-excluded-turn-' + i).digest('hex')
      doc.turnFacts.push({ ...sample, id })
    }
    doc.digest.backlog = [day]
    const bytes = () => Buffer.byteLength(JSON.stringify(doc.digest))
    for (let b = 1; b <= 12 && bytes() < target - 260; b++) {
      const page = digestRow('2026-10-' + String(b).padStart(2, '0'))
      doc.digest.days.push(page)
      for (let i = 0; i < 1024; i++) {
        const key = ('bounded-' + b + '-' + i + '-').padEnd(256, 'x')
        page.factKeys.push(key)
        if (bytes() > target) { page.factKeys.pop(); break }
      }
    }
    assert.ok(bytes() <= target && target - bytes() < 260)
    return true
  })
  const manifest = JSON.parse(readFileSync(engine.store.path, 'utf8'))
  const object = join(engine.stateRoot, '.memory-v1-object-' + manifest.coreRefs.digest + '.json')
  const digestBytes = readFileSync(object).byteLength
  const plan = engine.reviewDayPlan(day)
  assert.equal(plan.run, true)
  assert.equal(plan.facts.length, 1)
  assert.equal(plan.excludedKeys.length, 255)
  assert.ok(digestBytes + Buffer.byteLength(JSON.stringify(plan.excludedKeys)) > MAX_STORE_BYTES)
  let result
  let failure
  try { result = engine.beginReviewDay(day) } catch (error) { failure = error.code }
  assert.equal(engine.store.read().requests.length, 0, 'refusal to write exclusions must be atomic')
  assert.equal(failure, undefined, 'the scheduler should return a readable refusal')
  assert.equal(result.reason, 'storage_capacity')
})

test('a digest uses one remaining fact slot and retains all earlier identities', t => {
  const engine = engineFor(t)
  settledFact(engine, 'admitted', 'turn-1')
  settledFact(engine, 'admitted', 'turn-2')
  settledFact(engine, 'admitted', 'turn-3')
  const actualKeys = engine.store.read().turnFacts.map(row => 'turn:' + row.id)
  const oldKeys = Array.from({ length: 1023 }, (_, i) => 'previous-' + i)
  engine.store.transaction(doc => {
    doc.digest.backlog = [day]
    doc.digest.days = [digestRow(day, oldKeys)]
    return true
  })

  const plan = engine.reviewDayPlan(day)
  assert.deepEqual(plan.factKeys, [actualKeys[0]], 'the batch stops at the remaining ledger slot')
  const started = engine.beginReviewDay(day)
  assert.ok(started.ticket)
  const request = engine.store.read().requests.find(row => row.ticket === started.ticket)
  assert.deepEqual(request.digestKeys, [actualKeys[0]])
  engine.finishWork({ ticket: started.ticket, usage: { input: 10, output: 10 }, result: {
    schema: 'mse-daily-digest-v1', summary: '剩余一个事实槽', actions: [],
  } })
  const saved = engine.store.read().digest.days.find(row => row.day === day)
  assert.equal(saved.factKeys.length, 1024)
  assert.deepEqual(saved.factKeys.slice(-1), [actualKeys[0]])
  assert.deepEqual(saved.factKeys.slice(0, 1023), oldKeys)
  const waiting = engine.beginReviewDay(day)
  assert.equal(waiting.reason, 'digest_ledger_full')
  assert.equal(waiting.ticket, undefined)
})
