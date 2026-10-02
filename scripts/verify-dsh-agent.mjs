// Real DSH AgentLoop and tools with scripted in-process model responses only.
// This does not install or exempt a package; verify-dsh-install checks admission separately.
//
// LAYER: a PERMISSION-CONTROLLED AgentLoop fixture. This script mounts no session directory, so
// every mount states the host permission explicitly (`setTrustedGuard(() => true)` inside
// `mount()`); without it the core conservatively refuses to settle, which would make the counts
// below measure the missing fixture rather than the wiring. The real asynchronous directory,
// archive and guard rules are covered by the Host suite (independent 14 + race checks), never by
// this file. No assertion here is relaxed by that permission.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.equal(process.argv.length, 4, 'usage: node scripts/verify-dsh-agent.mjs <npm-tarball> <host-node_modules>')
const [archive, modules] = process.argv.slice(2).map(value => resolve(value))
const root = mkdtempSync(join(tmpdir(), 'mse-agent-native-'))
const load = name => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')))
let ctx
try {
  execFileSync('tar', ['-xzf', archive, '-C', root])
  symlinkSync(modules, join(root, 'package/node_modules'), 'dir')
  const { Context } = await load('cordis')
  const llm = await load('dsh-llm'), session = await load('dsh-session'), tools = await load('dsh-tools')
  const projection = await load('dsh-session-projection'), prompt = await load('dsh-system-prompt')
  const registry = await load('dsh-agent'), loop = await load('dsh-agent-loop')
  const commands = await load('dsh-commands')
  const { default: plugin } = await import(pathToFileURL(join(root, 'package/adapters/dsh/index.mjs')))
  const textResponse = text => [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const failedToolResponse = () => [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'fixture-call', name: 'mse_fixture_fail', argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'fixture-call', name: 'mse_fixture_fail', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  class FixtureAdapter extends llm.LlmAdapter {
    requests = []
    queue = []
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      assert.equal(options.provider, 'mse-fixture')
      assert.equal(options.model, 'fixture')
      this.requests.push(options)
      const chunks = options.sessionId === undefined
        ? textResponse(JSON.stringify({ instruction: '导出金额并排序时先检查数值类型，再核对金额排列顺序' }))
        : this.queue.shift()
      assert.ok(chunks, 'unexpected task request')
      for (const chunk of chunks) { options.signal?.throwIfAborted(); yield chunk }
    }
  }
  const mount = async (profile = 'learning', reflectionEnabled = false, extra = {}) => {
    ctx = new Context()
    ctx.provide('dshHomePath', (...parts) => join(root, profile, ...parts))
    for (const service of [llm.default, session.default, projection.default, prompt.default, tools.default, registry.default, commands.default]) {
      await ctx.plugin(service)
    }
    await ctx.plugin(loop.default, { agents: [] })
    const adapter = new FixtureAdapter()
    ctx.llm.registerAdapter(['mse-fixture'], adapter)
    ctx.tools.register(tools.defineContentToolFixture({ name: 'mse_fixture_fail', description: 'Synthetic failure',
      parameters: {}, async execute() { throw new Error('synthetic tool failure') } }))
    await ctx.plugin(plugin, { reflectionEnabled, ...extra })
    assert.ok(ctx.mseLearning)
    // ONE explicit, controlled permission per mount — this fixture has no session directory, and
    // an unstated guard would read as "host truth unknown" (the core's safe default). It is
    // deliberately the same statement for every mount, so a later mount cannot silently lose it.
    ctx.mseLearning.setTrustedGuard(() => true)
    return adapter
  }
  const create = id => ctx.agentLoop.create(session.SessionId(id), { provider: 'mse-fixture', model: 'fixture' })
  const send = async (agent, adapter, text, responses = [textResponse('已完成合成任务的金额排序检查')], expectedReason = 'completed') => {
    adapter.queue.push(...responses)
    let unsubscribe, timer
    const idle = new Promise((resolveIdle, reject) => {
      unsubscribe = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') resolveIdle()
      })
      timer = setTimeout(() => reject(new Error('fixture AgentLoop did not become idle')), 10000)
    })
    try {
      agent.followup(llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await idle
      const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
      assert.equal(end?.data.reason.kind, expectedReason)
    } finally { clearTimeout(timer); unsubscribe() }
  }
  const mseMessages = messages => messages.filter(message => message.source?.plugin === 'mse-learning')
  const eventMessages = agent => agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data)
  const correction = '以后导出金额前先转换为数值，再按金额排序'
  const task = '请导出金额并进行排序'
  let adapter = await mount()
  await send(await create('correction'), adapter, correction)
  assert.equal(ctx.mseLearning.engine.status().lessons, 1)
  await ctx.fiber.dispose()
  adapter = await mount()
  const recalled = await create('recalled')
  await send(recalled, adapter, task, [failedToolResponse(), textResponse('金额排序的合成工具检查失败，需要检查数值类型')])
  const injected = mseMessages(adapter.requests[0].messages)
  assert.equal(injected.length, 1, 'real request must carry the lesson')
  const context = injected[0].content.map(block => block.text ?? '').join('')
  assert.match(context, /转换为数值/)
  assert.ok(Buffer.byteLength(context) <= 768)
  assert.equal(ctx.mseLearning.engine.status().adopted, 1)
  assert.equal(ctx.mseLearning.engine.status().failed, 0, 'a tool failure is not proof that the lesson failed')
  assert.equal(ctx.mseLearning.engine.status().inconclusive, 1)
  assert.equal(ctx.mseLearning.engine.status().verified, 0)
  await send(recalled, adapter, task)
  assert.equal(mseMessages(eventMessages(recalled)).length, 1, 'same session must not reinject')
  const unrelated = await create('unrelated')
  await send(unrelated, adapter, '查询明天天气')
  assert.equal(mseMessages(eventMessages(unrelated)).length, 0)
  const blocked = await create('preflight-blocked')
  const beforeBlocked = ctx.mseLearning.engine.status()
  const offAdmission = ctx.on('llm/stream', (options, next) => {
    if (options.sessionId === blocked.session.id) throw new Error('synthetic preflight rejection')
    return next()
  })
  await send(blocked, adapter, task, [], 'error')
  offAdmission()
  assert.equal(ctx.mseLearning.engine.status().adopted, beforeBlocked.adopted, 'blocked requests do not adopt')
  assert.equal(ctx.mseLearning.engine.status().failed, beforeBlocked.failed, 'preflight rejection is not lesson failure')
  const checked = await create('host-checked')
  const offCheck = ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (agent === checked) assert.equal(ctx.mseLearning.bridge.verification({ sessionId: agent.session.id,
      turnId: turn, checkId: 'synthetic-host-check', passed: true,
      lessonIds: [ctx.mseLearning.engine.store.read().lessons[0].id] }), true)
  })
  await send(checked, adapter, task)
  offCheck()
  assert.equal(ctx.mseLearning.engine.status().verified, 1)
  // The plugin-owned /mse status command runs through the real command registry: it logs a
  // visible command row, reports real counts/bytes/reason, and adds nothing to a model request.
  const statusAgent = await create('status-view')
  await send(statusAgent, adapter, task)
  const command = await ctx.commands.execute(statusAgent, '/mse', [], new AbortController().signal)
  assert.equal(command?.result.kind, 'success', 'the real command registry must execute /mse')
  assert.match(command.result.text, /MSE 学习状态/)
  assert.match(command.result.text, /不进入模型上下文/)
  assert.match(command.result.text, /原因码/)
  const rows = statusAgent.session.snapshotEvents().filter(event => ['command/run', 'command/done'].includes(event.type))
  assert.equal(rows.length, 2, 'a visible command row is logged')
  assert.equal(statusAgent.session.snapshotEvents().some(event => event.type === 'user/message'
    && JSON.stringify(event.data.content).includes('MSE 学习状态')), false, 'the status row is not injected context')
  assert.equal(statusAgent.session.snapshotEvents().some(event => event.type === 'user/message'
    && event.data.source?.plugin === 'mse-learning'), true, 'the recalled lesson itself is still an injected context message')
  assert.match(command.result.text, /已召回 1 条/)
  const why = await ctx.commands.execute(statusAgent, '/mse why', [], new AbortController().signal)
  assert.match(why.result.text, /本轮来源/)
  assert.match(why.result.text, /最近轮次/)
  const dryRun = await ctx.commands.execute(statusAgent, '/mse now 导出金额并排序', [], new AbortController().signal)
  assert.match(dryRun.result.text, /只读诊断/)
  const statusOnly = await create('status-quiet')
  await send(statusOnly, adapter, '查询明天的天气情况')
  assert.equal(mseMessages(adapter.requests.at(-1).messages).length, 0)
  assert.equal(ctx.mseLearning.recallStatus(statusOnly.session.id).last.reason, 'match_insufficient')
  // A normal user task that mentions MSE is still learned from and later recalled.
  const mseDeveloper = await create('mse-developer')
  await send(mseDeveloper, adapter, '以后开发 MSE 学习插件时先核验项目入口再修改源码')
  const mseRelated = await create('mse-related')
  await send(mseRelated, adapter, '开始开发 MSE 学习插件的召回部分')
  assert.equal(mseMessages(adapter.requests.at(-1).messages).length, 1, 'an MSE-named task still recalls')
  // A synonym rewrite recalls the same lesson; an unrelated task stays silent.
  const synonym = await create('synonym')
  await send(synonym, adapter, '帮我把报表里的金额按数字大小排列后输出')
  assert.equal(mseMessages(adapter.requests.at(-1).messages).length, 1, 'synonym rewrite must recall')
  assert.equal(ctx.mseLearning.recallStatus(synonym.session.id).last.reason, 'recalled')
  // Only the internal review envelope pauses learning, and it never learns.
  const beforeInternal = ctx.mseLearning.engine.status().lessons
  const internalReview = await create('internal-review')
  await send(internalReview, adapter, '[[mse-internal-review]] 以后导出金额前先转换为数值，再按金额排序')
  assert.equal(mseMessages(adapter.requests.at(-1).messages).length, 0, 'internal review never injects')
  assert.equal(ctx.mseLearning.engine.status().lessons, beforeInternal, 'internal review text never becomes a lesson')
  assert.equal(ctx.mseLearning.recallStatus(internalReview.session.id).last.reason, 'internal_task')
  // Every prepare reports one reason, including a silent one.
  const silent = await create('silent')
  await send(silent, adapter, '查询明天的天气情况')
  assert.equal(ctx.mseLearning.recallStatus(silent.session.id).last.reason, 'match_insufficient')
  assert.equal(ctx.mseLearning.recallStatus(silent.session.id).last.bytes, 0)
  // The status surface reports the same settlement the core recorded.
  const settledAgent = await create('settled-view')
  const settledLesson = ctx.mseLearning.engine.store.read().lessons[0].id
  const offSettle = ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (agent === settledAgent) assert.equal(ctx.mseLearning.bridge.verification({ sessionId: agent.session.id,
      turnId: turn, checkId: 'status-settlement-check', passed: true, lessonIds: [settledLesson] }), true)
  })
  await send(settledAgent, adapter, task)
  offSettle()
  assert.equal(ctx.mseLearning.engine.status().verified >= 1, true)
  assert.equal(ctx.mseLearning.lastRecall(settledAgent.session.id).outcome, 'verified',
    'the status shows the outcome the core actually recorded')
  const legacy = await ctx.plugin({ name: 'legacy-fixture', apply(child) { child.provide('missherEvolutionCore', {}) } })
  await send(await create('legacy-paused'), adapter, task)
  assert.equal(mseMessages(adapter.requests.at(-1).messages).length, 0)
  await legacy.dispose()
  await send(await create('legacy-resumed'), adapter, task)
  assert.equal(mseMessages(adapter.requests.at(-1).messages).length, 1)
  await ctx.fiber.dispose()
  adapter = await mount('reflection', true)
  const reflected = await create('reflection')
  await send(reflected, adapter, task, [failedToolResponse(), textResponse('金额排序检查失败，金额被当作字符串排序，需要检查数值类型')])
  const deadline = Date.now() + 5000
  while (ctx.mseLearning.engine.status().counts.candidate !== 1 && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
  }
  assert.equal(ctx.mseLearning.engine.status().counts.candidate, 1)
  assert.equal(ctx.mseLearning.engine.status().verified, 0)
  const reviews = adapter.requests.filter(request => request.sessionId === undefined)
  assert.equal(reviews.length, 1)
  assert.equal(reviews[0].maxTokens, 384)
  assert.match(reviews[0].system ?? '', /复盘/)
  assert.equal(mseMessages(eventMessages(reflected)).length, 0, 'review stays outside the main conversation')
  // Closing one session cancels its queued review through the real AgentLoop: the same
  // failing turn followed by a session close must not add a candidate.
  const candidatesBeforeClose = ctx.mseLearning.engine.status().counts.candidate
  const closingAgent = await create('close-review')
  const closeOn = ctx.on('session/event', (session, event) => {
    if (session.id === 'close-review' && event.type === 'turn/end') ctx.mseLearning.bridge.closeSession(session.id)
  })
  await send(closingAgent, adapter, task, [failedToolResponse(), textResponse('金额排序检查失败，需要检查数值类型')])
  closeOn()
  await new Promise(resolveWait => setTimeout(resolveWait, 80))
  assert.equal(ctx.mseLearning.engine.status().counts.candidate, candidatesBeforeClose,
    'a closed session never writes a review candidate')
  const reviewsAfterClose = adapter.requests.filter(request => request.sessionId === undefined).length
  assert.equal(reviewsAfterClose, 1, 'the cancelled review never issued a model request')
  // The unvalidated reflection candidate must not reach a task request.
  const candidateSession = await create('candidate-not-recalled')
  await send(candidateSession, adapter, task)
  assert.equal(mseMessages(adapter.requests.at(-1).messages).length, 0,
    'an unvalidated method stays offline even for a matching task')
  assert.equal(ctx.mseLearning.recallStatus(candidateSession.session.id).last.reason, 'method_unvalidated')
  // A transient settlement failure through the REAL AgentLoop with an injected clock:
  // the frozen completion is replayed once and credited exactly once.
  await ctx.fiber.dispose()
  const retryTimers = new Map()
  let retryTime = 1000, retryId = 0
  const retryClock = { now: () => retryTime,
    schedule: (fn, ms) => { const id = ++retryId; retryTimers.set(id, { fn, at: retryTime + ms }); return id },
    cancel: id => retryTimers.delete(id),
    advance: ms => { retryTime += ms
      for (let guard = 0; guard < 16; guard++) {
        const due = [...retryTimers].filter(([, timer]) => timer.at <= retryTime)
        if (due.length === 0) return
        for (const [id, timer] of due) { retryTimers.delete(id); timer.fn() }
      } } }
  adapter = await mount('settlement', false, { now: retryClock.now,
    settlement: { schedule: retryClock.schedule, cancel: retryClock.cancel } })
  const retryLesson = ctx.mseLearning.engine.record({ eventId: 'retry-seed', source: 'direct_user', kind: 'correction',
    instruction: '以后导出金额前先转换为数值，再按金额排序' })
  const bridgeRef = ctx.mseLearning
  const retryComplete = bridgeRef.engine.settlementApply.bind(bridgeRef.engine)
  const retryPayloads = []
  let retryFailures = 1
  bridgeRef.engine.settlementApply = (...args) => {
    retryPayloads.push(JSON.stringify(args[0]))
    if (retryFailures-- > 0) throw Object.assign(new Error('locked'), { code: 'lock_busy' })
    return retryComplete(...args)
  }
  const retryAgent = await create('settlement-retry')
  const offRetryCheck = ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (agent !== retryAgent) return
    assert.equal(ctx.mseLearning.bridge.verification({ sessionId: agent.session.id, turnId: turn,
      checkId: 'settlement-retry-check', passed: true, lessonIds: [retryLesson.id] }), true)
  })
  await send(retryAgent, adapter, task)
  offRetryCheck()
  assert.equal(ctx.mseLearning.engine.status().verified, 0, 'the failed write is not reported as settled')
  assert.equal(ctx.mseLearning.lastRecall(retryAgent.session.id).outcome, 'pending')
  assert.equal(ctx.mseLearning.settlementStatus().length, 1, 'the frozen completion stays queued')
  assert.ok(ctx.mseLearning.durableStatus(), 'the durable queue is visible to the host')
  retryClock.advance(250)
  assert.equal(ctx.mseLearning.engine.status().verified, 1, 'the replay settles exactly once')
  assert.equal(new Set(retryPayloads).size, 1, 'every attempt replays one frozen payload')
  assert.equal(ctx.mseLearning.settlementStatus().length, 0)
  assert.equal(ctx.mseLearning.lastRecall(retryAgent.session.id).outcome, 'verified')
  assert.equal(mseMessages(adapter.requests.at(-1).messages).length, 1,
    'the injected recall is unaffected by the settlement retry')
  console.log(JSON.stringify({ ok: true, layer: 'permission-controlled AgentLoop with in-process fixture adapter',
    settlementRetryThroughAgentLoop: true, settlementRetryAttempts: retryPayloads.length,
    settlementVerifiedOnce: ctx.mseLearning.engine.status().verified,
    statusCommandVisible: true, statusCommandOutsideContext: true, reasonReported: true,
    statusSettlementMatchesCore: true, closedSessionReviewCancelled: true,
    mseNamedTaskLearned: true, synonymRecall: true, internalReviewNotLearned: true, unvalidatedMethodNotRecalled: true,
    runtimeVersion: JSON.parse(readFileSync(join(modules, '@deepseek-ai/dsh-llm/package.json'), 'utf8')).version,
    persistentRecall: true, requestContainsLesson: true, recallBytes: Buffer.byteLength(context),
    nativeToolFailureNotMisattributed: true, preflightNotMisattributed: true, trustedLessonVerification: true, duplicateSuppressed: true, unrelatedRecallBytes: 0,
    legacyPauseAndResume: true, boundedReflectionCandidate: true, unloadReload: true, realModelCalls: 0 }))
} finally {
  await ctx?.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
}
