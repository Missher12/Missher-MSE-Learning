// Package manifest contracts: what makes the bundle discoverable and the core importable.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('every export subpath is a valid Node key', () => {
  for (const key of Object.keys(manifest.exports)) {
    assert.ok(key === '.' || key.startsWith('./'), `exports key ${JSON.stringify(key)} must be "." or start with "./"`)
  }
  assert.equal(manifest.exports['.'], './src/root.mjs')
  assert.equal(manifest.exports['./core'], './src/index.mjs')
  assert.equal(manifest.main, './src/root.mjs')
})

test('every export target exists in the package', () => {
  for (const [key, value] of Object.entries(manifest.exports)) {
    assert.equal(typeof value, 'string', `exports["${key}"] must be a plain path`)
    assert.equal(existsSync(join(root, value)), true, `exports["${key}"] → ${value} is missing`)
  }
  for (const entry of manifest.files) {
    assert.equal(existsSync(join(root, entry)), true, `files entry ${entry} is missing`)
  }
})

test('the browser half is declared for the web platform and reaches a real file', () => {
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(Array.isArray(manifest.dsh.client.inject))
  assert.equal(typeof manifest.exports['./client'], 'string')
  const client = readFileSync(join(root, manifest.exports['./client']), 'utf8')
  assert.match(client, /__ModuleLoader__\.load\(\{ id: '@missher\/dsh-mse-learning'/)
  assert.match(client, /key: BUNDLE/)
  assert.match(client, /plugins\.bundle\.config/)
})

test('the Host entry declares the package root, not a subpath', () => {
  const patch = readFileSync(join(root, manifest.dsh.bundle.patch), 'utf8')
  assert.match(patch, /name: "@missher\/dsh-mse-learning"/,
    'client-modules resolves a row through its owning package manifest, so the row names the package root')
  assert.equal(patch.includes('/adapters/dsh'), false)
})

test('the package root imports no Host package outside the lazy adapter mount', () => {
  const rootEntry = readFileSync(join(root, manifest.exports['.']), 'utf8')
  const coreEntry = readFileSync(join(root, manifest.exports['./core']), 'utf8')
  for (const [name, source] of [['src/root.mjs', rootEntry], ['src/index.mjs', coreEntry]]) {
    for (const line of source.split('\n')) {
      if (!line.includes('@deepseek-ai/')) continue
      assert.equal(/^\s*(import|export)[^'"]*from\s+'@deepseek-ai\//u.test(line), false,
        `${name} must not statically import a Host package: ${line.trim()}`)
    }
  }
  assert.match(rootEntry, /await import\('\.\.\/adapters\/dsh\/index\.mjs'\)/,
    'the Host adapter is loaded lazily, only when a Host calls apply')
  assert.match(coreEntry, /export class LearningEngine/u)
})

test('the typert manifest describes exactly the marked endpoints', () => {
  const source = readFileSync(join(root, 'adapters/dsh/typert.mjs'), 'utf8')
  assert.match(source, /package: '@missher\/dsh-mse-learning'/)
  const details = readFileSync(join(root, 'adapters/dsh/details.mjs'), 'utf8')
  const declared = /const METHODS = \[([^\]]*)\]/u.exec(source)
  assert.ok(declared, 'the manifest lists its methods')
  for (const method of ['overview', 'sessions', 'lessons', 'lesson', 'recall', 'diagnose']) {
    assert.ok(declared[1].includes(`'${method}'`), `manifest declares ${method}`)
    assert.ok(details.includes(`${method}(`), `service implements ${method}`)
  }
  assert.equal(/this\.sessions\s*=/u.test(details), false,
    'an instance field named sessions would shadow the sessions() endpoint')
})
