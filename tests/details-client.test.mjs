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
    useLayoutEffect: () => {}, useCallback: value => value, Fragment: 'fragment' }
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
    'DisclosureRow', 'Checkbox', 'Menu', 'IconChevronRightOutlineRegular', 'IconChevronsUpDownOutlineRegular']
    .map(name => [name, primitive(name)]))
  return { id: registration.id, registration, module: registration.factory(spec => spec === 'react' ? react
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
  const settingsMirror = { getSnapshot: () => ({ status: 'ready', error: null, view: { namespaces: [] } }),
    load: async () => {} }
  const ctx = {
    effect: fn => { record.effects += 1; const disposer = fn(); record.disposers.push(disposer) },
    locale: { register: (ns, dicts) => { record.locales.push({ ns, dicts }) } },
    configForms: { get: id => { record.formIds.push(id); return form }, describe: () => settingsMirror,
      whileServed: (namespaces, register) => { record.served.push([...namespaces]); return register(new Set(namespaces)) } },
    remote: { $mount: async contribution => { record.mounted.push(contribution); return () => {} } },
    inject: (deps, run) => { record.injected.push(deps); run(scope) },
  }
  return { ctx, record, scope, form, settingsMirror }
}

test('the bundle registers the real settings section and the bundle-config entry', async () => {
  const { id, module: mod } = loadClient()
  assert.equal(id, '@missher/dsh-mse-learning')
  assert.deepEqual(mod.inject, ['slots', 'locale', 'remote', 'configForms'])
  const { ctx, record, form, settingsMirror } = fakeContext()
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
  assert.equal(section.options.inject().settingsMirror, settingsMirror,
    'the section receives the Host-owned read-only refresh mirror when available')
  assert.equal(bundle.options.inject().hooks.locale, ctx.locale, 'bundle page subscribes to live Host locale')
  assert.equal(section.options.inject().hooks.locale, ctx.locale, 'settings section subscribes to live Host locale')
})

test('settings write capability accepts old and new Host contracts and rejects ambiguous/read-only states', () => {
  const { module: mod } = loadClient()
  const form = { mutate() {} }
  const base = { status: 'ready', writable: true }
  for (const snapshot of [base, { ...base, mode: 'host' }]) {
    assert.equal(mod.__test.canWriteSettings(form, snapshot), true)
  }
  for (const snapshot of [
    { ...base, writable: false }, { ...base, writable: undefined },
    { ...base, status: 'loading' }, { ...base, status: 'unavailable' },
    { ...base, mode: 'memory' }, { ...base, mode: 'other' }, { ...base, mode: undefined },
  ]) assert.equal(mod.__test.canWriteSettings(form, snapshot), false)
  assert.equal(mod.__test.canWriteSettings({}, base), false, 'a missing mutate method cannot enable controls')
})

test('live locale hooks update both panel surfaces without changing fallback props', () => {
  const { module: mod } = loadClient()
  let active = 'zh'
  const useLocale = selector => selector({ active })
  const panelProps = { locale: 'zh', useLocale, call: async () => ({ ok: true, value: {} }),
    control: undefined, form: undefined }
  const title = tree => elementsOf(tree).find(node => node.type === 'h1')?.children?.[0]
  const zhPanel = mod.__test.MsePanel(panelProps)
  const zhBundle = mod.__test.BundlePage({ locale: 'zh', useLocale })
  active = 'en'
  const enPanel = mod.__test.MsePanel(panelProps)
  const enBundle = mod.__test.BundlePage({ locale: 'zh', useLocale })
  assert.equal(title(zhPanel), mod.__test.zh.settingsTitle)
  assert.equal(title(zhBundle), mod.__test.zh.settingsTitle)
  assert.equal(title(enPanel), mod.__test.en.settingsTitle)
  assert.equal(title(enBundle), mod.__test.en.settingsTitle)
})

test('compact settings navigation keeps all five full labels and the selected panel link', () => {
  const { module: mod } = loadClient()
  const changed = []
  for (const locale of ['en', 'zh']) {
    const dict = locale === 'en' ? mod.__test.en : mod.__test.zh
    const compactTree = mod.__test.settingsTabNavigation('lessons', value => changed.push(value), dict, true)
    const pickerElement = compactTree.children[0]
    const menu = mod.__test.Picker(pickerElement.props)
    assert.deepEqual(menu.props.items.map(item => item.label), [dict.tabOverview, dict.tabLessons,
      dict.tabRecall, dict.tabManual, dict.tabBudget])
    assert.equal(menu.props.selectedId, 'lessons')
    assert.equal(menu.props.anchor.props.id, 'mse-tab-lessons')
    assert.equal(menu.props.anchor.props['aria-controls'], 'mse-pane-lessons')
    menu.props.onSelect('budget')
    const wide = mod.__test.settingsTabNavigation('lessons', () => {}, dict, false)
    assert.equal(wide.type.uiName, 'SegmentedTabs')
    assert.equal(wide.props.items.length, 5)
    assert.equal(wide.props.items[1].panelId, 'mse-pane-lessons')
  }
  assert.deepEqual(changed, ['budget', 'budget'])
})

test('the client descriptors mirror the Host manifest endpoint for endpoint', async () => {
  const { module: mod } = loadClient()
  const descriptors = [...mod.__test.REMOTE.descriptors, ...mod.__test.CONTROL.descriptors]
  const declared = TYPERT.invocations.map(row => row.id).sort()
  assert.ok(declared.includes('@missher/dsh-mse-learning#mseControl/authorizeProblemRecoveryRetry'),
    'the narrow recovery operation must have a formal Host Typert invocation')
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
    callRemote, statusLabelOf, sessionOptions, sessionShortId, TABS, PAGE_SIZES } = mod.__test
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
  assert.equal(defaultDraft(accepted).evaluationBudgetMode, 'limited', 'an older config without the field migrates closed')
  const continuous = diffOps({ ...defaultDraft(accepted), evaluationBudgetMode: 'unlimited' }, accepted)
  assert.deepEqual(continuous.ops, [{ op: 'set', path: ['evaluationBudgetMode'], value: 'unlimited' }],
    'switching modes preserves both saved finite caps')
  const backToLimited = diffOps({ ...defaultDraft({ ...accepted, evaluationBudgetMode: 'unlimited' }),
    evaluationBudgetMode: 'limited' }, { ...accepted, evaluationBudgetMode: 'unlimited' })
  assert.deepEqual(backToLimited.ops, [{ op: 'set', path: ['evaluationBudgetMode'], value: 'limited' }],
    'switching back does not reset the finite settings')
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

test('experience verification keeps its summary brief and nests capability details in a disclosure', () => {
  const { module: mod } = loadClient()
  const { zh, en } = mod.__test
  assert.equal(zh.verificationCoverage, '经验验证')
  assert.equal(zh.verificationCoverageHint, 'MSE 验证候选经验，确认有效后再正式启用。')
  assert.equal(zh.verificationDetails, '验证详情')
  assert.ok(zh.verificationCoverageDetails.includes('DSH 项目根目录 package.json'))
  assert.equal(en.verificationCoverage, 'Experience verification')
  assert.equal(en.verificationDetails, 'Verification details')
  assert.ok(en.verificationCoverageDetails.includes('project-root package.json'))
  assert.ok(SOURCE.includes("row('verificationCoverage', dict.verificationCoverage, dict.verificationCoverageHint, null)"))
  assert.ok(SOURCE.includes("disclosure('verification-capabilities', dict.verificationDetails, ["))
  assert.ok(SOURCE.includes("{ id: 'verification-details' })"))
  assert.match(SOURCE, /\.mse-details \.mse-coverage-list\{display:flex;flex-wrap:wrap/u)
  assert.match(SOURCE, /\.mse-details \.mse-coverage-item\{min-width:0;overflow-wrap:anywhere\}/u)
})


/**
 * A minimal stateful React stand-in plus a render loop.
 *
 * `useState` keeps its value across passes and a setter schedules another pass, so a component
 * that stages its draft inside an effect reaches the same state the browser reaches. Without
 * it only the first render pass is observable and a `ready` + writable settings document is
 * never exercised — which is exactly how an undefined binding survived until it was read.
 */
async function renderPanel(registration, props, passes = 8, interact = undefined, effectWaitMs = 0) {
  const store = new Map()
  const refs = new Map()
  const effectStore = new Map()
  let pendingEffects = []
  let slot = 0
  let refSlot = 0
  let effectSlot = 0
  let dirty = false
  const depsEqual = (left, right) => Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  const runEffects = () => {
    for (const effect of pendingEffects) {
      const previous = effectStore.get(effect.index)
      if (typeof previous?.cleanup === 'function') previous.cleanup()
      const cleanup = effect.fn()
      effectStore.set(effect.index, { deps: effect.deps, cleanup: typeof cleanup === 'function' ? cleanup : null })
    }
    pendingEffects = []
  }
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
    useEffect: (fn, deps) => {
      const index = effectSlot++
      const previous = effectStore.get(index)
      if (deps === undefined || previous === undefined || !depsEqual(previous.deps, deps)) {
        pendingEffects.push({ index, fn, deps: Array.isArray(deps) ? [...deps] : deps })
      }
    },
    useLayoutEffect: () => {},
    useCallback: value => value,
    useMemo: fn => fn(),
    useRef: value => {
      const index = refSlot++
      if (!refs.has(index)) refs.set(index, { current: value })
      return refs.get(index)
    },
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
  // A pending interaction keeps the loop running while the page is still loading, so the user
  // action is delivered on the FIRST settled data render — the state the browser would be in.
  let acted = interact === undefined
  for (let pass = 0; pass < passes; pass++) {
    slot = 0
    refSlot = 0
    effectSlot = 0
    pendingEffects = []
    dirty = false
    tree = Component(props)
    const hasPendingEffects = pendingEffects.length > 0
    runEffects()
    if (hasPendingEffects && effectWaitMs > 0) await new Promise(resolve => setTimeout(resolve, effectWaitMs))
    // Let the effects' RPC promises settle before the next pass, so the page reaches the state
    // the browser reaches instead of stopping at its loading branch.
    await new Promise(resolve => setImmediate(resolve))
    if (!acted) {
      // The callback returns true once it has driven the control; false means "not rendered yet".
      acted = (await interact({ tree, nodes: elementsOf(tree) })) === true
      continue
    }
    if (!dirty) break
  }
  // One final pass so the last settled response is painted.
  slot = 0
  refSlot = 0
  effectSlot = 0
  pendingEffects = []
  dirty = false
  tree = Component(props)
  runEffects()
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
const REMOTE_READY_VALUES = Object.freeze({ ...READY_VALUES, decisionBackend: 'openai_compatible',
  decisionModel: 'model-before-edit', decisionEndpoint: 'https://example.test/v1',
  decisionSecretRef: '', decisionSecretBinding: '' })

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
  const verificationRow = nodes.find(node => node.props?.key === 'verificationCoverage')
  assert.ok(verificationRow, 'the short experience-verification summary stays on the settings surface')
  assert.ok(JSON.stringify(verificationRow).includes('MSE 验证候选经验，确认有效后再正式启用。'))
  assert.equal(JSON.stringify(verificationRow).includes('package.json'), false,
    'the technical limitations no longer crowd the settings surface')
  const verificationDetails = nodes.find(node => node.type === 'details'
    && node.props?.['data-mse-disclosure'] === 'verification-details')
  assert.ok(verificationDetails, 'the technical capability report remains available in its disclosure')
  assert.equal(verificationDetails.props.open, false, 'verification details are collapsed by default')
  assert.ok(JSON.stringify(verificationDetails).includes('package.json'))
  assert.ok(JSON.stringify(verificationDetails).includes('Hermes 前置检查'))
  const controls = name => nodes.filter(node => node.type?.uiName === name)
  const toggles = controls('Switch')
  assert.deepEqual(toggles.map(node => node.props.label),
    ['持久学习', '自动复盘', '自动审查候选经验', '每 20 秒自动刷新'],
    `the settings switches and the periodic refresh entry, got ${JSON.stringify(toggles.map(node => node.props.label))}`)
  const save = controls('Button').find(node => labelOf(node) === '保存')
  assert.ok(save !== undefined, 'the save control exists')
  assert.equal(save.props.disabled, true, 'saving an unmodified draft is disabled')
  const discard = controls('Button').find(node => labelOf(node) === '取消')
  assert.ok(discard !== undefined)
  assert.equal(discard.props.disabled, true, 'discarding an unmodified draft is disabled')
})

test('the budget panel saves and reads back unlimited mode while retaining metrics and the opt-in switch', async () => {
  const { registration, module: mod } = loadClient()
  let snapshot = { status: 'ready', writable: true, mode: 'host', revision: 1, value: { ...READY_VALUES } }
  const writes = []
  const listeners = new Set()
  const form = { getSnapshot: () => snapshot, subscribe: listener => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, mutate: async (ops, revision) => {
    writes.push({ ops, revision })
    const value = { ...snapshot.value }
    for (const op of ops) value[op.path[0]] = op.value
    snapshot = { ...snapshot, revision: revision + 1, value }
    for (const listener of listeners) listener()
    return true
  } }
  const call = hostCalls({ overview: { ok: true, version: 'test', runtime: 'dsh',
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, counts: {}, store: { readable: true, schema: 2 } } })
  const control = async () => {
    const unlimited = snapshot.value.evaluationBudgetMode === 'unlimited'
    return { ok: true, value: { ok: true, effective: {}, settings: { paidBudget: {
      evaluationBudgetMode: unlimited ? 'unlimited' : 'limited', state: unlimited ? 'unlimited' : 'running',
      remainingTokens: unlimited ? null : 0, remainingCalls: unlimited ? null : 2,
      tokensReserved: 12_345, tokensKnown: 9_876, callsUsed: 7, requestsUsed: 11, tasksUnknown: 2,
    } } } }
  }
  let phase = 0
  let sawLimitedSlider = false
  const tree = await renderPanel(registration, { locale: 'zh', initialTab: 'budget', call, control, form }, 24,
    ({ nodes }) => {
      if (phase === 0) {
        const mode = nodes.find(node => typeof node.type === 'function'
          && node.props?.testId === 'evaluation-budget-mode')
        if (!mode) return false
        sawLimitedSlider = nodes.some(node => node.props?.type === 'range')
        mode.props.onChange('unlimited')
        phase = 1
        return false
      }
      if (phase === 1) {
        const rendered = JSON.stringify(nodes)
        assert.equal(nodes.some(node => node.props?.type === 'range'), false,
          'the original slider is hidden in the unlimited draft')
        assert.ok(rendered.includes('待保存：持续处理（不限额）（当前：按额度）'),
          'the pending selection is distinguished from the currently effective mode')
        const toggle = nodes.find(node => node.type?.uiName === 'Switch' && node.props?.label === mod.__test.zh.autoValidate)
        assert.ok(toggle, 'automatic validation stays visible in the budget section')
        assert.equal(toggle.props.checked, false, 'saving a budget mode does not enable automatic validation')
        const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === mod.__test.zh.save)
        assert.ok(save && !save.props.disabled)
        save.props.onClick()
        phase = 2
        return false
      }
      if (phase === 2) {
        if (snapshot.value.evaluationBudgetMode !== 'unlimited') return false
        const rendered = JSON.stringify(nodes)
        assert.ok(rendered.includes('12345'))
        assert.ok(rendered.includes('9876'))
        assert.ok(rendered.includes('7 / 11'))
        assert.ok(rendered.includes('2'))
        phase = 3
        return true
      }
      return true
    })
  assert.equal(phase, 3)
  assert.equal(sawLimitedSlider, true)
  assert.equal(snapshot.value.evaluationTokensPerDay, READY_VALUES.evaluationTokensPerDay)
  assert.equal(snapshot.value.evaluationCallsPerDay, READY_VALUES.evaluationCallsPerDay)
  assert.deepEqual(writes, [{ revision: 1, ops: [
    { op: 'set', path: ['evaluationBudgetMode'], value: 'unlimited' },
  ] }])
  assert.equal(snapshot.value.autoValidationEnabled, undefined,
    'an absent opt-in remains absent and disabled after the mode write')
  assert.ok(JSON.stringify(tree).includes(mod.__test.zh.evalUnlimitedHint))
})

test('a new budget draft hides stale success and discard or resave reports the current state', async () => {
  const { registration, module: mod } = loadClient()
  let snapshot = { status: 'ready', writable: true, mode: 'host', revision: 1,
    value: { ...READY_VALUES, evaluationTokensPerDay: 50_000, evaluationCallsPerDay: 2,
      evaluationBudgetMode: 'limited' } }
  const writes = []
  const listeners = new Set()
  const form = { getSnapshot: () => snapshot, subscribe: listener => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, mutate: async (ops, revision) => {
    writes.push({ ops, revision })
    const value = { ...snapshot.value }
    for (const op of ops) value[op.path[0]] = op.value
    snapshot = { ...snapshot, revision: revision + 1, value }
    for (const listener of listeners) listener()
    return true
  } }
  const call = hostCalls({ overview: { ok: true, version: 'test', runtime: 'dsh',
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, counts: {},
    store: { readable: true, schema: 2 } } })
  const statusModes = []
  const control = async method => {
    if (method !== 'status') return { ok: true, value: { ok: true } }
    const evaluationBudgetMode = snapshot.value.evaluationBudgetMode === 'unlimited' ? 'unlimited' : 'limited'
    statusModes.push(evaluationBudgetMode)
    return { ok: true, value: { ok: true, effective: {}, settings: { paidBudget: {
      evaluationBudgetMode, state: evaluationBudgetMode === 'unlimited' ? 'unlimited' : 'running',
      remainingTokens: evaluationBudgetMode === 'unlimited' ? null : 50_000,
      remainingCalls: evaluationBudgetMode === 'unlimited' ? null : 2,
    } } } }
  }
  let phase = 0
  await renderPanel(registration, { locale: 'en', initialTab: 'budget', call, control, form }, 24,
    ({ nodes }) => {
      const token = nodes.find(node => node.type?.uiName === 'Input'
        && node.props?.['aria-label'] === mod.__test.en.evalTokens)
      const mode = nodes.find(node => typeof node.type === 'function'
        && node.props?.testId === 'evaluation-budget-mode')
      const save = nodes.find(node => node.type?.uiName === 'Button'
        && [mod.__test.en.save, mod.__test.en.saving].includes(labelOf(node)))
      if (!mode || !save || (phase === 0 && !token)) return false
      if (phase === 0) {
        token.props.onChange({ target: { value: '60000' } })
        phase = 1
        return false
      }
      if (phase === 1) {
        assert.equal(save.props.disabled, false)
        save.props.onClick()
        phase = 2
        return false
      }
      if (phase === 2) {
        const saved = nodes.some(node => node.props?.className === 'mse-ok'
          && labelOf(node) === mod.__test.en.saved)
        if (snapshot.value.evaluationTokensPerDay !== 60_000 || !saved) return false
        mode.props.onChange('unlimited')
        phase = 3
        return false
      }
      if (phase === 3) {
        const rendered = JSON.stringify(nodes)
        assert.ok(rendered.includes(mod.__test.en.unsaved), 'the new draft is marked unsaved')
        assert.ok(rendered.includes(`Unsaved: ${mod.__test.en.evalModeUnlimited} (current: ${mod.__test.en.evalModeLimited})`),
          'the pending mode remains visible against the currently applied mode')
        assert.equal(nodes.some(node => node.props?.className === 'mse-ok'
          && labelOf(node) === mod.__test.en.saved), false,
          'success from the previous save is hidden while this draft is dirty')
        assert.equal(save.props.disabled, false)
        const discard = nodes.find(node => node.type?.uiName === 'Button'
          && labelOf(node) === mod.__test.en.discard)
        assert.ok(discard && !discard.props.disabled)
        discard.props.onClick()
        phase = 4
        return false
      }
      if (phase === 4) {
        assert.equal(mode.props.value, 'limited', 'Discard restores the saved mode')
        assert.equal(save.props.disabled, true, 'Discard leaves no dirty settings behind')
        assert.equal(JSON.stringify(nodes).includes(mod.__test.en.unsaved), false)
        mode.props.onChange('unlimited')
        phase = 5
        return false
      }
      if (phase === 5) {
        const rendered = JSON.stringify(nodes)
        assert.ok(rendered.includes(mod.__test.en.unsaved))
        assert.equal(nodes.some(node => node.props?.className === 'mse-ok'
          && labelOf(node) === mod.__test.en.saved), false,
          'the second draft also hides stale success before it is saved')
        assert.equal(save.props.disabled, false)
        save.props.onClick()
        phase = 6
        return false
      }
      if (phase === 6) {
        const saved = nodes.some(node => node.props?.className === 'mse-ok'
          && labelOf(node) === mod.__test.en.saved)
        if (snapshot.value.evaluationBudgetMode !== 'unlimited' || !saved
          || !statusModes.includes('unlimited')) return false
        phase = 7
        return true
      }
      return true
    })
  assert.equal(phase, 7)
  assert.deepEqual(writes, [
    { revision: 1, ops: [{ op: 'set', path: ['evaluationTokensPerDay'], value: 60_000 }] },
    { revision: 2, ops: [{ op: 'set', path: ['evaluationBudgetMode'], value: 'unlimited' }] },
  ])
  assert.equal(snapshot.revision, 3)
  assert.equal(snapshot.value.evaluationTokensPerDay, 60_000)
  assert.equal(snapshot.value.evaluationBudgetMode, 'unlimited')
})

test('the budget usage disclosure reads the paidBudget projection from control status', async () => {
  const { registration, module: mod } = loadClient()
  const markerTime = Date.UTC(2030, 0, 2, 3, 4)
  // This is synthetic data with the public status response shape; no private receipt values enter
  // the test. paidBudget is a sibling of budget in settingsSnapshot(), not a child of budget.
  const paidBudget = { state: 'cost_unknown', window: 'rolling_24h', coversTasks: ['model_review', 'objective_evaluation'],
    tokensPerDay: 50_000, callsPerDay: 5, tokensReserved: 12_345, tokensKnown: 9_876,
    callsUsed: 2, requestsUsed: 7, tasksUnknown: 1, jobsOpen: 1, nextAvailableAt: markerTime,
    known: false, remainingTokens: 37_655, remainingCalls: 3 }
  const status = { ok: true, code: null, version: '0.9.1-test', generatedAt: markerTime,
    settings: { budget: { evaluationTokensPerDay: 50_000, evaluationCallsPerDay: 5 }, paidBudget,
      review: { usedLast24h: 1, perDay: 3 } },
    runtime: { jobs: [{}] } }
  const call = async method => ({ ok: true, value: method === 'overview'
    ? { ok: true, version: 'test', runtime: 'dsh', budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 },
      counts: {}, store: { readable: true, schema: 2 } }
    : { ok: true, sessions: [] } })
  const control = async method => ({ ok: true, value: method === 'status' ? status : { ok: true } })
  const tree = await renderPanel(registration, { locale: 'zh', initialTab: 'budget', call, control, form: RENDER_FORM })
  const disclosure = elementsOf(tree).find(node => node.type === 'details' && node.props['data-mse-disclosure'] === 'usage')
  assert.ok(disclosure, 'the usage and calculation disclosure is rendered')
  const rendered = JSON.stringify(disclosure)
  for (const value of ['12345', '9876', '2 次', '7 次', '1', mod.__test.formatTime(markerTime, 'zh'), '费用未知']) {
    assert.ok(rendered.includes(value), `the control projection value ${value} is rendered`)
  }
  assert.ok(rendered.includes('预算已占用（保守）'), 'reserved budget is labelled separately from measured usage')
  assert.ok(rendered.includes('已测 token'), 'measured usage keeps its own label')
  assert.ok(rendered.includes('1'), 'the unknown task count is visible')

  const incomplete = { ...status, settings: { ...status.settings,
    paidBudget: { ...paidBudget, tokensKnown: null, nextAvailableAt: null } } }
  const incompleteControl = async method => ({ ok: true, value: method === 'status' ? incomplete : { ok: true } })
  const incompleteTree = await renderPanel(registration, { locale: 'zh', initialTab: 'budget', call,
    control: incompleteControl, form: RENDER_FORM })
  const incompleteDisclosure = elementsOf(incompleteTree)
    .find(node => node.type === 'details' && node.props['data-mse-disclosure'] === 'usage')
  assert.ok(JSON.stringify(incompleteDisclosure).includes(mod.__test.zh.notReported),
    'a missing measured-use field stays unreported instead of becoming zero')
  assert.ok(JSON.stringify(incompleteDisclosure).includes(mod.__test.zh.notRecorded),
    'a missing next-available timestamp stays unrecorded')
  const englishTree = await renderPanel(registration, { locale: 'en', initialTab: 'budget', call, control, form: RENDER_FORM })
  const englishDisclosure = elementsOf(englishTree)
    .find(node => node.type === 'details' && node.props['data-mse-disclosure'] === 'usage')
  const englishRendered = JSON.stringify(englishDisclosure)
  assert.ok(englishRendered.includes('Budget reserved (conservative)'))
  assert.ok(englishRendered.includes('Measured tokens'))
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

test('the scope picker leads with the conversation title and keeps the id as the value', () => {
  const { module: mod } = loadClient()
  const { zh, en, sessionOptions, sessionShortId } = mod.__test
  const rows = [
    { id: 'session-aaaabbbb-1111', title: '重构召回排序', label: 'learning-product', scope: 'project', live: true },
    { id: 'session-ccccdddd-2222', title: '部署脚本整理', label: 'learning-product', scope: 'project', live: true },
    { id: 'session-eeeeffff-3333', title: null, label: 'learning-product', scope: 'project', live: true },
  ]
  const options = sessionOptions(zh, { ok: true, sessions: rows })
  assert.equal(options[0].label, zh.scopeDefault, 'the default scope stays first')
  assert.deepEqual(options.slice(1).map(option => option.id), rows.map(row => row.id),
    'every row still selects by the real Host id')
  assert.ok(options[1].label.startsWith('重构召回排序'), options[1].label)
  assert.ok(options[2].label.startsWith('部署脚本整理'), options[2].label)
  assert.ok(!options[1].label.startsWith('learning-product'), 'the project name is no longer the leading text')
  assert.ok(options[1].label.includes(zh.scopeProject) && options[1].label.includes('learning-product'),
    'the project and mode stay as secondary information')
  assert.ok(options[3].label.startsWith(zh.untitledConversation), options[3].label)
  assert.equal(/session-/u.test(options[3].label), false, 'the shared id prefix is never shown')
  assert.ok(options[3].label.includes(sessionShortId(rows[2].id)), options[3].label)
  // English carries the same key with its own wording.
  assert.ok(sessionOptions(en, { ok: true, sessions: rows })[3].label.startsWith(en.untitledConversation))
  assert.notEqual(zh.untitledConversation, en.untitledConversation)
})

test('one title, two conversations: a short id disambiguates inside and across projects', () => {
  const { module: mod } = loadClient()
  const { zh, sessionOptions, sessionShortId } = mod.__test
  const rows = [
    { id: 'session-aaaa1111-0001', title: '修复导出', label: 'alpha', scope: 'project' },
    { id: 'session-bbbb2222-0002', title: '修复导出', label: 'alpha', scope: 'project' },
    { id: 'session-cccc3333-0003', title: '修复导出', label: 'beta', scope: 'project' },
    { id: 'session-dddd4444-0004', title: '唯一的标题', label: 'beta', scope: 'project' },
  ]
  const labels = sessionOptions(zh, { ok: true, sessions: rows }).slice(1).map(option => option.label)
  const ids = rows.map(row => sessionShortId(row.id))
  assert.equal(new Set(labels).size, labels.length, 'every displayed row is distinguishable')
  for (const index of [0, 1, 2]) assert.ok(labels[index].includes(ids[index]), labels[index])
  assert.equal(labels[3].includes(ids[3]), false, 'a unique title needs no id')
  // A short id that would collide is extended until it does not.
  const collide = [
    { id: 'session-abcd1111-0001', title: '同名', label: 'p', scope: 'project' },
    { id: 'session-abcd2222-0002', title: '同名', label: 'p', scope: 'project' },
  ]
  const collided = sessionOptions(zh, { ok: true, sessions: collide }).slice(1).map(option => option.label)
  assert.equal(new Set(collided).size, 2, collided.join(' | '))
  assert.notEqual(sessionShortId(collide[0].id), sessionShortId(collide[1].id))
})

test('two standard UUID-style ids that differ only in the last character stay distinguishable', () => {
  const { module: mod } = loadClient()
  const { zh, sessionOptions, sessionShortId } = mod.__test
  // The exact independent counterexample: same title, same project, a standard 36-character body,
  // identical everywhere except the final character.
  const first = 'session-11111111-1111-4111-8111-111111111111'
  const second = 'session-11111111-1111-4111-8111-111111111112'
  assert.equal(sessionShortId(first), sessionShortId(second),
    'the default short form genuinely cannot tell these apart — that is why it must extend')
  const labels = sessionOptions(zh, { ok: true, sessions: [
    { id: first, title: '同一个标题', label: 'alpha', scope: 'project' },
    { id: second, title: '同一个标题', label: 'alpha', scope: 'project' }] }).slice(1).map(option => option.label)
  assert.equal(new Set(labels).size, 2, `UUID tails must differ: ${labels.join(' | ')}`)
  assert.ok(labels[0].startsWith('同一个标题 '), labels[0])
  assert.ok(labels[0].includes('11111111-1111-4111-8111-111111111111'), labels[0])
  assert.ok(labels[1].includes('11111111-1111-4111-8111-111111111112'), labels[1])
  assert.equal(labels[0].startsWith('session-'), false, 'the shared prefix is not the discriminator')
  assert.equal(labels[1].startsWith('session-'), false, 'the shared prefix is not the discriminator')
  // A bucket of three, and a stripped form that collides completely: the COMPLETE original id is
  // then the only truthful discriminator (a shared prefix never counts as a difference).
  const triple = sessionOptions(zh, { ok: true, sessions: [
    { id: 'session-aaaaaaaa-1111-4111-8111-111111111111', title: '三连', label: 'p', scope: 'project' },
    { id: 'session-aaaaaaaa-1111-4111-8111-111111111112', title: '三连', label: 'p', scope: 'project' },
    { id: 'session-aaaaaaaa-1111-4111-8111-111111111113', title: '三连', label: 'p', scope: 'project' }] })
    .slice(1).map(option => option.label)
  assert.equal(new Set(triple).size, 3, triple.join(' | '))
  const sameBody = sessionOptions(zh, { ok: true, sessions: [
    { id: 'session-abcdefgh', title: '去前缀同体', label: 'p', scope: 'project' },
    { id: 'abcdefgh', title: '去前缀同体', label: 'p', scope: 'project' }] })
    .slice(1).map(option => option.label)
  assert.equal(new Set(sameBody).size, 2, sameBody.join(' | '))
  assert.ok(sameBody[0].includes('session-abcdefgh'), sameBody[0])
})

test('a rename changes the label and nothing else, and hostile titles stay plain text', () => {
  const { module: mod } = loadClient()
  const { zh, sessionOptions, sessionShortId } = mod.__test
  const before = sessionOptions(zh, { ok: true, sessions: [
    { id: 'session-11112222-0001', title: '旧标题', label: 'alpha', scope: 'project', archived: true, running: true }] })
  const after = sessionOptions(zh, { ok: true, sessions: [
    { id: 'session-11112222-0001', title: '新标题', label: 'alpha', scope: 'project', archived: true, running: true }] })
  assert.equal(before[1].id, after[1].id, 'a rename never changes the selection value')
  assert.ok(before[1].label.startsWith('旧标题') && after[1].label.startsWith('新标题'))
  assert.ok(after[1].label.includes(zh.scopeArchived) && after[1].label.includes(zh.scopeRunning))
  // The label is a plain string: markup and emoji are rendered as characters, never interpreted.
  const hostile = sessionOptions(zh, { ok: true, sessions: [
    { id: 'session-33334444-0001', title: '<img src=x onerror=alert(1)> 📊', label: 'alpha', scope: 'project' }] })
  assert.equal(typeof hostile[1].label, 'string')
  assert.ok(hostile[1].label.startsWith('<img src=x onerror=alert(1)> 📊'), hostile[1].label)
  assert.equal(hostile[1].label.includes('\u0000'), false)
  // A long title is NOT truncated in JavaScript: the client keeps the whole string (CSS ellipsis
  // and the native tooltip handle narrow windows), so nothing is cut mid-glyph.
  const longTitle = '长'.repeat(400)
  const long = sessionOptions(zh, { ok: true, sessions: [
    { id: 'session-55556666-0001', title: longTitle, label: 'alpha', scope: 'project' }] })
  assert.equal(long[1].label.startsWith(longTitle), true, 'the full title survives to the option')
  assert.equal(long[1].label.includes('…'), false, 'the client adds no truncation marker of its own')
  // Two DIFFERENT long titles sharing a prefix stay distinguishable: grouping is done on the full
  // final visible title, so they collide and both receive a short id.
  const shared = '前缀'.repeat(40)
  const pair = sessionOptions(zh, { ok: true, sessions: [
    { id: 'session-aaaabbbb-0001', title: shared + '甲', label: 'alpha', scope: 'project' },
    { id: 'session-ccccdddd-0002', title: shared + '乙', label: 'alpha', scope: 'project' }] })
  assert.equal(new Set(pair.slice(1).map(option => option.label)).size, 2, 'prefix twins stay distinct')
  assert.equal(pair[1].label.includes('甲') && pair[2].label.includes('乙'), true, 'each keeps its own tail')
  // An emoji-terminated title survives whole (no lone surrogate, no dropped glyph).
  const emoji = sessionOptions(zh, { ok: true, sessions: [
    { id: 'session-eeeeffff-0001', title: '图表 📊', label: 'alpha', scope: 'project' }] })
  assert.equal(emoji[1].label.startsWith('图表 📊'), true)
  assert.equal(/[\uD800-\uDFFF]/u.test([...emoji[1].label].filter(char => char.length === 2).join('')), false,
    'the pair is intact')
  const missing = sessionOptions(zh, { ok: true, sessions: [
    { id: 'session-77778888-0001', title: '   ', label: 'alpha', scope: 'project' },
    { id: 'session-99990000-0001', label: 'alpha', scope: 'project' }] })
  for (const option of missing.slice(1)) {
    assert.ok(option.label.startsWith(zh.untitledConversation), option.label)
    assert.ok(option.label.includes(sessionShortId(option.id)), option.label)
  }
  // A title that is not the wire string (an older producer, or a folded object) is "untitled":
  // it must never be rendered as "[object Object]".
  const notAString = sessionOptions(zh, { ok: true, sessions: [
    { id: 'session-abcabcab-0001', title: { title: '折叠快照' }, label: 'alpha', scope: 'project' }] })
  assert.ok(notAString[1].label.startsWith(zh.untitledConversation), notAString[1].label)
  assert.equal(notAString[1].label.includes('object'), false)
  // A directory failure is still reported as unknown, never as an empty title list.
  assert.equal(sessionOptions(zh, { ok: false, code: 'session_directory_failed' })[1].label, zh.scopeUnknown)
  assert.deepEqual(sessionOptions(zh, null), [{ id: '', label: zh.scopeDefault }])
  assert.equal(sessionShortId(undefined), '—')
  assert.equal(sessionShortId('plain-id-1234'), 'plain-')
})

// ---------------------------------------------------------------- whole library and progress


/** The rendered `<b>` values, in depth-first order: exactly the metric grid's numbers. */
const boldValues = tree => elementsOf(tree).filter(node => node.type === 'b').map(node => (node.children ?? []).join(''))

/** The Chinese dictionary, for assertions about the wording a render must produce. */
const ZH_DICT = loadClient().module.__test.zh

const FULL_LIBRARY = Object.freeze({ readable: true, total: 23, corrections: 4, methods: 19, candidate: 6, tested: 1,
  trial: 2, validated: 11, adopted: 9, reviewed: 3, suspended: 1, experiments: 12, storeCap: 300, scanned: 23,
  complete: true, partial: false, unattributed: 0, code: null })

/** The r0 partial fixture: alpha's 11 rows scanned, beta's 12 rows not attributable. */
const PARTIAL_LIBRARY = Object.freeze({ readable: true, total: 23, corrections: 5, methods: 6, candidate: 9, tested: 0,
  trial: 0, validated: 0, adopted: 0, reviewed: 0, suspended: 0, experiments: 0, storeCap: 300, scanned: 11,
  complete: false, partial: true, unattributed: 12, code: null })

test('the whole-library block reports real numbers and never a fabricated zero', () => {
  const { module: mod } = loadClient()
  const { zh, en, libraryMetrics, scopeNumbers, scopeGuideRows } = mod.__test
  const labels = libraryMetrics(zh, { library: FULL_LIBRARY }).map(row => row.label)
  assert.deepEqual(labels, ['库内合计', '纠错记录', '方法', '待评审/待验证', '试用中（未验证）', '已验证', '实际采用'])
  // "Awaiting review/validation" is the two statuses the core keeps apart: candidate + tested.
  assert.deepEqual(libraryMetrics(zh, { library: FULL_LIBRARY }).map(row => row.value),
    ['23', '4', '19', '7', '2', '11', '9'])
  // Unread, absent or unreadable: every value is the unknown dash, and never a zero.
  for (const payload of [undefined, null, {}, { library: null },
    { library: { readable: false, code: 'store_unavailable' } }, { library: { readable: true } }]) {
    const values = libraryMetrics(zh, payload).map(row => row.value)
    assert.equal(values.every(value => value === '—'), true, JSON.stringify(values))
    assert.equal(values.includes('0'), false, 'an unread library is never an empty one')
  }
  // A PARTIAL read: the scan-derived categories are lower bounds ("at least N"), a scanned zero
  // there is unknown, and the whole-store totals/status counts stay exact — the r0 P2 defect was
  // showing 5/6 beside a whole-store 23 as if both were complete.
  const partialMetrics = libraryMetrics(zh, { library: PARTIAL_LIBRARY })
  assert.deepEqual(partialMetrics.map(row => row.value), ['23', '至少 5', '至少 6', '9', '—', '0', '0'])
  assert.deepEqual(partialMetrics.filter(row => row.partial).map(row => row.key), ['corrections', 'methods', 'trial'])
  assert.equal(partialMetrics[0].partial, false, 'a whole-store total is not downgraded')
  assert.deepEqual(libraryMetrics(en, { library: PARTIAL_LIBRARY }).map(row => row.value),
    ['23', 'at least 5', 'at least 6', '9', '—', '0', '0'])
  // Nothing could be attributed at all: the categories are UNKNOWN, never "the library has none".
  const orphan = libraryMetrics(zh, { library: { ...PARTIAL_LIBRARY, corrections: 0, methods: 0, scanned: 0,
    unattributed: 23 } })
  assert.deepEqual(orphan.map(row => row.value), ['23', '—', '—', '9', '—', '0', '0'])
  assert.equal(orphan.map(row => row.value).includes('0'), true, 'the real status zeros stay')
  // A half-published block leaves the missing half unknown instead of adding a zero to a real one.
  assert.deepEqual(libraryMetrics(zh, { library: { readable: true, total: 5, corrections: 2, methods: 3, candidate: 1 } })
    .map(row => row.value), ['5', '2', '3', '—', '—', '—', '—'])
  // The selected project's own numbers follow the same rule — a PUBLISHED zero is shown as 0.
  assert.deepEqual(scopeNumbers(zh, { counts: { scopeLessons: 3, activeCorrections: 2, methodsUnvalidated: 1,
    methodsValidated: 0 } }).map(row => row.value), ['3', '2', '1', '0'])
  assert.deepEqual(scopeNumbers(zh, null).map(row => row.value), ['—', '—', '—', '—'])
  assert.deepEqual(scopeNumbers(zh, { counts: null }).map(row => row.value), ['—', '—', '—', '—'])
  // The guide: one label + count per project, and a count the Host did not send stays unknown.
  const rows = scopeGuideRows(zh, { projects: [{ label: 'alpha', scopeHash: 'aaaa', lessons: 3 },
    { label: 'beta', scopeHash: 'bbbb', lessons: 1 }, { lessons: 2 }, { label: 'x', scopeHash: 'cccc', lessons: 'many' }] })
  assert.deepEqual(rows.map(row => `${row.label}:${row.count}`),
    ['alpha:3', 'beta:1', '项目作用域:2', 'x:—'])
  assert.deepEqual(scopeGuideRows(zh, null), [])
  assert.deepEqual(scopeGuideRows(en, { projects: [{ label: 'alpha', scopeHash: 'a', lessons: 3 }] })[0].label, 'alpha')
  // English carries every key with its own wording.
  assert.deepEqual(libraryMetrics(en, { library: FULL_LIBRARY }).map(row => row.label),
    ['Library total', 'Corrections', 'Methods', 'Awaiting review/validation', 'On trial (unverified)', 'Validated',
      'Actually adopted'])
})

test('a lesson row shows its stage, processing times, model, budget and non-promotion reason', () => {
  const { module: mod } = loadClient()
  const { zh, en, lessonProgress, progressLine, notPromotedReason } = mod.__test
  const row = { id: 'lesson_abc', kind: 'method', status: 'candidate', stage: 'queued', attempts: 1, maxAttempts: 2,
    updatedAt: Date.UTC(2030, 0, 2, 3, 4), nextAttemptAt: Date.UTC(2030, 0, 3, 3, 4), reason: 'review_budget_tokens',
    lastError: null, route: { provider: 'openai', model: 'gpt-x' },
    budget: { reviewRunTokens: 4000, holding: false }, review: null, trial: null, validation: null }
  const progress = lessonProgress(zh, row, 'zh')
  assert.equal(progress.stage, '排队中')
  assert.equal(progress.attempts, '1/2')
  assert.equal(progress.model, 'openai/gpt-x')
  assert.equal(progress.budget, '每次评审预留 4000 tokens')
  assert.notEqual(progress.last, '—', 'the last processing time is shown')
  assert.notEqual(progress.next, '—', 'the next attempt is shown')
  const line = progressLine(zh, row, 'zh')
  for (const part of ['阶段', '排队中', '上次处理', '下次处理', '模型', 'openai/gpt-x', '评审预算', '4000',
    '未晋升原因']) {
    assert.ok(line.includes(part), `${part} in ${line}`)
  }
  // A row with no plan says so: nothing is derived from the row's own status.
  const bare = lessonProgress(zh, { status: 'candidate' }, 'zh')
  assert.equal(bare.stage, zh.noPlan)
  assert.equal(bare.attempts, '—')
  assert.equal(bare.last, '—')
  assert.equal(bare.next, '—')
  assert.equal(bare.model, zh.notRecorded)
  assert.equal(bare.budget, zh.notRecorded)
  assert.equal(bare.reason, zh.reasonNotRecorded)
  assert.equal(bare.review, '—')
  assert.equal(bare.trial, '—')
  assert.equal(lessonProgress(zh, undefined, 'zh').stage, zh.noPlan)
  // Only a RUNNING plan holds a reservation, and the label says which row holds it.
  assert.equal(lessonProgress(zh, { ...row, stage: 'running', budget: { reviewRunTokens: 4000, holding: true } }, 'zh').budget,
    `每次评审预留 4000 tokens（本行正在使用）`)
  assert.equal(lessonProgress(zh, { ...row, budget: { reviewRunTokens: null, holding: false } }, 'zh').budget, zh.notRecorded)
  assert.equal(lessonProgress(zh, { ...row, route: { provider: '', model: '' } }, 'zh').model, zh.notRecorded)
  // The reason is a stored fact, in order of authority; a validated row is not unpromoted at all.
  assert.equal(notPromotedReason(zh, { status: 'candidate', reason: 'review_budget_tokens' }), 'review_budget_tokens')
  assert.equal(notPromotedReason(zh, { status: 'candidate', review: { reasons: ['review_unsafe_suggestion'] } }),
    'review_unsafe_suggestion')
  assert.equal(notPromotedReason(zh, { status: 'suspended', suspensionReason: 'regression' }), 'regression')
  assert.equal(notPromotedReason(zh, { status: 'candidate', trial: { reason: 'trial_withdrawn' } }), 'trial_withdrawn')
  assert.equal(notPromotedReason(zh, { status: 'validated', reason: 'review_budget_tokens' }), zh.promoted)
  assert.equal(notPromotedReason(zh, { status: 'candidate' }), zh.reasonNotRecorded)
  // English wording, same facts.
  assert.equal(lessonProgress(en, row, 'en').stage, 'Queued')
  assert.equal(lessonProgress(en, row, 'en').budget, 'reserves 4000 tokens per review')
  assert.equal(lessonProgress(en, { status: 'tested', review: { state: 'reviewed' } }, 'en').review, 'Reviewed (trial only)')
})

test('the in-process session counter is unknown when unread and never reported as history', () => {
  const { module: mod } = loadClient()
  const { observedSessions } = mod.__test
  assert.equal(observedSessions({ sessionsObserved: 3 }, null), 3)
  assert.equal(observedSessions({ turnsObserved: 0 }, null), 0, 'a real zero survives as zero')
  assert.equal(observedSessions({}, { runtime: { turnsObserved: 5 } }), 5, 'the control card is the fallback surface')
  assert.equal(observedSessions({ sessionsObserved: null, turnsObserved: null }, { runtime: {} }), null)
  assert.equal(observedSessions(undefined, undefined), null)
  assert.equal(observedSessions({ turnsObserved: -1 }, null), null, 'a negative count is not history either')
  assert.equal(observedSessions({ turnsObserved: 7.6 }, null), 7)
  assert.equal(observedSessions({ sessionsObserved: 2, turnsObserved: 9 }, null), 2,
    'the accurate name wins over the historical one')
})

test('both dictionaries carry the whole-library and progress keys, with their own wording', () => {
  const { module: mod } = loadClient()
  const { zh, en } = mod.__test
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'the key sets stay identical')
  const keys = ['libraryTitle', 'libraryNote', 'libraryCorrections', 'libraryAwaiting', 'libraryTrial',
    'libraryValidated', 'libraryAdopted', 'libraryUnreadable', 'libraryPartial', 'selectedProjectTitle',
    'selectedProjectNone', 'selectedProjectBoth', 'scopeCountsNote', 'scopeGuideTitle', 'scopeGuideNote',
    'scopeGuideMore', 'completeLibrary', 'progressStage', 'progressLast', 'progressNext', 'progressModel',
    'progressBudget', 'progressReason', 'progressAttempts', 'noPlan', 'promoted', 'reasonNotRecorded',
    'budgetReviewRun', 'budgetHolding', 'reviewState', 'trialState', 'validationDomain', 'turnsObservedMeaning',
    'runsObservedMeaning', 'autoQueue', 'autoReason', 'scopeScanLimited', 'libraryPartialCats', 'atLeast',
    'owningScope', 'verifySession', 'verifySessionHint', 'verifySessionNone', 'verifySessionNoneShort',
    'verifySessionNoneHint', 'verifySessionReady', 'verifySessionMissing', 'verifySessionMissingShort',
    'verifySessionUnknown', 'verifySessionUnverified']
  for (const key of keys) {
    assert.ok(Object.hasOwn(zh, key) && Object.hasOwn(en, key), `both dictionaries carry ${key}`)
    assert.notEqual(zh[key], en[key], `${key} is translated, not copied`)
  }
  for (const group of ['stageNames', 'reviewNames', 'trialNames']) {
    assert.deepEqual(Object.keys(zh[group]).sort(), Object.keys(en[group]).sort(), `${group} keys`)
  }
  assert.deepEqual(Object.keys(zh.stageNames).sort(), ['blocked', 'done', 'failed', 'interrupted', 'queued', 'running'])
  assert.deepEqual(Object.keys(zh.reviewNames).sort(), ['inconclusive', 'rejected', 'reviewed'])
  assert.deepEqual(Object.keys(zh.trialNames).sort(), ['trial', 'withdrawn'])
  // The historical counter's wording states what it counts, so a restart cannot read as
  // "the library is empty".
  assert.ok(Object.hasOwn(zh.codeNames, 'lesson_unattributable') && Object.hasOwn(en.codeNames, 'lesson_unattributable'))
  assert.ok(Object.hasOwn(zh.codeNames, 'lesson_scope_ambiguous') && Object.hasOwn(en.codeNames, 'lesson_scope_ambiguous'))
  assert.ok(zh.atLeast.includes('{n}') && en.atLeast.includes('{n}'), 'the lower-bound template keeps its number')
  assert.ok(zh.runsObserved.includes('{n}') && zh.runsObserved.includes('会话'))
  assert.ok(zh.runsObserved.includes('不是回合数'))
  assert.ok(en.runsObserved.includes('{n}') && en.runsObserved.includes('not turns'))
})

/** The fake Host the render tests drive: one dispatcher, no fabricated payloads. */
const hostCalls = payloads => async (method, input) => ({ ok: true, value: method === 'overview' ? payloads.overview
  : method === 'sessions' ? payloads.sessions ?? { ok: true, sessions: [] }
    : method === 'lessons' ? payloads.lessons
      : method === 'recall' ? { ok: true, memory: 'in-process', scope: null, recent: [], last: null,
        settlement: { live: [] }, session: null }
        : { ok: true } })

const RENDER_FORM = { getSnapshot: () => ({ status: 'ready', writable: true, mode: 'host', revision: 1,
  value: { ...READY_VALUES } }), subscribe: () => () => {}, mutate: () => true }

test('decision model settings preserve remote drafts across Host and bind legacy refs across route changes', async () => {
  const { registration, module: mod } = loadClient()
  const remoteValues = { ...READY_VALUES, decisionBackend: 'laya', decisionModel: ` ${'model-'.repeat(15)} `,
    decisionEndpoint: ` https://example.test/${'route/'.repeat(90)} `, decisionSecretRef: 'MSE_DECISION_KEY' }
  let snapshot = { status: 'ready', writable: true, mode: 'host', revision: 37, value: remoteValues }
  const writes = []
  const form = { getSnapshot: () => snapshot, subscribe: () => () => {},
    mutate: async (ops, revision) => { writes.push({ ops, revision }); return true } }
  const call = hostCalls({ overview: { ok: true, version: 'test', runtime: 'dsh',
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, counts: {},
    store: { readable: true, schema: 2 } } })
  let phase = 0
  await renderPanel(registration, { locale: 'zh', initialTab: 'budget', call, control: undefined, form }, 20,
    ({ nodes }) => {
      const picker = nodes.find(node => typeof node.type === 'function' && node.props?.testId === 'decision-source')
      if (picker === undefined) return false
      const decisionInputs = nodes.filter(node => node.type?.uiName === 'Input'
        && node.props?.className === 'mse-decision-input')
      if (phase === 0) {
        assert.equal(picker.props.label, mod.__test.zh.decisionBackend)
        assert.equal(picker.props.disabled, false)
        const visibleSourceLabel = nodes.find(node => node.props?.className === 'mse-decision-source-label')
        assert.equal(visibleSourceLabel.children[0], mod.__test.zh.decisionBackend)
        const modelHeading = nodes.find(node => node.props?.key === 'decision-title')
        assert.ok(JSON.stringify(modelHeading).includes(mod.__test.zh.decisionModel))
        assert.deepEqual(picker.props.options.map(option => option.label), [mod.__test.zh.decisionBackendHost,
          mod.__test.zh.decisionBackendOpenAI, mod.__test.zh.decisionBackendJev, mod.__test.zh.decisionBackendLaya])
        assert.equal(decisionInputs.length, 4)
        assert.deepEqual(decisionInputs.map(node => node.props['aria-label']).sort(), [mod.__test.zh.decisionModelField,
          mod.__test.zh.decisionEndpoint, mod.__test.zh.decisionApiKey, mod.__test.zh.decisionSecretRef].sort())
        assert.equal(decisionInputs.find(node => node.props['aria-label'] === mod.__test.zh.decisionApiKey).props.type,
          'password', 'the API key is entered in a masked field')
        picker.props.onChange('host')
        phase = 1
        return false
      }
      if (phase === 1) {
        assert.equal(decisionInputs.length, 0, 'Host hides model, endpoint and secret fields')
        const status = nodes.find(node => node.props?.className === 'mse-decision-status')
        assert.ok(status)
        assert.equal(status.children[0], mod.__test.zh.decisionHostCapability)
        assert.ok(status.children[0].includes('使用经验来源会话的模型，无需单独配置'))
        const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === mod.__test.zh.save)
        if (save === undefined || save.props.disabled) return false
        save.props.onClick()
        phase = 2
        return false
      }
      if (phase === 2) {
        if (writes.length === 0) return false
        assert.deepEqual(writes[0], { revision: 37, ops: [
          { op: 'set', path: ['decisionBackend'], value: 'host' },
          { op: 'set', path: ['decisionSecretBinding'], value: JSON.stringify(['laya', remoteValues.decisionEndpoint.trim()]) },
        ] })
        picker.props.onChange('laya')
        phase = 3
        return false
      }
      if (phase === 3) {
        const byLabel = new Map(decisionInputs.map(node => [node.props['aria-label'], node.props.value]))
        if (decisionInputs.length !== 4) return false
        assert.equal(byLabel.get(mod.__test.zh.decisionModelField), remoteValues.decisionModel)
        assert.equal(byLabel.get(mod.__test.zh.decisionEndpoint), remoteValues.decisionEndpoint)
        assert.equal(byLabel.get(mod.__test.zh.decisionSecretRef), remoteValues.decisionSecretRef)
        assert.equal(byLabel.get(mod.__test.zh.decisionApiKey), '')
        const status = nodes.find(node => node.props?.className === 'mse-decision-status'
          && node.children?.[0] === mod.__test.zh.decisionRemoteReady)
        assert.equal(status.children[0], mod.__test.zh.decisionRemoteReady)
        assert.ok(mod.__test.en.decisionRemoteReady.includes('not been tested'))
        assert.ok(nodes.some(node => node.props?.className === 'mse-decision-key'), 'the key has its own credential controls')
        assert.ok(nodes.some(node => node.props?.className === 'mse-decision-discovery'), 'the read-only model directory controls render')
        assert.ok(nodes.some(node => node.props?.className === 'mse-budget-picker'), 'budget slider uses its own layout')
        const budgetSlider = nodes.find(node => node.type === 'input' && node.props?.type === 'range'
          && node.props?.className === 'mse-budget-slider')
        assert.ok(budgetSlider, 'budget tier uses a native, accessible range input')
        assert.equal(budgetSlider.props['aria-label'], mod.__test.zh.evalTier)
        assert.equal(budgetSlider.props.step, 'any', 'custom token values can position the thumb between stops')
        assert.equal(typeof budgetSlider.props.onPointerUp, 'function', 'clicking an unchanged custom stop can select its preset')
        assert.equal(budgetSlider.props.value, 0, 'the thumb follows the custom token value without selecting a preset')
        assert.ok(budgetSlider.props['aria-valuetext'].includes(mod.__test.zh.evalTierCustom))
        const budgetInputs = nodes.filter(node => node.type?.uiName === 'Input'
          && node.props?.className === 'mse-budget-value')
        assert.equal(budgetInputs.length, 2)
        assert.match(SOURCE, /\.mse-decision-input\{display:flex;width:100%;min-width:0;max-width:100%;box-sizing:border-box\}/u)
        assert.match(SOURCE, /\.mse-decision-source \.mse-picker-wide\{width:100%;max-width:100%\}/u)
        assert.match(SOURCE, /\.mse-budget-slider::-webkit-slider-thumb\{width:16px;height:16px/u)
        assert.match(SOURCE, /\.mse-budget-slider\{display:block;width:calc\(100% - 18px\);height:36px/u)
        assert.match(SOURCE, /\.mse-budget-ticks\{position:relative;height:21px;margin:2px 17px 0/u)
        assert.match(SOURCE, /\.mse-budget-tick\.is-active\{color:var\(--dsw-alias-state-business-primary\)/u)
        assert.match(SOURCE, /\.mse-budget-values\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u)
        phase = 4
        return true
      }
      return true
    })
  assert.equal(phase, 4, 'the remote → Host → remote interaction completed in the same draft')
  assert.equal(writes.length, 1)

  snapshot = { ...snapshot, writable: false }
  const readOnly = await renderPanel(registration, { locale: 'zh', initialTab: 'budget', call,
    control: undefined, form }, 10)
  const readOnlyPicker = elementsOf(readOnly)
    .find(node => typeof node.type === 'function' && node.props?.testId === 'decision-source')
  assert.equal(readOnlyPicker.props.disabled, true, 'the Host Picker remains disabled without write access')
})

test('a pending API key marks the remote form dirty and Save stores only the credential', async () => {
  const { registration, module: mod } = loadClient()
  const snapshot = { status: 'ready', writable: true, mode: 'host', revision: 88,
    value: { ...REMOTE_READY_VALUES } }
  let mutateCalls = 0
  const form = { getSnapshot: () => snapshot, subscribe: () => () => {},
    mutate: async () => { mutateCalls += 1; return true } }
  const calls = []
  const control = async (method, input) => {
    calls.push({ method, input })
    if (method === 'describeDecisionCredential') return { ok: true, value: { ok: true,
      serviceAvailable: true, configured: false, stored: false, writable: true, legacyConfigured: false } }
    if (method === 'setDecisionCredential') return { ok: true, value: { ok: true,
      configured: true, stored: true } }
    return { ok: true, value: { ok: true } }
  }
  const call = hostCalls({ overview: { ok: true, version: 'test', runtime: 'dsh',
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, counts: {}, store: { readable: true, schema: 2 } } })
  const apiKey = 'synthetic-key-only-save'
  let phase = 0
  await renderPanel(registration, { locale: 'zh', initialTab: 'budget', call, control, form }, 24,
    ({ nodes }) => {
      const key = nodes.find(node => node.type?.uiName === 'Input'
        && node.props?.['aria-label'] === mod.__test.zh.decisionApiKey)
      const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === mod.__test.zh.save)
      if (phase === 0) {
        if (!key || !save) return false
        key.props.onChange({ target: { value: apiKey } })
        phase = 1
        return false
      }
      if (phase === 1) {
        if (!save || save.props.disabled) return false
        assert.ok(JSON.stringify(nodes).includes(mod.__test.zh.unsaved), 'the pending key marks the form unsaved')
        save.props.onClick()
        phase = 2
        return false
      }
      if (phase === 2) {
        if (!calls.some(row => row.method === 'setDecisionCredential') || key?.props.value !== '') return false
        assert.equal(mutateCalls, 0, 'a key-only save does not mutate ordinary configuration')
        phase = 3
        return true
      }
      return true
    }, 230)
  assert.equal(phase, 3)
  assert.equal(mutateCalls, 0)
  const keyWrite = calls.find(row => row.method === 'setDecisionCredential')
  assert.equal(keyWrite?.input.apiKey, apiKey)
  assert.equal(keyWrite?.input.settingsRevision, 88)
  assert.equal(calls.filter(row => row.method === 'setDecisionCredential').length, 1)
})

test('Discard clears a key-only remote draft without saving credentials or starting discovery', async () => {
  const { registration, module: mod } = loadClient()
  const snapshot = { status: 'ready', writable: true, mode: 'host', revision: 89,
    value: { ...REMOTE_READY_VALUES } }
  let mutateCalls = 0
  const form = { getSnapshot: () => snapshot, subscribe: () => () => {},
    mutate: async () => { mutateCalls += 1; return true } }
  const call = hostCalls({ overview: { ok: true, version: 'test', runtime: 'dsh',
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, counts: {}, store: { readable: true, schema: 2 } } })
  const apiKey = 'synthetic-key-discard'
  let phase = 0
  await renderPanel(registration, { locale: 'zh', initialTab: 'budget', call, control: undefined, form }, 20,
    ({ nodes }) => {
      const key = nodes.find(node => node.type?.uiName === 'Input'
        && node.props?.['aria-label'] === mod.__test.zh.decisionApiKey)
      const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === mod.__test.zh.save)
      const discard = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === mod.__test.zh.discard)
      if (phase === 0) {
        if (!key || !save || !discard) return false
        key.props.onChange({ target: { value: apiKey } })
        phase = 1
        return false
      }
      if (phase === 1) {
        if (!key || !save || !discard || save.props.disabled || discard.props.disabled) return false
        assert.ok(JSON.stringify(nodes).includes(mod.__test.zh.unsaved))
        discard.props.onClick()
        phase = 2
        return false
      }
      if (phase === 2) {
        assert.equal(key?.props.value, '')
        assert.equal(save?.props.disabled, true)
        assert.equal(discard?.props.disabled, true)
        assert.equal(mutateCalls, 0)
        phase = 3
        return true
      }
      return true
    })
  assert.equal(phase, 3)
  assert.equal(mutateCalls, 0)
})

test('Discard stays disabled and cannot clear a draft while the settings save is pending', async () => {
  const { registration } = loadClient()
  let snapshot = { status: 'ready', writable: true, mode: 'host', revision: 90, value: { ...READY_VALUES } }
  const listeners = new Set()
  const writes = []
  let resolveMutate
  let mutateCalls = 0
  const form = { getSnapshot: () => snapshot, subscribe: listener => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, mutate: async (ops, revision) => {
      mutateCalls += 1
      writes.push({ ops, revision })
      return new Promise(resolve => { resolveMutate = () => {
        if (revision !== snapshot.revision) { resolve(false); return }
        const value = { ...snapshot.value }
        for (const op of ops) value[op.path[0]] = op.value
        snapshot = { ...snapshot, revision: revision + 1, value }
        for (const listener of listeners) listener()
        resolve(true)
      } })
    } }
  const call = async method => ({ ok: true, value: method === 'overview'
    ? { ok: true, version: 'test', runtime: 'dsh', budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 },
      counts: {}, store: { readable: true, schema: 2 } }
    : { ok: true, sessions: [] } })
  let phase = 0
  await renderPanel(registration, { locale: 'zh', call, control: undefined, form }, 20,
    ({ nodes }) => {
      const input = nodes.find(node => node.type?.uiName === 'Input'
        && node.props?.['aria-label'] === ZH_DICT.contextBytes)
      const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === ZH_DICT.save)
      const discard = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === ZH_DICT.discard)
      if (phase === 0) {
        if (!input) return false
        input.props.onChange({ target: { value: '1024' } })
        phase = 1
        return false
      }
      if (phase === 1) {
        if (!save || save.props.disabled) return false
        save.props.onClick()
        phase = 2
        return false
      }
      if (phase === 2) {
        if (!discard || resolveMutate === undefined) return false
        assert.equal(discard.props.disabled, true)
        assert.equal(mutateCalls, 1)
        discard.props.onClick()
        phase = 3
        return false
      }
      if (phase === 3) {
        if (!input || !discard || resolveMutate === undefined) return false
        assert.equal(input.props.value, '1024', 'a fresh render keeps the draft after the old discard handler')
        assert.equal(discard.props.disabled, true)
        assert.equal(mutateCalls, 1, 'the pending save completes once')
        resolveMutate()
        phase = 4
        return false
      }
      if (phase === 4) {
        // The loop supplies nodes from one render; wait until the async mutation paints success.
        if (mutateCalls !== 1) return false
        const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === ZH_DICT.save)
        const saved = nodes.some(node => node.props?.className === 'mse-ok'
          && node.children?.includes(ZH_DICT.saved))
        if (!saved || save === undefined) return false
        assert.equal(mutateCalls, 1, 'the pending save completes once')
        phase = 5
        return true
      }
      return true
    })
  assert.equal(phase, 5)
  assert.equal(snapshot.revision, 91)
  assert.equal(snapshot.value.maxContextBytes, 1024)
  assert.deepEqual(writes, [{ revision: 90, ops: [{ op: 'set', path: ['maxContextBytes'], value: 1024 }] }])
})

