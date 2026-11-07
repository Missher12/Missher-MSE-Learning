import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDoc, entryIdFor, MemoryStore } from './memory.mjs'

const temporaryRoot = () => mkdtempSync(join(tmpdir(), 'mse-maintenance-test-'))
const cliPath = new URL('../scripts/mse-maintenance.mjs', import.meta.url).pathname

function entry(label, { status = 'retired', type = 'lesson', version = 1 } = {}) {
  const instruction = `维护快照中的 ${label} 规则原文`
  const originScope = 'a'.repeat(64)
  return { id: entryIdFor(type, originScope, instruction), type, status, instruction,
    applicability: '维护命令测试', exclusions: '', visibility: 'global', originScope,
    originEnvironment: 'b'.repeat(64), originSession: 'maintenance-test', lesson: null,
    problemSignature: null, version, parentVersion: version > 1 ? version - 1 : null,
    superseded: null, injected: 0, recurrences: 0, createdAt: 10, updatedAt: 20,
    lastInjectedAt: null, evidenceHash: null, factDigest: null, digestDay: null, importedFrom: null }
}

function cli(...args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })
  let output
  try { output = JSON.parse(result.stdout) } catch { output = null }
  return { ...result, output }
}

function state(...args) { return ['--state-root', ...args] }

function seed(root, mutate) {
  const store = new MemoryStore({ stateRoot: root })
  const doc = createDoc()
  mutate(doc)
  store.transaction(current => {
    Object.assign(current, doc)
    return true
  })
  return store
}

function request(entryId) {
  return { ticket: 'ticket-maint-1', kind: 'revise', at: 1000, problemId: null, entryId,
    digestDay: null, requestHash: 'c'.repeat(64), dispatchHash: null, dispatchedAt: null,
    settled: false, terminal: null, usage: null, maxTokens: 2048, evidenceIds: [], tokenHashes: [],
    parentVersion: 1, routeId: null, material: 'd'.repeat(64), retryOf: null,
    digestFacts: null, digestThrough: null, sourceSessionId: null, sourceRoute: null }
}

function receipt(entryId) {
  return { id: 'e'.repeat(64), turnKey: 'f'.repeat(64), at: 1000, bytes: 40,
    offered: [{ id: entryId, version: 1 }], settled: false, outcome: null,
    evidenceHash: null, source: null }
}

test('inspect is read-only and reports validated counts, capacity, unsettled work, and archivable retired entries', t => {
  const parent = temporaryRoot()
  const root = join(parent, 'store')
  const retiredReady = entry('ready')
  const retiredBusy = entry('busy')
  const active = entry('active', { status: 'pending' })
  const store = seed(root, doc => {
    doc.entries.push(retiredReady, retiredBusy, active)
    doc.requests.push(request(retiredBusy.id))
    doc.receipts.push(receipt(retiredBusy.id))
  })
  const before = readFileSync(store.path)
  t.after(() => rmSync(parent, { recursive: true, force: true }))

  const result = cli('inspect', ...state(root))

  assert.equal(result.status, 0)
  assert.deepEqual(result.output.counts.entriesByType, { lesson: 3 })
  assert.equal(result.output.capacity.entries.used, 3)
  assert.equal(result.output.capacity.entries.limit, 256)
  assert.equal(result.output.capacity.bytes.used, before.length)
  assert.equal(result.output.unsettled.requests, 1)
  assert.equal(result.output.unsettled.receipts, 1)
  assert.equal(result.output.archivableRetiredCount, 0)
  assert.equal(result.output.archiveBlockedReasons.inFlightRequests, 1)
  assert.equal(result.output.archiveBlockedReasons.unsettledReceiptsReferencingRetired, 1)
  assert.deepEqual(readFileSync(store.path), before)
})

test('inspect distinguishes an empty initialized directory from a missing state path', t => {
  const parent = temporaryRoot()
  const missing = join(parent, 'missing')
  const empty = join(parent, 'empty')
  mkdirSync(empty, { mode: 0o700 })
  t.after(() => rmSync(parent, { recursive: true, force: true }))

  const missingResult = cli('inspect', ...state(missing))
  const emptyResult = cli('inspect', ...state(empty))

  assert.equal(missingResult.status, 1)
  assert.equal(missingResult.output?.code, 'state_unavailable')
  assert.equal(emptyResult.status, 0)
  assert.equal(emptyResult.output.storeExists, false)
  assert.equal(emptyResult.output.format, null)
  assert.equal(emptyResult.output.bytes, 0)
})

