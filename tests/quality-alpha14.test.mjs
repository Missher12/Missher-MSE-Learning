/**
 * alpha.14 targeted regression for three reproducible quality gaps.
 *
 * Each block reproduces the independent audit's counterexample first, then the fixed behaviour,
 * using only the real core on an isolated state root: no model, no network, no daily state.
 * These are local fixtures, not a benchmark result and not a claim about real model quality.
 *
 *   1. one task must not become many cases by re-labelling (adapter *and* shared core),
 *   2. a lesson's own applicability/exclusions must take part in admission,
 *   3. unverified proposals must not consume the capacity a user correction needs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningEngine, runEvaluation } from '../src/index.mjs'
import { CASE_REASONS, caseTaskKey, normalizeCases, scoreOutput, taskIndependence } from '../src/cases.mjs'
import { analyze, conditionVerdict, formatMentions, parseCondition } from '../src/recall.mjs'
import { DEFAULT_EVALUATION_POLICY } from '../src/evaluation.mjs'

const PROJECT = 'alpha14-project'
const NOW = 1_790_985_600_000

let root = null
const makeRoot = () => {
  root ??= mkdtempSync(join(tmpdir(), 'mse-alpha14-'))
  return root
}
test.after(() => { if (root !== null) rmSync(root, { recursive: true, force: true }) })

const engineFor = (name, options = {}) => new LearningEngine({ stateRoot: join(makeRoot(), name),
  adapterId: 'audit', now: () => NOW, evaluationTokensPerDay: 100_000, evaluationCallsPerDay: 8, ...options })

const exact = (expected, forbidden = []) => ({ kind: 'text-exact-v1', expected, ...(forbidden.length === 0 ? {} : { forbidden }) })
const caseRow = (index, overrides = {}) => ({ caseId: `case-${index}`, family: `family-${index % 2}`,
  split: index % 3 === 0 ? 'holdout' : 'development', prompt: `任务 ${index}：把第 ${index} 组数值升序排列。`,
  checker: exact(`${index}, ${index + 1}`), ...overrides })

/** Twelve rows that really are twelve different tasks. */
const distinctCases = () => Array.from({ length: 12 }, (_, index) => caseRow(index))

// ---------------------------------------------------------------- 1. task independence

test('a task repeated across labels, oracles, forbidden lists or splits is one measurement', () => {
  const base = { caseId: 'a', family: 'f1', split: 'development', prompt: '把 3,1,2 升序排列',
    checker: exact('1, 2, 3') }
  const variants = {
    relabelled: { ...base, caseId: 'b', family: 'f2', split: 'holdout' },
    otherOracle: { ...base, caseId: 'b', family: 'f2', split: 'holdout', checker: exact('1,2,3') },
    otherForbidden: { ...base, caseId: 'b', family: 'f2', split: 'holdout', forbidden: ['降序'] },
    whitespace: { ...base, caseId: 'b', family: 'f2', split: 'holdout', prompt: '  把 3,1,2\u00a0 升序排列 ' },
    fullWidth: { ...base, caseId: 'b', family: 'f2', split: 'holdout', prompt: '把 3,1,2 升序排列'.normalize('NFD') },
  }
  for (const [label, variant] of Object.entries(variants)) {
    const result = normalizeCases([base, variant, ...distinctCases().slice(0, 11)], DEFAULT_EVALUATION_POLICY)
    assert.equal(result.ok, false, `${label} must be refused`)
    assert.equal(result.code, CASE_REASONS.duplicateCaseTask, label)
    assert.equal(result.index, 1, label)
    assert.equal(result.duplicateOf, 0, label)
  }
  // Twelve genuinely different tasks still pass, and are keyed apart.
  const ok = normalizeCases(distinctCases(), DEFAULT_EVALUATION_POLICY)
  assert.equal(ok.ok, true)
  assert.equal(new Set(ok.cases.map(caseTaskKey)).size, 12)
})

