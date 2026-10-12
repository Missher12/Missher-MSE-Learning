// Stage-3d: a problem whose reflection was refused by the ROLLING ALLOWANCE or the COOLDOWN signed
// no ticket, so its revision stays attemptable — and the HOST must come back to it on its own.
//
// Every trajectory below drives the shipped plugin through its real entry points: real host turn
// events persist the ledger, the real bounded scheduler's own timer callback runs the recovery pass,
// the real job queue owns the physical slot and the real core issues/refuses the ticket. Counts are
// read from the DOUBLE provider's stream entrance, never from a scan or a callback.
import test from 'node:test'
import assert from 'node:assert/strict'
import { COOLDOWN_MS, DAY, TICK_MS, countedProvider, failures, flush, manualScheduler, runTurn,
  sessionRow, stage3dHost, successTurn } from './pump-host.mjs'

const PROJECT = '/synthetic/pump-project'
const OTHER_PROJECT = '/synthetic/other-project'
const SESSION = 'pump-session'
const ROUTE = { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'max' }
/** A method the real core accepts: it passes the screening and the specificity bar. */
const INSTRUCTION = '导出金额排序前先统一转换为数值类型，再按数值比较'

function fixture(t, options = {}) {
  const provider = countedProvider({ instruction: INSTRUCTION })
  const scheduler = manualScheduler()
  const clock = { now: options.start ?? Date.UTC(2030, 0, 7, 9, 0) }
  const sessions = options.sessions ?? [sessionRow(SESSION, { cwd: PROJECT, route: ROUTE })]
  const archived = options.archived ?? new Set()
  const host = stage3dHost({ provider, scheduler, clock, sessions, archived })
  host.start()
  t.after(async () => { await host.cleanup(); host.remove() })
  const session = sessions[0]
  return {
    host, provider, scheduler, clock, session, sessions, archived,
    /** Queue the one reply a reflection consumes; `held` makes it ignore its AbortSignal. */
    reply: (extra = {}) => { provider.enqueue({ text: JSON.stringify({ instruction: INSTRUCTION }), ...extra }); return provider },
    turn: (turn, extra = {}) => runTurn(host, { session, turn, options: ROUTE, ...extra }),
    /** One real generic reflection (a successful turn on the trusted route): it spends one allowance. */
    success: (turn, prompt) => successTurn(host, { session, turn, options: ROUTE, ...(prompt === undefined ? {} : { prompt }) }),
  }
}

test('P11a: a cooldown-refused problem recovers on the host timer with no further event or UI read', async t => {
  const f = fixture(t)
  // (1) ONE real reflection through the ordinary turn-end path: the rolling 3/24h allowance now has a
  //     spend, and its timestamp is what the cooldown is measured from.
  f.reply()
  await f.success(1)
  assert.equal(f.provider.stats().physicalCalls, 1, 'the generic turn-end reflection really spent one call')
  assert.equal(f.host.state().spends.length, 1)

  // (2) Two INDEPENDENT failures of the same tool make one ready problem. The turn-end reflection is
  //     refused by the 30-minute cooldown, so NO ticket is signed: the revision stays attemptable.
  f.clock.now += 60_000
  await f.turn(2, { tools: failures('bash') })
  const problem = f.host.state().problems.find(row => row.toolName === 'bash')
  assert.ok(problem, 'the host failure roster really created a problem row')
  assert.equal(problem.evidenceRevision, 2)
  assert.equal(problem.attemptedRevision, 0, 'a budget/cooldown refusal consumes nothing')
  assert.equal(problem.state, 'waiting_budget')
  assert.equal(problem.reason, 'reflection_budget')
  assert.equal(problem.ticket, null)
  assert.equal(f.provider.stats().physicalCalls, 1, 'no provider call may happen after the refusal')
  const parkedAt = problem.nextAttemptAt
  assert.ok(parkedAt > f.clock.now, 'a refusal must park in the FUTURE, never at a past instant')
  assert.equal(parkedAt, f.host.state().spends[0].at + COOLDOWN_MS, 'the park is the cooldown release moment')

  // (3) Before the deadline the timer may tick as often as it likes: still zero calls, no attempt.
  const before = f.clock.now
  f.clock.now = parkedAt - 1
  assert.ok(f.clock.now > before)
  await f.scheduler.fire({ ms: TICK_MS, times: 20 })
  assert.equal(f.provider.stats().physicalCalls, 1, 'a parked problem cannot be retried before its release')
  assert.equal(f.host.problem(problem.id).attemptedRevision, 0)
  assert.equal(f.host.problem(problem.id).nextAttemptAt, parkedAt, 'an idle tick does not move the wait')

  // (4) The deadline passes with NO user message, NO settings read and NO extra event: the host's own
  //     timer runs one bounded pass, which re-confirms the source and spends exactly once.
  f.reply()
  f.clock.now = parkedAt + 1
  await f.scheduler.fire({ ms: TICK_MS, times: 1 })
  await flush()
  assert.equal(f.provider.stats().physicalCalls, 2, 'exactly one recovered attempt, no retry storm')
  const recovered = f.host.problem(problem.id)
  assert.equal(recovered.attemptedRevision, 2, 'the ticket consumes the revision it was signed for')
  assert.equal(recovered.state, 'candidate_created', 'the recovered reflection landed as a candidate')
  assert.ok(recovered.lessonId, 'the candidate is linked to the problem it came from')
  assert.equal(recovered.ticket, null)
  const call = f.provider.last()
  assert.deepEqual({ provider: call.provider, model: call.model, reasoningEffort: call.reasoningEffort }, ROUTE,
    'the recovered attempt ran on the frozen route of the original turn')
  assert.equal(call.abortedAtDispatch, false)
  const pass = f.host.service.problemPump()
  assert.equal(pass.lastPass.attempted, 1)
  assert.equal(pass.lastPass.recovered, 1)

  // (5) The revision is spent: nothing may ever send it again, not even after a day.
  f.clock.now += DAY
  await f.scheduler.fire({ ms: TICK_MS, times: 3 })
  assert.equal(f.provider.stats().physicalCalls, 2, 'the same revision is never sent twice')
  assert.equal(f.host.service.problemPump().due, 0)
})

