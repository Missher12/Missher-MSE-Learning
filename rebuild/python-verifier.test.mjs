import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { verifyPythonJsonLoader } from './python-verifier.mjs'

const SCRIPT = `from pathlib import Path
import json
source_path = Path(__file__).with_name("input.json")
raw = source_path.read_bytes()
while raw.startswith(b"\\xef\\xbb\\xbf"):
    raw = raw[3:]
config = json.loads(raw.decode("utf-8").lstrip("\\ufeff"))
print(json.dumps({"ok": True, "config": config}, ensure_ascii=False))
`

const PYTHON_EXECUTABLE = [process.env.PYTHON, process.env.PYTHON3, 'python3', 'python']
  .filter((value, index, values) => typeof value === 'string' && value !== '' && values.indexOf(value) === index)
  .find(executable => spawnSync(executable, ['-I', '-S', '-B', '-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8', timeout: 5000,
  }).status === 0) ?? null
const PYTHON_TEST_OPTIONS = PYTHON_EXECUTABLE === null
  ? { skip: 'Python runtime unavailable on this host' } : {}

function runtimeFixture() {
  const calls = []
  const runs = []
  return {
    calls,
    runs,
    sandbox: {
      async confine(argv, policy) {
        assert.equal(policy.mode, 'read-only')
        assert.ok(policy.workspaceRoot)
        calls.push({ argv, policy })
        return { argv, enforcement: 'full' }
      },
    },
    subprocess: {
      async resolveExecutable() { return PYTHON_EXECUTABLE },
      spawn(spec) {
        const run = spawnSync(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd,
          encoding: 'utf8', timeout: 20_000, maxBuffer: 32 * 1024 })
        runs.push(run)
        const reader = text => ({ readFrom: () => ({ text, lossy: false }) })
        return { done: Promise.resolve({ exitCode: run.status, signal: run.signal }),
          waitForExit: async () => {}, terminate: async () => {},
          collected: { stdout: reader(run.stdout ?? ''), stderr: reader(run.stderr ?? '') } }
      },
    },
  }
}

async function verify({ script = SCRIPT, input = Buffer.from('\xef\xbb\xbf\xef\xbb\xbf{"a":1}', 'binary'),
  scriptPath = 'verify.py', inputPath = 'input.json', runtime = runtimeFixture(),
  sourceAdmit = () => true, materialAdmit = () => true } = {}) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'mse-python-verifier-test-'))
  try {
    mkdirSync(join(workspaceRoot, '.mse-evolution', 'verify'), { recursive: true })
    writeFileSync(join(workspaceRoot, scriptPath), script)
    writeFileSync(join(workspaceRoot, inputPath), input)
    const result = await verifyPythonJsonLoader({ command: `python3 ${scriptPath}`, inputPath,
      workspaceRoot, workspaceRoots: [workspaceRoot], subprocess: runtime.subprocess, sandbox: runtime.sandbox,
      session: { id: 'python-test-session' }, sourceAdmit, materialAdmit,
      signal: new AbortController().signal })
    return { result, runtime, workspaceRoot, inputBefore: input }
  } catch (error) {
    rmSync(workspaceRoot, { recursive: true, force: true })
    throw error
  }
}

test('the verifier runs a recognized BOM loader once and preserves the source file', PYTHON_TEST_OPTIONS, async () => {
  const { result, workspaceRoot, inputBefore, runtime } = await verify()
  try {
    assert.equal(result.status, 'pass', result.reason)
    assert.deepEqual(result.summary, { kind: 'python_json_loader', bytes: inputBefore.length,
      inputHash: result.summary.inputHash, bomCount: 2, reads: 1, parses: 1, reason: 'matched' })
    assert.deepEqual(readFileSync(join(workspaceRoot, 'input.json')), inputBefore)
    assert.equal(runtime.calls.length, 1)
  } finally { rmSync(workspaceRoot, { recursive: true, force: true }) }
})

test('a real parse followed by wrong output is an objective failure', PYTHON_TEST_OPTIONS, async () => {
  const wrong = SCRIPT.replace('{"ok": True, "config": config}', '{"ok": True, "config": {"a": 2}}')
  const { result, workspaceRoot } = await verify({ script: wrong })
  try {
    assert.equal(result.status, 'fail', result.reason)
    assert.equal(result.summary.reason, 'output_mismatch')
    assert.equal(result.summary.parses, 1)
  } finally { rmSync(workspaceRoot, { recursive: true, force: true }) }
})

test('unsupported and hardcoded scripts are unknown and never execute their body', PYTHON_TEST_OPTIONS, async () => {
  const markerScript = `from pathlib import Path\nPath(__file__).with_name("ran.txt").write_text("ran")\n`
  const { result, workspaceRoot, runtime } = await verify({ script: markerScript })
  try {
    assert.equal(result.status, 'unknown')
    assert.equal(result.reason, 'unsupported_script')
    assert.equal(runtime.calls.length, 1, 'only the trusted validator process is launched')
    assert.equal(JSON.parse(runtime.runs[0].stdout).recognized, false)
  } finally { rmSync(workspaceRoot, { recursive: true, force: true }) }
})

test('the current source and complete script plus JSON pass admission before a snapshot runs', PYTHON_TEST_OPTIONS, async () => {
  let admittedMaterial = ''
  const denied = await verify({ materialAdmit(material) { admittedMaterial = material; return false } })
  try {
    assert.equal(denied.result.status, 'unknown')
    assert.equal(denied.result.reason, 'material_unadmitted')
    assert.match(admittedMaterial, /source_path\.read_bytes/u)
    assert.match(admittedMaterial, /"a":1/u)
    assert.equal(denied.runtime.calls.length, 0)
    assert.equal(denied.runtime.runs.length, 0)
  } finally { rmSync(denied.workspaceRoot, { recursive: true, force: true }) }

  const revoked = await verify({ sourceAdmit: () => false })
  try {
    assert.equal(revoked.result.status, 'unknown')
    assert.equal(revoked.result.reason, 'source_unadmitted')
    assert.equal(revoked.runtime.calls.length, 0)
  } finally { rmSync(revoked.workspaceRoot, { recursive: true, force: true }) }
})

test('a Python loader may exit zero after emitting the verified result', PYTHON_TEST_OPTIONS, async () => {
  const script = SCRIPT + 'import sys\nsys.exit(0)\n'
  const { result, workspaceRoot } = await verify({ script })
  try { assert.equal(result.status, 'pass', result.reason) }
  finally { rmSync(workspaceRoot, { recursive: true, force: true }) }
})

test('target output is capped while written and overflow cannot produce credit', PYTHON_TEST_OPTIONS, async () => {
  const script = `from pathlib import Path
import json
path = Path(__file__).with_name("input.json")
raw = path.read_bytes()
while raw.startswith(b"\\xef\\xbb\\xbf"):
    raw = raw[3:]
text = raw.decode("utf-8")
config = json.loads(text)
print(text + text + text + text + text)
`
  const input = Buffer.concat([Buffer.from('\xef\xbb\xbf\xef\xbb\xbf', 'binary'),
    Buffer.from(JSON.stringify({ payload: 'x'.repeat(60 * 1024) }))])
  const { result, workspaceRoot } = await verify({ script, input })
  try {
    assert.equal(result.status, 'unknown')
    assert.equal(result.reason, 'target_output_limit')
    assert.equal(result.summary, undefined)
  } finally { rmSync(workspaceRoot, { recursive: true, force: true }) }
})
