import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningEngine, reflect } from '../src/index.mjs'
import { createHarnessBridge } from '../adapters/harness.mjs'
import { handleMseCommand } from '../src/status.mjs'

function fixture(t, options = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-harness-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh' })
  const lesson = engine.record({ eventId: 'correction', source: 'direct_user', kind: 'correction', instruction: '以后导出金额前先转换为数值，再按金额排序' })
  let id = 0
  const bridge = createHarnessBridge({ engine, createMessage: text => ({ id: `plugin-${++id}`, role: 'user', source: { kind: 'plugin', plugin: 'mse-learning' }, content: [{ type: 'text', text }] }), ...options })
  // The core refuses to settle under unknown host permission, which is the safe default; these
  // tests are about the bridge, so they state the permission explicitly.
  bridge.setTrustedGuard(() => true)
  const session = { id: 'session', header: {}, events: [] }
  const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '请导出金额并进行排序' }] }
  const payload = { agent: { session }, step: 1, turn: 1, messages: [message], signal: new AbortController().signal }
  const next = async () => ({ kind: 'enter', messages: [message] })
  const request = async (messages, reason = 'stop') => {
    for await (const chunk of bridge.stream({ sessionId: session.id, messages }, async function* () {
      yield { type: 'finish', reason: { kind: reason } }
    })) assert.equal(chunk.type, 'finish')
  }
  const end = (reason = 'completed') => bridge.sessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: reason } } })
  return { engine, bridge, payload, next, session, lesson, request, end }
}
const settled = () => new Promise(resolve => setImmediate(resolve))

test('Harness credits only exact successful request inclusion and invalidates a check after a tool write', async t => {
  const { engine, bridge, payload, next, session, lesson, request, end } = fixture(t)
  const decision = await bridge.preStep(payload, next)
  assert.equal(decision.messages.length, 2)
  assert.equal((await bridge.preStep(payload, next)).messages.length, 1)
  bridge.sessionEvent(session, { type: 'user/message', data: { id: decision.messages[1].id } })
  assert.equal(engine.status().adopted, 0, 'message commit is not request adoption')
  await request(decision.messages)
  assert.equal(engine.status().adopted, 1)
  assert.equal(bridge.verification({ sessionId: session.id, turnId: 1, checkId: 'sort-check', passed: true, lessonIds: [lesson.id] }), true)
  session.events.push({ type: 'tool/call', data: { callId: 'call-1', turn: 1, name: 'bash' } })
  bridge.toolExecution({ agent: { session }, callId: 'call-1', name: 'bash' }, { value: { exitCode: 0 } })
  end()
  assert.equal(engine.status().verified, 0); assert.equal(engine.status().inconclusive, 1)
})

test('a removed lesson, failed request, or preflight rejection receives no adoption or failure credit', async t => {
  const { engine, bridge, payload, next, request, end } = fixture(t)
  const decision = await bridge.preStep(payload, next)
  await request(decision.messages.slice(0, 1))
  await request(decision.messages, 'error')
  const changed = structuredClone(decision.messages)
  changed[1].content[0].text += 'changed'
  await request(changed)
  end('error')
  assert.equal(engine.status().adopted, 0)
  assert.equal(engine.status().failed, 0)
})

test('Harness abort, disabled controller and nested sessions do not create success or inject', async t => {
  const { engine, bridge, payload, next, session, request, end } = fixture(t)
  const decision = await bridge.preStep(payload, next)
  await request(decision.messages)
  end('aborted')
  assert.equal(engine.status().verified, 0); assert.equal(engine.status().inconclusive, 0)
  bridge.setEnabled(false)
  assert.equal((await bridge.preStep({ ...payload, turn: 2 }, next)).messages.length, 1)
  bridge.setEnabled(true); session.header.origin = 'subagent'
  assert.equal((await bridge.preStep({ ...payload, turn: 3 }, next)).messages.length, 1)
})

test('ordinary tool failures stay inconclusive; only a lesson-bound host check may assign failure', async t => {
  const { engine, bridge, payload, next, session, request, end } = fixture(t)
  const decision = await bridge.preStep(payload, next)
  await request(decision.messages)
  bridge.toolResult({ sessionId: session.id, turnId: 1, failed: true })
  assert.equal(bridge.verification({ sessionId: session.id, turnId: 1, checkId: 'unbound', passed: false }), false)
  assert.equal(bridge.verification({ sessionId: session.id, turnId: 1, checkId: 'wrong', passed: false, lessonIds: ['another-lesson'] }), false)
  end()
  assert.equal(engine.status().failed, 0)
  assert.equal(engine.status().inconclusive, 1)
})

