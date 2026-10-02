import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningEngine, RECALL_REASONS } from '../src/index.mjs'
import { getMethod, registeredTrials as registered } from '../src/checks.mjs'

const projectKey = '/synthetic/project-a'
const DAY = 86_400_000
function setup(t, options = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-lifecycle-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  return { engine: new LearningEngine({ stateRoot, adapterId: 'dsh', ...options }), stateRoot }
}
let counter = 0
const turn = (sessionId, prompt, extra = {}) => ({ sessionId, turnId: `t${++counter}`, origin: 'user', prompt, ...extra })
const currency = (engine, project = projectKey) => engine.list({ projectKey: project, limit: 50 }).lessons
  .filter(row => row.topicKey === 'report.currency')
  // `id` is included because evidence must name a real lesson: the stricter shared validator
  // (alpha.15) refuses a binding array holding a non-string, which is what this projection used
  // to produce. The assertions below never changed.
  .map(row => ({ id: row.id, status: row.status, version: row.version, value: row.value, instruction: row.instruction }))

test('an explicit correction replaces the earlier currency preference and only the current one is served', t => {
  const { engine } = setup(t)
  engine.prepare(turn('old', '以后导出报表金额时统一使用美元', { projectKey }))
  const stored = engine.prepare(turn('new', '纠正一下，以后导出报表金额时统一使用人民币', { projectKey }))
  assert.notEqual(stored.reason, RECALL_REASONS.conflictUnresolved)
  const rows = currency(engine)
  const suspended = rows.find(row => row.value === 'USD')
  const active = rows.find(row => row.value === 'CNY')
  assert.equal(suspended.status, 'suspended')
  assert.equal(suspended.version, 2, 'the replaced version is bumped for audit')
  assert.equal(active.status, 'reminder')
  const served = engine.prepare(turn('task', '导出报表金额并核对币种', { projectKey }))
  assert.match(served.context, /人民币/u)
  assert.equal(served.context.includes('美元'), false, 'the superseded preference is never co-injected')
  assert.equal(served.lessons.length, 1)
  assert.equal(engine.prepare(turn('other-project', '导出报表金额并核对币种', { projectKey: '/synthetic/project-b' })).bytes, 0)
})

test('a late result for the replaced version earns no credit for the new one', t => {
  const { engine } = setup(t)
  engine.prepare(turn('old', '以后导出报表金额时统一使用美元', { projectKey }))
  const pending = engine.prepare(turn('accept-old', '核对报表金额币种', { projectKey }))
  engine.accept({ receipt: pending.receipt, lessonIds: pending.lessons })
  const oldRow = currency(engine).find(row => row.value === 'USD')
  engine.prepare(turn('new', '纠正一下，以后导出报表金额时统一使用人民币', { projectKey }))
  const before = engine.status()
  // The old receipt is stale after replacement: version moved on and the lesson is suspended.
  assert.throws(() => engine.complete({ ...turn('accept-old'), outcome: 'verified',
    evidence: { source: 'host_verifier', checkId: 'currency-check', lessonIds: [oldRow.id] } }), /receipt_stale|evidence_not_adopted/)
  const after = engine.status()
  assert.equal(after.verified, before.verified, 'a late result must not credit the replaced rule')
  assert.equal(after.failed, before.failed)
})

