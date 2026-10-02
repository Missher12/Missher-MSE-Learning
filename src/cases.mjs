/**
 * Bounded, deterministic validation cases for generic candidate methods.
 *
 * A registered method (`numeric-sort-v1`, …) carries its own pure checker, so it can be
 * re-evaluated without a model at all. A *generic* candidate has no such checker: its text
 * was produced by reflection and nothing about it is machine-checkable by construction.
 * The only honest way to test one is to run the same bounded task twice — once without the
 * candidate, once with it — and let a **deterministic judge** the caller cannot fake score
 * both answers.
 *
 * This module owns exactly three things and nothing else:
 *   1. the whitelist of versioned checkers,
 *   2. strict, total validation of a case list, and
 *   3. a pure scorer over one raw model output.
 *
 * It never calls a model, never reads a store, and never accepts a caller-supplied
 * `passed`/`score`/`tokens`. A model that says "I succeeded" scores exactly as its
 * observable output does. A user-supplied oracle means "pick a fixed checker and give the
 * expected value" — never an uploaded script, a shell command, a URL or another model.
 */

/** Versioned checkers a caller may select. Anything else is refused, never approximated. */
export const CHECKER_KINDS = Object.freeze(['text-exact-v1', 'json-deep-equal-v1', 'lines-present-v1'])
export const SPLITS = Object.freeze(['development', 'holdout'])
export const MIN_CASES = 12
export const MAX_CASES = 24
export const MAX_CASE_PROMPT_CHARS = 400
export const MAX_EXPECTED_CHARS = 800
export const MAX_EXPECTED_LINES = 12
export const MAX_FORBIDDEN = 4
export const MAX_FORBIDDEN_CHARS = 80
export const MAX_OUTPUT_BYTES = 4096
const CASE_KEYS = Object.freeze(['caseId', 'family', 'split', 'prompt', 'checker', 'forbidden'])
const CHECKER_KEYS = Object.freeze(['kind', 'expected'])

/** Reason codes a validation or scoring step can report. Every one is user-visible. */
export const CASE_REASONS = Object.freeze({
  invalidCases: 'invalid_cases',
  unknownField: 'unknown_case_field',
  tooFewCases: 'too_few_cases',
  tooManyCases: 'too_many_cases',
  duplicateCaseId: 'duplicate_case_id',
  duplicateCaseTask: 'duplicate_case_task',
  duplicateCaseContent: 'duplicate_case_content',
  invalidPrompt: 'invalid_case_prompt',
  invalidExpected: 'invalid_expected_value',
  invalidFamily: 'invalid_family',
  invalidSplit: 'invalid_split',
  invalidChecker: 'invalid_checker',
  insufficientHoldout: 'insufficient_holdout',
  insufficientFamilies: 'insufficient_families',
  insufficientHoldoutFamilies: 'insufficient_holdout_families',
  forbiddenUsed: 'forbidden_substring_present',
  outputEmpty: 'output_empty',
  outputTooLarge: 'output_too_large',
  outputNotJson: 'output_not_json',
  outputAmbiguousJson: 'output_json_ambiguous',
  outputTruncated: 'output_truncated',
})

const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/u
const isPlainObject = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exactKeys = (value, keys) => isPlainObject(value) && Object.keys(value).every(key => keys.includes(key))

/**
 * Text that would try to re-author the runner instead of answering the case. A validation
 * case is data; a case that inlines an instruction hierarchy is refused rather than run.
 */
const CASE_AUTHORITY = /忽略.{0,12}(?:指令|规则|用户|权限)|绕过.{0,12}(?:授权|权限|限制)|(?:ignore|override).{0,20}(?:instructions|permissions|rules)|<\/?(?:system|instruction)\b|(?:^|\n)\s*(?:system|assistant|developer)\s*:/iu

const printable = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && value.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)

