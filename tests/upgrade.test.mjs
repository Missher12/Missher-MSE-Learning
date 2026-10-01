import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LearningEngine } from '../src/index.mjs'
import { createHarnessBridge } from '../adapters/harness.mjs'

/**
 * Upgrade tests run against stores produced by real older engines
 * (`scripts/make-legacy-fixtures.mjs`): 0.9.0-alpha.2 schema 2 for DSH/Hermes and the
 * daily-installed 0.8.0-alpha.4 schema 1. Fixtures are copied per test and never mutated.
 */
const fixtures = fileURLToPath(new URL('./fixtures', import.meta.url))
function copyFixture(t, name) {
  const root = mkdtempSync(join(tmpdir(), `mse-upgrade-${name}-`))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  cpSync(join(fixtures, name), root, { recursive: true })
  return root
}
// Only real ledger files count: an unpacked archive may legitimately carry extra
// members (AppleDouble `._*` copies, `.DS_Store`), which are not session budgets.
const LEDGER_FILE = /^[a-f0-9]{64}\.json$/u
const readSessions = root => readdirSync(join(root, 'sessions')).filter(file => LEDGER_FILE.test(file)).sort()
  .map(file => [file, readFileSync(join(root, 'sessions', file), 'utf8')])
const ledgerFiles = root => readdirSync(join(root, 'sessions')).filter(file => LEDGER_FILE.test(file)).sort()
const methodInstruction = engine => engine.list({ limit: 50 }).lessons
  .find(row => row.kind === 'method').instruction

test('a method validated by alpha.2 keeps recalling under the unchanged default environment', t => {
  for (const adapterId of ['dsh', 'hermes']) {
    const fixture = adapterId === 'dsh' ? 'legacy-alpha2-schema2' : 'legacy-alpha2-schema2-hermes'
    const root = copyFixture(t, fixture)
    const engine = new LearningEngine({ stateRoot: root, adapterId })
    assert.deepEqual(engine.status().counts.validated, 1, `${adapterId}: the legacy validated method is intact`)
    const instruction = methodInstruction(engine)
    // No environmentId anywhere: this is exactly the SDK default the adapters now use.
    const recalled = engine.prepare({ sessionId: `${adapterId}-new`, turnId: '1', prompt: instruction, origin: 'user' })
    assert.equal(recalled.reason, 'recalled', `${adapterId}: the legacy method must still recall`)
    assert.ok(recalled.bytes > 0)
    // A different environment is still refused: compatibility must not widen validation scope.
    const elsewhere = engine.prepare({ sessionId: `${adapterId}-other`, turnId: '1', prompt: instruction,
      origin: 'user', environmentId: 'some-other-toolchain' })
    assert.equal(elsewhere.bytes, 0)
    assert.notEqual(elsewhere.reason, 'recalled')
    assert.equal(elsewhere.diagnostics.otherEnvironment, 1, `${adapterId}: the method belongs to the original environment`)
    assert.equal(elsewhere.diagnostics.methodUnvalidated, 0)
    assert.equal(elsewhere.diagnostics.matched, 0, `${adapterId}: no lesson is served outside its environment`)
    assert.equal(elsewhere.diagnostics.candidates, 0)
  }
})

test('the DSH bridge default recalls a legacy store without any environment configuration', async t => {
  const root = copyFixture(t, 'legacy-alpha2-schema2')
  const engine = new LearningEngine({ stateRoot: root, adapterId: 'dsh' })
  let id = 0
  const bridge = createHarnessBridge({ engine,
    createMessage: text => ({ id: `m-${++id}`, role: 'user', source: { kind: 'plugin', plugin: 'mse-learning' }, content: [{ type: 'text', text }] }) })
  const session = { id: 'legacy-session', header: {}, events: [] }
  const message = { id: 'u-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: methodInstruction(engine) }] }
  const decision = await bridge.preStep({ agent: { session }, step: 1, turn: 1, messages: [message],
    signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [message] }))
  assert.equal(decision.messages.length, 2, 'the alpha.2 validated method is injected by default')
  assert.equal(bridge.lastRecall(session.id).reason, 'recalled')
  assert.ok(bridge.lastRecall(session.id).bytes > 0)
})

