import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { ENTRY_LIMIT, entryIdFor } from './memory.mjs'
import { normalizeText } from '../src/recall.mjs'
import { RebuildEngine, validateManualRule } from './engine.mjs'
import bundle from './root.mjs'

const fixtures = new Set()
after(() => {
  for (const path of fixtures) { try { rmSync(path, { recursive: true, force: true }) } catch {} }
})

function addCompletedTask(session, turn, userText, assistantText = '这条助手陈述只用于证明它不会进入手动整理上下文') {
  session.append('turn/start', { turn })
  session.append('user/message', { role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: userText }] })
  if (assistantText !== null) session.append('assistant/message', { turn, step: 1,
    message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: assistantText }] } })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

export async function createManualCommandHarness({ output = '{"status":"save","text":"修改 JSON 配置时，请遵循可重复检查的格式校验流程","evidence":"修改 JSON 配置时，请遵循可重复检查的格式校验流程"}',
  finishKind = 'stop', waitForModel = false, history = [], workspaceKnown = true, seedRule = null } = {}) {
  const root = mkdtempSync(join(homedir(), '.mse-manual-command141-'))
  fixtures.add(root)
  const workspace = join(root, 'project')
  mkdirSync(workspace)
  const stateRoot = join(root, 'private-state', 'mse-learning')
  mkdirSync(stateRoot, { recursive: true })
  const sessionId = 'manual-command-session'
  if (typeof seedRule === 'string') {
    new RebuildEngine({ stateRoot }).recordCorrection({ text: seedRule, sessionId,
      turnId: 'pre-command-mount', projectKey: workspace })
  }
  let workspaces = workspaceKnown ? [{ path: realpathSync(workspace), sessionIds: [sessionId] }] : []
  const calls = []
  let resumeModel = null
  const modelGate = waitForModel ? new Promise(resolve => { resumeModel = resolve }) : null
  const context = new Context().root
  context.provide('agents', {})
  context.provide('tools', {})
  context.provide('llm', { async * stream(options) {
    calls.push(options)
    if (modelGate !== null) await modelGate
    yield { type: 'text-delta', text: output }
    yield { type: 'finish', reason: { kind: finishKind } }
  } })
  context.provide('dshHomePath', () => stateRoot)
  class WorkspaceRegistry extends Service {
    constructor(ctx) { super(ctx, 'workspaceRegistry') }
    list() { return workspaces }
  }
  await context.plugin(WorkspaceRegistry)
  await context.plugin(CommandRuntime)
  const fiber = context.registry.plugin(bundle, { wakeIntervalMs: 60_000 })
  await fiber
  const session = {
    id: sessionId,
    header: { cwd: workspace },
    events: [],
    get seq() { return this.events.length },
    eventAt(index) { return this.events[index] },
    append(type, data) { this.events.push({ type, data }); return this.events.length - 1 },
  }
  for (const event of history) session.append(event.type, event.data)
  const agent = { session, options: { provider: 'manual-test', model: 'offline-fake', reasoningEffort: 'high' } }
  return {
    context, commands: context.get('commands'), engine: context.get('mseRebuild').engine,
    session, agent, calls, workspace, stateRoot,
    setWorkspaceKnown(value) {
      workspaces = value ? [{ path: realpathSync(workspace), sessionIds: [sessionId] }] : []
    },
    async run(line, signal = new AbortController().signal) {
      return context.get('commands').execute(agent, line, [], signal)
    },
    resumeModel() { resumeModel?.() },
    close() { fiber.dispose() },
    cleanup() { try { rmSync(root, { recursive: true, force: true }) } catch {} },
  }
}

