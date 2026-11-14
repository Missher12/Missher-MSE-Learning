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
import SystemPrompt, { joinContextSections, renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import bundle from './root.mjs'
import { RECALL_QUALIFICATION } from './recall-qualification.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const PYTHON = ['python3', 'python', 'python3.exe', 'python.exe'].find(executable =>
  spawnSync(executable, ['-I', '-S', '-B', '-c', 'import sys'], { encoding: 'utf8', timeout: 5000 }).status === 0)
const NATIVE_OPTIONS = PYTHON === undefined ? { skip: 'Python interpreter unavailable on this host' } : {}
const PACKAGE_NAME = '@example/mse-plugin'
const LOADED_VERSION = '3.7.1'
const COMMAND = 'python3 sample-project/probes/entry-pair/intake.py'
const MANIFEST_PATH = 'sample-project/development/package.json'
const INTAKE = `from pathlib import Path
import sys,runpy
p=Path(__file__).resolve().parent
sys.argv=[str(p.parent/'gates/receipt_guard.py'),str(p/'receipts/a.txt')]
runpy.run_path(sys.argv[0],run_name='__main__')
`
const COUNTER = INTAKE.replace('receipts/a.txt', 'receipts/b.txt')
const GUARD = `import sys
from pathlib import Path
p = Path(sys.argv[1])
fields = dict(line.split("=", 1) for line in p.read_text().splitlines() if "=" in line)
if not fields.get("loadedVersion", "").strip():
    print("loadedVersion missing", file=sys.stderr)
    raise SystemExit(7)
print("receipt accepted")
`

function writeReceipts(root, version = LOADED_VERSION) {
  const receiptDir = join(root, 'sample-project', 'probes', 'entry-pair', 'receipts')
  writeFileSync(join(receiptDir, 'a.txt'), `candidateFile=alpha.tgz\nloadedVersion=${version}\n`)
  writeFileSync(join(receiptDir, 'b.txt'), `candidateFile=beta.tgz\nloadedVersion=${version}\n`)
}

function addSourceFixture(root) {
  const pair = join(root, 'sample-project', 'probes', 'entry-pair')
  mkdirSync(join(pair, 'receipts'), { recursive: true })
  mkdirSync(join(root, 'sample-project', 'probes', 'gates'), { recursive: true })
  mkdirSync(join(root, 'sample-project', 'development'), { recursive: true })
  writeFileSync(join(root, MANIFEST_PATH), JSON.stringify({ name: PACKAGE_NAME, version: '0.0.0-untrusted' }))
  writeFileSync(join(pair, 'intake.py'), INTAKE)
  writeFileSync(join(pair, 'counter.py'), COUNTER)
  writeFileSync(join(root, 'sample-project', 'probes', 'gates', 'receipt_guard.py'), GUARD)
  writeReceipts(root)
}

const packageManager = {
  async listPlugins() { return [{ entryId: 'include:example-mse', moduleName: 'example-mse',
    enabled: true, fiberPhase: 'active', patchId: 'sample-patch' }] },
  async listBundles() { return [{ name: PACKAGE_NAME, version: LOADED_VERSION, installed: true, enabled: true,
    rows: [{ rowId: 'sample-patch', moduleName: 'example-mse', entryId: 'include:example-mse' }] }] },
}

