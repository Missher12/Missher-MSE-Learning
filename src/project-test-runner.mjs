/** Code-registered, side-effect-free project tests. No shell, paths, or model-authored assertions. */
import { createHash } from 'node:crypto'
import { taskProfileOf, verifyTaskProfileOutput } from './task-profiles.mjs'
import { verifyProjectTestResult } from './task-evidence.mjs'
import { verifyPackageJsonArtifact } from './package-json-checker.mjs'
export { verifyPackageJsonArtifact } from './package-json-checker.mjs'

const MANIFEST = Object.freeze({ id: 'mse-learning-core-v1', version: 1,
  testIds: Object.freeze(['profile.bad_input_rejected', 'profile.control_input_accepted',
    'profile.oracle_tamper_unknown', 'profile.unregistered_input_unknown']) })
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const oracleHash = hash(MANIFEST)
const runOne = testId => {
  if (testId === 'profile.bad_input_rejected') {
    const task = taskProfileOf('mse-preserve-null-rows-v1', 'bad-null-row')
    return verifyTaskProfileOutput(task).status === 'fail'
  }
  if (testId === 'profile.control_input_accepted') {
    const task = taskProfileOf('mse-preserve-null-rows-v1', 'control-null-row')
    return verifyTaskProfileOutput(task).status === 'pass'
  }
  if (testId === 'profile.oracle_tamper_unknown') {
    const task = taskProfileOf('mse-preserve-null-rows-v1', 'control-null-row')
    return verifyTaskProfileOutput({ ...task, oracleHash: '0'.repeat(64) }).status === 'unknown'
  }
  if (testId === 'profile.unregistered_input_unknown') {
    return taskProfileOf('mse-preserve-null-rows-v1', 'model-chosen') === null
  }
  return null
}

export const PROJECT_TEST_MANIFESTS = Object.freeze([MANIFEST.id])

export function runRegisteredProjectTests(manifestId) {
  if (manifestId !== MANIFEST.id) return null
  const results = MANIFEST.testIds.map(testId => {
    let passed = false
    try { passed = runOne(testId) === true } catch { passed = false }
    return Object.freeze({ testId, status: passed ? 'passed' : 'failed', assertions: 1 })
  })
  const verdict = verifyProjectTestResult({ manifestHash: oracleHash, results }, MANIFEST)
  const source = MANIFEST.testIds.map((testId, index) => Object.freeze({ testId, ordinal: index + 1 }))
  const artifact = results.map(row => Object.freeze({ ...row }))
  const fixture = Object.freeze({ fixtureId: `mse-tests-${hash(artifact).slice(0, 24)}`,
    oracleHash, source: Object.freeze(source), artifact: Object.freeze(artifact) })
  return Object.freeze({ manifestId, version: MANIFEST.version, oracleHash,
    status: verdict.verdict, reason: verdict.reason, fixture })
}
