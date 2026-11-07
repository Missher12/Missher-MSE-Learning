import { lstatSync, readdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { LearningError, MAX_STORE_BYTES } from '../src/store.mjs'
import { ENTRY_LIMIT, MemoryStore, validateDoc } from '../rebuild/memory.mjs'
import { readBoundedMemoryFileBytes, writeExclusiveMemorySnapshot } from '../rebuild/storage.mjs'

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

function referencesTarget(doc, id) {
  const requestRef = doc.requests.some(row => row.settled !== true
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
  const counts = Object.fromEntries(['entries', 'receipts', 'requests', 'turnFacts', 'materials',
    'checkEvents', 'routes', 'corrections', 'methodHistory', 'turnUsage']
    .map(key => [key, doc[key].length]))
  const entriesByType = {}
  const entriesByStatus = {}
  for (const row of doc.entries) {
    entriesByType[row.type] = (entriesByType[row.type] ?? 0) + 1
    entriesByStatus[row.status] = (entriesByStatus[row.status] ?? 0) + 1
  }
  const archivableRetiredCount = doc.entries.filter(row => row.status === 'retired'
    && doc.requests.every(row => row.settled === true) && !referencesTarget(doc, row.id)).length
  const inFlightRequests = doc.requests.filter(row => row.settled !== true).length
  const unsettledReceiptsReferencingRetired = doc.receipts.filter(row => row.settled !== true
    && row.offered.some(offer => doc.entries.some(entry => entry.id === offer.id
      && entry.status === 'retired'))).length
  return { ok: true, operation: 'inspect', phase: 'complete', storeExists: snapshot.exists,
    format: snapshot.exists ? doc.format : null, bytes: snapshot.bytes?.length ?? 0,
    capacity: { entries: { used: doc.entries.length, limit: ENTRY_LIMIT },
      bytes: { used: snapshot.bytes?.length ?? 0, limit: MAX_STORE_BYTES } },
    counts: { ...counts, entriesByType, entriesByStatus },
    unsettled: { requests: doc.requests.filter(row => row.settled !== true).length,
      receipts: doc.receipts.filter(row => row.settled !== true).length },
    archivableRetiredCount, archiveBlockedReasons: { inFlightRequests,
      unsettledReceiptsReferencingRetired } }
}

function exportSnapshot(stateRoot, output) {
  progress.phase = 'reading_source'
  const snapshot = new MemoryStore({ stateRoot }).readSnapshot()
  if (!snapshot.exists || snapshot.bytes === null) fail('state_unavailable')
  progress.phase = 'source_validated'
  try { writeExclusiveMemorySnapshot(output, snapshot.bytes) }
  catch (error) {
    progress.backup = { created: error?.created === true || error?.committed === true,
      durable: error?.committed === true || error?.created === true ? false : null }
    progress.phase = progress.backup.created ? 'backup_created' : 'backup_failed'
    throw error
  }
  progress.backup = { created: true, durable: true }
  progress.phase = 'complete'
  return { ok: true, operation: 'export', bytes: snapshot.bytes.length,
    containsPrivateLearningData: true, ...progressFields() }
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
  if (typeof uid !== 'number' || target.uid !== uid) {
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
    if (targets.some(row => row === undefined || row.status !== 'retired')
      || doc.requests.some(row => row.settled !== true)
      || ids.some(id => referencesTarget(doc, id))) {
      progress.phase = 'rejected'
      fail('invalid_memory')
    }
    // The snapshot is written while the source writer lock is held and before any mutation.
    progress.phase = 'backup_writing'
    try { writeExclusiveMemorySnapshot(output, source.bytes) }
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
  const bytes = readBoundedMemoryFileBytes(input, MAX_STORE_BYTES)
  let source
  try { source = JSON.parse(bytes.toString('utf8')); validateDoc(source) }
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
