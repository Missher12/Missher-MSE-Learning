/** Strict, deterministic primitives for host registered task contracts (0.10.0). */
import { createHash } from 'node:crypto'

const HASH = Object.freeze({ test: value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) })
const SAFE_ID = Object.freeze({ test: value => typeof value === 'string' && /^[a-z][a-z0-9._:-]{0,63}$/u.test(value) })
const FIELD = Object.freeze({ test: value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u.test(value) })
const ROUTE_ID = Object.freeze({ test: value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u.test(value) })
const own = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function exactKeys(value, keys) {
  return own(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

/** Canonical contract must be minted from trusted adapter facts; model-authored input is never accepted. */
export function canonicalTaskContract(input) {
  const keys = ['contractId', 'version', 'scope', 'environment', 'taskFamily', 'model', 'toolchain',
    'methodId', 'methodVersion', 'validatorId', 'validatorVersion', 'sourceEventId', 'artifactHash',
    'adoptionSessionHash', 'adoptionTurnHash']
  if (!exactKeys(input, keys) || !SAFE_ID.test(input.contractId) || !Number.isSafeInteger(input.version)
    || input.version < 1 || !HASH.test(input.scope) || !HASH.test(input.environment)
    || !SAFE_ID.test(input.taskFamily) || !ROUTE_ID.test(input.model) || !SAFE_ID.test(input.toolchain)
    || !SAFE_ID.test(input.methodId) || !Number.isSafeInteger(input.methodVersion) || input.methodVersion < 1
    || !SAFE_ID.test(input.validatorId) || !Number.isSafeInteger(input.validatorVersion) || input.validatorVersion < 1
    || !SAFE_ID.test(input.sourceEventId) || !HASH.test(input.artifactHash)
    || !((input.adoptionSessionHash === null && input.adoptionTurnHash === null)
      || (HASH.test(input.adoptionSessionHash) && HASH.test(input.adoptionTurnHash)))) throw new TypeError('invalid_task_contract')
  const contract = Object.freeze(Object.fromEntries(keys.map(key => [key, input[key]])))
  return Object.freeze({ contract, hash: digest(contract) })
}

/** Registry identity is closure-private; a JSON field cannot assert that a verifier is trusted. */
export function createVerifierRegistry() {
  const verifierAuthority = Object.freeze(Object.create(null))
  const entries = new Map()
  return Object.freeze({
    authority: verifierAuthority,
    register(authority, id, version, verify) {
      if (authority !== verifierAuthority) throw new TypeError('untrusted_verifier_registration')
      if (!SAFE_ID.test(id) || !Number.isSafeInteger(version) || version < 1 || typeof verify !== 'function') {
        throw new TypeError('invalid_verifier')
      }
      const key = `${id}@${version}`
      if (entries.has(key)) throw new TypeError('verifier_immutable')
      entries.set(key, verify)
      return Object.freeze({ id, version })
    },
    async verify(binding, evidence) {
      if (!own(binding) || !SAFE_ID.test(binding.validatorId) || !Number.isSafeInteger(binding.validatorVersion)
        || !HASH.test(binding.contractHash) || !HASH.test(binding.environment)
        || !HASH.test(binding.artifactHash) || binding.contractHash !== evidence?.contractHash
        || binding.environment !== evidence?.environment || binding.artifactHash !== evidence?.artifactHash) {
        return Object.freeze({ verdict: 'unknown', reason: 'binding_mismatch' })
      }
      const fn = entries.get(`${binding.validatorId}@${binding.validatorVersion}`)
      if (!fn) return Object.freeze({ verdict: 'unknown', reason: 'validator_unregistered' })
      const result = await fn(evidence.input)
      if (!own(result) || !['pass', 'fail', 'unknown'].includes(result.verdict)) {
        return Object.freeze({ verdict: 'unknown', reason: 'invalid_verifier_result' })
      }
      return Object.freeze({ verdict: result.verdict, reason: SAFE_ID.test(result.reason ?? 'ok') ? result.reason ?? 'ok' : 'invalid_reason' })
    },
  })
}

/** Project test manifests name only registered test IDs, never shell commands or repo scripts. */
export function verifyProjectTestResult(input, manifest) {
  if (!exactKeys(manifest, ['id', 'version', 'testIds']) || !SAFE_ID.test(manifest.id)
    || !Number.isSafeInteger(manifest.version) || manifest.version < 1 || !Array.isArray(manifest.testIds)
    || manifest.testIds.length < 1 || manifest.testIds.length > 256
    || !manifest.testIds.every(id => SAFE_ID.test(id)) || new Set(manifest.testIds).size !== manifest.testIds.length) {
    return Object.freeze({ verdict: 'unknown', reason: 'manifest_invalid' })
  }
  if (!exactKeys(input, ['manifestHash', 'results']) || input.manifestHash !== digest(manifest)
    || !Array.isArray(input.results) || input.results.length !== manifest.testIds.length) {
    return Object.freeze({ verdict: 'unknown', reason: 'manifest_binding_mismatch' })
  }
  const byId = new Map()
  for (const row of input.results) {
    if (!exactKeys(row, ['testId', 'status', 'assertions']) || !SAFE_ID.test(row.testId)
      || !['passed', 'failed', 'skipped'].includes(row.status) || !Number.isSafeInteger(row.assertions)
      || row.assertions < 0 || byId.has(row.testId)) return Object.freeze({ verdict: 'unknown', reason: 'result_invalid' })
    byId.set(row.testId, row)
  }
  if (manifest.testIds.some(id => !byId.has(id))) return Object.freeze({ verdict: 'unknown', reason: 'test_set_incomplete' })
  const rows = manifest.testIds.map(id => byId.get(id))
  if (rows.some(row => row.status === 'skipped')) return Object.freeze({ verdict: 'unknown', reason: 'tests_skipped' })
  if (rows.some(row => row.assertions === 0)) return Object.freeze({ verdict: 'unknown', reason: 'zero_assertions' })
  if (rows.some(row => row.status === 'failed')) return Object.freeze({ verdict: 'fail', reason: 'test_failed' })
  return Object.freeze({ verdict: 'pass', reason: 'all_registered_tests_passed' })
}

/** Exact structured artifact checks; a digest binds the registered oracle, it does not certify it. */
export function verifyStructuredArtifact(input, schema) {
  if (!exactKeys(schema, ['id', 'version', 'requiredKeys', 'allowedKeys']) || !SAFE_ID.test(schema.id)
    || !Number.isSafeInteger(schema.version) || schema.version < 1
    || !Array.isArray(schema.requiredKeys) || !Array.isArray(schema.allowedKeys)
    || schema.requiredKeys.length > 128 || schema.allowedKeys.length > 256
    || !schema.requiredKeys.every(key => FIELD.test(key)) || !schema.allowedKeys.every(key => FIELD.test(key))
    || schema.requiredKeys.some(key => !schema.allowedKeys.includes(key))) {
    return Object.freeze({ verdict: 'unknown', reason: 'schema_invalid' })
  }
  if (!own(input) || !exactKeys(input, ['schemaHash', 'artifact']) || input.schemaHash !== digest(schema)
    || !own(input.artifact)) return Object.freeze({ verdict: 'unknown', reason: 'schema_binding_mismatch' })
  const keys = Object.keys(input.artifact)
  if (keys.some(key => !schema.allowedKeys.includes(key))) return Object.freeze({ verdict: 'fail', reason: 'unexpected_artifact_key' })
  if (schema.requiredKeys.some(key => !Object.hasOwn(input.artifact, key))) return Object.freeze({ verdict: 'fail', reason: 'required_artifact_key_missing' })
  return Object.freeze({ verdict: 'pass', reason: 'registered_artifact_shape_valid' })
}

/** Bounded frozen pair identity; raw task material stays in the isolated host fixture store. */
export function replayPairIdentity({ contractHash, validatorHash, environment, badFixtureHash, controlFixtureHash }) {
  if (![contractHash, validatorHash, environment, badFixtureHash, controlFixtureHash].every(value => HASH.test(value))
    || badFixtureHash === controlFixtureHash) throw new TypeError('invalid_replay_pair')
  return digest([contractHash, validatorHash, environment, badFixtureHash, controlFixtureHash])
}

export const REPLAY_CASE_LIMIT = 64
export const REPLAY_CASE_FORMAT = 1
export const TASK_EVIDENCE_LIMIT = 256
export const TASK_EVIDENCE_FORMAT = 2

const taskAuthorities = new WeakMap()

/** Host adapters receive an opaque per-engine capability; it is never serializable or model-facing. */
export function createTaskEvidenceAuthority(engine) {
  if (engine === null || (typeof engine !== 'object' && typeof engine !== 'function')) throw new TypeError('invalid_task_authority')
  let authority = taskAuthorities.get(engine)
  if (authority === undefined) { authority = Object.freeze(Object.create(null)); taskAuthorities.set(engine, authority) }
  return authority
}

export function taskEvidenceAuthorityFor(engine) { return taskAuthorities.get(engine) }

export function taskEvidenceLedgerValid(ledger) {
  if (!own(ledger) || ![1, TASK_EVIDENCE_FORMAT].includes(ledger.format)
    || Object.keys(ledger).sort().join(',') !== (ledger.format === 1 ? 'format,records,replayCases'
      : 'adoptionAttributions,format,records,replayCases')
    || !Array.isArray(ledger.records) || ledger.records.length > TASK_EVIDENCE_LIMIT) return false
  const recordsValid = ledger.records.every(row => own(row)
    && Object.keys(row).sort().join(',') === (ledger.format === 1
      ? 'digest,evidence,fixture,hostResultHash,taskFamilyHash'
      : 'digest,evidence,fixture,hostResultHash,sourceBinding,taskFamilyHash')
    && HASH.test(row.digest) && HASH.test(row.hostResultHash) && HASH.test(row.taskFamilyHash)
    && taskReplayFixtureValid(row.fixture)
    && (ledger.format === 1 || (row.sourceBinding === null || (own(row.sourceBinding)
      && Object.keys(row.sourceBinding).sort().join(',') === 'environment,scope,sessionHash,sourceKind,turnHash'
      && HASH.test(row.sourceBinding.environment) && HASH.test(row.sourceBinding.scope)
      && HASH.test(row.sourceBinding.sessionHash) && HASH.test(row.sourceBinding.turnHash)
      && ['calibration', 'project_test', 'structured_task'].includes(row.sourceBinding.sourceKind))))
    && taskEvidenceDigest(row.evidence) === row.digest)
  const evidenceDigests = new Set(ledger.records.map(row => row.digest))
  const attributionsValid = ledger.format === 1 || (Array.isArray(ledger.adoptionAttributions)
    && ledger.adoptionAttributions.length <= TASK_EVIDENCE_LIMIT
    && ledger.adoptionAttributions.every(row => own(row)
      && Object.keys(row).sort().join(',') === 'at,environment,evidenceDigest,lessonId,scope,sessionHash,sourceKind,turnHash,version'
      && HASH.test(row.environment) && HASH.test(row.scope) && HASH.test(row.sessionHash) && HASH.test(row.turnHash)
      && ['calibration', 'project_test', 'structured_task'].includes(row.sourceKind)
      && evidenceDigests.has(row.evidenceDigest)
      && (() => {
        const source = ledger.records.find(record => record.digest === row.evidenceDigest)?.sourceBinding
        return source !== null && source !== undefined && source.environment === row.environment
          && source.scope === row.scope && source.sessionHash === row.sessionHash && source.turnHash === row.turnHash
          && source.sourceKind === row.sourceKind
      })()
      && HASH.test(row.evidenceDigest) && /^lesson_[a-f0-9]{24}$/u.test(row.lessonId)
      && Number.isSafeInteger(row.version) && row.version > 0 && Number.isFinite(row.at))
    && new Set(ledger.adoptionAttributions.map(row => `${row.evidenceDigest}:${row.lessonId}:${row.version}`)).size
      === ledger.adoptionAttributions.length)
  return recordsValid && attributionsValid
    && replayCaseLedgerValid(ledger.replayCases)
    && new Set(ledger.records.map(row => row.evidence.eventId)).size === ledger.records.length
}

export function ensureTaskEvidenceLedger(state) {
  if (state.taskEvidence === undefined) state.taskEvidence = { format: TASK_EVIDENCE_FORMAT, records: [],
    replayCases: { format: REPLAY_CASE_FORMAT, cases: [] }, adoptionAttributions: [] }
  else if (state.taskEvidence.format === 1) {
    // Old facts remain byte-for-byte intact. They have no recoverable source turn binding, so they
    // are explicitly ineligible for later adoption attribution.
    state.taskEvidence = { ...state.taskEvidence, format: TASK_EVIDENCE_FORMAT,
      records: state.taskEvidence.records.map(row => ({ ...row, sourceBinding: null })), adoptionAttributions: [] }
  }
  return state.taskEvidence
}

export function taskReplayFixtureValid(value) {
  if (!own(value) || Object.keys(value).sort().join(',') !== 'artifact,fixtureId,oracleHash,source'
    || !SAFE_ID.test(value.fixtureId) || !HASH.test(value.oracleHash)
    || !Array.isArray(value.source) || !Array.isArray(value.artifact)) return false
  try { return Buffer.byteLength(JSON.stringify(value)) <= 32_768 } catch { return false }
}

export function replayCaseLedgerValid(ledger) {
  return own(ledger) && Object.keys(ledger).sort().join(',') === 'cases,format'
    && ledger.format === REPLAY_CASE_FORMAT && Array.isArray(ledger.cases)
    && ledger.cases.length <= REPLAY_CASE_LIMIT && ledger.cases.every(row => own(row)
      && ['badFixture,badFixtureHash,contractHash,controlFixture,controlFixtureHash,createdAt,environment,id,validatorHash',
        'badFixture,badFixtureHash,contractHash,controlFixture,controlFixtureHash,createdAt,environment,id,scope,validatorHash'].includes(Object.keys(row).sort().join(','))
      && HASH.test(row.id) && HASH.test(row.contractHash) && HASH.test(row.validatorHash)
      && HASH.test(row.environment) && (row.scope === undefined || HASH.test(row.scope)) && HASH.test(row.badFixtureHash) && HASH.test(row.controlFixtureHash)
      && taskReplayFixtureValid(row.badFixture) && taskReplayFixtureValid(row.controlFixture)
      && digest(row.badFixture) === row.badFixtureHash && digest(row.controlFixture) === row.controlFixtureHash
      && row.badFixtureHash !== row.controlFixtureHash && Number.isFinite(row.createdAt))
    && new Set(ledger.cases.map(row => row.id)).size === ledger.cases.length
}

/** Store only references/hashes after independently verified fail+control outcomes. */
export function recordReplayPairInState(ledger, input, now) {
  if (!replayCaseLedgerValid(ledger) || !own(input) || !Number.isFinite(now)
    || input.badVerdict !== 'fail' || input.controlVerdict !== 'pass'
    || !taskReplayFixtureValid(input.badFixture) || !taskReplayFixtureValid(input.controlFixture)) return Object.freeze({ ok: false, code: 'replay_pair_unverified' })
  let id
  try { id = replayPairIdentity(input) } catch { return Object.freeze({ ok: false, code: 'replay_pair_invalid' }) }
  if (ledger.cases.some(row => row.id === id)) return Object.freeze({ ok: true, duplicate: true, id })
  // Keep a rolling, durable replay window. Cases are self-contained immutable snapshots, so
  // evicting the oldest replay does not invalidate any task record or live candidate reference.
  if (ledger.cases.length >= REPLAY_CASE_LIMIT) ledger.cases.shift()
  ledger.cases.push(Object.freeze({ id, contractHash: input.contractHash, validatorHash: input.validatorHash,
    environment: input.environment, ...(HASH.test(input.scope) ? { scope: input.scope } : {}), badFixtureHash: input.badFixtureHash,
    controlFixtureHash: input.controlFixtureHash, badFixture: structuredClone(input.badFixture),
    controlFixture: structuredClone(input.controlFixture), createdAt: now }))
  return Object.freeze({ ok: true, duplicate: false, id })
}

export function taskFamilyHashOf(contract) {
  if (!own(contract)) throw new TypeError('invalid_task_contract')
  return digest(['mse-task-family-v1', contract.contractId, contract.version, contract.scope, contract.environment,
    contract.taskFamily, contract.model, contract.toolchain, contract.methodId, contract.methodVersion,
    contract.validatorId, contract.validatorVersion])
}

export function validateTaskEvidenceBinding(contract, evidence, contractHash) {
  const keys = ['eventId', 'contractHash', 'validatorHash', 'scope', 'environment', 'model', 'toolchain',
    'methodId', 'methodVersion', 'validatorId', 'validatorVersion', 'adoptionSessionHash', 'adoptionTurnHash',
    'artifactHash', 'verdict', 'failedChecks', 'at']
  if (!own(contract) || !exactKeys(evidence, keys) || !HASH.test(contractHash)
    || evidence.contractHash !== contractHash || !SAFE_ID.test(evidence.eventId)
    || !HASH.test(evidence.validatorHash) || evidence.scope !== contract.scope
    || evidence.environment !== contract.environment || evidence.model !== contract.model
    || evidence.toolchain !== contract.toolchain || evidence.methodId !== contract.methodId
    || evidence.methodVersion !== contract.methodVersion || evidence.validatorId !== contract.validatorId
    || evidence.validatorVersion !== contract.validatorVersion
    || evidence.adoptionSessionHash !== contract.adoptionSessionHash
    || evidence.adoptionTurnHash !== contract.adoptionTurnHash || evidence.artifactHash !== contract.artifactHash
    || !['pass', 'fail', 'unknown'].includes(evidence.verdict) || !Array.isArray(evidence.failedChecks)
    || evidence.failedChecks.length > 64 || !evidence.failedChecks.every(id => SAFE_ID.test(id))
    || !Number.isFinite(evidence.at)) return false
  return true
}

export const taskEvidenceDigest = evidence => {
  const required = ['eventId', 'contractHash', 'validatorHash', 'scope', 'environment', 'model', 'toolchain',
    'methodId', 'methodVersion', 'validatorId', 'validatorVersion', 'adoptionSessionHash', 'adoptionTurnHash',
    'artifactHash', 'verdict', 'failedChecks', 'at']
  if (!exactKeys(evidence, required) || !SAFE_ID.test(evidence.eventId) || !HASH.test(evidence.contractHash)
    || !HASH.test(evidence.validatorHash) || !HASH.test(evidence.scope) || !HASH.test(evidence.environment)
    || !ROUTE_ID.test(evidence.model) || !SAFE_ID.test(evidence.toolchain) || !SAFE_ID.test(evidence.methodId)
    || !Number.isSafeInteger(evidence.methodVersion) || evidence.methodVersion < 1
    || !SAFE_ID.test(evidence.validatorId) || !Number.isSafeInteger(evidence.validatorVersion)
    || !((evidence.adoptionSessionHash === null && evidence.adoptionTurnHash === null)
      || (HASH.test(evidence.adoptionSessionHash) && HASH.test(evidence.adoptionTurnHash)))
    || !HASH.test(evidence.artifactHash) || !['pass', 'fail', 'unknown'].includes(evidence.verdict)
    || !Array.isArray(evidence.failedChecks) || evidence.failedChecks.length > 64
    || !evidence.failedChecks.every(id => SAFE_ID.test(id)) || !Number.isFinite(evidence.at)) throw new TypeError('invalid_task_evidence')
  return digest(evidence)
}
