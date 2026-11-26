/** Format-6 persistent trees keep collection size out of the atomic manifest and every page bounded. */
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { LearningError, MAX_STORE_BYTES, check } from '../src/store.mjs'
import { commitMemoryFile, syncMemoryDirectory } from './storage.mjs'
import { V5_BUCKETS, V5_TURN_FACT_BUCKETS, V5_REQUEST_PROJECTION_LIMIT,
  readStoredObject, readStoredObjectValue, putStoredObject, withStoredObjectBatch, syncStoredObjects,
  updateStoredRequestIndex, getV5MigrationSource, v5RequestObjectReferences } from './storage-v5.mjs'
import { entryRecallFeatures, queryRecallFeatures } from './recall-index.mjs'

export const V6_STORAGE_SCHEMA = 'mse-growth-store-v1'
export const V6_COLLECTION_PAGE_ROWS = 256
export const V6_COLLECTION_PAGE_BYTES = 256 * 1024
export const V6_ENTRY_USAGE_LIMIT = 256
const HASH = /^[a-f0-9]{64}$/u
const ENTRY_ID = /^mem_[a-f0-9]{24}$/u
const hash = value => createHash('sha256').update(value).digest('hex')
const jsonBytes = value => Buffer.from(JSON.stringify(value), 'utf8')
const bucketOf = route => Number.parseInt(route.slice(0, 2), 16)
const validRefs = (value, count = V5_BUCKETS) => Array.isArray(value) && value.length === count
  && value.every(ref => ref === null || typeof ref === 'string' && HASH.test(ref))
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0
export const v6StrategyHistoryKey = row => `${row.turnKey}\u0000${row.scope}\u0000${row.qualification}`
  + `\u0000${row.id}\u0000${row.version}`

const emptyCollection = depth => ({ kind: 'collection-leaf', depth, rows: [] })
const collectionPageFits = (rows, depth) => rows.length <= V6_COLLECTION_PAGE_ROWS
  && Buffer.byteLength(JSON.stringify({ kind: 'collection-leaf', depth, rows }), 'utf8')
    <= V6_COLLECTION_PAGE_BYTES

function collectionNode(root, reference, depth, cache = null) {
  if (reference === null) return emptyCollection(depth)
  const cached = cache?.get(reference)
  if (cached !== undefined) {
    check(cached.depth === depth, 'invalid_memory')
    return cached
  }
  const node = cache === null ? readStoredObject(root, reference) : readStoredObjectValue(root, reference)
  check(plainObject(node) && node.depth === depth, 'invalid_memory')
  if (node.kind === 'collection-leaf') {
    check(Array.isArray(node.rows) && node.rows.length <= V6_COLLECTION_PAGE_ROWS
      && node.rows.every(row => Array.isArray(row) && row.length === 3
        && typeof row[0] === 'string' && row[0].length > 0 && row[0].length <= 256
        && Number.isSafeInteger(row[1]) && row[1] >= 0)
      && new Set(node.rows.map(row => row[0])).size === node.rows.length
      && node.rows.every((row, index) => index === 0 || compareText(node.rows[index - 1][0], row[0]) < 0)
      && (collectionPageFits(node.rows, depth)
        || node.rows.length === 1 && Buffer.byteLength(JSON.stringify(node), 'utf8') <= MAX_STORE_BYTES),
    'invalid_memory')
    cache?.set(reference, node)
    return node
  }
  check(node.kind === 'collection-branch' && depth < 64 && plainObject(node.children)
    && Object.keys(node.children).length > 0
    && Object.entries(node.children).every(([key, ref]) => /^[a-f0-9]$/u.test(key) && HASH.test(ref)),
  'invalid_memory')
  cache?.set(reference, node)
  return node
}

function collectionBranch(root, depth, rows) {
  check(depth < 64, 'capacity')
  const groups = new Map()
  for (const row of rows) {
    const selector = hash(row[0]).slice(depth, depth + 1)
    const group = groups.get(selector) ?? []
    group.push(row)
    groups.set(selector, group)
  }
  check(groups.size > 1 || depth < 63, 'capacity')
  const children = {}
  for (const [selector, group] of groups) {
    children[selector] = buildCollectionNode(root, depth + 1, group)
  }
  return putStoredObject(root, { kind: 'collection-branch', depth, children })
}

function buildCollectionNode(root, depth, rows) {
  const sorted = [...rows].sort((left, right) => compareText(left[0], right[0]))
  const leaf = { kind: 'collection-leaf', depth, rows: sorted }
  const bytes = Buffer.byteLength(JSON.stringify(leaf), 'utf8')
  if (collectionPageFits(sorted, depth) || sorted.length === 1 && bytes <= MAX_STORE_BYTES) {
    return putStoredObject(root, leaf)
  }
  return collectionBranch(root, depth, sorted)
}

function updateCollectionNode(root, reference, depth, key, value, sequence) {
  const route = hash(key)
  const node = collectionNode(root, reference, depth)
  if (node.kind === 'collection-branch') {
    const selector = route.slice(depth, depth + 1)
    const child = node.children[selector] ?? null
    const next = updateCollectionNode(root, child, depth + 1, key, value, sequence)
    const children = { ...node.children }
    if (next === null) delete children[selector]
    else children[selector] = next
    if (Object.keys(children).length === 0) return null
    return putStoredObject(root, { kind: 'collection-branch', depth, children })
  }
  const rows = new Map(node.rows.map(row => [row[0], row]))
  if (value === null) rows.delete(key)
  else rows.set(key, [key, sequence, value])
  if (rows.size === 0) return null
  const sorted = [...rows.values()].sort((left, right) => compareText(left[0], right[0]))
  const leaf = { kind: 'collection-leaf', depth, rows: sorted }
  const bytes = Buffer.byteLength(JSON.stringify(leaf), 'utf8')
  if (collectionPageFits(sorted, depth) || sorted.length === 1 && bytes <= MAX_STORE_BYTES) {
    return putStoredObject(root, leaf)
  }
  return collectionBranch(root, depth, sorted)
}

function lookupCollection(root, roots, key) {
  if (typeof key !== 'string') return undefined
  const route = hash(key)
  let reference = roots === null ? null : roots[bucketOf(route)]
  let depth = roots === null ? 0 : 2
  while (reference !== null) {
    const node = collectionNode(root, reference, depth)
    if (node.kind === 'collection-leaf') {
      const row = node.rows.find(item => item[0] === key)
      return row === undefined ? undefined : { sequence: row[1], value: row[2] }
    }
    reference = node.children[route.slice(depth, depth + 1)] ?? null
    depth += 1
  }
  return undefined
}