test('budget slider preserves custom values until a tier gesture and saves through the current revision', async () => {
  const { registration, module: mod } = loadClient()
  const customValues = { ...READY_VALUES, evaluationTokensPerDay: 30_000, evaluationCallsPerDay: 3 }
  const snapshot = { status: 'ready', writable: true, mode: 'host', revision: 42, value: customValues }
  const writes = []
  let resolveMutate
  const form = { getSnapshot: () => snapshot, subscribe: () => () => {},
    mutate: async (ops, revision) => {
      writes.push({ ops, revision })
      return new Promise(resolve => { resolveMutate = resolve })
    } }
  const call = hostCalls({ overview: { ok: true, version: 'test', runtime: 'dsh',
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, counts: {},
    store: { readable: true, schema: 2 } } })
  let phase = 0
  await renderPanel(registration, { locale: 'zh', initialTab: 'budget', call, control: undefined, form }, 24,
    ({ nodes }) => {
      const slider = nodes.find(node => node.type === 'input' && node.props?.type === 'range'
        && node.props?.className === 'mse-budget-slider')
      const tokens = nodes.find(node => node.type?.uiName === 'Input'
        && node.props?.['aria-label'] === mod.__test.zh.evalTokens)
      const tasks = nodes.find(node => node.type?.uiName === 'Input'
        && node.props?.['aria-label'] === mod.__test.zh.evalCalls)
      const ticks = nodes.filter(node => node.props?.className?.startsWith('mse-budget-tick'))
      const status = nodes.find(node => node.props?.className === 'mse-budget-status')
      const button = label => nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === label)
      const save = button(mod.__test.zh.save) ?? button(mod.__test.zh.saving)
      const discard = button(mod.__test.zh.discard)
      if (!slider || !tokens || !tasks || !save || !discard) return false
      if (phase === 0) {
        assert.ok(Math.abs(slider.props.value - (4 / 3)) < 1e-9)
        assert.equal(tokens.props.value, '30000')
        assert.equal(tasks.props.value, '3')
        assert.equal(ticks.filter(node => node.props.className.includes('is-active')).length, 0)
        assert.ok(status.children[0].includes(mod.__test.zh.evalTierCustom))
        slider.props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} })
        phase = 1
        return false
      }
      if (phase === 1) {
        assert.equal(tokens.props.value, '20000')
        assert.equal(tasks.props.value, '2')
        slider.props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
        phase = 2
        return false
      }
      if (phase === 2) {
        assert.equal(tokens.props.value, '50000')
        assert.equal(tasks.props.value, '5')
        assert.equal((status.children[0].match(/50K/gu) ?? []).length, 1)
        assert.equal((slider.props['aria-valuetext'].match(/50K/gu) ?? []).length, 1)
        slider.props.onKeyDown({ key: 'Home', preventDefault() {} })
        phase = 3
        return false
      }
      if (phase === 3) {
        assert.equal(tokens.props.value, '0')
        assert.equal(tasks.props.value, '0')
        slider.props.onKeyDown({ key: 'End', preventDefault() {} })
        phase = 4
        return false
      }
      if (phase === 4) {
        assert.equal(tokens.props.value, '200000')
        assert.equal(tasks.props.value, '20')
        discard.props.onClick()
        phase = 5
        return false
      }
      if (phase === 5) {
        assert.equal(tokens.props.value, '30000')
        assert.equal(tasks.props.value, '3')
        assert.ok(Math.abs(slider.props.value - (4 / 3)) < 1e-9)
        assert.equal(ticks.filter(node => node.props.className.includes('is-active')).length, 0)
        slider.props.onChange({ currentTarget: { value: '3' } })
        phase = 6
        return false
      }
      if (phase === 6) {
        assert.equal(tokens.props.value, '100000')
        assert.equal(tasks.props.value, '10')
        assert.equal(ticks.filter(node => node.props.className.includes('is-active')).length, 1)
        assert.equal(save.props.disabled, false)
        save.props.onClick()
        phase = 7
        return false
      }
      if (phase === 7) {
        assert.equal(slider.props.disabled, true, 'save in progress locks the slider')
        assert.equal(tokens.props.disabled, true)
        assert.equal(tasks.props.disabled, true)
        assert.equal(save.props.disabled, true)
        assert.equal(discard.props.disabled, true)
        assert.equal(writes.length, 1)
        assert.equal(writes[0].revision, 42)
        assert.deepEqual(writes[0].ops.map(op => [op.path[0], op.value]), [
          ['evaluationTokensPerDay', 100_000], ['evaluationCallsPerDay', 10],
        ])
        phase = 8
        return true
      }
      return true
    })
  assert.equal(phase, 8)
  resolveMutate(true)
  await new Promise(resolve => setImmediate(resolve))
})

