/**
 * Stage 3c business acceptance: the bounded adoption index and precise correction attribution.
 *
 * Real core, real store, real domain pack, synthetic clock, and NO model: every trial is earned
 * through the product's own review contract (`autoPlanRegister` → `reviewRequest` → `reviewResult`
 * against the registered lifecycle pack), so a fixture can never hand itself a licence the product
 * would not grant. `realProviderCalls` is 0 for every case here.
 *
 * The matrix is the one in the stage-3c handoff: the positive path, the idempotence of a repeated
 * turn, every refusal the design demands (prepare-only, cancelled, another session/scope/environment,
 * vague, quoted, tool, internal, new preference, ambiguous, stale version), a separate-process
 * rebuild, the session cap, and the TTL — including the assertion that the TTL case really tests the
 * INDEX TTL rather than a lesson version change hiding it.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { LearningEngine } from '../src/index.mjs'
import { getDomainPack, packCaseCriteriaHash, packCases, packScenarioHash } from '../src/domains.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = '/synthetic/stage3c-project'
const OTHER_PROJECT = '/synthetic/stage3c-other'
const ENVIRONMENT = 'stage3c-environment'
const OTHER_ENVIRONMENT = 'stage3c-other-environment'
const PACK_ID = 'mse-lifecycle-v1'
const PACK = getDomainPack(PACK_ID)
const CASE = packCases(PACK_ID).find(row => row.family === 'generation_ordering')
const METHOD = '处理请求时先记录代次，再把迟到结果按代次丢弃'
const OTHER_METHOD = '处理并发票据时先持有互斥锁，再把重复提交按票据唯一性拒绝'
const sha = text => createHash('sha256').update(text).digest('hex')
const turnHashOf = (sessionId, turnId) => sha(JSON.stringify([sessionId, String(turnId)]))
const correctionFor = method => `刚才你采用的“${method}”这条方法不完整。以后不要再用这条方法处理请求；回写之前必须重新核对当前代次。`
/** Every state root of this file lives outside the repository, in the test's own temp tree. */
const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'mse-stage3c-'))

/**
 * One isolated engine on a synthetic clock, plus the formal review contract that earns a trial.
 * `createTrial` is deliberately the ONLY door to a licence: no fixture writes `lesson.trial`.
 */
function fixture(t, { environmentId = ENVIRONMENT } = {}) {
  const root = join(TEMP_ROOT, `case-${++fixture.serial}`)
  let clock = Date.UTC(2030, 0, 1)
  const engine = new LearningEngine({ stateRoot: root, adapterId: 'dsh', now: () => clock,
    evaluationTokensPerDay: 60_000, evaluationCallsPerDay: 8 })
  let serial = 0
  const state = () => engine.store.read()
  const row = id => state().lessons.find(x => x.id === id)
  const bindings = () => engine.recentAdoptions().adoptions
  const corrections = () => (state().problemLoop?.problems ?? []).filter(x => x.kind === 'user_correction')

  const createTrial = (instruction = METHOD, existingId = null) => {
    const candidate = existingId === null
      ? engine.record({ projectKey: PROJECT, environmentId, kind: 'method', source: 'host_proposal',
        eventId: `create-${++serial}`, instruction })
      : { id: existingId }
    const lesson = row(candidate.id)
    const plan = engine.autoPlanRegister({ lessonId: lesson.id, version: lesson.version,
      environment: lesson.environment, track: 'review',
      source: { kind: 'turn', sessionId: `source-${serial}`, turnId: String(serial), projectKey: PROJECT,
        route: { provider: 'stage3c-fixture', model: 'synthetic' } },
      suite: { packId: PACK_ID, version: PACK.version }, criteria: CASE.criteria }).plan
    const binding = { packId: PACK_ID, packVersion: PACK.version, caseId: CASE.caseId,
      scenarioHash: packScenarioHash(PACK_ID, CASE.caseId), criteriaHash: packCaseCriteriaHash(PACK_ID, CASE.caseId),
      criteria: CASE.criteria }
    const request = engine.reviewRequest({ lessonId: lesson.id, expectedVersion: lesson.version,
      projectKey: PROJECT, environmentId, maxTokens: 4_000, queueKey: plan.queueKey, planHash: plan.planHash,
      shortAnswersAllowed: true, ...binding })
    assert.ok(request.ticket, `the fixture must really reserve a review: ${JSON.stringify(request)}`)
    const judge = JSON.stringify({ winner: 'tie',
      perCriterion: CASE.criteria.map(x => ({ id: x.id, met: 'both' })) })
    const result = engine.reviewResult({ ticket: request.ticket, projectKey: PROJECT, environmentId,
      planHash: plan.planHash, ...binding, first: judge, second: judge, swapped: true, structuredPassed: true,
      answers: { candidate: 'DISCARD', baseline: 'DISCARD' }, shortAnswersAllowed: true, costKnown: true, spent: 128 })
    assert.equal(row(lesson.id).trial?.state, 'trial', 'the fixture must really earn a trial')
    return row(lesson.id)
  }

  /**
   * The next unused turn number of one session.
   *
   * Turns matter here: a session's recall budget is spent per turn, a receipt is keyed by its turn,
   * and a correction must be a LATER turn than the adoption it refers to. A fixture that reused a
   * turn number would silently test neither, so every prepare/adopt/correction takes a fresh turn
   * unless the test explicitly binds one.
   */
  const turns = new Map()
  const nextTurn = (sessionId = 'adopt-session') => {
    const used = turns.get(sessionId) ?? 0
    turns.set(sessionId, used + 1)
    return String(used + 1)
  }

  const prepare = (lesson, { sessionId = 'adopt-session', turnId = nextTurn(sessionId), ...extra } = {}) => {
    const identity = { projectKey: PROJECT, environmentId, sessionId, turnId }
    const result = engine.prepare({ ...identity, origin: 'user', prompt: lesson.instruction, ...extra })
    assert.ok(result.lessons.includes(lesson.id), 'the fixture must genuinely offer the intended trial')
    return { identity, result }
  }

  /** A REAL adoption: prepare → accept → complete(unknown). The receipt is gone afterwards. */
  const adopt = (lesson, identity = {}) => {
    // The identity comes from `prepare` itself, so an explicit session and an implicit one can never
    // drift apart — a fixture bug there would silently write two session records instead of one.
    const { identity: bound, result } = prepare(lesson, identity)
    engine.accept({ receipt: result.receipt, lessonIds: [lesson.id] })
    engine.complete({ ...bound, outcome: 'unknown' })
    return bound
  }

  /** A correction in the NEXT turn of the same session, unless the test binds another one. */
  const correct = (identity, prompt = correctionFor(METHOD), extra = {}) => engine.prepare({
    ...identity, turnId: identity.turnId === undefined ? nextTurn(identity.sessionId) : String(Number(identity.turnId) + 1),
    origin: 'user', prompt, ...extra })

  const advance = ms => { clock += ms }
  return { root, engine, state, row, bindings, corrections, createTrial, prepare, adopt, correct,
    now: () => clock, advance, identity: (sessionId, turnId = '1') => ({ projectKey: PROJECT, environmentId, sessionId, turnId }) }
}
fixture.serial = 0

