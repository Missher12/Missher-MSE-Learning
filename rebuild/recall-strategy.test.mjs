import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDefaultCases } from '../scripts/rsi/replay.mjs'
import { RebuildEngine } from './engine.mjs'
import { selectRecall } from './recall.mjs'
import { archiveVersion } from './evolution.mjs'
import { RECALL_QUALIFICATION } from './recall-qualification.mjs'

const PROBES = join(tmpdir(), 'mse-recall-strategy-tests')
mkdirSync(PROBES, { recursive: true })
const stateRoot = () => mkdtempSync(join(PROBES, 'state-'))
const hex = text => createHash('sha256').update(text).digest('hex')
const memId = text => `mem_${hex(text).slice(0, 24)}`
const prompt = 'YAML 配置缩进报错，先帮我把格式修对'
const options = { prompt, scope: 'a'.repeat(64), environment: 'b'.repeat(64), now: 0 }

const lesson = (problemId, evidenceId) => ({
  schema: 'mse-failure-lesson-v1',
  applicability: '修复缩进层级错误时',
  failurePattern: '修复文件层级失败',
  rootCause: { summary: '列表层级处理遗漏', basis: 'hypothesis', evidenceIds: [evidenceId] },
  repairSteps: ['检查列表层级', '再解析整份文件'],
  verification: { check: '解析整份文件', expected: '解析成功' },
  instruction: '先检查列表层级和缩进宽度，再解析整份文件',
  problemId, evidenceRevision: 0, evidenceIds: [evidenceId],
})

function seedEngine({ matchTarget = true, matchBaselineMethod = false } = {}) {
  const root = stateRoot()
  const engine = new RebuildEngine({ stateRoot: root, now: () => 1_800_000_000_000 })
  const prior = engine.observeToolFailure({ sessionId: 'seed-session', turnId: 'seed-turn',
    projectKey: null, callId: 'seed-failure', toolName: 'bash', failureCode: 'tool_nonzero_exit',
    exitCode: 1, stderr: 'Error: list indentation failed', command: 'run config-check' })
  const priorProblem = engine.store.read().problemLoop.problems.find(row => row.id === prior.id)
  const cases = loadDefaultCases()
  const source = cases.find(row => row.id === 'rsi-02-indent-error-exact')
  const ids = new Map(source.entries.map(row => [row.id, memId(row.id)]))
  const evidenceId = hex('recall-strategy-evidence')
  const entries = source.entries.map(row => ({ ...structuredClone(row), id: ids.get(row.id),
    originScope: 'a'.repeat(64), originEnvironment: 'b'.repeat(64), originSession: null,
    exclusions: '', visibility: 'global', version: 1, parentVersion: null, superseded: null,
    injected: 0, recurrences: 0, createdAt: 100, updatedAt: 100, lastInjectedAt: null,
    evidenceHash: null, methodStats: null, factDigest: null, digestDay: null, importedFrom: null,
    sourceDigest: null }))
  const targetId = ids.get('mem_rsi_indent_levels')
  const target = entries.find(row => row.id === targetId)
  Object.assign(target, { type: 'lesson', status: 'pending',
    problemSignature: matchTarget ? priorProblem.signature : hex('different-signature'),
    lesson: lesson(matchTarget ? prior.id : hex('different-problem'), evidenceId) })
  if (matchBaselineMethod) {
    const shared = entries.find(row => row.id === ids.get('mem_rsi_indent_fix'))
    Object.assign(shared, { type: 'lesson', status: 'pending',
      problemSignature: priorProblem.signature, lesson: lesson(prior.id, evidenceId) })
  }
  engine.store.transaction(doc => { doc.entries.push(...entries); return true })
  return { engine, root, entries, targetId, sharedId: ids.get('mem_rsi_indent_fix'),
    failure: { toolName: 'bash', failureCode: 'tool_nonzero_exit', exitCode: 1,
      stderr: 'Error: list indentation failed', command: 'run config-check' } }
}

