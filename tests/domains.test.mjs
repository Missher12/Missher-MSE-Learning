/**
 * The domain pack is the pack the *Host* fixed, so these tests are about that property holding:
 * the registered text is frozen and handed out as copies, the case list is inside every bound the
 * shared validators enforce, the out-of-domain rows are refused rather than answered, and the
 * trial rows a pack produces are evidence the core can actually reject or promote.
 *
 * They deliberately read the pack through its public surface (`packCases`, `listDomainPacks`, …),
 * so a mutation of the registry is visible here instead of hidden behind a cached copy.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { DOMAIN_PACKS, getDomainPack, listDomainPacks, packCases, packCriteriaHash, packScenarioHash,
  packSuiteId, packTrials } from '../src/domains.mjs'
import { CHECKER_KINDS, MAX_CASE_PROMPT_CHARS, MAX_EXPECTED_CHARS, MAX_EXPECTED_LINES, MAX_FORBIDDEN,
  MAX_FORBIDDEN_CHARS, caseManifest, normalizeCases, scoreOutput, strictJson, taskIndependence } from '../src/cases.mjs'
// The trial shape `packTrials` returns is defined by the core, so the core is what has to accept it.
import { assessEvaluation } from '../src/evaluation.mjs'

const PACK_ID = 'mse-lifecycle-v1'

/** The answer a perfect candidate would give, derived from the case's own oracle. */
const correctAnswer = testCase => testCase.checker.kind === 'text-exact-v1' ? testCase.checker.expected
  : testCase.checker.kind === 'json-deep-equal-v1' ? JSON.stringify(testCase.checker.expected)
    : testCase.checker.expected.join('\n')

/** A wrong answer that is still a well-formed output, so the failure is the answer, not the guard. */
const wrongAnswer = testCase => testCase.checker.kind === 'text-exact-v1' ? 'WRONG'
  : testCase.checker.kind === 'json-deep-equal-v1' ? '{}'
    : [...testCase.checker.expected].reverse().join('\n')

const answersFor = pick => Object.fromEntries(packCases(PACK_ID)
  .map(testCase => [testCase.caseId, { baseline: wrongAnswer(testCase), candidate: pick(testCase) }]))

test('the pack is one frozen, version-bound registration and the index reports its true shape', () => {
  const listed = listDomainPacks()
  assert.equal(listed.length, 1, 'exactly one registered pack for now')
  const [entry] = listed
  assert.equal(entry.packId, PACK_ID)
  assert.equal(entry.version, 1)
  assert.equal(typeof entry.title, 'string')
  assert.ok(entry.title.length > 0)
  // The scope line is the pack's own honesty boundary: one line, and it names a validation domain.
  assert.equal(typeof entry.scope, 'string')
  assert.ok(entry.scope.length > 0 && !entry.scope.includes('\n'))
  assert.match(entry.scope, /验证域/u)

  const pack = getDomainPack(PACK_ID)
  assert.equal(pack, DOMAIN_PACKS[PACK_ID])
  assert.equal(getDomainPack('no-such-pack'), undefined, 'an unregistered id is never invented into a pack')
  assert.equal(Object.isFrozen(DOMAIN_PACKS), true)
  assert.equal(Object.isFrozen(pack), true)
  assert.equal(Object.isFrozen(pack.cases), true)
  assert.equal(Object.isFrozen(pack.cases[0].checker), true)
  assert.equal(Object.isFrozen(pack.cases[0].checker.expected), true)
  assert.equal(Object.isFrozen(pack.cases[0].forbidden), true)
  assert.equal(Object.isFrozen(pack.cases[0].criteria), true)
  // The registered oracle cannot be edited in place, so nothing can re-author it after the plan was
  // frozen. ESM is strict mode, so these assignments throw instead of silently doing nothing.
  assert.throws(() => { pack.version = 2 }, TypeError)
  assert.throws(() => { pack.scope = 'covers everything' }, TypeError)
  assert.throws(() => { pack.cases[0].checker.expected = 'HACKED' }, TypeError)
  assert.throws(() => { pack.cases[0].criteria.push({ id: 'x', kind: 'judgement', statement: 'x' }) }, TypeError)

  // Handed-out cases are copies: editing one changes the caller's copy and nothing else.
  const copy = packCases(PACK_ID)
  assert.deepEqual(packCases(PACK_ID), copy, 'every call returns the same content')
  copy[0].caseId = 'mutated'
  copy[0].prompt = 'mutated'
  copy[0].checker.expected = 'mutated'
  copy[0].forbidden.push('mutated')
  copy[0].criteria[0].statement = 'mutated'
  copy[0].criteria.push({ id: 'injected', kind: 'structured', statement: 'injected' })
  copy.push({ caseId: 'injected' })
  const fresh = packCases(PACK_ID)
  assert.equal(fresh.length, entry.cases)
  assert.notEqual(fresh[0].caseId, 'mutated')
  assert.notEqual(fresh[0].prompt, 'mutated')
  assert.equal(fresh[0].checker.expected, 'DISCARD')
  assert.deepEqual(fresh[0].forbidden, ['APPLY'])
  assert.equal(fresh[0].criteria.length, 2)
  assert.notEqual(fresh[0].criteria[0].statement, 'mutated')

  // The index counts come from the pack, not from a hand-maintained table.
  assert.equal(entry.cases, fresh.length)
  assert.equal(entry.families, new Set(fresh.map(testCase => testCase.family)).size)
  assert.equal(entry.holdout, fresh.filter(testCase => testCase.split === 'holdout').length)
  assert.ok(entry.cases >= 12 && entry.cases <= 24)
  assert.ok(entry.families >= 2)
  assert.ok(entry.holdout >= 4)
})

