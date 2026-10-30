/**
 * The versioned problem-reflection contract (`mse-failure-lesson-v1`).
 *
 * A reflection over REAL failure evidence must produce an experience LINKED to that evidence:
 * an applicability condition, the failure pattern, a root-cause judgement labelled
 * `hypothesis`/`observed` with the exact evidence ids it used, 1–4 concrete repair steps, a
 * checkable verification, and a short recall instruction (≤480 UTF-8 B) that carries the fix and
 * the check — not a generic "check the input and retry".
 *
 * What the validator CAN prove: the contract shape, every byte bound, and that each cited evidence
 * id really is in the frozen request, plus that the lesson text shares concrete tokens with the
 * frozen evidence (grounding). What it deliberately cannot prove is that any natural-language
 * causality is correct — a structured lesson is an explicitly UNVALIDATED candidate; only an
 * objective host check later may credit it.
 *
 * Evidence absence is a first-class answer: an `abstained` result names the missing facts instead
 * of inventing a version, cause or executed repair.
 */
import { createHash } from 'node:crypto'
import { SENSITIVE_PATTERN, AUTHORITY_PATTERN } from './failure-evidence.mjs'
import { analyze } from './recall.mjs'

export const FAILURE_LESSON_SCHEMA = 'mse-failure-lesson-v1'
/** Request policy for a problem reflection that carries capsules (legacy policies stay as they are). */
export const FAILURE_LESSON_OUTPUT_POLICY = 'failure-lesson-reflection-v1'
export const FAILURE_LESSON_OUTPUT_TOKENS = 2048
export const FAILURE_LESSON_MAX_BYTES = 4096
export const FAILURE_INSTRUCTION_MAX_BYTES = 480
export const FAILURE_INSTRUCTION_MAX_CHARS = 240

const hash = text => createHash('sha256').update(text).digest('hex')
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const isPlainObject = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
/** Short bounded text: code points within [min,max], no control chars, no secret/authority shapes. */
const safeText = (value, min, max) => typeof value === 'string'
  && [...value].length >= min && [...value].length <= max
  && value.trim() === value && value.trim() !== ''
  && /[\r\n\u0000-\u001f\u007f]/u.test(value) === false
  && !SENSITIVE_PATTERN.test(value) && !AUTHORITY_PATTERN.test(value)

/** The token set the frozen EVIDENCE supplies for grounding. Tool names and failure-class labels
 *  are deliberately EXCLUDED: "bash" plus "non-zero exit" is not specific experience — only what
 *  the tool actually reported (message, safe command summary) can ground a concrete fix. */
export function evidenceTokenHashes(capsules) {
  const keys = new Set()
  for (const capsule of capsules ?? []) {
    for (const part of [capsule.message, capsule.command]) {
      if (typeof part !== 'string' || part === '') continue
      for (const key of analyze(part).keys) keys.add(key)
    }
  }
  return [...keys].sort().slice(0, 96).map(hash)
}

/** Operational generic-only vocabulary. This is NOT a claim that any other natural-language text
 *  is semantically specific — it is the agreed operational rule that the canned "check the input
 *  and retry" family of sentences, and nothing built only from these filler words, can count as a
 *  concrete lesson. */
const GENERIC_TOKENS = new Set(['check', 'checks', 'checked', 'verify', 'verifying', 'confirm',
  'review', 'retry', 'try', 'trying', 'again', 'input', 'inputs', 'parameter', 'parameters',
  'output', 'outputs', 'result', 'results', 'carefully', 'careful', 'carefully', 'first', 'then',
  'before', 'after', 'correct', 'correctly', 'fix', 'fixed', 'error', 'errors', 'cause', 'problem',
  'when', 'occurs', 'happens', 'ensure', 'avoid', 'observe', 'code', 'status', 'exit', 'run', 'runs',
  '执行', '检查', '验证', '核对', '输入', '参数', '重试', '再次', '输出', '结果', '仔细', '确认', '修正',
  '修复', '错误', '原因', '问题', '发生', '退出', '先', '后', '再', '避免', '确保'])

