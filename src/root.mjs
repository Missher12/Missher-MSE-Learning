/**
 * Package root: the portable SDK plus this bundle's Host plugin.
 *
 * The generic core stays importable from the package root with no DSH dependency at all —
 * `export *` below is the whole surface of `./index.mjs`, which imports nothing outside
 * Node's standard library. A DSH Host that loads this package as a bundle row gets `apply`,
 * and only then is `adapters/dsh/index.mjs` (which does import Host packages) loaded.
 *
 * The settings schema is the one thing that must exist *before* `apply` runs: Cordis reads the
 * validator off the plugin object it is handed, and the host Settings service refuses to serve
 * a namespace without one. Resolving it with a dynamic import keeps both properties true at
 * once — a process that has no DSH packages simply ends up without `Config`, and it must be
 * able to reach that state without an import error, while a process that does have them must
 * never be handed a plugin whose schema silently failed to load. Only "the schema's own
 * dependencies are not installed" is tolerated; an error raised *inside* the schema module is
 * rethrown, because a broken schema is a defect, not a portable-SDK use case.
 */
export * from './index.mjs'

/**
 * Exactly one failure is tolerated: the optional settings-schema dependency is not installed.
 *
 * Nothing else may be swallowed here. A `@deepseek-ai/schemastery` that *is* installed but
 * whose exports moved, a syntax error in this package, or a missing dependency of the schema
 * module are all real breakage, and a portable SDK that hid them would report "no settings"
 * where a Host needs a defect. So the error is matched on the missing specifier itself, not on
 * the code alone, and anything unrecognised propagates.
 */
const OPTIONAL_DEPENDENCY = '@deepseek-ai/schemastery'
const MISSING_SPECIFIER = /Cannot find (?:package|module) '([^']+)'/u
function isAbsentOptionalDependency(error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'MODULE_NOT_FOUND') return false
  const missing = MISSING_SPECIFIER.exec(String(error?.message ?? ''))?.[1]
  return missing === OPTIONAL_DEPENDENCY || missing?.startsWith(`${OPTIONAL_DEPENDENCY}/`) === true
}

let dshConfig
try {
  dshConfig = (await import('../adapters/dsh/config.mjs')).Config
} catch (error) {
  if (!isAbsentOptionalDependency(error)) throw error
  dshConfig = undefined
}

/** Present only when this package is loaded next to a DSH installation. */
export const Config = dshConfig

export const name = 'mse-learning'
export const inject = ['agents', 'tools', 'llm', 'dshHomePath']

/** Cordis entry: load the DSH adapter only when a Host actually mounts this plugin. */
export async function apply(ctx, config) {
  if (dshConfig === undefined) {
    // A Host mounted this plugin, so the settings schema must have been resolvable. Running
    // without it would mean the settings page could never appear and every save would be
    // refused by an absent namespace — a silent, permanent half-install. Fail loudly instead.
    throw new Error('mse-learning: the DSH settings schema could not be loaded; @deepseek-ai/schemastery is required in a DSH host')
  }
  const adapter = await import('../adapters/dsh/index.mjs')
  return adapter.apply(ctx, config)
}

export default { name, inject, apply, Config: dshConfig }