function lookupCollectionRoot(root, reference, key, cache = null) {
  const route = hash(key)
  let depth = 0
  while (reference !== null) {
    const node = collectionNode(root, reference, depth, cache)
    if (node.kind === 'collection-leaf') {
      const row = node.rows.find(item => item[0] === key)
      return row === undefined ? undefined : { sequence: row[1], value: row[2] }
    }
    reference = node.children[route.slice(depth, depth + 1)] ?? null
    depth += 1
  }
  return undefined
}

function walkCollection(root, reference, depth, rows, cache = null) {
  if (reference === null) return
  const node = collectionNode(root, reference, depth, cache)
  if (node.kind === 'collection-leaf') { rows.push(...node.rows); return }
  for (const selector of Object.keys(node.children).sort()) {
    walkCollection(root, node.children[selector], depth + 1, rows, cache)
  }
}

function collectionRows(root, roots, expectedCount) {
  const rows = []
  const cache = new Map()
  for (const reference of roots) if (reference !== null) walkCollection(root, reference, 2, rows, cache)
  check(rows.length === expectedCount, 'invalid_memory')
  rows.sort((left, right) => left[1] - right[1])
  check(new Set(rows.map(row => row[0])).size === rows.length
    && new Set(rows.map(row => row[1])).size === rows.length, 'invalid_memory')
  return rows.map(row => row[2])
}

function singleCollectionRows(root, reference, expectedCount, cache = null) {
  if (reference === null) { check(expectedCount === 0, 'invalid_memory'); return [] }
  const rows = []
  walkCollection(root, reference, 0, rows, cache)
  check(rows.length === expectedCount && new Set(rows.map(row => row[0])).size === rows.length,
    'invalid_memory')
  return rows.map(row => row[2]).sort(compareText)
}

function lookupCollectionMany(root, roots, keys, cache = null) {
  const found = new Map()
  const byBucket = new Map()
  for (const key of keys) {
    const bucket = bucketOf(hash(key))
    const group = byBucket.get(bucket) ?? []
    group.push(key)
    byBucket.set(bucket, group)
  }
  const visit = (reference, depth, wanted) => {
    if (reference === null || wanted.length === 0) return
    const node = collectionNode(root, reference, depth, cache)
    if (node.kind === 'collection-leaf') {
      const keysNeeded = new Set(wanted)
      for (const row of node.rows) if (keysNeeded.has(row[0])) {
        found.set(row[0], { sequence: row[1], value: row[2] })
      }
      return
    }
    const groups = new Map()
    for (const key of wanted) {
      const selector = hash(key).slice(depth, depth + 1)
      const group = groups.get(selector) ?? []
      group.push(key)
      groups.set(selector, group)
    }
    for (const [selector, group] of groups) visit(node.children[selector] ?? null, depth + 1, group)
  }
  for (const [bucket, wanted] of byBucket) visit(roots[bucket], 2, wanted)
  return found
}

function buildCollectionRoots(root, values, keyOf) {
  const groups = Array.from({ length: V5_BUCKETS }, () => [])
  const keys = new Set()
  values.forEach((value, sequence) => {
    const key = keyOf(value)
    check(typeof key === 'string' && key.length > 0 && key.length <= 256 && !keys.has(key), 'invalid_memory')
    keys.add(key)
    const row = [key, sequence, value]
    groups[bucketOf(hash(key))].push(row)
  })
  return groups.map(rows => rows.length === 0 ? null : buildCollectionNode(root, 2, rows))
}

function applyCollectionChanges(root, previousRoots, previousCount, nextSequence, changes,
  keyOf, { bulkValues = null } = {}) {
  if (bulkValues !== null) {
    const roots = buildCollectionRoots(root, bulkValues, keyOf)
    return { roots, count: bulkValues.length, nextSequence: bulkValues.length }
  }
  const roots = [...previousRoots]
  let count = previousCount
  for (const change of changes ?? []) {
    const source = change.after ?? change.before
    if (source === null || source === undefined) continue
    const key = keyOf(source)
    const route = hash(key)
    const bucket = bucketOf(route)
    const prior = lookupCollection(root, roots, key)
    if (change.after === null) {
      if (prior === undefined) continue
      roots[bucket] = updateCollectionNode(root, roots[bucket], 2, key, null, prior.sequence)
      count -= 1
      continue
    }
    const sequence = prior?.sequence ?? nextSequence++
    roots[bucket] = updateCollectionNode(root, roots[bucket], 2, key, change.after, sequence)
    if (prior === undefined) count += 1
  }
  return { roots, count, nextSequence }
}

function copyCore(doc) {
  const excluded = new Set(['format', 'updatedAt', 'entries', 'requests', 'turnFacts', 'problemLoop', 'storage',
    'receipts', 'midTurnReceipts', 'turnUsage', 'methodHistory', 'adaptiveHistory', 'recallStrategyHistory'])
  return Object.fromEntries(Object.entries(doc).filter(([key]) => !excluded.has(key)))
}

function v6HotStateValid(value) {
  return plainObject(value) && Object.keys(value).every(key =>
    ['receipts', 'midTurnReceipts', 'turnUsage', 'entryUsage'].includes(key))
    && Array.isArray(value.receipts) && value.receipts.length <= 256
    && Array.isArray(value.midTurnReceipts) && value.midTurnReceipts.length <= 256
    && Array.isArray(value.turnUsage) && value.turnUsage.length <= 128
    && Array.isArray(value.entryUsage) && value.entryUsage.length <= V6_ENTRY_USAGE_LIMIT
    && value.entryUsage.every(row => plainObject(row)
      && Object.keys(row).every(key => ['id', 'injected', 'lastInjectedAt', 'methodStats'].includes(key))
      && ENTRY_ID.test(row.id) && Number.isSafeInteger(row.injected) && row.injected >= 0
      && (row.lastInjectedAt === null || Number.isFinite(row.lastInjectedAt))
      && (row.methodStats === null || plainObject(row.methodStats)))
    && new Set(value.entryUsage.map(row => row.id)).size === value.entryUsage.length
}

