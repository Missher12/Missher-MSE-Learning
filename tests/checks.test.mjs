import test from 'node:test'
import assert from 'node:assert/strict'
import { applyMethod, checkArtifact, getMethod, listMethods, registeredTrials } from '../src/checks.mjs'
import { assessEvaluation } from '../src/evaluation.mjs'

const rows = values => values.map((value, index) => ({ id: `r${index}`, value }))
const freezeRows = values => Object.freeze(rows(values).map(Object.freeze))

test('registration only exposes copies of the bounded allowlist; arbitrary code cannot become a method', () => {
  const methods = listMethods()
  assert.equal(methods.length, 3)
  methods[0].instruction = 'mutated'
  assert.notEqual(listMethods()[0].instruction, 'mutated')
  assert.throws(() => getMethod('__proto__'), /unknown_method/)
  assert.throws(() => applyMethod({ methodId: 'eval(user_script)' }), /unknown_method/)
  for (const method of listMethods()) {
    assert.equal(method.version, 1)
    assert.ok(method.checkId && method.applicability && method.exclusions)
  }
})

test('null projection preserves only source-null fields and leaves unrelated values/order untouched', () => {
  const source = freezeRows([null, false, 0, '', 'null'])
  const artifact = freezeRows(['unknown', true, 7, null, null])
  const input = { methodId: 'preserve-null-v1', source, artifact }
  const report = checkArtifact(input)
  assert.equal(report.status, 'fail')
  assert.equal(report.checked, 1)
  assert.equal(report.violations, 1)
  assert.equal(JSON.stringify(report).includes('unknown'), false)
  const repaired = applyMethod(input)
  assert.deepEqual(repaired.artifact, rows([null, true, 7, null, null]))
  assert.notEqual(repaired.artifact[1], artifact[1])
  assert.equal(checkArtifact({ ...input, artifact: repaired.artifact }).status, 'pass')
  assert.deepEqual(artifact, rows(['unknown', true, 7, null, null]))
  assert.equal(checkArtifact({ methodId: 'preserve-null-v1', source: rows([false, '', 0]), artifact: rows([null, null, null]) }).status, 'not_applicable')
})

test('dates come from valid source calendar dates; malformed generated dates can be repaired', () => {
  const source = freezeRows(['2000-02-29', '2024-02-29', '0099-01-01', null])
  const artifact = Object.freeze([...freezeRows(['1900-02-29', '2024-02-30', '2024-13-01', '0000-01-01'])].reverse())
  const input = { methodId: 'copy-source-date-v1', source, artifact }
  assert.equal(checkArtifact(input).violations, 4)
  const repaired = applyMethod(input)
  assert.deepEqual(repaired.artifact, [...source].reverse())
  assert.equal(checkArtifact({ ...input, artifact: repaired.artifact }).status, 'pass')
  for (const invalid of ['1900-02-29', '2023-02-29', '2024-02-30', '0000-01-01', '2024-1-01', '2024-01-01T00:00:00Z', true, 20240930]) {
    const result = applyMethod({ methodId: 'copy-source-date-v1', source: rows([invalid]), artifact: rows(['2024-01-01']) })
    assert.deepEqual(result, { status: 'not_applicable', artifact: null })
  }
})

test('all checkers refuse invalid schemas, missing or duplicate identities, empty and oversized inputs', () => {
  for (const { methodId } of listMethods()) {
    for (const [source, artifact] of [
      [[], []], [rows([null]), rows([null, null])], [rows([null]), [{ id: 'different', value: null }]],
      [[{ id: 'r0', value: null }, { id: 'r0', value: null }], rows([null, null])],
      [[{ id: 'r0', value: null, extra: 'do not discard' }], rows([null])],
      [rows([NaN]), rows([null])], [rows([Infinity]), rows([null])],
      [rows(['x'.repeat(257)]), rows([null])], [Array.from({ length: 1001 }, (_, i) => ({ id: String(i), value: null })), []],
      [[{ id: 'r\n0', value: null }], rows([null])], [rows(['\ud800']), rows([null])],
    ]) {
      assert.equal(checkArtifact({ methodId, source, artifact }).status, 'not_applicable')
      assert.equal(applyMethod({ methodId, source, artifact }).artifact, null)
    }
  }
})

test('numeric ordering preserves exact large integer and decimal strings instead of rounding them', () => {
  const source = freezeRows(['9007199254740993', '9007199254740992', '0.10000000000000002', '0.1', '-1e-200', '0'])
  const before = JSON.stringify(source)
  const input = { methodId: 'numeric-sort-v1', source, artifact: source }
  const repaired = applyMethod(input)
  assert.equal(repaired.status, 'applied')
  assert.deepEqual(repaired.artifact.map(x => x.id), ['r4', 'r5', 'r3', 'r2', 'r1', 'r0'])
  assert.equal(checkArtifact({ ...input, artifact: repaired.artifact }).status, 'pass')
  assert.equal(JSON.stringify(source), before)
})

test('numeric ties use source order and preserve both value type and signed zero', () => {
  const source = freezeRows(['1.00', 1, '1e0', -0, '0', 0])
  const artifact = [...source].reverse().map(row => ({ ...row }))
  const input = { methodId: 'numeric-sort-v1', source, artifact }
  const repaired = applyMethod(input)
  assert.deepEqual(repaired.artifact.map(x => x.id), ['r3', 'r4', 'r5', 'r0', 'r1', 'r2'])
  assert.ok(Object.is(repaired.artifact[0].value, -0))
  assert.equal(typeof repaired.artifact[1].value, 'string')
  assert.equal(checkArtifact({ ...input, artifact: repaired.artifact }).status, 'pass')
  const changedValue = rows(['1.00', 1, '1e0', 0, '0', 0])
  assert.equal(checkArtifact({ ...input, artifact: changedValue }).reason, 'source_value_changed')
})

test('numeric parser excludes lossy or ambiguous inputs and does not repair changed contents', () => {
  for (const invalid of [null, false, '', ' ', '01', '+1', 'NaN', 'Infinity', '0x10', '1,000', '1_000', '1.', '.1', '1e9999',
    Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    assert.equal(applyMethod({ methodId: 'numeric-sort-v1', source: rows([invalid, 0]), artifact: rows([invalid, 0]) }).status, 'not_applicable')
  }
  assert.equal(checkArtifact({ methodId: 'numeric-sort-v1', source: rows(['2', '1']), artifact: rows([2, 1]) }).status, 'not_applicable')
  const result = applyMethod({ methodId: 'numeric-sort-v1', source: freezeRows([1e-7, -1e-7, 0]), artifact: freezeRows([1e-7, -1e-7, 0]) })
  assert.deepEqual(result.artifact.map(x => x.value), [-1e-7, 0, 1e-7])
})

test('registered regressions include errors, previously-correct and unrelated cases with fixed holdout', () => {
  for (const { methodId } of listMethods()) {
    const trials = registeredTrials(methodId)
    assert.equal(trials.length, 24)
    assert.equal(trials.filter(x => !x.baseline.passed && x.candidate.passed).length, 12)
    assert.equal(trials.filter(x => x.family === 'already_correct').length, 6)
    assert.equal(trials.filter(x => x.family === 'excluded_inputs').length, 6)
    assert.ok(trials.every(x => x.guardPassed))
    assert.equal(assessEvaluation({ trials }).decision, 'accepted')
    assert.equal(JSON.stringify(trials).includes('artifact'), false)
    trials[0].candidate.passed = false
    assert.equal(registeredTrials(methodId)[0].candidate.passed, true)
  }
})
