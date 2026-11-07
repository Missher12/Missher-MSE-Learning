import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadDefaultCases } from '../scripts/rsi/replay.mjs'
import { evidenceTokenHashes, validateFailureLessonOutput } from '../src/failure-lessons.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

test('Cordis checker accepts only paired in-workspace calls and records stdout-only evidence at turn end', async () => {
  const { Context, Service } = await import('@deepseek-ai/cordis')
  const dir = mkdtempSync(join(homedir(), '.mse-development-check-'))
  const sessionId = 'development-check-session'
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
    const template = loadDefaultCases().find(row => row.id === 'rsi-02-indent-error-exact').entries[0]
    const entryId = `mem_${hash('development-check-method').slice(0, 24)}`
    const problemId = hash('development-check-problem')
    const evidenceId = hash('evidence')
    const sourceEvidence = [{ message: 'Node 测试运行器检查失败', command: 'node --test checks.test.mjs' }]
    const reflected = validateFailureLessonOutput({
      schema: 'mse-failure-lesson-v1',
      applicability: 'Node 测试运行器断言失败时',
      failurePattern: 'Node 测试运行器报告断言失败',
      rootCause: { summary: '测试断言未通过，需要修复对应测试。', basis: 'hypothesis',
        evidenceIds: [evidenceId] },
      repairSteps: ['运行 node --test checks.test.mjs 查看失败断言'],
      verification: { check: 'node --test checks.test.mjs', expected: '测试报告所有用例通过' },
      instruction: '测试报告失败后检查对应断言，再运行 node --test checks.test.mjs。',
    }, { evidenceIds: [evidenceId], tokenHashes: evidenceTokenHashes(sourceEvidence) })
    assert.equal(reflected.ok, true, 'the fixture follows the real reflection output contract')
    const lesson = { ...reflected.lesson, problemId, evidenceRevision: 0, evidenceIds: [evidenceId] }
    const entry = { ...structuredClone(template), id: entryId, type: 'lesson', status: 'pending',
      instruction: lesson.instruction, applicability: lesson.applicability,
      exclusions: '', visibility: 'global', originScope: hash('scope'),
      originEnvironment: hash('environment'), originSession: sessionId, version: 1,
      problemSignature: hash('signature'), lesson }
    api.engine.store.transaction(doc => { doc.entries.push(entry); return true })

    const session = { id: sessionId, header: { cwd: dir }, events: [],
      get seq() { return this.events.length }, eventAt(n) { return this.events[n] } }
    const emitEvent = async event => { session.events.push(event); await ctx.emit('session/event', session, event) }
    const start = async (turn, prompt, expectedOffers = [{ id: entryId, version: 1 }]) => {
      await emitEvent({ type: 'turn/start', data: { turn } })
      const message = { id: `user-${turn}`, role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: prompt }] }
      await emitEvent({ type: 'user/message', data: message })
      await ctx.emit('agent/pre-step', { agent: { session }, step: 1, turn, messages: [message] },
        async payload => ({ kind: 'enter', messages: payload.messages }))
      const offers = api.engine.developmentRelevantOffers({ sessionId, turnId: String(turn),
        command: 'node --test checks.test.mjs' })
      assert.deepEqual(offers, expectedOffers)
      assert.deepEqual(api.engine.developmentRelevantOffers({ sessionId, turnId: String(turn),
        command: 'node --test another.test.mjs' }), [], 'an unrelated test command does not match the reflected method')
    }
    const tool = async ({ turn, command, stdout, exitCode = 0, callId, resultCallId = callId,
      resultStep = 1, persist = true }) => {
      const step = 1
      await emitEvent({ type: 'tool/call', name: 'bash', data: { turn, step, callId, name: 'bash',
        arguments: JSON.stringify({ description: 'Run the tests', command }) } })
      await ctx.emit('tools/result', { name: 'bash', callId, rootCallId: callId,
        agent: { session } }, { isError: false, value: { kind: 'foreground', cwd: dir,
        exitCode, signal: null, timedOut: false, aborted: false,
        stdout: { text: stdout, truncated: false }, stderr: { text: '', truncated: false } } })
      if (persist) await emitEvent({ type: 'tool/result', data: { turn,
        step: resultStep, message: { role: 'tool', source: { kind: 'tool', callId: resultCallId },
          toolCallId: resultCallId, isError: false,
          content: [{ type: 'text', text: stdout }], id: `result-${callId}` }, meta: {} } })
    }
    const end = (turn, kind = 'completed') => emitEvent({ type: 'turn/end',
      data: { turn, reason: { kind } } })
    const pass = '✔ actual assertion (1ms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 2\n'
    const fail = '✖ actual assertion (1ms)\nℹ tests 1\nℹ suites 0\nℹ pass 0\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 2\n\n✖ failing tests:\nAssertionError: expected 2 but got 1\n'
    const command = 'node --test checks.test.mjs'

    await start(1, '请修复测试失败并运行测试')
    await tool({ turn: 1, command, stdout: `${pass}\n/etc/passwd\n`, callId: 'call-outside' })
    await end(1)
    assert.equal(api.engine.store.read().checkEvents.length, 0, 'stdout paths outside the workspace are screened')

    await start(2, '请修复测试失败并运行测试')
    await tool({ turn: 2, command: 'echo fake && node --test checks.test.mjs', stdout: pass,
      callId: 'call-wrapper' })
    await end(2)
    assert.equal(api.engine.store.read().checkEvents.length, 0, 'a shell wrapper is not objective test evidence')

    await start(3, '请修复测试失败并运行测试')
    await tool({ turn: 3, command, stdout: pass, callId: 'call-mismatch', resultCallId: 'another-call' })
    await end(3)
    assert.equal(api.engine.store.read().checkEvents.length, 0, 'tool/result must name the same toolCallId')

    await start(4, '请修复测试失败并运行测试')
    await tool({ turn: 4, command, stdout: pass, callId: 'call-step-mismatch', resultStep: 2 })
    await end(4)
    assert.equal(api.engine.store.read().checkEvents.length, 0, 'tool/result must preserve the exact step')

    await start(5, '请修复测试失败并运行测试')
    await tool({ turn: 5, command, stdout: pass, callId: 'call-cancelled' })
    await end(5, 'aborted')
    assert.equal(api.engine.store.read().checkEvents.length, 0, 'a cancelled turn drops pending check credit')

    await start(6, '请修复测试失败并运行测试')
    await tool({ turn: 6, command, stdout: pass, callId: 'call-pass' })
    await end(6)
    let events = api.engine.store.read().checkEvents
    assert.equal(events.length, 1)
    assert.equal(events[0].checkId, 'node-test-runner-spec-v1')
    assert.equal(events[0].entryId, entryId)
    assert.equal(events[0].entryVersion, 1)
    assert.equal(events[0].passed, true)
    assert.deepEqual(events[0].summary, { kind: 'node_test_runner', tests: 1, passed: 1,
      failed: 0, skipped: 0, cancelled: 0, todo: 0 })
    assert.equal(api.engine.store.read().turnFacts.find(row =>
      row.turnKey === hash(JSON.stringify([sessionId, '6'])))?.outcome, 'unknown',
    'a passing test is evidence for that check only, not proof that the user task is complete')

    await start(7, '请修复测试失败并运行测试')
    await tool({ turn: 7, command, stdout: pass, callId: 'call-late', persist: false })
    await end(7)
    await emitEvent({ type: 'tool/result', data: { turn: 7, step: 1, message: { role: 'tool',
      source: { kind: 'tool', callId: 'call-late' }, toolCallId: 'call-late', isError: false,
      content: [{ type: 'text', text: pass }], id: 'result-call-late' }, meta: {} } })
    assert.equal(api.engine.store.read().checkEvents.length, 1,
      'a result event persisted after turn/end is never credited')

    await start(8, '请修复测试失败并运行测试')
    await tool({ turn: 8, command, stdout: fail, exitCode: 1, callId: 'call-stdout-fail' })
    await end(8)
    events = api.engine.store.read().checkEvents
    assert.equal(events.length, 2, 'stdout-only diagnostics still yield an attributable objective summary')
    assert.equal(events[1].passed, false)
    assert.deepEqual(events[1].summary, { kind: 'node_test_runner', tests: 1, passed: 0,
      failed: 1, skipped: 0, cancelled: 0, todo: 0 })
    const failedCapsule = api.engine.store.read().problemLoop.problems
      .flatMap(row => row.capsules ?? []).find(row => row.eventIdHash === hash('call-stdout-fail'))
    assert.ok(failedCapsule?.message?.includes('actual assertion'),
      'the screened stdout diagnostic is present in the failure capsule when stderr is empty')
    assert.ok(!JSON.stringify(events).includes('AssertionError'))
    assert.ok(!JSON.stringify(events).includes('checks.test.mjs'))

    await start(9, '请修复测试失败并运行测试', [])
    await tool({ turn: 9, command, stdout: pass, callId: 'call-warning-only' })
    await end(9)
    assert.equal(api.engine.store.read().checkEvents.length, 2,
      'a warning-mode offer is never credited as a development method')
  } finally {
    fiber?.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
