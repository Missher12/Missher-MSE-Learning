import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonicalTaskContract, createVerifierRegistry, verifyProjectTestResult,
  verifyStructuredArtifact, replayPairIdentity, taskEvidenceDigest } from '../src/task-evidence.mjs'
import { checkGuard, createGuardFunction } from '../src/guards.mjs'
import { registerDshGuardTemplates } from '../adapters/dsh/index.mjs'
import { recordReplayPairInState, replayCaseLedgerValid, createTaskEvidenceAuthority,
  ensureTaskEvidenceLedger } from '../src/task-evidence.mjs'
import { taskEvidenceLedgerValid, taskFamilyHashOf } from '../src/task-evidence.mjs'
import { validateTaskEvidenceBinding } from '../src/task-evidence.mjs'
import { Config as dshConfig } from '../adapters/dsh/config.mjs'
import { LearningEngine } from '../src/index.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { replayTaskFixture, taskFixtureOf } from '../src/task-profiles.mjs'
import { PROJECT_TEST_MANIFESTS, runRegisteredProjectTests, verifyPackageJsonArtifact } from '../src/project-test-runner.mjs'
import { packageJsonReplayWitness, verifyPackageJsonReplayOutput } from '../src/package-json-checker.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const H = 'a'.repeat(64)

test('contract binds host identities and rejects malformed scope/model/method bindings', () => {
  const input = { contractId: 'build.v1', version: 1, scope: H, environment: 'b'.repeat(64), taskFamily: 'build',
    model: 'deepseek-official/deepseek-v4.1-flash/max', toolchain: 'node22', methodId: 'method.build', methodVersion: 2,
    validatorId: 'tests.node', validatorVersion: 1, sourceEventId: 'call:123', artifactHash: 'c'.repeat(64),
    adoptionSessionHash: 'd'.repeat(64), adoptionTurnHash: 'e'.repeat(64) }
  const frozen = canonicalTaskContract(input)
  assert.equal(frozen.hash.length, 64)
  assert.throws(() => canonicalTaskContract({ ...input, scope: '../all' }), /invalid_task_contract/)
  assert.throws(() => canonicalTaskContract({ ...input, model: 'model from output' }), /invalid_task_contract/)
  assert.throws(() => canonicalTaskContract({ ...input, model: 42 }), /invalid_task_contract/)
  assert.throws(() => canonicalTaskContract({ ...input, sourceEventId: `src-${'a'.repeat(64)}` }), /invalid_task_contract/)
  const evidence = { eventId: 'result:123', contractHash: frozen.hash, validatorHash: H, scope: input.scope,
    environment: input.environment, model: input.model, toolchain: input.toolchain, methodId: input.methodId,
    methodVersion: input.methodVersion, validatorId: input.validatorId, validatorVersion: input.validatorVersion,
    adoptionSessionHash: input.adoptionSessionHash, adoptionTurnHash: input.adoptionTurnHash,
    artifactHash: input.artifactHash, verdict: 'pass', failedChecks: [], at: 10 }
  assert.equal(validateTaskEvidenceBinding(frozen.contract, evidence, frozen.hash), true)
  assert.equal(validateTaskEvidenceBinding(frozen.contract, { ...evidence, methodVersion: 1 }, frozen.hash), false)
})

test('registered verifier identity is immutable and JSON cannot claim trusted registration', async () => {
  const registry = createVerifierRegistry()
  assert.throws(() => registry.register({}, 'tests.node', 1, () => ({ verdict: 'pass' })), /untrusted_verifier_registration/)
  registry.register(registry.authority, 'tests.node', 1, () => ({ verdict: 'pass' }))
  assert.throws(() => registry.register(registry.authority, 'tests.node', 1, () => ({ verdict: 'fail' })), /verifier_immutable/)
  const evidence = { contractHash: H, environment: 'b'.repeat(64), artifactHash: 'c'.repeat(64), input: {} }
  const binding = { validatorId: 'tests.node', validatorVersion: 1, contractHash: H,
    environment: 'b'.repeat(64), artifactHash: 'c'.repeat(64) }
  assert.equal((await registry.verify(binding, evidence)).verdict, 'pass')
  assert.equal((await registry.verify({ ...binding, contractHash: 'd'.repeat(64) }, evidence)).verdict, 'unknown')
})

