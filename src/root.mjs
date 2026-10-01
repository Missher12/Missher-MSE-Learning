/**
 * Package root: the portable SDK plus this bundle's Host plugin.
 *
 * The generic core stays importable from the package root with no DSH dependency at all —
 * `export *` below is the whole surface of `./index.mjs`, which imports nothing outside
 * Node's standard library. A DSH Host that loads this package as a bundle row gets `apply`,
 * and only then is `adapters/dsh/index.mjs` (which does import Host packages) loaded.
 */
export * from './index.mjs'

export const name = 'mse-learning'
export const inject = ['agents', 'tools', 'llm', 'dshHomePath']

/** Cordis entry: load the DSH adapter only when a Host actually mounts this plugin. */
export async function apply(ctx, config) {
  const adapter = await import('../adapters/dsh/index.mjs')
  return adapter.apply(ctx, config)
}

export default { name, inject, apply }