test('the shared core refuses a repeated task before any ticket, debit or runner call', async () => {
  const engine = engineFor('core-independence')
  const recorded = engine.record({ projectKey: PROJECT, eventId: 'proposal', kind: 'method',
    source: 'host_proposal', instruction: '导出报表金额时使用数值字段，同时保留原始空值。' })
  const repeated = Array.from({ length: 12 }, (_, index) => ({ caseId: `case-${index}`,
    family: `family-${index % 2}`, split: index < 8 ? 'development' : 'holdout',
    prompt: '输出金额字段为数值并保留空值。',
    checker: { kind: 'json-deep-equal-v1', expected: { amount: 10, value: null } },
    forbidden: [`unused_marker_${index}`] }))
  let calls = 0
  await assert.rejects(
    () => runEvaluation(engine, { projectKey: PROJECT, lessonId: recorded.id, expectedVersion: 1,
      suiteId: 'same-task', cases: repeated, maxTokens: 1000 },
    async ({ arm }) => { calls += 1; return { ...scoreOutput({ checker: { kind: 'json-deep-equal-v1', expected: null },
      forbidden: [] }, '{}'), tokens: 10 } }),
    error => error.code === CASE_REASONS.duplicateCaseTask || /duplicate_case_task/u.test(String(error.message)))
  const state = engine.store.read()
  assert.equal(calls, 0, 'the runner is never reached')
  assert.equal(state.jobs.length, 0, 'no ticket is minted')
  assert.equal(state.spends.filter(row => row.kind === 'evaluation').length, 0, 'nothing is debited')
  // A list that mixes rows carrying a prompt FIELD with rows that do not is refused: omitting
  // the field on some rows is how a malformed row would otherwise ride along.
  const mixed = repeated.map((row, index) => { const copy = { ...row }; if (index === 3) delete copy.prompt; return copy })
  assert.equal(taskIndependence(mixed).code, CASE_REASONS.invalidPrompt)
  // The protocol is chosen by field PRESENCE, so a row that carries the field with an unusable
  // value has opted in and is refused — it does not fall back to the prompt-less path.
  for (const value of ['', null, 3, undefined, 'a\u0001b', 'x'.repeat(407), 'ab\uD800cd']) {
    const rows = repeated.map(row => ({ ...row, prompt: value }))
    const verdict = taskIndependence(rows)
    assert.equal(verdict.ok, false, JSON.stringify(value))
    assert.equal(verdict.code, CASE_REASONS.invalidPrompt, JSON.stringify(value))
    assert.equal(verdict.mode, 'prompted', JSON.stringify(value))
  }
  // Only a list where NO row carries the field is the legacy protocol.
  assert.equal(taskIndependence(repeated.map(({ prompt, ...rest }) => rest)).mode, 'trusted_runner')
})

test('the legacy prompt-less trusted-runner protocol still runs', async () => {
  const engine = engineFor('core-legacy')
  const recorded = engine.record({ projectKey: PROJECT, eventId: 'proposal', kind: 'method',
    source: 'host_proposal', instruction: '排名并列时按来源顺序保持稳定。' })
  const manifest = distinctCases()
  let calls = 0
  const result = await runEvaluation(engine, { projectKey: PROJECT, lessonId: recorded.id, expectedVersion: 1,
    suiteId: 'trusted-runner', maxTokens: 1000,
    cases: manifest.map(({ caseId, family, split }) => ({ caseId, family, split })) },
  // The legacy protocol hands the Host's own comparison result back; the plugin never sees a
  // prompt, so the runner here is the trusted side reporting an outcome.
  async ({ arm }) => { calls += 1; return { passed: arm === 'candidate', guardPassed: true, tokens: 10 } })
  assert.equal(calls > 0, true, 'the trusted runner is still invoked')
  assert.equal(typeof result.decision, 'string')
})

// ---------------------------------------------------------------- 2. applicability and exclusions

