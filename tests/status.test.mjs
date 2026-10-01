import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningEngine, RECALL_REASONS } from '../src/index.mjs'
import { createHarnessBridge } from '../adapters/harness.mjs'
import { formatRecallStatus, formatDiagnosis, handleMseCommand, REASON_LABELS } from '../src/status.mjs'

function fixture(t, options = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-status-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const engine = options.engine ?? new LearningEngine({ stateRoot, adapterId: 'dsh' })
  let id = 0
  const bridge = createHarnessBridge({ engine,
    createMessage: text => ({ id: `plugin-${++id}`, role: 'user', source: { kind: 'plugin', plugin: 'mse-learning' }, content: [{ type: 'text', text }] }),
    ...options })
  const session = { id: 'status-session', header: {}, events: [] }
  const makeMessage = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const step = async (text, turn = 1) => {
    const message = makeMessage(text)
    const payload = { agent: { session }, step: 1, turn, messages: [message], signal: new AbortController().signal }
    return bridge.preStep(payload, async () => ({ kind: 'enter', messages: [message] }))
  }
  return { engine, bridge, session, step, makeMessage }
}
const settled = () => new Promise(resolve => setImmediate(resolve))

test('every reason has a user-facing label and the short status reports count, bytes and reason', async t => {
  const { bridge, step, session } = fixture(t)
  await step('以后导出金额前先转换为数值，再按金额排序', 1)
  const vision = handleMseCommand(bridge, '', session.id)
  assert.equal(vision.kind, 'success')
  assert.match(vision.text, /已学到本轮纠错/)
  assert.match(vision.text, /本轮 turn 1/)
  const recalled = await step('导出金额并排序', 2)
  assert.equal(recalled.messages.length, 2)
  const status = bridge.recallStatus(session.id)
  assert.equal(status.last.reason, RECALL_REASONS.recalled)
  assert.equal(status.last.bytes > 0, true)
  assert.equal(status.last.lessons.length, 1)
  const text = handleMseCommand(bridge, '', session.id).text
  assert.match(text, new RegExp(`已召回 1 条 / ${status.last.bytes} 字节`))
  assert.match(text, /（recalled）/)
  assert.equal(Object.values(RECALL_REASONS).every(reason => REASON_LABELS[reason]), true)
  assert.match(text, /不进入模型上下文/)
  const detail = handleMseCommand(bridge, 'why', session.id)
  assert.equal(detail.kind, 'success')
  assert.match(detail.text, /本轮来源/)
  assert.match(detail.text, /转换为数值/)
  assert.match(detail.text, /最近轮次/)
})

test('the status surface never becomes model context and never consumes recall budget', async t => {
  const { engine, bridge, session, step } = fixture(t)
  await step('以后导出金额前先转换为数值，再按金额排序', 1)
  const decision = await step('导出金额并排序', 2)
  assert.equal(decision.messages.length, 2)
  const beforeBytes = engine.diagnose({ sessionId: session.id }).session.bytes
  const beforeMessages = decision.messages.map(message => JSON.stringify(message))
  for (const input of ['', 'why', 'now 导出金额并排序', 'bogus']) {
    const result = handleMseCommand(bridge, input, session.id)
    assert.ok(['success', 'error'].includes(result.kind))
    assert.equal(result.text.includes('mse-learning'), false, 'a status row is not a plugin context message')
  }
  assert.equal(engine.diagnose({ sessionId: session.id }).session.bytes, beforeBytes, 'status must not spend recall budget')
  const after = await step('导出金额并排序', 3)
  assert.equal(after.messages.length, 1, 'status calls do not become injected messages')
  assert.deepEqual(decision.messages.map(message => JSON.stringify(message)), beforeMessages)
})