async function createHarness() {
  const dir = mkdtempSync(join(homedir(), '.mse-python-receipt-pipeline-'))
  addSourceFixture(dir)
  const ctx = new Context().root
  const sessionId = `receipt-pipeline-${hash(dir).slice(0, 12)}`
  let sourceAllowed = true
  const llmCalls = []
  ctx.provide('agents', {})
  ctx.provide('dshHomePath', name => join(dir, name))
  ctx.provide('pluginManager', packageManager)
  ctx.provide('llm', { async *stream(options) {
    llmCalls.push(options)
    const input = JSON.parse(options.messages[0].content[0].text)
    const evidenceId = input.evidenceIds.at(-1)
    const revised = { schema: 'mse-failure-lesson-v1',
      applicability: 'intake.py 与 counter.py 实际读取的 MSE 插件验收单需要校验宿主加载版本时',
      failurePattern: 'Python receipt objective check failed: wrong_loaded_version',
      rootCause: { summary: 'receipt 中的 loadedVersion 与唯一 active bundle 版本不一致', basis: 'observed',
        evidenceIds: [evidenceId] },
      repairSteps: ['检查 intake.py 与 counter.py 的实际读取路径并更新两份验收单。',
        '分别运行 intake.py 与 counter.py，确认 loadedVersion 等于宿主实际加载版本并保留 candidateFile。'],
      verification: { check: COMMAND,
        expected: '两份真实入口均 exit 0，实际读取的 loadedVersion 与宿主绑定版本相同。' },
      instruction: '先定位 intake.py 与 counter.py 实际读取的两份验收单，再写入宿主 active bundle 的真实版本并分别验收',
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
  await ctx.plugin(SystemPrompt)
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
    const probe = await ctx.sandbox.confine([PYTHON, '-I', '-S', '-B'],
      { mode: 'read-only', workspaceRoot: dir })
    nativeSandboxAvailable = probe?.enforcement === 'full'
  } catch { /* native enforcement is required for this fixture */ }
  const api = ctx.get('mseRebuild')
  api.engine.pause(true)
  api.engine.observeRoute({ sessionId, route: { provider: 'fake-provider', model: 'fake-model' } })
  const observed = api.engine.observeToolFailure({ sessionId, turnId: 'seed', projectKey: dir,
    callId: 'seed-receipt-failure', toolName: 'bash', failureCode: 'tool_nonzero_exit', exitCode: 7,
    stderr: 'MSE_RECEIPT_GUARD: 插件交付验收单缺少 loadedVersion；candidateFile 不能证明宿主实际加载版本。',
    command: COMMAND })
  assert.equal(observed.ok, true)
  const problem = api.engine.store.read().problemLoop.problems.find(row => row.id === observed.id)
  const capsuleId = problem.capsules.at(-1).id
  const entryId = `mem_${hash('native-python-receipt-method').slice(0, 24)}`
  const lesson = { problemId: problem.id, evidenceIds: [capsuleId],
    failurePattern: '真实入口因缺少 loadedVersion 被守卫以 exit 7 拒绝',
    rootCause: { summary: '两份实际 receipt 均缺少宿主加载版本', basis: 'observed', evidenceIds: [capsuleId] },
    repairSteps: ['检查 intake.py 与 counter.py 的实际读取路径。',
      '分别运行 intake.py 与 counter.py，核对 loadedVersion 并保留 candidateFile。'],
    verification: { check: COMMAND, expected: '两份入口 exit 0 且 loadedVersion 等于宿主实际版本。' },
  }
  api.engine.store.transaction(doc => {
    doc.entries.push({ id: entryId, type: 'lesson', status: 'pending',
      instruction: '按 intake.py 与 counter.py 实际读取的两份验收单写入宿主加载版本并分别验收',
      applicability: 'intake.py 与 counter.py 报 MSE_RECEIPT_GUARD 缺少 loadedVersion 时',
      exclusions: '', visibility: 'global', originScope: hash('receipt-scope'),
      originEnvironment: hash('receipt-environment'), originSession: sessionId, lesson,
      problemSignature: problem.signature ?? hash('receipt-signature'), version: 1, parentVersion: null,
      superseded: null, injected: 0, recurrences: 0, createdAt: Date.now(), updatedAt: Date.now(),
      lastInjectedAt: null, evidenceHash: null,
      methodStats: { version: 1, since: Date.now(), coverage: 'complete', injected: 0,
        recurrences: 0, checkPasses: 0, checkFails: 0 }, factDigest: null, digestDay: null, importedFrom: null })
    const linked = doc.problemLoop.problems.find(row => row.id === problem.id)
    linked.lessonId = entryId
    linked.lessonVersion = 1
    linked.state = 'candidate_created'
    return true
  })

  const session = {
    id: sessionId, header: { cwd: dir }, events: [], pendingEvents: [], skipResultCallIds: new Set(),
    get seq() { return this.events.length },
    eventAt(index) { return this.events[index] ?? null },
    append(type, data) {
      const message = data?.message
      const callId = type === 'tool/result'
        ? message?.source?.callId ?? message?.content?.find(part => part?.type === 'tool-result')?.toolCallId : null
      if (callId !== null && this.skipResultCallIds.delete(callId)) return { seq: this.events.length }
      const event = { type, data, seq: this.events.length }
      this.events.push(event)
      this.pendingEvents.push(Promise.resolve(ctx.emit('session/event', this, event)))
      return event
    },
    async flushEvents() { const rows = this.pendingEvents.splice(0); await Promise.all(rows) },
  }
  const agent = { session, options: { provider: 'fake-provider', model: 'fake-model' } }
  const assemble = async () => {
    const modelSelection = { provider: 'fake-provider', model: 'fake-model' }
    const toolSet = await ctx.tools.resolve({ agent, modelSelection, signal: new AbortController().signal })
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent, modelSelection, toolSet })
    return { assembly,
      runtimeContext() { return joinContextSections(renderContextSections(ctx.systemPrompt.refreshContext(assembly,
        { agent, scope: agent, modelSelection }))) },
      dispose: () => toolSet.dispose() }
  }
  const startTurn = async turn => {
    session.append('turn/start', { turn })
    await session.flushEvents()
    const message = { id: `user-${turn}`, role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '按当前方法验收 intake.py 和 counter.py 两份 MSE receipt 的 loadedVersion' }] }
    await ctx.emit('agent/pre-step', { agent, step: 1, turn, messages: [message] },
      async payload => ({ kind: 'enter', messages: payload.messages }))
    await session.flushEvents()
  }
  const execute = async (turn, callId) => {
    const result = await ctx.tools.execute({ calls: [{ id: callId, name: 'mse_verify_python_receipt',
      arguments: JSON.stringify({ command: COMMAND, projectManifest: MANIFEST_PATH }) }], agent,
      log: { turn, step: 1 }, signal: new AbortController().signal })
    await session.flushEvents()
    return result.results[0].result
  }
  const endTurn = async turn => {
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    await session.flushEvents()
  }
  return { dir, api, session, agent, ctx, entryId, problemId: problem.id, capsuleId,
    nativeSandboxAvailable, assemble, startTurn, execute, endTurn, llmCalls,
    async teardown() {
      await mseFiber.dispose()
      await subprocessFiber.dispose()
      await sandboxFiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    } }
}