test('an explicit format exclusion blocks the recall and costs no bytes', () => {
  const engine = engineFor('conditions-format')
  const method = engine.record({ projectKey: PROJECT, eventId: 'proposal', kind: 'method', source: 'host_proposal',
    instruction: '导出报表金额时保留两位小数。',
    applicability: '仅适用于 CSV 格式的报表导出。', exclusions: '不适用于 JSON 格式的报表导出。' })
  const trials = Array.from({ length: 12 }, (_, index) => ({ caseId: `c-${index}`, family: `f-${index % 2}`,
    split: index < 8 ? 'development' : 'holdout', baseline: { passed: false, tokens: 10 },
    candidate: { passed: true, tokens: 10 }, guardPassed: true }))
  const promoted = engine.evaluate({ projectKey: PROJECT, lessonId: method.id, expectedVersion: 1,
    eventId: 'evaluate', suiteId: 'controlled-evidence', trials })
  assert.equal(promoted.decision, 'accepted')
  // The audit's counterexample: a JSON task used to recall the CSV-only rule.
  const excluded = engine.prepare({ projectKey: PROJECT, sessionId: 'session', turnId: 't1', origin: 'user',
    prompt: '导出 JSON 报表金额，保留两位小数。' })
  assert.equal(excluded.lessons.length, 0)
  assert.equal(excluded.bytes, 0)
  assert.equal(excluded.context, '')
  assert.equal(excluded.reason, 'condition_blocked')
  assert.equal(excluded.diagnostics.conditionExcluded, 1)
  // The positive case still recalls, and diagnose agrees with prepare.
  const admitted = engine.prepare({ projectKey: PROJECT, sessionId: 'session', turnId: 't2', origin: 'user',
    prompt: '导出 CSV 报表金额，保留两位小数。' })
  assert.equal(admitted.reason, 'recalled')
  assert.equal(admitted.lessons.length, 1)
  assert.ok(admitted.bytes > 0)
  // A dry run reads its own session: the CSV lesson was just injected into `session`, and a
  // second offer in that same session is correctly reported as already_offered.
  const diagnosed = engine.diagnose({ projectKey: PROJECT, sessionId: 'diagnose-session', prompt: '导出 JSON 报表金额，保留两位小数。' })
  assert.equal(diagnosed.prompted.reason, 'condition_blocked')
  assert.equal(diagnosed.prompted.wouldInjectBytes, 0)
  assert.equal(diagnosed.prompted.conditionExcluded, 1)
  const diagnosedOk = engine.diagnose({ projectKey: PROJECT, sessionId: 'diagnose-session', prompt: '导出 CSV 报表金额，保留两位小数。' })
  assert.equal(diagnosedOk.prompted.reason, 'recalled')
  assert.ok(diagnosedOk.prompted.wouldInjectBytes > 0)
})

test('a negated format in the task is not an assertion of that format', () => {
  const verdict = conditionVerdict({ applicability: '仅适用于 CSV 格式的报表导出。', exclusions: '' },
    analyze('不用 CSV，改成 JSON 导出报表金额。'))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.gate, 'condition_not_applicable')
  // The mirror image: the lesson is CSV-only and the task really is a CSV task.
  assert.equal(conditionVerdict({ applicability: '仅适用于 CSV 格式的报表导出。', exclusions: '' },
    analyze('导出 CSV 报表金额。')).ok, true)
})

test('a numeric or otherwise unreadable condition is never decided by string matching', () => {
  // `19%` inside `119%`, or a negated `不是19%`, would satisfy a naive containment test. This
  // module does not attempt that: a numeric condition is unsupported, so the lesson is not
  // recalled — for every task, including one that names the same number.
  for (const prompt of ['按17%税率计算报表金额。', '按119%税率计算报表金额。', '不是19%的情况。', '按19%税率计算报表金额。']) {
    const verdict = conditionVerdict({ applicability: '仅当税率19%时可用。', exclusions: '' }, analyze(prompt))
    assert.equal(verdict.ok, false, prompt)
    assert.equal(verdict.gate, 'condition_unclear', prompt)
    assert.equal(verdict.verified, false, prompt)
  }
  // The same holds for an exclusion written as a number, and for a bare identifier that is
  // not a registered method's canonical condition.
  assert.equal(conditionVerdict({ applicability: '', exclusions: '不适用于 30% 税率场景。' },
    analyze('按30%税率计算。')).gate, 'condition_unclear')
  assert.equal(conditionVerdict({ applicability: 'freeform_identifier', exclusions: '' },
    analyze('导出报表金额。')).gate, 'condition_unclear')
})

test('only a registered method\u2019s own canonical conditions are treated as registered', () => {
  const registered = { methodId: 'numeric-sort-v1',
    applicability: 'explicit_ascending_order_matching_identity_and_values',
    exclusions: 'invalid_unknown_non_numeric_or_changed_values' }
  const verdict = conditionVerdict(registered, analyze('把这一列数值升序排列。'))
  assert.equal(verdict.ok, true)
  assert.equal(verdict.kind, 'registered')
  assert.equal(verdict.verified, true)
  // Same identifier, wrong methodId: it is ordinary text, not a registration.
  assert.equal(conditionVerdict({ ...registered, methodId: 'not-a-method' },
    analyze('把这一列数值升序排列。')).kind, 'unsupported')
  assert.equal(conditionVerdict({ ...registered, methodId: undefined },
    analyze('把这一列数值升序排列。')).kind, 'unsupported')
  // Same methodId, altered conditions: also not the registry's pair.
  assert.equal(conditionVerdict({ methodId: 'numeric-sort-v1', applicability: 'matching_row_identity', exclusions: '' },
    analyze('把这一列数值升序排列。')).kind, 'unsupported')
  for (const condition of [{ applicability: '任何任务都适用', exclusions: '' },
    { applicability: '', exclusions: '' }]) {
    const plain = conditionVerdict(condition, analyze('导出报表金额，保留两位小数。'))
    assert.equal(plain.ok, true, JSON.stringify(condition))
    assert.equal(plain.gate, null)
    assert.equal(plain.verified, true)
  }
})

