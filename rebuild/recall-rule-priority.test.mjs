import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RebuildEngine } from './engine.mjs'
import { loadDefaultCases } from '../scripts/rsi/replay.mjs'

test('engine prepare uses normalized relevance to rank saved user rules for the admitted turn', t => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-user-rule-priority-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const fixture = loadDefaultCases().find(row => row.id === 'rsi-02-indent-error-exact')
  const engine = new RebuildEngine({ stateRoot })
  const ids = new Map()
  for (const [index, entry] of fixture.entries.entries()) {
    const saved = engine.recordCorrection({ text: entry.instruction, sessionId: 'seed', turnId: String(index) })
    ids.set(entry.id, saved.id)
  }
  engine.store.transaction(doc => {
    for (const entry of fixture.entries) {
      const stored = doc.entries.find(row => row.id === ids.get(entry.id))
      stored.applicability = entry.applicability
      stored.exclusions = entry.exclusions
    }
    return true
  })
  engine.setSourceGuard(sessionId => sessionId === 'workspace-session')
  const prepared = engine.prepare({ sessionId: 'workspace-session', turnId: '1',
    prompt: fixture.prompt, strategyEligible: true })
  const offeredInstructions = prepared.offered.map(offer =>
    engine.store.read().entries.find(entry => entry.id === offer.id)?.instruction)
  assert.deepEqual(offeredInstructions, [
    '先统一两空格缩进并检查列表层级，再解析整份文件',
    '先检查列表层级和缩进宽度，再解析整份文件',
  ])
})