function installReceiptBirthV3Fixture(h) {
  const evidenceIds = ['1', '2', '3'].map(char => char.repeat(64))
  const at = Date.now()
  const request = { ticket: 'receipt-v3-birth', kind: 'revise', at, problemId: h.problemId,
    entryId: h.entryId, digestDay: null, requestHash: hash('receipt-v3-request'),
    dispatchHash: hash('receipt-v3-dispatch'), dispatchedAt: at, settled: true, terminal: 'committed',
    usage: { input: 8, output: 8, cached: 0, cacheWrite: 0, reasoning: 0, total: 16, known: true },
    maxTokens: 2048, evidenceIds, tokenHashes: [], parentVersion: 2, routeId: hash('receipt-v3-route'),
    material: hash('receipt-v3-material'), retryOf: null, digestFacts: null, digestThrough: null,
    sourceSessionId: h.session.id, sourceRoute: null }
  h.api.engine.store.transaction(doc => {
    const entry = doc.entries.find(row => row.id === h.entryId)
    entry.version = 3
    entry.parentVersion = 2
    entry.status = 'pending'
    entry.evidenceHash = null
    entry.lesson.evidenceIds = [...evidenceIds]
    entry.lesson.rootCause.evidenceIds = [...evidenceIds]
    entry.methodStats = { ...entry.methodStats, version: 3, checkPasses: 0, checkFails: 0, since: at }
    doc.problemLoop.problems.find(row => row.id === h.problemId).lessonVersion = 3
    doc.requests.push(request)
    return true
  })
  return { evidenceIds, requestTicket: request.ticket }
}

