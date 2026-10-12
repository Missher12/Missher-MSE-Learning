// Stage 4b — the durable SOURCE IDENTITY and the FINAL PERMISSION GATE around one reflection.
//
// These cases drive the REAL core (`src/index.mjs` + `src/sources.mjs`) through the same
// transaction, ledger and control records every adapter uses. Nothing here is a re-implementation:
// a case that passes because the test computed its own answer would prove nothing, so every
// assertion reads state the engine itself wrote.
//
// The properties under test are the ones a Python driver cannot supply on its own:
//   1. the endpoint is stored as a FINGERPRINT, never in the clear, and a synthetic canary URL
//      (a tenant id and a path-shaped token) appears in no document and in no returned view;
//   2. the revision is MONOTONIC and compare-and-set, so a stale asynchronous publisher cannot
//      overwrite a newer fact;
//   3. the frozen binding is re-read inside the final transaction, so a pause, a resume, an exact
//      stop, or a source drift that lands after the ticket was signed refuses the commit while the
//      already-consumed attempt stays consumed;
//   4. one session's refusal never blocks another session's work;
//   5. a source row that a live ticket references cannot be evicted to make room.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningEngine } from '../src/index.mjs'
import { endpointFingerprintOf, normalizeEndpoint, sourceRowValid } from '../src/sources.mjs'

const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-flash'
const EFFORT = 'max'
const SUMMARY_TASK = '导出金额并核对排序结果'
const SUMMARY_RESULT = '宿主验证收集到 1 条工具失败（工具退出码非零），未收到助手总结，需要复盘失败条件'
const INSTRUCTION = '处理金额排序前先核对数值类型，再用固定输入独立检查输出顺序'
// A synthetic canary: nobody's real endpoint. Its tenant segment and token-shaped suffix must never
// reach the document, a status view or a ticket.
const CANARY = 'https://relay.invalid/tenant/AUDIT_PRIVATE_ID/token/AUDIT_TOKEN/v1'

function fixture(t) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse4b-source-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  // The reflection allowance is a HOST-WIDE rolling window (3 per 24h with a 30-minute cooldown
  // between attempts), not a per-session one. These cases are about the source gate, so the clock is
  // injectable and `advance` steps past a cooldown without touching any gate, budget or ledger rule.
  let clock = Date.now()
  const engine = new LearningEngine({ stateRoot, adapterId: 'hermes', maxContextBytes: 768, now: () => clock })
  // Past an inter-attempt gate: the 30-minute cooldown, or the whole rolling 3-per-24h window.
  const advance = (ms = 25 * 60 * 60_000) => { clock += ms }
  const document = () => JSON.parse(readFileSync(join(stateRoot, 'lessons-v1.json'), 'utf8'))
  return { engine, stateRoot, document, advance }
}

/** Publish one source identity for a session and return the core's own answer. */
const publish = (engine, sessionId, overrides = {}) => engine.sourcePublish({ sessionId,
  provider: PROVIDER, model: MODEL, apiMode: 'chat_completions', baseUrl: endpoint(sessionId),
  reasoningState: 'explicit', reasoningValue: EFFORT, driver: 'async_openai_chat', ...overrides })

/** The session's own endpoint: the canary shape, different per session so two sessions stay two. */
const endpoint = sessionId => `${CANARY}/${sessionId}`

/** Two independent host tool failures on one session: what makes a problem ready to reflect on. */
function matureProblem(engine, sessionId, routeId, turnIds = ['1', '2'], { toolName = `tool-${sessionId}` } = {}) {
  const route = { provider: PROVIDER, model: MODEL, reasoningEffort: EFFORT }
  let last = null
  turnIds.forEach(turnId => {
    last = engine.observeProblem({ sessionId, turnId, eventId: `call-${turnId}`, kind: 'tool_failure',
      source: 'host_event', toolName, failureCode: 'tool_nonzero_exit',
      summary: '工具失败：bash', route, routeId })
  })
  assert.equal(last.ready, true, 'the second independent failure must make the problem ready')
  return { id: last.id, evidenceRevision: last.problem.evidenceRevision, base: { sessionId } }
}

/** Sign one source-gated reflection ticket for a ready problem, exactly as the driver does. */
function sign(engine, sessionId, problem, bound, control, overrides = {}) {
  // The turn identity is per (session, turn) and the duplicate gate keys on it, so two attempts for
  // two DIFFERENT problems of one fixture must not share a turn id.
  return engine.reflectionRequest({ sessionId, turnId: `problem-recovery:${problem.id}`,
    taskSummary: SUMMARY_TASK, resultSummary: SUMMARY_RESULT, outcome: 'failed',
    problemId: problem.id, evidenceRevision: problem.evidenceRevision,
    sourceBinding: true, sourceRevision: bound.revision, sourceBindingHash: bound.bindingHash,
    controlGeneration: control, ...overrides })
}

test('the endpoint is stored as a fingerprint and the raw URL never reaches the document', t => {
  const { engine, document } = fixture(t)
  const published = publish(engine, 'canary-session')
  assert.equal(published.ok, true)
  assert.equal(published.published, true)
  const raw = readFileSync(join(engine.store.root, 'lessons-v1.json'), 'utf8')
  for (const leak of ['AUDIT_PRIVATE_ID', 'AUDIT_TOKEN', 'relay.invalid', 'tenant/', 'token/']) {
    assert.equal(raw.includes(leak), false, `the document must not contain ${leak}`)
  }
  // The identity the caller receives back carries the fingerprint and nothing else about the URL.
  assert.equal(typeof published.identity.endpointFingerprint, 'string')
  assert.match(published.identity.endpointFingerprint, /^[a-f0-9]{64}$/u)
  assert.deepEqual(Object.keys(published.identity).sort(),
    ['apiMode', 'endpointFingerprint', 'model', 'provider', 'reasoningState', 'reasoningValue'])
  assert.equal(JSON.stringify(published).includes('relay.invalid'), false)
  // The stored row validates, and its identity tuple holds the digest in the endpoint slot.
  const row = document().sourceLedger.sources[0]
  assert.equal(sourceRowValid(row), true)
  assert.equal(row.identity[4], published.identity.endpointFingerprint)
  // A status read is just as clean.
  const status = engine.sourceStatus()
  assert.equal(JSON.stringify(status).includes('AUDIT_'), false)
  assert.equal(status.rows[0].identity.endpointFingerprint, published.identity.endpointFingerprint)
})

test('the fingerprint is domain-prefixed, path-sensitive and refuses what it cannot state', t => {
  const { engine } = fixture(t)
  // The path is part of the identity: trimming it would make two different tenants compare equal.
  const left = publish(engine, 'left', { baseUrl: 'https://relay.invalid/tenant/a/v1' })
  const right = publish(engine, 'right', { baseUrl: 'https://relay.invalid/tenant/b/v1' })
  assert.notEqual(left.identity.endpointFingerprint, right.identity.endpointFingerprint,
    'different paths must stay different endpoints')
  assert.notEqual(left.routeId, right.routeId)
  // A trailing slash and a default port are the same endpoint; a query, userinfo or fragment is not
  // an endpoint this build can state at all.
  const plain = publish(engine, 'plain', { baseUrl: 'https://relay.invalid/tenant/a/v1' })
  const slash = publish(engine, 'slash', { baseUrl: 'https://relay.invalid:443/tenant/a/v1/' })
  assert.equal(plain.identity.endpointFingerprint, slash.identity.endpointFingerprint)
  for (const bad of ['https://user:pass@relay.invalid/v1', 'https://relay.invalid/v1?key=abc',
    'https://relay.invalid/v1#frag', 'https://relay.invalid//v1', 'ftp://relay.invalid/v1',
    'not a url', 'https://relay.invalid:notaport/v1']) {
    assert.equal(normalizeEndpoint(bad), null, `${bad} must be refused`)
    assert.equal(endpointFingerprintOf(bad), null)
  }
  // The fingerprint carries its own domain tag, so a bare hash of the URL is a different value.
  const fingerprint = endpointFingerprintOf('https://relay.invalid/v1')
  assert.equal(fingerprint.length, 64)
  assert.notEqual(fingerprint, endpointFingerprintOf('https://relay.invalid/v2'))
})

