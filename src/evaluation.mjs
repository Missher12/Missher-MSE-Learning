import { check } from './store.mjs'

// Hosts may tighten this predeclared gate, but a proposal cannot lower it to promote itself.
export const DEFAULT_EVALUATION_POLICY = Object.freeze({ minPairs: 12, minHoldout: 4, minFamilies: 2,
  minHoldoutFamilies: 2, minImproved: 5, minHoldoutImproved: 1, maxPValue: 0.05, maxTokenGrowth: 0.25 })
const ownKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every(key => keys.includes(key))
const label = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/u.test(value)
const validTokens = value => value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000)

function policyFor(input = {}) {
  check(ownKeys(input, Object.keys(DEFAULT_EVALUATION_POLICY)), 'invalid_evaluation_policy')
  const policy = { ...DEFAULT_EVALUATION_POLICY, ...input }
  for (const key of ['minPairs', 'minHoldout', 'minFamilies', 'minHoldoutFamilies', 'minImproved', 'minHoldoutImproved']) {
    check(Number.isSafeInteger(policy[key]) && policy[key] >= DEFAULT_EVALUATION_POLICY[key]
      && policy[key] <= 128, 'invalid_evaluation_policy')
  }
  for (const key of ['maxPValue', 'maxTokenGrowth']) check(typeof policy[key] === 'number'
    && Number.isFinite(policy[key]) && policy[key] >= (key === 'maxPValue' ? 0.000001 : 0)
    && policy[key] <= DEFAULT_EVALUATION_POLICY[key], 'invalid_evaluation_policy')
  check(policy.minHoldout <= policy.minPairs && policy.minFamilies <= policy.minPairs
    && policy.minHoldoutFamilies <= policy.minHoldout && policy.minImproved <= policy.minPairs
    && policy.minHoldoutImproved <= policy.minHoldout, 'invalid_evaluation_policy')
  return policy
}

// Exact one-sided paired sign test: ties provide no evidence of an improvement.
function signProbability(improved, regressed) {
  const n = improved + regressed
  if (n === 0) return 1
  let probability = 2 ** -n, tail = improved === 0 ? probability : 0
  for (let successes = 1; successes <= n; successes++) {
    probability *= (n - successes + 1) / successes
    if (successes >= improved) tail += probability
  }
  return Math.min(1, tail)
}

/** Trusted host evidence only. This evaluates supplied trials; it cannot authenticate their provenance. */
export function assessEvaluation({ trials, policy: inputPolicy } = {}) {
  const policy = policyFor(inputPolicy)
  check(Array.isArray(trials) && trials.length <= 128, 'invalid_evaluation_trials')
  const ids = new Set()
  for (const trial of trials) {
    check(ownKeys(trial, ['caseId', 'family', 'split', 'baseline', 'candidate', 'guardPassed'])
      && label(trial.caseId) && !ids.has(trial.caseId) && label(trial.family)
      && ['development', 'holdout'].includes(trial.split) && typeof trial.guardPassed === 'boolean', 'invalid_evaluation_trial')
    for (const result of [trial.baseline, trial.candidate]) check(ownKeys(result, ['passed', 'tokens'])
      && typeof result.passed === 'boolean' && validTokens(result.tokens), 'invalid_evaluation_trial')
    ids.add(trial.caseId)
  }
  const holdout = trials.filter(x => x.split === 'holdout')
  const count = predicate => trials.filter(predicate).length
  const improved = count(x => !x.baseline.passed && x.candidate.passed)
  const regressed = count(x => x.baseline.passed && !x.candidate.passed)
  const baselinePassed = count(x => x.baseline.passed), candidatePassed = count(x => x.candidate.passed)
  const unknownCostPairs = count(x => x.baseline.tokens === null || x.candidate.tokens === null)
  const baselineTokens = unknownCostPairs ? null : trials.reduce((sum, x) => sum + x.baseline.tokens, 0)
  const candidateTokens = unknownCostPairs ? null : trials.reduce((sum, x) => sum + x.candidate.tokens, 0)
  const relativeGain = (candidatePassed - baselinePassed) / Math.max(1, baselinePassed)
  const allowedTokenGrowth = Math.min(policy.maxTokenGrowth, Math.max(0, relativeGain))
  const tokenGrowth = baselineTokens === null || candidateTokens === null ? null
    : baselineTokens === 0 ? (candidateTokens === 0 ? 0 : null) : (candidateTokens - baselineTokens) / baselineTokens
  const summary = { pairs: trials.length, developmentPairs: trials.length - holdout.length, holdoutPairs: holdout.length,
    families: new Set(trials.map(x => x.family)).size, holdoutFamilies: new Set(holdout.map(x => x.family)).size,
    baselinePassed, candidatePassed, improved, regressed, ties: trials.length - improved - regressed,
    holdoutImproved: holdout.filter(x => !x.baseline.passed && x.candidate.passed).length,
    guardFailures: count(x => !x.guardPassed), unknownCostPairs, baselineTokens, candidateTokens,
    pValue: signProbability(improved, regressed), relativeGain, tokenGrowth, allowedTokenGrowth }
  const rejected = [], inconclusive = []
  if (regressed > 0) rejected.push('regression')
  if (summary.guardFailures > 0) rejected.push('guard_failed')
  if (candidatePassed <= baselinePassed && trials.length >= policy.minPairs) rejected.push('no_improvement')
  if (summary.pairs < policy.minPairs) inconclusive.push('insufficient_pairs')
  if (summary.developmentPairs === 0) inconclusive.push('development_missing')
  if (summary.holdoutPairs < policy.minHoldout) inconclusive.push('insufficient_holdout')
  if (summary.families < policy.minFamilies || summary.holdoutFamilies < policy.minHoldoutFamilies) inconclusive.push('insufficient_families')
  if (improved < policy.minImproved) inconclusive.push('insufficient_improvements')
  if (summary.holdoutImproved < policy.minHoldoutImproved) inconclusive.push('holdout_no_improvement')
  if (summary.pValue > policy.maxPValue) inconclusive.push('noise_not_excluded')
  if (unknownCostPairs) inconclusive.push('unknown_cost')
  else if (candidateTokens > baselineTokens * (1 + allowedTokenGrowth)) rejected.push('cost_exceeds_gain')
  return { decision: rejected.length ? 'rejected' : inconclusive.length ? 'inconclusive' : 'accepted',
    reasons: [...rejected, ...inconclusive], summary }
}
