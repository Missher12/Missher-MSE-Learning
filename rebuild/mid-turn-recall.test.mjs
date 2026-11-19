import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { RebuildEngine } from './engine.mjs'
import { MID_TURN_FAILURE_FIXTURE_IDS, MID_TURN_OPERATION_FIXTURE_IDS,
  classifyMidTurnFailure, midTurnOperation } from './mid-turn-recall.mjs'
import bundle from './root.mjs'
import { RECALL_TOKEN_UNIT } from './recall-budget.mjs'

const probes = join(dirname(fileURLToPath(import.meta.url)), '.probes-mid-turn')
mkdirSync(probes, { recursive: true })
const root = () => mkdtempSync(join(probes, 'run-'))
const workRoot = root()
test.after(() => rmSync(probes, { recursive: true, force: true }))

async function mountRegistryMirror(ctx, rows) {
  const { Service } = await import('@deepseek-ai/cordis')
  class WorkspaceRegistryMirror extends Service {
    constructor(c) { super(c, 'workspaceRegistry') }
    list() { return rows }
  }
  await ctx.plugin(WorkspaceRegistryMirror)
}

function lesson({ id, instruction, applicability, failurePattern, check }) {
  const evidenceId = 'd'.repeat(64)
  return { id: `mem_${id}`, type: 'lesson', status: 'pending', instruction, applicability,
    exclusions: '', visibility: 'global', originScope: 'a'.repeat(64),
    originEnvironment: 'b'.repeat(64), originSession: null,
    lesson: { problemId: 'c'.repeat(64), evidenceIds: [evidenceId], failurePattern,
      repairSteps: ['复现问题', '按结果修复'], verification: { check, expected: '通过' } },
    problemSignature: null, version: 1, parentVersion: null, superseded: null,
    injected: 0, recurrences: 0, createdAt: 1, updatedAt: 1, lastInjectedAt: null,
    evidenceHash: null, factDigest: null, digestDay: null, importedFrom: null,
    sourceDigest: null }
}

