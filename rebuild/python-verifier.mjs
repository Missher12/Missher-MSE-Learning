import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pythonCommandSpec } from './checker.mjs'
import { relativeInside } from './paths.mjs'

const MAX_INPUT_BYTES = 64 * 1024
const MAX_SCRIPT_BYTES = 32 * 1024
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_RUNTIME_MS = 10_000
const SAFE_RELATIVE_FILE = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+$/u
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const unknown = reason => ({ status: 'unknown', reason })

function noSymlinkFile(root, relativePath, maxBytes) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > 512
    || !SAFE_RELATIVE_FILE.test(relativePath) || relativePath.startsWith('/')
    || relativePath.includes('\\') || relativePath.split('/').some(part => part === '' || part === '.' || part === '..')) return null
  const absolute = resolve(root, relativePath)
  if (relativeInside(absolute, root) === null || absolute === root) return null
  let cursor = root
  const parts = relativePath.split('/')
  try {
    for (let i = 0; i < parts.length; i += 1) {
      cursor = join(cursor, parts[i])
      const stat = lstatSync(cursor)
      if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) return null
      if (i === parts.length - 1 && (!stat.isFile() || stat.size > maxBytes)) return null
    }
    const real = realpathSync(absolute)
    if (relativeInside(real, root) === null || real !== absolute) return null
    const stat = lstatSync(absolute)
    const bytes = readFileSync(absolute)
    if (bytes.length > maxBytes) return null
    return { absolute, bytes, identity: [stat.dev, stat.ino, stat.size, stat.mtimeMs] }
  } catch { return null }
}

function stableFile(root, relativePath, maxBytes, before) {
  const after = noSymlinkFile(root, relativePath, maxBytes)
  return after !== null && before.identity.every((part, index) => part === after.identity[index])
    && before.bytes.equals(after.bytes)
}

function decodedOracle(bytes) {
  let bomCount = 0
  while (bytes.subarray(bomCount * 3, bomCount * 3 + 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) bomCount += 1
  if (bomCount < 1 || bomCount > 8) return null
  const bomInputHashes = []
  for (let stripped = 0; stripped < bomCount; stripped += 1) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(stripped * 3))
      bomInputHashes.push(hash(Buffer.from(text, 'utf8')))
    } catch { /* the normalized source is still checked below */ }
  }
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(bomCount * 3)) }
  catch { return null }
  text = text.replace(/^\uFEFF+/u, '')
  try { return { bomCount, text, value: JSON.parse(text), parseInputHash: hash(Buffer.from(text, 'utf8')), bomInputHashes } }
  catch { return null }
}

function traceFrom(output) {
  const collected = output?.collected?.stdout?.readFrom?.(0)
  if (collected?.lossy !== false || typeof collected?.text !== 'string'
    || Buffer.byteLength(collected.text, 'utf8') > MAX_OUTPUT_BYTES) return null
  const stderr = output?.collected?.stderr?.readFrom?.(0)
  if (stderr?.lossy !== false || typeof stderr?.text !== 'string' || stderr.text !== '') return null
  try {
    const trace = JSON.parse(collected.text)
    return trace !== null && typeof trace === 'object' && !Array.isArray(trace) ? trace : null
  } catch { return null }
}

