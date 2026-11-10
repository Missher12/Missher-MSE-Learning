import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { buildEngine, trainApiPolicy } from '../scripts/rsi/adaptive-engine-fixture.mjs'

const COMMAND = 'pytest -q --color=no tests/test_sample.py'
const SUMMARY = { kind: 'pytest', tests: 1, passed: 1, failed: 0, errors: 0,
  skipped: 0, xfailed: 0, xpassed: 0, deselected: 0 }

test('pytest evidence binds a direct offered command and stores counts only', () => {
  const { root, engine, targetX, fail, prepare, settle } = buildEngine()
  try {
    engine.store.transaction(doc => {
      doc.entries.find(row => row.id === targetX.id).lesson.verification.check = COMMAND
      return true
    })
    trainApiPolicy({ engine, fail, prepare, settle })
    const turn = prepare('seed-x', 'pytest-turn', 'API 调用返回意外状态，请分析原因')
    assert.ok(turn.offered.some(row => row.id === targetX.id && row.version === 1))
    assert.deepEqual(engine.developmentRelevantOffers({ sessionId: 'seed-x', turnId: 'pytest-turn',
      command: COMMAND }), [{ id: targetX.id, version: 1 }])
    assert.deepEqual(engine.developmentRelevantOffers({ sessionId: 'seed-x', turnId: 'pytest-turn',
      command: 'pytest -q tests/test_other.py' }), [])

    const invalid = { ...SUMMARY, skipped: 1 }
    assert.throws(() => engine.recordCheck({ checkId: 'pytest-summary-v1', passed: true,
      summary: invalid, sessionId: 'seed-x', turnId: 'pytest-turn', entryId: targetX.id,
      entryVersion: 1, eventId: 'pytest-invalid', sourceRequired: true }),
    error => error.code === 'invalid_check_summary')

    const recorded = engine.recordCheck({ checkId: 'pytest-summary-v1', passed: true,
      summary: SUMMARY, evidence: SUMMARY, sessionId: 'seed-x', turnId: 'pytest-turn',
      entryId: targetX.id, entryVersion: 1, eventId: 'pytest-pass', sourceRequired: true })
    assert.equal(recorded.settled, true)
    const row = engine.store.read().checkEvents.at(-1)
    assert.equal(row.checkId, 'pytest-summary-v1')
    assert.deepEqual(row.summary, SUMMARY)
    assert.equal(JSON.stringify(row).includes('tests/test_sample.py'), false)
    assert.equal(JSON.stringify(row).includes('passed in'), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