test('free prose is conservatively refused instead of being handed to the model', () => {
  for (const condition of [
    { applicability: '开发或调整 DSH 设置页与插件界面时', exclusions: '' },
    { applicability: '', exclusions: '独立页面没有宿主控件时按其设计规范处理' },
    { applicability: '开发或调整 DSH 设置页时', exclusions: '纯逻辑测试不能据此宣称视觉验收通过' },
  ]) {
    const verdict = conditionVerdict(condition, analyze('修复设置页的布局'))
    assert.equal(verdict.ok, false, JSON.stringify(condition))
    assert.equal(verdict.gate, 'condition_unclear', JSON.stringify(condition))
    assert.equal(verdict.verified, false)
  }
})

test('the recall budget is unchanged: at most two lessons and 768 bytes per turn', () => {
  const engine = engineFor('conditions-budget')
  const long = '导出报表金额并核对币种与小数位后写入审计日志，并在提交信息中用中文说明本次改动的原因。'
  for (let index = 0; index < 4; index += 1) {
    engine.record({ projectKey: PROJECT, eventId: `p-${index}`, kind: 'method', source: 'host_proposal',
      instruction: `导出报表金额时保留两位小数并核对币种（变体 ${index}）。` })
  }
  const recalled = engine.prepare({ projectKey: PROJECT, sessionId: 'budget', turnId: '1', origin: 'user',
    prompt: `导出报表金额并核对币种：${long}` })
  assert.ok(recalled.lessons.length <= 2, `at most two lessons, got ${recalled.lessons.length}`)
  assert.ok(recalled.bytes <= 768, `at most 768 bytes, got ${recalled.bytes}`)
})

// ---------------------------------------------------------------- 3. capacity and eviction

test('a user correction still lands when unverified proposals fill the library', () => {
  const engine = engineFor('capacity-correction')
  for (let index = 0; index < 300; index += 1) {
    engine.record({ projectKey: PROJECT, eventId: `proposal-${index}`, kind: 'method', source: 'host_proposal',
      instruction: `导出报表字段 field${index} 时保留原始数值精度。` })
  }
  assert.equal(engine.store.read().lessons.length, 300)
  const before = engine.store.read().lessons.filter(row => row.kind === 'correction').length
  const prepared = engine.prepare({ projectKey: PROJECT, sessionId: 'session', turnId: 'correction',
    origin: 'user', prompt: '以后导出报表时保留原始空值，不要改成零。' })
  assert.equal(typeof prepared.learned?.id, 'string', 'the correction is stored, not refused')
  const state = engine.store.read()
  assert.equal(state.lessons.length, 300, 'the hard cap still holds')
  assert.equal(state.lessons.filter(row => row.kind === 'correction').length, before + 1)
  assert.equal(state.evictions.length, 1)
  const [evicted] = state.evictions
  assert.equal(evicted.reason, 'weak_unverified_candidate')
  assert.equal(evicted.kind, 'method')
  assert.equal(state.lessons.some(row => row.id === evicted.id), false, 'exactly that row is gone')
  // The audit record carries ids and counts, never a copy of what was learned.
  assert.deepEqual(Object.keys(evicted).sort(), ['at', 'byLessonId', 'id', 'kind', 'reason', 'scope', 'status', 'version'].sort())
  assert.equal(JSON.stringify(evicted).includes('field'), false)
})

