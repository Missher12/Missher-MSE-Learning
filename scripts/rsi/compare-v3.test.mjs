import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { compareV3, v2PlusOneGuardOfflineV3, V3_POLICY } from './compare-v3.mjs'
import { compareV2, guardPreservingApplicabilityFirst } from './compare-v2.mjs'
import { loadDefaultCases } from './replay.mjs'
import { recallSelection } from '../../rebuild/recall.mjs'
import { createDoc, validateDoc } from '../../rebuild/memory.mjs'

const here = dirname(fileURLToPath(import.meta.url))
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
const controlCase = (id, entries, expect = {}) => ({ id, source: 'synthetic_control',
  critical: true, prompt: '处理缓存超时并检查 JSON', scope, environment, entries, expect })
const docFor = entries => {
  const doc = createDoc()
  doc.entries = entries
  validateDoc(doc)
  return doc
}

test('v3 closes rsi-10 guard gap only by an explicit third entry; strict evaluator stays no_go', () => {
  const cases = loadDefaultCases()
  const v2 = compareV2(cases)
  const v3 = compareV3(cases)
  for (let index = 0; index < cases.length; index += 1) {
    assert.deepEqual(v3.cases[index].baseline, v2.cases[index].baseline)
    assert.deepEqual(v3.cases[index].v2, v2.cases[index].v2)
    assert.equal(v3.cases[index].v2Verdict, v2.cases[index].verdict,
      `${v3.cases[index].id} v2Verdict must come from the real v2 row`)
  }
  const rsi01 = v3.cases.find(row => row.id === 'rsi-01-applicability-vs-broad-format')
  assert.equal(rsi01.v3Verdict, 'gain')
  assert.equal(rsi01.v3.hits.length, 2)
  const rsi10 = v3.cases.find(row => row.id === 'rsi-10-applicability-regression')
  assert.deepEqual(rsi10.v2.offered.map(offer => offer.id),
    ['mem_rsi_reg_method', 'mem_rsi_reg_third'])
  assert.deepEqual(rsi10.v3.offered.map(offer => offer.id + ':' + offer.mode),
    ['mem_rsi_reg_method:method', 'mem_rsi_reg_third:method', 'mem_rsi_reg_guard:guard'])
  assert.equal(rsi10.v3.bytes, 341)
  assert.equal(rsi10.v3.overBudget, true, 'the unchanged evaluator must count the third entry')
  assert.deepEqual(rsi10.v3.guardMisses, [])
  assert.equal(rsi10.v3Audit.ok, true)
  assert.equal(rsi10.v3Audit.appendedGuard.id, 'mem_rsi_reg_guard')
  assert.equal(rsi10.v3Audit.appendedGuard.mode, 'guard')
  assert.ok(rsi10.v3Lines.some(line => line.includes('风险警示')))
  assert.ok(rsi10.v3Lines.some(line => line.includes('延长超时掩盖上游故障')))
  assert.equal(v3.strictPolicyDecision, 'no_go')
  assert.equal(v3.experimentalPolicyDecision, 'experimental_candidate_requires_policy_change')
  assert.equal(v3.overall.overBudgetCases, 1)
  assert.equal(v3.overall.extraEntries, 1)
  assert.equal(v3.overall.extraBytes, 204)
  assert.equal(v3.overall.newVsV2.misses.length, 0)
  assert.equal(v3.overall.newVsV2.falseOffers.length, 0)
  assert.equal(v3.overall.newVsV2.guardMisses.length, 0)
  assert.equal(v3.deployAllowed, false)
  assert.equal(v3.automaticPromotion, false)
  assert.deepEqual(v3.policy, V3_POLICY)
})

