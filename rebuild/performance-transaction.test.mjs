import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from './dsh.mjs'
import { RebuildEngine } from './engine.mjs'
import { MAX_STORE_BYTES } from '../src/store.mjs'

const FIXED_NOW = 1_798_000_000_000
const RULE = '生成 JSON 配置时先校验字段和解析结果，避免不完整写入'
const PROMPT = '生成 JSON 配置时校验字段完整性，先检查解析结果再写入'
const ROUTE = { provider: 'benchmark-provider', model: 'benchmark-model', reasoningEffort: 'medium' }

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'mse-performance121-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function seededSnapshot(root) {
  const engine = new RebuildEngine({ stateRoot: root, now: () => FIXED_NOW })
  engine.recordCorrection({ text: RULE, sessionId: 'performance-test-seed', turnId: 'seed' })
  return readFileSync(engine.store.path)
}

function installSnapshot(root, bytes) {
  const fileRoot = join(root, 'state')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  mkdirSync(fileRoot, { mode: 0o700 })
  writeFileSync(join(fileRoot, 'memory-v1.json'), bytes, { mode: 0o600 })
  return fileRoot
}

function makeEngine(root, bytes) {
  const stateRoot = installSnapshot(root, bytes)
  return new RebuildEngine({ stateRoot, now: () => FIXED_NOW })
}

function withoutRootUpdatedAt(doc) {
  const normalized = structuredClone(doc)
  normalized.updatedAt = 0
  return normalized
}

function trackStore(engine) {
  let transactions = 0
  let reads = 0
  let commits = 0
  const store = engine.store
  const previousOnCommit = store.onCommit
  store.onCommit = durability => {
    commits += 1
    previousOnCommit?.(durability)
  }
  const transaction = store.transaction.bind(store)
  store.transaction = (...args) => { transactions += 1; return transaction(...args) }
  const read = store.read.bind(store)
  store.read = (...args) => { reads += 1; return read(...args) }
  return { snapshot: () => ({ transactions, reads, commits }) }
}

function adapterFixture(t) {
  const dir = tempRoot(t)
  const handlers = new Map()
  const provided = new Map()
  const workspace = realpathSync(process.cwd())
  const ctx = {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      return () => {}
    },
    effect() {},
    provide(key, value) { provided.set(key, value) },
    get(key) { return provided.get(key) },
    reflect: { provide() { return true } },
    plugin(Class) { return new Class(ctx) },
    dshHomePath(name) { return join(dir, name) },
    workspaceRegistry: { list: () => [{ path: workspace, sessionIds: ['s1'] }] },
  }
  const plugin = apply(ctx, { wakeIntervalMs: 60_000 })
  t.after(() => plugin.dispose())
  const session = { id: 's1', header: { cwd: workspace }, events: [],
    get seq() { return this.events.length }, eventAt(index) { return this.events[index] } }
  const preStep = (step = 1) => handlers.get('agent/pre-step')[0]({
    agent: { session, options: ROUTE }, step, turn: 1,
    messages: [{ id: 'prompt-1', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: PROMPT }] }],
  }, async payload => ({ kind: 'enter', messages: payload.messages }))
  return { plugin, session, preStep }
}

test('turn facts and route share one durable pre-step transaction with unchanged prepared state', t => {
  const root = tempRoot(t)
  const snapshot = seededSnapshot(join(root, 'seed'))
  const oldEngine = makeEngine(join(root, 'old'), snapshot)
  const newEngine = makeEngine(join(root, 'new'), snapshot)
  let oldCommits = 0
  let newCommits = 0
  oldEngine.store.onCommit = () => { oldCommits += 1 }
  newEngine.store.onCommit = () => { newCommits += 1 }

  const oldFact = oldEngine.recordTurnFacts({ sessionId: 's1', turnId: '1', taskSummary: PROMPT })
  const oldRoute = oldEngine.observeRoute({ sessionId: 's1', route: ROUTE })
  const oldPrepared = oldEngine.prepare({ sessionId: 's1', turnId: '1', projectKey: '/repo/mse',
    prompt: PROMPT })

  const combined = newEngine.recordTurnFactsAndRoute({ sessionId: 's1', turnId: '1',
    taskSummary: PROMPT, route: ROUTE })
  const newPrepared = newEngine.prepare({ sessionId: 's1', turnId: '1', projectKey: '/repo/mse',
    prompt: PROMPT })

  assert.deepEqual(combined.facts, oldFact)
  assert.deepEqual(combined.route, oldRoute)
  assert.deepEqual(newPrepared, oldPrepared)
  assert.equal(oldCommits, 3)
  assert.equal(newCommits, 2)
  assert.deepEqual(withoutRootUpdatedAt(newEngine.store.read()),
    withoutRootUpdatedAt(oldEngine.store.read()))
})