test('budget slider and numeric fields are locked in a read-only settings form', async () => {
  const { registration, module: mod } = loadClient()
  const snapshot = { status: 'ready', writable: false, mode: 'host', revision: 43,
    value: { ...READY_VALUES, evaluationTokensPerDay: 30_000, evaluationCallsPerDay: 3 } }
  let mutateCalls = 0
  const form = { getSnapshot: () => snapshot, subscribe: () => () => {},
    mutate: async () => { mutateCalls += 1; return true } }
  const call = hostCalls({ overview: { ok: true, version: 'test', runtime: 'dsh',
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, counts: {},
    store: { readable: true, schema: 2 } } })
  const tree = await renderPanel(registration, { locale: 'en', initialTab: 'budget', call, control: undefined, form }, 20)
  const nodes = elementsOf(tree)
  const slider = nodes.find(node => node.type === 'input' && node.props?.type === 'range'
    && node.props?.className === 'mse-budget-slider')
  const inputs = nodes.filter(node => node.type?.uiName === 'Input'
    && node.props?.className === 'mse-budget-value')
  assert.ok(slider)
  assert.equal(slider.props.disabled, true)
  assert.equal(inputs.length, 2)
  assert.ok(inputs.every(node => node.props.disabled))
  slider.props.onChange({ currentTarget: { value: '4' } })
  slider.props.onKeyDown({ key: 'End', preventDefault() {} })
  assert.equal(mutateCalls, 0)
})

