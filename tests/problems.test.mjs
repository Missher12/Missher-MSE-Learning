import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningEngine } from '../src/index.mjs'
import { observeInState, beginReflectionInState, linkCandidateInState, abstainInState, interruptInState,
  reflectionReady, problemLoopValid, ensureProblemLoop, INDEPENDENT_THRESHOLD } from '../src/problems.mjs'

/**
 * Problem ledger regression for audit matrix rev2:
 *  - A: independent evidence that arrives while a reflection is in flight must NOT invalidate the
 *    already-paid result, and the untried new revision must become reflectable again after the
 *    cooldown (never stranded in candidate_created/abstained/waiting_evidence).
 *  - B: a problem of one project/environment must never be bound by a reflection request issued
 *    for another project/environment, and must be refused BEFORE any spend is reserved.
 */

const OBS = { kind: 'tool_failure', source: 'host_event', scope: 'a'.repeat(64), environment: 'b'.repeat(64),
  owner: 'c'.repeat(64), taskClass: 'build', toolName: 'shell', failureClass: 'tool_nonzero_exit',
  summary: 'e'.repeat(20), turnHash: 'd'.repeat(64) }

/** Fresh ledger state with one problem at evidenceRevision = 2. */
function ledgerAtTwo() {
  const state = { problemLoop: { format: 1, problems: [], seenEvents: [] } }
  ensureProblemLoop(state)
  for (let i = 1; i <= INDEPENDENT_THRESHOLD; i++) observeInState(state, 1000 + i, { ...OBS, eventId: `x${i}` })
  return state
}

/** Push a third independent observation (same key, new event id) → evidenceRevision = 3. */
function thirdObservation(state, row) {
  observeInState(state, 6000, { ...OBS, eventId: 'y1' })
  assert.equal(row.evidenceRevision, 3)
}

test('rev2-A: in-flight evidence does not reject the paid result and the untried revision recovers to ready', async t => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-problems-rev2a-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  let now = 10_000_000
  const engine = new LearningEngine({ stateRoot, adapterId: 'review-rev2', now: () => now })
  const obs = { projectKey: 'synthetic-p1', environmentId: 'synthetic-e1', kind: 'tool_failure', source: 'host_event',
    toolName: 'shell', taskClass: 'build', failureCode: 'tool_nonzero_exit', summary: '构建失败，需要检查输入条件的边界值' }
  engine.observeProblem({ ...obs, sessionId: 's1', turnId: 1, eventId: 'call1' })
  const second = engine.observeProblem({ ...obs, sessionId: 's2', turnId: 2, eventId: 'call2' })
  const problemId = second.id
  const request = { sessionId: 's1', projectKey: 'synthetic-p1', environmentId: 'synthetic-e1', turnId: 3,
    outcome: 'failed', taskSummary: '构建任务失败，需要核对输入条件边界值', resultSummary: '失败与输入条件相关，需要检查边界值',
    problemId, evidenceRevision: 2 }
  const ticket = engine.reflectionRequest(request)
  assert.ok(ticket.ticket, 'reflection ticket issued')
  // Third independent failure arrives while the reflection is in flight.
  engine.observeProblem({ ...obs, sessionId: 's3', turnId: 4, eventId: 'call3' })
  const settled = engine.reflectionResult({ ticket: ticket.ticket,
    result: { instruction: '构建失败时先核对输入边界值再重试' } })
  assert.equal(settled.ok, true, 'paid result must settle despite in-flight evidence')
  let state = engine.store.read()
  const problem = state.problemLoop.problems.find(x => x.id === problemId)
  assert.ok(problem.lessonId, 'candidate must be linked to the problem')
  assert.equal(problem.evidenceRevision, 3)
  assert.equal(problem.attemptedRevision, 2, 'attempted revision stays at the ticket snapshot')
  assert.equal(problem.state, 'eligible', 'untried revision 3 keeps the problem eligible')
  // After the cooldown window the untried revision is ready again — no new evidence needed.
  now += 25 * 3600_000
  const rows = engine.problemStatus({ limit: 64 }).rows
  const view = rows.find(r => r.id === problemId)
  assert.equal(view.ready, true, 'untried new revision must become reflectable after cooldown')
  const secondTicket = engine.reflectionRequest({ ...request, turnId: 5, evidenceRevision: 3 })
  assert.ok(secondTicket.ticket, 're-reflection over the untried revision allowed')
  state = engine.store.read()
  assert.equal(state.problemLoop.problems.find(x => x.id === problemId).attemptedRevision, 3)
})

test('rev2-B: a foreign scope/environment can never bind a problem; refused before spend', async t => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-problems-rev2b-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  let now = 10_000_000
  const engine = new LearningEngine({ stateRoot, adapterId: 'review-rev2', now: () => now })
  const obs = { projectKey: 'synthetic-p1', environmentId: 'synthetic-e1', kind: 'tool_failure', source: 'host_event',
    toolName: 'shell', taskClass: 'build', failureCode: 'tool_nonzero_exit', summary: '构建失败，需要检查输入条件的边界值' }
  engine.observeProblem({ ...obs, sessionId: 's1', turnId: 1, eventId: 'call1' })
  const second = engine.observeProblem({ ...obs, sessionId: 's2', turnId: 2, eventId: 'call2' })
  const problemId = second.id
  const foreign = { sessionId: 'sX', projectKey: 'synthetic-p2', environmentId: 'synthetic-e2', turnId: 9,
    outcome: 'failed', taskSummary: '按金额排序失败需要处理', resultSummary: '字符串排序导致结果错误',
    problemId, evidenceRevision: second.evidenceRevision }
  const before = engine.store.read().spends.length ?? 0
  assert.throws(() => engine.reflectionRequest(foreign), /problem_binding_mismatch/)
  assert.equal((engine.store.read().spends.length ?? 0) - before, 0, 'no reflection spend may be reserved')
  const state = engine.store.read()
  assert.equal(state.problemLoop.problems.find(x => x.id === problemId).ticket, null)
  assert.equal(state.problemLoop.problems.find(x => x.id === problemId).state, 'eligible',
    'rejected foreign request must not disturb the problem')
})

test('rev2-A pure: all three settlement paths recover untried in-flight evidence; control does not re-charge', async t => {
  const run = (name, fn) => {
    const state = ledgerAtTwo()
    const row = state.problemLoop.problems[0]
    beginReflectionInState(row, 5000, 'ticket-' + name)
    thirdObservation(state, row)
    fn(row, 7000)
    assert.equal(row.state, 'eligible', `${name}: untried evidence returns to eligible`)
    assert.equal(row.attemptedRevision, 2, `${name}: attempted revision untouched`)
    assert.equal(reflectionReady(row, 25 * 3600_000 + 7000), true, `${name}: ready after cooldown`)
    assert.equal(problemLoopValid(state), true, `${name}: ledger stays valid`)
  }
  run('candidate', (row, now) => linkCandidateInState(row, 'lesson-1', 3, now))
  run('abstain', (row, now) => abstainInState(row, now))
  run('interrupt', (row, now) => interruptInState(row, now, 'reflection_interrupted'))
  // Control: without new evidence a linked candidate must NOT become ready again (no double charge).
  const state = ledgerAtTwo()
  const row = state.problemLoop.problems[0]
  beginReflectionInState(row, 5000, 'ticket-control')
  linkCandidateInState(row, 'lesson-2', 1, 7000)
  assert.equal(row.state, 'candidate_created')
  assert.equal(reflectionReady(row, 25 * 3600_000 + 7000), false)
  assert.equal(problemLoopValid(state), true)
})