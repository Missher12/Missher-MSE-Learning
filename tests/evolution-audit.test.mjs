import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LearningEngine, runEvaluation } from '../src/index.mjs'
import { getMethod, registeredTrials } from '../src/checks.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const methodId = 'numeric-sort-v1'
const descriptor = getMethod(methodId)
function setup(t, extra = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-evolution-audit-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const engine = new LearningEngine({ stateRoot, adapterId: 'audit', ...extra })
  return { engine, stateRoot }
}
const record = (engine, extra = {}) => engine.record({ eventId: 'registered', kind: 'method', source: 'host_proposal', methodId, ...extra })
const turn = (sessionId, extra = {}) => ({ sessionId, turnId: '1', origin: 'user', prompt: descriptor.instruction, ...extra })
const lesson = (engine, lessonId) => engine.list({ limit: 100 }).lessons.find(x => x.id === lessonId)
function validate(engine, lessonId, eventId) {
  return engine.evaluate({ lessonId, expectedVersion: lesson(engine, lessonId).version, eventId,
    suiteId: 'independent-audit-fixture-v1', trials: registeredTrials('preserve-null-v1') })
}

test('registered algorithms cannot acquire altered instructions, applicability or exclusions through record or import', t => {
  const { engine } = setup(t)
  for (const changed of [{ instruction: '任何任务都要执行金额升序排列' },
    { applicability: '任何任务都要执行金额升序排列' }, { exclusions: '所有数值都可以直接适用规则' }]) {
    assert.throws(() => record(engine, changed), /method_(instruction|conditions)_mismatch/)
  }
  assert.equal(engine.status().lessons, 0)
  const recorded = record(engine)
  assert.equal(engine.prepare(turn('candidate')).bytes, 0)
  assert.equal(engine.evaluateRegistered({ lessonId: recorded.id }).decision, 'accepted')
  const active = lesson(engine, recorded.id)
  assert.equal(active.instruction, descriptor.instruction)
  assert.equal(active.applicability, descriptor.applicability)
  assert.equal(active.exclusions, descriptor.exclusions)
  const exported = engine.exportLesson({ lessonId: recorded.id }).packet
  const changed = { schema: exported.schema, methodId: exported.methodId, instruction: exported.instruction,
    applicability: '任何任务都要执行金额升序排列', exclusions: exported.exclusions }
  const packet = { ...changed, checksum: hash(JSON.stringify(changed)) }
  assert.throws(() => engine.importLesson({ eventId: 'altered-packet', packet }), /method_conditions_mismatch/)
  assert.equal(engine.status().lessons, 1)
})

test('same-turn receipt cache respects environment changes and invalidates the prior environment receipt', t => {
  const { engine } = setup(t)
  const recorded = record(engine)
  engine.evaluateRegistered({ lessonId: recorded.id })
  const first = engine.prepare(turn('environment-switch'))
  assert.ok(first.bytes > 0)
  assert.equal(engine.prepare(turn('environment-switch')).receipt, first.receipt)
  const switched = engine.prepare(turn('environment-switch', { environmentId: 'different-toolchain' }))
  assert.equal(switched.bytes, 0)
  assert.equal(switched.receipt, null)
  assert.throws(() => engine.accept({ receipt: first.receipt, lessonIds: first.lessons }), /receipt_rejected/)
  assert.equal(engine.prepare(turn('fresh-other-environment', { environmentId: 'different-toolchain' })).bytes, 0)
  assert.ok(engine.prepare(turn('fresh-original-environment')).bytes > 0)
})

