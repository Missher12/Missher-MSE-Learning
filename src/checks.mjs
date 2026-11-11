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
