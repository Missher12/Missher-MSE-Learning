import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync,
  statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDoc, MemoryStore } from './memory.mjs'
import { RebuildEngine } from './engine.mjs'
import { encodeMemoryDocument } from './storage.mjs'
import { V5_OBJECT_PREFIX, V5_TURN_FACT_BUCKETS, writeV5Document } from './storage-v5.mjs'
import { MAX_STORE_BYTES } from '../src/store.mjs'

const hash = value => createHash('sha256').update(String(value)).digest('hex')
const rootFor = () => mkdtempSync(join(tmpdir(), 'mse-storage-v5-'))

function savedRule(index = 1) {
  const instruction = `保存第 ${index} 条 JSON 配置规则时先验证完整性`
  const id = `mem_${hash(`entry-${index}`).slice(0, 24)}`
  return { id, type: 'rule', status: 'user_rule', instruction, applicability: '处理 JSON 配置时',
    exclusions: '', visibility: 'global', originScope: hash('global'), originEnvironment: hash('default'),
    originSession: null, lesson: null, problemSignature: null, version: 1, parentVersion: null,
    superseded: null, injected: 0, recurrences: 0, createdAt: index, updatedAt: index,
    lastInjectedAt: null, evidenceHash: null, factDigest: null, digestDay: null, importedFrom: null }
}

function historyRow(entryId, version) {
  return { entryId, version, instruction: `历史版本 ${version} 保留完整原文`, applicability: '', exclusions: '',
    visibility: 'global', lesson: null, originScope: hash('global'), originEnvironment: hash('default'),
    originSession: null, stats: null, status: 'legacy_partial', reason: 'legacy_superseded_partial',
    archivedAt: version, evidenceHash: null }
}

function auditedRequest(index) {
  const ticket = `ticket-${String(index).padStart(4, '0')}`
  const contentHash = hash(`digest-content-${index}`)
  const request = { ticket, kind: 'digest', at: 1_800_000_000_000 + index, problemId: null,
    entryId: null, digestDay: '2026-11-20', requestHash: hash(`request-${index}`), dispatchHash: hash(`dispatch-${index}`),
    dispatchedAt: 1_800_000_000_001 + index, settled: true, terminal: 'completed',
    usage: { input: 31, output: 7, cached: null, cacheWrite: null, reasoning: null, total: 38, known: true },
    maxTokens: 2048, evidenceIds: [contentHash], tokenHashes: [hash(`token-${index}`)], parentVersion: null,
    routeId: hash('route'), material: hash(`material-${index}`), retryOf: index === 80 ? 'ticket-0079' : null,
    digestFacts: Array.from({ length: 32 }, (_, n) => ({ at: n + index, kind: n % 2 ? 'turn' : 'failure' })),
    digestThrough: 1_800_000_000_100 + index, sourceSessionId: `session-${index}`,
    sourceRoute: { provider: 'fixture', model: 'fixture-model' },
    digestKeys: Array.from({ length: 32 }, (_, n) => `fact-key-${index}-${n}`),
    digestExcluded: [`${contentHash}|source_unverified`],
    digestAdmission: [{ key: `fact-key-${index}-0`, kind: 'failure', contentHash,
      scope: hash('scope'), environment: hash('environment'), visibility: 'scoped', temporary: false,
      problemId: contentHash, evidenceIds: [contentHash], evidenceDigest: hash(`evidence-${index}`), passed: true }] }
  return request
}

function scaleEntry(index) {
  const row = savedRule(index)
  const topic = `topicx${index.toString(36)}`
  const object = `objecty${index.toString(36)}`
  const type = ['rule', 'lesson', 'digest', 'lesson'][index % 4]
  row.type = type
  row.status = type === 'rule' ? 'user_rule' : ['pending', 'check_passed', 'needs_revision'][index % 3]
  row.visibility = index % 5 === 0 ? 'scoped' : 'global'
  row.originScope = hash(index % 5 === 0 ? 'capacity-project' : 'global')
  row.applicability = `处理 ${topic} ${object} 的 JSON、CSV 或 YAML 数据时`
  row.exclusions = index % 31 === 0 ? '不适用于损坏的旧版 CSV 文件' : ''
  row.instruction = `${topic} ${object} 转换失败时，先核对字段再保留原始顺序`
  row.lesson = type === 'lesson' ? { problemId: hash(`problem-${index}`), evidenceIds: [hash(`evidence-${index}`)],
    repairSteps: ['核对字段', '保持输入顺序'],
    verification: { check: 'node --test', expected: '通过' } } : null
  return row
}

function legacyTurnFact(index) {
  const id = hash(`legacy-turn-${index}`)
  return { id, turnKey: id, sessionId: `legacy-session-${index}`, day: '2026-11-20',
    at: 1_800_000_000_000 + index, taskSummary: '旧格式事实'.repeat(20), outcome: 'unknown',
    evidenceBrief: '未知'.repeat(50), evidenceHash: hash(`legacy-evidence-${index}`),
    failures: index % 3, cancellations: index % 7 }
}

