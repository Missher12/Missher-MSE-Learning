/** Small, bounded, private-file I/O for the format-3/4 MemoryStore. */
import { randomUUID } from 'node:crypto'
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { LearningError, MAX_STORE_BYTES, check } from '../src/store.mjs'

export const REQUEST_AUDIT_LIMIT = 96

/** Lossless wire encoding only. The engine still receives the exact original request rows.
 * Each file stays <=2 MiB, and all expanded request audits together stay <=2 MiB, so a read
 * cannot expand beyond 4 MiB. In-flight requests are never packed. No evidence is discarded. */
export function encodeMemoryDocument(doc, reserve = 0) {
  check(Number.isSafeInteger(reserve) && reserve >= 0, 'invalid_memory')
  let auditBytes = 0
  const requests = doc.requests.map(row => {
    const raw = JSON.stringify(row)
    const bytes = Buffer.byteLength(raw)
    auditBytes += bytes
    check(auditBytes + reserve <= MAX_STORE_BYTES, 'capacity')
    if (row.settled !== true || bytes < 4096) return row
    const packed = { ticket: row.ticket, auditEncoding: 'gzip-json-v1', auditBytes: bytes,
      auditData: gzipSync(raw, { level: 1 }).toString('base64') }
    return Buffer.byteLength(JSON.stringify(packed)) < bytes ? packed : row
  })
  const body = JSON.stringify({ ...doc, requests })
  check(Buffer.byteLength(body) + reserve <= MAX_STORE_BYTES, 'capacity')
  return body
}

/** Decode before the existing strict schema validation; malformed packing fails closed. */
export function decodeMemoryDocument(bytes) {
  check(Buffer.byteLength(bytes) <= MAX_STORE_BYTES, 'invalid_memory')
  const doc = JSON.parse(bytes.toString('utf8'))
  check(Array.isArray(doc?.requests) && doc.requests.length <= REQUEST_AUDIT_LIMIT, 'invalid_memory')
  let auditBytes = 0
  doc.requests = doc.requests.map(row => {
    if (row === null || typeof row !== 'object' || !Object.hasOwn(row, 'auditEncoding')) {
      auditBytes += Buffer.byteLength(JSON.stringify(row))
      check(auditBytes <= MAX_STORE_BYTES, 'invalid_memory')
      return row
    }
    check(Object.keys(row).length === 4 && row.auditEncoding === 'gzip-json-v1'
      && typeof row.ticket === 'string' && row.ticket.length > 0 && row.ticket.length <= 64
      && Number.isSafeInteger(row.auditBytes) && row.auditBytes > 0
      && row.auditBytes <= MAX_STORE_BYTES - auditBytes
      && typeof row.auditData === 'string', 'invalid_memory')
    const compressed = Buffer.from(row.auditData, 'base64')
    check(compressed.toString('base64') === row.auditData, 'invalid_memory')
    const expanded = gunzipSync(compressed, { maxOutputLength: row.auditBytes })
    check(expanded.length === row.auditBytes, 'invalid_memory')
    const text = new TextDecoder('utf8', { fatal: true }).decode(expanded)
    const original = JSON.parse(text)
    check(original?.ticket === row.ticket && original.settled === true
      && !Object.hasOwn(original, 'auditEncoding'), 'invalid_memory')
    auditBytes += expanded.length
    return original
  })
  return doc
}

const LOCK_MAX_AGE_MS = 5 * 60_000
const LOCK_MAX_BYTES = 512
const MEMORY_LOCK_NAME = '.memory-v1.lock'
const MEMORY_REAPER_NAME = `${MEMORY_LOCK_NAME}.reap`
const WINDOWS = process.platform === 'win32'
const knownStorageCodes = new Set(['state_unavailable', 'invalid_store', 'invalid_memory', 'capacity',
  'invalid_state_root', 'lock_busy', 'transaction_async', 'transaction_reentry',
  'durability_unconfirmed', 'ENOSPC', 'EIO', 'EACCES', 'EROFS'])
const activeLocks = new Set()

export const isMemoryStorageError = error => error instanceof LearningError
  && knownStorageCodes.has(error.code)

const learningError = code => new LearningError(code)
const presentError = error => { error.storePresent = true; return error }
const ioCode = error => ['ENOSPC', 'EIO', 'EACCES', 'EROFS'].includes(error?.code)
  ? error.code : 'state_unavailable'
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino

function directoryFd(path) {
  const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0)
  return openSync(path, flags)
}