/** A trial that survived untouched: version, licence, and both objective counters. */
function assertUntouched(before, after, why) {
  assert.equal(after.version, before.version, why)
  assert.deepEqual(after.trial, before.trial, why)
  assert.equal(after.failed, before.failed, why)
  assert.equal(after.verified, before.verified, why)
  assert.equal(after.adopted, before.adopted, why)
}

function assertWithdrawn(engine, lessonId, expectedVersion) {
  const current = engine.store.read().lessons.find(x => x.id === lessonId)
  assert.equal(current.trial?.state, 'withdrawn', 'the licensing trial must be withdrawn')
  assert.equal(current.version, expectedVersion,
    'a natural-language correction revokes the licence; it never opens a new lesson version')
  assert.equal(current.failed, 0, 'a correction must not forge a checker failure')
  assert.equal(current.verified, 0, 'a correction must not forge host verification')
}

// ------------------------------------------------------------------ the index itself

test('only a real accept writes the adoption index, and it outlives the receipt it came from', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  assert.equal(f.bindings().length, 0, 'creating a trial is not an adoption')

  const { identity, result } = f.prepare(lesson)
  assert.equal(f.bindings().length, 0, 'prepare offers; it does not adopt')
  f.engine.accept({ receipt: result.receipt, lessonIds: [lesson.id] })
  assert.equal(f.state().receipts.length, 1, 'the receipt is still open after accept')

  const [record] = f.bindings()
  assert.equal(record.sessionHash, sha(identity.sessionId))
  assert.equal(record.scope, f.row(lesson.id).scope)
  assert.equal(record.environment, f.row(lesson.id).environment)
  assert.equal(record.turnHash, turnHashOf(identity.sessionId, identity.turnId))
  assert.equal(record.at, f.now())
  assert.deepEqual(record.lessons, [{ id: lesson.id, version: lesson.version, tier: 'trial' }])
  assert.equal(f.engine.recentAdoptions().contract.maxSessions, 64)
  assert.equal(f.engine.recentAdoptions().contract.ttlMs, 7 * 24 * 60 * 60_000)
  assert.ok(f.engine.recentAdoptions().contract.ttlMs <= 30 * 24 * 60 * 60_000,
    'the declared window stays inside the design ceiling')
  assert.equal(JSON.stringify(record).includes(METHOD), false, 'the index stores no lesson text')

  f.engine.complete({ ...identity, outcome: 'unknown' })
  assert.equal(f.state().receipts.length, 0, 'settlement deletes the receipt')
  assert.equal(f.bindings().length, 1, 'the adoption binding survives the receipt it was written with')
  assert.equal(f.row(lesson.id).adopted, 1)
})

test('a repeated accept is idempotent and does not re-date the binding', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  const { identity, result } = f.prepare(lesson)
  f.engine.accept({ receipt: result.receipt, lessonIds: [lesson.id] })
  const before = f.bindings()[0]
  f.advance(60_000)
  const again = f.engine.accept({ receipt: result.receipt, lessonIds: [lesson.id] })
  assert.equal(again.duplicate, true)
  assert.deepEqual(f.bindings()[0], before, 'a replayed accept adds no fact and no time')
  assert.equal(f.row(lesson.id).adopted, 1, 'a replayed accept must not double-count adoption')
  f.engine.complete({ ...identity, outcome: 'unknown' })
})

test('a direct correction is observed exactly once per turn and never as a second turn', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  const identity = f.adopt(lesson)
  f.engine.complete({ ...identity, outcome: 'unknown' })
  assert.equal(f.corrections().length, 0, 'no correction has been stated yet')
  f.correct(identity)
  const rows = f.corrections()
  assert.equal(rows.length, 1, 'the correction enters the problem ledger')
  assert.equal(rows[0].kind, 'user_correction')
  assert.equal(rows[0].source, 'direct_user')
  assert.equal(rows[0].count, 1)
  assert.equal(rows[0].evidenceRevision, 1)
  assert.equal(JSON.stringify(rows[0]).includes(METHOD), false, 'the ledger stores no user text either')
  const snapshot = structuredClone(f.corrections())
  f.correct(identity)
  assert.deepEqual(f.corrections(), snapshot, 'the same turn cannot add a second piece of evidence')
})

// ------------------------------------------------------------------ the positive attribution

