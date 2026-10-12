import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * The RELEASED generic CLI contract, asserted from outside the process.
 *
 * Stage 4a opened a small number of new trusted entry points. An earlier revision of that change
 * routed EVERY operation through a projection table keyed by operation name, so any released
 * operation the table did not name (`record`, `list`, `history`, `evaluate`, `migrate`, ...)
 * received `{}` instead of its own document: `record {eventId, source, kind, methodId}` started
 * answering `invalid_input` with exit 1. That is a behaviour change to a published interface, and
 * the only acceptable rule is the one asserted here — an operation that was not extended keeps its
 * verbatim input behaviour, and only the newly exposed entry points are bounded.
 */
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
const HEX64 = 'a'.repeat(64)
const instruction = '核对来源与产物的记录标识一致，仅将来源未知的对应字段保留为空值'

function run(stateRoot, op, input = {}, adapterId = 'generic') {
  const child = spawnSync(process.execPath, [cli], {
    input: JSON.stringify({ config: { stateRoot, adapterId }, op, input }), encoding: 'utf8' })
  assert.ok(child.stdout, child.stderr)
  return { code: child.status, body: JSON.parse(child.stdout) }
}
function root(t) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-cli-contract-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  return stateRoot
}
/** Byte-and-mtime fingerprint of the whole state directory: a read may not change it at all. */
function fingerprint(stateRoot) {
  return readdirSync(stateRoot).sort().map(name => {
    const info = statSync(join(stateRoot, name))
    return [name, info.size, info.mtimeMs,
      info.isFile() ? readFileSync(join(stateRoot, name), 'utf8') : '<dir>']
  })
}

test('a released operation still receives its own document verbatim (the reviewed regression)', t => {
  const stateRoot = root(t)
  const packed = { eventId: 'packed-method', source: 'host_proposal', kind: 'method', methodId: 'preserve-null-v1' }
  const recorded = run(stateRoot, 'record', packed)
  assert.equal(recorded.code, 0, JSON.stringify(recorded.body))
  assert.equal(recorded.body.ok, true)
  assert.equal(recorded.body.duplicate, false)
  assert.equal(recorded.body.status, 'candidate')
  // The document the caller sent is what the core saw: the same fields, no projection in between.
  // `methodId` is a REGISTERED algorithm, so the core canonicalises the instruction itself — the
  // lesson that lands is the registered method's own text, not the raw field, which is only
  // reachable when the whole document (including `methodId`) survived the transport.
  const listed = run(stateRoot, 'list', {})
  assert.equal(listed.code, 0)
  assert.equal(listed.body.lessons.length, 1)
  assert.equal(listed.body.lessons[0].methodId, 'preserve-null-v1')
  assert.match(listed.body.lessons[0].instruction, /来源/u)
  // And the refusal this used to produce is gone for the SAME request bytes.
  assert.notEqual(recorded.body.code, 'invalid_input')
})

test('fields the generic CLI does not name still reach the released operation', t => {
  const stateRoot = root(t)
  // `record` requires `source` and `kind`; both are fields a projection table would have to know
  // about. A projection that drops either one is indistinguishable from the regression above.
  assert.equal(run(stateRoot, 'record', { eventId: 'x1', kind: 'method', methodId: 'preserve-null-v1' }).body.code,
    'untrusted_source')
  // The core's OWN verdict on a field a projection would have dropped: `kind: 'bogus'` is only
  // refutable by the core if the value reached it intact, and the answer must be the core's code,
  // never a transport-level `invalid_request`/`invalid_operation`.
  const bogus = run(stateRoot, 'record', { eventId: 'x2', source: 'direct_user', kind: 'bogus', instruction })
  assert.equal(bogus.code, 1)
  assert.equal(bogus.body.code, 'invalid_input')
  // An operation with no required identity at all still sees its own document: an unknown field is
  // carried to the core, which is free to ignore it, instead of being silently emptied here.
  const status = run(stateRoot, 'status', { notAFieldOfThisOp: true })
  assert.equal(status.code, 0, JSON.stringify(status.body))
  assert.equal(status.body.ok, true)
  // `history` is released and takes a lesson identity: with the caller's own (empty) document it
  // must reach the core and be refused BY THE CORE as a missing lesson, never as a transport-level
  // `invalid_operation`, and never as a success fabricated from a projected-away input.
  const history = run(stateRoot, 'history', {})
  assert.equal(history.code, 1)
  assert.equal(history.body.code, 'lesson_unavailable')
  // A lesson the caller can really name is answered: the operation is intact, not merely refusing.
  const recorded = run(stateRoot, 'record', { eventId: 'h1', source: 'direct_user', kind: 'correction',
    instruction: '导出前把金额列转换为数值类型再排序，避免字符串比较' })
  assert.equal(recorded.code, 0, JSON.stringify(recorded.body))
  const named = run(stateRoot, 'history', { lessonId: recorded.body.id })
  assert.equal(named.code, 0, JSON.stringify(named.body))
  assert.equal(named.body.lessonId, recorded.body.id)
})