test('non-preset budget pairs stay exact on render and when an unrelated setting is saved', async () => {
  const { registration, module: mod } = loadClient()
  const call = hostCalls({ overview: { ok: true, version: 'test', runtime: 'dsh',
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, counts: {},
    store: { readable: true, schema: 2 } } })
  for (const [tokensValue, tasksValue] of [[50_000, 2], [250_000, 11]]) {
    const snapshot = { status: 'ready', writable: true, mode: 'host', revision: 44,
      value: { ...READY_VALUES, evaluationTokensPerDay: tokensValue, evaluationCallsPerDay: tasksValue } }
    const form = { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => true }
    const tree = await renderPanel(registration, { locale: 'en', initialTab: 'budget', call, control: undefined, form }, 20)
    const nodes = elementsOf(tree)
    const slider = nodes.find(node => node.type === 'input' && node.props?.className === 'mse-budget-slider')
    const token = nodes.find(node => node.type?.uiName === 'Input'
      && node.props?.['aria-label'] === mod.__test.en.evalTokens)
    const tasks = nodes.find(node => node.type?.uiName === 'Input'
      && node.props?.['aria-label'] === mod.__test.en.evalCalls)
    const status = nodes.find(node => node.props?.className === 'mse-budget-status')
    const activeTicks = nodes.filter(node => node.props?.className?.includes('mse-budget-tick is-active'))
    assert.equal(slider.props.value, tokensValue === 50_000 ? 2 : 4)
    assert.equal(token.props.value, String(tokensValue))
    assert.equal(tasks.props.value, String(tasksValue))
    assert.equal(activeTicks.length, 0)
    assert.ok(status.children[0].includes(mod.__test.en.evalTierCustom))
  }

  const exerciseCustomSteps = async (tokensValue, tasksValue, steps) => {
    const snapshot = { status: 'ready', writable: true, mode: 'host', revision: 44,
      value: { ...READY_VALUES, evaluationTokensPerDay: tokensValue, evaluationCallsPerDay: tasksValue } }
    const form = { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => true }
    let stepIndex = 0
    await renderPanel(registration, { locale: 'en', initialTab: 'budget', call, control: undefined, form }, 24,
      ({ nodes }) => {
        const slider = nodes.find(node => node.type === 'input' && node.props?.className === 'mse-budget-slider')
        const token = nodes.find(node => node.type?.uiName === 'Input'
          && node.props?.['aria-label'] === mod.__test.en.evalTokens)
        const tasks = nodes.find(node => node.type?.uiName === 'Input'
          && node.props?.['aria-label'] === mod.__test.en.evalCalls)
        const discard = nodes.find(node => node.type?.uiName === 'Button'
          && labelOf(node) === mod.__test.en.discard)
        if (!slider || !token || !tasks || !discard) return false
        const expected = stepIndex === 0 ? [tokensValue, tasksValue] : steps[stepIndex - 1].expected
        assert.equal(Number(token.props.value), expected[0])
        assert.equal(Number(tasks.props.value), expected[1])
        if (stepIndex === steps.length) return true
        const step = steps[stepIndex]
        if (step.key !== undefined) slider.props.onKeyDown({ key: step.key, preventDefault() {} })
        else if (step.pointer === true) {
          slider.props.onPointerDown({ button: 0 })
          slider.props.onPointerUp({ button: 0, currentTarget: { value: String(slider.props.value) } })
        }
        else discard.props.onClick()
        stepIndex += 1
        return false
      })
    assert.equal(stepIndex, steps.length)
  }
  await exerciseCustomSteps(30_000, 3, [
    { key: 'ArrowLeft', expected: [20_000, 2] },
    { key: 'ArrowRight', expected: [50_000, 5] },
  ])
  await exerciseCustomSteps(50_000, 2, [
    { pointer: true, expected: [50_000, 5] },
    { discard: true, expected: [50_000, 2] },
    { key: 'ArrowLeft', expected: [20_000, 2] },
    { discard: true, expected: [50_000, 2] },
    { key: 'ArrowRight', expected: [100_000, 10] },
  ])
  await exerciseCustomSteps(250_000, 11, [
    { key: 'ArrowLeft', expected: [200_000, 20] },
    { discard: true, expected: [250_000, 11] },
    { key: 'ArrowRight', expected: [250_000, 11] },
  ])

  let snapshot = { status: 'ready', writable: true, mode: 'host', revision: 45,
    value: { ...READY_VALUES, evaluationTokensPerDay: 50_000, evaluationCallsPerDay: 2 } }
  const writes = []
  const listeners = new Set()
  const form = { getSnapshot: () => snapshot, subscribe: listener => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, mutate: async (ops, revision) => {
    writes.push({ ops, revision })
    if (revision !== snapshot.revision) return false
    const value = { ...snapshot.value }
    for (const op of ops) value[op.path[0]] = op.value
    snapshot = { ...snapshot, revision: revision + 1, value }
    for (const listener of listeners) listener()
    return true
  } }
  let phase = 0
  await renderPanel(registration, { locale: 'en', initialTab: 'budget', call, control: undefined, form }, 20,
    ({ nodes }) => {
      const token = nodes.find(node => node.type?.uiName === 'Input'
        && node.props?.['aria-label'] === mod.__test.en.evalTokens)
      const tasks = nodes.find(node => node.type?.uiName === 'Input'
        && node.props?.['aria-label'] === mod.__test.en.evalCalls)
      const toggle = nodes.find(node => node.type?.uiName === 'Switch'
        && node.props?.label === mod.__test.en.autoValidate)
      const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === mod.__test.en.save)
      if (!token || !tasks || !toggle || !save) return false
      if (phase === 0) {
        assert.equal(token.props.value, '50000')
        assert.equal(tasks.props.value, '2')
        toggle.props.onChange(true)
        phase = 1
        return false
      }
      if (phase === 1) {
        assert.equal(token.props.value, '50000')
        assert.equal(tasks.props.value, '2')
        assert.equal(save.props.disabled, false)
        save.props.onClick()
        phase = 2
        return false
      }
      const saved = nodes.some(node => node.props?.className === 'mse-ok'
        && labelOf(node) === mod.__test.en.saved)
      if (!saved) return false
      assert.equal(token.props.value, '50000')
      assert.equal(tasks.props.value, '2')
      assert.equal(nodes.filter(node => node.props?.className?.includes('mse-budget-tick is-active')).length, 0)
      assert.equal(writes.length, 1)
      assert.equal(writes[0].revision, 45)
      assert.deepEqual(writes[0].ops, [{ op: 'set', path: ['autoValidationEnabled'], value: true }])
      assert.equal(snapshot.value.evaluationTokensPerDay, 50_000)
      assert.equal(snapshot.value.evaluationCallsPerDay, 2)
      phase = 3
      return true
    })
  assert.equal(phase, 3)
  assert.equal(snapshot.revision, 46)
  assert.equal(snapshot.value.autoValidationEnabled, true)
  assert.equal(snapshot.value.evaluationTokensPerDay, 50_000)
  assert.equal(snapshot.value.evaluationCallsPerDay, 2)
})