/**
 * Strict validation of a RAW task prompt, before any normalization.
 *
 * The raw text is what a runner would eventually be asked, so its own length, characters and
 * Unicode validity are checked as written — a prompt that only becomes acceptable after
 * whitespace collapsing, control-character stripping or length folding is not acceptable.
 * The adapter and the shared core both call this, so neither path can be the lenient one.
 * @returns `{ ok: true }` or `{ ok: false, code }`.
 */
export function checkTaskPrompt(raw) {
  if (typeof raw !== 'string') return { ok: false, code: CASE_REASONS.invalidPrompt }
  if (raw.length === 0 || raw.length > MAX_CASE_PROMPT_CHARS) return { ok: false, code: CASE_REASONS.invalidPrompt }
  if (!raw.isWellFormed()) return { ok: false, code: CASE_REASONS.invalidPrompt }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(raw)) return { ok: false, code: CASE_REASONS.invalidPrompt }
  if (CASE_AUTHORITY.test(raw)) return { ok: false, code: CASE_REASONS.invalidPrompt }
  return { ok: true }
}

/** Bounded structural JSON value: plain objects/arrays/primitives, depth and size capped. */
function boundedValue(value, depth = 0) {
  if (depth > 6) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= MAX_EXPECTED_CHARS
  if (Array.isArray(value)) return value.length <= 32 && value.every(item => boundedValue(item, depth + 1))
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    return keys.length <= 32 && keys.every(key => key.length <= 64 && boundedValue(value[key], depth + 1))
  }
  return false
}

const countNodes = (value, depth = 0) => depth > 6 ? 0
  : value === null || typeof value !== 'object' ? 1
    : (Array.isArray(value) ? value : Object.keys(value).map(key => value[key]))
      .reduce((sum, item) => sum + countNodes(item, depth + 1), 1)

/** Collapse whitespace runs so an answer is compared on content, not on indentation. */
export const normalizeText = value => typeof value === 'string'
  ? value.replace(/\r\n?/gu, '\n').split('\n').map(line => line.trim().replace(/[ \t]+/gu, ' ')).join('\n').trim()
  : ''

/**
 * A model may wrap JSON in a fenced block. Unwrapping is deterministic and bounded; it never
 * searches for "something that parses", because that would let a wrong answer score right.
 */
export function unwrapJson(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/u.exec(value)
  return fence === null ? value : fence[1].trim()
}

/** Structural equality with no coercion: `1` and `"1"` are different answers. */
export function deepEqual(left, right) {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length
      && keys.every(key => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
  }
  return false
}

/**
 * Strict JSON reader for a scored answer.
 *
 * `JSON.parse` is not enough here, and the difference is the whole point of scoring: it
 * silently keeps the last of two duplicate keys, so `{"amount": 1, "amount": 2}` would score
 * as `2` instead of being refused as an ambiguous answer. It also accepts `1e999` as
 * `Infinity` and any integer beyond `Number.MAX_SAFE_INTEGER` as a rounded double. This reader
 * rejects all three, so an answer can only score when it is unambiguous.
 *
 * @returns `{ ok: true, value }` or `{ ok: false, code }`.
 */
