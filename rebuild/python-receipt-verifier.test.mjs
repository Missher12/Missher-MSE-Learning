import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { verifyPythonReceiptContract } from './python-receipt-verifier.mjs'

const PYTHON = ['python3', 'python', 'python3.exe', 'python.exe'].find(executable =>
  spawnSync(executable, ['-I', '-S', '-B', '-c', 'import sys'], { encoding: 'utf8', timeout: 5000 }).status === 0)
const NATIVE_TEST_OPTIONS = PYTHON === undefined
  ? { skip: 'Python interpreter unavailable on this host' } : {}
const PACKAGE_NAME = '@example/mse-plugin'
const VERSION = '3.7.1'
const COMMAND = 'python3 sample-project/probes/entry-pair/intake.py'
const PROJECT_MANIFEST = 'sample-project/development/package.json'
const INTAKE = `from pathlib import Path
import sys,runpy
p=Path(__file__).resolve().parent
sys.argv=[str(p.parent/'gates/receipt_guard.py'),str(p/'receipts/a.txt')]
runpy.run_path(sys.argv[0],run_name='__main__')
`
const COUNTER = INTAKE.replace('receipts/a.txt', 'receipts/b.txt')
const GUARD = `import sys
from pathlib import Path
p = Path(sys.argv[1])
fields = dict(line.split("=", 1) for line in p.read_text().splitlines() if "=" in line)
if not fields.get("loadedVersion", "").strip():
    print("loadedVersion missing", file=sys.stderr)
    raise SystemExit(7)
print("receipt accepted")
`

function writeFixture(root, { first = `candidateFile=alpha.tgz\nloadedVersion=${VERSION}\n`,
  second = `candidateFile=beta.tgz\nloadedVersion=${VERSION}\n`, intake = INTAKE,
  counter = COUNTER, guard = GUARD } = {}) {
  const pair = join(root, 'sample-project', 'probes', 'entry-pair')
  mkdirSync(join(pair, 'receipts'), { recursive: true })
  mkdirSync(join(root, 'sample-project', 'probes', 'gates'), { recursive: true })
  mkdirSync(join(root, 'sample-project', 'development'), { recursive: true })
  writeFileSync(join(root, PROJECT_MANIFEST), JSON.stringify({ name: PACKAGE_NAME, version: '0.0.0-wrong' }))
  writeFileSync(join(pair, 'intake.py'), intake)
  writeFileSync(join(pair, 'counter.py'), counter)
  writeFileSync(join(root, 'sample-project', 'probes', 'gates', 'receipt_guard.py'), guard)
  writeFileSync(join(pair, 'receipts', 'a.txt'), first)
  writeFileSync(join(pair, 'receipts', 'b.txt'), second)
}

function manager({ version = VERSION, duplicate = false, onBundles } = {}) {
  const plugin = { entryId: 'include:example-mse', moduleName: 'example-mse', enabled: true,
    fiberPhase: 'active', patchId: 'sample-patch' }
  const plugins = duplicate ? [plugin, { ...plugin }] : [plugin]
  const bundle = { name: PACKAGE_NAME, version, installed: true, enabled: true, rows: [
    { rowId: 'sample-patch', moduleName: 'example-mse', entryId: 'include:example-mse' },
  ] }
  return {
    async listPlugins() { return plugins },
    async listBundles() { return onBundles?.() ?? [bundle] },
  }
}

