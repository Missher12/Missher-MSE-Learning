import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildPythonReceiptBirthProof, pythonReceiptBirthProofValid } from '../src/failure-evidence.mjs'
import { developmentCheckIdForCommand, developmentCheckMatchesVerification,
  pythonReceiptCommandSpec, pythonReceiptLessonBirthProofFor,
  pythonReceiptLessonEvidenceSupported } from './checker.mjs'
import { buildFailureCapsule } from '../src/failure-evidence.mjs'

const CHECK = 'python3 MSE-Learning/probes/rsi017-native/intake.py'
const PROBLEM_ID = 'a'.repeat(64)
test('birth proof producer accepts exactly 2048 UTF-8 bytes and rejects Chinese overflow without truncating IDs', () => {
  const input = { entryId: `mem_${'a'.repeat(24)}`, version: Number.MAX_SAFE_INTEGER,
    problemId: 'b'.repeat(64), parentVersion: Number.MAX_SAFE_INTEGER - 1,
    evidenceIds: ['c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64)], requestTicket: 't'.repeat(64),
    requestHash: 'f'.repeat(64), sourceSessionId: 'é'.repeat(61) + 's'.repeat(451),
    guardCapsuleId: '1'.repeat(64), guardTurnKey: '2'.repeat(64), guardSessionId: 'g'.repeat(512),
    command: CHECK }
  const boundary = buildPythonReceiptBirthProof(input)
  assert.ok(boundary)
  assert.equal(Buffer.byteLength(JSON.stringify(boundary), 'utf8'), 2048)
  assert.equal(pythonReceiptBirthProofValid(boundary), true)
  assert.equal(boundary.sourceSessionId, input.sourceSessionId)

  const overLimit = { ...input, sourceSessionId: input.sourceSessionId.slice(0, 61) + '中'
    + input.sourceSessionId.slice(62) }
  assert.equal(overLimit.sourceSessionId.length, input.sourceSessionId.length)
  const oversizedProof = { ...boundary, sourceSessionId: overLimit.sourceSessionId }
  oversizedProof.seal = createHash('sha256').update(JSON.stringify([
    'mse-python-receipt-birth-v1', oversizedProof.entryId, oversizedProof.version,
    oversizedProof.problemId, oversizedProof.parentVersion, oversizedProof.evidenceIds,
    oversizedProof.requestTicket, oversizedProof.requestHash, oversizedProof.sourceSessionId,
    oversizedProof.guardCapsuleId, oversizedProof.guardTurnKey, oversizedProof.guardSessionId,
    oversizedProof.commandHash,
  ])).digest('hex')
  assert.equal(Buffer.byteLength(JSON.stringify(oversizedProof), 'utf8'), 2050)
  assert.equal(pythonReceiptBirthProofValid(oversizedProof), false)
  assert.equal(buildPythonReceiptBirthProof(overLimit), null)
})

function sourceCapsule({ eventId = 'source-event', command = CHECK,
  message = 'MSE_RECEIPT_GUARD: loadedVersion is missing from the receipt',
  originSessionId = 'source-session', turnKey = 'b'.repeat(64), exitCode = 7 } = {}) {
  return buildFailureCapsule({ eventId, at: 1, toolName: 'bash', failureClass: 'tool_nonzero_exit',
    exitCode, message, command: JSON.stringify({ command }), originSessionId, turnKey })
}

function receiptLesson({ check = CHECK, repairSteps = [
  '检查 intake.py 与 counter.py 读取验收单的路径。',
  '对 intake.py 与 counter.py 分别重跑真实探针命令。',
], capsule = sourceCapsule() } = {}) {
  return { problemId: PROBLEM_ID, evidenceIds: [capsule.id], failurePattern: '真实探针缺少 loadedVersion',
    rootCause: { summary: '实际读取的验收单没有当前宿主版本', basis: 'observed', evidenceIds: [capsule.id] },
    repairSteps, verification: { check, expected: 'intake.py 与 counter.py 均 exit 0，loadedVersion 与宿主实际加载版本相同。' },
    problem: { id: PROBLEM_ID, capsules: [capsule] } }
}

test('the receipt command recognizes only the direct intake entry and rejects stale guard checks', () => {
  assert.deepEqual(pythonReceiptCommandSpec(CHECK), {
    executable: 'python3', scriptPath: 'MSE-Learning/probes/rsi017-native/intake.py',
  })
  for (const command of [
    'python3 MSE-Learning/probes/guard0161-real/receipt_check.py',
    'python3 MSE-Learning/probes/rsi017-native/counter.py',
    'python3 -c print(1)',
    `bash -c '${CHECK}'`,
    'python3 ../outside/intake.py',
  ]) assert.equal(pythonReceiptCommandSpec(command), null, command)
  assert.equal(developmentCheckIdForCommand(CHECK), 'python-json-loader-v1',
    'an intake.py basename does not globally change the existing Python/BOM check routing')
  assert.equal(developmentCheckMatchesVerification(CHECK, CHECK), true)
})

test('only the source-backed paired-entry receipt method is eligible', () => {
  const lesson = receiptLesson()
  assert.equal(pythonReceiptLessonEvidenceSupported(lesson, lesson.problem), true)
  assert.equal(pythonReceiptLessonEvidenceSupported(receiptLesson({
    repairSteps: ['只修 intake.py 并以 exit 0 为准。'],
  }), lesson.problem), false)
  assert.equal(pythonReceiptLessonEvidenceSupported(receiptLesson({
    check: 'python3 MSE-Learning/probes/guard0161-real/receipt_check.py',
  }), lesson.problem), false)
  const dynamicGuard = receiptLesson({ capsule: sourceCapsule({
    message: 'MSE_RECEIPT_GUARD: loadedVersion was not provided in this receipt format',
  }) })
  assert.equal(pythonReceiptLessonEvidenceSupported(dynamicGuard, dynamicGuard.problem), true)
  const unrelated = receiptLesson({ capsule: sourceCapsule({
    message: "ModuleNotFoundError: No module named 'sample'",
  }) })
  const ungrounded = unrelated
  assert.equal(pythonReceiptLessonEvidenceSupported(ungrounded, ungrounded.problem), false)
})

test('a unique admitted revision birth proof survives request and capsule rotation, but stale or ambiguous bindings fail closed', () => {
  const oldEvidenceIds = ['1', '2', '3'].map(char => char.repeat(64))
  const entryId = `mem_${'f'.repeat(24)}`
  const currentGuard = sourceCapsule({ eventId: 'current-guard', originSessionId: 'guard-source' })
  const lesson = { ...receiptLesson(), evidenceIds: oldEvidenceIds,
    rootCause: { summary: 'missing loadedVersion', basis: 'observed', evidenceIds: oldEvidenceIds } }
  const problem = { id: PROBLEM_ID, capsules: [currentGuard] }
  const request = { kind: 'revise', settled: true, terminal: 'committed', ticket: 'birth-ticket',
    requestHash: '9'.repeat(64), entryId, problemId: PROBLEM_ID, parentVersion: 2,
    evidenceIds: [...oldEvidenceIds], sourceSessionId: 'birth-source' }
  const allowed = new Set(['birth-source', 'guard-source'])
  const entry = { id: entryId, version: 3, parentVersion: 2, pythonReceiptBirthProof: undefined }
  const context = { doc: { requests: [request] }, entry, entryId, version: 3,
    sourceAdmitted: sessionId => allowed.has(sessionId) }

  assert.equal(pythonReceiptLessonEvidenceSupported(lesson, problem, context), true)
  const proof = pythonReceiptLessonBirthProofFor(lesson, problem, context)
  assert.ok(proof)
  entry.pythonReceiptBirthProof = proof
  context.doc.requests = []
  problem.capsules = []
  assert.equal(pythonReceiptLessonEvidenceSupported(lesson, problem, context), true,
    'the bounded method proof retains only the checked lineage after both rings rotate')
  assert.equal(pythonReceiptLessonEvidenceSupported(lesson, problem, { ...context, version: 4 }), false,
    'a birth proof cannot authorize a newer edition')

  allowed.delete('birth-source')
  assert.equal(pythonReceiptLessonEvidenceSupported(lesson, problem, context), false,
    'withdrawn birth sources stop future objective credit')
  allowed.add('birth-source')
  allowed.delete('guard-source')
  assert.equal(pythonReceiptLessonEvidenceSupported(lesson, problem, context), false,
    'withdrawn guard sources stop future objective credit')
  allowed.add('guard-source')

  context.doc.requests = [request, { ...request, ticket: 'duplicate-birth' }]
  assert.equal(pythonReceiptLessonEvidenceSupported(lesson, problem, context), false,
    'multiple committed births for the same edition are ambiguous')
})

test('a new birth proof requires the current exact entry, evidence list, admitted source and receipt guard semantics', () => {
  const evidenceIds = ['1', '2', '3'].map(char => char.repeat(64))
  const entryId = `mem_${'e'.repeat(24)}`
  const lesson = { ...receiptLesson(), evidenceIds,
    rootCause: { summary: 'missing loadedVersion', basis: 'observed', evidenceIds } }
  const problem = { id: PROBLEM_ID, capsules: [sourceCapsule({ eventId: 'birth-guard',
    originSessionId: 'guard-source' })] }
  const request = { kind: 'revise', settled: true, terminal: 'committed', ticket: 'birth-ticket',
    requestHash: '8'.repeat(64), entryId, problemId: PROBLEM_ID, parentVersion: 2,
    evidenceIds: [...evidenceIds], sourceSessionId: 'birth-source' }
  const context = { doc: { requests: [request] }, entry: { id: entryId, version: 3, parentVersion: 2 }, entryId, version: 3,
    sourceAdmitted: id => ['birth-source', 'guard-source'].includes(id) }
  assert.ok(pythonReceiptLessonBirthProofFor(lesson, problem, context))
  assert.equal(pythonReceiptLessonBirthProofFor(lesson, problem, { ...context, entryId: 'mem_' + 'a'.repeat(24) }), null)
  assert.equal(pythonReceiptLessonBirthProofFor(lesson, problem, { ...context,
    sourceAdmitted: () => false }), null)
  assert.equal(pythonReceiptLessonBirthProofFor({ ...lesson, evidenceIds: ['d'.repeat(64)],
    rootCause: { ...lesson.rootCause, evidenceIds: ['d'.repeat(64)] } }, problem, context), null)
  assert.equal(pythonReceiptLessonBirthProofFor(lesson, { ...problem,
    capsules: [sourceCapsule({ eventId: 'unrelated-guard', originSessionId: 'guard-source',
      message: 'ModuleNotFoundError: no module named sample' })] }, context), null)
})
