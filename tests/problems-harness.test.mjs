import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningEngine, reflect } from '../src/index.mjs'
import { createHarnessBridge, mseMessageSource } from '../adapters/harness.mjs'

/**
 * Phase-1 host wiring regression: close() persists verifiable failures into the problem ledger
 * (before settlement, cancelled turns excluded), synthesises a bounded reflection summary when
 * the assistant produced none, and hands the ready problem identity to the review callback.
 */

function fixture(t, options = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-harness-problem-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh' })
  let id = 0
  const bridge = createHarnessBridge({
    engine,
    createMessage: text => ({ id: `plugin-${++id}`, role: 'user',
      source: mseMessageSource('instructions'), content: [{ type: 'text', text }] }), ...options })
  bridge.setTrustedGuard(() => true)
  const session = { id: 'session', header: {}, events: [] }
  const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '请导出金额并进行排序' }] }
  const payload = { agent: { session }, step: 1, turn: 1, messages: [message], signal: new AbortController().signal }
  const next = async () => ({ kind: 'enter', messages: [message] })
  const request = async (messages) => {
    for await (const chunk of bridge.stream({ sessionId: session.id, messages }, async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })) assert.equal(chunk.type, 'finish')
  }
  const end = (reason = 'completed') => bridge.sessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: reason } } })
  return { engine, bridge, payload, next, session, request, end }
}
const settled = () => new Promise(resolve => setImmediate(resolve))

test('phase1 harness: failed tools persist as problems, missing assistant summary is synthesised, ready problem reaches review', async t => {
  const reviews = []
  const { engine, bridge, payload, next, end } = fixture(t, {
    review: (input, route, signal) => { reviews.push(input); return Promise.resolve({ ok: true }) } })
  await bridge.preStep(payload, next)
  // Two independent host-verified failures of the same class: one problem, evidenceRevision 2 → ready.
  bridge.toolResult({ sessionId: 'session', turnId: 1, failed: true,
    failureCode: 'tool_nonzero_exit', eventId: 'call-1', toolName: 'bash' })
  bridge.toolResult({ sessionId: 'session', turnId: 1, failed: true,
    failureCode: 'tool_nonzero_exit', eventId: 'call-2', toolName: 'bash' })
  // No assistant/message event: the host must synthesize the reflection summary from failures.
  end('error')
  await settled()
  const state = engine.store.read()
  const problems = state.problemLoop?.problems.filter(p => p.kind === 'tool_failure') ?? []
  assert.equal(problems.length, 1, 'one problem keyed by tool+class')
  assert.equal(problems[0].evidenceRevision, 2)
  assert.equal(problems[0].state, 'eligible')
  assert.equal(reviews.length, 1, 'review must run on host-verified failures without an assistant summary')
  const input = reviews[0]
  assert.ok(input.resultSummary.includes(`2 条工具失败`), 'synthesised summary carries failure facts')
  assert.ok(input.resultSummary.includes('tool_nonzero_exit'))
  assert.equal(input.problemId, problems[0].id, 'ready problem id handed to review')
  assert.equal(input.evidenceRevision, 2)
  assert.equal(input.outcome, 'failed')
})

test('phase1 harness: cancelled turns never persist problems and never reach review', async t => {
  const reviews = []
  const { engine, bridge, payload, next, session, end } = fixture(t, {
    review: (input, route, signal) => { reviews.push(input); return Promise.resolve({ ok: true }) } })
  await bridge.preStep(payload, next)
  bridge.toolResult({ sessionId: session.id, turnId: 1, failed: true, cancelled: true,
    failureCode: 'cancelled', eventId: 'call-9', toolName: 'bash' })
  end('cancelled')
  await settled()
  const state = engine.store.read()
  assert.equal((state.problemLoop?.problems ?? []).length, 0, 'availability facts must not become problems')
  assert.equal(reviews.length, 0, 'cancelled turn must not reflect')
})

test('phase1 harness: a failed verifier check persists as checker_failure with a stable event id', async t => {
  const reviews = []
  const { engine, bridge, payload, next, session, request, end } = fixture(t, {
    review: (input, route, signal) => { reviews.push(input); return Promise.resolve({ ok: true }) } })
  const lesson = engine.record({ eventId: 'correction', source: 'direct_user', kind: 'correction',
    instruction: '以后导出金额前先转换为数值，再按金额排序' })
  const decision = await bridge.preStep(payload, next)
  await request(decision.messages)
  assert.equal(engine.status().adopted, 1)
  assert.equal(bridge.verification({ sessionId: session.id, turnId: 1, checkId: 'amount-check',
    passed: false, lessonIds: [lesson.id] }), true)
  end('completed')
  await settled()
  const state = engine.store.read()
  const checker = (state.problemLoop?.problems ?? []).filter(p => p.kind === 'checker_failure')
  assert.equal(checker.length, 1)
  assert.equal(checker[0].toolName, null)
})
// ---------------------------------------------------------------- rev4 regressions

