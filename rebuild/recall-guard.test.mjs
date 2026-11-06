import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RebuildEngine } from './engine.mjs'
import { selectRecall, recallSelection, MAX_METHODS_PER_TURN }
  from './recall.mjs'
import { validateDoc } from './memory.mjs'
import { loadDefaultCases } from '../scripts/rsi/replay.mjs'
import { compareV3 } from '../scripts/rsi/compare-v3.mjs'

const scope = 'a'.repeat(64)
const environment = 'b'.repeat(64)
const entry = (id, type, instruction, applicability, {
  status = 'user_rule', lesson = null, updatedAt = 100, visibility = 'global',
  originScope = scope, originEnvironment = environment, exclusions = '',
} = {}) => ({
  id, type, status, instruction, applicability, exclusions, visibility,
  originScope, originEnvironment, originSession: null, lesson, problemSignature: null,
  version: 1, parentVersion: null, superseded: null, injected: 0, recurrences: 0,
  createdAt: updatedAt, updatedAt, lastInjectedAt: null, evidenceHash: null,
  methodStats: null, factDigest: null, digestDay: null, importedFrom: null,
})
const lesson = (pattern = '缓存超时错误'.repeat(10)) => ({
  problemId: 'f'.repeat(64), evidenceRevision: 0, evidenceIds: ['a'.repeat(64)],
  failurePattern: pattern, rootCause: { summary: 'control', basis: 'hypothesis',
    evidenceIds: ['a'.repeat(64)] }, repairSteps: ['control'],
  verification: { check: 'control-check', expected: 'control-expected' },
})
const root = () => join(mkdtempSync(join(tmpdir(), 'mse-recall-guard-')), 'mse-learning')
const seed = (engine, entries) => engine.store.transaction(doc => {
  doc.entries.push(...entries)
  return true
})

test('production selectRecall matches the approved v3 output on all 34 frozen cases', () => {
  const approved = compareV3(loadDefaultCases())
  const fixtures = loadDefaultCases()
  assert.equal(approved.cases.length, 34)
  for (const testCase of fixtures) {
    const want = approved.cases.find(row => row.id === testCase.id)
    const got = selectRecall(testCase.entries, { prompt: testCase.prompt,
      scope: testCase.scope, environment: testCase.environment, now: 0 })
    assert.deepEqual(got.offered, want.v3.offered, testCase.id)
    assert.equal(got.bytes, want.v3.bytes, testCase.id)
  }
})

test('engine.prepare stores 3 offers (2 methods + 1 guard), keeps method stats/guard facts separate, dedups and reloads', () => {
  const stateRoot = root()
  const engine = new RebuildEngine({ stateRoot })
  const m1 = entry('mem_aaaaaaaaaaaaaaaaaaaaaa01', 'rule', '先检查缓存和超时设置',
    '处理缓存超时', { updatedAt: 300 })
  const m2 = entry('mem_aaaaaaaaaaaaaaaaaaaaaa02', 'rule', '读取接口返回日志确认超时层级',
    '处理缓存超时', { updatedAt: 200 })
  const guard = entry('mem_aaaaaaaaaaaaaaaaaaaaaa03', 'lesson', '旧办法是直接增加重试次数',
    '缓存超时', { status: 'needs_revision', lesson: lesson(), updatedAt: 100 })
  seed(engine, [m1, m2, guard])
  const first = engine.prepare({ sessionId: 's1', turnId: 't1', projectKey: 'p1',
    prompt: '处理缓存超时并检查 JSON' })
  assert.equal(first.offered.length, 3)
  assert.deepEqual(first.offered.map(offer => offer.mode), ['method', 'method', 'guard'])
  assert.equal(first.bytes, Buffer.byteLength(first.context, 'utf8'))
  assert.ok(first.bytes <= 768)
  assert.match(first.context, /风险警示/u)
  assert.match(first.context, /具体失败模式/u)
  const doc = engine.store.read()
  validateDoc(doc)
  const receipt = doc.receipts.at(-1)
  assert.equal(receipt.offered.length, 3)
  assert.equal(receipt.bytes, first.bytes)
  assert.deepEqual(receipt.offered.map(offer => offer.mode), ['method', 'method', 'guard'])
  const rows = Object.fromEntries(doc.entries.map(row => [row.id, row]))
  assert.equal(rows[m1.id].methodStats.injected, 1)
  assert.equal(rows[m2.id].methodStats.injected, 1)
  assert.equal(rows[guard.id].methodStats, null, 'guard never gains methodStats')
  const again = engine.prepare({ sessionId: 's1', turnId: 't1', projectKey: 'p1',
    prompt: '处理缓存超时并检查 JSON' })
  assert.equal(again.reason, 'same_turn_dedup')
  assert.equal(engine.store.read().receipts.length, 1)
  const restarted = new RebuildEngine({ stateRoot })
  assert.deepEqual(restarted.store.read().receipts, doc.receipts, 'receipts reload after restart')
})

