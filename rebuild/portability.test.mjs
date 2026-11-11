// Real OS/filesystem tests. No platform override, DSH credentials, SDK, or model provider.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RebuildEngine } from './engine.mjs'
import { createDoc, MemoryStore } from './memory.mjs'
import { commitMemoryFile, writeExclusiveMemorySnapshot } from './storage.mjs'
import { pathInside } from './paths.mjs'
import { runChecker, runDevelopmentChecker } from './checker.mjs'

const temporary = t => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'mse-portable-')))
  t.after(() => rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return path
}

test('native store round trip preserves Unicode, unknown fields, and a read-only first read', t => {
  const parent = temporary(t)
  const root = join(parent, '学习 data 😀')
  const store = new MemoryStore({ stateRoot: root })
  assert.equal(store.read().entries.length, 0)
  assert.equal(existsSync(root), false)
  store.transaction(doc => { doc.portableSentinel = { text: '用户原文 😀', n: [1, 2, 3] }; return true })
  const before = readFileSync(store.path)
  const reopened = new MemoryStore({ stateRoot: root })
  assert.deepEqual(reopened.read().portableSentinel, { text: '用户原文 😀', n: [1, 2, 3] })
  assert.deepEqual(readFileSync(store.path), before)
  assert.equal(store.lastCommitDurability, 'confirmed')
  assert.deepEqual(readdirSync(root), ['memory-v1.json'])
  if (process.platform !== 'win32') {
    assert.equal(statSync(root).mode & 0o777, 0o700)
    assert.equal(statSync(store.path).mode & 0o777, 0o600)
  }
})

test('native format3 upgrade preserves old fields and leaves legacy source bytes untouched', t => {
  const root = temporary(t)
  const store = new MemoryStore({ stateRoot: root })
  const doc = createDoc()
  doc.format = 3
  doc.portableOldField = { version: 1, text: '旧文保留' }
  const original = JSON.stringify(doc)
  const legacy = join(root, 'lessons-v1.json')
  writeFileSync(store.path, original)
  writeFileSync(legacy, '{"schema":1,"lessons":[]}')
  const legacyBytes = readFileSync(legacy)
  assert.equal(store.read().format, 3)
  assert.equal(readFileSync(store.path, 'utf8'), original)
  store.transaction(current => { current.controls.userPaused = true; return true })
  const migrated = new MemoryStore({ stateRoot: root }).read()
  assert.equal(migrated.format, 4)
  assert.deepEqual(migrated.portableOldField, { version: 1, text: '旧文保留' })
  assert.equal(migrated.controls.userPaused, true)
  assert.deepEqual(readFileSync(legacy), legacyBytes)
})

test('native stored rule is recalled by a fresh engine in another project within 768 bytes', t => {
  const root = temporary(t)
  const engine = new RebuildEngine({ stateRoot: root })
  engine.recordCorrection({ text: '生成 JSON 配置时必须先做 JSON.parse 检查，禁止尾随逗号',
    sessionId: 'source', turnId: '1' })
  const fresh = new RebuildEngine({ stateRoot: root })
  const result = fresh.prepare({ sessionId: 'new', turnId: '1', projectKey: 'other-project',
    prompt: '生成 JSON 配置并检查语法' })
  assert.ok(result.context.includes('禁止尾随逗号'))
  assert.ok(result.bytes > 0 && result.bytes <= 768)
  fresh.complete({ sessionId: 'new', turnId: '1', outcome: 'unknown', evidence: 'portable core test' })
  const fact = fresh.store.read().turnFacts.at(-1)
  assert.equal(fact.outcome, 'unknown')
  assert.match(fact.evidenceHash, /^[a-f0-9]{64}$/u)
})

test('native failed replacement preserves the old file; post-commit failure is reported honestly', t => {
  const root = temporary(t)
  const path = join(root, 'memory-v1.json')
  writeFileSync(path, 'old data')
  assert.throws(() => commitMemoryFile(path, 'uncommitted', {
    renameSync() { throw Object.assign(new Error('injected disk error'), { code: 'EIO' }) },
  }), error => error.code === 'EIO' && error.committed !== true)
  assert.equal(readFileSync(path, 'utf8'), 'old data')
  let syncs = 0
  assert.throws(() => commitMemoryFile(path, 'committed', {
    fsyncSync() { if (++syncs === 2) throw Object.assign(new Error('injected sync error'), { code: 'EIO' }) },
  }), error => error.code === 'durability_unconfirmed' && error.committed === true)
  assert.equal(readFileSync(path, 'utf8'), 'committed')
  assert.deepEqual(readdirSync(root), ['memory-v1.json'])
})