test('rev4: single or duplicated failure evidence never reflects through the generic path', async t => {
  // One tool failure observed (or the same call id replayed): the problem is NOT ready, so no
  // reflection may run — not even through the assistant-summary channel — and no candidate or
  // spend may appear (audit matrix rev4 #1).
  for (const variant of ['single', 'duplicate']) {
    const reviews = []
    const { engine, bridge, payload, next, session, end } = fixture(t, {
      review: input => { reviews.push(input); return Promise.resolve({ ok: true }) } })
    await bridge.preStep(payload, next)
    if (variant === 'single') {
      bridge.toolResult({ sessionId: session.id, turnId: 1, failed: true, eventId: 'call-1',
        toolName: 'bash', failureCode: 'tool_nonzero_exit' })
    } else {
      bridge.toolResult({ sessionId: session.id, turnId: 1, failed: true, eventId: 'call-1',
        toolName: 'bash', failureCode: 'tool_nonzero_exit' })
      bridge.toolResult({ sessionId: session.id, turnId: 1, failed: true, eventId: 'call-1',
        toolName: 'bash', failureCode: 'tool_nonzero_exit' })
    }
    bridge.sessionEvent(session, { type: 'assistant/message', data: { turn: 1, content: '金额被当作字符串排序，需要复查数据类型' } })
    end('error')
    await settled()
    const state = engine.store.read()
    const problems = state.problemLoop?.problems ?? []
    assert.equal(reviews.length, 0, `${variant}: no reflection before independent evidence`)
    assert.equal(problems.length, 1, `${variant}: the failure fact is recorded`)
    assert.equal(problems[0].count, 1, `${variant}: replay must not inflate the count`)
    assert.equal(problems[0].state, 'observed', `${variant}: below threshold stays observed`)
    assert.equal(state.lessons.length, 0, `${variant}: no candidate may be minted`)
    assert.equal((state.spends ?? []).length, 0, `${variant}: no reflection spend`)
  }
})

test('rev4: the ready problem wins when a later unready tool also failed', async t => {
  // bash fails twice (ready) and read fails once (not ready): the review must bind the bash
  // problem tuple, never the unready read one (audit matrix rev4 #2).
  const reviews = []
  const { engine, bridge, payload, next, session, end } = fixture(t, {
    review: withReflect })
  await bridge.preStep(payload, next)
  bridge.toolResult({ sessionId: session.id, turnId: 1, failed: true, eventId: 'call-1', toolName: 'bash',
    failureCode: 'tool_nonzero_exit' })
  bridge.toolResult({ sessionId: session.id, turnId: 1, failed: true, eventId: 'call-2', toolName: 'bash',
    failureCode: 'tool_nonzero_exit' })
  bridge.toolResult({ sessionId: session.id, turnId: 1, failed: true, eventId: 'call-3', toolName: 'read',
    failureCode: 'tool_nonzero_exit' })
  end('error')
  await settled()
  const state = engine.store.read()
  const bash = state.problemLoop.problems.find(p => p.toolName === 'bash')
  const read = state.problemLoop.problems.find(p => p.toolName === 'read')
  assert.ok(bash && read, 'both problems recorded')
  assert.equal(bash.state, 'candidate_created')
  assert.equal(read.state, 'observed')
  assert.equal(reviews.length, 1, 'exactly one review on the ready problem')
  assert.equal(reviews[0].problemId, bash.id, 'review binds the really-ready bash problem')
  assert.equal(reviews[0].evidenceRevision, 2)
  assert.equal(state.lessons.length, 1, 'paid result lands as a candidate linked to bash')
  const linked = state.lessons.find(l => l.id === bash.lessonId)
  assert.ok(linked, 'candidate linked to the ready problem')
  // A REAL paid reflection: the review drives the same runner the host uses, so the candidate is
  // written in the SAME transaction that settles the ticket (rev6 probe pattern). Returning a bare
  // `{ok:false}` would look like reflection_unavailable and would never land a lesson.
  function withReflect(input, route, signal) {
    reviews.push(input)
    return reflect(engine, input,
      async () => JSON.stringify({ instruction: '导出金额排序前先统一转换为数值类型，再按数值比较' }), signal)
  }
})