test('validated methods, corrections and open regressions are never displaced', () => {
  const engine = engineFor('capacity-protected')
  const validated = engine.record({ projectKey: PROJECT, eventId: 'm-valid', kind: 'method', source: 'host_proposal',
    instruction: '导出报表金额时保留两位小数。' })
  const trials = Array.from({ length: 12 }, (_, index) => ({ caseId: `c-${index}`, family: `f-${index % 2}`,
    split: index < 8 ? 'development' : 'holdout', baseline: { passed: false, tokens: 10 },
    candidate: { passed: true, tokens: 10 }, guardPassed: true }))
  assert.equal(engine.evaluate({ projectKey: PROJECT, lessonId: validated.id, expectedVersion: 1,
    eventId: 'evaluate', suiteId: 's', trials }).decision, 'accepted')
  const correction = engine.record({ projectKey: PROJECT, eventId: 'c-1', kind: 'correction', source: 'direct_user',
    instruction: '以后导出报表时保留原始空值，不要改成零。' })
  const protectedIds = new Set([validated.id, correction.id])
  for (let index = 0; index < 298; index += 1) {
    engine.record({ projectKey: PROJECT, eventId: `proposal-${index}`, kind: 'method', source: 'host_proposal',
      instruction: `导出报表字段 field${index} 时保留原始数值精度。` })
  }
  engine.prepare({ projectKey: PROJECT, sessionId: 'session', turnId: 'second-correction', origin: 'user',
    prompt: '以后导出报表时不要使用浮点数，改用字符串。' })
  const state = engine.store.read()
  assert.equal(state.lessons.length, 300)
  for (const id of protectedIds) {
    assert.equal(state.lessons.some(row => row.id === id), true, `${id} must survive`)
  }
  assert.equal(state.lessons.filter(row => row.kind === 'correction').length, 2)
  assert.equal(state.lessons.filter(row => row.status === 'validated').length, 1)
})

test('another scope is never emptied to make room, and a full protected scope refuses clearly', () => {
  const engine = engineFor('capacity-scope')
  // A foreign project fills the library through the same public API.
  for (let index = 0; index < 300; index += 1) {
    engine.record({ projectKey: 'other-project', eventId: `foreign-${index}`, kind: 'method',
      source: 'host_proposal', instruction: `别的项目经验 ${index}：导出字段时保留精度。` })
  }
  const foreignBefore = engine.store.read().lessons.filter(row => row.scope !== undefined).length
  assert.equal(foreignBefore, 300)
  assert.throws(
    () => engine.prepare({ projectKey: PROJECT, sessionId: 'session', turnId: 't', origin: 'user',
      prompt: '以后导出报表时保留原始空值，不要改成零。' }),
    error => error.code === 'capacity')
  const state = engine.store.read()
  assert.equal(state.lessons.length, 300, 'nothing from the other scope was deleted')
  assert.equal((state.evictions ?? []).length, 0, 'no eviction was recorded, because none happened')
  assert.equal(state.lessons.filter(row => row.kind === 'correction').length, 0,
    'the refusal is reported instead of a fake save')
})

test('eviction is deterministic across equal timestamps and survives a restart', () => {
  const select = engine => {
    const rows = Array.from({ length: 300 }, (_, index) => ({ id: `lesson_${String(index).padStart(24, '0')}`,
      scope: 's', kind: 'method', status: 'candidate', verified: 0, adopted: 0, inconclusive: 0,
      createdAt: NOW, expiresAt: NOW + 1, version: 1 }))
    return engine.selectEviction({ lessons: rows, receipts: [], jobs: [], experiments: [] },
      { now: NOW, scope: 's', incomingKind: 'correction' }).row.id
  }
  const first = engineFor('determinism-a')
  const second = engineFor('determinism-b')
  assert.equal(select(first), select(second), 'the same state retires the same row')
  assert.equal(select(first), 'lesson_000000000000000000000000', 'and it is the lowest id, not an accident of order')
  // The policy is re-derived from persisted state, so it holds after a restart.
  const engine = engineFor('capacity-restart')
  for (let index = 0; index < 300; index += 1) {
    engine.record({ projectKey: PROJECT, eventId: `proposal-${index}`, kind: 'method', source: 'host_proposal',
      instruction: `导出报表字段 field${index} 时保留原始数值精度。` })
  }
  const reopened = new LearningEngine({ stateRoot: join(makeRoot(), 'capacity-restart'), adapterId: 'audit',
    now: () => NOW, evaluationTokensPerDay: 100_000, evaluationCallsPerDay: 8 })
  const prepared = reopened.prepare({ projectKey: PROJECT, sessionId: 'session', turnId: 'restart-correction',
    origin: 'user', prompt: '以后导出报表时保留原始空值，不要改成零。' })
  assert.equal(typeof prepared.learned?.id, 'string')
  const state = reopened.store.read()
  assert.equal(state.lessons.length, 300)
  assert.equal(state.lessons.filter(row => row.kind === 'correction').length, 1)
})

