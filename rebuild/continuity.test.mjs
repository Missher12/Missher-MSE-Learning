import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { RebuildEngine } from './engine.mjs'
import { createDoc, MemoryStore, noCommit, validateDoc } from './memory.mjs'
import { MAX_STORE_BYTES } from '../src/store.mjs'
import { buildEngine, failureX } from '../scripts/rsi/adaptive-engine-fixture.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const route = { provider: 'original-provider', model: 'original-model', reasoningEffort: 'max' }
const revisedLesson = work => ({
  schema: 'mse-failure-lesson-v1', applicability: 'API endpoint rejected by server',
  failurePattern: 'API request was rejected by server',
  rootCause: { summary: 'API server rejected the endpoint request', basis: 'observed',
    evidenceIds: [JSON.parse(work.request.text).evidenceIds[0]] },
  repairSteps: ['Check the API endpoint and server response', 'Retry the request with the current field version'],
  verification: { check: 'Run API endpoint validation', expected: 'Server accepts the request' },
  instruction: 'When the API server rejects a request, verify the endpoint and current field version',
})
function oldRevision() {
  const f = buildEngine()
  assert.equal(f.engine.observeRoute({ sessionId: 'seed-x', route }).ok, true)
  f.prepare('seed-x', 'recurrence', f.targetX.instruction)
  f.fail('seed-x', 'recurrence', 'recurrence-call', failureX)
  f.settle('seed-x', 'recurrence')
  // The surviving route belongs to a later admitted capsule, not necessarily capsules[0].
  f.registered.add('later-source')
  assert.equal(f.engine.observeRoute({ sessionId: 'later-source', route }).ok, true)
  f.fail('later-source', 'later-turn', 'later-call', failureX)
  for (let i = 0; i < 17; i++) f.engine.observeRoute({ sessionId: `unrelated-${i}`,
    route: { provider: 'unrelated', model: 'must-not-borrow' } })
  const next = new RebuildEngine({ stateRoot: f.root })
  next.setSourceGuard(id => f.registered.has(id), () => [...f.registered])
  return { ...f, engine: next }
}

