import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentEvents } from '@deepseek-ai/dsh-agent'
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

test('same-turn adapter reload restores an in-flight adaptive probe without reinjection', async () => {
  const { Context, Service } = await import('@deepseek-ai/cordis')
  const dir = mkdtempSync(join(homedir(), '.mse-rsi-reopen-'))
  const stateRoot = join(dir, 'mse-learning')
  const sessionId = 'native-rsi-reopen-session'
  let firstFiber
  let secondFiber
  try {
    const makeContext = async () => {
      const ctx = new Context().root
      ctx.provide('agents', {})
      ctx.provide('tools', {})
      ctx.provide('llm', { async * stream() { throw new Error('provider must remain unused') } })
      ctx.provide('dshHomePath', () => stateRoot)
      class WorkspaceRegistryMirror extends Service {
        constructor(c) { super(c, 'workspaceRegistry') }
        list() { return [{ path: realpathSync(dir), sessionIds: [sessionId] }] }
      }
      await ctx.plugin(WorkspaceRegistryMirror)
      const bundle = (await import('./root.mjs')).default
      const fiber = ctx.registry.plugin(bundle, { wakeIntervalMs: 60_000 })
      await fiber
      return { ctx, fiber, api: ctx.get('mseRebuild') }
    }
    const first = await makeContext()
    firstFiber = first.fiber
    first.api.engine.recordCorrection({
      text: '生成 JSON 配置时先校验字段和解析结果，避免不完整写入', sessionId: 'seed', turnId: 'seed',
    })
    const session = { id: sessionId, header: { cwd: dir }, events: [],
      get seq() { return this.events.length }, eventAt(index) { return this.events[index] } }
    const firstEvent = async event => {
      session.events.push(event)
      await first.ctx.parallel('session/event', session, event)
    }
    const prompt = '生成 JSON 配置时校验字段完整性，先检查解析结果再写入'
    const firstMessage = { id: 'user-1-first', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: prompt }] }
    await firstEvent({ type: 'turn/start', data: { turn: 1 } })
    await firstEvent({ type: 'user/message', data: firstMessage })
    const initial = await agentEvents(first.ctx, { session }).waterfall('agent/pre-step', {
      step: 1, turn: 1, messages: [firstMessage],
    }, () => Promise.resolve({ kind: 'enter', messages: [firstMessage] }))
    assert.equal(initial.kind, 'enter')
    assert.equal(initial.messages.length, 2, 'the first step injects the matched rule')
    const firstDoc = first.api.engine.store.read()
    const receiptCount = firstDoc.receipts.length
    const injectedCounts = firstDoc.entries.map(entry => [entry.id, entry.injected])
    const turnKey = firstDoc.recallStrategy.adaptive.probes.at(-1)?.turnKey
    assert.ok(firstDoc.recallStrategy.adaptive.probes.some(row => row.turnKey === turnKey),
      'the active step persisted its bounded adaptive probe')

    firstFiber.dispose()
    firstFiber = null
    const second = await makeContext()
    secondFiber = second.fiber
    const replayMessage = { id: 'user-1-reopened', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: prompt }] }
    const secondEvent = async event => {
      session.events.push(event)
      await second.ctx.parallel('session/event', session, event)
    }
    await secondEvent({ type: 'turn/start', data: { turn: 1 } })
    await secondEvent({ type: 'user/message', data: replayMessage })

    const bytesBeforePrepare = readFileSync(second.api.engine.store.path)
    const duplicate = second.api.engine.prepare({ sessionId, turnId: '1', projectKey: dir,
      prompt, strategyEligible: true })
    const storedProbe = second.api.engine.store.read().recallStrategy.adaptive.probes
      .find(row => row.turnKey === turnKey)
    assert.equal(duplicate.reason, 'same_turn_dedup')
    assert.deepEqual(duplicate.rsiProbe, {
      turnKey: storedProbe.turnKey, activePolicies: storedProbe.activePolicies,
      shadowPolicies: storedProbe.shadowPolicies, controlPolicies: storedProbe.controlPolicies,
      offered: storedProbe.offered, baselineOffers: storedProbe.baselineOffers, at: storedProbe.at,
    })
    assert.deepEqual(readFileSync(second.api.engine.store.path), bytesBeforePrepare,
      'engine prepare returns the projection without committing')

    const replayed = await agentEvents(second.ctx, { session }).waterfall('agent/pre-step', {
      step: 1, turn: 1, messages: [replayMessage],
    }, () => Promise.resolve({ kind: 'enter', messages: [replayMessage] }))
    assert.equal(replayed.kind, 'enter')
    assert.equal(replayed.messages.length, 1, 'the duplicate step does not inject the rule again')
    const replayDoc = second.api.engine.store.read()
    assert.equal(replayDoc.receipts.length, receiptCount, 'the duplicate step adds no receipt')
    assert.deepEqual(replayDoc.entries.map(entry => [entry.id, entry.injected]), injectedCounts,
      'the duplicate step does not change injection counts')
    assert.ok(second.api.statusView().rsiDiagnostics.recent.some(row =>
      row.stage === 'probe' && row.reason === 'probe_created'),
    'the native adapter resumes diagnostics from the persisted probe projection')
  } finally {
    firstFiber?.dispose()
    secondFiber?.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
