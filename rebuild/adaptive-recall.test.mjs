import test from 'node:test'
import assert from 'node:assert/strict'
import { addAdaptiveCandidate, adaptiveQueryFeatures, adaptiveQueryKey,
  synthesizeAdaptivePolicy } from './adaptive-recall.mjs'
import * as adaptive from './adaptive-recall.mjs'
import { selectRecall } from './recall.mjs'

const hex = value => value.repeat(64).slice(0, 64)

function method({ id = 'mem_api_method', instruction = '先检查 API 参数和状态码，再重新调用',
  applicability = 'API 请求失败时', status = 'pending', version = 1 } = {}) {
  return { id, type: 'lesson', status, instruction, applicability, exclusions: '', visibility: 'global',
    originScope: hex('a'), originEnvironment: hex('b'), updatedAt: 1, version,
    lesson: { problemId: hex('c'), failurePattern: 'API 请求失败', verification: { check: 'API 请求检查',
      expected: '返回成功' } } }
}

test('adaptive policy uses only bounded safe concept ids from the query and freezes its identity', () => {
  const query = 'API 调用失败，请定位 customer@example.test'
  const features = adaptiveQueryFeatures(query)
  assert.deepEqual(features, ['api'])
  assert.ok(!JSON.stringify(features).includes('customer'))
  const entry = method()
  const args = { scope: hex('d'), qualification: hex('e'), entry,
    queryFeatures: features, session: hex('f'), queryKey: hex('1'), now: 10 }
  const policy = synthesizeAdaptivePolicy(args)
  assert.deepEqual(policy.features, ['api'])
  assert.equal(policy.id, synthesizeAdaptivePolicy(args).id)
  assert.notEqual(policy.id, synthesizeAdaptivePolicy({ ...args, entry: { ...entry, version: 2 } }).id)
  assert.ok(!JSON.stringify(policy).includes(query))
  assert.ok(!JSON.stringify(policy).includes('customer'))
})

test('negated concepts do not enter the policy and transport markers do not create a new query', () => {
  assert.deepEqual(adaptiveQueryFeatures('不要用缓存；不需要金额，只看账户状态'), ['user'])
  const body = '请检查 API 请求后确认结果'
  assert.equal(adaptiveQueryKey(`${body}\n[RPC request id: 12345678-1234-1234-1234-123456789abc]`),
    adaptiveQueryKey(`${body}\n[RPC request id: 87654321-4321-4321-4321-cba987654321]`))
  assert.notEqual(adaptiveQueryKey('继续这个排查', ['api', 'opdebug']),
    adaptiveQueryKey('继续这个排查', ['json', 'opcheck']),
  'a different admitted task context is substantive query evidence')
  assert.notEqual(adaptiveQueryKey(body), adaptiveQueryKey('请检查 API 请求并确认最终状态'))
})

test('adaptive candidate adds without replacing baseline offers and obeys hard caps', () => {
  const entries = [method({ id: 'mem_base_one', instruction: '保留 API 任务原有方法说明' })]
  const baseline = selectRecall(entries, { prompt: 'API 调用失败', scope: hex('a'),
    environment: hex('b'), now: 10 })
  const candidate = method({ id: 'mem_candidate', applicability: '文档字段版本不匹配时',
    instruction: '先确认字段版本，再检查解析结果' })
  const added = addAdaptiveCandidate(baseline, candidate, { maxBytes: 768, now: 10 })
  assert.equal(added.ok, true)
  assert.ok(added.selection.offered.some(row => row.id === candidate.id && row.mode === 'method'))
  assert.ok(baseline.offered.every(row => added.selection.offered.some(item =>
    item.id === row.id && item.version === row.version && item.mode === row.mode)))
  assert.ok(added.selection.offered.filter(row => row.mode === 'method').length <= 2)
  assert.ok(added.selection.offered.filter(row => row.mode === 'guard').length <= 1)
  assert.ok(added.selection.offered.length <= 3 && added.selection.bytes <= 768)
  assert.deepEqual(synthesizeAdaptivePolicy({ scope: hex('d'), qualification: hex('e'),
    entry: candidate, queryFeatures: ['api'], session: hex('f'), queryKey: hex('1'),
    turnKey: hex('2'), now: 10 }).features, ['api'],
  'a unique real failure may learn a new query-to-method association without lexical overlap')
  assert.equal(addAdaptiveCandidate(baseline, { ...candidate, exclusions: 'API' },
    { maxBytes: 768, now: 10, prompt: 'API 调用失败' }).reason, 'candidate_excluded')

  const full = selectRecall([method({ id: 'mem_a', instruction: '保留第一条 API 方法提示' }),
    method({ id: 'mem_b', instruction: '保留第二条 API 方法提示' })], { prompt: 'API 调用失败',
    scope: hex('a'), environment: hex('b'), now: 10 })
  assert.equal(addAdaptiveCandidate(full, candidate, { maxBytes: 768, now: 10 }).ok, false)
})