test('an unknown operation is still refused, and the 65 KiB request budget is unchanged', t => {
  const stateRoot = root(t)
  const unknown = run(stateRoot, 'problemStatus_v2', {})
  assert.equal(unknown.code, 1)
  assert.equal(unknown.body.code, 'invalid_operation')
  // The published transport bound: a request over 65,536 UTF-8 bytes is refused as
  // `input_too_large`, and the new entry points did not widen it.
  const child = spawnSync(process.execPath, [cli], { encoding: 'utf8', input: JSON.stringify({
    config: { stateRoot, adapterId: 'generic' }, op: 'observeProblem',
    input: { sessionId: 's', turnId: '1', kind: 'tool_failure', source: 'host_event',
      eventId: `x-${'a'.repeat(70_000)}` } }) })
  assert.equal(child.status, 1)
  assert.equal(JSON.parse(child.stdout).code, 'input_too_large')
  assert.deepEqual(fingerprint(stateRoot), [], 'a refused request writes no state')
})

test('a problem-bound reflection is all-or-nothing, and the released explicit path is untouched', t => {
  const stateRoot = root(t)
  const bound = extra => run(stateRoot, 'reflectionRequest', { sessionId: 's', turnId: '1',
    taskSummary: instruction, resultSummary: '两次独立工具失败，未收到助手总结', outcome: 'failed', ...extra })
  assert.equal(bound({ problemId: 'not-a-hash', evidenceRevision: 2 }).body.code, 'invalid_problem_binding')
  assert.equal(bound({ problemId: HEX64 }).body.code, 'invalid_problem_binding')
  assert.equal(bound({ evidenceRevision: 2 }).body.code, 'invalid_problem_binding')
  assert.equal(bound({ problemId: HEX64, evidenceRevision: -1 }).body.code, 'invalid_problem_binding')
  assert.equal(fingerprint(stateRoot).length, 0, 'a malformed binding writes nothing at all')
  // The RELEASED explicit path (no binding fields at all) still behaves exactly as before.
  const legacy = run(stateRoot, 'reflectionRequest', { sessionId: 's', turnId: '2', taskSummary: instruction,
    resultSummary: '任务已完成', outcome: 'supported' })
  assert.equal(legacy.code, 0, JSON.stringify(legacy.body))
  assert.equal(legacy.body.ok, true)
})

test('the newly exposed reads write nothing, and the newly exposed write is bounded', t => {
  const stateRoot = root(t)
  // A read of a store that has never been written: answers, and creates nothing.
  for (const [op, input] of [['problemStatus', { limit: 5 }], ['recentAdoptions', {}],
    ['reflectionPlan', { sessionId: 's', turnId: '1', taskSummary: '导出金额并排序', resultSummary: '任务已完成', outcome: 'supported' }],
    ['problemRecoveryPlan', { problemId: 'a'.repeat(64) }],
    // Stage 4b's read surface: the due feed, the read-only control generation and the source ledger.
    ['problemDueFeed', { limit: 5 }], ['controlGeneration', {}], ['sourceStatus', { limit: 5 }]]) {
    const answer = run(stateRoot, op, input)
    assert.equal(answer.code, 0, `${op}: ${JSON.stringify(answer.body)}`)
    assert.equal(answer.body.ok ?? true, true)
  }
  assert.deepEqual(fingerprint(stateRoot), [], 'read entry points write nothing at all')
  // Stage 4b's WRITE entry points are bounded and projected; each is exercised in its own case, and
  // an operation this build never opened is still refused.
  for (const op of ['inventAnOperation', 'problemPump', 'sourceGrant']) {
    const refused = run(stateRoot, op, {})
    assert.equal(refused.code, 1, `${op} is not part of this surface`)
    assert.equal(refused.body.code, 'invalid_operation')
  }
  assert.deepEqual(fingerprint(stateRoot), [], 'a refused operation writes nothing')
  // A field the entry point does not define is dropped BEFORE the core sees it: `problemStatus`
  // takes a limit and a scope, so an `eventId` marker meant for another operation must not survive.
  assert.equal(run(stateRoot, 'problemStatus', { limit: 5, eventId: 'x' }).code, 0)
  assert.deepEqual(fingerprint(stateRoot), [], 'a projected-away field writes nothing')
  // An undefined field that would make the core refuse proves the projection is real: the summary
  // field of `observeProblem` is projected through, a `prompt` (prepare's field) is not.
  const good = run(stateRoot, 'observeProblem', { sessionId: 's', turnId: '1', eventId: 'call-1',
    kind: 'tool_failure', source: 'host_event', toolName: 'terminal', failureCode: 'tool_nonzero_exit' })
  assert.equal(good.body.ok, true, JSON.stringify(good.body))
  assert.equal(good.body.ready, false, 'one failure is never ready on its own')
  const duplicated = run(stateRoot, 'observeProblem', { sessionId: 's', turnId: '1', eventId: 'call-1',
    kind: 'tool_failure', source: 'host_event', toolName: 'terminal', failureCode: 'tool_nonzero_exit' })
  assert.equal(duplicated.body.duplicate, true, 'a replay of the same host event is not new evidence')
  const second = run(stateRoot, 'observeProblem', { sessionId: 's', turnId: '1', eventId: 'call-2',
    kind: 'tool_failure', source: 'host_event', toolName: 'terminal', failureCode: 'tool_nonzero_exit' })
  assert.equal(second.body.ready, true, 'two independent failures cross the core threshold')
  assert.equal(second.body.problem.evidenceRevision, 2)
})
