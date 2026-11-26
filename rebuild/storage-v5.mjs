/** Format-5 chunk manifest: every published payload is immutable and individually bounded. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { LearningError, MAX_STORE_BYTES, check } from '../src/store.mjs'
import { commitMemoryFile, readBoundedMemoryFileBytes, writeExclusiveMemorySnapshot,
  syncMemoryDirectory } from './storage.mjs'
import { buildRecallIndex, parseRecallShard, queryRecallFeatures, recallFeatureShard,
  recallCandidates, serializeRecallShard, updateRecallIndex, entryRecallFeatures } from './recall-index.mjs'

export const V5_STORAGE_SCHEMA = 'mse-capacity-store-v1'
export const V5_OBJECT_PREFIX = '.memory-v1-object-'
export const V5_BUCKETS = 256
export const V5_TURN_FACT_BUCKETS = 16
export const V5_REQUEST_PROJECTION_LIMIT = 96
const HASH = /^[a-f0-9]{64}$/u
const indexHash = value => createHash('sha256').update(value).digest('hex')
const requestIndexLimit = 64 * 1024
const requestIndexRows = 128
const OBJECT_CACHE_LIMIT = 512
const OBJECT_CACHE_BYTES = 32 * 1024 * 1024
const objectCache = new Map()
let cachedObjectBytes = 0
const batchedObjectRoots = new Set()
const dirtyObjectRoots = new Set()

const objectPath = (root, hash) => join(root, `${V5_OBJECT_PREFIX}${hash}.json`)
const asJsonBytes = value => Buffer.from(JSON.stringify(value), 'utf8')
const objectCacheKey = (root, hash) => `${root}\u0000${hash}`
const objectIdentity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')

function cachedObjectIdentity(root, hash) {
  const key = objectCacheKey(root, hash)
  const cached = objectCache.get(key)
  if (cached === undefined) return false
  try {
    const stat = lstatSync(objectPath(root, hash), { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink() || objectIdentity(stat) !== cached.identity) {
      objectCache.delete(key)
      cachedObjectBytes -= cached.weight
      return false
    }
    objectCache.delete(key)
    objectCache.set(key, cached)
    return true
  } catch {
    objectCache.delete(key)
    cachedObjectBytes -= cached.weight
    return false
  }
}

function putObject(root, value) {
  const bytes = Buffer.isBuffer(value) ? value : asJsonBytes(value)
  check(bytes.length <= MAX_STORE_BYTES, 'capacity')
  const hash = indexHash(bytes)
  const path = objectPath(root, hash)
  if (existsSync(path)) {
    if (cachedObjectIdentity(root, hash)) return hash
    const existing = readBoundedMemoryFileBytes(path)
    if (!existing.equals(bytes)) throw new LearningError('invalid_memory')
    return hash
  }
  try { writeExclusiveMemorySnapshot(path, bytes,
    { syncDirectory: !batchedObjectRoots.has(root) }) }
  catch (error) {
    // A content-addressed object can be left behind by an earlier failed manifest commit.
    if (existsSync(path)) {
      const existing = readBoundedMemoryFileBytes(path)
      if (existing.equals(bytes)) {
        if (batchedObjectRoots.has(root)) dirtyObjectRoots.add(root)
        return hash
      }
    }
    throw error
  }
  if (batchedObjectRoots.has(root)) dirtyObjectRoots.add(root)
  return hash
}

function readObjectBytes(root, hash) {
  check(typeof hash === 'string' && HASH.test(hash), 'invalid_memory')
  const bytes = readBoundedMemoryFileBytes(objectPath(root, hash))
  check(indexHash(bytes) === hash, 'invalid_memory')
  return bytes
}

function readObjectValue(root, hash) {
  const path = objectPath(root, hash)
  const key = objectCacheKey(root, hash)
  try {
    const stat = lstatSync(path, { bigint: true })
    check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= BigInt(MAX_STORE_BYTES), 'invalid_memory')
    const identity = objectIdentity(stat)
    const cached = objectCache.get(key)
    if (cached?.identity === identity) {
      objectCache.delete(key)
      objectCache.set(key, cached)
      return cached.value
    }
    if (cached !== undefined) {
      objectCache.delete(key)
      cachedObjectBytes -= cached.weight
    }
    const bytes = readObjectBytes(root, hash)
    const value = JSON.parse(bytes.toString('utf8'))
    const after = lstatSync(path, { bigint: true })
    check(after.isFile() && !after.isSymbolicLink()
      && objectIdentity(after) === identity,
    'invalid_memory')
    const weight = bytes.length
    if (weight <= OBJECT_CACHE_BYTES) {
      objectCache.set(key, { identity, value, weight })
      cachedObjectBytes += weight
      while (objectCache.size > OBJECT_CACHE_LIMIT || cachedObjectBytes > OBJECT_CACHE_BYTES) {
        const oldestKey = objectCache.keys().next().value
        const oldest = objectCache.get(oldestKey)
        objectCache.delete(oldestKey)
        cachedObjectBytes -= oldest.weight
      }
    }
    return value
  }
  catch (error) {
    if (error instanceof LearningError) throw error
    throw new LearningError('invalid_memory')
  }
}

function readObject(root, hash) { return structuredClone(readObjectValue(root, hash)) }

// Format 6 keeps the same immutable object envelope and request index encoding. These narrow
// helpers are shared so the v5 read path remains frozen while the new manifest changes its list
// roots.
export const readStoredObject = readObject
export const readStoredObjectValue = readObjectValue
export const putStoredObject = putObject
export function withStoredObjectBatch(root, action) {
  batchedObjectRoots.add(root)
  try { return action() }
  finally { batchedObjectRoots.delete(root) }
}
export function syncStoredObjects(root) {
  if (!dirtyObjectRoots.has(root)) return
  syncMemoryDirectory(root)
  dirtyObjectRoots.delete(root)
}

function validRefs(value, length = null) {
  return Array.isArray(value) && (length === null || value.length === length)
    && value.every(ref => ref === null || typeof ref === 'string' && HASH.test(ref))
}

export function isV5Manifest(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || value.format !== 5 || value.storageSchema !== V5_STORAGE_SCHEMA
    || typeof value.generation !== 'string' || value.generation.length < 16
    || !Number.isFinite(value.updatedAt)
    || !Number.isSafeInteger(value.entryCount) || value.entryCount < 0 || value.entryCount > 4096
    || !Number.isSafeInteger(value.problemCount) || value.problemCount < 0 || value.problemCount > 4096
    || !Number.isSafeInteger(value.requestCount) || value.requestCount < 0
    || !Number.isSafeInteger(value.nextRequestSequence) || value.nextRequestSequence < value.requestCount
    || !Array.isArray(value.entryOrder) || value.entryOrder.length !== value.entryCount
    || value.entryOrder.some(id => typeof id !== 'string' || !/^mem_[a-f0-9]{24}$/u.test(id))
    || new Set(value.entryOrder).size !== value.entryOrder.length
    || !Array.isArray(value.problemOrder) || value.problemOrder.length !== value.problemCount
    || value.problemOrder.some(id => typeof id !== 'string' || !HASH.test(id))
    || new Set(value.problemOrder).size !== value.problemOrder.length
    || (value.turnFactBuckets !== undefined
      && (!validRefs(value.turnFactBuckets, V5_TURN_FACT_BUCKETS)
        || !Number.isSafeInteger(value.turnFactCount) || value.turnFactCount < 0 || value.turnFactCount > 256
        || !Array.isArray(value.turnFactOrder) || value.turnFactOrder.length !== value.turnFactCount
        || value.turnFactOrder.some(id => typeof id !== 'string' || !HASH.test(id))
        || new Set(value.turnFactOrder).size !== value.turnFactOrder.length))
    || (value.turnFactBuckets === undefined
      && (value.turnFactCount !== undefined || value.turnFactOrder !== undefined))
    || !validRefs(value.entryBuckets, V5_BUCKETS)
    || !validRefs(value.problemBuckets, V5_BUCKETS)
    || !validRefs(value.recallShards, V5_BUCKETS)
    || !validRefs(value.requestIndexShards, V5_BUCKETS)
    || !Array.isArray(value.requestProjection) || value.requestProjection.length > V5_REQUEST_PROJECTION_LIMIT
    || value.requestProjection.some(row => row === null || typeof row !== 'object' || Array.isArray(row)
      || typeof row.ticket !== 'string' || row.ticket.length === 0 || row.ticket.length > 64
      || !Number.isSafeInteger(row.sequence) || row.sequence < 0)
    || new Set(value.requestProjection.map(row => row.ticket)).size !== value.requestProjection.length
    || !Array.isArray(value.activeRequests) || value.activeRequests.length > V5_REQUEST_PROJECTION_LIMIT
    || value.activeRequests.some(ticket => typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 64)
    || new Set(value.activeRequests).size !== value.activeRequests.length
    || !Array.isArray(value.materialLatest) || value.materialLatest.length > 64
    || value.materialLatest.some(row => row === null || typeof row !== 'object' || Array.isArray(row)
      || !HASH.test(row.material) || typeof row.ticket !== 'string' || row.ticket.length === 0
      || row.ticket.length > 64 || !Number.isSafeInteger(row.sequence) || row.sequence < 0)
    || new Set(value.materialLatest.map(row => row.material)).size !== value.materialLatest.length
    || value.migrationSource !== null && !HASH.test(value.migrationSource)
    || !hotStateValid(value.hotState)
    || (value.problemHeader !== null && (typeof value.problemHeader !== 'string' || !HASH.test(value.problemHeader)))
    || value.coreRefs === null || typeof value.coreRefs !== 'object' || Array.isArray(value.coreRefs)
    || Object.entries(value.coreRefs).some(([key, ref]) => !/^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(key)
      || !HASH.test(ref))) return false
  if (value.turnFactBuckets !== undefined && Object.hasOwn(value.coreRefs, 'turnFacts')) return false
  return true
}

function requestMetadata(row) {
  return { ticket: row.ticket, at: row.at, kind: row.kind, problemId: row.problemId,
    entryId: row.entryId, digestDay: row.digestDay, requestHash: row.requestHash,
    dispatchHash: row.dispatchHash, dispatchedAt: row.dispatchedAt, settled: row.settled,
    terminal: row.terminal, usage: row.usage, maxTokens: row.maxTokens, evidenceIds: row.evidenceIds,
    tokenHashes: row.tokenHashes, parentVersion: row.parentVersion, routeId: row.routeId,
    material: row.material, retryOf: row.retryOf, sourceSessionId: row.sourceSessionId,
    sourceRoute: row.sourceRoute, methodFingerprint: row.methodFingerprint ?? null,
    verdictFields: row.verdictFields ?? null, verdictCode: row.verdictCode ?? null,
    outputBytes: row.outputBytes ?? null,
    finishKind: row.finishKind ?? null }
}
const indexedRequestMetadata = (row, sequence) => ({ ...requestMetadata(row), sequence })

function requestHash(ticket) { return indexHash(ticket) }
function bucketFromHash(hash) { return Number.parseInt(hash.slice(0, 2), 16) }
function emptyRequestLeaf(depth) { return { kind: 'leaf', depth, rows: [] } }

function readRequestNode(root, reference, depth) {
  if (reference === null) return emptyRequestLeaf(depth)
  const node = readObject(root, reference)
  check(node !== null && typeof node === 'object' && !Array.isArray(node)
    && (node.kind === 'leaf' || node.kind === 'branch') && node.depth === depth, 'invalid_memory')
  if (node.kind === 'leaf') {
    check(Array.isArray(node.rows) && node.rows.length <= requestIndexRows
      && node.rows.every(row => Array.isArray(row) && row.length === 3
        && typeof row[0] === 'string' && row[0].length > 0 && row[0].length <= 64
        && HASH.test(row[1]) && row[2]?.ticket === row[0]
        && Number.isSafeInteger(row[2]?.sequence) && row[2].sequence >= 0)
      && new Set(node.rows.map(row => row[0])).size === node.rows.length, 'invalid_memory')
  } else {
    check(depth < 64 && node.children !== null && typeof node.children === 'object'
      && !Array.isArray(node.children)
      && Object.entries(node.children).every(([key, ref]) => /^[0-9a-f]{2}$/u.test(key) && HASH.test(ref)),
    'invalid_memory')
  }
  return node
}

function writeRequestNode(root, reference, depth, ticket, bodyHash, metadata) {
  const route = requestHash(ticket)
  const node = readRequestNode(root, reference, depth)
  if (node.kind === 'branch') {
    const selector = route.slice(depth, depth + 2)
    const child = node.children[selector] ?? null
    const nextChild = writeRequestNode(root, child, depth + 2, ticket, bodyHash, metadata)
    const children = { ...node.children, [selector]: nextChild }
    return putObject(root, { kind: 'branch', depth, children })
  }
  const rows = new Map(node.rows.map(([key, rowHash, meta]) => [key, [rowHash, meta]]))
  rows.set(ticket, [bodyHash, metadata])
  const sortedRows = [...rows].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, [rowHash, meta]]) => [key, rowHash, meta])
  const leaf = { kind: 'leaf', depth, rows: sortedRows }
  const leafBytes = asJsonBytes(leaf)
  if (sortedRows.length <= requestIndexRows && leafBytes.length <= requestIndexLimit) {
    return putObject(root, leafBytes)
  }
  check(depth < 64, 'capacity')
  const children = {}
  const groups = new Map()
  for (const row of sortedRows) {
    const selector = requestHash(row[0]).slice(depth, depth + 2)
    const list = groups.get(selector) ?? []
    list.push(row)
    groups.set(selector, list)
  }
  for (const [selector, grouped] of groups) {
    const childLeaf = { kind: 'leaf', depth: depth + 2, rows: grouped }
    children[selector] = putObject(root, childLeaf)
  }
  return putObject(root, { kind: 'branch', depth, children })
}

function findRequestPointer(root, manifest, ticket) {
  const digest = requestHash(ticket)
  let reference = manifest.requestIndexShards[bucketFromHash(digest)]
  if (reference === null) return null
  let depth = 2
  while (reference !== null) {
    const node = readRequestNode(root, reference, depth)
    if (node.kind === 'leaf') {
      const row = node.rows.find(item => item[0] === ticket)
      return row === undefined ? null : { bodyHash: row[1], metadata: row[2] }
    }
    const selector = digest.slice(depth, depth + 2)
    reference = node.children[selector] ?? null
    depth += 2
  }
  return null
}

function readRequestBody(root, manifest, ticket, validateRequest = null) {
  const pointer = findRequestPointer(root, manifest, ticket)
  if (pointer === null) return undefined
  const row = readObject(root, pointer.bodyHash)
  check(row?.ticket === ticket
    && JSON.stringify(indexedRequestMetadata(row, pointer.metadata.sequence)) === JSON.stringify(pointer.metadata),
  'invalid_memory')
  validateRequest?.(row)
  return row
}

function walkRequestIndex(root, reference, depth, rows, references = null) {
  if (reference === null) return
  references?.add(reference)
  const node = readRequestNode(root, reference, depth)
  if (node.kind === 'leaf') {
    rows.push(...node.rows)
    for (const row of node.rows) references?.add(row[1])
    return
  }
  for (const selector of Object.keys(node.children).sort()) {
    walkRequestIndex(root, node.children[selector], depth + 2, rows, references)
  }
}

function readBucketRows(root, refs, validateRow) {
  const rows = []
  for (const ref of refs) {
    if (ref === null) continue
    const bucket = readObject(root, ref)
    check(Array.isArray(bucket), 'invalid_memory')
    for (const row of bucket) {
      validateRow(row)
      rows.push(row)
    }
  }
  return rows
}

function hashBucket(row) { return bucketFromHash(indexHash(row.id)) }
function turnFactBucket(row) { return hashBucket(row) % V5_TURN_FACT_BUCKETS }

function buildRowsInBuckets(rows, validateRow) {
  const buckets = Array.from({ length: V5_BUCKETS }, () => [])
  for (const row of rows ?? []) {
    validateRow(row)
    buckets[hashBucket(row)].push(row)
  }
  return buckets
}

function buildTurnFactBuckets(rows, validateRow) {
  const buckets = Array.from({ length: V5_TURN_FACT_BUCKETS }, () => [])
  for (const row of rows ?? []) {
    validateRow?.(row)
    buckets[turnFactBucket(row)].push(row)
  }
  return buckets
}

function copyCore(doc) {
  const excluded = new Set(['format', 'updatedAt', 'entries', 'requests', 'turnFacts', 'problemLoop', 'storage',
    'receipts', 'midTurnReceipts', 'turnUsage'])
  return Object.fromEntries(Object.entries(doc).filter(([key]) => !excluded.has(key)))
}

function usageOverlay(entry) {
  return { id: entry.id, injected: entry.injected, lastInjectedAt: entry.lastInjectedAt,
    methodStats: entry.methodStats ?? null }
}

function usageOverlayValid(row) {
  return row !== null && typeof row === 'object' && !Array.isArray(row)
    && Object.keys(row).every(key => ['id', 'injected', 'lastInjectedAt', 'methodStats'].includes(key))
    && /^mem_[a-f0-9]{24}$/u.test(row.id)
    && Number.isSafeInteger(row.injected) && row.injected >= 0
    && (row.lastInjectedAt === null || Number.isFinite(row.lastInjectedAt))
    && (row.methodStats === null || row.methodStats !== undefined
      && typeof row.methodStats === 'object' && !Array.isArray(row.methodStats))
}

function hotStateValid(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['receipts', 'midTurnReceipts', 'turnUsage', 'entryUsage'].includes(key))
    && Array.isArray(value.receipts) && Array.isArray(value.midTurnReceipts)
    && Array.isArray(value.turnUsage) && Array.isArray(value.entryUsage)
    && value.entryUsage.length <= 4096 && value.entryUsage.every(usageOverlayValid)
    && new Set(value.entryUsage.map(row => row.id)).size === value.entryUsage.length
}

function applyEntryUsage(entries, hotState, validateEntry = null) {
  check(hotStateValid(hotState), 'invalid_memory')
  if (hotState.entryUsage.length === 0) return entries
  const byId = new Map(hotState.entryUsage.map(row => [row.id, row]))
  for (const entry of entries) {
    const usage = byId.get(entry.id)
    if (usage === undefined) continue
    entry.injected = usage.injected
    entry.lastInjectedAt = usage.lastInjectedAt
    if (usage.methodStats === null) delete entry.methodStats
    else entry.methodStats = structuredClone(usage.methodStats)
    validateEntry?.(entry)
  }
  return entries
}

function usageOnlyEntryChange(change) {
  if (change.before === null || change.after === null) return false
  const withoutUsage = row => {
    const copy = { ...row }
    delete copy.injected
    delete copy.lastInjectedAt
    delete copy.methodStats
    return copy
  }
  return JSON.stringify(withoutUsage(change.before)) === JSON.stringify(withoutUsage(change.after))
}

function largestBucketSize(rows) {
  const buckets = buildRowsInBuckets(rows, () => {})
  let largest = 0
  for (let index = 0; index < buckets.length; index += 1) {
    if (buckets[index].length === 0) continue
    const bytes = Buffer.byteLength(JSON.stringify(buckets[index]), 'utf8')
    largest = Math.max(largest, bytes)
  }
  return largest
}

/** Capacity forecast for format 5: compare independent atomic objects, never their sum. */
export function v5DocumentFits(doc, reserve = 0, { root = null, manifest = null, entryAdds = 0 } = {}) {
  if (!Number.isSafeInteger(reserve) || reserve < 0 || !Number.isSafeInteger(entryAdds)
    || entryAdds < 0 || !Array.isArray(doc?.entries) || !Array.isArray(doc?.requests)) return false
  const entries = doc.entries
  const problems = doc.problemLoop?.problems ?? []
  const problemCount = manifest?.problemCount ?? problems.length
  if (entries.length + entryAdds > 4096 || problemCount > 4096) return false
  const maxEntryBucket = largestBucketSize(entries)
  const maxProblemBucket = largestBucketSize(problems)
  const factGroups = buildTurnFactBuckets(doc.turnFacts, null)
  const maxTurnFactBucket = Math.max(0, ...factGroups.map(rows =>
    Buffer.byteLength(JSON.stringify(rows), 'utf8')))
  const coreSizes = Object.values(copyCore(doc)).map(value => Buffer.byteLength(JSON.stringify(value), 'utf8'))
  const maxCore = Math.max(0, ...coreSizes)
  const maxRequest = Math.max(0, ...doc.requests.map(row => Buffer.byteLength(JSON.stringify(row), 'utf8')))
  const entryUsage = new Map((manifest?.hotState?.entryUsage ?? []).map(row => [row.id, row]))
  // Capacity checks must include usage rows changed by this transaction. Forecasting every
  // currently loaded entry is conservative for partial recall transactions and stays bounded.
  for (const entry of entries) entryUsage.set(entry.id, usageOverlay(entry))
  const hotState = { receipts: doc.receipts ?? [], midTurnReceipts: doc.midTurnReceipts ?? [],
    turnUsage: doc.turnUsage ?? [], entryUsage: [...entryUsage.values()] }
  const hotStateBytes = Buffer.byteLength(JSON.stringify(hotState), 'utf8')
  let maxRecallShard = 0
  if (manifest !== null && root !== null) {
    for (const reference of manifest.recallShards) {
      if (reference === null) continue
      try {
        const stat = lstatSync(objectPath(root, reference))
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_STORE_BYTES) return false
        maxRecallShard = Math.max(maxRecallShard, stat.size)
      } catch { return false }
    }
  } else {
    for (const shard of buildRecallIndex(entries)) {
      maxRecallShard = Math.max(maxRecallShard,
        Buffer.byteLength(JSON.stringify(serializeRecallShard(shard)), 'utf8'))
    }
  }
  const sizes = [maxEntryBucket + reserve, maxProblemBucket + reserve,
    maxTurnFactBucket + reserve, maxCore + reserve,
    maxRequest + reserve, maxRecallShard + reserve, hotStateBytes + reserve]
  if (sizes.some(size => size > MAX_STORE_BYTES)) return false

  // The manifest has bounded arrays and fixed-size hashes. Model the maximum legal shape so the
  // projection, order vectors, and roots are covered without reading historical request objects.
  const zeroHash = '0'.repeat(64)
  const manifestShape = { format: 5, storageSchema: V5_STORAGE_SCHEMA, generation: '0'.repeat(36),
    updatedAt: 0, entryCount: entries.length + entryAdds, problemCount,
    turnFactCount: doc.turnFacts?.length ?? 0,
    turnFactOrder: (doc.turnFacts ?? []).map(row => row.id),
    turnFactBuckets: Array(V5_TURN_FACT_BUCKETS).fill(zeroHash),
    requestCount: Number.MAX_SAFE_INTEGER, nextRequestSequence: Number.MAX_SAFE_INTEGER,
    entryOrder: Array(entries.length + entryAdds).fill(`mem_${'0'.repeat(24)}`),
    problemOrder: Array(problemCount).fill(zeroHash),
    entryBuckets: Array(V5_BUCKETS).fill(zeroHash), problemBuckets: Array(V5_BUCKETS).fill(zeroHash),
    recallShards: Array(V5_BUCKETS).fill(zeroHash), requestIndexShards: Array(V5_BUCKETS).fill(zeroHash),
    requestProjection: Array(V5_REQUEST_PROJECTION_LIMIT).fill({ ticket: 't'.repeat(64), sequence: Number.MAX_SAFE_INTEGER }),
    activeRequests: Array(3).fill('t'.repeat(64)),
    materialLatest: Array(64).fill({ material: zeroHash, ticket: 't'.repeat(64), sequence: Number.MAX_SAFE_INTEGER }),
    coreRefs: Object.fromEntries(Object.keys(copyCore(doc)).map(key => [key, zeroHash])),
    problemHeader: zeroHash, migrationSource: doc.format === 5 ? manifest?.migrationSource ?? null : zeroHash,
    hotState }
  return Buffer.byteLength(JSON.stringify(manifestShape), 'utf8') <= MAX_STORE_BYTES
}

