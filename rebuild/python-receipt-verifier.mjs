import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'
import { pythonReceiptCommandSpec } from './checker.mjs'
import { relativeInside } from './paths.mjs'

const MAX_SOURCE_BYTES = 32 * 1024
const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_OUTPUT_BYTES = 512 * 1024
const MAX_RUNTIME_MS = 10_000
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const unknown = reason => ({ status: 'unknown', reason })

function noSymlinkFile(root, relativePath, maxBytes) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > 512
    || relativePath.startsWith('/') || relativePath.includes('\\') || /[\u0000-\u001f\u007f]/u.test(relativePath)
    || relativePath.split('/').some(part => part === '' || part === '.' || part === '..')) return null
  const absolute = resolve(root, relativePath)
  if (absolute === root || relativeInside(absolute, root) === null) return null
  let cursor = root
  const parts = relativePath.split('/')
  try {
    for (let index = 0; index < parts.length; index += 1) {
      cursor = join(cursor, parts[index])
      const stat = lstatSync(cursor)
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) return null
      if (index === parts.length - 1 && (!stat.isFile() || stat.size > maxBytes)) return null
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

function canonicalWorkspaceRoots(workspaceRoots) {
  if (!Array.isArray(workspaceRoots)) return []
  return workspaceRoots.map(value => typeof value === 'string' ? value : value?.path)
    .filter(value => typeof value === 'string').map(value => {
      try { return realpathSync(value) } catch { return null }
    }).filter(value => value !== null)
}

async function activeBundleBinding(pluginManager, packageName) {
  if (typeof pluginManager?.listPlugins !== 'function' || typeof pluginManager?.listBundles !== 'function') return null
  try {
    const [plugins, bundles] = await Promise.all([pluginManager.listPlugins(), pluginManager.listBundles()])
    if (!Array.isArray(plugins) || !Array.isArray(bundles)) return null
    const matchingBundles = bundles.filter(bundle => bundle?.name === packageName)
    if (matchingBundles.length !== 1) return null
    const bundle = matchingBundles[0]
    if (bundle.installed !== true || bundle.enabled !== true || typeof bundle.version !== 'string'
      || bundle.version.length === 0 || bundle.error !== undefined) return null
    if (!Array.isArray(bundle.rows)) return null
    const joins = []
    for (const declared of bundle.rows) {
      if (typeof declared?.entryId !== 'string' || typeof declared.moduleName !== 'string'
        || typeof declared.rowId !== 'string') continue
      const matchingPlugins = plugins.filter(plugin => plugin?.entryId === declared.entryId
        && plugin.moduleName === declared.moduleName)
      if (matchingPlugins.length !== 1) continue
      const plugin = matchingPlugins[0]
      if (plugin.enabled !== true || plugin.fiberPhase !== 'active' || typeof plugin.patchId !== 'string'
        || plugin.patchId !== declared.rowId) continue
      joins.push({ packageName, version: bundle.version, entryId: plugin.entryId,
        moduleName: plugin.moduleName, patchId: plugin.patchId })
    }
    return joins.length === 1 ? joins[0] : null
  } catch { return null }
}

function readManifest(root, relativePath) {
  const file = noSymlinkFile(root, relativePath, MAX_MANIFEST_BYTES)
  if (file === null) return null
  try {
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes))
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)
      || typeof manifest.name !== 'string' || manifest.name.length > 214
      || !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/u.test(manifest.name)) return null
    return { file, packageName: manifest.name }
  } catch { return null }
}

