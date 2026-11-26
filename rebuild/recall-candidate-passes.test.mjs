import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RebuildEngine } from './engine.mjs'
import { readV6RecallCandidates } from './storage-v6.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

test('readRecallView applies real archived-version extra IDs in one candidate load', t => {
  const root = mkdtempSync(join(tmpdir(), 'mse-recall-candidate-passes-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const engine = new RebuildEngine({ stateRoot: root })
  engine.recordCorrection({ text: '共享检索 zebra11 alpha21 保存配置前核对字段',
    sessionId: 'candidate-passes', turnId: '1' })
  engine.recordCorrection({ text: '共享检索 zebra11 beta22 保存配置后核对字段',
    sessionId: 'candidate-passes', turnId: '2' })
  engine.recordCorrection({ text: 'quasar37 unrelated maintenance cache path',
    sessionId: 'candidate-passes', turnId: '3' })
  const seeded = engine.store.read().entries
  const extra = seeded.find(row => row.instruction.includes('quasar37'))
  engine.store.transaction(doc => {
    const current = doc.entries.find(row => row.id === extra.id)
    current.version = 2
    current.parentVersion = 1
    doc.methodHistory.push({ entryId: extra.id, version: 1, instruction: extra.instruction,
      applicability: extra.applicability, exclusions: extra.exclusions, visibility: extra.visibility,
      lesson: null, originScope: extra.originScope, originEnvironment: extra.originEnvironment,
      originSession: extra.originSession, stats: null, status: 'legacy_partial',
      reason: 'legacy_superseded_partial', archivedAt: 1, evidenceHash: null })
    return true
  })
  const manifest = JSON.parse(readFileSync(engine.store.path, 'utf8'))
  const prompt = '共享检索 zebra11'
  const expected = readV6RecallCandidates(root, manifest, prompt, { extraIds: [extra.id] })
  assert.deepEqual(expected.map(row => row.id), [seeded[0].id, seeded[1].id, extra.id])

  const trackedIds = new Set(seeded.map(row => row.id))
  const originalClone = globalThis.structuredClone
  let entryCloneCount = 0
  let view
  globalThis.structuredClone = value => {
    if (value !== null && typeof value === 'object' && trackedIds.has(value.id)) entryCloneCount += 1
    return originalClone(value)
  }
  try { view = engine.store.readRecallView(prompt, [extra.id]) }
  finally { globalThis.structuredClone = originalClone }

  assert.deepEqual(view.entries, expected, 'recall order and the archived-version entry stay exact')
  assert.equal(entryCloneCount, expected.length,
    'each returned entry is copied and validated once during candidate lookup')
})