export function loadV5Document(root, manifest, { validateEntry, validateProblem,
  validateRequest = null, validateTurnFact = null,
  includeEntries = true, includeProblems = true, includeRequests = true } = {}) {
  check(isV5Manifest(manifest), 'invalid_memory')
  const doc = { format: 5, updatedAt: manifest.updatedAt,
    entries: includeEntries ? orderRows(readBucketRows(root, manifest.entryBuckets, validateEntry), manifest.entryOrder) : [],
    requests: includeRequests ? manifest.requestProjection.map(projected => {
      const ticket = typeof projected === 'string' ? projected : projected.ticket
      const row = readRequestBody(root, manifest, ticket, validateRequest)
      check(row !== undefined, 'invalid_memory')
      return row
    }) : [] }
  for (const [key, hash] of Object.entries(manifest.coreRefs)) doc[key] = readObject(root, hash)
  if (manifest.turnFactBuckets !== undefined) {
    doc.turnFacts = orderRows(readBucketRows(root, manifest.turnFactBuckets, validateTurnFact),
      manifest.turnFactOrder)
  }
  check(hotStateValid(manifest.hotState), 'invalid_memory')
  doc.receipts = manifest.hotState.receipts
  doc.midTurnReceipts = manifest.hotState.midTurnReceipts
  doc.turnUsage = manifest.hotState.turnUsage
  if (includeEntries) {
    applyEntryUsage(doc.entries, manifest.hotState, validateEntry)
    if (manifest.hotState.entryUsage.length === 0) for (const entry of doc.entries) validateEntry?.(entry)
  }
  if (includeProblems && manifest.problemHeader !== null) {
    const header = readObject(root, manifest.problemHeader)
    check(header !== null && typeof header === 'object' && !Array.isArray(header)
      && Array.isArray(header.seenEvents), 'invalid_memory')
    const problems = orderRows(readBucketRows(root, manifest.problemBuckets, validateProblem), manifest.problemOrder)
    doc.problemLoop = { format: header.format, seenEvents: header.seenEvents, problems }
  }
  return doc
}

