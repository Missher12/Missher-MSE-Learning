import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDoc, validateDoc } from './memory.mjs'
import { replayAdaptivePolicy } from './adaptive-replay.mjs'
import { addAdaptiveCandidate } from './adaptive-recall.mjs'
import { Config } from './config.mjs'
import { RebuildEngine } from './engine.mjs'

const budget = await import('./recall-budget.mjs').catch(() => ({}))

const scope = 'a'.repeat(64)
const environment = 'b'.repeat(64)
const makeEntry = (id, type, status, instruction, applicability, lesson = null) => ({
  id, type, status, instruction, applicability, exclusions: '', visibility: 'global',
  originScope: scope, originEnvironment: environment, lesson, version: 1, updatedAt: 10,
})
const methods = [1, 2].map(index => makeEntry(
  `mem_aaaaaaaaaaaaaaaaaaaaaa0${index}`, 'rule', 'user_rule',
  `缓存超时${'缓存超时检查'.repeat(20)}${index}`, '处理缓存超时',
))
const guard = makeEntry('mem_aaaaaaaaaaaaaaaaaaaaaa03', 'lesson', 'needs_revision',
  '旧的缓存超时办法', '处理缓存超时', {
    problemId: 'c'.repeat(64), failurePattern: '缓存超时失败',
    verification: { check: '检查缓存超时', expected: '缓存超时恢复' },
  })

test('token estimate follows DSH Memory Unicode code point accounting', () => {
  assert.equal(typeof budget.estimateRecallTokens, 'function')
  assert.equal(budget.estimateRecallTokens('汉a🙂'), 2)
  assert.equal(budget.estimateRecallTokens('a'.repeat(10)), 3)
  assert.equal(budget.estimateRecallTokens('a'.repeat(40)), 12,
    'non-CJK code points are multiplied as one group before the final ceiling')
})

test('legacy byte limits and the default resolve to the established budget units', () => {
  assert.equal(typeof budget.resolveRecallBudget, 'function')
  assert.deepEqual(budget.resolveRecallBudget({ maxContextBytes: 512 }),
    { unit: 'bytes', limit: 512 })
  assert.deepEqual(budget.resolveRecallBudget({ maxContextBytes: 768 }),
    { unit: budget.RECALL_TOKEN_UNIT, limit: 512 })
  for (const maxContextBytes of [768, 769, 1024, 1536]) {
    assert.deepEqual(budget.resolveRecallBudget({ maxContextBytes, maxContextTokens: null }),
      { unit: budget.RECALL_TOKEN_UNIT, limit: 512 },
      `a legacy ${maxContextBytes} B setting keeps the existing 512 Token default`)
  }
  assert.deepEqual(budget.resolveRecallBudget({ maxContextBytes: 512, maxContextTokens: 384 }),
    { unit: budget.RECALL_TOKEN_UNIT, limit: 384 })

  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-legacy-1024-recall-'))
  try {
    const engine = new RebuildEngine({ stateRoot, maxContextBytes: 1024, maxContextTokens: null })
    const resolved = budget.resolveRecallBudget({ maxContextBytes: 1024, maxContextTokens: null })
    engine.setRecallBudget(resolved)
    const entries = methods.map((row, index) => ({ ...row, originSession: null,
      problemSignature: null, parentVersion: null, superseded: null, injected: 0, recurrences: 0,
      createdAt: 1, lastInjectedAt: null, evidenceHash: null, methodStats: null, factDigest: null,
      digestDay: null, importedFrom: null, sourceDigest: null }))
    engine.store.transaction(doc => { doc.entries.push(...entries); return true })
    const prepared = engine.prepare({ sessionId: 'legacy-byte-session', turnId: '1',
      projectKey: '/repo/legacy-byte', prompt: '处理缓存超时' })
    assert.ok(prepared.ok)
    assert.equal(engine.store.read().receipts.at(-1).budgetUnit, budget.RECALL_TOKEN_UNIT)
    assert.equal(engine.store.read().receipts.at(-1).budgetLimit, 512,
      'the old 1024 B setting keeps the existing default 512 Token budget')
  } finally { rmSync(stateRoot, { recursive: true, force: true }) }
})

