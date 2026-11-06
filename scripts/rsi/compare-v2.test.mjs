import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { compareV2, guardPreservingApplicabilityFirst } from './compare-v2.mjs'
import { compareRecall, loadDefaultCases } from './replay.mjs'
import { recallSelection, rankForRecall, packRecall } from '../../rebuild/recall.mjs'
import { createDoc, validateDoc } from '../../rebuild/memory.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const comparisonFixture = JSON.parse(readFileSync(
  join(here, '..', '..', 'tests', 'fixtures', 'rsi', 'recall-comparison.json'), 'utf8'))
const guardCase = comparisonFixture.cases.find(row => row.id === 'rsi-05-guard-mode')
const methodCase = comparisonFixture.cases.find(row => row.id === 'rsi-10-applicability-regression')

const entry = (id, type, instruction, applicability, {
  status = 'user_rule', lesson = null, updatedAt = 100, visibility = 'global',
  originScope = 'control-scope', originEnvironment = 'control-env',
} = {}) => ({
  id, type, status, instruction, applicability, exclusions: '', visibility,
  originScope, originEnvironment, originSession: null, lesson, problemSignature: null,
  version: 1, parentVersion: null, superseded: null, injected: 0, recurrences: 0,
  createdAt: updatedAt, updatedAt, lastInjectedAt: null, evidenceHash: null,
  methodStats: null, factDigest: null, digestDay: null, importedFrom: null,
})
const lesson = (pattern = '盲目延长超时') => ({
  problemId: 'f'.repeat(64), evidenceRevision: 0, evidenceIds: ['a'.repeat(64)],
  failurePattern: pattern, rootCause: { summary: 'control', basis: 'hypothesis',
    evidenceIds: ['a'.repeat(64)] }, repairSteps: ['control'],
  verification: { check: 'control-check', expected: 'control-expected' },
})
const controlCase = (id, entries, expect = {}) => ({ id, source: 'synthetic_control',
  critical: true, prompt: '处理缓存超时并检查 JSON', scope: 'control-scope',
  environment: 'control-env', entries, expect })

test('v2 keeps the measured rsi-01 gain and restores rsi-10 baseline methods', () => {
  const report = compareV2(loadDefaultCases())
  const gain = report.cases.find(row => row.id === 'rsi-01-applicability-vs-broad-format')
  assert.equal(gain.verdict, 'gain')
  assert.equal(gain.v1Verdict, 'gain')
  const regression = report.cases.find(row => row.id === 'rsi-10-applicability-regression')
  assert.equal(regression.v1Verdict, 'regression')
  assert.equal(regression.verdict, 'unchanged')
  assert.deepEqual(regression.v2.offered.map(offer => offer.id),
    ['mem_rsi_reg_method', 'mem_rsi_reg_third'])
  assert.deepEqual(regression.v2.guardMisses, ['mem_rsi_reg_guard'],
    'the original baseline guard gap remains visible, not invented as a new gain')
  assert.equal(report.overall.criticalRegressions, 0)
  assert.equal(report.decision, 'offline_signal_only')
  assert.equal(report.deployAllowed, false)
  assert.equal(report.automaticPromotion, false)
})

test('v2 keeps the prior 24 known quality facts with no new regressions', () => {
  const report = compareV2(loadDefaultCases())
  const existing = report.cases.filter(row => row.source === 'existing_24_regression')
  assert.equal(existing.length, 24)
  for (const row of existing) {
    assert.deepEqual(row.v2.offered.map(offer => offer.id).sort(),
      row.baseline.offered.map(offer => offer.id).sort(), `${row.id} v2 keeps the same baseline ids`)
    const sorted = values => [...values].sort()
    assert.deepEqual({
      hits: sorted(row.v2.hits), misses: sorted(row.v2.misses),
      falseOffers: sorted(row.v2.falseOffers), guardMisses: sorted(row.v2.guardMisses),
      bytes: row.v2.bytes,
    }, {
      hits: sorted(row.baseline.hits), misses: sorted(row.baseline.misses),
      falseOffers: sorted(row.baseline.falseOffers), guardMisses: sorted(row.baseline.guardMisses),
      bytes: row.baseline.bytes,
    }, `${row.id} v2 keeps baseline quality facts`)
    assert.ok(['unchanged', 'changed'].includes(row.verdict),
      `${row.id} no new v2 quality claim`)
    assert.equal(row.v2Audit.guardPreservationFallback, false)
  }
})

