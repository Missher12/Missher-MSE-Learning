import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningEngine, RECALL_REASONS } from '../src/index.mjs'
import { analyze, relevance, admits } from '../src/recall.mjs'

function setup(t, extra = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-recall-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  return { engine: new LearningEngine({ stateRoot, adapterId: 'recall-test', ...extra }), stateRoot }
}
let counter = 0
const turn = (session, prompt, extra = {}) => ({ sessionId: session, turnId: `t${++counter}`, prompt, origin: 'user', ...extra })
const prepare = (engine, session, prompt, extra) => engine.prepare(turn(session, prompt, extra))

const CORRECTION = '以后导出金额前先转换为数值，再按金额排序'

test('a saved explicit correction is recalled by a new session task, including a synonym rewrite', t => {
  const { engine } = setup(t)
  const learned = prepare(engine, 'learn', CORRECTION)
  assert.equal(learned.reason, RECALL_REASONS.correctionLearned)
  assert.equal(learned.bytes, 0, 'the learning turn itself injects nothing')
  assert.equal(engine.status().lessons, 1)

  const same = prepare(engine, 'task-a', '导出金额并排序')
  assert.equal(same.reason, RECALL_REASONS.recalled)
  assert.ok(same.bytes > 0 && same.bytes === Buffer.byteLength(same.context))
  assert.match(same.context, /转换为数值/)

  const synonym = prepare(engine, 'task-b', '帮我把报表里的金额按数字大小排列后输出')
  assert.equal(synonym.reason, RECALL_REASONS.recalled, 'synonym rewrite must still match')
  assert.ok(synonym.bytes > 0)
  assert.equal(synonym.sources.length, synonym.lessons.length)
  assert.ok(synonym.sources.every(row => row.kind === 'correction' && row.bytes > 0))
})

test('unrelated tasks, vague follow-ups and other projects never recall', t => {
  const { engine } = setup(t)
  const scope = { projectKey: '/work/project-one' }
  assert.equal(prepare(engine, 'learn', CORRECTION, scope).reason, RECALL_REASONS.correctionLearned)
  for (const unrelated of ['查询明天的天气情况', '帮我写一个 Python 爬虫抓取网页标题', '继续', '用 React 写一个登录页面',
    '把这个函数重命名一下', '今天的运势如何']) {
    const result = prepare(engine, `u-${unrelated.length}-${unrelated.charCodeAt(0)}`, unrelated, scope)
    assert.equal(result.bytes, 0, `${unrelated} must not recall`)
    assert.equal(result.reason, RECALL_REASONS.matchInsufficient)
  }
  const otherProject = prepare(engine, 'other', '导出金额并排序', { projectKey: '/work/project-two' })
  assert.equal(otherProject.bytes, 0)
  assert.equal(otherProject.reason, RECALL_REASONS.scopeMismatch)
  const noProject = prepare(engine, 'instance', '导出金额并排序')
  assert.equal(noProject.bytes, 0)
  assert.equal(noProject.reason, RECALL_REASONS.scopeMismatch)
  assert.ok(prepare(engine, 'in-scope', '导出金额并排序', scope).bytes > 0)
})

test('labeled topic corpus: positives recall and negatives stay silent', () => {
  const lesson = analyze(CORRECTION)
  const positives = ['导出金额并排序', '帮我把报表里的金额按数字大小排列后输出', '记得先转成数字再排',
    'csv 文件里的金额导出时怎么处理', '先把金额转成数字然后再排序']
  const negatives = ['导出日志并按时间排序', '把时区转换一下', '提交代码前跑一下测试', '把数组排序并去重',
    '查询明天的天气情况', '继续', '这个函数重命名一下']
  for (const prompt of positives) {
    const verdict = admits(relevance(analyze(prompt), lesson))
    assert.equal(verdict.ok, true, `expected recall for ${prompt} (gate ${verdict.gate})`)
  }
  for (const prompt of negatives) {
    const verdict = admits(relevance(analyze(prompt), lesson))
    assert.equal(verdict.ok, false, `expected silence for ${prompt}`)
  }
})

