import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { rankForRecall, selectRecall } from './recall.mjs'
import { buildRecallIndex, recallCandidates, updateRecallIndex, serializeRecallShard,
  parseRecallShard, entryRecallFeatures, recallFeatureShard } from './recall-index.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
function entry(index, topic, options = {}) {
  const id = `mem_${hash(`entry-${index}`).slice(0, 24)}`
  const type = options.type ?? (index % 4 === 0 ? 'rule' : 'lesson')
  return { id, type,
    status: options.status ?? (index % 13 === 0 ? 'retired' : 'pending'),
    instruction: options.instruction ?? `处理 ${topic} 时先检查 ${topic} 字段，再保留稳定结果`,
    applicability: options.applicability ?? `在 ${topic} 文件格式转换时`,
    exclusions: options.exclusions ?? '', visibility: options.scoped ? 'scoped' : 'global',
    originScope: options.scoped ? options.scope ?? hash('scope-a') : hash('global'),
    originEnvironment: options.scoped ? options.environment ?? hash('env-a') : hash('default'),
    lesson: type === 'lesson' ? { failurePattern: `${topic} 内容解析失败`,
      verification: { check: 'node --test', expected: '通过' } } : null, updatedAt: index + 1 }
}

const projection = rows => rows.map(({ entry: row, score, appMatch, precision }) =>
  ({ id: row.id, version: row.version ?? 1, score, appMatch, precision }))

test('indexed recall candidates preserve full scorer and selector results across scopes, formats, and rare terms', () => {
  const entries = Array.from({ length: 1_024 }, (_, index) => entry(index,
    ['JSON', 'CSV', 'YAML', '并发锁', '超稀有瓷青', 'SQLite迁移', '日期字段', '尾随逗号'][index % 8], {
      scoped: index % 5 === 0, scope: hash(index % 2 ? 'scope-a' : 'scope-b'),
      environment: hash(index % 2 ? 'env-a' : 'env-b'),
      exclusions: index % 29 === 0 ? '不适用于 JSON 配置转换' : '',
    }))
  const index = buildRecallIndex(entries)
  const cases = [
    { prompt: '解析 JSON 配置时处理尾随逗号字段', scope: hash('scope-a'), environment: hash('env-a') },
    { prompt: '转换 CSV 日期字段并保留排序', scope: hash('scope-b'), environment: hash('env-b') },
    { prompt: '并发锁处理 SQLite迁移，遇到超稀有瓷青字段时如何恢复', scope: hash('scope-a'), environment: hash('env-a') },
    { prompt: '不要用于 YAML 配置转换', scope: hash('scope-a'), environment: hash('env-a') },
  ]
  for (const options of cases) {
    const expected = rankForRecall(entries, options)
    const ids = recallCandidates(index, options.prompt)
    const actual = rankForRecall(entries.filter(row => ids.has(row.id)), options)
    assert.deepEqual(projection(actual), projection(expected), options.prompt)
    assert.deepEqual(selectRecall(entries.filter(row => ids.has(row.id)), options), selectRecall(entries, options),
      `selection parity: ${options.prompt}`)
  }
})

test('incremental recall index updates remove stale features and add the revised edition', () => {
  const before = entry(1, '瓷青陶釉', { instruction: '瓷青陶釉解析失败时保留原始字段',
    applicability: '仅在瓷青陶釉数据损坏时' })
  const after = { ...before, instruction: '墨绿翡翠数据解析失败时保留原始字段',
    applicability: '仅在墨绿翡翠数据损坏时',
    lesson: { ...before.lesson, failurePattern: '墨绿翡翠数据解码失败' } }
  const original = buildRecallIndex([before])
  const next = updateRecallIndex(original, [{ id: before.id, before, after }])
  const oldFeatures = entryRecallFeatures(before)
  const newFeatures = entryRecallFeatures(after)
  const oldFeature = [...oldFeatures].find(feature => feature.startsWith('b:') && !newFeatures.has(feature))
  const newFeature = [...newFeatures].find(feature => feature.startsWith('b:') && !oldFeatures.has(feature))
  assert.ok(original[recallFeatureShard(oldFeature)].get(oldFeature).has(before.id))
  assert.ok(!next[recallFeatureShard(oldFeature)].get(oldFeature)?.has(before.id))
  assert.ok(next[recallFeatureShard(newFeature)].get(newFeature).has(after.id))
  assert.ok(!original[recallFeatureShard(newFeature)].get(newFeature)?.has(after.id), 'prior index remains immutable')
})

test('bounded shard encoding accepts a legal 184-character topic token', () => {
  const long = 'q'.repeat(184)
  const row = entry(12_345, long, { instruction: `${long} 字段解析失败时保留原始记录`,
    applicability: `仅在${long}配置导入时` })
  const shards = buildRecallIndex([row])
  const reopened = shards.map(shard => parseRecallShard(serializeRecallShard(shard)))
  const feature = [...entryRecallFeatures(row)].find(value => value.startsWith('s:'))
  assert.ok(reopened[recallFeatureShard(feature)].get(feature).has(row.id))
})