test('export writes the exact validated source bytes to a new private file without changing the source', t => {
  const parent = temporaryRoot()
  const root = join(parent, 'store')
  const output = join(parent, 'backup.json')
  const retired = entry('export', { version: 3 })
  const store = seed(root, doc => {
    doc.entries.push(retired)
    doc.controls.userPaused = true
    doc.futureExtension = { preserved: ['unknown', 'fields'] }
  })
  const before = readFileSync(store.path)
  t.after(() => rmSync(parent, { recursive: true, force: true }))

  const result = cli('export', ...state(root), '--output', output)

  assert.equal(result.status, 0)
  assert.equal(result.output.containsPrivateLearningData, true)
  assert.equal(result.output.bytes, before.length)
  assert.deepEqual(result.output.backup, { created: true, durable: true })
  assert.deepEqual(result.output.source, { committed: false, durable: null })
  assert.deepEqual(readFileSync(output), before)
  assert.deepEqual(readFileSync(store.path), before)
  assert.equal(statSync(output).mode & 0o777, 0o600)
  writeFileSync(output, 'sentinel')
  const refused = cli('export', ...state(root), '--output', output)
  assert.equal(refused.status, 1)
  assert.equal(readFileSync(output, 'utf8'), 'sentinel')
})

test('archive-retired snapshots under the writer transaction and removes only explicit unreferenced retired ids', t => {
  const parent = temporaryRoot()
  const root = join(parent, 'store')
  const output = join(parent, 'archive.json')
  const archived = entry('archive', { type: 'rule', version: 4 })
  const blockedByWork = entry('still referenced')
  const active = entry('active', { status: 'pending' })
  const store = seed(root, doc => {
    doc.entries.push(archived, blockedByWork, active)
    doc.receipts.push(receipt(blockedByWork.id))
    doc.futureExtension = { keep: true }
  })
  const before = readFileSync(store.path)
  const beforeDoc = store.read()
  t.after(() => rmSync(parent, { recursive: true, force: true }))

  const result = cli('archive-retired', ...state(root), '--output', output, '--id', archived.id)

  assert.equal(result.status, 0)
  assert.deepEqual(result.output.archivedIds, [archived.id])
  assert.equal(result.output.phase, 'complete')
  assert.deepEqual(result.output.backup, { created: true, durable: true })
  assert.deepEqual(result.output.source, { committed: true, durable: true })
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), JSON.parse(before))
  const after = store.read()
  assert.deepEqual(after.entries, [blockedByWork, active])
  for (const key of ['receipts', 'requests', 'turnFacts', 'materials', 'checkEvents',
    'methodHistory', 'recallStrategy', 'controls', 'digest', 'futureExtension']) {
    assert.deepEqual(after[key], beforeDoc[key], `preserved ${key}`)
  }
  assert.notDeepEqual(readFileSync(store.path), before)
})

test('archive-retired refuses duplicate, active, missing, and referenced ids before writing a backup', t => {
  const parent = temporaryRoot()
  const root = join(parent, 'store')
  const output = join(parent, 'archive.json')
  const retired = entry('referenced')
  const active = entry('active-target', { status: 'pending' })
  const store = seed(root, doc => {
    doc.entries.push(retired, active)
    doc.receipts.push(receipt(retired.id))
  })
  const before = readFileSync(store.path)
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const rejected = (...ids) => cli('archive-retired', ...state(root), '--output', output,
    ...ids.flatMap(id => ['--id', id]))

  for (const ids of [[retired.id, retired.id], [active.id], ['mem_' + '9'.repeat(24)], [retired.id]]) {
    const result = rejected(...ids)
    assert.equal(result.status, 1)
    assert.ok(result.output)
    assert.equal(result.output.ok, false)
    assert.equal(existsSync(output), false)
    assert.deepEqual(readFileSync(store.path), before)
  }
})

test('archive-retired refuses all targets while any request remains unsettled', t => {
  const parent = temporaryRoot()
  const root = join(parent, 'store')
  const output = join(parent, 'archive.json')
  const target = entry('unrelated-request-blocks-archive')
  const other = entry('unrelated-request-target', { status: 'pending' })
  const store = seed(root, doc => {
    doc.entries.push(target, other)
    doc.requests.push(request(other.id))
  })
  const before = readFileSync(store.path)
  t.after(() => rmSync(parent, { recursive: true, force: true }))

  const result = cli('archive-retired', ...state(root), '--output', output, '--id', target.id)

  assert.equal(result.status, 1)
  assert.equal(result.output.code, 'invalid_memory')
  assert.equal(result.output.phase, 'rejected')
  assert.equal(result.output.backup.created, false)
  assert.equal(result.output.source.committed, false)
  assert.equal(existsSync(output), false)
  assert.deepEqual(readFileSync(store.path), before)
})

test('archive backup failure leaves the original store bytes untouched', t => {
  const parent = temporaryRoot()
  const root = join(parent, 'store')
  const output = join(parent, 'already-exists.json')
  const target = entry('backup-failure')
  const store = seed(root, doc => { doc.entries.push(target) })
  const before = readFileSync(store.path)
  writeFileSync(output, 'keep')
  t.after(() => rmSync(parent, { recursive: true, force: true }))

  const result = cli('archive-retired', ...state(root), '--output', output, '--id', target.id)

  assert.equal(result.status, 1)
  assert.ok(result.output)
  assert.equal(result.output.ok, false)
  assert.equal(result.output.phase, 'backup_failed')
  assert.deepEqual(result.output.backup, { created: false, durable: null })
  assert.deepEqual(result.output.source, { committed: false, durable: null })
  assert.deepEqual(readFileSync(store.path), before)
  assert.equal(readFileSync(output, 'utf8'), 'keep')
})