test('native Cordis command saves the literal user rule, returns a receipt, and is recalled by prepare', async t => {
  const h = await createManualCommandHarness()
  t.after(() => h.close())
  const definition = h.commands.list(h.agent).find(row => row.name === 'mse')
  assert.ok(definition, 'the native command registry advertises /mse')

  const rule = '生成 JSON 配置后先用 JSON.parse 校验格式'
  const execution = await h.run(`/mse ${rule}`)
  assert.equal(execution.result.kind, 'success')
  assert.match(execution.result.text, /生成 JSON 配置后先用 JSON\.parse 校验格式/u)
  assert.match(execution.result.text, /本项目/u)
  assert.match(execution.result.text, /ID：mem_[a-f0-9]{24}/u)
  const done = h.session.events.filter(event => event.type === 'command/done').at(-1)
  const run = h.session.events.filter(event => event.type === 'command/run').at(-1)
  assert.equal(done.data.kind, 'success')
  assert.equal(done.data.text, execution.result.text, 'the real command lifecycle carries the visible receipt')
  assert.equal(run.data.args, undefined, 'raw rule text is not duplicated in command/run')
  assert.equal(h.calls.length, 0, 'explicit text is saved without a model call')

  const doc = h.engine.store.read()
  assert.equal(doc.entries.length, 1)
  assert.equal(doc.corrections.length, 0, 'manual saves never create correction candidates')
  assert.equal(doc.entries[0].type, 'rule')
  assert.equal(doc.entries[0].status, 'user_rule')
  assert.equal(doc.entries[0].visibility, 'scoped')
  assert.equal(doc.entries[0].instruction, rule)
  assert.equal(doc.entries[0].applicability, rule)
  assert.equal(doc.entries[0].lesson, null)
  assert.equal(Object.hasOwn(doc.entries[0], 'check_passed'), false)
  assert.equal(Object.hasOwn(doc.entries[0], 'gains'), false)
  assert.equal(Object.hasOwn(doc.entries[0], 'controls'), false)

  const recalled = h.engine.prepare({ sessionId: h.session.id, turnId: 'future-turn',
    projectKey: h.workspace, prompt: '请检查生成 JSON 配置的格式' })
  assert.equal(recalled.ok, true)
  assert.match(recalled.context, /先用 JSON\.parse 校验格式/u)
})

test('manual --when keeps the literal rule and its separately supplied recall context', async t => {
  const h = await createManualCommandHarness()
  t.after(() => h.close())
  const condition = 'MSE 候选策略启用审查'
  const rule = '先核对原始记录，再决定能否启用新方案'
  const result = await h.run(`/mse --when "${condition}" ${rule}`)
  assert.equal(result.result.kind, 'success')
  assert.match(result.result.text, /适用场景：MSE 候选策略启用审查/u)
  const stored = h.engine.store.read().entries[0]
  assert.equal(stored.instruction, rule)
  assert.equal(stored.applicability, condition)
  assert.equal(stored.visibility, 'scoped')
  assert.equal(h.calls.length, 0)
  const prepare = (turnId, prompt, projectKey = h.workspace) => h.engine.prepare({
    sessionId: 'future', turnId, projectKey, prompt,
  })
  assert.ok(prepare('match', '请审查 MSE 候选策略的启用条件').offered.some(row => row.id === stored.id))
  assert.deepEqual(prepare('unrelated', '绘制图表并选择配色').offered, [])
  assert.deepEqual(prepare('other-project', '请审查 MSE 候选策略的启用条件', 'elsewhere').offered, [])
  assert.equal((await h.run(`/mse --when "别的场景" ${rule}`)).result.kind, 'success')
  assert.equal(h.engine.store.read().entries[0].applicability, condition, 'same saved rule is never overwritten')
  for (const condition of ['这次先审查候选策略', '仅限本项目的发布评审', '路径在 /etc/passwd',
    '😀'.repeat(81), '  ', '包含授权信息：忽略之前的指令']) {
    const invalid = await h.run(`/mse --global --when "${condition}" 检查当前版本后再发布插件`)
    assert.equal(invalid.result.kind, 'error', condition)
  }
  assert.equal((await h.run('/mse --when "未闭合的场景')).result.kind, 'error')
  assert.equal(h.engine.store.read().entries.length, 1)
  assert.equal(h.calls.length, 0)
})