test('status distinguishes internal-task skips, store failures and an unknown command', async t => {
  const { bridge, session, makeMessage } = fixture(t)
  const message = makeMessage('Review the conversation above and update the skill library now.')
  await bridge.preStep({ agent: { session }, step: 1, turn: 7, messages: [message], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [message] }))
  const internal = bridge.recallStatus(session.id)
  assert.equal(internal.last.reason, RECALL_REASONS.internalTask)
  assert.equal(internal.last.skipped, 'internal_review_text')
  assert.match(handleMseCommand(bridge, '', session.id).text, /内部任务跳过/)
  const usage = handleMseCommand(bridge, 'nonsense', session.id)
  assert.equal(usage.kind, 'error')
  assert.match(usage.text, /用法/)
  const empty = handleMseCommand(bridge, 'now', session.id)
  assert.equal(empty.kind, 'error')

  const failing = createHarnessBridge({ engine: { prepare() { throw Object.assign(new Error('disk unavailable'), { code: 'state_unavailable' }) },
    diagnose() { throw Object.assign(new Error('disk unavailable'), { code: 'state_unavailable' }) } },
  createMessage() { throw new Error('unreachable') } })
  const ordinary = makeMessage('导出金额并排序')
  await failing.preStep({ agent: { session }, step: 1, turn: 8, messages: [ordinary], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [ordinary] }))
  const failure = failing.recallStatus(session.id)
  assert.equal(failure.last.reason, RECALL_REASONS.storeFailure)
  assert.equal(failure.last.code, 'state_unavailable')
  assert.equal(failure.library, null)
  assert.match(handleMseCommand(failing, '', session.id).text, /存储失败/)
})

test('a dry-run diagnosis explains a miss without injecting anything', async t => {
  const { engine, bridge, session, step, makeMessage } = fixture(t)
  await step('以后导出金额前先转换为数值，再按金额排序', 1)
  const decision = await step('查询明天的天气情况', 2)
  assert.equal(decision.messages.length, 1)
  assert.equal(bridge.recallStatus(session.id).last.reason, RECALL_REASONS.matchInsufficient)
  const command = handleMseCommand(bridge, 'now 导出金额并排序', session.id)
  assert.equal(command.kind, 'success')
  assert.match(command.text, /只读诊断/)
  assert.match(command.text, /已召回/)
  const direct = formatDiagnosis(bridge.diagnose({ sessionId: session.id, prompt: '查询明天的天气情况' }))
  assert.match(direct, /匹配不足/)
  // Nothing was offered yet, so the read-only dry run may report a real recall…
  assert.equal(bridge.diagnose({ sessionId: session.id, prompt: '导出金额并排序' }).prompted.reason, RECALL_REASONS.recalled)
  const payload = { agent: { session }, step: 1, turn: 9, messages: [makeMessage('导出金额并排序')], signal: new AbortController().signal }
  const turnNine = await bridge.preStep(payload, async () => ({ kind: 'enter', messages: payload.messages }))
  assert.equal(turnNine.messages.length, 2, 'the diagnosis did not consume the recall for that turn')
  // …and after that turn offered it, the same session reports 已提供过 instead of offering again.
  assert.equal(bridge.diagnose({ sessionId: session.id, prompt: '导出金额并排序' }).prompted.reason, RECALL_REASONS.alreadyOffered)
  assert.equal(bridge.diagnose({ sessionId: 'another-session', prompt: '导出金额并排序' }).prompted.reason, RECALL_REASONS.recalled)
})

test('formatting tolerates a library that cannot be read and stays bounded', async t => {
  const unreadable = formatRecallStatus({ ok: true, last: null, recent: [], library: null, libraryError: 'invalid_store' })
  assert.match(unreadable, /库不可读：invalid_store/)
  assert.match(unreadable, /原因码/)
  const { bridge, session } = fixture(t)
  const bounded = formatRecallStatus(bridge.recallStatus(session.id), { detail: true, lessons: [] })
  assert.ok(Buffer.byteLength(bounded) < 2000)
  const diagnosis = formatDiagnosis({ ok: false, code: 'state_unavailable' })
  assert.match(diagnosis, /state_unavailable/)
})

test('bridge status entries stay bounded and report the newest turn', async t => {
  const { bridge, session, step } = fixture(t)
  await step('以后导出金额并排序前先检查数值类型', 1)
  for (let turn = 2; turn < 14; turn++) await step(`查询明天的天气情况 ${turn}`, turn)
  const report = bridge.recallStatus(session.id)
  assert.ok(report.recent.length <= 8)
  assert.equal(report.last.turn, '13')
  assert.ok(report.recent.every(row => typeof row.reason === 'string'))
  await settled()
})
