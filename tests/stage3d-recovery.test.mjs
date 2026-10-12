// Stage-3d trajectories P12c–P15: revocation at every await boundary, non-replay of a consumed
// revision, fairness beyond the bounded feed, and read-only status surfaces.
//
// The same real chain as the P11/P12 file: real host turn events, the real ticket/allowance rules,
// the real job queue and the real bounded scheduler timer. Only the provider, the directory, the
// archive flag and the clock/timer are controlled, and every count comes from the provider's own
// stream entrance.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DAY, TICK_MS, countedProvider, failures, flush, manualScheduler, runTurn, sessionRow,
  stage3dHost, stateDigest, successTurn } from './pump-host.mjs'

const PROJECT = '/synthetic/pump-project'
const SESSION = 'pump-session'
const OTHER = 'other-session'
const ROUTE = { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'max' }
const INSTRUCTION = '导出金额排序前先统一转换为数值类型，再按数值比较'

function fixture(t, options = {}) {
  const provider = countedProvider({ instruction: INSTRUCTION })
  const scheduler = manualScheduler()
  const clock = { now: options.start ?? Date.UTC(2030, 0, 7, 9, 0) }
  const sessions = options.sessions ?? [sessionRow(SESSION, { cwd: PROJECT, route: ROUTE })]
  const archived = options.archived ?? new Set()
  const hooks = {}
  const host = stage3dHost({ provider, scheduler, clock, sessions, archived, hooks })
  host.start()
  t.after(async () => { await host.cleanup(); host.remove() })
  const session = sessions[0]
  return {
    host, provider, scheduler, clock, session, sessions, archived, hooks,
    reply: (extra = {}) => { provider.enqueue({ text: JSON.stringify({ instruction: INSTRUCTION }), ...extra }); return provider },
    turn: (turn, extra = {}) => runTurn(host, { session, turn, options: ROUTE, ...extra }),
    success: (turn, prompt) => successTurn(host, { session, turn, options: ROUTE, ...(prompt === undefined ? {} : { prompt }) }),
    /**
     * Queue a held reply and run ONE bounded pass until its provider request is really in flight.
     *
     * The pass promise is returned INSIDE an object on purpose: `return promise` from an async
     * function would chain it, so this helper would wait for the very pass it is handing back — the
     * held provider makes that a deadlock, not a test.
     */
    async holdPass() {
      provider.enqueue({ text: JSON.stringify({ instruction: INSTRUCTION }), held: true })
      const pass = host.service.runProblemPump()
      await flush()
      assert.equal(provider.stats().active, 1, 'the provider request must be in flight before the race')
      return { pass }
    },
  }
}

/** A ready, budget-refused problem: one prior spend (cooldown), then two independent failures. */
async function parkedProblem(f, { turn = 2 } = {}) {
  f.reply()
  await f.success(1)
  f.clock.now += 60_000
  await f.turn(turn, { tools: failures('bash') })
  const problem = f.host.state().problems.find(row => row.toolName === 'bash')
  assert.equal(problem.attemptedRevision, 0, 'setup: the refused attempt consumed nothing')
  return problem
}

const dueNow = (f, problem) => {
  const row = f.host.problem(problem.id)
  f.clock.now = Math.max(f.clock.now, row.nextAttemptAt) + 1
}