test('invalid route observation cannot prevent valid turn facts from being stored', t => {
  const root = tempRoot(t)
  const cases = [
    { sessionId: 'x'.repeat(513), route: ROUTE },
    { sessionId: 's1', route: { ...ROUTE, provider: '' } },
    { sessionId: 's1', route: { ...ROUTE, reasoningEffort: '\n' } },
  ]
  for (const [index, input] of cases.entries()) {
    const engine = new RebuildEngine({ stateRoot: join(root, `state-${index}`), now: () => FIXED_NOW })
    const result = engine.recordTurnFactsAndRoute({ ...input, turnId: '1', taskSummary: PROMPT })
    const doc = engine.store.read()
    assert.equal(result.facts.ok, true)
    assert.deepEqual(result.route, { ok: false, code: 'invalid_route_observation' })
    assert.equal(doc.turnFacts.length, 1)
    assert.equal(doc.turnFacts[0].taskSummary, PROMPT)
    assert.equal(doc.routes.length, 0)
  }
})

test('same-turn prepare dedup returns without a commit and leaves write health unchanged', t => {
  const root = tempRoot(t)
  const engine = new RebuildEngine({ stateRoot: join(root, 'state'), now: () => FIXED_NOW })
  engine.recordCorrection({ text: RULE, sessionId: 'seed', turnId: 'seed' })
  const first = engine.prepare({ sessionId: 's1', turnId: '1', projectKey: '/repo/mse', prompt: PROMPT })
  assert.ok(first.offered.length > 0)
  let commits = 0
  engine.store.onCommit = () => { commits += 1 }
  const before = readFileSync(engine.store.path)
  engine.store.lastCommitDurability = 'unconfirmed'

  const duplicate = engine.prepare({ sessionId: 's1', turnId: '1', projectKey: '/repo/mse', prompt: PROMPT })

  assert.deepEqual(duplicate, { ok: true, context: '', reason: 'same_turn_dedup' })
  assert.equal(commits, 0)
  assert.equal(engine.store.lastCommitDurability, 'unconfirmed')
  assert.deepEqual(readFileSync(engine.store.path), before)
})

test('deduplicated prepare still commits format3 migration and validation defaults', t => {
  const root = tempRoot(t)
  const stateRoot = join(root, 'state')
  const engine = new RebuildEngine({ stateRoot, now: () => FIXED_NOW })
  engine.recordCorrection({ text: RULE, sessionId: 'seed', turnId: 'seed' })
  const first = engine.prepare({ sessionId: 's1', turnId: '1', projectKey: '/repo/mse', prompt: PROMPT })
  assert.ok(first.offered.length > 0)
  const legacy = JSON.parse(readFileSync(engine.store.path, 'utf8'))
  legacy.format = 3
  delete legacy.methodHistory
  delete legacy.corrections
  delete legacy.recallStrategy.adaptive
  writeFileSync(engine.store.path, JSON.stringify(legacy), { mode: 0o600 })
  const reopened = new RebuildEngine({ stateRoot, now: () => FIXED_NOW })
  let commits = 0
  reopened.store.onCommit = () => { commits += 1 }

  const duplicate = reopened.prepare({ sessionId: 's1', turnId: '1', projectKey: '/repo/mse', prompt: PROMPT })
  const persisted = JSON.parse(readFileSync(reopened.store.path, 'utf8'))

  assert.equal(duplicate.reason, 'same_turn_dedup')
  assert.equal(commits, 1)
  assert.equal(persisted.format, 4)
  assert.ok(Array.isArray(persisted.methodHistory))
  assert.ok(Array.isArray(persisted.corrections))
})