test('the revision is monotonic and a stale publisher cannot overwrite a newer fact', t => {
  const { engine } = fixture(t)
  const first = publish(engine, 'stale-session')
  assert.equal(first.revision, 1)
  // An identical re-publication is idempotent: it must NOT bump the revision, because a bump that
  // meant "nothing changed" would invalidate every in-flight ticket on a heartbeat.
  const again = publish(engine, 'stale-session')
  assert.equal(again.published, true)
  assert.equal(again.duplicate, true)
  assert.equal(again.revision, 1)
  assert.equal(again.bindingHash, first.bindingHash)
  // A real change (a new endpoint) advances the revision.
  const moved = publish(engine, 'stale-session', { baseUrl: 'https://relay.invalid/v2' })
  assert.equal(moved.created, false)
  assert.equal(moved.revision, 2)
  assert.notEqual(moved.routeId, first.routeId)
  // A publisher that read revision 1 must not be able to write over revision 2.
  const stale = publish(engine, 'stale-session', { expectRevision: 1, baseUrl: 'https://relay.invalid/v3' })
  assert.equal(stale.published, false)
  assert.equal(stale.code, 'source_stale_revision')
  assert.equal(stale.revision, 2)
  assert.equal(engine.sourceStatus().rows[0].revision, 2, 'the newer fact survives')
  // ...and the current revision still publishes.
  const current = publish(engine, 'stale-session', { expectRevision: 2, baseUrl: 'https://relay.invalid/v3' })
  assert.equal(current.published, true)
  assert.equal(current.revision, 3)
})

test('a scoped source publication never silently moves a row to another scope', t => {
  const { engine } = fixture(t)
  const published = publish(engine, 'scoped-session', { projectKey: 'project-a' })
  assert.equal(published.published, true)
  assert.throws(() => publish(engine, 'scoped-session', { projectKey: 'project-b' }), /source_scope_mismatch/u)
})

test('the final gate refuses pause, resume, exact stop and source drift, and never refunds', t => {
  const { engine } = fixture(t)
  const bound = publish(engine, 'gate-session')
  const problem = matureProblem(engine, 'gate-session', bound.routeId)
  const control = engine.controlGeneration()
  const ticket = sign(engine, 'gate-session', problem, bound, control)
  assert.equal(typeof ticket.ticket, 'string')
  assert.equal(ticket.source.revision, bound.revision, 'the ticket froze the exact source revision')
  // ...pause, then resume: the generation moved twice, and the old ticket can never come back.
  engine.settlementPause({ paused: true })
  engine.settlementPause({ paused: false })
  assert.notEqual(engine.controlGeneration(), control)
  const refused = engine.reflectionResult({ ticket: ticket.ticket, result: { instruction: INSTRUCTION } })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'control_changed')
  assert.equal(refused.settled, true, 'the refused attempt is consumed, not left in flight')
  // The attempt stays spent: the ticket is settled, so a repeat of the SAME commit reports the
  // terminal fact it really has — never a second candidate, never a second charge, and never the
  // "expired, so try again" answer that a lost ACK must not look like.
  assert.equal(engine.status().reflectionsLast24h, 1)
  const repeat = engine.reflectionResult({ ticket: ticket.ticket, result: { instruction: INSTRUCTION } })
  assert.equal(repeat.code, 'reflection_already_settled')
  assert.equal(repeat.settled, true)
  assert.equal(repeat.terminal, 'control_changed')
  assert.equal(engine.reflectionResult({ ticket: 'no-such-ticket', result: { instruction: INSTRUCTION } }).code,
    'reflection_unknown_ticket')
  const rows = engine.problemStatus().rows
  assert.equal(rows[0].state, 'waiting_evidence', 'the problem waits for genuinely new evidence')
  assert.equal(rows[0].attemptedRevision, problem.evidenceRevision)
  assert.equal(rows[0].lessonId, null, 'no candidate was minted')
})

test('a source that drifts after signing is refused at commit, while another session still works', t => {
  const { engine, advance } = fixture(t)
  const bound = publish(engine, 'drift-session')
  const other = publish(engine, 'clean-session')
  const problem = matureProblem(engine, 'drift-session', bound.routeId)
  const clean = matureProblem(engine, 'clean-session', other.routeId, ['3', '4'])
  const control = engine.controlGeneration()
  const ticket = sign(engine, 'drift-session', problem, bound, control)
  assert.equal(typeof ticket.ticket, 'string')
  // The host re-publishes the SAME session on a different endpoint: a different execution.
  const moved = publish(engine, 'drift-session', { baseUrl: 'https://relay.invalid/elsewhere/v1' })
  assert.equal(moved.revision, 2)
  const refused = engine.reflectionResult({ ticket: ticket.ticket, result: { instruction: INSTRUCTION } })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'source_changed')
  // A DIFFERENT session is untouched by that: its OWN attempt still signs and still commits. (The
  // host-wide reflection allowance has a 30-minute cooldown between attempts, so the clock steps
  // past it — that allowance is core policy and deliberately not what this case is about.)
  advance(31 * 60_000)
  const cleanTicket = sign(engine, 'clean-session', clean, other, engine.controlGeneration())
  assert.equal(typeof cleanTicket.ticket, 'string')
  const committed = engine.reflectionResult({ ticket: cleanTicket.ticket, result: { instruction: INSTRUCTION } })
  assert.equal(committed.ok, true)
  assert.equal(typeof committed.id, 'string')
})

test('an exact stop refuses the ticket its session signed, and does not close the host', t => {
  const { engine, advance } = fixture(t)
  const stopped = publish(engine, 'stopped-session')
  const stoppedProblem = matureProblem(engine, 'stopped-session', stopped.routeId)
  const ticket = sign(engine, 'stopped-session', stoppedProblem, stopped, engine.controlGeneration())
  assert.equal(typeof ticket.ticket, 'string')
  engine.settlementStop({ sessionId: 'stopped-session', reason: 'operator' })
  const refused = engine.reflectionResult({ ticket: ticket.ticket, result: { instruction: INSTRUCTION } })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'control_source_stopped')
  assert.equal(refused.settled, true, 'the refused attempt is consumed')
  const row = engine.problemStatus().rows.find(entry => entry.id === stoppedProblem.id)
  assert.equal(row.state, 'waiting_evidence')
  assert.equal(row.attemptedRevision, stoppedProblem.evidenceRevision)
  assert.equal(row.lessonId, null, 'no candidate was minted')
  assert.equal(engine.status().reflectionsLast24h, 1, 'the attempt stays spent')
})

