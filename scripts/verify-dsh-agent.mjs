// Real DSH AgentLoop and tools with scripted in-process model responses only.
// This does not install or exempt a package; verify-dsh-install checks admission separately.
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
  const mount = async (profile = 'learning', reflectionEnabled = false) => {
    ctx = new Context()
    ctx.provide('dshHomePath', (...parts) => join(root, profile, ...parts))
    for (const service of [llm.default, session.default, projection.default, prompt.default, tools.default, registry.default]) {
      await ctx.plugin(service)
    }
    await ctx.plugin(loop.default, { agents: [] })
    const adapter = new FixtureAdapter()
    ctx.llm.registerAdapter(['mse-fixture'], adapter)
    ctx.tools.register(tools.defineContentToolFixture({ name: 'mse_fixture_fail', description: 'Synthetic failure',
      parameters: {}, async execute() { throw new Error('synthetic tool failure') } }))
    await ctx.plugin(plugin, { reflectionEnabled })
    assert.ok(ctx.mseLearning)
    return adapter
  }
  const create = id => ctx.agentLoop.create(session.SessionId(id), { provider: 'mse-fixture', model: 'fixture' })
  const send = async (agent, adapter, text, responses = [textResponse('已完成合成任务的金额排序检查')]) => {
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
      assert.equal(end?.data.reason.kind, 'completed')
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
  assert.equal(ctx.mseLearning.engine.status().failed, 1, 'native tools/result must be attributed')
  assert.equal(ctx.mseLearning.engine.status().verified, 0)
  await send(recalled, adapter, task)
  assert.equal(mseMessages(eventMessages(recalled)).length, 1, 'same session must not reinject')
  const unrelated = await create('unrelated')
  await send(unrelated, adapter, '查询明天天气')
  assert.equal(mseMessages(eventMessages(unrelated)).length, 0)
  const checked = await create('host-checked')
  const offCheck = ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (agent === checked) assert.equal(ctx.mseLearning.bridge.verification({ sessionId: agent.session.id,
      turnId: turn, checkId: 'synthetic-host-check', passed: true }), true)
  })
  await send(checked, adapter, task)
  offCheck()
  assert.equal(ctx.mseLearning.engine.status().verified, 1)
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
  console.log(JSON.stringify({ ok: true, layer: 'real AgentLoop with in-process fixture adapter',
    runtimeVersion: JSON.parse(readFileSync(join(modules, '@deepseek-ai/dsh-llm/package.json'), 'utf8')).version,
    persistentRecall: true, requestContainsLesson: true, recallBytes: Buffer.byteLength(context),
    nativeToolFailure: true, trustedVerification: true, duplicateSuppressed: true, unrelatedRecallBytes: 0,
    legacyPauseAndResume: true, boundedReflectionCandidate: true, unloadReload: true, realModelCalls: 0 }))
} finally {
  await ctx?.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
}
