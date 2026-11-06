#!/usr/bin/env node
/**
 * OFFLINE-ONLY recall comparison (MSE-OFFLINE-RECALL-BATCH-20261104).
 *
 * Compares the production recall baseline with one PRE-REGISTERED, sort-only candidate:
 * the same rankForRecall/packRecall pipeline, then a stable partition that puts entries whose
 * OWN applicability matches the task (appMatch === true) before entries matched only by body
 * tokens. Nothing else changes: scope/retirement/exclusion filters, guard wording, the 2-entry
 * cap and the 768-byte cap all stay in the existing functions.
 *
 * This module is developer-only. Importing it reads no file, starts no CLI, calls no model and
 * touches no live learning store. It is NOT part of the runtime package and must never be wired
 * into the plugin.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { rankForRecall, packRecall, recallSelection } from '../../rebuild/recall.mjs'

export const COMPARISON_SCHEMA = 'mse-rsi-recall-comparison-v1'
export const DEFAULT_NOW = 0
export const MAX_ENTRIES = 2
export const MAX_BYTES = 768
export const EXISTING_SOURCE = 'existing_24_regression'
const here = dirname(fileURLToPath(import.meta.url))
const EXISTING_FIXTURE = join(here, '..', '..', 'tests', 'fixtures', 'recall-cases.json')
const COMPARISON_FIXTURE = join(here, '..', '..', 'tests', 'fixtures', 'rsi', 'recall-comparison.json')

const fail = message => { throw new TypeError(`invalid recall comparison input: ${message}`) }

/** Production baseline: the existing selection pipeline, unchanged. */
export function baselineRecall(entries, options) {
  return recallSelection(entries, options)
}

/**
 * The ONE candidate in this batch. It calls the real rankForRecall first (so every existing
 * gate/filter/score is applied), then stably partitions by appMatch; packRecall is unchanged.
 * No tunable knobs, no search loop, no second candidate.
 */
export function applicabilityFirstRecall(entries, options) {
  const ranked = rankForRecall(entries, options)
  const stable = ranked.map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftApp = left.row.appMatch === true ? 0 : 1
      const rightApp = right.row.appMatch === true ? 0 : 1
      return leftApp - rightApp || left.index - right.index
    })
    .map(row => row.row)
  return packRecall(stable, options)
}

const isNonEmptyString = value => typeof value === 'string' && value !== ''
const isStringArray = value => Array.isArray(value) && value.every(item => typeof item === 'string')

/**
 * Validate and normalize the frozen, hand-labelled cases. Unknown expected ids, duplicate case
 * or entry ids, contradictory labels and malformed structures fail loudly: a case that cannot be
 * scored must never contribute a fake pass.
 */
export function normalizeCases(cases) {
  if (!Array.isArray(cases)) fail('cases must be an array')
  const caseIds = new Set()
  return cases.map((testCase, caseIndex) => {
    const where = `cases[${caseIndex}]`
    if (testCase === null || typeof testCase !== 'object' || Array.isArray(testCase)) {
      fail(`${where} must be an object`)
    }
    if (!isNonEmptyString(testCase.id)) fail(`${where}.id must be a non-empty string`)
    if (caseIds.has(testCase.id)) fail(`duplicate case id ${testCase.id}`)
    caseIds.add(testCase.id)
    if (!isNonEmptyString(testCase.prompt)) fail(`${testCase.id}.prompt must be a non-empty string`)
    if (typeof testCase.scope !== 'string') fail(`${testCase.id}.scope must be a string`)
    if (typeof testCase.environment !== 'string') fail(`${testCase.id}.environment must be a string`)
    if (!Array.isArray(testCase.entries)) fail(`${testCase.id}.entries must be an array`)
    const entryIds = new Set()
    const entries = testCase.entries.map((entry, entryIndex) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        fail(`${testCase.id}.entries[${entryIndex}] must be an object`)
      }
      if (!isNonEmptyString(entry.id)) fail(`${testCase.id}.entries[${entryIndex}].id must be a non-empty string`)
      if (entryIds.has(entry.id)) fail(`duplicate entry id ${entry.id} in ${testCase.id}`)
      entryIds.add(entry.id)
      return entry
    })
    const expected = testCase.expect ?? {}
    if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
      fail(`${testCase.id}.expect must be an object when present`)
    }
    for (const name of ['relevant', 'excluded', 'guards']) {
      if (expected[name] !== undefined && !isStringArray(expected[name])) {
        fail(`${testCase.id}.expect.${name} must be a string array`)
      }
    }
    const relevant = expected.relevant ?? []
    const excluded = expected.excluded ?? []
    const guards = expected.guards ?? []
    for (const [name, ids] of [['relevant', relevant], ['excluded', excluded], ['guards', guards]]) {
      for (const id of ids) if (!entryIds.has(id)) fail(`${testCase.id}.expect.${name} has unknown id ${id}`)
    }
    const overlap = relevant.filter(id => excluded.includes(id) || guards.includes(id))
    if (overlap.length > 0) fail(`${testCase.id} labels ${overlap.join(', ')} as both expected and excluded/guard`)
    const guardOverlap = guards.filter(id => excluded.includes(id))
    if (guardOverlap.length > 0) fail(`${testCase.id} labels ${guardOverlap.join(', ')} as both guard and excluded`)
    if (testCase.critical !== undefined && typeof testCase.critical !== 'boolean') {
      fail(`${testCase.id}.critical must be a boolean when present`)
    }
    const source = testCase.source ?? 'unspecified'
    if (!isNonEmptyString(source)) fail(`${testCase.id}.source must be a non-empty string when present`)
    return { id: testCase.id, prompt: testCase.prompt, scope: testCase.scope,
      environment: testCase.environment, entries, source,
      critical: testCase.critical === true,
      relevant: [...relevant], excluded: [...excluded], guards: [...guards] }
  })
}