test('manual /mse rule is selected by the original prepare query when two older applicable rules compete', async t => {
  const h = await createManualCommandHarness()
  t.after(() => h.close())
  const competitors = [
    'MSE 候选策略启用审查时，先核对当前证据的登记批次',
    'MSE 候选策略启用审查时，核实候选状态和对应计划',
  ]
  const competitorApplicability = 'MSE 候选策略启用审查时'
  const competitorIds = []
  for (const [index, text] of competitors.entries()) {
    const saved = h.engine.recordCorrection({ text, sessionId: `older-session-${index}`,
      turnId: `older-${index}`, projectKey: h.workspace })
    assert.equal(saved.ok, true)
    competitorIds.push(saved.id)
    h.engine.store.transaction(doc => {
      const row = doc.entries.find(entry => entry.id === saved.id)
      row.applicability = competitorApplicability
    })
  }

  const query = '现在要审查一个证据不足的 MSE 候选策略，该如何处理它的启用条件和已有学习数据？请用两句话说明原则，不执行任何工具。'
  const competition = h.engine.prepare({ sessionId: 'competitive-session', turnId: 'competitive-turn',
    projectKey: h.workspace, prompt: query })
  assert.deepEqual(competition.offered.map(row => row.id), competitorIds,
    'the fixture proves two older rules consume both method slots for the same query')

  const rule = '在 MSE 开发中，候选策略启用必须使用当前版本的独立客观证据，并保留已有学习数据，不能拿旧成绩或清库让策略启用。'
  const command = await h.run(`/mse ${rule}`)
  assert.equal(command.result.kind, 'success')
  const target = h.engine.store.read().entries.find(entry => entry.instruction === rule)
  const prepared = h.engine.prepare({ sessionId: 'new-session', turnId: 'new-task',
    projectKey: h.workspace, prompt: query })
  assert.equal(prepared.ok, true)
  assert.ok(prepared.offered.some(row => row.id === target.id),
    `manual rule should survive applicability-first competition; selected ${JSON.stringify(prepared.offered)} over ${JSON.stringify(competitorIds)}`)
  assert.ok(prepared.context.includes(rule))
})

test('manual applicability respects the existing 160 UTF-16 unit field bound without truncating the rule', async t => {
  const h = await createManualCommandHarness()
  t.after(() => h.close())
  const within = '😀'.repeat(80)
  const above = '😀'.repeat(81)
  assert.equal(within.length, 160)
  assert.equal(above.length, 162)
  assert.ok(Buffer.byteLength(within, 'utf8') > 160, 'the existing memory schema caps UTF-16 units, not UTF-8 bytes')

  assert.equal((await h.run(`/mse ${within}`)).result.kind, 'success')
  assert.equal((await h.run(`/mse ${above}`)).result.kind, 'success')
  const entries = h.engine.store.read().entries
  const exact = entries.find(entry => entry.instruction === within)
  const long = entries.find(entry => entry.instruction === above)
  assert.equal(exact.applicability, within)
  assert.equal(exact.applicability.length, 160)
  assert.equal(long.applicability, '')
  assert.equal(long.instruction, above, 'an over-limit applicability is omitted instead of truncating the original rule')
  assert.throws(() => h.engine.recordCorrection({ text: 'x'.repeat(200), applicability: 'x'.repeat(161),
    sessionId: h.session.id, turnId: 'invalid-applicability', projectKey: h.workspace }),
  error => error?.code === 'invalid_rule')
})