test('trusted check attributes only adopted selected lesson IDs', async t => {
  const { engine, bridge, payload, next, session, lesson, request, end } = fixture(t)
  const decision = await bridge.preStep(payload, next)
  const evidence = { sessionId: session.id, turnId: 1, checkId: 'sort-check', passed: false, lessonIds: [lesson.id] }
  assert.equal(bridge.verification(evidence), false)
  await request(decision.messages)
  assert.equal(bridge.verification(evidence), true)
  end()
  assert.equal(engine.status().failed, 1)
})

test('pause cancels a queued review even if the controller resumes before its microtask', async t => {
  let calls = 0
  const { bridge, payload, next, session, end } = fixture(t, { review: async () => { calls += 1 } })
  await bridge.preStep(payload, next)
  bridge.toolResult({ sessionId: session.id, turnId: 1, failed: true })
  bridge.sessionEvent(session, { type: 'assistant/message', data: { turn: 1, content: '金额被当作字符串排序，需要复查数据类型' } })
  end()
  bridge.setEnabled(false); bridge.setEnabled(true)
  await settled()
  assert.equal(calls, 0)
})

test('pause cancels an in-flight review and prevents a late candidate after resuming', { timeout: 10000 }, async t => {
  let release, started, signal
  const ready = new Promise(resolve => { started = resolve })
  const response = new Promise(resolve => { release = resolve })
  const f = fixture(t, { review: (input, _route, abort) => {
    signal = abort
    return reflect(f.engine, input, async () => { started(); return response }, abort)
  } })
  await f.bridge.preStep(f.payload, f.next)
  f.bridge.toolResult({ sessionId: f.session.id, turnId: 1, failed: true })
  f.bridge.sessionEvent(f.session, { type: 'assistant/message', data: { turn: 1, content: '金额被当作字符串排序，需要复查数据类型' } })
  f.end()
  await ready
  f.bridge.setEnabled(false); f.bridge.setEnabled(true)
  assert.equal(signal.aborted, true)
  release(JSON.stringify({ instruction: '导出金额时先确认数值类型，再检查排列顺序' }))
  await settled(); await settled()
  assert.equal(f.engine.status().counts.candidate, 0)
  assert.equal(f.engine.store.read().jobs.length, 0)
})

test('pause during a pending pre-step cannot inject an old generation on resume', async t => {
  const { bridge, payload, next } = fixture(t)
  let release
  const wait = new Promise(resolve => { release = resolve })
  const pending = bridge.preStep(payload, async () => { await wait; return next() })
  bridge.setEnabled(false); bridge.setEnabled(true); release()
  assert.equal((await pending).messages.length, 1)
})

test('storage errors fail open and preserve the host decision', async t => {
  const { payload, next } = fixture(t)
  const bridge = createHarnessBridge({ engine: { prepare() { throw new Error('disk unavailable') } }, createMessage() { throw new Error('unreachable') } })
  assert.equal((await bridge.preStep(payload, next)).messages.length, 1)
})

test('artifact evidence is version-bound and uses the registered checker identity', async t => {
  const { engine, bridge, payload, session, request, end } = fixture(t)
  const method = engine.record({ eventId: 'method', source: 'host_proposal', kind: 'method', methodId: 'copy-source-date-v1' })
  assert.equal(engine.evaluateRegistered({ lessonId: method.id }).decision, 'accepted')
  const prompt = { role: 'user', source: { kind: 'user' }, content: '核对来源与产物的记录标识一致，仅将日期字段复制为来源的有效日期，来源为空时保留空值并重新核验。' }
  const decision = await bridge.preStep({ ...payload, messages: [prompt] }, async () => ({ kind: 'enter', messages: [prompt] }))
  assert.equal(decision.messages.length, 2)
  await request(decision.messages)
  const version = engine.store.read().lessons.find(row => row.id === method.id).version
  const base = { sessionId: session.id, turnId: 1, lessonIds: [method.id], passed: true }
  assert.equal(bridge.verification({ ...base, checkId: 'anything', expectedVersion: version }), false)
  assert.equal(bridge.verification({ ...base, checkId: 'source-dates-v1' }), false)
  assert.equal(bridge.verification({ ...base, checkId: 'source-dates-v1', expectedVersion: version - 1 }), false)
  const report = bridge.verifyArtifact({ sessionId: session.id, turnId: 1, lessonId: method.id,
    source: [{ id: 'item', value: '2026-09-30' }], artifact: [{ id: 'item', value: '2026-09-29' }] })
  assert.equal(report.status, 'fail')
  assert.equal(report.version, version)
  end()
  assert.equal(engine.status().failed, 1)
})