const selectionShape = (selection, where) => {
  if (selection === null || typeof selection !== 'object') fail(`${where} selection must be an object`)
  if (!Array.isArray(selection.offered)) fail(`${where} selection.offered must be an array`)
  if (!Number.isFinite(selection.bytes) || selection.bytes < 0) fail(`${where} selection.bytes must be a non-negative number`)
  return { offered: selection.offered.map(offer => ({ id: offer.id, version: offer.version ?? null,
    mode: offer.mode ?? null })), bytes: selection.bytes }
}

const metricsOf = (selection, testCase) => {
  const selected = selection.offered.map(offer => offer.id)
  const hits = selected.filter(id => testCase.relevant.includes(id))
  const misses = testCase.relevant.filter(id => !selected.includes(id))
  const falseOffers = selected.filter(id => testCase.excluded.includes(id))
  const guardOffers = selection.offered.filter(offer => offer.mode === 'guard').map(offer => offer.id)
  // An expected guard is satisfied ONLY by the same id offered WITH mode=guard. A method/null/
  // unknown mode is a guard miss, not an id hit — this is the REVIEW-FIX1 red case.
  const guardModeMismatches = testCase.guards.flatMap(id => {
    const offer = selection.offered.find(row => row.id === id)
    return offer !== undefined && offer.mode !== 'guard'
      ? [{ id, mode: offer.mode === undefined ? null : offer.mode }]
      : []
  })
  const guardMisses = testCase.guards.filter(id => {
    const offer = selection.offered.find(row => row.id === id)
    return offer === undefined || offer.mode !== 'guard'
  })
  const known = new Set([...testCase.relevant, ...testCase.excluded, ...testCase.guards])
  const unknownSelected = selected.filter(id => !known.has(id))
  const overBudget = selection.offered.length > MAX_ENTRIES || selection.bytes > MAX_BYTES
  return { hits, misses, falseOffers, guardOffers, guardMisses, guardModeMismatches,
    unknownSelected, overBudget }
}

const verdictOf = (baseline, candidate, changes) => {
  const newMisses = candidate.misses.filter(id => !baseline.misses.includes(id))
  const newFalse = candidate.falseOffers.filter(id => !baseline.falseOffers.includes(id))
  const newGuardMisses = candidate.guardMisses.filter(id => !baseline.guardMisses.includes(id))
  const newOverBudget = candidate.overBudget && !baseline.overBudget
  if (baseline.overBudget && candidate.overBudget) return 'over_budget'
  if (newOverBudget || newMisses.length > 0 || newFalse.length > 0 || newGuardMisses.length > 0) {
    return newOverBudget ? 'over_budget' : 'regression'
  }
  const qualityGain = candidate.hits.length > baseline.hits.length
    || candidate.falseOffers.length < baseline.falseOffers.length
    || candidate.guardMisses.length < baseline.guardMisses.length
  if (qualityGain) return 'gain'
  if (changes.orderChanged) return 'changed'
  return 'unchanged'
}

const changesOf = (baseline, candidate) => {
  const baseIds = baseline.offered.map(offer => offer.id)
  const candIds = candidate.offered.map(offer => offer.id)
  const modeChanges = baseIds.filter(id => candIds.includes(id)).flatMap(id => {
    const baseMode = baseline.offered.find(offer => offer.id === id)?.mode ?? null
    const candMode = candidate.offered.find(offer => offer.id === id)?.mode ?? null
    return baseMode !== candMode ? [{ id, baselineMode: baseMode, candidateMode: candMode }] : []
  })
  return {
    added: candIds.filter(id => !baseIds.includes(id)),
    removed: baseIds.filter(id => !candIds.includes(id)),
    orderChanged: JSON.stringify(baseIds) !== JSON.stringify(candIds),
    modeChanges,
  }
}