function writeV5DocumentImpl(root, doc, { previousManifest = null, sourceBytes = null,
  validateEntry, validateProblem, validateRequest, validateTurnFact, entryChanges = null,
  problemChanges = null, requestChanges = [], bootstrapRequests = null,
  entryOrder = null, problemOrder = null, turnFactChanges = [] } = {}) {
  const entries = doc.entries ?? []
  const problems = doc.problemLoop?.problems ?? []
  const entryBuckets = previousManifest === null
    ? buildRowsInBuckets(entries, validateEntry).map(rows => rows.length === 0 ? null : putObject(root, rows))
    : [...previousManifest.entryBuckets]
  const changes = entryChanges ?? []
  const usageChanges = new Set(changes.filter(usageOnlyEntryChange).map(change => change.id))
  const bucketChanges = changes.filter(change => !usageChanges.has(change.id))
  if (previousManifest !== null) {
    const touched = new Set(bucketChanges.map(change => bucketFromHash(indexHash(change.id))))
    for (const bucketIndex of touched) {
      const bucketRows = entryBuckets[bucketIndex] === null ? [] : readObject(root, entryBuckets[bucketIndex])
      const updates = new Map(changes.filter(change => bucketFromHash(indexHash(change.id)) === bucketIndex)
        .map(change => [change.id, change.after]))
      const merged = [...bucketRows.filter(row => !updates.has(row.id)),
        ...[...updates.values()].filter(row => row !== null)]
      for (const row of merged) validateEntry(row)
      entryBuckets[bucketIndex] = merged.length === 0 ? null : putObject(root, merged)
    }
  }
  const entryCount = previousManifest === null ? entries.length
    : previousManifest.entryCount + changes.filter(change => change.before === null && change.after !== null).length
      - changes.filter(change => change.before !== null && change.after === null).length
  const problemBuckets = previousManifest === null
    ? buildRowsInBuckets(problems, validateProblem).map(rows => rows.length === 0 ? null : putObject(root, rows))
    : [...previousManifest.problemBuckets]
  let problemCount = previousManifest?.problemCount ?? problems.length
  if (previousManifest !== null && problemChanges !== null) {
    const touched = new Set(problemChanges.map(change => bucketFromHash(indexHash(change.id))))
    for (const bucketIndex of touched) {
      const bucketRows = problemBuckets[bucketIndex] === null ? [] : readObject(root, problemBuckets[bucketIndex])
      const bucketChanges = problemChanges.filter(change => bucketFromHash(indexHash(change.id)) === bucketIndex)
      const updates = new Map(bucketChanges.map(change => [change.id, change.after]))
      for (const change of bucketChanges) {
        const existed = bucketRows.some(row => row.id === change.id)
        if (!existed && change.after !== null) problemCount += 1
        if (existed && change.after === null) problemCount -= 1
      }
      const merged = [...bucketRows.filter(row => !updates.has(row.id)),
        ...[...updates.values()].filter(row => row !== null)]
      for (const row of merged) validateProblem(row)
      problemBuckets[bucketIndex] = merged.length === 0 ? null : putObject(root, merged)
    }
  } else if (previousManifest !== null && doc.problemLoop !== undefined) {
    // Non-specialized transactions retain compatibility with callers that replace the ledger.
    const buckets = buildRowsInBuckets(problems, validateProblem)
    for (let index = 0; index < V5_BUCKETS; index += 1) {
      if (JSON.stringify(buckets[index]) === JSON.stringify(problemBuckets[index] === null
        ? [] : readObject(root, problemBuckets[index]))) continue
      problemBuckets[index] = buckets[index].length === 0 ? null : putObject(root, buckets[index])
    }
    problemCount = problems.length
  }
  let turnFactBuckets
  if (previousManifest === null || previousManifest.turnFactBuckets === undefined) {
    turnFactBuckets = buildTurnFactBuckets(doc.turnFacts, validateTurnFact)
      .map(rows => rows.length === 0 ? null : putObject(root, rows))
  } else {
    turnFactBuckets = [...previousManifest.turnFactBuckets]
    const touched = new Set(turnFactChanges.map(change => turnFactBucket({ id: change.id })))
    for (const bucketIndex of touched) {
      const bucketRows = turnFactBuckets[bucketIndex] === null
        ? [] : readObject(root, turnFactBuckets[bucketIndex])
      const changesInBucket = turnFactChanges.filter(change =>
        turnFactBucket({ id: change.id }) === bucketIndex)
      const updates = new Map(changesInBucket.map(change => [change.id, change.after]))
      const merged = [...bucketRows.filter(row => !updates.has(row.id)),
        ...[...updates.values()].filter(row => row !== null)]
      for (const row of merged) validateTurnFact?.(row)
      turnFactBuckets[bucketIndex] = merged.length === 0 ? null : putObject(root, merged)
    }
  }
  const turnFactOrder = doc.turnFacts.map(row => row.id)
  const coreRefs = {}
  for (const [key, value] of Object.entries(copyCore(doc))) coreRefs[key] = putObject(root, value)
  const problemHeader = doc.problemLoop === undefined ? previousManifest?.problemHeader ?? null
    : putObject(root, { format: doc.problemLoop.format, seenEvents: doc.problemLoop.seenEvents })
  const priorHotState = previousManifest?.hotState ?? { receipts: [], midTurnReceipts: [], turnUsage: [], entryUsage: [] }
  const entryUsage = new Map(priorHotState.entryUsage.map(row => [row.id, row]))
  for (const change of changes) {
    if (change.after === null) entryUsage.delete(change.id)
    else if (usageChanges.has(change.id)) entryUsage.set(change.id, usageOverlay(change.after))
    else entryUsage.delete(change.id)
  }
  const hotState = { receipts: doc.receipts ?? [], midTurnReceipts: doc.midTurnReceipts ?? [],
    turnUsage: doc.turnUsage ?? [], entryUsage: [...entryUsage.values()].sort((left, right) => left.id.localeCompare(right.id)) }
  check(hotStateValid(hotState), 'invalid_memory')
  let recallShards
  if (previousManifest === null) {
    const recallIndex = buildRecallIndex(entries)
    recallShards = recallIndex.map(shard => putObject(root, serializeRecallShard(shard)))
  } else {
    recallShards = [...previousManifest.recallShards]
    const recallChanges = []
    const changedShardIds = new Set()
    for (const change of changes) {
      if (usageChanges.has(change.id)) continue
      const oldFeatures = change.before === null ? [] : [...entryRecallFeatures(change.before)]
      const newFeatures = change.after === null ? [] : [...entryRecallFeatures(change.after)]
      const oldSet = new Set(oldFeatures)
      if (oldFeatures.length === newFeatures.length && newFeatures.every(feature => oldSet.has(feature))) continue
      recallChanges.push(change)
      for (const feature of [...oldFeatures, ...newFeatures]) changedShardIds.add(recallFeatureShard(feature))
    }
    if (recallChanges.length > 0) {
      const partial = Array.from({ length: V5_BUCKETS }, (_, index) => {
        if (!changedShardIds.has(index)) return null
        const ref = recallShards[index]
        return ref === null ? new Map() : parseRecallShard(readObject(root, ref))
      })
      const next = updateRecallIndex(partial, recallChanges)
      for (const index of changedShardIds) {
        recallShards[index] = putObject(root, serializeRecallShard(next[index]))
      }
    }
  }
  const requestIndexShards = previousManifest === null
    ? Array(V5_BUCKETS).fill(null) : [...previousManifest.requestIndexShards]
  const requestUpdateMap = new Map()
  for (const row of [...(bootstrapRequests ?? []), ...requestChanges]) {
    requestUpdateMap.set(row.ticket, row)
  }
  const requestRows = [...requestUpdateMap.values()]
  let requestCount = previousManifest?.requestCount ?? 0
  let nextRequestSequence = previousManifest?.nextRequestSequence ?? 0
  const changedRequestSequences = new Map()
  const newRequestTickets = new Set()
  for (const row of requestRows) {
    validateRequest?.(row)
    const bodyHash = putObject(root, row)
    const digest = requestHash(row.ticket)
    const index = bucketFromHash(digest)
    const rootHash = requestIndexShards[index]
    const lookupManifest = manifestForLookup(previousManifest, requestIndexShards)
    const prior = findRequestPointer(root, lookupManifest, row.ticket)
    if (prior === null) { requestCount += 1; newRequestTickets.add(row.ticket) }
    const sequence = prior?.metadata.sequence ?? nextRequestSequence++
    changedRequestSequences.set(row.ticket, sequence)
    requestIndexShards[index] = writeRequestNode(root, rootHash, 2, row.ticket, bodyHash,
      indexedRequestMetadata(row, sequence))
  }
  const projection = new Map(previousManifest === null ? []
    : previousManifest.requestProjection.map(row => Array.isArray(row)
      ? [row[0], row[1]] : [row.ticket, row.sequence]))
  if (previousManifest === null) {
    requestRows.forEach((row, index) => projection.set(row.ticket, index))
  } else {
    for (const row of requestRows) {
      if (projection.has(row.ticket) || newRequestTickets.has(row.ticket)) {
        projection.set(row.ticket, changedRequestSequences.get(row.ticket))
      }
    }
  }
  const existingProjection = [...projection].sort((left, right) => left[1] - right[1])
    .slice(-V5_REQUEST_PROJECTION_LIMIT).map(([ticket, sequence]) => ({ ticket, sequence }))
  const activeRequests = new Set(previousManifest?.activeRequests ?? [])
  const materialLatest = new Map((previousManifest?.materialLatest ?? [])
    .map(row => [row.material, row]))
  const currentMaterialKeys = new Set((doc.materials ?? []).map(row => row.key))
  for (const row of requestRows) {
    if (row.settled === true) activeRequests.delete(row.ticket)
    else activeRequests.add(row.ticket)
    const sequence = changedRequestSequences.get(row.ticket)
    if (currentMaterialKeys.has(row.material)) {
      const previous = materialLatest.get(row.material)
      if (previous === undefined || sequence >= previous.sequence) {
        materialLatest.set(row.material, { material: row.material, ticket: row.ticket, sequence })
      }
    }
  }
  for (const material of [...materialLatest.keys()]) {
    if (!currentMaterialKeys.has(material)) materialLatest.delete(material)
  }
  const migrationSource = sourceBytes === null ? previousManifest?.migrationSource ?? null
    : putObject(root, Buffer.from(sourceBytes))
  const manifest = { format: 5, storageSchema: V5_STORAGE_SCHEMA, generation: randomUUID(),
    updatedAt: Number.isFinite(doc.updatedAt) ? doc.updatedAt : Date.now(),
    entryCount, problemCount, requestCount, nextRequestSequence,
    turnFactCount: doc.turnFacts.length, turnFactOrder, turnFactBuckets,
    entryOrder: previousManifest === null ? [...entries].map(row => row.id)
      : entryOrder !== null ? [...entryOrder] : mergeOrder(previousManifest.entryOrder,
        changes.filter(change => change.after === null).map(change => change.id),
        changes.filter(change => change.before === null && change.after !== null).map(change => change.id), entryCount),
    problemOrder: previousManifest === null ? [...problems].map(row => row.id)
      : problemOrder !== null ? [...problemOrder] : mergeOrder(previousManifest.problemOrder,
        (problemChanges ?? []).filter(change => change.after === null).map(change => change.id),
        (problemChanges ?? []).filter(change => change.before === null && change.after !== null).map(change => change.id),
        problemCount),
    entryBuckets, problemBuckets, recallShards, requestIndexShards, requestProjection: existingProjection,
    activeRequests: [...activeRequests], materialLatest: [...materialLatest.values()],
    coreRefs, problemHeader, migrationSource, hotState }
  check(isV5Manifest(manifest), 'invalid_memory')
  const body = JSON.stringify(manifest)
  check(Buffer.byteLength(body) <= MAX_STORE_BYTES, 'capacity')
  if (dirtyObjectRoots.has(root)) syncMemoryDirectory(root)
  commitMemoryFile(join(root, 'memory-v1.json'), body)
  dirtyObjectRoots.delete(root)
  return manifest
}

