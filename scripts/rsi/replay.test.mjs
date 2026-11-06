import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  compareRecall, baselineRecall, applicabilityFirstRecall, normalizeCases,
  loadDefaultCases, MAX_BYTES, MAX_ENTRIES,
} from './replay.mjs'
import { recallSelection, rankForRecall } from '../../rebuild/recall.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(here, '..', '..', 'tests', 'fixtures', 'rsi', 'recall-comparison.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const cases = fixture.cases
const byId = id => cases.find(testCase => testCase.id === id)

// The pre-existing 24-case fixture is the immutable known regression set.
const existingFixture = JSON.parse(readFileSync(
  join(here, '..', '..', 'tests', 'fixtures', 'recall-cases.json'), 'utf8')).cases

test('existing 24-case baseline selection/order/bytes equals direct recallSelection', () => {
  const report = compareRecall(existingFixture.map(testCase => ({ ...testCase,
    source: 'existing_24_regression', critical: true })))
  assert.equal(report.groups.length, 1)
  assert.equal(report.groups[0].caseCount, 24)
  assert.equal(report.groups[0].criticalRegressions, 0)
  for (const row of report.cases) {
    const direct = recallSelection(byIdExisting(row.id).entries, {
      prompt: byIdExisting(row.id).prompt,
      scope: byIdExisting(row.id).scope,
      environment: byIdExisting(row.id).environment,
      now: 0,
    })
    assert.deepEqual(row.baseline.offered, direct.offered, `${row.id} offer order`)
    assert.equal(row.baseline.bytes, direct.bytes, `${row.id} bytes`)
    const expected = byIdExisting(row.id).expect ?? {}
    const selected = row.baseline.offered.map(offer => offer.id)
    assert.deepEqual(row.baseline.hits,
      selected.filter(id => (expected.relevant ?? []).includes(id)))
    assert.deepEqual(row.baseline.falseOffers,
      selected.filter(id => (expected.excluded ?? []).includes(id)))
  }
})

const byIdExisting = id => existingFixture.find(testCase => testCase.id === id)

test('applicability-first only stably partitions the existing ranked list', () => {
  const testCase = byId('rsi-01-applicability-vs-broad-format')
  const options = { prompt: testCase.prompt, scope: testCase.scope,
    environment: testCase.environment, now: 0 }
  const ranked = rankForRecall(testCase.entries, options)
  const reordered = applicabilityFirstRecall(testCase.entries, options)
  assert.deepEqual(reordered.offered.map(offer => offer.id),
    ['mem_rsi_exact_fix', 'mem_rsi_exact_validate'])
  assert.equal(reordered.offered.length, MAX_ENTRIES)
  assert.ok(reordered.bytes <= MAX_BYTES)
  const baseline = baselineRecall(testCase.entries, options)
  assert.deepEqual(baseline.offered.map(offer => offer.id),
    ['mem_rsi_broad_json', 'mem_rsi_exact_fix'])
  // The candidate is a partition, not a score/byte/filter change in rankForRecall.
  assert.deepEqual(ranked.map(row => row.entry.id), ['mem_rsi_broad_json',
    'mem_rsi_exact_fix', 'mem_rsi_exact_validate'])
})

test('scope/retirement/guard/budget gates are preserved and stay bounded', () => {
  const report = compareRecall(loadDefaultCases())
  for (const row of report.cases) {
    for (const side of ['baseline', 'candidate']) {
      assert.ok(row[side].offered.length <= MAX_ENTRIES, `${row.id} ${side} entry cap`)
      assert.ok(row[side].bytes <= MAX_BYTES, `${row.id} ${side} byte cap`)
      assert.equal(row[side].overBudget, false)
    }
  }
  const scope = report.cases.find(row => row.id === 'rsi-03-scope-isolation')
  assert.ok(!JSON.stringify(scope.candidate.offered).includes('mem_rsi_scope_other'))
  const retired = report.cases.find(row => row.id === 'rsi-04-retired-filter')
  assert.ok(!JSON.stringify(retired.candidate.offered).includes('mem_rsi_retired_csv'))
  const guard = report.cases.find(row => row.id === 'rsi-05-guard-mode')
  assert.equal(guard.candidate.offered[0].mode, 'guard')
  assert.deepEqual(guard.candidate.guardOffers, ['mem_rsi_guard_deploy'])
})

test('an expected guard requires mode=guard: wrong method/unknown mode is a visible guard miss', () => {
  const guardCase = byId('rsi-05-guard-mode')
  const correct = (entries, options) => recallSelection(entries, options)
  const wrongMethod = () => ({ offered: [{ id: 'mem_rsi_guard_deploy', version: 1, mode: 'method' }], bytes: 198 })
  const wrongUnknown = () => ({ offered: [{ id: 'mem_rsi_guard_deploy', version: 1, mode: null }], bytes: 198 })
  for (const [label, wrong] of [['method', wrongMethod], ['null', wrongUnknown]]) {
    const report = compareRecall([guardCase], { baseline: correct, candidate: wrong })
    const row = report.cases[0]
    assert.deepEqual(row.candidate.guardMisses, ['mem_rsi_guard_deploy'], `${label} guard miss`)
    assert.deepEqual(row.candidate.guardModeMismatches,
      [{ id: 'mem_rsi_guard_deploy', mode: label === 'method' ? 'method' : null }], `${label} mismatch`)
    assert.deepEqual(row.changes.modeChanges,
      [{ id: 'mem_rsi_guard_deploy', baselineMode: 'guard', candidateMode: label === 'method' ? 'method' : null }],
      `${label} mode change is visible`)
    assert.equal(row.verdict, 'regression')
    assert.equal(row.criticalRegression, true)
    assert.equal(report.decision, 'no_go')
    assert.ok(report.overall.criticalRegressions > 0)
  }
  const valid = compareRecall([guardCase])
  assert.deepEqual(valid.cases[0].candidate.guardMisses, [])
  assert.deepEqual(valid.cases[0].candidate.guardModeMismatches, [])
  assert.equal(valid.cases[0].verdict, 'unchanged')
  assert.equal(valid.decision, 'no_measured_gain')
})

