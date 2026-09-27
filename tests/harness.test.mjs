import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningEngine } from '../src/index.mjs'
import { createHarnessBridge } from '../adapters/harness.mjs'

function fixture(t) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-harness-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh' })
  engine.record({ eventId: 'correction', source: 'direct_user', kind: 'correction', instruction: '以后导出金额前先转换为数值，再按金额排序' })
  let id = 0
  const bridge = createHarnessBridge({ engine, createMessage: text => ({ id: `plugin-${++id}`, role: 'user', source: { kind: 'plugin', plugin: 'mse-learning' }, content: [{ type: 'text', text }] }) })
  const session = { id: 'session', header: {}, events: [] }
  const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '导出金额并排序' }] }
  const payload = { agent: { session }, step: 1, turn: 1, messages: [message], signal: new AbortController().signal }
  const next = async () => ({ kind: 'enter', messages: [message] })
  return { engine, bridge, payload, next, session }
}

test('Harness stages once, credits only committed messages, and invalidates verification after a real tool write', async t => {
  const { engine, bridge, payload, next, session } = fixture(t)
  const decision = await bridge.preStep(payload, next)
  assert.equal(decision.messages.length, 2)
  assert.equal(engine.status().adopted, 0)
  assert.equal((await bridge.preStep(payload, next)).messages.length, 1)
  bridge.sessionEvent(session, { type: 'user/message', data: { id: decision.messages[1].id } })
  assert.equal(engine.status().adopted, 1)
  bridge.verification({ sessionId: session.id, turnId: 1, checkId: 'sort-check', passed: true })
  session.events.push({ type: 'tool/call', data: { callId: 'call-1', turn: 1, name: 'bash' } })
  bridge.toolExecution({ agent: { session }, callId: 'call-1', name: 'bash' }, { value: { exitCode: 0 } })
  bridge.sessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(engine.status().verified, 0); assert.equal(engine.status().inconclusive, 1)
})

test('Harness abort, disabled controller and nested sessions do not create success or inject', async t => {
  const { engine, bridge, payload, next, session } = fixture(t)
  const decision = await bridge.preStep(payload, next)
  bridge.sessionEvent(session, { type: 'user/message', data: { id: decision.messages[1].id } })
  bridge.sessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })
  assert.equal(engine.status().verified, 0); assert.equal(engine.status().inconclusive, 0)
  bridge.setEnabled(false)
  assert.equal((await bridge.preStep({ ...payload, turn: 2 }, next)).messages.length, 1)
  bridge.setEnabled(true); session.header.origin = 'subagent'
  assert.equal((await bridge.preStep({ ...payload, turn: 3 }, next)).messages.length, 1)
})

test('a native failed tool remains failure even when the model finishes normally', async t => {
  const { engine, bridge, payload, next, session } = fixture(t)
  const decision = await bridge.preStep(payload, next)
  bridge.sessionEvent(session, { type: 'user/message', data: { id: decision.messages[1].id } })
  session.events.push({ type: 'tool/call', data: { callId: 'bad', turn: 1, name: 'bash' } })
  bridge.toolExecution({ agent: { session }, callId: 'bad', name: 'bash' }, { value: { exitCode: 2 } })
  bridge.sessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(engine.status().failed, 1)
})

test('storage errors fail open and preserve the host decision', async t => {
  const { payload, next } = fixture(t)
  const bridge = createHarnessBridge({ engine: { prepare() { throw new Error('disk unavailable') } }, createMessage() { throw new Error('unreachable') } })
  assert.equal((await bridge.preStep(payload, next)).messages.length, 1)
})
