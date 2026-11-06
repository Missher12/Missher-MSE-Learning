#!/usr/bin/env node
/**
 * OFFLINE-ONLY MSE-RECALL-NORMALIZATION-20261106.
 *
 * The production baseline is the current 0.16.1 selectRecall (2 methods + at most 1 guard,
 * <=3 total / 768 B). The only candidate is a local error-concept normalization: when an
 * already-segmented whole word "错误" is present, add the EXISTING curated `log` concept to
 * the same analysis view for query, applicability and body. No substring replacement, no new
 * synonym table, no admission threshold change and no production import.
 *
 * This file is developer-only. It reads frozen public fixtures, writes only stdout, never reads
 * the live store, never calls a model/provider and is not part of the runtime package.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { NORMALIZATION_RULE, normalizedView, rankForRecallNormalized, selectRecall, selectRecallNormalized } from '../../rebuild/recall.mjs'
import { loadDefaultCases } from './replay.mjs'

export { NORMALIZATION_RULE, normalizedView, rankForRecallNormalized, selectRecallNormalized }

const expectedOf = testCase => ({
  relevant: testCase.expect?.relevant ?? [],
  excluded: testCase.expect?.excluded ?? [],
  guards: testCase.expect?.guards ?? [],
})

const metricsOf = (selection, testCase) => {
  const selected = selection.offered.map(offer => offer.id)
  const expected = expectedOf(testCase)
  const hits = expected.relevant.filter(id => selected.includes(id))
  const misses = expected.relevant.filter(id => !selected.includes(id))
  const falseOffers = expected.excluded.filter(id => selected.includes(id))
  const guardOffers = selection.offered.filter(offer => offer.mode === 'guard').map(offer => offer.id)
  const guardMisses = expected.guards.filter(id => !selection.offered
    .some(offer => offer.id === id && offer.mode === 'guard'))
  const modeMismatches = expected.guards.flatMap(id => {
    const offer = selection.offered.find(row => row.id === id)
    return offer !== undefined && offer.mode !== 'guard' ? [{ id, mode: offer.mode }] : []
  })
  const known = new Set([...expected.relevant, ...expected.excluded, ...expected.guards])
  const unknownSelected = selected.filter(id => !known.has(id))
  const methodOffers = selection.offered.filter(offer => offer.mode === 'method').length
  const guardCount = selection.offered.filter(offer => offer.mode === 'guard').length
  const caps = {
    total: selection.offered.length,
    methods: methodOffers,
    guards: guardCount,
    bytes: selection.bytes,
    totalOk: selection.offered.length <= 3,
    methodsOk: methodOffers <= 2,
    guardsOk: guardCount <= 1,
    bytesOk: selection.bytes <= 768,
  }
  return { hits, misses, falseOffers, guardOffers, guardMisses, modeMismatches,
    unknownSelected, caps, overBudget: !(caps.totalOk && caps.methodsOk && caps.guardsOk && caps.bytesOk) }
}

const verdictOf = (baseline, candidate, changed) => {
  const newMisses = candidate.misses.filter(id => !baseline.misses.includes(id))
  const newFalse = candidate.falseOffers.filter(id => !baseline.falseOffers.includes(id))
  const newGuardMisses = candidate.guardMisses.filter(id => !baseline.guardMisses.includes(id))
  const newMode = candidate.modeMismatches.filter(item => !baseline.modeMismatches
    .some(old => old.id === item.id))
  if (candidate.overBudget || newMisses.length > 0 || newFalse.length > 0
    || newGuardMisses.length > 0 || newMode.length > 0) return 'regression'
  if (candidate.hits.length > baseline.hits.length
    || candidate.falseOffers.length < baseline.falseOffers.length
    || candidate.guardMisses.length < baseline.guardMisses.length) return 'gain'
  return changed ? 'changed' : 'unchanged'
}

/**
 * Compare production 0.16.1 selectRecall with the normalized candidate over the frozen 34.
 * The selectors never receive labels; labels are used only after selection for scoring/report.
 */
