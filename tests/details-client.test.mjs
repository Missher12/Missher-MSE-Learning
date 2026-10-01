// The browser half: loader registration, slot wiring and the pure display helpers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TYPERT } from '../adapters/dsh/typert.mjs'

const SOURCE = readFileSync(new URL('../adapters/dsh/client.js', import.meta.url), 'utf8')

/** Evaluate the browser bundle the way the web shell does, then hand back its module. */
function loadClient() {
  let registration
  const window = { __ModuleLoader__: { load: value => { registration = value } } }
  const document = { createElement: () => ({ dataset: {}, remove: () => {} }), head: { append: () => {} } }
  // eslint-disable-next-line no-new-func -- the bundle is a browser script by contract.
  new Function('window', 'document', 'setInterval', 'clearInterval', SOURCE)(window, document, setInterval, clearInterval)
  assert.ok(registration, 'the bundle registers itself with the module loader')
  const react = { createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}], useEffect: () => {}, useCallback: value => value }
  return { id: registration.id, module: registration.factory(spec => spec === 'react' ? react : undefined) }
}

/** Minimal Cordis-like client context that records what the plugin wires up. */
function fakeContext() {
  const record = { locales: [], styles: [], mounted: [], slots: [], injected: [], effects: 0, disposers: [] }
  const scope = {
    remote: { mseDetails: { overview: async () => ({ ok: true, value: 1 }) } },
    locale: { getLocale: () => ({ active: 'zh' }), bind: () => key => key },
    slots: { inject: (name, run) => { record.slots.push(name); run() },
      register: (options, Component) => { record.registered = { options, Component } } },
  }
  const ctx = {
    effect: fn => { record.effects += 1; const disposer = fn(); record.disposers.push(disposer) },
    locale: { register: (ns, dicts) => { record.locales.push({ ns, dicts }) } },
    remote: { $mount: async contribution => { record.mounted.push(contribution); return () => {} } },
    inject: (deps, run) => { record.injected.push(deps); run(scope) },
  }
  return { ctx, record, scope }
}

test('the bundle registers one read-only bundle-config entry for its own package', async () => {
  const { id, module: mod } = loadClient()
  assert.equal(id, '@missher/dsh-mse-learning')
  assert.deepEqual(mod.inject, ['slots', 'locale', 'remote'])
  const { ctx, record } = fakeContext()
  await mod.apply(ctx)
  assert.equal(record.mounted.length, 1, 'the Remote contribution is mounted once')
  assert.equal(record.mounted[0].package, '@missher/dsh-mse-learning')
  assert.equal(record.locales.length, 1)
  assert.equal(record.locales[0].ns, 'mse.details')
  assert.deepEqual(record.slots, ['plugins.bundle.config'])
  assert.equal(record.registered.options.name, 'plugins.bundle.config')
  assert.equal(record.registered.options.key, '@missher/dsh-mse-learning',
    'the entry is keyed by this bundle, so it renders on the MSE detail page')
  assert.equal(record.registered.options.locale, 'mse.details')
  assert.equal(typeof record.registered.Component, 'function')
  const face = record.registered.options.inject()
  assert.equal(typeof face.call, 'function', 'the page receives only a bounded call face')
  assert.equal(face.locale, 'zh')
  const ok = await face.call('overview', {})
  assert.deepEqual(ok, { ok: true, value: 1 }, 'the slot face returns the raw Remote result')
})

test('the client descriptors mirror the Host manifest endpoint for endpoint', async () => {
  const { module: mod } = loadClient()
  const descriptors = mod.__test.REMOTE.descriptors
  const declared = TYPERT.invocations.map(row => row.id).sort()
  assert.deepEqual(descriptors.map(row => row.id).sort(), declared)
  for (const descriptor of descriptors) {
    const manifest = TYPERT.invocations.find(row => row.id === descriptor.id)
    assert.equal(descriptor.service, manifest.service)
    assert.equal(descriptor.namespace, manifest.namespace)
    assert.equal(descriptor.method, manifest.method)
    assert.equal(descriptor.invocation.kind, 'direct')
    assert.deepEqual(descriptor.parameters.map(row => row.wire), manifest.parameters.map(row => row.wire))
    assert.equal(descriptor.parameters[0].acceptsUndefined, true)
    assert.equal(descriptor.result.mode, 'strict')
    assert.equal(typeof descriptor.result.create, 'function')
    assert.equal(typeof descriptor.parameters[0].codec.create, 'function')
  }
  assert.deepEqual(TYPERT.model.services[0].members.map(row => row.name).sort(), descriptors.map(row => row.method).sort())
})

