import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningEngine, reflect } from '../src/index.mjs'

test('bounded background reflection learns an open method without giving it verified credit or storing the transcript', async t => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-reflect-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  let now = Date.now(), calls = 0
  const engine = new LearningEngine({ stateRoot, adapterId: 'reflection', now: () => now })
  const input = { sessionId: 'one', turnId: '1', outcome: 'supported', taskSummary: '按照金额对表格进行排序',
    resultSummary: '独特的测试摘要：检查金额数据后按数值排序完成；实际结果仍需核验' }
  const runner = async request => {
    calls++; assert.equal(request.maxTokens, 384)
    return JSON.stringify({ instruction: '导出金额时先将金额转换为数值，按数值排序并核对顺序' })
  }
  assert.equal((await reflect(engine, input, runner)).ok, true)
  assert.equal(engine.status().counts.candidate, 1)
  assert.equal(engine.status().verified, 0)
  const prepared = engine.prepare({ sessionId: 'next', turnId: '1', origin: 'user', prompt: '导出金额并排序' })
  assert.equal(prepared.context, '', 'unvalidated generated advice must not affect live tasks')
  assert.ok(!readFileSync(join(stateRoot, 'lessons-v1.json'), 'utf8').includes('独特的测试摘要'))
  assert.equal((await reflect(engine, input, runner)).skipped, 'duplicate')
  assert.equal((await reflect(engine, { ...input, turnId: '2' }, runner)).skipped, 'reflection_budget')
  for (let n = 2; n <= 3; n++) { now += 31 * 60_000; await reflect(engine, { ...input, turnId: String(n) }, runner) }
  now += 31 * 60_000
  assert.equal((await reflect(engine, { ...input, turnId: '4' }, runner)).skipped, 'reflection_budget')
  assert.equal(calls, 3)
})

test('sensitive summaries and extra output keys cannot create lessons', async t => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-reflect-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const engine = new LearningEngine({ stateRoot, adapterId: 'reflection' })
  const input = { sessionId: 'one', turnId: '1', outcome: 'failed', taskSummary: '根据表格处理数据并导出金额', resultSummary: '检测到金额列使用字符串排序，处理失败' }
  let calls = 0
  const skipped = await reflect(engine, { ...input, taskSummary: '处理数据 api_key=PRIVATE_TOKEN，不应发送' }, async () => { calls++ })
  assert.equal(skipped.skipped, 'sensitive_summary'); assert.equal(calls, 0)
  const invalid = await reflect(engine, input, async () => '{"instruction":"先检查金额数值再排序","verified":true}')
  assert.equal(invalid.ok, false); assert.equal(engine.status().lessons, 0)
})

test('unload cancellation prevents a late model response from creating lessons', async t => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-reflect-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const engine = new LearningEngine({ stateRoot, adapterId: 'reflection' })
  const lifetime = new AbortController()
  const result = await reflect(engine, { sessionId: 'one', turnId: '1', outcome: 'failed',
    taskSummary: '根据表格处理数据并导出金额', resultSummary: '检测到金额列使用字符串排序，处理失败' }, async () => {
    lifetime.abort()
    return '{"instruction":"导出金额前先转为数值，再按金额排序"}'
  }, lifetime.signal)
  assert.equal(result.ok, false)
  assert.equal(engine.status().lessons, 0)
})
