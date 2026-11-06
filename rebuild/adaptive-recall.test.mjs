import test from 'node:test'
import assert from 'node:assert/strict'
import { addAdaptiveCandidate, adaptiveQueryFeatures, adaptiveQueryKey,
  synthesizeAdaptivePolicy } from './adaptive-recall.mjs'
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