test('stopping one session does not permanently disable another', t => {
  const { engine, advance } = fixture(t)
  const stopped = publish(engine, 'stopped-session')
  const alive = publish(engine, 'alive-session')
  const stoppedProblem = matureProblem(engine, 'stopped-session', stopped.routeId)
  const aliveProblem = matureProblem(engine, 'alive-session', alive.routeId, ['3', '4'])
  // The two sessions are driven as SEPARATE trajectories, never as two live tickets held across the
  // host-wide 30-minute cooldown: A is signed, stopped and refused at one clock position, then B is
  // signed fresh past the cooldown and commits.
  const stoppedTicket = sign(engine, 'stopped-session', stoppedProblem, stopped, engine.controlGeneration())
  assert.equal(typeof stoppedTicket.ticket, 'string')
  engine.settlementStop({ sessionId: 'stopped-session', reason: 'operator' })
  const refused = engine.reflectionResult({ ticket: stoppedTicket.ticket, result: { instruction: INSTRUCTION } })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'control_source_stopped', 'the refusal NAMES the session that was stopped')
  assert.equal(refused.settled, true)
  const stoppedRow = engine.problemStatus().rows.find(entry => entry.id === stoppedProblem.id)
  assert.equal(stoppedRow.state, 'waiting_evidence')
  assert.equal(stoppedRow.attemptedRevision, stoppedProblem.evidenceRevision)
  assert.equal(stoppedRow.lessonId, null)
  // B is a different session: nothing about A's stop closes the host.
  advance(31 * 60_000)
  const retry = engine.controlGeneration()
  const aliveTicket = sign(engine, 'alive-session', aliveProblem, alive, retry)
  assert.equal(typeof aliveTicket.ticket, 'string', 'a different session still signs after the stop')
  const committed = engine.reflectionResult({ ticket: aliveTicket.ticket, result: { instruction: INSTRUCTION } })
  assert.equal(committed.ok, true)
  assert.equal(typeof committed.id, 'string')
  assert.equal(engine.problemStatus().rows.find(entry => entry.id === aliveProblem.id).state, 'candidate_created')
})

test('the request gate refuses an unproven driver, reasoning or endpoint before any spend', t => {
  const { engine } = fixture(t)
  const cases = [
    ['provider_driver_unsupported', { apiMode: 'responses' }],
    ['provider_driver_unsupported', { apiMode: 'anthropic_messages' }],
    ['source_reasoning_unavailable', { reasoningState: 'unknown', reasoningValue: null }],
    ['source_reasoning_unavailable', { reasoningState: 'not_applicable', reasoningValue: null }]
  ]
  let caseIndex = 0
  for (const [reason, overrides] of cases) {
    caseIndex += 1
    const session = `unproven-${caseIndex}`
    const bound = publish(engine, session, overrides)
    assert.equal(bound.published, true, `${reason}: the row itself is a fact and may be stored`)
    const problem = matureProblem(engine, session, bound.routeId)
    const refused = sign(engine, session, problem, bound, engine.controlGeneration())
    assert.equal(refused.skipped, reason, `${JSON.stringify(overrides)} must wait as ${reason}`)
    assert.equal(refused.ticket, undefined, 'nothing is signed')
    assert.equal(engine.status().reflectionsLast24h, 0, 'nothing is charged')
    const row = engine.problemStatus().rows.find(entry => entry.id === problem.id)
    assert.equal(row.attemptedRevision, 0, 'the evidence revision is not consumed')
  }
})

test('the gate refuses a stale source revision, a mismatched binding and a stale control', t => {
  const { engine } = fixture(t)
  const bound = publish(engine, 'stale-ticket')
  const problem = matureProblem(engine, 'stale-ticket', bound.routeId)
  const control = engine.controlGeneration()
  const stale = sign(engine, 'stale-ticket', problem, { ...bound, revision: bound.revision + 1 }, control)
  assert.equal(stale.skipped, 'source_stale_revision')
  const wrongHash = sign(engine, 'stale-ticket', problem,
    { ...bound, bindingHash: 'f'.repeat(64) }, control)
  assert.equal(wrongHash.skipped, 'source_stale_revision')
  const oldControl = sign(engine, 'stale-ticket', problem, bound, control + 7)
  assert.equal(oldControl.skipped, 'control_changed')
  // A paused host refuses at the REQUEST, before the ticket exists.
  engine.settlementPause({ paused: true })
  const paused = sign(engine, 'stale-ticket', problem, bound, engine.controlGeneration())
  assert.equal(paused.skipped, 'control_paused')
  assert.equal(engine.status().reflectionsLast24h, 0)
})

test('a bound reflection is refused for a problem with no published source, and for a foreign one', t => {
  const { engine } = fixture(t)
  const bound = publish(engine, 'bound-session')
  const unbound = matureProblem(engine, 'unbound-session', null, ['5', '6'], { toolName: 'never-bound' })
  // The session the problem came from never published a source: the ticket is refused on the
  // problem's OWN identity, whatever binding the caller offers.
  const refused = sign(engine, 'unbound-session', unbound, bound, engine.controlGeneration())
  assert.equal(refused.skipped, 'source_unknown')
  assert.equal(refused.ticket, undefined)
  assert.equal(engine.problemStatus().rows.find(row => row.id === unbound.id).attemptedRevision, 0)
  // A problem observed WITHOUT a routeId still binds through the three scalars, but only when the
  // published identity agrees with them.
  const agreed = matureProblem(engine, 'bound-session', bound.routeId, ['3', '4'])
  const fine = sign(engine, 'bound-session', agreed, bound, engine.controlGeneration())
  assert.equal(typeof fine.ticket, 'string')
})

test('a caller cannot ask for the gate and then hand in an unproven or downgraded binding', t => {
  const { engine } = fixture(t)
  const bound = publish(engine, 'shape-session')
  const problem = matureProblem(engine, 'shape-session', bound.routeId)
  const control = engine.controlGeneration()
  const base = { sessionId: 'shape-session', turnId: 'x', taskSummary: SUMMARY_TASK,
    resultSummary: SUMMARY_RESULT, outcome: 'failed', problemId: problem.id,
    evidenceRevision: problem.evidenceRevision }
  // A generation without the gate, a binding without a revision, and an explicit `false` are all
  // refused rather than quietly downgraded to the released path.
  const shapes = {
    'a control generation without the gate': { controlGeneration: control },
    'a binding without its hash': { sourceBinding: true, sourceRevision: bound.revision },
    'an explicit refusal of the gate': { sourceBinding: false, sourceRevision: bound.revision,
      sourceBindingHash: bound.bindingHash },
    'a binding with no gate flag at all': { sourceRevision: bound.revision,
      sourceBindingHash: bound.bindingHash },
    'a non-boolean gate flag': { sourceBinding: 'true', sourceRevision: bound.revision,
      sourceBindingHash: bound.bindingHash },
    'a negative source revision': { sourceBinding: true, sourceRevision: 0,
      sourceBindingHash: bound.bindingHash },
    'a non-numeric control generation': { sourceBinding: true, sourceRevision: bound.revision,
      sourceBindingHash: bound.bindingHash, controlGeneration: 'one' }
  }
  for (const [label, input] of Object.entries(shapes)) {
    assert.throws(() => engine.reflectionRequest({ ...base, ...input }), /invalid_reflection/u, label)
  }
  assert.equal(engine.status().reflectionsLast24h, 0)
  // The released explicit path still works exactly as before (no gate requested, no fields present).
  const legacy = engine.reflectionRequest(base)
  assert.equal(typeof legacy.ticket, 'string')
  assert.equal(legacy.source, undefined, 'the released path freezes no source binding')
})