test('an explicit correction of the unique adopted current trial withdraws exactly that trial', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  const identity = f.adopt(lesson)
  const before = structuredClone(f.row(lesson.id))
  const answer = f.correct(identity)
  assert.equal(answer.attribution?.action, 'withdrawn')
  assert.equal(answer.attribution?.lessonId, lesson.id)
  assert.equal(answer.attribution?.reason, 'user_correction')
  assertWithdrawn(f.engine, lesson.id, before.version)
  assert.ok(f.corrections().length >= 1, 'the correction is also a durable observation')
  // The revocation is the LICENCE counter, exactly like the public withdrawTrial: a review ticket
  // reserved before it can no longer re-grant the trial.
  assert.ok(f.row(lesson.id).reviewRevoked >= 1)
})

test('the correction turn itself is never offered as a later adoption', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  const identity = f.adopt(lesson)
  f.correct(identity)
  const after = f.bindings()
  assert.equal(after.length, 1, 'the correction turn adopts nothing new')
  assert.equal(after[0].lessons.length, 1, 'and cannot extend the session binding')
  assert.equal(after[0].lessons[0].version, lesson.version)
})

test('a licence withdrawal restores no status and promotes nothing', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  const identity = f.adopt(lesson)
  const before = structuredClone(f.row(lesson.id))
  f.correct(identity)
  const after = f.row(lesson.id)
  assert.equal(after.status, before.status, 'the status the review earned is history, not a licence')
  assert.deepEqual(after.validation, before.validation, 'a withdrawal invents no verdict')
  assert.equal(after.adopted, before.adopted)
})

// ------------------------------------------------------------------ refusals: no adoption at all

for (const cancelled of [false, true]) {
  test(cancelled ? 'a cancelled offer is not an adoption' : 'a prepared offer that was never accepted is not an adoption', t => {
    const f = fixture(t)
    const lesson = f.createTrial()
    const { identity, result } = f.prepare(lesson)
    if (cancelled) f.engine.cancel({ receipt: result.receipt })
    f.engine.complete({ ...identity, outcome: 'unknown' })
    assert.equal(f.bindings().length, 0, 'nothing was adopted, so nothing may be attributed')
    const before = structuredClone(f.row(lesson.id))
    const answer = f.correct(identity)
    assert.equal(answer.attribution?.action, 'none')
    assert.equal(answer.attribution?.reason, 'no_current_adoption')
    assertUntouched(before, f.row(lesson.id), 'a proposed method must survive a correction of the answer that used it')
  })
}

// ------------------------------------------------------------------ refusals: another boundary

for (const [name, change] of Object.entries({
  session: { sessionId: 'other-session' },
  scope: { projectKey: OTHER_PROJECT },
  environment: { environmentId: OTHER_ENVIRONMENT },
})) {
  test(`a correction from another ${name} cannot withdraw this session's adoption`, t => {
    const f = fixture(t)
    const lesson = f.createTrial()
    const identity = f.adopt(lesson)
    const before = structuredClone(f.row(lesson.id))
    const answer = f.engine.prepare({ ...identity, ...change, turnId: '9', origin: 'user',
      prompt: correctionFor(METHOD) })
    // A different project is a different scope, so the trial is not even offered there; either way
    // the licence stays exactly where it was.
    assert.notEqual(answer.attribution?.action, 'withdrawn')
    assertUntouched(before, f.row(lesson.id), `${name} is a boundary, not a hint`)
  })
}

// ------------------------------------------------------------------ refusals: the utterance itself

for (const [name, prompt, extra, observed] of [
  ['a vague complaint', '刚才不对，重来。', {}, false],
  ['a pasted example', `例如用户可能会这样说：${correctionFor(METHOD)}`, {}, false],
  // Somebody else's requirement is not the user's correction: it may not enter the ledger as a
  // `direct_user` observation, and it may not become a learned correction either. The user's own
  // sentence (the positive case at the top of this file) is unaffected.
  ['a relayed requirement', `他说：${correctionFor(METHOD)}`, {}, false],
  ['tool-origin text', correctionFor(METHOD), { origin: 'tool' }, false],
  ['internal-origin text', correctionFor(METHOD), { origin: 'internal' }, false],
  ['a new formatting preference', '以后回复请使用简体中文，解释时请先写结论。', {}, true],
  ['a rejection of something never adopted', `“${OTHER_METHOD}”这条以后不要再用。`, {}, true],
]) {
  test(`${name} never withdraws a licence`, t => {
    const f = fixture(t)
    const lesson = f.createTrial()
    const identity = f.adopt(lesson)
    const before = structuredClone(f.row(lesson.id))
    const library = structuredClone(f.state().lessons.map(row => row.instruction))
    const ledger = structuredClone(f.corrections())
    const answer = f.correct(identity, prompt, extra)
    assert.notEqual(answer.attribution?.action, 'withdrawn')
    assertUntouched(before, f.row(lesson.id), 'nothing precise was named, so nothing is withdrawn')
    if (!observed) {
      assert.deepEqual(f.corrections(), ledger, 'this text is not a direct user correction at all')
      assert.deepEqual(f.state().lessons.map(row => row.instruction), library,
        'and somebody else\'s words must not become a learned correction either')
    } else {
      assert.notEqual(f.corrections().length, 0, 'a real requirement is still observed')
    }
  })
}

test('a rejection that names no method withdraws nothing, however plausible it reads', t => {
  const f = fixture(t)
  const first = f.createTrial()
  const second = f.createTrial(OTHER_METHOD)
  f.adopt(first, { sessionId: 'ambiguous-session', turnId: '1' })
  const identity = f.adopt(second, { sessionId: 'ambiguous-session', turnId: '2' })
  const before = [structuredClone(f.row(first.id)), structuredClone(f.row(second.id))]
  const answer = f.correct(identity, '刚才这两条处理方法都不对，以后都不要再用，按我说的来。')
  assertUntouched(before[0], f.row(first.id), 'without a reference the correction cannot choose, so it chooses nothing')
  assertUntouched(before[1], f.row(second.id), 'without a reference the correction cannot choose, so it chooses nothing')
  assert.equal(answer.attribution?.action, 'pending', 'a real correction that names nothing stays for review')
  assert.equal(answer.attribution?.reason, 'attribution_unreferenced')
  assert.deepEqual(answer.attribution?.candidates, [], 'and it nominates no candidate at all')
  assert.ok(f.corrections().length >= 1, 'the correction itself is still observed')
})