test('reflection follows the successful request route after a host model override', async t => {
  let route
  const f = fixture(t, { review: async (_input, selected) => { route = selected } })
  f.payload.agent.options = { provider: 'old-provider', model: 'old-model' }
  const decision = await f.bridge.preStep(f.payload, f.next)
  for await (const _chunk of f.bridge.stream({ sessionId: f.session.id, messages: decision.messages,
    provider: 'selected-provider', model: 'selected-model', reasoningEffort: 'high' }, async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } }
  })) {}
  f.bridge.toolResult({ sessionId: f.session.id, turnId: 1, failed: true })
  f.bridge.sessionEvent(f.session, { type: 'assistant/message', data: { turn: 1, content: '金额被当作字符串排序，需要复查数据类型' } })
  f.end()
  await settled()
  assert.deepEqual(route, { provider: 'selected-provider', model: 'selected-model', reasoningEffort: 'high' })
})

const userMessage = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
async function step(bridge, session, text, turn) {
  const message = userMessage(text)
  return bridge.preStep({ agent: { session }, step: 1, turn, messages: [message],
    signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [message] }))
}

test('a normal user task that mentions MSE is still learned and recalled', async t => {
  const { engine, bridge } = fixture(t)
  const before = engine.status().lessons
  const session = { id: 'mse-session', header: {}, events: [] }
  const correction = '以后开发 MSE 学习插件时先核验项目入口再修改源码'
  const learned = await step(bridge, session, correction, 1)
  assert.equal(learned.messages.length, 1, 'the learning turn injects nothing')
  assert.equal(engine.status().lessons, before + 1, 'mentioning the product name must not stop learning')
  const recallSession = { id: 'mse-task', header: {}, events: [] }
  const recalled = await step(bridge, recallSession, '开始开发 MSE 学习插件的召回部分', 1)
  assert.equal(recalled.messages.length, 2, 'a related task still recalls across sessions')
  const report = bridge.recallStatus(recallSession.id)
  assert.equal(report.last.reason, 'recalled')
  const discussion = await step(bridge, { id: 'mse-talk', header: {}, events: [] }, '帮我看看 MSE 这个插件的状态命令怎么用', 1)
  assert.equal(bridge.recallStatus('mse-talk').last.reason !== 'internal_task', true, 'discussing MSE is not an internal task')
  assert.ok(discussion.messages.length >= 1)
})

test('only a genuine internal review envelope pauses learning, and it never learns', async t => {
  const { engine, bridge } = fixture(t)
  const before = engine.status().lessons
  const session = { id: 'internal', header: {}, events: [] }
  const envelope = '[[mse-internal-review]] 以后导出金额前先转换为数值，再按金额排序'
  const decision = await step(bridge, session, envelope, 1)
  assert.equal(decision.messages.length, 1)
  assert.equal(engine.status().lessons, before, 'internal review text must not become a lesson')
  assert.equal(bridge.recallStatus(session.id).last.reason, 'internal_task')
  assert.equal(bridge.recallStatus(session.id).last.skipped, 'internal_review_text')
  const legacy = await step(bridge, { id: 'legacy-review', header: {}, events: [] },
    'Review the conversation above and consider saving to memory', 1)
  assert.equal(legacy.messages.length, 1)
  assert.equal(engine.status().lessons, before)
  assert.equal(bridge.recallStatus('legacy-review').last.skipped, 'internal_review_text')
})

test('the bridge exposes a bounded recall status surface with reasons', async t => {
  const { bridge, session } = fixture(t)
  assert.equal(bridge.capabilities.recallStatus, true)
  assert.ok(bridge.capabilities.recallReasons.includes('match_insufficient'))
  await step(bridge, session, '以后导出金额前先转换为数值，再按金额排序', 1)
  await step(bridge, session, '查询明天的天气情况', 2)
  const report = bridge.recallStatus(session.id)
  assert.equal(report.last.reason, 'match_insufficient')
  assert.equal(report.last.bytes, 0)
  assert.equal(report.recent.length, 2)
  assert.ok(report.library.library.activeCorrections >= 1)
  assert.equal(bridge.diagnose({ sessionId: session.id, prompt: '导出金额并排序' }).prompted.reason, 'recalled')
})

