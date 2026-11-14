import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RebuildEngine } from './engine.mjs'
import { ENTRY_LIMIT, entryIdFor } from './memory.mjs'
import { apply } from './dsh.mjs'
import { LearningError } from '../src/store.mjs'

const temporaryRoot = () => mkdtempSync(join(tmpdir(), 'mse-storage-host-test-'))
const ruleText = index => `规则容量测试 ${String(index).padStart(3, '0')} 保持原样`
const hash = value => createHash('sha256').update(value).digest('hex')
const scope = hash(JSON.stringify(['instance']))
const freezeTestDate = t => t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 14, 10, 0, 0) })

function seededRule(index, existing = false) {
  const instruction = ruleText(index)
  const id = existing ? entryIdFor('rule', scope, instruction) : `mem_${hash(`seed-${index}`).slice(0, 24)}`
  return { id, type: 'rule', status: 'user_rule', instruction, applicability: '', exclusions: '',
    visibility: 'global', originScope: scope, originEnvironment: 'b'.repeat(64),
    originSession: 'capacity-test', lesson: null, problemSignature: null, version: 1,
    parentVersion: null, superseded: null, injected: 0, recurrences: 0, createdAt: index + 1,
    updatedAt: index + 1, lastInjectedAt: null, evidenceHash: null, factDigest: null,
    digestDay: null, importedFrom: null }
}

function addRules(engine, count) {
  if (count === 0) return
  assert.equal(engine.recordCorrection({ text: ruleText(0), sessionId: 'capacity-test', turnId: '0' }).ok, true)
  const first = engine.store.read().entries[0]
  const entries = [first, ...Array.from({ length: count - 1 }, (_, offset) => seededRule(offset + 1))]
  engine.store.transaction(doc => { doc.entries = entries; return true })
}

function pendingEntry() {
  const instruction = '旧pending条目容量测试文本'
  const originScope = 'a'.repeat(64)
  return { id: entryIdFor('lesson', originScope, instruction), type: 'lesson', status: 'pending',
    instruction, applicability: '', exclusions: '', visibility: 'global', originScope,
    originEnvironment: 'b'.repeat(64), originSession: 'capacity-test', lesson: null,
    problemSignature: null, version: 1, parentVersion: null, superseded: null, injected: 0,
    recurrences: 0, createdAt: 1, updatedAt: 1, lastInjectedAt: null, evidenceHash: null,
    factDigest: null, digestDay: null, importedFrom: null }
}

