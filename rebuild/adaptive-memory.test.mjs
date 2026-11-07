import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { replayAdaptivePolicy } from './adaptive-replay.mjs'
import { createDoc, MemoryStore, validateDoc } from './memory.mjs'
import { synthesizeAdaptiveTaskPolicy } from './adaptive-recall.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const entry = digit => `mem_${digit.repeat(24)}`
const offers = {
  baseline: [{ id: entry('1'), version: Number.MAX_SAFE_INTEGER, mode: 'method' },
    { id: entry('2'), version: 7, mode: 'method' }, { id: entry('3'), version: 4, mode: 'guard' }],
  candidate: [{ id: entry('4'), version: Number.MAX_SAFE_INTEGER, mode: 'method' },
    { id: entry('1'), version: Number.MAX_SAFE_INTEGER, mode: 'method' },
    { id: entry('3'), version: 4, mode: 'guard' }],
  protected: [{ id: entry('1'), version: Number.MAX_SAFE_INTEGER, mode: 'method' },
    { id: entry('3'), version: 4, mode: 'guard' }],
}

function sample(index, result, reason, expected, matched) {
  const session = hash(`session-${index}`)
  const query = hash(`query-${index}`)
  if (result === 'discovery_hit') return { turnKey: hash(`turn-${index}`), session, query,
    result, reason, at: index }
  const features = matched
    ? ['api', 'json', 'excel', 'chart', 'opdebug', 'config', 'table', 'opcheck']
    : ['json', 'csv', 'yaml', 'xml', 'toml', 'tsv', 'md', 'text']
  const candidateOffers = matched ? offers.candidate : offers.baseline
  const observedEntry = expected ? offers.candidate[0] : offers.baseline[1]
  return { turnKey: hash(`turn-${index}`), session, query, result, reason, at: index,
    replay: { features, baselineHasTarget: false, canAdd: true, expected, matched,
      baselineOffers: offers.baseline, candidateOffers,
      protectedOffers: offers.protected, baselineBytes: 767, candidateBytes: 768,
      observedEntry: { id: observedEntry.id, version: observedEntry.version } } }
}

test('maximal bounded adaptive evidence validates and isolated writeback survives reload', () => {
  const parentId = hash('adaptive-parent')
  const familyId = hash('adaptive-family')
  const parent = { id: parentId, schema: 'mse-adaptive-recall-v2', scope: hash('scope'),
    qualification: hash('qualification'), entryId: offers.candidate[0].id, version: Number.MAX_SAFE_INTEGER,
    objective: hash('objective'), features: ['api', 'opdebug'], excludedFeatures: [], familyId,
    familyGeneration: 0, parentId: null, mode: 'isolated', generation: 1, positives: 3,
    negativeControls: 2, rejections: 1, firstSession: hash('first-session'),
    firstQuery: hash('first-query'), reason: 'competing_method_failure', createdAt: 1, updatedAt: 2,
    samples: [{ turnKey: hash('parent-sample'), session: hash('parent-session'),
      query: hash('parent-query'), result: 'discovery_hit', reason: 'unique_native_method_match', at: 1 }] }
  const child = { ...parent, id: hash('adaptive-child'), features: ['api', 'excel', 'chart', 'opdebug'],
    excludedFeatures: ['path', 'user'], familyGeneration: 1, parentId,
    samples: [sample(0, 'discovery_hit', 'counterexample_child', false, false),
      sample(1, 'holdout_hit', 'independent_same_objective', true, true),
      sample(2, 'holdout_hit', 'independent_same_objective', true, true),
      sample(3, 'negative_control', 'independent_unmatched_objective', false, false),
      sample(4, 'negative_control', 'independent_unmatched_objective', false, false),
      sample(5, 'negative', 'competing_method_failure', false, true),
      sample(6, 'negative', 'competing_method_failure', false, true),
      sample(7, 'negative', 'competing_method_failure', false, true)] }
  const doc = createDoc()
  const taskPolicy = synthesizeAdaptiveTaskPolicy({ scope: hash('task-scope'),
    qualification: hash('task-qualification'), entry: { id: entry('5'), version: 1,
      lesson: { problemId: hash('task-objective') } }, taskFeatures: ['json', 'test'],
    turnKey: hash('task-turn'), session: hash('task-session'), queryKey: hash('task-query'), now: 3 })
  assert.deepEqual(taskPolicy.features, ['json', 'test'])
  doc.recallStrategy.adaptive.policies.push(parent, child, taskPolicy)
  assert.ok(Buffer.byteLength(JSON.stringify(child), 'utf8') <= 16_384)
  assert.ok(Buffer.byteLength(JSON.stringify(doc.recallStrategy.adaptive), 'utf8') <= 512_000)
  assert.doesNotThrow(() => validateDoc(doc), 'all eight complete maximum-size offer records are valid')
  assert.equal(replayAdaptivePolicy(child).reason, 'offer_or_objective_regression',
    'the complete producer-shaped records replay with the intended isolated counterexample')

  const root = mkdtempSync(join(tmpdir(), 'mse-adaptive-max-memory-'))
  try {
    const store = new MemoryStore({ stateRoot: root })
    assert.equal(store.transaction(state => {
      state.recallStrategy.adaptive.policies.push(parent, child, taskPolicy)
      state.recallStrategy.adaptive.generation = 2
      return { ok: true }
    }).ok, true)
    const loaded = new MemoryStore({ stateRoot: root }).read()
    assert.equal(loaded.recallStrategy.adaptive.policies.find(row => row.id === child.id)?.mode, 'isolated')
    assert.equal(loaded.recallStrategy.adaptive.policies.find(row => row.id === child.id)?.samples.length, 8)
    assert.deepEqual(loaded.recallStrategy.adaptive.policies.find(row => row.id === taskPolicy.id)?.features,
      ['json', 'test'], 'the persisted validator accepts the same operation vocabulary as discovery')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