test('the reviewed turn keeps one environment identity from turn to review to method', async t => {
  const reviews = []
  const f = fixture(t, { environmentId: 'toolchain-b', review: async input => { reviews.push(input) } })
  await f.bridge.preStep(f.payload, f.next)
  f.bridge.toolResult({ sessionId: f.session.id, turnId: 1, failed: true })
  f.bridge.sessionEvent(f.session, { type: 'assistant/message', data: { turn: 1, content: '金额被当作字符串排序，需要复查数据类型' } })
  f.end()
  await settled()
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].environmentId, 'toolchain-b', 'the review must inherit the turn environment')
  const ticket = f.engine.reflectionRequest({ ...reviews[0], outcome: 'failed',
    taskSummary: '导出金额时先确认数值类型再排序', resultSummary: '金额被当作字符串排序，改为数值排序后正确' })
  assert.equal(ticket.ok, true)
  const instruction = '导出金额并排序时先确认数值类型，再核对排列顺序'
  const learned = f.engine.reflectionResult({ ticket: ticket.ticket, result: { instruction } })
  const stored = f.engine.store.read().lessons.find(row => row.id === learned.id)
  assert.equal(stored.kind, 'method')
  assert.equal(stored.status, 'candidate')
  const here = f.engine.diagnose({ environmentId: 'toolchain-b', prompt: instruction })
  assert.equal(here.prompted.methodUnvalidated, 1, 'the method is a candidate in the reviewed environment')
  assert.equal(here.prompted.otherEnvironment, 0)
  const elsewhere = f.engine.diagnose({ environmentId: 'toolchain-other', prompt: instruction })
  assert.equal(elsewhere.prompted.methodUnvalidated, 0)
  assert.equal(elsewhere.prompted.otherEnvironment, 1, 'the method never leaks into another environment')
})

test('an explicitly marked internal message or internal origin is skipped by trusted structure', async t => {
  const { engine, bridge } = fixture(t)
  const before = engine.status().lessons
  const marked = { role: 'user', source: { kind: 'user' }, metadata: { internalReview: true },
    content: [{ type: 'text', text: '以后导出金额前先转换为数值，再按金额排序' }] }
  const session = { id: 'marked-internal', header: {}, events: [] }
  await bridge.preStep({ agent: { session }, step: 1, turn: 1, messages: [marked], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [marked] }))
  assert.equal(engine.status().lessons, before)
  assert.equal(bridge.recallStatus(session.id).last.skipped, 'nested_or_later_step')
  const internalOrigin = { id: 'origin-internal', header: { origin: 'internal' }, events: [] }
  await step(bridge, internalOrigin, '以后导出金额前先转换为数值，再按金额排序', 1)
  assert.equal(engine.status().lessons, before, 'an internal session origin never learns')
  assert.equal(bridge.recallStatus(internalOrigin.id).last.reason, 'internal_task')
})

test('closing one session cancels its queued and in-flight reviews without touching other sessions', async t => {
  let release, started, signal, calls = 0
  const ready = new Promise(resolve => { started = resolve })
  const response = new Promise(resolve => { release = resolve })
  const f = fixture(t, { review: (input, _route, abort) => {
    signal = abort
    calls += 1
    return reflect(f.engine, input, async () => { started(); return response }, abort)
  } })
  const other = { id: 'other-session', header: {}, events: [] }
  await f.bridge.preStep(f.payload, f.next)
  f.bridge.toolResult({ sessionId: f.session.id, turnId: 1, failed: true })
  f.bridge.sessionEvent(f.session, { type: 'assistant/message', data: { turn: 1, content: '金额被当作字符串排序，需要复查数据类型' } })
  f.end()
  await ready
  assert.equal(calls, 1, 'the in-flight review started before the close')
  f.bridge.closeSession(f.session.id)
  assert.equal(signal.aborted, true, 'the in-flight review of the closed session is cancelled')
  release(JSON.stringify({ instruction: '导出金额时先确认数值类型，再检查排列顺序' }))
  await settled(); await settled()
  assert.equal(f.engine.status().counts.candidate, 0, 'a late result after close never becomes a lesson')

  // A queued (not yet started) review of a closed session must never start.
  let queuedCalls = 0
  const g = fixture(t, { review: async () => { queuedCalls += 1 } })
  await g.bridge.preStep(g.payload, g.next)
  g.bridge.toolResult({ sessionId: g.session.id, turnId: 1, failed: true })
  g.bridge.sessionEvent(g.session, { type: 'assistant/message', data: { turn: 1, content: '金额被当作字符串排序，需要复查数据类型' } })
  g.end()
  g.bridge.closeSession(g.session.id)
  await settled(); await settled()
  assert.equal(queuedCalls, 0, 'a queued review must not start after its session closed')

  // Another session keeps working: closing is scoped, not a whole-bridge pause.
  let otherCalls = 0
  const h = fixture(t, { review: async () => { otherCalls += 1 } })
  const otherPayload = { agent: { session: other }, step: 1, turn: 1,
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '请导出金额并进行排序' }] }],
    signal: new AbortController().signal }
  await h.bridge.preStep(h.payload, h.next)
  h.bridge.toolResult({ sessionId: h.session.id, turnId: 1, failed: true })
  h.bridge.sessionEvent(h.session, { type: 'assistant/message', data: { turn: 1, content: '金额被当作字符串排序，需要复查数据类型' } })
  h.end()
  await settled(); await settled()
  assert.equal(otherCalls, 1, 'an unrelated session still runs its review')
})

