/**
 * Package root of the rebuilt slim bundle: plugin entry + settings schema, portable-core first.
 *
 * Same contract as the released root: Cordis reads `name`/`inject`/`Config` off the plugin
 * object before `apply` runs; the adapter loads only when a Host actually mounts it. A process
 * without DSH packages can still import this module (no settings schema, no adapter).
 */
export { RebuildEngine } from './engine.mjs'
export { MemoryStore, importOldLessons } from './memory.mjs'
export { runChecker, CHECKERS } from './checker.mjs'

const OPTIONAL_DEPENDENCY = '@deepseek-ai/schemastery'
const MISSING_SPECIFIER = /Cannot find (?:package|module) '([^']+)'/u
function isAbsentOptionalDependency(error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'MODULE_NOT_FOUND') return false
  const missing = MISSING_SPECIFIER.exec(String(error?.message ?? ''))?.[1]
  return missing === OPTIONAL_DEPENDENCY || missing?.startsWith(`${OPTIONAL_DEPENDENCY}/`) === true
}

let dshConfig
try {
  dshConfig = (await import('./config.mjs')).Config
} catch (error) {
  if (!isAbsentOptionalDependency(error)) throw error
  dshConfig = undefined
}

export const Config = dshConfig

export const name = 'mse-learning'
// MSE16: workspaceRegistry MUST be declared here — this root object is what the Cordis loader
// reads `inject` off BEFORE apply runs, and in the sandboxed host the inject list is the ONLY
// service entry (anything else throws `cannot get property "workspaceRegistry" without inject`,
// which is exactly how frozen-15 died on the real host).
export const inject = ['agents', 'tools', 'llm', 'dshHomePath', 'workspaceRegistry']

export async function apply(ctx, config) {
  if (dshConfig === undefined) {
    throw new Error('mse-learning: the DSH settings schema could not be loaded; @deepseek-ai/schemastery is required in a DSH host')
  }
  const adapter = await import('./dsh.mjs')
  adapter.apply(ctx, config)
  // Cordis runs an async plugin apply through its effect fiber: the RESOLVED value is collected
  // as a cleanup and anything that is neither a function nor null throws `Invalid effect`
  // (cordis/lib/index.js#safeCollect). The adapter already registers its dispose with the host
  // via ctx.effect, so the host-visible return value must be nothing at all — the internal API
  // object stays on the adapter for tests and the Remote wiring, never handed to Cordis.
}

export default { name, inject, apply, Config: dshConfig }