test('project test verifier requires the frozen exact set and rejects zero, skipped, or forged results', () => {
  const manifest = { id: 'tests.v1', version: 1, testIds: ['unit.core', 'unit.adapter'] }
  const result = statuses => ({ manifestHash: hash(manifest), results: manifest.testIds.map((testId, index) =>
    ({ testId, status: statuses[index], assertions: 3 })) })
  assert.equal(verifyProjectTestResult(result(['passed', 'passed']), manifest).verdict, 'pass')
  assert.equal(verifyProjectTestResult(result(['passed', 'skipped']), manifest).reason, 'tests_skipped')
  assert.equal(verifyProjectTestResult({ ...result(['passed', 'passed']), manifestHash: 'f'.repeat(64) }, manifest).verdict, 'unknown')
  assert.equal(verifyProjectTestResult({ manifestHash: hash(manifest), results: [] }, manifest).verdict, 'unknown')
  const zero = result(['passed', 'passed']); zero.results[0].assertions = 0
  assert.equal(verifyProjectTestResult(zero, manifest).reason, 'zero_assertions')
})

test('registered project runner executes its exact code-owned manifest and emits no shell command', () => {
  assert.deepEqual(PROJECT_TEST_MANIFESTS, ['mse-learning-core-v1'])
  assert.equal(runRegisteredProjectTests('user-selected-command'), null)
  const run = runRegisteredProjectTests('mse-learning-core-v1')
  assert.equal(run.status, 'pass')
  assert.equal(run.fixture.source.length, 4)
  assert.ok(run.fixture.artifact.every(row => row.status === 'passed' && row.assertions === 1))
  assert.equal(runRegisteredProjectTests('mse-learning-core-v1').oracleHash, run.oracleHash)
})

test('package.json artifact checker accepts extension fields and optional name/version, rejects known type errors', () => {
  const valid = verifyPackageJsonArtifact('{"scripts":{"test":"node --test"},"custom":true}', 'package.json')
  assert.equal(valid.status, 'pass')
  assert.equal(valid.reason, 'package_json_structure_valid')
  assert.deepEqual(valid.violations, [])
  assert.equal(verifyPackageJsonArtifact('{"scripts":{"test":17}}', 'package.json').reason,
    'package_json_field_type_invalid')
  assert.equal(verifyPackageJsonArtifact('{"scripts":', 'package.json').reason, 'manifest_invalid_json')
  assert.equal(verifyPackageJsonArtifact('[]', 'package.json').reason, 'package_json_top_level_not_object')
  assert.equal(verifyPackageJsonArtifact('{}', 'other.json').status, 'unknown')
  const standardShapes = verifyPackageJsonArtifact(JSON.stringify({
    browser: { './node.js': './browser.js' }, bundleDependencies: true,
    bundledDependencies: ['alias-package'], author: 'Ada <ada@example.test>',
    contributors: ['Grace Hopper', { name: 'Linus', email: 'linus@example.test' }],
  }), 'package.json')
  assert.equal(standardShapes.status, 'pass')
  assert.deepEqual(standardShapes.violations, [])
  for (const content of ['{"version":17}', '{"scripts":{"test":17},"private":"yes"}']) {
    const checked = verifyPackageJsonArtifact(content, 'package.json')
    const witness = packageJsonReplayWitness(checked)
    assert.ok(witness)
    const parsed = verifyPackageJsonArtifact(witness, 'package.json')
    assert.equal(parsed.status, checked.status)
    assert.deepEqual(parsed.violations, checked.violations)
    const fixture = { fixtureId: 'package-witness-regression', oracleHash: checked.oracleHash,
      source: [{ field: 'witness', value: witness }],
      artifact: [{ field: 'status', value: checked.status }, { field: 'reason', value: checked.reason },
        { field: 'violations', value: checked.violations }] }
    assert.equal(replayTaskFixture(fixture).status, 'fail')
  }
})

