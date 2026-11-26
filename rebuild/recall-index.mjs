/** Conservative recall candidate index. It never scores or admits an entry; recall.mjs remains authoritative. */
import { createHash } from 'node:crypto'
import { analyze } from '../src/recall.mjs'
import { normalizedView } from './recall.mjs'

export const RECALL_INDEX_SHARDS = 256
const featureHash = value => createHash('sha256').update(value).digest('hex')
const shardFor = feature => Number.parseInt(featureHash(feature).slice(0, 2), 16)
const typed = (kind, value) => {
  const full = `${kind}:${value}`
  return full.length <= 128 ? full : `${kind}:~${featureHash(value)}`
}

export function entryRecallFeatures(entry) {
  const text = `${entry.applicability} ${entry.instruction} ${entry.lesson?.failurePattern ?? ''}`
  const features = new Set()
  for (const body of [analyze(text), normalizedView(text)]) {
    for (const value of body.semantic) if (!body.weak.has(value)) features.add(typed('s', value))
    for (const value of body.bigrams) features.add(typed('b', value))
    for (const value of body.formats) features.add(typed('f', value))
  }
  return features
}

export function queryRecallFeatures(prompt) {
  const views = [analyze(prompt), normalizedView(prompt)]
  const features = new Set()
  for (const view of views) {
    for (const value of view.semantic) if (!view.weak.has(value)) features.add(typed('s', value))
    for (const value of view.bigrams) features.add(typed('b', value))
    for (const value of view.formats) features.add(typed('f', value))
  }
  return features
}

export function buildRecallIndex(entries) {
  const shards = Array.from({ length: RECALL_INDEX_SHARDS }, () => new Map())
  for (const entry of entries ?? []) {
    for (const feature of entryRecallFeatures(entry)) {
      const shard = shards[shardFor(feature)]
      const ids = shard.get(feature) ?? new Set()
      ids.add(entry.id)
      shard.set(feature, ids)
    }
  }
  return shards
}

export function updateRecallIndex(index, changes) {
  const next = [...index]
  const changedShards = new Set()
  const writable = shardIndex => {
    if (!changedShards.has(shardIndex)) {
      const source = index[shardIndex] ?? new Map()
      next[shardIndex] = new Map([...source].map(([key, ids]) => [key, new Set(ids)]))
      changedShards.add(shardIndex)
    }
    return next[shardIndex]
  }
  for (const { id, before = null, after = null } of changes ?? []) {
    if (before === null && after === null) continue
    const oldFeatures = before === null ? new Set() : entryRecallFeatures(before)
    const newFeatures = after === null ? new Set() : entryRecallFeatures(after)
    for (const feature of oldFeatures) {
      if (newFeatures.has(feature)) continue
      const shard = writable(shardFor(feature))
      const ids = shard.get(feature)
      ids?.delete(id)
      if (ids?.size === 0) shard.delete(feature)
    }
    for (const feature of newFeatures) {
      if (oldFeatures.has(feature)) continue
      const shard = writable(shardFor(feature))
      const ids = shard.get(feature) ?? new Set()
      ids.add(id)
      shard.set(feature, ids)
    }
  }
  return next
}

export function recallCandidates(index, prompt) {
  const queryFeatures = queryRecallFeatures(prompt)
  const formatIds = new Set()
  const bigramIds = new Set()
  const strongCounts = new Map()
  for (const feature of queryFeatures) {
    const shard = index?.[shardFor(feature)]
    const ids = shard?.get(feature) ?? []
    if (feature.startsWith('f:')) for (const id of ids) formatIds.add(id)
    else if (feature.startsWith('b:')) for (const id of ids) bigramIds.add(id)
    else if (feature.startsWith('s:')) for (const id of ids) strongCounts.set(id, (strongCounts.get(id) ?? 0) + 1)
  }
  const ids = new Set(formatIds)
  for (const [id, count] of strongCounts) if (count >= 2 || (count >= 1 && bigramIds.has(id))) ids.add(id)
  return ids
}

export function serializeRecallShard(shard) {
  return Object.fromEntries([...shard.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([feature, ids]) => [feature, [...ids].sort()]))
}

export function parseRecallShard(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid_recall_index')
  const shard = new Map()
  for (const [feature, ids] of Object.entries(value)) {
    if (!/^[sbf]:(?:.{1,127}|~[a-f0-9]{64})$/u.test(feature) || !Array.isArray(ids)
      || ids.some(id => typeof id !== 'string' || !/^mem_[a-f0-9]{24}$/u.test(id))
      || new Set(ids).size !== ids.length) throw new TypeError('invalid_recall_index')
    shard.set(feature, new Set(ids))
  }
  return shard
}

export function recallFeatureShard(feature) { return shardFor(feature) }
