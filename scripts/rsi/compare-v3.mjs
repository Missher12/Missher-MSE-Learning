#!/usr/bin/env node
/**
 * OFFLINE-ONLY v3 experiment (MSE-OFFLINE-RECALL-V3-20261105).
 *
 * Candidate: v2-plus-one-guard-offline-v3.
 * Start from the accepted v2 selection and keep every v2 offered entry/line/order/version/mode
 * untouched. If v2 already contains a guard, return it unchanged. Otherwise scan the original
 * production-ranked un-offered guards (same rankForRecall/methodNeedsGuard gates) and append at
 * most ONE real production guard line that fits the remaining 768-byte budget. This is an
 * explicitly changed-count policy (max 3 total, still max 2 methods); the original evaluator's
 * 2-entry budget is intentionally left intact and will report the third entry as over budget.
 *
 * Developer-only: importing this file performs no IO, starts no CLI, reads no live store and
 * calls no provider. It is not wired into the runtime.
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rankForRecall, packRecall } from '../../rebuild/recall.mjs'
import { methodNeedsGuard } from '../../rebuild/evolution.mjs'
import { guardPreservingApplicabilityFirst, compareV2 } from './compare-v2.mjs'
import { compareRecall, loadDefaultCases } from './replay.mjs'

export const V3_SCHEMA = 'mse-rsi-recall-comparison-v3'
export const V3_CANDIDATE = 'v2-plus-one-guard-offline-v3'
export const V3_POLICY = Object.freeze({ maxTotal: 3, maxMethods: 2, maxBytes: 768, maxAddedGuards: 1 })

const sameOffer = (left, right) => left.id === right.id && left.version === right.version
  && left.mode === right.mode

const policyOf = (v2, v3, extraCount, extraIsGuard) => {
  const offered = v3.offered ?? []
  const methods = offered.filter(offer => offer.mode === 'method').length
  const guards = offered.filter(offer => offer.mode === 'guard').length
  const prefixOffers = (v2.offered ?? []).every((offer, index) => sameOffer(offer, offered[index]))
  const v2Lines = v2.lines ?? []
  const prefixLines = v2Lines.every((line, index) => line === (v3.lines ?? [])[index])
  return {
    totalOffers: offered.length,
    methodOffers: methods,
    guardOffers: guards,
    totalBytes: v3.bytes,
    v2PrefixPreserved: prefixOffers && prefixLines,
    extraCount,
    extraIsGuard,
    ok: offered.length <= V3_POLICY.maxTotal
      && methods <= V3_POLICY.maxMethods
      && (v3.bytes ?? 0) <= V3_POLICY.maxBytes
      && prefixOffers && prefixLines
      && extraCount <= V3_POLICY.maxAddedGuards
      && (extraCount === 0 || extraIsGuard),
  }
}

const withAudit = (selection, audit) => ({ ...selection, v3Audit: audit })

const noAppendAudit = (v2, reason, extra = {}) => {
  const base = withAudit(v2, {
    reason, appendedGuard: null, extraCount: 0, extraBytes: 0, skippedGuards: [],
    ...policyOf(v2, v2, 0, false), ...extra,
  })
  return base
}

/**
 * Pure v3 selector. No case id, label, expected result, critical or source metadata is used.
 * If no guard can fit, the exact v2 offered/lines/bytes/order are retained (plus an audit field).
 */