test('package replay explicitly repairs malformed JSON and preserves invalid fields and controls', () => {
  const malformed = verifyPackageJsonArtifact('{"scripts":', 'package.json')
  const syntaxFixture = { source: [{ field: 'witness', value: packageJsonReplayWitness(malformed) }],
    artifact: [{ field: 'reason', value: malformed.reason }, { field: 'violations', value: [] }] }
  assert.equal(verifyPackageJsonReplayOutput(syntaxFixture, '{}', 'bad').reason, 'replay_syntax_repair_incomplete')
  assert.equal(verifyPackageJsonReplayOutput(syntaxFixture, '{"scripts":{"test":"node --test"}}', 'bad').status, 'pass')
  const invalid = verifyPackageJsonArtifact('{"scripts":{"test":17}}', 'package.json')
  const invalidFixture = { source: [{ field: 'witness', value: packageJsonReplayWitness(invalid) }],
    artifact: [{ field: 'reason', value: invalid.reason }, { field: 'violations', value: invalid.violations }] }
  assert.equal(verifyPackageJsonReplayOutput(invalidFixture, '{}', 'bad').reason, 'replay_invalid_field_removed')
  assert.equal(verifyPackageJsonReplayOutput(invalidFixture, '{"scripts":{"test":"node --test"}}', 'bad').status, 'pass')
  const control = verifyPackageJsonArtifact('{"scripts":{"test":"node --test"},"custom":true}', 'package.json')
  const controlFixture = { source: [{ field: 'witness', value: packageJsonReplayWitness(control) }], artifact: [] }
  assert.equal(verifyPackageJsonReplayOutput(controlFixture, controlFixture.source[0].value, 'control').status, 'pass')
  assert.equal(verifyPackageJsonReplayOutput(controlFixture, '{}', 'control').reason, 'replay_control_changed')
})

test('structured artifact checks are schema-bound and replay pair identity requires distinct frozen fixtures', () => {
  const schema = { id: 'artifact.v1', version: 1, requiredKeys: ['result'], allowedKeys: ['result', 'count'] }
  assert.equal(verifyStructuredArtifact({ schemaHash: hash(schema), artifact: { result: 'ok' } }, schema).verdict, 'pass')
  assert.equal(verifyStructuredArtifact({ schemaHash: 'f'.repeat(64), artifact: { result: 'ok' } }, schema).verdict, 'unknown')
  assert.equal(verifyStructuredArtifact({ schemaHash: hash(schema), artifact: { count: 1 } }, schema).verdict, 'fail')
  const identity = replayPairIdentity({ contractHash: H, validatorHash: H, environment: H,
    badFixtureHash: 'b'.repeat(64), controlFixtureHash: 'c'.repeat(64) })
  assert.equal(identity.length, 64)
  assert.throws(() => replayPairIdentity({ contractHash: H, validatorHash: H, environment: H,
    badFixtureHash: 'b'.repeat(64), controlFixtureHash: 'b'.repeat(64) }), /invalid_replay_pair/)
  const boundEvidence = { eventId: 'result:1', contractHash: H, validatorHash: H, scope: H, environment: H,
    model: 'model.v1', toolchain: 'node22', methodId: 'method.v1', methodVersion: 1, validatorId: 'check.v1',
    validatorVersion: 1, adoptionSessionHash: H, adoptionTurnHash: H, artifactHash: H,
    verdict: 'pass', failedChecks: [], at: 10 }
  assert.equal(taskEvidenceDigest(boundEvidence).length, 64)
  const fixture = id => ({ fixtureId: id, oracleHash: H, source: [{ id: 'r1', value: null }], artifact: [{ id: 'r1', value: id }] })
  const ledger = { format: 1, cases: [] }
  const badFixture = fixture('bad'), controlFixture = fixture('control')
  const pair = { contractHash: H, validatorHash: H, environment: H, badFixtureHash: hash(badFixture),
    controlFixtureHash: hash(controlFixture), badFixture, controlFixture, badVerdict: 'fail', controlVerdict: 'pass' }
  assert.equal(recordReplayPairInState(ledger, { ...pair, badVerdict: 'pass' }, 10).code, 'replay_pair_unverified')
  assert.equal(recordReplayPairInState(ledger, pair, 10).ok, true)
  assert.equal(recordReplayPairInState(ledger, pair, 11).duplicate, true)
  assert.equal(replayCaseLedgerValid(ledger), true)
})