test('a correction is attributed to the adopted method, never to a merely similar one in the library', t => {
  const f = fixture(t)
  const adopted = f.createTrial()
  const similar = f.createTrial(OTHER_METHOD)   // same pack, same scope, never adopted
  const identity = f.adopt(adopted, { sessionId: 'one-adoption', turnId: '1' })
  assert.equal(f.row(similar.id).adopted, 0)
  const beforeSimilar = structuredClone(f.row(similar.id))
  const beforeAdopted = structuredClone(f.row(adopted.id))
  const answer = f.correct(identity, `刚才采用的“${METHOD}”这条方法不对，以后不要再用；改用别的办法处理。`)
  assert.equal(answer.attribution?.action, 'withdrawn')
  assert.equal(answer.attribution?.lessonId, adopted.id)
  assert.equal(answer.attribution?.candidates.length, 1, 'exactly the adopted method, not the similar one')
  assertWithdrawn(f.engine, adopted.id, beforeAdopted.version)
  assertUntouched(beforeSimilar, f.row(similar.id), 'a method nobody adopted keeps its licence')
})

test('a relayed requirement is neither observed nor learned, while the user\'s own words still are', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  const identity = f.adopt(lesson)
  const before = structuredClone(f.row(lesson.id))
  const library = structuredClone(f.state().lessons.map(row => row.instruction))
  const relayed = f.correct(identity, `他说：${correctionFor(METHOD)}`)
  assert.equal(relayed.attribution ?? null, null, 'a relay is not an attribution input at all')
  assert.deepEqual(f.corrections(), [], 'nobody else\'s sentence may become a direct_user observation')
  assert.deepEqual(f.state().lessons.map(row => row.instruction), library,
    'and it must not become a learned correction either')
  assertUntouched(before, f.row(lesson.id), 'a relayed requirement withdraws nothing')

  // The very same sentence in the USER's voice behaves exactly as the positive case: observed, and
  // precise enough to withdraw. This is the control that keeps the relay screen from being a mute.
  const owned = f.correct(identity, correctionFor(METHOD))
  assert.equal(owned.attribution?.action, 'withdrawn', 'the same words, spoken by the user, still land')
  assert.ok(f.corrections().length >= 1)
})

test('the user\'s own explicit adoption of a reported rule is still their own correction', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  const identity = f.adopt(lesson)
  const before = structuredClone(f.row(lesson.id))
  const answer = f.correct(identity,
    `我要求以后不要再用“${METHOD}”这条方法处理请求，回写前必须重新核对当前代次。`)
  assert.equal(answer.attribution?.action, 'withdrawn', 'explicit first-person adoption keeps working')
  assertWithdrawn(f.engine, lesson.id, before.version)
  assert.ok(f.corrections().length >= 1)
})

test('a method whose own text contains a prohibition is not rejected by that text', t => {
  const f = fixture(t)
  // The exact counterexample from the independent boundary run, including its own real offer turn:
  // the method's INSTRUCTION says "不要用", and reading that as the user's complaint withdrew a method
  // the user had just asked to keep.
  const guarded = '处理请求时不要用旧代次覆盖当前状态，先核对代次再提交'
  const lesson = f.createTrial(guarded)
  const identity = f.adopt(lesson, { prompt: '如何处理请求中的旧代次与当前状态，核对代次再提交？' })
  const before = structuredClone(f.row(lesson.id))
  const answer = f.correct(identity, `请继续保留“${guarded}”这条方法。以后输出日志必须改成 JSON。`)
  assert.notEqual(answer.attribution?.action, 'withdrawn',
    'the prohibition belongs to the quoted method, and the rest of the message rejects nothing')
  assertUntouched(before, f.row(lesson.id), 'the method the user asked to keep keeps its licence')
})

test('the same quoted prohibition is still rejected when the user really rejects it', t => {
  const f = fixture(t)
  const guarded = '处理请求时不要用旧代次覆盖当前状态，先核对代次再提交'
  const lesson = f.createTrial(guarded)
  const identity = f.adopt(lesson, { prompt: '如何处理请求中的旧代次与当前状态，核对代次再提交？' })
  const before = structuredClone(f.row(lesson.id))
  // A rejection OUTSIDE the quotation, pointing at the method, is a rejection.
  const rejected = f.correct(identity, `注意：“${guarded}”这条方法不完整，以后不要再用这条方法处理请求。`)
  assert.equal(rejected.attribution?.action, 'withdrawn')
  assertWithdrawn(f.engine, lesson.id, before.version)
})

test('a correction that SWITCHES to a method does not withdraw the method it switches to', t => {
  const f = fixture(t)
  const adopted = f.createTrial()
  const replacement = f.createTrial(OTHER_METHOD)
  const identity = f.adopt(adopted, { sessionId: 'switch-session', turnId: '1' })
  const before = [structuredClone(f.row(adopted.id)), structuredClone(f.row(replacement.id))]
  // "改用" NAMES the replacement: the selector verb is what makes it wanted, so reading it as a
  // rejection would withdraw the method the user just chose.
  const answer = f.correct(identity, `上次的处理方式不对，以后改用“${OTHER_METHOD}”处理请求。`)
  assert.notEqual(answer.attribution?.action, 'withdrawn')
  assertUntouched(before[0], f.row(adopted.id), 'the complaint named no edition precisely enough')
  assertUntouched(before[1], f.row(replacement.id), 'the method being switched TO is not rejected')
})

