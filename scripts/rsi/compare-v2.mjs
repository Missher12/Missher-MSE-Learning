#!/usr/bin/env node
/**
 * OFFLINE-ONLY v2 recall comparison (MSE-OFFLINE-RECALL-V2-20261105).
 *
 * Candidate: guard-preserving-method-applicability-v2.
 * The production rankForRecall is unchanged. Guards (the production methodNeedsGuard judgment)
 * stay at their original ranked positions; only non-guard rows are stably partitioned by
 * appMatch=true. The same production packRecall applies the 2-entry / 768-byte limit. If the
 * reordered packing drops a guard that the production baseline already offered, the WHOLE case
 * falls back to baseline and is audited. No case id / label / critical / expected input is read.
 *
 * Developer-only: importing this file reads no fixture, starts no CLI, calls no model/provider,
 * writes nothing and is not part of the runtime package.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rankForRecall, packRecall, recallSelection } from '../../rebuild/recall.mjs'
import { methodNeedsGuard } from '../../rebuild/evolution.mjs'
import { compareRecall, loadDefaultCases } from './replay.mjs'

export const V2_SCHEMA = 'mse-rsi-recall-comparison-v2'
export const V2_CANDIDATE = 'guard-preserving-method-applicability-v2'

const sameOffered = (left, right) => left.id === right.id
  && left.version === right.version && left.mode === right.mode

/**
 * Pure v2 selector. It only receives entries/options; it never sees labels, case ids, expected
 * results, critical flags or source metadata. The returned selection may carry audit fields for
 * the caller, but the metrics are always the real packRecall result (or the real baseline on
 * fallback).
 */
export function guardPreservingApplicabilityFirst(entries, options) {
  const baseline = recallSelection(entries, options)
  const ranked = rankForRecall(entries, options)
  const guardRows = []
  const methodRows = []
  for (const row of ranked) {
    if (methodNeedsGuard(row.entry)) guardRows.push(row)
    else methodRows.push(row)
  }
  const sortedMethods = methodRows.map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftApp = left.row.appMatch === true ? 0 : 1
      const rightApp = right.row.appMatch === true ? 0 : 1
      return leftApp - rightApp || left.index - right.index
    })
    .map(row => row.row)
  // Put guards back at their original ranked indices; only the non-guard slots are permuted.
  const merged = []
  let guardIndex = 0
  let methodIndex = 0
  for (const row of ranked) {
    merged.push(methodNeedsGuard(row.entry)
      ? guardRows[guardIndex++]
      : sortedMethods[methodIndex++])
  }
  const candidate = packRecall(merged, options)
  const baselineGuards = baseline.offered.filter(offer => offer.mode === 'guard')
  const missingGuards = baselineGuards.filter(offer =>
    !candidate.offered.some(other => sameOffered(offer, other)))
  if (missingGuards.length > 0) {
    return { ...baseline, guardPreservationFallback: true,
      fallbackReason: 'guard_preservation_fallback', missingGuards }
  }
  return { ...candidate, guardPreservationFallback: false, missingGuards: [] }
}

const auditOf = selection => ({
  guardPreservationFallback: selection.guardPreservationFallback === true,
  fallbackReason: selection.guardPreservationFallback === true
    ? 'guard_preservation_fallback' : null,
  missingGuards: selection.missingGuards ?? [],
})

/**
 * Compare baseline, v1 and v2 on the same frozen cases. `v1` is the untouched
 * applicabilityFirstRecall from the prior tool; v2 is the guard-preserving selector above.
 * Fallback audits are attached per case and are never converted into a gain.
 */
export function compareV2(cases = loadDefaultCases(), { now = 0 } = {}) {
  const audits = []
  const v2Candidate = (entries, options) => {
    const selection = guardPreservingApplicabilityFirst(entries, options)
    audits.push(auditOf(selection))
    return selection
  }
  const v1 = compareRecall(cases, { now })
  const v2 = compareRecall(cases, { now, candidate: v2Candidate })
  const casesV2 = v2.cases.map((row, index) => {
    const v1Row = v1.cases[index]
    return {
      ...row,
      v1: v1Row.candidate,
      v2: row.candidate,
      v1Verdict: v1Row.verdict,
      v1CriticalRegression: v1Row.criticalRegression,
      v1Changes: v1Row.changes,
      v2Audit: audits[index] ?? { guardPreservationFallback: false,
        fallbackReason: null, missingGuards: [] },
    }
  })
  const fallbackCases = casesV2.filter(row => row.v2Audit.guardPreservationFallback)
  return {
    schema: V2_SCHEMA,
    mode: 'offline_developer_comparison',
    candidateName: V2_CANDIDATE,
    deployAllowed: false,
    automaticPromotion: false,
    now,
    modelCalls: 0,
    liveStoreReads: 0,
    liveStoreWrites: 0,
    futureProviderCost: 'not_evaluated',
    limits: [
      'Only the frozen cases listed here are scored; this is not a blind test or a live production replay.',
      'The v2 candidate only reorders non-guard rows; production rank/pack/guard functions are reused.',
      'Fallback cases are audited and return baseline; they are not counted as candidate gains.',
      'No runtime, live store, model route, package or deployment is touched.',
    ],
    decision: v2.decision,
    decisionNote: v2.decisionNote,
    deployAllowedReason: 'offline comparison only; never auto-promoted',
    v2Summary: { decision: v2.decision, overall: v2.overall, groups: v2.groups },
    v1Summary: { decision: v1.decision, overall: v1.overall, groups: v1.groups },
    fallbackCases: fallbackCases.map(row => row.id),
    fallbackAudit: fallbackCases.map(row => ({ id: row.id, ...row.v2Audit })),
    overall: v2.overall,
    groups: v2.groups,
    cases: casesV2,
  }
}

const main = () => {
  if (process.argv.length > 2) {
    throw new TypeError('--cases is not accepted: this CLI only reads the frozen default fixtures')
  }
  const report = compareV2()
  console.log(JSON.stringify(report, null, 2))
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) main()
