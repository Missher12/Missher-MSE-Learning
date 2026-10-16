import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHarnessBridge, mseMessageSource } from '../adapters/harness.mjs'
import { registerDshGuardTemplates, registerDshProjectManifestIntake } from '../adapters/dsh/index.mjs'
import { LearningEngine } from '../src/index.mjs'

const modules = process.env.MSE_HOST_NODE_MODULES ?? '/opt/DeepSeek Harness/resources/app/dsh/node_modules'
const available = existsSync(`${modules}/@deepseek-ai/dsh-tools/lib/index.js`)
  && existsSync(`${modules}/@deepseek-ai/dsh-system-prompt/lib/index.js`)
  && existsSync(`${modules}/@deepseek-ai/cordis/lib/index.js`)
  && existsSync(`${modules}/@deepseek-ai/dsh-fs-local/lib/index.js`)
  && existsSync(`${modules}/@deepseek-ai/dsh-tool-str-replace-editor/lib/index.js`)

test('real Cordis keeps optional fs intake disconnected, then mounts and unmounts it with the service', {
  skip: !existsSync(`${modules}/@deepseek-ai/cordis/lib/index.js`)
    || !existsSync(`${modules}/@deepseek-ai/dsh-fs-local/lib/index.js`),
}, async t => {
  const [{ Context }, mse, fsLocal] = await Promise.all([
    import(pathToFileURL(`${modules}/@deepseek-ai/cordis/lib/index.js`)),
    import('../adapters/dsh/index.mjs'),
    import(pathToFileURL(`${modules}/@deepseek-ai/dsh-fs-local/lib/index.js`)),
  ])
  const root = mkdtempSync(join(tmpdir(), 'mse-cordis-no-fs-'))
  const ctx = new Context()
  ctx.provide('agents', {})
  ctx.provide('tools', {})
  ctx.provide('llm', { stream: async function * () {} })
  ctx.provide('dshHomePath', () => root)
  ctx.provide('sessionQuery', { listSessions: async () => [], readSession: async () => null })
  ctx.provide('workspaceRegistry', { archivedSessionIds: new Set() })
  const fibers = []
  t.after(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  fibers.push(await ctx.plugin(mse.default, { schedule: () => ({ unref() {} }), cancelTimer: () => {} }))
  const service = ctx.get('mseLearning')
  assert.ok(service, 'the core plugin loads even when no filesystem service is mounted')
  assert.equal(service.settings().verificationCapabilities.structuredArtifactHostIntake, 'not_connected')

  const mountFs = () => ctx.plugin(fsLocal.default ?? fsLocal, { cwd: root })
  fibers.push(await mountFs())
  assert.equal(service.settings().verificationCapabilities.structuredArtifactHostIntake, 'dsh_root_package_json_checker')
  await fibers.pop().dispose()
  assert.equal(service.settings().verificationCapabilities.structuredArtifactHostIntake, 'not_connected',
    'disposing the injected fs scope clears the advertised capability')
  fibers.push(await mountFs())
  assert.equal(service.settings().verificationCapabilities.structuredArtifactHostIntake, 'dsh_root_package_json_checker',
    'a replacement fs service can mount a fresh observer')
})

test('real Cordis cold startup confirms facts and sweeps an archived acknowledged settlement once', {
  skip: !existsSync(`${modules}/@deepseek-ai/cordis/lib/index.js`),
}, async t => {
  const [{ Context }, mse] = await Promise.all([
    import(pathToFileURL(`${modules}/@deepseek-ai/cordis/lib/index.js`)),
    import('../adapters/dsh/index.mjs'),
  ])
  const root = mkdtempSync(join(tmpdir(), 'mse-cordis-cold-settlement-'))
  const stateRoot = join(root, 'mse-learning')
  t.after(() => rmSync(root, { recursive: true, force: true }))

  // Make a real durable, host-acknowledged settlement in process A, then leave it pending as that
  // process exits. The next process will see the same durable state but an archived source.
  const seedEngine = new LearningEngine({ stateRoot, adapterId: 'dsh' })
  const lesson = seedEngine.record({ eventId: 'cold-archive-method', source: 'direct_user', kind: 'correction',
    instruction: '导出金额前先转换为数值类型，再按数值排序' })
  let messageId = 0
  const seedBridge = createHarnessBridge({ engine: seedEngine,
    createMessage: text => ({ id: `cold-${++messageId}`, role: 'user', source: mseMessageSource('instructions'),
      content: [{ type: 'text', text }] }) })
  seedBridge.setTrustedGuard(() => true)
  const session = { id: 'cold-archived-session', header: { id: 'cold-archived-session' }, events: [] }
  const userMessage = { id: 'cold-user', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '导出金额并排序' }] }
  const decision = await seedBridge.preStep({ agent: { session }, step: 1, turn: 1, messages: [userMessage],
    signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [userMessage] }))
  for await (const _chunk of seedBridge.stream({ sessionId: session.id, messages: decision.messages }, async function * () {
    yield { type: 'finish', reason: { kind: 'stop' } }
  })) { /* the host acknowledged adoption without a provider request */ }
  seedBridge.verification({ sessionId: session.id, turnId: 1, checkId: 'cold-check', passed: true,
    lessonIds: [lesson.id] })
  seedEngine.settlementApply = () => { throw Object.assign(new Error('lock_busy'), { code: 'lock_busy' }) }
  seedBridge.sessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(seedBridge.durableStatus().counts.pending, 1,
    `the original host acknowledgement is durable: ${JSON.stringify({ durable: seedBridge.durableStatus(), local: seedBridge.settlementStatus(), recall: seedBridge.lastRecall(session.id) })}`)
  seedBridge.dispose()

  const archivedId = session.id
  const boot = async () => {
    const ctx = new Context()
    ctx.provide('agents', {})
    ctx.provide('tools', {})
    ctx.provide('llm', { stream: async function * () {} })
    ctx.provide('dshHomePath', name => join(root, name))
    ctx.provide('sessionQuery', { listSessions: async () => [], readSession: async () => { throw new Error('archived') } })
    ctx.provide('workspaceRegistry', { archivedSessionIds: new Set([archivedId]) })
    const fiber = await ctx.plugin(mse.default, { schedule: () => ({ unref() {} }), cancelTimer: () => {} })
    return { fiber, service: ctx.get('mseLearning') }
  }
  const waitForSweep = async service => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = service.durableStatus()
      if (status.counts.pending === 0) return status
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return service.durableStatus()
  }

  const first = await boot()
  const firstStatus = await waitForSweep(first.service)
  assert.equal(firstStatus.counts.pending, 0, 'cold readiness refresh completed the archived-source sweep')
  assert.equal(firstStatus.control.stops, 1, 'the archived acknowledgement was durably stopped exactly once')
  assert.equal(first.service.settlementStatus().length, 0, 'the stopped acknowledgement is not restored as pending')
  await first.fiber.dispose()

  const second = await boot()
  const secondStatus = await waitForSweep(second.service)
  assert.deepEqual(secondStatus.counts, firstStatus.counts, 'a second cold rebuild does not duplicate stop/accounting')
  assert.deepEqual(secondStatus.control, firstStatus.control, 'the same archived identity is not swept twice')
  assert.equal(second.service.settlementStatus().length, 0)
  await second.fiber.dispose()
})