test('one sentence that praises a method and rejects another withdraws neither by accident', t => {
  const f = fixture(t)
  const praised = f.createTrial()
  const criticised = f.createTrial(OTHER_METHOD)
  const identity = f.adopt(praised, { sessionId: 'topic-shift', turnId: '1' })
  const before = [structuredClone(f.row(praised.id)), structuredClone(f.row(criticised.id))]
  // A contrast marker opens a new topic inside the sentence: the rejection after it is about the
  // SECOND method, and the back-reach must stop at the marker instead of convicting the first.
  const answer = f.correct(identity,
    `“${METHOD}”这条很好用，另外“${OTHER_METHOD}”这条不对，以后不要再用。`)
  assert.notEqual(answer.attribution?.action, 'withdrawn')
  assertUntouched(before[0], f.row(praised.id), 'praising a method must never withdraw it')
  assertUntouched(before[1], f.row(criticised.id), 'and the criticised one was never adopted here')
})

test('a correction that names the method without rejecting it just observes', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  const identity = f.adopt(lesson)
  const before = structuredClone(f.row(lesson.id))
  const answer = f.correct(identity, `请把“${METHOD}”这条方法的适用条件再说明一遍。`)
  assert.notEqual(answer.attribution?.action, 'withdrawn')
  assertUntouched(before, f.row(lesson.id), 'quoting a method is not rejecting it')
})

// ------------------------------------------------------------------ refusals: a stale edition

test('a correction aimed at an edition that has moved on cannot revoke the current trial', t => {
  const f = fixture(t)
  const old = f.createTrial()
  const identity = f.adopt(old)
  const adoptedVersion = f.row(old.id).version
  f.engine.suspend({ projectKey: PROJECT, environmentId: ENVIRONMENT, lessonId: old.id })
  f.engine.resume({ projectKey: PROJECT, environmentId: ENVIRONMENT, lessonId: old.id })
  const fresh = f.createTrial(METHOD, old.id)
  assert.ok(fresh.version > adoptedVersion, 'the fixture must really be looking at a newer edition')
  const before = structuredClone(f.row(old.id))
  const answer = f.correct(identity, `刚才采用的旧版本方法（版本${adoptedVersion}）有误。${correctionFor(METHOD)}`)
  assert.notEqual(answer.attribution?.action, 'withdrawn')
  assertUntouched(before, f.row(old.id), 'a late correction is bound to the version it was about')
  assert.deepEqual(f.bindings()[0].lessons, [{ id: old.id, version: adoptedVersion, tier: 'trial' }],
    'the index still records the edition that was really used, not the one that replaced it')
})

// ------------------------------------------------------------------ durability and bounds

test('the index and its precise attribution survive a separate Node process', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  const identity = f.adopt(lesson)
  const input = { root: f.root, now: f.now(), identity, lessonId: lesson.id, version: lesson.version,
    turnId: '2', prompt: correctionFor(METHOD) }
  const script = join(TEMP_ROOT, 'rebuild-worker.mjs')
  writeFileSync(script, rebuildWorker())
  const child = spawnSync(process.execPath, [script, JSON.stringify(input)],
    { encoding: 'utf8', timeout: 20_000, env: { PATH: dirname(process.execPath) } })
  assert.equal(child.status, 0, child.stderr || child.error?.message)
  const result = JSON.parse(child.stdout)
  assert.deepEqual(result.bindings, f.bindings(), 'the index is a durable document, not memory')
  assert.equal(result.trial.state, 'withdrawn', 'a cold process still attributes precisely')
  assert.equal(result.trial.reason, 'user_correction')
  assert.equal(result.version, lesson.version)
  assert.equal(result.failed, 0)
  assert.equal(result.adopted, 1)
  const [record] = result.bindings
  assert.equal(record.sessionHash, sha(identity.sessionId))
  assert.equal(record.turnHash, turnHashOf(identity.sessionId, identity.turnId))
})

test('the session cap evicts the oldest adoption, and an evicted session cannot be attributed', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  const cap = f.engine.recentAdoptions().contract.maxSessions
  const identities = []
  for (let index = 0; index < cap + 2; index++) {
    identities.push(f.adopt(lesson, { sessionId: `bounded-session-${index}` }))
    f.advance(1)
    assert.ok(f.bindings().length <= cap, 'the index never exceeds its declared cap')
  }
  const retained = new Set(f.bindings().map(row => row.sessionHash))
  const evicted = identities.find(row => !retained.has(sha(row.sessionId)))
  assert.ok(evicted, 'a cap of N sessions with N+2 adoptions must evict something')
  const before = structuredClone(f.row(lesson.id))
  const answer = f.correct(evicted)
  assert.equal(answer.attribution?.action, 'none')
  assertUntouched(before, f.row(lesson.id), 'an evicted binding is genuinely unknown, not rebuilt from counters')
})

test('the index TTL alone retires a binding while the trial and version stay current', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  const identity = f.adopt(lesson)
  const versionAtAdoption = f.row(lesson.id).version
  const ttl = f.engine.recentAdoptions().contract.ttlMs
  const licence = 14 * 24 * 60 * 60_000
  // The contract is deliberately shorter than the licence it can withdraw. That ordering is what
  // makes this case decidable: at the boundary the TRIAL IS STILL LIVE, so nothing but the adoption
  // window itself can explain the outcome.
  assert.ok(ttl < licence, 'the adoption window must be shorter than the trial licence')

  // One millisecond inside the window: still evidence, and still actionable.
  f.advance(ttl - 1)
  assert.equal(f.bindings().length, 1, 'a binding inside its window is still evidence')
  assert.equal(f.row(lesson.id).version, versionAtAdoption, 'no clock change may mint a new version')
  assert.equal(f.row(lesson.id).trial.state, 'trial')
  const before = structuredClone(f.row(lesson.id))
  const inside = f.correct(identity)
  assert.equal(inside.attribution?.action, 'withdrawn', 'inside the window the correction still lands')
  assertWithdrawn(f.engine, lesson.id, before.version)

  // One millisecond past it: the same binding is no longer evidence, the licence is untouched, and
  // the write that just happened RETIRED the stale record instead of hiding it.
  const second = fixture(t)
  const other = second.createTrial()
  const otherIdentity = second.adopt(other)
  second.advance(ttl + 1)
  assert.equal(second.row(other.id).version, versionAtAdoption, 'the edition did not move either')
  assert.equal(second.row(other.id).trial.state, 'trial',
    'the licence is STILL live past the adoption window — no trial expiry can explain the refusal')
  assert.deepEqual(second.bindings(), [], 'past its window the binding is filtered out of the answer')
  const untouched = structuredClone(second.row(other.id))
  const later = second.correct(otherIdentity)
  assert.equal(later.attribution?.action, 'none')
  assert.equal(later.attribution?.reason, 'no_current_adoption')
  assertUntouched(untouched, second.row(other.id), 'a live licence the correction cannot reach stays untouched')
  assert.deepEqual(second.state().recentAdoptions.sessions, [],
    'the real write retired the expired binding instead of leaving it in the document')
})

