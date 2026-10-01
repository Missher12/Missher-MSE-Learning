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
    useState: initial => [initial, () => {}], useEffect: () => {}, useRef: value => ({ current: value }),
    useCallback: value => value, Fragment: 'fragment' }
  // The host primitives are loaded by the shell, not by this package; the test only needs their
  // component identities so the tree can be inspected.
  // The element type stays the component identity the bundle passed to createElement, so the
  // tests can name a control by tagging the stand-in rather than by reading its source text.
  const primitive = name => {
    const Stand = props => ({ type: `ui:${name}`, props: props ?? {}, children: [] })
    Stand.uiName = name
    return Stand
  }
  const primitives = Object.fromEntries(['Button', 'Input', 'Switch', 'SegmentedTabs', 'Tag', 'StateDot',
    'DisclosureRow', 'Checkbox'].map(name => [name, primitive(name)]))
  return { id: registration.id, module: registration.factory(spec => spec === 'react' ? react
    : spec === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : undefined) }
}

/** Minimal Cordis-like client context that records what the plugin wires up. */
function fakeContext() {
  const record = { locales: [], styles: [], mounted: [], slots: [], injected: [], effects: 0, disposers: [],
    registered: [], formIds: [], served: [] }
  const scope = {
    remote: {
      mseDetails: { overview: async () => ({ ok: true, value: 1 }) },
      mseControl: { status: async () => ({ ok: true, value: { ok: true, code: null, settings: null } }) },
    },
    locale: { getLocale: () => ({ active: 'zh' }), bind: () => key => key },
    slots: { inject: (name, run) => { record.slots.push(name); run(); return () => {} },
      register: (options, Component) => { record.registered.push({ options, Component }); return () => {} } },
  }
  const form = {
    getSnapshot: () => ({ status: 'ready', value: { enabled: true, reflectionEnabled: true, maxContextBytes: 768,
      evaluationTokensPerDay: 0, evaluationCallsPerDay: 2 }, revision: 7, writable: true, mode: 'host' }),
    subscribe: () => () => {},
    mutate: async () => true,
  }
  const ctx = {
    effect: fn => { record.effects += 1; const disposer = fn(); record.disposers.push(disposer) },
    locale: { register: (ns, dicts) => { record.locales.push({ ns, dicts }) } },
    configForms: { get: id => { record.formIds.push(id); return form },
      whileServed: (namespaces, register) => { record.served.push([...namespaces]); return register(new Set(namespaces)) } },
    remote: { $mount: async contribution => { record.mounted.push(contribution); return () => {} } },
    inject: (deps, run) => { record.injected.push(deps); run(scope) },
  }
  return { ctx, record, scope, form }
}

test('the bundle registers the real settings section and the bundle-config entry', async () => {
  const { id, module: mod } = loadClient()
  assert.equal(id, '@missher/dsh-mse-learning')
  assert.deepEqual(mod.inject, ['slots', 'locale', 'remote', 'configForms'])
  const { ctx, record, form } = fakeContext()
  await mod.apply(ctx)
  assert.equal(record.mounted.length, 2, 'both the read-only and the control Remote are mounted once')
  assert.equal(record.mounted[0].package, '@missher/dsh-mse-learning')
  assert.equal(record.mounted[1].package, '@missher/dsh-mse-learning-control',
    'a second contribution must not reuse the first package label')
  assert.equal(record.locales.length, 1)
  assert.equal(record.locales[0].ns, 'mse.details')
  assert.deepEqual(record.slots, ['plugins.bundle.config', 'settings.section'])
  assert.deepEqual(record.served, [['mse-learning']], 'the section waits until the namespace is served')
  assert.deepEqual(record.formIds, ['mse-learning'], 'the form is bound to the profile entry id')
  const bundle = record.registered.find(row => row.options.name === 'plugins.bundle.config')
  assert.equal(bundle.options.key, '@missher/dsh-mse-learning',
    'the entry is keyed by this bundle, so it renders on the MSE page')
  assert.equal(bundle.options.locale, 'mse.details')
  assert.equal(typeof bundle.Component, 'function')
  const face = bundle.options.inject()
  assert.equal(typeof face.call, 'function', 'the page receives only a bounded call face')
  assert.equal(typeof face.control, 'function', 'and the control face, from a different namespace')
  assert.equal(face.locale, 'zh')
  const ok = await face.call('overview', {})
  assert.deepEqual(ok, { ok: true, value: 1 }, 'the slot face returns the raw Remote result')
  const section = record.registered.find(row => row.options.name === 'settings.section')
  assert.equal(section.options.id, 'mse-learning', 'the settings cell id is the profile entry id')
  assert.equal(section.options.order, 66)
  assert.equal(section.options.label(), '自我进化')
  assert.equal(section.options.inject().form, form, 'the section is handed the host config form')
})

