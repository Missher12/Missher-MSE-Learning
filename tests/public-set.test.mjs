// The public file set is the ONE definition both artifacts are built from.
//
// The reviewed defect was concrete: the source archive tarred the whole workspace and the candidate
// manifest walked the tree with a short exclusion list, so private evidence (`.probes/`), coordination
// notes and local scratch were published. A publication needs an allowlist, and this suite locks the
// two properties that make the allowlist real: nothing private is a member, and both artifacts agree.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PUBLIC_DIRECTORIES, PUBLIC_FILES, isPublicPath, publicFiles } from '../scripts/public-set.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

test('nothing private is in the public set', () => {
  const files = publicFiles(root)
  assert.ok(files.length > 100, 'a real source tree is published')
  for (const silent of ['.probes', '.git', 'node_modules', 'dist', '__pycache__']) {
    assert.equal(files.some(relative => relative.split('/').includes(silent)), false,
      `${silent} must never be published`)
  }
  assert.equal(files.some(relative => relative.split('/').some(part => part.startsWith('.'))), false,
    'no hidden path is published')
  assert.equal(files.some(relative => relative.endsWith('.log') || relative.endsWith('.tmp')
    || relative.endsWith('.pyc')), false, 'no scratch, log or bytecode is published')
})

test('the pipeline files the runtime needs ARE public, including the new pass', () => {
  const files = publicFiles(root)
  for (const required of ['src/index.mjs', 'src/cli.mjs', 'adapters/hermes/plan.py',
    'adapters/hermes/bridge.py', 'adapters/hermes/driver.py', 'adapters/dsh/auto.mjs',
    'scripts/pack.mjs', 'package.json']) {
    assert.ok(files.includes(required), `${required} must be published`)
  }
})

test('the rule is a whitelist: an unlisted root file is private even when it exists', () => {
  const stage = mkdtempSync(join(tmpdir(), 'public-set-'))
  try {
    mkdirSync(join(stage, 'src'))
    mkdirSync(join(stage, '.probes'))
    writeFileSync(join(stage, 'src', 'index.mjs'), 'export {}\n')
    writeFileSync(join(stage, 'package.json'), '{}\n')
    writeFileSync(join(stage, 'NOTES.md'), 'private\n')
    writeFileSync(join(stage, 'draft.log'), 'private\n')
    writeFileSync(join(stage, '.probes', 'evidence.json'), '{}\n')
    assert.deepEqual(publicFiles(stage), ['package.json', 'src/index.mjs'],
      'only the whitelisted files are published')
  } finally { rmSync(stage, { recursive: true, force: true }) }
})

test('every public directory is declared, so a new top-level directory is private by default', () => {
  const top = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
  for (const name of top) {
    if (['node_modules', 'dist'].includes(name)) continue
    assert.ok(PUBLIC_DIRECTORIES.includes(name) || publicFiles(root).every(f => !f.startsWith(`${name}/`)),
      `${name} is neither declared public nor excluded`)
  }
  assert.ok(PUBLIC_FILES.includes('package.json'))
  assert.equal(isPublicPath('.probes/stage4c/PROGRESS.md'), false)
  assert.equal(isPublicPath('src/index.mjs'), true)
})
