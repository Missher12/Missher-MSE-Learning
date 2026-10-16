import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const PACKAGE_FIELD_TYPES = Object.freeze({
  name: 'string', version: 'string', description: 'string', keywords: 'string_array', homepage: 'string',
  bugs: 'string_or_object', license: 'string', author: 'person', contributors: 'person_array',
  files: 'string_array', main: 'string', module: 'string', types: 'string', typings: 'string', browser: 'string_or_object',
  bin: 'string_or_string_map', scripts: 'string_map', config: 'object', dependencies: 'string_map',
  devDependencies: 'string_map', peerDependencies: 'string_map', optionalDependencies: 'string_map',
  bundledDependencies: 'string_array_or_boolean', bundleDependencies: 'string_array_or_boolean', engines: 'string_map',
  os: 'string_array', cpu: 'string_array', repository: 'string_or_object', private: 'boolean',
  publishConfig: 'object', workspaces: 'string_array_or_object', packageManager: 'string',
  sideEffects: 'boolean_or_string_array', exports: 'any_json', imports: 'object', type: 'string',
  funding: 'string_or_object_or_array', directories: 'object', man: 'string_or_string_array', preferGlobal: 'boolean',
})
const manifestOracleHash = hash({ id: 'npm-package-json-shape-v1', version: 2, fields: PACKAGE_FIELD_TYPES })

export function verifyPackageJsonArtifact(content, filename) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 32_000) {
    return Object.freeze({ status: 'unknown', reason: 'artifact_unreadable', oracleHash: manifestOracleHash })
  }
  if (filename !== 'package.json') return Object.freeze({ status: 'unknown', reason: 'artifact_not_registered', oracleHash: manifestOracleHash })
  let manifest
  try { manifest = JSON.parse(content) } catch {
    return Object.freeze({ status: 'fail', reason: 'manifest_invalid_json', oracleHash: manifestOracleHash })
  }
  const verdict = verifyPackageManifest(manifest)
  return Object.freeze({ status: verdict.status, reason: verdict.reason, oracleHash: manifestOracleHash,
    violations: Object.freeze(verdict.violations) })
}

/** A privacy-minimized deterministic witness, not the project's raw package manifest. */
export function packageJsonReplayWitness(checked) {
  if (!checked || typeof checked.reason !== 'string') return null
  if (checked.status === 'pass') return '{"scripts":{"test":"node --test"},"extension":true}'
  if (checked.reason === 'manifest_invalid_json') return '{"scripts":'
  if (checked.reason === 'package_json_top_level_not_object') return '[]'
  const invalidByField = {
    name: 17, version: 17, description: 17, keywords: 17, homepage: 17, bugs: 17, license: 17,
    author: 17, contributors: [17], files: 17, main: 17, module: 17, types: 17, typings: 17,
    browser: 17, bin: 17, scripts: { test: 17 }, config: 17, dependencies: { alpha: 17 },
    devDependencies: { alpha: 17 }, peerDependencies: { alpha: 17 }, optionalDependencies: { alpha: 17 },
    bundledDependencies: 17, bundleDependencies: 17, engines: 17, os: 17, cpu: 17, repository: 17,
    private: 'yes', publishConfig: 17, workspaces: 17, packageManager: 17, sideEffects: 17,
    imports: 17, type: 17, funding: 17, directories: 17, man: 17, preferGlobal: 'yes',
  }
  const violations = checked.violations
  if (!Array.isArray(violations) || violations.length === 0 || violations.some(field => !Object.hasOwn(invalidByField, field))) return null
  const witness = {}
  for (const field of violations) witness[field] = invalidByField[field]
  return JSON.stringify(witness)
}

