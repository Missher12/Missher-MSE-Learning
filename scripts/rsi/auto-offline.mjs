#!/usr/bin/env node
/**
 * One-pass offline recall improvement proposal. Discovery cases alone derive and select a
 * candidate; the frozen candidate is then checked once against a separate synthetic control set.
 * Nothing in this file is imported by the runtime or allowed to promote a production policy.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ALIAS_GROUPS, analyze, normalizeText } from '../../src/recall.mjs'
import {
  DEFAULT_RECALL_MAX_BYTES, MAX_GUARDS_PER_TURN, MAX_METHODS_PER_TURN,
  MAX_RECALL_TOTAL, selectRecall,
} from '../../rebuild/recall.mjs'
import { compareNormalization, NORMALIZATION_RULE, selectRecallNormalized }
  from './compare-normalization.mjs'
import { loadDefaultCases } from './replay.mjs'

const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' })
const SAFE_CANDIDATES = Object.freeze([NORMALIZATION_RULE])
const expectedOf = testCase => testCase.expect ?? {}

const wholeWords = text => new Set([...SEGMENTER.segment(normalizeText(text))]
  .filter(part => part.isWordLike).map(part => part.segment))

const candidateIsSupported = (rule, methodText, prompt) => {
  const targetExists = ALIAS_GROUPS.some(group => group.id === rule.conceptId)
  const sourceAlreadyGrouped = ALIAS_GROUPS.some(group => group.forms.includes(rule.sourceWord))
  return targetExists && !sourceAlreadyGrouped
    && wholeWords(methodText).has(rule.sourceWord)
    && analyze(prompt).semantic.includes(rule.conceptId)
}

/** Discover only from baseline-missed, explicitly relevant method text and prompt-side concepts. */
export function discoverCandidates(cases, baselineReport) {
  const proposals = new Map()
  for (const row of baselineReport.cases) {
    const testCase = cases.find(item => item.id === row.id)
    if (!testCase) continue
    const relevant = expectedOf(testCase).relevant ?? []
    for (const methodId of row.baseline.misses) {
      if (!relevant.includes(methodId)) continue
      const entry = testCase.entries.find(item => item.id === methodId)
      if (!entry) continue
      const methodText = `${entry.applicability ?? ''} ${entry.instruction ?? ''} `
        + `${entry.lesson?.failurePattern ?? ''}`
      for (const rule of SAFE_CANDIDATES) {
        if (!candidateIsSupported(rule, methodText, testCase.prompt)) continue
        if (!proposals.has(rule.id)) {
          proposals.set(rule.id, { id: rule.id, rule,
            source: 'auto_discovered_from_baseline_missed_method', evidence: [] })
        }
        proposals.get(rule.id).evidence.push({ caseId: testCase.id, methodId,
          methodText: methodText.trim(), prompt: testCase.prompt,
          queryConceptEvidence: rule.conceptId })
      }
    }
  }
  return [...proposals.values()].sort((left, right) => left.id.localeCompare(right.id))
}

const detailsOf = selection => {
  const lines = Array.isArray(selection.lines) ? selection.lines : []
  const actualBytes = Buffer.byteLength(lines.join(''), 'utf8')
  const offered = selection.offered ?? []
  const methods = offered.filter(offer => offer.mode === 'method').length
  const guards = offered.filter(offer => offer.mode === 'guard').length
  const methodLines = lines.filter(line => /^\n- (?:经验|项目规则)：/u.test(line)).length
  const guardLines = lines.filter(line => /^\n- 风险警示：/u.test(line)).length
  const unknownModes = offered.filter(offer => !['method', 'guard'].includes(offer.mode))
  return {
    offers: offered.map(offer => ({ id: offer.id, mode: offer.mode })),
    lines,
    hits: selection.hits ?? [],
    misses: selection.misses ?? [],
    falseOffers: selection.falseOffers ?? [],
    guardMisses: selection.guardMisses ?? [],
    modeMismatches: selection.modeMismatches ?? [],
    unknownSelected: selection.unknownSelected ?? [],
    methods,
    methodSlots: MAX_METHODS_PER_TURN,
    methodLines,
    guards,
    guardSlots: MAX_GUARDS_PER_TURN,
    guardLines,
    total: offered.length,
    totalSlots: MAX_RECALL_TOTAL,
    bytes: actualBytes,
    reportedBytes: selection.bytes,
    bytesVerified: actualBytes === selection.bytes,
    lineModesVerified: methods === methodLines && guards === guardLines && unknownModes.length === 0,
    capsOk: methods <= MAX_METHODS_PER_TURN && guards <= MAX_GUARDS_PER_TURN
      && offered.length <= MAX_RECALL_TOTAL && actualBytes <= DEFAULT_RECALL_MAX_BYTES,
    unknownModes: unknownModes.map(offer => ({ id: offer.id, mode: offer.mode })),
  }
}