test('the settings schema accepts integer Token budgets from 128 through 16384 only', () => {
  for (const value of [128, 16384]) {
    assert.doesNotThrow(() => Config({ maxContextTokens: value }), `boundary ${value}`)
  }
  for (const value of [127, 16385, 128.5]) {
    assert.throws(() => Config({ maxContextTokens: value }), `out of range ${value}`)
  }
  assert.equal(Config({ maxContextTokens: 1537 }).maxContextTokens.get(), 1537,
    'the non-preset value survives schema resolution')
  assert.doesNotThrow(() => Config({ maxContextBytes: 512, maxContextTokens: null }),
    'existing byte profiles remain valid')
})

test('1537 Token budget carries full legal content through opening, mid-turn, and restart receipts', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-token-recall-1537-'))
  const longInstruction = '索引缓存异常状态'.repeat(20)
  const longCheck = '索引缓存异常核对请求'.repeat(16)
  const longExpected = '索引缓存响应正确'.repeat(20)
  const longEntry = (id, status = 'check_passed') => ({ id, type: 'lesson', status,
    instruction: longInstruction, applicability: '索引缓存异常时', exclusions: '', visibility: 'global',
    originScope: scope, originEnvironment: environment, originSession: null,
    lesson: { problemId: 'c'.repeat(64), evidenceIds: ['d'.repeat(64)],
      failurePattern: '索引缓存异常', repairSteps: ['核对索引状态'],
      verification: { check: longCheck, expected: longExpected } },
    problemSignature: null, version: 1, parentVersion: null, superseded: null,
    injected: 0, recurrences: 0, createdAt: 1, updatedAt: 1, lastInjectedAt: null,
    evidenceHash: null, methodStats: null, factDigest: null, digestDay: null,
    importedFrom: null, sourceDigest: null })
  const entries = [longEntry('mem_aaaaaaaaaaaaaaaaaaaaaa11'),
    longEntry('mem_bbbbbbbbbbbbbbbbbbbbbb22'), longEntry('mem_cccccccccccccccccccccc33', 'needs_revision')]
  const prompt = '索引缓存异常时核对索引状态'
  try {
    assert.deepEqual(budget.resolveRecallBudget({ maxContextBytes: 512, maxContextTokens: 1537 }),
      { unit: budget.RECALL_TOKEN_UNIT, limit: 1537 })
    const lowLimit = budget.selectRecallByTokens(entries, { prompt,
      scope, environment, maxTokens: 1024, now: 0 })
    assert.ok(lowLimit.contextTokens <= 1024, 'the established 1024 Token budget remains bounded')

    let engine
    assert.doesNotThrow(() => { engine = new RebuildEngine({ stateRoot, maxContextBytes: 512,
      maxContextTokens: 1537 }) }, 'the engine accepts a non-preset Token budget')
    engine.store.transaction(doc => { doc.entries.push(...entries); return true })
    const opened = engine.prepare({ sessionId: 'token-1537-open', turnId: '1',
      projectKey: '/repo/token-1537', prompt })
    assert.deepEqual(opened.offered.map(row => row.mode), ['method', 'method', 'guard'],
      'the custom budget keeps the existing two methods and one warning')
    assert.ok(opened.contextTokens > 1024 && opened.contextTokens <= 1537)
    assert.ok(opened.bytes > 1024)
    assert.ok(opened.context.includes(longInstruction), 'the eligible instruction is never truncated')
    assert.ok(opened.context.includes(longCheck) && opened.context.includes(longExpected),
      'the long verification detail remains complete')

    const midTurn = engine.prepareMidTurnRecall({ sessionId: 'token-1537-mid', turnId: '2',
      projectKey: '/repo/token-1537', prompt, maxTokens: 1537, maxMethods: 2, maxGuards: 1 })
    assert.deepEqual(midTurn.offered.map(row => row.mode), ['method', 'method', 'guard'])
    assert.ok(midTurn.contextTokens > 1024 && midTurn.contextTokens <= 1537)
    assert.ok(midTurn.context.includes(longInstruction))
    const recorded = engine.recordMidTurnInjection({ sessionId: 'token-1537-mid', turnId: '2',
      offered: midTurn.offered, step: 1, messageSeq: 1, promptSeq: 2, promptHash: 'f'.repeat(64),
      bytes: midTurn.bytes, contextTokens: midTurn.contextTokens,
      budget: { unit: budget.RECALL_TOKEN_UNIT, limit: 1537 } })
    assert.equal(recorded.ok, true)
    assert.doesNotThrow(() => validateDoc(engine.store.read()))

    const reopened = new RebuildEngine({ stateRoot, maxContextBytes: 512, maxContextTokens: 1537 })
    const openingReceipt = reopened.store.read().receipts.find(row => row.turnKey === opened.turnKey)
    assert.equal(openingReceipt.budgetLimit, 1537)
    assert.ok(openingReceipt.contextTokens > 1024 && openingReceipt.contextTokens <= 1537)
    const midTurnReceipt = reopened.store.read().midTurnReceipts.at(-1)
    assert.equal(midTurnReceipt.budgetLimit, 1537)
    assert.ok(midTurnReceipt.contextTokens > 1024 && midTurnReceipt.contextTokens <= 1537)
    assert.doesNotThrow(() => validateDoc(reopened.store.read()), 'both new receipts stay readable after restart')
  } finally { rmSync(stateRoot, { recursive: true, force: true }) }
})