export function writeV5Document(root, doc, options = {}) {
  batchedObjectRoots.add(root)
  try { return writeV5DocumentImpl(root, doc, options) }
  finally {
    batchedObjectRoots.delete(root)
    dirtyObjectRoots.delete(root)
  }
}

function mergeOrder(previous, removals, additions, expectedLength) {
  const removed = new Set(removals)
  const result = previous.filter(id => !removed.has(id))
  const seen = new Set(result)
  for (const id of additions) if (!seen.has(id)) { seen.add(id); result.push(id) }
  check(result.length === expectedLength, 'invalid_memory')
  return result
}

function orderRows(rows, ids) {
  const byId = new Map(rows.map(row => [row.id, row]))
  check(byId.size === rows.length && byId.size === ids.length, 'invalid_memory')
  return ids.map(id => {
    const row = byId.get(id)
    check(row !== undefined, 'invalid_memory')
    return row
  })
}

// Handles the `previousManifest === null` request-index bootstrap without accepting an unchecked root.
function manifestForLookup(previousManifest, roots) {
  if (previousManifest !== null) return { ...previousManifest, requestIndexShards: roots }
    return { format: 5, storageSchema: V5_STORAGE_SCHEMA, generation: 'bootstrap-v5-index', updatedAt: 0,
    entryCount: 0, problemCount: 0, requestCount: 0, entryBuckets: Array(V5_BUCKETS).fill(null),
    problemBuckets: Array(V5_BUCKETS).fill(null), recallShards: Array(V5_BUCKETS).fill(null),
    requestIndexShards: roots, requestProjection: [], activeRequests: [], materialLatest: [],
    coreRefs: {}, problemHeader: null, migrationSource: null,
    hotState: { receipts: [], midTurnReceipts: [], turnUsage: [], entryUsage: [] } }
}