export function strictJson(text) {
  const source = typeof text === 'string' ? text : ''
  let index = 0
  const fail = code => ({ ok: false, code })
  const skip = () => { while (index < source.length && /[ \t\n\r]/u.test(source[index])) index += 1 }
  function parseNumber() {
    const start = index
    if (source[index] === '-') index += 1
    if (source[index] === '0') index += 1
    else if (/[1-9]/u.test(source[index] ?? '')) { while (/[0-9]/u.test(source[index] ?? '')) index += 1 } else return fail(CASE_REASONS.outputNotJson)
    if (source[index] === '.') {
      index += 1
      if (!/[0-9]/u.test(source[index] ?? '')) return fail(CASE_REASONS.outputNotJson)
      while (/[0-9]/u.test(source[index] ?? '')) index += 1
    }
    if (source[index] === 'e' || source[index] === 'E') {
      index += 1
      if (source[index] === '+' || source[index] === '-') index += 1
      if (!/[0-9]/u.test(source[index] ?? '')) return fail(CASE_REASONS.outputNotJson)
      while (/[0-9]/u.test(source[index] ?? '')) index += 1
    }
    const literal = source.slice(start, index)
    const value = Number(literal)
    // `1.0` and `1e0` are the same unambiguous JSON number as `1`, so they score as equal.
    // What is refused is a number whose value the reader cannot stand behind: an overflow to
    // infinity, or an integer past the exactly-representable range that would be silently
    // rounded. Duplicate keys are still rejected outright, because there the answer really is
    // ambiguous and `JSON.parse` would have quietly kept the last one.
    if (!Number.isFinite(value)) return fail(CASE_REASONS.outputAmbiguousJson)
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) return fail(CASE_REASONS.outputAmbiguousJson)
    return { ok: true, value }
  }
  function parseString() {
    const start = index
    index += 1
    while (index < source.length && source[index] !== '"') {
      if (source[index] === '\\') index += 2
      else index += 1
    }
    if (source[index] !== '"') return fail(CASE_REASONS.outputNotJson)
    index += 1
    // Delegate escapes to the platform reader; the slice is already known to be balanced.
    try {
      const value = JSON.parse(source.slice(start, index))
      return typeof value === 'string' ? { ok: true, value } : fail(CASE_REASONS.outputNotJson)
    } catch { return fail(CASE_REASONS.outputNotJson) }
  }
  function parseValue(depth) {
    if (depth > 8) return fail(CASE_REASONS.outputTooLarge)
    skip()
    const ch = source[index]
    if (ch === '{') {
      index += 1
      const result = {}, seen = new Set()
      skip()
      if (source[index] === '}') { index += 1; return { ok: true, value: result } }
      for (;;) {
        skip()
        if (source[index] !== '"') return fail(CASE_REASONS.outputNotJson)
        const key = parseString()
        if (!key.ok) return key
        if (seen.has(key.value)) return fail(CASE_REASONS.outputAmbiguousJson)
        seen.add(key.value)
        skip()
        if (source[index] !== ':') return fail(CASE_REASONS.outputNotJson)
        index += 1
        const value = parseValue(depth + 1)
        if (!value.ok) return value
        result[key.value] = value.value
        skip()
        if (source[index] === ',') { index += 1; continue }
        if (source[index] === '}') { index += 1; return { ok: true, value: result } }
        return fail(CASE_REASONS.outputNotJson)
      }
    }
    if (ch === '[') {
      index += 1
      const list = []
      skip()
      if (source[index] === ']') { index += 1; return { ok: true, value: list } }
      for (;;) {
        const value = parseValue(depth + 1)
        if (!value.ok) return value
        list.push(value.value)
        skip()
        if (source[index] === ',') { index += 1; continue }
        if (source[index] === ']') { index += 1; return { ok: true, value: list } }
        return fail(CASE_REASONS.outputNotJson)
      }
    }
    if (ch === '"') return parseString()
    if (source.startsWith('true', index)) { index += 4; return { ok: true, value: true } }
    if (source.startsWith('false', index)) { index += 5; return { ok: true, value: false } }
    if (source.startsWith('null', index)) { index += 4; return { ok: true, value: null } }
    if (ch === '-' || /[0-9]/u.test(ch ?? '')) return parseNumber()
    return fail(CASE_REASONS.outputNotJson)
  }
  const parsed = parseValue(0)
  if (!parsed.ok) return parsed
  skip()
  if (index !== source.length) return fail(CASE_REASONS.outputNotJson)
  return parsed
}

/**
 * Score one raw model output against one case. Pure and total: an unusable answer is a
 * failed case with a reason, never an exception and never a silent pass.
 * @returns `{ passed, guardPassed, reason }` — `guardPassed` is about the arm's *fairness*
 *   (a truncated or oversized answer cannot be scored), not about being correct.
 */
