import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPythonCheckFailureProof } from '../src/failure-evidence.mjs'
import { developmentCheckIdForCommand, developmentCheckMatchesVerification,
  pythonBOMLessonEvidenceSupported } from './checker.mjs'

const COMMAND = 'python3 .mse-evolution/verify/check.py'

test('Python JSON verification recognizes only an exact direct script command', () => {
  assert.equal(developmentCheckIdForCommand(COMMAND), 'python-json-loader-v1')
  assert.equal(developmentCheckMatchesVerification(COMMAND, COMMAND), true)
  assert.equal(developmentCheckMatchesVerification(COMMAND, 'python3  .mse-evolution/verify/check.py'), false)
  assert.equal(developmentCheckMatchesVerification(COMMAND, 'python3 other.py'), false)

  for (const command of [
    'python3 -c print(1)',
    'python3 .mse-evolution/verify/check.py && echo done',
    'bash -lc python3 .mse-evolution/verify/check.py',
    'python3 ../outside.py',
    'python3 /etc/passwd',
    'python3 .mse-evolution/verify/check.py extra.json',
  ]) assert.equal(developmentCheckIdForCommand(command), null, command)
})

test('the Python JSON/BOM verifier is scoped to the lesson and its complete cited BOM failure evidence', () => {
  const evidenceIds = ['a'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)]
  const lesson = { problemId: 'b'.repeat(64), evidenceIds,
    failurePattern: 'JSONDecodeError: Unexpected UTF-8 BOM',
    rootCause: { evidenceIds },
    verification: { check: COMMAND,
      expected: 'exit code 0；stderr 不含 JSONDecodeError 或 Unexpected UTF-8 BOM；配置文件 BOM 未被删除。' } }
  const capsules = evidenceIds.map((id, index) => ({ id,
    message: `JSONDecodeError: Unexpected UTF-8 BOM (source evidence ${index + 1})`,
    originSessionId: 'source-session', turnKey: String(index + 1).repeat(64) }))
  assert.equal(pythonBOMLessonEvidenceSupported(lesson, { id: lesson.problemId,
    capsules }), true, 'the complete original v4 wording and all three cited evidence rows are admitted')
  assert.equal(pythonBOMLessonEvidenceSupported({ ...lesson, failurePattern: 'JSONDecodeError: trailing comma' },
    { id: lesson.problemId, capsules }), false)
  assert.equal(pythonBOMLessonEvidenceSupported({ ...lesson, verification: {
    check: COMMAND, expected: 'exit code 0；stderr 不含 JSONDecodeError；配置正确解析。' } },
  { id: lesson.problemId, capsules }), false)
  assert.equal(pythonBOMLessonEvidenceSupported({ ...lesson, problemId: 'd'.repeat(64) },
    { id: lesson.problemId, capsules }), false)
  assert.equal(pythonBOMLessonEvidenceSupported(lesson, { id: lesson.problemId, capsules: capsules.slice(1) }),
    false, 'one missing cited capsule is not replaced by partial evidence')
  assert.equal(pythonBOMLessonEvidenceSupported({ ...lesson,
    rootCause: { evidenceIds: evidenceIds.slice(1) } }, { id: lesson.problemId, capsules }), false,
  'the lesson and root cause must cite the same complete evidence set')
  const businessLesson = { ...lesson,
    failurePattern: 'intake.py is missing the loadedVersion guard',
    verification: { check: COMMAND, expected: 'loadedVersion matches the current intake version' } }
  assert.equal(pythonBOMLessonEvidenceSupported(businessLesson, { id: lesson.problemId, capsules }), false,
    'ordinary intake business invariants do not inherit JSON/BOM verification credit')
})