test('P11b: the daily allowance parks for the REAL window release, never in the past, and never spins', async t => {
  const f = fixture(t)
  // Three real reflections (each 31 minutes apart) exhaust the rolling 3-per-24h allowance.
  for (let turn = 1; turn <= 3; turn += 1) {
    if (turn > 1) f.clock.now += COOLDOWN_MS + 60_000
    f.reply()
    await f.success(turn, `整理报表并核对金额（第 ${turn} 轮）`)
  }
  assert.equal(f.provider.stats().physicalCalls, 3)
  assert.equal(f.host.state().spends.length, 3)

  // The cooldown has LONG passed; the 24-hour window has not. A refusal must therefore park at the
  // window's real release (the oldest counted spend leaving it), not at the elapsed cooldown.
  f.clock.now += COOLDOWN_MS + 60_000
  await f.turn(9, { tools: failures('bash') })
  const problem = f.host.state().problems.find(row => row.toolName === 'bash')
  assert.equal(problem.state, 'waiting_budget')
  const spends = f.host.state().spends.map(row => row.at).sort((left, right) => left - right)
  assert.equal(problem.nextAttemptAt, spends[0] + DAY, 'the park is the window release, not the cooldown')
  assert.ok(problem.nextAttemptAt > f.clock.now, 'a positive wait is the whole point of the fix')
  const status = f.host.reader.problemStatus({ limit: 8 })
  const view = status.rows.find(row => row.id === problem.id)
  assert.equal(view.ready, false)
  assert.match(view.nextAction, /^waiting_reflection_budget_until_\d+$/u, 'the wait reason is visible')

  // No spin: a tick does nothing at all, and the wait does not move.
  const callsBefore = f.provider.stats().physicalCalls
  await f.scheduler.fire({ ms: TICK_MS, times: 30 })
  assert.equal(f.provider.stats().physicalCalls, callsBefore, 'a parked problem never hot-scans the provider')
  assert.equal(f.host.problem(problem.id).nextAttemptAt, problem.nextAttemptAt)
  assert.equal(f.host.service.problemPump().due, 0)
  // The one timer the plugin owns is a positive-period interval, never a zero-delay chain: nothing
  // the pass did left a live timer behind, and every timer this build ever created had a real period.
  assert.deepEqual(f.scheduler.pending().map(row => row.ms), [TICK_MS],
    'the only live wake-up is the declared positive-period interval')
  assert.ok(f.scheduler.scheduled.every(row => row.ms > 0), 'no zero-delay timer was ever created')

  // The window releases: the same revision now has exactly one chance.
  f.reply()
  f.clock.now = problem.nextAttemptAt + 1
  await f.scheduler.fire({ ms: TICK_MS, times: 1 })
  await flush()
  assert.equal(f.provider.stats().physicalCalls, callsBefore + 1, 'the window release restores exactly one attempt')
  const recovered = f.host.problem(problem.id)
  assert.equal(recovered.state, 'candidate_created')
  assert.equal(recovered.lessonId !== null, true)
})