test('general Save stores a pending remote key before the config CAS and clears it only after the key is stored', async () => {
  const { registration, module: mod } = loadClient()
  let snapshot = { status: 'ready', writable: true, mode: 'host', revision: 81, value: { ...READY_VALUES } }
  const writes = []
  const order = []
  const form = { getSnapshot: () => snapshot, subscribe: () => () => {},
    mutate: async (ops, revision) => { order.push('config'); writes.push({ ops, revision }); return true } }
  const calls = []
  let resolveKeyWrite
  const control = async (method, input) => {
    calls.push({ method, input })
    if (method === 'setDecisionCredential') {
      order.push('credential')
      return new Promise(resolve => { resolveKeyWrite = () => resolve({ ok: true,
        value: { ok: true, configured: true, stored: true } }) })
    }
    if (method === 'describeDecisionCredential') return { ok: true, value: { ok: true,
      serviceAvailable: true, configured: false, stored: false, writable: true, legacyConfigured: false } }
    return { ok: true, value: { ok: true } }
  }
  const call = hostCalls({ overview: { ok: true, version: 'test', runtime: 'dsh',
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, counts: {}, store: { readable: true, schema: 2 } } })
  const apiKey = 'synthetic-key-for-general-save'
  let phase = 0
  await renderPanel(registration, { locale: 'zh', initialTab: 'budget', call, control, form }, 24,
    ({ nodes }) => {
      if (phase === 0) {
        const source = nodes.find(node => typeof node.type === 'function' && node.props?.testId === 'decision-source')
        if (source === undefined) return false
        source.props.onChange('openai_compatible')
        phase = 1
        return false
      }
      const inputFor = label => nodes.find(node => node.type?.uiName === 'Input' && node.props?.['aria-label'] === label)
      if (phase === 1) {
        const model = inputFor(mod.__test.zh.decisionModelField)
        const endpoint = inputFor(mod.__test.zh.decisionEndpoint)
        const key = inputFor(mod.__test.zh.decisionApiKey)
        if (!model || !endpoint || !key) return false
        endpoint.props.onChange({ target: { value: 'https://api.example.test/v1' } })
        model.props.onChange({ target: { value: 'gpt-synthetic' } })
        key.props.onChange({ target: { value: apiKey } })
        phase = 2
        return false
      }
      if (phase === 2) {
        const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === mod.__test.zh.save)
        if (!save || save.props.disabled) return false
        save.props.onClick()
        phase = 3
        return false
      }
      if (phase === 3) {
        const key = inputFor(mod.__test.zh.decisionApiKey)
        if (!key || key.props.disabled !== true || resolveKeyWrite === undefined) return false
        assert.equal(writes.length, 0, 'the config CAS waits for the credentials write')
        assert.equal(calls.find(row => row.method === 'setDecisionCredential')?.input.apiKey, apiKey)
        resolveKeyWrite()
        phase = 4
        return false
      }
      if (phase === 4) {
        const key = inputFor(mod.__test.zh.decisionApiKey)
        if (writes.length !== 1 || key?.props.value !== '') return false
        phase = 5
        return true
      }
      return true
    })
  assert.equal(phase, 5)
  assert.deepEqual(order, ['credential', 'config'], 'the Host stores the key before the route settings CAS')
  assert.equal(writes[0].revision, 81)
  assert.equal(calls.find(row => row.method === 'setDecisionCredential')?.input.settingsRevision, 81)
  const paths = writes[0].ops.map(op => op.path.join('.'))
  assert.ok(paths.includes('decisionBackend'))
  assert.ok(paths.includes('decisionModel'))
  assert.ok(paths.includes('decisionEndpoint'))
  assert.ok(!JSON.stringify(writes[0].ops).includes(apiKey), 'the API key never enters ordinary settings')
})

test('a failed general Save keeps the API key draft and does not submit the settings', async () => {
  const { registration, module: mod } = loadClient()
  const snapshot = { status: 'ready', writable: true, mode: 'host', revision: 82, value: { ...READY_VALUES } }
  const writes = []
  const form = { getSnapshot: () => snapshot, subscribe: () => () => {},
    mutate: async (ops, revision) => { writes.push({ ops, revision }); return true } }
  const calls = []
  const control = async (method, input) => {
    calls.push({ method, input })
    if (method === 'setDecisionCredential') return { ok: true,
      value: { ok: false, code: 'credential_save_failed' } }
    return { ok: true, value: { ok: true } }
  }
  const call = hostCalls({ overview: { ok: true, version: 'test', runtime: 'dsh',
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, counts: {}, store: { readable: true, schema: 2 } } })
  const apiKey = 'synthetic-key-retained-on-failure'
  let phase = 0
  const tree = await renderPanel(registration, { locale: 'zh', initialTab: 'budget', call, control, form }, 20,
    ({ nodes }) => {
      if (phase === 0) {
        const source = nodes.find(node => typeof node.type === 'function' && node.props?.testId === 'decision-source')
        if (!source) return false
        source.props.onChange('openai_compatible')
        phase = 1
        return false
      }
      const inputFor = label => nodes.find(node => node.type?.uiName === 'Input' && node.props?.['aria-label'] === label)
      if (phase === 1) {
        const endpoint = inputFor(mod.__test.zh.decisionEndpoint)
        const model = inputFor(mod.__test.zh.decisionModelField)
        const key = inputFor(mod.__test.zh.decisionApiKey)
        if (!endpoint || !model || !key) return false
        endpoint.props.onChange({ target: { value: 'https://api.example.test/v1' } })
        model.props.onChange({ target: { value: 'gpt-synthetic' } })
        key.props.onChange({ target: { value: apiKey } })
        phase = 2
        return false
      }
      if (phase === 2) {
        const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === mod.__test.zh.save)
        if (!save || save.props.disabled) return false
        save.props.onClick()
        phase = 3
        return false
      }
      if (phase === 3) {
        if (!calls.some(row => row.method === 'setDecisionCredential')) return false
        assert.equal(inputFor(mod.__test.zh.decisionApiKey)?.props.value, apiKey)
        assert.equal(writes.length, 0)
        phase = 4
        return true
      }
      return true
    })
  assert.equal(phase, 4)
  assert.equal(writes.length, 0)
  assert.ok(JSON.stringify(tree).includes(mod.__test.zh.decisionKeySaveFailed))
})

test('a config CAS failure after storing the API key reports that only the key was saved', async () => {
  const { registration, module: mod } = loadClient()
  const snapshot = { status: 'ready', writable: true, mode: 'host', revision: 87, value: { ...READY_VALUES } }
  const writes = []
  const form = { getSnapshot: () => snapshot, subscribe: () => () => {},
    mutate: async (ops, revision) => { writes.push({ ops, revision }); return false } }
  const calls = []
  const control = async (method, input) => {
    calls.push({ method, input })
    if (method === 'setDecisionCredential') return { ok: true,
      value: { ok: true, configured: true, stored: true } }
    return { ok: true, value: { ok: true } }
  }
  const call = hostCalls({ overview: { ok: true, version: 'test', runtime: 'dsh',
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, counts: {}, store: { readable: true, schema: 2 } } })
  const apiKey = 'synthetic-key-only-credential-save'
  let phase = 0
  const tree = await renderPanel(registration, { locale: 'zh', initialTab: 'budget', call, control, form }, 20,
    ({ nodes }) => {
      if (phase === 0) {
        const source = nodes.find(node => typeof node.type === 'function' && node.props?.testId === 'decision-source')
        if (!source) return false
        source.props.onChange('openai_compatible')
        phase = 1
        return false
      }
      const inputFor = label => nodes.find(node => node.type?.uiName === 'Input' && node.props?.['aria-label'] === label)
      if (phase === 1) {
        const endpoint = inputFor(mod.__test.zh.decisionEndpoint)
        const model = inputFor(mod.__test.zh.decisionModelField)
        const key = inputFor(mod.__test.zh.decisionApiKey)
        if (!endpoint || !model || !key) return false
        endpoint.props.onChange({ target: { value: 'https://api.example.test/v1' } })
        model.props.onChange({ target: { value: 'gpt-synthetic' } })
        key.props.onChange({ target: { value: apiKey } })
        phase = 2
        return false
      }
      if (phase === 2) {
        const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === mod.__test.zh.save)
        if (!save || save.props.disabled) return false
        save.props.onClick()
        phase = 3
        return false
      }
      if (phase === 3) {
        const key = inputFor(mod.__test.zh.decisionApiKey)
        if (writes.length !== 1 || key?.props.value !== '') return false
        phase = 4
        return true
      }
      return true
    })
  assert.equal(phase, 4)
  assert.equal(calls.find(row => row.method === 'setDecisionCredential')?.input.apiKey, apiKey)
  assert.equal(writes.length, 1)
  assert.ok(JSON.stringify(tree).includes(mod.__test.zh.decisionConfigNotSavedKeySaved))
})

test('editing the API key cancels discovery and fences a late model-list response', async () => {
  const { registration, module: mod } = loadClient()
  const snapshot = { status: 'ready', writable: true, mode: 'host', revision: 83,
    value: { ...REMOTE_READY_VALUES } }
  const form = { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => true }
  const calls = []
  let markDiscoveryStarted
  const discoveryStarted = new Promise(resolve => { markDiscoveryStarted = resolve })
  let resolveDiscovery
  const control = async (method, input) => {
    calls.push({ method, input })
    if (method === 'describeDecisionCredential') return { ok: true, value: { ok: true,
      serviceAvailable: true, configured: false, stored: false, writable: true, legacyConfigured: false } }
    if (method === 'discoverDecisionModels') {
      markDiscoveryStarted()
      return new Promise(resolve => { resolveDiscovery = () => resolve({ ok: true,
        value: { ok: true, models: [{ id: 'old-key-model' }], autoAvailable: false } }) })
    }
    return { ok: true, value: { ok: true } }
  }
  const call = hostCalls({ overview: { ok: true, version: 'test', runtime: 'dsh',
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, counts: {}, store: { readable: true, schema: 2 } } })
  let phase = 0
  const tree = await renderPanel(registration, { locale: 'zh', initialTab: 'budget', call, control, form }, 24,
    async ({ nodes }) => {
      const key = nodes.find(node => node.type?.uiName === 'Input'
        && node.props?.['aria-label'] === mod.__test.zh.decisionApiKey)
      if (phase === 0) {
        if (!key) return false
        key.props.onChange({ target: { value: 'synthetic-old-key' } })
        phase = 1
        return false
      }
      if (phase === 1) {
        const discover = nodes.find(node => node.type?.uiName === 'Button'
          && labelOf(node) === mod.__test.zh.decisionDiscover)
        if (!discover || discover.props.disabled) return false
        discover.props.onClick()
        phase = 2
        return false
      }
      if (phase === 2) {
        await discoveryStarted
        const latestKey = nodes.find(node => node.type?.uiName === 'Input'
          && node.props?.['aria-label'] === mod.__test.zh.decisionApiKey)
        latestKey.props.onChange({ target: { value: 'synthetic-new-key' } })
        resolveDiscovery()
        phase = 3
        return false
      }
      if (phase === 3) {
        assert.ok(!nodes.some(node => node.props?.key === 'decision-model-list'),
          'models returned for the earlier key are not rendered')
        assert.equal(key?.props.value, 'synthetic-new-key', 'the replacement key remains in the field')
        assert.ok(calls.some(row => row.method === 'cancelDecisionDiscovery'))
        phase = 4
        return true
      }
      return true
    })
  assert.equal(phase, 4)
  assert.ok(!JSON.stringify(tree).includes('old-key-model'))
})

