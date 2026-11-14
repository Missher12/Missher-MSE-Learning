import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import * as NativeTools from '@deepseek-ai/dsh-tool-executor-native'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import bundle from './root.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const PYTHON_NAME = ['python3', 'python', 'python3.exe', 'python.exe'].find(executable =>
  spawnSync(executable, ['-I', '-S', '-B', '-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8', timeout: 5000,
  }).status === 0) ?? null
const NATIVE_TEST_OPTIONS = PYTHON_NAME === null
  ? { skip: 'Python interpreter unavailable on this host' } : {}
const COMMAND = `${PYTHON_NAME ?? 'python3'} .mse-evolution/verify/check.py`
const INPUT_PATH = '.mse-evolution/verify/incoming.json'
const SCRIPT = `import json
from pathlib import Path
raw = Path(__file__).with_name("incoming.json").read_bytes()
while raw.startswith(b"\\xef\\xbb\\xbf"):
    raw = raw[3:]
config = json.loads(raw.decode("utf-8"))
print(json.dumps({"ok": True, "config": config}, ensure_ascii=False))
`
const WRONG_SCRIPT = SCRIPT.replace('{"ok": True, "config": config}', '{"ok": True, "config": {"wrong": True}}')

function validLesson(problemId, capsuleId, { business = false } = {}) {
  return { problemId, evidenceIds: [capsuleId],
    failurePattern: business ? 'intake.py fails because the loadedVersion guard is missing'
      : 'JSONDecodeError: Unexpected UTF-8 BOM',
    rootCause: { summary: business ? 'The loadedVersion check is absent' : 'Unexpected UTF-8 BOM reaches json.loads',
      basis: 'observed', evidenceIds: [capsuleId] },
    repairSteps: [business ? 'Restore the loadedVersion guard before accepting the intake'
      : 'Strip each UTF-8 BOM from the in-memory bytes before json.loads'],
    verification: { check: COMMAND, expected: business ? 'loadedVersion must match the incoming version'
      : 'exit code 0；stderr 不含 JSONDecodeError 或 Unexpected UTF-8 BOM；配置文件 BOM 未被删除。' },
  }
}