test('P11c: a timer tick, a turn end and an explicit host entry arriving together still produce ONE attempt', async t => {
  const f = fixture(t)
  f.reply()
  await f.success(1)
  f.clock.now += 60_000
  await f.turn(2, { tools: failures('bash') })
  const problem = f.host.state().problems.find(row => row.toolName === 'bash')
  assert.equal(problem.attemptedRevision, 0)

  f.reply()
  f.clock.now = problem.nextAttemptAt + 1
  // Three real wake-ups in the same instant: the owned timer, the turn-end scheduler path and the
  // explicit host entry. None of them may turn into a second ticket, a second spend or a second row.
  const [tick, explicit, turnEnd] = await Promise.all([
    f.scheduler.fire({ ms: TICK_MS, times: 1 }),
    f.host.service.runProblemPump(),
    f.host.service.scanAutoValidation([]),
  ])
  await flush()
  assert.ok(tick >= 1 && explicit !== null && turnEnd !== null)
  const state = f.host.state()
  assert.equal(f.provider.stats().physicalCalls, 2, 'exactly one recovered provider call')
  assert.equal(state.spends.length, 2, 'exactly one reflection spend for the recovery')
  // The refused turn-end attempt signed no ticket, so it wrote NO event at all: the only reflection
  // event bound to this problem is the recovery that really spent.
  assert.equal(state.events.filter(row => row.problemId === problem.id).length, 1,
    'one reflection event for the problem: the recovery, and nothing for the refused turn-end attempt')
  const rows = state.problems.filter(row => row.toolName === 'bash')
  assert.equal(rows.length, 1, 'the concurrent wake-ups never mint a second problem')
  assert.equal(rows[0].state, 'candidate_created')
  assert.equal(rows[0].attemptedRevision, 2)
  const recoveryEvent = state.events.find(row => row.problemId === problem.id && row.ticket !== null)
  assert.ok(recoveryEvent === undefined || recoveryEvent.settled === true)
})

test('P12a: a refused problem is recovered by an INDEPENDENT process on its own session, project and route', async t => {
  const providerA = countedProvider({ instruction: INSTRUCTION })
  const schedulerA = manualScheduler()
  const clock = { now: Date.UTC(2030, 0, 7, 9, 0) }
  const sessions = [sessionRow(SESSION, { cwd: PROJECT, route: ROUTE }),
    sessionRow('other-session', { cwd: OTHER_PROJECT, route: { provider: 'other-provider', model: 'other-model' } })]
  const hostA = stage3dHost({ provider: providerA, scheduler: schedulerA, clock, sessions })
  hostA.start()
  const session = sessions[0]
  // Refuse the immediate reflection (cooldown) so the revision is left attemptable, then stop process A.
  providerA.enqueue({ text: JSON.stringify({ instruction: INSTRUCTION }) })
  await successTurn(hostA, { session, turn: 1, options: ROUTE })
  clock.now += 60_000
  await runTurn(hostA, { session, turn: 2, options: ROUTE, tools: failures('bash') })
  const problemA = hostA.state().problems.find(row => row.toolName === 'bash')
  assert.equal(problemA.attemptedRevision, 0, 'process A refused without consuming the revision')
  assert.equal(problemA.origin.sessionId, SESSION)
  assert.equal(problemA.origin.provider, ROUTE.provider)
  const callsA = providerA.stats().physicalCalls
  await hostA.close()

  // Process B: a NEW plugin instance on the same store, with another session live and running a
  // different model. It has no memory of A's turn — only the durable binding.
  const providerB = countedProvider({ instruction: INSTRUCTION })
  const schedulerB = manualScheduler()
  const hostB = stage3dHost({ provider: providerB, scheduler: schedulerB, clock, stateRoot: hostA.stateRoot,
    sessions })
  hostB.start()
  t.after(async () => { await hostB.cleanup(); hostB.remove() })

  // Another session is active on a different model: it must not be borrowed.
  await successTurn(hostB, { session: sessions[1], turn: 1, prompt: '另一个项目的任务' })
  const otherCalls = providerB.calls.filter(row => row.model === 'other-model')
  assert.equal(otherCalls.length, 0, 'the unrelated session ran no model of its own here')

  providerB.enqueue({ text: JSON.stringify({ instruction: INSTRUCTION }) })
  clock.now = problemA.nextAttemptAt + 1
  await schedulerB.fire({ ms: TICK_MS, times: 1 })
  await flush()
  assert.equal(providerB.stats().physicalCalls, 1, 'the restarted host recovered exactly once')
  const call = providerB.last()
  assert.deepEqual({ provider: call.provider, model: call.model, reasoningEffort: call.reasoningEffort }, ROUTE,
    'the recovered attempt used the ORIGINAL route, never the other session or a default model')
  const prompt = call.prompt
  assert.ok(prompt.includes(PROJECT) === false, 'the raw project path is not part of the request')
  const recovered = hostB.problem(problemA.id)
  assert.equal(recovered.state, 'candidate_created')
  assert.equal(recovered.attemptedRevision, problemA.evidenceRevision)
  const lesson = hostB.state().lessons.find(row => row.id === recovered.lessonId)
  assert.ok(lesson, 'the recovered candidate is a real lesson row')
  assert.equal(lesson.sessionId, SESSION, 'the lesson keeps the source session of the recovered problem')
  assert.equal(callsA, 1)
})