function usageOverlay(entry) {
  return { id: entry.id, injected: entry.injected, lastInjectedAt: entry.lastInjectedAt,
    methodStats: entry.methodStats ?? null }
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

function applyEntryUsage(entries, hotState, validateEntry = null) {
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

export function isV6Manifest(value) {
  const allowed = new Set(['format', 'storageSchema', 'generation', 'updatedAt',
    'entryCount', 'nextEntrySequence', 'entryRoots', 'problemCount', 'nextProblemSequence', 'problemRoots',
    'methodHistoryCount', 'nextMethodHistorySequence', 'methodHistoryRoots',
    'adaptiveHistoryCount', 'nextAdaptiveHistorySequence', 'adaptiveHistoryRoots',
    'recallStrategyHistoryCount', 'nextRecallStrategyHistorySequence', 'recallStrategyHistoryRoots',
    'seenEventCount', 'nextSeenEventSequence', 'seenEventRoots',
    'turnFactCount', 'turnFactOrder', 'turnFactBuckets', 'requestCount', 'nextRequestSequence',
    'requestIndexShards', 'requestProjection', 'activeRequests', 'materialLatest', 'recallRoots',
    'coreRefs', 'problemHeader', 'migrationSource', 'hotState'])
  if (!plainObject(value) || Object.keys(value).some(key => !allowed.has(key))
    || value.format !== 6 || value.storageSchema !== V6_STORAGE_SCHEMA
    || typeof value.generation !== 'string' || value.generation.length < 16
    || !Number.isFinite(value.updatedAt)
    || !Number.isSafeInteger(value.entryCount) || value.entryCount < 0
    || !Number.isSafeInteger(value.nextEntrySequence) || value.nextEntrySequence < value.entryCount
    || !validRefs(value.entryRoots)
    || !Number.isSafeInteger(value.problemCount) || value.problemCount < 0
    || !Number.isSafeInteger(value.nextProblemSequence) || value.nextProblemSequence < value.problemCount
    || !validRefs(value.problemRoots)
    || !Number.isSafeInteger(value.methodHistoryCount) || value.methodHistoryCount < 0
    || !Number.isSafeInteger(value.nextMethodHistorySequence)
    || value.nextMethodHistorySequence < value.methodHistoryCount || !validRefs(value.methodHistoryRoots)
    || !Number.isSafeInteger(value.adaptiveHistoryCount) || value.adaptiveHistoryCount < 0
    || !Number.isSafeInteger(value.nextAdaptiveHistorySequence)
    || value.nextAdaptiveHistorySequence < value.adaptiveHistoryCount || !validRefs(value.adaptiveHistoryRoots)
    || !Number.isSafeInteger(value.recallStrategyHistoryCount) || value.recallStrategyHistoryCount < 0
    || !Number.isSafeInteger(value.nextRecallStrategyHistorySequence)
    || value.nextRecallStrategyHistorySequence < value.recallStrategyHistoryCount
    || !validRefs(value.recallStrategyHistoryRoots)
    || !Number.isSafeInteger(value.seenEventCount) || value.seenEventCount < 0
    || !Number.isSafeInteger(value.nextSeenEventSequence)
    || value.nextSeenEventSequence < value.seenEventCount || !validRefs(value.seenEventRoots)
    || !Number.isSafeInteger(value.turnFactCount) || value.turnFactCount < 0 || value.turnFactCount > 256
    || !Array.isArray(value.turnFactOrder) || value.turnFactOrder.length !== value.turnFactCount
    || value.turnFactOrder.some(id => typeof id !== 'string' || !HASH.test(id))
    || new Set(value.turnFactOrder).size !== value.turnFactOrder.length
    || !validRefs(value.turnFactBuckets, V5_TURN_FACT_BUCKETS)
    || !Number.isSafeInteger(value.requestCount) || value.requestCount < 0
    || !Number.isSafeInteger(value.nextRequestSequence) || value.nextRequestSequence < value.requestCount
    || !validRefs(value.requestIndexShards)
    || !Array.isArray(value.requestProjection) || value.requestProjection.length > V5_REQUEST_PROJECTION_LIMIT
    || value.requestProjection.some(row => !plainObject(row) || typeof row.ticket !== 'string'
      || row.ticket.length === 0 || row.ticket.length > 64 || !Number.isSafeInteger(row.sequence) || row.sequence < 0)
    || new Set(value.requestProjection.map(row => row.ticket)).size !== value.requestProjection.length
    || !Array.isArray(value.activeRequests) || value.activeRequests.length > V5_REQUEST_PROJECTION_LIMIT
    || value.activeRequests.some(ticket => typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 64)
    || new Set(value.activeRequests).size !== value.activeRequests.length
    || !Array.isArray(value.materialLatest) || value.materialLatest.length > 64
    || value.materialLatest.some(row => !plainObject(row) || !HASH.test(row.material)
      || typeof row.ticket !== 'string' || row.ticket.length === 0 || row.ticket.length > 64
      || !Number.isSafeInteger(row.sequence) || row.sequence < 0)
    || new Set(value.materialLatest.map(row => row.material)).size !== value.materialLatest.length
    || !validRefs(value.recallRoots)
    || !plainObject(value.coreRefs) || Object.entries(value.coreRefs).some(([key, ref]) =>
      !/^[A-Za-z][A-Za-z0-9]{0,31}$/u.test(key) || !HASH.test(ref))
    || value.problemHeader !== null && !HASH.test(value.problemHeader)
    || value.migrationSource !== null && !HASH.test(value.migrationSource)
    || !v6HotStateValid(value.hotState)) return false
  return true
}

const FEATURE_PAGE_ROWS = 256
const FEATURE_INLINE_IDS = 16
const FEATURE_INLINE_BYTES = 2 * 1024
const POSTING_PAGE_BYTES = V6_COLLECTION_PAGE_BYTES
const emptyFeatureLeaf = depth => ({ kind: 'feature-leaf', depth, rows: [] })
const inlinePostingFits = ids => ids.length <= FEATURE_INLINE_IDS
  && Buffer.byteLength(JSON.stringify(ids), 'utf8') <= FEATURE_INLINE_BYTES

function postingNode(root, reference, depth, cache = null) {
  if (reference === null) return { kind: 'posting-leaf', depth, ids: [] }
  const cached = cache?.get(reference)
  if (cached !== undefined) {
    check(cached.depth === depth, 'invalid_memory')
    return cached
  }
  const node = cache === null ? readStoredObject(root, reference) : readStoredObjectValue(root, reference)
  check(plainObject(node) && node.depth === depth, 'invalid_memory')
  if (node.kind === 'posting-leaf') {
    check(Array.isArray(node.ids)
      && node.ids.every(id => ENTRY_ID.test(id))
      && new Set(node.ids).size === node.ids.length
      && node.ids.every((id, index) => index === 0 || compareText(node.ids[index - 1], id) < 0)
      && Buffer.byteLength(JSON.stringify(node), 'utf8') <= POSTING_PAGE_BYTES, 'invalid_memory')
    cache?.set(reference, node)
    return node
  }
  check(node.kind === 'posting-branch' && depth < 64 && plainObject(node.children)
    && Object.keys(node.children).length > 0
    && Object.entries(node.children).every(([key, ref]) => /^[a-f0-9]$/u.test(key) && HASH.test(ref)),
  'invalid_memory')
  cache?.set(reference, node)
  return node
}

function postingLeafFits(ids, depth) {
  return Buffer.byteLength(JSON.stringify({ kind: 'posting-leaf', depth, ids }), 'utf8')
    <= POSTING_PAGE_BYTES
}

function buildPostingTree(root, depth, ids) {
  const sorted = [...ids].sort(compareText)
  if (postingLeafFits(sorted, depth)) return putStoredObject(root, { kind: 'posting-leaf', depth, ids: sorted })
  check(depth < 64, 'capacity')
  const groups = new Map()
  for (const id of sorted) {
    const selector = hash(id).slice(depth, depth + 1)
    const group = groups.get(selector) ?? []
    group.push(id)
    groups.set(selector, group)
  }
  check(groups.size > 1 || depth < 63, 'capacity')
  const children = {}
  for (const [selector, group] of groups) children[selector] = buildPostingTree(root, depth + 1, group)
  return putStoredObject(root, { kind: 'posting-branch', depth, children })
}

function updatePostingTree(root, reference, depth, id, present) {
  const route = hash(id)
  const node = postingNode(root, reference, depth)
  if (node.kind === 'posting-branch') {
    const selector = route.slice(depth, depth + 1)
    const next = updatePostingTree(root, node.children[selector] ?? null, depth + 1, id, present)
    const children = { ...node.children }
    if (next === null) delete children[selector]
    else children[selector] = next
    if (Object.keys(children).length === 0) return null
    return putStoredObject(root, { kind: 'posting-branch', depth, children })
  }
  const ids = new Set(node.ids)
  if (present) ids.add(id)
  else ids.delete(id)
  if (ids.size === 0) return null
  const sorted = [...ids].sort(compareText)
  if (postingLeafFits(sorted, depth)) return putStoredObject(root, { kind: 'posting-leaf', depth, ids: sorted })
  return buildPostingTree(root, depth, sorted)
}

function postingContains(root, reference, id, cache = null) {
  const route = hash(id)
  let depth = 0
  while (reference !== null) {
    const node = postingNode(root, reference, depth, cache)
    if (node.kind === 'posting-leaf') return node.ids.includes(id)
    reference = node.children[route.slice(depth, depth + 1)] ?? null
    depth += 1
  }
  return false
}

function postingIds(root, reference, expectedCount, cache = null) {
  const cached = cache?.get(reference)
  if (cached !== undefined) {
    check(cached.expectedCount === expectedCount, 'invalid_memory')
    return cached.ids
  }
  const ids = []
  const walk = (hashRef, depth) => {
    if (hashRef === null) return
    const node = postingNode(root, hashRef, depth, cache)
    if (node.kind === 'posting-leaf') { ids.push(...node.ids); return }
    for (const selector of Object.keys(node.children).sort()) walk(node.children[selector], depth + 1)
  }
  walk(reference, 0)
  check(ids.length === expectedCount && new Set(ids).size === ids.length, 'invalid_memory')
  cache?.set(reference, { expectedCount, ids })
  return ids
}

function featureNode(root, reference, depth, cache = null) {
  if (reference === null) return emptyFeatureLeaf(depth)
  const cached = cache?.get(reference)
  if (cached !== undefined) {
    check(cached.depth === depth, 'invalid_memory')
    return cached
  }
  const node = cache === null ? readStoredObject(root, reference) : readStoredObjectValue(root, reference)
  check(plainObject(node) && node.depth === depth, 'invalid_memory')
  if (node.kind === 'feature-leaf') {
    check(Array.isArray(node.rows) && node.rows.length <= FEATURE_PAGE_ROWS
      && node.rows.every(row => Array.isArray(row) && row.length === 4
        && typeof row[0] === 'string' && row[0].length <= 128
        && (row[1] === null ? true : Array.isArray(row[1]) && inlinePostingFits(row[1])
          && row[1].every(id => ENTRY_ID.test(id))
          && new Set(row[1]).size === row[1].length
          && row[1].every((id, index) => index === 0 || compareText(row[1][index - 1], id) < 0))
        && (row[2] === null || HASH.test(row[2]))
        && (row[1] === null ? row[2] !== null : row[2] === null)
        && Number.isSafeInteger(row[3]) && row[3] > 0
        && (row[1] === null ? true : row[3] === row[1].length))
      && new Set(node.rows.map(row => row[0])).size === node.rows.length
      && node.rows.every((row, index) => index === 0 || compareText(node.rows[index - 1][0], row[0]) < 0)
      && Buffer.byteLength(JSON.stringify(node), 'utf8') <= V6_COLLECTION_PAGE_BYTES, 'invalid_memory')
    cache?.set(reference, node)
    return node
  }
  check(node.kind === 'feature-branch' && depth < 64 && plainObject(node.children)
    && Object.keys(node.children).length > 0
    && Object.entries(node.children).every(([key, ref]) => /^[a-f0-9]$/u.test(key) && HASH.test(ref)),
  'invalid_memory')
  cache?.set(reference, node)
  return node
}

function buildFeatureNode(root, depth, rows) {
  const sorted = [...rows].sort((left, right) => compareText(left[0], right[0]))
  const leaf = { kind: 'feature-leaf', depth, rows: sorted }
  if (sorted.length <= FEATURE_PAGE_ROWS && Buffer.byteLength(JSON.stringify(leaf), 'utf8') <= V6_COLLECTION_PAGE_BYTES) {
    return putStoredObject(root, leaf)
  }
  check(depth < 64, 'capacity')
  const groups = new Map()
  for (const row of sorted) {
    const selector = hash(row[0]).slice(depth, depth + 1)
    const group = groups.get(selector) ?? []
    group.push(row)
    groups.set(selector, group)
  }
  check(groups.size > 1 || depth < 63, 'capacity')
  const children = {}
  for (const [selector, group] of groups) children[selector] = buildFeatureNode(root, depth + 1, group)
  return putStoredObject(root, { kind: 'feature-branch', depth, children })
}

function updateFeatureNode(root, reference, depth, feature, inlineIds, postingRoot, count) {
  const route = hash(feature)
  const node = featureNode(root, reference, depth)
  if (node.kind === 'feature-branch') {
    const selector = route.slice(depth, depth + 1)
    const next = updateFeatureNode(root, node.children[selector] ?? null, depth + 1,
      feature, inlineIds, postingRoot, count)
    const children = { ...node.children }
    if (next === null) delete children[selector]
    else children[selector] = next
    if (Object.keys(children).length === 0) return null
    return putStoredObject(root, { kind: 'feature-branch', depth, children })
  }
  const rows = new Map(node.rows.map(row => [row[0], row]))
  if (count === 0) rows.delete(feature)
  else rows.set(feature, [feature, inlineIds, postingRoot, count])
  if (rows.size === 0) return null
  const sorted = [...rows.values()].sort((left, right) => compareText(left[0], right[0]))
  const leaf = { kind: 'feature-leaf', depth, rows: sorted }
  if (sorted.length <= FEATURE_PAGE_ROWS && Buffer.byteLength(JSON.stringify(leaf), 'utf8') <= V6_COLLECTION_PAGE_BYTES) {
    return putStoredObject(root, leaf)
  }
  check(depth < 64, 'capacity')
  const groups = new Map()
  for (const row of sorted) {
    const selector = hash(row[0]).slice(depth, depth + 1)
    const group = groups.get(selector) ?? []
    group.push(row)
    groups.set(selector, group)
  }
  check(groups.size > 1 || depth < 63, 'capacity')
  const children = {}
  for (const [selector, group] of groups) children[selector] = buildFeatureNode(root, depth + 1, group)
  return putStoredObject(root, { kind: 'feature-branch', depth, children })
}

function lookupFeature(root, roots, feature, cache = null) {
  const route = hash(feature)
  let reference = roots[bucketOf(route)]
  let depth = 2
  while (reference !== null) {
    const node = featureNode(root, reference, depth, cache)
    if (node.kind === 'feature-leaf') return node.rows.find(row => row[0] === feature) ?? null
    reference = node.children[route.slice(depth, depth + 1)] ?? null
    depth += 1
  }
  return null
}

function buildRecallRoots(root, entries) {
  const groups = Array.from({ length: V5_BUCKETS }, () => new Map())
  for (const entry of entries) {
    for (const feature of entryRecallFeatures(entry)) {
      const bucket = bucketOf(hash(feature))
      const ids = groups[bucket].get(feature) ?? new Set()
      ids.add(entry.id)
      groups[bucket].set(feature, ids)
    }
  }
  return groups.map((features, bucket) => {
    if (features.size === 0) return null
    const rows = []
    for (const [feature, ids] of features) {
      const sortedIds = [...ids].sort(compareText)
      if (inlinePostingFits(sortedIds)) rows.push([feature, sortedIds, null, sortedIds.length])
      else {
        const postingRoot = buildPostingTree(root, 0, sortedIds)
        rows.push([feature, null, postingRoot, sortedIds.length])
      }
    }
    return buildFeatureNode(root, 2, rows)
  })
}

function updateRecallRoots(root, priorRoots, changes) {
  const roots = [...priorRoots]
  for (const change of changes) {
    const before = change.before === null ? new Set() : entryRecallFeatures(change.before)
    const after = change.after === null ? new Set() : entryRecallFeatures(change.after)
    const removed = [...before].filter(feature => !after.has(feature))
    const added = [...after].filter(feature => !before.has(feature))
    for (const feature of [...removed, ...added]) {
      const bucket = bucketOf(hash(feature))
      const current = lookupFeature(root, roots, feature)
      let inlineIds = current?.[1] === null ? null : current?.[1] ?? []
      let postingRoot = current?.[2] ?? null
      let count = current?.[3] ?? 0
      const removing = removed.includes(feature)
      const prior = inlineIds === null ? postingContains(root, postingRoot, change.id)
        : inlineIds.includes(change.id)
      if (removing) {
        check(prior, 'invalid_memory')
        if (inlineIds === null) postingRoot = updatePostingTree(root, postingRoot, 0, change.id, false)
        else inlineIds = inlineIds.filter(id => id !== change.id)
        count -= 1
      } else if (!prior) {
        if (inlineIds !== null) {
          const nextIds = [...inlineIds, change.id].sort(compareText)
          count += 1
          if (inlinePostingFits(nextIds)) inlineIds = nextIds
          else {
            postingRoot = buildPostingTree(root, 0, nextIds)
            inlineIds = null
          }
        } else {
          postingRoot = updatePostingTree(root, postingRoot, 0, change.id, true)
          count += 1
        }
      }
      if (inlineIds === null && count > 0 && count <= FEATURE_INLINE_IDS) {
        inlineIds = postingIds(root, postingRoot, count)
        postingRoot = null
      }
      roots[bucket] = updateFeatureNode(root, roots[bucket], 2, feature,
        inlineIds, postingRoot, count)
    }
  }
  return roots
}

function candidateIds(root, roots, prompt, { collectionCache = null, featureCache = null,
  postingListCache = null } = {}) {
  const formatIds = new Set()
  const bigramIds = new Set()
  const strongCounts = new Map()
  for (const feature of queryRecallFeatures(prompt)) {
    const bucket = bucketOf(hash(feature))
    const row = lookupFeature(root, roots, feature, featureCache)
    if (row === null) continue
    const ids = row[1] === null ? postingIds(root, row[2], row[3], postingListCache) : row[1]
    if (feature.startsWith('f:')) for (const id of ids) formatIds.add(id)
    else if (feature.startsWith('b:')) for (const id of ids) bigramIds.add(id)
    else if (feature.startsWith('s:')) for (const id of ids) strongCounts.set(id, (strongCounts.get(id) ?? 0) + 1)
  }
  const ids = new Set(formatIds)
  for (const [id, count] of strongCounts) if (count >= 2 || count >= 1 && bigramIds.has(id)) ids.add(id)
  return ids
}

function readTurnFacts(root, manifest, validateTurnFact) {
  const groups = Array.from({ length: V5_TURN_FACT_BUCKETS }, () => [])
  for (const reference of manifest.turnFactBuckets) {
    if (reference === null) continue
    const rows = readStoredObject(root, reference)
    check(Array.isArray(rows), 'invalid_memory')
    for (const row of rows) { validateTurnFact?.(row); groups[bucketOf(hash(row.id)) % V5_TURN_FACT_BUCKETS].push(row) }
  }
  const rows = groups.flat()
  const byId = new Map(rows.map(row => [row.id, row]))
  check(byId.size === rows.length && byId.size === manifest.turnFactCount, 'invalid_memory')
  return manifest.turnFactOrder.map(id => {
    const row = byId.get(id)
    check(row !== undefined, 'invalid_memory')
    return row
  })
}

function writeTurnFacts(root, values, validateTurnFact) {
  const groups = Array.from({ length: V5_TURN_FACT_BUCKETS }, () => [])
  for (const row of values) { validateTurnFact?.(row); groups[bucketOf(hash(row.id)) % V5_TURN_FACT_BUCKETS].push(row) }
  const refs = groups.map(rows => rows.length === 0 ? null : putStoredObject(root, rows))
  return { refs, order: values.map(row => row.id) }
}

export function loadV6Document(root, manifest, { validateEntry, validateProblem,
  validateRequest = null, validateTurnFact = null, includeEntries = true,
  includeProblems = true, includeRequests = true, includeHistory = true,
  includeAdaptiveHistory = true, includeStrategyHistory = true } = {}) {
  check(isV6Manifest(manifest), 'invalid_memory')
  const doc = { format: 6, updatedAt: manifest.updatedAt,
    entries: includeEntries ? collectionRows(root, manifest.entryRoots, manifest.entryCount) : [],
    requests: includeRequests ? manifest.requestProjection.map(projected => {
      const row = readV6Request(root, manifest, projected.ticket, validateRequest)
      check(row !== undefined, 'invalid_memory')
      return row
    }) : [],
    turnFacts: readTurnFacts(root, manifest, validateTurnFact) }
  for (const [key, reference] of Object.entries(manifest.coreRefs)) doc[key] = readStoredObject(root, reference)
  if (includeHistory) doc.methodHistory = collectionRows(root, manifest.methodHistoryRoots, manifest.methodHistoryCount)
  if (includeAdaptiveHistory) {
    doc.adaptiveHistory = collectionRows(root, manifest.adaptiveHistoryRoots, manifest.adaptiveHistoryCount)
  }
  if (includeStrategyHistory) {
    doc.recallStrategyHistory = collectionRows(root, manifest.recallStrategyHistoryRoots,
      manifest.recallStrategyHistoryCount)
  }
  doc.receipts = manifest.hotState.receipts
  doc.midTurnReceipts = manifest.hotState.midTurnReceipts
  doc.turnUsage = manifest.hotState.turnUsage
  if (includeEntries) applyEntryUsage(doc.entries, manifest.hotState,
    row => check(validateEntry?.(row) !== false, 'invalid_memory'))
  if (includeProblems && manifest.problemHeader !== null) {
    const header = readStoredObject(root, manifest.problemHeader)
    check(plainObject(header) && header.format === 1, 'invalid_memory')
    const problems = collectionRows(root, manifest.problemRoots, manifest.problemCount)
    const seenEvents = collectionRows(root, manifest.seenEventRoots, manifest.seenEventCount)
    for (const row of problems) validateProblem?.(row)
    doc.problemLoop = { format: header.format, problems, seenEvents }
  }
  return doc
}

function readV6Request(root, manifest, ticket, validateRequest) {
  // The persistent request index encoding is shared with format 5.
  return importV5Request(root, manifest, ticket, validateRequest)
}

// Kept as an indirect function below to avoid introducing a second request body format.
import { getV5Request as importV5Request } from './storage-v5.mjs'

function manifestShapeFits(manifest) {
  return Buffer.byteLength(JSON.stringify(manifest), 'utf8') <= MAX_STORE_BYTES
}

function writeV6DocumentImpl(root, doc, { previousManifest = null, sourceBytes = null,
  validateEntry, validateProblem, validateRequest, validateTurnFact,
  entryChanges = null, problemChanges = null, methodHistoryChanges = null,
  adaptiveHistoryChanges = null, recallStrategyHistoryChanges = null, seenEventChanges = null, requestChanges = [],
  bootstrapRequests = null, partialEntries = false } = {}) {
  const previousV6 = isV6Manifest(previousManifest) ? previousManifest : null
  const entries = doc.entries ?? []
  const problems = doc.problemLoop?.problems ?? []
  const methodHistory = doc.methodHistory ?? []
  const adaptiveHistory = doc.adaptiveHistory ?? []
  const recallStrategyHistory = doc.recallStrategyHistory ?? []
  const seenEvents = doc.problemLoop?.seenEvents ?? []
  const bulk = previousV6 === null
  const changedEntries = entryChanges ?? []
  const usageChanges = new Set(changedEntries.filter(usageOnlyEntryChange).map(change => change.id))
  const storedEntryChanges = changedEntries.filter(change => !usageChanges.has(change.id))
  const bulkEntries = bulk || !partialEntries && storedEntryChanges.length > 128
  const bulkProblems = bulk || (problemChanges?.length ?? 0) > 128
  const bulkMethodHistory = bulk || (methodHistoryChanges?.length ?? 0) > 128
  const bulkAdaptiveHistory = bulk || (adaptiveHistoryChanges?.length ?? 0) > 128
  const bulkRecallStrategyHistory = bulk || (recallStrategyHistoryChanges?.length ?? 0) > 128
  const bulkSeenEvents = bulk || (seenEventChanges?.length ?? 0) > 128
  let entryState = applyCollectionChanges(root, previousV6?.entryRoots ?? Array(V5_BUCKETS).fill(null),
    previousV6?.entryCount ?? 0, previousV6?.nextEntrySequence ?? 0, storedEntryChanges, row => row.id,
    { bulkValues: bulkEntries ? entries : null })
  const problemState = doc.problemLoop === undefined && previousV6 !== null
    ? { roots: previousV6.problemRoots, count: previousV6.problemCount, nextSequence: previousV6.nextProblemSequence }
    : applyCollectionChanges(root, previousV6?.problemRoots ?? Array(V5_BUCKETS).fill(null),
      previousV6?.problemCount ?? 0, previousV6?.nextProblemSequence ?? 0, problemChanges,
      row => row.id, { bulkValues: bulkProblems ? problems : null })
  const methodHistoryState = applyCollectionChanges(root,
    previousV6?.methodHistoryRoots ?? Array(V5_BUCKETS).fill(null), previousV6?.methodHistoryCount ?? 0,
    previousV6?.nextMethodHistorySequence ?? 0, methodHistoryChanges, row => `${row.entryId}\u0000${row.version}`,
    { bulkValues: bulkMethodHistory ? methodHistory : null })
  const adaptiveHistoryState = applyCollectionChanges(root,
    previousV6?.adaptiveHistoryRoots ?? Array(V5_BUCKETS).fill(null), previousV6?.adaptiveHistoryCount ?? 0,
    previousV6?.nextAdaptiveHistorySequence ?? 0, adaptiveHistoryChanges, row => row.id,
    { bulkValues: bulkAdaptiveHistory ? adaptiveHistory : null })
  const recallStrategyHistoryState = applyCollectionChanges(root,
    previousV6?.recallStrategyHistoryRoots ?? Array(V5_BUCKETS).fill(null),
    previousV6?.recallStrategyHistoryCount ?? 0,
    previousV6?.nextRecallStrategyHistorySequence ?? 0, recallStrategyHistoryChanges,
    v6StrategyHistoryKey, { bulkValues: bulkRecallStrategyHistory ? recallStrategyHistory : null })
  const seenEventState = doc.problemLoop === undefined && previousV6 !== null
    ? { roots: previousV6.seenEventRoots, count: previousV6.seenEventCount,
      nextSequence: previousV6.nextSeenEventSequence }
    : applyCollectionChanges(root, previousV6?.seenEventRoots ?? Array(V5_BUCKETS).fill(null),
      previousV6?.seenEventCount ?? 0, previousV6?.nextSeenEventSequence ?? 0,
      seenEventChanges, row => row.eventId, { bulkValues: bulkSeenEvents ? seenEvents : null })
  const recallRoots = previousV6 === null || !partialEntries && storedEntryChanges.length > 128
    ? buildRecallRoots(root, entries)
      : updateRecallRoots(root, previousV6.recallRoots, storedEntryChanges)
  const turnFacts = writeTurnFacts(root, doc.turnFacts ?? [], validateTurnFact)
  const coreRefs = {}
  for (const [key, value] of Object.entries(copyCore(doc))) coreRefs[key] = putStoredObject(root, value)
  const problemHeader = doc.problemLoop === undefined ? previousV6?.problemHeader ?? null
    : putStoredObject(root, { format: doc.problemLoop.format })
  const priorRequestManifest = previousManifest ?? null
  const requestState = updateStoredRequestIndex(root, priorRequestManifest, doc, {
    requestChanges, bootstrapRequests: bootstrapRequests ?? [], validateRequest })
  const priorHotState = previousV6?.hotState ?? { receipts: [], midTurnReceipts: [], turnUsage: [], entryUsage: [] }
  const entryUsage = new Map(priorHotState.entryUsage.map(row => [row.id, row]))
  for (const change of changedEntries) {
    if (change.after === null) entryUsage.delete(change.id)
    else if (usageChanges.has(change.id)) {
      entryUsage.delete(change.id)
      entryUsage.set(change.id, usageOverlay(change.after))
    } else entryUsage.delete(change.id)
  }
  while (entryUsage.size > V6_ENTRY_USAGE_LIMIT) {
    const oldestId = entryUsage.keys().next().value
    const [overlay] = [entryUsage.get(oldestId)]
    entryUsage.delete(oldestId)
    const stored = lookupCollection(root, entryState.roots, oldestId)
    check(stored !== undefined, 'invalid_memory')
    const folded = structuredClone(stored.value)
    folded.injected = overlay.injected
    folded.lastInjectedAt = overlay.lastInjectedAt
    if (overlay.methodStats === null) delete folded.methodStats
    else folded.methodStats = structuredClone(overlay.methodStats)
    const route = hash(oldestId)
    const bucket = bucketOf(route)
    entryState.roots[bucket] = updateCollectionNode(root, entryState.roots[bucket], 2,
      oldestId, folded, stored.sequence)
  }
  const hotState = { receipts: doc.receipts ?? priorHotState.receipts,
    midTurnReceipts: doc.midTurnReceipts ?? priorHotState.midTurnReceipts,
    turnUsage: doc.turnUsage ?? priorHotState.turnUsage, entryUsage: [...entryUsage.values()] }
  check(v6HotStateValid(hotState), 'invalid_memory')
  const migrationSource = sourceBytes !== null ? putStoredObject(root, Buffer.from(sourceBytes))
    : previousManifest?.migrationSource ?? null
  const manifest = { format: 6, storageSchema: V6_STORAGE_SCHEMA, generation: randomUUID(),
    updatedAt: Number.isFinite(doc.updatedAt) ? doc.updatedAt : Date.now(),
    entryCount: entryState.count, nextEntrySequence: entryState.nextSequence, entryRoots: entryState.roots,
    problemCount: problemState.count, nextProblemSequence: problemState.nextSequence,
    problemRoots: problemState.roots,
    methodHistoryCount: methodHistoryState.count,
    nextMethodHistorySequence: methodHistoryState.nextSequence, methodHistoryRoots: methodHistoryState.roots,
    adaptiveHistoryCount: adaptiveHistoryState.count,
    nextAdaptiveHistorySequence: adaptiveHistoryState.nextSequence,
    adaptiveHistoryRoots: adaptiveHistoryState.roots,
    recallStrategyHistoryCount: recallStrategyHistoryState.count,
    nextRecallStrategyHistorySequence: recallStrategyHistoryState.nextSequence,
    recallStrategyHistoryRoots: recallStrategyHistoryState.roots,
    seenEventCount: seenEventState.count, nextSeenEventSequence: seenEventState.nextSequence,
    seenEventRoots: seenEventState.roots,
    turnFactCount: (doc.turnFacts ?? []).length, turnFactOrder: turnFacts.order, turnFactBuckets: turnFacts.refs,
    requestCount: requestState.requestCount, nextRequestSequence: requestState.nextRequestSequence,
    requestIndexShards: requestState.requestIndexShards,
    requestProjection: requestState.requestProjection, activeRequests: requestState.activeRequests,
    materialLatest: requestState.materialLatest, recallRoots, coreRefs, problemHeader, migrationSource, hotState }
  check(isV6Manifest(manifest) && manifestShapeFits(manifest), 'capacity')
  syncStoredObjects(root)
  commitMemoryFile(join(root, 'memory-v1.json'), JSON.stringify(manifest))
  return manifest
}

export function writeV6Document(root, doc, options = {}) {
  return withStoredObjectBatch(root, () => writeV6DocumentImpl(root, doc, options))
}

export function readV6RecallCandidates(root, manifest, prompt, { validateEntry, extraIds = [] } = {}) {
  check(isV6Manifest(manifest) && typeof prompt === 'string', 'invalid_memory')
  const collectionCache = new Map()
  const featureCache = new Map()
  const postingListCache = new Map()
  const ids = candidateIds(root, manifest.recallRoots, prompt,
    { collectionCache, featureCache, postingListCache })
  const requested = new Set([...ids, ...extraIds])
  const loaded = lookupCollectionMany(root, manifest.entryRoots, requested, collectionCache)
  for (const id of extraIds) if (loaded.has(id)) ids.add(id)
  const usageById = new Map(manifest.hotState.entryUsage.map(row => [row.id, row]))
  const rows = []
  for (const id of ids) {
    const stored = loaded.get(id)
    check(stored !== undefined, 'invalid_memory')
    const entry = structuredClone(stored.value)
    const usage = usageById.get(id)
    if (usage !== undefined) {
      entry.injected = usage.injected
      entry.lastInjectedAt = usage.lastInjectedAt
      if (usage.methodStats === null) delete entry.methodStats
      else entry.methodStats = structuredClone(usage.methodStats)
    }
    validateEntry?.(entry)
    rows.push({ sequence: stored.sequence, entry })
  }
  return rows.sort((left, right) => left.sequence - right.sequence).map(row => row.entry)
}

export function v6DocumentFits(doc, reserve = 0, { entryAdds = 0 } = {}) {
  if (!Number.isSafeInteger(reserve) || reserve < 0 || !Number.isSafeInteger(entryAdds) || entryAdds < 0
    || !Array.isArray(doc?.entries) || !Array.isArray(doc?.requests)) return false
  const fitsObject = value => Buffer.byteLength(JSON.stringify(value), 'utf8') + reserve <= MAX_STORE_BYTES
  if (doc.entries.some(row => !fitsObject(row))
    || (doc.problemLoop?.problems ?? []).some(row => !fitsObject(row))
    || (doc.methodHistory ?? []).some(row => !fitsObject(row))
    || (doc.adaptiveHistory ?? []).some(row => !fitsObject(row))
    || (doc.recallStrategyHistory ?? []).some(row => !fitsObject(row))
    || doc.requests.some(row => !fitsObject(row))
    || Object.values(copyCore(doc)).some(value => !fitsObject(value))) return false
  const facts = Array.from({ length: V5_TURN_FACT_BUCKETS }, () => [])
  for (const row of doc.turnFacts ?? []) facts[bucketOf(hash(row.id)) % V5_TURN_FACT_BUCKETS].push(row)
  if (facts.some(rows => !fitsObject(rows))) return false
  const hotState = { receipts: doc.receipts ?? [], midTurnReceipts: doc.midTurnReceipts ?? [],
    turnUsage: doc.turnUsage ?? [], entryUsage: (doc.entries ?? []).slice(-V6_ENTRY_USAGE_LIMIT).map(usageOverlay) }
  if (!fitsObject(hotState)) return false
  return true
}

export function getV6MigrationSource(root, manifest) {
  check(isV6Manifest(manifest), 'invalid_memory')
  return manifest.migrationSource === null ? null : getV5MigrationSource(root, manifest)
}

export function v6HasAdaptivePolicyHistory(root, manifest, id) {
  check(isV6Manifest(manifest) && typeof id === 'string', 'invalid_memory')
  return lookupCollection(root, manifest.adaptiveHistoryRoots, id) !== undefined
}

export function v6GetMethodHistory(root, manifest, entryId, version, validateRow = null) {
  check(isV6Manifest(manifest) && ENTRY_ID.test(entryId)
    && Number.isSafeInteger(version) && version >= 1, 'invalid_memory')
  const found = lookupCollection(root, manifest.methodHistoryRoots, `${entryId}\u0000${version}`)
  if (found === undefined) return undefined
  check(found.sequence < manifest.nextMethodHistorySequence
    && found.value?.entryId === entryId && found.value?.version === version, 'invalid_memory')
  validateRow?.(found.value)
  return found.value
}

export function v6HasRecallStrategyHistory(root, manifest, row) {
  check(isV6Manifest(manifest) && plainObject(row), 'invalid_memory')
  return lookupCollection(root, manifest.recallStrategyHistoryRoots, v6StrategyHistoryKey(row)) !== undefined
}

export function v6StorageStats(root, manifest, manifestBytes = null) {
  check(isV6Manifest(manifest), 'invalid_memory')
  let bytes = manifestBytes?.length ?? 0
  for (const name of readdirSync(root)) {
    if (!name.startsWith('.memory-v1-object-')) continue
    const stat = lstatSync(join(root, name))
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_STORE_BYTES) {
      throw new LearningError('invalid_memory')
    }
    bytes += stat.size
  }
  return { entries: manifest.entryCount, problems: manifest.problemCount, requests: manifest.requestCount,
    bytes, maxObjectBytes: MAX_STORE_BYTES }
}

export function v6ObjectReferences(root, manifest) {
  check(isV6Manifest(manifest), 'invalid_memory')
  const references = new Set([...Object.values(manifest.coreRefs),
    ...manifest.entryRoots.filter(Boolean), ...manifest.problemRoots.filter(Boolean),
    ...manifest.methodHistoryRoots.filter(Boolean), ...manifest.adaptiveHistoryRoots.filter(Boolean),
    ...manifest.recallStrategyHistoryRoots.filter(Boolean),
    ...manifest.seenEventRoots.filter(Boolean), ...manifest.turnFactBuckets.filter(Boolean),
    ...manifest.requestIndexShards.filter(Boolean), ...manifest.recallRoots.filter(Boolean),
    ...(manifest.problemHeader === null ? [] : [manifest.problemHeader]),
    ...(manifest.migrationSource === null ? [] : [manifest.migrationSource]),
    ...v5RequestObjectReferences(root, manifest)])
  const visitedCollections = new Set()
  const walkCollectionRefs = (reference, depth) => {
    if (reference === null || visitedCollections.has(reference)) return
    visitedCollections.add(reference)
    references.add(reference)
    const node = collectionNode(root, reference, depth)
    if (node.kind === 'collection-branch') for (const child of Object.values(node.children)) walkCollectionRefs(child, depth + 1)
  }
  const roots = [manifest.entryRoots, manifest.problemRoots, manifest.methodHistoryRoots,
    manifest.adaptiveHistoryRoots, manifest.recallStrategyHistoryRoots, manifest.seenEventRoots]
  for (const set of roots) for (const reference of set) if (reference !== null) walkCollectionRefs(reference, 2)
  const visitedFeatures = new Set()
  const visitedPostings = new Set()
  const walkPostingRefs = (reference, depth) => {
    if (reference === null || visitedPostings.has(reference)) return
    visitedPostings.add(reference)
    references.add(reference)
    const node = postingNode(root, reference, depth)
    if (node.kind === 'posting-branch') for (const child of Object.values(node.children)) {
      walkPostingRefs(child, depth + 1)
    }
  }
  const walkFeatureRefs = (reference, depth) => {
    if (reference === null || visitedFeatures.has(reference)) return
    visitedFeatures.add(reference)
    references.add(reference)
    const node = featureNode(root, reference, depth)
    if (node.kind === 'feature-leaf') for (const row of node.rows) {
      if (row[1] === null) walkPostingRefs(row[2], 0)
    }
    else for (const child of Object.values(node.children)) walkFeatureRefs(child, depth + 1)
  }
  for (const reference of manifest.recallRoots) if (reference !== null) walkFeatureRefs(reference, 2)
  return [...references]
}
