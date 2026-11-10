import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildEngine, failureX } from '../scripts/rsi/adaptive-engine-fixture.mjs'
import { synthesizeAdaptivePolicy } from './adaptive-recall.mjs'
import { RECALL_QUALIFICATION } from './recall-qualification.mjs'

test('native pre-step, failure result, and turn end bridge one observing legacy policy without double-counting', async () => {
  const { Context, Service } = await import('@deepseek-ai/cordis')
  const dir = mkdtempSync(join(homedir(), '.mse-legacy-host-'))
  const stateRoot = join(dir, 'mse-learning')
  const fixture = buildEngine({ root: stateRoot, projectKey: dir })
  const registered = fixture.registered
  const sessionId = 'native-rsi-session'
  registered.add(sessionId)
  registered.add('native-legacy-seed')
  let fiber
  try {
    const ctx = new Context().root
    ctx.provide('agents', {})
    ctx.provide('tools', {})
    ctx.provide('llm', { async * stream() { throw new Error('provider must remain unused') } })
    ctx.provide('dshHomePath', () => stateRoot)
    class WorkspaceRegistryMirror extends Service {
      constructor(c) { super(c, 'workspaceRegistry') }
      list() { return [{ path: realpathSync(dir), sessionIds: [...registered, 'native-rsi-session'] }] }
    }
    await ctx.plugin(WorkspaceRegistryMirror)
    const bundle = (await import('./root.mjs')).default
    fiber = ctx.registry.plugin(bundle, { wakeIntervalMs: 60_000 })
    await fiber
    const api = ctx.get('mseRebuild')
    const session = { id: sessionId, header: { cwd: dir }, events: [],
      get seq() { return this.events.length }, eventAt(index) { return this.events[index] } }
    const emitEvent = async event => {
      session.events.push(event)
      await ctx.emit('session/event', session, event)
    }
    const startTurn = turn => emitEvent({ type: 'turn/start', data: { turn } })
    const userStep = async (turn, text) => {
      const message = { id: `user-${turn}-${session.events.length}`, role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text }] }
      await emitEvent({ type: 'user/message', data: message })
      await ctx.emit('agent/pre-step', { agent: { session }, step: 1, turn, messages: [message] },
        async payload => ({ kind: 'enter', messages: payload.messages }))
    }
    const toolFailure = async (turn, id, { cancelled = false } = {}) => {
      const signal = { aborted: cancelled }
      await emitEvent({ type: 'tool/call', data: { callId: id, name: 'bash', turn, step: 1,
        arguments: JSON.stringify({ command: 'curl api endpoint' }) } })
      await ctx.emit('tools/result', { agent: { session }, name: 'bash', callId: id,
        rootCallId: id, signal }, cancelled ? { isError: true,
          value: { cancelled: true, aborted: true }, error: { info: { code: 'ABORTED' } } }
          : { isError: false, value: { exitCode: 1,
            stdout: { text: '', truncated: false },
            stderr: { text: failureX.stderr, truncated: false }, cwd: dir } })
    }
    const endTurn = (turn, kind = 'completed') => emitEvent({ type: 'turn/end',
      data: { turn, reason: { kind } } })

    const seed = fixture.prepare('native-legacy-seed', 'seed', '测试 JSON 输出。')
    const seedProbe = structuredClone(api.engine.store.read().recallStrategy.adaptive.probes
      .find(row => row.turnKey === seed.turnKey))
    const target = api.engine.store.read().entries.find(row => row.id === fixture.targetX.id)
    const legacy = synthesizeAdaptivePolicy({ scope: seedProbe.scope,
      qualification: RECALL_QUALIFICATION.id, entry: target, queryFeatures: ['json', 'test'],
      turnKey: seedProbe.turnKey, session: seedProbe.session, queryKey: seedProbe.query,
      now: 1_800_000_000_000 })
    legacy.positives = 3
    legacy.negativeControls = 4
    api.engine.store.transaction(doc => { doc.recallStrategy.adaptive.policies.push(legacy); return true })
    const originalLegacy = structuredClone(legacy)
    fixture.settle('native-legacy-seed', 'seed', 'unknown')

    await startTurn(2)
    await userStep(2, '测试 JSON 输出。')
    await toolFailure(2, 'native-legacy-discovery')
    const pendingProbe = api.engine.store.read().recallStrategy.adaptive.probes.at(-1)
    assert.ok(pendingProbe, 'native pre-step created the bounded adaptive probe')
    assert.ok(pendingProbe.pending.some(row => row.kind === 'discovery'
      && row.entryId === fixture.targetX.id))
    assert.ok(!pendingProbe.pending.some(row => row.policyId === legacy.id && row.kind === 'holdout'),
      'the same native failure is not counted as both a v1 holdout and v2 discovery')
    await endTurn(2)

    await startTurn(3)
    await userStep(3, '测试 JSON 输出。')
    await toolFailure(3, 'native-legacy-duplicate')
    await endTurn(3)

    await startTurn(4)
    await userStep(4, '测试 JSON 输出。')
    await toolFailure(4, 'native-legacy-cancelled', { cancelled: true })
    await endTurn(4, 'aborted')

    await startTurn(5)
    await userStep(5, '测试 JSON 输出。')
    await endTurn(5)

    const adaptive = api.engine.store.read().recallStrategy.adaptive
    const retainedLegacy = adaptive.policies.find(row => row.id === legacy.id)
    const successor = adaptive.policies.find(row => row.entryId === fixture.targetX.id
      && row.version === target.version && row.schema === 'mse-adaptive-recall-v2')
    assert.deepEqual(retainedLegacy, originalLegacy)
    assert.ok(successor)
    assert.equal(successor.positives, 1, 'duplicate and unknown/cancelled turns add no holdouts')
    assert.equal(successor.negativeControls, 0)
    assert.equal(successor.mode, 'observing')
    assert.equal(JSON.stringify(api.statusView().rsiDiagnostics.recent).includes(sessionId), false)
  } finally {
    fiber?.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
