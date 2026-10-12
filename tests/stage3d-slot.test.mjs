// Stage-3d physical-slot dynamics: the immediate turn-end reflection, the recovered due reflection
// and a human job (manual review/evaluation) all run through the ONE queue, so at most one provider
// request is ever in flight — and a cancelled request keeps the slot until it PHYSICALLY ends.
//
// `MseControl` cannot be constructed on this synthetic ctx (it is a real cordis Service), so the
// human side is exercised through the exact call shape control.mjs uses:
// `core.jobs.submit({ requestId, kind, fingerprint, gate: () => core.permissions(), run })`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { countedProvider, failures, flush, manualScheduler, runTurn, sessionRow,
  stage3dHost, successTurn } from './pump-host.mjs'

const PROJECT = '/synthetic/pump-project'
const SESSION = 'pump-session'
const ROUTE = { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'max' }
const INSTRUCTION = '导出金额排序前先统一转换为数值类型，再按数值比较'

function fixture(t) {
  const provider = countedProvider({ instruction: INSTRUCTION })
  const scheduler = manualScheduler()
  const clock = { now: Date.UTC(2030, 0, 7, 9, 0) }
  const sessions = [sessionRow(SESSION, { cwd: PROJECT, route: ROUTE })]
  const host = stage3dHost({ provider, scheduler, clock, sessions })
  host.start()
  t.after(async () => { await host.cleanup(); host.remove() })
  const session = sessions[0]
  return {
    host, provider, scheduler, clock, session, sessions,
    reply: (extra = {}) => { provider.enqueue({ text: JSON.stringify({ instruction: INSTRUCTION }), ...extra }); return provider },
    turn: (turn, extra = {}) => runTurn(host, { session, turn, options: ROUTE, ...extra }),
    success: (turn, prompt) => successTurn(host, { session, turn, options: ROUTE, ...(prompt === undefined ? {} : { prompt }) }),
  }
}

/** A ready, budget-refused problem (one prior spend, then two independent failures). */
async function parkedProblem(f) {
  f.reply()
  await f.success(1)
  f.clock.now += 60_000
  await f.turn(2, { tools: failures('bash') })
  const problem = f.host.state().problems.find(row => row.toolName === 'bash')
  assert.equal(problem.attemptedRevision, 0)
  f.clock.now = Math.max(f.clock.now, problem.nextAttemptAt) + 1
  return problem
}

/** Start ONE bounded due-recovery pass whose provider request is really in flight. */
async function holdRecovery(f) {
  f.provider.enqueue({ text: JSON.stringify({ instruction: INSTRUCTION }), held: true })
  const pass = f.host.service.runProblemPump()
  await flush()
  assert.equal(f.provider.stats().active, 1, 'the recovered reflection is in flight')
  return { pass }
}

test('P14c: the immediate reflection, the due recovery and a human job share ONE physical slot', async t => {
  const f = fixture(t)
  const problem = await parkedProblem(f)
  const { pass } = await holdRecovery(f)
  const calls = f.provider.stats().physicalCalls

  // A human job submitted while the reflection holds the slot is refused by the queue — exactly what
  // `MseControl.startReview` receives — and reaches NO provider.
  const submitted = f.host.service.jobs.submit({ requestId: 'msemanual-slot-0001', kind: 'review',
    fingerprint: 'manual:slot', gate: () => f.host.service.permissions(),
    run: async () => ({ state: 'done', result: { kind: 'review', status: 'learned' } }) })
  assert.equal(submitted.ok, false)
  assert.equal(submitted.code, 'job_in_progress')
  assert.equal(f.provider.stats().physicalCalls, calls, 'a human job never starts beside a reflection')
  assert.equal(f.provider.stats().peak, 1, 'peak in-flight stays at one')
  assert.equal(f.host.service.jobs.status().slotHeld, true)

  // Neither may the turn-end path start a second stream: it is refused, and the revision it would
  // have used stays unconsumed for the next wake-up.
  f.reply()
  await f.success(3)
  await flush()
  assert.equal(f.provider.stats().physicalCalls, calls, 'the immediate reflection never overlaps')
  assert.equal(f.provider.stats().peak, 1)

  // Release the recovered reflection: it commits, the slot frees, and the human job can then run.
  f.provider.last().release()
  await pass
  assert.equal(f.host.problem(problem.id).state, 'candidate_created')
  const second = f.host.service.jobs.submit({ requestId: 'msemanual-slot-0002', kind: 'review',
    fingerprint: 'manual:slot-2', gate: () => f.host.service.permissions(),
    run: async () => ({ state: 'done', result: { kind: 'review', status: 'learned' } }) })
  assert.equal(second.ok, true, 'once the slot is free the human path is admitted')
  await flush()
  assert.equal(f.host.service.jobs.status().slotHeld, false, 'the human job finished in its turn')
})