test('R23 native rc.4 failure recalls one matching lesson before the next entered request', async () => {
  const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/native-a3-diagnostic.json', import.meta.url), 'utf8'))
  const id = 'mse-mid-turn-native'
  const dir = root()
  const session = Session.create(id, undefined, { ...Session.create(id).header, cwd: dir })
  const ctx = new Context().root
  ctx.provide('agents', {})
  ctx.provide('tools', {})
  ctx.provide('llm', { async * stream() { throw new Error('unexpected provider call') } })
  ctx.provide('dshHomePath', name => join(workRoot, name))
  await mountRegistryMirror(ctx, [{ path: realpathSync(dir), sessionIds: [id] }])
  const fiber = ctx.registry.plugin(bundle, {})
  await fiber
  try {
    const engine = ctx.get('mseRebuild').engine
    const midTurnQueries = []
    const midTurnTokens = []
    const prepareMidTurnRecall = engine.prepareMidTurnRecall.bind(engine)
    engine.prepareMidTurnRecall = options => {
      midTurnQueries.push(options)
      const selected = prepareMidTurnRecall(options)
      midTurnTokens.push(selected.contextTokens ?? 0)
      return selected
    }
    const base = lesson({ id: '111111111111111111111111',
      instruction: '运行 Node 测试前先确认测试范围，再根据失败结果定位断言',
      applicability: '运行 Node 测试时', failurePattern: '测试断言失败', check: 'node --test' })
    const json = lesson({ id: '222222222222222222222222',
      instruction: '解析 JSON 前先检查并删除尾随逗号，再用 JSON.parse 验收',
      applicability: '解析 JSON 文件出现语法错误时', failurePattern: 'JSONDecodeError 尾随逗号',
      check: 'JSON.parse' })
    engine.store.transaction(doc => { doc.entries.push(base, json); return true })
    const emit = (type, ...args) => ctx.emit(type, ...args)
    const send = async (step, messages) => {
      return await ctx.waterfall('agent/pre-step', { agent: { session }, step, turn: 1, messages },
        async () => ({ kind: 'enter', messages }))
    }
    const user = { id: 'native-user-1', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '请更新 README 并运行 Node 测试，整理失败项' }] }
    await emit('session/event', session, session.append('turn/start', { turn: 1 }))
    const first = await send(1, [user])
    assert.ok(first.messages.some(message => message?.content?.some(part =>
      part?.type === 'text' && part.text.includes('运行 Node 测试前'))))
    assert.ok(!first.messages.some(message => message?.content?.some(part =>
      part?.type === 'text' && part.text.includes('删除尾随逗号'))),
    'the first-step selection must not already contain the failure-specific method')
    const receiptBefore = structuredClone(engine.store.read().receipts.at(-1))
    assert.equal(receiptBefore.budgetUnit, RECALL_TOKEN_UNIT)
    assert.equal(receiptBefore.budgetLimit, 512)
    assert.ok(receiptBefore.contextTokens <= 512)
    const turnKey = receiptBefore.turnKey
    assert.ok(receiptBefore.offered.some(row => row.id === base.id))
    assert.ok(!receiptBefore.offered.some(row => row.id === json.id))

    const args = JSON.stringify({ command: 'python3 scripts/check_json.py' })
    await emit('session/event', session, session.append('assistant/message', { turn: 1, step: 1,
      message: { role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture-model' },
        content: [{ type: 'tool-call', id: 'failure-1', name: 'bash', arguments: args }] } },
    { surfaceOp: 'append' }))
    await emit('session/event', session, session.append('tool/call', { turn: 1, step: 1,
      callId: 'failure-1', name: 'bash', arguments: args }))
    const result = { isError: false, value: { exitCode: 1, cwd: dir,
      stdout: { text: '', truncated: false }, stderr: { text: fixture.text, truncated: false } } }
    await emit('tools/result', { agent: { session }, callId: 'failure-1', rootCallId: 'failure-1',
      name: 'bash', signal: new AbortController().signal }, result)
    assert.equal(engine.store.read().turnFacts.find(row => row.sessionId === id)?.failures, 1,
      'the rc.4 tools/result reached the existing admitted-failure path')
    const nativeResult = session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'failure-1', isError: false,
        content: [{ type: 'text', text: 'Process failed with exit code 1.' }] }) }, { surfaceOp: 'append' })
    await emit('session/event', session, nativeResult)
    const receiptAfterFailure = structuredClone(engine.store.read().receipts.at(-1))
    assert.deepEqual(receiptAfterFailure.offered, receiptBefore.offered,
      'the failure remains attributed to the pre-tool offer set')

    const second = await send(2, [user])
    assert.equal(midTurnQueries.length, 1, 'one exact persisted failure queues one local query')
    assert.ok(!midTurnQueries[0].prompt.includes(fixture.text)
      && !midTurnQueries[0].prompt.includes('python3 scripts/check_json.py'),
    'the retrieval query contains only fixed diagnostic/task labels')
    assert.ok(second.messages.some(message => message?.content?.some(part =>
      part?.type === 'text' && part.text.includes('删除尾随逗号'))),
    'the matching lesson should be available before the next entered model request')
    assert.ok(receiptBefore.contextTokens + midTurnTokens[0] <= 512,
      'the failure follow-up includes its own message prefix in the shared turn estimate')
    assert.deepEqual(engine.store.read().receipts.at(-1), receiptAfterFailure,
      'mid-turn recall must not change receipt outcome or efficacy attribution')
    assert.equal(engine.store.read().entries.find(row => row.id === json.id).injected, 1)
    const probe = engine.store.read().recallStrategy.adaptive.probes.find(row => row.turnKey === turnKey)
    assert.ok(probe, 'the first step created the ordinary RRSI probe')
    assert.equal(probe.offered.some(row => row.id === json.id), false,
    'the later lesson cannot be added to the earlier RRSI sample')

    const passText = '✔ actual assertion (1ms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 2\n'
    const pass = { isError: false, value: { kind: 'foreground', cwd: dir, exitCode: 0,
      signal: null, timedOut: false, aborted: false, timeoutMs: 60_000,
      stdout: { text: passText, truncated: false }, stderr: { text: '', truncated: false } } }
    const check = async (step, callId) => {
      const checkArgs = JSON.stringify({ command: 'node --test checks.test.mjs' })
      const assistant = session.append('assistant/message', { turn: 1, step, message: {
        role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture-model' },
        content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: checkArgs }],
      } }, { surfaceOp: 'append' })
      await emit('session/event', session, assistant)
      const call = session.append('tool/call', { turn: 1, step, callId, name: 'bash', arguments: checkArgs })
      await emit('session/event', session, call)
      await emit('tools/result', { agent: { session }, callId, rootCallId: callId,
        name: 'bash', signal: new AbortController().signal }, pass)
      const resultEvent = session.append('tool/result', { turn: 1, step,
        message: createToolResultMessage({ callId, isError: false,
          content: [{ type: 'text', text: passText }] }) }, { surfaceOp: 'append' })
      await emit('session/event', session, resultEvent)
    }
    await check(2, 'repeat-after-failure-1')
    const thirdStep = await send(3, [user])
    assert.equal(midTurnQueries.length, 1, 'one successful stage is not a repetition')
    await check(3, 'repeat-after-failure-2')
    engine.setRecallBudget({ unit: RECALL_TOKEN_UNIT, limit: 128 })
    await send(4, [user])
    assert.equal(midTurnQueries.length, 2,
      'a later distinct repeated operation still gets its own query after the failure query')
    assert.ok(midTurnQueries[1].prompt.includes('suite validation stage'))
    assert.equal(midTurnQueries[1].maxTokens, 0, 'the lower live token ceiling is enforced cumulatively')
    assert.ok(engine.statusView().collection.skipped.some(row => row.reason === '本回合召回预算已用完'),
      'an exhausted budget returns a readable local reason')
    assert.ok(thirdStep.kind === 'enter')
  } finally { fiber.dispose() }
})

