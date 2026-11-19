import test from 'node:test'
import assert from 'node:assert/strict'
import { judge, selectRound } from './adaptive-selection.mjs'

const evidenceKeys = ['turn-a', 'turn-b', 'turn-c', 'turn-d']
const candidate = ({ id, hits, misses = 0, falseOffers = 0, featureCount = 3,
  keys = evidenceKeys, gains = 2, controls = 2, regressions = 0, incomplete = 0,
  mode = 'observing' }) => ({ id,
  policy: { id, mode, features: Array.from({ length: featureCount }, (_, index) => `topic-${index}`),
    excludedFeatures: [] },
  replay: { approved: true, evidenceKeys: keys, independentGains: gains, independentControls: controls,
    regressions, incomplete, candidate: { hits, misses, falseOffers } } })

test('RRSI judge applies the real-evidence floor and rejects regressions before selection', () => {
  assert.deepEqual(judge(candidate({ id: 'short', hits: 1, gains: 1 })),
    { policyId: 'short', admissible: false, reason: 'need_two_independent_gains',
      hits: 1, falseOffers: 0, specificity: 3 })
  assert.equal(judge(candidate({ id: 'regressed', hits: 3, regressions: 1 })).reason,
    'offer_or_objective_regression')
})

test('RRSI selectRound compares the same history, picks the best qualified candidate, and keeps an incumbent on ties', () => {
  const broad = candidate({ id: 'broad', hits: 3, misses: 1, featureCount: 3 })
  const exact = candidate({ id: 'exact', hits: 2, misses: 2, featureCount: 4 })
  assert.equal(selectRound([broad, exact]).winnerId, 'broad')
  const tiedIncumbent = candidate({ id: 'enabled', hits: 3, misses: 1, featureCount: 4, mode: 'approved' })
  assert.equal(selectRound([broad, tiedIncumbent], { incumbentId: 'enabled' }).winnerId, 'enabled',
    'an enabled policy stays when replay results tie')
  const better = candidate({ id: 'better', hits: 4, featureCount: 2 })
  assert.equal(selectRound([tiedIncumbent, better], { incumbentId: 'enabled' }).winnerId, 'better')

  const tied = candidate({ id: 'tied', hits: 2, misses: 2, featureCount: 2 })
  assert.equal(selectRound([exact, tied]).winnerId, 'exact',
    'an initial tie prefers the more specific condition')
})

test('RRSI selectRound refuses candidates with different frozen turn histories', () => {
  const incumbent = candidate({ id: 'incumbent', hits: 2, mode: 'approved' })
  const late = candidate({ id: 'late', hits: 3, keys: ['turn-a', 'turn-b', 'turn-c', 'turn-e'] })
  const result = selectRound([incumbent, late], { incumbentId: incumbent.id })
  assert.equal(result.winnerId, incumbent.id)
  assert.equal(result.reason, 'incomparable_evidence')
  assert.ok(result.decisions.every(row => row.admissible === false
    && row.reason === 'incomparable_evidence'))
  const firstRound = selectRound([candidate({ id: 'first', hits: 2 }), late])
  assert.equal(firstRound.winnerId, null)
  assert.equal(firstRound.reason, 'incomparable_evidence')
})