test('overflow: an oversized answer aborts the request, DRAINS it, and never releases the slot early', async t => {
  const f = fixture(t)
  const problem = await parkedProblem(f)
  // The provider answers with 3000 bytes (over the 2048-byte contract) and then STALLS: the transport
  // is still alive while this side has already decided to stop reading it.
  f.provider.enqueue({ stall: true, chunks: [
    { type: 'text-delta', text: 'x'.repeat(3000) },
    { type: 'usage', usage: { totalTokens: 12 } },
    { type: 'finish', reason: { kind: 'stop' } }] })
  const pass = f.host.service.runProblemPump()
  await flush()
  assert.equal(f.provider.stats().active, 1, 'the transport is still running after the oversized chunk')
  assert.equal(f.host.service.jobs.status().slotHeld, true, 'the slot is held while the request is alive')
  assert.equal(f.host.problem(problem.id).lessonId, null, 'an oversized answer creates no candidate')

  // Another human job and another turn-end reflection are both refused while it drains.
  const blocked = f.host.service.jobs.submit({ requestId: 'msemanual-drain-0001', kind: 'evaluation',
    fingerprint: 'manual:drain', gate: () => f.host.service.permissions(),
    run: async () => ({ state: 'done', result: { kind: 'evaluation', status: 'learned' } }) })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, 'job_in_progress')
  assert.equal(f.provider.stats().peak, 1, 'no second stream was entered while draining')

  f.provider.last().releaseStall()
  await pass
  await flush()
  assert.equal(f.provider.stats().active, 0, 'the request really ended before the slot was released')
  assert.equal(f.host.service.jobs.status().slotHeld, false)
  const consumed = f.host.problem(problem.id)
  assert.equal(consumed.attemptedRevision, problem.evidenceRevision, 'the signed attempt is consumed, not refunded')
  assert.equal(consumed.lessonId, null, 'and nothing was written')
  assert.equal(f.host.state().lessons.length, 1, 'only the setup lesson exists')
})

test('withdrawal: a disposed session aborts an in-flight immediate reflection and writes nothing', async t => {
  const f = fixture(t)
  f.provider.enqueue({ text: JSON.stringify({ instruction: INSTRUCTION }), held: true })
  await f.success(1)
  await flush()
  assert.equal(f.provider.stats().active, 1, 'the immediate reflection is in flight')
  // The real host withdrawal: the session is disposed, which closes the harness job that owns this
  // review and aborts the signal the reflection was started with.
  f.host.emit('session/disposed', f.session)
  f.provider.last().release()
  await flush()
  await flush()
  assert.equal(f.host.state().lessons.length, 0, 'a withdrawn turn-end reflection commits nothing')
  assert.equal(f.host.state().events.length, 1, 'the ticket still exists as a consumed attempt')
  assert.equal(f.host.state().events[0].settled, true, 'and it is settled, never replayed')
  assert.equal(f.provider.stats().peak, 1)
})

test('draining: a cancelled reflection whose provider ignores its abort keeps the slot until it exits', async t => {
  const f = fixture(t)
  const problem = await parkedProblem(f)
  const { pass } = await holdRecovery(f)
  const job = f.host.service.jobs.list().find(row => row.state === 'running')
  assert.ok(job, 'the reflection holds the slot')
  f.host.service.jobs.cancel(job.id, 'operator_cancelled')
  await flush()
  const view = f.host.service.jobs.get(job.id)
  assert.equal(view.state, 'cancelled', 'the task is cancelled')
  assert.equal(f.host.service.jobs.status().slotHeld, true, 'but the provider request still owns the slot')
  assert.equal(f.provider.stats().active, 1)
  // New work is ACCEPTED (the cancelled task is terminal) but may not START: the physical slot is
  // still owned by the request that has not exited.
  const queued = f.host.service.jobs.submit({ requestId: 'msemanual-draining-0001', kind: 'review',
    fingerprint: 'manual:draining', gate: () => f.host.service.permissions(),
    run: async () => ({ state: 'done', result: { kind: 'review', status: 'learned' } }) })
  assert.equal(queued.ok, true)
  assert.equal(queued.job.state, 'queued', 'accepted, not started')
  await flush()
  assert.equal(f.host.service.jobs.get(queued.job.id).state, 'queued', 'still waiting for the real exit')
  assert.equal(f.host.service.jobs.status().running, job.id,
    'the cancelled-but-unsettled request is still the slot owner')
  assert.equal(f.host.service.jobs.status().slotHeld, true, 'the draining request still holds the slot')
  f.provider.last().release()
  await pass
  await flush()
  assert.equal(f.host.service.jobs.get(queued.job.id).state, 'done', 'the queued work runs once the request ends')
  assert.equal(f.host.service.jobs.status().slotHeld, false, 'the slot frees exactly when the request ends')
  assert.equal(f.host.problem(problem.id).lessonId, null, 'a late answer from a cancelled attempt writes nothing')
  assert.equal(f.host.problem(problem.id).attemptedRevision, problem.evidenceRevision)
})