async function makeNativeHost(sessionIds) {
  const dir = root()
  const stateRoot = root()
  const sessions = new Map(sessionIds.map(id => [id,
    Session.create(id, undefined, { ...Session.create(id).header, cwd: dir })]))
  const ctx = new Context().root
  ctx.provide('agents', {})
  ctx.provide('tools', {})
  ctx.provide('llm', { async * stream() { throw new Error('unexpected provider call') } })
  ctx.provide('dshHomePath', name => join(stateRoot, name))
  await mountRegistryMirror(ctx, [{ path: realpathSync(dir), sessionIds }])
  const fiber = ctx.registry.plugin(bundle, {})
  await fiber
  const emit = (type, ...args) => ctx.emit(type, ...args)
  const enter = (session, turn, step, messages) => ctx.waterfall('agent/pre-step',
    { agent: { session }, turn, step, messages }, async () => ({ kind: 'enter', messages }))
  const start = async (session, turn, text) => {
    await emit('session/event', session, session.append('turn/start', { turn }))
    const message = { id: `${session.id}-user-${turn}`, role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text }] }
    return { message, decision: await enter(session, turn, 1, [message]) }
  }
  const nativeTool = async (session, { turn, step, callId, command, result, resultText = 'completed',
    persisted = true, resultCallId = callId, resultStep = step }) => {
    const args = JSON.stringify({ command })
    const assistant = session.append('assistant/message', { turn, step, message: {
      role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture-model' },
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: args }],
    } }, { surfaceOp: 'append' })
    await emit('session/event', session, assistant)
    const call = session.append('tool/call', { turn, step, callId, name: 'bash', arguments: args })
    await emit('session/event', session, call)
    await emit('tools/result', { agent: { session }, callId, rootCallId: callId,
      name: 'bash', signal: new AbortController().signal }, result)
    if (!persisted) return null
    const nativeResult = session.append('tool/result', { turn, step: resultStep,
      message: createToolResultMessage({ callId: resultCallId, isError: result?.isError === true,
        content: [{ type: 'text', text: resultText }] }) }, { surfaceOp: 'append' })
    await emit('session/event', session, nativeResult)
    return nativeResult
  }
  return { dir, sessions, ctx, fiber, engine: ctx.get('mseRebuild').engine, emit, enter, start, nativeTool }
}