export function v2PlusOneGuardOfflineV3(entries, options) {
  const v2 = guardPreservingApplicabilityFirst(entries, options)
  if ((v2.offered ?? []).some(offer => offer.mode === 'guard')) {
    return noAppendAudit(v2, 'already_has_guard')
  }
  const selected = new Set((v2.offered ?? []).map(offer => offer.id))
  const ranked = rankForRecall(entries, options)
  const candidates = ranked.filter(row => methodNeedsGuard(row.entry) && !selected.has(row.entry.id))
  if (candidates.length === 0) return noAppendAudit(v2, 'no_unoffered_guard')
  const remaining = V3_POLICY.maxBytes - (v2.bytes ?? 0)
  const skippedGuards = []
  let chosen = null
  let packed = null
  for (const row of candidates) {
    if (remaining <= 0) { skippedGuards.push(row.entry.id); continue }
    const one = packRecall([row], { ...options, maxBytes: remaining, maxEntries: 1 })
    if (one.offered.length === 1 && one.offered[0].mode === 'guard') {
      chosen = row
      packed = one
      break
    }
    skippedGuards.push(row.entry.id)
  }
  if (chosen === null) {
    return noAppendAudit(v2, 'guard_does_not_fit', { skippedGuards })
  }
  const offered = [...(v2.offered ?? []), ...packed.offered]
  const lines = [...(v2.lines ?? []), ...packed.lines]
  const bytes = (v2.bytes ?? 0) + packed.bytes
  const appended = {
    id: packed.offered[0].id,
    version: packed.offered[0].version,
    mode: packed.offered[0].mode,
    bytes: packed.bytes,
    line: packed.lines[0],
  }
  const result = { ...v2, offered, lines, bytes }
  return withAudit(result, {
    reason: 'appended_guard', appendedGuard: appended, extraCount: 1,
    extraBytes: packed.bytes, skippedGuards, ...policyOf(v2, result, 1, true),
  })
}

const strictGroup = (v3Group, v2Group, rows) => ({
  ...v3Group,
  v2: v2Group?.candidate ?? null,
  v2Bytes: v2Group ? v2Group.candidate.bytes : null,
  extraEntries: rows.reduce((total, row) => total
    + (row.v3?.offered.length ?? 0) - (row.v2?.offered.length ?? 0), 0),
  extraBytes: rows.reduce((total, row) => total
    + (row.v3?.bytes ?? 0) - (row.v2?.bytes ?? 0), 0),
  strictOverBudgetCases: rows.filter(row => row.v3?.overBudget).length,
  experimentalViolations: rows.filter(row => !row.v3Audit?.ok).length,
  appendedCases: rows.filter(row => row.v3Audit?.appendedGuard).length,
  reasons: rows.reduce((counts, row) => {
    const reason = row.v3Audit?.reason ?? 'unknown'
    counts[reason] = (counts[reason] ?? 0) + 1
    return counts
  }, {}),
})

/**
 * Compare production baseline, v2 and v3 with the UNCHANGED old evaluator. Strict metrics keep the
 * original 2-entry budget (`overBudget`); the separate experimental audit checks the explicit
 * 3-total/2-method/1-added-guard policy. A strict no_go is reported even if the experiment closes
 * a guard gap, because the online policy did not change.
 */
