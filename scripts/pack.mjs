import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
const dist = resolve(root, 'dist')
mkdirSync(dist, { recursive: true })
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
    for (const name of ['__init__.py', 'bridge.py', 'plugin.yaml']) cpSync(join(root, 'adapters/hermes', name), join(plugin, name))
    cpSync(join(root, 'src'), join(plugin, 'runtime/src'), { recursive: true })
    for (const name of ['README.md', 'LICENSE']) cpSync(join(root, name), join(plugin, name))
    run('tar', ['-czf', join(dist, hermesName), '-C', stage, 'mse-learning'])
  } finally { rmSync(stage, { recursive: true, force: true }) }
}

function sources(dir, prefix = '') {
  return readdirSync(dir).sort().flatMap(name => {
    if (['node_modules', 'dist', '__pycache__'].includes(name) || name.endsWith('.pyc')) return []
    const path = join(dir, name), relative = prefix + name
    return statSync(path).isDirectory() ? sources(path, relative + '/') : [{ path: relative, sha256: digest(path) }]
  })
}
const artifacts = [packed.filename, ...(dshOnly ? [] : [hermesName])].map(name => ({ name, sha256: digest(join(dist, name)), bytes: statSync(join(dist, name)).size }))
const manifest = { version: pkg.version, targets: dshOnly ? ['dsh'] : ['dsh', 'hermes'], generatedAt: new Date().toISOString(),
  baseCommit: run('git', ['rev-parse', 'HEAD']).trim(), sourceState: 'uncommitted candidate', artifacts, sources: sources(root) }
writeFileSync(join(dist, 'candidate-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ version: pkg.version, artifacts }, null, 2))
