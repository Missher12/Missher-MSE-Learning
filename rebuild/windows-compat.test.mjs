import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { pathInside } from './engine.mjs'
import { runDevelopmentChecker } from './checker.mjs'

const storageUrl = new URL('./storage.mjs', import.meta.url).href
const memoryUrl = new URL('./memory.mjs', import.meta.url).href
const dshUrl = new URL('./dsh.mjs', import.meta.url).href

// Exercise the actual store against real files, with the documented Windows limitations at
// the OS boundary. This is a portability regression, not a claim of a physical Windows run.
function windowsStorage(body) {
  const script = `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    const parent = fs.mkdtempSync(join(tmpdir(), 'mse-windows-'))
    const root = join(parent, '学习 data')
    const actual = { ...fs }
    const operations = []
    Object.defineProperty(process, 'platform', { value: 'win32' })
    Object.defineProperty(process, 'getuid', { value: undefined })
    fs.openSync = (path, ...args) => {
      let stat
      try { stat = actual.lstatSync(path) } catch {}
      if (stat?.isDirectory()) throw Object.assign(new Error('Windows directory handle unavailable'), { code: 'EPERM' })
      return actual.openSync(path, ...args)
    }
    fs.fchmodSync = () => { throw Object.assign(new Error('Windows has no POSIX mode'), { code: 'ENOSYS' }) }
    fs.fsyncSync = fd => { operations.push('file-sync'); return actual.fsyncSync(fd) }
    fs.renameSync = (...args) => { operations.push('rename'); return actual.renameSync(...args) }
    syncBuiltinESMExports()
    const { MemoryStore, createDoc } = await import(${JSON.stringify(memoryUrl)})
    const { commitMemoryFile, writeExclusiveMemorySnapshot } = await import(${JSON.stringify(storageUrl)})
    try { ${body} } finally { actual.rmSync(parent, { recursive: true, force: true }) }
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 10000 })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 0, child.stderr || child.stdout)
}

test('Windows store opens existing data without POSIX UID/mode or directory handles', () => {
  windowsStorage(`
    actual.mkdirSync(root, { mode: 0o755 })
    const doc = createDoc()
    doc.privateSentinel = { label: '原有学习数据', values: [1, 2, 3] }
    const path = join(root, 'memory-v1.json')
    actual.writeFileSync(path, JSON.stringify(doc))
    const before = actual.readFileSync(path)
    const store = new MemoryStore({ stateRoot: root })
    assert.deepEqual(store.read().privateSentinel, doc.privateSentinel)
    assert.deepEqual(actual.readFileSync(path), before, 'status/read must not rewrite data')
    store.transaction(next => { next.controls.userPaused = true; return true })
    const reopened = new MemoryStore({ stateRoot: root }).read()
    assert.equal(reopened.controls.userPaused, true)
    assert.deepEqual(reopened.privateSentinel, doc.privateSentinel)
    assert.equal(store.lastCommitDurability, 'confirmed')
    assert.deepEqual(operations, ['file-sync', 'rename', 'file-sync'])
    assert.deepEqual(actual.readdirSync(root), ['memory-v1.json'])
  `)
})

test('Windows first write and exclusive maintenance snapshot keep existing data intact', () => {
  windowsStorage(`
    const store = new MemoryStore({ stateRoot: root })
    assert.equal(store.read().entries.length, 0)
    assert.equal(actual.existsSync(root), false)
    store.transaction(doc => { doc.preserved = '原文'; return true })
    const before = actual.readFileSync(store.path)
    const snapshot = join(root, 'snapshot.json')
    assert.equal(writeExclusiveMemorySnapshot(snapshot, before).committed, true)
    assert.deepEqual(actual.readFileSync(snapshot), before)
    assert.throws(() => writeExclusiveMemorySnapshot(snapshot, 'overwrite'))
    assert.deepEqual(actual.readFileSync(snapshot), before)
    assert.deepEqual(actual.readFileSync(store.path), before)
  `)
})

test('Windows denied replacement preserves the original file and removes the temporary file', () => {
  windowsStorage(`
    actual.mkdirSync(root)
    const path = join(root, 'memory-v1.json')
    actual.writeFileSync(path, 'old data')
    assert.throws(() => commitMemoryFile(path, 'new data', {
      renameSync() { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }) },
    }), error => error.code === 'state_unavailable')
    assert.equal(actual.readFileSync(path, 'utf8'), 'old data')
    assert.deepEqual(actual.readdirSync(root), ['memory-v1.json'])
  `)
})

test('workspace containment accepts Windows drive/UNC paths but rejects siblings and other volumes', () => {
  for (const [candidate, roots, expected] of [
    ['C:\\Work\\插件\\config.json', ['c:\\work\\插件'], true],
    ['C:/Work/插件/config.json', ['C:\\Work\\插件'], true],
    ['\\\\?\\C:\\Work\\插件\\config.json', ['C:\\Work\\插件'], true],
    ['\\\\server\\share\\project\\file.json', ['\\\\server\\share\\project'], true],
    ['C:\\Work\\插件-other\\config.json', ['C:\\Work\\插件'], false],
    ['D:\\Work\\插件\\config.json', ['C:\\Work\\插件'], false],
    ['C:\\Work\\插件\\..\\outside.json', ['C:\\Work\\插件'], false],
    ['C:\\Users\\person\\AppData\\Local\\Temp\\x', ['C:\\Work\\插件'], false],
  ]) assert.equal(pathInside(candidate, roots), expected, candidate)
})

test('real foreground checker facts remain usable with a Windows cwd', () => {
  const result = runDevelopmentChecker({ command: 'node --test checks.test.mjs', result: {
    isError: false, value: { kind: 'foreground', cwd: 'C:\\Work\\插件', signal: null,
      timedOut: false, aborted: false, exitCode: 0,
      stdout: { text: '✔ assertion (1ms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 5\n', truncated: false },
      stderr: { text: '', truncated: false } },
  } })
  assert.equal(result.status, 'pass')
  assert.equal(result.evidence.passed, 1)
})

test('Windows native adapter admits registered workspaces and excludes external material before storage', () => {
  windowsStorage(String.raw`
    const win = (await import('node:path')).win32
    const workspace = 'C:\\项目\\插件 repo'
    const outside = 'C:\\Users\\person\\AppData\\Local\\Temp\\external.txt'
    const os = (await import('node:os')).default
    os.tmpdir = () => win.dirname(outside)
    fs.realpathSync = path => {
      if (path === '/tmp') return 'C:\\tmp'
      if (/^[A-Za-z]:/.test(path)) return win.normalize(path)
      return actual.realpathSync(path)
    }
    syncBuiltinESMExports()
    const { apply } = await import(${JSON.stringify(dshUrl)})
    const handlers = new Map()
    const ctx = {
      on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); return () => {} },
      effect() {}, provide() {}, get() {}, plugin() {}, reflect: { provide() {} },
      dshHomePath() { return root },
      workspaceRegistry: { list: () => [
        { path: workspace, sessionIds: ['win-session'] },
        { path: win.dirname(outside), sessionIds: ['scratch'] },
        { path: 'C:\\tmp', sessionIds: ['named-tmp-but-not-system-temp'] },
      ] },
      llm: { async * stream() { throw new Error('no live provider in compatibility check') } },
    }
    const api = apply(ctx, { wakeIntervalMs: 600000 })
    const session = { id: 'win-session', header: { cwd: workspace }, seq: 0, eventAt() {} }
    const step = async (text, turn) => {
      for (const fn of handlers.get('agent/pre-step') ?? []) await fn({ agent: { session },
        step: 1, turn, messages: [{ role: 'user', source: { kind: 'user' },
          content: [{ type: 'text', text }] }] }, async payload => ({ kind: 'enter', messages: payload.messages }))
    }
    try {
      await step('不对，插件版本应该读取实际加载信息。', 1)
      let doc = api.engine.store.read()
      assert.equal(doc.corrections.length, 1)
      assert.equal(api.status().storage.available, true)
      assert.equal(api.status().collection.workspaces, 2,
        'exclude the real Windows TEMP directory, not an unrelated C:\\tmp workspace')
      await step('不对，修改 JSON 配置应该先检查文件 "' + workspace + '\\config.json" 再定位语法错误。', 2)
      assert.equal(api.engine.store.read().corrections.length, 2,
        'quoted workspace paths with spaces stay usable: ' + JSON.stringify(api.status().collection))
      await step('不对，HTTP 错误应该先核对 https://example.com/status 再定位原因。', 3)
      assert.equal(api.engine.store.read().corrections.length, 3, 'a URL is not an external file path')
      const marker = 'WINDOWS_EXTERNAL_MUST_NOT_PERSIST'
      await step('不对，请读取 "' + outside + '" ' + marker, 4)
      doc = api.engine.store.read()
      assert.equal(doc.corrections.length, 3)
      assert.equal(JSON.stringify(doc).includes(marker), false)
      assert.equal(JSON.stringify(doc).includes('external.txt'), false)
    } finally { api.dispose() }
  `)
})

test('Windows post-replacement file flush failure reports an already committed document', () => {
  windowsStorage(`
    actual.mkdirSync(root)
    const path = join(root, 'memory-v1.json')
    actual.writeFileSync(path, 'old data')
    let syncs = 0
    assert.throws(() => commitMemoryFile(path, 'new data', {
      fsyncSync(fd) {
        if (++syncs === 2) throw Object.assign(new Error('flush failed'), { code: 'EIO' })
        return actual.fsyncSync(fd)
      },
    }), error => error.code === 'durability_unconfirmed' && error.committed === true)
    assert.equal(actual.readFileSync(path, 'utf8'), 'new data')
  `)
})