test('registered host guard is inert by default, shadow-only when requested, and reversible on false positives', () => {
  const base = { guardId: 'tool.contract', version: 1, toolName: 'write_file',
    requiredKeys: ['path', 'content'], allowedKeys: ['path', 'content'] }
  const exec = { name: 'write_file', arguments: { path: '/tmp/x', content: 'ok', unexpected: true } }
  assert.equal(checkGuard({ ...base, mode: 'observe' }, exec).denyReason, undefined)
  assert.equal(checkGuard({ ...base, mode: 'shadow' }, exec).code, 'unexpected_key')
  assert.equal(checkGuard({ ...base, guardId: ['tool.contract'] }, exec).matched, false)
  assert.equal(checkGuard({ ...base, allowedKeys: [['path', 'content']] }, exec).matched, false)
  assert.match(createGuardFunction({ ...base, mode: 'enforce' })(exec), /unexpected_key/)
  assert.equal(createGuardFunction({ ...base, mode: 'suspended' })(exec), undefined)
  assert.throws(() => createGuardFunction({ ...base, mode: 'enforce', command: 'rm -rf' }), /invalid_guard_template/)
})

test('DSH guard lease survives plugin disposal for a prepared call and releases after its host result event', async () => {
  const listeners = new Map()
  const guards = new Set()
  const ctx = { tools: { guard(fn) { guards.add(fn); return () => guards.delete(fn) } },
    on(name, fn) { const rows = listeners.get(name) ?? []; rows.push(fn); listeners.set(name, rows); return () => {
      listeners.set(name, rows.filter(row => row !== fn))
    } } }
  const dispose = registerDshGuardTemplates(ctx, [{ guardId: 'contract.x', version: 1, mode: 'enforce',
    toolName: 'write_file', requiredKeys: ['path'], allowedKeys: ['path'] }])
  const exec = { name: 'write_file', arguments: { path: '/tmp/x' } }
  assert.equal([...guards][0](exec), undefined)
  dispose() // prepared execution is still live; policy listeners must remain until tools/result.
  assert.equal(guards.size, 1)
  exec.arguments = { path: '/tmp/x', extra: true }
  const result = await listeners.get('tools/execute')[0](exec, () => { throw new Error('dispatch must be refused') })
  assert.equal(result.isError, true)
  listeners.get('tools/result')[0](exec, result)
  assert.equal(guards.size, 0)
  assert.equal(listeners.get('tools/execute').length, 0)
})