const ratio = (numerator, denominator, reason) => denominator === 0
  ? { value: null, reason }
  : { value: Number((numerator / denominator).toFixed(4)), reason: null }

const aggregate = rows => {
  const labelled = rows.filter(row => row.labelled)
  const sum = key => rows.reduce((total, row) => total + row.candidate[key].length, 0)
  const baseSum = key => rows.reduce((total, row) => total + row.baseline[key].length, 0)
  const baselineHits = baseSum('hits')
  const baselineFalse = baseSum('falseOffers')
  const candidateHits = sum('hits')
  const candidateFalse = sum('falseOffers')
  return {
    caseCount: rows.length,
    labelledCases: labelled.length,
    unlabelledCases: rows.length - labelled.length,
    groupBytes: {
      baseline: rows.reduce((total, row) => total + row.baseline.bytes, 0),
      candidate: rows.reduce((total, row) => total + row.candidate.bytes, 0),
    },
    baseline: {
      knownRelevantHits: baselineHits,
      knownRelevantMisses: baseSum('misses'),
      explicitFalseOffers: baselineFalse,
      guardOffers: baseSum('guardOffers'),
      guardMisses: baseSum('guardMisses'),
      guardModeMismatches: rows.reduce((total, row) =>
        total + row.baseline.guardModeMismatches.length, 0),
      unknownSelected: baseSum('unknownSelected'),
      overBudgetCases: rows.filter(row => row.baseline.overBudget).length,
      bytes: rows.reduce((total, row) => total + row.baseline.bytes, 0),
    },
    candidate: {
      knownRelevantHits: candidateHits,
      knownRelevantMisses: sum('misses'),
      explicitFalseOffers: candidateFalse,
      guardOffers: sum('guardOffers'),
      guardMisses: sum('guardMisses'),
      guardModeMismatches: rows.reduce((total, row) =>
        total + row.candidate.guardModeMismatches.length, 0),
      unknownSelected: sum('unknownSelected'),
      overBudgetCases: rows.filter(row => row.candidate.overBudget).length,
      bytes: rows.reduce((total, row) => total + row.candidate.bytes, 0),
    },
    delta: {
      knownRelevantHits: candidateHits - baselineHits,
      knownRelevantMisses: sum('misses') - baseSum('misses'),
      explicitFalseOffers: candidateFalse - baselineFalse,
      guardOffers: sum('guardOffers') - baseSum('guardOffers'),
      guardMisses: sum('guardMisses') - baseSum('guardMisses'),
      guardModeMismatches: rows.reduce((total, row) =>
        total + row.candidate.guardModeMismatches.length - row.baseline.guardModeMismatches.length, 0),
      unknownSelected: sum('unknownSelected') - baseSum('unknownSelected'),
      bytes: rows.reduce((total, row) => total + row.candidate.bytes, 0)
        - rows.reduce((total, row) => total + row.baseline.bytes, 0),
    },
    labelledSubsetPrecision: ratio(candidateHits, candidateHits + candidateFalse,
      'no_labelled_selections'),
    labelledPositiveRecall: ratio(candidateHits, candidateHits + sum('misses'),
      'no_positive_labels'),
    criticalRegressions: rows.filter(row => row.criticalRegression).length,
    criticalBaselineFailures: rows.filter(row => row.critical && (row.baseline.misses.length > 0
      || row.baseline.falseOffers.length > 0 || row.baseline.guardMisses.length > 0
      || row.baseline.overBudget)).length,
    nonCriticalRegressions: rows.filter(row => !row.critical && row.verdict === 'regression').length,
    casesWithGain: rows.filter(row => row.verdict === 'gain').length,
    casesUnchanged: rows.filter(row => row.verdict === 'unchanged').length,
    casesChangedWithoutQuality: rows.filter(row => row.verdict === 'changed').length,
    overBudgetCases: rows.filter(row => row.candidate.overBudget).length,
  }
}

/**
 * Compare the production baseline with the pre-registered candidate over frozen cases.
 * `options.baseline` / `options.candidate` exist only so tests can inject a DELIBERATELY bad
 * selector to prove regressions are detected; the CLI never accepts code and never overrides.
 */