test('view helpers stay bounded and never invent a label or a byte', () => {
  const { module: mod } = loadClient()
  const { zh, en, formatBytes, formatTime, reasonLabel, settleLabel, kindLabel, normalizeQuery, storeState,
    callRemote, statusLabelOf, TABS, PAGE_SIZES } = mod.__test
  const dict = zh
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'both dictionaries carry the same keys')
  assert.deepEqual(Object.keys(zh.reasonNames).sort(), Object.keys(en.reasonNames).sort())
  assert.equal(reasonLabel(dict, 'recalled'), '已召回并注入')
  assert.equal(reasonLabel(en, 'budget_exhausted'), 'Budget exhausted')
  assert.equal(reasonLabel(dict, 'unknown_code'), 'unknown_code')
  assert.equal(reasonLabel(dict, undefined), '')
  assert.equal(settleLabel(dict, 'settled'), '已结算')
  assert.equal(settleLabel(en, 'stopped'), 'Stopped')
  assert.equal(kindLabel(dict, 'method'), '方法')
  assert.equal(kindLabel(dict, 'correction'), '纠错')
  assert.equal(formatBytes(130), '130 B')
  assert.equal(formatBytes(Number.NaN), '0 B')
  assert.equal(formatBytes(-5), '0 B')
  assert.equal(formatTime(0, 'zh'), '—')
  assert.equal(formatTime(undefined, 'zh'), '—')
  assert.equal(storeState(dict, { readable: true, schema: 2 }).tone, 'ok')
  assert.equal(storeState(dict, { migrationRequired: true }).tone, 'warn')
  assert.equal(storeState(dict, { readable: false, error: 'store_unavailable' }).tone, 'err')
  assert.equal(storeState(dict, null).tone, 'err')
  assert.equal(statusLabelOf(dict, 'validated'), dict.methodsValidated)
  assert.deepEqual(TABS, ['overview', 'lessons', 'recall', 'budget'])
  assert.deepEqual(PAGE_SIZES, [10, 20, 50])
  const query = normalizeQuery({ query: 'x'.repeat(200), kind: 'bogus', status: 'gone', page: -1, pageSize: 999,
    sessionId: '' })
  assert.equal(query.query.length, 64)
  assert.equal(query.kind, '')
  assert.equal(query.status, '')
  assert.equal(query.page, 1)
  assert.equal(query.pageSize, 20)
  assert.equal(query.sessionId, undefined)
  assert.deepEqual(normalizeQuery({}), { query: '', kind: '', status: '', page: 1, pageSize: 20, sessionId: undefined })
})

test('a failed remote call becomes a labelled error, never a fabricated value', async () => {
  const { module: mod } = loadClient()
  const { callRemote } = mod.__test
  await assert.rejects(() => callRemote(async () => ({ ok: false, code: 'session_unknown' }), 'recall', {}), /session_unknown/)
  await assert.rejects(() => callRemote(async () => undefined, 'overview', {}), /empty_result/)
  await assert.rejects(() => callRemote(async () => ({ ok: false, error: { code: 'store_unavailable' } }), 'overview', {}),
    /store_unavailable/)
  const ok = await callRemote(async () => ({ ok: true, value: { total: 3, page: 2 } }), 'lessons', { page: 2 })
  assert.deepEqual(ok, { total: 3, page: 2 }, 'the Host payload is unwrapped from the Remote envelope')
  await assert.rejects(() => callRemote(async () => ({ ok: true }), 'overview', {}), /empty_result/)
  await assert.rejects(() => callRemote(async () => ({ ok: true, value: null }), 'overview', {}), /empty_result/)
})