/** Update only the shared persistent request index for a format-5 or format-6 manifest. */
export function updateStoredRequestIndex(root, previousManifest, doc, {
  requestChanges = [], bootstrapRequests = [], validateRequest = null,
} = {}) {
  const requestIndexShards = previousManifest === null
    ? Array(V5_BUCKETS).fill(null) : [...previousManifest.requestIndexShards]
  const requestUpdateMap = new Map()
  for (const row of [...bootstrapRequests, ...requestChanges]) requestUpdateMap.set(row.ticket, row)
  const requestRows = [...requestUpdateMap.values()]
  let requestCount = previousManifest?.requestCount ?? 0
  let nextRequestSequence = previousManifest?.nextRequestSequence ?? 0
  const changedRequestSequences = new Map()
  const newRequestTickets = new Set()
  for (const row of requestRows) {
    validateRequest?.(row)
    const bodyHash = putObject(root, row)
    const digest = requestHash(row.ticket)
    const index = bucketFromHash(digest)
    const rootHash = requestIndexShards[index]
    const lookupManifest = manifestForLookup(previousManifest, requestIndexShards)
    const prior = findRequestPointer(root, lookupManifest, row.ticket)
    if (prior === null) { requestCount += 1; newRequestTickets.add(row.ticket) }
    const sequence = prior?.metadata.sequence ?? nextRequestSequence++
    changedRequestSequences.set(row.ticket, sequence)
    requestIndexShards[index] = writeRequestNode(root, rootHash, 2, row.ticket, bodyHash,
      indexedRequestMetadata(row, sequence))
  }
  const projection = new Map(previousManifest === null ? []
    : previousManifest.requestProjection.map(row => Array.isArray(row)
      ? [row[0], row[1]] : [row.ticket, row.sequence]))
  if (previousManifest === null) {
    requestRows.forEach((row, index) => projection.set(row.ticket, index))
  } else {
    for (const row of requestRows) {
      if (projection.has(row.ticket) || newRequestTickets.has(row.ticket)) {
        projection.set(row.ticket, changedRequestSequences.get(row.ticket))
      }
    }
  }
  const requestProjection = [...projection].sort((left, right) => left[1] - right[1])
    .slice(-V5_REQUEST_PROJECTION_LIMIT).map(([ticket, sequence]) => ({ ticket, sequence }))
  const activeRequests = new Set(previousManifest?.activeRequests ?? [])
  const materialLatest = new Map((previousManifest?.materialLatest ?? []).map(row => [row.material, row]))
  const currentMaterialKeys = new Set((doc.materials ?? []).map(row => row.key))
  for (const row of requestRows) {
    if (row.settled === true) activeRequests.delete(row.ticket)
    else activeRequests.add(row.ticket)
    const sequence = changedRequestSequences.get(row.ticket)
    if (currentMaterialKeys.has(row.material)) {
      const previous = materialLatest.get(row.material)
      if (previous === undefined || sequence >= previous.sequence) {
        materialLatest.set(row.material, { material: row.material, ticket: row.ticket, sequence })
      }
    }
  }
  for (const material of [...materialLatest.keys()]) {
    if (!currentMaterialKeys.has(material)) materialLatest.delete(material)
  }
  return { requestIndexShards, requestProjection, activeRequests: [...activeRequests],
    materialLatest: [...materialLatest.values()], requestCount, nextRequestSequence }
}

