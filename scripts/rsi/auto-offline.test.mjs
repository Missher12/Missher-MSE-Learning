import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { assessComparison, runAutoOffline } from './auto-offline.mjs'
import { compareNormalization, selectRecallNormalized } from './compare-normalization.mjs'
import { loadDefaultCases } from './replay.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const controls = [
  ...JSON.parse(readFileSync(join(here, '..', '..', 'tests', 'fixtures', 'rsi',
    'normalization-controls.json'), 'utf8')).cases,
  ...JSON.parse(readFileSync(join(here, '..', '..', 'tests', 'fixtures', 'rsi',
    'auto-independent-controls.json'), 'utf8')).cases,
]

test('discovers the whole-word error-to-log proposal from a missed method and runs controls once after freeze', () => {
  const cases = loadDefaultCases()
  let controlLoads = 0
  const report = runAutoOffline({ discoveryCases: cases, loadControlCases: () => {
    controlLoads += 1
    return controls
  } })

  assert.equal(controlLoads, 1)
  assert.equal(report.proposals.length, 1)
  assert.equal(report.proposals[0].rule.sourceWord, '错误')
  assert.equal(report.proposals[0].rule.conceptId, 'log')
  assert.ok(report.proposals[0].evidence.some(row => row.methodText.includes('错误')))
  assert.equal(report.frozenCandidate.id, report.proposals[0].id)
  assert.equal(report.recommendation, 'offline_recommendation')
  assert.equal(report.automaticPromotion, false)
  assert.equal(report.discovery.cases.length, 34)

  const target = report.discovery.cases.find(row => row.id === 'rsi-02-indent-error-exact')
  assert.deepEqual(target.baseline.misses, ['mem_rsi_indent_levels'])
  assert.deepEqual(target.candidate.misses, [])
  assert.equal(target.candidate.methods, 2)
  assert.equal(target.candidate.guards, 0)
  assert.equal(target.candidate.bytes, 153)
  assert.equal(target.candidate.bytesVerified, true)
  assert.equal(target.candidate.methodLines, target.candidate.methods)
  assert.equal(target.candidate.guardLines, target.candidate.guards)
  assert.equal(report.controls.cases.length, 9)
  const independentGains = report.controls.independentGainCases.map(row => row.caseId)
  assert.ok(independentGains.includes('new_indentation'))
  assert.ok(!independentGains.includes('norm-positive-error-object'),
    'the exact discovery prompt cannot count as independent gain evidence')

  const renamed = structuredClone(cases.find(row => row.id === target.id))
  renamed.id = 'renamed-sample'
  const renamedReport = runAutoOffline({ discoveryCases: [renamed], loadControlCases: () => [] })
  assert.equal(renamedReport.proposals[0].evidence[0].caseId, 'renamed-sample')
  assert.equal(renamedReport.proposals[0].rule.sourceWord, '错误')
})

test('control evidence needs a labeled gain on a normalized prompt absent from discovery', () => {
  const cases = loadDefaultCases()
  const unrelated = controls.find(row => row.id === 'copy_error_not_backend_error')
  const noGain = runAutoOffline({ discoveryCases: cases, loadControlCases: () => [unrelated] })
  assert.equal(noGain.controls.overall.gainCases.length, 0)
  const unchanged = noGain.controls.cases.find(row => row.id === unrelated.id)
  assert.deepEqual(unchanged.candidate.offers, unchanged.baseline.offers)
  assert.equal(unchanged.candidate.bytes, unchanged.baseline.bytes)
  assert.equal(noGain.recommendation, 'retain_baseline')
  assert.equal(noGain.controls.status, 'evidence_insufficient')
  assert.equal(noGain.recommendationReason, 'controls_no_independent_gain_on_new_prompt')

  const duplicatePrompt = { ...structuredClone(cases.find(row => row.id === 'rsi-02-indent-error-exact')),
    id: 'renamed-control-only', source: 'synthetic_control' }
  const repeated = runAutoOffline({ discoveryCases: cases,
    loadControlCases: () => [duplicatePrompt] })
  assert.equal(repeated.controls.overall.gainCases.length, 1)
  assert.equal(repeated.controls.independentGainCases.length, 0)
  assert.equal(repeated.recommendation, 'retain_baseline')
  assert.equal(repeated.controls.status, 'evidence_insufficient')
})