test('deduplicated prepare persists format4 defaults injected while validating the snapshot', t => {
  const root = tempRoot(t)
  const stateRoot = join(root, 'state')
  const engine = new RebuildEngine({ stateRoot, now: () => FIXED_NOW })
  engine.recordCorrection({ text: RULE, sessionId: 'seed', turnId: 'seed' })
  const first = engine.prepare({ sessionId: 's1', turnId: '1', projectKey: '/repo/mse', prompt: PROMPT })
  assert.ok(first.offered.length > 0)
  const oldShape = JSON.parse(readFileSync(engine.store.path, 'utf8'))
  delete oldShape.methodHistory
  delete oldShape.corrections
  delete oldShape.recallStrategy.adaptive
  writeFileSync(engine.store.path, JSON.stringify(oldShape), { mode: 0o600 })
  const reopened = new RebuildEngine({ stateRoot, now: () => FIXED_NOW })
  let commits = 0
  reopened.store.onCommit = () => { commits += 1 }

  const duplicate = reopened.prepare({ sessionId: 's1', turnId: '1', projectKey: '/repo/mse', prompt: PROMPT })
  const persisted = JSON.parse(readFileSync(reopened.store.path, 'utf8'))

  assert.equal(duplicate.reason, 'same_turn_dedup')
  assert.equal(commits, 1)
  assert.equal(persisted.format, 4)
  assert.ok(Array.isArray(persisted.methodHistory))
  assert.ok(Array.isArray(persisted.corrections))
})

test('real step1 uses the batched facts-route write and step2 exits before store access', async t => {
  const { plugin, preStep } = adapterFixture(t)
  plugin.engine.recordCorrection({ text: RULE, sessionId: 'seed', turnId: 'seed' })
  const tracked = trackStore(plugin.engine)

  const decision = await preStep(1)
  const firstCounts = tracked.snapshot()
  const doc = plugin.engine.store.read()

  assert.equal(firstCounts.transactions, 2)
  assert.equal(firstCounts.commits, 2)
  assert.equal(firstCounts.reads, 2)
  assert.equal(doc.turnFacts.length, 1)
  assert.equal(doc.routes.length, 1)
  assert.ok(doc.receipts.length > 0)
  assert.ok(doc.recallStrategy.adaptive.probes.length > 0)
  assert.ok(decision.messages.length > 1)

  const beforeStep2 = tracked.snapshot()
  await preStep(2)
  assert.deepEqual(tracked.snapshot(), beforeStep2)
})

function capacityPartialSuccessSnapshot(root) {
  const baseRoot = join(root, 'capacity-base')
  const seed = new RebuildEngine({ stateRoot: baseRoot, now: () => FIXED_NOW })
  seed.store.transaction(() => true)
  const baseBytes = readFileSync(seed.store.path)
  const factRoot = join(root, 'capacity-fact')
  const factEngine = makeEngine(factRoot, baseBytes)
  factEngine.recordTurnFacts({ sessionId: 's1', turnId: '1', taskSummary: PROMPT })
  const factBytes = readFileSync(factEngine.store.path)
  const routeRoot = join(root, 'capacity-route')
  const routeEngine = new RebuildEngine({ stateRoot: routeRoot, now: () => FIXED_NOW })
  mkdirSync(routeRoot, { mode: 0o700 })
  writeFileSync(routeEngine.store.path, factBytes, { mode: 0o600 })
  routeEngine.observeRoute({ sessionId: 's1', route: ROUTE })
  const routeBytes = readFileSync(routeEngine.store.path)
  const paddedBase = JSON.parse(baseBytes.toString('utf8'))
  paddedBase.performancePadding = ''
  const paddingOverhead = Buffer.byteLength(JSON.stringify(paddedBase)) - baseBytes.length
  const factDelta = factBytes.length - baseBytes.length
  const routeDelta = routeBytes.length - factBytes.length
  const paddingBytes = MAX_STORE_BYTES - (baseBytes.length + paddingOverhead + factDelta)
    - Math.floor(routeDelta / 2)
  assert.ok(paddingBytes > 0)
  const padded = JSON.parse(baseBytes.toString('utf8'))
  padded.performancePadding = 'x'.repeat(paddingBytes)
  const result = Buffer.from(JSON.stringify(padded))
  assert.ok(result.length + factDelta <= MAX_STORE_BYTES)
  assert.ok(result.length + factDelta + routeDelta > MAX_STORE_BYTES)
  return result
}

test('capacity fallback keeps the fact if route would exceed the store limit', async t => {
  const root = tempRoot(t)
  const { plugin, preStep } = adapterFixture(t)
  const fixture = capacityPartialSuccessSnapshot(root)
  writeFileSync(plugin.engine.store.path, fixture, { mode: 0o600 })

  const decision = await preStep(1)
  const doc = plugin.engine.store.read()

  assert.equal(decision.kind, 'enter')
  assert.equal(doc.turnFacts.length, 1)
  assert.equal(doc.turnFacts[0].taskSummary, PROMPT)
  assert.equal(doc.routes.length, 0)
  assert.equal(doc.receipts.length, 0)
})
