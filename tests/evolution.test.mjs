import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { LearningEngine, reflect, runEvaluation, guardedAction, getMethod } from '../src/index.mjs'

function setup(t, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mse-evolution-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const options = { stateRoot: root, adapterId: 'generic', ...config }
  return { engine: new LearningEngine(options), root, options }
}
const proposal = { eventId: 'proposal', source: 'host_proposal', kind: 'method', instruction: '导出金额前核对数值类型，再执行金额排序并核查结果' }
const task = (sessionId = 'next') => ({ sessionId, turnId: '1', origin: 'user', prompt: '导出金额并检查数值排序结果' })
const trials = () => Array.from({ length: 16 }, (_, i) => ({ caseId: `c${i}`, family: `family${i % 3}`,
  split: i % 2 ? 'holdout' : 'development', baseline: { passed: i >= 8, tokens: 100 },
  candidate: { passed: true, tokens: 100 }, guardPassed: true }))
function evaluate(engine, lessonId, changes = {}) {
  return engine.evaluate({ lessonId, expectedVersion: engine.list().lessons.find(x => x.id === lessonId).version,
    eventId: 'eval', suiteId: 'isolated-suite-v1', trials: trials(), ...changes })
}

test('paired evaluation promotes a method, survives restart and retains context limits', t => {
  const { engine, options, root } = setup(t)
  const learned = engine.record(proposal)
  assert.equal(engine.prepare(task()).bytes, 0)
  assert.equal(evaluate(engine, learned.id).decision, 'accepted')
  const resumed = new LearningEngine(options), p = resumed.prepare(task('fresh'))
  assert.match(p.context, /已评测方法/)
  assert.ok(p.bytes <= 768 && p.lessons.length === 1)
  resumed.accept({ receipt: p.receipt, lessonIds: p.lessons })
  resumed.complete({ ...task('fresh'), outcome: 'failed' })
  assert.equal(resumed.status().failed, 0, 'ordinary errors are not evidence against a method')
  assert.equal(resumed.status().counts.validated, 1)
  const text = readFileSync(join(root, 'lessons-v1.json'), 'utf8')
  assert.ok(!text.includes('family0'), 'individual trial data is not persisted')
  assert.equal(resumed.history({ lessonId: learned.id }).experiments[0].basis, 'host_trial')
})

test('evaluation is idempotent and conflicts or stale revisions cannot overwrite evidence', t => {
  const { engine } = setup(t), learned = engine.record(proposal)
  const input = { lessonId: learned.id, expectedVersion: 1, eventId: 'job', suiteId: 'suite', trials: trials() }
  engine.evaluate(input)
  assert.equal(engine.evaluate(input).duplicate, true)
  assert.throws(() => engine.evaluate({ ...input, suiteId: 'different' }), /event_conflict/)
  assert.throws(() => engine.evaluate({ ...input, eventId: 'stale' }), /stale_version/)
})

test('unknown evaluation cost does not promote; raw cost failures do not falsify a method', t => {
  const { engine } = setup(t), learned = engine.record(proposal)
  const unknown = trials(); unknown[0].candidate.tokens = null
  assert.equal(evaluate(engine, learned.id, { trials: unknown }).decision, 'inconclusive')
  assert.equal(engine.status().counts.candidate, 1)
  const costly = trials().map(x => ({ ...x, candidate: { ...x.candidate, tokens: 1000 } }))
  assert.equal(evaluate(engine, learned.id, { eventId: 'cost', trials: costly }).decision, 'rejected')
  assert.equal(engine.status().counts.suspended, 0)
})

test('measured regression suspends a method and blocks the same hypothesis in that environment', t => {
  const { engine } = setup(t)
  const learned = engine.record({ ...proposal, hypothesisId: 'numeric-order' })
  const bad = trials(); bad[15].candidate.passed = false
  assert.equal(evaluate(engine, learned.id, { trials: bad }).decision, 'rejected')
  assert.equal(engine.record({ ...proposal, eventId: 'again', hypothesisId: 'numeric-order', instruction: '处理导出金额时先核对数值，再检查金额排序结果' }).skipped, 'refuted_hypothesis')
  assert.ok(engine.record({ ...proposal, eventId: 'new-environment', hypothesisId: 'numeric-order', environmentId: 'tools-v2' }).id)
  assert.equal(engine.prepare(task()).bytes, 0)
})

