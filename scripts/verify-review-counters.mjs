// Independent-counterexample regression: every finding in dist/review-20261001-alpha3/REVIEW.md
// (R1-R7) is reproduced here with the FIXED expectation. Run from the product root:
//   node scripts/verify-review-counters.mjs
// Bundled fixtures keep the legacy shapes real; no model call, no daily profile, no writes
// outside temporary directories.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LearningEngine, RECALL_REASONS, reflect } from '../src/index.mjs'
import { analyze, relevance, admits } from '../src/recall.mjs'
import { createHarnessBridge } from '../adapters/harness.mjs'
import { handleMseCommand } from '../src/status.mjs'

const root = mkdtempSync(join(tmpdir(), 'mse-review-counters-'))
const fixtures = fileURLToPath(new URL('../tests/fixtures', import.meta.url))
const temporary = () => mkdtempSync(join(root, 'case-'))
const tick = () => new Promise(resolve => setImmediate(resolve))
const results = []
const record = (id, detail) => { results.push({ id, ok: true, detail }); }

let serial = 0
const correction = '以后导出金额前先转换为数值，再按金额排序'
const task = '请导出报表金额并核对结果'

function fixture({ projectKey, review, environmentId, seed = true, seedInstruction = correction } = {}) {
  const engine = new LearningEngine({ stateRoot: temporary(), adapterId: 'dsh' })
  const lesson = seed ? engine.record({ eventId: 'seed', source: 'direct_user', kind: 'correction',
    instruction: seedInstruction, ...(projectKey ? { projectKey } : {}) }) : null
  const session = { id: `probe-${++serial}`, header: projectKey ? { cwd: projectKey } : {}, events: [] }
  const bridge = createHarnessBridge({ engine, environmentId,
    createMessage: text => ({ id: `m-${++serial}`, role: 'user', source: { kind: 'plugin', plugin: 'mse-learning' }, content: [{ type: 'text', text }] }),
    review })
  const step = async (text, { turn = 1, stepNumber = 1 } = {}) => {
    const message = { id: `u-${++serial}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
    return bridge.preStep({ agent: { session, options: { provider: 'probe', model: 'probe' } }, step: stepNumber, turn, messages: [message],
      signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [message] }))
  }
  const finish = async messages => { for await (const _chunk of bridge.stream({ sessionId: session.id, messages },
    async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })) {} }
  const fail = () => {
    bridge.toolResult({ sessionId: session.id, turnId: 1, failed: true })
    bridge.sessionEvent(session, { type: 'assistant/message', data: { turn: 1, content: '金额被当作字符串排序，需要复查数据类型' } })
    bridge.sessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  }
  return { engine, bridge, session, step, finish, fail }
}

try {
  // ---- R1: questions, one-shot requests and relayed speech never become persistent corrections
  const refused = ['金额必须用人民币结算？', '金额改成人民币结算？', '仅这次把报表金额改成人民币', '他说"以后导出金额都用人民币"']
  const r1 = []
  for (const prompt of refused) {
    const engine = new LearningEngine({ stateRoot: temporary(), adapterId: 'dsh' })
    const learned = engine.prepare({ sessionId: `r1-${++serial}`, turnId: '1', prompt, origin: 'user' })
    const stored = engine.list({ lessons: 20 }).lessons.map(row => row.instruction)
    const later = engine.prepare({ sessionId: `r1-later-${serial}`, turnId: '1', prompt: task, origin: 'user' })
    assert.equal(stored.length, 0, `${prompt} must not be stored`)
    assert.equal(later.bytes, 0, `${prompt} must not inject into a later session`)
    r1.push({ prompt, learnedReason: learned.reason, stored: stored.length, laterBytes: later.bytes })
  }
  const control = new LearningEngine({ stateRoot: temporary(), adapterId: 'dsh' })
  const learnedControl = control.prepare({ sessionId: `r1-control-${++serial}`, turnId: '1', prompt: correction, origin: 'user' })
  const controlRecall = control.prepare({ sessionId: `r1-control-later-${serial}`, turnId: '1', prompt: task, origin: 'user' })
  const fieldReference = '记住：导出 CSV 时 `amount` 字段保留两位小数'
  const fieldEngine = new LearningEngine({ stateRoot: temporary(), adapterId: 'dsh' })
  const learnedField = fieldEngine.prepare({ sessionId: `r1-field-${++serial}`, turnId: '1', prompt: fieldReference, origin: 'user' })
  assert.equal(learnedControl.reason, RECALL_REASONS.correctionLearned)
  assert.equal(controlRecall.bytes, 130)
  assert.equal(learnedField.reason, RECALL_REASONS.correctionLearned)
  assert.equal(fieldEngine.list({}).lessons[0].instruction, '导出 CSV 时 `amount` 字段保留两位小数')
  record('R1', { refused: r1, controlBytes: controlRecall.bytes, inlineFieldKept: true })

  // ---- R2: closing one session cancels queued and in-flight reviews, leaving others alone
  const cancellation = async queued => {
    let release, started, signal, calls = 0
    const ready = new Promise(resolve => { started = resolve })
    const response = new Promise(resolve => { release = resolve })
    const probe = fixture({ review: (input, _route, abort) => {
      signal = abort
      calls += 1
      return reflect(probe.engine, input, async () => { started(); return response }, abort)
    } })
    await probe.step(task)
    probe.fail()
    if (!queued) await ready
    probe.bridge.closeSession(probe.session.id)
    await tick()
    const snapshot = { calls, aborted: signal?.aborted ?? null }
    release(JSON.stringify({ instruction: '导出金额时先确认数值类型，再检查排列顺序' }))
    await tick(); await tick()
    snapshot.candidatesAfterClose = probe.engine.status().counts.candidate
    return snapshot
  }
  const queued = await cancellation(true)
  const inFlight = await cancellation(false)
  assert.equal(queued.calls, 0, 'a queued review must not start after its session closed')
  assert.equal(queued.candidatesAfterClose, 0)
  assert.equal(inFlight.aborted, true, 'an in-flight review must be cancelled')
  assert.equal(inFlight.candidatesAfterClose, 0, 'a late result must not be written')
  let closedCalls = 0, survivorCalls = 0
  const closedOther = fixture({ review: async () => { closedCalls += 1 } })
  await closedOther.step(task)
  closedOther.fail()
  closedOther.bridge.closeSession(closedOther.session.id)
  await tick(); await tick()
  const survivor = fixture({ review: async () => { survivorCalls += 1 } })
  await survivor.step(task)
  survivor.fail()
  await tick(); await tick()
  assert.equal(closedCalls, 0, 'the closed session review never runs')
  assert.equal(survivorCalls, 1, 'closing one session must not stop another session review')
  record('R2', { queued, inFlight, closedSessionReviews: closedCalls, otherSessionReviews: survivorCalls })

  // ---- R3: alpha.2 stores keep their default environment identity in both adapters
  const r3 = []
  for (const adapterId of ['dsh', 'hermes']) {
    const stateRoot = join(temporary(), 'store')
    cpSync(join(fixtures, adapterId === 'dsh' ? 'legacy-alpha2-schema2' : 'legacy-alpha2-schema2-hermes'), stateRoot, { recursive: true })
    const engine = new LearningEngine({ stateRoot, adapterId })
    const instruction = engine.list({ limit: 20 }).lessons.find(row => row.kind === 'method').instruction
    const legacy = engine.prepare({ sessionId: `${adapterId}-legacy-${++serial}`, turnId: '1', prompt: instruction, origin: 'user' })
    const elsewhere = engine.prepare({ sessionId: `${adapterId}-other-${++serial}`, turnId: '1', prompt: instruction,
      origin: 'user', environmentId: 'another-toolchain' })
    assert.equal(legacy.reason, RECALL_REASONS.recalled, `${adapterId}: the alpha.2 method must still recall`)
    assert.ok(legacy.bytes > 0)
    assert.equal(elsewhere.bytes, 0, `${adapterId}: compatibility must not widen validation scope`)
    r3.push({ adapterId, legacyBytes: legacy.bytes, otherEnvironmentBytes: elsewhere.bytes })
  }
  record('R3', r3)

  // ---- R4: formats are related, not synonymous
  const formatCases = [
    { lesson: '以后导出 JSON 时必须用双引号包裹属性名', prompt: '导出 YAML 配置', expect: false },
    { lesson: '以后 YAML 配置禁止使用制表符缩进', prompt: '格式化 JSON 配置', expect: false },
    { lesson: '以后导出 JSON 时必须用双引号包裹属性名', prompt: '导出 JSON 配置', expect: true },
  ]
  const r4 = []
  for (const item of formatCases) {
    const evidence = relevance(analyze(item.prompt), analyze(item.lesson))
    const verdict = admits(evidence)
    assert.equal(verdict.ok, item.expect, `${item.prompt} vs ${item.lesson}`)
    const engine = new LearningEngine({ stateRoot: temporary(), adapterId: 'dsh' })
    engine.record({ eventId: 'record', kind: 'correction', source: 'direct_user', instruction: item.lesson })
    const recall = engine.prepare({ sessionId: `r4-${++serial}`, turnId: '1', prompt: item.prompt, origin: 'user' })
    assert.equal(recall.bytes > 0, item.expect, `${item.prompt} injection must match the gate`)
    r4.push({ lesson: item.lesson, prompt: item.prompt, gate: verdict.gate ?? 'accepted', bytes: recall.bytes })
  }
  record('R4', r4)

  // ---- R5: a match that does not fit is reported as budget_exhausted, never recalled
  const tight = new LearningEngine({ stateRoot: temporary(), adapterId: 'dsh', maxContextBytes: 128 })
  tight.record({ eventId: 'seed', source: 'direct_user', kind: 'correction', instruction: correction })
  const tightResult = tight.prepare({ sessionId: `r5-${++serial}`, turnId: '1', prompt: '导出金额并排序', origin: 'user' })
  const tightDiagnosis = tight.diagnose({ prompt: '导出金额并排序' })
  assert.equal(tightResult.reason, RECALL_REASONS.budgetExhausted)
  assert.equal(tightResult.bytes, 0)
  assert.equal(tightResult.lessons.length, 0)
  assert.equal(tightDiagnosis.prompted.reason, RECALL_REASONS.budgetExhausted)
  assert.equal(tightDiagnosis.prompted.wouldInjectBytes, 0)
  const wide = new LearningEngine({ stateRoot: temporary(), adapterId: 'dsh' })
  wide.record({ eventId: 'seed', source: 'direct_user', kind: 'correction', instruction: correction })
  const wideResult = wide.prepare({ sessionId: `r5-wide-${++serial}`, turnId: '1', prompt: '导出金额并排序', origin: 'user' })
  assert.equal(wideResult.reason, RECALL_REASONS.recalled)
  record('R5', { cappedReason: tightResult.reason, cappedBytes: tightResult.bytes, defaultReason: wideResult.reason, defaultBytes: wideResult.bytes })

  // ---- R6: the first status command already uses the trusted session project scope
  const projectKey = '/synthetic/project-scoped'
  const scoped = fixture({ projectKey })
  const beforeTurn = handleMseCommand(scoped.bridge, `now ${task}`, { sessionId: scoped.session.id, projectKey })
  assert.match(beforeTurn.text, /已召回/, 'the first command must see the project scope from the trusted header')
  assert.equal(scoped.bridge.recallStatus(scoped.session.id, projectKey).library.scopeKind, 'project')
  const cachedOnly = handleMseCommand(scoped.bridge, `now ${task}`, { sessionId: 'never-seen-session' })
  assert.equal(/已召回/u.test(cachedOnly.text) && !/控制器|无/u.test(cachedOnly.text), false,
    'without a trusted key the command must not claim a project-scoped recall')
  const decision = await scoped.step(task)
  assert.equal(decision.messages.length, 2)
  record('R6', { beforeTurnScope: 'project', actualInjection: decision.messages.length - 1 })

  // ---- R7: the status shows the settlement the core really recorded
  const settled = fixture({})
  const settledDecision = await settled.step(task)
  await settled.finish(settledDecision.messages)
  assert.equal(settled.bridge.verification({ sessionId: settled.session.id, turnId: 1, checkId: 'probe-check',
    passed: true, lessonIds: [settled.engine.list({}).lessons[0].id] }), true)
  settled.bridge.sessionEvent(settled.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(settled.engine.status().verified, 1)
  assert.equal(settled.bridge.lastRecall(settled.session.id).outcome, 'verified')
  const pending = fixture({})
  await pending.step(task)
  pending.engine.complete = () => { throw Object.assign(new Error('disk unavailable'), { code: 'state_unavailable' }) }
  pending.bridge.sessionEvent(pending.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(pending.bridge.lastRecall(pending.session.id).outcome, 'pending')
  assert.equal(pending.bridge.lastRecall(pending.session.id).settleError, 'state_unavailable')
  record('R7', { verifiedOutcome: 'verified', writeFailureOutcome: 'pending' })

  console.log(JSON.stringify({ ok: true, counters: results.length, results, modelCalls: 0 }, null, 2))
} finally {
  rmSync(root, { recursive: true, force: true })
}