test('a daily schema-1 library needs an explicit migration that keeps a byte-exact backup and the session budget', t => {
  const root = copyFixture(t, 'legacy-daily-schema1')
  const statePath = join(root, 'lessons-v1.json')
  const originalBytes = readFileSync(statePath, 'utf8')
  const sessionsBefore = readSessions(root)
  const engine = new LearningEngine({ stateRoot: root, adapterId: 'dsh' })
  assert.equal(engine.status().schema, 1)
  assert.equal(engine.status().migrationRequired, true)
  assert.throws(() => engine.prepare({ sessionId: 'pre', turnId: '1', prompt: '导出报表金额并排序', origin: 'user' }),
    /migration_required/, 'schema 1 must not be used without an explicit migration')

  const migrated = engine.migrate({ fromSchema: 1 })
  assert.equal(migrated.ok, true)
  assert.equal(migrated.schema, 2)
  assert.ok(/^before-schema2-r\d+\.json$/u.test(migrated.backup))
  assert.equal(readFileSync(join(root, migrated.backup), 'utf8'), originalBytes,
    'the rollback snapshot must be the exact pre-migration bytes')
  const after = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(after.schema, 2)
  assert.equal(after.lessons.length, 2)
  assert.deepEqual(after.lessons.map(row => row.legacyStatus), ['reminder', 'candidate'])
  assert.equal(after.lessons.some(row => row.status === 'validated'), false,
    'a legacy method never becomes validated through migration')
  assert.deepEqual(readSessions(root), sessionsBefore, 'the migration must not disturb session budgets')
  assert.equal(migrated.sessionBudgetsPreserved, true)

  const recalled = engine.prepare({ sessionId: 'after-migrate', turnId: '1', prompt: '导出报表金额并排序', origin: 'user' })
  assert.equal(recalled.reason, 'recalled')
  assert.ok(recalled.bytes > 0, 'the migrated correction is recallable')

  // Rollback: the snapshot restores a schema-1 store that the same engine reads as pre-migration.
  const restored = copyFixture(t, 'legacy-daily-schema1')
  const rollbackEngine = new LearningEngine({ stateRoot: restored, adapterId: 'dsh' })
  assert.equal(JSON.parse(readFileSync(join(root, migrated.backup), 'utf8')).schema, 1)
  assert.equal(rollbackEngine.status().schema, 1)
  assert.equal(rollbackEngine.status().counts.candidate, 1)
  assert.throws(() => rollbackEngine.migrate({ fromSchema: 2 }), /unsupported_migration/)
})

test('a migrated legacy session keeps accounting for its already offered lesson', t => {
  const root = copyFixture(t, 'legacy-daily-schema1')
  const engine = new LearningEngine({ stateRoot: root, adapterId: 'dsh' })
  engine.migrate({ fromSchema: 1 })
  const ledger = readSessions(root)[0][1]
  const record = JSON.parse(ledger)
  assert.equal(ledgerFiles(root).length, 1)
  assert.equal(record.bytes, 127, 'the pre-migration session debit survives')
  assert.equal(record.offered.length, 1)
  const sessionId = 'legacy-daily-session'
  const again = engine.prepare({ sessionId, turnId: '2', prompt: '导出报表金额并排序', origin: 'user' })
  assert.equal(again.bytes, 0, 'the same session does not re-offer the version it already received')
  assert.equal(again.reason, 'already_offered')
  const diagnosis = engine.diagnose({ sessionId, prompt: '导出报表金额并排序' })
  assert.equal(diagnosis.session.bytes, 127)
  assert.equal(diagnosis.session.remainingBytes, 1536 - 127)
})

test('migration stays explicit for the trusted CLI surface too', t => {
  const root = copyFixture(t, 'legacy-daily-schema1')
  const engine = new LearningEngine({ stateRoot: root, adapterId: 'dsh' })
  assert.throws(() => engine.list({}), /migration_required/)
  engine.migrate({ fromSchema: 1 })
  assert.equal(engine.list({}).lessons.length, 2)
})
