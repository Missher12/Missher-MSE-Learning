import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { compareNormalization, normalizedView, selectRecallNormalized }
  from './compare-normalization.mjs'
import { selectRecall, recallSelection } from '../../rebuild/recall.mjs'
import { loadDefaultCases } from './replay.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const controls = JSON.parse(readFileSync(join(here, '..', '..', 'tests', 'fixtures', 'rsi',
  'normalization-controls.json'), 'utf8')).cases

test('the only normalization is the existing log concept for a segmented 错误, deduped', () => {
  const error = normalizedView('修复缩进层级错误时')
  assert.ok(error.semantic.includes('log'))
  assert.equal(error.semantic.filter(key => key === 'log').length, 1)
  const withFormat = normalizedView('修复 YAML 缩进错误时')
  assert.ok(!withFormat.semantic.includes('log'),
    'a format-bearing text keeps its format boundary and is not normalized across formats')
  const bare = normalizedView('错误')
  assert.ok(bare.semantic.includes('log'))
  assert.equal(bare.semantic.filter(key => key === 'log').length, 1)
})

test('production 0.16.1 vs normalized candidate improves rsi-02 without new regressions', () => {
  const report = compareNormalization(loadDefaultCases())
  assert.equal(report.decision, 'candidate_signal')
  assert.deepEqual(report.overall.regressionCases, [])
  assert.deepEqual(report.overall.newMisses, [])
  assert.deepEqual(report.overall.newFalseOffers, [])
  assert.deepEqual(report.overall.newGuardMisses, [])
  const rsi02 = report.cases.find(row => row.id === 'rsi-02-indent-error-exact')
  assert.equal(rsi02.verdict, 'gain')
  assert.deepEqual(rsi02.candidate.offered.map(offer => offer.id),
    ['mem_rsi_indent_fix', 'mem_rsi_indent_levels'])
  assert.deepEqual(rsi02.candidate.falseOffers, [])
  assert.deepEqual(rsi02.newFalseOffers, [])
  assert.ok(rsi02.candidate.lines.some(line => line.includes('列表层级')))
  assert.equal(rsi02.candidate.bytes, 153)
  assert.equal(rsi02.candidate.caps.total, 2)
  assert.equal(rsi02.candidate.caps.methods, 2)
  assert.equal(rsi02.candidate.caps.bytesOk, true)
  const rsi10 = report.cases.find(row => row.id === 'rsi-10-applicability-regression')
  assert.deepEqual(rsi10.candidate.offered.map(offer => offer.id + ':' + offer.mode),
    ['mem_rsi_reg_method:method', 'mem_rsi_reg_third:method', 'mem_rsi_reg_guard:guard'])
  assert.equal(rsi10.candidate.bytes, 341)
  assert.equal(rsi10.candidate.caps.total, 3)
  assert.equal(rsi10.candidate.caps.guards, 1)
  assert.equal(rsi10.candidate.caps.bytesOk, true)
  assert.deepEqual(rsi10.newMisses, [])
  assert.deepEqual(rsi10.newFalseOffers, [])
  assert.deepEqual(rsi10.newGuardMisses, [])
})

