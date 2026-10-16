/** Registered synchronous argument-contract guards; no model output or executable rule is accepted. */
const ID = Object.freeze({ test: value => typeof value === 'string' && /^[a-z][a-z0-9._:-]{0,63}$/u.test(value) })
const KEY = Object.freeze({ test: value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u.test(value) })
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype

export const GUARD_MODES = Object.freeze(['observe', 'shadow', 'enforce', 'suspended'])

export function validateGuardTemplate(template) {
  if (!plain(template) || Object.keys(template).sort().join(',') !== 'allowedKeys,guardId,mode,requiredKeys,toolName,version'
    || !ID.test(template.guardId) || !ID.test(template.toolName) || !Number.isSafeInteger(template.version)
    || template.version < 1 || !GUARD_MODES.includes(template.mode)
    || !Array.isArray(template.requiredKeys) || !Array.isArray(template.allowedKeys)
    || template.requiredKeys.length > 64 || template.allowedKeys.length > 128
    || !template.requiredKeys.every(key => KEY.test(key)) || !template.allowedKeys.every(key => KEY.test(key))
    || template.requiredKeys.some(key => !template.allowedKeys.includes(key))) return null
  return Object.freeze({ ...template, requiredKeys: Object.freeze([...template.requiredKeys]),
    allowedKeys: Object.freeze([...template.allowedKeys]) })
}

/** Pure check; only a validated registered template can produce a denial reason. */
export function checkGuard(template, exec) {
  const rule = validateGuardTemplate(template)
  if (!rule || rule.mode === 'observe' || rule.mode === 'suspended' || !plain(exec)
    || exec.name !== rule.toolName) return Object.freeze({ matched: false, denyReason: undefined })
  const args = exec.arguments
  if (!plain(args)) return Object.freeze({ matched: true,
    denyReason: rule.mode === 'enforce' ? `MSE guard ${rule.guardId}: arguments must be an object` : undefined,
    code: 'arguments_not_object' })
  const keys = Object.keys(args)
  const missing = rule.requiredKeys.some(key => !Object.hasOwn(args, key))
  const extra = keys.some(key => !rule.allowedKeys.includes(key))
  const code = missing ? 'required_key_missing' : extra ? 'unexpected_key' : null
  return Object.freeze({ matched: code !== null,
    denyReason: code !== null && rule.mode === 'enforce' ? `MSE guard ${rule.guardId}: ${code}` : undefined,
    ...(code === null ? {} : { code }) })
}

export function createGuardFunction(template) {
  const rule = validateGuardTemplate(template)
  if (!rule) throw new TypeError('invalid_guard_template')
  return exec => checkGuard(rule, exec).denyReason
}