test('explicit correction phrases are captured, quoted or interrogative text is not', t => {
  const { engine } = setup(t)
  const captured = ['记住：导出 CSV 时 `amount` 字段保留两位小数', '下次不要用字符串排序，改用数值排序',
    '以后报表里的金额统一用人民币', '改成按日期升序排列', '不要再把空值写成 0', '请记住：日志里不要出现用户邮箱',
    '这个表里的金额，以后统一按升序排列']
  for (const prompt of captured) {
    const result = prepare(engine, `c-${captured.indexOf(prompt)}`, prompt)
    assert.equal(result.reason, RECALL_REASONS.correctionLearned, `expected capture for ${prompt}`)
  }
  assert.equal(engine.status().lessons, captured.length)
  const rejected = ['例如：以后导出金额前先转换为数值', '```\n以后导出金额\n```', '以后要不要用人民币结算？',
    '你说得对，为什么以后不能用字符串排序', '帮我重构这段代码，以后也好维护', '从“以后”这个词开始分析一下这句话']
  for (const prompt of rejected) {
    const before = engine.status().lessons
    const result = prepare(engine, `r-${rejected.indexOf(prompt)}`, prompt)
    assert.equal(engine.status().lessons, before, `${prompt} must not be learned`)
    assert.notEqual(result.reason, RECALL_REASONS.correctionLearned)
  }
  const lessons = engine.list({ limit: 20 }).lessons.map(row => row.instruction)
  assert.ok(lessons.includes('导出 CSV 时 `amount` 字段保留两位小数'), 'inline field reference is kept verbatim')
})

test('every recall outcome reports exactly one distinguishable reason', t => {
  const { engine } = setup(t)
  // 未学到: nothing is stored yet.
  assert.equal(prepare(engine, 's1', '导出金额并排序').reason, RECALL_REASONS.notLearned)
  // 内部任务跳过: a non-user origin never learns or recalls.
  const internal = engine.prepare({ ...turn('s2', '导出金额并排序'), origin: 'tool' })
  assert.equal(internal.reason, RECALL_REASONS.internalTask)
  assert.equal(internal.bytes, 0)
  // 已学到本轮纠错: the learning turn itself injects nothing.
  assert.equal(prepare(engine, 's3', CORRECTION).reason, RECALL_REASONS.correctionLearned)
  // 匹配不足: a stored, recallable lesson with no topic overlap.
  const miss = prepare(engine, 's4', '查询明天的天气情况')
  assert.equal(miss.reason, RECALL_REASONS.matchInsufficient)
  assert.equal(miss.bytes, 0)
  // 已提供过: same session, same lesson version.
  assert.equal(prepare(engine, 's5', '导出金额并排序').reason, RECALL_REASONS.recalled)
  assert.equal(prepare(engine, 's5', '导出金额并排序').reason, RECALL_REASONS.alreadyOffered)
  // 作用域不符: a library exists, but only for another project key.
  assert.equal(prepare(engine, 's6', '导出金额并排序', { projectKey: '/other' }).reason, RECALL_REASONS.scopeMismatch)
  // 预算不足: the session ledger has already consumed the 1536-byte cap.
  const sessionId = 'capped'
  for (let index = 0; index < 24; index++) {
    engine.record({ eventId: `cap${index}`, source: 'direct_user', kind: 'correction',
      instruction: `以后导出金额先检查精度${index}，再按金额排序并核对结果` })
    engine.prepare({ sessionId, turnId: `cap${index}`, prompt: '导出金额并排序并核对结果', origin: 'user' })
  }
  const ledgerBytes = engine.diagnose({ sessionId }).session.bytes
  assert.ok(ledgerBytes >= 1409 && ledgerBytes <= 1536, `session ledger must approach the documented cap: ${ledgerBytes}`)
  const blocked = engine.prepare({ sessionId, turnId: 'cap-final', prompt: '导出金额并排序并核对结果', origin: 'user' })
  assert.equal(blocked.bytes, 0)
  assert.equal(blocked.reason, RECALL_REASONS.budgetExhausted)
  // 方法未验证: nothing but a candidate method is left in this scope.
  const methodOnly = setup(t)
  methodOnly.engine.record({ eventId: 'm', source: 'host_proposal', kind: 'method', methodId: 'copy-source-date-v1' })
  const unvalidated = prepare(methodOnly.engine, 'm1', '核对来源与产物的记录标识一致，仅将日期字段复制为来源的有效日期，来源为空时保留空值并重新核验。')
  assert.equal(unvalidated.reason, RECALL_REASONS.methodUnvalidated)
  assert.equal(unvalidated.bytes, 0)
})