const directModeChanges = row => {
  const before = new Map(row.baseline.offered.map(offer => [offer.id, offer.mode]))
  return row.candidate.offered.flatMap(offer => before.has(offer.id)
    && before.get(offer.id) !== offer.mode
    ? [{ id: offer.id, baselineMode: before.get(offer.id), candidateMode: offer.mode }]
    : [])
}

const expectedModeViolations = row => {
  const expectedMethods = row.expected?.relevant ?? []
  const expectedGuards = row.expected?.guards ?? []
  const baselineOffers = new Map(row.baseline.offered.map(offer => [offer.id, offer.mode]))
  const candidateOffers = new Map(row.candidate.offered.map(offer => [offer.id, offer.mode]))
  return [
    ...expectedMethods.filter(id => candidateOffers.has(id) && !baselineOffers.has(id)
      && candidateOffers.get(id) !== 'method')
      .map(id => ({ id, expectedMode: 'method', candidateMode: candidateOffers.get(id) })),
    ...expectedGuards.filter(id => candidateOffers.has(id) && !baselineOffers.has(id)
      && candidateOffers.get(id) !== 'guard')
      .map(id => ({ id, expectedMode: 'guard', candidateMode: candidateOffers.get(id) })),
  ]
}

/** Keep the comparator's label scoring intact; add conservative gates for unknown IDs and bytes. */
export function assessComparison(report) {
  const newUnknownSelections = report.cases.flatMap(row => row.candidate.unknownSelected
    .filter(id => !row.baseline.unknownSelected.includes(id))
    .map(id => ({ caseId: row.id, id })))
  const modeChanges = report.cases.flatMap(row => [
    ...directModeChanges(row).map(change => ({ caseId: row.id, ...change })),
    ...expectedModeViolations(row).map(change => ({ caseId: row.id, ...change })),
  ])
  const selectionIssues = []
  for (const row of report.cases) {
    for (const side of ['baseline', 'candidate']) {
      const details = detailsOf(row[side])
      if (!details.bytesVerified || !details.lineModesVerified || !details.capsOk) {
        selectionIssues.push({ caseId: row.id, side, bytesVerified: details.bytesVerified,
          lineModesVerified: details.lineModesVerified, capsOk: details.capsOk,
          actualBytes: details.bytes, reportedBytes: details.reportedBytes })
      }
    }
  }
  const newMisses = report.overall.newMisses ?? []
  const newFalseOffers = report.overall.newFalseOffers ?? []
  const newGuardMisses = report.overall.newGuardMisses ?? []
  const newModeMismatches = report.overall.newModeMismatches ?? []
  const regressions = newMisses.length > 0 || newFalseOffers.length > 0
    || newGuardMisses.length > 0 || newModeMismatches.length > 0 || modeChanges.length > 0
    || report.overall.candidateOverCapCases.length > 0
  const qualityGain = report.overall.gainCases.length > 0
  const status = newUnknownSelections.length > 0 || selectionIssues.length > 0
    ? 'evidence_insufficient'
    : regressions ? 'blocked_regression'
      : qualityGain ? 'candidate_signal' : 'no_gain'
  return { status, qualityGain, newMisses, newFalseOffers, newGuardMisses,
    newModeMismatches, modeChanges, newUnknownSelections, selectionIssues }
}