test('format isolation and unrelated/negative controls do not create a new false offer or miss', () => {
  const report = compareNormalization(controls)
  for (const row of report.cases) {
    const expected = controls.find(testCase => testCase.id === row.id).expect
    for (const id of expected.relevant) {
      assert.ok(row.candidate.offered.some(offer => offer.id === id),
        `${row.id} must select expected relevant ${id}`)
    }
    assert.deepEqual(row.newMisses, [], `${row.id} no new miss`)
    assert.deepEqual(row.newFalseOffers, [], `${row.id} no new false offer`)
    assert.deepEqual(row.newGuardMisses, [], `${row.id} no new guard miss`)
    for (const id of expected.excluded) {
      if (row.baseline.falseOffers.includes(id)) continue // baseline-known false stays visible
      assert.ok(!row.candidate.offered.some(offer => offer.id === id),
        `${row.id} must not introduce excluded ${id}`)
    }
    assert.equal(row.candidate.caps.methods <= 2, true)
    assert.equal(row.candidate.caps.total <= 3, true)
    assert.equal(row.candidate.caps.bytesOk, true)
  }
  const positive = report.cases.find(row => row.id === 'norm-positive-error-object')
  assert.ok(positive.candidate.offered.some(offer => offer.id === 'mem_norm_positive_exact'))
  assert.deepEqual(positive.newFalseOffers, [],
    'the broad baseline false is not relabelled as a new candidate false')

  // Hard exclusions and the existing negation wording remain on their original behavior.
  const excludedEntry = structuredClone(controls[0].entries[0])
  excludedEntry.id = 'mem_norm_excluded_gate'
  excludedEntry.exclusions = 'YAML 配置缩进报错'
  const excludedOptions = { prompt: 'YAML 配置缩进报错', scope: 'a'.repeat(64),
    environment: 'b'.repeat(64), now: 0 }
  assert.equal(selectRecallNormalized([excludedEntry], excludedOptions).offered.length, 0)
  const negatedOptions = { ...excludedOptions, prompt: '不是 YAML 缩进错误，先检查配置' }
  assert.deepEqual(selectRecallNormalized([excludedEntry], negatedOptions).offered,
    selectRecall([excludedEntry], negatedOptions).offered,
    'candidate does not invent a different negation policy')
})

test('a deliberately broken candidate is reported as a new miss and no_go', () => {
  const control = loadDefaultCases().find(row => row.id === 'rsi-02-indent-error-exact')
  const broken = (entries, options) => {
    const selection = selectRecallNormalized(entries, options)
    return { ...selection, offered: selection.offered.filter(offer => offer.id !== 'mem_rsi_indent_fix') }
  }
  const report = compareNormalization([control], { candidate: broken })
  assert.equal(report.decision, 'no_go')
  assert.ok(report.overall.newMisses.some(item => item.id === 'mem_rsi_indent_fix'))
  assert.equal(report.deployAllowed, false)
})

test('import/CLI are offline, deterministic and understand only the frozen default cases', () => {
  const imported = spawnSync(process.execPath, ['--input-type=module', '--eval',
    `await import(${JSON.stringify(new URL('./compare-normalization.mjs', import.meta.url).href)})`],
    { encoding: 'utf8' })
  assert.equal(imported.status, 0, imported.stderr)
  assert.equal(imported.stdout, '')

  const run = spawnSync(process.execPath, [join(here, 'compare-normalization.mjs')], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const parsed = JSON.parse(run.stdout)
  assert.equal(parsed.schema, 'mse-recall-normalization-comparison-v1')
  assert.equal(parsed.decision, 'candidate_signal')
  assert.equal(parsed.deployAllowed, false)
  assert.equal(parsed.overall.cases, 34)
  assert.equal(parsed.cases.find(row => row.id === 'rsi-02-indent-error-exact').verdict, 'gain')
  const rejected = spawnSync(process.execPath,
    [join(here, 'compare-normalization.mjs'), '--cases=/tmp/x.json'], { encoding: 'utf8' })
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /--cases is not accepted/)

  const first = JSON.stringify(compareNormalization(loadDefaultCases()))
  const second = JSON.stringify(compareNormalization(loadDefaultCases()))
  assert.equal(first, second)
})

test('the comparison baseline is the current production selector, not the old 2-entry replay', () => {
  const testCase = loadDefaultCases().find(row => row.id === 'rsi-10-applicability-regression')
  const options = { prompt: testCase.prompt, scope: testCase.scope,
    environment: testCase.environment, now: 0 }
  const current = selectRecall(testCase.entries, options)
  const historical = recallSelection(testCase.entries, options)
  assert.equal(current.offered.length, 3)
  assert.equal(current.bytes, 341)
  assert.equal(historical.offered.length, 2, 'the old replay semantics remain separate and unchanged')
  assert.equal(historical.bytes, 137)
  const report = compareNormalization([testCase])
  assert.deepEqual(report.cases[0].baseline.offered, current.offered)
  assert.equal(report.cases[0].baseline.bytes, current.bytes)
})