test('an expired adoption binding cannot attribute a correction while the same version keeps a live trial', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  const identity = f.adopt(lesson)
  const versionAtAdoption = f.row(lesson.id).version
  const ttl = f.engine.recentAdoptions().contract.ttlMs
  f.advance(ttl + 1)

  // The lesson stays CURRENT on the SAME version, through the product's own lifecycle: the suspension
  // is the operator's, the resume re-opens the row, and the registered review contract grants a fresh
  // trial on the version the resume produced. `settleEvaluation` only mints a new version when a
  // review ACCEPTS a promotion — a review that merely grants a trial keeps the version, which is
  // exactly why this fixture can isolate the index TTL from "the edition moved on".
  f.engine.suspend({ projectKey: PROJECT, environmentId: ENVIRONMENT, lessonId: lesson.id })
  f.engine.resume({ projectKey: PROJECT, environmentId: ENVIRONMENT, lessonId: lesson.id })
  const fresh = f.createTrial(METHOD, lesson.id)
  assert.equal(fresh.trial.state, 'trial', 'the target licence is live again')
  assert.ok(fresh.version > versionAtAdoption, 'the formal lifecycle really did move the edition')

  const before = structuredClone(f.row(lesson.id))
  assert.deepEqual(f.bindings(), [], 'the reader filters an expired binding out of its answer')
  const answer = f.correct(identity)
  assert.equal(answer.attribution?.action, 'none')
  assert.equal(answer.attribution?.reason, 'no_current_adoption')
  assertUntouched(before, f.row(lesson.id), 'an expired adoption is not evidence, however current the trial is')
  // The write transaction that just ran must have RETIRED the stale record, not merely hidden it:
  // the read-only assertion above would also hold if the licence had lapsed, which is the confound
  // this check rules out.
  assert.deepEqual(f.state().recentAdoptions.sessions, [],
    'a real write transaction retires expired bindings instead of leaving them in the document')
})

test('the binding always describes the most recent adoption of the session', t => {
  const f = fixture(t)
  const first = f.createTrial()
  const second = f.createTrial(OTHER_METHOD)
  const session = 're-armed-session'
  f.adopt(first, { sessionId: session, turnId: '1' })
  const identity = f.adopt(second, { sessionId: session, turnId: '2' })
  const [record] = f.bindings()
  assert.equal(record.turnHash, turnHashOf(session, '2'), 'the record carries the newest adoption turn')
  assert.equal(record.at, f.now())
  assert.deepEqual(record.lessons, [{ id: second.id, version: second.version, tier: 'trial' }],
    'the record is a snapshot of ONE turn: last turn\'s selection is not carried forward')
  const beforeFirst = structuredClone(f.row(first.id))
  const beforeSecond = structuredClone(f.row(second.id))
  // The correction must NAME the second method: a correction that quotes the first one is about a
  // different edition, and the record no longer lists it.
  const answer = f.correct(identity, correctionFor(OTHER_METHOD))
  assert.equal(answer.attribution?.action, 'withdrawn')
  assert.equal(answer.attribution?.lessonId, second.id)
  assertWithdrawn(f.engine, second.id, beforeSecond.version)
  assertUntouched(beforeFirst, f.row(first.id),
    'the superseded adoption cannot be withdrawn by a correction of the newer answer')
})

test('a correction naming the superseded edition withdraws nothing at all', t => {
  const f = fixture(t)
  const first = f.createTrial()
  const second = f.createTrial(OTHER_METHOD)
  const session = 'superseded-session'
  f.adopt(first, { sessionId: session, turnId: '1' })
  const identity = f.adopt(second, { sessionId: session, turnId: '2' })
  const beforeFirst = structuredClone(f.row(first.id))
  const beforeSecond = structuredClone(f.row(second.id))
  // Same session, same scope, and the FIRST method is still a live trial — but the session's most
  // recent adoption was the second one, so quoting the first names nothing that is still current.
  const answer = f.correct(identity, correctionFor(METHOD))
  assert.equal(answer.attribution?.action, 'pending')
  assert.equal(answer.attribution?.reason, 'attribution_unreferenced')
  assertUntouched(beforeFirst, f.row(first.id), 'an older edition is not the current adoption')
  assertUntouched(beforeSecond, f.row(second.id), 'and the newer one was not the one named')
})

test('a trial the clock already ended is never retired by a correction, however fresh the adoption', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  const identity = f.adopt(lesson)
  // A binding written AFTER the licence expired — the case a maintenance pass has not reached yet.
  // The row still reads `trial`, and Stage 3b relies on exactly that state to renew it.
  f.advance(15 * 24 * 60 * 60_000)
  const stale = f.row(lesson.id)
  assert.equal(stale.trial.state, 'trial', 'maintenance has not run, so the row still says `trial`')
  assert.ok(stale.trial.at + 14 * 24 * 60 * 60_000 <= f.now(), 'and its 14-day window really has ended')
  const before = structuredClone(stale)
  const answer = f.correct(identity)
  assert.notEqual(answer.attribution?.action, 'withdrawn')
  assertUntouched(before, f.row(lesson.id), 'the clock ended this licence, not the user')
  const after = f.row(lesson.id)
  assert.equal(after.trial.state, 'trial')
  assert.notEqual(after.trial.reason, 'user_correction',
    'recording `user_correction` here would disqualify the renewal maintenance still owes this row')
})