test('task-aware policies freeze domain plus action and counterexample children add a novel exclusion', () => {
  const entry = method()
  const root = adaptive.synthesizeAdaptiveTaskPolicy({ scope: hex('d'), qualification: hex('e'), entry,
    taskFeatures: ['api', 'opdebug'], turnKey: hex('2'), session: hex('f'), queryKey: hex('1'), now: 10 })
  assert.equal(root.schema, 'mse-adaptive-recall-v2')
  assert.deepEqual(root.features, ['api', 'opdebug'])
  assert.deepEqual(root.excludedFeatures, [])
  const children = adaptive.narrowAdaptivePolicy({ ...root, mode: 'isolated' },
    ['api', 'opdebug', 'chart', 'color'], { turnKey: hex('3'), session: hex('4'), queryKey: hex('5'), now: 20 })
  assert.equal(children.length, 2, 'one counterexample proposes no more than two bounded alternatives')
  assert.notEqual(children[0].id, children[1].id)
  for (const child of children) {
    assert.equal(child.parentId, root.id)
    assert.equal(child.familyId, root.familyId)
    assert.equal(child.familyGeneration, 1)
    assert.equal(adaptive.adaptivePolicyMatches(child, ['api', 'opdebug', ...child.excludedFeatures]), false)
    assert.equal(adaptive.adaptivePolicyMatches(child, ['api', 'opdebug']), true)
  }
  assert.equal(adaptive.synthesizeAdaptiveTaskPolicy({ scope: hex('d'), qualification: hex('e'), entry,
    taskFeatures: ['null', 'opcheck'], turnKey: hex('2'), session: hex('f'), queryKey: hex('1'), now: 10 }), null,
  'generic null/value clues cannot seed cross-task policies')
  for (const [prompt, topic, operation] of [
    ['测试 JSON 输出。', 'json', 'test'],
    ['部署 API 服务。', 'api', 'deploy'],
    ['校验 JSON 输出。', 'json', 'validate'],
  ]) {
    const taskFeatures = adaptive.adaptiveTaskFeatures(prompt)
    assert.ok(taskFeatures.includes(topic) && taskFeatures.includes(operation), prompt)
    const policy = adaptive.synthesizeAdaptiveTaskPolicy({ scope: hex('d'), qualification: hex('e'),
      entry, taskFeatures, turnKey: hex('2'), session: hex('f'), queryKey: hex('1'), now: 10 })
    assert.ok(policy !== null && policy.features.includes(topic) && policy.features.includes(operation),
      'the task feature producer and policy consumer agree on operation IDs')
  }
})

test('a qualified challenger replaces only a lower-ranked automatic method and preserves a rule and warning', () => {
  const rule = { ...method({ id: 'mem_user_rule' }), type: 'rule', status: 'user_rule', lesson: null,
    instruction: '在 API 交付前必须保留明确验收规则' }
  const weak = method({ id: 'mem_weaker', instruction: '处理 API 任务时核对一般状态' })
  const candidate = method({ id: 'mem_challenger', instruction: '遇到 API 调用错误时先按已验证路径排查' })
  const guard = method({ id: 'mem_warning', status: 'needs_revision', instruction: 'API 旧方法有风险' })
  const lines = ['\n- 项目规则：在 API 交付前必须保留明确验收规则',
    '\n- 经验：处理 API 任务时核对一般状态', '\n- 风险警示：API 旧方法有风险']
  const incumbent = { lines, offered: [{ id: rule.id, version: 1, mode: 'method' },
    { id: weak.id, version: 1, mode: 'method' }, { id: guard.id, version: 1, mode: 'guard' }],
  bytes: Buffer.byteLength(lines.join(''), 'utf8'), ranked: [{ entry: rule, score: 5 }, { entry: weak, score: 1 }] }
  const changed = adaptive.competeAdaptiveCandidate(incumbent, candidate, [rule, weak, candidate, guard],
    { maxBytes: 768, now: 10, prompt: 'API 调用错误' })
  assert.equal(changed.ok, true)
  assert.equal(changed.reason, 'replace_automatic_method')
  assert.ok(changed.selection.offered.some(row => row.id === rule.id && row.mode === 'method'))
  assert.ok(changed.selection.offered.some(row => row.id === candidate.id && row.mode === 'method'))
  assert.ok(changed.selection.offered.some(row => row.id === guard.id && row.mode === 'guard'))
  assert.ok(changed.selection.bytes <= 768)
  assert.equal(changed.selection.lines[0], lines[0])
  assert.equal(changed.selection.lines[2], lines[2])
  assert.equal(changed.selection.offered.some(row => row.id === weak.id), false)
})