test('P12c: a foreground turn blocks the dispatch, consumes nothing, and the release recovers it', async t => {
  const f = fixture(t)
  const problem = await parkedProblem(f)
  const other = sessionRow(OTHER, { cwd: PROJECT, route: ROUTE })
  f.sessions.push(other)
  const before = f.provider.stats().physicalCalls

  // A person's turn owns the provider (turn/start), and it stays open across the due moment.
  f.host.emit('session/event', other, { type: 'turn/start', data: { turn: 1 } })
  dueNow(f, problem)
  await f.scheduler.fire({ ms: TICK_MS, times: 3 })
  assert.equal(f.provider.stats().physicalCalls, before, 'a foreground turn blocks every background dispatch')
  const waiting = f.host.problem(problem.id)
  assert.equal(waiting.attemptedRevision, 0, 'the revision is NOT consumed by a yield')
  assert.equal(waiting.ticket, null)
  const pass = f.host.service.problemPump().lastPass
  assert.equal(pass.attempted, 0)
  assert.ok(pass.codes.includes('foreground') || pass.yielded > 0, 'the yield is visible with its reason')

  // The turn ends: the same revision is recovered by the next bounded wake-up, exactly once.
  f.reply()
  f.host.emit('session/event', other, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await f.scheduler.fire({ ms: TICK_MS, times: 1 })
  await flush()
  assert.equal(f.provider.stats().physicalCalls, before + 1)
  assert.equal(f.host.problem(problem.id).state, 'candidate_created')
})

test('P12d: a pause or a closed reflection switch keeps the revision, and a consumed one never revives', async t => {
  const f = fixture(t)
  const problem = await parkedProblem(f)
  const before = f.provider.stats().physicalCalls

  // (a) the user's pause (the plugin's own `enabled` switch).
  f.host.policy.enabled = false
  dueNow(f, problem)
  await f.scheduler.fire({ ms: TICK_MS, times: 3 })
  assert.equal(f.provider.stats().physicalCalls, before, 'a paused plugin makes no background call')
  assert.equal(f.host.problem(problem.id).attemptedRevision, 0, 'a pause consumes nothing')

  // (b) the reflection switch alone, with the plugin still enabled.
  f.host.policy.enabled = true
  f.host.policy.reflectionEnabled = false
  await f.scheduler.fire({ ms: TICK_MS, times: 3 })
  assert.equal(f.provider.stats().physicalCalls, before, 'a closed reflection switch stops the dispatch')
  assert.equal(f.host.problem(problem.id).attemptedRevision, 0)

  // (c) legal again: the deferred revision is recovered, exactly once.
  f.host.policy.reflectionEnabled = true
  f.reply()
  await f.scheduler.fire({ ms: TICK_MS, times: 1 })
  await flush()
  assert.equal(f.provider.stats().physicalCalls, before + 1)
  assert.equal(f.host.problem(problem.id).state, 'candidate_created')

  // (d) toggling the switches never resurrects an attempt that was really signed.
  f.host.policy.enabled = false
  f.host.policy.enabled = true
  f.host.policy.reflectionEnabled = false
  f.host.policy.reflectionEnabled = true
  f.clock.now += DAY
  await f.scheduler.fire({ ms: TICK_MS, times: 3 })
  assert.equal(f.provider.stats().physicalCalls, before + 1, 'an attempted revision is never replayed')
})

test('P12e: every awaited boundary re-checks its permission, and a late answer never writes', async t => {
  // (a) the permission was withdrawn while the SOURCE was being read (before any ticket).
  {
    const f = fixture(t)
    const problem = await parkedProblem(f)
    const before = f.provider.stats().physicalCalls
    f.hooks.onDirectoryRead = () => { f.host.policy.enabled = false }
    dueNow(f, problem)
    await f.scheduler.fire({ ms: TICK_MS, times: 1 })
    await flush()
    f.hooks.onDirectoryRead = null
    assert.equal(f.provider.stats().physicalCalls, before, 'no dispatch after the source read was invalidated')
    assert.equal(f.host.problem(problem.id).attemptedRevision, 0, 'nothing was consumed before the ticket')
    f.host.policy.enabled = true
    f.reply()
    await f.scheduler.fire({ ms: TICK_MS, times: 1 })
    await flush()
    assert.equal(f.host.problem(problem.id).state, 'candidate_created', 'the revision is still available')
  }
  // (b) the archive lands WHILE the provider request is in flight: the ticket is spent, no candidate.
  {
    const f = fixture(t)
    const problem = await parkedProblem(f)
    dueNow(f, problem)
    const { pass } = await f.holdPass()
    f.archived.add(SESSION)
    f.provider.last().release()
    await pass
    assert.equal(f.host.problem(problem.id).lessonId, null, 'an archived source cannot produce a candidate')
    assert.equal(f.host.problem(problem.id).attemptedRevision, problem.evidenceRevision,
      'the signed attempt is consumed and never refunded')
    assert.equal(f.host.state().lessons.length, 1, 'only the setup lesson exists')
  }
  // (c) the reflection switch closes while the request is in flight.
  {
    const f = fixture(t)
    const problem = await parkedProblem(f)
    dueNow(f, problem)
    const { pass } = await f.holdPass()
    f.host.policy.reflectionEnabled = false
    f.provider.last().release()
    await pass
    assert.equal(f.host.problem(problem.id).lessonId, null, 'a withdrawn licence cannot produce a candidate')
    assert.equal(f.host.problem(problem.id).attemptedRevision, problem.evidenceRevision)
  }
  // (d) disposal while the request is in flight.
  {
    const f = fixture(t)
    const problem = await parkedProblem(f)
    dueNow(f, problem)
    const { pass } = await f.holdPass()
    const closing = f.host.close()
    f.provider.last().release()
    await pass
    await closing
    assert.equal(f.host.problem(problem.id).lessonId, null, 'a disposed plugin writes nothing')
    assert.equal(f.host.problem(problem.id).attemptedRevision, problem.evidenceRevision)
  }
  // (e) the project drifts while the request is in flight (a foreign cwd after the answer).
  {
    const f = fixture(t)
    const problem = await parkedProblem(f)
    dueNow(f, problem)
    const { pass } = await f.holdPass()
    f.session.header.cwd = '/synthetic/moved-project'
    f.provider.last().release()
    await pass
    assert.equal(f.host.problem(problem.id).lessonId, null, 'a drifted project refuses the late commit')
    assert.equal(f.host.problem(problem.id).attemptedRevision, problem.evidenceRevision)
  }
})

test('P13a: a crash after the ticket is signed never replays, and the abandoned attempt is released once', async t => {
  const provider = countedProvider({ instruction: INSTRUCTION })
  const clock = { now: Date.UTC(2030, 0, 7, 9, 0) }
  const sessions = [sessionRow(SESSION, { cwd: PROJECT, route: ROUTE })]
  const hostA = stage3dHost({ provider, scheduler: manualScheduler(), clock, sessions })
  hostA.start()
  const session = sessions[0]
  provider.enqueue({ text: JSON.stringify({ instruction: INSTRUCTION }) })
  await successTurn(hostA, { session, turn: 1, options: ROUTE })
  clock.now += 60_000
  await runTurn(hostA, { session, turn: 2, options: ROUTE, tools: failures('bash') })
  const problem = hostA.state().problems.find(row => row.toolName === 'bash')
  clock.now = problem.nextAttemptAt + 1
  // The ticket is signed and the provider request is in flight; the process then "dies" (no settle,
  // no refund, no further lifecycle) — exactly the crash-before-send case.
  provider.enqueue({ text: JSON.stringify({ instruction: INSTRUCTION }), held: true })
  const abandoned = hostA.service.runProblemPump()
  await flush()
  assert.equal(provider.calls.length, 2, 'the attempt really reached the provider')
  assert.equal(hostA.problem(problem.id).attemptedRevision, problem.evidenceRevision)

  // A second, independent process on the same store: it must not replay the signed revision.
  const providerB = countedProvider({ instruction: INSTRUCTION })
  const hostB = stage3dHost({ provider: providerB, scheduler: manualScheduler(), clock,
    stateRoot: hostA.stateRoot, sessions })
  hostB.start()
  t.after(async () => {
    provider.last()?.release()
    await abandoned
    await hostA.cleanup()
    await hostB.cleanup()
    hostB.remove()
  })
  await hostB.scheduler.fire({ ms: TICK_MS, times: 3 })
  assert.equal(providerB.stats().physicalCalls, 0, 'a signed revision is never sent again')

  // Across the 48-hour boundary the abandoned attempt is released (no refund, no replay) and only
  // genuinely NEW evidence could open a new one.
  clock.now += 2 * DAY
  await hostB.scheduler.fire({ ms: TICK_MS, times: 1 })
  await flush()
  const released = hostB.problem(problem.id)
  assert.equal(released.state, 'waiting_evidence', 'the dead process left an attempt that is now released')
  assert.equal(released.attemptedRevision, problem.evidenceRevision, 'released is not refunded')
  assert.equal(released.ticket, null)
  assert.equal(providerB.stats().physicalCalls, 0, 'releasing an abandoned attempt never resends it')

  // Even the original process's late answer cannot write: its ticket was settled while it was away.
  provider.last().release()
  await abandoned
  assert.equal(hostB.problem(problem.id).lessonId, null, 'a late answer from a dead attempt writes nothing')
})

test('P13b: an abstention, a provider failure and a cancellation all consume the revision', async t => {
  // abstained: the core records the attempt, so the SAME evidence never asks again.
  {
    const f = fixture(t)
    const problem = await parkedProblem(f)
    dueNow(f, problem)
    f.provider.enqueue({ text: JSON.stringify({ instruction: null }) })
    await f.scheduler.fire({ ms: TICK_MS, times: 1 })
    await flush()
    const abstained = f.host.problem(problem.id)
    assert.equal(abstained.state, 'abstained')
    assert.equal(abstained.attemptedRevision, problem.evidenceRevision)
    const calls = f.provider.stats().physicalCalls
    f.clock.now += DAY
    await f.scheduler.fire({ ms: TICK_MS, times: 3 })
    assert.equal(f.provider.stats().physicalCalls, calls, 'an abstention is not re-charged')
  }
  // provider failure.
  {
    const f = fixture(t)
    const problem = await parkedProblem(f)
    dueNow(f, problem)
    f.provider.enqueue({ error: 'provider_timeout' })
    await f.scheduler.fire({ ms: TICK_MS, times: 1 })
    await flush()
    const failed = f.host.problem(problem.id)
    assert.equal(failed.attemptedRevision, problem.evidenceRevision, 'a failed attempt is still consumed')
    assert.equal(failed.lessonId, null)
    const calls = f.provider.stats().physicalCalls
    f.clock.now += DAY
    await f.scheduler.fire({ ms: TICK_MS, times: 3 })
    assert.equal(f.provider.stats().physicalCalls, calls)
  }
  // cancellation: the request is held and the queue is asked to cancel the job.
  {
    const f = fixture(t)
    const problem = await parkedProblem(f)
    dueNow(f, problem)
    const { pass } = await f.holdPass()
    const job = f.host.service.jobs.list().find(row => row.state === 'running')
    assert.ok(job, 'the reflection holds the shared slot')
    f.host.service.jobs.cancel(job.id, 'operator_cancelled')
    f.provider.last().release()
    await pass
    const cancelled = f.host.problem(problem.id)
    assert.equal(cancelled.attemptedRevision, problem.evidenceRevision, 'a cancelled attempt is consumed')
    assert.equal(cancelled.lessonId, null)
    const calls = f.provider.stats().physicalCalls
    f.clock.now += DAY
    await f.scheduler.fire({ ms: TICK_MS, times: 1 })
    assert.equal(f.provider.stats().physicalCalls, calls, 'a cancelled revision is never replayed')
  }
})

test('P13c: only genuinely new independent evidence buys a new chance, and a replayed event buys none', async t => {
  const f = fixture(t)
  const problem = await parkedProblem(f)
  dueNow(f, problem)
  f.reply()
  await f.scheduler.fire({ ms: TICK_MS, times: 1 })
  await flush()
  const first = f.host.problem(problem.id)
  assert.equal(first.evidenceRevision, 2)
  assert.equal(first.attemptedRevision, 2)
  const calls = f.provider.stats().physicalCalls

  // A REPLAY of an already-seen host event is not new evidence: no revision, no chance.
  const session = f.session
  session.events.push({ type: 'tool/call', seq: session.events.length + 1,
    data: { callId: `${SESSION}-2-bash-0`, turn: 4, name: 'bash' } })
  f.host.emit('tools/result', { agent: { session }, callId: `${SESSION}-2-bash-0`,
    rootCallId: `${SESSION}-2-bash-0`, name: 'bash' }, { isError: false, value: { exitCode: 1 } })
  await f.turn(4, { tools: [] })
  assert.equal(f.host.problem(problem.id).evidenceRevision, 2, 'a replayed event identity does not advance the revision')
  f.clock.now += DAY
  await f.scheduler.fire({ ms: TICK_MS, times: 2 })
  assert.equal(f.provider.stats().physicalCalls, calls, 'no new evidence, no new attempt')

  // A genuinely NEW independent call id in a new trusted turn: the revision advances by exactly one,
  // and that revision gets exactly ONE chance — whichever real path takes it (the turn-end review
  // itself when the allowance is free again, or the bounded pump when it is not).
  f.reply()
  await f.turn(5, { tools: [{ name: 'bash', exitCode: 1, callId: 'fresh-call-1' }] })
  const advanced = f.host.problem(problem.id)
  assert.equal(advanced.evidenceRevision, 3, 'a real new independent failure advances the revision by one')
  assert.equal(advanced.origin.turnHash !== null, true)
  assert.equal(f.provider.stats().physicalCalls, calls + 1, 'the new revision buys exactly one new attempt')
  assert.equal(advanced.attemptedRevision, 3, 'and that attempt is consumed, not left open')
  dueNow(f, problem)
  await f.scheduler.fire({ ms: TICK_MS, times: 3 })
  await flush()
  assert.equal(f.provider.stats().physicalCalls, calls + 1, 'no second chance for the same revision')
})

test('P14a: a drifted prefix cannot starve a legal tail — the window moves and remote reads stay bounded', async t => {
  const f = fixture(t)
  const drifting = sessionRow('drift-session', { cwd: PROJECT, route: ROUTE })
  f.sessions.push(drifting)
  // One real reflection first, so every turn-end review below is refused by the cooldown and NO
  // problem is attempted: the ledger is exactly "ready but never tried".
  f.reply()
  await successTurn(f.host, { session: f.session, turn: 1, options: ROUTE })
  f.clock.now += 60_000
  // The host reports at most sixteen failures per turn, so one turn makes exactly eight ready
  // problems from the session that is about to drift. The legal problem is created later, in its own
  // turn, so it ranks behind all of them — the independent probe's exact shape.
  const driftTools = Array.from({ length: 8 }, (_, index) => ({ name: `drift${index}`, exitCode: 1 }))
  await runTurn(f.host, { session: drifting, turn: 2, options: ROUTE,
    tools: driftTools.flatMap(tool => [tool, { ...tool }]) })
  f.clock.now += 60_000
  await runTurn(f.host, { session: f.session, turn: 3, options: ROUTE, tools: failures('legal-tool') })
  const problems = f.host.state().problems
  assert.equal(problems.length, 9, 'eight drifted problems and one legal one')
  const legal = problems.find(row => row.toolName === 'legal-tool')
  drifting.header.cwd = '/synthetic/foreign-project'
  f.clock.now = Math.max(...problems.map(row => row.nextAttemptAt)) + 1

  const feed = f.host.reader.problemDueFeed({ limit: 8 })
  assert.equal(feed.rows.length, 8, 'the window is bounded')
  assert.ok(feed.rows.every(row => row.id !== legal.id), 'the legal tail starts OUTSIDE the bounded window')
  assert.equal(feed.eligible, 9)

  // Pass 1: every row in the window is a real scope drift. Each is confirmed, DEFERRED with a visible
  // reason and a positive wait, and the watermark moves so the tail is reachable.
  const readsBefore = f.host.localCalls.listSessions
  const passOne = await f.host.service.runProblemPump()
  assert.equal(passOne.attempted, 0, 'a drifted source is never attempted')
  assert.equal(passOne.deferred, 8, 'each considered row is parked as a wait, not skipped silently')
  assert.deepEqual(passOne.codes, ['scope_mismatch'])
  const readsOne = f.host.localCalls.listSessions - readsBefore
  assert.ok(readsOne <= 8, `one pass reads the directory at most once per considered row (saw ${readsOne})`)
  assert.equal(f.provider.stats().physicalCalls, 1, 'no provider call was made for a drifted prefix')

  for (const row of f.host.state().problems.filter(row => row.toolName?.startsWith('drift'))) {
    assert.ok(row.nextAttemptAt > f.clock.now, 'a deferred row waits in the future')
    assert.equal(row.reason, 'scope_mismatch')
    assert.equal(row.attemptedRevision, 0)
  }

  // A window that starts INSIDE the parked segment, while due work sits outside it, still moves: the
  // pass may not stop on a not-due slice. The cursor is placed by hand so the window really is the
  // eight parked rows, with the due legal row sitting outside it.
  f.host.reader.problemConsiderAdvance({ step: 2 })
  const parkedFeed = f.host.reader.problemDueFeed({ limit: 8 })
  assert.equal(parkedFeed.cursor, 1)
  assert.equal(parkedFeed.rows.some(row => row.id === legal.id), false, 'the due row is outside this window')
  assert.equal(parkedFeed.due, 0, 'the window holds no due row')
  assert.equal(parkedFeed.dueTotal, 1, 'but the ranking does hold due work outside it')
  const cursorBefore = parkedFeed.cursor
  const starved = await f.host.service.runProblemPump()
  assert.equal(starved.attempted, 0, 'nothing in that window can be attempted')
  assert.equal(f.host.problem(legal.id).attemptedRevision, 0, 'the due row is not consumed by a parked window')
  assert.notEqual(f.host.reader.problemDueFeed({ limit: 8 }).cursor, cursorBefore,
    'the watermark still moves, so the parked segment cannot pin the window')

  // The window has now moved onto the due row, and the legal tail is really recovered.
  f.reply()
  const passTwo = await f.host.service.runProblemPump()
  assert.equal(passTwo.attempted, 1, 'the legal tail is considered within bounded passes')
  assert.equal(f.provider.stats().physicalCalls, 2, 'exactly one recovered attempt')
  assert.equal(f.host.problem(legal.id).state, 'candidate_created')
  const considered = new Set([...passOne.consideredIds, ...starved.consideredIds, ...passTwo.consideredIds])
  assert.ok(considered.has(legal.id), 'the tail was really considered, not merely left behind')

  // A completely idle ledger (no due row anywhere) writes NOTHING.
  const digestBefore = stateDigest(f.host.stateRoot)
  const idle = await f.host.service.runProblemPump()
  assert.equal(idle.dueTotal, 0)
  assert.equal(idle.attempted + idle.deferred + idle.skipped, 0)
  assert.deepEqual(stateDigest(f.host.stateRoot).sha256, digestBefore.sha256, 'an idle pass writes nothing')
})

test('P14b: continuous arrivals do not bury the oldest, and the watermark survives a restart', async t => {
  const f = fixture(t)
  f.reply()
  await successTurn(f.host, { session: f.session, turn: 1, options: ROUTE })
  f.clock.now += 60_000
  await runTurn(f.host, { session: f.session, turn: 2, options: ROUTE, tools: failures('oldest-tool') })
  const oldest = f.host.state().problems.find(row => row.toolName === 'oldest-tool')

  // Nine more problems arrive while the first is still unattempted: the newest must never push the
  // oldest out of reach.
  for (let round = 0; round < 9; round += 1) {
    f.clock.now += 1_000
    await runTurn(f.host, { session: f.session, turn: 10 + round, options: ROUTE, tools: failures(`new${round}`) })
  }
  assert.equal(f.host.state().problems.length, 10)
  const considered = new Set()
  for (let pass = 0; pass < 6; pass += 1) {
    const report = await f.host.service.runProblemPump()
    for (const id of report.consideredIds) considered.add(id)
    if (considered.has(oldest.id)) break
  }
  assert.ok(considered.has(oldest.id), 'the oldest problem is considered within bounded passes')

  // The persistent watermark survives a restart: a second process resumes the SAME rotation instead
  // of starting from zero.
  const cursor = f.host.reader.problemDueFeed({ limit: 8 }).cursor
  const hostB = stage3dHost({ provider: f.provider, scheduler: manualScheduler(), clock: f.clock,
    stateRoot: f.host.stateRoot, sessions: f.sessions })
  hostB.start()
  t.after(async () => { await hostB.cleanup() })
  assert.equal(hostB.reader.problemDueFeed({ limit: 8 }).cursor, cursor,
    'the rotation watermark is durable, not process-local')
})

test('P14b2: the ledger refuses unbounded growth and keeps the rows it already has', async t => {
  const f = fixture(t)
  f.reply()
  await successTurn(f.host, { session: f.session, turn: 1, options: ROUTE })
  // A turn may report sixteen failures, so a bounded run of turns fills the 128-row ledger.
  for (let round = 0; round < 16; round += 1) {
    const tools = Array.from({ length: 8 }, (_, index) => ({ name: `cap${round}-${index}`, exitCode: 1 }))
    f.clock.now += 60_000
    await runTurn(f.host, { session: f.session, turn: 10 + round, options: ROUTE,
      tools: tools.flatMap(tool => [tool, { ...tool }]) })
    assert.equal(f.host.state().problems.length, (round + 1) * 8)
  }
  assert.equal(f.host.state().problems.length, 128, 'the ledger is bounded at its declared capacity')
  const idsBefore = f.host.state().problems.map(row => row.id).sort()
  // The capacity+1th distinct fact is refused EXPLICITLY, and nothing already stored is evicted.
  f.clock.now += 60_000
  await runTurn(f.host, { session: f.session, turn: 40, options: ROUTE,
    tools: [{ name: 'overflow', exitCode: 1 }, { name: 'overflow', exitCode: 1, callId: 'overflow-2' }] })
  assert.equal(f.host.state().problems.length, 128, 'a refused observation never evicts a live row')
  assert.deepEqual(f.host.state().problems.map(row => row.id).sort(), idsBefore, 'existing identities survive')
})

test('P15a/b: status, why and the due feed are pure reads — no writes, no provider, no trajectory change', async t => {
  const reads = host => {
    host.service.settings()
    host.service.problemPump()
    host.service.problemDueFeed({ limit: 8 })
    host.reader.problemStatus({ limit: 64 })
    host.reader.status()
    host.reader.problemDueFeed({ limit: 8 })
    host.reader.reflectionPlan({ sessionId: SESSION, turnId: '9', taskSummary: '一个新的任务描述', resultSummary: '一个新的结果描述' })
    host.service.autoValidation()
  }
  // (a) a read storm changes nothing at all, before and after a due moment.
  const f = fixture(t)
  const problem = await parkedProblem(f)
  const before = stateDigest(f.host.stateRoot)
  reads(f.host)
  assert.deepEqual(stateDigest(f.host.stateRoot).sha256, before.sha256, 'reads write nothing while parked')
  const calls = f.provider.stats().physicalCalls
  dueNow(f, problem)
  reads(f.host)
  assert.deepEqual(stateDigest(f.host.stateRoot).sha256, before.sha256, 'reads write nothing at the due moment')
  assert.equal(f.provider.stats().physicalCalls, calls, 'reads never reach a provider')
  assert.deepEqual(f.scheduler.pending().map(row => row.ms), [TICK_MS], 'reads never create a timer')
  assert.equal(f.host.state().spends.length, 1, 'reads never reserve allowance')

  // (b) the same trajectory with and without interleaved reads produces the same bytes.
  const run = async interleaved => {
    const local = fixture(t)
    const target = await parkedProblem(local)
    if (interleaved) reads(local.host)
    dueNow(local, target)
    if (interleaved) reads(local.host)
    local.reply()
    await local.scheduler.fire({ ms: TICK_MS, times: 1 })
    if (interleaved) reads(local.host)
    await flush()
    await local.host.cleanup()
    const business = local.host.state()
    // The ledger, the lessons and the spends: everything a read could conceivably disturb. The
    // per-run event identities (`eventIds`/`originEvent`, derived from a fresh ticket) and the receipt
    // ids are random by design, so the comparison is over the STABLE business projection.
    const projection = row => ({ id: row.id, version: row.version, generation: row.generation,
      status: row.status, instruction: row.instruction, createdAt: row.createdAt,
      expiresAt: row.expiresAt, sessionId: row.sessionId ?? null, sourceTurn: row.sourceTurn ?? null,
      environment: row.environment, hypothesis: row.hypothesis, adopted: row.adopted, verified: row.verified })
    // The spend's `ticket` is a fresh random UUID per run (exactly like the event identities above),
    // so the stable projection keeps what a read could actually disturb: the kind, the moment, the
    // attempt charge and the recorded cost — never the random handle.
    const spendProjection = row => ({ kind: row.kind, at: row.at, tokens: row.tokens,
      usage: row.usage ?? null })
    return { calls: local.provider.stats().physicalCalls, lesson: local.host.problem(target.id).lessonId,
      problems: JSON.stringify(business.problems), lessons: JSON.stringify(business.lessons.map(projection)),
      spends: JSON.stringify(business.spends.map(spendProjection)) }
  }
  const plain = await run(false)
  const withReads = await run(true)
  assert.equal(withReads.calls, plain.calls, 'reads do not change how many provider calls happen')
  assert.equal(withReads.lesson, plain.lesson, 'reads do not change the recovered candidate')
  assert.equal(withReads.problems, plain.problems, 'the problem ledger is identical')
  assert.equal(withReads.lessons, plain.lessons, 'the lessons are identical')
  assert.equal(withReads.spends, plain.spends, 'the allowance ledger is identical')
})

test('P15c: a large problem backlog with long summaries never enters the task context', async t => {
  const f = fixture(t)
  const lesson = f.host.reader.record({ eventId: 'correction-1', source: 'direct_user', kind: 'correction',
    instruction: '以后整理报表金额时，先统一转换为数值类型再排序输出' })
  assert.ok(lesson?.id, 'a recallable lesson exists')
  f.reply()
  await successTurn(f.host, { session: f.session, turn: 1, options: ROUTE })
  for (const [round, count] of [[0, 8], [1, 8], [2, 4]]) {
    const tools = Array.from({ length: count }, (_, index) => ({ name: `bulk${round}-${index}`, exitCode: 1 }))
    f.clock.now += 60_000
    await runTurn(f.host, { session: f.session, turn: 20 + round, options: ROUTE,
      tools: tools.flatMap(tool => [tool, { ...tool }]) })
  }
  const backlog = f.host.state().problems
  assert.equal(backlog.length, 20, 'the backlog really exists')

  const prepared = f.host.reader.prepare({ sessionId: SESSION, turnId: '7', origin: 'user',
    prompt: '请整理报表金额并排序输出结果' })
  assert.ok(prepared.context.length > 0, 'a recallable lesson is really injected')
  assert.ok(Buffer.byteLength(prepared.context) <= 768, 'the per-turn injection stays inside its bound')
  assert.ok(prepared.lessons.length <= 2, 'at most two lessons per turn')
  const second = f.host.reader.prepare({ sessionId: SESSION, turnId: '8', origin: 'user',
    prompt: '请整理报表金额并排序输出结果' })
  assert.ok(Buffer.byteLength(second.context) <= 768, 'the bound holds on the next turn too')
  for (const row of backlog) {
    assert.equal(prepared.context.includes(row.summary), false, 'a problem summary never becomes prompt material')
    assert.equal(second.context.includes(row.summary), false)
  }
  for (const row of f.host.state().doc.sessions) {
    assert.ok(row.bytes <= 1536, 'the per-session byte ceiling holds')
  }
})

test('P12f: the plugin\'s OWN startup pass recovers an already-due problem, before any timer fires', async t => {
  const providerA = countedProvider({ instruction: INSTRUCTION })
  const clock = { now: Date.UTC(2030, 0, 7, 9, 0) }
  const sessions = [sessionRow(SESSION, { cwd: PROJECT, route: ROUTE })]
  const hostA = stage3dHost({ provider: providerA, scheduler: manualScheduler(), clock, sessions })
  hostA.start()
  const session = sessions[0]
  providerA.enqueue({ text: JSON.stringify({ instruction: INSTRUCTION }) })
  await successTurn(hostA, { session, turn: 1, options: ROUTE })
  clock.now += 60_000
  await runTurn(hostA, { session, turn: 2, options: ROUTE, tools: failures('bash') })
  const problem = hostA.state().problems.find(row => row.toolName === 'bash')
  assert.equal(problem.attemptedRevision, 0)
  await hostA.close()

  // Process B opens a store where a problem is ALREADY due. Its own startup pass — not the timer,
  // which the test never fires — must recover it. (The startup pass used to reach a binding that did
  // not exist yet and was swallowed as `problem_pump_failed:unknown`.)
  const providerB = countedProvider({ instruction: INSTRUCTION })
  const schedulerB = manualScheduler()
  clock.now = problem.nextAttemptAt + 1
  providerB.enqueue({ text: JSON.stringify({ instruction: INSTRUCTION }) })
  const hostB = stage3dHost({ provider: providerB, scheduler: schedulerB, clock,
    stateRoot: hostA.stateRoot, sessions })
  hostB.start()
  t.after(async () => { await hostB.cleanup(); hostB.remove() })
  await flush()
  assert.equal(providerB.stats().physicalCalls, 1, 'the startup pass itself dispatched the recovered attempt')
  const pass = hostB.service.problemPump().lastPass
  assert.ok(pass !== null, 'the startup pass really ran')
  assert.equal(pass.attempted, 1)
  assert.equal(pass.codes.includes('problem_pump_failed'), false)
  assert.equal(hostB.problem(problem.id).state, 'candidate_created')
  assert.equal(hostB.warnings.some(line => line.includes('problem_pump_failed')), false,
    'no swallowed startup failure')
})

test('P12g: an immediate reflection carries the SAME source licence as a recovered one', async t => {
  // Positive control: nothing moves while the answer is in flight → the candidate lands.
  {
    const f = fixture(t)
    f.provider.enqueue({ text: JSON.stringify({ instruction: INSTRUCTION }), held: true })
    await f.success(1)
    await flush()
    assert.equal(f.provider.stats().active, 1, 'the immediate reflection is really in flight')
    f.provider.last().release()
    await flush()
    assert.equal(f.host.state().lessons.length, 1, 'control: an unchanged source commits its candidate')
    assert.equal(f.host.state().lessons[0].sessionId, SESSION)
  }
  // The project moves after `finish` but before the commit: no candidate may be created.
  {
    const f = fixture(t)
    f.provider.enqueue({ text: JSON.stringify({ instruction: INSTRUCTION }), held: true })
    await f.success(1)
    await flush()
    f.session.header.cwd = '/synthetic/moved-project'
    f.provider.last().release()
    await flush()
    assert.equal(f.host.state().lessons.length, 0, 'a moved project commits nothing')
    const event = f.host.state().events[0]
    assert.ok(event, 'the attempt still exists as a consumed ticket')
    assert.equal(f.host.state().events.every(row => row.settled === true), true, 'the ticket is settled, not refunded')
  }
  // The session switches model after `finish`: same refusal, same consumption.
  {
    const f = fixture(t)
    f.provider.enqueue({ text: JSON.stringify({ instruction: INSTRUCTION }), held: true })
    await f.success(1)
    await flush()
    f.session.events = [{ seq: 1, type: 'request/header',
      data: { header: { config: { provider: 'switched-provider', model: 'switched-model' } } } }]
    f.provider.last().release()
    await flush()
    assert.equal(f.host.state().lessons.length, 0, 'a re-routed session commits nothing')
    assert.equal(f.host.state().events.every(row => row.settled === true), true)
  }
})

test('P12h: a snapshot that cannot answer is confirmed once (bounded, coalesced) before the pass judges', async t => {
  const f = fixture(t)
  const problem = await parkedProblem(f)
  dueNow(f, problem)
  const before = f.provider.stats().physicalCalls
  // A real lifecycle notice invalidates the host's confirmed directory and starts one pull. The pass
  // that runs IMMEDIATELY after must wait for that confirmation instead of judging `unknown` — the
  // 30-second snapshot can never outlive the 60-second timer, and refusing there recovered nothing.
  f.host.emit('api-session/removed', SESSION)
  f.reply()
  const pass = await f.host.service.runProblemPump()
  await flush()
  assert.equal(pass.attempted, 1, 'the pass confirmed the directory and attempted the due row')
  assert.equal(pass.codes.includes('host_state_unknown'), false, 'unknown was resolved, not treated as permission')
  assert.equal(f.provider.stats().physicalCalls, before + 1, 'exactly one recovered attempt')
  assert.equal(f.host.problem(problem.id).state, 'candidate_created')
})