export function compareV3(cases = loadDefaultCases(), { now = 0 } = {}) {
  const v2Report = compareV2(cases, { now })
  const raw = []
  const v3Candidate = (entries, options) => {
    const selection = v2PlusOneGuardOfflineV3(entries, options)
    raw.push({ v3Audit: selection.v3Audit, lines: selection.lines,
      offered: selection.offered, bytes: selection.bytes })
    return selection
  }
  const v3Report = compareRecall(cases, { now, candidate: v3Candidate })
  const mergedCases = v3Report.cases.map((row, index) => {
    const v2Row = v2Report.cases[index]
    return {
      ...row,
      v2: v2Row.v2,
      v2Verdict: v2Row.verdict,
      v2Audit: v2Row.v2Audit,
      v3: row.candidate,
      v3Verdict: row.verdict,
      v3Audit: raw[index].v3Audit,
      v3Lines: raw[index].lines,
      v3Offers: raw[index].offered,
      v3Bytes: raw[index].bytes,
    }
  })
  const groups = v3Report.groups.map(group => strictGroup(group,
    v2Report.groups.find(other => other.source === group.source),
    mergedCases.filter(row => row.source === group.source)))
  const appendedCases = mergedCases.filter(row => row.v3Audit?.appendedGuard)
  const extraEntries = mergedCases.reduce((total, row) => total
    + (row.v3?.offered.length ?? 0) - (row.v2?.offered.length ?? 0), 0)
  const extraBytes = mergedCases.reduce((total, row) => total
    + (row.v3?.bytes ?? 0) - (row.v2?.bytes ?? 0), 0)
  // REVIEW-FIX1: every newly introduced miss/false/guard miss or guard-mode error is a hard
  // experimental rejection. No aggregate gain (including the appended guard) can cancel it.
  const qualityRegressions = []
  for (const row of mergedCases) {
    for (const [kind, key] of [['miss', 'misses'], ['falseOffer', 'falseOffers'],
      ['guardMiss', 'guardMisses']]) {
      for (const id of row.v3[key].filter(id => !row.v2[key].includes(id))) {
        qualityRegressions.push({ caseId: row.id, id, kind })
      }
    }
    const oldModeErrors = new Set((row.v2.guardModeMismatches ?? [])
      .map(mismatch => `${mismatch.id}\u0000${mismatch.mode}`))
    for (const mismatch of row.v3.guardModeMismatches ?? []) {
      if (!oldModeErrors.has(`${mismatch.id}\u0000${mismatch.mode}`)) {
        qualityRegressions.push({ caseId: row.id, id: mismatch.id,
          kind: 'modeMismatch', mode: mismatch.mode })
      }
    }
  }
  const uniqueIds = kind => [...new Set(qualityRegressions
    .filter(row => row.kind === kind).map(row => row.id))]
  const newVsV2 = {
    misses: uniqueIds('miss'),
    falseOffers: uniqueIds('falseOffer'),
    guardMisses: uniqueIds('guardMiss'),
    modeMismatches: uniqueIds('modeMismatch'),
  }
  const qualityGain = mergedCases.some(row => row.v3.hits.length > row.v2.hits.length
    || row.v3.falseOffers.length < row.v2.falseOffers.length
    || row.v3.guardMisses.length < row.v2.guardMisses.length)
  const policyViolations = mergedCases.filter(row => !row.v3Audit?.ok)
  const experimentalPolicyDecision = qualityRegressions.length > 0
    ? 'no_go_quality_regression'
    : policyViolations.length > 0
      ? 'experimental_policy_violation'
      : qualityGain && appendedCases.length > 0
        ? 'experimental_candidate_requires_policy_change'
        : 'no_experimental_gain'
  const overall = {
    ...v3Report.overall,
    v2: v2Report.v2Summary.overall.candidate,
    extraEntries,
    extraBytes,
    appendedCases: appendedCases.map(row => row.id),
    experimentalViolations: policyViolations.map(row => row.id),
    newVsV2,
    qualityRegressions,
    strictOverBudgetCases: v3Report.overall.overBudgetCases,
  }
  return {
    schema: V3_SCHEMA,
    mode: 'offline_developer_comparison',
    candidateName: V3_CANDIDATE,
    deployAllowed: false,
    automaticPromotion: false,
    now,
    modelCalls: 0,
    liveStoreReads: 0,
    liveStoreWrites: 0,
    futureProviderCost: 'not_evaluated',
    policy: V3_POLICY,
    policyNote: 'The experimental policy allows at most 3 total / 2 methods / 1 appended guard; '
      + 'the original 2-entry evaluator remains unchanged and still reports overBudget/no_go.',
    strictPolicyDecision: v3Report.decision,
    strictPolicyNote: v3Report.decisionNote,
    experimentalPolicyDecision,
    experimentalPolicyNote: 'Audited separately from the strict 2-entry result; never online.',
    v2Summary: { decision: v2Report.decision, overall: v2Report.v2Summary.overall,
      groups: v2Report.v2Summary.groups },
    v3Summary: { decision: v3Report.decision, overall: v3Report.overall,
      groups: v3Report.groups },
    overall,
    groups,
    cases: mergedCases,
  }
}

const main = () => {
  if (process.argv.length > 2) {
    throw new TypeError('--cases is not accepted: this CLI only reads the frozen default fixtures')
  }
  console.log(JSON.stringify(compareV3(), null, 2))
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) main()