test('the receipt tool persists objective pass, creates a revision capsule on failure, then credits only the revised method', NATIVE_OPTIONS, async t => {
  const h = await createHarness()
  let modelSurface
  try {
    if (!h.nativeSandboxAvailable) { t.skip('native LocalSandboxProvider does not report full read-only enforcement here'); return }
    modelSurface = await h.assemble()
    const tool = modelSurface.assembly.tools.find(row => row.name === 'mse_verify_python_receipt')
    assert.ok(tool)
    assert.deepEqual(Object.keys(tool.parameters).sort(), ['command', 'projectManifest'])
    assert.equal(Object.hasOwn(tool.parameters, 'expectedVersion'), false)

    await h.startTurn(1)
    assert.match(modelSurface.runtimeContext(), /mse_verify_python_receipt/u)
    assert.deepEqual(h.api.engine.developmentRelevantOffers({ sessionId: h.session.id, turnId: '1',
      checkId: 'python-receipt-contract-v1', command: COMMAND }), [{ id: h.entryId, version: 1 }])
    const pass = await h.execute(1, 'receipt-pass')
    assert.deepEqual(pass.value, { status: 'pass', reason: 'matched' })
    await h.endTurn(1)
    let doc = h.api.engine.store.read()
    assert.equal(doc.checkEvents.at(-1)?.checkId, 'python-receipt-contract-v1')
    assert.equal(doc.checkEvents.at(-1)?.passed, true)
    assert.equal(doc.checkEvents.at(-1)?.entryVersion, 1)
    assert.equal(doc.receipts.at(-1)?.outcome, 'verified')

    writeReceipts(h.dir, '9.9.9')
    await h.startTurn(2)
    const fail = await h.execute(2, 'receipt-wrong-version')
    assert.deepEqual(fail.value, { status: 'fail', reason: 'wrong_loaded_version' })
    h.api.engine.pause(false)
    await h.endTurn(2)
    doc = h.api.engine.store.read()
    assert.equal(doc.checkEvents.at(-1)?.passed, false)
    assert.equal(doc.receipts.at(-1)?.outcome, 'failed')
    const problem = doc.problemLoop.problems.find(row => row.id === h.problemId)
    const objectiveCapsule = problem.capsules.at(-1)
    assert.equal(objectiveCapsule.checkId, 'python-receipt-contract-v1')
    assert.match(objectiveCapsule.message, /wrong_loaded_version/u)
    assert.equal(objectiveCapsule.checkProof.entryVersion, 1)
    assert.equal(doc.entries.find(row => row.id === h.entryId)?.status, 'needs_revision')

    for (let attempt = 0; attempt < 200
      && h.api.engine.store.read().entries.find(row => row.id === h.entryId)?.version === 1; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    doc = h.api.engine.store.read()
    assert.equal(h.llmCalls.length, 1)
    assert.equal(doc.entries.find(row => row.id === h.entryId)?.version, 2)
    assert.deepEqual(doc.entries.find(row => row.id === h.entryId)?.lesson.evidenceIds, [objectiveCapsule.id])
    assert.equal(doc.methodHistory.find(row => row.entryId === h.entryId && row.version === 1)?.stats.checkPasses, 1)
    assert.equal(doc.methodHistory.find(row => row.entryId === h.entryId && row.version === 1)?.stats.checkFails, 1)

    writeReceipts(h.dir)
    await h.startTurn(3)
    assert.deepEqual(h.api.engine.developmentRelevantOffers({ sessionId: h.session.id, turnId: '3',
      checkId: 'python-receipt-contract-v1', command: COMMAND }), [{ id: h.entryId, version: 2 }])
    const revised = await h.execute(3, 'receipt-revised-pass')
    assert.deepEqual(revised.value, { status: 'pass', reason: 'matched' })
    await h.endTurn(3)
    doc = h.api.engine.store.read()
    assert.equal(doc.checkEvents.at(-1)?.entryVersion, 2)
    assert.equal(doc.receipts.at(-1)?.outcome, 'verified')
    assert.equal(doc.methodHistory.find(row => row.entryId === h.entryId && row.version === 1)?.stats.checkPasses, 1)
    assert.equal(doc.entries.find(row => row.id === h.entryId)?.methodStats.checkPasses, 1)
  } finally { modelSurface?.dispose(); await h.teardown() }
})

test('a current v3 birth binding is retained on its edition and survives request/capsule rotation only while sources remain admitted', NATIVE_OPTIONS, async t => {
  const h = await createHarness()
  try {
    if (!h.nativeSandboxAvailable) { t.skip('native LocalSandboxProvider does not report full read-only enforcement here'); return }
    const { evidenceIds, requestTicket } = installReceiptBirthV3Fixture(h)
    await h.startTurn(1)
    assert.deepEqual(h.api.engine.developmentRelevantOffers({ sessionId: h.session.id, turnId: '1',
      checkId: 'python-receipt-contract-v1', command: COMMAND }), [{ id: h.entryId, version: 3 }])
    const first = await h.execute(1, 'receipt-v3-first-check')
    assert.deepEqual(first.value, { status: 'pass', reason: 'matched' })
    await h.endTurn(1)

    let doc = h.api.engine.store.read()
    const proof = doc.entries.find(row => row.id === h.entryId)?.pythonReceiptBirthProof
    assert.ok(proof)
    assert.equal(proof.version, 3)
    assert.equal(proof.problemId, h.problemId)
    assert.deepEqual(proof.evidenceIds, evidenceIds)
    assert.equal(proof.requestTicket, requestTicket)

    h.api.engine.store.transaction(current => {
      current.requests = current.requests.filter(row => row.ticket !== requestTicket)
      current.problemLoop.problems.find(row => row.id === h.problemId).capsules = []
      return true
    })
    await h.startTurn(2)
    assert.deepEqual(h.api.engine.developmentRelevantOffers({ sessionId: h.session.id, turnId: '2',
      checkId: 'python-receipt-contract-v1', command: COMMAND }), [{ id: h.entryId, version: 3 }],
    'the stored birth proof supports a fresh objective check after both bounded histories rotate')
    const second = await h.execute(2, 'receipt-v3-after-rotation')
    assert.deepEqual(second.value, { status: 'pass', reason: 'matched' })
    await h.endTurn(2)
    doc = h.api.engine.store.read()
    assert.equal(doc.entries.find(row => row.id === h.entryId)?.methodStats.checkPasses, 2,
      'the score comes from the two new checker events on v3')

    h.api.engine.store.transaction(current => {
      delete current.entries.find(row => row.id === h.entryId).pythonReceiptBirthProof
      return true
    })
    await h.startTurn(3)
    assert.deepEqual(h.api.engine.developmentRelevantOffers({ sessionId: h.session.id, turnId: '3',
      checkId: 'python-receipt-contract-v1', command: COMMAND }), [],
    'without the retained binding, rotated historical prose is still missing and cannot be reconstructed')
  } finally { await h.teardown() }
})

test('a native receipt checker failure isolates the exact active fixed strategy version', NATIVE_OPTIONS, async t => {
  const h = await createHarness()
  try {
    if (!h.nativeSandboxAvailable) { t.skip('native LocalSandboxProvider does not report full read-only enforcement here'); return }
    installReceiptBirthV3Fixture(h)
    h.api.engine.pause(false)
    await h.startTurn(1)
    assert.deepEqual(h.api.engine.developmentRelevantOffers({ sessionId: h.session.id, turnId: '1',
      checkId: 'python-receipt-contract-v1', command: COMMAND }), [{ id: h.entryId, version: 3 }])

    const projectScope = hash(JSON.stringify(['project', h.dir]))
    const environment = hash('default')
    const strategyScope = hash(JSON.stringify([projectScope, environment]))
    const turnKey = hash(JSON.stringify([h.session.id, '1']))
    const sessionKey = hash(JSON.stringify(h.session.id))
    h.api.engine.store.transaction(doc => {
      doc.recallStrategy.rows.push(
        { turnKey: hash('prior-approved-turn'), scope: strategyScope, session: hash('prior-session'),
          qualification: RECALL_QUALIFICATION.id, id: h.entryId, version: 3, mode: 'approved',
          generation: 1, reason: 'same_turn_native_failure_match' },
        { turnKey, scope: strategyScope, session: sessionKey, qualification: RECALL_QUALIFICATION.id,
          id: h.entryId, version: 3, mode: 'active', generation: 1, reason: 'candidate_difference' })
      return true
    })

    writeReceipts(h.dir, '9.9.9')
    const result = await h.execute(1, 'receipt-active-strategy-fail')
    assert.deepEqual(result.value, { status: 'fail', reason: 'wrong_loaded_version' })
    const originalComplete = h.api.engine.complete.bind(h.api.engine)
    h.api.engine.complete = options => {
      const settled = originalComplete(options)
      h.api.engine.pause(true)
      return settled
    }
    await h.endTurn(1)

    let doc = h.api.engine.store.read()
    assert.equal(doc.receipts.find(row => row.turnKey === turnKey)?.outcome, 'failed')
    assert.ok(doc.receipts.find(row => row.turnKey === turnKey)?.methodFeedback.some(row =>
      row.entryId === h.entryId && row.version === 3 && row.kind === 'check_fail'
        && row.checkId === 'python-receipt-contract-v1'))
    assert.equal(doc.entries.find(row => row.id === h.entryId)?.status, 'needs_revision')

    h.api.engine.pause(false)
    const next = h.api.engine.prepare({ sessionId: h.session.id, turnId: '2', projectKey: h.dir,
      prompt: '按当前方法验收 intake.py 和 counter.py 两份 MSE receipt 的 loadedVersion',
      strategyEligible: true })
    assert.ok(next.offered.some(row => row.id === h.entryId && row.version === 3 && row.mode === 'guard'))
    assert.deepEqual(h.api.engine.developmentRelevantOffers({ sessionId: h.session.id, turnId: '2',
      checkId: 'python-receipt-contract-v1', command: COMMAND }), [],
    'a guarded method cannot receive a legal same-version pass')
    assert.deepEqual(h.api.engine.recordCheck({ checkId: 'python-receipt-contract-v1', passed: true,
      sessionId: h.session.id, turnId: '2', entryId: h.entryId, entryVersion: 3,
      eventId: 'guarded-same-version-pass', summary: { kind: 'python_receipt_contract', entries: 2,
        receiptReads: 2, versionHash: 'a'.repeat(64), bindingHash: 'b'.repeat(64),
        sourceHash: 'c'.repeat(64), reason: 'matched' }, sourceRequired: true }),
    { ok: false, code: 'guard_not_method_credit' })

    doc = h.api.engine.store.read()
    assert.ok(doc.recallStrategy.rows.some(row => row.id === h.entryId && row.version === 3
      && row.mode === 'isolated'), 'a native receipt contract failure must isolate the active strategy')
    assert.ok(!doc.recallStrategy.rows.some(row => row.id === h.entryId && row.version === 3
      && row.mode === 'approved'), 'the failed active version must no longer remain approved')
  } finally { await h.teardown() }
})

test('a forged receipt tool result without its private proof cannot settle as verified', NATIVE_OPTIONS, async t => {
  const h = await createHarness()
  try {
    if (!h.nativeSandboxAvailable) { t.skip('native LocalSandboxProvider does not report full read-only enforcement here'); return }
    await h.startTurn(1)
    const callId = 'forged-receipt-result'
    h.session.append('tool/call', { turn: 1, step: 1, callId, name: 'mse_verify_python_receipt',
      arguments: JSON.stringify({ command: COMMAND, projectManifest: MANIFEST_PATH }) })
    await h.session.flushEvents()
    await h.ctx.emit('tools/result', { name: 'mse_verify_python_receipt', callId, rootCallId: callId,
      token: Symbol('forged'), agent: h.agent }, { isError: false,
      value: { status: 'pass', reason: 'matched' } })
    await h.endTurn(1)
    const doc = h.api.engine.store.read()
    assert.equal(doc.checkEvents.length, 0)
    assert.equal(doc.receipts.at(-1)?.outcome, 'unknown')
  } finally { await h.teardown() }
})