function wrapperPaths(bytes) {
  let source
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return null }
  const pattern = /^\s*from\s+pathlib\s+import\s+Path\s*\r?\n\s*import\s+sys\s*,\s*runpy\s*\r?\n\s*p\s*=\s*Path\(\s*__file__\s*\)\.resolve\(\s*\)\.parent\s*\r?\n\s*sys\.argv\s*=\s*\[\s*str\(\s*p\.parent\s*\/\s*(['"])([^'"\r\n]+)\1\s*\)\s*,\s*str\(\s*p\s*\/\s*(['"])([^'"\r\n]+)\3\s*\)\s*\]\s*\r?\n\s*runpy\.run_path\(\s*sys\.argv\[0\]\s*,\s*run_name\s*=\s*(['"])__main__\5\s*\)\s*$/u
  const match = pattern.exec(source)
  const safe = value => typeof value === 'string' && value.length <= 256 && !value.startsWith('/')
    && !value.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
  if (match === null || !safe(match[2]) || !safe(match[4])
    || match[2].split('/').some(part => part === '.' || part === '..')
    || match[4].split('/').some(part => part === '.' || part === '..')) return null
  return { helperPath: match[2], receiptPath: match[4] }
}

function receiptFields(bytes) {
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return null }
  const fields = Object.create(null)
  for (const line of text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u)) {
    const separator = line.indexOf('=')
    if (separator >= 0) fields[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return fields
}

function executionTrace(handle) {
  const collected = handle?.collected?.stdout?.readFrom?.(0)
  if (collected?.lossy !== false || typeof collected.text !== 'string'
    || Buffer.byteLength(collected.text, 'utf8') > MAX_OUTPUT_BYTES) return null
  const stderr = handle?.collected?.stderr?.readFrom?.(0)
  if (stderr?.lossy !== false || stderr.text !== '') return null
  try {
    const trace = JSON.parse(collected.text)
    return trace !== null && typeof trace === 'object' && !Array.isArray(trace) ? trace : null
  } catch { return null }
}

function receiptSummary(reason, { version, binding, sources }) {
  const identity = `${binding.packageName}\u0000${binding.entryId}\u0000${binding.moduleName}`
    + `\u0000${binding.patchId}\u0000${binding.version}`
  return { kind: 'python_receipt_contract', entries: 2, receiptReads: 2,
    versionHash: hash(Buffer.from(version, 'utf8')),
    bindingHash: hash(Buffer.from(identity, 'utf8')),
    sourceHash: hash(Buffer.from(sources.map(([path, file]) => `${path}:${hash(file.bytes)}`).join('\n'), 'utf8')),
    reason }
}

/** Execute only the recognized paired MSE receipt entry wrappers in the host native read-only sandbox. */
export async function verifyPythonReceiptContract({ command, projectManifest, workspaceRoot, workspaceRoots,
  pluginManager, subprocess, sandbox, signal, sourceAdmit, materialAdmit } = {}) {
  if (signal?.aborted === true) return unknown('cancelled')
  const spec = pythonReceiptCommandSpec(command)
  if (spec === null || typeof projectManifest !== 'string') return unknown('unrecognized_command')
  if (subprocess?.resolveExecutable === undefined || subprocess?.spawn === undefined
    || sandbox?.confine === undefined || typeof workspaceRoot !== 'string'
    || typeof sourceAdmit !== 'function' || typeof materialAdmit !== 'function') return unknown('execution_unavailable')

  let root
  try { root = realpathSync(workspaceRoot) } catch { return unknown('workspace_unavailable') }
  const roots = canonicalWorkspaceRoots(workspaceRoots)
  if (!roots.some(value => relativeInside(root, value) !== null)) return unknown('workspace_unavailable')

  const intakePath = spec.scriptPath
  const counterPath = posix.join(posix.dirname(intakePath), 'counter.py')
  const files = new Map()
  const initialPaths = [intakePath, counterPath, projectManifest]
  for (const path of initialPaths) {
    const maxBytes = path === projectManifest ? MAX_MANIFEST_BYTES
      : path.endsWith('.py') ? MAX_SOURCE_BYTES : MAX_SOURCE_BYTES
    const file = noSymlinkFile(root, path, maxBytes)
    if (file === null) return unknown('source_unavailable')
    files.set(path, file)
  }
  const intakePaths = wrapperPaths(files.get(intakePath).bytes)
  const counterPaths = wrapperPaths(files.get(counterPath).bytes)
  if (intakePaths === null || counterPaths === null || intakePaths.helperPath !== counterPaths.helperPath
    || intakePaths.receiptPath === counterPaths.receiptPath) return unknown('unsupported_source')
  const helperPath = posix.normalize(posix.join(posix.dirname(intakePath), '..', intakePaths.helperPath))
  const earlyPath = posix.normalize(posix.join(posix.dirname(intakePath), intakePaths.receiptPath))
  const latePath = posix.normalize(posix.join(posix.dirname(counterPath), counterPaths.receiptPath))
  const paths = [intakePath, counterPath, helperPath, earlyPath, latePath, projectManifest]
  for (const path of [helperPath, earlyPath, latePath]) {
    if (files.has(path)) continue
    const file = noSymlinkFile(root, path, MAX_SOURCE_BYTES)
    if (file === null) return unknown('source_unavailable')
    files.set(path, file)
  }
  const manifest = readManifest(root, projectManifest)
  if (manifest === null || !manifest.file.bytes.equals(files.get(projectManifest).bytes)) {
    return unknown('project_manifest_unavailable')
  }
  const material = [...files].map(([path, file]) => `${path}\n${file.bytes.toString('utf8')}`).join('\n')
  const admissionFailure = () => {
    try {
      if (sourceAdmit() !== true) return 'source_unadmitted'
      if (materialAdmit(material, { workspaceRoot: root, projectManifest, sourcePaths: paths }) !== true) {
        return 'material_unadmitted'
      }
      return null
    } catch { return 'admission_unavailable' }
  }
  const initialAdmission = admissionFailure()
  if (initialAdmission !== null) return unknown(initialAdmission)

  const binding = await activeBundleBinding(pluginManager, manifest.packageName)
  if (binding === null) return unknown('host_identity_ambiguous')
  const snapshot = mkdtempSync(join(tmpdir(), 'mse-python-receipt-'))
  let timeout
  let deadline
  let handle
  try {
    const runner = readFileSync(new URL('./python-receipt-runner.py', import.meta.url))
    for (const [path, file] of files) {
      const target = join(snapshot, ...path.split('/'))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.bytes, { mode: 0o444 })
    }
    writeFileSync(join(snapshot, 'mse-python-receipt-runner.py'), runner, { mode: 0o444 })

    const executable = await subprocess.resolveExecutable(spec.executable, undefined, signal)
    if (signal?.aborted === true) return unknown('cancelled')
    const argv = [executable, '-I', '-S', '-B', 'mse-python-receipt-runner.py',
      intakePath, counterPath, helperPath, earlyPath, latePath]
    const confinement = await sandbox.confine(argv, { mode: 'read-only', workspaceRoot: snapshot })
    if (confinement?.enforcement !== 'full' || !Array.isArray(confinement.argv)
      || confinement.argv.some(value => typeof value !== 'string')) return unknown('sandbox_unavailable')
    const currentAdmission = admissionFailure()
    if (currentAdmission !== null) return unknown(currentAdmission)
    const currentManifest = readManifest(root, projectManifest)
    const currentBinding = await activeBundleBinding(pluginManager, manifest.packageName)
    if (currentManifest === null || !currentManifest.file.bytes.equals(manifest.file.bytes)
      || currentBinding === null || JSON.stringify(currentBinding) !== JSON.stringify(binding)) {
      return unknown('host_or_manifest_changed')
    }

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
    const trace = executionTrace(handle)
    if (trace?.recognized !== true || !Array.isArray(trace.entries) || trace.entries.length !== 2) {
      return unknown(trace?.reason === 'unsupported_source' ? 'unsupported_source' : 'runner_output_invalid')
    }
    if (trace.entries[0]?.entry !== 'intake.py' || trace.entries[1]?.entry !== 'counter.py'
      || trace.entries[0]?.receiptReadCount !== 1 || trace.entries[1]?.receiptReadCount !== 1) {
      return unknown('receipt_read_not_observed')
    }
    if (trace.entries.some(row => !Number.isSafeInteger(row.exitCode)
      || typeof row.stdout !== 'string' || typeof row.stderr !== 'string')) {
      return unknown('execution_evidence_missing')
    }
    if (trace.entries[0]?.receipt !== realpathSync(join(snapshot, ...earlyPath.split('/')))
      || trace.entries[1]?.receipt !== realpathSync(join(snapshot, ...latePath.split('/')))) {
      return unknown('receipt_read_not_observed')
    }
    for (const path of paths) {
      if (!stableFile(root, path, path === projectManifest ? MAX_MANIFEST_BYTES
        : path.endsWith('.py') ? MAX_SOURCE_BYTES : MAX_SOURCE_BYTES, files.get(path))) {
        return unknown('source_changed')
      }
    }
    const finalManifest = readManifest(root, projectManifest)
    const finalBinding = await activeBundleBinding(pluginManager, manifest.packageName)
    if (finalManifest === null || !finalManifest.file.bytes.equals(manifest.file.bytes)
      || finalBinding === null || JSON.stringify(finalBinding) !== JSON.stringify(binding)) {
      return unknown('host_or_manifest_changed')
    }
    const finalAdmission = admissionFailure()
    if (finalAdmission !== null) return unknown(finalAdmission)

    const receipts = [files.get(earlyPath), files.get(latePath)].map(file => receiptFields(file.bytes))
    if (receipts.some(fields => fields === null)) return unknown('receipt_parse_unavailable')
    if (receipts.some(fields => typeof fields.loadedVersion !== 'string' || fields.loadedVersion.trim() === '')) {
      const summary = receiptSummary('missing_loaded_version', { version: binding.version, binding, sources: [...files] })
      return { status: 'fail', reason: summary.reason, summary }
    }
    if (receipts.some(fields => typeof fields.candidateFile !== 'string' || fields.candidateFile.trim() === '')) {
      const summary = receiptSummary('candidate_file_missing', { version: binding.version, binding, sources: [...files] })
      return { status: 'fail', reason: summary.reason, summary }
    }
    if (receipts.some(fields => fields.loadedVersion.trim() !== binding.version)) {
      const summary = receiptSummary('wrong_loaded_version', { version: binding.version, binding, sources: [...files] })
      return { status: 'fail', reason: summary.reason, summary }
    }
    if (trace.entries.some(row => row.exitCode !== 0)) {
      const summary = receiptSummary('probe_exit_nonzero', { version: binding.version, binding, sources: [...files] })
      return { status: 'fail', reason: summary.reason, summary }
    }
    if (trace.entries.some(row => row.stderr !== '')) {
      return unknown('execution_evidence_missing')
    }
    const summary = receiptSummary('matched', { version: binding.version, binding, sources: [...files] })
    return { status: 'pass', reason: 'matched', summary }
  } catch {
    if (signal?.aborted === true) return unknown('cancelled')
    if (deadline?.signal.aborted === true) return unknown('timeout')
    return unknown('execution_failed')
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    try { await handle?.terminate?.() } catch { /* provider already settled */ }
    rmSync(snapshot, { recursive: true, force: true })
  }
}
