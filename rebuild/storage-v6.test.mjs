import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RebuildEngine } from './engine.mjs'
import { MemoryStore } from './memory.mjs'
import { readStoredObject, V5_OBJECT_PREFIX, v5RequestObjectReferences } from './storage-v5.mjs'
import { readV6RecallCandidates, v6ObjectReferences } from './storage-v6.mjs'
import { entryRecallFeatures } from './recall-index.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

function newProblem(template, index) {
  const id = hash(`growth150-problem-${index}`)
  return { ...structuredClone(template), id, key: id, evidence: [], count: 0,
    evidenceRevision: 0, attemptedRevision: 0, capsules: [], capsuleDropped: 0,
    firstAt: index + 1, lastAt: index + 1, updatedAt: index + 1 }
}

test('format 6 stores entries and problems beyond 4,096 without root-sized ID arrays', t => {
  const root = mkdtempSync(join(tmpdir(), 'mse-growth150-v6-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const engine = new RebuildEngine({ stateRoot: root, now: () => 1_800_000_000_000 })
  engine.recordCorrection({ text: '保留 JSON 输入字段的原始顺序', sessionId: 'growth150-seed', turnId: '1' })
  engine.observeToolFailure({ sessionId: 'growth150-seed', turnId: '1', projectKey: '/repo/growth150',
    callId: 'seed-event', toolName: 'seed-tool', failureCode: 'tool_nonzero_exit', exitCode: 1,
    stderr: 'SyntaxError: seed storage growth fixture' })
  const template = engine.store.read()
  const entry = template.entries[0]
  const problem = template.problemLoop.problems[0]
  const additions = 4_100
  const usageRows = []

  engine.store.transaction(doc => {
    for (let index = 0; index < additions; index += 1) {
      const id = `mem_${hash(`growth150-entry-${index}`).slice(0, 24)}`
      doc.entries.push({ ...structuredClone(entry), id,
        instruction: `增长样本 ${index} 保留 JSON 输入字段的原始顺序`,
        methodStats: { version: 1, since: 1, coverage: 'complete', injected: 0,
          recurrences: 0, checkPasses: 0, checkFails: 0 },
        createdAt: index + 2, updatedAt: index + 2 })
      doc.problemLoop.problems.push(newProblem(problem, index))
    }
    return true
  })

  engine.store.transaction(doc => {
    for (const entry of doc.entries.slice(0, 260)) {
      entry.injected += 1
      entry.lastInjectedAt = 1_800_000_000_001
      delete entry.methodStats
      usageRows.push(entry.id)
    }
    return true
  })

  const reopened = new MemoryStore({ stateRoot: root })
  assert.equal(reopened.stats().format, 6)
  assert.equal(reopened.stats().entries, additions + 1)
  assert.equal(reopened.stats().problems, additions + 1)
  const doc = reopened.read()
  assert.equal(doc.entries.length, additions + 1)
  assert.equal(doc.problemLoop.problems.length, additions + 1)
  const manifest = JSON.parse(readFileSync(reopened.path, 'utf8'))
  assert.equal(manifest.entryRoots.length, 256)
  assert.equal(manifest.problemRoots.length, 256)
  assert.equal(Object.hasOwn(manifest, 'entryOrder'), false)
  assert.equal(Object.hasOwn(manifest, 'problemOrder'), false)
  assert.equal(manifest.hotState.entryUsage.length, 256,
    '260 usage updates retain only the newest 256 in the root')
  assert.equal(doc.entries.filter(row => usageRows.includes(row.id)).length, 260)
  assert.ok(doc.entries.filter(row => usageRows.includes(row.id)).every(row => row.injected === 1
    && row.methodStats === undefined), 'folded and overlaid usage counts preserve version-window clearing')
  const refs = v6ObjectReferences(root, manifest)
  const maximumPosting = refs.map(reference => readStoredObject(root, reference))
    .filter(node => node?.kind === 'feature-leaf').flatMap(node => node.rows)
    .reduce((maximum, row) => Math.max(maximum, row[3]), 0)
  assert.ok(maximumPosting >= additions + 1, 'a shared feature keeps the complete >4,096-ID posting')
  assert.equal(readV6RecallCandidates(root, manifest, '保留 JSON 输入字段的原始顺序').length,
    additions + 1, 'common recall returns the entire high-match group')
})

test('format 6 retains more than 128 method revisions and 1,024 live dedupe identities', t => {
  const root = mkdtempSync(join(tmpdir(), 'mse-growth150-history-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const engine = new RebuildEngine({ stateRoot: root, now: () => 1_800_000_000_000 })
  engine.observeToolFailure({ sessionId: 'growth150-history', turnId: '1', projectKey: '/repo/history',
    callId: 'seed-event', toolName: 'json-tool', failureCode: 'tool_nonzero_exit', exitCode: 1,
    stderr: 'SyntaxError: history growth fixture' })
  const seed = engine.store.read()
  const problem = seed.problemLoop.problems[0]
  const entryId = seed.entries[0]?.id ?? `mem_${hash('history-entry').slice(0, 24)}`
  engine.store.transaction(doc => {
    doc.methodHistory = Array.from({ length: 140 }, (_, index) => ({
      entryId, version: index + 1, instruction: `历史方法版本 ${index + 1} 保留完整内容`,
      applicability: '', exclusions: '', visibility: 'global', lesson: null,
      originScope: hash('global'), originEnvironment: hash('default'), originSession: null,
      stats: null, status: 'legacy_partial', reason: 'legacy_superseded_partial',
      archivedAt: index + 1, evidenceHash: null,
    }))
    doc.problemLoop.seenEvents = Array.from({ length: 1_100 }, (_, index) => ({
      eventId: hash(`growth150-seen-${index}`), at: 1_800_000_000_000 - index,
    }))
    doc.problemLoop.problems = [problem]
    return true
  })
  const reopened = new MemoryStore({ stateRoot: root })
  const doc = reopened.read()
  assert.equal(doc.methodHistory.length, 140)
  assert.equal(doc.problemLoop.seenEvents.length, 1_100)
  assert.equal(reopened.stats().format, 6)
})

test('format 6 recall views resolve one archived method version across deleted sequence gaps', t => {
  const root = mkdtempSync(join(tmpdir(), 'mse-growth150-history-lookup-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new MemoryStore({ stateRoot: root })
  const row = { entryId: `mem_${hash('growth150-history-lookup').slice(0, 24)}`, version: 1,
    instruction: '归档方法版本应按确切版本读取', applicability: '', exclusions: '', visibility: 'global',
    lesson: null, originScope: hash('global'), originEnvironment: hash('default'), originSession: null,
    stats: null, status: 'legacy_partial', reason: 'legacy_superseded_partial', archivedAt: 1,
    evidenceHash: null }
  const later = { ...row, version: 2, instruction: '较新的归档方法版本同样可精确读取', archivedAt: 2 }
  store.transaction(doc => { doc.methodHistory.push(row, later); return true })
  store.transaction(doc => {
    doc.methodHistory = doc.methodHistory.filter(candidate => candidate.version !== 1)
    return true
  })
  assert.deepEqual(store.read().methodHistory, [later], 'only the newer edition remains live')
  const manifest = JSON.parse(readFileSync(join(root, 'memory-v1.json'), 'utf8'))
  assert.equal(manifest.methodHistoryCount, 1)
  assert.equal(manifest.nextMethodHistorySequence, 2, 'deletion does not reuse an older row sequence')

  const view = store.readRecallView('不命中任何方法特征')
  assert.deepEqual(view.methodHistory, [], 'ordinary recall does not materialize the full history')
  assert.deepEqual(view.__getMethodHistory(later.entryId, later.version), later,
    'the precise archived edition is resolved from its V6 method-history root')
  assert.equal(view.__getMethodHistory(row.entryId, row.version), undefined,
    'a removed method edition is not returned from an obsolete collection page')
  assert.equal(view.__getMethodHistory(later.entryId, later.version + 1), undefined,
    'a neighboring version is never substituted')
})

test('format 6 uses exact compact postings, stable accented features, and complete object references', t => {
  const root = mkdtempSync(join(tmpdir(), 'mse-growth150-index-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const engine = new RebuildEngine({ stateRoot: root, now: () => 1_800_000_000_000 })
  engine.recordCorrection({ text: '保留 équipe14 zebraword33 字段和原始顺序', sessionId: 'growth150-index', turnId: '1' })
  const seed = engine.store.read().entries[0]
  const ids = []
  engine.store.transaction(doc => {
    for (let index = 0; index < 20; index += 1) {
      const id = `mem_${hash(`growth150-index-entry-${index}`).slice(0, 24)}`
      ids.push(id)
      doc.entries.push({ ...structuredClone(seed), id,
        instruction: `保留 équipe14 zebraword33 配置字段第 ${index} 项`,
        createdAt: index + 2, updatedAt: index + 2 })
    }
    doc.requests.push({ ticket: 'growth150-audit', kind: 'digest', at: 1_800_000_000_001,
      problemId: null, entryId: null, digestDay: '2026-11-25', requestHash: hash('growth150-request'),
      dispatchHash: hash('growth150-dispatch'), dispatchedAt: 1_800_000_000_002, settled: true,
      terminal: 'completed', usage: { input: 3, output: 2, cached: null, cacheWrite: null,
        reasoning: null, total: 5, known: true }, maxTokens: 2048, evidenceIds: [], tokenHashes: [],
      parentVersion: null, routeId: hash('growth150-route'), material: hash('growth150-material'),
      retryOf: null, digestFacts: [], digestThrough: 1_800_000_000_003, sourceSessionId: 'growth150-index',
      sourceRoute: { provider: 'fixture', model: 'fixture-model' }, digestKeys: [], digestExcluded: [],
      digestAdmission: [] })
    return true
  })

  const snapshot = engine.store.readSnapshot()
  const manifest = JSON.parse(snapshot.bytes.toString('utf8'))
  assert.equal(manifest.format, 6)
  const candidates = readV6RecallCandidates(root, manifest, 'équipe14 zebraword33 配置字段')
  assert.deepEqual(candidates.map(row => row.id).sort(), [seed.id, ...ids].sort())

  const saved = new Map(candidates.filter(row => ids.includes(row.id)).map(row => [row.id, row]))
  engine.store.transaction(doc => {
    const removed = new Set(ids.slice(0, 5))
    doc.entries = doc.entries.filter(row => !removed.has(row.id))
    return true
  })
  const compacted = engine.store.readSnapshot()
  const compactedManifest = JSON.parse(compacted.bytes.toString('utf8'))
  const afterRemoval = readV6RecallCandidates(root, compactedManifest, 'équipe14 zebraword33 配置字段')
  assert.deepEqual(afterRemoval.map(row => row.id).sort(), [seed.id, ...ids.slice(5)].sort())
  const compactedRefs = v6ObjectReferences(root, compactedManifest)
  const compactedRows = compactedRefs.map(reference => readStoredObject(root, reference))
    .filter(node => node?.kind === 'feature-leaf').flatMap(node => node.rows)
  const sixteen = compactedRows.find(row => row[3] === 16)
  assert.ok(sixteen)
  assert.notEqual(sixteen[1], null, 'a posting contracts back into the feature page at 16 IDs')

  engine.store.transaction(doc => {
    doc.entries.push(...ids.slice(0, 5).map(id => saved.get(id)))
    return true
  })
  const restored = engine.store.readSnapshot()
  const restoredManifest = JSON.parse(restored.bytes.toString('utf8'))
  assert.deepEqual(readV6RecallCandidates(root, restoredManifest, 'équipe14 zebraword33 配置字段')
    .map(row => row.id).sort(), [seed.id, ...ids].sort())

  const references = new Set(v6ObjectReferences(root, manifest))
  const requestReferences = v5RequestObjectReferences(root, manifest)
  assert.ok(requestReferences.length > 0)
  assert.ok(requestReferences.every(reference => references.has(reference)),
    'the request index, descendant nodes, and body references are all returned')
  const objectNames = new Set(readdirSync(root).filter(name => name.startsWith(V5_OBJECT_PREFIX)))
  assert.ok([...references].every(reference => objectNames.has(`${V5_OBJECT_PREFIX}${reference}.json`)))

  const featureRows = [...references].map(reference => readStoredObject(root, reference))
    .filter(node => node?.kind === 'feature-leaf').flatMap(node => node.rows)
  const common = featureRows.find(row => row[3] === ids.length + 1)
  assert.ok(common, 'a common feature contains every relevant entry')
  assert.equal(common[1], null, 'large postings spill out of the bounded feature page')
  const accentFeatures = entryRecallFeatures(seed)
  assert.ok(accentFeatures.has('s:équipe14'))
  assert.ok(accentFeatures.has('s:zebraword33'))
  for (const node of [...references].map(reference => readStoredObject(root, reference))
    .filter(value => value?.kind === 'feature-leaf')) {
    assert.ok(node.rows.every((row, index) => index === 0 || node.rows[index - 1][0] < row[0]),
      'feature leaves use the same deterministic ordering when written and validated')
  }
})