test('a valid guard-only and a guard in front/middle stay visible as guard mode', () => {
  const front = controlCase('control-guard-front', [
    entry('c_guard_front', 'lesson', '旧办法：直接增加重试次数',
      '处理缓存超时并检查 JSON', { status: 'needs_revision', lesson: lesson() }),
    entry('c_rule_front', 'rule', '先检查缓存和超时设置', '处理缓存', { updatedAt: 200 }),
  ], { guards: ['c_guard_front'], relevant: ['c_rule_front'] })
  const report = compareV2([front])
  assert.equal(report.cases[0].v2.offered[0].id, 'c_guard_front')
  assert.equal(report.cases[0].v2.offered[0].mode, 'guard')
  assert.equal(report.cases[0].v2.guardMisses.length, 0)

  const valid = compareV2([guardCase])
  assert.deepEqual(valid.cases[0].v2.offered,
    [{ id: 'mem_rsi_guard_deploy', version: 1, mode: 'guard' }])
  assert.deepEqual(valid.cases[0].v2.guardMisses, [])
  assert.equal(valid.cases[0].verdict, 'unchanged')
})

test('a guard in the middle keeps its original rank position while methods reorder around it', () => {
  const lead = entry('c_lead', 'rule', '生成 JSON 时先删除尾逗号并校验', '整理交付时',
    { updatedAt: 300 })
  const middleGuard = entry('c_middle_guard', 'lesson', '旧办法：直接增加重试次数',
    '处理缓存超时', { status: 'needs_revision', lesson: lesson(), updatedAt: 200 })
  const method = entry('c_method', 'rule', '先检查缓存和超时设置', '处理缓存', { updatedAt: 100 })
  const control = controlCase('control-guard-middle', [lead, middleGuard, method],
    { relevant: ['c_method'], guards: ['c_middle_guard'] })
  const report = compareV2([control])
  const row = report.cases[0]
  assert.deepEqual(row.v2.offered.map(offer => offer.id + ':' + offer.mode),
    ['c_method:method', 'c_middle_guard:guard'])
  assert.equal(row.v2.offered[1].id, 'c_middle_guard')
  assert.deepEqual(row.v2.guardMisses, [])
  assert.equal(row.v2Audit.guardPreservationFallback, false)
})

test('legal byte-boundary reorder that would drop a baseline-selected guard falls back to baseline and audits it', () => {
  const scope = 'a'.repeat(64)
  const environment = 'b'.repeat(64)
  const shortId = 'mem_111111111111111111111111'
  const guardId = 'mem_222222222222222222222222'
  const longId = 'mem_333333333333333333333333'
  const short = entry(shortId, 'rule', '生成 JSON 时先删除尾逗号并校验',
    '整理交付时', { updatedAt: 300, originScope: scope, originEnvironment: environment })
  const guard = entry(guardId, 'lesson', '旧办法是直接增加重试次数', '处理缓存超时',
    { status: 'needs_revision', lesson: lesson('缓存超时错误'.repeat(10)), updatedAt: 200,
      originScope: scope, originEnvironment: environment })
  const long = entry(longId, 'rule',
    ('处理缓存问题并检查输出，' + '逐项核对并保留原始记录，'.repeat(20)).slice(0, 156),
    '处理缓存', { updatedAt: 100, originScope: scope, originEnvironment: environment })
  const control = controlCase('control-byte-fallback', [short, guard, long],
    { relevant: [shortId], guards: [guardId] })
  control.scope = scope
  control.environment = environment
  control.prompt = '处理缓存超时并检查 JSON'
  assert.ok([...long.instruction].length <= 240)
  assert.ok(Buffer.byteLength(long.instruction, 'utf8') <= 480)
  const doc = createDoc()
  doc.entries = [short, guard, long]
  assert.doesNotThrow(() => validateDoc(doc), 'the control entries satisfy the real memory validator')
  const options = { prompt: control.prompt, scope, environment, now: 0 }
  const baseline = recallSelection(control.entries, options)
  assert.deepEqual(baseline.offered.map(offer => offer.id + ':' + offer.mode),
    [shortId + ':method', guardId + ':guard'])
  assert.equal(baseline.bytes, 408)
  const ranked = rankForRecall(control.entries, options)
  const guardRow = ranked.find(row => row.entry.id === guardId)
  const shortRow = ranked.find(row => row.entry.id === shortId)
  const longRow = ranked.find(row => row.entry.id === longId)
  const unprotected = packRecall([longRow, guardRow, shortRow], options)
  assert.deepEqual(unprotected.offered.map(offer => offer.id + ':' + offer.mode),
    [longId + ':method', shortId + ':method'])
  assert.equal(unprotected.bytes, 534)
  assert.ok(!unprotected.offered.some(offer => offer.id === guardId))
  const raw = guardPreservingApplicabilityFirst(control.entries, options)
  assert.equal(raw.guardPreservationFallback, true)
  assert.deepEqual(raw.missingGuards.map(offer => offer.id), [guardId])
  assert.deepEqual(raw.offered, baseline.offered)
  assert.equal(raw.bytes, baseline.bytes)
  const report = compareV2([control])
  assert.deepEqual(report.fallbackCases, ['control-byte-fallback'])
  assert.equal(report.fallbackAudit[0].guardPreservationFallback, true)
  assert.deepEqual(report.cases[0].v2.offered, baseline.offered,
    'fallback returns the real baseline selection')
  assert.equal(report.cases[0].v2Audit.guardPreservationFallback, true)
  assert.equal(report.decision, 'no_measured_gain', 'fallback is not scored as a gain')
})

