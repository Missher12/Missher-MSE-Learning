import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { LearningEngine } from '../src/index.mjs'
import { getDomainPack, packCases, packCaseCriteriaHash, packScenarioHash, packSuiteId } from '../src/domains.mjs'
import { callEvaluationModel } from '../adapters/dsh/index.mjs'
import { createAutoValidation } from '../adapters/dsh/auto.mjs'

const PROJECT = '/synthetic/dsh-checkpoint'
const SESSION = 'dsh-checkpoint-session'
const PROVIDER = 'deepseek-official'
const MODEL = 'deepseek-flash'
const EFFORT = 'max'
const DAY = 86_400_000

test('the production DSH call and scheduler resume an unbound plan after a rolling day', async t => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-dsh-checkpoint-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  let now = Date.UTC(2030, 0, 1)
  const makeEngine = (tokens = 100_000, calls = 2) => new LearningEngine({ stateRoot, adapterId: 'dsh',
    maxContextBytes: 768, now: () => now, evaluationTokensPerDay: tokens, evaluationCallsPerDay: calls })
  let engine = makeEngine()
  const lessonResult = engine.record({ projectKey: PROJECT, source: 'host_proposal', kind: 'method',
    eventId: 'dsh-checkpoint-candidate', instruction: '处理请求前先核对代次，再丢弃迟到结果' })
  const lesson = engine.list({ projectKey: PROJECT, limit: 10 }).lessons.find(row => row.id === lessonResult.id)
  const source = engine.sourcePublish({ sessionId: SESSION, projectKey: PROJECT, environmentId: 'default',
    provider: PROVIDER, model: MODEL, apiMode: 'chat_completions', baseUrl: 'https://dsh-checkpoint.invalid/v1',
    reasoningState: 'explicit', reasoningValue: EFFORT, driver: 'async_openai_chat' })
  assert.equal(source.published, true, JSON.stringify(source))
  const route = { provider: PROVIDER, model: MODEL, reasoningEffort: EFFORT }
  const proposal = engine.autoPlanProposal({ lessonId: lesson.id, version: lesson.version, environment: 'default',
    track: 'review', source: { kind: 'manual_backfill', sessionId: SESSION, route }, projectKey: PROJECT })
  assert.equal(proposal.ok, true, JSON.stringify(proposal))
  const registered = engine.autoPlanRegister({ lessonId: lesson.id, version: lesson.version, environment: 'default',
    track: 'review', source: { kind: 'manual_backfill', sessionId: SESSION, route, projectKey: PROJECT }, projectKey: PROJECT,
    suite: proposal.suite, criteria: proposal.criteria, caseId: proposal.caseId })
  assert.equal(registered.ok, true, JSON.stringify(registered))
  const row = registered.plan
  const requestTicket = engine.reviewRequest({ lessonId: lesson.id, expectedVersion: lesson.version, projectKey: PROJECT,
    maxTokens: 2, stepwiseBudget: true, steps: 1, inputChars: 1, stepOutputTokens: 1,
    planHash: row.planHash, queueKey: row.queueKey, packId: 'mse-lifecycle-v1', caseId: row.caseId,
    scenarioHash: row.scenarioHash, criteriaHash: row.criteriaHash, criteria: proposal.criteria,
  })
  assert.equal(typeof requestTicket.ticket, 'string', JSON.stringify(requestTicket))

  const physical = []
  const ctx = { llm: { stream: options => {
    physical.push(options)
    return (async function * () {
      yield { type: 'text-delta', text: 'checkpoint answer' }
      yield { type: 'usage', usage: { totalTokens: 19, inputTokens: 12, outputTokens: 7,
        cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  } } }
  const lifetime = new AbortController()
  const api = () => callEvaluationModel({ engine, ctx, lifetime }, {
    route, system: 'fixed system', prompt: 'fixed user prompt', maxTokens: 128,
    stepKey: 'review:candidate' }, requestTicket.ticket)

  const first = await api()
  assert.equal(first.text, 'checkpoint answer')
  assert.equal(physical.length, 1)
  const a = createUserMessage({ content: [{ type: 'text', text: 'same user content' }] })
  const b = createUserMessage({ content: [{ type: 'text', text: 'same user content' }] })
  assert.notEqual(a.id, b.id, 'the host creates a fresh message id for equal content')
  const resumed = await api()
  assert.equal(resumed.resumed, true)
  assert.equal(physical.length, 1, 'equal effective request reuses the production checkpoint')
  for (const changed of [
    { prompt: 'changed prompt' },
    { system: 'changed system' },
    { maxTokens: 127 },
    { route: { ...route, reasoningEffort: 'high' } },
    { route: { ...route, model: 'other-model' } },
  ]) {
    await assert.rejects(callEvaluationModel({ engine, ctx, lifetime }, {
      route, system: 'fixed system', prompt: 'fixed user prompt', maxTokens: 128,
      stepKey: 'review:candidate', ...changed }, requestTicket.ticket), error => error.code === 'checkpoint_conflict')
  }

  const initialProgress = engine.store.read().autoPlans.find(plan => plan.queueKey === row.queueKey).progress.steps
  const savedHash = initialProgress.find(step => step.stepKey === 'review:candidate').requestHash
  assert.match(savedHash, /^[a-f0-9]{64}$/)
  const unboundJob = engine.store.read().jobs.find(job => job.ticket === requestTicket.ticket)
  assert.equal(unboundJob.expiresAt - now, 30 * 60_000, 'DSH auto plans use the real unbound 30-minute ticket')
  now += DAY + 1
  engine = makeEngine()
  engine.recoverAutoPlans()
  const recovered = engine.store.read().autoPlans.find(plan => plan.queueKey === row.queueKey)
  assert.equal(recovered.ticket, null, 'expired unbound ticket is discarded while durable progress remains')
  assert.equal(recovered.progress.steps.some(step => step.stepKey === 'review:candidate'), true)
  const pack = getDomainPack('mse-lifecycle-v1')
  const sample = packCases(pack.packId).find(item => item.caseId === row.caseId)
  const scenario = { suite: { packId: pack.packId, version: pack.version }, suiteId: packSuiteId(pack),
    criteria: sample.criteria, caseId: sample.caseId, scenarioHash: packScenarioHash(pack.packId, sample.caseId),
    criteriaHash: packCaseCriteriaHash(pack.packId, sample.caseId),
    arm: kind => ({ system: kind === 'candidate' ? 'fixed system' : 'baseline system', prompt: 'fixed user prompt' }),
    judge: (_candidate, _baseline, pass) => ({ system: 'judge system', prompt: `judge prompt ${pass}`,
      labels: { armA: pass === 0 ? 'A' : 'B' } }) }
  const scheduler = createAutoValidation({ engine, context: () => scenario, route: () => route,
    source: () => ({ kind: 'manual_backfill', sessionId: SESSION, route }),
    enabled: () => true, now: () => now, callModel: (request, ticket) =>
      callEvaluationModel({ engine, ctx, lifetime }, request, ticket) })
  t.after(() => scheduler.dispose())
  const resumedScan = await scheduler.scan([lesson])
  assert.equal(resumedScan.ok, true, JSON.stringify(resumedScan))
  assert.equal(physical.length, 4, 'the completed candidate checkpoint is reused; baseline and two judge steps dispatch')
  const finalPlan = engine.autoPlans().find(plan => plan.queueKey === row.queueKey)
  assert.equal(finalPlan.stage, 'done')
  assert.notEqual(finalPlan.ticket, requestTicket.ticket, 'the expired ticket is replaced by scheduler re-admission')
  assert.equal(engine.store.read().autoPlans.find(plan => plan.queueKey === row.queueKey).progress.steps
    .find(step => step.stepKey === 'review:candidate').requestHash, savedHash)
  assert.equal(engine.status().evaluationTasksLast24h, 1)
  assert.equal(engine.status().evaluationRequestsLast24h, 3)
  assert.equal(engine.status().evaluationTokensReserved24h > 0, true)
  assert.equal(engine.store.read().autoPlans.find(plan => plan.queueKey === row.queueKey).progress.steps
    .find(step => step.stepKey === 'review:candidate').requestHash, savedHash)
  assert.ok(packCases('mse-lifecycle-v1').some(item => item.caseId === row.caseId))
})
