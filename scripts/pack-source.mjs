// Build and verify the portable source archive for the current version.
//
// Usage: node scripts/pack-source.mjs [--out <directory>]
//
// macOS tar can add AppleDouble (`._*`) members for files carrying extended attributes,
// so a passing archive must be *verified from its raw members*, not from a listing that
// the same tar may have already normalised. Verification uses Python's tarfile, which
// reports exactly what a standard extractor would write to disk.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const outIndex = process.argv.indexOf('--out')
const dist = outIndex === -1 ? join(root, 'dist', pkg.version) : process.argv[outIndex + 1]
assert.ok(dist, 'usage: node scripts/pack-source.mjs [--out <directory>]')
mkdirSync(dist, { recursive: true })
const name = `mse-learning-${pkg.version}-source.tar.gz`
const target = join(dist, name)
assert.ok(!existsSync(target) && !existsSync(join(dist, 'source-archive.json')),
  'candidate_exists: preserve prior source artifacts; choose a new output directory')

const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const MAC_METADATA = name => name.startsWith('/') || name.split('/').some(part =>
  part === '..' || part.startsWith('._') || part === '.DS_Store' || part === '__MACOSX')

/** Raw members, as a standard extractor sees them. */
const members = archive => JSON.parse(execFileSync('python3', ['-c',
  'import json,sys,tarfile\n'
  + 'with tarfile.open(sys.argv[1]) as t:\n'
  + '    rows=[{"name":m.name,"dir":m.isdir(),"link":m.issym() or m.islnk(),"size":m.size} for m in t.getmembers()]\n'
  + 'print(json.dumps(rows))\n', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))

const assertPortable = (archive, { requireEntries = [] } = {}) => {
  const rows = members(archive)
  const bad = rows.filter(row => MAC_METADATA(row.name)).map(row => row.name)
  assert.deepEqual(bad, [], `${archive} contains Mac metadata or unsafe paths: ${bad.slice(0, 5).join(', ')}`)
  assert.equal(rows.some(row => row.link && !row.dir), false, `${archive} contains links`)
  for (const required of requireEntries) {
    assert.ok(rows.some(row => row.name.replace(/^\.\//u, '') === required || row.name.endsWith(`/${required}`)),
      `${archive} is missing ${required}`)
  }
  return { entries: rows.length, files: rows.filter(row => !row.dir).length }
}

// Nothing that looks like leftover metadata may sit in the tree we are freezing.
const strays = []
const walk = directory => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', '__pycache__', '.git'].includes(entry.name)) continue
    if (entry.name.startsWith('._') || entry.name === '.DS_Store' || entry.name === '__MACOSX') {
      strays.push(join(directory, entry.name)); continue
    }
    if (entry.isDirectory()) walk(join(directory, entry.name))
  }
}
walk(root)
assert.deepEqual(strays, [], `source tree carries Mac metadata: ${strays.slice(0, 5).join(', ')}`)

execFileSync('tar', ['-czf', target,
  '--exclude', './dist', '--exclude', './node_modules', '--exclude', './.git',
  '--exclude', './__pycache__', '--exclude', '*.pyc',
  '--exclude', '*/._*', '--exclude', '._*', '--exclude', '*/.DS_Store', '--exclude', '.DS_Store',
  '--exclude', '__MACOSX', '.'],
{ cwd: root, env: { ...process.env, COPYFILE_DISABLE: '1' } })

const sourceCheck = assertPortable(target, { requireEntries: ['src/index.mjs', 'package.json', 'tests/upgrade.test.mjs', 'scripts/pack-source.mjs'] })

// The shipped runtime artifacts must be portable too.
const runtime = []
for (const artifact of existsSync(join(dist, 'candidate-manifest.json'))
  ? JSON.parse(readFileSync(join(dist, 'candidate-manifest.json'), 'utf8')).artifacts : []) {
  const path = join(dist, artifact.name)
  if (!existsSync(path)) continue
  const check = assertPortable(path)
  assert.equal(sha(path), artifact.sha256, `${artifact.name} changed after packing`)
  runtime.push({ name: artifact.name, sha256: artifact.sha256, bytes: statSync(path).size, ...check })
}

const report = { schema: 'mse-source-archive-v1', version: pkg.version, generatedAt: new Date().toISOString(),
  archive: { name, sha256: sha(target), bytes: statSync(target).size, ...sourceCheck },
  portable: true, runtimeArtifacts: runtime }
writeFileSync(join(dist, 'source-archive.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