/** Run one recognized read-only Python JSON loader against frozen workspace copies. */
export async function verifyPythonJsonLoader({ command, inputPath, workspaceRoot, workspaceRoots,
  subprocess, sandbox, session, signal, sourceAdmit, materialAdmit } = {}) {
  if (signal?.aborted === true) return unknown('cancelled')
  const commandSpec = pythonCommandSpec(command)
  if (commandSpec === null || typeof inputPath !== 'string' || !inputPath.endsWith('.json')) {
    return unknown('unrecognized_command')
  }
  if (subprocess?.resolveExecutable === undefined || subprocess?.spawn === undefined
    || sandbox?.confine === undefined || typeof workspaceRoot !== 'string'
    || !Array.isArray(workspaceRoots) || workspaceRoots.length === 0
    || typeof sourceAdmit !== 'function' || typeof materialAdmit !== 'function') {
    return unknown('execution_unavailable')
  }

  let root
  try { root = realpathSync(workspaceRoot) } catch { return unknown('workspace_unavailable') }
  const roots = workspaceRoots.map(value => typeof value === 'string' ? value : value?.path)
    .filter(value => typeof value === 'string').map(value => {
      try { return realpathSync(value) } catch { return null }
    }).filter(value => value !== null)
  if (!roots.some(value => relativeInside(root, value) !== null)) {
    return unknown('workspace_unavailable')
  }
  const scriptPath = commandSpec.scriptPath
  if (dirname(scriptPath) !== dirname(inputPath) || basename(scriptPath) === 'mse-python-runner.py'
    || basename(inputPath) === 'mse-python-runner.py') return unknown('input_not_adjacent')
  const script = noSymlinkFile(root, scriptPath, MAX_SCRIPT_BYTES)
  const input = noSymlinkFile(root, inputPath, MAX_INPUT_BYTES)
  if (script === null || input === null) return unknown('file_unavailable')
  const oracle = decodedOracle(input.bytes)
  if (oracle === null) return unknown('source_not_bom_json')
  const fullMaterial = `${script.bytes.toString('utf8')}\n${input.bytes.toString('utf8')}`
  const admissionFailure = () => {
    try {
      if (sourceAdmit() !== true) return 'source_unadmitted'
      if (materialAdmit(fullMaterial, { workspaceRoot: root, scriptPath, inputPath }) !== true) {
        return 'material_unadmitted'
      }
      return null
    } catch { return 'admission_unavailable' }
  }
  const initialAdmission = admissionFailure()
  if (initialAdmission !== null) return unknown(initialAdmission)

  const snapshot = mkdtempSync(join(tmpdir(), 'mse-python-verify-'))
  let timeout
  let deadline
  let handle
  try {
    const runner = readFileSync(new URL('./python-json-runner.py', import.meta.url))
    const copy = (relativePath, bytes) => {
      const target = join(snapshot, ...relativePath.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes, { mode: 0o444 })
    }
    copy(scriptPath, script.bytes)
    copy(inputPath, input.bytes)
    writeFileSync(join(snapshot, 'mse-python-runner.py'), runner, { mode: 0o444 })

    const executable = await subprocess.resolveExecutable(commandSpec.executable, undefined, signal)
    if (signal?.aborted === true) return unknown('cancelled')
    const argv = [executable, '-I', '-S', '-B', 'mse-python-runner.py', scriptPath, inputPath]
    const confinement = await sandbox.confine(argv, { mode: 'read-only', workspaceRoot: snapshot })
    if (confinement?.enforcement !== 'full' || !Array.isArray(confinement.argv)
      || confinement.argv.some(value => typeof value !== 'string')) return unknown('sandbox_unavailable')
    const currentAdmission = admissionFailure()
    if (currentAdmission !== null) return unknown(currentAdmission)

    deadline = new AbortController()
    timeout = setTimeout(() => deadline.abort(), MAX_RUNTIME_MS)
    const combinedSignal = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal])
    handle = subprocess.spawn({ argv: confinement.argv, cwd: snapshot,
    stdio: { stdin: 'ignore', stdout: { maxBytes: MAX_OUTPUT_BYTES }, stderr: { maxBytes: 64 * 1024 } },
      graceMs: 500, signal: combinedSignal })
    const exit = await handle.done
    await handle.waitForExit()
    if (signal?.aborted === true) return unknown('cancelled')
    if (deadline.signal.aborted) return unknown('timeout')
    if (exit?.exitCode !== 0 || exit?.signal !== null) return unknown('runner_failed')

    const trace = traceFrom(handle)
    if (trace === null || trace.recognized !== true) return unknown(trace?.reason === 'unsupported_script'
      ? 'unsupported_script' : 'runner_output_invalid')
    if (!stableFile(root, scriptPath, MAX_SCRIPT_BYTES, script)
      || !stableFile(root, inputPath, MAX_INPUT_BYTES, input)) return unknown('source_changed')
    if (trace.readCount !== 1 || trace.readMatched !== true || trace.parseCount !== 1
      || typeof trace.parseInputHash !== 'string') return unknown('execution_evidence_missing')
    if (trace.outputOverflow === true) return unknown('target_output_limit')
    if (typeof trace.targetExitCode !== 'number' || !Number.isSafeInteger(trace.targetExitCode)) {
      return unknown('execution_evidence_missing')
    }

    let reason
    if (trace.parseInputHash !== oracle.parseInputHash) {
      if (oracle.bomInputHashes.includes(trace.parseInputHash)) reason = 'bom_not_stripped'
      else return unknown('parser_input_changed')
    } else if (trace.parseSucceeded !== true) reason = 'parse_error'
    else {
      let printed
      try {
        if (typeof trace.targetStdout !== 'string' || trace.targetStdout.trim() === '') throw new Error()
        printed = JSON.parse(trace.targetStdout)
      } catch { printed = null }
      const matches = isDeepStrictEqual(printed, { ok: true, config: oracle.value })
        && trace.dumpsUsedParseResult === true && trace.targetError === null
        && trace.targetExitCode === 0
        && trace.targetStderr === '' && trace.deniedPaths === 0 && trace.writeAttempts === 0
      if (matches) {
        return { status: 'pass', reason: 'matched', summary: { kind: 'python_json_loader',
          bytes: input.bytes.length, inputHash: hash(input.bytes), bomCount: oracle.bomCount,
          reads: 1, parses: 1, reason: 'matched' } }
      }
      reason = trace.writeAttempts > 0 ? 'source_write_attempted' : 'output_mismatch'
    }
    if (trace.writeAttempts > 0) reason = 'source_write_attempted'
    return { status: 'fail', reason, summary: { kind: 'python_json_loader',
      bytes: input.bytes.length, inputHash: hash(input.bytes), bomCount: oracle.bomCount,
      reads: 1, parses: 1, reason } }
  } catch {
    if (signal?.aborted === true) return unknown('cancelled')
    if (deadline?.signal.aborted === true) return unknown('timeout')
    return unknown('execution_failed')
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    try { await handle?.terminate?.() } catch { /* the provider already settled */ }
    rmSync(snapshot, { recursive: true, force: true })
  }
}