async function createRuntime(t) {
  const root = mkdtempSync(join(homedir(), '.mse-python-receipt-'))
  writeFixture(root)
  const ctx = new Context().root
  const sandboxFiber = ctx.registry.plugin(LocalSandboxProvider, {
    runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000,
  })
  await sandboxFiber
  const subprocessFiber = ctx.registry.plugin(LocalSubprocessRuntime)
  await subprocessFiber
  let nativeAvailable = false
  try {
    const probe = await ctx.sandbox.confine([PYTHON, '-I', '-S', '-B'],
      { mode: 'read-only', workspaceRoot: root })
    nativeAvailable = probe?.enforcement === 'full'
  } catch { /* the verifier tests below skip without actual enforcement */ }
  t.after(async () => {
    await subprocessFiber.dispose()
    await sandboxFiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, ctx, nativeAvailable }
}

async function check(fixture, host = manager(), options = {}) {
  return verifyPythonReceiptContract({ command: COMMAND, projectManifest: PROJECT_MANIFEST,
    workspaceRoot: fixture.root, workspaceRoots: [{ path: realpathSync(fixture.root) }],
    pluginManager: host, subprocess: fixture.ctx.subprocess, sandbox: fixture.ctx.sandbox,
    sourceAdmit: options.sourceAdmit ?? (() => true), materialAdmit: options.materialAdmit ?? (() => true),
    signal: options.signal,
  })
}

test('the native receipt checker follows dynamically declared helper and receipt paths and trusts only the active bundle version', NATIVE_TEST_OPTIONS, async t => {
  const fixture = await createRuntime(t)
  if (!fixture.nativeAvailable) { t.skip('native LocalSandboxProvider does not report full read-only enforcement here'); return }
  const checked = await check(fixture)
  assert.deepEqual({ status: checked.status, reason: checked.reason }, { status: 'pass', reason: 'matched' })
  assert.equal(checked.summary.kind, 'python_receipt_contract')
  assert.equal(checked.summary.entries, 2)
  assert.equal(checked.summary.receiptReads, 2)
})

test('exit zero with a wrong nonempty version fails and a one-entry repair cannot pass', NATIVE_TEST_OPTIONS, async t => {
  const fixture = await createRuntime(t)
  if (!fixture.nativeAvailable) { t.skip('native LocalSandboxProvider does not report full read-only enforcement here'); return }
  writeFixture(fixture.root, { first: `candidateFile=alpha.tgz\nloadedVersion=9.9.9\n` })
  const wrong = await check(fixture)
  assert.deepEqual({ status: wrong.status, reason: wrong.reason },
    { status: 'fail', reason: 'wrong_loaded_version' })

  writeFixture(fixture.root, { second: 'candidateFile=beta.tgz\n' })
  const partial = await check(fixture)
  assert.deepEqual({ status: partial.status, reason: partial.reason },
    { status: 'fail', reason: 'missing_loaded_version' })
})

test('candidateFile cannot substitute for loadedVersion, print-only wrappers and ambiguous host evidence stay unknown', NATIVE_TEST_OPTIONS, async t => {
  const fixture = await createRuntime(t)
  if (!fixture.nativeAvailable) { t.skip('native LocalSandboxProvider does not report full read-only enforcement here'); return }
  writeFixture(fixture.root, { first: `candidateFile=${VERSION}\n`, second: `candidateFile=${VERSION}\n` })
  const candidateOnly = await check(fixture)
  assert.deepEqual({ status: candidateOnly.status, reason: candidateOnly.reason },
    { status: 'fail', reason: 'missing_loaded_version' })

  writeFixture(fixture.root, { intake: `print("receipt accepted")\n` })
  const printOnly = await check(fixture)
  assert.equal(printOnly.status, 'unknown')

  writeFixture(fixture.root)
  const ambiguous = await check(fixture, manager({ duplicate: true }))
  assert.deepEqual({ status: ambiguous.status, reason: ambiguous.reason },
    { status: 'unknown', reason: 'host_identity_ambiguous' })

  for (const guard of [
    GUARD.replace('if "=" in line)', 'if "=" in (str(print("NOT_ALLOWED_EXTRA_EXECUTION")) + line))'),
    GUARD.replace('raise SystemExit(7)', 'raise SystemExit(7) from print("NOT_ALLOWED_EXTRA_EXECUTION")'),
  ]) {
    writeFixture(fixture.root, { guard })
    const unsupported = await check(fixture)
    assert.deepEqual({ status: unsupported.status, reason: unsupported.reason },
      { status: 'unknown', reason: 'unsupported_source' })
  }
})

test('a changed host bundle version during execution stays unknown', NATIVE_TEST_OPTIONS, async t => {
  const fixture = await createRuntime(t)
  if (!fixture.nativeAvailable) { t.skip('native LocalSandboxProvider does not report full read-only enforcement here'); return }
  let bundleReads = 0
  const host = manager({ onBundles() {
    bundleReads += 1
    const current = bundleReads >= 3 ? '4.0.0' : VERSION
    return [{ name: PACKAGE_NAME, version: current, installed: true, enabled: true,
      rows: [{ rowId: 'sample-patch', moduleName: 'example-mse', entryId: 'include:example-mse' }] }]
  } })
  const checked = await check(fixture, host)
  assert.equal(checked.status, 'unknown')
  assert.equal(checked.reason, 'host_or_manifest_changed')
})

test('source refusal, source mutation and cancellation stay unknown', NATIVE_TEST_OPTIONS, async t => {
  const fixture = await createRuntime(t)
  if (!fixture.nativeAvailable) { t.skip('native LocalSandboxProvider does not report full read-only enforcement here'); return }
  const refused = await check(fixture, manager(), { sourceAdmit: () => false })
  assert.deepEqual({ status: refused.status, reason: refused.reason },
    { status: 'unknown', reason: 'source_unadmitted' })

  let admissions = 0
  const changed = await check(fixture, manager(), { sourceAdmit() {
    admissions += 1
    if (admissions === 2) writeFileSync(join(fixture.root, 'sample-project/probes/entry-pair/receipts/a.txt'),
      `candidateFile=alpha.tgz\nloadedVersion=${VERSION}\nchanged=true\n`)
    return true
  } })
  assert.deepEqual({ status: changed.status, reason: changed.reason },
    { status: 'unknown', reason: 'source_changed' })

  const aborted = new AbortController()
  aborted.abort()
  const cancelled = await check(fixture, manager(), { signal: aborted.signal })
  assert.deepEqual({ status: cancelled.status, reason: cancelled.reason },
    { status: 'unknown', reason: 'cancelled' })
})