async function createHarness({ business = false } = {}) {
  const dir = mkdtempSync(join(homedir(), '.mse-python-native-pipeline-'))
  const verifyDir = join(dir, '.mse-evolution', 'verify')
  mkdirSync(verifyDir, { recursive: true })
  writeFileSync(join(verifyDir, 'check.py'), SCRIPT)
  writeFileSync(join(verifyDir, 'incoming.json'), Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify({ generation: 137, loadedVersion: 7, nested: { enabled: true } })),
  ]))

  const ctx = new Context().root
  const sessionId = `python-pipeline-${hash(dir).slice(0, 12)}`
  let sourceAllowed = true
  let afterToolsResult = null
  const observedToolResults = []
  const llmCalls = []
  ctx.provide('systemPrompt', { tools() { return () => {} } })
  ctx.provide('agents', {})
  ctx.provide('dshHomePath', name => join(dir, name))
  ctx.provide('llm', { async *stream(options) {
    llmCalls.push(options)
    const input = JSON.parse(options.messages[0].content[0].text)
    const evidenceId = input.evidenceIds.at(-1)
    const revised = { schema: 'mse-failure-lesson-v1',
      applicability: '处理 JSONDecodeError Unexpected UTF-8 BOM 的 Python 配置读取时',
      failurePattern: 'Python JSON/BOM objective check failed: output_mismatch',
      rootCause: { summary: 'UTF-8 BOM was not stripped before parsing', basis: 'observed',
        evidenceIds: [evidenceId] },
      repairSteps: ['Remove each UTF-8 BOM in memory before calling json.loads',
        'Compare the parsed configuration with the complete JSON source'],
      verification: { check: COMMAND,
        expected: 'exit code 0；stderr 不含 JSONDecodeError 或 Unexpected UTF-8 BOM；配置文件 BOM 未被删除。' },
      instruction: '解析 JSON 配置前逐层处理 UTF-8 BOM，并把结果与源数据比较',
    }
    yield { type: 'text-delta', text: JSON.stringify(revised) }
    yield { type: 'usage', usage: { inputTokens: 80, outputTokens: 80, totalTokens: 160 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } })
  class WorkspaceRegistryMirror extends Service {
    constructor(c) { super(c, 'workspaceRegistry') }
    list() { return [{ path: realpathSync(dir), sessionIds: sourceAllowed ? [sessionId] : [] }] }
  }

  await ctx.plugin(WorkspaceRegistryMirror)
  await ctx.plugin(ToolsService)
  await ctx.plugin(NativeTools)
  const sandboxFiber = ctx.registry.plugin(LocalSandboxProvider, {
    runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000,
  })
  await sandboxFiber
  const subprocessFiber = ctx.registry.plugin(LocalSubprocessRuntime)
  await subprocessFiber
  const mseFiber = ctx.registry.plugin(bundle, { modelProvider: 'fake-provider', modelId: 'fake-model',
    wakeIntervalMs: 60_000 })
  await mseFiber
  let nativeSandboxAvailable = false
  try {
    const probe = await ctx.sandbox.confine([PYTHON_NAME, '-I', '-S', '-B'],
      { mode: 'read-only', workspaceRoot: dir })
    nativeSandboxAvailable = probe?.enforcement === 'full'
  } catch { /* tests below skip unless the host reports actual full enforcement */ }
  const api = ctx.get('mseRebuild')
  api.engine.pause(true)
  api.engine.observeRoute({ sessionId, route: { provider: 'fake-provider', model: 'fake-model' } })
  const observed = api.engine.observeToolFailure({ sessionId, turnId: 'seed', projectKey: dir,
    callId: 'seed-bom-failure', toolName: PYTHON_NAME, failureCode: 'tool_nonzero_exit', exitCode: 1,
    stderr: 'JSONDecodeError: Unexpected UTF-8 BOM (decode using utf-8-sig)',
    command: `${PYTHON_NAME} check.py` })
  assert.equal(observed.ok, true)
  const problem = api.engine.store.read().problemLoop.problems.find(row => row.id === observed.id)
  assert.ok(problem?.capsules?.length)
  const capsuleId = problem.capsules.at(-1).id
  const entryId = `mem_${hash('native-python-json-bom-method').slice(0, 24)}`
  const lesson = validLesson(problem.id, capsuleId, { business })
  api.engine.store.transaction(doc => {
    doc.entries.push({ id: entryId, type: 'lesson', status: 'pending',
      instruction: '解析 JSON 配置前逐层处理 UTF-8 BOM，并把结果与源数据比较',
      applicability: 'Python 读取 UTF-8 BOM JSON 配置时', exclusions: '', visibility: 'global',
      originScope: hash('native-python-scope'), originEnvironment: hash('native-python-environment'),
      originSession: sessionId, lesson, problemSignature: problem.signature ?? hash('native-python-signature'),
      version: 1, parentVersion: null, superseded: null, injected: 0, recurrences: 0,
      createdAt: Date.now(), updatedAt: Date.now(), lastInjectedAt: null, evidenceHash: null,
      methodStats: { version: 1, since: Date.now(), coverage: 'complete', injected: 0,
        recurrences: 0, checkPasses: 0, checkFails: 0 }, factDigest: null, digestDay: null,
      importedFrom: null })
    const linked = doc.problemLoop.problems.find(row => row.id === problem.id)
    linked.lessonId = entryId
    linked.lessonVersion = 1
    linked.state = 'candidate_created'
    return true
  })

  ctx.on('tools/result', (exec, result) => {
    observedToolResults.push({ name: exec.name, callId: exec.callId, token: typeof exec.token,
      isError: result.isError, value: result.value })
    const sideEffect = afterToolsResult
    afterToolsResult = null
    sideEffect?.(exec)
  })
  const removeFailingTool = ctx.tools.register({
    name: 'bash', description: 'Integration fixture for a persisted non-zero foreground tool result.',
    parameters: {
      description: { type: 'string', required: true },
      command: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: false,
        required: ['kind', 'cwd', 'exitCode', 'timedOut', 'aborted', 'timeoutMs', 'stdout', 'stderr'],
        properties: {
          kind: { type: 'string' }, cwd: { type: 'string' }, exitCode: { type: 'integer' },
          timedOut: { type: 'boolean' }, aborted: { type: 'boolean' },
          timeoutMs: { type: 'integer' },
          stdout: { type: 'object', additionalProperties: false, required: ['text', 'truncated'],
            properties: { text: { type: 'string' }, truncated: { type: 'boolean' } } },
          stderr: { type: 'object', additionalProperties: false, required: ['text', 'truncated'],
            properties: { text: { type: 'string' }, truncated: { type: 'boolean' } } },
        } },
      render: () => [{ type: 'text', text: 'foreground command exited with code 1' }],
    },
    execute: () => ({ kind: 'foreground', cwd: dir, exitCode: 1, timedOut: false,
      aborted: false, timeoutMs: 60_000,
      stdout: { text: '', truncated: false },
      stderr: { text: 'AssertionError in foreground command', truncated: false } }),
  })

  const session = {
    id: sessionId,
    header: { cwd: dir },
    events: [],
    pendingEvents: [],
    skipResultCallIds: new Set(),
    get seq() { return this.events.length },
    eventAt(index) { return this.events[index] ?? null },
    append(type, data) {
      const message = data?.message
      const callId = type === 'tool/result'
        ? message?.source?.callId ?? message?.content?.find(part => part?.type === 'tool-result')?.toolCallId
        : null
      if (callId !== null && this.skipResultCallIds.delete(callId)) return { seq: this.events.length }
      const event = { type, data, seq: this.events.length }
      this.events.push(event)
      this.pendingEvents.push(Promise.resolve(ctx.emit('session/event', this, event)))
      return event
    },
    async flushEvents() {
      const rows = this.pendingEvents.splice(0)
      await Promise.all(rows)
    },
  }
  const agent = { session, options: { provider: 'fake-provider', model: 'fake-model' } }

  const startTurn = async (turn, prompt = 'Python 加载 UTF-8 BOM JSON 配置时发生 JSONDecodeError，请按方法处理') => {
    session.append('turn/start', { turn })
    await session.flushEvents()
    const message = { id: `user-${turn}`, role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: prompt }] }
    const decision = await ctx.emit('agent/pre-step', { agent, step: 1, turn, messages: [message] },
      async payload => ({ kind: 'enter', messages: payload.messages }))
    await session.flushEvents()
    return decision
  }
  const execute = async (turn, callId, script = '.mse-evolution/verify/check.py') => {
    const result = await ctx.tools.execute({ calls: [{ id: callId, name: 'mse_verify_python',
      arguments: JSON.stringify({ command: `${PYTHON_NAME} ${script}`, inputPath: INPUT_PATH }) }], agent,
      log: { turn, step: 1 }, signal: new AbortController().signal })
    await session.flushEvents()
    return result.results[0].result
  }
  const executeFailingTool = async (turn, callId) => {
    const result = await ctx.tools.execute({ calls: [{ id: callId, name: 'bash', arguments: JSON.stringify({
      description: 'Persist a real native foreground failure for precedence coverage.',
      command: 'node --test failed.test.mjs',
    }) }], agent, log: { turn, step: 2 }, signal: new AbortController().signal })
    await session.flushEvents()
    return result.results[0].result
  }
  const endTurn = async (turn, kind = 'completed') => {
    session.append('turn/end', { turn, reason: { kind } })
    await session.flushEvents()
  }
  const teardown = async () => {
    removeFailingTool()
    await mseFiber.dispose()
    await subprocessFiber.dispose()
    await sandboxFiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
  return { ctx, api, session, agent, entryId, problemId: problem.id, capsuleId, dir,
    startTurn, execute, executeFailingTool, endTurn, llmCalls, observedToolResults,
    nativeSandboxAvailable,
    setSourceAllowed(value) { sourceAllowed = value },
    setAfterToolsResult(fn) { afterToolsResult = fn }, teardown }
}