test('format4 turn facts migrate losslessly and repeated writes append only bounded buckets', t => {
  const root = rootFor()
  const store = new MemoryStore({ stateRoot: root })
  const legacy = createDoc()
  legacy.format = 4
  legacy.entries = Array.from({ length: 77 }, (_, index) => scaleEntry(index))
  legacy.turnFacts = Array.from({ length: 251 }, (_, index) => legacyTurnFact(index))
  const originalFacts = structuredClone(legacy.turnFacts)
  const originalBytes = Buffer.from(encodeMemoryDocument(legacy))
  writeFileSync(store.path, originalBytes, { mode: 0o600 })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.deepEqual(store.read().turnFacts, originalFacts, 'the legacy read preserves every fact in order')
  store.transaction(() => true)
  assert.deepEqual(store.read().turnFacts, originalFacts, 'format4 migration keeps every fact field and order')
  assert.deepEqual(store.getMigrationSource(), originalBytes, 'the exact legacy bytes remain archived')

  // Simulate a real v5 manifest from the first chunk-store revision, where turnFacts lived in coreRefs.
  // The preceding first-write migration now publishes format 6, so build this compatibility source
  // with the frozen v5 writer instead of relabeling a format-6 manifest as v5.
  const legacyV5 = structuredClone(legacy)
  legacyV5.format = 5
  writeV5Document(root, legacyV5, { sourceBytes: originalBytes,
    validateEntry: () => {}, validateProblem: () => {}, validateRequest: () => {}, validateTurnFact: () => {} })
  const previousManifest = JSON.parse(readFileSync(store.path, 'utf8'))
  delete previousManifest.turnFactBuckets
  delete previousManifest.turnFactCount
  delete previousManifest.turnFactOrder
  const oldFactBytes = Buffer.from(JSON.stringify(originalFacts))
  const oldFactHash = hash(oldFactBytes)
  writeFileSync(join(root, `${V5_OBJECT_PREFIX}${oldFactHash}.json`), oldFactBytes, { mode: 0o600 })
  previousManifest.coreRefs.turnFacts = oldFactHash
  writeFileSync(store.path, JSON.stringify(previousManifest), { mode: 0o600 })
  const compatible = new MemoryStore({ stateRoot: root })
  assert.deepEqual(compatible.read().turnFacts, originalFacts, 'old v5 coreRefs remain readable')
  compatible.transaction(() => true)
  const bucketed = compatible.read()
  assert.deepEqual(bucketed.turnFacts, originalFacts, 'conversion from old v5 coreRefs is lossless')
  const firstManifest = JSON.parse(readFileSync(store.path, 'utf8'))
  assert.equal(firstManifest.turnFactBuckets.length, V5_TURN_FACT_BUCKETS)
  assert.equal(Object.hasOwn(firstManifest.coreRefs, 'turnFacts'), false)

  const objectPrefix = name => name.startsWith(V5_OBJECT_PREFIX)
  const objectsBefore = readdirSync(root).filter(objectPrefix).length
  const bytesBefore = compatible.stats().bytes
  let now = 1_800_000_100_000
  const engine = new RebuildEngine({ stateRoot: root, now: () => now++ })
  for (let index = 1; index <= 24; index += 1) {
    engine.recordTurnFacts({ sessionId: 'new-session', turnId: String(index),
      taskSummary: `新回合事实 ${index}` })
  }

  const after = engine.store.read()
  assert.equal(after.turnFacts.length, 251)
  assert.deepEqual(after.turnFacts.slice(0, 227), originalFacts.slice(24),
    'bounded history eviction preserves the original surviving order and fields')
  assert.deepEqual(engine.store.getMigrationSource(), originalBytes)
  const bytesAdded = engine.store.stats().bytes - bytesBefore
  const objectsAdded = readdirSync(root).filter(objectPrefix).length - objectsBefore
  t.diagnostic(`251-fact format4 migration: ${Buffer.byteLength(JSON.stringify(originalFacts))} fact bytes; `
    + `24 writes added ${bytesAdded} physical bytes across ${objectsAdded} objects`)
  assert.ok(objectsAdded <= 48, `24 updates created ${objectsAdded} immutable bucket objects`)
  assert.ok(bytesAdded < 1_000_000, `24 updates added ${bytesAdded} bytes`)
  for (const ref of firstManifest.turnFactBuckets.filter(Boolean)) {
    assert.ok(existsSync(join(root, `${V5_OBJECT_PREFIX}${ref}.json`)))
  }
})