test('a verified regression withdraws only the bound lesson; user corrections remain active', t => {
  const { engine } = setup(t), learned = engine.record(proposal)
  evaluate(engine, learned.id)
  engine.record({ eventId: 'correction', source: 'direct_user', kind: 'correction', instruction: '以后导出金额先检查数值精度，再核查金额排序结果' })
  const p = engine.prepare(task())
  assert.equal(p.lessons.length, 2)
  engine.accept({ receipt: p.receipt, lessonIds: p.lessons })
  const selected = p.lessonVersions.find(x => x.id === learned.id)
  engine.complete({ ...task(), outcome: 'failed', evidence: { source: 'host_verifier', checkId: 'numeric-check',
    checks: [{ lessonId: learned.id, version: selected.version, checkId: 'numeric-check', passed: false }] } })
  assert.equal(engine.status().failed, 1)
  assert.equal(engine.status().counts.suspended, 1)
  assert.equal(engine.status().counts.reminder, 1)
  assert.equal(engine.status().inconclusive, 1)
})

test('registered methods can be checked without storing or returning source records', t => {
  const { engine, root } = setup(t)
  const learned = engine.record({ eventId: 'date', source: 'host_proposal', kind: 'method', methodId: 'copy-source-date-v1' })
  assert.equal(engine.evaluateRegistered({ lessonId: learned.id }).decision, 'accepted')
  const report = engine.checkArtifact({ lessonId: learned.id, source: [{ id: 'private-id', value: '2024-02-29' }],
    artifact: [{ id: 'private-id', value: '2024-03-01' }] })
  assert.equal(report.status, 'fail')
  assert.equal(report.violations, 1)
  assert.ok(!JSON.stringify(report).includes('private-id'))
  assert.ok(!readFileSync(join(root, 'lessons-v1.json'), 'utf8').includes('2024-02-29'))
  assert.equal(engine.status().failed, 0, 'checking an artifact alone never attributes an outcome')
})

test('portable methods do not transfer host state or verification credit', t => {
  const a = setup(t), b = setup(t, { adapterId: 'hermes' })
  const learned = a.engine.record({ ...proposal, methodId: 'numeric-sort-v1', instruction: undefined })
  a.engine.evaluateRegistered({ lessonId: learned.id })
  const { packet } = a.engine.exportLesson({ lessonId: learned.id })
  assert.ok(!JSON.stringify(packet).includes('validated'))
  const received = b.engine.importLesson({ eventId: 'import', packet })
  assert.equal(received.status, 'candidate')
  assert.equal(b.engine.status().verified, 0)
  assert.throws(() => b.engine.importLesson({ eventId: 'bad', packet: { ...packet, instruction: '任意更改内容' } }), /invalid_packet/)
  assert.equal(b.engine.evaluateRegistered({ lessonId: received.id }).decision, 'accepted')
})

test('explicit schema migration preserves old bytes, counts and conversation debits', t => {
  const { engine, root, options } = setup(t)
  engine.record({ ...proposal, source: 'direct_user', kind: 'correction' })
  const p = engine.prepare(task())
  const path = join(root, 'lessons-v1.json'), legacy = JSON.parse(readFileSync(path, 'utf8'))
  legacy.schema = 1; delete legacy.experiments; delete legacy.jobs; delete legacy.spends
  for (const lesson of legacy.lessons) for (const key of ['hypothesis', 'environment', 'methodId', 'applicability', 'exclusions', 'replaces']) delete lesson[key]
  const original = JSON.stringify(legacy)
  writeFileSync(path, original)
  const reopened = new LearningEngine(options)
  assert.equal(reopened.status().migrationRequired, true)
  assert.throws(() => reopened.prepare(task('blocked')), /migration_required/)
  const migrated = reopened.migrate()
  assert.equal(readFileSync(join(root, migrated.backup), 'utf8'), original)
  assert.equal(reopened.status().migrationRequired, false)
  assert.equal(reopened.prepare(task()).bytes, 0, 'already offered correction stays deduplicated')
  assert.throws(() => reopened.accept({ receipt: p.receipt, lessonIds: p.lessons }), /receipt_rejected/)
})

test('a pre-aborted reflection does not spend a request or mint a ticket', async t => {
  const { engine } = setup(t), controller = new AbortController(); controller.abort()
  let calls = 0
  const result = await reflect(engine, {}, () => { calls++ }, controller.signal)
  assert.equal(result.code, 'cancelled'); assert.equal(calls, 0)
  assert.equal(engine.status().reflectionsLast24h, 0)
})

