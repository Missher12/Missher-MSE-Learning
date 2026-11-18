import { NORMALIZATION_RULE, normalizedView, selectRecall, selectRecallNormalized } from './recall.mjs'

const offerKey = row => `${row.id}\u0000${row.version}\u0000${row.mode ?? 'method'}`

function isSavedUserRule(entries, offer) {
  if (offer.mode !== 'method') return false
  return entries.some(entry => entry.id === offer.id && entry.version === offer.version
    && entry.type === 'rule' && entry.status === 'user_rule')
}

/** Share the turn's comparison without retaining an entry, scope, or admission across turns. */
export function compareRecallWithUserRulePriority(entries, options = {}) {
  const baseline = selectRecall(entries, options)
  // The normalizer changes only the log concept. If the normalized query has no log,
  // a change limited to this concept cannot affect relevance, exclusions, or ordering.
  if (!normalizedView(options.prompt).semantic.includes(NORMALIZATION_RULE.conceptId)) {
    return { selection: baseline, candidate: null }
  }
  const candidate = selectRecallNormalized(entries, options)
  const baselineOffers = new Set(baseline.offered.map(offerKey))
  const additions = candidate.offered.filter(row => !baselineOffers.has(offerKey(row)))
  if (additions.length === 0 || additions.some(row => !isSavedUserRule(entries, row))) {
    return { selection: baseline, candidate }
  }

  const candidateOffers = new Set(candidate.offered.map(offerKey))
  const protectedBaseline = baseline.offered.filter(row => row.mode === 'guard'
    || entries.find(entry => entry.id === row.id && entry.version === row.version)?.type !== 'rule')
  return { selection: protectedBaseline.some(row => !candidateOffers.has(offerKey(row)))
    ? baseline : candidate, candidate }
}

export function selectRecallWithUserRulePriority(entries, options = {}) {
  return compareRecallWithUserRulePriority(entries, options).selection
}