test('packCases stays inside every bound and is byte-equal to what the shared validator normalizes', () => {
  const cases = packCases(PACK_ID)
  assert.ok(cases.length >= 12 && cases.length <= 24)
  assert.ok(cases.filter(testCase => testCase.split === 'holdout').length >= 4)
  assert.ok(new Set(cases.map(testCase => testCase.family)).size >= 2)
  assert.ok(new Set(cases.filter(testCase => testCase.split === 'holdout').map(testCase => testCase.family)).size >= 2,
    'holdout rows span families, so a holdout cannot be re-labelled development rows of one kind')
  assert.equal(new Set(cases.map(testCase => testCase.caseId)).size, cases.length)

  const kinds = new Set()
  for (const testCase of cases) {
    kinds.add(testCase.checker.kind)
    assert.ok(CHECKER_KINDS.includes(testCase.checker.kind), testCase.caseId)
    assert.deepEqual(Object.keys(testCase),
      ['caseId', 'family', 'split', 'prompt', 'checker', 'forbidden', 'criteria'], testCase.caseId)
    // Prompts are measured RAW, exactly as the runner would receive them.
    assert.ok(testCase.prompt.length > 0 && testCase.prompt.length <= MAX_CASE_PROMPT_CHARS, testCase.caseId)
    if (testCase.checker.kind === 'text-exact-v1') {
      assert.equal(typeof testCase.checker.expected, 'string', testCase.caseId)
      assert.ok(testCase.checker.expected.length <= MAX_EXPECTED_CHARS, testCase.caseId)
    } else if (testCase.checker.kind === 'json-deep-equal-v1') {
      // The authored literal is JSON text, but the emitted expectation is the parsed *value*: that
      // is what `scoreOutput` deep-compares an answer against, and a JSON string there could never
      // score for any answer. Re-reading it with the scorer's own reader proves it round-trips.
      assert.notEqual(typeof testCase.checker.expected, 'string', testCase.caseId)
      const reread = strictJson(JSON.stringify(testCase.checker.expected))
      assert.equal(reread.ok, true, testCase.caseId)
      assert.deepEqual(reread.value, testCase.checker.expected, testCase.caseId)
    } else {
      const lines = testCase.checker.expected
      assert.ok(Array.isArray(lines) && lines.length > 0 && lines.length <= MAX_EXPECTED_LINES, testCase.caseId)
      assert.equal(new Set(lines).size, lines.length, `${testCase.caseId}: lines must be distinct`)
      for (const line of lines) {
        assert.ok(line.length > 0 && line.length <= MAX_EXPECTED_CHARS, testCase.caseId)
        assert.ok(!line.includes('\n'), testCase.caseId)
      }
    }
    assert.ok(Array.isArray(testCase.forbidden) && testCase.forbidden.length <= MAX_FORBIDDEN, testCase.caseId)
    for (const needle of testCase.forbidden) {
      assert.ok(needle.length > 0 && needle.length <= MAX_FORBIDDEN_CHARS, testCase.caseId)
    }
    assert.ok(Array.isArray(testCase.criteria) && testCase.criteria.length >= 1 && testCase.criteria.length <= 3,
      testCase.caseId)
    assert.equal(new Set(testCase.criteria.map(criterion => criterion.id)).size, testCase.criteria.length,
      `${testCase.caseId}: criterion ids are distinct within a case`)
    for (const criterion of testCase.criteria) {
      assert.deepEqual(Object.keys(criterion), ['id', 'kind', 'statement'], testCase.caseId)
      assert.ok(['structured', 'judgement'].includes(criterion.kind), testCase.caseId)
      assert.ok(criterion.statement.length > 0 && criterion.statement.length <= MAX_EXPECTED_CHARS, testCase.caseId)
    }
  }
  assert.equal(kinds.size, CHECKER_KINDS.length, 'all three registered checkers are exercised')

  // `criteria` is the one field the strict case validator does not know. Stripping it must leave a
  // list that validator accepts verbatim — and the normalization it returns must be the pack's own
  // cases unchanged, which is what "shaped exactly like normalizeCases output" has to mean.
  const stripped = cases.map(({ criteria, ...rest }) => rest)
  const normalized = normalizeCases(stripped)
  assert.equal(normalized.ok, true, `normalizeCases refused the pack: ${normalized.code}`)
  assert.deepEqual(normalized.cases, stripped)
})