test('P12b: an archived, deleted, re-routed or drifted source waits with a reason and spends nothing', async t => {
  const f = fixture(t)
  f.reply()
  await f.success(1)
  f.clock.now += 60_000
  await f.turn(2, { tools: failures('bash') })
  const problem = f.host.state().problems.find(row => row.toolName === 'bash')
  const before = f.provider.stats().physicalCalls

  // Each wake-up happens after the CURRENT wait the row holds (a defer moves it forward).
  const passOnce = async () => {
    const row = f.host.problem(problem.id)
    f.clock.now = Math.max(f.clock.now, row.nextAttemptAt) + 1
    await f.scheduler.fire({ ms: TICK_MS, times: 1 })
    await flush()
  }

  // (a) archive truth is a synchronous host fact: the row waits and says so.
  f.archived.add(SESSION)
  await passOnce()
  assert.equal(f.provider.stats().physicalCalls, before, 'an archived source spends nothing')
  let row = f.host.problem(problem.id)
  assert.equal(row.reason, 'source_archived')
  assert.equal(row.attemptedRevision, 0, 'the revision survives a temporary host fact')
  f.archived.delete(SESSION)

  // (b) the session is gone from the directory.
  f.sessions.length = 0
  await passOnce()
  assert.equal(f.provider.stats().physicalCalls, before)
  row = f.host.problem(problem.id)
  assert.equal(row.reason, 'source_unavailable')
  f.sessions.push(sessionRow(SESSION, { cwd: PROJECT, route: ROUTE }))

  // (c) the session is on a DIFFERENT model now: the frozen execution cannot be reconstructed.
  const restored = f.sessions[0]
  restored.events = [{ seq: 1, type: 'request/header',
    data: { header: { config: { provider: 'switched-provider', model: 'switched-model' } } } }]
  await passOnce()
  assert.equal(f.provider.stats().physicalCalls, before, 'a re-routed session is a different execution: it waits')
  assert.equal(f.host.problem(problem.id).reason, 'source_route_changed')

  // (d) the project the session reports has drifted: the core refuses the stored scope.
  restored.events = [{ seq: 1, type: 'request/header',
    data: { header: { config: { provider: ROUTE.provider, model: ROUTE.model,
      reasoningEffort: ROUTE.reasoningEffort } } } }]
  restored.header.cwd = '/synthetic/moved-project'
  await passOnce()
  assert.equal(f.provider.stats().physicalCalls, before, 'a drifted project is never silently re-bound')
  assert.equal(f.host.problem(problem.id).reason, 'scope_mismatch')
  assert.equal(f.host.problem(problem.id).lessonId, null)

  // (e) the true source comes back: the SAME revision recovers, with no new evidence needed.
  restored.header.cwd = PROJECT
  f.reply()
  await passOnce()
  assert.equal(f.provider.stats().physicalCalls, before + 1)
  const recovered = f.host.problem(problem.id)
  assert.equal(recovered.state, 'candidate_created')
  assert.equal(recovered.reason, null)
  assert.deepEqual({ provider: f.provider.last().provider, model: f.provider.last().model }, 
    { provider: ROUTE.provider, model: ROUTE.model })
})