test('public diagnostic fixture categories are closed and do not invent a JSON cause', () => {
  const categories = JSON.parse(readFileSync(
    new URL('../tests/fixtures/mid-turn-recall-categories.json', import.meta.url), 'utf8'))
  assert.deepEqual(MID_TURN_FAILURE_FIXTURE_IDS, categories.failure_categories)
  assert.deepEqual(MID_TURN_OPERATION_FIXTURE_IDS, categories.operation_check_ids)
  const native = JSON.parse(readFileSync(
    new URL('../tests/fixtures/native-a3-diagnostic.json', import.meta.url), 'utf8'))
  assert.equal(classifyMidTurnFailure('tool_nonzero_exit', native.text)?.category, 'json_trailing_comma')
  assert.equal(classifyMidTurnFailure('tool_error_flag', 'JSONDecodeError: Unterminated string')?.category,
    'json_parse_error')
  assert.equal(classifyMidTurnFailure('tool_nonzero_exit', 'JSONDecodeError token=fixture-secret'), null,
    'sensitive diagnostic text yields no query class')
  assert.equal(midTurnOperation('bash', ['test']), null, 'a generic shell command is not an operation class')
  assert.equal(midTurnOperation('node-test-runner-spec-v1', ['doc']), null,
    'the test stage must match the frozen task feature')
  assert.equal(midTurnOperation('node-test-runner-spec-v1', ['test'])?.category, 'test_stage')
})

test('read-only mid-turn selector keeps a project rule local to its project and environment', () => {
  const engine = new RebuildEngine({ stateRoot: root() })
  engine.setSourceGuard(() => true)
  engine.setMaterialGuard(() => true)
  const saved = engine.recordCorrection({ text: '修改 JSON 配置前先检查语法并保留现有字段',
    sessionId: 'scope-session', turnId: 'saved', projectKey: '/repo/project-a' })
  assert.equal(saved.ok, true)
  const shared = { sessionId: 'scope-session', turnId: 'active', prompt: 'JSON configuration parse syntax',
    maxBytes: 768, maxMethods: 2, maxGuards: 1 }
  const same = engine.prepareMidTurnRecall({ ...shared, projectKey: '/repo/project-a' })
  assert.equal(same.ok, true)
  assert.ok(same.context.includes('保留现有字段'), 'the same project can recall its saved rule')
  const other = engine.prepareMidTurnRecall({ ...shared, projectKey: '/repo/project-b' })
  assert.equal(other.ok, true)
  assert.equal(other.offered.length, 0, 'the project rule cannot leak into another project')
})