test('unvalidated methods never recall, validated methods recall only in their own environment', t => {
  const { engine } = setup(t)
  const method = engine.record({ eventId: 'method', source: 'host_proposal', kind: 'method', methodId: 'copy-source-date-v1',
    environmentId: 'toolchain-a' })
  const prompt = '核对来源与产物的记录标识一致，仅将日期字段复制为来源的有效日期，来源为空时保留空值并重新核验。'
  const candidate = prepare(engine, 'm1', prompt, { environmentId: 'toolchain-a' })
  assert.equal(candidate.bytes, 0)
  assert.equal(candidate.reason, RECALL_REASONS.methodUnvalidated)
  assert.equal(candidate.diagnostics.methodUnvalidated, 1)

  assert.equal(engine.evaluateRegistered({ lessonId: method.id, environmentId: 'toolchain-a' }).decision, 'accepted')
  assert.equal(engine.status().counts.validated, 1)
  const other = prepare(engine, 'm2', prompt, { environmentId: 'toolchain-b' })
  assert.equal(other.bytes, 0, 'a validated method must not leak into another environment')
  assert.equal(other.reason, RECALL_REASONS.notLearned)
  const otherDiagnosis = engine.diagnose({ environmentId: 'toolchain-b', prompt })
  assert.equal(otherDiagnosis.prompted.otherEnvironment, 1)
  assert.equal(otherDiagnosis.prompted.methodUnvalidated, 0)
  assert.ok(prepare(engine, 'm3', prompt, { environmentId: 'toolchain-a' }).bytes > 0)
})

test('reflection keeps its environment through the ticket, so a new method stays bound there', t => {
  const { engine } = setup(t)
  const environment = { environmentId: 'toolchain-b' }
  const prompt = '导出金额并排序时先确认数值类型，再核对排列顺序'
  const ticket = engine.reflectionRequest({ sessionId: 'r1', turnId: 't1', outcome: 'supported',
    taskSummary: '导出金额时先确认数值类型再排序', resultSummary: '金额被当作字符串排序，改为数值排序后正确', ...environment })
  assert.equal(ticket.ok, true)
  const learned = engine.reflectionResult({ ticket: ticket.ticket, result: { instruction: prompt } })
  assert.equal(learned.ok, true)
  assert.equal(engine.diagnose({ ...environment, prompt }).prompted.methodUnvalidated, 1)
  const elsewhere = engine.diagnose({ environmentId: 'toolchain-other', prompt })
  assert.equal(elsewhere.prompted.methodUnvalidated, 0, 'another environment does not inherit the candidate')
  assert.equal(elsewhere.prompted.otherEnvironment, 1)
  // The generic method stays a candidate until a trusted host supplies paired trials,
  // and it is only ever served in the environment that produced it.
  assert.equal(engine.status().counts.candidate, 1)
  assert.equal(engine.prepare({ sessionId: 'r2', turnId: 't1', prompt, origin: 'user', ...environment }).bytes, 0)
  assert.equal(engine.prepare({ sessionId: 'r3', turnId: 't1', prompt, origin: 'user',
    environmentId: 'toolchain-other' }).reason, RECALL_REASONS.notLearned)
  assert.throws(() => engine.evaluate({ lessonId: learned.id, expectedVersion: 1, environmentId: 'toolchain-other',
    eventId: 'e1', suiteId: 's1', trials: [] }), /environment_mismatch/)
})

test('default per-turn and per-session budgets are unchanged and deduplication holds', t => {
  const { engine } = setup(t)
  for (let index = 0; index < 6; index++) {
    engine.record({ eventId: `e${index}`, source: 'direct_user', kind: 'correction',
      instruction: `以后导出金额先检查精度${index}，再按金额排序并核对结果` })
  }
  const first = prepare(engine, 'budget', '导出金额并排序并核对结果')
  assert.equal(first.reason, RECALL_REASONS.recalled)
  assert.ok(first.lessons.length <= 2 && first.bytes <= 768)
  assert.ok(first.bytes === Buffer.byteLength(first.context))
  let total = first.bytes
  for (let index = 0; index < 6; index++) {
    engine.record({ eventId: `later${index}`, source: 'direct_user', kind: 'correction',
      instruction: `以后导出金额先检查精度${index}，再按金额排序并核对结果` })
    const next = engine.prepare({ sessionId: 'budget', turnId: `n${index}`, prompt: '导出金额并排序并核对结果', origin: 'user' })
    total += next.bytes
    assert.ok(next.lessons.length <= 2)
  }
  assert.ok(total <= 1536, `session budget exceeded: ${total}`)
  const finalTurn = engine.prepare({ sessionId: 'budget', turnId: 'final', prompt: '导出金额并排序并核对结果', origin: 'user' })
  assert.equal(finalTurn.bytes, 0)
  assert.ok([RECALL_REASONS.alreadyOffered, RECALL_REASONS.budgetExhausted].includes(finalTurn.reason))
  assert.ok(prepare(engine, 'fresh-session', '导出金额并排序并核对结果').bytes > 0)
})