test('a row a live ticket references is never evicted, while a dead one ages out', t => {
  const { engine, document } = fixture(t)
  const held = publish(engine, 'held-session')
  const problem = matureProblem(engine, 'held-session', held.routeId)
  const ticket = sign(engine, 'held-session', problem, held, engine.controlGeneration())
  // Fill the ledger past its cap with other sessions. Capacity is REFUSED rather than resolved by
  // evicting a row that is still protecting an attempt, so the fill is allowed to stop early — that
  // explicit refusal IS the property under test.
  let published = 0, refusals = 0
  for (let index = 0; index < 60; index += 1) {
    try {
      publish(engine, `filler-${index}`, { baseUrl: `https://relay.invalid/filler/${index}/v1` })
      published += 1
    } catch (error) { assert.equal(error.code, 'source_capacity'); refusals += 1 }
  }
  assert.equal(published, 31, 'the cap admits exactly one fewer than the limit')
  assert.ok(refusals > 0, 'further publications are explicitly refused')
  const rows = document().sourceLedger.sources
  assert.equal(rows.length, 32, 'the ledger stays bounded')
  assert.equal(rows.some(row => row.sessionHash === held.sessionHash), true,
    'the row a live ticket froze is still there')
  const pinned = engine.sourceStatus({ limit: 64 }).rows.filter(row => row.pinned === true)
  assert.equal(pinned.length, 1, 'exactly the row a live ticket froze is pinned')
  assert.equal(pinned[0].revision, held.revision)
  assert.equal(pinned[0].held, true, 'the hold is a durable column, not a derived guess')
  assert.equal(rows.filter(row => row.held === true).length, 1)
  // The commit therefore still works: the gate can compare against exactly what it froze.
  assert.equal(engine.reflectionResult({ ticket: ticket.ticket, result: { instruction: INSTRUCTION } }).ok, true)
})

test('source release is compare-and-set and never revives a newer identity', t => {
  const { engine } = fixture(t)
  const bound = publish(engine, 'release-session')
  const stale = engine.sourceRelease({ sessionId: 'release-session', expectRevision: bound.revision + 1 })
  assert.equal(stale.released, false)
  assert.equal(stale.code, 'source_stale_revision')
  assert.equal(engine.sourceStatus().total, 1)
  const released = engine.sourceRelease({ sessionId: 'release-session', expectRevision: bound.revision,
    expectBindingHash: bound.bindingHash })
  assert.equal(released.released, true)
  assert.equal(engine.sourceStatus().total, 0)
  // A released source refuses a new reflection: the identity is gone, not merely stale.
  const problem = matureProblem(engine, 'release-session', bound.routeId)
  const refused = sign(engine, 'release-session', problem, bound, engine.controlGeneration())
  assert.equal(refused.skipped, 'source_unknown')
})

test('an observation only carries the digest the ledger really holds for that route', t => {
  const { engine } = fixture(t)
  const bound = publish(engine, 'digest-session')
  const route = { provider: PROVIDER, model: MODEL, reasoningEffort: EFFORT }
  const agree = engine.observeProblem({ sessionId: 'digest-session', turnId: '1', eventId: 'a',
    kind: 'tool_failure', source: 'host_event', toolName: 'bash', failureCode: 'tool_nonzero_exit',
    summary: '工具失败：bash', route, routeId: bound.routeId })
  assert.equal(agree.problem.origin.routeId, bound.routeId)
  // A route the published identity does not agree with stores NO digest: a caller cannot stamp a
  // stale digest onto evidence produced under another execution.
  const disagree = engine.observeProblem({ sessionId: 'digest-session', turnId: '2', eventId: 'b',
    kind: 'tool_failure', source: 'host_event', toolName: 'other-tool', failureCode: 'tool_nonzero_exit',
    summary: '工具失败：other-tool', route: { ...route, model: 'some-other-model' }, routeId: bound.routeId })
  assert.equal(disagree.problem.origin.routeId, null)
  assert.equal(disagree.problem.origin.model, 'some-other-model')
  // ...and an invented digest is stored as nothing rather than as a binding.
  const invented = engine.observeProblem({ sessionId: 'digest-session', turnId: '3', eventId: 'c',
    kind: 'tool_failure', source: 'host_event', toolName: 'third-tool', failureCode: 'tool_nonzero_exit',
    summary: '工具失败：third-tool', route, routeId: 'a'.repeat(64) })
  assert.equal(invented.problem.origin.routeId, null,
    'a digest the ledger does not hold for this route is not a binding')
  assert.equal(engine.store.read().sourceLedger.sources[0].routeId, bound.routeId,
    'the ledger still holds exactly the digest it computed')
})

test('the recovery plan answers the source-identity questions before a ticket exists', t => {
  const { engine } = fixture(t)
  const bound = publish(engine, 'plan-session')
  const problem = matureProblem(engine, 'plan-session', bound.routeId)
  const plan = engine.problemRecoveryPlan({ problemId: problem.id })
  assert.equal(plan.recoverable, true)
  assert.equal(plan.source.revision, bound.revision)
  assert.equal(plan.source.routeId, bound.routeId)
  assert.equal(plan.source.driver, 'async_openai_chat')
  assert.equal(plan.origin.routeId, bound.routeId, 'the plan reports the digest, never an endpoint')
  // An unsupported driver is a WAIT, and it is NOT recoverable-for-this-build.
  const unsupported = publish(engine, 'plan-unsupported', { apiMode: 'responses' })
  const other = matureProblem(engine, 'plan-unsupported', unsupported.routeId)
  const refused = engine.problemRecoveryPlan({ problemId: other.id })
  // The plan REPORTS the source state rather than requiring it (a released entry point keeps its
  // contract — see the Node gate case), so a caller that wants the gate reads `gateReady`.
  assert.equal(refused.recoverable, true)
  assert.equal(refused.source.gateReady, false)
  assert.equal(refused.source.code, 'provider_driver_unsupported')
  // ...and it can be parked under exactly that code, which keeps the revision unspent.
  const deferred = engine.problemDefer({ problemId: other.id, evidenceRevision: other.evidenceRevision,
    code: 'provider_driver_unsupported' })
  assert.equal(deferred.deferred, true)
  assert.equal(deferred.evidenceRevision, other.evidenceRevision)
  assert.equal(engine.problemStatus().rows.find(row => row.id === other.id).attemptedRevision, 0)
  const moved = publish(engine, 'plan-unsupported', { baseUrl: 'https://relay.invalid/moved/v1' })
  const drifted = publish(engine, 'plan-session', { baseUrl: 'https://relay.invalid/moved/v1' })
  assert.equal(moved.revision, 2)
  assert.equal(drifted.revision, 2)
  const driftedPlan = engine.problemRecoveryPlan({ problemId: problem.id })
  assert.equal(driftedPlan.source.gateReady, false,
    'a session whose published identity moved away from the evidence cannot pass the source gate')
  assert.equal(driftedPlan.source.code, 'source_route_changed')
})