test('DSH guard reports missing host capability and follows the live enabled setting', async () => {
  const template = { guardId: 'contract.x', version: 1, mode: 'enforce', toolName: 'write_file',
    requiredKeys: ['path'], allowedKeys: ['path'] }
  const unsupported = registerDshGuardTemplates({ tools: { guard() { return () => {} } } }, [template])
  assert.equal(unsupported.supported, false)
  assert.equal(unsupported.registered, 0)
  assert.equal(unsupported.enforcing, 0)

  const listeners = new Map(), guards = new Set()
  let enabled = true
  const ctx = { tools: { guard(fn) { guards.add(fn); return () => guards.delete(fn) } },
    on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
  const dispose = registerDshGuardTemplates(ctx, [template], { enabled: () => enabled })
  const exec = { name: 'write_file', arguments: {} }
  assert.match([...guards][0](exec), /required_key_missing/)
  enabled = false
  assert.equal([...guards][0](exec), undefined)
  const result = await listeners.get('tools/execute')(exec, () => ({ isError: false }))
  assert.equal(result.isError, false)
  dispose()
})

test('DSH plugin config schema validates guard template registration and defaults to no guards', () => {
  const base = { guardId: 'contract.x', version: 1, mode: 'shadow', toolName: 'write_file',
    requiredKeys: ['path'], allowedKeys: ['path', 'content'] }
  const valid = dshConfig['~standard'].validate({ guardTemplates: [base] })
  assert.equal(valid.issues, undefined)
  assert.equal(valid.value.guardTemplates.length, 1)
  assert.deepEqual(dshConfig['~standard'].validate({}).value.guardTemplates, [])
  assert.ok(dshConfig['~standard'].validate({ guardTemplates: [{ ...base, mode: 'execute-script' }] }).issues)
})

test('host task evidence is durable before adoption and stores a recoverable fail/control pair', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-task-evidence-'))
  const now = Date.UTC(2030, 0, 1)
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh', now: () => now })
  const projectKey = '/synthetic/task-evidence'
  const sessionId = 'synthetic-task-session', turnId = '1'
  const authority = createTaskEvidenceAuthority(engine)
  const context = engine.taskEvidenceContext(authority, { sessionId, turnId, projectKey, environmentId: 'task-env' })
  assert.equal(context.adoptionSessionHash, null, 'a first task run has no adoption to bind')
  const oracleHash = 'c'.repeat(64), validatorHash = hash(['mse-preserve-null-checker', 1, oracleHash])
  const hostResultHash = suffix => createHash('sha256').update(`actual-host-result:${suffix}`).digest('hex')
  const fixture = fixtureId => taskFixtureOf('mse-preserve-null-rows-v1', fixtureId === 'preserve-null.bad-null-row.v1'
    ? 'bad-null-row' : 'control-null-row')
  const put = (eventId, sourceEventId, verdict, fixtureId, at, sourceKind = 'structured_task') => {
    const material = fixture(fixtureId), artifactHash = hash(material)
    const contractInput = { contractId: 'mse-preserve-null-rows-v1', version: 1, scope: context.scope,
      environment: context.environment, taskFamily: 'mse-preserve-null-rows', model: 'm-deepseek-flash',
      toolchain: 'dsh-tools-0.2.1-alpha.2', methodId: 'preserve-null-v1', methodVersion: 1,
      validatorId: 'mse-preserve-null-checker', validatorVersion: 1, sourceEventId, artifactHash,
      adoptionSessionHash: null, adoptionTurnHash: null }
    const { contract, hash: contractHash } = canonicalTaskContract(contractInput)
    const evidence = { eventId, contractHash, validatorHash, scope: context.scope, environment: context.environment,
      model: contract.model, toolchain: contract.toolchain, methodId: contract.methodId, methodVersion: 1,
      validatorId: contract.validatorId, validatorVersion: 1, adoptionSessionHash: null, adoptionTurnHash: null,
      artifactHash, verdict, failedChecks: verdict === 'fail' ? ['artifact_value_mismatch'] : [], at }
    return engine.recordTaskEvidence(authority, { contract, evidence, hostResultHash: hostResultHash(eventId),
      taskFamilyHash: taskFamilyHashOf(contract), fixture: material,
      taskContext: { ...context.taskContext, sourceKind } })
  }
  const first = put('ev-bad', 'src-bad', 'fail', 'preserve-null.bad-null-row.v1', now)
  const second = put('ev-control', 'src-control', 'pass', 'preserve-null.control-null-row.v1', now + 1)
  const repeatedFailure = put('ev-bad-independent', 'src-bad-independent', 'fail', 'preserve-null.bad-null-row.v1', now + 2)
  const calibration = put('ev-calibration', 'src-calibration', 'fail', 'preserve-null.bad-null-row.v1', now + 3, 'calibration')
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(repeatedFailure.ok, true)
  assert.equal(calibration.ok, true)
  assert.equal(calibration.problem ?? null, null, 'calibration fixtures never seed product learning problems')
  assert.equal(engine.taskEvidenceStatus().records, 3)
  assert.equal(engine.taskEvidenceStatus().replayCases, 1)
  assert.equal(first.problem.ok, true)
  assert.equal(repeatedFailure.problem.ready, true)
  assert.equal(engine.problemStatus({ limit: 10 }).rows[0].state, 'eligible')
  assert.throws(() => engine.recordTaskEvidence({}, {}), /untrusted_task_evidence/)
  const reopened = new LearningEngine({ stateRoot, adapterId: 'dsh', now: () => now + 3 })
  assert.equal(reopened.taskEvidenceStatus().records, 3, 'the evidence survives a real store reopen')
  assert.equal(reopened.taskEvidenceStatus().replayCases, 1)
  const recovered = reopened.store.read().taskEvidence
  assert.equal(taskEvidenceLedgerValid(recovered), true)
  const sourceBinding = recovered.records[0].sourceBinding
  assert.deepEqual(Object.keys(sourceBinding).sort(), ['environment', 'scope', 'sessionHash', 'sourceKind', 'turnHash'])
  const sessionHash = createHash('sha256').update(sessionId).digest('hex')
  assert.equal(sourceBinding.sessionHash, sessionHash, 'raw source binding stores only a session hash')
  assert.equal(sourceBinding.turnHash, createHash('sha256').update(JSON.stringify([sessionId, turnId])).digest('hex'),
    'raw source binding stores only a session/turn hash')
  const legacyLedger = { ...structuredClone(recovered), format: 1, adoptionAttributions: undefined,
    records: recovered.records.map(({ sourceBinding, ...row }) => row) }
  delete legacyLedger.adoptionAttributions
  assert.equal(taskEvidenceLedgerValid(legacyLedger), true, 'the prior on-disk format remains readable')
  const migratedLedger = ensureTaskEvidenceLedger({ taskEvidence: legacyLedger })
  assert.equal(migratedLedger.format, 2)
  assert.ok(migratedLedger.records.every(row => row.sourceBinding === null),
    'legacy facts without source hashes remain non-attributable')
  assert.equal(taskEvidenceLedgerValid(migratedLedger), true)
  assert.equal(replayTaskFixture(recovered.replayCases.cases[0].badFixture).status, 'fail')
  assert.equal(replayTaskFixture(recovered.replayCases.cases[0].controlFixture).status, 'pass')
})