test('rev4: provider unavailability and generic host errors are diagnostics, never task_failure evidence', async t => {
  // Official host error contract: an unknown Error, an LlmError with TIMEOUT / AUTH codes, and a
  // trailing turn/end 'error' carry NO trusted tool-result structure. They void success credit but
  // must not be rewritten into a task failure (rev4 #3 + native classification contract): zero
  // problems, zero candidates, zero paid reflections.
  for (const label of ['provider_unavailable', 'generic-error', 'turn-end-error']) {
    const reviews = []
    const { engine, bridge, payload, next, session, end } = fixture(t, {
      review: input => { reviews.push(input); return Promise.resolve({ ok: true }) } })
    await bridge.preStep(payload, next)
    if (label === 'provider_unavailable') {
      bridge.toolResult({ sessionId: session.id, turnId: 1, failed: true, failureCode: 'provider_unavailable',
        eventId: 'provider-1' })
    } else if (label === 'generic-error') {
      bridge.toolResult({ sessionId: session.id, turnId: 1, failed: false, diagnostic: true })
    } else {
      end('error')
      await settled()
      const state = engine.store.read()
      assert.equal(reviews.length, 0, 'turn-end error: no reflection')
      assert.equal((state.problemLoop?.problems ?? []).length, 0, 'turn-end error: no problem')
      assert.equal(state.lessons.length, 0)
      assert.equal((state.spends ?? []).length, 0)
      continue
    }
    bridge.sessionEvent(session, { type: 'assistant/message', data: { turn: 1, content: '供应商/宿主侧出错，本轮任务没有完成' } })
    end('error')
    await settled()
    const state = engine.store.read()
    assert.equal(reviews.length, 0, `${label}: diagnostic never reflects`)
    assert.equal((state.problemLoop?.problems ?? []).length, 0, `${label}: no problem minted`)
    assert.equal(state.lessons.length, 0, `${label}: no candidate`)
    assert.equal((state.spends ?? []).length, 0, `${label}: no paid reflection`)
  }
})

test('rev4: two independent failures with no assistant summary synthesize and bind the ready problem', async t => {
  const reviews = []
  const { engine, bridge, payload, next, session, end } = fixture(t, {
    review: input => { reviews.push(input); return Promise.resolve({ ok: false, code: 'synthetic' }) } })
  await bridge.preStep(payload, next)
  bridge.toolResult({ sessionId: session.id, turnId: 1, failed: true, eventId: 'call-1', toolName: 'bash',
    failureCode: 'tool_nonzero_exit' })
  bridge.toolResult({ sessionId: session.id, turnId: 1, failed: true, eventId: 'call-2', toolName: 'bash',
    failureCode: 'tool_nonzero_exit' })
  end('error')
  await settled()
  const state = engine.store.read()
  const problem = state.problemLoop.problems[0]
  assert.equal(reviews.length, 1)
  assert.ok(reviews[0].resultSummary.includes('2 条工具失败'), 'synthesised from the failure roster')
  assert.equal(reviews[0].problemId, problem.id)
  assert.equal(reviews[0].evidenceRevision, 2)
  assert.equal(problem.state, 'eligible')
})

test('DSH agent/error maps every generic host error to a diagnostic, never to method evidence', () => {
  // The native classification contract: agent/error carries no guaranteed code shape (an unknown
  // Error or official LlmError codes like AUTH/QUOTA/SERVER/TRANSPORT/TIMEOUT). The adapter must
  // route it through the diagnostic channel without enumerating code strings, and the harness
  // must not rewrite a later turn/end 'error' into a task failure.
  const source = readFileSync(new URL('../adapters/dsh/index.mjs', import.meta.url), 'utf8')
  const marker = `ctx.on('agent/error', payload => {\n    // A generic agent/model error is a DIAGNOSTIC`
  assert.ok(source.includes(marker), 'agent/error is wired as a diagnostic')
  assert.ok(!/code\.includes\(/u.test(source.slice(source.indexOf(marker), source.indexOf('sync()', source.indexOf(marker)))),
    'no fragile code-string enumeration drives the classification')
  const harness = readFileSync(new URL('../adapters/harness.mjs', import.meta.url), 'utf8')
  assert.ok(harness.includes("if (!state.taskFailed && state.failures.length === 0) state.diagnosticError = true"),
    'a trailing turn/end error without tool evidence stays a diagnostic')
})