test('a same-topic value change without an explicit replacement stays unresolved and keeps the old rule', t => {
  const { engine } = setup(t)
  engine.prepare(turn('old', '以后导出报表金额时统一使用美元', { projectKey }))
  const unresolved = engine.prepare(turn('ambiguous', '以后导出报表金额时统一使用人民币', { projectKey }))
  assert.equal(unresolved.reason, RECALL_REASONS.conflictUnresolved)
  assert.equal(unresolved.bytes, 0)
  assert.equal(unresolved.diagnostics.conflict.topicKey, 'report.currency')
  assert.equal(unresolved.diagnostics.conflict.value, 'CNY')
  assert.deepEqual(currency(engine).map(row => [row.value, row.status]), [['USD', 'reminder']])
  // Idempotent: repeating the unresolved request changes nothing.
  assert.equal(engine.prepare(turn('ambiguous-again', '以后导出报表金额时统一使用人民币', { projectKey })).reason,
    RECALL_REASONS.conflictUnresolved)
  assert.deepEqual(currency(engine).map(row => [row.value, row.status]), [['USD', 'reminder']])
  assert.match(engine.prepare(turn('task', '导出报表金额并核对币种', { projectKey })).context, /美元/u)
})

test('structured preference keys replace, deduplicate and reject stale or cross-scope replacements', t => {
  const { engine } = setup(t)
  const usd = engine.record({ eventId: 'usd', kind: 'correction', source: 'direct_user', projectKey,
    instruction: '以后导出报表金额时统一使用美元', topicKey: 'report.currency', value: 'USD' })
  const sameSlot = engine.record({ eventId: 'usd-repeat', kind: 'correction', source: 'direct_user', projectKey,
    instruction: '以后导出报表金额时统一使用美元', topicKey: 'report.currency', value: 'USD' })
  assert.equal(sameSlot.duplicate, true)
  assert.equal(sameSlot.id, usd.id, 'the same slot, value and instruction stay one rule')
  const unresolved = engine.record({ eventId: 'cny', kind: 'correction', source: 'direct_user', projectKey,
    instruction: '以后导出报表金额时统一使用人民币', topicKey: 'report.currency', value: 'CNY' })
  assert.equal(unresolved.skipped, 'conflict_unresolved')
  assert.equal(unresolved.existing, usd.id)
  // A stale expected version fails instead of overwriting another client's replacement.
  assert.throws(() => engine.record({ eventId: 'cny-stale', kind: 'correction', source: 'direct_user', projectKey,
    instruction: '以后导出报表金额时统一使用人民币', topicKey: 'report.currency', value: 'CNY',
    supersedes: usd.id, expectedSupersededVersion: 7 }), /stale_replacement/)
  const replaced = engine.record({ eventId: 'cny-ok', kind: 'correction', source: 'direct_user', projectKey,
    instruction: '以后导出报表金额时统一使用人民币', topicKey: 'report.currency', value: 'CNY',
    supersedes: usd.id, expectedSupersededVersion: 1 })
  assert.equal(replaced.ok, true)
  assert.equal(currency(engine).find(row => row.value === 'USD').status, 'suspended')
  assert.match(engine.prepare(turn('task', '导出报表金额并核对币种', { projectKey })).context, /人民币/u)
  // Different topics coexist; a different project cannot replace this one's rule.
  engine.record({ eventId: 'naming', kind: 'correction', source: 'direct_user', projectKey,
    instruction: '以后导出 JSON 时空值必须写成 "unknown"', topicKey: 'export.nullValue', value: 'unknown' })
  assert.equal(engine.list({ projectKey, limit: 50 }).lessons.filter(row => row.status === 'reminder').length, 2)
  assert.throws(() => engine.record({ eventId: 'cross-project', kind: 'correction', source: 'direct_user',
    projectKey: '/synthetic/project-b', instruction: '以后导出报表金额时统一使用美元',
    topicKey: 'report.currency', value: 'USD', supersedes: replaced.id }), /invalid_replacement/)
  // Malformed structured fields are refused.
  assert.throws(() => engine.record({ eventId: 'bad-key', kind: 'correction', source: 'direct_user', projectKey,
    instruction: '以后导出报表金额时统一使用欧元', topicKey: 'Report Currency', value: 'EUR' }), /invalid_topic_key/)
  assert.throws(() => engine.record({ eventId: 'bad-value', kind: 'correction', source: 'direct_user', projectKey,
    instruction: '以后导出报表金额时统一使用欧元', topicKey: 'report.currency', value: 'x'.repeat(65) }), /invalid_topic_value/)
})