test('format-4 pure reads stay byte-exact and first write migrates complete evidence into format 6', t => {
  const root = rootFor()
  const store = new MemoryStore({ stateRoot: root })
  const doc = createDoc()
  doc.format = 4
  const current = savedRule()
  doc.entries.push(current)
  doc.methodHistory = Array.from({ length: 8 }, (_, index) => historyRow(current.id, index + 1))
  doc.requests = Array.from({ length: 81 }, (_, index) => auditedRequest(index))
  const original = Buffer.from(encodeMemoryDocument(doc))
  writeFileSync(store.path, original, { mode: 0o600 })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const before = store.read()
  assert.equal(before.format, 4)
  assert.deepEqual(readFileSync(store.path), original)

  store.transaction(next => { next.controls.userPaused = true; return true })

  const disk = JSON.parse(readFileSync(store.path, 'utf8'))
  assert.equal(disk.format, 6, 'the old writer format must no longer accept the manifest')
  const reopened = new MemoryStore({ stateRoot: root })
  const migrated = reopened.read()
  assert.equal(migrated.format, 6)
  assert.deepEqual(migrated.entries, doc.entries)
  assert.deepEqual(migrated.methodHistory, doc.methodHistory)
  assert.deepEqual(reopened.listRequests(), doc.requests)
  assert.equal(reopened.stats().entries, 1)
  assert.equal(reopened.stats().requests, 81)
  assert.ok(readdirSync(root).some(name => name.startsWith('.memory-v1-object-')))
  for (const name of readdirSync(root).filter(name => name.startsWith('.memory-v1-object-'))) {
    assert.ok(statSync(join(root, name)).size <= MAX_STORE_BYTES, `${name} is bounded`)
  }
  assert.equal(existsSync(join(root, '.memory-v1.lock')), false)
})

test('an interrupted format-4 migration keeps the old manifest readable and retries losslessly', t => {
  const root = rootFor()
  const store = new MemoryStore({ stateRoot: root })
  const legacy = createDoc()
  legacy.format = 4
  const current = savedRule()
  legacy.entries.push(current)
  legacy.methodHistory = [historyRow(current.id, 1)]
  const originalBytes = Buffer.from(encodeMemoryDocument(legacy))
  writeFileSync(store.path, originalBytes, { mode: 0o600 })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const historyKey = `${current.id}\u0000${legacy.methodHistory[0].version}`
  const historyLeaf = { kind: 'collection-leaf', depth: 2,
    rows: [[historyKey, 0, legacy.methodHistory[0]]] }
  const blockedObject = join(root,
    `${V5_OBJECT_PREFIX}${hash(Buffer.from(JSON.stringify(historyLeaf)))}.json`)
  mkdirSync(blockedObject)

  assert.throws(() => store.transaction(doc => { doc.controls.userPaused = true; return true }))
  assert.deepEqual(readFileSync(store.path), originalBytes,
    'failure before manifest publication leaves the exact format-4 source in place')
  assert.equal(store.read().format, 4)
  assert.deepEqual(store.read().entries, [current])
  assert.deepEqual(store.read().methodHistory, legacy.methodHistory)

  rmdirSync(blockedObject)
  assert.equal(store.transaction(doc => { doc.controls.userPaused = true; return true }), true)
  const reopened = new MemoryStore({ stateRoot: root })
  assert.equal(reopened.read().format, 6)
  assert.deepEqual(reopened.read().entries, [current])
  assert.deepEqual(reopened.read().methodHistory, legacy.methodHistory)
  assert.deepEqual(reopened.getMigrationSource(), originalBytes,
    'retry archives the exact legacy source bytes')
})

test('request audit lookup keeps every exact row beyond the legacy 96-row projection', t => {
  const root = rootFor()
  const store = new MemoryStore({ stateRoot: root })
  const expected = Array.from({ length: 120 }, (_, index) => auditedRequest(index))
  for (const row of expected.slice(0, 5)) row.usage = { input: null, output: null, cached: null,
    cacheWrite: null, reasoning: null, total: null, known: false }
  t.after(() => rmSync(root, { recursive: true, force: true }))

  store.transaction(doc => {
    for (let index = 0; index < 120; index += 1) {
      const row = auditedRequest(index)
      if (index < 5) row.usage = { input: null, output: null, cached: null, cacheWrite: null,
        reasoning: null, total: null, known: false }
      doc.requests.push(row)
    }
    for (let index = 0; index < 63; index += 1) {
      doc.materials.push({ key: hash(`material-${index}`), terminal: index < 5 ? 'unknown' : 'completed',
        attempts: 1, autoRetriesUsed: 0, unknownCost: index < 5, updatedAt: index,
        manualAllowed: index === 10, autoRetryAllowed: false, ticket: `ticket-${String(index).padStart(4, '0')}` })
    }
    return true
  })

  const reopened = new MemoryStore({ stateRoot: root })
  assert.equal(reopened.stats().requests, 120)
  assert.ok(reopened.read().requests.length <= 96)
  assert.deepEqual(reopened.listRequests(), expected)
  assert.deepEqual(reopened.getRequest('ticket-0003').usage,
    { input: null, output: null, cached: null, cacheWrite: null, reasoning: null, total: null, known: false })
  assert.deepEqual(reopened.getRequest('ticket-0080').digestAdmission,
    auditedRequest(80).digestAdmission)
  assert.equal(reopened.getRequest('ticket-0080').retryOf, 'ticket-0079')
  assert.equal(reopened.read().materials.length, 63)
})