test('one acceptance writes one snapshot, and an identical replay does not re-date it', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  const session = 'repeat-session'
  const identity = f.adopt(lesson, { sessionId: session, turnId: '1' })
  const first = structuredClone(f.bindings()[0])
  // A replayed accept of the SAME receipt is refused by the core before the index is reached, so the
  // record cannot be re-dated by a retry: one acceptance is one fact with one time.
  f.advance(3 * 60 * 60_000)
  const replay = (() => { try { return f.engine.accept({ receipt: 'not-a-receipt', lessonIds: [lesson.id] }) }
    catch (error) { return error.code ?? String(error) } })()
  assert.equal(replay, 'receipt_rejected')
  assert.deepEqual(f.bindings()[0], first, 'nothing a retry does may rewrite the stored acceptance')
  assert.equal(f.row(lesson.id).adopted, 1)
  const before = structuredClone(f.row(lesson.id))
  const answer = f.correct(identity)
  assert.equal(answer.attribution?.action, 'withdrawn')
  assertWithdrawn(f.engine, lesson.id, before.version)
})

test('the record is a snapshot of its own turn: a later adoption never inherits the older identity', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  const session = 'snapshot-session'
  f.adopt(lesson, { sessionId: session, turnId: '1' })
  const firstTurn = turnHashOf(session, '1')
  assert.equal(f.bindings()[0].turnHash, firstTurn)
  // The engine refuses to re-offer an already offered edition in the same session, so a genuinely
  // LATER adoption must pick a different one — which is exactly the case the old code got wrong by
  // carrying the first turn's binding (and its list) into the new turn's record.
  const other = f.createTrial(OTHER_METHOD)
  const identity = f.adopt(other, { sessionId: session, turnId: '2' })
  const [record] = f.bindings()
  assert.equal(record.turnHash, turnHashOf(session, '2'))
  assert.deepEqual(record.lessons, [{ id: other.id, version: other.version, tier: 'trial' }])
  assert.equal(record.at, f.now())
  const beforeLesson = structuredClone(f.row(lesson.id))
  const answer = f.correct(identity, correctionFor(OTHER_METHOD))
  assert.equal(answer.attribution?.action, 'withdrawn')
  assert.equal(answer.attribution?.lessonId, other.id)
  assertUntouched(beforeLesson, f.row(lesson.id), 'the superseded turn is not evidence any more')
})

test('a rejection of the named method cannot be moved onto a method that was only re-used', t => {
  const f = fixture(t)
  const rejected = f.createTrial()
  const reused = f.createTrial(OTHER_METHOD)
  f.adopt(rejected, { sessionId: 'mixed-session', turnId: '1' })
  const identity = f.adopt(reused, { sessionId: 'mixed-session', turnId: '2' })
  const beforeRejected = structuredClone(f.row(rejected.id))
  const beforeReused = structuredClone(f.row(reused.id))
  const answer = f.correct(identity,
    `刚才的“${METHOD}”那条不对，以后不要再用；“${OTHER_METHOD}”这条可以继续用。`)
  assertUntouched(beforeReused, f.row(reused.id),
    'the method the user explicitly KEEPS must not be withdrawn by a cue about another one')
  // The rejected one belongs to the PREVIOUS turn, so the index no longer calls it the current
  // adoption — a refusal by reference identity, not by a cue that leaked onto the wrong method.
  assertUntouched(beforeRejected, f.row(rejected.id),
    'the older adoption is no longer the turn this correction is about')
  assert.equal(answer.attribution?.action, 'pending')
  assert.equal(answer.attribution?.reason, 'attribution_unreferenced')
  assert.equal(f.row(reused.id).trial?.state, 'trial')
})

test('a cue about another method never withdraws the method the user keeps using', t => {
  const f = fixture(t)
  const kept = f.createTrial()
  const other = f.createTrial(OTHER_METHOD)
  const identity = f.adopt(kept, { sessionId: 'kept-session', turnId: '1' })
  assert.equal(f.row(other.id).adopted, 0)
  const beforeKept = structuredClone(f.row(kept.id))
  const beforeOther = structuredClone(f.row(other.id))
  const answer = f.correct(identity,
    `“${OTHER_METHOD}”这条不对，以后不要再用；“${METHOD}”这条很好，继续用。`)
  assert.notEqual(answer.attribution?.action, 'withdrawn')
  assertUntouched(beforeKept, f.row(kept.id), 'the mentioned-and-kept method keeps its licence')
  assertUntouched(beforeOther, f.row(other.id), 'and the rejected one was never adopted here')
})

test('the tier is frozen as the row was when it was accepted, not as it looks later', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  const identity = f.adopt(lesson)
  assert.equal(f.bindings()[0].lessons[0].tier, 'trial')
  // A later evaluation may promote the row; the recorded adoption must keep saying what it was.
  f.engine.store.update(state => {
    const row = state.lessons.find(x => x.id === lesson.id)
    row.status = 'validated'
    row.validation = { decision: 'accepted', experimentId: 'fixture-promotion', basis: 'registered_algorithm',
      at: f.now() }
    return true
  })
  assert.equal(f.bindings()[0].lessons[0].tier, 'trial', 'the frozen tier is history, not a live join')
  f.correct(identity)
  assert.equal(f.row(lesson.id).trial.state, 'trial', 'a validated row is not a trial to withdraw')
})

