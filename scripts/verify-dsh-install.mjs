// Use DSH's real package operation and pnpm in a fresh profile; never touch a daily profile.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
assert.ok(args.length === 3 || args.length === 4,
  'usage: node scripts/verify-dsh-install.mjs <npm-tarball> <host-node_modules> <pnpm-executable> [old-npm-tarball]')
const [archive, modules, pnpm, previous] = args.map(value => resolve(value))
const root = mkdtempSync(join(tmpdir(), 'mse-dsh-install-'))
try {
  const host = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-app-boot/lib/index.js')))
  const { runProfilePnpm } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh-plugin-manager/lib/types/operations.js')))
  const dir = join(root, 'profiles', 'test'), anchor = join(root, 'package.json')
  writeFileSync(anchor, '{"name":"mse-test-installation","private":true}\n')
  writeFileSync(join(root, '.npmrc'), '\n')
  host.initProfile(dir, [])
  const context = { profile: 'test', dir, home: root, cwd: root, installAnchor: anchor }
  const options = { command: pnpm, execution: 'service', outputBytes: 8192, idleTimeoutMs: 30000,
    env: { DSH_HOME: root, NPM_CONFIG_USERCONFIG: join(root, '.npmrc'),
      XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'), CI: '1' } }
  let previousRejected = null
  if (previous) {
    const oldDir = join(root, 'previous')
    mkdirSync(oldDir)
    execFileSync('tar', ['-xzf', previous, '-C', oldDir])
    const before = readFileSync(join(dir, 'package.json'), 'utf8')
    const rejected = await runProfilePnpm(context, ['add', join(oldDir, 'package'), '--offline', '--ignore-scripts'], options)
    assert.equal(rejected.exitCode, 1, 'old package must reproduce the refusal')
    assert.ok(rejected.incompatible?.some(item => item.name === '@missher/mse-learning'))
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), before)
    assert.equal(existsSync(join(dir, 'node_modules')), false)
    previousRejected = true
  }
  const installed = await runProfilePnpm(context, ['add', archive, '--offline', '--ignore-scripts',
    '--config.manage-package-manager-versions=false', '--config.auto-install-peers=false',
    '--config.strict-peer-dependencies=true', `--config.store-dir=${join(root, 'store')}`], options)
  assert.equal(installed.exitCode, 0, installed.output)
  assert.equal(installed.incompatible, undefined)
  const manifest = JSON.parse(readFileSync(join(dir, 'node_modules/@missher/dsh-mse-learning/package.json'), 'utf8'))
  const expected = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }))
  assert.equal(manifest.version, expected.version)
  assert.deepEqual(manifest.peerDependencies, expected.peerDependencies)
  assert.equal(host.evaluatePluginCompatibility(manifest), undefined)
  assert.equal(existsSync(join(dir, 'compatibility.json')), false, 'no version exemption')
  const profile = host.loadProfileDirectory('mse-test', dir, anchor)
  const entries = host.composeEntries(profile.layers.map(layer => layer.patches))
  assert.equal(entries.filter(row => row.id === 'mse-learning'
    && row.name === '@missher/dsh-mse-learning').length, 1)
  assert.ok(host.readProfileManifest('mse-test', dir).dsh.profile.bundles.includes('@missher/dsh-mse-learning'))
  console.log(JSON.stringify({ ok: true, layer: 'native DSH package operation and profile composition',
    runtimeVersion: host.getDshRuntimeVersion(), version: manifest.version, previousRejected,
    installed: true, compatibilityAccepted: true, bundleRegisteredOnce: true, exemptions: false, modelCalls: 0 }))
} finally { rmSync(root, { recursive: true, force: true }) }