test('recover-copy validates an export and preserves rules, versions, controls, and unknown top-level fields', t => {
  const parent = temporaryRoot()
  const root = join(parent, 'source')
  const destination = join(parent, 'restored')
  const rule = entry('recover-rule', { type: 'rule', status: 'user_rule', version: 7 })
  const store = seed(root, doc => {
    doc.entries.push(rule)
    doc.controls.userPaused = true
    doc.futureExtension = { revision: 12, nested: ['untouched'] }
  })
  const exportPath = join(parent, 'export.json')
  execFileSync(process.execPath, [cliPath, 'export', ...state(root), '--output', exportPath], { encoding: 'utf8' })
  const before = store.read()
  t.after(() => rmSync(parent, { recursive: true, force: true }))

  const result = cli('recover-copy', '--input', exportPath, '--state-root', destination)

  assert.equal(result.status, 0)
  assert.equal(result.output.phase, 'complete')
  assert.deepEqual(result.output.target, { committed: true, durable: true })
  const restored = new MemoryStore({ stateRoot: destination }).read()
  assert.deepEqual(restored.entries, before.entries)
  assert.equal(restored.entries[0].id, rule.id)
  assert.equal(restored.entries[0].version, 7)
  assert.equal(restored.controls.userPaused, true)
  assert.deepEqual(restored.futureExtension, before.futureExtension)
})

test('recover-copy refuses a nonempty target before changing its mode or contents', t => {
  const parent = temporaryRoot()
  const sourceRoot = join(parent, 'source')
  const destination = join(parent, 'nonempty')
  const exportPath = join(parent, 'export.json')
  const sourceEntry = entry('preflight-source')
  const source = seed(sourceRoot, doc => { doc.entries.push(sourceEntry) })
  execFileSync(process.execPath, [cliPath, 'export', ...state(sourceRoot), '--output', exportPath],
    { encoding: 'utf8' })
  mkdirSync(destination, { mode: 0o755 })
  chmodSync(destination, 0o755)
  const unrelated = join(destination, 'unrelated.txt')
  writeFileSync(unrelated, 'leave this alone')
  t.after(() => rmSync(parent, { recursive: true, force: true }))

  const result = cli('recover-copy', '--input', exportPath, '--state-root', destination)

  assert.equal(result.status, 1)
  assert.equal(result.output.code, 'invalid_store')
  assert.equal(result.output.phase, 'rejected')
  assert.equal(statSync(destination).mode & 0o777, 0o755)
  assert.equal(readFileSync(unrelated, 'utf8'), 'leave this alone')
  assert.equal(existsSync(join(destination, 'memory-v1.json')), false)
  assert.ok(source.read().entries.some(row => row.id === sourceEntry.id))
})

test('recover-copy accepts an existing empty directory and secures it before writing', t => {
  const parent = temporaryRoot()
  const sourceRoot = join(parent, 'source')
  const destination = join(parent, 'empty')
  const exportPath = join(parent, 'export.json')
  const sourceEntry = entry('empty-target-source')
  seed(sourceRoot, doc => { doc.entries.push(sourceEntry) })
  execFileSync(process.execPath, [cliPath, 'export', ...state(sourceRoot), '--output', exportPath],
    { encoding: 'utf8' })
  mkdirSync(destination, { mode: 0o755 })
  chmodSync(destination, 0o755)
  t.after(() => rmSync(parent, { recursive: true, force: true }))

  const result = cli('recover-copy', '--input', exportPath, '--state-root', destination)

  assert.equal(result.status, 0)
  assert.equal(statSync(destination).mode & 0o777, 0o700)
  assert.equal(new MemoryStore({ stateRoot: destination }).read().entries[0].id, sourceEntry.id)
})

test('recover-copy rejects invalid exports and existing stores without overwriting them', t => {
  const parent = temporaryRoot()
  const input = join(parent, 'bad.json')
  const target = entry('existing')
  const destination = join(parent, 'existing')
  const store = seed(destination, doc => { doc.entries.push(target) })
  const before = readFileSync(store.path)
  writeFileSync(input, '{broken')
  t.after(() => rmSync(parent, { recursive: true, force: true }))

  const invalid = cli('recover-copy', '--input', input, '--state-root', join(parent, 'not-created'))
  assert.equal(invalid.status, 1)
  assert.ok(invalid.output)
  assert.equal(invalid.output.ok, false)
  assert.equal(existsSync(join(parent, 'not-created')), false)
  const existing = cli('recover-copy', '--input', store.path, '--state-root', destination)
  assert.equal(existing.status, 1)
  assert.ok(existing.output)
  assert.equal(existing.output.ok, false)
  assert.deepEqual(readFileSync(store.path), before)
})
