import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningEngine } from '../src/index.mjs'
import { createTaskEvidenceAuthority } from '../src/task-evidence.mjs'
import { packCases, packSuiteId } from '../src/domains.mjs'

const PACK = 'package-json-structure-v1'
const projectKey = '/synthetic/package-replay-objective'
const sessionId = 'package-replay-session'
const provider = 'deepseek-official', model = 'deepseek-flash'
const sha = value => createHash('sha256').update(value).digest('hex')

test('package objective freezes scoped replay pairs and refuses promotion until both outputs pass', t => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-package-replay-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  let now = 1_900_000_000_000
  const engine = new LearningEngine({ stateRoot, adapterId: 'hermes', now: () => now,
    evaluationTokensPerDay: 50_000, evaluationCallsPerDay: 5 })
  const lessonResult = engine.record({ projectKey, source: 'host_proposal', kind: 'method',
    eventId: 'package-replay-method', instruction: 'Validate package.json manifest structure and JSON known field types.' })
  const lesson = engine.list({ projectKey, limit: 10 }).lessons.find(row => row.id === lessonResult.id)
  const authority = createTaskEvidenceAuthority(engine)
  const artifact = (eventId, content) => engine.recordPackageJsonArtifact(authority, {
    adapterId: 'hermes', environmentId: null, eventId, filename: 'package.json',
    content, fileHash: sha(content), lessonId: null, lessonVersion: null, projectKey, provider, model, reasoningEffort: 'max',
    sessionId, toolchain: 'hermes-file-tools-v1', turnId: eventId,
  })
  assert.equal(artifact('package-bad', '{"scripts":{"test":17}}').status, 'fail')
  assert.equal(artifact('package-control', '{"scripts":{"test":"node --test"},"custom":true}').status, 'pass')
  const replay = engine.taskEvidenceReplayCases({ projectKey, limit: 2 })
  assert.equal(replay.ok, true, JSON.stringify(replay))
  assert.equal(replay.cases.length, 1)
  const published = engine.sourcePublish({ sessionId, projectKey, provider, model,
    apiMode: 'chat_completions', baseUrl: 'https://synthetic.invalid/v1',
    reasoningState: 'explicit', reasoningValue: 'max', driver: 'async_openai_chat' })
  assert.equal(published.published, true)
  const plan = engine.autoPlanRegister({ lessonId: lesson.id, version: lesson.version,
    environment: 'default', track: 'objective', source: { kind: 'turn', sessionId, turnId: '1', projectKey,
      route: { provider, model, reasoningEffort: 'max' } },
    suite: { packId: PACK, version: 2 }, criteria: packCases(PACK)[0].criteria,
    sourceBinding: { revision: published.revision, bindingHash: published.bindingHash } })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  const frozenRefs = replay.cases.map(({ id, badFixtureHash, controlFixtureHash }) =>
    ({ id, badFixtureHash, controlFixtureHash }))
  const request = engine.evaluationRequest({ lessonId: lesson.id, expectedVersion: lesson.version,
    projectKey, maxTokens: 2, stepwiseBudget: true, planHash: plan.plan.planHash,
    queueKey: plan.plan.queueKey, packId: PACK, sourceBinding: true, sessionId,
    sourceRevision: published.revision, sourceBindingHash: published.bindingHash,
    controlGeneration: engine.controlGeneration(), taskReplayCases: frozenRefs })
  assert.equal(typeof request.ticket, 'string', JSON.stringify(request))
  assert.deepEqual(engine.store.read().jobs.find(row => row.ticket === request.ticket).taskReplayCases
    .map(({ id, badFixtureHash, controlFixtureHash }) => ({ id, badFixtureHash, controlFixtureHash })), frozenRefs)
  const invalidFields = ['name', 'version', 'description', 'homepage', 'private', 'files', 'scripts']
  for (let index = 1; index <= 64; index += 1) {
    const invalid = Object.fromEntries(invalidFields.filter((_, bit) => (index & (1 << bit)) !== 0)
      .map(field => [field, field === 'scripts' ? { test: 17 } : 17]))
    assert.equal(artifact(`rotate-bad-${index}`, JSON.stringify(invalid)).status, 'fail')
    assert.equal(artifact(`rotate-control-${index}`, '{"scripts":{"test":"node --test"},"custom":true}').status, 'pass')
  }
  assert.equal(engine.taskEvidenceStatus().replayCases, 64)
  assert.deepEqual(engine.taskEvidenceReplayCases({ ticket: request.ticket, projectKey }).cases, replay.cases)
  const cases = packCases(PACK)
  const answers = Object.fromEntries(cases.map(row => [row.caseId,
    { baseline: '{}', candidate: JSON.stringify(row.checker.expected) }]))
  const usage = Object.fromEntries(cases.map(row => [row.caseId, { baseline: 1, candidate: 1 }]))
  const common = { ticket: request.ticket, lessonId: lesson.id, expectedVersion: lesson.version,
    projectKey, answers, usage, sourceBinding: true }
  const missingGate = engine.evaluate(common)
  assert.equal(missingGate.ok, false)
  assert.equal(missingGate.code, 'task_replay_gate_required')
  const nextSource = engine.sourcePublish({ sessionId, projectKey, provider, model,
    apiMode: 'chat_completions', baseUrl: 'https://synthetic.invalid/v2',
    reasoningState: 'explicit', reasoningValue: 'max', driver: 'async_openai_chat' })
  assert.equal(artifact('package-bad-fresh', '{"scripts":{"test":17}}').status, 'fail')
  assert.equal(artifact('package-control-fresh', '{"scripts":{"test":"node --test"},"custom":true}').status, 'pass')
  const freshReplay = engine.taskEvidenceReplayCases({ projectKey, limit: 2 })
  const freshRefs = freshReplay.cases.map(({ id, badFixtureHash, controlFixtureHash }) =>
    ({ id, badFixtureHash, controlFixtureHash }))
  const repairWitness = source => JSON.stringify(Object.fromEntries(Object.keys(JSON.parse(source)).map(field =>
    [field, field === 'scripts' ? { test: 'node --test' } : field === 'private' ? true
      : field === 'files' ? [] : 'fixed'])) )
  const gateResults = freshReplay.cases.map(row => ({ id: row.id, badOutput: repairWitness(row.badInput),
    controlOutput: row.controlInput }))
  const nextPlan = engine.autoPlanRegister({ lessonId: lesson.id, version: lesson.version,
    environment: 'default', track: 'objective', source: { kind: 'turn', sessionId, turnId: '2', projectKey,
      route: { provider, model, reasoningEffort: 'max' } },
    suite: { packId: PACK, version: 2 }, criteria: packCases(PACK)[0].criteria,
    sourceBinding: { revision: nextSource.revision, bindingHash: nextSource.bindingHash } })
  const retry = engine.evaluationRequest({ lessonId: lesson.id, expectedVersion: lesson.version,
    projectKey, maxTokens: 2, stepwiseBudget: true, planHash: nextPlan.plan.planHash,
    queueKey: nextPlan.plan.queueKey, packId: PACK, sourceBinding: true, sessionId,
    sourceRevision: nextSource.revision, sourceBindingHash: nextSource.bindingHash,
    controlGeneration: engine.controlGeneration(), taskReplayCases: freshRefs })
  for (let index = 0; index < cases.length * 2 + freshReplay.cases.length * 2; index += 1) {
    const stepKey = `synthetic-objective-step-${index}`
    assert.equal(engine.ticketReserve({ ticket: retry.ticket, stepKey, requestHash: sha(stepKey),
      inputTokens: 1, outputTokens: 1 }).ok, true)
  }
  const accepted = engine.evaluate({ ...common, ticket: retry.ticket, taskReplayResults: gateResults })
  assert.equal(accepted.ok, true, JSON.stringify(accepted))
  assert.equal(accepted.decision, 'accepted', JSON.stringify(accepted))

  // Continue the real lifecycle after promotion: only an actual user turn acceptance binds the
  // method, and a later host-read bad manifest must retire that exact validated edition.
  const promoted = engine.inspect({ projectKey, id: lesson.id }).lessons[0]
  assert.equal(promoted.status, 'validated')
  const cancelledSession = `${sessionId}-cancelled`
  const cancelledContent = '{"scripts":{"test":17},"cancelled":"raw-only"}'
  engine.recordPackageJsonArtifact(authority, { adapterId: 'hermes', content: cancelledContent,
    environmentId: null, eventId: 'package-before-cancel', filename: 'package.json',
    fileHash: sha(cancelledContent), lessonId: null, lessonVersion: null, projectKey, provider, model,
    reasoningEffort: 'max', sessionId: cancelledSession, toolchain: 'hermes-file-tools-v1', turnId: '3' })
  const cancelledOffer = engine.prepare({ sessionId: cancelledSession, turnId: '3', origin: 'user', projectKey,
    prompt: promoted.instruction })
  if (cancelledOffer.receipt) engine.cancel({ receipt: cancelledOffer.receipt })
  assert.equal(engine.store.read().taskEvidence.adoptionAttributions.length, 0,
    'a durable raw Host failure plus prepare/cancel alone cannot create adoption attribution')
  const offer = engine.prepare({ sessionId, turnId: '3', origin: 'user', projectKey,
    prompt: promoted.instruction })
  assert.ok(offer.lessonVersions?.some(row => row.id === promoted.id), JSON.stringify(offer))
  assert.equal(engine.accept({ receipt: offer.receipt, lessonIds: [promoted.id] }).ok, true)
  const failedContent = '{"scripts":{"test":17}}'
  const regression = engine.recordPackageJsonArtifact(authority, { adapterId: 'hermes', content: failedContent,
    environmentId: null, eventId: 'package-after-promotion-fail', filename: 'package.json',
    fileHash: sha(failedContent), lessonId: promoted.id, lessonVersion: promoted.version,
    projectKey, provider, model, reasoningEffort: 'max', sessionId,
    toolchain: 'hermes-file-tools-v1', turnId: '3' })
  assert.equal(regression.status, 'fail')
  const boundLedger = engine.store.read().taskEvidence
  assert.equal(boundLedger.adoptionAttributions.length, 1)
  const sourceBinding = boundLedger.records.find(row => row.digest === regression.evidence.digest).sourceBinding
  assert.deepEqual(boundLedger.adoptionAttributions[0], { ...sourceBinding, evidenceDigest: regression.evidence.digest,
    lessonId: promoted.id, version: promoted.version, at: boundLedger.adoptionAttributions[0].at })
  const retired = engine.inspect({ projectKey, id: promoted.id }).lessons[0]
  assert.equal(retired.status, 'suspended')
  assert.equal(retired.suspensionReason, 'regression')
  assert.equal(retired.version, promoted.version + 1, 'the counterevidence retires only the adopted generation')
  const cold = new LearningEngine({ stateRoot, adapterId: 'hermes', now: () => 1_900_000_000_000,
    evaluationTokensPerDay: 50_000, evaluationCallsPerDay: 5 })
  assert.deepEqual(cold.store.read().taskEvidence.adoptionAttributions, boundLedger.adoptionAttributions,
    'source and adoption attribution are durable across a cold reopen')
  assert.equal(cold.prepare({ sessionId, turnId: '5', origin: 'user', projectKey,
    prompt: promoted.instruction }).lessonVersions?.some(row => row.id === promoted.id), false)
  now += 7 * 86_400_000
  const lateContent = '{"scripts":{"test":17},"late":"expired-adoption"}'
  engine.recordPackageJsonArtifact(authority, { adapterId: 'hermes', content: lateContent,
    environmentId: null, eventId: 'package-late-after-adoption-expiry', filename: 'package.json',
    fileHash: sha(lateContent), lessonId: null, lessonVersion: null, projectKey, provider, model,
    reasoningEffort: 'max', sessionId, toolchain: 'hermes-file-tools-v1', turnId: '3' })
  assert.equal(engine.store.read().taskEvidence.adoptionAttributions.length, 1,
    'an expired adoption cannot claim attribution for late evidence')
})