test('real package.json artifact facts are checker-bound, paired with a valid control, and enter the problem queue', () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-package-json-evidence-'))
  const engine = new LearningEngine({ stateRoot, adapterId: 'dsh', now: () => 1_900_000_000_000 })
  const authority = createTaskEvidenceAuthority(engine)
  const base = { adapterId: 'dsh', environmentId: 'package-env', eventId: '', filename: 'package.json',
    lessonId: null, lessonVersion: null, model: 'deepseek-flash', projectKey: '/synthetic/package-project', provider: 'deepseek-official',
    reasoningEffort: 'max', sessionId: 'package-session', toolchain: 'dsh-file-editor-v1', turnId: 'package-turn' }
  const write = (eventId, content) => engine.recordPackageJsonArtifact(authority, { ...base, eventId, content,
    fileHash: createHash('sha256').update(content).digest('hex') })
  const bad = write('package-write-bad', '{"scripts":{"test":17}}')
  const good = write('package-write-good', '{"scripts":{"test":"node --test"},"custom":true}')
  assert.equal(bad.status, 'fail')
  assert.equal(bad.evidence.problem.ok, true)
  assert.equal(good.status, 'pass')
  assert.equal(engine.taskEvidenceStatus().records, 2)
  assert.equal(engine.taskEvidenceStatus().replayCases, 1)
  const pair = engine.store.read().taskEvidence.replayCases.cases[0]
  assert.equal(pair.badFixture.artifact.find(row => row.field === 'reason').value, 'package_json_field_type_invalid')
  assert.equal(pair.controlFixture.artifact.find(row => row.field === 'reason').value, 'package_json_structure_valid')
  assert.equal(replayTaskFixture(pair.badFixture).status, 'fail', 'the persisted real-failure witness is rechecked by the current package oracle')
  assert.equal(replayTaskFixture(pair.controlFixture).status, 'pass', 'the persisted normal-control witness is rechecked by the current package oracle')
  assert.equal(pair.badFixture.source[0].value.includes('custom'), false, 'private project manifest values are not copied into replay storage')
  assert.equal(engine.problemStatus({ limit: 8 }).rows.length, 1)
  assert.throws(() => engine.recordPackageJsonArtifact({}, { ...base, content: '{}', fileHash: '0'.repeat(64) }),
    /untrusted_task_evidence/)
})