function verifyPackageManifest(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'fail', reason: 'package_json_top_level_not_object', violations: ['top_level'] }
  }
  const violations = []
  const isObject = item => item !== null && typeof item === 'object' && !Array.isArray(item)
  const hasType = (item, type) => {
    if (type === 'any_json') return true
    if (type === 'string') return typeof item === 'string'
    if (type === 'boolean') return typeof item === 'boolean'
    if (type === 'object') return isObject(item)
    if (type === 'person') return typeof item === 'string' || (isObject(item) && typeof item.name === 'string'
      && (item.email === undefined || typeof item.email === 'string') && (item.url === undefined || typeof item.url === 'string'))
    if (type === 'string_array') return Array.isArray(item) && item.every(x => typeof x === 'string')
    if (type === 'object_array') return Array.isArray(item) && item.every(isObject)
    if (type === 'person_array') return Array.isArray(item) && item.every(person => hasType(person, 'person'))
    if (type === 'string_map') return isObject(item) && Object.keys(item).length <= 2048
      && Object.values(item).every(x => typeof x === 'string')
    if (type === 'string_or_object') return typeof item === 'string' || isObject(item)
    if (type === 'string_or_string_map') return typeof item === 'string' || hasType(item, 'string_map')
    if (type === 'string_array_or_object') return hasType(item, 'string_array') || isObject(item)
    if (type === 'string_array_or_boolean') return typeof item === 'boolean' || hasType(item, 'string_array')
    if (type === 'boolean_or_string_array') return typeof item === 'boolean' || hasType(item, 'string_array')
    if (type === 'string_or_object_or_array') return typeof item === 'string' || isObject(item) || Array.isArray(item)
    if (type === 'string_or_string_array') return typeof item === 'string' || hasType(item, 'string_array')
    return false
  }
  for (const [field, type] of Object.entries(PACKAGE_FIELD_TYPES)) {
    if (Object.hasOwn(value, field) && !hasType(value[field], type)) violations.push(field)
  }
  return violations.length > 0
    ? { status: 'fail', reason: 'package_json_field_type_invalid', violations }
    : { status: 'pass', reason: 'package_json_structure_valid', violations: [] }
}

/** The package-pack replay gate: deterministic checker plus preserved control/source fields. */
export function verifyPackageJsonReplayOutput(fixture, output, role) {
  if (!fixture || !['bad', 'control'].includes(role) || typeof output !== 'string'
    || Buffer.byteLength(output, 'utf8') > 32_000) return Object.freeze({ status: 'unknown', reason: 'replay_output_invalid' })
  let input, artifact
  try { artifact = JSON.parse(output) } catch {
    return Object.freeze({ status: 'fail', reason: 'replay_output_invalid_json' })
  }
  const witness = fixture.source?.find(row => row?.field === 'witness')?.value
  if (typeof witness !== 'string') return Object.freeze({ status: 'unknown', reason: 'replay_witness_missing' })
  let inputValidJson = true
  try { input = JSON.parse(witness) } catch { inputValidJson = false }
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return Object.freeze({ status: 'fail', reason: 'replay_output_not_object' })
  }
  const checked = verifyPackageManifest(artifact)
  if (checked.status !== 'pass') return Object.freeze({ status: 'fail', reason: 'replay_output_checker_failed' })
  const recordedReason = fixture.artifact?.find(row => row?.field === 'reason')?.value
  if (recordedReason === 'manifest_invalid_json') {
    // Syntax failures have no fields to preserve. Require a non-empty, structurally valid object so
    // replacing the malformed witness with `{}` cannot count as a repair.
    if (inputValidJson || Object.keys(artifact).length === 0) {
      return Object.freeze({ status: 'fail', reason: 'replay_syntax_repair_incomplete' })
    }
  }
  if (role === 'control' && !isDeepStrictEqual(artifact, input)) {
    return Object.freeze({ status: 'fail', reason: 'replay_control_changed' })
  }
  if (role === 'bad' && input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const violations = fixture.artifact?.find(row => row?.field === 'violations')?.value
    const changed = new Set(Array.isArray(violations) ? violations : [])
    for (const key of changed) {
      if (!Object.hasOwn(artifact, key)) return Object.freeze({ status: 'fail', reason: 'replay_invalid_field_removed' })
    }
    for (const [key, value] of Object.entries(input)) {
      if (!changed.has(key) && !isDeepStrictEqual(artifact[key], value)) {
        return Object.freeze({ status: 'fail', reason: 'replay_unrelated_field_changed' })
      }
    }
  }
  if (!inputValidJson && recordedReason !== 'manifest_invalid_json') {
    return Object.freeze({ status: 'unknown', reason: 'replay_fixture_reason_mismatch' })
  }
  return Object.freeze({ status: 'pass', reason: 'replay_output_valid' })
}
