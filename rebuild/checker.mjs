/**
 * Real deterministic checkers — actual programs, not claims.
 *
 * A checker turns an objective fact about the world into pass/fail with a bounded reason code.
 * Exit code 0 of an arbitrary command and model prose never reach this path; only the checker's
 * own evaluation does. Results carry counts and reason codes only — never file contents.
 */
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isAbsolutePath, relativeInside } from './paths.mjs'
import { buildPythonReceiptBirthProof, capsuleValid, pythonCheckFailureProofValid,
  pythonReceiptBirthProofValid, pythonReceiptCheckFailureProofValid } from '../src/failure-evidence.mjs'

const MAX_FILE_BYTES = 256 * 1024

function safeFile(root, rel) {
  if (typeof root !== 'string' || root === '' || typeof rel !== 'string' || rel === '' || rel.length > 512
    || rel.includes('\u0000') || isAbsolutePath(rel)) return null
  const target = resolve(join(root, rel))
  const base = resolve(root)
  if (relativeInside(target, base) === null || target === base) return null
  try {
    if (relativeInside(realpathSync(target), realpathSync(base)) === null) return null
    const stat = statSync(target)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null
    return readFileSync(target, 'utf8')
  } catch { return null }
}

/** Parses the file as JSON; a trailing comma is reported as the concrete reason. */
function jsonFileParses({ file, root } = {}) {
  const text = safeFile(root, file)
  const result = (status, reason, extra = {}) => ({ status, checkId: 'json-file-parses-v1', reason, ...extra })
  if (text === null) return result('not_applicable', 'file_unavailable')
  try {
    JSON.parse(text)
    return result('pass', 'parses', { bytes: Buffer.byteLength(text) })
  } catch (error) {
    const trailing = /Expected double-quoted property name|Unexpected token ','/iu.test(String(error?.message))
    return result('fail', trailing ? 'trailing_comma' : 'parse_error', { bytes: Buffer.byteLength(text) })
  }
}

export const CHECKERS = Object.freeze({ 'json-file-parses-v1': jsonFileParses })