test('the Cordis native pipeline persists the Python result, settles verified, and revises from a new failed capsule', NATIVE_TEST_OPTIONS, async t => {
  const h = await createHarness()
  try {
    if (!h.nativeSandboxAvailable) { t.skip('native LocalSandboxProvider does not report full read-only enforcement here'); return }
    const definitions = h.ctx.tools.view(h.agent)
    assert.equal(definitions.knownNames.has('mse_verify_python'), true)
    await h.startTurn(1)
    assert.deepEqual(h.api.engine.developmentRelevantOffers({ sessionId: h.session.id, turnId: '1',
      command: COMMAND }), [{ id: h.entryId, version: 1 }])
    const pass = await h.execute(1, 'python-pass')
    assert.deepEqual(pass.value, { status: 'pass', reason: 'matched' })
    assert.ok(h.session.events.some(event => event.type === 'tool/call'
      && event.data.callId === 'python-pass'))
    assert.ok(h.session.events.some(event => event.type === 'tool/result'
      && event.data.message.source.callId === 'python-pass'
      && event.data.message.content[0]?.type === 'tool-result'
      && event.data.message.content[0]?.toolCallId === 'python-pass'))
    await h.endTurn(1)
    let doc = h.api.engine.store.read()
    assert.equal(doc.checkEvents.at(-1)?.passed, true, JSON.stringify({
      checks: doc.checkEvents, receipt: doc.receipts.at(-1), turn: doc.turnFacts.at(-1),
      observedToolResults: h.observedToolResults,
      skips: [...h.api.engine.collectionSkips], persistedResults: h.session.events
        .filter(event => event.type === 'tool/result').map(event => event.data.message),
    }))
    assert.equal(doc.checkEvents.at(-1)?.entryId, h.entryId)
    assert.equal(doc.checkEvents.at(-1)?.entryVersion, 1)
    assert.equal(doc.receipts.find(row => row.turnKey === hash(JSON.stringify([h.session.id, '1'])))?.outcome,
      'verified')
    assert.equal(doc.turnFacts.find(row => row.turnKey === hash(JSON.stringify([h.session.id, '1'])))?.outcome,
      'verified')

    await h.startTurn(2)
    writeFileSync(join(h.dir, '.mse-evolution', 'verify', 'check.py'), WRONG_SCRIPT)
    const fail = await h.execute(2, 'python-fail')
    assert.deepEqual(fail.value, { status: 'fail', reason: 'output_mismatch' })
    h.api.engine.pause(false)
    await h.endTurn(2)
    doc = h.api.engine.store.read()
    assert.equal(doc.checkEvents.at(-1)?.passed, false)
    assert.equal(doc.receipts.find(row => row.turnKey === hash(JSON.stringify([h.session.id, '2'])))?.outcome,
      'failed')
    const linked = doc.problemLoop.problems.find(row => row.id === h.problemId)
    const objectiveCapsule = linked.capsules.at(-1)
    assert.equal(objectiveCapsule.checkId, 'python-json-loader-v1')
    assert.match(objectiveCapsule.message, /output_mismatch/u)
    assert.notEqual(objectiveCapsule.id, h.capsuleId)
    assert.equal(objectiveCapsule.checkProof?.problemId, h.problemId)
    assert.equal(objectiveCapsule.checkProof?.entryId, h.entryId)
    assert.equal(objectiveCapsule.checkProof?.entryVersion, 1)
    assert.equal(objectiveCapsule.checkProof?.checkEventId, doc.checkEvents.at(-1)?.id)
    assert.equal(objectiveCapsule.checkProof?.originSessionId, h.session.id)
    assert.equal(doc.entries.find(row => row.id === h.entryId)?.status, 'needs_revision')

    for (let attempt = 0; attempt < 200
      && h.api.engine.store.read().entries.find(row => row.id === h.entryId)?.version === 1; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(h.llmCalls.length, 1, 'the fake provider receives the native check-failure revision')
    const request = JSON.parse(h.llmCalls[0].messages[0].content[0].text)
    assert.ok(request.evidenceIds.includes(objectiveCapsule.id))
    assert.ok(request.capsules.some(capsule => capsule.id === objectiveCapsule.id
      && capsule.message.includes('output_mismatch')))
    doc = h.api.engine.store.read()
    assert.equal(doc.entries.find(row => row.id === h.entryId)?.version, 2)
    assert.equal(doc.entries.find(row => row.id === h.entryId)?.status, 'pending')
    const revised = doc.entries.find(row => row.id === h.entryId)
    assert.deepEqual(revised.lesson.evidenceIds, [objectiveCapsule.id],
      'the revision cites the new objective failure capsule rather than borrowing the original source capsule')
    assert.equal(objectiveCapsule.checkEventId, doc.checkEvents.at(-1)?.id,
      'the failure capsule carries the exact persisted checker event identity')

    writeFileSync(join(h.dir, '.mse-evolution', 'verify', 'check.py'), SCRIPT)
    await h.startTurn(3)
    assert.deepEqual(h.api.engine.developmentRelevantOffers({ sessionId: h.session.id, turnId: '3',
      command: COMMAND }), [{ id: h.entryId, version: 2 }],
    'the audited check-failure capsule keeps the same-problem revised method objectively verifiable')
    const rechecked = await h.execute(3, 'revised-python-check')
    assert.deepEqual(rechecked.value, { status: 'pass', reason: 'matched' })
    await h.endTurn(3)
    doc = h.api.engine.store.read()
    assert.equal(doc.checkEvents.at(-1)?.passed, true)
    assert.equal(doc.checkEvents.at(-1)?.entryId, h.entryId)
    assert.equal(doc.checkEvents.at(-1)?.entryVersion, 2)
    assert.equal(doc.receipts.find(row => row.turnKey === hash(JSON.stringify([h.session.id, '3'])))?.outcome,
      'verified')
    const archivedV1 = doc.methodHistory.find(row => row.entryId === h.entryId && row.version === 1)
    assert.equal(archivedV1.stats.checkPasses, 1,
      'the successful recheck is credited only to v2, leaving v1 counts unchanged')
    assert.equal(archivedV1.stats.checkFails, 1)
    assert.equal(doc.entries.find(row => row.id === h.entryId)?.methodStats.checkPasses, 1)
    assert.equal(doc.entries.find(row => row.id === h.entryId)?.methodStats.checkFails, 0)
  } finally { await h.teardown() }
})

test('unsupported Python business checks and unpaired, missing, cancelled, stale, or withdrawn results get no credit', NATIVE_TEST_OPTIONS, async t => {
  const h = await createHarness({ business: true })
  try {
    if (!h.nativeSandboxAvailable) { t.skip('native LocalSandboxProvider does not report full read-only enforcement here'); return }
    await h.startTurn(1)
    assert.deepEqual(h.api.engine.developmentRelevantOffers({ sessionId: h.session.id, turnId: '1',
      command: COMMAND }), [], 'loadedVersion business invariants are outside JSON/BOM scope')
    const unsupported = await h.execute(1, 'python-business')
    assert.deepEqual(unsupported.value, { status: 'unknown', reason: 'no_unique_offer' })
    await h.endTurn(1)
    assert.equal(h.api.engine.store.read().checkEvents.length, 0)
  } finally { await h.teardown() }

  for (const mode of ['forged', 'missing-result', 'cancelled', 'withdrawn', 'stale-version']) {
    const x = await createHarness()
    try {
      if (!x.nativeSandboxAvailable) { t.skip('native LocalSandboxProvider does not report full read-only enforcement here'); return }
      await x.startTurn(1)
      if (mode === 'forged') {
        const callId = 'forged-python-call'
        x.session.append('tool/call', { turn: 1, step: 1, callId, name: 'mse_verify_python',
          arguments: JSON.stringify({ command: COMMAND, inputPath: INPUT_PATH }) })
        await x.session.flushEvents()
        await x.ctx.emit('tools/result', { name: 'mse_verify_python', callId, rootCallId: callId,
          token: Symbol('forged'), agent: x.agent }, { isError: false,
          value: { status: 'pass', reason: 'matched' } })
      } else if (mode === 'missing-result') {
        x.session.skipResultCallIds.add('missing-persisted-result')
        const result = await x.execute(1, 'missing-persisted-result')
        assert.deepEqual(result.value, { status: 'pass', reason: 'matched' })
      } else {
        if (mode === 'withdrawn') x.setAfterToolsResult(() => x.setSourceAllowed(false))
        if (mode === 'stale-version') x.setAfterToolsResult(() => x.api.engine.store.transaction(doc => {
          const entry = doc.entries.find(row => row.id === x.entryId)
          entry.version = 2
          entry.parentVersion = 1
          entry.methodStats = { version: 2, since: Date.now(), coverage: 'complete', injected: 0,
            recurrences: 0, checkPasses: 0, checkFails: 0 }
          return true
        }))
        const result = await x.execute(1, `${mode}-python`)
        assert.deepEqual(result.value, { status: 'pass', reason: 'matched' })
      }
      await x.endTurn(1, mode === 'cancelled' ? 'aborted' : 'completed')
      const doc = x.api.engine.store.read()
      assert.equal(doc.checkEvents.length, 0, `${mode} is not a creditable Python check`)
      assert.equal(doc.entries.find(row => row.id === x.entryId)?.methodStats?.checkPasses ?? 0, 0)
    } finally { await x.teardown() }
  }
})

test('a real native foreground failure outranks a persisted Python checker pass at turn end', NATIVE_TEST_OPTIONS, async t => {
  const h = await createHarness()
  try {
    if (!h.nativeSandboxAvailable) { t.skip('native LocalSandboxProvider does not report full read-only enforcement here'); return }
    await h.startTurn(1)
    const checked = await h.execute(1, 'python-pass-with-failure')
    assert.deepEqual(checked.value, { status: 'pass', reason: 'matched' })
    const failed = await h.executeFailingTool(1, 'native-foreground-fail')
    assert.equal(failed.isError, false)
    assert.equal(failed.value.exitCode, 1)
    await h.endTurn(1)
    const doc = h.api.engine.store.read()
    assert.equal(doc.checkEvents.at(-1)?.passed, true,
      'the exact successful JSON/BOM method check remains a method-level fact')
    assert.equal(doc.receipts.find(row => row.turnKey === hash(JSON.stringify([h.session.id, '1'])))?.outcome,
      'failed', 'a real tool failure has terminal priority over a Python checker pass')
    assert.equal(doc.turnFacts.find(row => row.turnKey === hash(JSON.stringify([h.session.id, '1'])))?.outcome,
      'failed')
  } finally { await h.teardown() }
})
