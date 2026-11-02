import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { publicFiles } from './public-set.mjs'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
// `--dsh-only` remains a tolerated compatibility flag: unknown arguments are simply ignored, and a
// DSH candidate is the only thing this script builds now (the Hermes adapter exited the public tree).
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
// Respect the manager that invoked `run pack:local`; the DSH runtime ships pnpm without npm.
const managerCli = process.env.npm_execpath
const pnpm = managerCli && /(?:^|[/\\])pnpm\.[cm]?js$/u.test(managerCli)
const packArgs = pnpm ? ['--config.ignore-scripts=true', 'pack', '--json', '--pack-destination', dist]
  : ['pack', '--ignore-scripts', '--json', '--pack-destination', dist]
const packResult = JSON.parse(managerCli ? run(process.execPath, [managerCli, ...packArgs]) : run('npm', packArgs))
const packed = Array.isArray(packResult) ? packResult[0] : packResult
packed.filename = basename(packed.filename)

// The manifest's source list is the SAME public set the source archive carries (`public-set.mjs`), so
// the two artifacts can never disagree about what was published — and private material (`.probes/`,
// coordination notes, caches, local scratch) can no longer ride into a public manifest.
const sources = () => publicFiles(root).map(relative => ({
  path: relative, sha256: digest(join(root, relative)) }))
const artifacts = [packed.filename].map(name => ({ name, sha256: digest(join(dist, name)), bytes: statSync(join(dist, name)).size }))
const baseCommit = process.env.MSE_SOURCE_COMMIT ?? run('git', ['rev-parse', 'HEAD']).trim()
if (!/^[a-f0-9]{40}$/u.test(baseCommit)) throw new Error('invalid_source_commit')
const sourceDirty = run('git', ['status', '--porcelain']).trim().length > 0
const manifest = { version: pkg.version, targets: ['dsh'], generatedAt: new Date().toISOString(),
  baseCommit, sourceState: sourceDirty ? 'uncommitted candidate' : 'clean commit', artifacts, sources: sources() }
writeFileSync(join(dist, 'candidate-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ version: pkg.version, artifacts }, null, 2))
