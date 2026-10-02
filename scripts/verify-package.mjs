import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const filesUnder = directory => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)])

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
// `--dist <dir>` checks a delivery directory built with `pack.mjs --dist`, so one release can be
// verified in place without copying it into `dist/<version>` first.
const distFlag = process.argv.indexOf('--dist')
const dist = distFlag === -1 ? join(root, 'dist', pkg.version) : resolve(root, process.argv[distFlag + 1] ?? '')
const manifest = JSON.parse(readFileSync(join(dist, 'candidate-manifest.json'), 'utf8'))
const dshOnly = manifest.targets?.length === 1 && manifest.targets[0] === 'dsh'
assert.equal(manifest.artifacts.length, dshOnly ? 1 : 2)
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
  // The frozen source archive must cover the whole listed source set and add nothing
  // else — no Mac metadata, no unlisted file that a standard extractor would write.
  const sourceStage = mkdtempSync(join(tmpdir(), 'mse-source-archive-'))
  try {
    const sourceReport = JSON.parse(readFileSync(join(dist, 'source-archive.json'), 'utf8'))
    const archivePath = join(dist, sourceReport.archive.name)
    assert.equal(sha(archivePath), sourceReport.archive.sha256, 'source archive changed after it was verified')
    assert.equal(sourceReport.portable, true)
    execFileSync('tar', ['-xzf', archivePath, '-C', sourceStage])
    for (const source of manifest.sources) {
      assert.equal(sha(join(sourceStage, source.path)), source.sha256, `source archive differs at ${source.path}`)
    }
    const listed = new Set(manifest.sources.map(source => source.path))
    const extra = filesUnder(sourceStage).map(file => relative(sourceStage, file)).filter(file => !listed.has(file))
    assert.deepEqual(extra, [], `source archive adds unlisted files: ${extra.slice(0, 5).join(', ')}`)
    for (const artifact of sourceReport.runtimeArtifacts) {
      assert.equal(artifact.sha256, manifest.artifacts.find(row => row.name === artifact.name)?.sha256, artifact.name)
    }
  } finally { rmSync(sourceStage, { recursive: true, force: true }) }

  for (const path of manifest.sources.filter(x => x.path.startsWith('src/') && x.path.endsWith('.mjs')).map(x => x.path)) {
    const expected = manifest.sources.find(x => x.path === path).sha256
    assert.equal(sha(join(stage, 'package', path)), expected)
    if (!dshOnly) assert.equal(sha(join(stage, 'mse-learning/runtime', path)), expected)
  }
  assert.equal(JSON.parse(readFileSync(join(stage, 'package/package.json'), 'utf8')).version, manifest.version)
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
  const method = invoke('record', { eventId: 'packed-method', source: 'host_proposal', kind: 'method', methodId: 'preserve-null-v1' })
  assert.equal(invoke('evaluateRegistered', { lessonId: method.id }).decision, 'accepted')
  assert.equal(invoke('checkArtifact', { lessonId: method.id, source: [{ id: 'a', value: null }], artifact: [{ id: 'a', value: 0 }] }).status, 'fail')
  const packet = invoke('exportLesson', { lessonId: method.id }).packet
  assert.equal(packet.schema, 'mse-method-v1')
  const exported = execFileSync(process.execPath, ['--input-type=module', '-e',
    'const api = await import(process.argv[1]); if (typeof api.LearningEngine !== "function") process.exit(1)',
    pathToFileURL(join(stage, 'package/src/index.mjs')).href], { cwd: stage, env: clean, encoding: 'utf8', timeout: 5000 })
  assert.equal(exported, '')
  // The package root must stay a portable SDK: a process with no DSH peer installed imports it
  // and gets the core, and the Host adapter is only pulled in when a Host calls apply().
  const rootImport = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const api = await import(process.argv[1])
     if (typeof api.LearningEngine !== 'function' || typeof api.guardedAction !== 'function') process.exit(1)
     if (api.name !== 'mse-learning' || typeof api.apply !== 'function') process.exit(1)
     const imported = Object.keys(api)
     if (imported.some(key => key.startsWith('createHarnessBridge'))) process.exit(1)`,
    pathToFileURL(join(stage, 'package/src/root.mjs')).href], { cwd: stage, env: clean, encoding: 'utf8', timeout: 5000 })
  assert.equal(rootImport, '')
  const lazyAdapter = await import(pathToFileURL(join(stage, 'package/src/root.mjs')).href).then(
    () => null,
    error => error)
  assert.equal(lazyAdapter, null, 'importing the package root must not need a DSH peer')
  const adapterModule = await import(pathToFileURL(join(stage, 'package/adapters/dsh/index.mjs')).href).then(
    () => 'loaded', error => error?.code ?? 'failed')
  assert.equal(adapterModule, 'ERR_MODULE_NOT_FOUND',
    'the packaged Host adapter is expected to need Host packages that this clean stage does not have')
  console.log(JSON.stringify({ ok: true, sourcesMatchManifest: true, artifactsMatchManifest: true,
    sourceArchiveCoverage: true,
    hermesArtifactIncluded: !dshOnly, hermesAndSdkUseIdenticalCore: dshOnly ? null : true,
    genericClientNeedsNoHostDependencies: true, cleanProcessRecall: true, registeredEvaluationAndChecker: true, portableMethods: true,
    recallBytes: recalled.bytes, artifactBytes: manifest.artifacts.map(x => x.bytes) }))
} finally { rmSync(stage, { recursive: true, force: true }) }