test('a changed settings revision blocks credential and discovery actions with only a pending API key', async () => {
  const { registration, module: mod } = loadClient()
  let snapshot = { status: 'ready', writable: true, mode: 'host', revision: 84,
    value: { ...REMOTE_READY_VALUES } }
  let notify
  const writes = []
  const form = { getSnapshot: () => snapshot, subscribe: listener => { notify = listener; return () => {} },
    mutate: async (ops, revision) => { writes.push({ ops, revision }); return true } }
  const calls = []
  const control = async (method, input) => {
    calls.push({ method, input })
    if (method === 'describeDecisionCredential') return { ok: true, value: { ok: true,
      serviceAvailable: true, configured: false, stored: false, writable: true, legacyConfigured: false } }
    return { ok: true, value: { ok: true } }
  }
  const call = hostCalls({ overview: { ok: true, version: 'test', runtime: 'dsh',
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, counts: {}, store: { readable: true, schema: 2 } } })
  let phase = 0
  const tree = await renderPanel(registration, { locale: 'zh', initialTab: 'budget', call, control, form }, 20,
    ({ nodes }) => {
      const byLabel = label => nodes.find(node => node.type?.uiName === 'Input' && node.props?.['aria-label'] === label)
      if (phase === 0) {
        const key = byLabel(mod.__test.zh.decisionApiKey)
        if (!key || notify === undefined) return false
        key.props.onChange({ target: { value: 'synthetic-stale-key' } })
        phase = 1
        return false
      }
      if (phase === 1) {
        const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === mod.__test.zh.save)
        assert.equal(save.props.disabled, false, 'a key-only edit is a dirty form before the Host revision changes')
        assert.ok(JSON.stringify(nodes).includes(mod.__test.zh.unsaved))
        snapshot = { ...snapshot, revision: 85 }
        notify()
        phase = 2
        return false
      }
      if (phase === 2) {
        const saveKey = nodes.find(node => node.type?.uiName === 'Button'
          && labelOf(node) === mod.__test.zh.decisionSaveKey)
        const discover = nodes.find(node => node.type?.uiName === 'Button'
          && labelOf(node) === mod.__test.zh.decisionDiscover)
        const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === mod.__test.zh.save)
        assert.equal(saveKey.props.disabled, true)
        assert.equal(discover.props.disabled, true)
        assert.equal(save.props.disabled, true)
        assert.ok(JSON.stringify(nodes).includes(mod.__test.zh.draftStale))
        assert.equal(byLabel(mod.__test.zh.decisionApiKey)?.props.value, 'synthetic-stale-key')
        // Exercise the handlers too: a stale callback must be rejected even if a browser event
        // was already queued before the disabled state painted.
        saveKey.props.onClick()
        discover.props.onClick()
        save.props.onClick()
        phase = 3
        return true
      }
      return true
    })
  assert.equal(phase, 3)
  assert.equal(writes.length, 0)
  assert.ok(!calls.some(row => ['setDecisionCredential', 'unsetDecisionCredential',
    'discoverDecisionModels'].includes(row.method)))
})

test('remote key status distinguishes an empty or invalid API address from an absent Host credential service', async () => {
  const { registration, module: mod } = loadClient()
  const call = hostCalls({ overview: { ok: true, version: 'test', runtime: 'dsh',
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, counts: {}, store: { readable: true, schema: 2 } } })
  const renderStatus = async (endpoint, describe) => {
    const snapshot = { status: 'ready', writable: true, mode: 'host', revision: 86,
      value: { ...REMOTE_READY_VALUES, decisionEndpoint: endpoint } }
    const form = { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async () => true }
    const control = async method => method === 'describeDecisionCredential'
      ? { ok: true, value: describe() } : { ok: true, value: { ok: true } }
    return renderPanel(registration, { locale: 'zh', initialTab: 'budget', call, control, form }, 12, undefined, 230)
  }
  const empty = await renderStatus('', () => ({ ok: false, code: 'invalid_decision_credential_request' }))
  assert.ok(JSON.stringify(empty).includes(mod.__test.zh.decisionEndpointRequired))
  assert.ok(!JSON.stringify(empty).includes(mod.__test.zh.decisionCredentialUnavailable))
  assert.equal(mod.__test.zh.decisionEndpoint, 'API 地址')

  const invalid = await renderStatus('not-an-url', () => ({ ok: false, code: 'invalid_endpoint' }))
  assert.ok(JSON.stringify(invalid).includes(mod.__test.zh.decisionEndpointInvalid))
  assert.ok(!JSON.stringify(invalid).includes(mod.__test.zh.decisionCredentialUnavailable))

  const absent = await renderStatus('https://example.test/v1', () => ({ ok: true,
    serviceAvailable: false, configured: false, stored: false, writable: false }))
  assert.ok(JSON.stringify(absent).includes(mod.__test.zh.decisionCredentialUnavailable))
})

test('the verification-session row never invents a session and states what is saved', () => {
  const { module: mod } = loadClient()
  const { zh, en, verificationSession, defaultDraft, diffOps } = mod.__test
  const directory = { ok: true, sessions: [
    { id: 'session-aaaabbbb-1111', title: '重构召回排序', label: 'alpha', scope: 'project', live: true },
    { id: 'session-ccccdddd-2222', title: null, label: 'alpha', scope: 'project' },
    { id: 'session-eeeeffff-3333', title: '重构召回排序', label: 'beta', scope: 'project' }] }
  // Nothing saved: the first option is the explicit no-choice and it maps to the empty string.
  const none = verificationSession(zh, directory, '')
  assert.equal(none.state, 'none')
  assert.equal(none.text, zh.verifySessionNoneHint)
  assert.deepEqual(none.options[0], { id: '', label: zh.verifySessionNone })
  assert.deepEqual(none.options.slice(1).map(option => option.id),
    ['session-aaaabbbb-1111', 'session-ccccdddd-2222', 'session-eeeeffff-3333'])
  // Real conversation titles lead; the untitled and the duplicate-title rows carry a short id.
  assert.ok(none.options[1].label.startsWith('重构召回排序'), none.options[1].label)
  assert.ok(none.options[2].label.startsWith(zh.untitledConversation), none.options[2].label)
  assert.ok(none.options[3].label.startsWith('重构召回排序'), none.options[3].label)
  assert.notEqual(none.options[1].label, none.options[3].label, 'twins stay distinguishable')
  // A saved id the directory answers for is ready, and no id outside the directory is offered.
  const ready = verificationSession(zh, directory, 'session-ccccdddd-2222')
  assert.equal(ready.state, 'ready')
  assert.equal(ready.text, zh.verifySessionReady)
  assert.deepEqual(ready.options.map(option => option.id), none.options.map(option => option.id))
  // A saved id the directory does NOT list is shown as such — never silently swapped, never read
  // as "not selected".
  const missing = verificationSession(zh, directory, 'session-99990000-4444')
  assert.equal(missing.state, 'missing')
  assert.equal(missing.text, zh.verifySessionMissing.replace('{id}', 'session-99990000-4444'))
  assert.deepEqual(missing.options.map(option => option.id),
    ['', 'session-aaaabbbb-1111', 'session-ccccdddd-2222', 'session-eeeeffff-3333', 'session-99990000-4444'])
  assert.ok(missing.options[4].label.startsWith(zh.verifySessionMissingShort), missing.options[4].label)
  // An unreadable directory is "unknown, cannot choose now", and the saved value is still shown.
  const unknown = verificationSession(zh, { ok: false, code: 'session_directory_unavailable' }, 'session-99990000-4444')
  assert.equal(unknown.state, 'unknown')
  assert.deepEqual(unknown.options.map(option => option.id), ['', 'session-99990000-4444'],
    'the configured value is still shown, just not verified against the directory')
  assert.ok(unknown.options[1].label.startsWith(zh.verifySessionUnverified), unknown.options[1].label)
  assert.ok(unknown.text.includes('session-99990000-4444'), unknown.text)
  // With nothing configured there is nothing to carry, only the explicit no-choice.
  assert.deepEqual(verificationSession(zh, { ok: false, code: 'x' }, '').options.map(option => option.id), [''])
  assert.ok(verificationSession(zh, null, '').text.includes(zh.verifySessionNoneShort))
  assert.equal(verificationSession(en, null, '').state, 'unknown')
  // Not read YET is its own state: the page must not claim the directory is unavailable while the
  // first sessions() call is still in flight.
  const pending = verificationSession(zh, undefined, '')
  assert.equal(pending.state, 'pending')
  assert.equal(pending.text, zh.loading)
  assert.deepEqual(pending.options.map(option => option.id), [''])
  assert.deepEqual(verificationSession(zh, undefined, 'session-99990000-4444').options.map(option => option.id),
    ['', 'session-99990000-4444'], 'a read still in flight never reads as "not selected"')
  assert.deepEqual(verificationSession(en, undefined, 'session-99990000-4444').options[1].label.startsWith('saved value'), true)
  assert.equal(en.verifySessionNone.startsWith('Not selected'), true)
  // Every offered option is either the no-choice or a directory row (plus the saved value itself).
  const ids = directory.sessions.map(row => row.id)
  assert.equal(missing.options.filter(option => option.id !== '' && option.id !== 'session-99990000-4444')
    .every(option => ids.includes(option.id)), true)

  // The draft carries the field, an untouched form writes nothing, and one selection produces
  // exactly ONE `set` op inside the same patch as the other edits.
  const accepted = { enabled: true, reflectionEnabled: true, autoValidationEnabled: false,
    verificationSessionId: '', maxContextBytes: 768, evaluationTokensPerDay: 0, evaluationCallsPerDay: 2 }
  const fresh = defaultDraft(accepted)
  assert.equal(fresh.verificationSessionId, '', 'the empty value is the documented default')
  assert.deepEqual(diffOps(fresh, accepted).ops, [])
  const chosen = diffOps({ ...fresh, autoValidationEnabled: true, verificationSessionId: 'session-aaaabbbb-1111' }, accepted)
  assert.deepEqual(chosen.ops, [
    { op: 'set', path: ['autoValidationEnabled'], value: true },
    { op: 'set', path: ['verificationSessionId'], value: 'session-aaaabbbb-1111' },
  ], 'one atomic patch, one op for the session')
  assert.deepEqual(chosen.problems, [])
  // Clearing it again and an over-long value are both explicit, never a silent coercion.
  assert.deepEqual(diffOps({ ...fresh, verificationSessionId: '' }, { ...accepted, verificationSessionId: 'session-aaaabbbb-1111' }).ops,
    [{ op: 'set', path: ['verificationSessionId'], value: '' }])
  const tooLong = diffOps({ ...fresh, verificationSessionId: 'x'.repeat(600) }, accepted)
  assert.deepEqual(tooLong.ops, [], 'an over-long id never reaches the Host')
  assert.equal(tooLong.problems.length, 1)
  const notAString = diffOps({ ...fresh, verificationSessionId: 42 }, accepted)
  assert.deepEqual(notAString.ops, [])
  assert.equal(notAString.problems.length, 1)
})

test('the native picker maps the no-choice entry to the empty value and only offers real rows', () => {
  const { module: mod } = loadClient()
  const { zh, Picker } = mod.__test
  const chosen = []
  const element = Picker({ label: zh.verifySession, value: '', disabled: false, testId: 'verify-session',
    options: [{ id: '', label: zh.verifySessionNone }, { id: 'session-aaaabbbb-1111', label: '重构召回排序 · alpha' }],
    onChange: id => chosen.push(id) })
  // The element IS the host's menu: the no-choice option is the sentinel the shell needs, and it
  // maps back to the empty string the settings document actually stores.
  assert.equal(element.type.uiName, 'Menu')
  assert.equal(element.props['data-mse-picker'], 'verify-session')
  assert.deepEqual(element.props.items, [{ id: '__default', label: zh.verifySessionNone },
    { id: 'session-aaaabbbb-1111', label: '重构召回排序 · alpha' }])
  assert.equal(element.props.selectedId, '__default')
  element.props.onSelect('__default')
  element.props.onSelect('session-aaaabbbb-1111')
  assert.deepEqual(chosen, ['', 'session-aaaabbbb-1111'])
  // A saved id is reflected as the selection, and the picker carries the disabled state through.
  const saved = Picker({ label: zh.verifySession, value: 'session-aaaabbbb-1111', disabled: true,
    options: [{ id: '', label: zh.verifySessionNone }, { id: 'session-aaaabbbb-1111', label: 'x' }],
    onChange: () => {} })
  assert.equal(saved.props.selectedId, 'session-aaaabbbb-1111')
  assert.equal(saved.props.anchor.props.disabled, true)
})

test('常规 renders the verification picker, and a saved id missing from the directory says so', async () => {
  let registration
  const window = { __ModuleLoader__: { load: value => { registration = value } } }
  const document = { createElement: () => ({ dataset: {}, remove: () => {} }), head: { append: () => {} } }
  // eslint-disable-next-line no-new-func -- the bundle is a browser script by contract.
  new Function('window', 'document', 'setInterval', 'clearInterval', SOURCE)(window, document, setInterval, clearInterval)
  const overview = { ok: true, version: 'test', runtime: 'dsh', store: { readable: true, schema: 2 },
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, counts: {}, countsError: null,
    library: { ...FULL_LIBRARY }, scope: null, scopeReason: 'no_scope_selected', turnsObserved: 0 }
  const sessions = { ok: true, sessions: [
    { id: 'session-aaaabbbb-1111', title: '重构召回排序', label: 'alpha', scope: 'project', live: true },
    { id: 'session-ccccdddd-2222', title: null, label: 'alpha', scope: 'project' }] }
  // The host's Picker is a component, so the tree carries the ELEMENT the panel created; its props
  // are exactly what the real Menu receives (items, selectedId, disabled, onChange).
  const pickerOf = tree => elementsOf(tree).find(node => typeof node.type === 'function'
    && node.props?.testId === 'verify-session')
  const formWith = value => ({ getSnapshot: () => ({ status: 'ready', writable: true, mode: 'host', revision: 1,
    value: { ...READY_VALUES, verificationSessionId: '', ...value } }), subscribe: () => () => {}, mutate: () => true })
  const call = hostCalls({ overview, sessions })

  // Nothing saved: the picker exists, offers only directory rows plus the explicit no-choice, and
  // the row explains that historical candidates stay blocked meanwhile.
  const tree = await renderPanel(registration, { locale: 'zh', call, control: undefined, form: formWith({}) }, 10)
  const picker = pickerOf(tree)
  assert.ok(picker !== undefined, 'the verification-session picker is mounted in the settings rows')
  assert.deepEqual(picker.props.options.map(option => option.id),
    ['', 'session-aaaabbbb-1111', 'session-ccccdddd-2222'])
  assert.deepEqual(picker.props.options[0], { id: '', label: ZH_DICT.verifySessionNone })
  assert.ok(picker.props.options[1].label.startsWith('重构召回排序'), 'the conversation title leads the label')
  assert.ok(picker.props.options[2].label.startsWith(ZH_DICT.untitledConversation), picker.props.options[2].label)
  assert.equal(picker.props.value, '', 'nothing is saved, so the no-choice value is selected')
  assert.equal(picker.props.disabled, false)
  assert.ok(JSON.stringify(tree).includes(ZH_DICT.verifySessionNoneHint), 'the not-selected state is explained')
  assert.ok(JSON.stringify(tree).includes(ZH_DICT.verifySessionHint), 'and what the setting is for is stated too')

  // A saved id the directory does not list: the row states it, and the picker shows the saved
  // value instead of falling back to "not selected".
  const saved = 'session-99990000-4444'
  const missingTree = await renderPanel(registration, { locale: 'zh', call, control: undefined,
    form: formWith({ verificationSessionId: saved }) }, 10)
  const missingPicker = pickerOf(missingTree)
  assert.equal(missingPicker.props.value, saved, 'the picker shows the configured session')
  assert.ok(missingPicker.props.options.map(option => option.id).includes(saved))
  assert.ok(JSON.stringify(missingTree).includes(ZH_DICT.verifySessionMissing.replace('{id}', saved)),
    'the saved value is shown next to the picker')
  assert.ok(JSON.stringify(missingTree).includes(ZH_DICT.verifySessionMissingShort), 'and labelled as missing')

  // An unavailable directory: "unknown, cannot choose right now", with the saved value intact.
  const unknownTree = await renderPanel(registration, { locale: 'zh', control: undefined,
    call: hostCalls({ overview, sessions: { ok: false, code: 'session_directory_unavailable' } }),
    form: formWith({ verificationSessionId: saved }) }, 10)
  assert.ok(JSON.stringify(unknownTree).includes(ZH_DICT.verifySessionUnknown.replace('{id}', saved)),
    'an unreadable directory is stated, never shown as an empty choice')
  const unknownPicker = pickerOf(unknownTree)
  assert.deepEqual(unknownPicker.props.options.map(option => option.id), ['', saved],
    'an unreadable directory offers no OTHER session, and still shows the configured one')
  assert.equal(unknownPicker.props.value, saved, 'the trigger never falls back to "not selected"')

  // Not writable: the picker is disabled and nothing can be written.
  const readOnly = { getSnapshot: () => ({ status: 'ready', writable: false, mode: 'host', revision: 1,
    value: { ...READY_VALUES, verificationSessionId: '' } }), subscribe: () => () => {},
    mutate: () => { throw new Error('nothing may be written by a render test') } }
  const readOnlyTree = await renderPanel(registration, { locale: 'zh', call, control: undefined, form: readOnly }, 10)
  assert.equal(pickerOf(readOnlyTree).props.disabled, true, 'a non-writable form cannot choose a session')

  // One selection plus one switch, saved ONCE through the existing sparse-op path.
  const writes = []
  const recordingForm = { getSnapshot: () => ({ status: 'ready', writable: true, revision: 7,
    value: { ...READY_VALUES, verificationSessionId: '' } }), subscribe: () => () => {},
    mutate: (ops, revision) => { writes.push({ ops, revision }); return true } }
  let phase = 0
  await renderPanel(registration, { locale: 'zh', call, control: undefined, form: recordingForm }, 16, ({ nodes }) => {
    if (phase === 0) {
      const picker = nodes.find(node => typeof node.type === 'function' && node.props?.testId === 'verify-session')
      // The switch's own label is `autoValidate`; `autoValidation` is the row title.
      const toggle = nodes.find(node => node.type?.uiName === 'Switch' && node.props?.label === ZH_DICT.autoValidate)
      if (picker === undefined || toggle === undefined) return false
      toggle.props.onChange(true)
      // `onChange` is what the picker's own menu calls after mapping the no-choice sentinel.
      picker.props.onChange('session-aaaabbbb-1111')
      phase = 1
      return false
    }
    const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === '保存')
    if (save === undefined || save.props?.disabled === true) return false
    save.props.onClick()
    phase = 2
    return true
  })
  assert.equal(writes.length, 1, 'the session travels in the SAME single patch as the switch')
  assert.deepEqual(writes[0], { revision: 7, ops: [
    { op: 'set', path: ['autoValidationEnabled'], value: true },
    { op: 'set', path: ['verificationSessionId'], value: 'session-aaaabbbb-1111' },
  ] })
})

