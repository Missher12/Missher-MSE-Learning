import { randomUUID } from 'node:crypto'
import { constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, closeSync,
  readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024
export class LearningError extends Error {
  constructor(code) { super(code); this.code = code }
}
export function check(condition, code = 'invalid_input') { if (!condition) throw new LearningError(code) }

function regular(path) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(fd)
    check(stat.isFile() && stat.size <= MAX_BYTES, 'invalid_store')
    return readFileSync(fd, 'utf8')
  } finally { closeSync(fd) }
}

function privateDirectory(path) {
  check(typeof path === 'string' && isAbsolute(path) && !/[\u0000-\u001f]/u.test(path), 'invalid_state_root')
  if (existsSync(path)) check(!lstatSync(path).isSymbolicLink() && lstatSync(path).isDirectory(), 'invalid_state_root')
  mkdirSync(path, { recursive: true, mode: 0o700 })
  // macOS system parents such as /var are symlinks. Canonicalize parents, reject a linked store itself.
  return realpathSync(path)
}

function atomicWrite(path, body) {
  const directoryPath = dirname(path)
  const temporary = join(directoryPath, `.mse-${randomUUID()}.tmp`)
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    try { writeFileSync(fd, body); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path)
    if (process.platform !== 'win32') {
      const directory = openSync(directoryPath, 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
  } finally { try { unlinkSync(temporary) } catch {} }
}

/** Small bounded documents, one writer, atomic replacement; no host state is imported. */
export class LessonStore {
  constructor(root, owner) {
    this.root = privateDirectory(root)
    this.path = join(this.root, 'lessons-v1.json')
    this.lock = join(this.root, 'lessons-v1.lock')
    this.owner = owner
  }
  sessionPath(key) {
    check(typeof key === 'string' && /^[a-f0-9]{64}$/u.test(key))
    return join(privateDirectory(join(this.root, 'sessions')), `${key}.json`)
  }
  readSession(key, legacy) {
    let value
    try { value = JSON.parse(regular(this.sessionPath(key))) }
    catch (error) {
      if (error.code !== 'ENOENT') throw new LearningError('session_state_unavailable')
      value = { id: key, owner: this.owner, bytes: legacy?.bytes ?? 0, offered: [...(legacy?.offered ?? [])] }
    }
    check(value?.id === key && value.owner === this.owner && Number.isSafeInteger(value.bytes)
      && value.bytes >= 0 && value.bytes <= 1536 && Array.isArray(value.offered) && value.offered.length <= 32
      && value.offered.every(x => typeof x === 'string' && /^lesson_[a-f0-9]{24}:\d+$/u.test(x)), 'invalid_session_state')
    return value
  }
  reserveSession(session) {
    // Called while the main writer lock is held. Persist the debit BEFORE the receipt.
    // If receipt commit fails, the debit remains: lost recall is preferable to budget overshoot.
    const body = JSON.stringify(session)
    check(Buffer.byteLength(body) <= 4096, 'session_capacity')
    atomicWrite(this.sessionPath(session.id), body)
  }
  read() {
    let text
    try { text = regular(this.path) }
    catch (error) {
      if (error.code === 'ENOENT') return { schema: 2, owner: this.owner, revision: 0, lessons: [], receipts: [], events: [], sessions: [], experiments: [], jobs: [], spends: [] }
      throw new LearningError('state_unavailable')
    }
    let state
    try { state = JSON.parse(text) } catch { throw new LearningError('invalid_store') }
    check([1, 2].includes(state?.schema) && state.owner === this.owner, 'owner_or_schema_mismatch')
    check(Number.isSafeInteger(state.revision) && state.revision >= 0
      && Array.isArray(state.lessons) && state.lessons.length <= 300
      && Array.isArray(state.receipts) && state.receipts.length <= 256
      && Array.isArray(state.events) && state.events.length <= 2048, 'invalid_store')
    state.sessions ??= []
    return state
  }
  update(fn, { backup = false } = {}) {
    let fd
    try { fd = openSync(this.lock, 'wx', 0o600) }
    catch (error) {
      // Conservative stale-lock recovery: a confirmed dead local PID and an unchanged old lock.
      if (error.code !== 'EEXIST') throw new LearningError('state_unavailable')
      try {
        const before = lstatSync(this.lock)
        const lease = JSON.parse(regular(this.lock))
        check(Number.isSafeInteger(lease.pid) && lease.pid > 0 && Date.now() - before.mtimeMs > 300_000, 'lock_busy')
        let dead = false
        try { process.kill(lease.pid, 0) } catch (e) { dead = e.code === 'ESRCH' }
        const after = lstatSync(this.lock)
        check(dead && before.ino === after.ino && before.dev === after.dev && before.mtimeMs === after.mtimeMs
          && before.size === after.size, 'lock_busy')
        unlinkSync(this.lock)
        fd = openSync(this.lock, 'wx', 0o600)
      } catch { throw new LearningError('lock_busy') }
    }
    const token = randomUUID()
    const lockIdentity = fstatSync(fd)
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fsyncSync(fd)
      const state = this.read()
      if (backup && state.schema === 1 && existsSync(this.path)) {
        const destination = join(this.root, `before-schema2-r${state.revision}.json`)
        const original = regular(this.path)
        // Never replace a prior rollback snapshot, even after an interrupted migration.
        if (existsSync(destination)) check(regular(destination) === original, 'backup_conflict')
        else {
          const saved = openSync(destination, 'wx', 0o600)
          try { writeFileSync(saved, original); fsyncSync(saved) } finally { closeSync(saved) }
        }
      }
      const result = fn(state)
      state.revision += 1
      const body = JSON.stringify(state)
      check(Buffer.byteLength(body) <= MAX_BYTES, 'capacity')
      atomicWrite(this.path, body)
      return result
    } finally {
      closeSync(fd)
      try {
        const current = lstatSync(this.lock)
        if (current.dev === lockIdentity.dev && current.ino === lockIdentity.ino) unlinkSync(this.lock)
      } catch {}
    }
  }
}