test('evicted source routes resume revision from the exact admitted native origin after reload', () => {
  const f = oldRevision()
  try {
    assert.equal(f.engine.store.read().routes.some(r => r.sessionId === 'later-source'), false)
    const before = f.engine.store.read().entries
    const work = f.engine.beginWork()
    assert.equal(work?.kind, 'revise')
    assert.deepEqual(work.request.route, route)
    const request = f.engine.store.read().requests.at(-1)
    assert.equal(request.sourceSessionId, 'later-source')
    assert.deepEqual(request.sourceRoute, route)
    assert.deepEqual(f.engine.store.read().entries, before, 'resuming does not approve or rewrite the method')
    f.engine.markDispatched(work.ticket)
    const result = f.engine.finishWork({ ticket: work.ticket, result: revisedLesson(work),
      usage: { input: 10, output: 20, total: 30 } })
    assert.equal(result.revision, 'replaced')
    assert.equal(result.version, 2)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

for (const invalid of ['revoked', 'unbound-turn', 'route-mismatch', 'missing-route']) {
  test(`old route recovery refuses ${invalid} without borrowing the newest session model`, () => {
    const f = oldRevision()
    try {
      if (invalid === 'revoked') f.registered.delete('later-source')
      else f.engine.store.transaction(doc => {
        const p = doc.problemLoop.problems.find(r => r.id === f.targetX.lesson.problemId)
        if (invalid === 'unbound-turn') p.origin.turnHash = hash('unrelated-turn')
        if (invalid === 'route-mismatch') p.origin.routeId = hash('different-route')
        if (invalid === 'missing-route') p.origin.provider = null
      })
      assert.equal(f.engine.beginWork(), null)
      assert.equal(f.engine.store.read().requests.length, 0)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
}

for (const change of ['revoke', 'model-change']) {
  test(`recovered source still rejects a ${change} while the request is in flight`, () => {
    const f = oldRevision()
    try {
      const work = f.engine.beginWork()
      assert.equal(work?.kind, 'revise')
      f.engine.markDispatched(work.ticket)
      const before = f.engine.store.read().entries
      if (change === 'revoke') f.registered.delete('later-source')
      else f.engine.observeRoute({ sessionId: 'later-source', route: { provider: 'changed', model: 'changed' } })
      f.engine.finishWork({ ticket: work.ticket, result: revisedLesson(work),
        usage: { input: 10, output: 20, total: 30 } })
      assert.deepEqual(f.engine.store.read().entries, before)
      assert.equal(f.engine.store.read().requests.at(-1).settled, true)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
}

function auditDocument() {
  const doc = createDoc()
  doc.requests = Array.from({ length: 64 }, (_, i) => ({
    ticket: `audit-${i}`, kind: 'digest', at: i + 1, problemId: null, entryId: null,
    digestDay: '2026-11-14', requestHash: hash(`request-${i}`), dispatchHash: hash(`dispatch-${i}`),
    dispatchedAt: i + 1, settled: true, terminal: 'usage_unknown',
    usage: { input: null, output: null, cached: null, cacheWrite: null, reasoning: null, total: null, known: false },
    maxTokens: 2048, evidenceIds: [], tokenHashes: [], parentVersion: null,
    routeId: null, material: hash(`material-${i}`), retryOf: null, digestFacts: null,
    digestThrough: null, sourceSessionId: null, sourceRoute: null,
    digestExcluded: Array.from({ length: 128 }, (_, j) => `${i}-${j}-` + 'e'.repeat(230)),
  }))
  doc.materials = Array.from({ length: 63 }, (_, i) => ({ key: hash(`material-${i}`),
    terminal: 'usage_unknown', attempts: 1, autoRetriesUsed: 0, unknownCost: true,
    updatedAt: 1000, manualAllowed: false, autoRetryAllowed: false, ticket: null }))
  doc.turnFacts = Array.from({ length: 256 }, (_, i) => ({ id: hash(`turn-${i}`), turnKey: hash(`turn-${i}`),
    sessionId: `session-${i}`, day: '2026-11-14', at: 1000, taskSummary: '证'.repeat(200),
    outcome: 'unknown', evidenceBrief: '未知'.repeat(100), evidenceHash: hash(`evidence-${i}`),
    failures: 0, cancellations: 0 }))
  validateDoc(doc)
  return doc
}

test('large audit history is stored losslessly without deleting rows or widening the file limit', () => {
  const root = mkdtempSync(join(tmpdir(), 'mse-continuity-'))
  try {
    const doc = auditDocument()
    assert.ok(Buffer.byteLength(JSON.stringify(doc)) > MAX_STORE_BYTES)
    assert.ok(Buffer.byteLength(JSON.stringify(doc.requests)) < MAX_STORE_BYTES)
    const store = new MemoryStore({ stateRoot: root })
    store.transaction(current => { Object.assign(current, structuredClone(doc)) })
    const loaded = store.read()
    for (const key of Object.keys(doc).filter(k => k !== 'updatedAt')) assert.deepEqual(loaded[key], doc[key])
    assert.ok(statSync(store.path).size < MAX_STORE_BYTES)
    const bytes = readFileSync(store.path)
    store.transaction(() => noCommit(true))
    assert.deepEqual(readFileSync(store.path), bytes, 'a no-op does not repack or rewrite the snapshot')
    const exportPath = join(root, 'export.json')
    const copyPath = join(root, 'copy')
    for (const args of [['export', '--state-root', root, '--output', exportPath],
      ['recover-copy', '--input', exportPath, '--state-root', copyPath]]) {
      const call = spawnSync(process.execPath, ['scripts/mse-maintenance.mjs', ...args], { encoding: 'utf8' })
      assert.equal(call.status, 0, call.stderr + call.stdout)
    }
    assert.deepEqual(new MemoryStore({ stateRoot: copyPath }).read().requests, doc.requests)
    assert.deepEqual(new MemoryStore({ stateRoot: copyPath }).read().materials, doc.materials)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('packed audit corruption and over-declared expansion fail closed without replacing the file', () => {
  const root = mkdtempSync(join(tmpdir(), 'mse-packed-corrupt-'))
  const path = join(root, 'memory-v1.json')
  try {
    const request = auditDocument().requests[0]
    const bytes = Buffer.from(JSON.stringify(request))
    const packed = { ticket: request.ticket, auditEncoding: 'gzip-json-v1', auditBytes: bytes.length,
      auditData: gzipSync(bytes).toString('base64') }
    for (const bad of [{ ...packed, auditBytes: MAX_STORE_BYTES + 1 },
      { ...packed, ticket: 'wrong-ticket' }, { ...packed, auditBytes: bytes.length - 1 },
      { ...packed, auditData: packed.auditData.slice(0, -8) }]) {
      const doc = createDoc(); doc.requests = [bad]
      const original = JSON.stringify(doc); writeFileSync(path, original)
      assert.throws(() => new MemoryStore({ stateRoot: root }).transaction(() => true),
        error => error.code === 'invalid_memory')
      assert.equal(readFileSync(path, 'utf8'), original)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('expanded audit growth still has a hard limit and preserves the prior library on refusal', () => {
  const root = mkdtempSync(join(tmpdir(), 'mse-audit-bound-'))
  try {
    const store = new MemoryStore({ stateRoot: root })
    const doc = auditDocument()
    store.transaction(current => { Object.assign(current, structuredClone(doc)) })
    const before = readFileSync(store.path)
    assert.throws(() => store.transaction(current => {
      for (let i = 64; i < 80; i++) current.requests.push({ ...structuredClone(doc.requests[0]), ticket: `audit-${i}` })
    }), error => error.code === 'capacity')
    assert.deepEqual(readFileSync(store.path), before)
    assert.deepEqual(store.read().materials, doc.materials, 'unknown-cost replay holds remain intact')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