test('a second objectively repeated test stage queues one query and can use the remaining method slot', async () => {
  const id = 'mse-midturn-repeat-native'
  const host = await makeNativeHost([id])
  try {
    const session = host.sessions.get(id)
    const base = lesson({ id: '333333333333333333333333',
      instruction: '运行 Node 测试时先查看失败断言，再整理具体修复办法',
      applicability: '运行 Node 测试时', failurePattern: '测试断言失败', check: 'node --test checks.test.mjs' })
    const repeated = lesson({ id: '444444444444444444444444',
      instruction: 'After two consecutive suite validation passes, verify stage completion and report the result',
      applicability: 'suite validation stage', failurePattern: 'suite validation passed twice',
      check: 'node --test checks.test.mjs' })
    host.engine.store.transaction(doc => { doc.entries.push(base, repeated); return true })
    const queries = []
    const selectionTokens = []
    const originalPrepare = host.engine.prepareMidTurnRecall.bind(host.engine)
    host.engine.prepareMidTurnRecall = options => {
      queries.push(options)
      const selected = originalPrepare(options)
      selectionTokens.push(selected.contextTokens ?? 0)
      return selected
    }
    const { message, decision: first } = await host.start(session, 3,
      '请更新 README 并运行 Node 测试，整理失败项')
    const offeredText = decision => decision.messages.flatMap(item => item?.content ?? [])
      .filter(part => part.type === 'text').map(part => part.text).join('\n')
    assert.ok(offeredText(first).includes('查看失败断言'))
    assert.ok(!offeredText(first).includes('two consecutive suite validation passes'),
      'the repeat-only method is not included before the repeated stage exists')
    const receiptBefore = structuredClone(host.engine.store.read().receipts.at(-1))
    const passText = '✔ actual assertion (1ms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 2\n'
    const pass = { isError: false, value: { kind: 'foreground', cwd: host.dir, exitCode: 0,
      signal: null, timedOut: false, aborted: false, timeoutMs: 60_000,
      stdout: { text: passText, truncated: false }, stderr: { text: '', truncated: false } } }
    await host.nativeTool(session, { turn: 3, step: 1, callId: 'test-stage-1',
      command: 'node --test checks.test.mjs', result: pass, resultText: passText })
    const second = await host.enter(session, 3, 2, [message])
    assert.equal(queries.length, 0, 'one check is not a repeated operation')
    await host.nativeTool(session, { turn: 3, step: 2, callId: 'test-stage-2',
      command: 'node --test checks.test.mjs', result: pass, resultText: passText })
    const third = await host.enter(session, 3, 3, [message])
    assert.equal(queries.length, 1, 'the second durable check queues one read-only query')
    assert.ok(queries[0].prompt.includes('suite validation'))
    assert.ok(!queries[0].prompt.includes('checks.test.mjs') && !queries[0].prompt.includes(passText),
      'operation retrieval uses only fixed task/category labels')
    assert.ok(offeredText(third).includes('two consecutive suite validation passes'),
      'the repeat-specific lesson is recalled at the next model step')
    assert.ok(receiptBefore.contextTokens + selectionTokens[0] <= 512,
      'the repeated-operation follow-up consumes only the remaining turn budget')
    assert.deepEqual(host.engine.store.read().receipts.at(-1), receiptBefore,
      'the later query does not rewrite the first request receipt')
    assert.equal(host.engine.store.read().entries.find(row => row.id === repeated.id).injected, 1)
    await host.nativeTool(session, { turn: 3, step: 3, callId: 'test-stage-3',
      command: 'node --test checks.test.mjs', result: pass, resultText: passText })
    await host.enter(session, 3, 4, [message])
    assert.equal(queries.length, 1, 'the same normalized operation class triggers at most once per turn')
    assert.ok(second.kind === 'enter')
  } finally { host.fiber.dispose() }
})

test('mid-turn setting changes across budget units skip the queued recall without throwing', async () => {
  const fixture = JSON.parse(readFileSync(
    new URL('../tests/fixtures/native-a3-diagnostic.json', import.meta.url), 'utf8'))
  const id = 'mse-midturn-budget-switch'
  const host = await makeNativeHost([id])
  try {
    const session = host.sessions.get(id)
    const { message } = await host.start(session, 91, '请更新 README 并检查 JSON 解析错误')
    let recallCalls = 0
    const original = host.engine.prepareMidTurnRecall.bind(host.engine)
    host.engine.prepareMidTurnRecall = options => { recallCalls += 1; return original(options) }
    host.engine.setRecallBudget({ unit: 'bytes', limit: 512 })
    const failed = { isError: false, value: { exitCode: 1, cwd: host.dir,
      stdout: { text: '', truncated: false }, stderr: { text: fixture.text, truncated: false } } }
    await host.nativeTool(session, { turn: 91, step: 1, callId: 'budget-switch-failure',
      command: 'python3 scripts/check_json.py', result: failed, resultText: 'Process failed with exit code 1.' })
    const next = await host.enter(session, 91, 2, [message])
    assert.equal(recallCalls, 0, 'a token-budget turn never passes old bytes into the new byte selector')
    assert.ok(host.engine.statusView().collection.skipped.some(row =>
      row.reason === 'mid_turn_budget_unit_changed'))
    assert.equal(next.kind, 'enter')
  } finally { host.fiber.dispose() }
})