test('token selection counts the injected prefix and keeps complete methods and one warning', () => {
  assert.equal(typeof budget.selectRecallByTokens, 'function')
  const selection = budget.selectRecallByTokens([...methods, guard], {
    prompt: '处理缓存超时', scope, environment, maxTokens: 512, now: 0,
  })
  assert.deepEqual(selection.offered.map(row => row.mode), ['method', 'method', 'guard'])
  assert.ok(selection.bytes > 768, 'the token limit can carry valid CJK content above the old byte cap')
  assert.equal(selection.contextTokens, budget.estimateRecallTokens(
    `${budget.RECALL_INJECTION_PREFIX}${selection.lines.join('')}`))
  assert.ok(selection.contextTokens <= 512)

  const tooSmall = budget.selectRecallByTokens([...methods, guard], {
    prompt: '处理缓存超时', scope, environment, maxTokens: 32, now: 0,
  })
  assert.deepEqual(tooSmall.offered, [], 'oversized lines are skipped whole, never truncated')
  assert.deepEqual(tooSmall.lines, [])
})

test('engine receipts keep real bytes and persist the token estimate separately', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-token-recall-'))
  try {
    const engine = new RebuildEngine({ stateRoot, maxContextTokens: 512 })
    const entry = id => ({ id, type: 'rule', status: 'user_rule',
      instruction: `缓存超时${'缓存超时检查'.repeat(24)}`, applicability: '处理缓存超时', exclusions: '',
      visibility: 'global', originScope: scope, originEnvironment: environment,
      originSession: null, lesson: null, problemSignature: null, version: 1,
      parentVersion: null, superseded: null, injected: 0, recurrences: 0,
      createdAt: 1, updatedAt: 1, lastInjectedAt: null, evidenceHash: null, methodStats: null,
      factDigest: null, digestDay: null, importedFrom: null, sourceDigest: null })
    engine.store.transaction(doc => {
      doc.entries.push(entry('mem_aaaaaaaaaaaaaaaaaaaaaaaa'), entry('mem_bbbbbbbbbbbbbbbbbbbbbbbb'))
      return true
    })
    const prepared = engine.prepare({ sessionId: 'token-session', turnId: 'token-turn',
      projectKey: '/repo/token', prompt: '处理缓存超时' })
    assert.equal(prepared.offered.length, 2)
    assert.ok(prepared.bytes > 768)
    assert.ok(prepared.contextTokens <= 512)
    const receipt = engine.store.read().receipts.at(-1)
    assert.equal(receipt.bytes, Buffer.byteLength(prepared.context, 'utf8'))
    assert.equal(receipt.contextTokens, prepared.contextTokens)
    assert.equal(receipt.budgetUnit, budget.RECALL_TOKEN_UNIT)
    assert.equal(receipt.budgetLimit, 512)
    assert.doesNotThrow(() => validateDoc(engine.store.read()))
  } finally { rmSync(stateRoot, { recursive: true, force: true }) }
})

test('token receipts keep raw bytes while validating the versioned token profile', () => {
  assert.equal(typeof budget.RECALL_TOKEN_UNIT, 'string')
  const doc = createDoc()
  doc.receipts.push({ id: 'd'.repeat(64), turnKey: 'e'.repeat(64), at: 1,
    bytes: 2048, contextTokens: 500, budgetUnit: budget.RECALL_TOKEN_UNIT, budgetLimit: 512,
    offered: [{ id: 'mem_aaaaaaaaaaaaaaaaaaaaaa01', version: 1, mode: 'method' }],
    settled: false, outcome: null, evidenceHash: null, source: null })
  assert.doesNotThrow(() => validateDoc(doc))
})