test('a released ticket keeps its published contract: the registered evaluator still promotes', t => {
  // The DSH adapter signs registered-method reflections with NO source binding, and that path is
  // RELEASED behaviour: the bounded pure evaluator runs and may promote the lesson. Retrofitting the
  // new gate onto it would turn every already-authorised promotion into `inconclusive` while the
  // attempt stayed spent — a compatibility regression, not a protection.
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse4b-legacy-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh', instanceId: 'audit-legacy-method',
    reflectionsPerDay: 4 })
  const signed = engine.reflectionRequest({ sessionId: 'old-dsh-source', turnId: '1',
    projectKey: 'audit-legacy', outcome: 'failed', taskSummary: '导出数据时保留来源的空值字段',
    resultSummary: '来源缺失值在导出时被替换，需要保持原始缺失语义' })
  assert.equal(typeof signed.ticket, 'string')
  assert.equal(signed.source, undefined, 'a released ticket freezes no source binding')
  const result = engine.reflectionResult({ ticket: signed.ticket,
    result: { instruction: '登记规范方法', methodId: 'preserve-null-v1' } })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'validated', 'the registered evaluator still promotes a released ticket')
  assert.equal(result.version, 2)
  assert.equal(result.evaluation, 'accepted')
  const state = engine.store.read()
  assert.equal(state.experiments.length, 1, 'the pure evaluation really ran')
  assert.equal(state.experiments[0].basis, 'registered_algorithm')
  assert.equal(state.experiments[0].decision, 'accepted')
  assert.equal(state.experiments[0].summary.pairs, 24)
  assert.equal(state.spends.filter(row => row.kind === 'reflection').length, 1)
  assert.equal(state.lessons[0].status, 'validated')
  assert.equal(state.lessons[0].version, 2)
  // The same trajectory under a SOURCE-GATED ticket is refused at commit and never promotes through
  // the second door either: the gate this build added is not weakened by the released path above.
  const gatedRoot = mkdtempSync(join(tmpdir(), 'mse4b-legacy-gated-'))
  t.after(() => rmSync(gatedRoot, { recursive: true, force: true }))
  const gated = new LearningEngine({ stateRoot: gatedRoot, adapterId: 'dsh',
    instanceId: 'audit-legacy-method', reflectionsPerDay: 4 })
  const bound = gated.sourcePublish({ sessionId: 'gated-source', provider: PROVIDER, model: MODEL,
    apiMode: 'chat_completions', baseUrl: endpoint('gated-source'), reasoningState: 'explicit',
    reasoningValue: EFFORT, driver: 'async_openai_chat' })
  const problem = matureProblem(gated, 'gated-source', bound.routeId)
  const ticket = sign(gated, 'gated-source', problem, bound, gated.controlGeneration())
  assert.equal(typeof ticket.ticket, 'string')
  gated.settlementPause({ paused: true })
  gated.settlementPause({ paused: false })
  assert.equal(gated.reflectionResult({ ticket: ticket.ticket,
    result: { instruction: '登记规范方法', methodId: 'preserve-null-v1' } }).code, 'control_changed')
  const after = gated.store.read()
  assert.equal(after.experiments.length, 0, 'a refused commit runs no evaluation')
  assert.equal(after.lessons.filter(row => row.kind === 'method').length, 0)
})

test('a frozen binding stays on the ticket it was signed for, and no later generation backfills it', t => {
  const { engine } = fixture(t)
  const bound = publish(engine, 'freeze-session')
  const problem = matureProblem(engine, 'freeze-session', bound.routeId)
  const control = engine.controlGeneration()
  const ticket = sign(engine, 'freeze-session', problem, bound, control)
  const stored = engine.store.read().events.find(row => row.ticket === ticket.ticket)
  assert.equal(stored.sourceRevision, bound.revision)
  assert.equal(stored.sourceBindingHash, bound.bindingHash)
  assert.equal(stored.sourceControlGeneration, control)
  assert.equal(stored.sourceRouteId, bound.routeId)
  assert.equal(stored.sourceSessionHash, engine.sourceStatus().rows[0].sessionHash)
  // A NEWER source revision must never be able to stand in for the frozen one: the caller may not
  // substitute it, and the core does not re-read it.
  const moved = publish(engine, 'freeze-session', { baseUrl: 'https://relay.invalid/after/v1' })
  assert.equal(moved.revision, bound.revision + 1)
  const substituted = engine.reflectionResult({ ticket: ticket.ticket, result: { instruction: INSTRUCTION },
    expected: { routeId: moved.routeId, revision: moved.revision, bindingHash: moved.bindingHash,
      controlGeneration: control, sessionHash: engine.sourceStatus().rows[0].sessionHash } })
  assert.equal(substituted.ok, false)
  assert.equal(substituted.code, 'source_changed', 'the later generation is not backfilled into the old ticket')
})

test('an old document without the ledger still validates and still reads', t => {
  const { engine, stateRoot } = fixture(t)
  const bound = publish(engine, 'legacy-session')
  const problem = matureProblem(engine, 'legacy-session', bound.routeId)
  assert.equal(typeof problem.id, 'string')
  // Strip the new field the way an upgraded build reads a document written before it existed.
  const file = join(stateRoot, 'lessons-v1.json')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  delete state.sourceLedger
  writeFileSync(file, JSON.stringify(state))
  const reopened = new LearningEngine({ stateRoot, adapterId: 'hermes', maxContextBytes: 768 })
  assert.equal(reopened.status().ok, true, 'a document without the ledger still validates')
  assert.equal(reopened.sourceStatus().total, 0)
  assert.equal(reopened.problemStatus().rows[0].origin.routeId, bound.routeId,
    'the binding already recorded on the row survives')
  const refused = sign(reopened, 'legacy-session', problem, bound, reopened.controlGeneration())
  assert.equal(refused.skipped, 'source_unknown')
})

