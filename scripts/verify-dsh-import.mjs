/**
 * Real-import smoke for the DSH adapter.
 *
 * `node --check` only proves the file parses. It cannot see a `ctx` referenced outside `apply`,
 * a helper called before its `const` is initialised, or a service read on the wrong object — all
 * of which fail only when the module is actually loaded and applied. This runs the adapter the
 * way the host does, against a minimal context, and touches no daily state.
 *
 * Usage: node scripts/verify-dsh-import.mjs <host-node_modules> [--out <json>]
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const modules = resolve(args[0] ?? '')
const outIndex = args.indexOf('--out')
const out = outIndex === -1 ? null : resolve(args[outIndex + 1])
assert.ok(existsSync(modules), `host node_modules exists: ${modules}`)

const results = []
const check = (name, value, detail) => {
  results.push({ name, ok: value === true, detail })
  assert.equal(value, true, `${name}${detail === undefined ? '' : ` (${detail})`}`)
}

/** The smallest context the adapter's apply() reads. Every accessor is recorded, not faked away. */
function fakeContext() {
  const registered = { hooks: [], effects: [], injections: [], listeners: [] }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get: () => undefined,
    on: (event, handler) => { registered.listeners.push(event); return () => {} },
    effect: fn => { registered.effects.push(fn); return fn() },
    inject: (names, fn) => { registered.injections.push(names); return { effect: () => {} } },
    plugin: () => {},
    provide: () => {},
    get dshHomePath() { return () => mkdtempSync(join(tmpdir(), 'mse-import-home-')) },
  }
  return { ctx, registered }
}

const work = mkdtempSync(join(tmpdir(), 'mse-dsh-import-'))
try {
  const stage = join(work, 'package')
  mkdirSync(stage, { recursive: true })
  for (const entry of ['src', 'adapters', 'package.json', 'cordis.patch.yml']) {
    cpSync(join(here, entry), join(stage, entry), { recursive: true })
  }
  symlinkSync(modules, join(stage, 'node_modules'), 'dir')

  const adapter = await import(new URL('./adapters/dsh/index.mjs', `file://${stage}/`).href)
  check('the adapter imports under real host dependencies', typeof adapter.apply === 'function'
    && typeof adapter.mseCommandDefinition === 'function')

  const { ctx, registered } = fakeContext()
  let failure = null
  try { adapter.apply(ctx, {}) } catch (error) { failure = error }
  check('apply() runs against a minimal host context without a ReferenceError', failure === null,
    failure === null ? null : `${failure.name}: ${failure.message}`)
  check('the lifecycle hooks are registered', registered.listeners.length > 0,
    registered.listeners.join(','))
  check('the service-driven recovery is registered through an injection',
    registered.injections.some(names => Array.isArray(names) && names.includes('sessionQuery')
      && names.includes('workspaceRegistry')),
    JSON.stringify(registered.injections))
  check('the command registration is registered through an injection',
    registered.injections.some(names => Array.isArray(names) && names.includes('commands')))

  const command = adapter.mseCommandDefinition({ recallStatus: () => ({ ok: true }), listLessons: () => [] })
  check('the /mse command definition still carries its argument declaration',
    typeof command.input?.hint === 'string' && command.input.hint.length > 0
    && typeof command.handler === 'function')
} catch (error) {
  results.push({ name: 'smoke', ok: false, detail: String(error?.stack ?? error).slice(0, 600) })
} finally {
  const passed = results.filter(row => row.ok).length
  const report = { checked: results.length, passed, failed: results.filter(row => !row.ok).map(row => row.name), results }
  if (out !== null) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2) + '\n') }
  console.log(JSON.stringify({ checked: report.checked, passed: report.passed, failed: report.failed,
    detail: results.find(row => !row.ok)?.detail ?? null }, null, 2))
  rmSync(work, { recursive: true, force: true })
}
process.exit(results.every(row => row.ok) ? 0 : 1)