test('the pack asks distinct tasks and the wire manifest carries unique case ids', () => {
  const cases = packCases(PACK_ID)
  assert.deepEqual(taskIndependence(cases), { ok: true, mode: 'prompted', tasks: cases.length })
  const manifest = caseManifest(cases)
  assert.equal(manifest.length, cases.length)
  assert.equal(new Set(manifest.map(row => row.caseId)).size, cases.length)
  for (const row of manifest) assert.deepEqual(Object.keys(row), ['caseId', 'family', 'split'])
})

test('out-of-domain cases score only against the pack-fixed refusal text', () => {
  const excluded = packCases(PACK_ID).filter(testCase => testCase.family === 'excluded_inputs')
  assert.ok(excluded.length >= 2, 'at least two non_applicable rows')
  for (const testCase of excluded) assert.equal(testCase.checker.kind, 'text-exact-v1', testCase.caseId)
  const refusals = new Set(excluded.map(testCase => testCase.checker.expected))
  assert.equal(refusals.size, 1, 'the pack fixes ONE refusal text for every out-of-domain request')
  const [refusal] = refusals
  assert.ok(refusal.length > 0 && refusal.length <= MAX_EXPECTED_CHARS)

  for (const testCase of excluded) {
    // The fixed refusal answer carries no excluded substring: nothing about answering correctly is
    // also forbidden, which is what would make an out-of-domain row unanswerable.
    assert.deepEqual(testCase.forbidden, [], testCase.caseId)
    assert.equal(scoreOutput(testCase, refusal).passed, true, testCase.caseId)
    assert.equal(scoreOutput(testCase, `  ${refusal}  `).passed, true,
      'whitespace is presentation, not content')
    for (const wrong of ['', 'APPLY', 'DISCARD', `${refusal} 补充说明`,
      refusal.replace(/拒绝作答/u, '可以作答'), 'REFUSAL']) {
      assert.equal(scoreOutput(testCase, wrong).passed, false,
        `${testCase.caseId}: only the pack's own text may score (${JSON.stringify(wrong)})`)
    }
    assert.equal(scoreOutput(testCase, refusal, { truncated: true }).passed, false,
      'a cut-off answer never scores, even when its text matches')
  }
})

