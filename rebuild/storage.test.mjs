import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
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
    assert.equal(migrated.format, 6)
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

test('a stale legacy reaper marker is recovered only alongside a confirmed dead lock owner', () => {
  const root = temporaryRoot()
  const store = new MemoryStore({ stateRoot: root })
  store.transaction(doc => { doc.sentinel = 'preserve'; return true })
  const lock = join(root, '.memory-v1.lock')
  const reaper = `${lock}.reap`
  const stale = JSON.stringify({ pid: 2147483647, token: 'dead-owner' })
  const claim = 'legacy-ownerless-reaper-marker'
  writeFileSync(lock, stale, { mode: 0o600 })
  writeFileSync(reaper, claim, { mode: 0o600 })
  const old = new Date(Date.now() - 10 * 60_000)
  utimesSync(lock, old, old)
  utimesSync(reaper, old, old)
  try {
    assert.doesNotThrow(() => store.transaction(doc => { doc.recovered = true; return true }))
    assert.equal(existsSync(reaper), false)
    assert.equal(store.read().sentinel, 'preserve')
    assert.equal(store.read().recovered, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('concurrent stale reapers cannot delete each other’s claim or committed lock', async () => {
  const root = temporaryRoot()
  const store = new MemoryStore({ stateRoot: root })
  store.transaction(doc => { doc.sentinel = 'preserve'; return true })
  const lock = join(root, '.memory-v1.lock')
  const legacyReaper = `${lock}.reap`
  const deadOwner = 2147483647
  writeFileSync(lock, JSON.stringify({ pid: deadOwner, token: 'dead-main-lock' }), { mode: 0o600 })
  writeFileSync(legacyReaper, 'stale-legacy-claim', { mode: 0o600 })
  const old = new Date(Date.now() - 10 * 60_000)
  utimesSync(lock, old, old)
  utimesSync(legacyReaper, old, old)
  const canonicalLock = realpathSync(lock)
  const canonicalLegacyReaper = realpathSync(legacyReaper)

  const moduleUrl = pathToFileURL(join(process.cwd(), 'rebuild/memory.mjs')).href
  const launch = (label, pausePath, unlinkRelease, commitRelease, property) => {
    const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.unlinkSync.bind(fs); const wait=path=>{ while(!fs.existsSync(path)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20) }; fs.unlinkSync=(path,...args)=>{ if(String(path)===${JSON.stringify(pausePath)}) { fs.writeSync(1,${JSON.stringify(`${label}_UNLINK_PAUSED\\n`)}); wait(${JSON.stringify(unlinkRelease)}); } return original(path,...args) }; syncBuiltinESMExports(); const {MemoryStore}=await import(${JSON.stringify(moduleUrl)}); const store=new MemoryStore({stateRoot:${JSON.stringify(root)}}); try { store.transaction(doc=>{doc[${JSON.stringify(property)}]=true;fs.writeSync(1,${JSON.stringify(`${label}_LOCK_HELD\\n`)});wait(${JSON.stringify(commitRelease)});return true}); fs.writeSync(1,'COMMITTED\\n') } catch(error) { fs.writeSync(1,'ERROR:'+error.code+'\\n'); process.exitCode=1 }`
    const child = spawn(process.execPath, ['--input-type=module', '-e', script],
      { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.output = ''
    child.errors = ''
    child.stdout.on('data', chunk => { child.output += chunk })
    child.stderr.on('data', chunk => { child.errors += chunk })
    return child
  }
  const waitFor = async (child, predicate, label) => {
    const until = Date.now() + 5000
    while (!predicate(child.output) && child.exitCode === null && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(predicate(child.output) || child.exitCode !== null,
      `${label} timed out; stdout=${child.output} stderr=${child.errors}`)
  }
  const waitExit = child => child.exitCode !== null
    ? Promise.resolve([child.exitCode, child.signalCode]) : once(child, 'exit')
  const signal = path => writeFileSync(path, 'continue')
  const firstUnlinkRelease = join(root, 'release-first-unlink')
  const firstCommitRelease = join(root, 'release-first-commit')
  const secondUnlinkRelease = join(root, 'release-second-unlink')
  const secondCommitRelease = join(root, 'release-second-commit')
  const first = launch('FIRST', canonicalLegacyReaper, firstUnlinkRelease,
    firstCommitRelease, 'firstWriter')
  let second
  try {
    await waitFor(first, output => output.includes('FIRST_UNLINK_PAUSED'), 'first reaper')
    second = launch('SECOND', canonicalLock, secondUnlinkRelease,
      secondCommitRelease, 'secondWriter')
    await waitFor(second, output => output.includes('SECOND_UNLINK_PAUSED')
      || output.includes('ERROR:') || output.includes('COMMITTED'), 'second reaper')

    if (second.output.includes('SECOND_UNLINK_PAUSED')) {
      // Reproduce the reported interleaving: both contenders read the old claim and lock,
      // then the first installs its lease while the second is paused before unlinking.
      signal(firstUnlinkRelease)
      await waitFor(first, output => output.includes('FIRST_LOCK_HELD'), 'first transaction')
      signal(secondUnlinkRelease)
      await waitFor(second, output => output.includes('SECOND_LOCK_HELD')
        || output.includes('ERROR:'), 'second transaction')
      assert.ok(second.output.includes('SECOND_LOCK_HELD'),
        `second should reach its transaction after the stale lock deletion; ${second.output} ${second.errors}`)
      signal(secondCommitRelease)
      const [secondCode] = await waitExit(second)
      assert.equal(secondCode, 0, `${second.output} ${second.errors}`)
      signal(firstCommitRelease)
      const [firstCode] = await waitExit(first)
      assert.equal(firstCode, 0, first.errors)
    } else {
      assert.match(second.output, /ERROR:lock_busy/, second.errors)
      const [secondCode] = await waitExit(second)
      assert.notEqual(secondCode, 0)
      signal(firstUnlinkRelease)
      await waitFor(first, output => output.includes('FIRST_LOCK_HELD')
        || output.includes('ERROR:'), 'first transaction')
      assert.ok(first.output.includes('FIRST_LOCK_HELD'),
        `first should own the stale lock after reaping; ${first.output} ${first.errors}`)
      signal(firstCommitRelease)
      const [firstCode] = await waitExit(first)
      assert.equal(firstCode, 0, first.errors)
    }

    assert.doesNotMatch(second.output, /SECOND_UNLINK_PAUSED/,
      `a concurrent process must fail before unlinking a lock protected by another reaper; ${second.output}`)
    const result = store.read()
    assert.equal(result.sentinel, 'preserve')
    assert.equal(result.firstWriter, true)
    assert.equal(result.secondWriter, undefined)
  } finally {
    for (const child of [first, second]) {
      if (child === undefined) continue
      if (child.exitCode === null) {
        for (const path of [firstUnlinkRelease, firstCommitRelease,
          secondUnlinkRelease, secondCommitRelease]) signal(path)
        child.kill('SIGKILL')
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('a direct lock acquisition yields during the stale-reaper replacement gap', async () => {
  const root = temporaryRoot()
  const store = new MemoryStore({ stateRoot: root })
  store.transaction(doc => { doc.sentinel = 'preserve'; return true })
  const lock = join(root, '.memory-v1.lock')
  const deadOwner = 2147483647
  writeFileSync(lock, JSON.stringify({ pid: deadOwner, token: 'dead-main-lock' }), { mode: 0o600 })
  const old = new Date(Date.now() - 10 * 60_000)
  utimesSync(lock, old, old)
  const canonicalLock = realpathSync(lock)
  const releasePath = join(root, 'release-direct-acquire')
  const moduleUrl = pathToFileURL(join(process.cwd(), 'rebuild/memory.mjs')).href
  const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; const original=fs.unlinkSync.bind(fs); fs.unlinkSync=(path,...args)=>{ if(String(path)===${JSON.stringify(canonicalLock)}) { const result=original(path,...args); fs.writeSync(1,'STALE_LOCK_REMOVED\\n'); while(!fs.existsSync(${JSON.stringify(releasePath)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); return result } return original(path,...args) }; syncBuiltinESMExports(); const {MemoryStore}=await import(${JSON.stringify(moduleUrl)}); const store=new MemoryStore({stateRoot:${JSON.stringify(root)}}); store.transaction(doc=>{doc.reaperWriter=true;return true})`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const waitForMarker = async () => {
    const until = Date.now() + 5000
    while (!stdout.includes('STALE_LOCK_REMOVED') && child.exitCode === null && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(stdout.includes('STALE_LOCK_REMOVED'), `reaper pause timed out: ${stdout} ${stderr}`)
  }
  try {
    await waitForMarker()
    assert.throws(() => store.transaction(doc => { doc.directWriter = true; return true }),
      error => error.code === 'lock_busy')
    assert.equal(store.read().directWriter, undefined)
    writeFileSync(releasePath, 'continue')
    const [code] = child.exitCode !== null ? [child.exitCode]
      : await Promise.race([once(child, 'exit'), new Promise((_, reject) =>
        setTimeout(() => reject(new Error('stale reaper replacement timeout')), 5000))])
    assert.equal(code, 0, stderr)
    assert.equal(store.read().sentinel, 'preserve')
    assert.equal(store.read().reaperWriter, true)
  } finally {
    writeFileSync(releasePath, 'continue')
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})

test('a crashed cross-process reaper claim is recoverable, while a live owner is never stolen', async () => {
  const root = temporaryRoot()
  const store = new MemoryStore({ stateRoot: root })
  store.transaction(doc => { doc.sentinel = 'preserve'; return true })
  const lock = join(root, '.memory-v1.lock')
  const reaperPrefix = '.memory-v1.lock.reap-'
  const deadOwner = 2147483647
  writeFileSync(lock, JSON.stringify({ pid: deadOwner, token: 'dead-main-lock' }), { mode: 0o600 })
  const old = new Date(Date.now() - 10 * 60_000)
  utimesSync(lock, old, old)
  const moduleUrl = pathToFileURL(join(process.cwd(), 'rebuild/memory.mjs')).href
  const script = `import { writeSync } from 'node:fs'; import { MemoryStore } from ${JSON.stringify(moduleUrl)}; const nativeKill=process.kill.bind(process); process.kill=(pid,signal)=>{ if(pid===${deadOwner}&&signal===0){ writeSync(1,'REAPER_HELD\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120000); return true } return nativeKill(pid,signal) }; const store=new MemoryStore({stateRoot:${JSON.stringify(root)}}); store.transaction(doc=>{doc.childWriter=true;return true})`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('reaper claim timeout')), 4000))
  try {
    await Promise.race([new Promise((resolve, reject) => {
      const poll = () => stdout.includes('REAPER_HELD') ? resolve() : setTimeout(poll, 10)
      poll()
      child.once('error', reject)
      child.once('exit', code => reject(new Error(`reaper exited before holding claim: ${code}`)))
    }), timeout])
    const reaper = readdirSync(root).find(name => name.startsWith(`${reaperPrefix}${child.pid}-`))
    assert.ok(reaper, 'the live reaper owns a unique visible ticket')
    const owner = JSON.parse(readFileSync(join(root, reaper), 'utf8'))
    assert.equal(owner.pid, child.pid, 'the new claim records its owning process')
    assert.throws(() => store.transaction(doc => { doc.parentWriter = true; return true }),
      error => error.code === 'lock_busy')
    assert.equal(readFileSync(lock, 'utf8'), JSON.stringify({ pid: deadOwner, token: 'dead-main-lock' }))
    assert.equal(store.read().sentinel, 'preserve')

    child.kill('SIGKILL')
    const [code, signal] = await Promise.race([once(child, 'exit'), timeout])
    assert.notEqual(code, 0)
    assert.ok(signal !== null || code !== 0)
    assert.doesNotThrow(() => store.transaction(doc => { doc.recoveredWriter = true; return true }), stderr)
    const result = store.read()
    assert.equal(result.sentinel, 'preserve')
    assert.equal(result.childWriter, undefined, 'the killed writer never committed partial data')
    assert.equal(result.parentWriter, undefined, 'the live reaper lock blocked the concurrent writer')
    assert.equal(result.recoveredWriter, true)
    assert.equal(readdirSync(root).some(name => name.startsWith(reaperPrefix)), false,
      'the next safe reaper removes the dead process ticket')
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})