test('native exclusive snapshot cannot overwrite an existing file', t => {
  const root = temporary(t)
  const output = join(root, 'snapshot.json')
  const body = Buffer.from(JSON.stringify(createDoc()))
  assert.equal(writeExclusiveMemorySnapshot(output, body).durable, true)
  assert.deepEqual(readFileSync(output), body)
  assert.throws(() => writeExclusiveMemorySnapshot(output, 'overwrite'))
  assert.deepEqual(readFileSync(output), body)
})

test('native directory link and external JSON link never grant storage or checker access', t => {
  const parent = temporary(t)
  const root = join(parent, 'workspace')
  const external = join(parent, 'external')
  new MemoryStore({ stateRoot: root }).transaction(() => true)
  new MemoryStore({ stateRoot: external }).transaction(() => true)
  const link = join(root, 'outside')
  symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => new MemoryStore({ stateRoot: link }).read(), error => error.code === 'invalid_store')
  writeFileSync(join(external, 'data.json'), '{"outside":true}')
  assert.equal(pathInside(realpathSync(link), [realpathSync(root)]), false)
  assert.equal(runChecker('json-file-parses-v1', { root, file: join('outside', 'data.json') }).status,
    'not_applicable')
})

test('native JSON checker handles local paths and rejects siblings, traversal, and absolute names', t => {
  const root = temporary(t)
  writeFileSync(join(root, '配置 file.json'), '{"ok":true}')
  assert.equal(runChecker('json-file-parses-v1', { root, file: '配置 file.json' }).status, 'pass')
  writeFileSync(join(root, 'bad.json'), '{"invalid":true,}')
  assert.equal(runChecker('json-file-parses-v1', { root, file: 'bad.json' }).status, 'fail')
  assert.equal(runChecker('json-file-parses-v1', { root, file: join(root, '配置 file.json') }).status, 'not_applicable')
  assert.equal(runChecker('json-file-parses-v1', { root, file: join('..', 'outside.json') }).status, 'not_applicable')
  assert.equal(pathInside(root + '-sibling', [root]), false)
})

test('native foreground checker accepts the current OS cwd without minting success from exit 0', t => {
  const root = temporary(t)
  const value = { kind: 'foreground', cwd: root, signal: null, timedOut: false, aborted: false,
    exitCode: 0, stdout: { text: '✔ assertion (1ms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 1\n', truncated: false },
    stderr: { text: '', truncated: false } }
  assert.equal(runDevelopmentChecker({ command: 'node --test checks.test.mjs',
    result: { isError: false, value } }).status, 'pass')
  assert.equal(runDevelopmentChecker({ command: 'echo success', result: { isError: false, value } }).status, 'unknown')
})

test('native cross-process writer lock prevents a lost update', { timeout: 25000 }, async t => {
  const root = temporary(t)
  const store = new MemoryStore({ stateRoot: root })
  store.transaction(doc => { doc.portableSentinel = 'preserve'; return true })
  const release = join(root, 'release-writer')
  const script = `
    import { existsSync } from 'node:fs'
    import { MemoryStore } from ${JSON.stringify(new URL('./memory.mjs', import.meta.url).href)}
    const store = new MemoryStore({ stateRoot: ${JSON.stringify(root)} })
    store.transaction(doc => {
      process.stdout.write('LOCKED\\n')
      const end = Date.now() + 15000
      while (!existsSync(${JSON.stringify(release)})) {
        if (Date.now() > end) throw new Error('owned test writer timed out')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
      doc.writerA = true
      return true
    })
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = once(child, 'exit')
  try {
    const [message] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(15000) })
    assert.match(message.toString(), /LOCKED/u)
    assert.throws(() => store.transaction(doc => { doc.writerB = true; return true }),
      error => error.code === 'lock_busy')
    writeFileSync(release, 'go')
    const [code] = await exited
    assert.equal(code, 0, stderr)
    store.transaction(doc => { doc.writerB = true; return true })
    const final = store.read()
    assert.equal(final.portableSentinel, 'preserve')
    assert.equal(final.writerA, true)
    assert.equal(final.writerB, true)
  } finally {
    if (child.exitCode === null) { child.kill(); await exited }
  }
})