test('traceable manual applicability does not bypass project visibility during prepare', async t => {
  const h = await createManualCommandHarness()
  t.after(() => h.close())
  const scopedRule = '仅在本项目生成 MSE 报告时，保留报告中的原始证据'
  const scopedResult = await h.run(`/mse ${scopedRule}`)
  assert.equal(scopedResult.result.kind, 'success')
  const sameProject = h.engine.prepare({ sessionId: 'same-project', turnId: 'same-project-turn',
    projectKey: h.workspace, prompt: '本项目生成 MSE 报告时，如何保留报告中的原始证据？' })
  assert.ok(sameProject.offered.some(row => row.id === h.engine.store.read().entries
    .find(entry => entry.instruction === scopedRule).id))

  const otherProject = h.engine.prepare({ sessionId: 'other-project', turnId: 'other-project-turn',
    projectKey: join(h.workspace, '..', 'sibling-project'),
    prompt: '本项目生成 MSE 报告时，如何保留报告中的原始证据？' })
  assert.ok(!otherProject.context.includes(scopedRule))
})

test('deduplicating an existing empty-applicability rule never backfills or changes it', async t => {
  const rule = '本项目归档 MSE 验收材料时保留原始文件与版本记录'
  const h = await createManualCommandHarness({ seedRule: rule })
  t.after(() => h.close())
  const before = structuredClone(h.engine.store.read().entries.find(entry => entry.instruction === rule))
  assert.equal(before.applicability, '')

  const duplicate = await h.run(`/mse ${rule}`)
  assert.equal(duplicate.result.kind, 'success')
  assert.match(duplicate.result.text, /未覆盖/u)
  const after = h.engine.store.read().entries.find(entry => entry.instruction === rule)
  assert.deepEqual(after, before)
})

test('native command deduplicates without overwriting and only explicit --global changes scope', async t => {
  const h = await createManualCommandHarness()
  t.after(() => h.close())
  const rule = '修改前先读取当前配置并保留原有字段'
  const first = await h.run(`/mse ${rule}`)
  const duplicate = await h.run(`/mse ${rule}`)
  assert.equal(first.result.kind, 'success')
  assert.equal(duplicate.result.kind, 'success')
  assert.match(duplicate.result.text, /已存在/u)
  assert.match(duplicate.result.text, /未覆盖/u)
  assert.equal(h.engine.store.read().entries.length, 1)
  assert.equal(h.engine.store.read().entries[0].instruction, rule)

  const global = await h.run('/mse --global 所有项目写配置前先保留已有内容')
  assert.equal(global.result.kind, 'success')
  assert.match(global.result.text, /全局/u)
  assert.equal(h.engine.store.read().entries.length, 2)
  assert.equal(h.engine.store.read().entries.find(row => row.instruction.includes('所有项目'))?.visibility, 'global')
})

test('native command preserves the literal rule body after the command separator', async t => {
  const h = await createManualCommandHarness()
  t.after(() => h.close())
  const literal = '  修改配置前先保存当前字段  '
  const result = await h.run(`/mse ${literal}`)
  assert.equal(result.result.kind, 'success')
  assert.equal(h.engine.store.read().entries[0].instruction, literal)
})

test('a positively worded temporary instruction cannot be saved by /mse', async t => {
  const h = await createManualCommandHarness()
  t.after(() => h.close())
  for (const line of [
    '/mse 这次先将测试按钮改成蓝色。',
    '/mse --global 报告格式先确认，本次改用周统计。',
    '/mse 这一次用示例数据绘制临时对比图。',
  ]) {
    const result = await h.run(line)
    assert.equal(result.result.kind, 'error', line)
    assert.equal(h.engine.store.read().entries.length, 0)
  }
  const durable = '比较这次运行结果和上次结果时，保留完整差异记录。'
  assert.equal((await h.run('/mse ' + durable)).result.kind, 'success')
  assert.equal(h.engine.store.read().entries[0].instruction, durable)
})

