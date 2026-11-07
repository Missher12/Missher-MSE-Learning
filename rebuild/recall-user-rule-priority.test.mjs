import test from 'node:test'
import assert from 'node:assert/strict'
import { loadDefaultCases } from '../scripts/rsi/replay.mjs'
import { replayRecall, selectRecall } from './recall.mjs'
import { selectRecallWithUserRulePriority } from './recall-user-rule-priority.mjs'

const cases = loadDefaultCases()
const indent = cases.find(row => row.id === 'rsi-02-indent-error-exact')
const optionsFor = row => ({ prompt: row.prompt, scope: row.scope, environment: row.environment, now: 0 })
const ids = selection => selection.offered.map(row => row.id)
const guardEntry = () => ({ ...structuredClone(indent.entries[0]), id: `mem_${'b'.repeat(24)}`,
  type: 'lesson', status: 'needs_revision', instruction: 'YAML 缩进错误时先确认列表层级再解析配置',
  applicability: '', lesson: { problemId: 'b'.repeat(64), evidenceIds: [], repairSteps: ['确认缩进'],
    verification: { check: '解析 YAML', expected: '成功' } }, updatedAt: 1 })

test('the hand-labelled indent error case promotes only the relevant saved user rule', () => {
  const result = selectRecallWithUserRulePriority(indent.entries, optionsFor(indent))
  assert.deepEqual(ids(result), ['mem_rsi_indent_fix', 'mem_rsi_indent_levels'])
  assert.ok(result.bytes <= 768)
})

test('a normalized user-rule candidate cannot displace a baseline lesson', () => {
  const lesson = { ...structuredClone(indent.entries[0]), id: `mem_${'a'.repeat(24)}`,
    type: 'lesson', status: 'check_passed', instruction: '检查 YAML 配置的缩进层级并验证列表结构后解析文件',
    applicability: '', lesson: { problemId: 'a'.repeat(64), evidenceIds: [], repairSteps: ['校验层级'],
      verification: { check: '解析 YAML', expected: '成功' } }, updatedAt: 1 }
  const entries = [indent.entries[0], indent.entries[2], lesson]
  const selected = selectRecallWithUserRulePriority(entries, optionsFor(indent))
  assert.deepEqual(ids(selected), [`mem_rsi_indent_fix`, lesson.id])
})

test('a normalized user-rule candidate retains the baseline guard', () => {
  const guard = guardEntry()
  const selected = selectRecallWithUserRulePriority([...indent.entries, guard], optionsFor(indent))
  assert.deepEqual(ids(selected), ['mem_rsi_indent_fix', 'mem_rsi_indent_levels', guard.id])
  assert.equal(selected.offered.at(-1).mode, 'guard')
})

test('scoped-out, excluded, and retired user rules never gain recall from normalization', () => {
  const restricted = [
    { ...structuredClone(indent.entries[2]), visibility: 'scoped', originScope: 'other-scope' },
    { ...structuredClone(indent.entries[2]), exclusions: '缩进' },
    { ...structuredClone(indent.entries[2]), status: 'retired' },
  ]
  for (const target of restricted) {
    const entries = [indent.entries[0], indent.entries[1], target]
    assert.deepEqual(ids(selectRecallWithUserRulePriority(entries, optionsFor(indent))),
      ids(selectRecall(entries, optionsFor(indent))))
    assert.ok(!ids(selectRecallWithUserRulePriority(entries, optionsFor(indent))).includes(target.id))
  }
})

test('ordinary synonym wording finds the matching rule while an unrelated topic stays empty', () => {
  const synonym = { ...optionsFor(indent), prompt: 'YAML 配置缩进异常，帮我整理列表层级' }
  assert.deepEqual(ids(selectRecallWithUserRulePriority(indent.entries, synonym)),
    ['mem_rsi_indent_levels', 'mem_rsi_indent_fix'])
  const unrelated = { ...optionsFor(indent), prompt: '更新 API 超时文档' }
  assert.deepEqual(ids(selectRecallWithUserRulePriority(indent.entries, unrelated)), [])
  assert.deepEqual(ids(selectRecallWithUserRulePriority(indent.entries, unrelated)),
    ids(selectRecall(indent.entries, unrelated)))
})

test('the shared helper changes only the labelled case and preserves the excluded-only control', () => {
  const baseline = replayRecall(cases, selectRecall)
  const candidate = replayRecall(cases, selectRecallWithUserRulePriority)
  assert.equal(cases.length, 34)
  assert.deepEqual({ miss: baseline.miss, falseOffer: baseline.falseOffer }, { miss: 1, falseOffer: 2 })
  assert.deepEqual({ miss: candidate.miss, falseOffer: candidate.falseOffer }, { miss: 0, falseOffer: 1 })
  const changed = candidate.cases.filter((row, index) =>
    JSON.stringify(row.selected) !== JSON.stringify(baseline.cases[index].selected))
  assert.deepEqual(changed.map(row => row.id), ['rsi-02-indent-error-exact'])
  assert.deepEqual(changed[0].selected, ['mem_rsi_indent_fix', 'mem_rsi_indent_levels'])
  const control = candidate.cases.find(row => row.id === 'rsi-09-excluded-only')
  assert.deepEqual(control.falseOffer, ['mem_rsi_excluded_doc'])
})