const DEVELOPMENT_CHECK_IDS = Object.freeze({
  nodeTest: 'node-test-runner-spec-v1',
  typeScript: 'typescript-noemit-v1',
  pytest: 'pytest-summary-v1',
  pythonJson: 'python-json-loader-v1',
  pythonReceipt: 'python-receipt-contract-v1',
})
const SAFE_LOCAL_PATH = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./*-]+$/u
const SAFE_PYTHON_PATH = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+$/u

function simpleCommandWords(command) {
  if (typeof command !== 'string' || command.length === 0 || command.length > 4096
    || /[\u0000-\u001f\u007f;&|<>`$\\'"(){}\[\]]/u.test(command)) return null
  return command.trim().split(/\s+/u)
}

function developmentCommandSpec(command) {
  const args = simpleCommandWords(command)
  if (args === null || args.length === 0) return null
  const executable = (path, name) => SAFE_LOCAL_PATH.test(path)
    && (path === name || path.endsWith(`/${name}`))
  if (args.length === 2 && /^(?:python|python3|python\.exe|python3\.exe)$/u.test(args[0].split('/').at(-1))
    && SAFE_PYTHON_PATH.test(args[0]) && !args[0].includes('*')
    && SAFE_PYTHON_PATH.test(args[1]) && !args[1].startsWith('/')
    && args[1].endsWith('.py')) {
    return { checkId: DEVELOPMENT_CHECK_IDS.pythonJson, executable: args[0], scriptPath: args[1], arguments: args.slice(1) }
  }
  if (executable(args[0], 'node') && args[1] === '--test'
    && args.slice(2).every(arg => SAFE_LOCAL_PATH.test(arg)
      && (!arg.includes('*') || /(?:^|\/)[*][A-Za-z0-9_.-]*\.(?:test|spec)\.(?:mjs|cjs|js|ts)$/u.test(arg)))) {
    return { checkId: DEVELOPMENT_CHECK_IDS.nodeTest, arguments: args.slice(1) }
  }
  const pytest = pytestCommandSpec(args)
  if (pytest !== null) return pytest
  if (!executable(args[0], 'tsc') || args[1] !== '--noEmit' || args.length < 3) return null
  const inputs = args.slice(2)
  if (inputs[0] === '-p' || inputs[0] === '--project') {
    return inputs.length === 2 && SAFE_LOCAL_PATH.test(inputs[1])
      && /(?:^|\/)tsconfig(?:\.[A-Za-z0-9_-]+)?\.json$/u.test(inputs[1])
      ? { checkId: DEVELOPMENT_CHECK_IDS.typeScript, arguments: args.slice(1) } : null
  }
  return inputs.every(path => SAFE_LOCAL_PATH.test(path) && /\.(?:ts|tsx|mts|cts)$/u.test(path))
    ? { checkId: DEVELOPMENT_CHECK_IDS.typeScript, arguments: args.slice(1) } : null
}

function pytestPath(path) {
  if (typeof path !== 'string' || !SAFE_LOCAL_PATH.test(path) || path.startsWith('/')
    || path.includes('*') || path.includes('\\')) return false
  const normalized = path.startsWith('./') ? path.slice(2) : path
  if (normalized === '' || normalized.split('/').some(part => part === '' || part === '.' || part === '..')) return false
  return normalized.endsWith('.py') || !/\.[A-Za-z0-9]+$/u.test(normalized)
}

function pytestCommandSpec(args) {
  const executable = (path, name) => SAFE_LOCAL_PATH.test(path)
    && (path === name || path.endsWith(`/${name}`))
  let start
  if (executable(args[0], 'pytest')) start = 1
  else if ((executable(args[0], 'python') || executable(args[0], 'python3'))
    && args[1] === '-m' && args[2] === 'pytest') start = 3
  else return null
  const options = new Set()
  const paths = []
  for (const arg of args.slice(start)) {
    if (['-q', '--quiet', '--color=no'].includes(arg)) {
      if (options.has(arg)) return null
      options.add(arg)
    } else if (arg.startsWith('-') || !pytestPath(arg)) return null
    else paths.push(arg)
  }
  if (paths.length === 0 || paths.length > 32) return null
  return { checkId: DEVELOPMENT_CHECK_IDS.pytest, arguments: args.slice(1) }
}

/** Exact normalized verification matcher shared by stored lessons and observed foreground calls. */
export function developmentCheckIdForCommand(command) {
  return developmentCommandSpec(command)?.checkId ?? null
}

export function developmentCheckMatchesVerification(verificationCheck, command) {
  const actual = developmentCommandSpec(command)
  if (actual === null || typeof verificationCheck !== 'string') return false
  if (actual.checkId === DEVELOPMENT_CHECK_IDS.pythonJson) return verificationCheck === command
  if (verificationCheck === actual.checkId) return actual.checkId !== DEVELOPMENT_CHECK_IDS.pytest
    // Existing internal IDs stay compatible; pytest requires its exact command and target path.
  const declared = developmentCommandSpec(verificationCheck)
  return declared !== null && declared.checkId === actual.checkId
    && declared.arguments.length === actual.arguments.length
    && declared.arguments.every((part, index) => part === actual.arguments[index])
}

/** Parse one direct Python script command without shell wrappers or extra arguments. */
export function pythonCommandSpec(command) {
  const spec = developmentCommandSpec(command)
  return spec?.checkId === DEVELOPMENT_CHECK_IDS.pythonJson ? spec : null
}

