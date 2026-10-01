import { check } from './store.mjs'

const METHODS = Object.freeze(Object.fromEntries([
  { methodId: 'preserve-null-v1', version: 1, checkId: 'missing-values-v1',
    instruction: '核对来源与产物的记录标识一致，仅将来源未知的对应字段保留为空值，保留其他字段并重新核验。',
    applicability: 'matching_row_identity', exclusions: 'invalid_empty_duplicate_or_mismatched_rows' },
  { methodId: 'copy-source-date-v1', version: 1, checkId: 'source-dates-v1',
    instruction: '核对来源与产物的记录标识一致，仅将日期字段复制为来源的有效日期，来源为空时保留空值并重新核验。',
    applicability: 'matching_row_identity_valid_source_dates', exclusions: 'invalid_empty_duplicate_or_mismatched_rows' },
  { methodId: 'numeric-sort-v1', version: 1, checkId: 'numeric-order-v1',
    instruction: '仅对已确认要求升序的数值记录排序；核对来源与产物的标识和值一致，精确比较十进制数值，同值保留来源顺序。',
    applicability: 'explicit_ascending_order_matching_identity_and_values', exclusions: 'invalid_unknown_non_numeric_or_changed_values' },
].map(method => [method.methodId, Object.freeze(method)])))

export function getMethod(methodId) {
  check(typeof methodId === 'string' && Object.hasOwn(METHODS, methodId), 'unknown_method')
  return { ...METHODS[methodId] }
}
export function listMethods() { return Object.values(METHODS).map(method => ({ ...method })) }

const validString = (value, max) => typeof value === 'string' && value.length <= max && value.isWellFormed()
  && !/[\u0000-\u001f\u007f]/u.test(value)
function validRows(rows) {
  return Array.isArray(rows) && rows.length <= 1000 && rows.every(row => row !== null && typeof row === 'object'
    && Object.getPrototypeOf(row) === Object.prototype && Object.keys(row).length === 2
    && Object.hasOwn(row, 'id') && Object.hasOwn(row, 'value') && validString(row.id, 128) && row.id.length > 0
    && (row.value === null || typeof row.value === 'boolean' || validString(row.value, 256)
      || (typeof row.value === 'number' && Number.isFinite(row.value))))
    && new Set(rows.map(row => row.id)).size === rows.length
}
function validDate(value) {
  if (value === null) return true
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || value.startsWith('0000')) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

// Decimal strings stay exact, including integers beyond Number.MAX_SAFE_INTEGER.
// Already-rounded unsafe numeric integers cannot be repaired and are excluded.
function decimal(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) return null
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/u.exec(String(value))
  if (!match) return null
  const exponent = Number(match[4] ?? 0) - (match[3]?.length ?? 0)
  if (Math.abs(exponent) > 512) return null
  return { coefficient: BigInt(`${match[1]}${match[2]}${match[3] ?? ''}`), exponent }
}
function compareDecimal(a, b) {
  const exponent = Math.min(a.exponent, b.exponent)
  const left = a.coefficient * 10n ** BigInt(a.exponent - exponent)
  const right = b.coefficient * 10n ** BigInt(b.exponent - exponent)
  return left < right ? -1 : left > right ? 1 : 0
}
const sortedRows = source => source.map((row, index) => ({ row, index, number: decimal(row.value) }))
  .sort((a, b) => compareDecimal(a.number, b.number) || a.index - b.index).map(x => x.row)

/** Only bounded counts and reason codes leave the checker, never source values. */
export function checkArtifact({ methodId, source, artifact } = {}) {
  const method = getMethod(methodId)
  const result = (status, reason, checked = 0, violations = 0) => ({ status, checkId: method.checkId, reason, checked, violations })
  if (!validRows(source) || !validRows(artifact)) return result('not_applicable', 'invalid_rows')
  if (source.length === 0 || artifact.length === 0) return result('not_applicable', 'empty_rows')
  const target = new Map(artifact.map(row => [row.id, row.value]))
  if (source.length !== artifact.length || source.some(row => !target.has(row.id))) return result('not_applicable', 'identity_mismatch')
  if (methodId === 'copy-source-date-v1' && source.some(row => !validDate(row.value))) return result('not_applicable', 'invalid_source_date')
  if (methodId === 'numeric-sort-v1') {
    if (source.some(row => decimal(row.value) === null)) return result('not_applicable', 'invalid_number')
    if (source.some(row => !Object.is(row.value, target.get(row.id)))) return result('not_applicable', 'source_value_changed')
    const ordered = sortedRows(source)
    const violations = artifact.filter((row, index) => row.id !== ordered[index].id).length
    return result(violations ? 'fail' : 'pass', violations ? 'numeric_order_changed' : 'matched', source.length, violations)
  }
  const relevant = methodId === 'preserve-null-v1' ? source.filter(row => row.value === null) : source
  if (relevant.length === 0) return result('not_applicable', 'no_unknown_values')
  const violations = relevant.filter(row => !Object.is(row.value, target.get(row.id))).length
  return result(violations ? 'fail' : 'pass', violations ? methodId === 'preserve-null-v1'
    ? 'missing_value_filled' : 'source_date_changed' : 'matched', relevant.length, violations)
}