const comparisonView = (report, assessment) => ({
  assessment,
  overall: report.overall,
  cases: report.cases.map(row => ({
    id: row.id,
    source: row.source,
    verdict: row.verdict,
    baseline: detailsOf(row.baseline),
    candidate: detailsOf(row.candidate),
    deltas: {
      newMisses: row.newMisses,
      newFalseOffers: row.newFalseOffers,
      newGuardMisses: row.newGuardMisses,
      newModeMismatches: row.newModeMismatches,
      newUnknownSelections: row.candidate.unknownSelected
        .filter(id => !row.baseline.unknownSelected.includes(id)),
      modeChanges: directModeChanges(row),
      expectedModeViolations: expectedModeViolations(row),
    },
  })),
})

const loadDefaultControls = () => {
  const originalUrl = new URL('../../tests/fixtures/rsi/normalization-controls.json', import.meta.url)
  const independentUrl = new URL('../../tests/fixtures/rsi/auto-independent-controls.json', import.meta.url)
  const original = JSON.parse(readFileSync(originalUrl, 'utf8')).cases
  const independent = JSON.parse(readFileSync(independentUrl, 'utf8')).cases
  return [...original, ...independent]
}

const candidateSelectorFor = proposal => proposal.id === NORMALIZATION_RULE.id
  ? selectRecallNormalized : null