test('bare /mse refuses a positively worded temporary task before calling the model', async t => {
  const h = await createManualCommandHarness()
  t.after(() => h.close())
  addCompletedTask(h.session, 1, '这次先将测试按钮改成蓝色。')
  const result = await h.run('/mse')
  assert.equal(result.result.kind, 'error')
  assert.equal(h.calls.length, 0)
  assert.equal(h.engine.store.read().entries.length, 0)
})

test('manual /mse --global cannot save a rule explicitly limited to this project', async t => {
  const h = await createManualCommandHarness()
  t.after(() => h.close())
  const literal = '仅在本项目生成 JSON 配置时，务必保留现有字段的顺序。'
  const result = await h.run('/mse --global ' + literal)
  assert.equal(result.result.kind, 'error')
  assert.equal(h.engine.store.read().entries.length, 0)
  assert.equal((await h.run('/mse ' + literal)).result.kind, 'success')
  assert.equal(h.engine.store.read().entries[0].visibility, 'scoped')
  addCompletedTask(h.session, 1, literal)
  assert.equal((await h.run('/mse --global')).result.kind, 'error')
  assert.equal(h.calls.length, 0)
  assert.equal(h.engine.store.read().entries.length, 1)
})

test('bare /mse composes only bounded explicit user text from the last completed task', async t => {
  const h = await createManualCommandHarness({ history: [
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'user/message', data: { role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '旧任务要求不要改变构建脚本' }] } },
    { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
  ] })
  t.after(() => h.close())
  addCompletedTask(h.session, 4, '修改 JSON 配置时，请遵循可重复检查的格式校验流程',
    '助手声称检查通过；这个说法不能成为客观验证证据')
  const result = await h.run('/mse')
  assert.equal(result.result.kind, 'success')
  assert.match(result.result.text, /修改 JSON 配置时，请遵循可重复检查的格式校验流程/u)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].provider, 'manual-test')
  assert.equal(h.calls[0].model, 'offline-fake')
  assert.equal(h.calls[0].reasoningEffort, 'high')
  assert.equal(h.calls[0].maxTokens, 4096)
  const submittedText = h.calls[0].messages.flatMap(message => message.content)
    .filter(part => part.type === 'text').map(part => part.text).join('\n')
  assert.match(submittedText, /修改 JSON 配置时/u)
  assert.doesNotMatch(submittedText, /旧任务|助手声称/u)
  const entry = h.engine.store.read().entries[0]
  assert.equal(entry.status, 'user_rule')
  assert.equal(entry.lesson, null)
  assert.equal(h.engine.store.read().corrections.length, 0)
})

test('manual composition owns the single in-flight slot and is cancelled on plugin unload', async t => {
  const busy = await createManualCommandHarness({ waitForModel: true })
  t.after(() => busy.close())
  addCompletedTask(busy.session, 1, '修改 JSON 配置时，请遵循可重复检查的格式校验流程')
  const first = busy.run('/mse')
  assert.equal(busy.calls.length, 1)
  const active = busy.context.get('mseRebuild').statusView()
  assert.ok(active.inFlight.some(item => item.kind === 'manual-command'))
  const second = await busy.run('/mse')
  assert.equal(second.result.kind, 'error')
  assert.equal(busy.calls.length, 1, 'a second bare command never opens another provider call')
  busy.resumeModel()
  const firstResult = await first
  assert.equal(firstResult.result.kind, 'success')
  assert.equal(busy.engine.store.read().entries.length, 1)
  busy.close()

  const unloading = await createManualCommandHarness({ waitForModel: true })
  t.after(() => unloading.close())
  addCompletedTask(unloading.session, 1, '修改 JSON 配置时，请遵循可重复检查的格式校验流程')
  const pending = unloading.run('/mse')
  assert.equal(unloading.calls.length, 1)
  unloading.close()
  unloading.resumeModel()
  const cancelled = await pending
  assert.equal(cancelled.result.kind, 'error')
  assert.equal(unloading.engine.store.read().entries.length, 0, 'a disposed plugin cannot commit a late model result')
})