export function scoreOutput(testCase, output, { truncated = false } = {}) {
  if (truncated === true) return { passed: false, guardPassed: false, reason: CASE_REASONS.outputTruncated }
  const text = typeof output === 'string' ? output : ''
  if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) {
    return { passed: false, guardPassed: false, reason: CASE_REASONS.outputTooLarge }
  }
  if (text.trim().length === 0) return { passed: false, guardPassed: false, reason: CASE_REASONS.outputEmpty }
  const lowered = text.toLowerCase()
  for (const needle of testCase.forbidden) {
    if (lowered.includes(needle.toLowerCase())) return { passed: false, guardPassed: true, reason: CASE_REASONS.forbiddenUsed }
  }
  if (testCase.checker.kind === 'json-deep-equal-v1') {
    const parsed = strictJson(unwrapJson(text))
    if (!parsed.ok) return { passed: false, guardPassed: true, reason: parsed.code }
    return { passed: deepEqual(parsed.value, testCase.checker.expected), guardPassed: true, reason: 'judged' }
  }
  if (testCase.checker.kind === 'text-exact-v1') {
    return { passed: normalizeText(text) === testCase.checker.expected, guardPassed: true, reason: 'judged' }
  }
  // lines-present-v1: each expected line must exist in order as a whole line of the answer.
  const lines = normalizeText(text).split('\n')
  let cursor = 0
  for (const expected of testCase.checker.expected) {
    const found = lines.findIndex((line, index) => index >= cursor && line === expected)
    if (found === -1) return { passed: false, guardPassed: true, reason: 'judged' }
    cursor = found + 1
  }
  return { passed: true, guardPassed: true, reason: 'judged' }
}

function normalizeOne(raw, index) {
  const fail = code => ({ ok: false, code, index })
  if (!isPlainObject(raw) || !exactKeys(raw, CASE_KEYS)) return fail(CASE_REASONS.unknownField)
  const caseId = raw.caseId, family = raw.family
  if (!LABEL.test(typeof caseId === 'string' ? caseId : '')) return fail(CASE_REASONS.invalidCases)
  if (!LABEL.test(typeof family === 'string' ? family : '')) return fail(CASE_REASONS.invalidFamily)
  if (!SPLITS.includes(raw.split)) return fail(CASE_REASONS.invalidSplit)
  if (!checkTaskPrompt(raw.prompt).ok) return fail(CASE_REASONS.invalidPrompt)
  const forbidden = raw.forbidden === undefined ? [] : raw.forbidden
  if (!Array.isArray(forbidden) || forbidden.length > MAX_FORBIDDEN) return fail(CASE_REASONS.invalidCases)
  if (!forbidden.every(value => printable(value, MAX_FORBIDDEN_CHARS))) return fail(CASE_REASONS.invalidExpected)
  const checker = raw.checker
  if (!exactKeys(checker, CHECKER_KEYS) || !CHECKER_KINDS.includes(checker?.kind)) return fail(CASE_REASONS.invalidChecker)
  let expected = checker.expected
  if (checker.kind === 'json-deep-equal-v1') {
    if (!boundedValue(expected) || countNodes(expected) > 128) return fail(CASE_REASONS.invalidExpected)
  } else if (checker.kind === 'text-exact-v1') {
    if (!printable(expected, MAX_EXPECTED_CHARS)) return fail(CASE_REASONS.invalidExpected)
    expected = normalizeText(expected)
    if (expected.length === 0) return fail(CASE_REASONS.invalidExpected)
  } else {
    if (!Array.isArray(expected) || expected.length === 0 || expected.length > MAX_EXPECTED_LINES) {
      return fail(CASE_REASONS.invalidExpected)
    }
    const lines = expected.map(line => normalizeText(line))
    if (lines.some(line => line.length === 0 || line.length > MAX_EXPECTED_CHARS || line.includes('\n'))) {
      return fail(CASE_REASONS.invalidExpected)
    }
    expected = [...new Set(lines)]
    if (expected.length !== lines.length) return fail(CASE_REASONS.invalidExpected)
  }
  return { ok: true, value: { caseId, family, split: raw.split, prompt: raw.prompt,
    checker: { kind: checker.kind, expected },
    forbidden: [...new Set(forbidden.map(value => value.trim()).filter(value => value.length > 0))] } }
}