test('adaptive replay accepts only gains and controls measured under the same token profile', () => {
  const candidate = { id: 'mem_adaptive_candidate', version: 2, mode: 'method' }
  const incumbent = { id: 'mem_adaptive_incumbent', version: 1, mode: 'method' }
  const rule = { id: 'mem_adaptive_rule', version: 1, mode: 'method' }
  const warning = { id: 'mem_adaptive_warning', version: 1, mode: 'guard' }
  const policy = { schema: 'mse-adaptive-recall-v2', id: 'token-policy',
    entryId: candidate.id, version: candidate.version, features: ['api', 'opcheck'],
    excludedFeatures: [], budget: { unit: budget.RECALL_TOKEN_UNIT, limit: 512 },
    firstSession: 'source-session', firstQuery: 'source-query', samples: [] }
  const sample = ({ session, query, expected, features, baselineOffers = [incumbent, rule, warning],
    candidateOffers, observed = expected ? candidate : incumbent, sampleBudget = policy.budget }) => ({
    session, query, turnKey: `${session}-${query}`,
    result: expected ? 'holdout_hit' : 'negative_control',
    replay: { features, expected, matched: expected, canAdd: true, baselineHasTarget: false,
      baselineOffers, candidateOffers: candidateOffers ?? (expected ? [candidate, rule, warning] : baselineOffers),
      protectedOffers: [rule, warning], baselineBytes: 900, candidateBytes: expected ? 1020 : 900,
      baselineTokens: 480, candidateTokens: expected ? 505 : 480, budget: sampleBudget,
      observedEntry: { id: observed.id, version: observed.version } },
  })
  const matched = ['api', 'opcheck']
  const unmatched = ['chart', 'opdraw']
  const replay = (...samples) => replayAdaptivePolicy({ ...policy, samples })
  assert.equal(replay(
    sample({ session: 'positive-1', query: 'q1', expected: true, features: matched }),
    sample({ session: 'positive-2', query: 'q2', expected: true, features: matched }),
    sample({ session: 'control-1', query: 'q3', expected: false, features: unmatched }),
    sample({ session: 'control-2', query: 'q4', expected: false, features: unmatched,
      observed: { id: 'mem_adaptive_other', version: 5 }, baselineOffers: [rule, warning] }),
  ).approved, true)
  const mismatched = replay(
    sample({ session: 'positive-1', query: 'q1', expected: true, features: matched }),
    sample({ session: 'positive-2', query: 'q2', expected: true, features: matched,
      sampleBudget: { unit: budget.RECALL_TOKEN_UNIT, limit: 384 } }),
    sample({ session: 'control-1', query: 'q3', expected: false, features: unmatched }),
    sample({ session: 'control-2', query: 'q4', expected: false, features: unmatched,
      observed: { id: 'mem_adaptive_other', version: 5 }, baselineOffers: [rule, warning] }),
  )
  assert.equal(mismatched.approved, false)
  assert.ok(mismatched.incomplete > 0)
})

test('adaptive token candidate packing uses estimated tokens while keeping real byte totals', () => {
  const line = `\n- 经验：${'缓存超时'.repeat(70)}`
  const incumbent = { lines: [line], bytes: Buffer.byteLength(line),
    contextTokens: budget.estimateRecallTokens(`${budget.RECALL_INJECTION_PREFIX}${line}`),
    offered: [{ id: 'mem_adaptive_incumbent', version: 1, mode: 'method' }], ranked: [],
    budget: { unit: budget.RECALL_TOKEN_UNIT, limit: 512 } }
  const entry = makeEntry('mem_adaptive_candidate', 'lesson', 'check_passed',
    `缓存超时${'缓存超时检查'.repeat(22)}`, '处理缓存超时', {
      verification: { check: '检查缓存超时', expected: '缓存超时恢复' },
    })
  const result = addAdaptiveCandidate(incumbent, entry,
    { budget: incumbent.budget, prompt: '处理缓存超时', now: 0 })
  assert.equal(result.ok, true)
  assert.ok(result.selection.bytes > 768)
  assert.ok(result.selection.contextTokens <= 512)
  assert.equal(result.selection.contextTokens, budget.estimateRecallTokens(
    `${budget.RECALL_INJECTION_PREFIX}${result.selection.lines.join('')}`))
})