function prepare(engine, sessionId, turnId, { strategyEligible = true } = {}) {
  return engine.prepare({ sessionId, turnId, projectKey: null, ...options, strategyEligible })
}

function fail(engine, sessionId, turnId, callId, details) {
  return engine.observeToolFailure({ sessionId, turnId, projectKey: null, callId, ...details })
}

function settle(engine, sessionId, turnId, outcome = 'failed') {
  return engine.complete({ sessionId, turnId, outcome, evidence: 'settled native turn' })
}

test('shared runtime candidate is the offline normalization and baseline remains the default', async () => {
  const recall = await import('./recall.mjs')
  assert.equal(typeof recall.selectRecallErrorLog, 'function')
  const source = loadDefaultCases().find(row => row.id === 'rsi-02-indent-error-exact')
  const current = structuredClone(source.entries)
  const target = current.find(row => row.id === 'mem_rsi_indent_levels')
  Object.assign(target, { type: 'lesson', status: 'pending', problemSignature: hex('sig'),
    lesson: lesson(hex('problem'), hex('evidence')) })
  const baseline = selectRecall(current, { ...options, prompt: source.prompt, scope: source.scope,
    environment: source.environment })
  const candidate = recall.selectRecallErrorLog(current, { ...options, prompt: source.prompt,
    scope: source.scope, environment: source.environment })
  assert.ok(!baseline.offered.some(row => row.id === target.id))
  assert.ok(candidate.offered.some(row => row.id === target.id && row.mode === 'method'))
  assert.ok(candidate.offered.filter(row => row.mode === 'method').length <= 2)
  assert.ok(candidate.offered.filter(row => row.mode === 'guard').length <= 1)
  assert.ok(candidate.offered.length <= 3 && candidate.bytes <= 768)
})