/**
 * Validate and normalize a whole case list against the evaluation policy's shape rules.
 * The caller's own policy gate (12 pairs, 4 holdout, 2 families) is checked here too, so a
 * run that could only ever end `inconclusive` is refused *before* any model call or debit.
 */
export function normalizeCases(raw, policy) {
  if (!Array.isArray(raw)) return { ok: false, code: CASE_REASONS.invalidCases, cases: [] }
  if (raw.length < MIN_CASES) return { ok: false, code: CASE_REASONS.tooFewCases, cases: [] }
  if (raw.length > MAX_CASES) return { ok: false, code: CASE_REASONS.tooManyCases, cases: [] }
  const cases = [], seen = new Set(), tasks = new Map(), content = new Map()
  for (const [index, item] of raw.entries()) {
    const row = normalizeOne(item, index)
    if (!row.ok) return { ok: false, code: row.code, index, cases: [] }
    if (seen.has(row.value.caseId)) return { ok: false, code: CASE_REASONS.duplicateCaseId, index, cases: [] }
    seen.add(row.value.caseId)
    // One measurement per task. Identity here is the normalized prompt ALONE: varying the
    // oracle, the forbidden list, the id, the family or the split changes what a case looks
    // like, not what it asks. Counting those variants as independent pairs would inflate the
    // sample and — worse — let a holdout be built out of re-labelled development rows, which
    // is not a held-out set at all. Both failures come from the same missing check.
    const task = caseTaskKey(row.value)
    if (tasks.has(task)) {
      return { ok: false, code: CASE_REASONS.duplicateCaseTask, index, duplicateOf: tasks.get(task), cases: [] }
    }
    tasks.set(task, index)
    // The full-content key still refuses an exact duplicate, and it is what the plan binds to.
    const key = caseContentKey(row.value)
    if (content.has(key)) {
      return { ok: false, code: CASE_REASONS.duplicateCaseContent, index, duplicateOf: content.get(key), cases: [] }
    }
    content.set(key, index)
    cases.push(row.value)
  }
  const families = new Set(cases.map(row => row.family))
  const holdout = cases.filter(row => row.split === 'holdout')
  const holdoutFamilies = new Set(holdout.map(row => row.family))
  const minPairs = policy?.minPairs ?? MIN_CASES
  const minHoldout = policy?.minHoldout ?? 4
  const minFamilies = policy?.minFamilies ?? 2
  const minHoldoutFamilies = policy?.minHoldoutFamilies ?? 2
  // Only the shape rules are pre-checked. "Enough improvement" cannot be known in advance,
  // so a well-formed set may still end `inconclusive`; that is reported, not hidden.
  if (cases.length < minPairs) return { ok: false, code: CASE_REASONS.tooFewCases, cases: [] }
  if (holdout.length < minHoldout) return { ok: false, code: CASE_REASONS.insufficientHoldout, cases: [] }
  if (families.size < minFamilies) return { ok: false, code: CASE_REASONS.insufficientFamilies, cases: [] }
  if (holdoutFamilies.size < minHoldoutFamilies) return { ok: false, code: CASE_REASONS.insufficientHoldoutFamilies, cases: [] }
  return { ok: true, code: null, cases, families: families.size, holdout: holdout.length, holdoutFamilies: holdoutFamilies.size }
}

/**
 * Presentation-only normalization of a task prompt.
 *
 * It removes differences that cannot change what is being asked — compatibility forms (NFKC),
 * zero-width joiners a paste can smuggle in, and runs of whitespace — and nothing else. Case,
 * punctuation and word order are left exactly as written, because for a coding task they can be
 * the difference between `JSON.parse` and `json.parse`, or between a requirement and its
 * negation.
 */
export function normalizeTaskPrompt(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff]/gu, '').replace(/\s+/gu, ' ').trim()
    : ''
}