function syncDirectory(path) {
  // Windows Node cannot open/fsync a POSIX directory descriptor. File writes are flushed
  // separately; never suppress a real directory-sync failure on macOS/Linux.
  if (WINDOWS) return
  const fd = directoryFd(path)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function tightenOwnedDirectory(path, expected, uid) {
  // Windows uses the DSH profile's inherited ACL, not POSIX UID/mode bits. The caller still
  // rejects links and verifies canonical directory identity; actual file I/O enforces the ACL.
  if (WINDOWS) return
  if (typeof uid !== 'number' || expected.uid !== uid) throw learningError('state_unavailable')
  let fd
  try {
    fd = directoryFd(path)
    const opened = fstatSync(fd)
    if (!opened.isDirectory() || !sameIdentity(expected, opened) || opened.uid !== uid) {
      throw learningError('invalid_store')
    }
    if ((opened.mode & 0o777) !== 0o700) fchmodSync(fd, 0o700)
    const secured = fstatSync(fd)
    if ((secured.mode & 0o777) !== 0o700) throw learningError('state_unavailable')
  } catch (error) {
    if (error instanceof LearningError) throw error
    throw learningError(ioCode(error))
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch {} }
  }
}

/** The final component must be an owned directory; parent aliases such as /var are canonicalized. */
export function prepareMemoryDirectory(path) {
  check(typeof path === 'string' && isAbsolute(path) && !/[\u0000-\u001f]/u.test(path),
    'invalid_state_root')
  let created = false
  let entry
  try { entry = lstatSync(path) }
  catch (error) {
    if (error?.code !== 'ENOENT') throw presentError(learningError(ioCode(error)))
    try { mkdirSync(path, { mode: 0o700 }); created = true }
    catch (mkdirError) { throw learningError(ioCode(mkdirError)) }
    try { entry = lstatSync(path) }
    catch (statError) { throw learningError(ioCode(statError)) }
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    const invalid = learningError('invalid_store')
    throw created ? invalid : presentError(invalid)
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  try { tightenOwnedDirectory(path, entry, uid) }
  catch (error) { throw created ? error : presentError(error) }

  let canonical
  try { canonical = realpathSync(path) }
  catch (error) { throw created ? learningError(ioCode(error)) : presentError(learningError(ioCode(error))) }
  let current
  try { current = lstatSync(path) }
  catch (error) { throw created ? learningError(ioCode(error)) : presentError(learningError(ioCode(error))) }
  let resolved
  try { resolved = statSync(canonical) }
  catch (error) { throw created ? learningError(ioCode(error)) : presentError(learningError(ioCode(error))) }
  if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(entry, current)
    || !sameIdentity(current, resolved)) {
    const invalid = learningError('invalid_store')
    throw created ? invalid : presentError(invalid)
  }
  if (created) {
    try { syncDirectory(canonical); syncDirectory(dirname(canonical)) }
    catch (error) { throw learningError(ioCode(error)) }
  }
  return canonical
}

/** Read-only counterpart: status/read never creates or repairs the directory it inspects. */
export function resolveMemoryDirectory(path) {
  check(typeof path === 'string' && isAbsolute(path) && !/[\u0000-\u001f]/u.test(path),
    'invalid_state_root')
  let entry
  try { entry = lstatSync(path) }
  catch (error) {
    if (error?.code === 'ENOENT') return resolve(path)
    throw presentError(learningError(ioCode(error)))
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw presentError(learningError('invalid_store'))
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (!WINDOWS && (typeof uid !== 'number' || entry.uid !== uid)) {
    throw presentError(learningError('state_unavailable'))
  }
  let canonical
  let current
  let resolved
  try {
    canonical = realpathSync(path)
    current = lstatSync(path)
    resolved = statSync(canonical)
  } catch (error) { throw presentError(learningError(ioCode(error))) }
  if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(entry, current)
    || !sameIdentity(current, resolved)) throw presentError(learningError('invalid_store'))
  if (!WINDOWS && (current.mode & 0o777) !== 0o700) throw presentError(learningError('state_unavailable'))
  return canonical
}

/** Open without following the final link, prove regular-file identity, then read at most limit+1. */
export function readBoundedMemoryFileBytes(path, limit = MAX_STORE_BYTES) {
  let before
  try { before = lstatSync(path) }
  catch (error) { throw error }
  if (before.isSymbolicLink() || !before.isFile()) {
    const invalid = learningError('invalid_store')
    invalid.storePresent = true
    throw invalid
  }
  let fd
  try {
    const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)
    fd = openSync(path, flags)
    const opened = fstatSync(fd)
    if (!opened.isFile() || !sameIdentity(before, opened) || opened.size > limit) {
      const invalid = learningError('invalid_store')
      invalid.storePresent = true
      throw invalid
    }
    const buffer = Buffer.alloc(limit + 1)
    let offset = 0
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null)
      if (count === 0) break
      offset += count
    }
    if (offset > limit) {
      const invalid = learningError('invalid_store')
      invalid.storePresent = true
      throw invalid
    }
    return Buffer.from(buffer.subarray(0, offset))
  } catch (error) {
    if (error instanceof LearningError) throw error
    const unavailable = learningError(error?.code === 'ELOOP' || error?.code === 'ENXIO'
      ? 'invalid_store' : ioCode(error))
    unavailable.storePresent = true
    throw unavailable
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch {} }
  }
}