test('withdrawing a losing replacement candidate cannot revive the winner\'s predecessor', t => {
  const { engine } = setup(t)
  const predecessor = record(engine)
  engine.evaluateRegistered({ lessonId: predecessor.id })
  const loser = engine.record({ eventId: 'loser', kind: 'method', source: 'host_proposal', supersedes: predecessor.id,
    instruction: '处理报表导出时先检查金额精度再输出结果' })
  const winner = engine.record({ eventId: 'winner', kind: 'method', source: 'host_proposal', supersedes: predecessor.id,
    instruction: '处理报表导出时先检查金额类型再输出结果' })
  assert.equal(validate(engine, winner.id, 'winner-evaluation').decision, 'accepted')
  assert.equal(lesson(engine, predecessor.id).status, 'suspended')
  assert.equal(lesson(engine, predecessor.id).replacedBy, winner.id)
  const late = validate(engine, loser.id, 'late-loser-evaluation')
  assert.equal(late.decision, 'inconclusive')
  assert.ok(late.reasons.includes('replacement_changed'))
  assert.equal(engine.suspend({ lessonId: loser.id }).restored, null)
  assert.equal(lesson(engine, predecessor.id).status, 'suspended')
  assert.equal(lesson(engine, winner.id).status, 'validated')
  assert.equal(engine.status().counts.validated, 1)
  assert.equal(engine.rollback({ lessonId: winner.id }).restored, predecessor.id)
  assert.equal(lesson(engine, predecessor.id).status, 'validated')
  assert.equal(lesson(engine, predecessor.id).replacedBy, null)
  assert.equal(engine.status().counts.validated, 1)
})

test('old-version and wrong-checker observations cannot earn credit against a new accepted method version', t => {
  const { engine } = setup(t)
  const recorded = record(engine)
  engine.evaluateRegistered({ lessonId: recorded.id })
  const oldPrepared = engine.prepare(turn('old-pending'))
  const oldReport = engine.checkArtifact({ lessonId: recorded.id,
    source: [{ id: 'a', value: '2' }, { id: 'b', value: '1' }], artifact: [{ id: 'b', value: '1' }, { id: 'a', value: '2' }] })
  assert.equal(oldReport.status, 'pass')
  engine.suspend({ lessonId: recorded.id })
  engine.resume({ lessonId: recorded.id })
  engine.evaluateRegistered({ lessonId: recorded.id })
  const currentVersion = lesson(engine, recorded.id).version
  assert.ok(currentVersion > oldReport.version)
  assert.throws(() => engine.accept({ receipt: oldPrepared.receipt, lessonIds: oldPrepared.lessons }), /receipt_stale/)
  for (const [sessionId, version, checkId, expectedVerified] of [
    ['old-observation', oldReport.version, oldReport.checkId, 0],
    ['other-checker', currentVersion, 'source-dates-v1', 0],
    ['bound-observation', currentVersion, oldReport.checkId, 1],
  ]) {
    const input = turn(sessionId), prepared = engine.prepare(input)
    assert.deepEqual(prepared.lessons, [recorded.id])
    engine.accept({ receipt: prepared.receipt, lessonIds: prepared.lessons })
    engine.complete({ ...input, outcome: 'verified', evidence: { source: 'host_verifier', checkId,
      checks: [{ lessonId: recorded.id, version, checkId, passed: true }] } })
    assert.equal(lesson(engine, recorded.id).verified, expectedVerified)
  }
  assert.equal(lesson(engine, recorded.id).inconclusive, 2)
  assert.equal(lesson(engine, recorded.id).failed, 0)
  assert.equal(lesson(engine, recorded.id).status, 'validated')
})