/**
 * Validate one model answer against the frozen request facts.
 * Returns `{ ok: true, abstained, lesson? }` or `{ ok: false, code }` with an explicit code:
 * `invalid_lesson`, `needs_compaction` (text over its bound) or `not_grounded_evidence` (the
 * concrete parts share no real evidence vocabulary — including the canned generic retry family).
 *
 * The grounding rules this validator CAN enforce, mechanically:
 *  • every cited evidence id is in the frozen request;
 *  • the recall instruction itself (the text actually injected next time) shares at least one
 *    non-generic token with the frozen evidence, so the injected line keeps a concrete fix/check
 *    rather than only the prose around it being specific;
 *  • the instruction also shares a token with its own repairSteps/verification (a concrete
 *    summary of this lesson, not unrelated filler);
 *  • the repair/check body shares at least one token with the evidence;
 *  • the instruction is not built purely from generic filler vocabulary.
 * What no validator here can do is prove arbitrary natural-language causality — a structured
 * lesson remains an explicitly unvalidated candidate.
 */
export function validateFailureLessonOutput(result, { evidenceIds, tokenHashes } = {}) {
  if (!isPlainObject(result) || result.schema !== FAILURE_LESSON_SCHEMA) {
    return { ok: false, code: 'invalid_lesson' }
  }
  if (result.abstained === true) {
    if (!Object.keys(result).every(key => ['schema', 'abstained', 'reason', 'missing'].includes(key))
      || result.reason !== 'evidence_insufficient'
      || !Array.isArray(result.missing) || result.missing.length < 1 || result.missing.length > 4
      || !result.missing.every(text => safeText(text, 4, 120))) return { ok: false, code: 'invalid_lesson' }
    return { ok: true, abstained: true, missing: [...result.missing] }
  }
  if (!Object.keys(result).every(key => ['schema', 'applicability', 'failurePattern', 'rootCause',
    'repairSteps', 'verification', 'instruction'].includes(key))) return { ok: false, code: 'invalid_lesson' }
  const { applicability, failurePattern, rootCause, repairSteps, verification, instruction } = result
  if (!safeText(applicability, 4, 160) || !safeText(failurePattern, 8, 240)) {
    return { ok: false, code: 'invalid_lesson' }
  }
  if (!isPlainObject(rootCause) || !Object.keys(rootCause).every(key => ['summary', 'basis', 'evidenceIds'].includes(key))
    || !safeText(rootCause.summary, 8, 240) || !['hypothesis', 'observed'].includes(rootCause.basis)
    || !Array.isArray(rootCause.evidenceIds) || rootCause.evidenceIds.length < 1
    || rootCause.evidenceIds.length > 3 || !rootCause.evidenceIds.every(hex64)
    || !rootCause.evidenceIds.every(id => evidenceIds.includes(id))) {
    return { ok: false, code: 'invalid_lesson' }
  }
  if (!Array.isArray(repairSteps) || repairSteps.length < 1 || repairSteps.length > 4
    || !repairSteps.every(step => safeText(step, 8, 160))) return { ok: false, code: 'invalid_lesson' }
  if (!isPlainObject(verification) || !Object.keys(verification).every(key => ['check', 'expected'].includes(key))
    || !safeText(verification.check, 8, 160) || !safeText(verification.expected, 4, 160)) {
    return { ok: false, code: 'invalid_lesson' }
  }
  if (typeof instruction !== 'string' || [...instruction].length < 8
    || /[\r\n\u0000-\u001f\u007f]/u.test(instruction) === true
    || SENSITIVE_PATTERN.test(instruction) || AUTHORITY_PATTERN.test(instruction)) {
    return { ok: false, code: 'invalid_lesson' }
  }
  if ([...instruction].length > FAILURE_INSTRUCTION_MAX_CHARS
    || Buffer.byteLength(instruction, 'utf8') > FAILURE_INSTRUCTION_MAX_BYTES) {
    // MSE21: a REAL field diagnostic (fixed vocabulary only) so the one compact retry knows what
    // to shorten — never the provider text itself.
    return { ok: false, code: 'needs_compaction', fields: ['instruction'] }
  }
  const lesson = { schema: FAILURE_LESSON_SCHEMA, applicability, failurePattern,
    rootCause: { summary: rootCause.summary, basis: rootCause.basis, evidenceIds: [...rootCause.evidenceIds] },
    repairSteps: [...repairSteps], verification: { check: verification.check, expected: verification.expected },
    instruction }
  if (Buffer.byteLength(JSON.stringify(lesson), 'utf8') > FAILURE_LESSON_MAX_BYTES) {
    return { ok: false, code: 'needs_compaction', fields: ['lesson_json'] }
  }
  const tokensOf = texts => {
    const set = new Set()
    for (const text of texts) for (const key of analyze(text).keys) set.add(key)
    return set
  }
  const instructionTokens = tokensOf([instruction])
  const fixTokens = tokensOf([...repairSteps, verification.check, verification.expected])
  const evidenceHits = keys => [...keys].filter(key => tokenHashes.includes(hash(key)))
  const instructionEvidence = evidenceHits(instructionTokens)
  if (instructionEvidence.length < 1) return { ok: false, code: 'not_grounded_evidence' }
  if (evidenceHits(fixTokens).length < 1) return { ok: false, code: 'not_grounded_evidence' }
  // The injected instruction must itself carry the concrete fix/check: it shares a token with the
  // steps/verification it summarizes…
  const ownFix = [...instructionTokens].some(token => fixTokens.has(token))
  if (!ownFix) return { ok: false, code: 'not_grounded_evidence' }
  // …and at least one of its evidence-linked tokens is not generic filler vocabulary.
  if (!instructionEvidence.some(token => !GENERIC_TOKENS.has(token.toLocaleLowerCase('und')))) {
    return { ok: false, code: 'not_grounded_evidence' }
  }
  return { ok: true, abstained: false, lesson }
}