test('a source published for one project or environment never authorises another', t => {
  const { engine, advance } = fixture(t)
  // ── the SCOPE half ──────────────────────────────────────────────────────────────────────────
  // The identity is published for project A.
  const bound = publish(engine, 'scoped-source', { projectKey: 'projectA' })
  // The SAME session's problem is observed under project B: the identity that authorises a
  // reflection for A must not authorise one charged to B.
  for (const [turnId, eventId] of [['3', 'call-3'], ['4', 'call-4']]) {
    engine.observeProblem({ sessionId: 'scoped-source', turnId, eventId, projectKey: 'projectB',
      kind: 'tool_failure', source: 'host_event', toolName: 'other-tool', failureCode: 'tool_nonzero_exit',
      summary: '工具失败：other-tool', route: { provider: PROVIDER, model: MODEL, reasoningEffort: EFFORT } })
  }
  const otherId = engine.problemStatus({ projectKey: 'projectB' }).rows
    .find(row => row.toolName === 'other-tool').id
  const crossScope = engine.reflectionRequest({ sessionId: 'scoped-source',
    turnId: `problem-recovery:${otherId}`, projectKey: 'projectB', taskSummary: SUMMARY_TASK,
    resultSummary: SUMMARY_RESULT, outcome: 'failed', problemId: otherId, evidenceRevision: 2,
    sourceBinding: true, sourceRevision: bound.revision, sourceBindingHash: bound.bindingHash,
    controlGeneration: engine.controlGeneration() })
  assert.equal(crossScope.skipped, 'scope_mismatch',
    'the scope of the charge must be the scope the identity was published for')
  assert.equal(engine.status().reflectionsLast24h, 0, 'a mismatched scope charges nothing')
  // ── the ENVIRONMENT half ────────────────────────────────────────────────────────────────────
  // A source identity published in the DEFAULT environment, and a problem observed in ANOTHER one.
  // Scope and owner are the same; the environment is not, and that alone must refuse the charge.
  advance()
  const envBound = publish(engine, 'env-source', { projectKey: 'projectA' })
  for (const [turnId, eventId] of [['5', 'call-5'], ['6', 'call-6']]) {
    engine.observeProblem({ sessionId: 'env-source', turnId, eventId, projectKey: 'projectA',
      environmentId: 'another-environment', kind: 'tool_failure', source: 'host_event',
      toolName: 'env-tool', failureCode: 'tool_nonzero_exit', summary: '工具失败：env-tool',
      route: { provider: PROVIDER, model: MODEL, reasoningEffort: EFFORT } })
  }
  const envId = engine.problemStatus({ projectKey: 'projectA' }).rows
    .find(row => row.toolName === 'env-tool').id
  const crossEnv = engine.reflectionRequest({ sessionId: 'env-source',
    turnId: `problem-recovery:${envId}`, projectKey: 'projectA', environmentId: 'another-environment',
    taskSummary: SUMMARY_TASK, resultSummary: SUMMARY_RESULT, outcome: 'failed', problemId: envId,
    evidenceRevision: 2, sourceBinding: true, sourceRevision: envBound.revision,
    sourceBindingHash: envBound.bindingHash, controlGeneration: engine.controlGeneration() })
  assert.equal(crossEnv.skipped, 'environment_mismatch')
  assert.equal(engine.status().reflectionsLast24h, 0, 'a mismatched environment charges nothing')
  // ── the environment of a LIVE identity is durable, and moving it is a refusal, not a rewrite ──
  // Rebinding the same session under another environment would silently move every in-flight ticket
  // that froze the old one, so the ledger refuses it and the host must release first.
  assert.throws(() => publish(engine, 'env-source', { projectKey: 'projectA',
    environmentId: 'another-environment' }), /source_scope_mismatch/u)
  // A DIFFERENT session published under that environment signs normally, so the refusal is precise
  // rather than a blanket block on the field.
  const other = publish(engine, 'env-source-b', { projectKey: 'projectA',
    environmentId: 'another-environment' })
  const matching = engine.reflectionRequest({ sessionId: 'env-source-b',
    turnId: `problem-recovery:${envId}`, projectKey: 'projectA', environmentId: 'another-environment',
    taskSummary: SUMMARY_TASK, resultSummary: SUMMARY_RESULT, outcome: 'failed', problemId: envId,
    evidenceRevision: 2, sourceBinding: true, sourceRevision: other.revision,
    sourceBindingHash: other.bindingHash, controlGeneration: engine.controlGeneration() })
  assert.notEqual(matching.skipped, 'environment_mismatch',
    'an identity PUBLISHED for that environment is not refused by the environment rule')
})

test('a released and re-published identity never revives an old ticket', t => {
  const { engine, advance } = fixture(t)
  const bound = publish(engine, 'aba-session')
  const problem = matureProblem(engine, 'aba-session', bound.routeId)
  const ticket = sign(engine, 'aba-session', problem, bound, engine.controlGeneration())
  assert.equal(typeof ticket.ticket, 'string')
  // Release, then publish the SAME identity again. The revision legitimately restarts at 1, so only a
  // persistent epoch can tell the two apart — and the old ticket must never come back to life.
  const released = engine.sourceRelease({ sessionId: 'aba-session', expectRevision: bound.revision,
    expectBindingHash: bound.bindingHash })
  assert.equal(released.released, true)
  const again = publish(engine, 'aba-session')
  assert.equal(again.revision, 1, 'the revision really does restart')
  assert.equal(again.routeId, bound.routeId, 'and the identity really is the same one')
  assert.notEqual(again.bindingHash, bound.bindingHash, 'the epoch makes the binding different')
  assert.ok(again.epoch > bound.epoch, `${again.epoch} must exceed ${bound.epoch}`)
  const refused = engine.reflectionResult({ ticket: ticket.ticket, result: { instruction: INSTRUCTION } })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'source_changed')
  assert.equal(engine.store.read().lessons.filter(row => row.kind === 'method').length, 0,
    'the rebound identity never produced a candidate for the old ticket')
  // A NEW attempt under the NEW binding works, so the epoch gate is not a blanket refusal.
  advance()
  const fresh = matureProblem(engine, 'aba-session', again.routeId, ['5', '6'], { toolName: 'fresh-tool' })
  const retry = sign(engine, 'aba-session', fresh, again, engine.controlGeneration())
  assert.equal(typeof retry.ticket, 'string', JSON.stringify(retry))
  assert.equal(engine.reflectionResult({ ticket: retry.ticket, result: { instruction: INSTRUCTION } }).ok, true)
})

test('a live ticket keeps its session stop in force under tombstone pressure', t => {
  const { engine, document } = fixture(t)
  // One session with a LIVE ticket and a stop tombstone naming it.
  const held = publish(engine, 'tombstone-session')
  const problem = matureProblem(engine, 'tombstone-session', held.routeId)
  const ticket = sign(engine, 'tombstone-session', problem, held, engine.controlGeneration())
  assert.equal(typeof ticket.ticket, 'string')
  engine.settlementStop({ sessionId: 'tombstone-session', reason: 'operator' })
  const stops = () => (document().settlementControl.stops ?? [])
  assert.equal(stops().filter(row => row.sessionHash === held.sessionHash).length, 1, 'the stop is in force')
  // Now fill the stop table past its cap with other sessions, all of which have nothing binding them.
  for (let index = 0; index < 80; index += 1) {
    engine.settlementStop({ sessionId: `filler-session-${index}`, reason: 'pressure' })
  }
  assert.ok(stops().length <= 64, 'the stop table stays bounded')
  assert.equal(stops().some(row => row.sessionHash === held.sessionHash), true,
    'the stop naming a session a LIVE ticket still references was not trimmed')
  // The ticket is refused by that stop, and the refusal names the session.
  const refused = engine.reflectionResult({ ticket: ticket.ticket, result: { instruction: INSTRUCTION } })
  assert.equal(refused.code, 'control_source_stopped')
})

test('a measured cost is recorded once per attempt, and an unreadable one is never zero', t => {
  const { engine } = fixture(t)
  const bound = publish(engine, 'usage-session')
  const problem = matureProblem(engine, 'usage-session', bound.routeId)
  const ticket = sign(engine, 'usage-session', problem, bound, engine.controlGeneration())
  const usage = { known: true, promptTokens: 11, completionTokens: 7, totalTokens: 18 }
  const committed = engine.reflectionResult({ ticket: ticket.ticket,
    result: { instruction: INSTRUCTION }, usage })
  assert.equal(committed.ok, true)
  const state = engine.store.read()
  const spend = state.spends.find(row => row.ticket === ticket.ticket)
  assert.deepEqual(spend.usage, { known: true, promptTokens: 11, completionTokens: 7, totalTokens: 18,
    at: spend.usage.at })
  assert.equal(spend.tokens, 0, 'the reflection allowance stays counted in ATTEMPTS, not tokens')
  assert.equal(engine.status().reflectionsLast24h, 1)
  assert.equal(engine.status().reflectionTokensLast24h, 18)
  // Re-reporting the same ticket is idempotent: no second charge, no rewritten measurement.
  const repeat = engine.reflectionResult({ ticket: ticket.ticket, result: { instruction: INSTRUCTION }, usage })
  assert.equal(repeat.code, 'reflection_already_settled')
  assert.equal(engine.status().reflectionTokensLast24h, 18, 'the cost was charged exactly once')
  // A malformed measurement is REFUSED rather than rounded into the books.
  for (const bad of [{ known: true, promptTokens: 1, completionTokens: 2, totalTokens: 9 },
    { known: true, promptTokens: 1, totalTokens: 3 }, { known: 'yes' }, { known: true, promptTokens: -1,
      completionTokens: 1, totalTokens: 0 }]) {
    assert.throws(() => engine.reflectionResult({ ticket: ticket.ticket,
      result: { instruction: INSTRUCTION }, usage: bad }), /invalid_reflection|invalid_usage/u)
  }
})

