import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RebuildEngine } from './engine.mjs'
import { observeInState } from '../src/problems.mjs'
import { buildFailureCapsule, capsulesByteTotal } from '../src/failure-evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

test('problem ledger grows past 128, adds capsule-free facts, and keeps recurrence identity', t => {
  const root = mkdtempSync(join(tmpdir(), 'mse-problem-capacity-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const engine = new RebuildEngine({ stateRoot: root })
  const failure = (callId, toolName, turnId) => engine.observeToolFailure({
    sessionId: 'capacity-session', turnId, projectKey: '/repo/capacity', callId,
    toolName, failureCode: 'tool_nonzero_exit', exitCode: 1,
    stderr: 'SyntaxError: malformed JSON object in capacity fixture',
  })
  const first = failure('event-first', 'json-parser', 'turn-1')
  const originalId = first.id
  engine.store.transaction(doc => {
    const source = doc.problemLoop.problems[0]
    const rows = Array.from({ length: 127 }, (_, index) => {
      const id = hash(`retained-problem-${index}`)
      return { ...structuredClone(source), id, key: id, firstAt: index + 1,
        lastAt: index + 1, updatedAt: index + 1 }
    })
    doc.problemLoop.problems.push(...rows)
    return true
  })
  const before = engine.store.read().problemLoop.problems.map(row => row.id)
  assert.equal(before.length, 128)

  const recurrence = failure('event-recurrence', 'json-parser', 'turn-2')
  assert.equal(recurrence.id, originalId)
  assert.equal(engine.store.read().problemLoop.problems.find(row => row.id === originalId).count, 2)

  engine.store.transaction(doc => {
    for (const [rowIndex, row] of doc.problemLoop.problems.entries()) {
      row.capsules = Array.from({ length: 3 }, (_, capsuleIndex) => buildFailureCapsule({
        eventId: `retained-${rowIndex}-${capsuleIndex}`, at: row.firstAt + capsuleIndex,
        toolName: 'retained-evidence', failureClass: 'tool_nonzero_exit', exitCode: 1,
        message: `JSON parser preserved diagnostic ${rowIndex} ${capsuleIndex} `.repeat(12),
        command: `validate-${rowIndex}-${capsuleIndex} `.repeat(10),
      }))
    }
    return true
  })
  const retainedBefore = engine.store.read().problemLoop.problems.find(row => row.id === originalId).capsules
  assert.ok(capsulesByteTotal(engine.store.read().problemLoop) > 128 * 1024)
  const capsuleFree = engine.store.transaction(doc => observeInState(doc, Date.now(), {
    sessionId: 'capacity-session', eventId: 'event-no-capsule', kind: 'tool_failure',
    source: 'host_event', scope: hash('capsule-free-scope'), environment: hash('default'),
    owner: hash('owner'), taskClass: null, toolName: 'json-parser-without-diagnostic',
    failureClass: 'unknown_tool_failure', signature: null,
    summary: 'JSON 工具失败，但宿主没有可用诊断', turnHash: hash('turn-no-capsule'),
  }))
  assert.equal(capsuleFree.ok, true)
  assert.equal(engine.store.read().problemLoop.problems.length, 129)

  const added = failure('event-new-tool', 'yaml-parser', 'turn-3')
  assert.equal(added.ok, true)
  const after = engine.store.read().problemLoop.problems
  assert.equal(after.length, 130)
  for (const id of before) assert.ok(after.some(row => row.id === id), `retained ${id}`)
  assert.equal(after.find(row => row.id === added.id).capsules.length, 1)
  assert.deepEqual(after.find(row => row.id === originalId).capsules, retainedBefore)
})

test('problem ledger grows past 4,096 and event replay stays idempotent', t => {
  const root = mkdtempSync(join(tmpdir(), 'mse-problem-capacity-4096-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const engine = new RebuildEngine({ stateRoot: root })
  engine.observeToolFailure({ sessionId: 'capacity-4096-session', turnId: 'seed',
    projectKey: '/repo/capacity-4096', callId: 'seed-event', toolName: 'seed-tool',
    failureCode: 'tool_nonzero_exit', exitCode: 1,
    stderr: 'SyntaxError: seed capacity fixture' })
  const existing = engine.store.read().problemLoop.problems[0]
  const initialIds = engine.store.read().problemLoop.problems.map(row => row.id)
  engine.store.transaction(doc => {
    const rows = Array.from({ length: 4094 }, (_, index) => {
      const id = hash(`retained-4096-problem-${index}`)
      return { ...structuredClone(existing), id, key: id, evidence: [], count: 0, capsules: [],
        firstAt: index + 1, lastAt: index + 1, updatedAt: index + 1 }
    })
    doc.problemLoop.problems.push(...rows)
    return true
  })
  assert.equal(engine.store.read().problemLoop.problems.length, 4095)

  const accepted = engine.observeToolFailure({ sessionId: 'capacity-4096-session', turnId: 'new',
    projectKey: '/repo/capacity-4096', callId: 'event-4096', toolName: 'tool-type-4096',
    failureCode: 'tool_nonzero_exit', exitCode: 1,
    stderr: 'SyntaxError: the final supported failure type' })
  assert.equal(accepted.ok, true)
  const atLimit = engine.store.read().problemLoop.problems
  assert.equal(atLimit.length, 4096)
  for (const id of initialIds) assert.ok(atLimit.some(row => row.id === id))

  const growth = engine.observeToolFailure({ sessionId: 'capacity-4096-session', turnId: 'over',
    projectKey: '/repo/capacity-4096', callId: 'event-4097', toolName: 'tool-type-4097',
    failureCode: 'tool_nonzero_exit', exitCode: 1,
    stderr: 'SyntaxError: the first growth failure type' })
  assert.equal(growth.ok, true)
  assert.equal(engine.store.read().problemLoop.problems.length, 4097)
  const replay = engine.observeToolFailure({ sessionId: 'capacity-4096-session', turnId: 'over',
    projectKey: '/repo/capacity-4096', callId: 'event-4097', toolName: 'tool-type-4097',
    failureCode: 'tool_nonzero_exit', exitCode: 1,
    stderr: 'SyntaxError: the first growth failure type' })
  assert.equal(replay.duplicate, true)
  assert.equal(engine.store.read().problemLoop.problems.length, 4097)
})