/** One deterministic discovery pass, one candidate freeze at most, then one control pass. */
export function runAutoOffline({ discoveryCases = loadDefaultCases(),
  loadControlCases = loadDefaultControls } = {}) {
  const baselineReport = compareNormalization(discoveryCases, {
    baseline: selectRecall, candidate: selectRecall, now: 0,
  })
  const proposals = discoverCandidates(discoveryCases, baselineReport)
  const evaluated = []
  let frozen = null

  for (const proposal of proposals) {
    const selector = candidateSelectorFor(proposal)
    if (selector === null) continue
    const report = compareNormalization(discoveryCases, {
      baseline: selectRecall, candidate: selector, now: 0,
    })
    const assessment = assessComparison(report)
    evaluated.push({ proposal, report, assessment })
    if (assessment.status === 'candidate_signal') {
      frozen = evaluated[evaluated.length - 1]
      break
    }
  }

  const baseline = {
    source: 'production selectRecall 0.16.1',
    sampleSource: 'frozen local discovery cases; no live learning library read',
    sampleCases: discoveryCases.length,
    overall: baselineReport.overall.baseline,
    cases: baselineReport.cases.map(row => ({ id: row.id, source: row.source,
      selection: detailsOf(row.baseline) })),
  }
  const candidateEvaluations = evaluated.map(({ proposal, report, assessment }) => ({
    id: proposal.id, rule: proposal.rule, evidence: proposal.evidence,
    discovery: comparisonView(report, assessment),
  }))

  if (frozen === null) {
    const lastStatus = evaluated.at(-1)?.assessment.status
    const status = proposals.length === 0 ? 'evidence_insufficient'
      : lastStatus ?? 'evidence_insufficient'
    return {
      schema: 'mse-rsi-auto-offline-v1',
      mode: 'local_offline_discovery',
      recommendation: 'retain_baseline',
      recommendationReason: proposals.length === 0
        ? 'no_safe_candidate_was_triggered_by_a_baseline_miss'
        : `discovery_${status}`,
      baseline,
      proposals: candidateEvaluations,
      frozenCandidate: null,
      controls: { status: 'not_run_no_candidate_frozen', cases: [] },
      discoveryStatus: status,
      automaticPromotion: false,
      modelCalls: 0,
      liveStoreReads: 0,
      liveStoreWrites: 0,
      candidatePoolSize: SAFE_CANDIDATES.length,
      stopRule: 'Evaluate triggered safe candidates on discovery cases once; stop after the first '
        + 'candidate with a measured gain and no per-case regression, then do not tune from controls.',
    }
  }

  // The frozen candidate is immutable below this point. Controls cannot select another rule.
  const controlCases = loadControlCases()
  const controlReport = compareNormalization(controlCases, {
    baseline: selectRecall, candidate: candidateSelectorFor(frozen.proposal), now: 0,
  })
  const controlAssessment = assessComparison(controlReport)
  const controlsWellFormed = controlCases.length > 0
    && controlCases.every(testCase => testCase.source === 'synthetic_control'
      && ['relevant', 'excluded', 'guards'].some(key => (testCase.expect?.[key] ?? []).length > 0))
  const discoveryPrompts = new Set(discoveryCases.map(testCase => normalizeText(testCase.prompt)))
  const seenIndependentPrompts = new Set()
  const independentGainCases = controlReport.cases.flatMap(row => {
    const testCase = controlCases.find(item => item.id === row.id)
    if (!testCase || row.source !== 'synthetic_control') return []
    const normalizedPrompt = normalizeText(testCase.prompt)
    if (discoveryPrompts.has(normalizedPrompt) || seenIndependentPrompts.has(normalizedPrompt)) return []
    const addedHits = row.candidate.hits.filter(id => !row.baseline.hits.includes(id))
    const removedFalseOffers = row.baseline.falseOffers
      .filter(id => !row.candidate.falseOffers.includes(id))
    const removedGuardMisses = row.baseline.guardMisses
      .filter(id => !row.candidate.guardMisses.includes(id))
    if (addedHits.length === 0 && removedFalseOffers.length === 0
      && removedGuardMisses.length === 0) return []
    seenIndependentPrompts.add(normalizedPrompt)
    return [{ caseId: row.id, prompt: testCase.prompt, normalizedPrompt,
      addedHits, removedFalseOffers, removedGuardMisses }]
  })
  const controlReason = !controlsWellFormed ? 'controls_missing_or_unlabelled'
    : controlAssessment.status === 'evidence_insufficient' ? 'controls_evidence_insufficient'
      : controlAssessment.status === 'blocked_regression' ? 'controls_blocked_regression'
        : independentGainCases.length === 0 ? 'controls_no_independent_gain_on_new_prompt'
          : 'controls_passed'
  const controlStatus = controlReason === 'controls_passed' ? 'passed'
    : controlReason === 'controls_blocked_regression' ? 'blocked_regression'
      : 'evidence_insufficient'
  const recommendation = controlStatus === 'passed' ? 'offline_recommendation' : 'retain_baseline'
  const recommendationReason = controlStatus === 'passed'
    ? 'discovery_gain_and_independent_controls_passed_without_any_per_case_regression'
    : controlReason
  const controlView = comparisonView(controlReport, controlAssessment)

  return {
    schema: 'mse-rsi-auto-offline-v1',
    mode: 'local_offline_discovery',
    recommendation,
    recommendationReason,
    baseline,
    proposals: candidateEvaluations,
    frozenCandidate: { id: frozen.proposal.id, rule: frozen.proposal.rule,
      evidence: frozen.proposal.evidence, chosenUsing: 'discovery_cases_only' },
    discovery: comparisonView(frozen.report, frozen.assessment),
    controls: { source: 'independent_synthetic_controls', notBlind: true,
      notProductionData: true,
      note: 'Public synthetic controls; not blind. The combined control set is evaluated once '
        + 'after the discovery-only candidate freeze.',
      caseSets: [{ fixture: 'normalization-controls.json', cases: 5 },
        { fixture: 'auto-independent-controls.json', cases: 4 }],
      cases: controlView.cases, overall: controlView.overall,
      assessment: controlView.assessment, independentGainCases,
      status: controlStatus, reason: controlReason },
    automaticPromotion: false,
    modelCalls: 0,
    liveStoreReads: 0,
    liveStoreWrites: 0,
    candidatePoolSize: SAFE_CANDIDATES.length,
    stopRule: 'Evaluate triggered safe candidates on discovery cases once; freeze the first '
      + 'candidate with a measured gain and no per-case regression; run controls once and never '
      + 'select or tune a candidate from control results.',
  }
}

const main = () => {
  if (process.argv.length > 2) {
    throw new TypeError('arguments are not accepted: this CLI only reads its frozen local fixtures')
  }
  console.log(JSON.stringify(runAutoOffline(), null, 2))
}

const isMain = globalThis.process?.argv?.[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(globalThis.process.argv[1])).href
if (isMain) main()