/**
 * Identity of the *task*: the normalized prompt alone.
 *
 * This is deliberately narrower than {@link caseContentKey}. The same question asked twice is
 * the same measurement no matter what oracle, forbidden list, label or split surrounds it, so
 * a caller cannot manufacture twelve independent cases — or a fake holdout — out of one prompt
 * by varying the parts that are not the task.
 */
export function caseTaskKey(testCase) {
  return normalizeTaskPrompt(testCase.prompt)
}

/**
 * Stable identity of a case's *full content*: the task, its oracle, and its exclusions.
 *
 * This is the identity a plan binds to (`planIdentity`), because a preview and the run it
 * authorises must describe byte-identical work. It is not the identity used to count
 * independent cases — that is {@link caseTaskKey}.
 */
export function caseContentKey(testCase) {
  return JSON.stringify([normalizeTaskPrompt(testCase.prompt), testCase.checker.kind,
    testCase.checker.kind === 'json-deep-equal-v1' ? testCase.checker.expected : normalizeText(
      Array.isArray(testCase.checker.expected) ? testCase.checker.expected.join('\n') : testCase.checker.expected),
    (testCase.forbidden ?? []).map(value => value.toLowerCase()).sort()])
}

/**
 * Task independence over a raw case list, shared by the package validator and the core.
 *
 * A validation run's evidence is only as wide as the number of *distinct tasks* it asked. A
 * caller that repeats one question behind twelve labels, oracles or forbidden lists produces a
 * sample of one dressed as twelve, so the shared core refuses it before any ticket, debit or
 * runner call — not only the DSH adapter.
 *
 * Two protocols are supported and they are not mixed:
 *   - **prompted**: every row carries a `prompt`. All of them must be valid and pairwise
 *     distinct after presentation normalization. A row that merely omits its prompt cannot
 *     opt out of the check.
 *   - **trusted runner**: no row carries a prompt. This is the legacy shape, where the Host
 *     runs its own trusted comparisons and the prompt never reaches the plugin; it stays
 *     accepted, and its independence remains the Host's guarantee rather than something a
 *     score could prove. See `docs`/README for that boundary.
 *
 * @param rows - raw case rows; only `prompt` is read.
 * @returns `{ ok, mode, tasks }` or `{ ok: false, code, index, duplicateOf }`.
 */
export function taskIndependence(rows) {
  const list = Array.isArray(rows) ? rows : []
  // The protocol is chosen by the PRESENCE of the field, never by its value. A row that carries
  // `prompt: ''`, `null`, a number or an own `undefined` has opted into the prompted protocol
  // and must satisfy it; deciding on truthiness is what let those rows fall back to the
  // prompt-less path and still receive a ticket and a debit.
  const carriers = list.filter(row => row !== null && typeof row === 'object' && Object.hasOwn(row, 'prompt'))
  if (carriers.length === 0) return { ok: true, mode: 'trusted_runner', tasks: 0 }
  // One prompted row makes the whole list prompted: mixing is how a malformed row slips past.
  if (carriers.length !== list.length) return { ok: false, code: CASE_REASONS.invalidPrompt, mode: 'mixed' }
  const seen = new Map()
  for (const [index, row] of list.entries()) {
    const strict = checkTaskPrompt(row.prompt)
    if (!strict.ok) return { ok: false, code: strict.code, index, mode: 'prompted' }
    const key = normalizeTaskPrompt(row.prompt)
    if (key.length === 0) return { ok: false, code: CASE_REASONS.invalidPrompt, index, mode: 'prompted' }
    if (seen.has(key)) {
      return { ok: false, code: CASE_REASONS.duplicateCaseTask, index, duplicateOf: seen.get(key), mode: 'prompted' }
    }
    seen.set(key, index)
  }
  return { ok: true, mode: 'prompted', tasks: seen.size }
}

/** Wire manifest for `evaluationRequest`, in the exact shape the core validates. */
export const caseManifest = cases => cases.map(row => ({ caseId: row.caseId, family: row.family, split: row.split }))