export function compareRecall(cases, { now = DEFAULT_NOW, baseline = baselineRecall,
  candidate = applicabilityFirstRecall } = {}) {
  if (typeof now !== 'number' || !Number.isFinite(now)) fail('now must be a finite number')
  const normalized = normalizeCases(cases)
  const rows = normalized.map(testCase => {
    const options = { prompt: testCase.prompt, scope: testCase.scope,
      environment: testCase.environment, now }
    const base = selectionShape(baseline(testCase.entries, options), `${testCase.id} baseline`)
    const cand = selectionShape(candidate(testCase.entries, options), `${testCase.id} candidate`)
    const baseMetrics = metricsOf(base, testCase)
    const candMetrics = metricsOf(cand, testCase)
    const changes = changesOf(base, cand)
    const labelled = testCase.relevant.length > 0 || testCase.excluded.length > 0
      || testCase.guards.length > 0
    const verdict = labelled ? verdictOf(baseMetrics, candMetrics, changes) : 'unknown'
    const newMisses = candMetrics.misses.filter(id => !baseMetrics.misses.includes(id))
    const newFalse = candMetrics.falseOffers.filter(id => !baseMetrics.falseOffers.includes(id))
    const newGuardMisses = candMetrics.guardMisses.filter(id => !baseMetrics.guardMisses.includes(id))
    const criticalRegression = testCase.critical && (candMetrics.overBudget && !baseMetrics.overBudget
      || newMisses.length > 0 || newFalse.length > 0 || newGuardMisses.length > 0)
    return {
      id: testCase.id,
      source: testCase.source,
      critical: testCase.critical,
      labelled,
      expected: { relevant: testCase.relevant, excluded: testCase.excluded, guards: testCase.guards },
      baseline: { offered: base.offered, bytes: base.bytes, ...baseMetrics },
      candidate: { offered: cand.offered, bytes: cand.bytes, ...candMetrics },
      changes,
      newMisses,
      newFalseOffers: newFalse,
      newGuardMisses,
      verdict,
      criticalRegression,
    }
  })
  const sourceOrder = []
  for (const row of rows) if (!sourceOrder.includes(row.source)) sourceOrder.push(row.source)
  const groups = sourceOrder.map(source => {
    const groupRows = rows.filter(row => row.source === source)
    return { source, ...aggregate(groupRows) }
  })
  const overall = aggregate(rows)
  const anyOverBudget = overall.overBudgetCases > 0
  const anyCritical = overall.criticalRegressions > 0
  const qualityGain = overall.candidate.knownRelevantHits > overall.baseline.knownRelevantHits
    || overall.candidate.explicitFalseOffers < overall.baseline.explicitFalseOffers
    || overall.candidate.guardMisses < overall.baseline.guardMisses
  const decision = anyOverBudget || anyCritical ? 'no_go'
    : qualityGain ? 'offline_signal_only' : 'no_measured_gain'
  return {
    schema: COMPARISON_SCHEMA,
    mode: 'offline_developer_comparison',
    deployAllowed: false,
    automaticPromotion: false,
    now,
    modelCalls: 0,
    liveStoreReads: 0,
    liveStoreWrites: 0,
    futureProviderCost: 'not_evaluated',
    limits: [
      'Only the frozen cases listed here are scored; this is not a blind test and not a live production replay.',
      'Only labelled relevant/excluded/guard ids count; unknown selections are reported but never scored.',
      'This tool saves no provider calls and says nothing about future online provider cost.',
      'No runtime code, live learning library, model route, package or deployment is touched.',
    ],
    decision,
    decisionNote: decision === 'no_go'
      ? 'A critical regression or over-budget selection exists; no deployment is allowed.'
      : decision === 'offline_signal_only'
        ? 'Offline labelled-subset signal only; this is not proof of online benefit and is never auto-promoted.'
        : 'No measured quality gain on the labelled subset; byte changes alone do not count as improvement.',
    overall,
    groups,
    cases: rows,
  }
}

const readFixture = (path, source, defaults = {}) => {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const cases = Array.isArray(parsed) ? parsed : parsed.cases
  if (!Array.isArray(cases)) fail(`${path} does not contain a cases array`)
  return cases.map(testCase => ({ source, ...defaults, ...testCase }))
}

export function loadDefaultCases() {
  const existing = readFixture(EXISTING_FIXTURE, EXISTING_SOURCE, { critical: true })
  const comparison = readFixture(COMPARISON_FIXTURE, 'manual_regression')
  return [...existing, ...comparison]
}

const parseArgs = argv => {
  const args = {}
  for (const raw of argv) {
    const match = /^--([a-z-]+)=(.*)$/u.exec(raw)
    if (match !== null) args[match[1]] = match[2]
  }
  return args
}

const main = () => {
  const args = parseArgs(process.argv.slice(2))
  if (args.cases !== undefined) fail('--cases is not accepted: this CLI only reads the frozen default fixtures')
  const report = compareRecall(loadDefaultCases())
  console.log(JSON.stringify(report, null, 2))
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) main()
