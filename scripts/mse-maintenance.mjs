import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { LearningError, MAX_STORE_BYTES } from '../src/store.mjs'
import { ENTRY_LIMIT, MemoryStore, validateDoc } from '../rebuild/memory.mjs'
import { readBoundedMemoryFileBytes, writeExclusiveMemorySnapshot, decodeMemoryDocument,
  commitMemoryFile, prepareMemoryDirectory, syncMemoryDirectory, withMemoryStoreLock } from '../rebuild/storage.mjs'
import { isV5Manifest, v5ObjectReferences, V5_OBJECT_PREFIX } from '../rebuild/storage-v5.mjs'
import { isV6Manifest, v6ObjectReferences } from '../rebuild/storage-v6.mjs'

const fail = code => { throw new LearningError(code) }
const validPath = value => typeof value === 'string' && isAbsolute(value)
  && !/[\u0000-\u001f]/u.test(value)
const SAFE_ERROR_CODES = new Set(['invalid_arguments', 'invalid_state_root', 'invalid_memory',
  'invalid_store', 'state_unavailable', 'capacity', 'lock_busy', 'durability_unconfirmed',
  'transaction_async', 'transaction_reentry', 'ENOSPC', 'EIO', 'EACCES', 'EROFS'])
let progress = { phase: 'validating', backup: { created: false, durable: null },
  source: { committed: false, durable: null }, target: { committed: false, durable: null },
  sourceAttempted: false, targetAttempted: false }
const progressFields = () => ({ phase: progress.phase, backup: progress.backup,
  source: progress.source, target: progress.target })

function parseOptions(command, args) {
  const allowed = command === 'recover-copy'
    ? new Set(['--input', '--state-root']) : new Set(['--state-root', '--output'])
  if (command === 'archive-retired') allowed.add('--id')
  const options = { ids: [] }
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]
    if (!allowed.has(key) || index + 1 >= args.length || args[index + 1].startsWith('--')) {
      fail('invalid_arguments')
    }
    const value = args[++index]
    if (key === '--id') options.ids.push(value)
    else {
      if (options[key] !== undefined) fail('invalid_arguments')
      options[key] = value
    }
  }
  const required = command === 'recover-copy' ? ['--input', '--state-root']
    : command === 'inspect' ? ['--state-root'] : ['--state-root', '--output']
  if (required.some(key => options[key] === undefined)
    || ((command === 'archive-retired') !== (options.ids.length > 0))) fail('invalid_arguments')
  for (const key of required) {
    if (key !== '--id' && !validPath(options[key])) fail('invalid_arguments')
  }
  if (command === 'archive-retired') {
    if (options.ids.some(id => !/^mem_[0-9a-f]{24}$/u.test(id))
      || new Set(options.ids).size !== options.ids.length || options.ids.length > ENTRY_LIMIT) {
      fail('invalid_arguments')
    }
  }
  return options
}

const bytesHash = value => createHash('sha256').update(value).digest('hex')
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino

function readV5ObjectFiles(root) {
  const objects = []
  for (const name of readdirSync(root).filter(name => name.startsWith(V5_OBJECT_PREFIX)).sort()) {
    const match = /^\.memory-v1-object-([a-f0-9]{64})\.json$/u.exec(name)
    if (match === null) fail('invalid_memory')
    const bytes = readBoundedMemoryFileBytes(join(root, name))
    if (bytesHash(bytes) !== match[1]) fail('invalid_memory')
    objects.push({ name, bytes })
  }
  return objects
}

function requireV5References(manifest, objects) {
  const present = new Set(objects.map(object => object.name))
  for (const hash of v5ObjectReferences(manifest)) {
    if (!present.has(`${V5_OBJECT_PREFIX}${hash}.json`)) fail('invalid_memory')
  }
}

function requireV6References(root, manifest, objects) {
  const present = new Set(objects.map(object => object.name))
  for (const hash of v6ObjectReferences(root, manifest)) {
    if (!present.has(`${V5_OBJECT_PREFIX}${hash}.json`)) fail('invalid_memory')
  }
}