test('diagnose explains a recall decision without writing, injecting or leaking lesson text', t => {
  const { engine } = setup(t)
  prepare(engine, 'learn', CORRECTION)
  const before = engine.store.read().revision
  const hit = engine.diagnose({ prompt: '导出金额并排序' })
  const miss = engine.diagnose({ prompt: '查询明天的天气情况' })
  assert.equal(engine.store.read().revision, before, 'diagnose must not write')
  assert.equal(hit.prompted.reason, RECALL_REASONS.recalled)
  assert.equal(miss.prompted.reason, RECALL_REASONS.matchInsufficient)
  assert.equal(miss.library.activeCorrections, 1)
  assert.equal(JSON.stringify(miss).includes('转换为数值'), false, 'diagnostics carry no lesson text')
})

test('questions, one-shot requests and relayed speech never become persistent corrections', t => {
  const { engine } = setup(t)
  const refused = [
    '金额必须用人民币结算？',            // ordinary question
    '金额改成人民币结算？',              // question about a change
    '仅这次把报表金额改成人民币',         // explicitly this occasion only
    '暂时先按美元结算，这次不用改',        // temporary
    '他说"以后导出金额都用人民币"',       // straight-quoted relay
    '他说以后导出金额都用人民币',         // unquoted relay
    '客户要求以后导出的金额都用人民币',    // relayed third-party requirement
  ]
  for (const prompt of refused) {
    const before = engine.status().lessons
    const result = prepare(engine, `refuse-${refused.indexOf(prompt)}`, prompt)
    assert.equal(engine.status().lessons, before, `${prompt} must not be stored`)
    assert.notEqual(result.reason, RECALL_REASONS.correctionLearned)
    // Nothing is injected into a later, related session either.
    assert.equal(prepare(engine, `later-${refused.indexOf(prompt)}`, '导出报表金额并排序').bytes, 0)
  }
  const accepted = ['以后导出金额前先转换为数值，再按金额排序', '记住：导出 CSV 时 `amount` 字段保留两位小数',
    '下次不要用字符串排序，改用数值排序', '仅这次先这样，以后统一用人民币结算', '他说得对，但我们以后统一按升序排列']
  for (const prompt of accepted) {
    const before = engine.status().lessons
    assert.equal(prepare(engine, `accept-${accepted.indexOf(prompt)}`, prompt).reason,
      RECALL_REASONS.correctionLearned, `${prompt} must be learned`)
    assert.equal(engine.status().lessons, before + 1)
  }
  const stored = engine.list({ limit: 20 }).lessons.map(row => row.instruction)
  assert.ok(stored.includes('导出 CSV 时 `amount` 字段保留两位小数'), 'inline field reference is preserved')
  assert.equal(stored.some(row => row.includes('把报表金额改成人民币')), false, 'the one-shot request is not stored')
  assert.equal(stored.some(row => row.includes('人民币结算？')), false, 'a question is not stored')
  assert.equal(stored.some(row => row.includes('都用人民币')), false, 'relayed speech is not stored')
})

test('related but different data formats are not interchangeable synonyms', () => {
  const cases = [
    ['以后导出 JSON 时必须用双引号包裹属性名', '导出 JSON 配置', true],
    ['以后导出 JSON 时必须用双引号包裹属性名', '导出 YAML 配置', false],
    ['以后 YAML 配置禁止使用制表符缩进', '格式化 JSON 配置', false],
    ['以后 YAML 配置禁止使用制表符缩进', '整理 YAML 配置的缩进', true],
    ['以后导出 CSV 时统一使用 UTF-8 编码', '把表格导出成 excel', false],
    ['以后导出 CSV 时统一使用 UTF-8 编码', '把这个 csv 导出并核对编码', true],
  ]
  for (const [lesson, prompt, expected] of cases) {
    const verdict = admits(relevance(analyze(prompt), analyze(lesson)))
    assert.equal(verdict.ok, expected, `${prompt} vs ${lesson} (gate ${verdict.gate ?? 'none'})`)
  }
})