test('a full user-rule-only library rejects a new direct rule with a readable reason and no write', () => {
  const root = temporaryRoot()
  const engine = new RebuildEngine({ stateRoot: root })
  try {
    addRules(engine, ENTRY_LIMIT)
    const before = readFileSync(engine.store.path)
    const result = engine.recordCorrection({ text: ruleText(ENTRY_LIMIT), sessionId: 'capacity-test',
      turnId: String(ENTRY_LIMIT) })
    assert.deepEqual(result, { ok: false, reason: 'entry_capacity' })
    assert.deepEqual(readFileSync(engine.store.path), before)
    assert.equal(engine.store.read().entries.length, ENTRY_LIMIT)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a full library preserves its pending entry when refusing a new direct rule', () => {
  const root = temporaryRoot()
  const engine = new RebuildEngine({ stateRoot: root })
  try {
    addRules(engine, ENTRY_LIMIT - 1)
    const pending = pendingEntry()
    engine.store.transaction(doc => { doc.entries.push(pending); return true })
    const before = readFileSync(engine.store.path)
    const result = engine.recordCorrection({ text: ruleText(ENTRY_LIMIT - 1),
      sessionId: 'capacity-test', turnId: String(ENTRY_LIMIT - 1) })
    assert.deepEqual(result, { ok: false, reason: 'entry_capacity' })
    assert.deepEqual(readFileSync(engine.store.path), before)
    const after = engine.store.read()
    assert.equal(after.entries.length, ENTRY_LIMIT)
    assert.equal(after.entries.find(entry => entry.id === pending.id)?.instruction, pending.instruction)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a duplicate user rule remains successful when the library is full', () => {
  const root = temporaryRoot()
  const engine = new RebuildEngine({ stateRoot: root })
  try {
    addRules(engine, ENTRY_LIMIT)
    const duplicate = engine.recordCorrection({ text: ruleText(0), sessionId: 'capacity-test',
      turnId: 'duplicate' })
    assert.equal(duplicate.ok, true)
    assert.equal(duplicate.duplicate, true)
    assert.equal(engine.store.read().entries.length, ENTRY_LIMIT)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a full library keeps a new natural correction pending without paying for extraction', () => {
  const root = temporaryRoot()
  const engine = new RebuildEngine({ stateRoot: root })
  try {
    addRules(engine, ENTRY_LIMIT)
    engine.setRoute({ provider: 'fake', model: 'm1' })
    engine.recordCorrectionCandidate({ sessionId: 'capacity-test', turnId: 'queued',
      userText: '不对，插件版本应该先读取实际加载信息。', cwd: '/repo/alpha' })
    assert.equal(engine.beginWork(), null)
    const doc = engine.store.read()
    assert.equal(doc.corrections.at(-1).status, 'pending')
    assert.equal(doc.requests.length, 0)
    assert.equal(doc.digest.waitReason, 'entry_capacity')
    assert.equal(doc.entries.length, ENTRY_LIMIT)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an already-dispatched extraction that reaches capacity settles as entry_capacity', () => {
  const root = temporaryRoot()
  const engine = new RebuildEngine({ stateRoot: root })
  try {
    addRules(engine, ENTRY_LIMIT - 1)
    engine.setRoute({ provider: 'fake', model: 'm1' })
    engine.recordCorrectionCandidate({ sessionId: 'capacity-test', turnId: 'raced',
      userText: '不对，插件版本应该读取实际加载信息。', cwd: '/repo/alpha' })
    const work = engine.beginWork()
    assert.ok(work)
    engine.markDispatched(work.ticket)
    engine.store.transaction(doc => { doc.entries.push(seededRule(ENTRY_LIMIT - 1)); return true })
    const result = engine.finishWork({ ticket: work.ticket, usage: { total: 12 },
      result: { schema: 'mse-correction-extract-v1', corrections: [{
        durability: 'durable', scope: 'global', basis: 'stable workflow', reason: '可复用',
        evidence: '插件版本应该读取实际加载信息', instruction: '插件版本应该读取实际加载信息',
        applicability: '核对插件版本时' }] } })
    assert.equal(result.reason, 'entry_capacity')
    const doc = engine.store.read()
    assert.equal(doc.entries.length, ENTRY_LIMIT)
    assert.equal(doc.requests.find(row => row.ticket === work.ticket).settled, true)
    assert.equal(doc.requests.find(row => row.ticket === work.ticket).terminal, 'entry_capacity')
    assert.equal(doc.corrections.at(-1).status, 'ignored')
    assert.equal(doc.corrections.at(-1).reason, 'entry_capacity')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a full library keeps eligible reflection evidence waiting without a provider request', () => {
  const root = temporaryRoot()
  const engine = new RebuildEngine({ stateRoot: root })
  try {
    addRules(engine, ENTRY_LIMIT)
    engine.setRoute({ provider: 'fake', model: 'm1' })
    for (const [sessionId, turnId] of [['s-a', '1'], ['s-b', '1']]) {
      engine.observeToolFailure({ sessionId, turnId, projectKey: '/repo/alpha',
        callId: `failure-${sessionId}`, toolName: 'node', failureCode: 'tool_nonzero_exit',
        exitCode: 1, stderr: 'SyntaxError: Unexpected token in configuration file' })
    }
    assert.equal(engine.beginWork(), null)
    const doc = engine.store.read()
    assert.equal(doc.requests.length, 0)
    assert.equal(doc.digest.waitReason, 'entry_capacity')
    assert.equal(doc.problemLoop.problems.some(row => row.ticket !== null), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a dispatched reflection that reaches capacity settles without leaving its problem in flight', () => {
  const root = temporaryRoot()
  const engine = new RebuildEngine({ stateRoot: root })
  try {
    addRules(engine, ENTRY_LIMIT - 1)
    engine.setRoute({ provider: 'fake', model: 'm1' })
    for (const [sessionId, turnId] of [['s-a', '1'], ['s-b', '1']]) {
      engine.observeToolFailure({ sessionId, turnId, projectKey: '/repo/alpha',
        callId: `failure-${sessionId}`, toolName: 'node', failureCode: 'tool_nonzero_exit',
        exitCode: 1, stderr: 'SyntaxError: Unexpected token in configuration file' })
    }
    const work = engine.beginWork()
    assert.ok(work && work.kind === 'reflect')
    engine.markDispatched(work.ticket)
    engine.store.transaction(doc => { doc.entries.push(seededRule(ENTRY_LIMIT - 1)); return true })
    const evidenceId = engine.store.read().requests.find(row => row.ticket === work.ticket).evidenceIds[0]
    const result = engine.finishWork({ ticket: work.ticket, usage: { total: 18 },
      result: { schema: 'mse-failure-lesson-v1', applicability: '处理配置文件时',
        failurePattern: '配置文本因语法无效而解析失败',
        rootCause: { summary: '配置文本包含无效语法', basis: 'hypothesis', evidenceIds: [evidenceId] },
        repairSteps: ['先解析配置文本并定位语法错误'],
        verification: { check: '用 JSON.parse 解析配置', expected: '解析成功' },
        instruction: '写入配置前先用 JSON.parse 验证语法有效' } })
    assert.deepEqual(result, { ok: false, code: 'entry_capacity', settled: true })
    const doc = engine.store.read()
    assert.equal(doc.entries.length, ENTRY_LIMIT)
    const request = doc.requests.find(row => row.ticket === work.ticket)
    assert.equal(request.settled, true)
    assert.equal(request.terminal, 'entry_capacity')
    const problem = doc.problemLoop.problems.find(row => row.id === work.problemId)
    assert.equal(problem.ticket, null)
    assert.equal(problem.reason, 'entry_capacity')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a missing store after this instance has committed a library is unavailable, not first use', () => {
  const root = temporaryRoot()
  const engine = new RebuildEngine({ stateRoot: root })
  try {
    engine.recordCorrection({ text: '丢失库测试保留哨兵', sessionId: 'missing-store', turnId: '1' })
    const original = readFileSync(engine.store.path)
    unlinkSync(engine.store.path)
    assert.throws(() => engine.store.read(), error => error.code === 'state_unavailable')
    assert.throws(() => engine.store.transaction(doc => { doc.replacement = true; return true }),
      error => error.code === 'state_unavailable')
    assert.equal(engine.store.path, join(realpathSync(root), 'memory-v1.json'))
    writeFileSync(engine.store.path, original)
    assert.equal(engine.store.read().entries[0].instruction, '丢失库测试保留哨兵')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('status reports an invalid library without writing or presenting a fake empty view', () => {
  const root = temporaryRoot()
  const engine = new RebuildEngine({ stateRoot: root })
  try {
    writeFileSync(engine.store.path, '{broken store bytes')
    const before = readFileSync(engine.store.path)
    const status = engine.statusView()
    assert.deepEqual(status.storage, { available: false, reason: 'invalid_memory' })
    assert.equal(Object.hasOwn(status, 'entries'), false)
    assert.deepEqual(readFileSync(engine.store.path), before)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a source-mode host continues a normal pre-step while storage is corrupt, then recovers the same library', async t => {
  freezeTestDate(t)
  const root = temporaryRoot()
  const stateRoot = join(root, 'mse-learning')
  const durable = new RebuildEngine({ stateRoot })
  durable.recordCorrection({ text: '保留合法库原有哨兵内容', sessionId: 's1', turnId: 'before' })
  const original = readFileSync(durable.store.path)
  writeFileSync(durable.store.path, '{corrupt bytes stay untouched')
  const corrupt = readFileSync(durable.store.path)
  const handlers = new Map()
  const calls = []
  const project = realpathSync(process.cwd())
  const ctx = {
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); return () => {} },
    effect() {}, provide() {}, get() { return undefined },
    reflect: { provide() { return true } }, plugin() {},
    dshHomePath(name) { return join(root, name) },
    workspaceRegistry: { list: () => [{ path: project, sessionIds: ['s1'] }] },
    llm: { async * stream() { calls.push('called'); throw new Error('unexpected provider call') } },
  }
  let api
  try {
    api = apply(ctx, { modelProvider: 'demo', modelId: 'm1', wakeIntervalMs: 60_000 })
    const status = api.status()
    assert.deepEqual(status.storage, { available: false, reason: 'invalid_memory' })
    const session = { id: 's1', header: { cwd: project }, seq: 0, eventAt() { return undefined } }
    let proceeded = false
    const [decision] = await Promise.all((handlers.get('agent/pre-step') ?? []).map(fn => fn({
      agent: { session }, step: 1, turn: 1,
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续普通工作' }] }],
    }, async payload => { proceeded = true; return { kind: 'enter', messages: payload.messages } })))
    assert.equal(proceeded, true)
    assert.equal(decision.kind, 'enter')
    await api.wake()
    assert.deepEqual(calls, [])
    assert.deepEqual(readFileSync(durable.store.path), corrupt)

    writeFileSync(durable.store.path, original)
    await api.wake()
    const recovered = api.status()
    assert.deepEqual(recovered.storage, { available: true, reason: null })
    assert.ok(recovered.entries.some(row => row.instruction === '保留合法库原有哨兵内容'))
    assert.equal(calls.length, 0)
  } finally {
    api?.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a write-side EIO stays visible through reads until a confirmed commit succeeds', async () => {
  const root = temporaryRoot()
  const handlers = new Map()
  const project = realpathSync(process.cwd())
  const calls = []
  const ctx = {
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); return () => {} },
    effect() {}, provide() {}, get() { return undefined },
    reflect: { provide() { return true } },
    dshHomePath(name) { return join(root, name) },
    workspaceRegistry: { list: () => [{ path: project, sessionIds: [] }] },
    llm: { async * stream() { calls.push('called'); throw new Error('unexpected provider call') } },
  }
  let api
  try {
    api = apply(ctx, { modelProvider: 'demo', modelId: 'm1', wakeIntervalMs: 60_000 })
    const store = api.engine.store
    const transaction = store.transaction.bind(store)
    const now = Date.now()
    api.engine.recordCorrection({ text: '保留用于写故障状态探针的合法规则', sessionId: 's1', turnId: 'seed' })
    store.transaction(doc => {
      doc.entries[0].createdAt = now - 2 * 86_400_000
      doc.entries[0].updatedAt = now - 2 * 86_400_000
      return true
    })
    api.engine.now = () => now - 86_400_000
    const before = readFileSync(store.path)
    let fail = true
    store.transaction = mutate => {
      if (fail) { fail = false; throw new LearningError('EIO') }
      return transaction(mutate)
    }
    await api.wake()
    assert.equal(fail, false, 'syncDigest reached its real transactional backlog write')
    assert.deepEqual(readFileSync(store.path), before)
    assert.deepEqual(api.status().storage, { available: true, reason: 'EIO' })
    assert.deepEqual(api.status().storage, { available: true, reason: 'EIO' },
      'read-only status cannot clear a write failure')
    assert.deepEqual(calls, [])

    api.engine.recordTurnFacts({ sessionId: 's1', turnId: '1', taskSummary: '成功提交探针' })
    assert.deepEqual(api.status().storage, { available: true, reason: null },
      'only a subsequent confirmed store commit clears the write warning')
  } finally {
    api?.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