test('tampered frozen replay material fails before dispatch and the ticket can be cancelled', t => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-package-replay-tamper-'))
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }))
  const engine = new LearningEngine({ stateRoot, adapterId: 'hermes', now: () => 1_900_000_000_000,
    evaluationTokensPerDay: 50_000, evaluationCallsPerDay: 5 })
  const project = '/synthetic/package-replay-tamper'
  const session = 'package-replay-tamper-session'
  const lessonResult = engine.record({ projectKey: project, source: 'host_proposal', kind: 'method',
    eventId: 'package-replay-tamper-method', instruction: 'Validate package.json manifest structure and JSON known field types.' })
  const lesson = engine.list({ projectKey: project, limit: 10 }).lessons.find(row => row.id === lessonResult.id)
  const authority = createTaskEvidenceAuthority(engine)
  const write = (eventId, content) => engine.recordPackageJsonArtifact(authority, {
    adapterId: 'hermes', environmentId: null, eventId, filename: 'package.json', content,
    fileHash: sha(content), lessonId: null, lessonVersion: null, projectKey: project,
    provider, model, reasoningEffort: 'max', sessionId: session,
    toolchain: 'hermes-file-tools-v1', turnId: eventId,
  })
  write('tamper-bad', '{"scripts":{"test":17}}')
  write('tamper-control', '{"scripts":{"test":"node --test"}}')
  const bound = engine.sourcePublish({ sessionId: session, projectKey: project, provider, model,
    apiMode: 'chat_completions', baseUrl: 'https://synthetic.invalid/v1',
    reasoningState: 'explicit', reasoningValue: 'max', driver: 'async_openai_chat' })
  const plan = engine.autoPlanRegister({ lessonId: lesson.id, version: lesson.version,
    environment: 'default', track: 'objective', source: { kind: 'turn', sessionId: session,
      turnId: '1', projectKey: project, route: { provider, model, reasoningEffort: 'max' } },
    suite: { packId: PACK, version: 2 }, criteria: packCases(PACK)[0].criteria,
    sourceBinding: { revision: bound.revision, bindingHash: bound.bindingHash } })
  const material = engine.taskEvidenceReplayCases({ projectKey: project, limit: 2 })
  const request = engine.evaluationRequest({ lessonId: lesson.id, expectedVersion: lesson.version,
    projectKey: project, maxTokens: 2, stepwiseBudget: true, planHash: plan.plan.planHash,
    queueKey: plan.plan.queueKey, packId: PACK, sourceBinding: true, sessionId: session,
    sourceRevision: bound.revision, sourceBindingHash: bound.bindingHash,
    controlGeneration: engine.controlGeneration(), taskReplayCases: material.cases.map(({ id, badFixtureHash,
      controlFixtureHash }) => ({ id, badFixtureHash, controlFixtureHash })) })
  assert.equal(typeof request.ticket, 'string', JSON.stringify({ plan, material, request }))
  engine.store.update(state => {
    state.jobs.find(row => row.ticket === request.ticket).taskReplayCases[0].badFixtureHash = '0'.repeat(64)
  })
  const rejected = engine.taskEvidenceReplayCases({ ticket: request.ticket, projectKey: project })
  assert.deepEqual(rejected, { ok: false, code: 'task_replay_evidence_changed' })
  const cancelled = engine.evaluationCancel({ ticket: request.ticket })
  assert.equal(cancelled.ok, true)
  assert.equal(engine.store.read().jobs.some(row => row.ticket === request.ticket), false)
  assert.equal(engine.store.read().spends.find(row => row.ticket === request.ticket).terminal, 'ticket_cancelled')
})
