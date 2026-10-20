import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { publicFiles } from './public-set.mjs'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const dshOnly = process.argv.includes('--dsh-only')
if (!dshOnly && !readFileSync(join(root, 'adapters/hermes/plugin.yaml'), 'utf8').includes(`version: "${pkg.version}"`)) {
  throw new Error('Hermes has an independent version; use --dsh-only for this DSH candidate')
}
// `--dist <dir>` lets one release build into its own delivery directory without touching an
// earlier candidate. The default stays `dist/<version>`.
const distFlag = process.argv.indexOf('--dist')
const dist = distFlag === -1 ? resolve(root, 'dist', pkg.version) : resolve(root, process.argv[distFlag + 1] ?? '')
mkdirSync(dist, { recursive: true })
if (readdirSync(dist).some(name => name.endsWith('.tgz') || name.endsWith('.tar.gz') || name === 'candidate-manifest.json')) {
  throw new Error('candidate_exists: preserve prior artifacts; build from a fresh isolated source copy')
}
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
  env: { ...process.env, COPYFILE_DISABLE: '1' } })
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dist]))[0]
const hermesName = `mse-learning-hermes-${pkg.version}.tar.gz`
if (!dshOnly) {
  const stage = mkdtempSync(join(tmpdir(), 'mse-pack-'))
  try {
    const plugin = join(stage, 'mse-learning')
    mkdirSync(join(plugin, 'runtime'), { recursive: true })
    for (const name of ['__init__.py', 'bridge.py', 'guards.py', 'driver.py', 'plan.py', 'plugin.yaml']) cpSync(join(root, 'adapters/hermes', name), join(plugin, name))
    cpSync(join(root, 'src'), join(plugin, 'runtime/src'), { recursive: true })
    // Preserve every local document/image linked by either public README; exclude maintainer records.
    mkdirSync(join(plugin, 'docs/images'), { recursive: true })
    for (const name of ['README.md', 'README.en.md', 'VALIDATION.md', 'LICENSE']) cpSync(join(root, name), join(plugin, name))
    for (const name of ['AUTONOMY_0.10.0.md', 'AUTONOMY_0.11.0.md', 'AUTONOMY_0.11.1.md', 'AUTONOMY_0.12.0.md', 'ADAPTER_PROTOCOL.md', 'BEHAVIOR.zh.md', 'DURABLE_SETTLEMENT_OUTBOX.md', 'RECALL_2026-09-30.md', 'RRSI_RESEARCH_2026-09-30.md', 'LIFECYCLE_2026-10-01.md']) cpSync(join(root, 'docs', name), join(plugin, 'docs', name))
    cpSync(join(root, 'docs/images/en-normal.png'), join(plugin, 'docs/images/en-normal.png'))
    run('tar', ['-czf', join(dist, hermesName), '-C', stage, 'mse-learning'])
  } finally { rmSync(stage, { recursive: true, force: true }) }
}

// The manifest's source list is the SAME public set the source archive carries (`public-set.mjs`), so
// the two artifacts can never disagree about what was published — and private material (`.probes/`,
// coordination notes, caches, local scratch) can no longer ride into a public manifest.
const sources = () => publicFiles(root).map(relative => ({
  path: relative, sha256: digest(join(root, relative)) }))
const artifacts = [packed.filename, ...(dshOnly ? [] : [hermesName])].map(name => ({ name, sha256: digest(join(dist, name)), bytes: statSync(join(dist, name)).size }))
const baseCommit = process.env.MSE_SOURCE_COMMIT ?? run('git', ['rev-parse', 'HEAD']).trim()
if (!/^[a-f0-9]{40}$/u.test(baseCommit)) throw new Error('invalid_source_commit')
const manifest = { version: pkg.version, targets: dshOnly ? ['dsh'] : ['dsh', 'hermes'], generatedAt: new Date().toISOString(),
  baseCommit, sourceState: 'uncommitted candidate', artifacts, sources: sources() }
writeFileSync(join(dist, 'candidate-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ version: pkg.version, artifacts }, null, 2))