test('failure recall requires an exact durable pair, refuses outside material, and releases a rejected reservation', async () => {
  const id = 'mse-midturn-pair-native'
  const host = await makeNativeHost([id])
  try {
    const session = host.sessions.get(id)
    const json = lesson({ id: '555555555555555555555555',
      instruction: '解析 JSON 前先检查并删除尾随逗号，再用 JSON.parse 验收',
      applicability: '解析 JSON 文件出现语法错误时', failurePattern: 'JSONDecodeError 尾随逗号',
      check: 'JSON.parse' })
    host.engine.store.transaction(doc => { doc.entries.push(json); return true })
    const queries = []
    const originalPrepare = host.engine.prepareMidTurnRecall.bind(host.engine)
    host.engine.prepareMidTurnRecall = options => {
      queries.push(options)
      return originalPrepare(options)
    }
    const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/native-a3-diagnostic.json', import.meta.url), 'utf8'))
    const { message } = await host.start(session, 7, '请更新 README 并运行 Node 测试，整理失败项')
    const failure = { isError: false, value: { exitCode: 1, cwd: host.dir,
      stdout: { text: '', truncated: false }, stderr: { text: fixture.text, truncated: false } } }

    await host.nativeTool(session, { turn: 7, step: 1, callId: 'not-yet-durable',
      command: 'python3 scripts/check_json.py', result: failure, persisted: false })
    await host.enter(session, 7, 2, [message])
    assert.equal(queries.length, 0, 'an in-memory failure without a durable native result cannot trigger recall')

    const wrongStep = session.append('tool/result', { turn: 7, step: 2,
      message: createToolResultMessage({ callId: 'not-yet-durable', isError: false,
        content: [{ type: 'text', text: 'Process failed with exit code 1.' }] }) }, { surfaceOp: 'append' })
    await host.emit('session/event', session, wrongStep)
    assert.equal(queries.length, 0, 'a result logged under a different step does not pair with the failure')

    const refusedMaterial = session.append('tool/result', { turn: 7, step: 1,
      message: createToolResultMessage({ callId: 'not-yet-durable', isError: false,
        content: [{ type: 'text', text: 'Diagnostic references /etc/passwd' }] }) }, { surfaceOp: 'append' })
    await host.emit('session/event', session, refusedMaterial)

    await host.nativeTool(session, { turn: 7, step: 2, callId: 'eligible-after-refusal',
      command: 'python3 scripts/check_json.py', result: failure })
    const recovered = await host.enter(session, 7, 3, [message])
    assert.equal(queries.length, 1, 'a rejected durable candidate releases the once-per-turn reservation')
    assert.ok(recovered.messages.some(item => item?.content?.some(part =>
      part?.type === 'text' && part.text.includes('删除尾随逗号'))))
  } finally { host.fiber.dispose() }
})

test('a real turn start stays valid after more than 400 same-turn step events', async () => {
  const id = 'mse-midturn-long-native'
  const host = await makeNativeHost([id])
  try {
    const session = host.sessions.get(id)
    const json = lesson({ id: '777777777777777777777777',
      instruction: '解析 JSON 前先检查并删除尾随逗号，再用 JSON.parse 验收',
      applicability: '解析 JSON 文件出现语法错误时', failurePattern: 'JSONDecodeError 尾随逗号',
      check: 'JSON.parse' })
    host.engine.store.transaction(doc => { doc.entries.push(json); return true })
    const queries = []
    const originalPrepare = host.engine.prepareMidTurnRecall.bind(host.engine)
    host.engine.prepareMidTurnRecall = options => {
      queries.push(options)
      return originalPrepare(options)
    }
    const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/native-a3-diagnostic.json', import.meta.url), 'utf8'))
    const { message } = await host.start(session, 9, '请更新 README 并运行 Node 测试，整理失败项')
    for (let step = 2; step <= 201; step += 1) {
      for (const type of ['step/start', 'step/end']) {
        await host.emit('session/event', session, session.append(type, { turn: 9, step }))
      }
    }
    await host.emit('session/event', session, session.append('step/start', { turn: 9, step: 202 }))
    assert.ok(session.seq > 400, 'the native event log exceeds the former active-turn lookback')
    const failure = { isError: false, value: { exitCode: 1, cwd: host.dir,
      stdout: { text: '', truncated: false }, stderr: { text: fixture.text, truncated: false } } }
    await host.nativeTool(session, { turn: 9, step: 202, callId: 'late-turn-failure',
      command: 'python3 scripts/check_json.py', result: failure })
    const next = await host.enter(session, 9, 203, [message])
    assert.equal(queries.length, 1, 'the stored turn/start sequence validates the same live turn without a tail scan')
    assert.ok(next.messages.some(item => item?.content?.some(part =>
      part?.type === 'text' && part.text.includes('删除尾随逗号'))))
  } finally { host.fiber.dispose() }
})