export function getV5Request(root, manifest, ticket, validateRequest = null) {
  return readRequestBody(root, manifest, ticket, validateRequest)
}

export function getV5RequestMetadata(root, manifest, ticket) {
  check(Array.isArray(manifest?.requestIndexShards) && typeof ticket === 'string', 'invalid_memory')
  const pointer = findRequestPointer(root, manifest, ticket)
  return pointer === null ? undefined : { ...pointer.metadata }
}

export function getV5LatestMaterialRequest(root, manifest, material) {
  check(Array.isArray(manifest?.requestIndexShards) && HASH.test(material), 'invalid_memory')
  const latest = manifest.materialLatest.find(row => row.material === material)
  return latest === undefined ? undefined : getV5RequestMetadata(root, manifest, latest.ticket)
}

export function listV5Requests(root, manifest, validateRequest = null) {
  check(Array.isArray(manifest?.requestIndexShards), 'invalid_memory')
  const pointers = []
  for (let bucket = 0; bucket < V5_BUCKETS; bucket += 1) {
    const reference = manifest.requestIndexShards[bucket]
    if (reference !== null) walkRequestIndex(root, reference, 2, pointers)
  }
  check(pointers.length === manifest.requestCount, 'invalid_memory')
  const rows = pointers.map(([ticket, bodyHash, metadata]) => {
    const row = readObject(root, bodyHash)
    check(row.ticket === ticket && JSON.stringify(indexedRequestMetadata(row, metadata.sequence))
      === JSON.stringify(metadata), 'invalid_memory')
    validateRequest?.(row)
    return { row, sequence: metadata.sequence }
  })
  return rows.sort((left, right) => left.sequence - right.sequence).map(({ row }) => row)
}