test('scope, retirement, budget and method cap are not bypassed by v2', () => {
  const report = compareV2(loadDefaultCases())
  const scope = report.cases.find(row => row.id === 'rsi-03-scope-isolation')
  assert.ok(!JSON.stringify(scope.v2.offered).includes('mem_rsi_scope_other'))
  const retired = report.cases.find(row => row.id === 'rsi-04-retired-filter')
  assert.ok(!JSON.stringify(retired.v2.offered).includes('mem_rsi_retired_csv'))
  for (const row of report.cases) {
    assert.ok(row.v2.offered.length <= 2)
    assert.ok(row.v2.bytes <= 768)
    assert.equal(row.v2.overBudget, false)
  }
})

test('the selector does not receive or read case labels/metadata; changed id only changes output ids', () => {
  const a = controlCase('control-a', [entry('a1', 'rule', '先检查缓存', '处理缓存超时')])
  const b = controlCase('control-b', [entry('b1', 'rule', '先检查缓存', '处理缓存超时')])
  const first = guardPreservingApplicabilityFirst(a.entries, { prompt: a.prompt,
    scope: a.scope, environment: a.environment, now: 0 })
  const second = guardPreservingApplicabilityFirst(b.entries, { prompt: b.prompt,
    scope: b.scope, environment: b.environment, now: 0 })
  assert.deepEqual(first.offered.map(offer => offer.id), ['a1'])
  assert.deepEqual(second.offered.map(offer => offer.id), ['b1'])
  assert.equal(first.offered[0].mode, 'method')
  assert.equal(second.offered[0].mode, 'method')
  const atZero = guardPreservingApplicabilityFirst(a.entries, { prompt: a.prompt,
    scope: a.scope, environment: a.environment, now: 0 })
  const atLater = guardPreservingApplicabilityFirst(a.entries, { prompt: a.prompt,
    scope: a.scope, environment: a.environment, now: 99_999 })
  assert.deepEqual(atLater.offered, atZero.offered)
  assert.equal(atLater.bytes, atZero.bytes)
})

test('import has no side effects and the CLI only uses the frozen default fixtures', () => {
  const replayUrl = new URL('./compare-v2.mjs', import.meta.url).href
  const imported = spawnSync(process.execPath, ['--input-type=module', '--eval',
    `await import(${JSON.stringify(replayUrl)})`], { encoding: 'utf8' })
  assert.equal(imported.status, 0, imported.stderr)
  assert.equal(imported.stdout, '')

  const run = spawnSync(process.execPath, [join(here, 'compare-v2.mjs')], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const parsed = JSON.parse(run.stdout)
  assert.equal(parsed.schema, 'mse-rsi-recall-comparison-v2')
  assert.equal(parsed.candidateName, 'guard-preserving-method-applicability-v2')
  assert.equal(parsed.decision, 'offline_signal_only')
  assert.equal(parsed.deployAllowed, false)
  assert.equal(parsed.overall.caseCount, 34)
  assert.equal(parsed.fallbackCases.length, 0)
  const rejected = spawnSync(process.execPath, [join(here, 'compare-v2.mjs'), '--cases=/tmp/x.json'],
    { encoding: 'utf8' })
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /--cases is not accepted/)
})

test('same frozen input gives identical v2 output', () => {
  assert.equal(JSON.stringify(compareV2(loadDefaultCases())),
    JSON.stringify(compareV2(loadDefaultCases())))
})