test('cancellation closes pending state and parallel sessions keep their triggers isolated', async () => {
  const cancelledId = 'mse-midturn-cancel-native'
  const firstId = 'mse-midturn-isolated-a'
  const secondId = 'mse-midturn-isolated-b'
  const host = await makeNativeHost([cancelledId, firstId, secondId])
  try {
    const json = lesson({ id: '666666666666666666666666',
      instruction: '解析 JSON 前先检查并删除尾随逗号，再用 JSON.parse 验收',
      applicability: '解析 JSON 文件出现语法错误时', failurePattern: 'JSONDecodeError 尾随逗号',
      check: 'JSON.parse' })
    host.engine.store.transaction(doc => { doc.entries.push(json); return true })
    const queries = []
    const originalPrepare = host.engine.prepareMidTurnRecall.bind(host.engine)
    host.engine.prepareMidTurnRecall = options => {
      queries.push(options)
      return originalPrepare(options)
    }
    const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/native-a3-diagnostic.json', import.meta.url), 'utf8'))
    const failure = { isError: false, value: { exitCode: 1, cwd: host.dir,
      stdout: { text: '', truncated: false }, stderr: { text: fixture.text, truncated: false } } }
    const cancelled = host.sessions.get(cancelledId)
    const cancelledStart = await host.start(cancelled, 1, '请更新 README 并运行 Node 测试，整理失败项')
    await host.nativeTool(cancelled, { turn: 1, step: 1, callId: 'cancelled-failure',
      command: 'python3 scripts/check_json.py', result: failure, persisted: false })
    await host.emit('session/event', cancelled, cancelled.append('turn/cancel', { turn: 1 }))
    const lateResult = cancelled.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'cancelled-failure', isError: false,
        content: [{ type: 'text', text: 'Process failed with exit code 1.' }] }) }, { surfaceOp: 'append' })
    await host.emit('session/event', cancelled, lateResult)
    await host.enter(cancelled, 1, 2, [cancelledStart.message])
    assert.equal(queries.length, 0, 'cancellation closes pending and late-persisted failure candidates')

    const first = host.sessions.get(firstId)
    const second = host.sessions.get(secondId)
    const firstStart = await host.start(first, 4, '请更新 README 并运行 Node 测试，整理失败项')
    const secondStart = await host.start(second, 4, '请更新 README 并运行 Node 测试，整理失败项')
    await host.nativeTool(first, { turn: 4, step: 1, callId: 'session-a-failure',
      command: 'python3 scripts/check_json.py', result: failure })
    await host.enter(second, 4, 2, [secondStart.message])
    assert.equal(queries.length, 0, 'session A cannot trigger a query in session B')
    const firstNext = await host.enter(first, 4, 2, [firstStart.message])
    assert.equal(queries.length, 1, 'session A can consume only its own paired trigger')
    assert.ok(firstNext.messages.some(item => item?.content?.some(part =>
      part?.type === 'text' && part.text.includes('删除尾随逗号'))))
    await host.nativeTool(second, { turn: 4, step: 2, callId: 'session-b-failure',
      command: 'python3 scripts/check_json.py', result: failure })
    await host.enter(second, 4, 3, [secondStart.message])
    assert.equal(queries.length, 2, 'session B can recall only after its own durable failure pair')
  } finally { host.fiber.dispose() }
})
