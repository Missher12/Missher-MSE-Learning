// Verify the current slim DSH package against its frozen source and clean-process API.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const flag = process.argv.indexOf('--dist')
const dist = flag < 0 ? join(root, 'dist', pkg.version) : resolve(process.argv[flag + 1])
const manifest = JSON.parse(readFileSync(join(dist, 'candidate-manifest.json'), 'utf8'))
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const filesUnder = path => readdirSync(path, { withFileTypes: true }).flatMap(row =>
  row.isDirectory() ? filesUnder(join(path, row.name)) : [join(path, row.name)])
assert.equal(manifest.version, pkg.version)
assert.deepEqual(manifest.targets, ['dsh'])
assert.equal(manifest.artifacts.length, 1)
for (const row of manifest.sources) assert.equal(sha(join(root, row.path)), row.sha256, row.path)
const artifact = manifest.artifacts[0]
const archive = join(dist, artifact.name)
assert.equal(sha(archive), artifact.sha256)
assert.equal(statSync(archive).size, artifact.bytes)
const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')
assert.ok(members.every(name => name.startsWith('package/') && !name.split('/').includes('..')
  && !/node_modules|__MACOSX|(?:^|\/)\._|lessons-v1|memory-v1|\.env(?:\.|$)/u.test(name)))
const stage = mkdtempSync(join(tmpdir(), 'mse-verify-slim-'))
try {
  execFileSync('tar', ['-xzf', archive, '-C', stage])
  const unpacked = join(stage, 'package')
  const packed = JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8'))
  assert.equal(packed.name, '@missher/dsh-mse-learning')
  assert.equal(packed.version, pkg.version)
  const allowed = new Set(['package.json', ...pkg.files])
  const runtimeFiles = filesUnder(unpacked).map(file => relative(unpacked, file))
  for (const file of runtimeFiles) {
    assert.ok(allowed.has(file), 'unlisted package member: ' + file)
    if (file !== 'package.json') assert.equal(sha(join(unpacked, file)), sha(join(root, file)), file)
  }
  for (const file of pkg.files) assert.ok(runtimeFiles.includes(file), 'missing member: ' + file)
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    const api = await import(process.argv[1])
    assert.equal(api.name, 'mse-learning')
    assert.equal(typeof api.apply, 'function')
    const engine = new api.RebuildEngine({ stateRoot: process.argv[2] })
    engine.recordCorrection({ text: '生成 JSON 配置时不要保留尾随逗号，先做 JSON.parse 检查', sessionId: 'A', turnId: '1' })
    const recalled = engine.prepare({ sessionId: 'B', turnId: '1', projectKey: 'other-project', prompt: '生成 JSON 配置并检查' })
    assert.ok(recalled.context.includes('不要保留尾随逗号'))
    assert.ok(recalled.bytes > 0 && recalled.bytes <= 768)
    engine.complete({ sessionId: 'B', turnId: '1', outcome: 'unknown', evidence: 'offline host occurrence' })
    assert.match(engine.store.read().turnFacts.at(-1).evidenceHash, /^[a-f0-9]{64}$/u)
    console.log(JSON.stringify({ crossProjectRecall: true, occurrenceEvidence: true, bytes: recalled.bytes }))
  `, pathToFileURL(join(unpacked, 'rebuild/root.mjs')).href, join(stage, 'state')], {
    cwd: stage, env: { PATH: dirname(process.execPath), LANG: 'C.UTF-8' }, encoding: 'utf8', timeout: 10000,
  })
  const source = JSON.parse(readFileSync(join(dist, 'source-archive.json'), 'utf8'))
  assert.equal(sha(join(dist, source.archive.name)), source.archive.sha256)
  assert.equal(source.portable, true)
  console.log(JSON.stringify({ ok: true, version: pkg.version, sourcesMatchManifest: true,
    packageWhitelist: true, sourceArchive: true, packageMembers: runtimeFiles.length,
    cleanProcess: JSON.parse(output) }))
} finally { rmSync(stage, { recursive: true, force: true }) }