test('a settings save rejects a changed revision, preserves a stable draft revision, and rechecks permission', async () => {
  const { registration } = loadClient()
  let snapshot = { status: 'ready', writable: true, revision: 19, value: { ...READY_VALUES } }
  const writes = []
  const listeners = new Set()
  const form = { getSnapshot: () => snapshot, subscribe: listener => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, mutate: (ops, revision) => {
    writes.push({ ops, revision })
    if (revision !== snapshot.revision || snapshot.writable !== true) return false
    const value = { ...snapshot.value }
    for (const op of ops) value[op.path[0]] = op.value
    snapshot = { ...snapshot, revision: revision + 1, value }
    for (const listener of listeners) listener()
    return true
  } }
  const call = async method => ({ ok: true, value: method === 'overview'
    ? { ok: true, version: 'test', runtime: 'dsh', budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 },
      counts: {}, store: { readable: true, schema: 2 } }
    : { ok: true, sessions: [] } })
  let phase = 0
  const staleTree = await renderPanel(registration, { locale: 'zh', call, control: undefined, form }, 14, ({ nodes }) => {
    if (phase === 0) {
      const picker = nodes.find(node => typeof node.type === 'function' && node.props?.testId === 'verify-session')
      const input = nodes.find(node => node.type?.uiName === 'Input' && node.props?.['aria-label'] === ZH_DICT.contextBytes)
      if (picker === undefined || input === undefined) return false
      picker.props.onChange('session-aaaabbbb-1111')
      input.props.onChange({ target: { value: '1024' } })
      phase = 1
      return false
    }
    const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === '保存')
    if (save === undefined || save.props.disabled) return false
    // This latest rendered handler still cannot write against a Host revision that changed unseen.
    snapshot = { ...snapshot, revision: 20 }
    save.props.onClick()
    phase = 2
    return true
  })
  assert.equal(phase, 2)
  assert.equal(writes.length, 0, 'a stale draft is refused before mutate')
  assert.ok(JSON.stringify(staleTree).includes(ZH_DICT.draftStale))

  // A fresh form at a stable revision remains writable and sends the revision it was seeded with.
  snapshot = { ...snapshot, revision: 21, writable: true }
  phase = 0
  const stableTree = await renderPanel(registration, { locale: 'zh', call, control: undefined, form }, 14, ({ nodes }) => {
    if (phase === 0) {
      const picker = nodes.find(node => typeof node.type === 'function' && node.props?.testId === 'verify-session')
      const input = nodes.find(node => node.type?.uiName === 'Input' && node.props?.['aria-label'] === ZH_DICT.contextBytes)
      if (picker === undefined || input === undefined) return false
      picker.props.onChange('session-bbbbcccc-2222')
      assert.equal(input.props.value, '768', 'the permission check begins from the saved Host value')
      input.props.onChange({ target: { value: '1280' } })
      phase = 1
      return false
    }
    if (phase === 2) {
      if (writes.length !== 1) return false
      phase = 3
      return true
    }
    const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === '保存')
    if (save === undefined || save.props.disabled) return false
    save.props.onClick()
    phase = 2
    return false
  })
  assert.equal(phase, 3)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].revision, 21, 'a current draft writes using the revision it was seeded with')
  assert.deepEqual(writes[0].ops, [
    { op: 'set', path: ['verificationSessionId'], value: 'session-bbbbcccc-2222' },
    { op: 'set', path: ['maxContextBytes'], value: 1280 },
  ])
  assert.equal(snapshot.revision, 22)
  assert.equal(snapshot.value.verificationSessionId, 'session-bbbbcccc-2222')
  assert.equal(snapshot.value.maxContextBytes, 1280)
  assert.ok(JSON.stringify(stableTree).includes(ZH_DICT.saved))

  writes.length = 0
  phase = 0
  await renderPanel(registration, { locale: 'zh', call, control: undefined, form }, 14, ({ nodes }) => {
    if (phase === 0) {
      const input = nodes.find(node => node.type?.uiName === 'Input' && node.props?.['aria-label'] === ZH_DICT.contextBytes)
      if (input === undefined) return false
      assert.equal(input.props.value, '1280', 'the committed value is the baseline for the next draft')
      input.props.onChange({ target: { value: '1344' } })
      phase = 1
      return false
    }
    const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === '保存')
    if (save === undefined || save.props.disabled) return false
    // This models the permission revoking after render but before the event handler runs.
    snapshot = { ...snapshot, writable: false }
    save.props.onClick()
    phase = 2
    return true
  })
  assert.equal(phase, 2)
  assert.equal(writes.length, 0, 'permission revoked at save time results in zero writes')
  assert.equal(snapshot.value.maxContextBytes, 1280, 'permission revocation leaves the committed Host value unchanged')
})

test('a Host mutate refusal is never presented as a successful settings save', async () => {
  const { registration, module: mod } = loadClient()
  const snapshot = { status: 'ready', writable: true, revision: 23, value: { ...READY_VALUES } }
  let writes = 0
  const form = { getSnapshot: () => snapshot, subscribe: () => () => {},
    mutate: () => { writes += 1; return false } }
  const call = async method => ({ ok: true, value: method === 'overview'
    ? { ok: true, version: 'test', runtime: 'dsh', budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 },
      counts: {}, store: { readable: true, schema: 2 } }
    : { ok: true, sessions: [] } })
  let phase = 0
  const tree = await renderPanel(registration, { locale: 'zh', call, control: undefined, form }, 14, ({ nodes }) => {
    if (phase === 0) {
      const input = nodes.find(node => node.type?.uiName === 'Input' && node.props?.['aria-label'] === ZH_DICT.contextBytes)
      if (input === undefined) return false
      input.props.onChange({ target: { value: '1280' } })
      phase = 1
      return false
    }
    const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === '保存')
    if (save === undefined || save.props.disabled) return false
    save.props.onClick()
    phase = 2
    return true
  })
  assert.equal(writes, 1)
  const rendered = JSON.stringify(tree)
  assert.ok(rendered.includes(mod.__test.zh.reloadNeeded), 'a rejected atomic mutation requests a host reread')
  assert.ok(!elementsOf(tree).some(node => node.props?.className === 'mse-ok'),
    'a rejected mutation has no successful-save indicator')
})

test('a Host revision conflict offers one reload action and refreshes credential metadata', async () => {
  const { registration, module: mod } = loadClient()
  let snapshot = { status: 'ready', writable: true, revision: 23, value: { ...READY_VALUES,
    decisionBackend: 'openai_compatible', decisionModel: 'before-conflict',
    decisionEndpoint: 'https://example.test/v1', decisionSecretRef: '', decisionSecretBinding: '' } }
  const writes = []
  let notifySnapshot = null
  const form = { getSnapshot: () => snapshot, subscribe: listener => {
    notifySnapshot = listener
    return () => { if (notifySnapshot === listener) notifySnapshot = null }
  },
    mutate: async (ops, revision) => {
      writes.push({ ops, revision })
      snapshot = { ...snapshot, revision: 24, value: { ...snapshot.value, decisionModel: 'host-model-after-conflict' } }
      notifySnapshot?.()
      return false
    } }
  const settingsMirror = { getSnapshot: () => ({ status: 'ready', error: null,
    view: { namespaces: [{ ns: 'mse-learning', revision: snapshot.revision }] } }), load: async () => {} }
  const call = hostCalls({ overview: { ok: true, version: 'test', runtime: 'dsh',
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, counts: {},
    store: { readable: true, schema: 2 } } })
  let statusReads = 0
  const descriptions = []
  const control = async (method, input) => {
    if (method === 'status') {
      statusReads += 1
      return { ok: true, value: { ok: true, runtime: { jobs: [] } } }
    }
    if (method === 'describeDecisionCredential') {
      return await new Promise(resolve => descriptions.push({ input, resolve }))
    }
    return { ok: true, value: { ok: true } }
  }
  let phase = 0
  let statusReadsBeforeRecovery = 0
  let oldDescription
  let currentDescription
  await renderPanel(registration, { locale: 'zh', initialTab: 'budget', call, control, form, settingsMirror }, 30, async ({ nodes }) => {
    const rendered = JSON.stringify(nodes)
    if (phase === 0) {
      const input = nodes.find(node => node.type?.uiName === 'Input'
        && node.props?.['aria-label'] === mod.__test.zh.decisionModelField)
      if (input === undefined) return false
      input.props.onChange({ target: { value: 'draft-model-before-conflict' } })
      phase = 1
      return false
    }
    if (phase === 1) {
      oldDescription = descriptions.find(request => request.input.settingsRevision === 23)
      if (oldDescription === undefined) return false
      const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === ZH_DICT.save)
      if (save === undefined || save.props.disabled) return false
      save.props.onClick()
      phase = 2
      return false
    }
    if (phase === 2) {
      const reloads = nodes.filter(node => node.type?.uiName === 'Button' && labelOf(node) === mod.__test.zh.reloadHost)
      if (reloads.length === 0 || !rendered.includes(mod.__test.zh.draftStale)
        || !rendered.includes(mod.__test.zh.reloadNeeded)) return false
      assert.equal(reloads.length, 1, 'stale and failed states share one recovery action')
      assert.equal(writes.length, 1)
      assert.equal(writes[0].revision, 23)
      assert.equal(snapshot.revision, 24, 'the rejected write leaves a newer Host revision')
      statusReadsBeforeRecovery = statusReads
      reloads[0].props.onClick()
      assert.equal(statusReads, statusReadsBeforeRecovery + 1, 'the failed-save recovery refreshes runtime status')
      phase = 3
      return false
    }
    if (phase === 3) {
      currentDescription = descriptions.find(request => request.input.settingsRevision === 24)
      if (currentDescription === undefined) return false
      assert.equal(currentDescription.input.backend, 'openai_compatible')
      assert.equal(currentDescription.input.endpoint, 'https://example.test/v1')
      const input = nodes.find(node => node.type?.uiName === 'Input'
        && node.props?.['aria-label'] === mod.__test.zh.decisionModelField)
      const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === ZH_DICT.save)
      if (input === undefined || save === undefined) return false
      assert.equal(input.props.value, 'host-model-after-conflict', 'reseed uses the latest Host model value')
      assert.equal(save.props.disabled, true, 'save stays disabled after the clean reseed')
      assert.ok(!rendered.includes(mod.__test.zh.draftStale))
      assert.ok(!rendered.includes(mod.__test.zh.reloadNeeded))
      assert.ok(nodes.some(node => node.props?.className === 'mse-decision-status'
        && node.children?.[0] === mod.__test.zh.loading), 'credential status shows loading while the 200ms read is pending')
      currentDescription.resolve({ ok: true, value: { ok: true, serviceAvailable: true,
        configured: false, stored: false, writable: true } })
      phase = 4
      return false
    }
    if (phase === 4) {
      const status = nodes.find(node => node.props?.className === 'mse-decision-status'
        && node.children?.[0] === mod.__test.zh.decisionNoSavedKey)
      if (status === undefined) return false
      assert.ok(!rendered.includes(mod.__test.zh.draftStale), 'the old conflict hint is cleared')
      assert.equal(oldDescription.input.settingsRevision, 23)
      oldDescription.resolve({ ok: true, value: { ok: true, serviceAvailable: true,
        configured: true, stored: true, writable: true } })
      await new Promise(resolve => setImmediate(resolve))
      phase = 5
      return false
    }
    if (phase === 5) {
      const status = nodes.find(node => node.props?.className === 'mse-decision-status'
        && node.children?.[0] === mod.__test.zh.decisionNoSavedKey)
      if (status === undefined) return false
      assert.ok(!rendered.includes(mod.__test.zh.decisionSavedKey), 'late old metadata cannot mark the new revision configured')
      phase = 6
      return true
    }
    return true
  }, 220)
  assert.equal(phase, 6, 'the conflict recovery refreshes metadata and ignores a late older response')
  assert.equal(writes.length, 1, 'recovery does not resubmit the rejected write')
})

test('a credential conflict refreshes the Host mirror before reseeding a stale ConfigForm', async () => {
  const { registration, module: mod } = loadClient()
  const latestValue = { ...REMOTE_READY_VALUES, decisionModel: 'host-model-after-external-change' }
  let snapshot = { status: 'ready', writable: true, mode: 'host', revision: 0, value: { ...REMOTE_READY_VALUES } }
  let notifySnapshot = null
  let mirrorSnapshot = { status: 'ready', error: null,
    view: { namespaces: [{ ns: 'mse-learning', revision: 0 }] } }
  let mirrorLoads = 0
  const settingsMirror = {
    getSnapshot: () => mirrorSnapshot,
    load: async () => {
      mirrorLoads += 1
      mirrorSnapshot = { status: 'ready', error: null,
        view: { namespaces: [{ ns: 'mse-learning', revision: 2 }] } }
      snapshot = { ...snapshot, revision: 2, value: latestValue }
      notifySnapshot?.()
    },
  }
  const writes = []
  const form = { getSnapshot: () => snapshot, subscribe: listener => {
    notifySnapshot = listener
    return () => { if (notifySnapshot === listener) notifySnapshot = null }
  }, mutate: async (ops, revision) => { writes.push({ ops, revision }); return true } }
  const calls = []
  const control = async (method, input) => {
    calls.push({ method, input })
    if (method === 'setDecisionCredential') {
      return { ok: true, value: { ok: false, code: 'settings_conflict' } }
    }
    if (method === 'describeDecisionCredential') {
      return { ok: true, value: input.settingsRevision === 0
        ? { ok: false, code: 'settings_conflict' }
        : { ok: true, serviceAvailable: true, configured: false, stored: false,
          writable: true, legacyConfigured: false } }
    }
    if (method === 'status') return { ok: true, value: { ok: true, runtime: { jobs: [] } } }
    return { ok: true, value: { ok: true } }
  }
  const call = hostCalls({ overview: { ok: true, version: 'test', runtime: 'dsh',
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, counts: {},
    store: { readable: true, schema: 2 } } })
  const apiKey = 'synthetic-stale-revision-key'
  let phase = 0
  const tree = await renderPanel(registration,
    { locale: 'zh', initialTab: 'budget', call, control, form, settingsMirror }, 30, ({ nodes }) => {
      const inputFor = label => nodes.find(node => node.type?.uiName === 'Input' && node.props?.['aria-label'] === label)
      if (phase === 0) {
        const key = inputFor(mod.__test.zh.decisionApiKey)
        if (!key) return false
        key.props.onChange({ target: { value: apiKey } })
        phase = 1
        return false
      }
      if (phase === 1) {
        const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === mod.__test.zh.save)
        if (!save || save.props.disabled) return false
        save.props.onClick()
        phase = 2
        return false
      }
      if (phase === 2) {
        const reload = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === mod.__test.zh.reloadHost)
        if (!reload || !JSON.stringify(nodes).includes(mod.__test.zh.draftStale)) return false
        assert.equal(snapshot.revision, 0, 'the ConfigForm mirror still holds the initial revision')
        assert.equal(writes.length, 0, 'the credential conflict returned before ConfigForm.mutate')
        assert.equal(calls.find(row => row.method === 'setDecisionCredential')?.input.settingsRevision, 0)
        reload.props.onClick()
        phase = 3
        return false
      }
      if (phase === 3) {
        if (!calls.some(row => row.method === 'describeDecisionCredential' && row.input.settingsRevision === 2)) {
          return false
        }
        assert.equal(mirrorLoads, 1, 'explicit reload performs a fresh Host settings.describe read')
        assert.equal(snapshot.revision, 2, 'the form revision follows the refreshed namespace revision')
        assert.equal(writes.length, 0, 'refresh does not use an empty mutate or retry the rejected credential save')
        const model = inputFor(mod.__test.zh.decisionModelField)
        const key = inputFor(mod.__test.zh.decisionApiKey)
        if (!model || !key) return false
        assert.equal(model.props.value, 'host-model-after-external-change')
        assert.equal(key.props.value, '', 'only a successful refresh clears the key draft')
        phase = 4
        return false
      }
      if (phase === 4) {
        const cleanStatus = nodes.find(node => node.props?.className === 'mse-decision-status'
          && node.children?.[0] === mod.__test.zh.decisionNoSavedKey)
        if (!cleanStatus) return false
        assert.ok(!JSON.stringify(nodes).includes(mod.__test.zh.draftStale))
        phase = 5
        return true
      }
      return true
    }, 220)
  assert.equal(phase, 5, 'the refreshed revision drives a clean credential metadata read')
  assert.equal(writes.length, 0)
  assert.ok(!JSON.stringify(tree).includes(mod.__test.zh.draftStale))
})

