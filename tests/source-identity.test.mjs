// The producer identity of every message MSE writes, and of every message it credits (stage-3b Host
// compatibility).
//
// The session document is format v4: a message source must name a PRODUCER-OWNED kind, and the
// released `{ kind: 'plugin', plugin: ... }` wrapper is refused on write. The Host's own V3→V4
// converter lifts that wrapper into `plugin:<name>` and DROPS the `plugin` field, so MSE's canonical
// identity is `plugin:mse-learning`. These cases lock the two halves that must move together:
//   • the plugin WRITES only the producer-owned kind (`mseMessageSource`), and
//   • it still RECOGNISES the released wrapper — a historical or not-yet-migrated row — for adoption
//     credit and for the internal-review guard, WITHOUT ever mistaking a user message or another
//     producer's message for its own.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningEngine } from '../src/index.mjs'
import { createHarnessBridge, isMseSource, mseMessageSource, MSE_PRODUCER_KIND } from '../adapters/harness.mjs'

const RETIRED = { kind: 'plugin', plugin: 'mse-learning', form: 'instructions' }
const RETIRED_INTERNAL = { kind: 'plugin', plugin: 'mse-learning', form: 'internal-review' }
const OTHER = { kind: 'plugin:other-plugin', form: 'instructions' }
const RETIRED_OTHER = { kind: 'plugin', plugin: 'other-plugin', form: 'instructions' }
const OTHER_INTERNAL = { kind: 'plugin:other-plugin', form: 'internal-review' }
/**
 * The prompt that really recalls the fixture's correction: a lesson's OWN sentence is "just learned"
 * in the same turn and is deliberately not re-offered, so an exact copy would inject nothing.
 */
const RECALLING_PROMPT = '请导出金额并进行排序'
const CORRECTION = '以后导出金额前先转换为数值，再按金额排序'

const userMessage = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

function fixture(t, { source = () => mseMessageSource('instructions') } = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-source-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh' })
  engine.record({ eventId: 'correction', source: 'direct_user', kind: 'correction', instruction: CORRECTION })
  let id = 0
  const created = []
  const bridge = createHarnessBridge({ engine, createMessage: text => {
    const message = { id: `plugin-${++id}`, role: 'user', source: source(), content: [{ type: 'text', text }] }
    created.push(message)
    return message
  } })
  // The core refuses to settle under unknown host permission, which is the safe default; these cases
  // are about the message identity, so they state the permission explicitly.
  bridge.setTrustedGuard(() => true)
  const session = { id: 'source-session', header: {}, events: [] }
  const stepFrom = (messages, target = session, turn = 1) =>
    bridge.preStep({ agent: { session: target }, step: 1, turn, messages,
      signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }))
  const step = (text, turn = 1, target = session) => stepFrom([userMessage(text)], target, turn)
  const requestWith = async (sessionId, messages, reason = 'stop') => {
    for await (const chunk of bridge.stream({ sessionId, messages }, async function* () {
      yield { type: 'finish', reason: { kind: reason } }
    })) assert.equal(chunk.type, 'finish')
  }
  const request = (messages, reason = 'stop') => requestWith(session.id, messages, reason)
  return { engine, bridge, session, step, stepFrom, request, requestWith, created }
}

