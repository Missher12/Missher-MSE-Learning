import test from 'node:test'
import assert from 'node:assert/strict'
import { assessEvaluation, DEFAULT_EVALUATION_POLICY } from '../src/evaluation.mjs'

function trials({ count = 16, improved = 8, tokens = 100 } = {}) {
  return Array.from({ length: count }, (_, index) => ({ caseId: `case-${index}`, family: `family-${index % 2}`,
    split: index < 4 ? 'holdout' : 'development', baseline: { passed: index >= improved, tokens },
    candidate: { passed: true, tokens }, guardPassed: true }))
}

test('paired evidence with heldout improvement passes conservatively and never mutates its input', () => {
  const input = trials(), before = JSON.stringify(input)
  for (const trial of input) { Object.freeze(trial.baseline); Object.freeze(trial.candidate); Object.freeze(trial) }
  Object.freeze(input)
  const result = assessEvaluation({ trials: input })
  assert.equal(result.decision, 'accepted')
  assert.deepEqual(result.reasons, [])
  assert.equal(result.summary.pValue, 2 ** -8)
  assert.equal(result.summary.improved, 8)
  assert.equal(result.summary.holdoutPairs, 4)
  assert.equal(JSON.stringify(input), before)
})

test('two successes are insufficient and ties cannot manufacture significance', () => {
  const insufficient = assessEvaluation({ trials: trials({ count: 2, improved: 2 }) })
  assert.equal(insufficient.decision, 'inconclusive')
  assert.ok(insufficient.reasons.includes('insufficient_pairs'))
  assert.ok(insufficient.reasons.includes('noise_not_excluded'))
  const manyTies = assessEvaluation({ trials: trials({ count: 128, improved: 4 }) })
  assert.equal(manyTies.decision, 'inconclusive')
  assert.equal(manyTies.summary.pValue, 0.0625)
  assert.equal(assessEvaluation({ trials: trials({ improved: 5 }) }).decision, 'accepted')
})

test('any regression or non-compensatory guard failure vetoes otherwise large gains', () => {
  const regressed = trials(); regressed[15].candidate.passed = false
  const regression = assessEvaluation({ trials: regressed })
  assert.equal(regression.decision, 'rejected')
  assert.ok(regression.reasons.includes('regression'))
  const guarded = trials(); guarded[0].guardPassed = false
  const guard = assessEvaluation({ trials: guarded })
  assert.equal(guard.decision, 'rejected')
  assert.ok(guard.reasons.includes('guard_failed'))
})

test('holdout and task-family diversity are required even for noiseless perfect gains', () => {
  const noHoldout = trials().map(row => ({ ...row, split: 'development' }))
  assert.ok(assessEvaluation({ trials: noHoldout }).reasons.includes('insufficient_holdout'))
  const singleFamily = trials().map(row => ({ ...row, family: 'single' }))
  assert.ok(assessEvaluation({ trials: singleFamily }).reasons.includes('insufficient_families'))
  const holdoutWithoutGain = trials().map((row, i) => ({ ...row, baseline: { ...row.baseline, passed: i < 4 || i > 9 } }))
  assert.equal(assessEvaluation({ trials: holdoutWithoutGain }).decision, 'inconclusive')
  assert.ok(assessEvaluation({ trials: holdoutWithoutGain }).reasons.includes('holdout_no_improvement'))
  assert.ok(assessEvaluation({ trials: trials().map(row => ({ ...row, split: 'holdout' })) }).reasons.includes('development_missing'))
})