test('installed DSH tools pipeline enforces, rechecks, and drains a prepared guard lease', { skip: !available }, async t => {
  const load = async name => import(pathToFileURL(`${modules}/@deepseek-ai/${name}/lib/index.js`))
  const [{ Context }, systemPrompt, toolsModule] = await Promise.all([
    import(pathToFileURL(`${modules}/@deepseek-ai/cordis/lib/index.js`)), load('dsh-system-prompt'), load('dsh-tools')])
  const { defineTool, TOOL_RUNTIME_SCHEDULER } = toolsModule
  const ctx = new Context()
  const pluginDisposers = []
  t.after(async () => { for (const dispose of pluginDisposers.reverse()) if (typeof dispose === 'function') await dispose() })
  pluginDisposers.push(await ctx.plugin(systemPrompt.default ?? systemPrompt))
  pluginDisposers.push(await ctx.plugin(toolsModule.default ?? toolsModule))
  let bodyCalls = 0
  ctx.tools.register(defineTool({ name: 'synthetic_write', description: 'synthetic only',
    parameters: { path: { type: 'string', required: true }, target: { type: 'string' } },
    output: { schema: { type: 'string' }, render: () => [] },
    async execute() { bodyCalls++; return 'ok' } }))
  const dispose = registerDshGuardTemplates(ctx, [{ guardId: 'synthetic.contract', version: 1, mode: 'enforce',
    toolName: 'synthetic_write', requiredKeys: ['path'], allowedKeys: ['path'] }])
  assert.equal(dispose.registered, 1)
  const denied = await ctx.tools.execute({ name: 'synthetic_write', callId: 'invalid-1', arguments: { path: 'x', extra: true },
    signal: new AbortController().signal })
  assert.equal(denied.isError, true)
  assert.equal(bodyCalls, 0)

  const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare({ name: 'synthetic_write', callId: 'valid-1',
    arguments: { path: 'fixture-only' }, signal: new AbortController().signal })
  assert.equal(prepared.kind, 'dispatch')
  dispose() // Stop new admissions immediately; retain the old prepared execution's lease until result.
  assert.equal(bodyCalls, 0)
  const afterDispose = await ctx.tools.execute({ name: 'synthetic_write', callId: 'new-after-dispose',
    arguments: { path: 'new-call', target: 'valid-host-optional-argument' }, signal: new AbortController().signal })
  assert.equal(afterDispose.isError, false, 'a fresh call must not be controlled by a disposed template')
  assert.equal(bodyCalls, 1)
  const final = await ctx.tools.completeScheduledExecution(prepared)
  assert.equal(final.isError, false)
  assert.equal(bodyCalls, 2)
  const afterDrain = await ctx.tools.execute({ name: 'synthetic_write', callId: 'after-drain',
    arguments: { path: 'after-drain', target: 'valid-host-optional-argument' }, signal: new AbortController().signal })
  assert.equal(afterDrain.isError, false)
  assert.equal(bodyCalls, 3)
})