export function readBoundedMemoryFile(path, limit = MAX_STORE_BYTES) {
  return readBoundedMemoryFileBytes(path, limit).toString('utf8')
}

/** Persist a bounded private snapshot at a caller-selected path without replacing any file. */
export function writeExclusiveMemorySnapshot(path, body, overrides = {}) {
  check(typeof path === 'string' && isAbsolute(path) && !/[\u0000-\u001f]/u.test(path),
    'invalid_state_root')
  check(typeof body === 'string' || Buffer.isBuffer(body), 'invalid_memory')
  check(Buffer.byteLength(body) <= MAX_STORE_BYTES, 'capacity')
  const io = { openSync, writeFileSync, fchmodSync, fstatSync, fsyncSync, closeSync,
    lstatSync, unlinkSync, ...overrides }
  const directory = dirname(path)
  let directoryHandle
  let fd
  let identity
  let outputOpened = false
  let committed = false
  try {
    const before = io.lstatSync(directory)
    if (before.isSymbolicLink() || !before.isDirectory()) throw learningError('invalid_store')
    if (!WINDOWS) directoryHandle = directoryFd(directory)
    const openedDirectory = WINDOWS ? io.lstatSync(directory) : io.fstatSync(directoryHandle)
    if (!openedDirectory.isDirectory() || !sameIdentity(before, openedDirectory)) {
      throw learningError('invalid_store')
    }
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | (constants.O_NOFOLLOW ?? 0)
    fd = io.openSync(path, flags, 0o600)
    outputOpened = true
    identity = io.fstatSync(fd)
    if (!identity.isFile()) throw learningError('invalid_store')
    if (!WINDOWS) io.fchmodSync(fd, 0o600)
    const currentDirectory = io.lstatSync(directory)
    if (currentDirectory.isSymbolicLink() || !currentDirectory.isDirectory()
      || !sameIdentity(before, currentDirectory)) throw learningError('invalid_store')
    io.writeFileSync(fd, body)
    io.fsyncSync(fd)
    committed = true
    io.closeSync(fd)
    fd = undefined
    if (!WINDOWS) io.fsyncSync(directoryHandle)
    return { committed: true, durable: true }
  } catch (error) {
    if (committed) {
      const uncertain = learningError('durability_unconfirmed')
      uncertain.committed = true
      uncertain.created = true
      throw uncertain
    }
    if (fd !== undefined) { try { io.closeSync(fd) } catch {} fd = undefined }
    const failure = error instanceof LearningError ? error : learningError(ioCode(error))
    let created = false
    if (outputOpened) {
      if (identity === undefined) created = true
      else try {
        const current = io.lstatSync(path)
        if (sameIdentity(identity, current)) {
          try { io.unlinkSync(path) } catch {}
          const remaining = io.lstatSync(path)
          created = sameIdentity(identity, remaining)
        }
      } catch (cleanupError) {
        if (cleanupError?.code !== 'ENOENT') created = true
      }
    }
    failure.created = created
    throw failure
  } finally {
    if (fd !== undefined) { try { io.closeSync(fd) } catch {} }
    if (directoryHandle !== undefined) { try { io.closeSync(directoryHandle) } catch {} }
  }
}

/** Exclusive temp + file sync + same-directory rename + platform-native metadata sync.
 *  POSIX syncs the directory; Windows reopens and flushes the replaced file (no directory fd).
 *  After rename, failures are reported as committed-but-durability-unconfirmed, never rollback. */
export function commitMemoryFile(path, body, overrides = {}) {
  const io = { openSync, writeFileSync, fsyncSync, fstatSync, closeSync, renameSync, unlinkSync, ...overrides }
  const directory = dirname(path)
  const temporary = join(directory, `.memory-v1-${randomUUID()}.tmp`)
  let fd
  let committed = false
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
    fd = io.openSync(temporary, flags, 0o600)
    const identity = WINDOWS ? io.fstatSync(fd) : null
    io.writeFileSync(fd, body)
    io.fsyncSync(fd)
    io.closeSync(fd)
    fd = undefined
    io.renameSync(temporary, path)
    committed = true
    if (WINDOWS) {
      const replaced = io.openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
      try {
        const opened = io.fstatSync(replaced)
        if (!opened.isFile() || !sameIdentity(identity, opened)) throw learningError('invalid_store')
        io.fsyncSync(replaced)
      } finally { io.closeSync(replaced) }
    } else {
      const directoryHandle = io.openSync(directory,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
      try { io.fsyncSync(directoryHandle) } finally { io.closeSync(directoryHandle) }
    }
    return { committed: true, durable: true }
  } catch (error) {
    if (committed) {
      const uncertain = learningError('durability_unconfirmed')
      uncertain.committed = true
      throw uncertain
    }
    throw learningError(ioCode(error))
  } finally {
    if (fd !== undefined) { try { io.closeSync(fd) } catch {} }
    try { io.unlinkSync(temporary) } catch {}
  }
}