function writeV5Bundle(root, manifestBytes, output) {
  let createdIdentity = null
  try {
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    if (!isV5Manifest(manifest)) fail('invalid_memory')
    const objects = readV5ObjectFiles(root)
    requireV5References(manifest, objects)
    mkdirSync(output, { mode: 0o700 })
    createdIdentity = lstatSync(output)
    chmodSync(output, 0o700)
    syncMemoryDirectory(dirname(output))
    writeExclusiveMemorySnapshot(join(output, 'memory-v1.json'), manifestBytes, { syncDirectory: false })
    let totalBytes = manifestBytes.length
    for (const object of objects) {
      writeExclusiveMemorySnapshot(join(output, object.name), object.bytes, { syncDirectory: false })
      totalBytes += object.bytes.length
    }
    syncMemoryDirectory(output)
    return { bytes: totalBytes, objects: objects.length }
  } catch (error) {
    let created = createdIdentity !== null
    if (created) {
      try {
        const current = lstatSync(output)
        if (!sameIdentity(createdIdentity, current) || current.isSymbolicLink() || !current.isDirectory()) created = true
        else {
          rmSync(output, { recursive: true })
          syncMemoryDirectory(dirname(output))
          created = false
        }
      } catch { created = true }
    }
    error.created = created
    throw error
  }
}

function writeV6Bundle(root, manifestBytes, output) {
  let createdIdentity = null
  try {
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    if (!isV6Manifest(manifest)) fail('invalid_memory')
    const objects = readV5ObjectFiles(root)
    requireV6References(root, manifest, objects)
    mkdirSync(output, { mode: 0o700 })
    createdIdentity = lstatSync(output)
    chmodSync(output, 0o700)
    syncMemoryDirectory(dirname(output))
    writeExclusiveMemorySnapshot(join(output, 'memory-v1.json'), manifestBytes, { syncDirectory: false })
    let totalBytes = manifestBytes.length
    for (const object of objects) {
      writeExclusiveMemorySnapshot(join(output, object.name), object.bytes, { syncDirectory: false })
      totalBytes += object.bytes.length
    }
    syncMemoryDirectory(output)
    return { bytes: totalBytes, objects: objects.length }
  } catch (error) {
    let created = createdIdentity !== null
    if (created) {
      try {
        const current = lstatSync(output)
        if (!sameIdentity(createdIdentity, current) || current.isSymbolicLink() || !current.isDirectory()) created = true
        else {
          rmSync(output, { recursive: true })
          syncMemoryDirectory(dirname(output))
          created = false
        }
      } catch { created = true }
    }
    error.created = created
    throw error
  }
}

function readV5Bundle(input) {
  const store = new MemoryStore({ stateRoot: input })
  const snapshot = store.readSnapshot()
  if (!snapshot.exists || snapshot.doc.format !== 5 || snapshot.bytes === null) fail('invalid_memory')
  const manifest = JSON.parse(snapshot.bytes.toString('utf8'))
  if (!isV5Manifest(manifest)) fail('invalid_memory')
  // Read and validate every exact audit body, not only the legacy 96-row projection.
  const requests = store.listRequests()
  const objects = readV5ObjectFiles(store.root)
  requireV5References(manifest, objects)
  const allowed = new Set(['memory-v1.json', ...objects.map(object => object.name)])
  if (readdirSync(store.root).some(name => !allowed.has(name))) fail('invalid_store')
  const present = new Set(objects.map(object => object.name))
  for (const name of allowed) {
    if (name !== 'memory-v1.json' && !present.has(name)) fail('invalid_memory')
  }
  return { root: store.root, manifestBytes: snapshot.bytes, manifest, objects, requests,
    entries: snapshot.doc.entries.length, problems: snapshot.doc.problemLoop?.problems.length ?? 0 }
}

function readV6Bundle(input) {
  const store = new MemoryStore({ stateRoot: input })
  const snapshot = store.readSnapshot()
  if (!snapshot.exists || snapshot.doc.format !== 6 || snapshot.bytes === null) fail('invalid_memory')
  const manifest = JSON.parse(snapshot.bytes.toString('utf8'))
  if (!isV6Manifest(manifest)) fail('invalid_memory')
  const requests = store.listRequests()
  const objects = readV5ObjectFiles(store.root)
  requireV6References(store.root, manifest, objects)
  const allowed = new Set(['memory-v1.json', ...objects.map(object => object.name)])
  if (readdirSync(store.root).some(name => !allowed.has(name))) fail('invalid_store')
  return { root: store.root, manifestBytes: snapshot.bytes, manifest, objects, requests,
    entries: snapshot.doc.entries.length, problems: snapshot.doc.problemLoop?.problems.length ?? 0 }
}