test('transport identifiers cannot create independent evidence; sentence refusals cannot trigger a policy', async () => {
  const {adaptiveQueryKey} = await import('./adaptive-recall.mjs')
  assert.equal(adaptiveQueryKey('7a124d84f2b1\n交班凭条，落款留空。'),
    adaptiveQueryKey('5fd0978241ce\n交班凭条 落款留空！'))
  assert.deepEqual(adaptiveQueryFeatures('不要把这项需要跨多个步骤核对清楚且非常长的临时说明当成可以直接启用缓存。应核对接口。'), ['api'])
  assert.ok(!adaptiveQueryFeatures('缓存不应该参与这次操作。').includes('cache'))
  assert.ok(!adaptiveQueryFeatures('别用缓存。').includes('cache'))
  assert.ok(adaptiveQueryFeatures('分别说明缓存和接口。').includes('cache'))
  assert.ok(!adaptiveQueryFeatures('不要启用以下选项：测试、缓存和接口。').includes('api'))
})

test('task features pair an operation with its object and borrow only related positive user context', () => {
  assert.deepEqual(adaptive.adaptiveTaskFeatures?.('空值异常'), [],
    'a lone generic null/error pair is not a task trigger')
  const task = [{ role: 'user', turn: 4, source: 'events', text: '这是插件交付验收单，核对宿主实际加载版本。' }]
  const handover = adaptive.adaptiveTaskFeatures?.('交班凭条落款是空值，该取谁为准？', task)
  for (const feature of ['record', 'null', 'opchoose', 'plugin', 'version']) {
    assert.ok(handover.includes(feature), 'related task feature ' + feature + ' is retained')
  }
  const json = adaptive.adaptiveTaskFeatures?.('解析 JSON BOM 时空值异常，如何定位原因？', task)
  assert.ok(json.includes('json') && json.includes('opread'))
  assert.ok(!json.includes('plugin') && !json.includes('version'),
    'a same-null JSON parsing task does not inherit an unrelated acceptance-sheet background')
  assert.deepEqual(adaptive.adaptiveTaskFeatures?.('检查空值。'), [],
    'a generic null check needs a concrete task object before it can trigger a cross-task policy')
  assert.deepEqual(adaptive.adaptiveTaskFeatures?.('不要继续这个检查。', [
    { role: 'user', turn: 4, source: 'events', text: '需要检查 API 请求参数。' },
  ]), [], 'an explicit current refusal cannot be revived by a reference to prior context')
  const switched = adaptive.adaptiveTaskFeatures?.('这个 JSON 文件需要解析，上一轮 API 话题到此为止。', [
    { role: 'user', turn: 4, source: 'events', text: '需要检查 API 请求参数。' },
  ])
  assert.ok(switched.includes('json') && switched.includes('opread'))
  assert.ok(!switched.includes('api') && !switched.includes('config'),
    'a closed prior topic is not retained alongside an explicit current topic')
  assert.deepEqual(adaptive.adaptiveTaskFeatures?.('继续这个排查', [
    { role: 'assistant', turn: 4, source: 'events', text: '建议核对插件交付验收单和宿主实际加载版本。' },
  ]), [], 'assistant suggestions never supply task identity')
  assert.deepEqual(adaptive.adaptiveTaskFeatures?.('继续这个排查', [
    { role: 'user', turn: 4, source: 'events', text: '不要核对插件交付验收单中的宿主版本。' },
  ]), [], 'negative history is not a positive task requirement')
  for (const objectStatement of ['当前对象是 Excel 报表。', '这个项目是一个 API 接口服务。']) {
    const continued = adaptive.adaptiveTaskFeatures?.('继续排查这个问题。', [
      { role: 'user', turn: 4, source: 'events', text: objectStatement },
    ])
    assert.ok(continued.includes('opdebug') && continued.some(feature => ['excel', 'api'].includes(feature)),
      'a current operation can use a trusted topic-only prior turn: ' + objectStatement)
  }
  assert.deepEqual(adaptive.adaptiveTaskFeatures?.('继续这个排查', [
    { role: 'user', turn: 4, source: 'events', text: '“这是插件交付验收单，核对宿主实际加载版本。”' },
  ]), [], 'quoted history cannot supply a requirement')
  const explicit = adaptive.adaptiveTaskFeatures?.('现在换到 Excel 日期格式校验，先定位问题', task)
  assert.ok(explicit.includes('date') && explicit.includes('excel') && explicit.includes('validate'))
  assert.ok(!explicit.includes('plugin') && !explicit.includes('version'),
    'unrelated older task context is ignored when the current request is explicit')
})