function lockIdentity(path) {
  try { return lstatSync(path) } catch { return null }
}

function staleOwnerIdentity(lockPath) {
  let before
  let lease
  try {
    before = lstatSync(lockPath)
    if (!before.isFile() || before.isSymbolicLink()
      || Date.now() - before.mtimeMs < LOCK_MAX_AGE_MS || before.size > LOCK_MAX_BYTES) return null
    lease = JSON.parse(readBoundedMemoryFile(lockPath, LOCK_MAX_BYTES))
  } catch { return null }
  if (!Number.isSafeInteger(lease?.pid) || lease.pid < 1 || typeof lease.token !== 'string') return null
  let dead = false
  try { process.kill(lease.pid, 0) } catch (error) { dead = error?.code === 'ESRCH' }
  if (!dead) return null
  const after = lockIdentity(lockPath)
  if (after === null || !sameIdentity(before, after) || before.mtimeMs !== after.mtimeMs
    || before.size !== after.size) return null
  return after
}

function writeOwnedLock(lockPath, fd) {
  const identity = fstatSync(fd)
  const token = randomUUID()
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() }))
    // The lease is ephemeral process metadata; exclusive creation plus the complete synchronous
    // write and identity checks provide mutual exclusion. User data is synced in commitMemoryFile.
    return { fd, identity, token }
  } catch (error) {
    try { closeSync(fd) } catch {}
    const current = lockIdentity(lockPath)
    if (current !== null && sameIdentity(identity, current)) { try { unlinkSync(lockPath) } catch {} }
    throw learningError(ioCode(error))
  }
}

function acquireReaperClaim(path) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
  let fd
  try { fd = openSync(path, flags, 0o600) }
  catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ELOOP') throw learningError('lock_busy')
    throw learningError(ioCode(error))
  }
  try { return { fd, identity: fstatSync(fd) } }
  catch {
    try { closeSync(fd) } catch {}
    throw learningError('lock_busy')
  }
}

function releaseReaperClaim(path, claim) {
  try { closeSync(claim.fd) } catch {}
  const current = lockIdentity(path)
  if (current !== null && sameIdentity(claim.identity, current)) {
    try { unlinkSync(path) } catch {}
  }
}

function acquireAfterStaleLock(lockPath, flags) {
  const reaperPath = join(dirname(lockPath), MEMORY_REAPER_NAME)
  const claim = acquireReaperClaim(reaperPath)
  try {
    const stale = staleOwnerIdentity(lockPath)
    const current = lockIdentity(lockPath)
    if (stale === null || current === null || !sameIdentity(stale, current)
      || stale.mtimeMs !== current.mtimeMs || stale.size !== current.size) {
      throw learningError('lock_busy')
    }
    try { unlinkSync(lockPath) }
    catch (error) { throw learningError(ioCode(error)) }
    let fd
    try { fd = openSync(lockPath, flags, 0o600) }
    catch (error) {
      if (error?.code === 'EEXIST' || error?.code === 'ELOOP') throw learningError('lock_busy')
      throw learningError(ioCode(error))
    }
    return writeOwnedLock(lockPath, fd)
  } finally { releaseReaperClaim(reaperPath, claim) }
}

function acquireLock(lockPath) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
  let fd
  try { fd = openSync(lockPath, flags, 0o600) }
  catch (error) {
    if (error?.code === 'EEXIST') return acquireAfterStaleLock(lockPath, flags)
    if (error?.code === 'ELOOP') throw learningError('lock_busy')
    else throw learningError(ioCode(error))
  }
  return writeOwnedLock(lockPath, fd)
}

function releaseLock(lockPath, lock) {
  try { closeSync(lock.fd) } catch {}
  const current = lockIdentity(lockPath)
  if (current !== null && sameIdentity(lock.identity, current)) {
    try { unlinkSync(lockPath) } catch {}
  }
}

/** Synchronous single-writer transaction lease with conservative, identity-checked stale cleanup. */
export function withMemoryStoreLock(root, action) {
  const lockPath = join(root, MEMORY_LOCK_NAME)
  if (activeLocks.has(lockPath)) throw learningError('transaction_reentry')
  activeLocks.add(lockPath)
  let lock
  try {
    lock = acquireLock(lockPath)
    return action()
  } finally {
    if (lock !== undefined) releaseLock(lockPath, lock)
    activeLocks.delete(lockPath)
  }
}