test('new unlabeled selections are evidence_insufficient without changing comparator labels', () => {
  const caseRow = { id: 'unlabelled-control', source: 'synthetic_control',
    prompt: '与候选无关的任务', scope: 'a'.repeat(64), environment: 'b'.repeat(64),
    entries: [], expect: { relevant: [], excluded: [], guards: [] } }
  const report = compareNormalization([caseRow], { candidate: () => ({
    offered: [{ id: 'mem_unjudged_offer', version: 1, mode: 'method' }],
    lines: ['\n- 经验：未裁定'], bytes: Buffer.byteLength('\n- 经验：未裁定', 'utf8'),
  }) })
  const assessment = assessComparison(report)
  assert.equal(report.cases[0].candidate.unknownSelected[0], 'mem_unjudged_offer')
  assert.equal(assessment.status, 'evidence_insufficient')
  assert.deepEqual(assessment.newUnknownSelections,
    [{ caseId: 'unlabelled-control', id: 'mem_unjudged_offer' }])
})

test('one explicit false regression blocks a discovery gain', () => {
  const gainCase = loadDefaultCases().find(row => row.id === 'rsi-02-indent-error-exact')
  const negative = { ...structuredClone(gainCase), id: 'synthetic-negative',
    source: 'synthetic_control',
    expect: { relevant: [], excluded: ['mem_rsi_indent_levels'], guards: [] } }
  const report = compareNormalization([gainCase, negative], {
    candidate: (entries, options) => selectRecallNormalized(entries, options),
  })
  assert.equal(report.overall.gainCases.includes(gainCase.id), true)
  const assessment = assessComparison(report)
  assert.equal(assessment.status, 'blocked_regression')
  assert.deepEqual(assessment.newFalseOffers,
    [{ caseId: 'synthetic-negative', id: 'mem_rsi_indent_levels' }])
})

test('changing a selected method into a warning is a hard per-case mode regression', () => {
  const testCase = loadDefaultCases().find(row => row.id === 'rsi-02-indent-error-exact')
  const changedMode = (entries, options) => {
    const selection = selectRecallNormalized(entries, options)
    const firstLine = selection.lines[0].replace(/^\n- (?:经验|项目规则)：/u, '\n- 风险警示：')
    const lines = [firstLine, ...selection.lines.slice(1)]
    const offered = selection.offered.map((offer, index) => index === 0
      ? { ...offer, mode: 'guard' } : offer)
    return { ...selection, offered, lines, bytes: Buffer.byteLength(lines.join(''), 'utf8') }
  }
  const report = compareNormalization([testCase], { candidate: changedMode })
  const assessment = assessComparison(report)
  assert.equal(assessment.status, 'blocked_regression')
  assert.ok(assessment.modeChanges.some(row => row.id === 'mem_rsi_indent_fix'
    && row.baselineMode === 'method' && row.candidateMode === 'guard'))
})

test('the local CLI emits the same offline recommendation on repeated runs', () => {
  const command = join(here, 'auto-offline.mjs')
  const first = spawnSync(process.execPath, [command], { encoding: 'utf8' })
  const second = spawnSync(process.execPath, [command], { encoding: 'utf8' })
  assert.equal(first.status, 0, first.stderr)
  assert.equal(second.status, 0, second.stderr)
  assert.equal(first.stdout, second.stdout)
  const report = JSON.parse(first.stdout)
  assert.equal(report.recommendation, 'offline_recommendation')
  assert.equal(report.baseline.sampleCases, 34)
  assert.equal(report.controls.cases.length, 9)
  assert.deepEqual(report.controls.independentGainCases.map(row => row.caseId)
    .includes('new_indentation'), true)
})