/** A pure projection, never permission to write a file or change the task's requested sort order. */
export function applyMethod({ methodId, source, artifact } = {}) {
  const report = checkArtifact({ methodId, source, artifact })
  if (report.status === 'not_applicable') return { status: 'not_applicable', artifact: null }
  if (report.status === 'pass') return { status: 'unchanged', artifact: artifact.map(row => ({ ...row })) }
  const original = new Map(source.map(row => [row.id, row.value]))
  const rows = methodId === 'numeric-sort-v1' ? sortedRows(source).map(row => ({ ...row }))
    : artifact.map(row => ({ ...row, value: methodId === 'copy-source-date-v1' || original.get(row.id) === null
      ? original.get(row.id) : row.value }))
  return { status: 'applied', artifact: rows }
}

function fixtureRows(values, prefix = 'r') { return values.map((value, index) => ({ id: `${prefix}${index}`, value })) }
function fixtures(methodId) {
  const dates = methodId === 'copy-source-date-v1', numeric = methodId === 'numeric-sort-v1'
  const failures = numeric ? [
    ['10', '2', '1'], [-10, -2, -20], ['9007199254740993', '9007199254740992', '1'], ['0.10000000000000002', '0.1', '0'],
    ['1e-10', '1e-11', '-1e-10'], ['1.0', '1', '0'], ['-0', '0', '-1'], ['9.99', '10', '-0.001'],
    [10, 2, 1], ['123456789012345678901234567890', '123456789012345678901234567889', '0'],
    ['0.00000000000000000002', '0.00000000000000000001', '0'], ['2e2', '199.99', '1'],
  ].map((values, index) => ({ kind: 'failure', family: index % 2 ? 'signed_decimal' : 'integer_precision',
    source: fixtureRows(values), artifact: fixtureRows(values) }))
    : Array.from({ length: 12 }, (_, index) => {
      const day = String(index + 1).padStart(2, '0')
      return { kind: 'failure', family: index % 2 ? 'nullable_values' : 'source_values',
        source: fixtureRows(dates ? [index % 2 ? null : `2024-02-${day}`, '2000-02-29'] : [null, index % 2 ? null : false]),
        artifact: fixtureRows(dates ? ['2001-01-01', index % 2 ? null : 'not-a-date'] : [index % 2 ? 0 : 'unknown', index % 2 ? false : 42]).reverse() }
    })
  const correct = Array.from({ length: 6 }, (_, index) => {
    const values = numeric ? [-index - 1, '0', String(index + 1)] : dates ? [null, '2024-02-29'] : [null, index]
    return { kind: 'correct', family: 'already_correct', source: fixtureRows(values), artifact: fixtureRows(values) }
  })
  const unrelated = [
    { source: [], artifact: [] },
    { source: fixtureRows([null]), artifact: fixtureRows([null], 'different') },
    { source: fixtureRows([null]), artifact: [{ id: 'r0', value: null }, { id: 'r0', value: null }] },
    { source: [{ id: 'r0', value: null, extra: true }], artifact: fixtureRows([null]) },
    { source: fixtureRows([dates ? '2023-02-29' : numeric ? 'NaN' : 10]), artifact: fixtureRows([dates ? '2024-02-29' : numeric ? 'NaN' : 20]) },
    { source: fixtureRows([dates ? '0000-01-01' : numeric ? Number.MAX_SAFE_INTEGER + 1 : false]), artifact: fixtureRows([null]) },
  ].map(item => ({ ...item, kind: 'non_applicable', family: 'excluded_inputs' }))
  return [...failures, ...correct, ...unrelated]
}

/** Fixed algorithm regressions, not independent real-agent causal evidence; no proposer reads fixtures. */
export function registeredTrials(methodId) {
  getMethod(methodId)
  return fixtures(methodId).map((fixture, index) => {
    const sourceBefore = JSON.stringify(fixture.source), artifactBefore = JSON.stringify(fixture.artifact)
    const baseline = checkArtifact({ methodId, ...fixture })
    const applied = applyMethod({ methodId, ...fixture })
    const artifact = applied.artifact ?? fixture.artifact
    const candidate = checkArtifact({ methodId, source: fixture.source, artifact })
    const unchanged = JSON.stringify(artifact) === artifactBefore
    const original = new Map(fixture.source.map(row => [row.id, row.value]))
    const scopeIntact = methodId === 'numeric-sort-v1'
      ? artifact.every(row => Object.is(row.value, original.get(row.id)))
      : artifact.every((row, i) => row.id === fixture.artifact[i]?.id
        && (methodId !== 'preserve-null-v1' || original.get(row.id) === null || Object.is(row.value, fixture.artifact[i]?.value)))
    const preserved = fixture.kind === 'failure' || unchanged
    return { caseId: `${methodId}.case.${index}`, family: fixture.family, split: index % 3 === 0 ? 'holdout' : 'development',
      baseline: { passed: fixture.kind === 'non_applicable' ? baseline.status === 'not_applicable' : baseline.status === 'pass', tokens: 0 },
      candidate: { passed: fixture.kind === 'non_applicable' ? candidate.status === 'not_applicable' && unchanged : candidate.status === 'pass', tokens: 0 },
      guardPassed: sourceBefore === JSON.stringify(fixture.source) && artifactBefore === JSON.stringify(fixture.artifact)
        && preserved && (fixture.kind === 'non_applicable' || scopeIntact) }
  })
}
