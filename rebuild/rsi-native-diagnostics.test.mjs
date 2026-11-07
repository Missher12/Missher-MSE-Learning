import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildEngine, failureX, trainApiPolicy } from '../scripts/rsi/adaptive-engine-fixture.mjs'

test('native events expose bounded RSI pending, settlement, refusal and restart diagnostics', async () => {
  const { Context, Service } = await import('@deepseek-ai/cordis')
  const dir = mkdtempSync(join(homedir(), '.mse-rsi-native-'))
  const stateRoot = join(dir, 'mse-learning')
  const fixture = buildEngine({ root: stateRoot, projectKey: dir })
  const registered = fixture.registered
  let fiber
  let nextFiber
  try {
    trainApiPolicy(fixture)
    const makeContext = async () => {
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
      const pluginFiber = ctx.registry.plugin(bundle, { wakeIntervalMs: 60_000 })
      await pluginFiber
      return { ctx, fiber: pluginFiber, api: ctx.get('mseRebuild') }
    }
    const running = await makeContext()
    fiber = running.fiber
    const { ctx, api } = running
    const sessionId = 'native-rsi-session'
    const session = { id: sessionId, header: { cwd: dir }, events: [],
      get seq() { return this.events.length }, eventAt(index) { return this.events[index] } }
    const emitEvent = async event => {
      session.events.push(event)
      await ctx.emit('session/event', session, event)
    }
    const startTurn = turn => emitEvent({ type: 'turn/start', data: { turn } })
    const userStep = async (turn, text) => {
      const message = { id: `user-${turn}-${session.events.length}`, role: 'user',
        source: { kind: 'user' }, content: [{ type: 'text', text }] }
      await emitEvent({ type: 'user/message', data: message })
      return ctx.emit('agent/pre-step', { agent: { session }, step: 1, turn, messages: [message] },
        async payload => ({ kind: 'enter', messages: payload.messages }))
    }
    const toolCall = async (turn, id, result, signal = { aborted: false }) => {
      const call = { type: 'tool/call', data: { callId: id, name: 'bash', turn, step: 1,
        arguments: JSON.stringify({ command: 'curl api endpoint' }) } }
      await emitEvent(call)
      const exec = { agent: { session }, name: 'bash', callId: id, rootCallId: id, signal }
      await ctx.emit('tools/result', exec, result)
      return { exec, call }
    }

    await startTurn(6)
    await userStep(6, 'API 调用遇到阻塞，请定位原因')
    await toolCall(6, 'native-api-failure', { isError: false, value: { exitCode: 1,
      stdout: { text: '', truncated: false },
      stderr: { text: failureX.stderr, truncated: false }, cwd: dir } })
    let status = api.statusView()
    let trace = status.rsiDiagnostics.recent
    assert.ok(trace.some(row => row.stage === 'pending'
      && row.reason === 'same_signature_recurrence'),
    `the persisted active-policy signal is visible before settlement: ${JSON.stringify({ trace,
      probes: api.engine.store.read().recallStrategy.adaptive.probes.map(row => ({
        activePolicies: row.activePolicies, pending: row.pending.map(signal => signal.reason) })),
      policies: api.engine.store.read().recallStrategy.adaptive.policies.map(row => ({ id: row.id,
        mode: row.mode, features: row.features })) })}`)
    for (let index = 0; index < 40; index += 1) {
      await toolCall(6, `native-api-success-${index}`, { isError: false, value: { exitCode: 0,
        stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, cwd: dir } })
    }
    assert.equal(api.statusView().rsiDiagnostics.recent.length, 32, 'runtime diagnostics retain only 32 rows')
    await emitEvent({ type: 'turn/end', data: { turn: 6, reason: { kind: 'completed' } } })
    status = api.statusView()
    trace = status.rsiDiagnostics.recent
    assert.ok(trace.some(row => row.stage === 'settled' && row.result === 'isolated'
      && row.reason === 'same_signature_recurrence' && row.outcome === 'failed'))
    const persisted = status.recallStrategy.adaptive.decisions
    assert.ok(persisted.some(row => row.result === 'isolated'
      && row.reason === 'same_signature_recurrence'))

    await startTurn(7)
    await userStep(7, 'API 调用遇到阻塞，请定位原因')
    await userStep(7, '请检查 /etc/rsi-private-canary.txt 中的内容')
    await emitEvent({ type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
    status = api.statusView()
    trace = status.rsiDiagnostics.recent
    assert.ok(trace.some(row => row.stage === 'admission' && row.reason === 'material_refused'))
    const traceJson = JSON.stringify(trace)
    for (const forbidden of ['API 调用遇到阻塞', 'curl api endpoint', failureX.stderr,
      '/etc/rsi-private-canary.txt', dir, sessionId]) {
      assert.ok(!traceJson.includes(forbidden), `diagnostics must omit ${forbidden}`)
    }
    assert.ok(trace.every(row => Object.keys(row).sort().join(',') ===
      'at,entryId,outcome,policyId,reason,result,stage,turnHash,version'))
    assert.ok(trace.every(row => /^[a-f0-9]{12}$/u.test(row.turnHash)))
    assert.ok(trace.every(row => row.policyId === null || /^[a-f0-9]{12}$/u.test(row.policyId)))
    assert.ok(trace.every(row => row.entryId === null || /^[a-f0-9]{8}$/u.test(row.entryId)))

    await startTurn(8)
    await userStep(8, 'API 请求遇到阻塞，请定位原因')
    const cancellation = new AbortController()
    cancellation.abort()
    await toolCall(8, 'native-api-cancelled', { isError: true,
      value: { cancelled: true, aborted: true }, error: { info: { code: 'ABORTED' } } }, cancellation.signal)
    await emitEvent({ type: 'turn/end', data: { turn: 8, reason: { kind: 'aborted' } } })
    status = api.statusView()
    assert.ok(status.rsiDiagnostics.recent.some(row => row.stage === 'settled'
      && row.outcome === 'cancelled' && row.result === 'unknown'))
    assert.equal(JSON.stringify(status.rsiDiagnostics.recent).includes(sessionId), false)

    await startTurn(10)
    await userStep(10, 'API 请求遇到阻塞，请定位原因')
    await emitEvent({ type: 'turn/end', data: { turn: 10, reason: { kind: 'completed' } } })
    status = api.statusView()
    assert.ok(status.rsiDiagnostics.recent.some(row => row.stage === 'settled'
      && row.reason === 'unknown_outcome' && row.result === 'unknown' && row.outcome === 'unknown'))

    const beforeOrdinary = status.rsiDiagnostics.recent
    await startTurn(9)
    await toolCall(9, 'ordinary-unprobed-success', { isError: false, value: { exitCode: 0,
      stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, cwd: dir } })
    await emitEvent({ type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } })
    assert.deepEqual(api.statusView().rsiDiagnostics.recent, beforeOrdinary,
      'ordinary native tool events without an RSI probe do not enter diagnostics')

    const decisionsBeforeRestart = status.recallStrategy.adaptive.decisions
    fiber.dispose()
    fiber = null
    const restarted = await makeContext()
    nextFiber = restarted.fiber
    const restartedStatus = restarted.api.statusView()
    assert.deepEqual(restartedStatus.rsiDiagnostics.recent, [])
    assert.deepEqual(restartedStatus.recallStrategy.adaptive.decisions, decisionsBeforeRestart)
  } finally {
    fiber?.dispose()
    nextFiber?.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