test('an open regression window is protected evidence, not free space', () => {
  const engine = engineFor('capacity-regression')
  const method = engine.record({ projectKey: PROJECT, eventId: 'm', kind: 'method', source: 'host_proposal',
    instruction: '导出报表金额时保留两位小数。' })
  const state = engine.store.read()
  const row = state.lessons.find(item => item.id === method.id)
  assert.ok(row)
  // Mark it as a refuted hypothesis with a live window, exactly the shape `put()` consults.
  engine.store.update(current => {
    const target = current.lessons.find(item => item.id === method.id)
    target.suspensionReason = 'regression'
    target.status = 'suspended'
    target.expiresAt = NOW + 90 * 86_400_000
  })
  const protectedIds = engine.protectedLessonIds(engine.store.read(), NOW)
  assert.equal(protectedIds.has(method.id), true)
})

// ---------------------------------------------------------------- independent acceptance set

test('the audit\u2019s 13 adjacent cases are answered as the review requires', async () => {
  // The eight input-protocol cases: every one of them carries the `prompt` FIELD, so all of
  // them are the prompted protocol and all must be refused before any ticket exists.
  const base = Array.from({ length: 12 }, (_, index) => ({ caseId: `c-${index}`, family: `f-${index % 2}`,
    split: index < 8 ? 'development' : 'holdout', checker: exact(`${index}`) }))
  const malformed = {
    empty: '', null: null, number: 3, 'undefined-own-property': undefined,
    'control-char': 'a\u0001bcd', 'illformed-unicode': 'ab\uD800cd', 'raw-oversize-collapsed': 'x'.repeat(407),
  }
  for (const [id, value] of Object.entries(malformed)) {
    const rows = base.map(row => ({ ...row, prompt: value }))
    const verdict = taskIndependence(rows)
    assert.equal(verdict.ok, false, id)
    assert.equal(verdict.code, CASE_REASONS.invalidPrompt, id)
    const engine = engineFor(`adjacent-${id}`)
    const lesson = engine.record({ projectKey: PROJECT, eventId: 'p', kind: 'method', source: 'host_proposal',
      instruction: '导出报表金额时使用数值字段，同时保留原始空值。' })
    let runnerCalls = 0
    await assert.rejects(() => runEvaluation(engine, { projectKey: PROJECT, lessonId: lesson.id, expectedVersion: 1,
      suiteId: `s-${id}`, cases: rows, maxTokens: 1000 },
    async () => { runnerCalls += 1; return { passed: true, guardPassed: true, tokens: 10 } }), undefined, id)
    const state = engine.store.read()
    assert.equal(runnerCalls, 0, `${id}: no runner call`)
    assert.equal(state.jobs.length, 0, `${id}: no ticket`)
    assert.equal(state.spends.filter(row => row.kind === 'evaluation').length, 0, `${id}: no debit`)
  }
  // The legacy shape (no row carries the field) is still the trusted-runner protocol.
  const legacy = base.map(({ ...row }) => row)
  assert.equal(taskIndependence(legacy).mode, 'trusted_runner')
  const engine = engineFor('adjacent-legacy')
  const lesson = engine.record({ projectKey: PROJECT, eventId: 'p', kind: 'method', source: 'host_proposal',
    instruction: '排名并列时按来源顺序保持稳定。' })
  let calls = 0
  const result = await runEvaluation(engine, { projectKey: PROJECT, lessonId: lesson.id, expectedVersion: 1,
    suiteId: 'legacy', cases: legacy, maxTokens: 1000 },
  async ({ arm }) => { calls += 1; return { passed: arm === 'candidate', guardPassed: true, tokens: 10 } })
  assert.equal(calls > 0, true)
  assert.equal(typeof result.decision, 'string')
})