test('canonical reflection can automatically run algorithm regression while generic advice stays offline', async t => {
  const { engine } = setup(t)
  const result = await reflect(engine, { sessionId: 'reflection', turnId: '1', outcome: 'failed',
    taskSummary: '保留来源记录中未知字段的空值', resultSummary: '检查发现原来未知字段被错误填写为零' },
  async () => JSON.stringify({ instruction: '保留来源空值', methodId: 'preserve-null-v1' }))
  assert.equal(result.evaluation, 'accepted')
  assert.equal(result.status, 'validated')
  assert.equal(engine.status().counts.validated, 1)
  assert.equal(engine.status().verified, 0)
  const [lesson] = engine.list().lessons
  assert.equal(result.version, lesson.version)
  assert.equal(lesson.instruction, getMethod('preserve-null-v1').instruction)
  assert.equal(lesson.validation.basis, 'registered_algorithm')
})

test('paired runner uses a separate prepaid budget and disabled budget makes zero calls', async t => {
  const { engine } = setup(t), learned = engine.record(proposal)
  let calls = 0
  const spec = { lessonId: learned.id, expectedVersion: 1, suiteId: 'runner-suite', cases: trials(), maxTokens: 4000 }
  assert.equal((await runEvaluation(engine, spec, () => { calls++ })).skipped, 'evaluation_budget')
  assert.equal(calls, 0)
  const enabled = setup(t, { evaluationTokensPerDay: 5000 }), target = enabled.engine.record(proposal)
  const result = await runEvaluation(enabled.engine, { ...spec, lessonId: target.id }, async ({ arm, sample }) => {
    calls++; return { ...sample[arm], guardPassed: true }
  })
  assert.equal(result.decision, 'accepted'); assert.equal(calls, 32)
  assert.equal(enabled.engine.status().evaluationTokensReserved24h, 4000)
  assert.equal(enabled.engine.status().reflectionsLast24h, 0)
})

test('cancelling a runner releases its job but does not refund budget or promote late output', async t => {
  const { engine } = setup(t, { evaluationTokensPerDay: 5000 }), learned = engine.record(proposal)
  const controller = new AbortController()
  const result = await runEvaluation(engine, { lessonId: learned.id, expectedVersion: 1,
    suiteId: 'runner-suite', cases: trials(), maxTokens: 4000 }, async () => {
    controller.abort(); return { passed: true, tokens: 10, guardPassed: true }
  }, controller.signal)
  assert.equal(result.ok, false)
  assert.equal(engine.status().counts.candidate, 1)
  assert.equal(engine.store.read().jobs.length, 0)
  assert.equal(engine.status().evaluationTokensReserved24h, 4000)
})

test('CLI supports full registered learning cycle in a separate process', t => {
  const { options } = setup(t)
  const call = (op, input = {}) => {
    const result = spawnSync(process.execPath, ['src/cli.mjs'], { input: JSON.stringify({ config: options, op, input }), encoding: 'utf8' })
    assert.equal(result.status, 0, result.stdout)
    return JSON.parse(result.stdout)
  }
  const learned = call('record', { eventId: 'cli', source: 'host_proposal', kind: 'method', methodId: 'preserve-null-v1' })
  assert.equal(call('evaluateRegistered', { lessonId: learned.id }).decision, 'accepted')
  assert.equal(call('list').lessons[0].status, 'validated')
  assert.equal(call('exportLesson', { lessonId: learned.id }).packet.schema, 'mse-method-v1')
  assert.equal(call('suspend', { lessonId: learned.id }).status, 'suspended')
  assert.equal(call('resume', { lessonId: learned.id }).status, 'candidate')
})

test('execution gate blocks a known violation and allows only a checked bounded repair', async t => {
  const { engine } = setup(t)
  const learned = engine.record({ eventId: 'guard', source: 'host_proposal', kind: 'method', methodId: 'preserve-null-v1' })
  engine.evaluateRegistered({ lessonId: learned.id })
  const source = [{ id: 'a', value: null }, { id: 'b', value: 9 }]
  const artifact = [{ id: 'a', value: 0 }, { id: 'b', value: 9 }]
  let writes = 0
  const input = { lessonId: learned.id, source, artifact }
  const blocked = await guardedAction(engine, input, () => { writes++ })
  assert.equal(blocked.executed, false); assert.equal(writes, 0)
  const result = await guardedAction(engine, { ...input, repair: true }, rows => {
    writes++; assert.deepEqual(rows, source); return 'host-write-receipt'
  })
  assert.equal(result.executed, true); assert.equal(result.repaired, true)
  assert.equal(writes, 1); assert.equal(result.output, 'host-write-receipt')
  assert.equal(artifact[0].value, 0, 'source input objects are never mutated')
  assert.equal(engine.status().verified, 0, 'execution callback alone cannot grant online credit')
  const c = new AbortController(); c.abort()
  assert.equal((await guardedAction(engine, { ...input, signal: c.signal }, () => { writes++ })).executed, false)
  assert.equal(writes, 1)
})