test('a deliberately bad selector is reported as a regression and cannot be hidden by bytes', () => {
  const bad = entries => ({ offered: entries.slice(0, 1).map(entry => ({
    id: entry.id, version: entry.version, mode: 'method' })), bytes: 1 })
  const report = compareRecall(loadDefaultCases(), { candidate: bad })
  assert.equal(report.decision, 'no_go')
  assert.ok(report.overall.criticalRegressions > 0)
  assert.ok(report.cases.some(row => row.verdict === 'regression'))
  assert.equal(report.deployAllowed, false)
  assert.equal(report.automaticPromotion, false)
})

test('duplicate/unknown/contradictory/malformed labels fail loudly', () => {
  const base = { id: 'bad', prompt: 'p', scope: 's', environment: 'e',
    entries: [{ id: 'a' }, { id: 'b' }] }
  assert.throws(() => normalizeCases([{ ...base, expect: { relevant: ['missing'] } }]),
    /unknown id/)
  assert.throws(() => normalizeCases([base, { ...base }]), /duplicate case id/)
  assert.throws(() => normalizeCases([{ ...base, entries: [{ id: 'a' }, { id: 'a' }] }]),
    /duplicate entry id/)
  assert.throws(() => normalizeCases([{ ...base, expect: { relevant: ['a'], excluded: ['a'] } }]),
    /both expected and excluded/)
  assert.throws(() => normalizeCases([{ ...base, expect: { relevant: 'a' } }]),
    /must be a string array/)
  assert.throws(() => normalizeCases([{ ...base, expect: { relevant: null } }]),
    /must be a string array/)
})

test('unlabelled and partially labelled cases never become fake passes; zero denominators are null', () => {
  const partial = byId('rsi-07-partial-labels')
  const partialReport = compareRecall([partial])
  assert.equal(partialReport.cases[0].labelled, true)
  assert.ok(partialReport.cases[0].candidate.unknownSelected.length > 0,
    'the unlabelled selected entry is reported as unknown')
  assert.ok(!partialReport.cases[0].candidate.hits.includes('mem_rsi_partial_unknown'))

  const unlabelled = compareRecall([byId('rsi-08-unlabelled')])
  assert.equal(unlabelled.cases[0].labelled, false)
  assert.equal(unlabelled.cases[0].verdict, 'unknown')
  assert.equal(unlabelled.overall.labelledSubsetPrecision.value, null)
  assert.equal(unlabelled.overall.labelledSubsetPrecision.reason, 'no_labelled_selections')
  assert.equal(unlabelled.overall.labelledPositiveRecall.value, null)
  assert.equal(unlabelled.overall.labelledPositiveRecall.reason, 'no_positive_labels')

  const excludedOnly = compareRecall([byId('rsi-09-excluded-only')])
  assert.equal(excludedOnly.overall.labelledPositiveRecall.value, null)
  assert.equal(excludedOnly.overall.labelledPositiveRecall.reason, 'no_positive_labels')
})

test('the candidate has one measured gain and one non-critical regression; decision is offline-only', () => {
  const report = compareRecall(loadDefaultCases())
  const gain = report.cases.find(row => row.id === 'rsi-01-applicability-vs-broad-format')
  assert.equal(gain.verdict, 'gain')
  assert.equal(gain.candidate.falseOffers.length, 0)
  const regression = report.cases.find(row => row.id === 'rsi-10-applicability-regression')
  assert.equal(regression.verdict, 'regression')
  assert.deepEqual(regression.newMisses, ['mem_rsi_reg_third'])
  assert.equal(report.decision, 'offline_signal_only')
  assert.equal(report.deployAllowed, false)
  assert.equal(report.automaticPromotion, false)
  assert.equal(report.modelCalls, 0)
  assert.equal(report.liveStoreReads, 0)
  assert.equal(report.liveStoreWrites, 0)
  assert.equal(report.futureProviderCost, 'not_evaluated')
})

test('importing the module has no CLI side effects', () => {
  const replayUrl = new URL('./replay.mjs', import.meta.url).href
  const imported = spawnSync(process.execPath, ['--input-type=module', '--eval',
    `await import(${JSON.stringify(replayUrl)})`], { encoding: 'utf8' })
  assert.equal(imported.status, 0, imported.stderr)
  assert.equal(imported.stdout, '', 'import must not print a report or start the CLI')
})

test('same frozen input produces identical output', () => {
  const first = JSON.stringify(compareRecall(loadDefaultCases()))
  const second = JSON.stringify(compareRecall(loadDefaultCases()))
  assert.equal(first, second)
})

test('CLI emits the real comparison JSON with exit 0 and rejects arbitrary fixture paths', () => {
  const run = spawnSync(process.execPath, [join(here, 'replay.mjs')], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const parsed = JSON.parse(run.stdout)
  assert.equal(parsed.schema, 'mse-rsi-recall-comparison-v1')
  assert.equal(parsed.decision, 'offline_signal_only')
  assert.deepEqual(parsed.groups.map(group => group.source),
    ['existing_24_regression', 'manual_regression', 'synthetic'])
  assert.equal(parsed.overall.caseCount, 34)
  const rejected = spawnSync(process.execPath, [join(here, 'replay.mjs'), '--cases=/tmp/x.json'], { encoding: 'utf8' })
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /--cases is not accepted/)
})
