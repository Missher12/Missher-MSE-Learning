/** Built-in deterministic task producer profiles. No model-authored oracle or executable input. */
import { createHash } from 'node:crypto'
import { checkArtifact } from './checks.mjs'
import { verifyPackageJsonArtifact } from './package-json-checker.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const PROFILE = Object.freeze({ id: 'mse-preserve-null-rows-v1', methodId: 'preserve-null-v1', methodVersion: 1,
  validatorId: 'mse-preserve-null-checker', validatorVersion: 1,
  oracleHash: hash(['mse-preserve-null-rows-v1', 'preserve-null-v1', 1, 'source+artifact', 'null-preservation']) })
const FIXTURES = Object.freeze({
  'bad-null-row': Object.freeze({ fixtureId: 'preserve-null.bad-null-row.v1',
    source: Object.freeze([{ id: 'row-1', value: null }]), artifact: Object.freeze([{ id: 'row-1', value: 'unknown' }]) }),
  'control-null-row': Object.freeze({ fixtureId: 'preserve-null.control-null-row.v1',
    source: Object.freeze([{ id: 'row-1', value: null }]), artifact: Object.freeze([{ id: 'row-1', value: null }]) }),
})

export const TASK_PROFILE_IDS = Object.freeze([PROFILE.id])
export const TASK_PROFILE_INPUTS = Object.freeze(Object.keys(FIXTURES))
export function taskProfileOf(profileId, inputRef) {
  if (profileId !== PROFILE.id || !Object.hasOwn(FIXTURES, inputRef)) return null
  const fixture = FIXTURES[inputRef]
  return Object.freeze({ profileId: PROFILE.id, inputRef, producerId: 'mse-registered-row-fixture-v1',
    oracleHash: PROFILE.oracleHash, fixtureId: fixture.fixtureId,
    source: fixture.source.map(row => ({ ...row })), artifact: fixture.artifact.map(row => ({ ...row })) })
}

/** The pure verifier consumes only the registered fixture snapshot, never caller-supplied criteria. */
export function verifyTaskProfileOutput(attested) {
  if (!attested || attested.profileId !== PROFILE.id || attested.producerId !== 'mse-registered-row-fixture-v1') {
    return Object.freeze({ status: 'unknown', reason: 'profile_attestation_invalid' })
  }
  const fixture = FIXTURES[attested.inputRef]
  if (!fixture || fixture.fixtureId !== attested.fixtureId || attested.oracleHash !== PROFILE.oracleHash) {
    return Object.freeze({ status: 'unknown', reason: 'oracle_binding_mismatch' })
  }
  const checked = checkArtifact({ methodId: PROFILE.methodId, source: attested.source, artifact: attested.artifact })
  return Object.freeze({ status: checked.status, reason: checked.reason, checkId: checked.checkId,
    methodId: PROFILE.methodId, methodVersion: PROFILE.methodVersion, validatorId: PROFILE.validatorId,
    validatorVersion: PROFILE.validatorVersion, oracleHash: PROFILE.oracleHash, fixtureId: fixture.fixtureId })
}

export function taskFixtureOf(profileId, inputRef) {
  const result = taskProfileOf(profileId, inputRef)
  if (!result) return null
  return Object.freeze({ fixtureId: result.fixtureId, oracleHash: result.oracleHash,
    source: result.source, artifact: result.artifact })
}

/** Re-run a persisted snapshot only when it byte-matches a registered built-in fixture. */
export function replayTaskFixture(fixture) {
  if (!fixture || typeof fixture !== 'object') return Object.freeze({ status: 'unknown', reason: 'fixture_invalid' })
  if (typeof fixture.fixtureId === 'string' && fixture.fixtureId.startsWith('package-')) {
    if (Object.keys(fixture).sort().join(',') !== 'artifact,fixtureId,oracleHash,source'
      || !Array.isArray(fixture.source) || fixture.source.length !== 1
      || fixture.source[0]?.field !== 'witness' || typeof fixture.source[0]?.value !== 'string'
      || !Array.isArray(fixture.artifact)) return Object.freeze({ status: 'unknown', reason: 'fixture_snapshot_mismatch' })
    const checked = verifyPackageJsonArtifact(fixture.source[0].value, 'package.json')
    if (fixture.oracleHash !== checked.oracleHash) return Object.freeze({ status: 'unknown', reason: 'oracle_binding_mismatch' })
    const artifact = Object.fromEntries(fixture.artifact.map(row => [row.field, row.value]))
    if (artifact.status !== checked.status || artifact.reason !== checked.reason
      || JSON.stringify(artifact.violations) !== JSON.stringify(checked.violations)) {
      return Object.freeze({ status: 'unknown', reason: 'fixture_snapshot_mismatch' })
    }
    return Object.freeze({ status: checked.status, reason: checked.reason, oracleHash: checked.oracleHash })
  }
  const inputRef = Object.keys(FIXTURES).find(key => FIXTURES[key].fixtureId === fixture.fixtureId)
  if (!inputRef) return Object.freeze({ status: 'unknown', reason: 'fixture_unregistered' })
  const registered = taskFixtureOf(PROFILE.id, inputRef)
  if (JSON.stringify(fixture) !== JSON.stringify(registered)) return Object.freeze({ status: 'unknown', reason: 'fixture_snapshot_mismatch' })
  const output = { profileId: PROFILE.id, inputRef, producerId: 'mse-registered-row-fixture-v1', ...fixture }
  return verifyTaskProfileOutput(output)
}