test('configured maxContextBytes > 768 still loads but production selection caps at 768', () => {
  const stateRoot = root()
  const engine = new RebuildEngine({ stateRoot, maxContextBytes: 1536 })
  const m1 = entry('mem_bbbbbbbbbbbbbbbbbbbbbb01', 'rule', '先检查缓存和超时设置',
    '处理缓存超时')
  const guard = entry('mem_bbbbbbbbbbbbbbbbbbbbbb02', 'lesson', '旧办法是直接增加重试次数',
    '缓存超时', { status: 'needs_revision', lesson: lesson() })
  seed(engine, [m1, guard])
  const prepared = engine.prepare({ sessionId: 's2', turnId: 't1', projectKey: 'p1',
    prompt: '处理缓存超时并检查 JSON' })
  assert.ok(prepared.bytes <= 768)
  assert.equal(engine.store.read().receipts.at(-1).bytes, prepared.bytes)
  const pure = selectRecall([m1, guard], { prompt: '处理缓存超时并检查 JSON',
    scope, environment, now: 0, maxBytes: 1536 })
  assert.ok(pure.bytes <= 768)
})

test('methods keep their 2-slot cap and guard-only/multi-guard cases append at most one', () => {
  const methods = Array.from({ length: 4 }, (_, index) => entry(
    `mem_cccccccccccccccccccc${String(index).padStart(2, '0')}`, 'rule',
    `先检查缓存和超时设置 ${index}`, '处理缓存超时', { updatedAt: 400 - index }))
  const one = entry('mem_cccccccccccccccccccc09', 'lesson', '旧办法是直接增加重试次数',
    '缓存超时', { status: 'needs_revision', lesson: lesson() })
  const out = selectRecall([...methods, one], { prompt: '处理缓存超时并检查 JSON',
    scope, environment, now: 0 })
  assert.equal(out.offered.filter(offer => offer.mode === 'method').length, MAX_METHODS_PER_TURN)
  assert.equal(out.offered.filter(offer => offer.mode === 'guard').length, 1)
  const guardOnly = selectRecall([one], { prompt: '处理缓存超时并检查 JSON',
    scope, environment, now: 0 })
  assert.equal(guardOnly.offered.length, 1)
  assert.equal(guardOnly.offered[0].mode, 'guard')
  const twoGuards = [one, entry('mem_cccccccccccccccccccc10', 'lesson',
    '旧办法是直接增加重试次数', '缓存超时', { status: 'needs_revision', lesson: lesson('另一个失败模式') })]
  const onlyOne = selectRecall(twoGuards, { prompt: '处理缓存超时并检查 JSON',
    scope, environment, now: 0 })
  assert.equal(onlyOne.offered.filter(offer => offer.mode === 'guard').length, 1)
})

test('remaining-byte / scope / retired / excluded gates never squeeze or truncate a guard', () => {
  const longA = entry('mem_dddddddddddddddddddd01', 'rule', '甲'.repeat(100), '处理缓存超时')
  const longB = entry('mem_dddddddddddddddddddd02', 'rule', '乙'.repeat(100), '处理缓存超时')
  const noFit = entry('mem_dddddddddddddddddddd03', 'lesson', '旧办法是直接增加重试次数',
    '缓存超时', { status: 'needs_revision', lesson: lesson() })
  const packed = recallSelection([longA, longB, noFit], { prompt: '处理缓存超时并检查 JSON',
    scope, environment, now: 0 })
  const selected = selectRecall([longA, longB, noFit], { prompt: '处理缓存超时并检查 JSON',
    scope, environment, now: 0 })
  assert.equal(selected.offered.filter(offer => offer.mode === 'guard').length, 0)
  assert.deepEqual(selected.lines, packed.lines, 'no method line is replaced or truncated')
  assert.ok(selected.bytes <= 768)
  const scopedGuard = entry('mem_dddddddddddddddddddd04', 'lesson', '旧办法是直接增加重试次数',
    '缓存超时', { status: 'needs_revision', lesson: lesson(), visibility: 'scoped',
      originScope: 'c'.repeat(64), originEnvironment: 'd'.repeat(64) })
  const retiredGuard = entry('mem_dddddddddddddddddddd05', 'lesson', '旧办法是直接增加重试次数',
    '缓存超时', { status: 'retired', lesson: lesson() })
  const excludedGuard = entry('mem_dddddddddddddddddddd06', 'lesson', '旧办法是直接增加重试次数',
    '缓存超时', { status: 'needs_revision', lesson: lesson(), exclusions: '处理缓存超时' })
  for (const guard of [scopedGuard, retiredGuard, excludedGuard]) {
    const out = selectRecall([longA, guard], { prompt: '处理缓存超时并检查 JSON',
      scope, environment, now: 0 })
    assert.equal(out.offered.filter(offer => offer.mode === 'guard').length, 0)
  }
})