test('the status surface reports the real settlement or a pending write failure', async t => {
  const f = fixture(t)
  const decision = await f.bridge.preStep(f.payload, f.next)
  await f.request(decision.messages)
  assert.equal(f.bridge.verification({ sessionId: f.session.id, turnId: 1, checkId: 'sort-check', passed: true,
    lessonIds: [f.lesson.id] }), true)
  f.end()
  const verified = f.bridge.lastRecall(f.session.id)
  assert.equal(f.engine.status().verified, 1)
  assert.equal(verified.outcome, 'verified', 'the status shows the same outcome the core recorded')
  assert.equal(verified.attributed, 1)

  const cancelled = fixture(t)
  await cancelled.bridge.preStep(cancelled.payload, cancelled.next)
  cancelled.end('aborted')
  assert.equal(cancelled.bridge.lastRecall(cancelled.session.id).outcome, 'cancelled')

  const unknown = fixture(t)
  await unknown.bridge.preStep(unknown.payload, unknown.next)
  unknown.end()
  assert.equal(unknown.bridge.lastRecall(unknown.session.id).outcome, 'unknown')
  assert.equal(unknown.engine.status().inconclusive, 0)

  // A learning-state write failure must never be displayed as a settled success.
  const failing = fixture(t)
  await failing.bridge.preStep(failing.payload, failing.next)
  // The durable acknowledgement is the first write now, so that is the boundary a storage
  // failure actually happens at.
  failing.engine.settlementEnqueue = () => { throw Object.assign(new Error('disk unavailable'), { code: 'state_unavailable' }) }
  failing.end()
  const pending = failing.bridge.lastRecall(failing.session.id)
  assert.equal(pending.outcome, 'pending')
  assert.equal(pending.settleError, 'state_unavailable')
})

test('status reads use the trusted session project key before any turn has run', async t => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-harness-scope-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh' })
  const projectKey = '/work/project-scoped'
  engine.record({ eventId: 'seed', source: 'direct_user', kind: 'correction',
    instruction: '以后导出金额前先转换为数值，再按金额排序', projectKey })
  const bridge = createHarnessBridge({ engine, createMessage: text => ({ id: 'm1', role: 'user', content: [{ type: 'text', text }] }) })
  const session = { id: 'fresh-session', header: { cwd: projectKey }, events: [] }
  const status = bridge.recallStatus(session.id, session.header.cwd)
  assert.equal(status.library.scopeKind, 'project')
  assert.equal(status.library.library.activeCorrections, 1, 'the first status read sees the project scope')
  assert.equal(bridge.recallStatus(session.id).library.scopeKind, 'instance',
    'without the trusted key the cache is simply empty, not wrong')
  const diagnosis = bridge.diagnose({ sessionId: session.id, projectKey: session.header.cwd, prompt: '导出金额并排序' })
  assert.equal(diagnosis.prompted.reason, 'recalled')
  const command = handleMseCommand(bridge, 'now 导出金额并排序', { sessionId: session.id, projectKey: session.header.cwd })
  assert.match(command.text, /已召回/)
  const firstTurn = bridge.preStep({ agent: { session }, step: 1, turn: 1,
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '导出金额并排序' }] }],
    signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.equal((await firstTurn).messages.length, 1, 'the same task is injected once the turn actually runs')
})

test('a paused controller never claims an injection is available', async t => {
  const { bridge, session } = fixture(t)
  bridge.setEnabled(false)
  const status = bridge.recallStatus(session.id, session.header.cwd)
  assert.equal(status.enabled, false)
  const now = handleMseCommand(bridge, 'now 导出金额并排序', { sessionId: session.id })
  assert.equal(now.kind, 'success')
  assert.match(now.text, /控制器已暂停/)
  assert.match(now.text, /不会注入/)
  const overview = handleMseCommand(bridge, '', { sessionId: session.id }).text
  assert.match(overview, /控制器已暂停/)
})