/** Parse the one supported receipt entry command; paired coverage is derived from its directory. */
export function pythonReceiptCommandSpec(command) {
  const args = simpleCommandWords(command)
  if (args === null || args.length !== 2
    || !/^(?:python|python3|python\.exe|python3\.exe)$/u.test(args[0].split('/').at(-1))
    || !SAFE_PYTHON_PATH.test(args[0]) || args[0].includes('*')
    || !SAFE_PYTHON_PATH.test(args[1]) || args[1].startsWith('/') || !args[1].endsWith('/intake.py')) {
    return null
  }
  const scriptPath = args[1].replace(/^\.\//u, '')
  if (scriptPath.split('/').some(part => part === '' || part === '.' || part === '..')) return null
  return { executable: args[0], scriptPath }
}

function pythonReceiptLessonShapeSupported(lesson, problem) {
  if (lesson === null || typeof lesson !== 'object' || Array.isArray(lesson)
    || problem === null || typeof problem !== 'object' || Array.isArray(problem)
    || lesson.problemId !== problem.id || pythonReceiptCommandSpec(lesson.verification?.check) === null
    || !Array.isArray(lesson.evidenceIds) || lesson.evidenceIds.length === 0
    || lesson.evidenceIds.length > 3 || new Set(lesson.evidenceIds).size !== lesson.evidenceIds.length
    || !Array.isArray(lesson.rootCause?.evidenceIds)
    || lesson.rootCause.evidenceIds.length !== lesson.evidenceIds.length
    || !lesson.evidenceIds.every((id, index) => lesson.rootCause.evidenceIds[index] === id)
    || !Array.isArray(lesson.repairSteps)
    || !Array.isArray(problem.capsules)) return false
  const methodText = lesson.repairSteps.filter(step => typeof step === 'string').join('\n')
  return /intake\.py/iu.test(methodText) && /counter\.py/iu.test(methodText)
}

function capsuleCommand(capsule) {
  if (typeof capsule?.command !== 'string') return null
  try {
    const value = JSON.parse(capsule.command)
    if (typeof value === 'string') return value
    return isPlainRecord(value) && typeof value.command === 'string' ? value.command : null
  } catch {
    return pythonReceiptCommandSpec(capsule.command) === null ? null : capsule.command
  }
}

function sourceStillAdmitted(sourceAdmitted, sessionId) {
  try { return typeof sourceAdmitted === 'function' && sourceAdmitted(sessionId) === true } catch { return false }
}

function receiptGuardFailureMessage(message) {
  return typeof message === 'string'
    && /\bMSE_RECEIPT_GUARD\b/iu.test(message)
    && /\bloadedVersion\b/iu.test(message)
    && /(?:缺少|缺失|未(?:设置|提供|填写)|没有|missing|absent|unset|not\s+(?:set|provided|present|found))/iu
      .test(message)
}

function pythonReceiptGuardCapsuleSupported(capsule, command, sourceAdmitted) {
  return capsuleValid(capsule) && capsule.toolName === 'bash' && capsule.failureClass === 'tool_nonzero_exit'
    && Number.isSafeInteger(capsule.exitCode) && capsule.exitCode !== 0 && capsule.checkId === null
    && typeof capsule.originSessionId === 'string' && capsule.originSessionId !== ''
    && typeof capsule.turnKey === 'string' && /^[a-f0-9]{64}$/u.test(capsule.turnKey)
    && receiptGuardFailureMessage(capsule.message)
    && capsuleCommand(capsule) === command
    && (typeof sourceAdmitted !== 'function' || sourceStillAdmitted(sourceAdmitted, capsule.originSessionId))
}

function committedReceiptBirthRequests(doc, { entryId, version, problemId }) {
  if (!Array.isArray(doc?.requests)) return null
  return doc.requests.filter(row => row?.kind === 'revise' && row.settled === true
    && row.terminal === 'committed' && row.entryId === entryId && row.problemId === problemId
    && row.parentVersion === version - 1)
}

function sameEvidenceIds(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((id, index) => id === right[index])
}

function requestMatchesBirthProof(request, proof) {
  return request.ticket === proof.requestTicket && request.requestHash === proof.requestHash
    && request.sourceSessionId === proof.sourceSessionId && request.problemId === proof.problemId
    && request.entryId === proof.entryId && request.parentVersion === proof.parentVersion
    && sameEvidenceIds(request.evidenceIds, proof.evidenceIds)
}

/** Return a current birth binding, creating it only from one retained committed request and a live native guard capsule. */
export function pythonReceiptLessonBirthProofFor(lesson, problem, context = {}) {
  if (!pythonReceiptLessonShapeSupported(lesson, problem) || typeof context.entryId !== 'string'
    || !Number.isSafeInteger(context.version) || context.version < 2
    || context.entry?.id !== context.entryId || context.entry.version !== context.version
    || context.entry.parentVersion !== context.version - 1
    || typeof context.sourceAdmitted !== 'function') return null
  const expected = { entryId: context.entryId, version: context.version, problemId: problem.id,
    parentVersion: context.version - 1, evidenceIds: lesson.evidenceIds, command: lesson.verification.check }
  const doc = context.doc
  const existing = context.entry?.pythonReceiptBirthProof
  if (existing !== undefined) {
    if (!pythonReceiptBirthProofValid(existing, expected)
      || !sourceStillAdmitted(context.sourceAdmitted, existing.sourceSessionId)
      || !sourceStillAdmitted(context.sourceAdmitted, existing.guardSessionId)) return null
    const rows = committedReceiptBirthRequests(doc, expected)
    if (rows === null || (rows.length > 0 && (rows.length !== 1 || !requestMatchesBirthProof(rows[0], existing)))) {
      return null
    }
    return existing
  }

  const rows = committedReceiptBirthRequests(doc, expected)
  if (rows === null || rows.length !== 1) return null
  const request = rows[0]
  if (!sameEvidenceIds(request.evidenceIds, lesson.evidenceIds)
    || typeof request.sourceSessionId !== 'string' || request.sourceSessionId === ''
    || !sourceStillAdmitted(context.sourceAdmitted, request.sourceSessionId)) return null
  const guard = problem.capsules.filter(capsule =>
    pythonReceiptGuardCapsuleSupported(capsule, lesson.verification.check, context.sourceAdmitted))
    .sort((left, right) => left.id.localeCompare(right.id))[0]
  if (guard === undefined) return null
  return buildPythonReceiptBirthProof({ entryId: context.entryId, version: context.version,
    problemId: problem.id, parentVersion: context.version - 1, evidenceIds: lesson.evidenceIds,
    requestTicket: request.ticket, requestHash: request.requestHash, sourceSessionId: request.sourceSessionId,
    guardCapsuleId: guard.id, guardTurnKey: guard.turnKey, guardSessionId: guard.originSessionId,
    command: lesson.verification.check })
}

function receiptHistoricalCapsuleSupported(capsule, problem, lesson, context) {
  if (!capsuleValid(capsule)) return false
  if (capsule.checkId === DEVELOPMENT_CHECK_IDS.pythonReceipt && capsule.toolName === 'mse_verify_python_receipt'
    && capsule.failureClass === 'checker_contract_failure' && typeof capsule.checkEventId === 'string'
    && capsule.checkProof !== null && typeof capsule.checkProof === 'object' && capsule.message ===
      `Python receipt objective check failed: ${capsule.checkProof.reason}`
    && pythonReceiptCheckFailureProofValid(capsule.checkProof, { problemId: problem.id,
      entryId: context.entryId, checkEventId: capsule.checkEventId, command: lesson.verification.check,
      reason: capsule.checkProof.reason })) {
    const proof = capsule.checkProof
    if (Number.isSafeInteger(context.version) && proof.entryVersion >= context.version) return false
    const event = context.doc?.checkEvents?.find(row => row.id === proof.checkEventId)
    if (event !== undefined && (event.checkId !== DEVELOPMENT_CHECK_IDS.pythonReceipt || event.passed !== false
      || event.entryId !== proof.entryId || event.entryVersion !== proof.entryVersion
      || event.summary?.kind !== 'python_receipt_contract' || event.summary?.reason !== proof.reason
      || proof.summaryHash !== digestJson(event.summary))) return false
    const receipt = context.doc?.receipts?.find(row => row.turnKey === proof.turnKey)
    if (receipt !== undefined && (receipt.settled !== true || receipt.outcome !== 'failed'
      || !receipt.offered?.some(row => row.id === proof.entryId && row.version === proof.entryVersion
        && row.mode !== 'guard')
      || !receipt.methodFeedback?.some(row => row.entryId === proof.entryId
        && row.version === proof.entryVersion && row.kind === 'check_fail'
        && row.checkId === DEVELOPMENT_CHECK_IDS.pythonReceipt))) return false
    const fact = context.doc?.turnFacts?.find(row => row.turnKey === proof.turnKey)
    return fact === undefined || (fact.sessionId === proof.originSessionId && fact.outcome === 'failed')
  }
  return pythonReceiptGuardCapsuleSupported(capsule, lesson.verification.check, context.sourceAdmitted)
}

/** Whether source-backed paired-entry receipt evidence still supports the exact current method. */
export function pythonReceiptLessonEvidenceSupported(lesson, problem, context = {}) {
  if (!pythonReceiptLessonShapeSupported(lesson, problem)) return false

  const cited = lesson.evidenceIds.map(id => problem.capsules.find(row => row?.id === id) ?? null)
  const historicalEvidence = cited.every(capsule =>
    capsule !== null && receiptHistoricalCapsuleSupported(capsule, problem, lesson, context))
  if (historicalEvidence) return true
  return pythonReceiptLessonBirthProofFor(lesson, problem, context) !== null
}

const pythonBOMLessonShape = (lesson, problemId) => {
  if (lesson === null || typeof lesson !== 'object' || Array.isArray(lesson)
    || lesson.problemId !== problemId || pythonCommandSpec(lesson.verification?.check) === null) return false
  const expected = lesson.verification?.expected
  if (typeof expected !== 'string'
    || !/\bBOM\b.{0,32}(?:未(?:被)?(?:删除|移除|剥离)|保留|preserv|not.{0,8}(?:remov|strip))/iu.test(expected)
    || !Array.isArray(lesson.evidenceIds) || lesson.evidenceIds.length === 0
    || !Array.isArray(lesson.rootCause?.evidenceIds)
    || lesson.rootCause.evidenceIds.length !== lesson.evidenceIds.length
    || !lesson.evidenceIds.every((id, index) => lesson.rootCause.evidenceIds[index] === id)
    || lesson.evidenceIds.length > 3 || new Set(lesson.evidenceIds).size !== lesson.evidenceIds.length) return false
  return true
}

const pythonBOMLessonContract = (lesson, problemId) => pythonBOMLessonShape(lesson, problemId)
  && typeof lesson.failurePattern === 'string'
  && /JSONDecodeError\s*:\s*Unexpected\s+UTF-8\s+BOM/iu.test(lesson.failurePattern)

const immutableBOMSourceCapsule = capsule => typeof capsule?.originSessionId === 'string'
  && capsule.originSessionId !== '' && typeof capsule?.turnKey === 'string'
  && /^[a-f0-9]{64}$/u.test(capsule.turnKey) && typeof capsule?.message === 'string'
  && /JSONDecodeError\s*:\s*Unexpected\s+UTF-8\s+BOM/iu.test(capsule.message)

function checkerFailureCapsuleGrounded(capsule, problem, lesson, { doc, entryId, version } = {}) {
  if (capsule?.checkId !== DEVELOPMENT_CHECK_IDS.pythonJson || capsule.toolName !== 'mse_verify_python'
    || capsule.failureClass !== 'checker_contract_failure' || typeof capsule.checkEventId !== 'string'
    || !/^[a-f0-9]{64}$/u.test(capsule.checkEventId)
    || typeof capsule.originSessionId !== 'string' || capsule.originSessionId === ''
    || typeof capsule.turnKey !== 'string' || !/^[a-f0-9]{64}$/u.test(capsule.turnKey)
    || typeof capsule.message !== 'string'
    || !/^Python JSON\/BOM objective check failed: (?:output_mismatch|bom_not_stripped|parse_error|source_write_attempted)$/u
      .test(capsule.message)
    || !isPlainRecord(doc) || typeof entryId !== 'string' || !Number.isSafeInteger(version)) return false

  const proof = capsule.checkProof
  const reason = proof?.reason
  if (capsule.message !== `Python JSON/BOM objective check failed: ${reason}`
    || !pythonCheckFailureProofValid(proof, { problemId: problem.id, entryId,
      entryVersion: proof?.entryVersion, checkEventId: capsule.checkEventId,
      turnKey: capsule.turnKey, originSessionId: capsule.originSessionId,
      command: lesson.verification.check, reason })
    || proof.entryVersion >= version) return false

  // Runtime audit arrays are intentionally bounded and may later rotate. Any matching row that
  // remains must agree with the proof; the proof itself is the durable engine-side attestation.
  const event = (doc.checkEvents ?? []).find(row => row.id === proof.checkEventId)
  if (event !== undefined && (event.checkId !== DEVELOPMENT_CHECK_IDS.pythonJson || event.passed !== false
    || event.entryId !== entryId || event.entryVersion !== proof.entryVersion || event.turnKey !== proof.turnKey
    || event.summary?.kind !== 'python_json_loader' || event.summary?.reason !== reason
    || proof.summaryHash !== digestJson(event.summary))) return false
  const receipt = (doc.receipts ?? []).find(row => row.turnKey === proof.turnKey)
  if (receipt !== undefined && (receipt.settled !== true || receipt.outcome !== 'failed'
    || !receipt.offered?.some(row => row.id === entryId && row.version === proof.entryVersion
      && row.mode !== 'guard')
    || !receipt.methodFeedback?.some(row => row.entryId === entryId && row.version === proof.entryVersion
      && row.kind === 'check_fail' && row.checkId === DEVELOPMENT_CHECK_IDS.pythonJson))) return false
  const fact = (doc.turnFacts ?? []).find(row => row.turnKey === proof.turnKey)
  if (fact !== undefined && (fact.sessionId !== proof.originSessionId || fact.outcome !== 'failed')) return false

  const previous = (doc.methodHistory ?? []).find(row => row.entryId === entryId
    && row.version === proof.entryVersion)
  return previous === undefined || (previous.status === 'needs_revision'
    && pythonBOMLessonShape(previous.lesson, problem.id)
    && previous.lesson.verification.check === lesson.verification.check)
}

const digestJson = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const isPlainRecord = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

/** Scope the Python verifier to source-backed BOM lessons and audited same-problem revisions. */
export function pythonBOMLessonEvidenceSupported(lesson, problem, context = {}) {
  if (problem === null || typeof problem !== 'object' || Array.isArray(problem)
    || problem.id !== lesson?.problemId || !pythonBOMLessonShape(lesson, problem.id)) return false
  const capsules = problem.capsules ?? []
  const cited = lesson.evidenceIds.map(id => capsules.find(capsule => capsule?.id === id) ?? null)
  if (cited.some(capsule => capsule === null)) return false
  const checked = cited.filter(capsule => checkerFailureCapsuleGrounded(capsule, problem, lesson, context))
  const sourceOnly = checked.length === 0 && cited.every(immutableBOMSourceCapsule)
  if (sourceOnly) return pythonBOMLessonContract(lesson, problem.id)
  if (checked.length === 0 || !cited.every(capsule => immutableBOMSourceCapsule(capsule)
    || checked.includes(capsule))) return false
  return pythonBOMLessonContract(lesson, problem.id)
    || checked.some(capsule => lesson.failurePattern === capsule.message)
}

function foregroundOutput(result) {
  const value = result?.value
  if (result?.isError !== false || value?.kind !== 'foreground'
    || !isAbsolutePath(value.cwd)
    || value.timedOut !== false || value.aborted !== false
    || (value.signal !== null && value.signal !== 0)
    || !Number.isSafeInteger(value.exitCode)
    || typeof value.stdout?.text !== 'string' || value.stdout.truncated !== false
    || typeof value.stderr?.text !== 'string' || value.stderr.truncated !== false
    || value.stdout.text.length > 256 * 1024 || value.stderr.text.length > 64 * 1024) return null
  return { exitCode: value.exitCode, stdout: value.stdout.text, stderr: value.stderr.text }
}

function nodeTestResult(output) {
  if (output.stderr !== '') return null
  const names = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']
  const counts = Object.create(null)
  let duration = null
  for (const line of output.stdout.split(/\r?\n/u)) {
    const row = /^ℹ (tests|suites|pass|fail|cancelled|skipped|todo) ([0-9]+)$/u.exec(line)
    if (row !== null) {
      if (Object.hasOwn(counts, row[1])) return null
      counts[row[1]] = Number(row[2])
      continue
    }
    const time = /^ℹ duration_ms ([0-9]+(?:\.[0-9]+)?)$/u.exec(line)
    if (time !== null) {
      if (duration !== null) return null
      duration = Number(time[1])
    }
  }
  if (names.some(name => !Number.isSafeInteger(counts[name])) || duration === null
    || !Number.isFinite(duration)
    || counts.tests !== counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo
    || counts.tests < 1 || counts.cancelled > 0) return null
  const evidence = { kind: 'node_test_runner', tests: counts.tests, passed: counts.pass,
    failed: counts.fail, skipped: counts.skipped, cancelled: counts.cancelled, todo: counts.todo }
  if (output.exitCode === 0 && counts.fail === 0 && counts.pass > 0
    && counts.skipped === 0 && counts.todo === 0) return { status: 'pass', evidence }
  if (output.exitCode !== 0 && counts.fail > 0) return { status: 'fail', evidence }
  return null
}

function typeScriptResult(output) {
  const text = `${output.stdout}\n${output.stderr}`
  if (output.exitCode === 0) {
    return output.stdout === '' && output.stderr === ''
      ? { status: 'pass', evidence: { kind: 'typescript_noemit', diagnostics: 0 } } : null
  }
  const diagnostics = text.match(/^.*error TS[0-9]+:.*$/gmu) ?? []
  return diagnostics.length > 0
    ? { status: 'fail', evidence: { kind: 'typescript_noemit', diagnostics: Math.min(diagnostics.length, 256) } } : null
}

const PYTEST_TERMS = new Set(['passed', 'failed', 'error', 'errors', 'skipped', 'xfailed',
  'xpassed', 'deselected', 'warning', 'warnings'])
function pytestSummary(line) {
  const match = /^\s*(?:=+\s*)?(.+?)\s+in\s+([0-9]+(?:\.[0-9]+)?s)(?:\s*=+)?\s*$/u.exec(line)
  if (match === null) return null
  const counts = Object.create(null)
  for (const part of match[1].split(/,\s*/u)) {
    const row = /^([0-9]+) (passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?)$/u.exec(part)
    if (row === null || !PYTEST_TERMS.has(row[2]) || Object.hasOwn(counts, row[2])) return null
    const count = Number(row[1])
    if (!Number.isSafeInteger(count) || count > 1_000_000) return null
    counts[row[2]] = count
  }
  const singularError = counts.error ?? 0
  if (Object.hasOwn(counts, 'error') && Object.hasOwn(counts, 'errors')) return null
  const errors = singularError + (counts.errors ?? 0)
  const tests = ['passed', 'failed', 'skipped', 'xfailed', 'xpassed'].reduce((sum, key) =>
    sum + (counts[key] ?? 0), errors)
  return { tests, passed: counts.passed ?? 0, failed: counts.failed ?? 0, errors,
    skipped: counts.skipped ?? 0, xfailed: counts.xfailed ?? 0, xpassed: counts.xpassed ?? 0,
    deselected: counts.deselected ?? 0 }
}

function pytestMarkers(output, quiet, summaryIndex) {
  const clean = output.stdout.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
  const lines = clean.split(/\r?\n/u).slice(0, summaryIndex)
  const counts = { passed: 0, failed: 0, errors: 0, skipped: 0, xfailed: 0, xpassed: 0 }
  const addMarker = marker => {
    const key = ({ '.': 'passed', F: 'failed', E: 'errors', s: 'skipped',
      x: 'xfailed', X: 'xpassed' })[marker]
    if (key === undefined) return false
    counts[key] += 1
    return true
  }
  const addStatus = status => {
    const key = ({ PASSED: 'passed', FAILED: 'failed', ERROR: 'errors', SKIPPED: 'skipped',
      XFAIL: 'xfailed', XPASS: 'xpassed' })[status]
    if (key === undefined) return false
    counts[key] += 1
    return true
  }
  if (!quiet) {
    const itemRows = lines.map(line => /^\s*.+::.+\s+(PASSED|FAILED|SKIPPED|XFAIL|XPASS|ERROR)(?:\s+\[\s*[0-9]{1,3}%\])?\s*$/u.exec(line))
      .filter(Boolean)
    if (itemRows.length > 0) {
      if (!itemRows.every(row => addStatus(row[1]))) return null
      return counts
    }
  }
  const progress = lines.map(line => (quiet
    ? /^\s*([.FEsxX]+)\s*(?:\[\s*[0-9]{1,3}%\])?\s*$/u.exec(line)
    : /^\s*[^:]+\.py\s+([.FEsxX]+)\s*(?:\[\s*[0-9]{1,3}%\])?\s*$/u.exec(line)))
    .filter(Boolean)
  if (progress.length === 0) return null
  for (const row of progress) for (const marker of row[1]) if (!addMarker(marker)) return null
  return counts
}

function pytestResult(output, spec) {
  if (output.stderr !== '') return null
  const lines = output.stdout.split(/\r?\n/u)
  const summaries = lines.map((line, index) => ({ index, counts: pytestSummary(line) }))
    .filter(row => row.counts !== null)
  if (summaries.length !== 1) return null
  const summary = summaries[0]
  const markers = pytestMarkers(output, spec.arguments.includes('-q') || spec.arguments.includes('--quiet'),
    summary.index)
  if (markers === null || ['passed', 'failed', 'errors', 'skipped', 'xfailed', 'xpassed']
    .some(key => markers[key] !== (summary.counts[key] ?? 0))) return null
  const { tests, passed, failed, errors, skipped, xfailed, xpassed, deselected } = summary.counts
  const evidence = { kind: 'pytest', tests, passed, failed, errors, skipped, xfailed, xpassed, deselected }
  if (errors > 0 || tests < 1) return null
  if (output.exitCode === 0 && passed === tests && failed === 0 && skipped === 0
    && xfailed === 0 && xpassed === 0 && deselected === 0) return { status: 'pass', evidence }
  if (output.exitCode === 1 && failed > 0) return { status: 'fail', evidence }
  return null
}

/**
 * Recognize only direct foreground Node spec-runner and TypeScript noEmit invocations.
 * Evidence contains counts only; command text, source paths, and compiler diagnostics are never
 * returned to the caller for persistence.
 */
export function runDevelopmentChecker({ command, result } = {}) {
  const spec = developmentCommandSpec(command)
  const output = spec === null ? null : foregroundOutput(result)
  if (output === null) return { status: 'unknown', checkId: spec?.checkId ?? null, reason: 'unrecognized_execution' }
  const parsed = spec.checkId === DEVELOPMENT_CHECK_IDS.nodeTest ? nodeTestResult(output)
    : spec.checkId === DEVELOPMENT_CHECK_IDS.typeScript ? typeScriptResult(output)
      : pytestResult(output, spec)
  return parsed === null
    ? { status: 'unknown', checkId: spec.checkId, reason: 'incomplete_or_ambiguous_result' }
    : { ...parsed, checkId: spec.checkId }
}

export function runChecker(checkId, params) {
  const checker = Object.hasOwn(CHECKERS, checkId) ? CHECKERS[checkId] : null
  if (checker === null) return { status: 'not_applicable', checkId, reason: 'unknown_checker' }
  return checker(params)
}
