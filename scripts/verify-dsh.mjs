// Exercises the packed plugin through installed Cordis, with isolated state and no model calls.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const [archive, modules] = process.argv.slice(2).map(x => resolve(x))
assert.ok(archive && modules, 'usage: node scripts/verify-dsh.mjs <npm-tarball> <host-node_modules>')
const root = mkdtempSync(join(tmpdir(), 'mse-cordis-native-'))
let ctx, fiber
try {
  execFileSync('tar', ['-xzf', archive, '-C', root])
  symlinkSync(modules, join(root, 'package/node_modules'), 'dir')
  const { evaluatePluginCompatibility, getDshRuntimeVersion } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-app-boot/lib/index.js')))
  const manifest = JSON.parse(readFileSync(join(root, 'package/package.json'), 'utf8'))
  assert.equal(evaluatePluginCompatibility(manifest), undefined, 'packed manifest must pass the real host compatibility gate without exemptions')
  const { Context } = await import(pathToFileURL(join(modules, '@deepseek-ai/cordis/lib/index.js')))
  const { default: plugin } = await import(pathToFileURL(join(root, 'package/adapters/dsh/index.mjs')))
  const mount = async () => {
    ctx = new Context()
    ctx.provide('agents', {}); ctx.provide('tools', {})
    ctx.provide('dshHomePath', (...parts) => join(root, 'profile', ...parts))
    ctx.provide('llm', { async *stream() { throw new Error('unexpected_model_call') } })
    fiber = ctx.plugin(plugin, { reflectionEnabled: false })
    await fiber.await()
    assert.ok(ctx.mseLearning, 'learning service mounted')
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
  console.log(JSON.stringify({ ok: true, layer: 'packed Cordis lifecycle', runtimeVersion: getDshRuntimeVersion(),
    compatibilityAccepted: true, restartRecall: true,
    committedAdoption: true, repeatedContextSuppressed: true, legacyConflictPaused: true, modelCalls: 0 }))
} finally {
  await fiber?.dispose(); await ctx?.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
}