test('conditions are decided only when the grammar consumes the whole sentence', () => {
  // Refused: an unread predicate behind a format word, a numeric constraint, an exclusion that
  // would exclude everything, and free Chinese prose. None of them may be admitted.
  const refused = [
    [{ applicability: '仅适用于管理员批准的 CSV 报表。', exclusions: '' }, '导出 CSV 报表金额。'],
    [{ applicability: '仅当 CSV 报表包含字段时。', exclusions: '' }, '导出 CSV 报表金额。'],
    [{ applicability: '仅在 CSV 报表必须备份时。', exclusions: '' }, '导出 CSV 报表金额。'],
    [{ applicability: '仅当金额为正时的 CSV 报表。', exclusions: '' }, '导出 CSV 报表金额。'],
    [{ applicability: '仅适用于税率为19%的 CSV 报表。', exclusions: '' }, '按17%税率导出 CSV 报表金额。'],
    [{ applicability: '', exclusions: '不适用于所有报表导出。' }, '导出 CSV 报表金额。'],
  ]
  for (const [lesson, prompt] of refused) {
    const verdict = conditionVerdict(lesson, analyze(prompt))
    assert.equal(verdict.ok, false, JSON.stringify(lesson))
    assert.equal(verdict.gate, 'condition_unclear', JSON.stringify(lesson))
  }
  // The grammar is a template match, not a keyword filter: only the wrapper and a short tail of
  // report/export words are consumed, so a leftover predicate cannot be deleted away.
  assert.equal(parseCondition('仅当 CSV 报表包含字段时。', 'applicability').kind, 'unsupported')
  assert.equal(parseCondition('仅在 CSV 报表必须备份时。', 'applicability').kind, 'unsupported')
  assert.deepEqual(parseCondition('适用于 CSV、TSV 的导出', 'applicability').allow, ['csv', 'tsv'])
  assert.deepEqual(parseCondition('CSV 导出场景', 'applicability').allow, ['csv'])
  assert.deepEqual(parseCondition('CSV 除外', 'exclusions').exclude, ['csv'])
  // Format identity is the matched atom, never a substring: `jsonl`/`ndjson` are not `json`, and
  // `xlsx` is not `xls`.
  assert.deepEqual(parseCondition('仅适用于 JSONL 格式的导出。', 'applicability').allow, ['jsonl'])
  assert.deepEqual(parseCondition('仅适用于 NDJSON 导出', 'applicability').allow, ['jsonl'])
  assert.deepEqual(parseCondition('仅适用于 XLSX 格式的导出。', 'applicability').allow, ['excel'])
  assert.equal(conditionVerdict({ applicability: '仅适用于 JSONL 格式的导出。', exclusions: '' },
    analyze('导出 JSON 报表。')).gate, 'condition_not_applicable')
  assert.equal(conditionVerdict({ applicability: '仅适用于 JSONL 格式的导出。', exclusions: '' },
    analyze('导出 JSONL 报表。')).ok, true)
  // A bare format template in the exclusions field is an exclusion: the field states polarity.
  assert.deepEqual(parseCondition('JSON 导出场景', 'exclusions').exclude, ['json'])
  assert.equal(conditionVerdict({ applicability: '', exclusions: 'JSON 导出场景' },
    analyze('导出 JSON 报表。')).gate, 'condition_excluded')
  assert.equal(conditionVerdict({ applicability: '', exclusions: 'JSON 导出场景' },
    analyze('导出 CSV 报表。')).ok, true)
  // `仅适用于所有 CSV 报表导出` is a CSV condition, not an unconditional one.
  const csvOnly = { applicability: '仅适用于所有 CSV 报表导出。', exclusions: '' }
  assert.equal(conditionVerdict(csvOnly, analyze('导出 JSON 报表金额。')).gate, 'condition_not_applicable')
  assert.equal(conditionVerdict(csvOnly, analyze('导出 CSV 报表金额。')).ok, true)
  // A negation later in the same sentence is not a positive assertion of that format.
  assert.equal(conditionVerdict({ applicability: '仅适用于 CSV 格式的报表导出。',
    exclusions: '不适用于 JSON 格式的报表导出。' },
  analyze('导出 CSV 报表金额，保留两位小数，不使用 JSON。')).ok, true)
  assert.equal(conditionVerdict({ applicability: '仅适用于 CSV 格式的报表导出。',
    exclusions: '不适用于 JSON 格式的报表导出。' },
  analyze('导出 JSON 报表金额，保留两位小数。')).gate, 'condition_excluded')
})

test('an explicit capability limit, not a hidden pass: free Chinese scenes stay refused', () => {
  // The review keeps this as a stated limitation rather than asking for substring matching on
  // Chinese scenario text. It is recorded here so the limit cannot be mistaken for coverage.
  const verdict = conditionVerdict({ applicability: '仅适用于月度财务结算报表。', exclusions: '' },
    analyze('生成本月财务结算报表。'))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.gate, 'condition_unclear')
})

