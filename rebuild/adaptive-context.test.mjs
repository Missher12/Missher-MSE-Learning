import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

test('real Cordis wiring admits only the related, ended USER task context to adaptive recall', async () => {
  const { Context, Service } = await import('@deepseek-ai/cordis')
  const dir = mkdtempSync(join(homedir(), '.mse-adaptive-context-'))
  const sessionId = 'adaptive-context-session'
  const ctx = new Context().root
  ctx.provide('agents', {})
  ctx.provide('tools', {})
  ctx.provide('llm', { async * stream() { throw new Error('no provider call expected') } })
  ctx.provide('dshHomePath', name => join(dir, name))
  class WorkspaceRegistryMirror extends Service {
    constructor(c) { super(c, 'workspaceRegistry') }
    list() { return [{ path: realpathSync(dir), sessionIds: [sessionId] }] }
  }
  let fiber
  try {
    await ctx.plugin(WorkspaceRegistryMirror)
    const bundle = (await import('./root.mjs')).default
    fiber = ctx.registry.plugin(bundle, { modelProvider: 'demo', modelId: 'm1', wakeIntervalMs: 60_000 })
    await fiber
    const api = ctx.get('mseRebuild')
    assert.ok(api)
    const session = { id: sessionId, header: { cwd: dir }, events: [],
      get seq() { return this.events.length }, eventAt(n) { return this.events[n] } }
    const emitEvent = async event => {
      session.events.push(event)
      await ctx.emit('session/event', session, event)
    }
    const userStep = async (turn, text) => {
      const message = { id: 'user-' + turn, role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text }] }
      await emitEvent({ type: 'user/message', data: message })
      return ctx.emit('agent/pre-step', { agent: { session }, step: 1, turn, messages: [message] },
        async payload => ({ kind: 'enter', messages: payload.messages }))
    }
    await emitEvent({ type: 'turn/start', data: { turn: 1 } })
    await userStep(1, '这是插件交付验收单，核对宿主实际加载版本。')
    await emitEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await emitEvent({ type: 'turn/start', data: { turn: 2 } })
    await userStep(2, '当前对象是 Excel 报表。')
    await emitEvent({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await emitEvent({ type: 'turn/start', data: { turn: 3 } })
    await userStep(3, '继续排查这个问题。')

    const doc = api.engine.store.read()
    const probe = doc.recallStrategy.adaptive.probes.at(-1)
    assert.ok(Array.isArray(probe?.taskFeatures), 'DSH passes the admitted prior task into prepare')
    assert.ok(probe.taskFeatures.includes('excel') && probe.taskFeatures.includes('opdebug'))
    assert.ok(!probe.taskFeatures.includes('plugin') && !probe.taskFeatures.includes('version'),
      'the referenced object-only turn supplies Excel, while older unrelated task details stay out')
    assert.equal(doc.corrections.length, 0, 'task context does not open correction learning')
    assert.ok(!JSON.stringify(doc.recallStrategy.adaptive).includes('验收单'))
    assert.ok(!JSON.stringify(doc.recallStrategy.adaptive).includes('Excel 报表'))
  } finally {
    fiber?.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