test('a match that cannot fit the byte budget is reported as budget_exhausted, never as recalled', t => {
  // Per-turn cap: a complete lesson plus framing does not fit into 128 bytes.
  const tight = setup(t, { maxContextBytes: 128 }).engine
  tight.record({ eventId: 'c', source: 'direct_user', kind: 'correction', instruction: CORRECTION })
  const capped = prepare(tight, 'cap', '导出金额并排序')
  assert.equal(capped.reason, RECALL_REASONS.budgetExhausted)
  assert.equal(capped.bytes, 0)
  assert.equal(capped.context, '')
  assert.equal(capped.lessons.length, 0)
  assert.equal(capped.diagnostics.matched, 1, 'the match existed; only the budget refused it')
  assert.equal(tight.diagnose({ prompt: '导出金额并排序' }).prompted.reason, RECALL_REASONS.budgetExhausted)
  assert.equal(tight.diagnose({ prompt: '导出金额并排序' }).prompted.wouldInjectBytes, 0)

  // Session remainder: the session ledger is nearly full and the next complete lesson
  // (about 140 bytes) no longer fits into the remaining 1536-byte allowance.
  const { engine } = setup(t)
  engine.record({ eventId: 'seed', source: 'direct_user', kind: 'correction', instruction: CORRECTION })
  const sessionId = 'nearly-full'
  let injected = 0
  for (let index = 0; index < 12; index++) {
    engine.record({ eventId: `bulk${index}`, source: 'direct_user', kind: 'correction',
      instruction: `以后导出金额时先核对精度${index}，再按金额排序并核对结果与来源` })
    const step = engine.prepare({ sessionId, turnId: `t${index}`, prompt: '导出金额并排序并核对结果与来源', origin: 'user' })
    injected += step.bytes
  }
  const remaining = engine.diagnose({ sessionId }).session.remainingBytes
  assert.ok(remaining < 140 && remaining >= 0, `expected a small remainder, got ${remaining}`)
  engine.record({ eventId: 'last-one', source: 'direct_user', kind: 'correction',
    instruction: '以后导出金额时先核对货币单位，再按金额排序并核对结果' })
  const blocked = engine.prepare({ sessionId, turnId: 'final', prompt: '导出金额并排序并核对结果并核对货币单位', origin: 'user' })
  if (blocked.bytes === 0) {
    assert.equal(blocked.reason, RECALL_REASONS.budgetExhausted)
    assert.equal(engine.diagnose({ sessionId, prompt: '导出金额并排序并核对结果并核对货币单位' }).prompted.reason,
      RECALL_REASONS.budgetExhausted)
  }
  assert.ok(injected <= 1536)
})

test('a one-shot clause covers the following clauses while literals keep their exact bytes', t => {
  const { engine } = setup(t)
  const cases = [
    { prompt: '仅这次，把报表金额统一为人民币', saved: false },
    { prompt: '仅这次：把报表金额统一为人民币', saved: false },
    { prompt: '仅这次先把报表金额改成美元', saved: false },
    { prompt: '仅这次先这样，以后报表金额统一用人民币结算', saved: true, text: '以后报表金额统一用人民币结算' },
    { prompt: '仅这次先这样。以后报表金额统一用人民币结算。', saved: true, text: '以后报表金额统一用人民币结算' },
    { prompt: '以后导出 CSV 时空值必须写成 "N/A, unknown"', saved: true, literal: '"N/A, unknown"' },
    { prompt: '以后导出 JSON 时空值必须写成 `{"state":"unknown","code":0}`', saved: true,
      literal: '`{"state":"unknown","code":0}`' },
    { prompt: '以后日志里必须保留两个连续空格：段首  段尾', saved: true, literal: '段首  段尾' },
    { prompt: "From now on don't rewrite 'N/A, unknown' literals", saved: true, literal: "'N/A, unknown'" },
    { prompt: '以后导出金额前先转换为数值，再按金额排序', saved: true, text: '以后导出金额前先转换为数值，再按金额排序' },
  ]
  for (const [index, item] of cases.entries()) {
    const learned = prepare(engine, `a12-${index}`, item.prompt)
    const lessons = engine.list({ limit: 100 }).lessons
    const mine = lessons.filter(row => row.instruction.includes(item.literal ?? item.text ?? '') || item.saved === false)
    assert.equal(mine.length > 0, item.saved, `${item.prompt} -> ${JSON.stringify(lessons.map(row => row.instruction))}`)
    if (!item.saved) assert.equal(learned.reason, RECALL_REASONS.notLearned)
    if (item.literal) assert.ok(lessons.some(row => row.instruction.includes(item.literal)),
      `literal must survive byte-for-byte: ${item.literal}`)
    if (item.text) assert.ok(lessons.some(row => row.instruction === item.text), `expected exactly ${item.text}`)
  }
})

test('captured literals stay valid and recall in a fresh session', t => {
  const { engine } = setup(t)
  prepare(engine, 'literal', '以后导出 JSON 时空值必须写成 `{"state":"unknown","code":0}`')
  const recalled = prepare(engine, 'literal-task', '导出 JSON 空值字段怎么处理')
  assert.equal(recalled.reason, RECALL_REASONS.recalled)
  assert.ok(recalled.context.includes('`{"state":"unknown","code":0}`'), 'the recalled rule is still valid JSON')
})