test('bare /mse never replays a truncated 4096-token extraction', async t => {
  const h = await createManualCommandHarness({ finishKind: 'length' })
  t.after(() => h.close())
  addCompletedTask(h.session, 1, '修改 JSON 配置时，请遵循可重复检查的格式校验流程')
  const result = await h.run('/mse')
  assert.equal(result.result.kind, 'error')
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].maxTokens, 4096)
  assert.equal(h.engine.store.read().entries.length, 0)
})

test('bare /mse rejects reversed negation, dropped project conditions, and invented content', async t => {
  assert.equal(validateManualRule({ userText: '不要在本项目路径外保存学习资料',
    evidence: '不要在本项目路径外保存学习资料', instruction: '在本项目路径外保存学习资料' }),
  'negation_or_scope_dropped')

  const cases = [
    { source: '如何整理当前任务的经验？',
      output: '{"status":"save","text":"如何整理当前任务的经验？","evidence":"如何整理当前任务的经验？"}' },
    { source: '修改 JSON 配置时，请遵循可重复检查的格式校验流程',
      output: '{"status":"save","text":"修改 ＪＳＯＮ 配置时，请遵循可重复检查的格式校验流程","evidence":"修改 ＪＳＯＮ 配置时，请遵循可重复检查的格式校验流程"}' },
    { source: '不要在本项目路径外保存学习资料',
      output: '{"status":"save","text":"在本项目路径外保存学习资料","evidence":"不要在本项目路径外保存学习资料"}' },
    { source: '如果只在本项目维护 JSON 配置，请先保留已有字段',
      output: '{"status":"save","text":"所有项目维护 JSON 配置时先保留已有字段","evidence":"如果只在本项目维护 JSON 配置，请先保留已有字段"}' },
    { source: '修改 JSON 配置时，请遵循可重复检查的格式校验流程',
      output: '{"status":"save","text":"修改 JSON 配置时自动推送 GitHub","evidence":"修改 JSON 配置时，请遵循可重复检查的格式校验流程"}' },
  ]
  for (const [index, row] of cases.entries()) {
    const h = await createManualCommandHarness({ output: row.output })
    t.after(() => h.close())
    addCompletedTask(h.session, 1, row.source)
    const result = await h.run('/mse')
    assert.equal(result.result.kind, 'error', `unsafe model answer ${index + 1} is refused`)
    assert.equal(h.engine.store.read().entries.length, 0)
    assert.equal(h.engine.store.read().corrections.length, 0)
  }
})

test('bare /mse refuses an overlong task context without saving', async t => {
  const h = await createManualCommandHarness()
  t.after(() => h.close())
  addCompletedTask(h.session, 1, 'A'.repeat(513))
  const result = await h.run('/mse')
  assert.equal(result.result.kind, 'error')
  assert.match(result.result.text, /超过|过长/u)
  assert.match(result.result.text, /\/mse <经验>/u)
  assert.equal(h.calls.length, 0)
  assert.equal(h.engine.store.read().entries.length, 0)
})