test('the client descriptors mirror the Host manifest endpoint for endpoint', async () => {
  const { module: mod } = loadClient()
  const descriptors = [...mod.__test.REMOTE.descriptors, ...mod.__test.CONTROL.descriptors]
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
  const byService = new Map(TYPERT.model.services.map(row => [row.key, row.members.map(member => member.name).sort()]))
  for (const [service, members] of byService) {
    assert.deepEqual(members, descriptors.filter(row => row.service === service).map(row => row.method).sort())
  }
  assert.deepEqual([...byService.keys()].sort(), ['mseControl', 'mseDetails'])
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
  assert.deepEqual(TABS, ['overview', 'lessons', 'recall', 'manual', 'budget'])
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

test('the settings draft only sends the fields that actually changed', () => {
  const { module: mod } = loadClient()
  const { diffOps, defaultDraft } = mod.__test
  const accepted = { enabled: true, reflectionEnabled: true, maxContextBytes: 768,
    evaluationTokensPerDay: 0, evaluationCallsPerDay: 2 }
  const clean = diffOps(defaultDraft(accepted), accepted)
  assert.deepEqual(clean.ops, [], 'an untouched form writes nothing')
  assert.deepEqual(clean.problems, [])
  const changed = diffOps({ ...defaultDraft(accepted), enabled: false, maxContextBytes: '512' }, accepted)
  assert.deepEqual(changed.ops, [
    { op: 'set', path: ['enabled'], value: false },
    { op: 'set', path: ['maxContextBytes'], value: 512 },
  ], 'one atomic op list carries exactly the edited paths')
  const bad = diffOps({ ...defaultDraft(accepted), maxContextBytes: '4096' }, accepted)
  assert.deepEqual(bad.ops, [], 'an out-of-range byte cap never reaches the host')
  assert.equal(bad.problems.length, 1)
  const fractional = diffOps({ ...defaultDraft(accepted), evaluationTokensPerDay: '12.5' }, accepted)
  assert.deepEqual(fractional.ops, [], 'a fractional token cap is a problem, not a rounded value')
  assert.equal(fractional.problems.length, 1)
  const negative = diffOps({ ...defaultDraft(accepted), evaluationCallsPerDay: '-1' }, accepted)
  assert.deepEqual(negative.ops, [])
  assert.equal(negative.problems.length, 1)
})

test('the plugin page points at the settings section without mounting a second panel', () => {
  const { module: mod } = loadClient()
  const { zh, en, BundlePage } = mod.__test
  const tree = BundlePage({ locale: 'zh' })
  assert.equal(tree.props['data-mse-details'], 'pointer')
  assert.equal(zh.settingsPath, '设置 → 自我进化')
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const key of ['settingsPath', 'settingsPointer', 'previewStale', 'verifyStale', 'reasonNamesForControl']) {
    assert.ok(Object.hasOwn(zh, key) && Object.hasOwn(en, key), `both dictionaries carry ${key}`)
  }
  assert.deepEqual(Object.keys(zh.reasonNamesForControl).sort(), Object.keys(en.reasonNamesForControl).sort())
  assert.deepEqual(Object.keys(zh.jobState).sort(), Object.keys(en.jobState).sort())
  assert.deepEqual(Object.keys(zh.jobKind).sort(), Object.keys(en.jobKind).sort())
  assert.deepEqual(Object.keys(zh.verifyDecision).sort(), Object.keys(en.verifyDecision).sort())
})

test('control payloads surface their business code instead of being unwrapped away', async () => {
  const { module: mod } = loadClient()
  const { controlCall } = mod.__test
  const refused = await controlCall(async () => ({ ok: true, value: { ok: false, code: 'turn_required' } }), 'turns', {})
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'turn_required')
  await assert.rejects(() => controlCall(async () => ({ ok: false, error: { code: 'gateway/internal' } }), 'status', {}),
    /gateway\/internal/)
})


/**
 * A minimal stateful React stand-in plus a render loop.
 *
 * `useState` keeps its value across passes and a setter schedules another pass, so a component
 * that stages its draft inside an effect reaches the same state the browser reaches. Without
 * it only the first render pass is observable and a `ready` + writable settings document is
 * never exercised — which is exactly how an undefined binding survived until it was read.
 */
async function renderPanel(registration, props, passes = 8) {
  const store = new Map()
  const effects = []
  let slot = 0
  let dirty = false
  const react = {
    createElement: (type, elementProps, ...children) => ({ type, props: elementProps, children }),
    useState: initial => {
      const index = slot++
      if (!store.has(index)) store.set(index, typeof initial === 'function' ? initial() : initial)
      return [store.get(index), next => {
        store.set(index, typeof next === 'function' ? next(store.get(index)) : next)
        dirty = true
      }]
    },
    useEffect: fn => { effects.push(fn) },
    useLayoutEffect: () => {},
    useCallback: value => value,
    useMemo: fn => fn(),
    useRef: value => ({ current: value }),
    Fragment: 'fragment',
  }
  // The element type stays the component identity the bundle passed to createElement, so the
  // tests can name a control by tagging the stand-in rather than by reading its source text.
  const primitive = name => {
    const Stand = props => ({ type: `ui:${name}`, props: props ?? {}, children: [] })
    Stand.uiName = name
    return Stand
  }
  const primitives = Object.fromEntries(['Button', 'Input', 'Switch', 'SegmentedTabs', 'Tag', 'StateDot',
    'DisclosureRow', 'Checkbox', 'Menu', 'IconChevronRightOutlineRegular'].map(name => [name, primitive(name)]))
  const mod = registration.factory(spec => spec === 'react' ? react
    : spec === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : undefined)
  const Component = mod.__test.MsePanel
  let tree = null
  for (let pass = 0; pass < passes; pass++) {
    slot = 0
    dirty = false
    tree = Component(props)
    if (pass === 0) for (const fn of effects) fn()
    // Let the effects' RPC promises settle before the next pass, so the page reaches the state
    // the browser reaches instead of stopping at its loading branch.
    await new Promise(resolve => setImmediate(resolve))
    if (!dirty) break
  }
  // One final pass so the last settled response is painted.
  slot = 0
  dirty = false
  tree = Component(props)
  return tree
}