test('a failed settings refresh keeps the draft and any edits made while it is pending', async () => {
  const { registration, module: mod } = loadClient()
  let snapshot = { status: 'ready', writable: true, mode: 'host', revision: 0, value: { ...REMOTE_READY_VALUES } }
  let notifySnapshot = null
  let mirrorSnapshot = { status: 'ready', error: null,
    view: { namespaces: [{ ns: 'mse-learning', revision: 0 }] } }
  let resolveLoad
  let mirrorLoads = 0
  const settingsMirror = {
    getSnapshot: () => mirrorSnapshot,
    load: () => {
      mirrorLoads += 1
      return new Promise(resolve => { resolveLoad = () => {
        mirrorSnapshot = { status: 'ready', error: 'describe_unavailable',
          view: { namespaces: [{ ns: 'mse-learning', revision: 0 }] } }
        resolve()
      } })
    },
  }
  const form = { getSnapshot: () => snapshot, subscribe: listener => {
    notifySnapshot = listener
    return () => { if (notifySnapshot === listener) notifySnapshot = null }
  }, mutate: async () => { throw new Error('credential conflict must not reach ConfigForm.mutate') } }
  const control = async (method, input) => {
    if (method === 'setDecisionCredential') return { ok: true, value: { ok: false, code: 'settings_conflict' } }
    if (method === 'describeDecisionCredential') return { ok: true,
      value: { ok: false, code: 'settings_conflict' } }
    if (method === 'status') return { ok: true, value: { ok: true, runtime: { jobs: [] } } }
    return { ok: true, value: { ok: true } }
  }
  const call = hostCalls({ overview: { ok: true, version: 'test', runtime: 'dsh',
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, counts: {},
    store: { readable: true, schema: 2 } } })
  const apiKey = 'synthetic-key-kept-on-refresh-failure'
  let phase = 0
  const tree = await renderPanel(registration,
    { locale: 'zh', initialTab: 'budget', call, control, form, settingsMirror }, 30, ({ nodes }) => {
      const inputFor = label => nodes.find(node => node.type?.uiName === 'Input' && node.props?.['aria-label'] === label)
      if (phase === 0) {
        const key = inputFor(mod.__test.zh.decisionApiKey)
        if (!key) return false
        key.props.onChange({ target: { value: apiKey } })
        phase = 1
        return false
      }
      if (phase === 1) {
        const save = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === mod.__test.zh.save)
        if (!save || save.props.disabled) return false
        save.props.onClick()
        phase = 2
        return false
      }
      if (phase === 2) {
        const reload = nodes.find(node => node.type?.uiName === 'Button' && labelOf(node) === mod.__test.zh.reloadHost)
        if (!reload || !JSON.stringify(nodes).includes(mod.__test.zh.draftStale)) return false
        reload.props.onClick()
        phase = 3
        return false
      }
      if (phase === 3) {
        if (mirrorLoads !== 1 || typeof resolveLoad !== 'function') return false
        const model = inputFor(mod.__test.zh.decisionModelField)
        if (!model) return false
        model.props.onChange({ target: { value: 'follow-up-edit-during-refresh' } })
        resolveLoad()
        phase = 4
        return false
      }
      if (phase === 4) {
        const model = inputFor(mod.__test.zh.decisionModelField)
        const key = inputFor(mod.__test.zh.decisionApiKey)
        const rendered = JSON.stringify(nodes)
        if (!model || !key || !rendered.includes(mod.__test.zh.settingsReloadFailed)) return false
        assert.equal(model.props.value, 'follow-up-edit-during-refresh', 'refresh cannot overwrite a later edit')
        assert.equal(key.props.value, apiKey, 'a failed refresh keeps the secret draft')
        assert.equal(snapshot.revision, 0)
        assert.ok(rendered.includes(mod.__test.zh.draftStale), 'the stale draft remains marked')
        phase = 5
        return true
      }
      return true
    }, 220)
  assert.equal(phase, 5)
  assert.equal(snapshot.revision, 0)
  assert.ok(JSON.stringify(tree).includes(mod.__test.zh.settingsReloadFailed))
})

test('常规 shows the whole library by default and the selected project beside it', async () => {
  let registration
  const window = { __ModuleLoader__: { load: value => { registration = value } } }
  const document = { createElement: () => ({ dataset: {}, remove: () => {} }), head: { append: () => {} } }
  // eslint-disable-next-line no-new-func -- the bundle is a browser script by contract.
  new Function('window', 'document', 'setInterval', 'clearInterval', SOURCE)(window, document, setInterval, clearInterval)
  const base = { ok: true, version: 'test', runtime: 'dsh', store: { readable: true, schema: 2 },
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, countsError: null,
    // The instance scope is empty in daily use — exactly the reading that used to be shown alone.
    counts: { total: 23, scopeLessons: 0, otherScope: 23, activeCorrections: 0, methodsUnvalidated: 0,
      methodsValidated: 0 },
    library: { ...FULL_LIBRARY }, scope: null, scopeReason: 'no_scope_selected', turnsObserved: 0,
    turnsObservedMeaning: 'in_process_sessions_since_process_start',
    auto: { source: 'mseLearning', plans: 2, queued: 1, running: 0, done: 1, blocked: 0, failed: null,
      interrupted: null, lastReason: 'review_budget_tokens', scans: 3, lastEvent: null, reviewTokens: 4000 },
    autoError: null }
  const tree = await renderPanel(registration, { locale: 'zh', call: hostCalls({ overview: base }), control: undefined,
    form: RENDER_FORM }, 10)
  const flat = JSON.stringify(tree)
  assert.ok(flat.includes('全库总览（默认视图）'), 'the whole library is the default view')
  assert.deepEqual(boldValues(tree), ['23', '4', '19', '7', '2', '11', '9'], 'the library numbers are rendered')
  assert.ok(flat.includes('未选择项目'), 'the page states that no project is selected')
  assert.ok(flat.includes('全库读数来自本机学习库的只读投影'), 'and what the library reading means')
  // A real zero is a restart, never "an empty library", and it is labelled as such.
  assert.ok(flat.includes(ZH_DICT.noRuns), 'the restart wording is used for a real 0')
  // The automatic queue comes from the scheduler itself, and an unpublished stage stays unknown.
  assert.ok(flat.includes('自动队列') && flat.includes('排队中 1'), 'the scheduler queue is shown')
  assert.ok(flat.includes('失败 —'), 'an unpublished queue stage is not rendered as 0')

  // With a selected project BOTH readings are on screen: the library first, then the project.
  const scoped = { ...base, scopeReason: null, scope: { kind: 'project', label: 'alpha', scopeHash: 'abcabcabc123',
    counts: { scopeLessons: 3, otherScope: 20, activeCorrections: 2, methodsUnvalidated: 1, methodsValidated: 0 } } }
  const scopedTree = await renderPanel(registration, { locale: 'zh', call: hostCalls({ overview: scoped }),
    control: undefined, form: RENDER_FORM }, 10)
  const values = boldValues(scopedTree)
  assert.deepEqual(values.slice(0, 7), ['23', '4', '19', '7', '2', '11', '9'], 'the library reading stays')
  assert.deepEqual(values.slice(7), ['3', '2', '1', '0'], 'the project counts are shown beside it')
  const scopedFlat = JSON.stringify(scopedTree)
  assert.ok(scopedFlat.includes('所选项目') && scopedFlat.includes('alpha'), 'the project block is labelled')
  assert.ok(scopedFlat.includes('全库读数与所选项目计数同时显示'), 'and the page says both are shown')

  // A PARTIAL read is stated where the numbers are: lower bounds plus a visible notice naming the
  // records nobody could attribute — the r0 P2 defect was a silent 5/6 next to a whole-store 23.
  const partialOverview = { ...base, library: { ...PARTIAL_LIBRARY } }
  const partialTree = await renderPanel(registration, { locale: 'zh', call: hostCalls({ overview: partialOverview }),
    control: undefined, form: RENDER_FORM }, 10)
  assert.deepEqual(boldValues(partialTree), ['23', '至少 5', '至少 6', '9', '—', '0', '0'],
    'the scanned categories are lower bounds and the whole-store numbers stay exact')
  const partialFlat = JSON.stringify(partialTree)
  assert.ok(partialFlat.includes('另有 12 条属于本进程未观察到的项目作用域'),
    'the unattributable records are stated with their number')
  assert.ok(partialFlat.includes('纠错、方法与试用只统计本进程已扫描的作用域'),
    'and the page explains why the categories are bounded')

  // A scan that could not even name a project is a DIFFERENT statement from a partial scan: the
  // project scopes could not be listed at all, so the page says which scan was limited.
  const limited = { ...base, libraryScan: { scopes: 1, named: 1, rows: 0, truncated: false,
    code: 'session_directory_unavailable' } }
  const limitedTree = await renderPanel(registration, { locale: 'zh', call: hostCalls({ overview: limited }),
    control: undefined, form: RENDER_FORM }, 10)
  assert.ok(JSON.stringify(limitedTree).includes('项目作用域扫描受限：宿主会话目录服务不可用'),
    'a limited project scan is stated with its own code')

  // An unreadable library is a code, never zeros that read as "nothing learned".
  const unreadable = { ...base, library: { readable: false, code: 'store_unavailable', total: null },
    turnsObserved: null }
  const brokenTree = await renderPanel(registration, { locale: 'zh', call: hostCalls({ overview: unreadable }),
    control: undefined, form: RENDER_FORM }, 10)
  const broken = JSON.stringify(brokenTree)
  assert.ok(broken.includes('全库计数不可读'), 'the failure is stated')
  assert.ok(broken.includes('学习库不可读'), 'with its own code label')
  assert.deepEqual(boldValues(brokenTree), [], 'no metric grid is rendered from an unread library')
  // An unread counter is `未知` — never "no history in this process".
  assert.ok(broken.includes('未知'), 'the counter renders as unknown')
  assert.equal(broken.includes(ZH_DICT.noRuns), false, 'an unread counter is not reported as "no runs yet"')
})

test('经验 opens a whole-library row by id alone and the detail names its owner', async () => {
  let registration
  const window = { __ModuleLoader__: { load: value => { registration = value } } }
  const document = { createElement: () => ({ dataset: {}, remove: () => {} }), head: { append: () => {} } }
  // eslint-disable-next-line no-new-func -- the bundle is a browser script by contract.
  new Function('window', 'document', 'setInterval', 'clearInterval', SOURCE)(window, document, setInterval, clearInterval)
  const overview = { ok: true, version: 'test', runtime: 'dsh', store: { readable: true, schema: 2 },
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, counts: {}, countsError: null,
    library: { ...FULL_LIBRARY }, scope: null, scopeReason: 'no_scope_selected', turnsObserved: 3 }
  const lessons = { ok: true, library: true, scope: null, scopeReason: 'no_scope_selected',
    scopeGuide: { selected: false, note: 'whole_library_read_only', omitted: 0, projects: [] },
    total: 1, scopeTotal: 1, libraryTotal: 1, unattributed: 0, storeCap: 300, complete: true, partial: false,
    page: 1, pageSize: 20, pages: 1,
    items: [{ id: 'lesson_1', kind: 'method', status: 'candidate', instruction: '保留原始空值', createdAt: 1, expiresAt: 2,
      adopted: 0, verified: 0, failed: 0, inconclusive: 0, scopeLabel: 'alpha', scopeHash: 'abcabcabc123',
      scopeKind: 'project', stage: 'queued', budget: { reviewRunTokens: 4000, holding: false },
      updatedAt: 3, nextAttemptAt: 4, reason: 'review_budget_tokens', route: { provider: 'openai', model: 'gpt-x' },
      review: null, trial: null, validation: null }] }
  // The detail the Host answers for a row located inside its OWN named scopes: no session existed.
  const detail = { ok: true, scope: { kind: 'project', label: 'alpha', scopeHash: 'abcabcabc123', sessionId: null,
    counts: { scopeLessons: 3 } }, historyError: null,
    lesson: { id: 'lesson_1', kind: 'method', status: 'candidate', instruction: '保留原始空值', createdAt: 1, expiresAt: 2,
      adopted: 0, verified: 0, failed: 0, inconclusive: 0, sourceTurn: null, currentEnvironment: null,
      applicability: '', exclusions: '', topicKey: null, value: null, historyComplete: true, replaces: null,
      replacedBy: null, validation: null, experiments: [], version: 1, stage: 'queued', attempts: 1, maxAttempts: 2,
      route: { provider: 'openai', model: 'gpt-x' }, budget: { reviewRunTokens: 4000, holding: false },
      updatedAt: 3, nextAttemptAt: 4, reason: 'review_budget_tokens', review: null, trial: null } }
  const asked = []
  const call = async (method, input) => {
    if (method === 'lesson') asked.push(input)
    return { ok: true, value: method === 'overview' ? overview : method === 'sessions' ? { ok: true, sessions: [] }
      : method === 'lessons' ? lessons : method === 'lesson' ? detail
        : { ok: true, memory: 'in-process', scope: null, recent: [], last: null, settlement: { live: [] },
          session: null } }
  }
  const tree = await renderPanel(registration, { locale: 'zh', initialTab: 'lessons', call, control: undefined,
    form: RENDER_FORM }, 14, ({ nodes }) => {
    const row = nodes.find(node => node.props?.className === 'mse-lesson')
    if (row === undefined) return false
    // The real control: the list row's own toggle, exactly what a click delivers.
    row.props.onToggle({ target: { open: true } })
    return true
  })
  // The page must ask for the row by ID ALONE: no session id, no project key, no path. That is the
  // exact call the r0 probe made (and the Host answered `lesson_not_in_scope` for 23/23).
  assert.deepEqual(asked, [{ id: 'lesson_1' }])
  const flat = JSON.stringify(tree)
  assert.ok(flat.includes('所属项目') && flat.includes('alpha'), 'the open detail names the owning project')
  assert.ok(flat.includes('保留原始空值'), 'the row is rendered')
  assert.ok(flat.includes('阶段 排队中'), 'and its read-only progress is shown in the detail')
})

test('经验 lists the whole library with each row owner and its progress', async () => {
  let registration
  const window = { __ModuleLoader__: { load: value => { registration = value } } }
  const document = { createElement: () => ({ dataset: {}, remove: () => {} }), head: { append: () => {} } }
  // eslint-disable-next-line no-new-func -- the bundle is a browser script by contract.
  new Function('window', 'document', 'setInterval', 'clearInterval', SOURCE)(window, document, setInterval, clearInterval)
  const overview = { ok: true, version: 'test', runtime: 'dsh', store: { readable: true, schema: 2 },
    budget: { turnBytes: 768, sessionBytes: 1536, maxLessons: 2 }, counts: {}, countsError: null,
    library: { ...FULL_LIBRARY }, scope: null, scopeReason: 'no_scope_selected', turnsObserved: 3 }
  const lessons = { ok: true, library: true, scope: null, scopeReason: 'no_scope_selected',
    scopeGuide: { selected: false, note: 'whole_library_read_only', omitted: 2,
      projects: [{ label: 'alpha', scopeHash: 'hash-a', lessons: 3 }, { label: 'beta', scopeHash: 'hash-b', lessons: 1 }] },
    total: 4, scopeTotal: 4, libraryTotal: 6, unattributed: 2, storeCap: 300, complete: false, truncated: true,
    scanCode: 'session_directory_unavailable',
    page: 1, pageSize: 20, pages: 1,
    items: [{ id: 'lesson_1', kind: 'method', status: 'candidate', instruction: '保留原始空值', createdAt: 1, expiresAt: 2,
      adopted: 0, verified: 0, failed: 0, inconclusive: 0, scopeLabel: 'alpha', scopeHash: 'hash-a', scopeKind: 'project',
      stage: 'queued', attempts: 1, maxAttempts: 2, updatedAt: 1_900_000_000_000, nextAttemptAt: 1_900_000_060_000,
      reason: 'review_budget_tokens', lastError: null, route: { provider: 'openai', model: 'gpt-x' },
      budget: { reviewRunTokens: 4000, holding: false }, review: null, trial: null, validation: null },
    { id: 'lesson_2', kind: 'correction', status: 'reminder', instruction: '统一人民币', createdAt: 1, expiresAt: 2,
      adopted: 1, verified: 1, failed: 0, inconclusive: 0, scopeLabel: 'beta', scopeHash: 'hash-b', scopeKind: 'project',
      stage: null, budget: null, review: null, trial: null, validation: null }] }
  const tree = await renderPanel(registration, { locale: 'zh', initialTab: 'lessons',
    call: hostCalls({ overview, lessons }), control: undefined, form: RENDER_FORM }, 12)
  const flat = JSON.stringify(tree)
  // The guide states the list is the whole library and shows where the records live.
  assert.ok(flat.includes('按项目浏览'), 'the guide is rendered')
  assert.ok(flat.includes('未选择项目：以下是全库只读列表，每行标注所属项目'), 'and explains the list')
  assert.ok(flat.includes('alpha · 3') && flat.includes('beta · 1'), 'each project and its count is listed')
  assert.ok(flat.includes('另有 2 个项目未列出'), 'the omitted projects are counted, not dropped silently')
  assert.ok(flat.includes('另有 2 条属于本进程未观察到的项目作用域'), 'unattributed records are stated')
  assert.ok(flat.includes('项目作用域扫描受限：宿主会话目录服务不可用'),
    'a limited project scan is stated with its own code')
  assert.ok(flat.includes('全库共 6 条，本次列出 4 条（库上限 300）。'), 'the footline reports the library, not the scope')
  // Each row names its owner and carries the full read-only progress.
  assert.ok(flat.includes('保留原始空值') && flat.includes('统一人民币'), 'both rows are listed')
  for (const part of ['阶段 排队中', '模型 openai/gpt-x', '评审预算 每次评审预留 4000 tokens', '未晋升原因']) {
    assert.ok(flat.includes(part), `${part} in the row`)
  }
  assert.ok(flat.includes('无自动计划'), 'a row without a plan says so instead of inventing a stage')
  assert.equal(flat.includes('本作用域共'), false, 'the scoped footline is not used for a library list')

  // The SCOPED read keeps its own rendering: no guide, no owner badge, and the scope footline.
  const scoped = { ...lessons, library: false, scope: { kind: 'project', label: 'alpha', scopeHash: 'abcabcabc123',
    counts: { scopeLessons: 3 } }, scopeGuide: { selected: true, projects: [], omitted: 0, note: null },
    scopeTotal: 3, libraryTotal: 6, unattributed: null, scanCode: null }
  const scopedTree = await renderPanel(registration, { locale: 'zh', initialTab: 'lessons',
    call: hostCalls({ overview, lessons: scoped }), control: undefined, form: RENDER_FORM }, 12)
  const scopedFlat = JSON.stringify(scopedTree)
  assert.ok(scopedFlat.includes('本作用域共 3 条，已全部读取（库上限 300）。'), 'the scoped footline is used again')
  assert.equal(scopedFlat.includes('按项目浏览'), false, 'a scoped list needs no project guide')
  assert.equal(scopedFlat.includes('alpha · 3'), false, 'the guide chips are not rendered for a scope')
  assert.ok(scopedFlat.includes('阶段'), 'the progress line stays on every row')
})