export function compareNormalization(cases = loadDefaultCases(), {
  now = 0, baseline = selectRecall, candidate = selectRecallNormalized,
} = {}) {
  const rows = []
  for (const testCase of cases) {
    const options = { prompt: testCase.prompt, scope: testCase.scope,
      environment: testCase.environment, now }
    const baseSelection = baseline(testCase.entries, options)
    const candSelection = candidate(testCase.entries, options)
    const base = metricsOf(baseSelection, testCase)
    const cand = metricsOf(candSelection, testCase)
    const changed = JSON.stringify(baseSelection.offered) !== JSON.stringify(candSelection.offered)
      || baseSelection.bytes !== candSelection.bytes
      || JSON.stringify(baseSelection.lines) !== JSON.stringify(candSelection.lines)
    const newMisses = cand.misses.filter(id => !base.misses.includes(id))
    const newFalse = cand.falseOffers.filter(id => !base.falseOffers.includes(id))
    const newGuardMisses = cand.guardMisses.filter(id => !base.guardMisses.includes(id))
    const newMode = cand.modeMismatches.filter(item => !base.modeMismatches
      .some(old => old.id === item.id))
    rows.push({ id: testCase.id, source: testCase.source ?? 'unknown',
      baseline: { offered: baseSelection.offered, lines: baseSelection.lines,
        bytes: baseSelection.bytes, ...base },
      candidate: { offered: candSelection.offered, lines: candSelection.lines,
        bytes: candSelection.bytes, ...cand },
      expected: expectedOf(testCase), changed,
      newMisses, newFalseOffers: newFalse, newGuardMisses, newModeMismatches: newMode,
      verdict: verdictOf(base, cand, changed), baselineCaps: base.caps,
      candidateCaps: cand.caps })
  }
  const sum = (key, side) => rows.reduce((total, row) => total + row[side][key].length, 0)
  const overall = {
    cases: rows.length,
    baseline: {
      hits: sum('hits', 'baseline'), misses: sum('misses', 'baseline'),
      falseOffers: sum('falseOffers', 'baseline'), guardMisses: sum('guardMisses', 'baseline'),
      bytes: rows.reduce((total, row) => total + row.baseline.bytes, 0),
    },
    candidate: {
      hits: sum('hits', 'candidate'), misses: sum('misses', 'candidate'),
      falseOffers: sum('falseOffers', 'candidate'), guardMisses: sum('guardMisses', 'candidate'),
      bytes: rows.reduce((total, row) => total + row.candidate.bytes, 0),
    },
    newMisses: rows.flatMap(row => row.newMisses.map(id => ({ caseId: row.id, id }))),
    newFalseOffers: rows.flatMap(row => row.newFalseOffers.map(id => ({ caseId: row.id, id }))),
    newGuardMisses: rows.flatMap(row => row.newGuardMisses.map(id => ({ caseId: row.id, id }))),
    newModeMismatches: rows.flatMap(row => row.newModeMismatches.map(item => ({ caseId: row.id, ...item }))),
    gainCases: rows.filter(row => row.verdict === 'gain').map(row => row.id),
    regressionCases: rows.filter(row => row.verdict === 'regression').map(row => row.id),
    changedCases: rows.filter(row => row.verdict === 'changed').map(row => row.id),
    candidateOverCapCases: rows.filter(row => row.candidate.overBudget).map(row => row.id),
    baselineOverCapCases: rows.filter(row => row.baseline.overBudget).map(row => row.id),
  }
  overall.decision = overall.newMisses.length > 0 || overall.newFalseOffers.length > 0
    || overall.newGuardMisses.length > 0 || overall.newModeMismatches.length > 0
    || overall.candidateOverCapCases.length > 0
    ? 'no_go'
    : overall.gainCases.length > 0 ? 'candidate_signal' : 'no_measurable_gain'
  return {
    schema: 'mse-recall-normalization-comparison-v1',
    mode: 'offline_developer_comparison',
    candidateName: 'error-word-to-existing-log-concept-v1',
    baseline: 'selectRecall 0.16.1 (2 methods + <=1 guard, <=3 total / 768B)',
    deployAllowed: false,
    automaticPromotion: false,
    now,
    modelCalls: 0,
    liveStoreReads: 0,
    liveStoreWrites: 0,
    futureProviderCost: 'not_evaluated',
    decision: overall.decision,
    overall,
    cases: rows,
  }
}

const main = () => {
  if (process.argv.length > 2) {
    throw new TypeError('--cases is not accepted: this CLI only reads the frozen default fixtures')
  }
  console.log(JSON.stringify(compareNormalization(), null, 2))
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) main()