test('unknown cost is inconclusive rather than free; explicit zero-token deterministic trials are valid', () => {
  const unknown = trials(); unknown[0].baseline.tokens = null
  const result = assessEvaluation({ trials: unknown })
  assert.equal(result.decision, 'inconclusive')
  assert.ok(result.reasons.includes('unknown_cost'))
  assert.equal(result.summary.baselineTokens, null)
  assert.equal(result.summary.candidateTokens, null)
  assert.equal(assessEvaluation({ trials: trials({ tokens: 0 }) }).decision, 'accepted')
  const newlyCostly = trials({ tokens: 0 }); newlyCostly[0].candidate.tokens = 1
  const costly = assessEvaluation({ trials: newlyCostly })
  assert.equal(costly.decision, 'rejected')
  assert.ok(costly.reasons.includes('cost_exceeds_gain'))
  assert.equal(costly.summary.tokenGrowth, null)
})

test('token growth must be paid by relative gains and never exceeds the fixed 25 percent cap', () => {
  const atCap = trials().map(row => ({ ...row, candidate: { passed: true, tokens: 125 } }))
  assert.equal(assessEvaluation({ trials: atCap }).decision, 'accepted')
  const overCap = atCap.map(row => ({ ...row, candidate: { passed: true, tokens: 126 } }))
  assert.equal(assessEvaluation({ trials: overCap }).decision, 'rejected')
  const smallGain = trials({ count: 128, improved: 5 }).map(row => ({ ...row, candidate: { passed: true, tokens: 110 } }))
  const result = assessEvaluation({ trials: smallGain })
  assert.equal(result.decision, 'rejected')
  assert.ok(result.summary.allowedTokenGrowth < 0.05)
})

test('policy may only tighten and bounded schema rejects invalid or duplicate trial evidence', () => {
  for (const policy of [{ minPairs: 2 }, { minImproved: 1 }, { maxPValue: 0.5 }, { maxTokenGrowth: 99 },
    { bypass: true }, { minPairs: undefined }, { minHoldout: 20 }, { maxTokenGrowth: NaN }, { minFamilies: -1 }]) {
    assert.throws(() => assessEvaluation({ trials: trials(), policy }), /invalid_evaluation_policy/)
  }
  assert.equal(assessEvaluation({ trials: trials(), policy: { minPairs: 20 } }).decision, 'inconclusive')
  assert.equal(assessEvaluation({ trials: trials(), policy: { maxPValue: 0.001 } }).decision, 'inconclusive')
  assert.ok(Object.isFrozen(DEFAULT_EVALUATION_POLICY))
  for (const broken of [trials({ count: 129 }), [trials()[0], { ...trials()[0], split: 'development' }],
    [{ ...trials()[0], caseId: 'bad\n' }], [{ ...trials()[0], split: 'training' }],
    [{ ...trials()[0], guardPassed: 'true' }], [{ ...trials()[0], payload: 'forbidden' }],
    [{ ...trials()[0], baseline: { passed: true, tokens: undefined } }],
    [{ ...trials()[0], baseline: { passed: true, tokens: -1 } }],
    [{ ...trials()[0], candidate: { passed: true, tokens: NaN } }],
    [{ ...trials()[0], candidate: { passed: true, tokens: Infinity } }],
    [{ ...trials()[0], candidate: { passed: true, tokens: 0.5 } }],
    [{ ...trials()[0], candidate: { passed: 1, tokens: 0 } }]]) {
    assert.throws(() => assessEvaluation({ trials: broken }), /invalid_evaluation_trial/)
  }
  const empty = assessEvaluation({ trials: [] })
  assert.equal(empty.decision, 'inconclusive')
  assert.equal(empty.summary.pValue, 1)
})

test('large samples remain finite and an unchanged candidate is explicitly rejected', () => {
  const allImproved = assessEvaluation({ trials: trials({ count: 128, improved: 128 }) })
  assert.equal(allImproved.decision, 'accepted')
  assert.ok(Number.isFinite(allImproved.summary.pValue) && allImproved.summary.pValue > 0)
  const noGain = assessEvaluation({ trials: trials({ improved: 0 }) })
  assert.equal(noGain.decision, 'rejected')
  assert.ok(noGain.reasons.includes('no_improvement'))
})