export function listV5RequestMetadata(root, manifest, predicate = null) {
  check(Array.isArray(manifest?.requestIndexShards), 'invalid_memory')
  const pointers = []
  for (let bucket = 0; bucket < V5_BUCKETS; bucket += 1) {
    const reference = manifest.requestIndexShards[bucket]
    if (reference !== null) walkRequestIndex(root, reference, 2, pointers)
  }
  check(pointers.length === manifest.requestCount, 'invalid_memory')
  return pointers.map(([ticket, , metadata]) => ({ ...metadata }))
    .filter(row => predicate === null || predicate(row))
    .sort((left, right) => left.sequence - right.sequence)
}

export function v5RequestObjectReferences(root, manifest) {
  check(Array.isArray(manifest?.requestIndexShards), 'invalid_memory')
  const references = new Set()
  for (const reference of manifest.requestIndexShards) {
    if (reference !== null) walkRequestIndex(root, reference, 2, [], references)
  }
  return [...references]
}

export function readV5RecallCandidates(root, manifest, prompt, { validateEntry, extraIds = [] } = {}) {
  check(isV5Manifest(manifest) && typeof prompt === 'string', 'invalid_memory')
  const features = queryRecallFeatures(prompt)
  const ids = new Set(extraIds.filter(id => manifest.entryOrder.includes(id)))
  const loadedShards = new Map()
  const queryIndex = Array.from({ length: V5_BUCKETS }, () => null)
  for (const feature of features) {
    const index = recallFeatureShard(feature)
    if (!loadedShards.has(index)) {
      const ref = manifest.recallShards[index]
      loadedShards.set(index, ref === null ? new Map() : parseRecallShard(readObject(root, ref)))
    }
    queryIndex[index] = loadedShards.get(index)
  }
  for (const id of recallCandidates(queryIndex, prompt)) ids.add(id)
  const wantedBuckets = new Set([...ids].map(id => bucketFromHash(indexHash(id))))
  const rows = []
  for (const bucketIndex of wantedBuckets) {
    const ref = manifest.entryBuckets[bucketIndex]
    if (ref === null) continue
    // The cached bucket is immutable internal data. Clone only rows the index selected instead
    // of cloning every row in a bucket and discarding most of them immediately.
    for (const row of readObjectValue(root, ref)) if (ids.has(row.id)) {
      const candidate = structuredClone(row)
      validateEntry?.(candidate)
      rows.push(candidate)
    }
  }
  check(rows.length === ids.size || [...ids].every(id => manifest.entryOrder.includes(id)), 'invalid_memory')
  const byId = new Map(rows.map(row => [row.id, row]))
  const ordered = manifest.entryOrder.filter(id => byId.has(id)).map(id => byId.get(id))
  return applyEntryUsage(ordered, manifest.hotState, validateEntry)
}

