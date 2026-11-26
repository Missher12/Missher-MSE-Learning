/** Offline replay over bounded feature and offer projections; no store, model call, or clock. */
import { adaptivePolicyMatches } from './adaptive-recall.mjs'
import { judge } from './adaptive-selection.mjs'
import { MAX_RECALL_LINE_BYTES, RECALL_TOKEN_UNIT } from './recall-budget.mjs'
import { MAX_RECALL_TOKEN_BUDGET, MIN_RECALL_TOKEN_BUDGET } from './recall-budget-constants.mjs'

const key = row => `${row.id}\u0000${row.version}\u0000${row.mode}`
const sameOffers = (left, right) => left.length === right.length
  && left.every((row, index) => key(row) === key(right[index]))
const validOffer = row => row !== null && typeof row === 'object'
  && typeof row.id === 'string' && Number.isSafeInteger(row.version)
  && ['method', 'guard'].includes(row.mode)
const has = (rows, id, version) => rows.some(row => row.id === id && row.version === version
  && row.mode === 'method')
const validBudget = budget => budget !== null && typeof budget === 'object' && !Array.isArray(budget)
  && Object.keys(budget).every(key => ['unit', 'limit'].includes(key))
  && Number.isSafeInteger(budget.limit)
  && (budget.unit === RECALL_TOKEN_UNIT ? budget.limit >= MIN_RECALL_TOKEN_BUDGET
    && budget.limit <= MAX_RECALL_TOKEN_BUDGET
    : budget.unit === 'bytes' && budget.limit >= 128 && budget.limit < 768)
const measuredForPolicy = (policy, row) => {
  const budget = policy.budget
  if (budget === undefined) return row.budget === undefined
    && row.baselineTokens === undefined && row.candidateTokens === undefined
    && row.baselineBytes <= 768 && row.candidateBytes <= 768
  if (!validBudget(budget) || row.budget?.unit !== budget.unit || row.budget?.limit !== budget.limit) return false
  if (budget.unit === RECALL_TOKEN_UNIT) return Number.isSafeInteger(row.baselineTokens)
    && row.baselineTokens >= 0 && row.baselineTokens <= budget.limit
    && Number.isSafeInteger(row.candidateTokens) && row.candidateTokens >= 0
    && row.candidateTokens <= budget.limit
    && row.baselineBytes <= MAX_RECALL_LINE_BYTES * 3
    && row.candidateBytes <= MAX_RECALL_LINE_BYTES * 3
  return budget.unit === 'bytes' && row.baselineTokens === undefined
    && row.candidateTokens === undefined && row.baselineBytes <= budget.limit
    && row.candidateBytes <= budget.limit
}
const budgetExceeded = (policy, row) => policy.budget === undefined
  ? row.candidateBytes > 768
  : policy.budget.unit === RECALL_TOKEN_UNIT
    ? row.candidateTokens > policy.budget.limit : row.candidateBytes > policy.budget.limit

function replayV1(policy) {
  const incumbent = { hits: 0, misses: 0, falseOffers: 0 }
  const candidate = { hits: 0, misses: 0, falseOffers: 0 }
  const sessions = new Set([policy.firstSession])
  const queries = new Set([policy.firstQuery])
  let evaluated = 0, independentGains = 0, independentControls = 0, regressions = 0,
    repeats = 0, incomplete = 0
  for (const sample of policy.samples ?? []) {
    if (!['holdout_hit', 'negative_control', 'negative'].includes(sample.result)) continue
    const row = sample.replay
    if (!row || !Array.isArray(row.features) || typeof row.baselineHasTarget !== 'boolean'
      || typeof row.canAdd !== 'boolean' || typeof row.expected !== 'boolean'
      || typeof sample.session !== 'string' || typeof sample.query !== 'string'
      || (sample.result === 'holdout_hit') !== row.expected) { incomplete++; continue }
    const old = row.baselineHasTarget
    const matches = adaptivePolicyMatches(policy, row.features)
    const added = !old && row.canAdd && matches
    const next = old || added
    if (added && !row.expected) regressions++
    const independent = !sessions.has(sample.session) && !queries.has(sample.query)
    sessions.add(sample.session); queries.add(sample.query)
    if (!independent) { repeats++; continue }
    evaluated++
    for (const [metrics, offer] of [[incumbent, old], [candidate, next]]) {
      if (row.expected) metrics[offer ? 'hits' : 'misses']++
      else if (offer) metrics.falseOffers++
    }
    if (row.expected && added) independentGains++
    if (!row.expected && !old && row.canAdd && !next && !matches) independentControls++
  }
  const reason = regressions ? 'new_false_offer' : incomplete ? 'incomplete_replay'
    : !independentGains ? 'no_independent_gain' : !independentControls
      ? 'no_independent_control' : 'strict_gain'
  return { approved: reason === 'strict_gain', reason, evaluated, independentGains,
    independentControls, regressions, repeats, incomplete, incumbent, candidate,
    removedMethods: [], maxCandidateBytes: null }
}