function referencesTarget(doc, id, requests = doc.requests) {
  const requestRef = requests.some(row => row.settled !== true
    && (row.entryId === id || row.evidenceIds.includes(id)
      || row.digestAdmission?.some(ref => ref.entryId === id)))
  const receiptRef = doc.receipts.some(row => row.settled !== true
    && row.offered.some(offer => offer.id === id))
  return requestRef || receiptRef
}

function inspect(stateRoot) {
  const store = new MemoryStore({ stateRoot })
  const snapshot = store.readSnapshot()
  try {
    const root = lstatSync(store.root)
    if (root.isSymbolicLink() || !root.isDirectory()) fail('state_unavailable')
  } catch (error) {
    if (error instanceof LearningError) throw error
    fail('state_unavailable')
  }
  const doc = snapshot.doc
  const stats = store.stats()
  const requests = store.listRequests()
  if (snapshot.exists && doc.format === 5) {
    const manifest = JSON.parse(snapshot.bytes.toString('utf8'))
    requireV5References(manifest, readV5ObjectFiles(store.root))
  } else if (snapshot.exists && doc.format === 6) {
    const manifest = JSON.parse(snapshot.bytes.toString('utf8'))
    requireV6References(store.root, manifest, readV5ObjectFiles(store.root))
  }
  const counts = Object.fromEntries(['entries', 'receipts', 'requests', 'turnFacts', 'materials',
    'checkEvents', 'routes', 'corrections', 'methodHistory', 'turnUsage']
    .map(key => [key, key === 'requests' ? stats.requests : doc[key].length]))
  const entriesByType = {}
  const entriesByStatus = {}
  for (const row of doc.entries) {
    entriesByType[row.type] = (entriesByType[row.type] ?? 0) + 1
    entriesByStatus[row.status] = (entriesByStatus[row.status] ?? 0) + 1
  }
  const archivableRetiredCount = doc.entries.filter(row => row.status === 'retired'
    && requests.every(row => row.settled === true) && !referencesTarget(doc, row.id, requests)).length
  const inFlightRequests = requests.filter(row => row.settled !== true).length
  const unsettledReceiptsReferencingRetired = doc.receipts.filter(row => row.settled !== true
    && row.offered.some(offer => doc.entries.some(entry => entry.id === offer.id
      && entry.status === 'retired'))).length
  return { ok: true, operation: 'inspect', phase: 'complete', storeExists: snapshot.exists,
    format: snapshot.exists ? doc.format : null, bytes: stats.bytes,
    capacity: { entries: { used: doc.entries.length, limit: null, legacyLimit: ENTRY_LIMIT },
      bytes: { used: stats.bytes, maxObjectBytes: MAX_STORE_BYTES } },
    counts: { ...counts, entriesByType, entriesByStatus },
    unsettled: { requests: requests.filter(row => row.settled !== true).length,
      receipts: doc.receipts.filter(row => row.settled !== true).length },
    archivableRetiredCount, archiveBlockedReasons: { inFlightRequests,
      unsettledReceiptsReferencingRetired } }
}

function exportSnapshot(stateRoot, output) {
  progress.phase = 'reading_source'
  const store = new MemoryStore({ stateRoot })
  store.readSnapshot() // resolve and validate the directory before acquiring the lease
  return withMemoryStoreLock(store.root, () => {
    const snapshot = store.readSnapshot()
    if (!snapshot.exists || snapshot.bytes === null) fail('state_unavailable')
    const objectCount = [5, 6].includes(snapshot.doc.format) ? store.listRequests().length : 0
    progress.phase = 'source_validated'
    try {
      if ([5, 6].includes(snapshot.doc.format)) {
        const written = snapshot.doc.format === 6
          ? writeV6Bundle(store.root, snapshot.bytes, output)
          : writeV5Bundle(store.root, snapshot.bytes, output)
        progress.backup = { created: true, durable: true }
        progress.phase = 'complete'
        return { ok: true, operation: 'export', format: snapshot.doc.format, bytes: written.bytes,
          objects: written.objects, requests: objectCount, bundle: true,
          containsPrivateLearningData: true, ...progressFields() }
      }
      writeExclusiveMemorySnapshot(output, snapshot.bytes)
    } catch (error) {
      progress.backup = { created: error?.created === true || error?.committed === true,
        durable: error?.committed === true || error?.created === true ? false : null }
      progress.phase = progress.backup.created ? 'backup_created' : 'backup_failed'
      throw error
    }
    progress.backup = { created: true, durable: true }
    progress.phase = 'complete'
    return { ok: true, operation: 'export', format: snapshot.doc.format, bytes: snapshot.bytes.length,
      bundle: false, containsPrivateLearningData: true, ...progressFields() }
  })
}