export function getV5MigrationSource(root, manifest) {
  return manifest.migrationSource === null ? null : readObjectBytes(root, manifest.migrationSource)
}

export function v5StorageStats(root, manifest, manifestBytes = null) {
  check(isV5Manifest(manifest), 'invalid_memory')
  let storageBytes = manifestBytes?.length ?? 0
  for (const name of readdirSync(root)) {
    if (!name.startsWith(V5_OBJECT_PREFIX)) continue
    const stat = statSync(join(root, name))
    if (!stat.isFile() || stat.size > MAX_STORE_BYTES) throw new LearningError('invalid_memory')
    storageBytes += stat.size
  }
  return { entries: manifest.entryCount, problems: manifest.problemCount, requests: manifest.requestCount,
    bytes: storageBytes, maxObjectBytes: MAX_STORE_BYTES }
}

export function v5ObjectReferences(manifest) {
  if (!isV5Manifest(manifest)) return []
  return [...Object.values(manifest.coreRefs), ...manifest.entryBuckets.filter(Boolean),
    ...(manifest.turnFactBuckets?.filter(Boolean) ?? []),
    ...manifest.problemBuckets.filter(Boolean), ...manifest.recallShards.filter(Boolean),
    ...manifest.requestIndexShards.filter(Boolean), ...(manifest.problemHeader === null ? [] : [manifest.problemHeader]),
    ...(manifest.migrationSource === null ? [] : [manifest.migrationSource])]
}

export function removeV5Object(root, hash) {
  if (!HASH.test(hash)) return false
  try { unlinkSync(objectPath(root, hash)); return true }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error }
}