test('an unreadable cost and a revoked permit both keep the accounting', t => {
  const { engine, advance } = fixture(t)
  const bound = publish(engine, 'unknown-usage')
  const problem = matureProblem(engine, 'unknown-usage', bound.routeId)
  const ticket = sign(engine, 'unknown-usage', problem, bound, engine.controlGeneration())
  // The provider answered but its usage could not be read: the attempt is charged, marked UNKNOWN,
  // and never promoted on the strength of a number nobody measured.
  const unknown = engine.reflectionResult({ ticket: ticket.ticket, result: { instruction: INSTRUCTION },
    usage: { known: false } })
  assert.equal(unknown.ok, true, 'an unreadable cost does not stop the candidate from being recorded')
  assert.equal(engine.status().reflectionTokensLast24h, 0)
  assert.equal(engine.status().reflectionTokensUnknown24h, 1)
  const spend = engine.store.read().spends.find(row => row.ticket === ticket.ticket)
  assert.deepEqual({ known: spend.usage.known }, { known: false })
  assert.equal(engine.store.read().lessons[0].status, 'candidate', 'a candidate is never validated here')
  // Now a KNOWN cost on a permit that is revoked before the commit: the money is still recorded.
  advance()
  const second = publish(engine, 'revoked-usage')
  const secondProblem = matureProblem(engine, 'revoked-usage', second.routeId)
  const secondTicket = sign(engine, 'revoked-usage', secondProblem, second, engine.controlGeneration())
  engine.settlementPause({ paused: true })
  const refused = engine.reflectionResult({ ticket: secondTicket.ticket,
    result: { instruction: INSTRUCTION },
    usage: { known: true, promptTokens: 5, completionTokens: 5, totalTokens: 10 } })
  assert.equal(refused.code, 'control_paused')
  const revoked = engine.store.read().spends.find(row => row.ticket === secondTicket.ticket)
  assert.deepEqual({ known: revoked.usage.known, total: revoked.usage.totalTokens },
    { known: true, total: 10 }, 'a revoked permit does not lose the cost it already incurred')
})

test('a cancelled attempt reports its cost or says the cost is unknown, never zero', t => {
  const { engine, advance } = fixture(t)
  const bound = publish(engine, 'cancel-usage')
  const problem = matureProblem(engine, 'cancel-usage', bound.routeId)
  const first = sign(engine, 'cancel-usage', problem, bound, engine.controlGeneration())
  const closed = engine.reflectionCancel({ ticket: first.ticket })
  assert.equal(closed.settled, true)
  assert.equal(closed.terminal, 'cancelled')
  assert.deepEqual({ known: closed.usage.known }, { known: false },
    'a gated attempt that was closed without a measurement says so')
  assert.equal(engine.status().reflectionTokensUnknown24h, 1)
  // The same ticket closed twice reports the terminal fact instead of rewriting it.
  const again = engine.reflectionCancel({ ticket: first.ticket })
  assert.equal(again.code, 'reflection_already_settled')
  assert.equal(engine.reflectionCancel({ ticket: 'never-signed' }).code, 'reflection_unknown_ticket')
  advance()
  const second = publish(engine, 'measured-cancel')
  const secondProblem = matureProblem(engine, 'measured-cancel', second.routeId)
  const secondTicket = sign(engine, 'measured-cancel', secondProblem, second, engine.controlGeneration())
  const measured = engine.reflectionCancel({ ticket: secondTicket.ticket,
    usage: { known: true, promptTokens: 4, completionTokens: 6, totalTokens: 10 } })
  assert.deepEqual({ known: measured.usage.known, total: measured.usage.totalTokens },
    { known: true, total: 10 })
})

test('a stop for a session with a live identity or a live ticket is never trimmed away', t => {
  const { engine, document, advance } = fixture(t)
  const stops = () => (document().settlementControl.stops ?? [])
  const held = (sessionHash) => stops().some(row => row.sessionHash === sessionHash)

  // ── (1) a PUBLISHED identity and a mature problem, but NO ticket signed yet ──────────────────
  // A stop for this session must survive tombstone pressure: the identity can still authorise a
  // bounded reflection attempt, so trimming the stop would let the next publication re-open a
  // session the operator stopped.
  const published = publish(engine, 'stop-source-session')
  const problem = matureProblem(engine, 'stop-source-session', published.routeId)
  engine.settlementStop({ sessionId: 'stop-source-session', reason: 'operator' })
  assert.equal(held(published.sessionHash), true, 'the stop is in force')
  for (let index = 0; index < 80; index += 1) {
    engine.settlementStop({ sessionId: `pressure-${index}`, reason: 'pressure' })
  }
  assert.ok(stops().length <= 64, 'the stop table stays bounded')
  assert.equal(held(published.sessionHash), true,
    'a stop naming a session with a LIVE published identity was not trimmed')
  // The stopped session is still blocked at the request gate, which is what that retention protects.
  const refused = engine.reflectionRequest({ sessionId: 'stop-source-session',
    turnId: `problem-recovery:${problem.id}`, taskSummary: SUMMARY_TASK, resultSummary: SUMMARY_RESULT,
    outcome: 'failed', problemId: problem.id, evidenceRevision: problem.evidenceRevision,
    sourceBinding: true, sourceRevision: published.revision,
    sourceBindingHash: published.bindingHash, controlGeneration: engine.controlGeneration() })
  assert.equal(refused.skipped, 'control_source_stopped', JSON.stringify(refused))

  // ── (2) a LIVE TICKET whose source row was RELEASED, then 65 further stops ───────────────────
  // The event IS the attempt: deleting the row it was published against cannot make an unsettled
  // ticket lose its protection.
  const signed = publish(engine, 'stop-ticket-session')
  const signedProblem = matureProblem(engine, 'stop-ticket-session', signed.routeId)
  advance(31 * 60_000)
  const ticket = sign(engine, 'stop-ticket-session', signedProblem, signed, engine.controlGeneration())
  assert.equal(typeof ticket.ticket, 'string', JSON.stringify(ticket))
  engine.settlementStop({ sessionId: 'stop-ticket-session', reason: 'operator' })
  const released = engine.sourceRelease({ sessionId: 'stop-ticket-session',
    expectRevision: signed.revision, expectBindingHash: signed.bindingHash })
  assert.equal(released.released, true)
  assert.equal(engine.sourceStatus({ limit: 64 }).rows
    .some(row => row.sessionHash === signed.sessionHash), false, 'the source row really is gone')
  for (let index = 0; index < 80; index += 1) {
    engine.settlementStop({ sessionId: `late-pressure-${index}`, reason: 'pressure' })
  }
  assert.equal(held(signed.sessionHash), true,
    'the stop survived even though the source row it referenced was released')
  const late = engine.reflectionResult({ ticket: ticket.ticket, result: { instruction: INSTRUCTION } })
  assert.equal(late.code, 'control_source_stopped')
})