test('a receipt whose licence was withdrawn before acceptance is refused, not credited', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  const { identity, result } = f.prepare(lesson)
  assert.ok(result.lessons.includes(lesson.id), 'the fixture must be offering a real trial')
  f.engine.withdrawTrial({ lessonId: lesson.id, projectKey: PROJECT, expectedVersion: lesson.version,
    reason: 'user_correction' })
  assert.equal(f.row(lesson.id).trial.state, 'withdrawn')
  const attempt = (() => { try { return f.engine.accept({ receipt: result.receipt, lessonIds: [lesson.id] }) }
    catch (error) { return error.code ?? String(error) } })()
  assert.equal(attempt, 'receipt_stale',
    'a licence withdrawn between the offer and the acceptance cannot still authorise the adoption')
  assert.deepEqual(f.bindings(), [], 'and nothing may be recorded as adopted')
  assert.equal(f.row(lesson.id).adopted, 0)
  f.engine.complete({ ...identity, outcome: 'unknown' })
})

test('an adopted row is recorded with the tier it was OFFERED as, never a later relabelling', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  const { identity, result } = f.prepare(lesson)
  // The row is edited between the offer and the acceptance. The adoption must keep saying what the
  // user was really given — a trial — instead of picking up the new label from live state.
  f.engine.store.update(state => {
    const row = state.lessons.find(x => x.id === lesson.id)
    row.status = 'validated'
    row.validation = { decision: 'accepted', experimentId: 'fixture-relabel', basis: 'registered_algorithm',
      at: f.now() }
    return true
  })
  f.engine.accept({ receipt: result.receipt, lessonIds: [lesson.id] })
  f.engine.complete({ ...identity, outcome: 'unknown' })
  assert.deepEqual(f.bindings()[0].lessons,
    [{ id: lesson.id, version: lesson.version, tier: 'trial' }],
    'the tier is the offered one, frozen on the receipt')
})

test('a user reminder is adopted with the tier it was OFFERED as, never relabelled as verified', t => {
  const f = fixture(t)
  // A plain user rule: `status: 'reminder'`, `verified: 0`, and NOT a licensing trial.
  const reminderText = '以后处理请求结果时，请始终用 JSON 输出当前代次和处理状态'
  const captured = f.engine.prepare({ projectKey: PROJECT, environmentId: ENVIRONMENT,
    sessionId: 'reminder-source', turnId: '1', origin: 'user', prompt: `${reminderText}。` })
  assert.equal(captured.reason, 'correction_learned', 'the fixture must really learn a reminder')
  const reminder = f.row(captured.learned.id)
  assert.equal(reminder.kind, 'correction')
  assert.equal(reminder.status, 'reminder')
  assert.equal(reminder.verified, 0)

  const identity = { projectKey: PROJECT, environmentId: ENVIRONMENT, sessionId: 'reminder-session', turnId: '1' }
  // A related task in the SAME environment: the rule is offered because it applies here, and the
  // tier it is offered on is what the index must record.
  const result = f.engine.prepare({ ...identity, origin: 'user',
    prompt: '如何用 JSON 输出当前代次和处理状态？' })
  assert.ok(result.lessons.includes(reminder.id), 'the reminder is offered as a rule')
  const selected = result.lessonVersions.find(row => row.id === reminder.id)
  assert.equal(selected.tier, 'trial',
    'an unverified user rule is offered on the UNVERIFIED tier, not as a host-verified recall')
  f.engine.accept({ receipt: result.receipt, lessonIds: [reminder.id] })
  f.engine.complete({ ...identity, outcome: 'unknown' })
  const [record] = f.bindings()
  assert.deepEqual(record.lessons, [{ id: reminder.id, version: reminder.version, tier: 'trial' }],
    'the index records the offered tier verbatim — never a promotion the row never received')
  assert.notEqual(f.row(reminder.id).status, 'validated')
  assert.equal(f.row(reminder.id).verified, 0, 'and adoption is not verification')
})

test('a validated method is adopted with the verified tier it was offered as', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  // Promote it through the product's own evaluation path is out of scope for this file; what matters
  // here is that the tier recorded is the RECALL tier of the receipt, whatever it was.
  const identity = f.adopt(lesson)
  assert.equal(f.bindings()[0].lessons[0].tier, 'trial')
  const again = f.engine.recentAdoptions()
  assert.deepEqual(again.contract, { format: 1, maxSessions: 64, lessonsPerSession: 2, ttlMs: 604800000 },
    'the declared contract is what the index really obeys')
  assert.equal(identity.turnId, '1')
})

test('reading the adoption index writes nothing at all', t => {
  const f = fixture(t)
  const lesson = f.createTrial()
  f.adopt(lesson)
  f.advance(1)
  const before = readFileSync(f.engine.store.path)
  for (let index = 0; index < 5; index++) f.engine.recentAdoptions({ projectKey: PROJECT, environmentId: ENVIRONMENT })
  assert.deepEqual(readFileSync(f.engine.store.path), before, 'a read is never a write')
})

test('a document without adoptions is never initialised by a read', t => {
  const f = fixture(t)
  f.createTrial()
  assert.equal(f.state().recentAdoptions, undefined)
  const view = f.engine.recentAdoptions()
  assert.deepEqual(view.adoptions, [])
  assert.equal(view.ok, true)
  assert.equal(f.state().recentAdoptions, undefined, 'the empty view is not written to disk')
})

/** The child shipped with this test: a cold engine must still attribute the correction precisely. */
function rebuildWorker() {
  return `import { LearningEngine } from ${JSON.stringify(pathToFileURL(join(HERE, '..', 'src', 'index.mjs')).href)}
const input = JSON.parse(process.argv[2])
const engine = new LearningEngine({ stateRoot: input.root, adapterId: 'dsh', now: () => input.now })
const bindings = engine.recentAdoptions().adoptions
const answer = engine.prepare({ ...input.identity, turnId: input.turnId, origin: 'user', prompt: input.prompt })
const lesson = engine.store.read().lessons.find(x => x.id === input.lessonId)
process.stdout.write(JSON.stringify({ bindings, attribution: answer.attribution, trial: lesson.trial,
  version: lesson.version, failed: lesson.failed, adopted: lesson.adopted }))
`
}