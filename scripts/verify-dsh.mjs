// Exercises the packed plugin through installed Cordis, with isolated state and no model calls.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const [archive, modules] = process.argv.slice(2).map(x => resolve(x))
assert.ok(archive && modules, 'usage: node scripts/verify-dsh.mjs <npm-tarball> <host-node_modules>')
const root = mkdtempSync(join(tmpdir(), 'mse-cordis-native-'))
let ctx, fiber, lifecycleTurn = 0
try {
  execFileSync('tar', ['-xzf', archive, '-C', root])
  symlinkSync(modules, join(root, 'package/node_modules'), 'dir')
  const { evaluatePluginCompatibility, getDshRuntimeVersion } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-app-boot/lib/index.js')))
  const manifest = JSON.parse(readFileSync(join(root, 'package/package.json'), 'utf8'))
  assert.equal(evaluatePluginCompatibility(manifest), undefined, 'packed manifest must pass the real host compatibility gate without exemptions')
  const { Context } = await import(pathToFileURL(join(modules, '@deepseek-ai/cordis/lib/index.js')))
  const { default: plugin } = await import(pathToFileURL(join(root, 'package/adapters/dsh/index.mjs')))
  let registered = null
  const mount = async (config = {}, home = join(root, 'profile')) => {
    ctx = new Context()
    ctx.provide('agents', {}); ctx.provide('tools', {})
    ctx.provide('dshHomePath', (...parts) => join(home, ...parts))
    ctx.provide('llm', { async *stream() { throw new Error('unexpected_model_call') } })
    ctx.provide('commands', { register(definition) { registered = definition; return () => { registered = null } } })
    fiber = ctx.plugin(plugin, { reflectionEnabled: false, ...config })
    await fiber.await()
    assert.ok(ctx.mseLearning, 'learning service mounted')
    assert.equal(registered?.name, 'mse', 'the visible /mse status command is registered through the public commands service')
  }
  const user = text => ({ id: `user-${Math.random()}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
  const enter = async (session, prompt, turn = 1) => {
    const messages = [user(prompt)]
    return ctx.waterfall('agent/pre-step', { agent: { session }, messages, turn, step: 1,
      signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }))
  }
  await mount()
  const one = { id: 'correction', header: {}, events: [] }
  await enter(one, '以后导出金额前先转换为数值，再按金额排序')
  ctx.emit('session/event', one, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(ctx.mseLearning.engine.status().lessons, 1)
  await fiber.dispose(); await ctx.fiber.dispose()
  await mount()
  const session = { id: 'new-session', header: {}, events: [] }
  const decision = await enter(session, '导出金额并排序')
  assert.equal(decision.messages.length, 2)
  const message = decision.messages[1]
  assert.equal(message.source.plugin, 'mse-learning')
  ctx.emit('session/event', session, { type: 'user/message', data: message })
  assert.equal(ctx.mseLearning.engine.status().adopted, 0, 'commit must not count as request adoption')
  for await (const _chunk of ctx.waterfall('llm/stream', { sessionId: session.id, messages: decision.messages },
    async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })) {}
  assert.equal(ctx.mseLearning.engine.status().adopted, 1)
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(ctx.mseLearning.engine.status().verified, 0)
  assert.equal((await enter(session, '导出金额并排序', 2)).messages.length, 1)
  assert.equal((await enter({ id: 'weather', header: {} }, '查询明天天气')).messages.length, 1)
  const legacy = ctx.plugin({ name: 'legacy-fixture', apply(c) { c.provide('missherEvolutionCore', {}) } })
  await legacy.await()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await enter({ id: 'legacy-conflict', header: {} }, '导出金额并排序')).messages.length, 1)
  await legacy.dispose()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await enter({ id: 'resumed', header: {} }, '导出金额并排序')).messages.length, 2)
  // Reasons and diagnostics are reported for every prepare, including the silent ones.
  const silent = await enter({ id: 'unrelated-reason', header: {} }, '查询明天天气')
  assert.equal(silent.messages.length, 1)
  assert.equal(ctx.mseLearning.recallStatus('unrelated-reason').last.reason, 'match_insufficient')
  assert.equal(ctx.mseLearning.recallStatus('unrelated-reason').last.bytes, 0)
  // The visible status command reports real counts, bytes and a reason, and never
  // becomes a model message: the decision still carries exactly the user message.
  const statusDecision = await enter({ id: 'status-view', header: {} }, '导出金额并排序')
  assert.equal(statusDecision.messages.length, 2)
  const command = await registered.handler({ rawInput: '', agent: { session: { id: 'status-view' } }, signal: new AbortController().signal })
  assert.equal(command.kind, 'success')
  assert.match(command.text, /MSE 学习状态/)
  assert.match(command.text, /已召回 1 条/)
  assert.match(command.text, /原因码/)
  const detail = await registered.handler({ rawInput: 'why', agent: { session: { id: 'status-view' } } })
  assert.match(detail.text, /本轮来源/)
  const dryRun = await registered.handler({ rawInput: 'now 导出金额并排序', agent: { session: { id: 'dry-run-session' } } })
  assert.equal(dryRun.kind, 'success')
  assert.match(dryRun.text, /只读诊断/)
  assert.equal(statusDecision.messages.some(item => String(item.content?.[0]?.text ?? '').includes('MSE 学习状态')), false,
    'a status row is never injected as model context')
  // A normal user task that mentions MSE is still learned from; only the internal
  // review envelope is skipped, and it never becomes a lesson.
  const beforeMse = ctx.mseLearning.engine.status().lessons
  await enter({ id: 'mse-developer', header: {} }, '以后开发 MSE 学习插件时先核验项目入口再修改源码')
  assert.equal(ctx.mseLearning.engine.status().lessons, beforeMse + 1,
    'discussing or developing MSE must not stop learning')
  const internalEnvelope = await enter({ id: 'internal-review', header: {} },
    '[[mse-internal-review]] 以后导出金额前先转换为数值，再按金额排序')
  assert.equal(internalEnvelope.messages.length, 1)
  assert.equal(ctx.mseLearning.engine.status().lessons, beforeMse + 1, 'internal review text never becomes a lesson')
  assert.equal(ctx.mseLearning.recallStatus('internal-review').last.reason, 'internal_task')
  const mseRelated = await enter({ id: 'mse-related', header: {} }, '开始开发 MSE 学习插件的召回部分')
  assert.equal(mseRelated.messages.length, 2, 'a related task still recalls after an MSE-named correction')
  // Synonym rewriting recalls the same lesson, unrelated tasks stay silent.
  assert.equal((await enter({ id: 'synonym', header: {} }, '帮我把报表里的金额按数字大小排列后输出')).messages.length, 2)
  assert.equal((await enter({ id: 'unrelated-two', header: {} }, '帮我写一个 Python 爬虫抓取网页标题')).messages.length, 1)
  // A library written by 0.9.0-alpha.2 (real fixture, adapterId dsh, no environment
  // configured anywhere) must keep recalling under the unchanged SDK default.
  await ctx.fiber.dispose()
  const legacyHome = join(root, 'legacy-home')
  const legacyRoot = join(legacyHome, 'mse-learning')
  cpSync(fileURLToPath(new URL('../tests/fixtures/legacy-alpha2-schema2', import.meta.url)), legacyRoot, { recursive: true })
  await mount({}, legacyHome)
  assert.equal(ctx.mseLearning.engine.status().counts.validated, 1)
  const legacyInstruction = ctx.mseLearning.engine.list({ limit: 20 }).lessons.find(row => row.kind === 'method').instruction
  const legacyDecision = await enter({ id: 'legacy-alpha2-upgrade', header: {} }, legacyInstruction)
  assert.equal(legacyDecision.messages.length, 2, 'an alpha.2 validated method still recalls under the new default environment')
  assert.equal(ctx.mseLearning.recallStatus('legacy-alpha2-upgrade').last.reason, 'recalled')
  // The visible status command takes its project identity from the trusted session header,
  // so the first command in a fresh session already reports the right scope.
  const scopedProject = '/synthetic/project-scoped'
  ctx.mseLearning.engine.record({ eventId: 'scoped-seed', source: 'direct_user', kind: 'correction',
    instruction: '以后导出金额前先转换为数值，再按金额排序', projectKey: scopedProject })
  const scopedSession = { id: 'scoped-command', header: { cwd: scopedProject } }
  const scopedStatus = ctx.mseLearning.recallStatus(scopedSession.id, scopedSession.header.cwd)
  assert.equal(scopedStatus.library.scopeKind, 'project')
  assert.equal(scopedStatus.library.library.activeCorrections, 1, 'the first status read already sees the project scope')
  assert.equal(ctx.mseLearning.recallStatus(scopedSession.id).library.scopeKind, 'instance',
    'without the trusted key there is simply no cached scope yet')
  const scopedNow = await registered.handler({ rawInput: 'now 导出金额并排序', agent: { session: scopedSession } })
  assert.match(scopedNow.text, /已召回/)
  const scopedDecision = await enter(scopedSession, '导出金额并排序')
  assert.equal(scopedDecision.messages.length, 2, 'the same session injects the project-scoped lesson')
  // A match that cannot fit the byte budget is never reported as recalled.
  await ctx.fiber.dispose()
  await mount({ maxContextBytes: 128 }, legacyHome)
  const tight = await enter({ id: 'tight-budget', header: {} }, '导出金额并排序')
  assert.equal(tight.messages.length, 1)
  assert.equal(ctx.mseLearning.recallStatus('tight-budget').last.reason, 'budget_exhausted')
  const tightNow = await registered.handler({
    rawInput: 'now 导出金额并排序', agent: { session: { id: 'tight-budget', header: {} } } })
  assert.match(tightNow.text, /预算不足/)
  // A paused controller never claims an injection is available.
  ctx.mseLearning.bridge.setEnabled(false)
  assert.equal(ctx.mseLearning.recallStatus('paused-session').enabled, false)
  const paused = await registered.handler({
    rawInput: 'now 导出金额并排序', agent: { session: { id: 'paused-session', header: {} } } })
  assert.match(paused.text, /控制器已暂停/)
  assert.match(paused.text, /不会注入/)
  ctx.mseLearning.bridge.setEnabled(true)
  // --- Packed-artifact lifecycle evidence: conflict replacement, expiry re-learning and
  // --- bounded settlement retry, all against the code inside the frozen tarball.
  const packed = await import(pathToFileURL(join(root, 'package/src/index.mjs')))
  const packedChecks = await import(pathToFileURL(join(root, 'package/src/checks.mjs')))
  const packedHarness = await import(pathToFileURL(join(root, 'package/adapters/harness.mjs')))
  const project = '/synthetic/packed-project'
  const packedTurn = (sessionId, prompt, extra = {}) => ({ sessionId, turnId: String(++lifecycleTurn), origin: 'user', prompt, ...extra })
  const lifecycle = new packed.LearningEngine({ stateRoot: join(root, 'lifecycle-profile'), adapterId: 'dsh' })
  lifecycle.prepare(packedTurn('currency-old', '以后导出报表金额时统一使用美元', { projectKey: project }))
  assert.equal(lifecycle.prepare(packedTurn('currency-new', '纠正一下，以后导出报表金额时统一使用人民币', { projectKey: project })).reason,
    'correction_learned')
  const served = lifecycle.prepare(packedTurn('currency-task', '导出报表金额并核对币种', { projectKey: project }))
  assert.match(served.context, /人民币/u)
  assert.equal(served.context.includes('美元'), false, 'the packed artifact must not co-inject the replaced preference')
  const unresolved = new packed.LearningEngine({ stateRoot: join(root, 'lifecycle-unresolved'), adapterId: 'dsh' })
  unresolved.prepare(packedTurn('u1', '以后导出报表金额时统一使用美元', { projectKey: project }))
  assert.equal(unresolved.prepare(packedTurn('u2', '以后导出报表金额时统一使用人民币', { projectKey: project })).reason,
    'conflict_unresolved')

  let methodClock = Date.UTC(2026, 9, 1)
  const methodEngine = new packed.LearningEngine({ stateRoot: join(root, 'lifecycle-expiry'), adapterId: 'dsh',
    now: () => methodClock })
  const methodPrompt = packedChecks.getMethod('numeric-sort-v1').instruction
  const method = methodEngine.record({ eventId: 'initial', kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' })
  assert.equal(methodEngine.evaluateRegistered({ lessonId: method.id }).decision, 'accepted')
  methodClock += 91 * 86_400_000
  assert.equal(methodEngine.prepare(packedTurn('expired', methodPrompt)).bytes, 0)
  assert.equal(methodEngine.record({ eventId: 'initial', kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' }).duplicate, true)
  const reopened = methodEngine.record({ eventId: 'relearn', kind: 'method', source: 'host_proposal', methodId: 'numeric-sort-v1' })
  const reopenedRow = methodEngine.list({ limit: 20 }).lessons.find(row => row.id === reopened.id)
  assert.equal(reopenedRow.status, 'candidate')
  assert.equal(reopenedRow.validation ?? null, null)
  assert.equal(methodEngine.prepare(packedTurn('before-eval', methodPrompt)).bytes, 0)
  assert.equal(methodEngine.evaluateRegistered({ lessonId: reopened.id }).decision, 'accepted')
  assert.ok(methodEngine.prepare(packedTurn('after-eval', methodPrompt)).bytes > 0)

  const settlementClock = (() => {
    let time = 1000, nextId = 0
    const timers = new Map()
    return { now: () => time,
      schedule: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, at: time + ms }); return id },
      cancel: id => timers.delete(id),
      advance: ms => { time += ms
        for (let guard = 0; guard < 16; guard++) {
          const due = [...timers].filter(([, timer]) => timer.at <= time)
          if (due.length === 0) return
          for (const [id, timer] of due) { timers.delete(id); timer.fn() }
        } } }
  })()
  const settlementEngine = new packed.LearningEngine({ stateRoot: join(root, 'lifecycle-settlement'), adapterId: 'dsh' })
  const settlementLesson = settlementEngine.record({ eventId: 'seed', source: 'direct_user', kind: 'correction',
    instruction: '以后导出金额前先转换为数值，再按金额排序' })
  const attemptPayloads = []
  const settlementOriginal = settlementEngine.settlementApply.bind(settlementEngine)
  let settlementFailures = 1
  // The harness settles through the durable apply now, so that is where a transient storage
  // failure really happens.
  settlementEngine.settlementApply = (...args) => {
    attemptPayloads.push(JSON.stringify(args[0]))
    if (settlementFailures-- > 0) throw Object.assign(new Error('locked'), { code: 'lock_busy' })
    return settlementOriginal(...args)
  }
  const settlementBridge = packedHarness.createHarnessBridge({ engine: settlementEngine, now: settlementClock.now,
    settlement: { schedule: settlementClock.schedule, cancel: settlementClock.cancel },
    createMessage: text => ({ id: 'packed-message', role: 'user',
      source: { kind: 'plugin', plugin: 'mse-learning' }, content: [{ type: 'text', text }] }) })
  // The core refuses to settle under unknown host permission; this script states it explicitly.
  settlementBridge.setTrustedGuard(() => true)
  const settlementSession = { id: 'packed-settlement', header: {}, events: [] }
  const settlementPrompt = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '导出金额并排序' }] }
  const packedDecision = await settlementBridge.preStep({ agent: { session: settlementSession }, step: 1, turn: 1,
    messages: [settlementPrompt], signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [settlementPrompt] }))
  for await (const _settledChunk of settlementBridge.stream({ sessionId: settlementSession.id, messages: packedDecision.messages },
    async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })) {}
  assert.equal(settlementBridge.verification({ sessionId: settlementSession.id, turnId: 1, checkId: 'packed-check',
    passed: true, lessonIds: [settlementLesson.id] }), true)
  settlementBridge.sessionEvent(settlementSession, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(settlementEngine.status().verified, 0, 'the failed write is not reported as settled')
  assert.equal(settlementBridge.lastRecall(settlementSession.id).outcome, 'pending')
  settlementClock.advance(250)
  assert.equal(settlementEngine.status().verified, 1, 'the bounded replay settles exactly once')
  assert.equal(new Set(attemptPayloads).size, 1, 'every attempt replays one frozen payload')
  assert.equal(settlementBridge.settlementStatus().length, 0)
  const packedLifecycle = { conflictReplacement: true, unresolvedConflictReported: true, expiredMethodRelearned: true,
    settlementRetryAttempts: attemptPayloads.length, settlementVerified: settlementEngine.status().verified }
  console.log(JSON.stringify({ ok: true, layer: 'packed Cordis lifecycle', runtimeVersion: getDshRuntimeVersion(),
    packedLifecycle,
    compatibilityAccepted: true, restartRecall: true, legacyAlpha2DefaultEnvironmentRecall: true,
    statusCommandTrustedScope: true, budgetNotReportedAsRecalled: true, pausedNeverClaimsInjection: true,
    successfulRequestAdoption: true, commitAloneNotAdopted: true, repeatedContextSuppressed: true, legacyConflictPaused: true,
    recallReasonsReported: true, statusCommandRegistered: true, statusCommandOutsideContext: true,
    mseNamedTaskLearned: true, internalReviewNotLearned: true, synonymRecall: true, unrelatedSilent: true, modelCalls: 0 }))
} finally {
  await fiber?.dispose(); await ctx?.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
}