test('conflicting format instructions in one task are refused, not resolved', () => {
  const lesson = { applicability: '仅适用于 CSV 格式的报表导出。', exclusions: '不适用于 JSON 格式的报表导出。' }
  const csv = '导出 CSV 报表金额，保留两位小数。'
  // Both orders: a later positive mention must not erase an earlier negation, and vice versa.
  for (const prompt of ['不使用 JSON；使用 JSON；' + csv, '使用 JSON；不使用 JSON；' + csv]) {
    const verdict = conditionVerdict(lesson, analyze(prompt))
    assert.equal(verdict.ok, false, prompt)
    assert.equal(verdict.gate, 'condition_unclear', prompt)
    assert.deepEqual(verdict.detail, ['json'], prompt)
  }
  // A purely negative mention is not an assertion, so the CSV positive control still recalls.
  assert.equal(conditionVerdict(lesson, analyze('导出 CSV 报表金额，保留两位小数，不使用 JSON。')).ok, true)
  assert.equal(conditionVerdict(lesson, analyze(csv)).ok, true)
  assert.equal(conditionVerdict(lesson, analyze('导出 JSON 报表金额，保留两位小数。')).gate, 'condition_excluded')
  // The facts are kept apart rather than merged into one flag.
  const mixed = analyze('不使用 JSON；使用 JSON；' + csv)
  assert.deepEqual(mixed.formats, ['csv'])
  assert.deepEqual(mixed.ambiguousFormats, ['json'])
  const mentions = Object.fromEntries(formatMentions('不使用 JSON；使用 JSON；' + csv).map(row => [row.id, row]))
  assert.equal(mentions.json.hasPositive, true)
  assert.equal(mentions.json.hasNegative, true)
  assert.equal(mentions.json.ambiguous, true)
  assert.equal(mentions.csv.hasPositive, true)
  assert.equal(mentions.csv.hasNegative, false)
})

test('a format needs a real word boundary to exist, and every alias is examined', () => {
  // A hit inside a longer ASCII word is not the format being named.
  assert.deepEqual(formatMentions('abccsvdef 里的东西'), [])
  assert.deepEqual(formatMentions('jsonl'), [{ id: 'jsonl', hasPositive: true, hasNegative: false, negated: false, ambiguous: false }])
  assert.deepEqual(formatMentions('ndjson'), [{ id: 'jsonl', hasPositive: true, hasNegative: false, negated: false, ambiguous: false }])
  // An invalid alias does not stand in for the group: `xlsx` is still found beside a bare `xls`
  // substring that has no boundary. `xlsx` and `xls` remain one curated group by design.
  assert.deepEqual(formatMentions('xlsx 导出'), [{ id: 'excel', hasPositive: true, hasNegative: false, negated: false, ambiguous: false }])
  assert.deepEqual(formatMentions('见 xlsx2 与 xls'), [{ id: 'excel', hasPositive: true, hasNegative: false, negated: false, ambiguous: false }])
  assert.deepEqual(formatMentions('tsvx'), [])
})

test('the short 仅/只 format prefix is a supported template, and only that', () => {
  // The Hermes PluginManager probe wrote these short forms; they are an explicit format
  // wrapper, so they must keep working.
  const lesson = { applicability: '仅 CSV 导出', exclusions: 'JSON 导出场景' }
  for (const form of ['仅 CSV 导出', '只 CSV 导出', '仅 CSV 格式的报表导出。', '仅 CSV 报表导出']) {
    const parsed = parseCondition(form, 'applicability')
    assert.equal(parsed.kind, 'format', form)
    assert.deepEqual(parsed.allow, ['csv'], form)
  }
  assert.equal(conditionVerdict(lesson, analyze('导出 CSV 报表金额，保留两位小数。')).ok, true)
  assert.equal(conditionVerdict(lesson, analyze('导出 JSON 报表金额，保留两位小数。')).gate, 'condition_excluded')
  // The short prefix does not turn `仅当…`/`仅在…` into a template: those still carry an
  // unknown predicate and stay refused.
  for (const form of ['仅当 CSV 报表包含字段时。', '仅在 CSV 报表必须备份时。', '仅当金额为正时的 CSV 报表。']) {
    assert.equal(parseCondition(form, 'applicability').kind, 'unsupported', form)
  }
})
