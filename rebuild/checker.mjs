/**
 * Real deterministic checkers — actual programs, not claims.
 *
 * A checker turns an objective fact about the world into pass/fail with a bounded reason code.
 * Exit code 0 of an arbitrary command and model prose never reach this path; only the checker's
 * own evaluation does. Results carry counts and reason codes only — never file contents.
 */
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const MAX_FILE_BYTES = 256 * 1024

function safeFile(root, rel) {
  if (typeof root !== 'string' || root === '' || typeof rel !== 'string' || rel === '' || rel.length > 512
    || rel.includes('\u0000') || rel.startsWith('/')) return null
  const target = resolve(join(root, rel))
  const base = resolve(root)
  if (!target.startsWith(`${base}/`)) return null
  try {
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
})
const SAFE_LOCAL_PATH = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./*-]+$/u

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
  if (executable(args[0], 'node') && args[1] === '--test'
    && args.slice(2).every(arg => SAFE_LOCAL_PATH.test(arg)
      && (!arg.includes('*') || /(?:^|\/)[*][A-Za-z0-9_.-]*\.(?:test|spec)\.(?:mjs|cjs|js|ts)$/u.test(arg)))) {
    return { checkId: DEVELOPMENT_CHECK_IDS.nodeTest, arguments: args.slice(1) }
  }
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

/** Exact normalized verification matcher shared by stored lessons and observed foreground calls. */
export function developmentCheckIdForCommand(command) {
  return developmentCommandSpec(command)?.checkId ?? null
}

export function developmentCheckMatchesVerification(verificationCheck, command) {
  const actual = developmentCommandSpec(command)
  if (actual === null || typeof verificationCheck !== 'string') return false
  if (verificationCheck === actual.checkId) return true // existing internal IDs stay compatible
  const declared = developmentCommandSpec(verificationCheck)
  return declared !== null && declared.checkId === actual.checkId
    && declared.arguments.length === actual.arguments.length
    && declared.arguments.every((part, index) => part === actual.arguments[index])
}

function foregroundOutput(result) {
  const value = result?.value
  if (result?.isError !== false || value?.kind !== 'foreground'
    || typeof value.cwd !== 'string' || !value.cwd.startsWith('/')
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
    : typeScriptResult(output)
  return parsed === null
    ? { status: 'unknown', checkId: spec.checkId, reason: 'incomplete_or_ambiguous_result' }
    : { ...parsed, checkId: spec.checkId }
}

export function runChecker(checkId, params) {
  const checker = Object.hasOwn(CHECKERS, checkId) ? CHECKERS[checkId] : null
  if (checker === null) return { status: 'not_applicable', checkId, reason: 'unknown_checker' }
  return checker(params)
}
