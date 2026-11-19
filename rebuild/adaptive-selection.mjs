/*
 * Adapted from google-research/rrsi/rrsi/selection.py at be50316e1db05914068a973f322770ef08ed7ba1.
 * Copyright 2026 The rrsi Authors and Google LLC. Licensed under Apache-2.0; see
 * THIRD_PARTY_NOTICES.md and licenses/Apache-2.0.txt.
 * Modified for MSE: judge frozen native recall replays against the existing two-gain,
 * two-control and no-regression gate, then select one policy from a shared turn history.
 */

const validId = value => typeof value === 'string' && value.length > 0
const count = value => Number.isSafeInteger(value) && value >= 0
const evidenceKeys = candidate => Array.isArray(candidate?.replay?.evidenceKeys)
  && candidate.replay.evidenceKeys.length > 0
  && candidate.replay.evidenceKeys.every(validId)
  ? [...new Set(candidate.replay.evidenceKeys)].sort() : null
const sameEvidence = candidates => {
  if (candidates.length < 2) return true
  const first = evidenceKeys(candidates[0])
  return first !== null && candidates.slice(1).every(candidate => {
    const next = evidenceKeys(candidate)
    return next !== null && next.length === first.length
      && next.every((key, index) => key === first[index])
  })
}
const specificity = policy => (Array.isArray(policy?.features) ? policy.features.length : 0)
  + (Array.isArray(policy?.excludedFeatures) ? policy.excludedFeatures.length : 0)

/** Evaluate one frozen replay using MSE's real admission and evidence thresholds. */
export function judge(candidate, { comparable = true, incumbent = false } = {}) {
  const replay = candidate?.replay
  const stats = replay?.candidate
  const hits = count(stats?.hits) ? stats.hits : 0
  const falseOffers = count(stats?.falseOffers) ? stats.falseOffers : 0
  const specific = specificity(candidate?.policy)
  let reason = 'strict_gain'
  let admissible = true
  if (!validId(candidate?.id) || replay === null || typeof replay !== 'object'
    || !Array.isArray(replay.evidenceKeys) || !count(replay.independentGains)
    || !count(replay.independentControls) || !count(replay.regressions)
    || !count(replay.incomplete) || !stats || !count(stats.hits) || !count(stats.misses)
    || !count(stats.falseOffers)) {
    admissible = false
    reason = 'incomplete_replay'
  } else if (!comparable) {
    admissible = false
    reason = 'incomparable_evidence'
  } else if (replay.regressions > 0) {
    admissible = false
    reason = 'offer_or_objective_regression'
  } else if (replay.incomplete > 0) {
    admissible = false
    reason = 'incomplete_replay'
  } else if (incumbent) {
    reason = 'incumbent_retained'
  } else if (replay.independentGains < 2) {
    admissible = false
    reason = 'need_two_independent_gains'
  } else if (replay.independentControls < 2) {
    admissible = false
    reason = 'need_two_independent_controls'
  }
  return { policyId: candidate?.id ?? null, admissible, reason,
    hits, falseOffers, specificity: specific }
}

/** Judge a comparable set and retain its incumbent unless a challenger has a strict gain. */
export function selectRound(candidates, { incumbentId = null } = {}) {
  const rows = Array.isArray(candidates) ? candidates.filter(candidate => validId(candidate?.id)) : []
  const current = incumbentId === null
    ? rows.find(candidate => candidate.policy?.mode === 'approved') ?? null
    : rows.find(candidate => candidate.id === incumbentId) ?? null
  const currentId = current?.id ?? incumbentId
  const comparable = sameEvidence(rows)
  const decisions = rows.map(candidate => judge(candidate, {
    comparable, incumbent: candidate.id === currentId && candidate.policy?.mode === 'approved',
  }))
  if (!comparable) {
    return { winnerId: current?.policy?.mode === 'approved' ? current.id : null,
      reason: 'incomparable_evidence', decisions }
  }
  const decisionById = new Map(decisions.map(row => [row.policyId, row]))
  const eligible = rows.filter(candidate => decisionById.get(candidate.id)?.admissible)
  const sortBest = (left, right) => {
    const a = decisionById.get(left.id), b = decisionById.get(right.id)
    return b.hits - a.hits || a.falseOffers - b.falseOffers
      || b.specificity - a.specificity || left.id.localeCompare(right.id)
  }
  const best = eligible.sort(sortBest)[0] ?? null
  if (current !== null && current.policy?.mode === 'approved') {
    const activeDecision = decisionById.get(current.id)
    const challenger = eligible.filter(row => row.id !== current.id).sort(sortBest)[0]
    if (challenger !== undefined && activeDecision?.admissible === true) {
      const challengerDecision = decisionById.get(challenger.id)
      if (challengerDecision.hits > activeDecision.hits
        || challengerDecision.hits === activeDecision.hits
          && challengerDecision.falseOffers < activeDecision.falseOffers) {
        return { winnerId: challenger.id, reason: 'strict_gain', decisions }
      }
    }
    return { winnerId: current.id, reason: 'incumbent_retained', decisions }
  }
  return { winnerId: best?.id ?? null,
    reason: best === null ? 'no_admissible_candidate' : 'strict_gain', decisions }
}