/** Whether a STORED `lesson.failureLesson` record passes its bounded shape rule. */
export function failureLessonValid(record) {
  return isPlainObject(record)
    && Object.keys(record).every(key => ['schema', 'problemId', 'evidenceRevision', 'evidenceIds',
      'applicability', 'failurePattern', 'rootCause', 'repairSteps', 'verification', 'instruction',
      'createdAt', 'originScope', 'originEnvironment', 'visibility'].includes(key))
    && record.schema === FAILURE_LESSON_SCHEMA && hex64(record.problemId)
    && Number.isSafeInteger(record.evidenceRevision) && record.evidenceRevision >= 0
    && Array.isArray(record.evidenceIds) && record.evidenceIds.length >= 1 && record.evidenceIds.length <= 3
    && record.evidenceIds.every(hex64)
    && safeText(record.applicability, 4, 160) && safeText(record.failurePattern, 8, 240)
    && isPlainObject(record.rootCause) && safeText(record.rootCause.summary, 8, 240)
    && ['hypothesis', 'observed'].includes(record.rootCause.basis)
    && Array.isArray(record.rootCause.evidenceIds) && record.rootCause.evidenceIds.every(hex64)
    && Array.isArray(record.repairSteps) && record.repairSteps.length >= 1 && record.repairSteps.length <= 4
    && record.repairSteps.every(step => safeText(step, 8, 160))
    && isPlainObject(record.verification) && safeText(record.verification.check, 8, 160)
    && safeText(record.verification.expected, 4, 160)
    && safeText(record.instruction, 8, FAILURE_INSTRUCTION_MAX_CHARS)
    && Buffer.byteLength(record.instruction, 'utf8') <= FAILURE_INSTRUCTION_MAX_BYTES
    && Number.isFinite(record.createdAt)
    && hex64(record.originScope) && hex64(record.originEnvironment)
    && ['global', 'scoped'].includes(record.visibility)
    && Buffer.byteLength(JSON.stringify(record), 'utf8') <= FAILURE_LESSON_MAX_BYTES
}
