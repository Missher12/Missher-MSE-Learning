import { NORMALIZATION_RULE, normalizedView, packRecall, rankForRecall, rankForRecallNormalized,
  MAX_GUARDS_PER_TURN, MAX_METHODS_PER_TURN } from './recall.mjs'
import { methodNeedsGuard } from './evolution.mjs'

const offerKey = row => `${row.id}\u0000${row.version}\u0000${row.mode ?? 'method'}`
const versionKey = row => `${row.id}\u0000${row.version}`

function isSavedUserRule(entries, offer) {
  return offer.mode === 'method' && entries.some(entry => entry.id === offer.id
    && entry.version === offer.version && entry.type === 'rule' && entry.status === 'user_rule')
}

function selectPacked(entries, { prompt, scope, environment, maxBytes, maxMethods, maxGuards,
  excludeOffers, now, guardAdmit }, ranker) {
  const limit = Math.min(768, maxBytes)
  const excluded = new Set(excludeOffers.map(versionKey))
  const ranked = ranker(entries, { prompt, scope, environment })
    .filter(row => !excluded.has(versionKey({ id: row.entry.id, version: row.entry.version })))
  const methodRows = ranked.filter(row => !methodNeedsGuard(row.entry, now))
    .map((row, index) => ({ row, index }))
    .sort((left, right) => (left.row.appMatch === true ? 0 : 1)
      - (right.row.appMatch === true ? 0 : 1) || left.index - right.index)
    .map(item => item.row)
  const methods = packRecall(methodRows, { maxBytes: limit, maxEntries: Math.min(maxMethods,
    MAX_METHODS_PER_TURN), now, guardAdmit })
  const lines = [...methods.lines]
  const offered = [...methods.offered]
  let bytes = methods.bytes
  if (maxGuards > 0 && bytes < limit) {
    for (const row of ranked) {
      if (!methodNeedsGuard(row.entry, now)) continue
      const guard = packRecall([row], { maxBytes: limit - bytes,
        maxEntries: Math.min(maxGuards, MAX_GUARDS_PER_TURN), now, guardAdmit })
      if (guard.offered.length === 1) {
        lines.push(...guard.lines)
        offered.push(...guard.offered)
        bytes += guard.bytes
        break
      }
    }
  }
  return { lines, bytes, offered }
}

/** Same rank/packing and saved-user-rule protection as first-step recall, with residual slots. */
export function selectMidTurnRecall(entries, options) {
  const baseline = selectPacked(entries, options, rankForRecall)
  if (!normalizedView(options.prompt).semantic.includes(NORMALIZATION_RULE.conceptId)) return baseline
  const candidate = selectPacked(entries, options, rankForRecallNormalized)
  const baselineOffers = new Set(baseline.offered.map(offerKey))
  const additions = candidate.offered.filter(row => !baselineOffers.has(offerKey(row)))
  if (additions.length === 0 || additions.some(row => !isSavedUserRule(entries, row))) return baseline
  const candidateOffers = new Set(candidate.offered.map(offerKey))
  const protectedBaseline = baseline.offered.filter(row => row.mode === 'guard'
    || entries.find(entry => entry.id === row.id && entry.version === row.version)?.type !== 'rule')
  return protectedBaseline.some(row => !candidateOffers.has(offerKey(row))) ? baseline : candidate
}