test('installed DSH editor writes drive package.json checks from real Host file/version events', { skip: !available }, async t => {
  const load = async name => import(pathToFileURL(`${modules}/@deepseek-ai/${name}/lib/index.js`))
  const [{ Context }, systemPrompt, toolsModule, fsLocal, editor] = await Promise.all([
    import(pathToFileURL(`${modules}/@deepseek-ai/cordis/lib/index.js`)), load('dsh-system-prompt'),
    load('dsh-tools'), load('dsh-fs-local'), load('dsh-tool-str-replace-editor')])
  const root = mkdtempSync(join(tmpdir(), 'mse-manifest-host-'))
  const ctx = new Context()
  const disposers = []
  t.after(async () => {
    for (const dispose of disposers.reverse()) if (typeof dispose === 'function') await dispose()
    rmSync(root, { recursive: true, force: true })
  })
  disposers.push(await ctx.plugin(systemPrompt.default ?? systemPrompt))
  disposers.push(await ctx.plugin(toolsModule.default ?? toolsModule))
  disposers.push(await ctx.plugin(fsLocal.default ?? fsLocal, { cwd: root }))
  disposers.push(await ctx.plugin(editor.default ?? editor))
  const engine = new LearningEngine({ stateRoot: join(root, '.state'), adapterId: 'dsh' })
  const session = { id: 'host-manifest-session', seq: 0, events: [], header: { cwd: root },
    eventAt(index) { return this.events[index] } }
  const bridge = { taskContext: () => ({ provider: 'deepseek-official', model: 'deepseek-flash',
    reasoningEffort: 'max', projectKey: root }) }
  let intake
  const intakeFiber = await ctx.inject(['fs'], fsCtx => {
    intake = registerDshProjectManifestIntake(fsCtx, { engine, bridge, environmentId: 'host-manifest-env' })
    fsCtx.effect(() => intake)
  })
  assert.equal(intake.registered, true)
  disposers.push(() => intakeFiber.dispose())
  const path = resolve(root, 'package.json')
  const invoke = async (callId, args) => {
    session.events.push({ type: 'tool/call', data: { callId, turn: 'turn-1' } }); session.seq = session.events.length
    const result = await ctx.tools.execute({ name: 'str_replace_editor', callId, arguments: args,
      signal: new AbortController().signal, agent: { session, model: 'deepseek-flash' } })
    await intake.drain()
    return result
  }
  const first = await invoke('manifest-bad', { command: 'create', path,
    file_text: '{"scripts":{"test":17},"extensionField":"allowed"}' })
  assert.equal(first.isError, false)
  const second = await invoke('manifest-repair', { command: 'str_replace', path,
    old_str: '"test":17', new_str: '"test":"node --test"' })
  assert.equal(second.isError, false)
  const status = engine.taskEvidenceStatus()
  assert.equal(status.records, 2)
  assert.equal(status.replayCases, 1)
  assert.deepEqual(status.latest.map(row => row.verdict), ['fail', 'pass'])
})