test('a revised Python lesson may cite only a same-problem checker failure with persisted version evidence', () => {
  const entryId = `mem_${'f'.repeat(24)}`
  const problemId = 'b'.repeat(64)
  const sessionId = 'python-source-session'
  const turnKey = 'c'.repeat(64)
  const checkEventId = '9'.repeat(64)
  const rootId = 'a'.repeat(64)
  const checkCapsuleId = '8'.repeat(64)
  const rootLesson = { problemId, evidenceIds: [rootId],
    failurePattern: 'JSONDecodeError: Unexpected UTF-8 BOM',
    rootCause: { evidenceIds: [rootId] },
    verification: { check: COMMAND,
      expected: 'exit code 0；stderr 不含 JSONDecodeError 或 Unexpected UTF-8 BOM；配置文件 BOM 未被删除。' } }
  const revised = { ...rootLesson, evidenceIds: [checkCapsuleId],
    failurePattern: 'Python JSON/BOM objective check failed: output_mismatch',
    rootCause: { evidenceIds: [checkCapsuleId] } }
  const summary = { kind: 'python_json_loader', bytes: 24, inputHash: 'd'.repeat(64), bomCount: 2,
    reads: 1, parses: 1, reason: 'output_mismatch' }
  const checkProof = buildPythonCheckFailureProof({ problemId, entryId, entryVersion: 1,
    checkEventId, turnKey, originSessionId: sessionId, command: COMMAND, summary })
  const problem = { id: problemId, capsules: [
    { id: rootId, message: 'JSONDecodeError: Unexpected UTF-8 BOM',
      originSessionId: sessionId, turnKey },
    { id: checkCapsuleId, toolName: 'mse_verify_python', failureClass: 'checker_contract_failure',
      checkId: 'python-json-loader-v1', checkEventId, message: 'Python JSON/BOM objective check failed: output_mismatch',
      checkProof, originSessionId: sessionId, turnKey },
  ] }
  const doc = {
    checkEvents: [{ id: checkEventId, turnKey, checkId: 'python-json-loader-v1', passed: false,
      entryId, entryVersion: 1, summary }],
    receipts: [{ turnKey, settled: true, outcome: 'failed',
      offered: [{ id: entryId, version: 1, mode: 'method' }],
      methodFeedback: [{ entryId, version: 1, kind: 'check_fail', checkId: 'python-json-loader-v1' }] }],
    turnFacts: [{ turnKey, sessionId, outcome: 'failed' }],
    methodHistory: [{ entryId, version: 1, status: 'needs_revision', lesson: rootLesson }],
  }
  assert.equal(pythonBOMLessonEvidenceSupported(revised, problem,
    { doc, entryId, version: 2 }), true, 'the failed check is grounded in the archived same-problem BOM method')
  assert.equal(pythonBOMLessonEvidenceSupported(revised, problem,
    { doc: { ...doc, turnFacts: [{ turnKey, sessionId: 'another-session', outcome: 'failed' }] },
      entryId, version: 2 }), false, 'the receipt source session must match the immutable capsule source')
  assert.equal(pythonBOMLessonEvidenceSupported(revised, problem,
    { doc: { ...doc, checkEvents: [], receipts: [], turnFacts: [], methodHistory: [] },
      entryId, version: 2 }), true,
  'the engine-stamped capsule retains its same-problem check/version binding after bounded ledgers rotate')
  const unprovedProblem = { ...problem, capsules: problem.capsules.map(capsule => {
    if (capsule.id !== checkCapsuleId) return capsule
    const unproved = { ...capsule }
    delete unproved.checkProof
    return unproved
  }) }
  assert.equal(pythonBOMLessonEvidenceSupported(revised, unprovedProblem,
    { doc, entryId, version: 2 }), false,
  'checkId, matching text, and even live rows cannot replace the engine-stamped capsule proof')
  assert.equal(pythonBOMLessonEvidenceSupported(revised, problem,
    { doc, entryId, version: 1 }), false, 'a failure from the current version cannot support itself')
  const unrelatedProblem = { ...problem, id: 'e'.repeat(64) }
  assert.equal(pythonBOMLessonEvidenceSupported({ ...revised, problemId: unrelatedProblem.id },
    unrelatedProblem, { doc, entryId, version: 2 }), false,
  'the archived failed version and revised method must remain tied to the original problem')
})
