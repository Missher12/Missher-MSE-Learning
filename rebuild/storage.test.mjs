import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDoc, MemoryStore, ROLLBACK } from './memory.mjs'
import { commitMemoryFile } from './storage.mjs'

const temporaryRoot = () => mkdtempSync(join(tmpdir(), 'mse-storage-test-'))
const modeOf = path => statSync(path).mode & 0o777

test('MemoryStore creates a private root and private document under a permissive umask', () => {
  const parent = temporaryRoot()
  const root = join(parent, 'mse')
  const previous = process.umask(0o022)
  try {
    const store = new MemoryStore({ stateRoot: root })
    store.transaction(() => ({ ok: true }))
    assert.equal(modeOf(root), 0o700)
    assert.equal(modeOf(store.path), 0o600)
    assert.equal(modeOf(parent), 0o700, 'only the new MSE directory receives private mode')
  } finally {
    process.umask(previous)
    rmSync(parent, { recursive: true, force: true })
  }
})

test('MemoryStore tightens only an existing state directory owned by the current user', () => {
  const parent = temporaryRoot()
  const root = join(parent, 'mse')
  mkdirSync(root, { mode: 0o755 })
  chmodSync(root, 0o755)
  const parentMode = modeOf(parent)
  try {
    assert.throws(() => new MemoryStore({ stateRoot: root }).read(),
      error => error.code === 'state_unavailable')
    assert.equal(modeOf(root), 0o755, 'pure reads do not repair directory permissions')
    new MemoryStore({ stateRoot: root }).transaction(() => ({ ok: true }))
    if (typeof process.getuid === 'function') assert.equal(modeOf(root), 0o700)
    assert.equal(modeOf(parent), parentMode)
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('a pure first read does not create the state directory', () => {
  const parent = temporaryRoot()
  const root = join(parent, 'not-created')
  const store = new MemoryStore({ stateRoot: root })
  try {
    assert.equal(store.read().entries.length, 0)
    assert.equal(existsSync(root), false)
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('initialization does not recursively create a missing parent path', () => {
  const parent = temporaryRoot()
  const missingParent = join(parent, 'not-created')
  try {
    const store = new MemoryStore({ stateRoot: join(missingParent, 'mse') })
    assert.throws(() => store.transaction(() => true), error => error.code === 'state_unavailable')
    assert.equal(existsSync(missingParent), false)
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('a permission-degraded existing store cannot later be mistaken for first use', () => {
  const root = temporaryRoot()
  const store = new MemoryStore({ stateRoot: root })
  try {
    store.transaction(doc => { doc.controls.userPaused = true; return true })
    chmodSync(root, 0o755)
    assert.throws(() => store.read(), error => error.code === 'state_unavailable')
    chmodSync(root, 0o700)
    unlinkSync(store.path)
    assert.throws(() => store.read(), error => error.code === 'state_unavailable')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('MemoryStore refuses a symlink at the state-root boundary', () => {
  const parent = temporaryRoot()
  const target = join(parent, 'outside')
  const link = join(parent, 'mse-link')
  mkdirSync(target)
  symlinkSync(target, link, 'dir')
  try {
    const store = new MemoryStore({ stateRoot: link })
    assert.throws(() => store.read(), error => error.code === 'invalid_store')
    assert.equal(existsSync(join(target, 'memory-v1.json')), false)
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('MemoryStore refuses a symlink store file without reading its target', () => {
  const parent = temporaryRoot()
  const root = join(parent, 'mse')
  const target = join(parent, 'outside.json')
  mkdirSync(root, { mode: 0o700 })
  writeFileSync(target, JSON.stringify(createDoc()))
  symlinkSync(target, join(root, 'memory-v1.json'))
  try {
    assert.throws(() => new MemoryStore({ stateRoot: root }).read(),
      error => error.code === 'invalid_store' && error.message === 'invalid_store')
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('MemoryStore rejects an oversized file before parsing it', () => {
  const root = temporaryRoot()
  const store = new MemoryStore({ stateRoot: root })
  writeFileSync(store.path, Buffer.alloc(2 * 1024 * 1024 + 1, 0x78))
  try {
    assert.throws(() => store.read(), error => error.code === 'invalid_store')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('MemoryStore rejects a FIFO without blocking while opening it', t => {
  const root = temporaryRoot()
  const store = new MemoryStore({ stateRoot: root })
  const fifo = store.path
  const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' })
  if (created.error || created.status !== 0) {
    rmSync(root, { recursive: true, force: true })
    t.skip('mkfifo is unavailable on this platform')
    return
  }
  const moduleUrl = pathToFileURL(join(process.cwd(), 'rebuild/memory.mjs')).href
  const script = `import { MemoryStore } from ${JSON.stringify(moduleUrl)}; try { new MemoryStore({ stateRoot: ${JSON.stringify(root)} }).read(); process.exitCode = 2 } catch (error) { console.log(error.code) }`
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 1500 })
    assert.equal(child.error, undefined, `FIFO read must not block: ${child.error?.code ?? ''}`)
    assert.equal(child.status, 0, child.stderr)
    assert.equal(child.stdout.trim(), 'invalid_store')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('MemoryStore rejects async callbacks before committing their partial mutation', () => {
  const root = temporaryRoot()
  const store = new MemoryStore({ stateRoot: root })
  try {
    assert.throws(() => store.transaction(async doc => {
      doc.controls.userPaused = true
      return { ok: true }
    }), error => error.code === 'transaction_async')
    assert.equal(store.read().controls.userPaused, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('MemoryStore rejects nested transactions without committing either mutation', () => {
  const root = temporaryRoot()
  const store = new MemoryStore({ stateRoot: root })
  try {
    assert.throws(() => store.transaction(doc => {
      doc.controls.userPaused = true
      store.transaction(inner => { inner.updatedAt = 5; return true })
      return true
    }), error => error.code === 'transaction_reentry')
    assert.equal(store.read().controls.userPaused, false)
    assert.equal(store.read().updatedAt, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('MemoryStore rollback keeps its existing no-write sentinel contract', () => {
  const root = temporaryRoot()
  const store = new MemoryStore({ stateRoot: root })
  try {
    assert.deepEqual(store.transaction(doc => {
      doc.controls.userPaused = true
      return ROLLBACK
    }), { ok: false, rolledBack: true })
    assert.equal(existsSync(store.path), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('pre-rename commit failure preserves the old document and removes the unique temporary file', () => {
  const root = temporaryRoot()
  const store = new MemoryStore({ stateRoot: root })
  store.transaction(() => ({ ok: true }))
  const before = readFileSync(store.path)
  try {
    assert.throws(() => commitMemoryFile(store.path, JSON.stringify(createDoc()), {
      renameSync() { throw Object.assign(new Error('private path must not escape'), { code: 'EIO' }) },
    }), error => error.code === 'EIO' && error.message === 'EIO')
    assert.deepEqual(readFileSync(store.path), before)
    assert.deepEqual(readdirSync(root).filter(name => name.endsWith('.tmp')), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('post-rename directory sync failure reports committed state and does not claim rollback', () => {
  const root = temporaryRoot()
  const store = new MemoryStore({ stateRoot: root })
  const doc = createDoc()
  doc.controls.userPaused = true
  try {
    assert.throws(() => commitMemoryFile(store.path, JSON.stringify(doc), {
      fsyncSync(fd) {
        if (fstatSync(fd).isDirectory()) throw Object.assign(new Error('private'), { code: 'EIO' })
        return fsyncSync(fd)
      },
    }), error => error.code === 'durability_unconfirmed' && error.committed === true
      && error.message === 'durability_unconfirmed')
    assert.equal(store.read().controls.userPaused, true, 'rename already committed the visible document')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('format-3 pure reads do not rewrite; the first real transaction upgrades once and keeps unknown fields', () => {
  const root = temporaryRoot()
  const store = new MemoryStore({ stateRoot: root })
  const legacy = createDoc()
  legacy.format = 3
  legacy.preservedUnknownField = { owner: 'earlier writer' }
  writeFileSync(store.path, JSON.stringify(legacy))
  const before = readFileSync(store.path)
  try {
    assert.equal(store.read().format, 3)
    assert.deepEqual(readFileSync(store.path), before)
    store.transaction(doc => { doc.controls.userPaused = true; return true })
    const migrated = store.read()
    assert.equal(migrated.format, 4)
    assert.deepEqual(migrated.preservedUnknownField, { owner: 'earlier writer' })
    assert.equal(migrated.controls.userPaused, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a concurrent process waits on the active writer and later commits preserve both updates', async () => {
  const root = temporaryRoot()
  const store = new MemoryStore({ stateRoot: root })
  store.transaction(doc => { doc.initial = true; return true })
  const moduleUrl = pathToFileURL(join(process.cwd(), 'rebuild/memory.mjs')).href
  const script = `import { MemoryStore } from ${JSON.stringify(moduleUrl)}; const store = new MemoryStore({ stateRoot: ${JSON.stringify(root)} }); store.transaction(doc => { process.stdout.write('LOCKED\\n'); const until = Date.now() + 350; while (Date.now() < until) {} doc.writerA = true; return true })`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('writer lock timeout')), 3000))
  try {
    const [message] = await Promise.race([once(child.stdout, 'data'), timeout])
    assert.match(message, /LOCKED/u)
    assert.throws(() => store.transaction(doc => { doc.writerB = true; return true }),
      error => error.code === 'lock_busy' && error.message === 'lock_busy')
    const [code, signal] = await Promise.race([once(child, 'exit'), timeout])
    assert.equal(code, 0, stderr)
    assert.equal(signal, null)
    store.transaction(doc => { doc.writerB = true; return true })
    const result = store.read()
    assert.equal(result.writerA, true)
    assert.equal(result.writerB, true)
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})

test('a stale lock is removed only for a confirmed dead PID and a stable lock identity', () => {
  const root = temporaryRoot()
  const store = new MemoryStore({ stateRoot: root })
  store.transaction(() => true)
  const lock = join(root, '.memory-v1.lock')
  writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: 'dead-owner' }))
  const old = new Date(Date.now() - 10 * 60_000)
  utimesSync(lock, old, old)
  try {
    assert.doesNotThrow(() => store.transaction(doc => { doc.afterStaleLock = true; return true }))
    assert.equal(store.read().afterStaleLock, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an uncertain leftover stale-lock reaper claim fails closed without touching either lock', () => {
  const root = temporaryRoot()
  const store = new MemoryStore({ stateRoot: root })
  store.transaction(doc => { doc.sentinel = 'preserve'; return true })
  const lock = join(root, '.memory-v1.lock')
  const reaper = `${lock}.reap`
  const stale = JSON.stringify({ pid: 2147483647, token: 'dead-owner' })
  const claim = 'uncertain-reaper-owner'
  writeFileSync(lock, stale, { mode: 0o600 })
  writeFileSync(reaper, claim, { mode: 0o600 })
  const old = new Date(Date.now() - 10 * 60_000)
  utimesSync(lock, old, old)
  try {
    assert.throws(() => store.transaction(doc => { doc.mustNotCommit = true; return true }),
      error => error.code === 'lock_busy')
    assert.equal(readFileSync(lock, 'utf8'), stale)
    assert.equal(readFileSync(reaper, 'utf8'), claim)
    assert.equal(store.read().sentinel, 'preserve')
    assert.equal(store.read().mustNotCommit, undefined)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