function replayV2(policy) {
  const incumbent = { hits: 0, misses: 0, falseOffers: 0 }
  const candidate = { hits: 0, misses: 0, falseOffers: 0 }
  const sessions = new Set([policy.firstSession])
  const queries = new Set([policy.firstQuery])
  const removed = new Set()
  const checkedObjectives = new Set()
  const controlObjectives = new Set()
  const evidenceKeys = []
  let evaluated = 0, independentGains = 0, independentControls = 0, regressions = 0,
    repeats = 0, incomplete = 0, maxCandidateBytes = 0, maxCandidateTokens = 0
  for (const sample of policy.samples ?? []) {
    if (!['holdout_hit', 'holdout_miss', 'negative_control', 'negative'].includes(sample.result)) continue
    if (typeof sample.turnKey === 'string') evidenceKeys.push(sample.turnKey)
    const row = sample.replay
    const checkedControl = row?.nativeCheckEvent !== undefined
    const complete = row && Array.isArray(row.features)
      && typeof row.baselineHasTarget === 'boolean' && typeof row.canAdd === 'boolean'
      && typeof row.expected === 'boolean' && typeof row.matched === 'boolean'
      && Array.isArray(row.baselineOffers) && Array.isArray(row.candidateOffers)
      && Array.isArray(row.protectedOffers) && row.baselineOffers.every(validOffer)
      && row.candidateOffers.every(validOffer) && row.protectedOffers.every(validOffer)
      && Number.isSafeInteger(row.baselineBytes) && row.baselineBytes >= 0
      && Number.isSafeInteger(row.candidateBytes) && row.candidateBytes >= 0
      && measuredForPolicy(policy, row)
      && row.baselineOffers.length <= 3 && row.candidateOffers.length <= 3
      && row.baselineOffers.filter(offer => offer.mode === 'method').length <= 2
      && row.candidateOffers.filter(offer => offer.mode === 'method').length <= 2
      && row.baselineOffers.filter(offer => offer.mode === 'guard').length <= 1
      && row.candidateOffers.filter(offer => offer.mode === 'guard').length <= 1
      && row.protectedOffers.every(offer => row.baselineOffers.some(base => key(base) === key(offer))
        && row.candidateOffers.some(next => key(next) === key(offer)))
      && row.baselineHasTarget === has(row.baselineOffers, policy.entryId, policy.version)
      && row.matched === adaptivePolicyMatches(policy, row.features)
      && typeof sample.session === 'string' && typeof sample.query === 'string'
      && row.observedEntry !== null && typeof row.observedEntry === 'object'
      && typeof row.observedEntry.id === 'string' && Number.isSafeInteger(row.observedEntry.version)
      && row.expected === ['holdout_hit', 'holdout_miss'].includes(sample.result)
      && (sample.result !== 'holdout_miss' || (!row.matched && row.canAdd
        && !row.baselineHasTarget && sameOffers(row.baselineOffers, row.candidateOffers)
        && row.observedEntry.id === policy.entryId && row.observedEntry.version === policy.version))
      && (!checkedControl || (sample.result === 'negative_control'
        && typeof row.nativeCheckEvent === 'string' && /^[a-f0-9]{64}$/u.test(row.nativeCheckEvent)
        && row.observedEntry.id !== policy.entryId && row.canAdd && !row.matched
        && !row.baselineHasTarget && has(row.baselineOffers, row.observedEntry.id, row.observedEntry.version)
        && sameOffers(row.baselineOffers, row.candidateOffers)
        && row.baselineBytes === row.candidateBytes
        && row.baselineTokens === row.candidateTokens))
    if (!complete) { incomplete++; continue }
    maxCandidateBytes = Math.max(maxCandidateBytes, row.candidateBytes)
    if (Number.isSafeInteger(row.candidateTokens)) {
      maxCandidateTokens = Math.max(maxCandidateTokens, row.candidateTokens)
    }
    for (const base of row.baselineOffers) {
      if (base.mode === 'method' && !row.candidateOffers.some(next => key(next) === key(base))) {
        removed.add(base.id)
      }
    }
    const baselineTarget = has(row.baselineOffers, policy.entryId, policy.version)
    const candidateTarget = has(row.candidateOffers, policy.entryId, policy.version)
    const baselineObjective = has(row.baselineOffers, row.observedEntry.id, row.observedEntry.version)
    const candidateObjective = has(row.candidateOffers, row.observedEntry.id, row.observedEntry.version)
    if (baselineObjective && !candidateObjective || budgetExceeded(policy, row)
      || !row.matched && (!sameOffers(row.baselineOffers, row.candidateOffers)
        || row.baselineBytes !== row.candidateBytes || row.baselineTokens !== row.candidateTokens)
      || sample.result === 'holdout_miss' && (row.matched || baselineTarget || candidateTarget)
      || sample.result === 'holdout_hit' && (!row.expected || !row.matched || !row.canAdd || baselineTarget || !candidateTarget
        || !candidateObjective || row.observedEntry.id !== policy.entryId
        || row.observedEntry.version !== policy.version)
      || !row.expected && row.matched && candidateTarget) regressions++
    const control = sample.result === 'negative_control'
    const repeatedObjective = control && (checkedObjectives.has(row.observedEntry.id)
      || checkedControl && controlObjectives.has(row.observedEntry.id))
    if (control) controlObjectives.add(row.observedEntry.id)
    if (checkedControl) checkedObjectives.add(row.observedEntry.id)
    const independent = !sessions.has(sample.session) && !queries.has(sample.query) && !repeatedObjective
    sessions.add(sample.session); queries.add(sample.query)
    if (!independent) { repeats++; continue }
    evaluated++
    if (row.expected) {
      incumbent[baselineTarget ? 'hits' : 'misses']++
      candidate[candidateTarget ? 'hits' : 'misses']++
      if (!baselineTarget && candidateTarget) independentGains++
    } else {
      if (baselineTarget) incumbent.falseOffers++
      if (candidateTarget) candidate.falseOffers++
      if (sample.result === 'negative_control' && !row.matched && !baselineTarget && row.canAdd && !candidateTarget
        && (!baselineObjective || candidateObjective)) independentControls++
    }
  }
  const report = { evaluated, independentGains, independentControls, regressions, repeats, incomplete,
    incumbent, candidate, removedMethods: [...removed].sort(), maxCandidateBytes,
    ...(policy.budget?.unit === RECALL_TOKEN_UNIT ? { maxCandidateTokens } : {}),
    evidenceKeys: [...new Set(evidenceKeys)].sort() }
  const decision = judge({ id: policy.id ?? 'adaptive-candidate', policy, replay: report })
  return { ...report, approved: decision.admissible, reason: decision.reason }
}

export function replayAdaptivePolicy(policy) {
  return policy?.schema === 'mse-adaptive-recall-v2' ? replayV2(policy) : replayV1(policy)
}