test('a measurement that arrives after the commit window is still recorded', t => {
  const { engine, advance } = fixture(t)
  const bound = publish(engine, 'late-usage')
  const problem = matureProblem(engine, 'late-usage', bound.routeId)
  const ticket = sign(engine, 'late-usage', problem, bound, engine.controlGeneration())
  assert.equal(typeof ticket.ticket, 'string')
  // The result comes back after the ticket's own window closed: the COMMIT is refused (late answers
  // never create candidates) while the cost the call really incurred is still recorded.
  advance(31 * 60_000)
  const late = engine.reflectionResult({ ticket: ticket.ticket, result: { instruction: INSTRUCTION },
    usage: { known: true, promptTokens: 600, completionTokens: 0, totalTokens: 600 } })
  assert.equal(late.code, 'reflection_expired')
  assert.equal(late.settled, false, 'an expired ticket was never committed')
  const spend = engine.store.read().spends.find(row => row.ticket === ticket.ticket)
  assert.deepEqual({ known: spend.usage.known, total: spend.usage.totalTokens },
    { known: true, total: 600 }, 'the cost of the paid call survives the expiry')
  assert.equal(engine.status().reflectionTokensLast24h, 600)
  assert.equal(engine.status().reflectionsLast24h, 1, 'the attempt is still counted as ONE attempt')
  assert.equal(engine.store.read().lessons.filter(row => row.kind === 'method').length, 0,
    'an expired answer never produces a candidate')
})

test('a measurement that arrives after a cancellation upgrades the unknown record once', t => {
  const { engine, advance } = fixture(t)
  const bound = publish(engine, 'cancel-then-usage')
  const problem = matureProblem(engine, 'cancel-then-usage', bound.routeId)
  const ticket = sign(engine, 'cancel-then-usage', problem, bound, engine.controlGeneration())
  const cancelled = engine.reflectionCancel({ ticket: ticket.ticket })
  assert.equal(cancelled.settled, true)
  assert.deepEqual({ known: cancelled.usage.known }, { known: false },
    'the cancelled attempt starts as an honest unknown, never as zero')
  assert.equal(engine.status().reflectionTokensUnknown24h, 1)
  // The provider layer then reports what the call really cost. The attempt is over, so this can only
  // ever MERGE into the same record.
  const recorded = engine.reflectionResult({ ticket: ticket.ticket, result: { instruction: INSTRUCTION },
    usage: { known: true, promptTokens: 600, completionTokens: 0, totalTokens: 600 } })
  assert.equal(recorded.code, 'reflection_already_settled')
  assert.equal(recorded.usageMerged, true)
  assert.deepEqual({ known: recorded.usage.known, total: recorded.usage.totalTokens },
    { known: true, total: 600 }, 'the known measurement replaced the unknown one')
  assert.equal(engine.status().reflectionTokensLast24h, 600)
  assert.equal(engine.status().reflectionTokensUnknown24h, 0)
  assert.equal(engine.status().reflectionsLast24h, 1, 'still exactly one attempt')
  assert.equal(engine.store.read().lessons.filter(row => row.kind === 'method').length, 0,
    'a settled attempt never mints a candidate afterwards')
  // A REPEATED report cannot charge twice or rewrite the cost.
  const again = engine.reflectionResult({ ticket: ticket.ticket, result: { instruction: INSTRUCTION },
    usage: { known: true, promptTokens: 999, completionTokens: 0, totalTokens: 999 } })
  assert.equal(again.usageMerged, false, 'a second measurement for one attempt is ignored')
  assert.equal(engine.status().reflectionTokensLast24h, 600, 'the cost is charged exactly once')
  // And the same merge works through the cancel entry point.
  const second = publish(engine, 'cancel-then-usage-2')
  const secondProblem = matureProblem(engine, 'cancel-then-usage-2', second.routeId)
  advance(31 * 60_000)
  const secondTicket = sign(engine, 'cancel-then-usage-2', secondProblem, second, engine.controlGeneration())
  engine.reflectionCancel({ ticket: secondTicket.ticket })
  const merged = engine.reflectionCancel({ ticket: secondTicket.ticket,
    usage: { known: true, promptTokens: 4, completionTokens: 0, totalTokens: 4 } })
  assert.equal(merged.code, 'reflection_already_settled')
  assert.equal(merged.usageMerged, true)
  assert.equal(merged.usage.totalTokens, 4)
})

test('a stale publisher cannot put an old endpoint back after a release and rebind', t => {
  const { engine } = fixture(t)
  const first = publish(engine, 'cas-session')
  assert.equal(first.revision, 1)
  const stale = { revision: first.revision, epoch: first.epoch, routeId: first.routeId }
  // The host releases the row and publishes a DIFFERENT endpoint for the same session. The revision
  // restarts at 1 — which is exactly why the revision alone cannot be the precondition.
  engine.sourceRelease({ sessionId: 'cas-session', expectRevision: first.revision,
    expectBindingHash: first.bindingHash })
  const second = publish(engine, 'cas-session', { baseUrl: 'https://relay.invalid/new-endpoint/v1' })
  assert.equal(second.revision, 1, 'the revision really is reusable')
  assert.ok(second.epoch > first.epoch, 'the epoch is not')
  assert.notEqual(second.routeId, first.routeId)
  // The stale writer now tries to put the OLD endpoint back with the precondition it read. Both
  // halves are checked, and the EPOCH is the one that catches this: the revision precondition passes
  // (both are 1) and only the non-reusable epoch shows the caller read a different incarnation.
  const rejected = publish(engine, 'cas-session', { expectRevision: stale.revision,
    expectEpoch: stale.epoch, baseUrl: CANARY })
  assert.equal(rejected.published, false)
  assert.equal(rejected.code, 'source_stale_epoch')
  const atRejection = engine.sourceStatus({ limit: 8 }).rows[0]
  assert.equal(atRejection.routeId, second.routeId, 'the newer endpoint survived the stale write')
  assert.equal(atRejection.epoch, second.epoch)
  assert.equal(atRejection.revision, second.revision)
  assert.equal(JSON.stringify(engine.sourceStatus()).includes('relay.invalid'), false,
    'the status view still carries no endpoint in the clear')
  // A writer that names the CURRENT epoch is accepted, so the check is precise rather than blanket.
  const current = publish(engine, 'cas-session', { expectRevision: second.revision,
    expectEpoch: second.epoch, baseUrl: 'https://relay.invalid/third-endpoint/v1' })
  assert.equal(current.published, true)
  assert.equal(current.revision, 2)
  assert.ok(current.epoch > second.epoch)
  // ── positive control: after a release the row is ABSENT, and a stale write is refused too ────
  engine.sourceRelease({ sessionId: 'cas-session', expectRevision: current.revision,
    expectBindingHash: current.bindingHash })
  const absent = publish(engine, 'cas-session', { expectRevision: current.revision,
    expectEpoch: current.epoch, baseUrl: CANARY })
  assert.equal(absent.published, false, 'a precondition against an absent row is not a licence')
  assert.equal(absent.code, 'source_stale_revision',
    'an absent row is read as revision 0, so any precondition about a row that existed is refused')
  assert.equal(engine.sourceStatus({ limit: 8 }).total, 0)
  // ...and a publisher that states NO precondition still works, which is the first-publication path.
  const fresh = publish(engine, 'cas-session')
  assert.equal(fresh.published, true)
  assert.equal(fresh.revision, 1)
})