test('mixed positive/negative control: a new false offer hard-rejects the experiment', () => {
  const cases = loadDefaultCases()
  const positive = cases.find(row => row.id === 'rsi-10-applicability-regression')
  const negative = {
    ...positive,
    id: 'independent-negative-guard-control',
    source: 'synthetic_control',
    critical: false,
    expect: {
      relevant: [...positive.expect.relevant],
      excluded: ['mem_rsi_reg_guard'],
      guards: [],
    },
  }
  const report = compareV3([positive, negative])
  assert.equal(report.experimentalPolicyDecision, 'no_go_quality_regression')
  assert.deepEqual(report.overall.qualityRegressions,
    [{ caseId: 'independent-negative-guard-control', id: 'mem_rsi_reg_guard', kind: 'falseOffer' }])
  assert.ok(report.overall.newVsV2.falseOffers.includes('mem_rsi_reg_guard'))
  const negativeRow = report.cases.find(row => row.id === 'independent-negative-guard-control')
  assert.deepEqual(negativeRow.v3.falseOffers, ['mem_rsi_reg_guard'],
    'the added guard is explicitly counted as a new false offer')
  assert.deepEqual(negativeRow.v3.guardMisses, [],
    'the false offer cannot be hidden as a guard hit')
  assert.equal(report.deployAllowed, false)
  const original = compareV3(loadDefaultCases())
  assert.equal(original.experimentalPolicyDecision,
    'experimental_candidate_requires_policy_change',
    'the original 34 cases still keep their original experimental feasibility result')
})

test('v3 appends nothing when v2 already contains a guard, and audit says why', () => {
  const cases = loadDefaultCases()
  const v3 = compareV3(cases)
  for (const id of ['rsi-05-guard-mode', 'rsi-04-retired-filter']) {
    const row = v3.cases.find(testCase => testCase.id === id)
    assert.deepEqual(row.v3.offered, row.v2.offered)
    assert.equal(row.v3Audit.extraCount, 0)
  }
  const guardCase = v3.cases.find(row => row.id === 'rsi-05-guard-mode')
  assert.equal(guardCase.v3Audit.reason, 'already_has_guard')
  assert.deepEqual(guardCase.v3.offered.map(offer => offer.mode), ['guard'])
})

test('missing guard returns v2 exactly; legal near-budget entries cannot squeeze or truncate', () => {
  const methodA = entry('mem_aaaaaaaaaaaaaaaaaaaaaa01', 'rule', '甲'.repeat(100),
    '处理缓存超时', { updatedAt: 300 })
  const methodB = entry('mem_aaaaaaaaaaaaaaaaaaaaaa02', 'rule', '乙'.repeat(100),
    '处理缓存超时', { updatedAt: 200 })
  const guard = entry('mem_aaaaaaaaaaaaaaaaaaaaaa03', 'lesson', '旧办法是直接增加重试次数',
    '缓存超时', { status: 'needs_revision', lesson: lesson(), updatedAt: 100 })
  const near = controlCase('control-near-budget', [methodA, methodB, guard],
    { relevant: ['mem_aaaaaaaaaaaaaaaaaaaaaa01', 'mem_aaaaaaaaaaaaaaaaaaaaaa02'],
      guards: ['mem_aaaaaaaaaaaaaaaaaaaaaa03'] })
  docFor(near.entries)
  const v2 = recallSelection(near.entries, { prompt: near.prompt, scope, environment, now: 0 })
  assert.deepEqual(v2.offered.map(offer => offer.id),
    ['mem_aaaaaaaaaaaaaaaaaaaaaa01', 'mem_aaaaaaaaaaaaaaaaaaaaaa02'])
  assert.ok(v2.bytes > 768 - 204, 'the two methods leave less than one real guard line')
  const result = v2PlusOneGuardOfflineV3(near.entries, { prompt: near.prompt,
    scope, environment, now: 0 })
  assert.equal(result.v3Audit.reason, 'guard_does_not_fit')
  assert.deepEqual(result.offered, v2.offered)
  assert.deepEqual(result.lines, v2.lines)
  assert.equal(result.bytes, v2.bytes)
  assert.equal(result.v3Audit.extraCount, 0)
  assert.equal(result.v3Audit.ok, true)

  const noGuard = controlCase('control-no-guard', [methodA], { relevant: [methodA.id] })
  docFor(noGuard.entries)
  const noGuardV2 = recallSelection(noGuard.entries, { prompt: noGuard.prompt,
    scope, environment, now: 0 })
  const noGuardV3 = v2PlusOneGuardOfflineV3(noGuard.entries, { prompt: noGuard.prompt,
    scope, environment, now: 0 })
  assert.equal(noGuardV3.v3Audit.reason, 'no_unoffered_guard')
  assert.deepEqual(noGuardV3.offered, noGuardV2.offered)
  assert.equal(noGuardV3.bytes, noGuardV2.bytes)
})