/** Every element in a rendered tree, depth-first. */
function elementsOf(tree) {
  const nodes = []
  const walk = node => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    nodes.push(node)
    if (Array.isArray(node.children)) node.children.forEach(walk)
  }
  walk(tree)
  return nodes
}

const labelOf = node => (node.children ?? []).filter(child => typeof child === 'string').join('')

const READY_VALUES = Object.freeze({ enabled: true, reflectionEnabled: true, maxContextBytes: 768,
  evaluationTokensPerDay: 0, evaluationCallsPerDay: 2 })

test('a ready writable form renders the settings rows and a disabled save', async () => {
  let registration
  const window = { __ModuleLoader__: { load: value => { registration = value } } }
  const document = { createElement: () => ({ dataset: {}, remove: () => {} }), head: { append: () => {} } }
  // eslint-disable-next-line no-new-func -- the browser bundle is a script by contract.
  new Function('window', 'document', 'setInterval', 'clearInterval', SOURCE)(window, document, setInterval, clearInterval)
  const form = {
    getSnapshot: () => ({ status: 'ready', writable: true, mode: 'host', revision: 7, value: { ...READY_VALUES } }),
    subscribe: () => () => {},
    mutate: () => { throw new Error('nothing may be written by a render test') },
  }
  const call = async method => ({ ok: true, value: method === 'overview'
    ? { ok: true, version: 'test', runtime: 'dsh', budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 },
      counts: {}, store: { readable: true, schema: 2 } }
    : { ok: true, sessions: [{ id: 's1', label: 'SESSION', scope: 'project' }] } })
  const tree = await renderPanel(registration, { locale: 'zh', call, control: undefined, form })
  const flat = JSON.stringify(tree)
  for (const label of ['持久学习', '自动复盘', '单轮上下文上限']) {
    assert.ok(flat.includes(label), `the ${label} row is rendered`)
  }
  const nodes = elementsOf(tree)
  const controls = name => nodes.filter(node => node.type?.uiName === name)
  const toggles = controls('Switch')
  assert.deepEqual(toggles.map(node => node.props.label),
    ['持久学习', '自动复盘', '每 20 秒自动刷新'],
    `the two settings switches and the periodic refresh entry, got ${JSON.stringify(toggles.map(node => node.props.label))}`)
  const save = controls('Button').find(node => labelOf(node) === '保存')
  assert.ok(save !== undefined, 'the save control exists')
  assert.equal(save.props.disabled, true, 'saving an unmodified draft is disabled')
  const discard = controls('Button').find(node => labelOf(node) === '取消')
  assert.ok(discard !== undefined)
  assert.equal(discard.props.disabled, true, 'discarding an unmodified draft is disabled')
})

test('a read failure is reported as unknown, never as paused or as a zero', async () => {
  let registration
  const window = { __ModuleLoader__: { load: value => { registration = value } } }
  const document = { createElement: () => ({ dataset: {}, remove: () => {} }), head: { append: () => {} } }
  // eslint-disable-next-line no-new-func -- the browser bundle is a script by contract.
  new Function('window', 'document', 'setInterval', 'clearInterval', SOURCE)(window, document, setInterval, clearInterval)
  const form = {
    getSnapshot: () => ({ status: 'ready', writable: true, mode: 'host', revision: 1, value: { ...READY_VALUES } }),
    subscribe: () => () => {},
    mutate: () => true,
  }
  // No control Remote: the runtime state is unknown, not paused.
  const call = async method => ({ ok: true, value: method === 'overview'
    ? { ok: true, version: 'test', runtime: 'dsh', budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 },
      counts: {}, store: { readable: true, schema: 2 } }
    : { ok: true, sessions: [] } })
  const tree = await renderPanel(registration, { locale: 'zh', call, control: undefined, form })
  const flat = JSON.stringify(tree)
  assert.ok(!flat.includes('已暂停'), 'an unread state is never shown as paused')
  const nodes = elementsOf(tree)
  // The five pages must all be reachable from the tab list.
  const tabs = nodes.find(node => node.type?.uiName === 'SegmentedTabs')
  assert.equal(tabs.props.items.length, 5)
  assert.deepEqual(tabs.props.items.map(item => item.label), ['常规', '经验', '召回', '任务', '额度'])
})