test('schema-one migration preserves correction identity and session debit; repeated migration does not grow backups', t => {
  const { engine, stateRoot } = setup(t)
  const instruction = '以后导出金额前先转换为数值，再按金额排序'
  const recorded = engine.record({ eventId: 'legacy-correction', source: 'direct_user', kind: 'correction', instruction })
  const originalTurn = turn('legacy-session', { prompt: '导出金额并排序' })
  const offered = engine.prepare(originalTurn)
  assert.ok(offered.bytes > 0)
  const path = join(stateRoot, 'lessons-v1.json')
  const state = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(recorded.id, `lesson_${hash(JSON.stringify([state.lessons[0].scope, instruction, 'correction'])).slice(0, 24)}`)
  state.schema = 1
  delete state.jobs; delete state.experiments; delete state.spends
  for (const row of state.lessons) for (const key of ['methodId', 'applicability', 'exclusions', 'hypothesis', 'environment', 'replaces']) delete row[key]
  const legacy = JSON.stringify(state)
  writeFileSync(path, legacy, { mode: 0o600 })
  assert.equal(engine.status().migrationRequired, true)
  const migrated = engine.migrate()
  assert.equal(migrated.schema, 2)
  assert.equal(readFileSync(join(stateRoot, migrated.backup), 'utf8'), legacy)
  const backups = () => readdirSync(stateRoot).filter(name => name.startsWith('before-schema2-')).sort()
  assert.deepEqual(backups(), [migrated.backup])
  assert.equal(engine.migrate().alreadyCurrent, true)
  assert.equal(engine.migrate().alreadyCurrent, true)
  assert.deepEqual(backups(), [migrated.backup])
  assert.equal(readFileSync(join(stateRoot, migrated.backup), 'utf8'), legacy)
  const repeated = engine.record({ eventId: 'same-correction-after-migration', source: 'direct_user', kind: 'correction', instruction })
  assert.equal(repeated.id, recorded.id)
  assert.equal(engine.status().lessons, 1)
  assert.equal(engine.prepare({ ...originalTurn, turnId: '2' }).bytes, 0)
  const session = JSON.parse(readFileSync(join(stateRoot, 'sessions', `${hash(originalTurn.sessionId)}.json`), 'utf8'))
  assert.equal(session.bytes, offered.bytes)
  assert.deepEqual(session.offered, [`${recorded.id}:1`])
})

test('registered evidence provenance requires both a registered method and its exact fixed trials', t => {
  const { engine } = setup(t)
  const generic = engine.record({ eventId: 'generic', kind: 'method', source: 'host_proposal',
    instruction: '处理报表导出时先检查金额类型再输出结果' })
  assert.throws(() => engine.evaluate({ lessonId: generic.id, expectedVersion: 1, eventId: 'mislabelled',
    suiteId: 'arbitrary-suite', basis: 'registered_algorithm', trials: registeredTrials(methodId) }), /invalid_evaluation_basis/)
  assert.equal(lesson(engine, generic.id).status, 'candidate')
  const recorded = record(engine)
  const altered = registeredTrials(methodId)
  altered[0].caseId = 'caller-replaced-case'
  assert.throws(() => engine.evaluate({ lessonId: recorded.id, expectedVersion: 1, eventId: 'altered-fixed-suite',
    suiteId: 'arbitrary-suite', basis: 'registered_algorithm', trials: altered }), /invalid_evaluation_basis/)
  assert.equal(lesson(engine, recorded.id).status, 'candidate')
  assert.equal(engine.evaluateRegistered({ lessonId: recorded.id }).decision, 'accepted')
  assert.equal(lesson(engine, recorded.id).validation.basis, 'registered_algorithm')
})

function reflectRegistered(engine) {
  const request = engine.reflectionRequest({ sessionId: 'reflection', turnId: '1', outcome: 'verified',
    taskSummary: '将报表金额记录按数值升序排序', resultSummary: '完成了金额记录排序并通过顺序检查' })
  assert.ok(request.ticket)
  return engine.reflectionResult({ ticket: request.ticket, result: { instruction: descriptor.instruction, methodId } })
}