test('scope/retired/excluded guards never become the appended third entry', () => {
  const base = [
    entry('mem_bbbbbbbbbbbbbbbbbbbbbb01', 'rule', '先检查缓存和超时设置', '处理缓存超时'),
  ]
  const cases = [
    controlCase('control-scope', [...base, entry('mem_bbbbbbbbbbbbbbbbbbbbbb02', 'lesson',
      '旧办法是直接增加重试次数', '处理缓存超时', { status: 'needs_revision',
        lesson: lesson(), visibility: 'scoped', originScope: 'c'.repeat(64),
        originEnvironment: 'd'.repeat(64) })], { relevant: [base[0].id] }),
    controlCase('control-retired', [...base, entry('mem_bbbbbbbbbbbbbbbbbbbbbb03', 'lesson',
      '旧办法是直接增加重试次数', '处理缓存超时', { status: 'retired',
        lesson: lesson(), updatedAt: 50 })], { relevant: [base[0].id] }),
    controlCase('control-excluded', [...base, entry('mem_bbbbbbbbbbbbbbbbbbbbbb04', 'lesson',
      '旧办法是直接增加重试次数', '处理缓存超时', { status: 'needs_revision',
        lesson: lesson(), exclusions: '处理缓存超时' })], { relevant: [base[0].id] }),
  ]
  for (const testCase of cases) {
    docFor(testCase.entries)
    const result = v2PlusOneGuardOfflineV3(testCase.entries, { prompt: testCase.prompt,
      scope, environment, now: 0 })
    assert.equal(result.v3Audit.extraCount, 0, `${testCase.id} must not append`)
    assert.deepEqual(result.offered, guardPreservingApplicabilityFirst(testCase.entries, {
      prompt: testCase.prompt, scope, environment, now: 0 }).offered)
  }
})

test('selector ignores case metadata, is deterministic, and CLI has no side effects', () => {
  const method = entry('mem_cccccccccccccccccccccc01', 'rule', '先检查缓存和超时设置', '处理缓存超时')
  const guard = entry('mem_cccccccccccccccccccccc02', 'lesson', '旧办法是直接增加重试次数',
    '处理缓存超时', { status: 'needs_revision', lesson: lesson() })
  const first = controlCase('control-id-a', [method, guard], { relevant: [method.id], guards: [guard.id] })
  const second = controlCase('control-id-b', [method, guard], { relevant: [method.id], guards: [guard.id] })
  docFor(first.entries); docFor(second.entries)
  const a = v2PlusOneGuardOfflineV3(first.entries, { prompt: first.prompt, scope, environment, now: 0 })
  const b = v2PlusOneGuardOfflineV3(second.entries, { prompt: second.prompt, scope, environment, now: 0 })
  assert.deepEqual(a.offered, b.offered)
  assert.equal(a.bytes, b.bytes)
  const atLater = v2PlusOneGuardOfflineV3(first.entries, { prompt: first.prompt, scope, environment, now: 99_999 })
  assert.deepEqual(atLater.offered, a.offered)
  assert.equal(atLater.bytes, a.bytes)

  const cli = spawnSync(process.execPath, [join(here, 'compare-v3.mjs')], { encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stderr)
  const report = JSON.parse(cli.stdout)
  assert.equal(report.schema, 'mse-rsi-recall-comparison-v3')
  assert.equal(report.strictPolicyDecision, 'no_go')
  assert.equal(report.experimentalPolicyDecision, 'experimental_candidate_requires_policy_change')
  assert.equal(report.deployAllowed, false)
  assert.equal(report.overall.caseCount, 34)
  const imported = spawnSync(process.execPath, ['--input-type=module', '--eval',
    `await import(${JSON.stringify(new URL('./compare-v3.mjs', import.meta.url).href)})`],
    { encoding: 'utf8' })
  assert.equal(imported.status, 0, imported.stderr)
  assert.equal(imported.stdout, '')
  const rejected = spawnSync(process.execPath, [join(here, 'compare-v3.mjs'), '--cases=/tmp/x.json'],
    { encoding: 'utf8' })
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /--cases is not accepted/)
})