test('the producer-owned kind is the only message identity this plugin writes', () => {
  assert.deepEqual(mseMessageSource('instructions'), { kind: 'plugin:mse-learning', form: 'instructions' })
  assert.deepEqual(mseMessageSource('internal-review'), { kind: 'plugin:mse-learning', form: 'internal-review' })
  assert.deepEqual(mseMessageSource(), { kind: 'plugin:mse-learning' })
  assert.equal(MSE_PRODUCER_KIND, 'plugin:mse-learning')
  // Identity, not prefix matching: the exact producer kind, or the released wrapper naming THIS plugin.
  assert.equal(isMseSource(mseMessageSource('instructions')), true)
  assert.equal(isMseSource(RETIRED), true)
  assert.equal(isMseSource(OTHER), false)
  assert.equal(isMseSource(RETIRED_OTHER), false)
  assert.equal(isMseSource({ kind: 'user' }), false)
  assert.equal(isMseSource({ kind: 'plugin' }), false)
  assert.equal(isMseSource(null), false)
  // Every message source the product really writes goes through that one factory: no retired wrapper
  // may be constructed again anywhere in the adapters.
  const codeOf = path => readFileSync(new URL(path, import.meta.url), 'utf8').split('\n')
    .filter(line => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
  for (const path of ['../adapters/dsh/index.mjs', '../adapters/dsh/control.mjs', '../adapters/harness.mjs']) {
    const code = codeOf(path)
    assert.equal(code.some(line => /kind:\s*'plugin'/.test(line)), false,
      `${path} still writes the retired plugin wrapper`)
    assert.equal(code.some(line => /plugin:\s*'mse-learning'/.test(line)), false,
      `${path} still writes the retired plugin field`)
  }
  const index = codeOf('../adapters/dsh/index.mjs').join('\n')
  assert.equal((index.match(/mseMessageSource\(/gu) ?? []).length, 2, 'both recall and reflection messages')
  const control = codeOf('../adapters/dsh/control.mjs').join('\n')
  assert.equal((control.match(/mseMessageSource\(pluginForm\)/gu) ?? []).length, 1, 'every readModel request')
})

test('adoption credits the producer-owned source, and only for MSE itself', async t => {
  const f = fixture(t)
  const decision = await f.step(RECALLING_PROMPT, 1)
  assert.equal(decision.messages.length, 2, 'the recall is injected as a second message')
  const injected = decision.messages[1]
  assert.deepEqual(injected.source, { kind: 'plugin:mse-learning', form: 'instructions' })
  await f.request([userMessage(RECALLING_PROMPT), injected])
  assert.equal(f.engine.status().adopted, 1, 'the real request carrying the injected message adopts')
  // The SAME text under another identity is not our injection: a user message, another producer's
  // producer-owned kind, and the released wrapper of ANOTHER plugin all earn nothing. Each check gets
  // its own session (a repeat in one session is already offered, and would inject nothing at all).
  for (const [label, source, id] of [['a user source', { kind: 'user' }, 'neg-user'],
    ['another producer', OTHER, 'neg-other'], ['another plugin retired wrapper', RETIRED_OTHER, 'neg-retired']]) {
    const probe = await f.step(RECALLING_PROMPT, 1, { id, header: {}, events: [] })
    assert.equal(probe.messages.length, 2, `${label}: the recall really is injected in a fresh session`)
    assert.deepEqual(probe.messages[1].source, { kind: 'plugin:mse-learning', form: 'instructions' })
    await f.requestWith(id, [userMessage(RECALLING_PROMPT), { ...probe.messages[1], source }])
    assert.equal(f.engine.status().adopted, 1, `${label} is never credited as the injection`)
  }
})

test('a migrated historical message keeps its adoption credit', async t => {
  // The released wrapper is what a session written before the migration still carries (and what the
  // Host converts to the producer-owned kind): losing it would silently stop counting real use.
  const f = fixture(t, { source: () => ({ ...RETIRED }) })
  const decision = await f.step(RECALLING_PROMPT, 1)
  assert.deepEqual(decision.messages[1].source, RETIRED)
  await f.request([userMessage(RECALLING_PROMPT), decision.messages[1]])
  assert.equal(f.engine.status().adopted, 1, 'the released wrapper is still recognised as our own message')
})

test('internal review work is recognised in both identities, and never learned from', async t => {
  const f = fixture(t)
  const before = f.engine.status().lessons
  // A payload whose TEXT is an ordinary user task and whose extra message announces internal review
  // work: exactly the shape the guard exists for. The SOURCE is what has to decide.
  const cases = [
    ['producer-owned envelope', mseMessageSource('internal-review'), 'internal-current'],
    ['released wrapper', RETIRED_INTERNAL, 'internal-legacy'],
    ['another plugin released wrapper', { ...RETIRED_OTHER, form: 'internal-review' }, 'internal-foreign'],
    ['another producer kind', OTHER_INTERNAL, 'internal-other'],
  ]
  for (const [label, source, id] of cases) {
    const inner = { role: 'user', source, content: [{ type: 'text', text: '内部评审工作' }] }
    const created = f.created.length
    const decision = await f.stepFrom([userMessage(CORRECTION), inner], { id, header: {}, events: [] })
    assert.equal(decision.messages.length, 2, `${label}: nothing is appended to the request`)
    assert.equal(f.created.length, created, `${label}: internal work injects no recall at all`)
    assert.equal(f.engine.status().lessons, before, `${label}: internal work never becomes a lesson`)
    assert.equal(f.bridge.recallStatus(id).last.reason, 'internal_task',
      `${label}: recognised as internal work, not merely as a non-user source`)
  }
  // The same payload from a producer that is NOT internal is an ordinary task: it still learns, so the
  // guard never swallows real user work.
  const foreign = { role: 'user', source: OTHER, content: [{ type: 'text', text: '另一个插件的上下文' }] }
  const normal = await f.stepFrom([userMessage('以后整理导出文件时先核对列名再排序'),
    foreign], { id: 'normal', header: {}, events: [] })
  assert.equal(normal.messages.length, 2, 'an ordinary turn is processed normally')
  assert.equal(f.engine.status().lessons, before + 1, 'an ordinary task still learns')
  assert.notEqual(f.bridge.recallStatus('normal').last.reason, 'internal_task')
})