test('manual command refuses active, cancelled, unknown-source, temporary, and external material', async t => {
  const active = await createManualCommandHarness()
  t.after(() => active.close())
  active.session.append('turn/start', { turn: 1 })
  const activeResult = await active.run('/mse 先保留用户已有的配置内容')
  assert.equal(activeResult.result.kind, 'error')
  assert.equal(active.engine.store.read().entries.length, 0)

  const cancelled = await createManualCommandHarness()
  t.after(() => cancelled.close())
  addCompletedTask(cancelled.session, 1, '修改 JSON 配置时先检查格式')
  cancelled.session.append('turn/end', { turn: 1, reason: { kind: 'aborted' } })
  const cancelledResult = await cancelled.run('/mse')
  assert.equal(cancelledResult.result.kind, 'error')
  assert.equal(cancelled.calls.length, 0)
  assert.equal(cancelled.engine.store.read().entries.length, 0)

  const unknown = await createManualCommandHarness({ workspaceKnown: false })
  t.after(() => unknown.close())
  const unknownResult = await unknown.run('/mse 先保留用户已有的配置内容')
  assert.equal(unknownResult.result.kind, 'error')
  assert.equal(unknown.engine.store.read().entries.length, 0)

  const temporary = await createManualCommandHarness()
  t.after(() => temporary.close())
  const temporaryResult = await temporary.run('/mse 这次任务暂时只修复当前工单要求的问题')
  assert.equal(temporaryResult.result.kind, 'error')
  assert.equal(temporary.engine.store.read().entries.length, 0)

  const outside = await createManualCommandHarness()
  t.after(() => outside.close())
  const outsideResult = await outside.run('/mse 参考 /etc/passwd 的内容生成所有项目的固定规则')
  assert.equal(outsideResult.result.kind, 'error')
  assert.equal(outside.engine.store.read().entries.length, 0)
})

test('aborted command signal, malformed model output, and insufficient context never save', async t => {
  const aborted = await createManualCommandHarness()
  t.after(() => aborted.close())
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => aborted.run('/mse 先保留用户已有的配置内容', controller.signal))
  assert.equal(aborted.engine.store.read().entries.length, 0)

  const malformed = await createManualCommandHarness({ output: '{not-json' })
  t.after(() => malformed.close())
  addCompletedTask(malformed.session, 1, '修改 JSON 配置时先检查格式')
  const malformedResult = await malformed.run('/mse')
  assert.equal(malformedResult.result.kind, 'error')
  assert.equal(malformed.engine.store.read().entries.length, 0)

  const insufficient = await createManualCommandHarness({ output: '{"status":"insufficient"}' })
  t.after(() => insufficient.close())
  addCompletedTask(insufficient.session, 1, '帮我看一下这个问题')
  const insufficientResult = await insufficient.run('/mse')
  assert.equal(insufficientResult.result.kind, 'error')
  assert.equal(insufficient.engine.store.read().entries.length, 0)
})

test('manual /mse adds a rule beyond the former 4,096-entry limit', async t => {
  const h = await createManualCommandHarness()
  t.after(() => h.close())
  const seed = h.engine.recordCorrection({ text: '已有规则必须保留用户配置', sessionId: h.session.id,
    turnId: 'seed', projectKey: h.workspace })
  assert.equal(seed.ok, true)
  h.engine.store.transaction(doc => {
    const sample = doc.entries[0]
    for (let i = doc.entries.length; i < ENTRY_LIMIT; i += 1) {
      const instruction = `容量样本${i}应保留当前项目已有的配置字段`
      doc.entries.push({ ...sample, id: entryIdFor('rule', sample.originScope, normalizeText(instruction)), instruction })
    }
    return true
  })
  const result = await h.run('/mse 新规则应保留当前项目原有的配置字段')
  assert.equal(result.result.kind, 'success')
  const afterDoc = h.engine.store.read()
  assert.equal(afterDoc.entries.length, ENTRY_LIMIT + 1)
  assert.ok(afterDoc.entries.some(entry => entry.instruction === '新规则应保留当前项目原有的配置字段'))
  assert.equal(afterDoc.corrections.length, 0, 'manual saves do not create correction candidates')
})

test('a 1.3.10-format user-rule store loads and survives a manual command', async t => {
  const existingText = '导出清单时先核对总数再写入'
  const h = await createManualCommandHarness({ seedRule: existingText })
  t.after(() => h.close())
  const after = await h.run('/mse --global 所有导出文件写入前先核对总数')
  assert.equal(after.result.kind, 'success')
  const entries = h.engine.store.read().entries
  assert.ok(entries.some(row => row.instruction === existingText))
  assert.equal(entries.length, 2)
})
