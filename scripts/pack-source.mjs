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
import { publicFiles } from './public-set.mjs'
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
    if (['node_modules', 'dist', '__pycache__', '.git', '.probes'].includes(entry.name)) continue
    if (entry.name.startsWith('._') || entry.name === '.DS_Store' || entry.name === '__MACOSX') {
      strays.push(join(directory, entry.name)); continue
    }
    if (entry.isDirectory()) walk(join(directory, entry.name))
  }
}
walk(root)
assert.deepEqual(strays, [], `source tree carries Mac metadata: ${strays.slice(0, 5).join(', ')}`)

// THE ARCHIVE IS BUILT FROM THE EXPLICIT PUBLIC SET, never from `tar … .`. An allowlist is the only
// shape that cannot leak: `.probes/` (private evidence), coordination notes and local scratch are
// simply not members, instead of being excluded by names someone remembered to list.
const published = publicFiles(root)
// The public set must still be the real source closure of THIS package: every packaged file, the
// package entry points, and the shipped test with its sanitized fixture are all members. This is a
// manifest-derived check, not a magic size that a stub could walk through.
const entryPoints = [pkg.main, ...Object.values(pkg.exports ?? {}).map(v => typeof v === 'string' ? v : v?.default)]
  .filter(Boolean).map(p => p.replace(/^\.\//u, ''))
for (const file of pkg.files) assert.ok(published.includes(file), `the public set is missing packaged file ${file}`)
for (const file of entryPoints) assert.ok(published.includes(file), `the public set is missing entry point ${file}`)
for (const file of ['rebuild/rebuild.test.mjs', 'tests/fixtures/native-a3-diagnostic.json', 'scripts/pack.mjs']) {
  assert.ok(published.includes(file), `the public set is missing required source ${file}`)
}
assert.equal(published.some(relative => relative.startsWith('.')), false,
  'the public set never carries a dot-directory')
execFileSync('tar', ['-czf', target, '-C', root, ...published],
{ env: { ...process.env, COPYFILE_DISABLE: '1' } })

const sourceCheck = assertPortable(target, { requireEntries: ['rebuild/root.mjs', 'package.json',
  'tests/fixtures/native-a3-diagnostic.json', 'scripts/pack-source.mjs'] })

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
  // The archive's own membership is reported, so a reviewer can see WHAT was published without
  // extracting it — and the manifest's list is generated from the same set.
  publicSet: { count: published.length,
    bytes: published.reduce((total, relative) => total + statSync(join(root, relative)).size, 0) },
  archive: { name, sha256: sha(target), bytes: statSync(target).size, ...sourceCheck },
  portable: true, runtimeArtifacts: runtime }
writeFileSync(join(dist, 'source-archive.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