test('reflection promotion uses the same predecessor and competing-replacement rules as explicit evaluation', t => {
  for (const competing of [false, true]) {
    const { engine } = setup(t)
    const predecessor = record(engine, { methodId: 'copy-source-date-v1' })
    engine.evaluateRegistered({ lessonId: predecessor.id })
    const proposed = record(engine, { eventId: 'numeric-replacement', supersedes: predecessor.id })
    let winner
    if (competing) {
      winner = engine.record({ eventId: 'parallel-winner', kind: 'method', source: 'host_proposal',
        instruction: '处理报表导出时先检查金额类型再输出结果', supersedes: predecessor.id })
      assert.equal(validate(engine, winner.id, 'parallel-winner-evaluation').decision, 'accepted')
    }
    const reflected = reflectRegistered(engine)
    assert.equal(reflected.id, proposed.id)
    assert.equal(reflected.evaluation, competing ? 'inconclusive' : 'accepted')
    assert.equal(lesson(engine, proposed.id).status, competing ? 'candidate' : 'validated')
    assert.equal(lesson(engine, predecessor.id).status, 'suspended')
    assert.equal(lesson(engine, predecessor.id).replacedBy, competing ? winner.id : proposed.id)
    assert.equal(engine.status().counts.validated, 1)
    if (!competing) {
      assert.equal(engine.rollback({ lessonId: proposed.id }).restored, predecessor.id)
      assert.equal(lesson(engine, predecessor.id).status, 'validated')
    } else {
      assert.ok(engine.history({ lessonId: proposed.id }).experiments.at(-1).reasons.includes('replacement_changed'))
    }
  }
})

test('reflection cannot apply registered algorithm evidence to a generic method with identical instruction text', t => {
  const { engine } = setup(t)
  const generic = engine.record({ eventId: 'same-text-generic', kind: 'method', source: 'host_proposal',
    instruction: descriptor.instruction, applicability: '任何任务都要执行金额升序排列', exclusions: '所有数值都可以直接适用规则' })
  const reflected = reflectRegistered(engine)
  assert.notEqual(reflected.id, generic.id)
  assert.equal(reflected.evaluation, 'accepted')
  assert.equal(lesson(engine, generic.id).status, 'candidate')
  assert.equal(lesson(engine, generic.id).methodId, null)
  assert.equal(engine.history({ lessonId: generic.id }).experiments.length, 0)
  const registered = lesson(engine, reflected.id)
  assert.equal(registered.status, 'validated')
  assert.equal(registered.methodId, methodId)
  assert.equal(registered.applicability, descriptor.applicability)
  assert.equal(registered.exclusions, descriptor.exclusions)
  const prepared = engine.prepare(turn('after-reflection'))
  assert.deepEqual(prepared.lessons, [reflected.id])
  assert.ok(!prepared.context.includes('任何任务都要执行'))
})

test('paired runner evaluates the same instruction and applicability text later offered to the agent', async t => {
  const { engine } = setup(t, { evaluationTokensPerDay: 64 })
  const instruction = '处理报表导出时先检查金额类型再输出结果'
  const applicability = '仅适用于需要导出金额报表的任务'
  const exclusions = '排除没有金额字段的天气查询任务'
  const proposed = engine.record({ eventId: 'conditional-method', kind: 'method', source: 'host_proposal',
    instruction, applicability, exclusions })
  const cases = Array.from({ length: 16 }, (_, index) => ({ caseId: `case-${index}`, family: `family-${index % 2}`,
    split: index < 4 ? 'holdout' : 'development' }))
  const candidateTexts = [], baselineTexts = []
  const evaluation = await runEvaluation(engine, { lessonId: proposed.id, expectedVersion: 1,
    suiteId: 'conditional-method-suite', cases, maxTokens: 64 }, async ({ arm, instruction: evaluatedText }) => {
    ;(arm === 'candidate' ? candidateTexts : baselineTexts).push(evaluatedText)
    return { passed: arm === 'candidate', tokens: 1, guardPassed: true }
  })
  assert.equal(evaluation.decision, 'accepted')
  assert.equal(candidateTexts.length, cases.length)
  assert.ok(baselineTexts.every(text => text === null))
  const prepared = engine.prepare(turn('conditional-recall', { prompt: instruction }))
  assert.deepEqual(prepared.lessons, [proposed.id])
  const recalledText = prepared.context.split('\n- 已评测方法：')[1]
  assert.equal(recalledText, `${instruction}（适用：${applicability}；排除：${exclusions}）`)
  assert.ok(candidateTexts.every(text => text === recalledText))
})
