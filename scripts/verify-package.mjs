import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url)), dist = join(root, 'dist')
const manifest = JSON.parse(readFileSync(join(dist, 'candidate-manifest.json'), 'utf8'))
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const stage = mkdtempSync(join(tmpdir(), 'mse-package-'))
try {
  for (const source of manifest.sources) assert.equal(sha(join(root, source.path)), source.sha256, source.path)
  for (const artifact of manifest.artifacts) {
    const path = join(dist, artifact.name)
    assert.equal(sha(path), artifact.sha256, artifact.name)
    assert.equal(statSync(path).size, artifact.bytes)
    const files = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' }).trim().split('\n')
    assert.ok(files.every(name => !name.startsWith('/') && !name.split('/').includes('..')))
    assert.ok(files.every(name => !/node_modules|__pycache__|lessons-v1|\.env(?:\.|$)|\.pyc$/u.test(name)))
    execFileSync('tar', ['-xzf', path, '-C', stage])
  }
  for (const path of ['src/index.mjs', 'src/store.mjs', 'src/cli.mjs']) {
    const expected = manifest.sources.find(x => x.path === path).sha256
    assert.equal(sha(join(stage, 'package', path)), expected)
    assert.equal(sha(join(stage, 'mse-learning/runtime', path)), expected)
  }
  const clean = { PATH: dirname(process.execPath), LANG: 'C.UTF-8' }
  const config = { stateRoot: join(stage, 'state'), adapterId: 'generic' }
  const invoke = (op, input = {}) => JSON.parse(execFileSync(process.execPath, [join(stage, 'package/src/cli.mjs')], {
    cwd: stage, env: clean, input: JSON.stringify({ config, op, input }), encoding: 'utf8', timeout: 5000,
  }))
  const learned = invoke('prepare', { sessionId: 'first', turnId: '1', origin: 'user', prompt: '以后导出金额前先转换为数值，再按金额排序' })
  assert.equal(learned.bytes, 0)
  const recalled = invoke('prepare', { sessionId: 'second', turnId: '1', origin: 'user', prompt: '导出金额并排序' })
  assert.match(recalled.context, /转换为数值/)
  assert.ok(recalled.bytes <= 768)
  const exported = execFileSync(process.execPath, ['--input-type=module', '-e',
    'const api = await import(process.argv[1]); if (typeof api.LearningEngine !== "function") process.exit(1)',
    pathToFileURL(join(stage, 'package/src/index.mjs')).href], { cwd: stage, env: clean, encoding: 'utf8', timeout: 5000 })
  assert.equal(exported, '')
  console.log(JSON.stringify({ ok: true, sourcesMatchManifest: true, artifactsMatchManifest: true,
    hermesAndSdkUseIdenticalCore: true, genericClientNeedsNoHostDependencies: true, cleanProcessRecall: true,
    recallBytes: recalled.bytes, artifactBytes: manifest.artifacts.map(x => x.bytes) }))
} finally { rmSync(stage, { recursive: true, force: true }) }