function preflightRecoveryTarget(stateRoot) {
  let target
  try { target = lstatSync(stateRoot) }
  catch (error) {
    if (error?.code === 'ENOENT') return
    progress.phase = 'rejected'
    throw error
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (target.isSymbolicLink() || !target.isDirectory()) {
    progress.phase = 'rejected'
    fail('invalid_store')
  }
  if (process.platform !== 'win32' && (typeof uid !== 'number' || target.uid !== uid)) {
    progress.phase = 'rejected'
    fail('state_unavailable')
  }
  let children
  try { children = readdirSync(stateRoot) }
  catch (error) { progress.phase = 'rejected'; throw error }
  if (children.length > 0) {
    progress.phase = 'rejected'
    fail('invalid_store')
  }
}

function archiveRetired(stateRoot, output, ids) {
  const store = new MemoryStore({ stateRoot })
  const initial = store.readSnapshot()
  if (!initial.exists) fail('state_unavailable')
  progress.phase = 'source_validated'
  return store.transaction((doc, source) => {
    if (!source.exists || source.bytes === null) fail('state_unavailable')
    const targets = ids.map(id => doc.entries.find(row => row.id === id))
    const requests = store.listRequests()
    if (targets.some(row => row === undefined || row.status !== 'retired')
      || requests.some(row => row.settled !== true)
      || ids.some(id => referencesTarget(doc, id, requests))) {
      progress.phase = 'rejected'
      fail('invalid_memory')
    }
    // The snapshot is written while the source writer lock is held and before any mutation.
    progress.phase = 'backup_writing'
    try {
      if ([5, 6].includes(doc.format)) {
        if (doc.format === 6) writeV6Bundle(store.root, source.bytes, output)
        else writeV5Bundle(store.root, source.bytes, output)
        progress.backup = { created: true, durable: true }
        progress.phase = 'backup_durable'
      } else writeExclusiveMemorySnapshot(output, source.bytes)
    }
    catch (error) {
      progress.backup = { created: error?.created === true || error?.committed === true,
        durable: error?.committed === true || error?.created === true ? false : null }
      progress.phase = progress.backup.created ? 'backup_created' : 'backup_failed'
      throw error
    }
    progress.backup = { created: true, durable: true }
    progress.phase = 'backup_durable'
    const selected = new Set(ids)
    doc.entries = doc.entries.filter(row => !selected.has(row.id))
    progress.sourceAttempted = true
    progress.phase = 'source_commit'
    return { ok: true, operation: 'archive-retired', archivedIds: [...ids],
      archivedSnapshotContainsPrivateLearningData: true }
  })
}

function recoverCopy(input, stateRoot) {
  let inputStat
  try { inputStat = lstatSync(input) }
  catch (error) { throw error }
  if (inputStat.isSymbolicLink()) fail('invalid_store')
  if (inputStat.isDirectory()) return recoverBundleCopy(input, stateRoot)
  const bytes = readBoundedMemoryFileBytes(input, MAX_STORE_BYTES)
  let source
  try { source = decodeMemoryDocument(bytes); validateDoc(source) }
  catch { fail('invalid_memory') }
  progress.phase = 'export_validated'
  // Refuse an existing nonempty directory before MemoryStore can tighten its mode. The same
  // emptiness check runs again under the writer lock below to close the race before commit.
  preflightRecoveryTarget(stateRoot)
  const store = new MemoryStore({ stateRoot })
  const result = store.transaction((destination, current) => {
    if (current.exists) { progress.phase = 'rejected'; fail('state_unavailable') }
    const extra = readdirSync(store.root).filter(name => name !== '.memory-v1.lock')
    if (extra.length > 0) { progress.phase = 'rejected'; fail('invalid_store') }
    for (const key of Object.keys(destination)) delete destination[key]
    Object.assign(destination, source)
    progress.targetAttempted = true
    progress.phase = 'target_commit'
    return { ok: true, operation: 'recover-copy', format: source.format,
      entries: source.entries.length }
  })
  progress.target = { committed: true, durable: true }
  progress.phase = 'complete'
  return { ...result, ...progressFields() }
}

function recoverBundleCopy(input, stateRoot) {
  let bundle
  try { bundle = readV6Bundle(input) }
  catch (v6Error) {
    if (!(v6Error instanceof LearningError) || v6Error.code !== 'invalid_memory') throw v6Error
    bundle = readV5Bundle(input)
  }
  progress.phase = 'export_validated'
  preflightRecoveryTarget(stateRoot)
  const targetRoot = prepareMemoryDirectory(stateRoot)
  const createdObjects = []
  let manifestCommitted = false
  try {
    withMemoryStoreLock(targetRoot, () => {
      try {
        const extra = readdirSync(targetRoot).filter(name => name !== '.memory-v1.lock')
        if (extra.length > 0) { progress.phase = 'rejected'; fail('invalid_store') }
        for (const object of bundle.objects) {
          const path = join(targetRoot, object.name)
          writeExclusiveMemorySnapshot(path, object.bytes, { syncDirectory: false })
          createdObjects.push({ path, identity: lstatSync(path) })
        }
        syncMemoryDirectory(targetRoot)
        progress.targetAttempted = true
        progress.phase = 'target_commit'
        commitMemoryFile(join(targetRoot, 'memory-v1.json'), bundle.manifestBytes)
        manifestCommitted = true
      } catch (error) {
        // Cleanup is part of the same target lease. A second writer can never publish a manifest
        // that references one of these objects between the failed copy and its rollback.
        if (!manifestCommitted && error?.committed !== true) {
          for (const { path, identity } of createdObjects) {
            try {
              const current = lstatSync(path)
              if (!current.isSymbolicLink() && current.isFile() && sameIdentity(identity, current)) unlinkSync(path)
            } catch {}
          }
          try { syncMemoryDirectory(targetRoot) } catch {}
        }
        throw error
      }
    })
  } catch (error) { throw error }
  progress.target = { committed: true, durable: true }
  progress.phase = 'complete'
  return { ok: true, operation: 'recover-copy', format: bundle.manifest.format, entries: bundle.entries,
    problems: bundle.problems, requests: bundle.requests.length, ...progressFields() }
}

function main(args) {
  const [command, ...rest] = args
  progress = { phase: 'validating', backup: { created: false, durable: null },
    source: { committed: false, durable: null }, target: { committed: false, durable: null },
    sourceAttempted: false, targetAttempted: false }
  if (!['inspect', 'export', 'archive-retired', 'recover-copy'].includes(command)) {
    fail('invalid_arguments')
  }
  const options = parseOptions(command, rest)
  if (command === 'inspect') return inspect(options['--state-root'])
  if (command === 'export') return exportSnapshot(options['--state-root'], options['--output'])
  if (command === 'archive-retired') {
    try {
      const result = archiveRetired(options['--state-root'], options['--output'], options.ids)
      progress.source = { committed: true, durable: true }
      progress.phase = 'complete'
      return { ...result, ...progressFields() }
    } catch (error) {
      if (progress.sourceAttempted && error?.committed === true) {
        progress.source = { committed: true, durable: false }
        progress.phase = 'source_committed'
      }
      throw error
    }
  }
  try { return recoverCopy(options['--input'], options['--state-root']) }
  catch (error) {
    if (progress.targetAttempted && error?.committed === true) {
      progress.target = { committed: true, durable: false }
      progress.phase = 'target_committed'
    }
    throw error
  }
}

try {
  process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`)
} catch (error) {
  const code = SAFE_ERROR_CODES.has(error?.code) ? error.code : 'state_unavailable'
  if (progress.phase === 'validating') progress.phase = 'rejected'
  process.stdout.write(`${JSON.stringify({ ok: false, code, ...progressFields() })}\n`)
  process.exitCode = 1
}