test('an admitted candidate-only method is shadowed; an exact same-turn native failure enables the next turn', () => {
  const { engine, root, targetId, failure } = seedEngine()
  try {
    const baseline = prepare(engine, 'untrusted', '1', { strategyEligible: false })
    assert.ok(!baseline.offered.some(row => row.id === targetId))
    assert.equal(engine.store.read().recallStrategy.generation, 0)
    const probed = prepare(engine, 'admitted', '1')
    assert.ok(!probed.offered.some(row => row.id === targetId),
      'shadow comparison never changes the real receipt or model context')
    assert.equal(engine.store.read().entries.find(row => row.id === targetId).injected, 0,
      'shadow comparison never increments the candidate method injection counter')
    const strategy = engine.store.read().recallStrategy
    assert.equal(strategy.generation, 0, 'shadow evidence is not yet approved')
    assert.deepEqual(Object.keys(strategy.rows[0]).sort(),
      ['generation', 'id', 'mode', 'qualification', 'reason', 'scope', 'session', 'turnKey', 'version'].sort())
    assert.equal(strategy.rows[0].mode, 'shadow')
    assert.equal(strategy.rows[0].generation, 0)
    assert.equal(strategy.rows[0].qualification.length, 64)
    assert.ok(!JSON.stringify(strategy).match(/prompt|path|command/iu))
    assert.equal(prepare(engine, 'admitted', '1').reason, 'same_turn_dedup')
    assert.equal(engine.store.read().recallStrategy.rows.length, 1)
    fail(engine, 'admitted', '1', 'candidate-probe-failure', failure)
    settle(engine, 'admitted', '1')
    const approved = engine.store.read().recallStrategy
    assert.equal(approved.generation, 1)
    assert.ok(approved.rows.some(row => row.id === targetId && row.mode === 'approved'
      && row.reason === 'same_turn_native_failure_match'))
    const nextTurn = prepare(engine, 'admitted', '2')
    assert.ok(nextTurn.offered.some(row => row.id === targetId && row.mode === 'method'),
      'candidate injection begins only after the next prepare')
    assert.ok(engine.store.read().receipts.find(row => row.turnKey === nextTurn.turnKey)
      .offered.some(row => row.id === targetId), 'only the approved next turn includes the method receipt')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a failure already explained by an offered baseline method cannot promote another candidate', () => {
  const { engine, root, targetId, sharedId, failure } = seedEngine({ matchTarget: true,
    matchBaselineMethod: true })
  try {
    const probed = prepare(engine, 'shared-error', '1')
    assert.ok(!probed.offered.some(row => row.id === targetId))
    assert.ok(probed.offered.some(row => row.id === sharedId && row.mode === 'method'))
    fail(engine, 'shared-error', '1', 'baseline-shared-failure', failure)
    settle(engine, 'shared-error', '1')
    assert.equal(engine.store.read().recallStrategy.generation, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a concurrent candidate version change before settlement cannot approve the old version', () => {
  const { engine, root, targetId, failure } = seedEngine()
  try {
    prepare(engine, 'revision-race', '1')
    fail(engine, 'revision-race', '1', 'revision-race-failure', failure)
    engine.store.transaction(doc => {
      const entry = doc.entries.find(row => row.id === targetId)
      assert.equal(archiveVersion(doc, entry, { now: 1_800_000_000_001,
        reason: 'native_revision' }).ok, true)
      entry.version = 2
      entry.parentVersion = 1
      entry.methodStats = null
      return true
    })
    settle(engine, 'revision-race', '1')
    const state = engine.store.read().recallStrategy
    assert.equal(state.generation, 0)
    assert.ok(!state.rows.some(row => row.id === targetId && row.mode === 'approved'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('withdrawn source or material admission before settlement cannot approve a shadow method', () => {
  for (const revoked of ['source', 'material']) {
    const { engine, root, failure } = seedEngine()
    try {
      engine.setSourceGuard(() => true)
      engine.setMaterialGuard(() => true)
      prepare(engine, `revoked-${revoked}`, '1')
      fail(engine, `revoked-${revoked}`, '1', `revoked-${revoked}-failure`, failure)
      if (revoked === 'source') engine.setSourceGuard(() => false)
      else engine.setMaterialGuard(() => false)
      settle(engine, `revoked-${revoked}`, '1')
      assert.equal(engine.store.read().recallStrategy.generation, 0, revoked)
      assert.ok(!engine.store.read().recallStrategy.rows.some(row => row.mode === 'approved'), revoked)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('paused or settings-disabled recall keeps baseline behavior and cannot collect or settle strategy evidence', () => {
  for (const blockedAt of ['before_prepare', 'before_settlement']) {
    const { engine, root, targetId, failure } = seedEngine()
    try {
      if (blockedAt === 'before_prepare') engine.pause(true)
      const out = prepare(engine, `paused-${blockedAt}`, '1')
      assert.ok(!out.offered.some(row => row.id === targetId))
      if (blockedAt === 'before_prepare') {
        assert.equal(engine.store.read().recallStrategy.rows.length, 0)
      }
      fail(engine, `paused-${blockedAt}`, '1', `paused-${blockedAt}-failure`, failure)
      if (blockedAt === 'before_settlement') engine.setSettingsEnabled(false)
      settle(engine, `paused-${blockedAt}`, '1')
      assert.equal(engine.store.read().recallStrategy.generation, 0, blockedAt)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('status exposes only a bounded read-only strategy decision projection', () => {
  const { engine, root, targetId, failure } = seedEngine()
  try {
    prepare(engine, 'status-projection', '1')
    fail(engine, 'status-projection', '1', 'status-projection-failure', failure)
    const before = JSON.stringify(engine.store.read())
    const view = engine.statusView()
    assert.deepEqual(view.recallStrategy.counts,
      { shadow: 0, matched: 1, active: 0, approved: 0, isolated: 0 })
    assert.deepEqual(view.recallStrategy.recent, [{ id: targetId, version: 1,
      mode: 'matched', generation: 0, reason: 'same_turn_native_failure_match' }])
    assert.ok(!/turnKey|scope|session|qualification|problemId|command|prompt/u.test(
      JSON.stringify(view.recallStrategy)))
    assert.equal(JSON.stringify(engine.store.read()), before, 'status reads do not mutate strategy state')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('cancelled and late matching failures never promote the candidate', () => {
  for (const kind of ['cancelled', 'late']) {
    const { engine, root, failure } = seedEngine()
    try {
      prepare(engine, kind, '1')
      if (kind === 'cancelled') {
        fail(engine, kind, '1', 'cancelled-probe-failure', failure)
        settle(engine, kind, '1', 'cancelled')
      } else {
        settle(engine, kind, '1', 'unknown')
        fail(engine, kind, '1', 'late-probe-failure', failure)
        settle(engine, kind, '1', 'failed')
      }
      assert.equal(engine.store.read().recallStrategy.generation, 0, kind)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('a settled native checker failure on the active candidate exact version rolls back and isolates it', () => {
  const { engine, root, targetId, failure } = seedEngine()
  try {
    prepare(engine, 'promote', '1')
    fail(engine, 'promote', '1', 'promote-failure', failure)
    settle(engine, 'promote', '1')
    assert.equal(engine.store.read().recallStrategy.rows.some(row => row.id === targetId
      && row.mode === 'approved'), true)
    engine.store.transaction(doc => {
      const target = doc.entries.find(row => row.id === targetId)
      target.status = 'pending'
      target.recurrences = 0
      target.methodStats = { version: target.version, since: 1, coverage: 'complete', injected: 0,
        recurrences: 0, checkPasses: 0, checkFails: 0 }
      return true
    })
    const active = prepare(engine, 'active-check', '1')
    assert.ok(active.offered.some(row => row.id === targetId && row.mode === 'method'))
    const checked = engine.recordCheck({ checkId: 'json-file-parses-v1', passed: false,
      sessionId: 'active-check', turnId: '1', entryId: targetId, entryVersion: 1,
      eventId: 'native-check-failure' })
    assert.equal(checked.outcome, 'needs_revision')
    settle(engine, 'active-check', '1')
    const state = engine.store.read().recallStrategy
    assert.equal(state.generation, 2)
    assert.ok(state.rows.some(row => row.id === targetId && row.version === 1
      && row.mode === 'isolated'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a settled same-signature recurrence on an active candidate exact version rolls it back', () => {
  const { engine, root, targetId, failure } = seedEngine()
  try {
    prepare(engine, 'promote', '1')
    fail(engine, 'promote', '1', 'promote-failure', failure)
    settle(engine, 'promote', '1')
    engine.store.transaction(doc => {
      const target = doc.entries.find(row => row.id === targetId)
      target.status = 'pending'
      target.recurrences = 0
      target.methodStats = { version: target.version, since: 1, coverage: 'complete', injected: 0,
        recurrences: 0, checkPasses: 0, checkFails: 0 }
      return true
    })
    const active = prepare(engine, 'active-recurrence', '1')
    assert.ok(active.offered.some(row => row.id === targetId && row.mode === 'method'))
    fail(engine, 'active-recurrence', '1', 'active-same-signature-failure', failure)
    settle(engine, 'active-recurrence', '1')
    const state = engine.store.read().recallStrategy
    assert.equal(state.generation, 2)
    assert.ok(state.rows.some(row => row.id === targetId && row.version === 1
      && row.mode === 'isolated'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('wrong checker version and cancelled active failure do not roll back an active candidate', () => {
  for (const kind of ['wrong-version', 'cancelled']) {
    const { engine, root, targetId, failure } = seedEngine()
    try {
      prepare(engine, 'promote', '1')
      fail(engine, 'promote', '1', 'promote-failure', failure)
      settle(engine, 'promote', '1')
      engine.store.transaction(doc => {
        const target = doc.entries.find(row => row.id === targetId)
        target.status = 'pending'
        target.recurrences = 0
        target.methodStats = { version: target.version, since: 1, coverage: 'complete', injected: 0,
          recurrences: 0, checkPasses: 0, checkFails: 0 }
        return true
      })
      prepare(engine, kind, '2')
      if (kind === 'wrong-version') {
        const result = engine.recordCheck({ checkId: 'json-file-parses-v1', passed: false,
          sessionId: kind, turnId: '2', entryId: targetId, entryVersion: 2, eventId: 'wrong-version' })
        assert.equal(result.code, 'version_not_injected_this_turn')
        settle(engine, kind, '2')
      } else {
        fail(engine, kind, '2', 'active-cancelled-failure', failure)
        settle(engine, kind, '2', 'cancelled')
      }
      assert.equal(engine.store.read().recallStrategy.rows.some(row => row.id === targetId
        && row.mode === 'approved'), true, kind)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('candidate activation survives restart and old format-3 documents default to baseline', () => {
  const { engine, root, targetId, failure } = seedEngine()
  try {
    prepare(engine, 'persisted', '1')
    fail(engine, 'persisted', '1', 'persisted-failure', failure)
    settle(engine, 'persisted', '1')
    const restarted = new RebuildEngine({ stateRoot: root, now: () => 1_800_000_000_000 })
    assert.ok(restarted.store.read().recallStrategy.rows.some(row => row.id === targetId
      && row.mode === 'approved'))
    const active = prepare(restarted, 'persisted-next', '2')
    assert.ok(active.offered.some(row => row.id === targetId && row.mode === 'method'))

    const oldRoot = stateRoot()
    try {
      const old = new RebuildEngine({ stateRoot: oldRoot })
      const doc = old.store.read()
      doc.format = 3
      delete doc.recallStrategy
      writeFileSync(old.store.path, JSON.stringify(doc))
      old.recordTurnFacts({ sessionId: 'old-format', turnId: '1', taskSummary: 'legacy' })
      assert.equal(old.store.read().format, 4)
      assert.equal(old.store.read().recallStrategy.generation, 0)
    } finally { rmSync(oldRoot, { recursive: true, force: true }) }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a recall-state transaction failure fails closed without escaping into the caller', () => {
  const { engine, root } = seedEngine()
  try {
    engine.store.transaction = () => { throw Object.assign(new Error('capacity'), { code: 'capacity' }) }
    assert.doesNotThrow(() => prepare(engine, 'capacity', '1'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('an optional strategy capacity failure retries once with the normal baseline receipt', () => {
  const { engine, root, targetId } = seedEngine()
  try {
    const transaction = engine.store.transaction.bind(engine.store)
    let calls = 0
    engine.store.transaction = mutate => {
      calls += 1
      if (calls === 1) {
        mutate(engine.store.read()) // MemoryStore mutates a private copy, then refuses it pre-write.
        throw Object.assign(new Error('capacity'), { code: 'capacity' })
      }
      return transaction(mutate)
    }
    const out = prepare(engine, 'capacity-fallback', '1')
    assert.equal(calls, 2)
    assert.equal(out.ok, true)
    assert.ok(out.offered.length > 0, 'the ordinary baseline selection is still committed')
    assert.ok(!out.offered.some(row => row.id === targetId))
    assert.equal(engine.store.read().recallStrategy.rows.length, 0)
    assert.ok(engine.store.read().receipts.some(row => row.turnKey === out.turnKey))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('strategy append reclaims only durable rows whose method version or qualification is stale', () => {
  const { engine, root, targetId } = seedEngine()
  try {
    const stale = Array.from({ length: 128 }, (_, index) => ({
      turnKey: hex(`obsolete-turn-${index}`), scope: hex(`obsolete-scope-${index}`),
      session: hex(`obsolete-session-${index}`), qualification: RECALL_QUALIFICATION.id,
      id: memId(`removed-method-${index}`), version: 1, mode: 'isolated', generation: index + 1,
      reason: 'same_signature_recurrence',
    }))
    engine.store.transaction(doc => { doc.recallStrategy.rows = stale; return true })
    prepare(engine, 'revised-method', '1')
    const rows = engine.store.read().recallStrategy.rows
    assert.equal(rows.length, 1)
    assert.ok(rows.some(row => row.id === targetId && row.mode === 'shadow'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('suite cleanup removes its shared probe directory', () => {
  rmSync(PROBES, { recursive: true, force: true })
})