test('packTrials ranks a correct candidate above a wrong one and refuses to promote without answers', () => {
  const cases = packCases(PACK_ID)
  for (const testCase of cases) {
    assert.notEqual(correctAnswer(testCase), wrongAnswer(testCase), testCase.caseId)
    assert.equal(scoreOutput(testCase, correctAnswer(testCase)).passed, true, testCase.caseId)
    assert.equal(scoreOutput(testCase, wrongAnswer(testCase)).passed, false, testCase.caseId)
  }

  // Real usage for both arms of every case: an unknown cost is not a measured zero, and the core
  // now refuses to promote a pair whose spend nobody reported.
  const everyCase = Object.fromEntries(cases.map(row => [row.caseId, { baseline: 7, candidate: 5 }]))
  const good = packTrials(PACK_ID, { answers: answersFor(correctAnswer), usage: everyCase })
  const bad = packTrials(PACK_ID, { answers: answersFor(wrongAnswer), usage: everyCase })
  assert.equal(good.length, cases.length)
  assert.equal(bad.length, cases.length)
  for (const row of good) {
    // Exactly the six keys `registeredTrials` emits: the core refuses anything else.
    assert.deepEqual(Object.keys(row).sort(),
      ['baseline', 'candidate', 'caseId', 'family', 'guardPassed', 'split'])
    assert.equal(row.baseline.passed, false, row.caseId)
    assert.equal(row.candidate.passed, true, row.caseId)
    // The supplied usage travels verbatim; an unmeasured side would be `null`, never a fake zero.
    assert.equal(row.baseline.tokens, 7)
    assert.equal(row.candidate.tokens, 5)
    assert.equal(row.guardPassed, true, row.caseId)
  }
  assert.equal(bad.filter(row => row.candidate.passed).length, 0)
  assert.ok(good.filter(row => row.candidate.passed).length > bad.filter(row => row.candidate.passed).length)

  // A plain string is the candidate arm alone; the arm nobody ran is not silently excused.
  const single = packTrials(PACK_ID, { answers: { [cases[0].caseId]: correctAnswer(cases[0]) }, usage: everyCase })
  assert.equal(single.length, cases.length)
  assert.equal(single[0].candidate.passed, true)
  assert.equal(single[0].baseline.passed, false)
  assert.equal(single[0].guardPassed, false, 'a missing baseline arm cannot make a fair comparison')

  // `truncated` is the caller stating a side was cut off: the pair becomes unusable evidence.
  const cut = packTrials(PACK_ID, { answers: {
    [cases[0].caseId]: { candidate: correctAnswer(cases[0]), truncated: true } }, usage: everyCase })
  assert.equal(cut[0].candidate.passed, false)
  assert.equal(cut[0].baseline.passed, false)
  assert.equal(cut[0].guardPassed, false)

  // No answers at all: every row is failed AND guard-failed, so the core refuses to promote.
  for (const args of [undefined, {}, { answers: undefined }, { answers: null }, { answers: {} }, { answers: 'nope' }]) {
    const rows = packTrials(PACK_ID, args)
    assert.equal(rows.length, cases.length)
    assert.ok(rows.every(row => row.baseline.passed === false && row.candidate.passed === false
      && row.guardPassed === false))
    assert.equal(assessEvaluation({ trials: rows }).decision, 'rejected', JSON.stringify(args))
  }
  // And with real answers the rows reach the core's own conclusion, not just its validator.
  assert.equal(assessEvaluation({ trials: good }).decision, 'accepted')
  assert.equal(assessEvaluation({ trials: bad }).decision, 'rejected')
  assert.deepEqual(packTrials('no-such-pack', { answers: {} }), [])
  assert.deepEqual(packCases('no-such-pack'), [])
})

test('criteria and scenario hashes are stable, hex, and bound to the registered text', () => {
  const cases = packCases(PACK_ID)
  const criteria = packCriteriaHash(PACK_ID)
  assert.match(criteria, /^[0-9a-f]{64}$/u)
  assert.equal(packCriteriaHash(PACK_ID), criteria, 'stable across calls')
  assert.equal(packCriteriaHash('no-such-pack'), null)

  const scenarios = new Map(cases.map(testCase => [testCase.caseId, packScenarioHash(PACK_ID, testCase.caseId)]))
  assert.equal(scenarios.size, cases.length)
  assert.equal(new Set(scenarios.values()).size, cases.length, 'distinct cases hash apart')
  for (const [caseId, hash] of scenarios) {
    assert.match(hash, /^[0-9a-f]{64}$/u, caseId)
    assert.equal(packScenarioHash(PACK_ID, caseId), hash, caseId)
    assert.notEqual(hash, criteria, caseId)
  }
  assert.equal(packScenarioHash(PACK_ID, 'no-such-case'), null)
  // The hash is over the REGISTERED text, so editing a handed-out copy cannot move it.
  const copy = packCases(PACK_ID)
  copy[0].prompt = 'mutated'
  copy[0].checker.expected = 'mutated'
  assert.equal(packScenarioHash(PACK_ID, copy[0].caseId), scenarios.get(copy[0].caseId))
  // The four exclusion rows share a family, a checker kind and the fixed expected text, so what
  // separates their hashes is exactly the scenario text around it (prompt and case id).
  const excluded = cases.filter(testCase => testCase.family === 'excluded_inputs')
  assert.equal(new Set(excluded.map(testCase => testCase.checker.expected)).size, 1)
  assert.equal(new Set(excluded.map(testCase => packScenarioHash(PACK_ID, testCase.caseId))).size, excluded.length)
  assert.equal(criteria, packCriteriaHash(PACK_ID))
})

test('the suite id is exactly domain-pack:mse-lifecycle-v1:v1', () => {
  assert.equal(packSuiteId(getDomainPack(PACK_ID)), 'domain-pack:mse-lifecycle-v1:v1')
  assert.equal(packSuiteId(listDomainPacks()[0]), 'domain-pack:mse-lifecycle-v1:v1')
  assert.equal(packSuiteId(undefined), null)
  assert.equal(packSuiteId({ packId: PACK_ID }), null, 'no version, no bound suite id')
})
