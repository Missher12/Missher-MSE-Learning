import { selectRecall, selectRecallNormalized } from './recall.mjs'

const offerKey = row => `${row.id}\u0000${row.version}\u0000${row.mode ?? 'method'}`

function isSavedUserRule(entries, offer) {
  if (offer.mode !== 'method') return false
  return entries.some(entry => entry.id === offer.id && entry.version === offer.version
    && entry.type === 'rule' && entry.status === 'user_rule')
}

/** Re-rank only trusted saved user rules; lesson promotion remains under its existing evidence gate. */
export function selectRecallWithUserRulePriority(entries, options = {}) {
  const baseline = selectRecall(entries, options)
  const candidate = selectRecallNormalized(entries, options)
  const baselineOffers = new Set(baseline.offered.map(offerKey))
  const additions = candidate.offered.filter(row => !baselineOffers.has(offerKey(row)))
  if (additions.length === 0 || additions.some(row => !isSavedUserRule(entries, row))) return baseline

  const candidateOffers = new Set(candidate.offered.map(offerKey))
  const protectedBaseline = baseline.offered.filter(row => row.mode === 'guard'
    || entries.find(entry => entry.id === row.id && entry.version === row.version)?.type !== 'rule')
  if (protectedBaseline.some(row => !candidateOffers.has(offerKey(row)))) return baseline
  return candidate
}