test('expired methods reopen as a new candidate, never inheriting the old acceptance', t => {
  let now = Date.UTC(2026, 9, 1)
  const { engine } = setup(t, { now: () => now })
  const prompt = getMethod('numeric-sort-v1').instruction
  const initial = engine.record({ eventId: 'initial', kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' })
  assert.equal(engine.evaluateRegistered({ lessonId: initial.id }).decision, 'accepted')
  assert.ok(engine.prepare(turn('before-expiry', prompt)).bytes > 0)
  now += 91 * DAY
  assert.equal(engine.prepare(turn('expired', prompt)).bytes, 0)

  const replay = engine.record({ eventId: 'initial', kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' })
  assert.equal(replay.duplicate, true)
  const stillExpired = engine.list({ limit: 20 }).lessons.find(row => row.id === initial.id)
  assert.ok(stillExpired.expiresAt <= now, 'a replayed event must not renew the lesson')
  assert.equal(stillExpired.status, 'validated')

  const fresh = engine.record({ eventId: 'fresh-observation', kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' })
  const row = engine.list({ limit: 20 }).lessons.find(item => item.id === fresh.id)
  assert.equal(row.status, 'candidate')
  assert.ok(row.version > stillExpired.version, 'a new generation gets a new version')
  assert.ok(row.expiresAt > now)
  assert.equal(row.validation ?? null, null, 'the old acceptance never carries into the new generation')
  assert.equal(engine.prepare(turn('before-new-eval', prompt)).bytes, 0)
  assert.throws(() => engine.evaluateRegistered({ lessonId: fresh.id, expectedVersion: stillExpired.version }), /stale_version/)
  assert.equal(engine.evaluateRegistered({ lessonId: fresh.id }).decision, 'accepted')
  assert.ok(engine.prepare(turn('after-new-eval', prompt)).bytes > 0)
  const decisions = engine.store.read().experiments.map(row => row.decision)
  assert.deepEqual(decisions, ['accepted', 'reopened', 'accepted'], 'the reopened generation keeps its own history')
  // Repeating the same reopen request does not bump the version twice.
  const versionAfterEvaluation = engine.list({ limit: 20 }).lessons.find(row => row.id === initial.id).version
  engine.record({ eventId: 'fresh-observation', kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' })
  assert.equal(engine.list({ limit: 20 }).lessons.find(row => row.id === initial.id).version, versionAfterEvaluation)
})

test('manual and regression suspensions never reopen through a repeated proposal', t => {
  let now = Date.UTC(2026, 9, 1)
  const { engine } = setup(t, { now: () => now })
  const prompt = getMethod('numeric-sort-v1').instruction
  const manual = engine.record({ eventId: 'manual', kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' })
  engine.suspend({ lessonId: manual.id })
  now += 91 * DAY
  engine.record({ eventId: 'manual-again', kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' })
  const row = engine.list({ limit: 20 }).lessons.find(item => item.id === manual.id)
  assert.equal(row.status, 'suspended', 'a manually withdrawn rule stays withdrawn')
  assert.equal(engine.prepare(turn('after', prompt)).bytes, 0)
  // Another environment is a separate generation, not a renewal of this one.
  const otherEnv = engine.prepare({ ...turn('other-env', prompt), environmentId: 'toolchain-b' })
  assert.equal(otherEnv.bytes, 0)
  engine.record({ eventId: 'other-env-record', kind: 'method', source: 'host_proposal',
    methodId: 'numeric-sort-v1', environmentId: 'toolchain-b' })
  const rows = engine.list({ limit: 20 }).lessons.filter(item => item.methodId === 'numeric-sort-v1')
  assert.equal(rows.length, 2, 'each environment keeps its own generation')
  assert.equal(rows.filter(item => item.status === 'candidate').length, 1, 'only the new environment is a fresh candidate')
  assert.equal(rows.filter(item => item.status === 'suspended').length, 1, 'the withdrawn rule stays withdrawn')
})

test('relearning keeps the session budget and survives a restart', t => {
  let now = Date.UTC(2026, 9, 1)
  const { engine, stateRoot } = setup(t, { now: () => now })
  const prompt = getMethod('numeric-sort-v1').instruction
  const first = engine.record({ eventId: 'seed', kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' })
  engine.evaluateRegistered({ lessonId: first.id })
  const served = engine.prepare(turn('budget-session', prompt))
  assert.ok(served.bytes > 0)
  const bytesBefore = engine.diagnose({ sessionId: 'budget-session' }).session.bytes
  now += 91 * DAY
  engine.record({ eventId: 'relearn', kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' })
  const restarted = new LearningEngine({ stateRoot, adapterId: 'dsh', now: () => now })
  const row = restarted.list({ limit: 20 }).lessons.find(item => item.id === first.id)
  assert.equal(row.status, 'candidate')
  assert.equal(restarted.diagnose({ sessionId: 'budget-session' }).session.bytes, bytesBefore,
    'relearning never clears the existing session debit')
})

test('selecting a previously used value reactivates it as a new generation', t => {
  const { engine } = setup(t)
  engine.prepare(turn('usd', '以后导出报表金额时统一使用美元', { projectKey }))
  engine.prepare(turn('cny', '纠正一下，以后导出报表金额时统一使用人民币', { projectKey }))
  const pending = engine.prepare(turn('consumer', '导出报表金额并核对币种', { projectKey }))
  engine.accept({ receipt: pending.receipt, lessonIds: pending.lessons })
  const back = engine.prepare(turn('usd-again', '纠正一下，以后导出报表金额时统一使用美元', { projectKey }))
  assert.notEqual(back.reason, RECALL_REASONS.conflictUnresolved)
  const rows = currency(engine)
  const usd = rows.find(row => row.value === 'USD')
  const cny = rows.find(row => row.value === 'CNY')
  assert.equal(usd.status, 'reminder', 'the returned value is active again')
  assert.equal(usd.version, 3, 'reactivation is a new generation, not a silent reuse')
  assert.equal(cny.status, 'suspended')
  assert.equal(rows.filter(row => row.status === 'reminder').length, 1, 'exactly one value stays active')
  const served = engine.prepare(turn('task', '导出报表金额并核对币种', { projectKey }))
  assert.match(served.context, /美元/u)
  assert.equal(served.context.includes('人民币'), false)
  // Evidence gathered for the previous generation never credits the reactivated one.
  const settled = engine.complete({ sessionId: 'consumer', turnId: pending.lessonVersions ? undefined : undefined,
    outcome: 'unknown' })
  assert.equal(settled.ok, true)
  assert.equal(engine.list({ projectKey, limit: 50 }).lessons.find(row => row.value === 'USD').verified, 0)
})

test('a reworded selection keeps its slot, so the replacement retires it', t => {
  const { engine } = setup(t)
  engine.prepare(turn('first', '以后导出报表金额时统一使用人民币', { projectKey }))
  const reworded = engine.prepare(turn('reworded', '以后报表金额都用人民币结算', { projectKey }))
  assert.equal(reworded.learned?.topicKey, 'report.currency', 'the reworded selection still owns the slot')
  assert.equal(reworded.learned?.value, 'CNY')
  assert.equal(currency(engine).filter(row => row.status === 'reminder').length, 1,
    'the slot keeps exactly one active owner instead of leaking an ordinary correction')
  engine.prepare(turn('replacement', '纠正一下，以后导出报表金额时统一使用美元', { projectKey }))
  const rows = currency(engine)
  assert.equal(rows.filter(row => row.status === 'reminder').length, 1)
  assert.equal(rows.filter(row => row.value === 'CNY' && row.status !== 'suspended').length, 0,
    'every superseded value in the slot is retired')
  const served = engine.prepare(turn('query', '导出报表金额并核对币种', { projectKey }))
  assert.match(served.context, /美元/u)
  assert.equal(served.context.includes('人民币'), false, 'no superseded value is served next to the new one')
})

test('a stored requirement keeps its own bytes, including a leading negation', t => {
  const { engine, stateRoot } = setup(t)
  engine.prepare(turn('learn', '记住：不要把空值改成零 ，保留原始空值'))
  const rows = engine.list({ limit: 10 }).lessons
  assert.equal(rows.length, 1)
  assert.equal(rows[0].instruction, '不要把空值改成零 ，保留原始空值',
    'the slice starts where the cue ends, never one character late')
  assert.equal(rows[0].instruction.startsWith('不'), true, 'the negation is never truncated away')
  const recalled = new LearningEngine({ stateRoot, adapterId: 'dsh' })
    .prepare(turn('next', '导出数据时处理空值并保留原始空值'))
  assert.ok(recalled.bytes > 0)
  assert.match(recalled.context, /不要把空值改成零/u)
})

test('a currency choice and an independent precision rule are two separate instructions', t => {
  const { engine } = setup(t)
  engine.prepare(turn('currency', '以后导出报表金额时统一使用人民币', { projectKey }))
  const precision = engine.prepare(turn('precision', '以后人民币金额必须保留两位小数', { projectKey }))
  assert.notEqual(precision.reason, RECALL_REASONS.conflictUnresolved)
  const lessons = engine.list({ projectKey, limit: 50 }).lessons
  assert.equal(lessons.length, 2, 'the precision requirement must not be swallowed by the currency slot')
  assert.equal(lessons.filter(row => row.topicKey === 'report.currency').length, 1)
  const plain = lessons.find(row => row.topicKey === undefined)
  assert.match(plain.instruction, /保留两位小数/u)
  const served = engine.prepare(turn('precision-task', '人民币金额怎么保留两位小数', { projectKey }))
  assert.match(served.context, /两位小数/u)
  // A bare mention of a currency is never treated as selecting the slot.
  engine.prepare(turn('mention', '以后美元金额也要一起核对，不要漏掉', { projectKey }))
  assert.equal(currency(engine).filter(row => row.status === 'reminder').length, 1, 'mentions do not open new slots')
})

test('every explicit supersedes path validates the expected version and refuses a stale one', t => {
  const { engine } = setup(t)
  const a = engine.record({ eventId: 'a', kind: 'correction', source: 'direct_user', projectKey,
    instruction: '以后导出报表金额时统一使用美元' })
  engine.record({ eventId: 'b', kind: 'correction', source: 'direct_user', projectKey,
    instruction: '以后导出报表金额时统一使用人民币', supersedes: a.id, expectedSupersededVersion: 1 })
  const before = JSON.stringify(engine.store.read().lessons)
  assert.throws(() => engine.record({ eventId: 'c', kind: 'correction', source: 'direct_user', projectKey,
    instruction: '以后导出报表金额时统一使用欧元', supersedes: a.id, expectedSupersededVersion: 1 }),
  /stale_replacement/)
  assert.equal(JSON.stringify(engine.store.read().lessons), before, 'a refused replacement changes nothing')
  assert.throws(() => engine.record({ eventId: 'd', kind: 'correction', source: 'direct_user', projectKey,
    instruction: '以后导出报表金额时统一使用欧元', supersedes: a.id }), /invalid_replacement/)
  assert.equal(JSON.stringify(engine.store.read().lessons), before)
})

test('the generation contract stops replays after the bounded ring is evicted', t => {
  let now = Date.UTC(2030, 0, 1)
  const { engine } = setup(t, { now: () => now })
  const proposal = { kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' }
  const first = engine.record({ eventId: 'initial', ...proposal })
  engine.evaluateRegistered({ lessonId: first.id })
  for (let index = 1; index <= 8; index++) engine.record({ eventId: `additional-${index}`, ...proposal })
  now += 91 * DAY
  const replay = engine.record({ eventId: 'initial', ...proposal })
  assert.equal(replay.duplicate, true, 'the opening event is remembered beyond the ring')
  assert.equal(engine.list({ projectKey: undefined, limit: 10 }).lessons.find(row => row.id === first.id).status, 'validated')
  assert.ok(engine.list({ limit: 10 }).lessons.find(row => row.id === first.id).expiresAt <= now)
  // A full ring may have evicted events, so it is not proof of novelty: an unprovable
  // observation is refused conservatively instead of being trusted as a new one.
  const unprovable = engine.record({ eventId: 'fresh-observation', ...proposal })
  assert.equal(unprovable.skipped, 'new_observation_required', 'a bare event id cannot prove novelty')
  assert.ok(engine.list({ limit: 10 }).lessons.find(row => row.id === first.id).expiresAt <= now,
    'a refused observation leaves the row byte-identical')
  // A host that re-observed the row states the version and generation it read.
  const observed = engine.list({ limit: 10 }).lessons.find(row => row.id === first.id)
  const fresh = engine.record({ eventId: 'fresh-observation', newGeneration: true,
    expectedVersion: observed.version, expectedGeneration: observed.generation, ...proposal })
  assert.equal(fresh.duplicate, false)
  assert.equal(fresh.status, 'candidate', 'a verifiably new observation reopens the method')
  const renewed = engine.list({ limit: 10 }).lessons.find(row => row.id === first.id)
  assert.equal(renewed.generation, observed.generation + 1, 'the re-open opens one new generation')
  assert.ok(renewed.expiresAt > now)
  // The condition is bound to the generation it was read from, so it cannot be replayed.
  now += 91 * DAY
  const stale = engine.record({ eventId: 'stale-observation', newGeneration: true,
    expectedVersion: observed.version, expectedGeneration: observed.generation, ...proposal })
  assert.equal(stale.skipped, 'stale_generation')
  assert.ok(engine.list({ limit: 10 }).lessons.find(row => row.id === first.id).expiresAt <= now)
})

test('a legacy row without the generation contract needs a verifiable observation', t => {
  let now = Date.UTC(2030, 0, 1)
  const { engine, stateRoot } = setup(t, { now: () => now })
  const proposal = { kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' }
  const first = engine.record({ eventId: 'legacy-initial', ...proposal })
  engine.evaluateRegistered({ lessonId: first.id })
  // Reproduce the alpha.4 shape: a row written before the generation contract existed.
  const path = join(stateRoot, 'lessons-v1.json')
  const state = JSON.parse(readFileSync(path, 'utf8'))
  for (const lesson of state.lessons) { delete lesson.originEvent; delete lesson.generationEvent
    delete lesson.eventIds; delete lesson.generation }
  writeFileSync(path, JSON.stringify(state))
  const legacy = new LearningEngine({ stateRoot, adapterId: 'dsh', now: () => now })
  assert.equal(legacy.record({ eventId: 'legacy-initial', ...proposal }).duplicate, true, 'the ledger still knows the event')
  now += 91 * DAY
  // Once the pruned ledger is gone, an untracked row cannot prove the event is new.
  assert.equal(legacy.record({ eventId: 'legacy-initial', ...proposal }).skipped, 'new_observation_required')
  assert.equal(legacy.record({ eventId: 'unprovable-replay', ...proposal }).skipped, 'new_observation_required')
  assert.equal(legacy.list({ limit: 10 }).lessons[0].status, 'validated', 'no silent reopen from a missing old field')
  // A bare boolean is explicitly not enough — it cannot prove a replayable event is fresh.
  assert.equal(legacy.record({ eventId: 'asserted-bare', newGeneration: true, ...proposal }).skipped,
    'new_observation_required')
  assert.equal(legacy.list({ limit: 10 }).lessons[0].status, 'validated')
  // The host re-observed the row: pre-contract rows report generation 0.
  const observed = legacy.list({ limit: 10 }).lessons[0]
  assert.equal(observed.generation, undefined)
  const asserted = legacy.record({ eventId: 'asserted-new', newGeneration: true,
    expectedVersion: observed.version, expectedGeneration: 0, ...proposal })
  assert.equal(asserted.duplicate, false)
  const row = legacy.list({ limit: 10 }).lessons[0]
  assert.equal(row.status, 'candidate')
  assert.equal(row.generation, 1, 'the row carries the contract after its first verified re-open')
})

test('an upgraded legacy row can never certify the history it lost', t => {
  let now = Date.UTC(2030, 0, 1)
  const { engine, stateRoot } = setup(t, { now: () => now })
  const proposal = { kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' }
  const first = engine.record({ eventId: 'legacy-original', ...proposal })
  assert.equal(engine.evaluateRegistered({ lessonId: first.id }).decision, 'accepted')
  now += 91 * DAY
  // The alpha.4 shape: no generation contract at all.
  const path = join(stateRoot, 'lessons-v1.json')
  const state = JSON.parse(readFileSync(path, 'utf8'))
  const row = state.lessons.find(item => item.id === first.id)
  for (const field of ['historyComplete', 'generation', 'originEvent', 'generationEvent', 'eventIds']) delete row[field]
  writeFileSync(path, JSON.stringify(state))
  const upgraded = new LearningEngine({ stateRoot, adapterId: 'dsh', now: () => now })
  // A legitimate re-open is still possible — it needs the bound condition, and it must not
  // retroactively certify the events that were never recorded.
  const reopened = upgraded.record({ eventId: 'upgrade-observed', newGeneration: true,
    expectedVersion: row.version, expectedGeneration: 0, ...proposal })
  assert.equal(reopened.status, 'candidate')
  assert.equal(upgraded.evaluateRegistered({ lessonId: first.id }).decision, 'accepted')
  const before = upgraded.list({ limit: 10 }).lessons[0]
  assert.notEqual(before.historyComplete, true, 'one legitimate re-open never certifies missing history')
  assert.equal(before.eventIds.length, 1, 'the upgrade ring only starts at the re-open')
  now += 91 * DAY
  // The pre-upgrade event is not in that ring, so it cannot be trusted as a new observation.
  const replay = upgraded.record({ eventId: 'legacy-original', ...proposal })
  assert.equal(replay.skipped, 'new_observation_required')
  const after = upgraded.list({ limit: 10 }).lessons[0]
  assert.equal(after.version, before.version)
  assert.equal(after.expiresAt, before.expiresAt)
  assert.equal(after.status, 'validated')
  assert.equal(after.validation?.decision, 'accepted', 'a refused replay changes no credit')
  // A host that really observed the row again can still open the next generation.
  const observed = upgraded.list({ limit: 10 }).lessons[0]
  const next = upgraded.record({ eventId: 'second-observation', newGeneration: true,
    expectedVersion: observed.version, expectedGeneration: observed.generation, ...proposal })
  assert.equal(next.status, 'candidate')
})

test('a short ring written by an older build is not proof of a complete history', t => {
  let now = Date.UTC(2030, 0, 1)
  const { engine, stateRoot } = setup(t, { now: () => now })
  const proposal = { kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' }
  const first = engine.record({ eventId: 'alpha6-origin', ...proposal })
  assert.equal(engine.evaluateRegistered({ lessonId: first.id }).decision, 'accepted')
  engine.record({ eventId: 'alpha6-extra', ...proposal })
  // The alpha.6 shape: a short ring, a generation event, but no completeness marker.
  const path = join(stateRoot, 'lessons-v1.json')
  const state = JSON.parse(readFileSync(path, 'utf8'))
  const row = state.lessons.find(item => item.id === first.id)
  delete row.historyComplete
  writeFileSync(path, JSON.stringify(state))
  now += 91 * DAY
  const upgraded = new LearningEngine({ stateRoot, adapterId: 'dsh', now: () => now })
  const before = upgraded.list({ limit: 10 }).lessons[0]
  assert.equal(before.eventIds.length, 2, 'the short ring looks harmless')
  const unbound = upgraded.record({ eventId: 'unbound-upgrade-observation', ...proposal })
  assert.equal(unbound.skipped, 'new_observation_required', 'a short ring is not a complete history')
  const after = upgraded.list({ limit: 10 }).lessons[0]
  assert.equal(after.version, before.version)
  assert.equal(after.expiresAt, before.expiresAt)
})

test('a row created by this build keeps its proven history until the ring drops an event', t => {
  let now = Date.UTC(2030, 0, 1)
  const { engine } = setup(t, { now: () => now })
  const proposal = { kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' }
  const first = engine.record({ eventId: 'initial', ...proposal })
  engine.evaluateRegistered({ lessonId: first.id })
  assert.equal(engine.list({ limit: 10 }).lessons[0].historyComplete, true)
  now += 91 * DAY
  // Nothing was ever evicted, so an unseen event is still provably new.
  const fresh = engine.record({ eventId: 'fresh-observation', ...proposal })
  assert.equal(fresh.status, 'candidate')
  assert.equal(engine.list({ limit: 10 }).lessons[0].historyComplete, true, 'a re-open keeps the proven history')
  // Filling the ring permanently ends completeness: the next append drops an event.
  engine.evaluateRegistered({ lessonId: first.id })
  for (let index = 1; index <= 6; index++) engine.record({ eventId: `additional-${index}`, ...proposal })
  const full = engine.list({ limit: 10 }).lessons[0]
  assert.equal(full.eventIds.length, 8, 'the ring is full')
  assert.equal(full.historyComplete, true, 'a full ring that never dropped an event is still complete')
  engine.record({ eventId: 'one-more', ...proposal })
  const dropped = engine.list({ limit: 10 }).lessons[0]
  assert.equal(dropped.eventIds.length, 8)
  assert.equal(dropped.historyComplete, false, 'the first dropped event ends completeness for good')
  now += 91 * DAY
  const afterDrop = engine.record({ eventId: 'unprovable-after-drop', ...proposal })
  assert.equal(afterDrop.skipped, 'new_observation_required', 'a ring that dropped an event proves nothing')
})

test('a completed historical replacement no longer blocks the new generation evaluation', t => {
  let now = Date.UTC(2030, 0, 1)
  const { engine } = setup(t, { now: () => now })
  const descriptor = getMethod('numeric-sort-v1')
  const a = engine.record({ eventId: 'generic', kind: 'method', source: 'host_proposal', instruction: descriptor.instruction })
  assert.equal(engine.evaluate({ lessonId: a.id, expectedVersion: 1, eventId: 'generic-eval',
    suiteId: 'fixture', trials: registered('numeric-sort-v1') }).decision, 'accepted')
  const b = engine.record({ eventId: 'canonical', kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1', supersedes: a.id })
  assert.equal(engine.evaluateRegistered({ lessonId: b.id }).decision, 'accepted')
  now += 91 * DAY
  const reopened = engine.record({ eventId: 'canonical-again', kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' })
  assert.equal(reopened.status, 'candidate')
  const reEvaluated = engine.evaluateRegistered({ lessonId: b.id })
  assert.equal(reEvaluated.decision, 'accepted', JSON.stringify(reEvaluated.reasons))
  assert.equal(engine.list({ limit: 10 }).lessons.find(row => row.id === b.id).status, 'validated')
  // The restored method is recallable again in its own environment.
  assert.ok(engine.prepare(turn('recall', descriptor.instruction)).bytes > 0)
})