test('hash buckets retain the original entry and equal-time request order', t => {
  const root = rootFor()
  const store = new MemoryStore({ stateRoot: root })
  const rows = [6, 5, 4, 3, 2, 1].map(savedRule)
  const requests = [6, 5, 4, 3, 2, 1].map(index => ({ ...auditedRequest(index), at: 7 }))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  store.transaction(doc => {
    doc.entries.push(...rows)
    doc.requests.push(...requests)
    return true
  })

  const reopened = new MemoryStore({ stateRoot: root })
  assert.deepEqual(reopened.read().entries, rows)
  assert.deepEqual(reopened.listRequests(), requests)
})

test('usage, receipts, and turn usage update the hot manifest without rewriting entry objects', t => {
  const root = rootFor()
  const store = new MemoryStore({ stateRoot: root })
  const row = savedRule(17)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  store.transaction(doc => { doc.entries.push(row); return true })

  const before = JSON.parse(readFileSync(store.path, 'utf8'))
  const objectsBefore = readdirSync(root).filter(name => name.startsWith('.memory-v1-object-')).sort()
  const receipt = { id: hash('receipt-17'), turnKey: hash('turn-17'), at: 700,
    bytes: 40, offered: [{ id: row.id, version: 1 }], settled: false, outcome: null,
    evidenceHash: null, source: null }
  const turnUsage = { turnKey: hash('turn-usage-17'), at: 701 }
  store.transactionRecall('JSON configuration', doc => {
    const entry = doc.entries.find(candidate => candidate.id === row.id)
    entry.injected += 1
    entry.lastInjectedAt = 701
    entry.methodStats = { version: 1, since: 701, coverage: 'complete', injected: 1,
      recurrences: 0, checkPasses: 0, checkFails: 0 }
    doc.receipts.push(receipt)
    doc.turnUsage.push(turnUsage)
    return true
  }, [row.id])

  const after = JSON.parse(readFileSync(store.path, 'utf8'))
  const objectsAfter = readdirSync(root).filter(name => name.startsWith('.memory-v1-object-')).sort()
  assert.deepEqual(after.entryBuckets, before.entryBuckets)
  assert.deepEqual(after.recallShards, before.recallShards)
  assert.deepEqual(objectsAfter, objectsBefore)
  assert.deepEqual(after.hotState.receipts, [receipt])
  assert.deepEqual(after.hotState.turnUsage, [turnUsage])
  assert.deepEqual(after.hotState.entryUsage, [{ id: row.id, injected: 1, lastInjectedAt: 701,
    methodStats: { version: 1, since: 701, coverage: 'complete', injected: 1,
      recurrences: 0, checkPasses: 0, checkFails: 0 } }])

  const reopened = new MemoryStore({ stateRoot: root }).read()
  assert.equal(reopened.entries[0].injected, 1)
  assert.equal(reopened.entries[0].lastInjectedAt, 701)
  assert.deepEqual(reopened.entries[0].methodStats, after.hotState.entryUsage[0].methodStats)
  assert.deepEqual(reopened.receipts, [receipt])
  assert.deepEqual(reopened.turnUsage, [turnUsage])
})

test('all 4,096 mixed entries persist and a rare-topic read opens only indexed candidates', t => {
  const root = rootFor()
  const store = new MemoryStore({ stateRoot: root })
  const rows = Array.from({ length: 4096 }, (_, index) => scaleEntry(index))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  store.transaction(doc => { doc.entries.push(...rows); return true })

  const reopened = new MemoryStore({ stateRoot: root })
  assert.equal(reopened.stats().entries, 4096)
  assert.deepEqual(reopened.read().entries, rows)
  const suffix = (4095).toString(36)
  const view = reopened.readRecallView(`topicx${suffix} objecty${suffix}`)
  assert.ok(view.entries.some(row => row.id === rows[4095].id))
  assert.ok(view.entries.length < rows.length, `opened ${view.entries.length} candidates`)
  for (const name of readdirSync(root).filter(name => name.startsWith('.memory-v1-object-'))) {
    assert.ok(statSync(join(root, name)).size <= MAX_STORE_BYTES, `${name} is bounded`)
  }
})
