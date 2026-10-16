// The stage-3a chain end to end: the REAL DSH adapter → the REAL scheduler → the REAL core.
//
// The independent stage-3a review found the remaining gap precisely here: the core could refuse an
// out-of-domain review, but the adapter never asked it to, the scheduler never passed the pack
// identity a reservation must carry, and nothing proved the recall side of a trial earned through
// this chain. These tests wire the actual plugin (`apply`) onto a minimal host context, drive the
// automatic pass with a recording stand-in model, and read the resulting state back through the
// core and the harness bridge.
//
// Nothing here is faked below the host boundary: the pack, the predicate, the scheduler, the core
// store and the recall budget are the shipped ones. The only stubs are the host transport
// (`ctx.llm.stream`), the host directory services, and the clock.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../adapters/dsh/index.mjs'
import { LearningEngine } from '../src/index.mjs'
import { createTaskEvidenceAuthority } from '../src/task-evidence.mjs'
import { createHarnessBridge, mseMessageSource } from '../adapters/harness.mjs'
import { packCases, packCaseCriteriaHash, packScenarioHash } from '../src/domains.mjs'

const DAY = 86_400_000

const PACK_ID = 'mse-lifecycle-v1'
const IN_DOMAIN = '处理请求时先记录代次，再把迟到结果按代次丢弃'
const OUT_OF_DOMAIN = '数字排序时先将字符串转换为数值，再按照数值从小到大排序'
const PACKAGE_PACK = 'package-json-structure-v1'
const PROJECT = '/synthetic/chain-project'
const SESSION = 'chain-session'

/**
 * A minimal Cordis-like host context, written to the REAL host contracts the plugin relies on.
 *
 * This is a synthetic host boundary, not the native app: `llm.stream` is an async iterable yielding
 * the same chunk shapes `control.readModel` consumes (text-delta / usage / finish), the prompt is
 * read from the logged user message rather than from an invented field, `sessionQuery` and
 * `workspaceRegistry` answer the live session/archive facts a permit re-reads, and effects run when
 * cordis would have run them. Nothing here relaxes a product gate: unknown usage would still be
 * refused, a blocked source would still stop the run, and a missing route would still park it.
 */
function hostContext(stateRoot, { answer, fs } = {}) {
  const services = new Map()
  const listeners = []
  const warnings = [], infos = []
  const modelCalls = []
  const mounted = []
  const effects = []
  const injections = []
  const promptOf = options => (options?.messages ?? []).map(message => (message?.content ?? [])
    .filter(block => block?.type === 'text').map(block => block.text).join('')).join('\n')
  const ctx = {
    dshHomePath: () => stateRoot,
    ...(fs ? { fs } : {}),
    logger: { warn: (...args) => warnings.push(args.map(String).join(' ')),
      info: (...args) => infos.push(args.map(String).join(' ')),
      error: (...args) => warnings.push(args.map(String).join(' ')),
      debug: () => {} },
    // `ctx.llm.stream(options)` returns an async ITERABLE; the real caller `for await`s it. It also
    // reports usage, because a provider that never measures a call is a run the product refuses to
    // treat as a known cost.
    llm: { stream: options => {
      const prompt = promptOf(options)
      const text = answer === undefined ? '' : answer({ options, prompt, system: String(options?.system ?? '') })
      modelCalls.push({ options, prompt, system: String(options?.system ?? ''), text })
      return (async function * () {
        yield { type: 'text-delta', text }
        // The protocol's own usage payload: `usageTokens` refuses to call a call measured unless
        // the provider total is there, or every component (including the cache counters) is.
        yield { type: 'usage', usage: { totalTokens: 320, inputTokens: 300, outputTokens: 20,
          cacheReadTokens: 0, cacheWriteTokens: 0 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    } },
    // The host services this plugin reads. The ones the fixture can provide are present; the rest
    // are absent, and every reader is written to answer "unknown" rather than to assume.
    get: name => services.get(name),
    provide: (name, value) => { services.set(name, value) },
    on: (name, handler) => { listeners.push({ name, handler }); return () => {} },
    // cordis runs an effect callback after the plugin has finished loading, so the fixture records
    // them and runs them on demand — a synchronous call here would reach plugin state that is
    // declared later in `apply` (and the very first one legitimately does).
    effect: fn => { effects.push(fn); return () => {} },
    inject: (names, run) => {
      const child = Object.assign(Object.create(ctx), {
        settings: { configure: () => {} },
        commands: { register: () => () => {} },
        sessionQuery: services.get('sessionQuery'),
        workspaceRegistry: services.get('workspaceRegistry'),
      })
      injections.push(() => run(child))
      return () => {}
    },
    // The host's plugin registry (cordis): the read-only UI remotes are mounted here. The fixture
    // records the registration instead of loading a browser half.
    plugin: value => { mounted.push(value); return () => {} },
    fiber: undefined,
  }
  return { ctx, services, warnings, infos, modelCalls, mounted, listeners, effects, injections, promptOf,
    // Run what the host would have run once the plugin finished loading (deferred effects and the
    // injections whose services the fixture can stand in for).
    start: () => { effects.forEach(fn => fn()); injections.forEach(fn => fn()) },
    emit: (name, ...args) => listeners.filter(row => row.name === name).forEach(row => row.handler(...args)) }
}

/**
 * The frozen-scenario answers a review run compares, in the shape the pack's checker reads.
 *
 * Both arms answer the pack's own case with the answer it fixes (`DISCARD`), and the judge reports
 * every criterion as met by BOTH arms with no winner: a legal tie, which is the control the side
 * audit already ran against the real pack and the real scheduler. It grants the trial the review is
 * allowed to grant — an explicitly unproven reference — without claiming any model benefit.
 */
const lifecycleAnswer = ({ prompt, system }) => {
  const fixed = JSON.stringify({ answer: 'DISCARD' })
  if (system.includes('准则')) {
    // The criteria ids come from the registered case, never copied by hand: a judge report that
    // invents ids is a report the structured guard refuses.
    return JSON.stringify({ winner: 'tie', reason: '两条答案都给出 DISCARD，无法区分优劣。',
      criteria: packCases(PACK_ID)[0].criteria.map(row => ({ id: row.id, met: 'both' })) })
  }
  return fixed
}

function chain({ answer = lifecycleAnswer, tokens = 20_000, calls = 3, archived = false, emit = () => {},
  omitBudgetFields = false, reflectionEnabled = false, fs = undefined } = {}) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'mse-chain-'))
  const host = hostContext(stateRoot, { answer, fs })
  // The host's own directory services, present BEFORE the plugin loads (the plugin reads them at
  // load time): one live session whose header names the project directory its turns belong to and
  // whose request header names the route they really used, plus a workspace registry whose archive
  // truth is a synchronous in-memory fact. Both are what the permit re-reads on every paid step.
  const session = { id: SESSION, cwd: PROJECT, header: { id: SESSION, cwd: PROJECT }, events: [{ seq: 1, type: 'request/header',
    data: { header: { config: { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'max' } } } }] }
  host.services.set('sessionQuery', { listSessions: async () => [session], readSession: async () => ({ session, events: session.events }) })
  host.services.set('workspaceRegistry', { archivedSessionIds: archived ? [SESSION] : [] })
  // A method recorded through the public API carries its source TURN but no session id, so its route
  // comes from the verification session the operator explicitly named — the production path for
  // reviewing a task that already happened. Nothing here borrows a route the host did not name.
  const config = { enabled: true, reflectionEnabled, autoValidationEnabled: true,
    verificationSessionId: SESSION, maxContextBytes: 768,
    ...(omitBudgetFields ? {} : { evaluationTokensPerDay: tokens, evaluationCallsPerDay: calls }) }
  apply(host.ctx, config)
  const service = host.services.get('mseLearning')
  assert.ok(service, 'the plugin must provide its service')
  // The plugin built its own engine on the host path; a second engine on the same root is the
  // read-back view (exactly what a restart of the plugin would do).
  const reader = new LearningEngine({ stateRoot, adapterId: 'dsh', maxContextBytes: 768,
    ...(omitBudgetFields ? {} : { evaluationTokensPerDay: tokens, evaluationCallsPerDay: calls }) })
  return { ...host, stateRoot, service, reader, session,
    cleanup: () => rmSync(stateRoot, { recursive: true, force: true }) }
}

test('legacy missing budgets remain fail-closed, and explicit zero/custom values survive settings reads', () => {
  const missing = chain({ omitBudgetFields: true })
  try {
    const settings = missing.service.settings()
    assert.equal(settings.user.evaluationTokensPerDay, 0)
    assert.equal(settings.user.evaluationCallsPerDay, 2)
    assert.equal(settings.effective.autoValidation, false)
  } finally { missing.cleanup() }

  for (const [tokens, calls] of [[0, 0], [12_345, 7]]) {
    const configured = chain({ tokens, calls })
    try {
      const settings = configured.service.settings()
      assert.equal(settings.user.evaluationTokensPerDay, tokens)
      assert.equal(settings.user.evaluationCallsPerDay, calls)
    } finally { configured.cleanup() }
  }
})

test('real DSH file events create the automatic package.json candidate and enter the budgeted fair queue', async t => {
  const disk = mkdtempSync(join(tmpdir(), 'mse-package-chain-'))
  const diskFile = join(disk, 'package.json')
  const virtualFile = join(PROJECT, 'package.json')
  const fs = {
    resolve: async path => ({ displayPath: path, diskPath: diskFile }),
    stat: async target => {
      const value = statSync(target.diskPath, { bigint: true })
      return { type: 'file', size: Number(value.size), version: `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}` }
    },
    readText: async target => readFileSync(target.diskPath, 'utf8'),
  }
  const answer = () => JSON.stringify({ instruction: '处理 package.json 时先按任务修复标准字段类型，生成完整 JSON，并保留所有无关字段。' })
  const c = chain({ answer, reflectionEnabled: true, tokens: 0, calls: 0, fs })
  t.after(() => { c.cleanup(); rmSync(disk, { recursive: true, force: true }) })
  c.start()
  const session = c.session
  let writes = 0
  const hostWrite = async (content, turn) => {
    writeFileSync(diskFile, content, 'utf8')
    const callId = `package-host-write-${++writes}`
    session.events.push({ type: 'tool/call', data: { callId, turn: String(turn) } })
    session.seq = session.events.length
    const exec = { name: 'str_replace_editor', token: Symbol(callId), rootCallId: callId,
      arguments: { command: writes === 1 ? 'create' : 'str_replace' }, signal: new AbortController().signal,
      agent: { session } }
    const target = await fs.resolve(virtualFile)
    const observed = await fs.stat(target)
    c.emit('fs/observed', { displayPath: virtualFile }, { kind: 'present', version: observed.version }, exec)
    c.emit('tools/result', exec, { isError: false })
    assert.equal(await waitFor(() => c.service.engine.taskEvidenceStatus().records >= writes), true,
      'the Host observer completed its bounded readback')
  }
  await driveTurn(c, session, 1, { prompt: '修复 package.json 的 scripts 字段并保留扩展字段。', duringTurn: async () => {
    await hostWrite('{"scripts":{"test":17},"extensionField":"allowed"}', 1)
    await hostWrite('{"scripts":{"test":"node --test"},"extensionField":"allowed"}', 1)
    await hostWrite('{"scripts":{"test":17},"extensionField":"allowed"}', 1)
  } })
  const sourceRow = c.service.engine.sourceStatus({ limit: 64 }).rows.find(row =>
    row.sessionHash === createHash('sha256').update(SESSION).digest('hex'))
  assert.equal(sourceRow?.driver, 'dsh_host_stream')
  assert.equal(sourceRow?.identity.reasoningState, 'explicit')
  assert.equal(sourceRow?.identity.reasoningValue, 'max')
  assert.equal(c.service.engine.taskEvidenceReplayCases({ projectKey: PROJECT, limit: 2 }).cases.length, 1,
    'the true project scope has a durable fail/control replay pair')
  const evidence = c.service.engine.taskEvidenceStatus()
  assert.equal(evidence.records, 3)
  assert.equal(evidence.replayCases, 1, 'the observed bad and normal artifacts produced a durable replay pair')
  assert.equal(await waitFor(() => c.service.engine.problemStatus({ limit: 8 }).rows.some(row => row.state === 'candidate_created')),
    true, `the ordinary problem pump reflected the host failure into a candidate without a manual lesson write: ${JSON.stringify({
      problems: c.service.engine.problemStatus({ limit: 8 }), pump: c.service.problemPump(), calls: c.modelCalls.map(x => x.prompt.slice(0, 120)) })}`)
  const candidate = c.reader.list({ projectKey: PROJECT, limit: 16 }).lessons.find(row =>
    row.kind === 'method' && row.instruction.includes('package.json'))
  assert.ok(candidate, 'the candidate came from the reflection pipeline')
  assert.equal(packCases('package-json-structure-v1').filter(row => row.split === 'development').length, 12)
  assert.equal(packCases('package-json-structure-v1').filter(row => row.split === 'holdout').length, 4)
  c.emit('settings/document-updated', 'mse-learning')
  assert.equal(await waitFor(() => c.service.autoValidation().plans > 0), true,
    'the automatic scheduler registered the domain plans even though the budget is empty')
  assert.equal(c.reader.status().evaluationTokensReserved24h, 0, 'zero budget prevents every physical evaluation reservation')
})

test('DSH automatic package trajectory: Host failure → candidate → 12+4/replay promotion → natural adoption', async t => {
  const disk = mkdtempSync(join(tmpdir(), 'mse-package-full-auto-'))
  const diskFile = join(disk, 'package.json')
  const virtualFile = join(PROJECT, 'package.json')
  const fs = {
    resolve: async path => ({ displayPath: path, diskPath: diskFile }),
    stat: async target => {
      const value = statSync(target.diskPath, { bigint: true })
      return { type: 'file', size: Number(value.size), version: `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}` }
    },
    readText: async target => readFileSync(target.diskPath, 'utf8'),
  }
  const answer = ({ prompt, system }) => {
    if (system.includes('独立的答案评审')) return JSON.stringify({ winner: 'tie', reason: '两条答案都符合冻结准则。',
      criteria: packCases(PACKAGE_PACK)[0].criteria.map(row => ({ id: row.id, met: 'both' })) })
    if (system.includes('修复后的完整 JSON 对象')) {
      let value
      try { value = JSON.parse(prompt) } catch { return '{"scripts":{"test":"node --test"}}' }
      for (const [key, replacement] of Object.entries({ name: 'app', version: '1.0.0', description: '',
        homepage: 'https://example.invalid', private: true, files: [], scripts: { test: 'node --test' } })) {
        if (Object.hasOwn(value, key)) {
          if (key === 'scripts' && value.scripts && typeof value.scripts === 'object') {
            value.scripts = Object.fromEntries(Object.keys(value.scripts).map(name => [name, 'node --test']))
          } else value[key] = replacement
        }
      }
      return JSON.stringify(value)
    }
    const testCase = packCases(PACKAGE_PACK).find(row => prompt.includes(row.prompt))
    if (testCase && system.includes('冻结验证场景')) return JSON.stringify(testCase.checker.expected)
    if (testCase && system.includes('你是任务执行器')) return system.includes('严格按下面这条方法作答')
      ? JSON.stringify(testCase.checker.expected) : '{}'
    return JSON.stringify({ instruction: '修复 package.json 时只修改标准字段的错误类型，保留扩展字段并输出完整 JSON。' })
  }
  const c = chain({ answer, reflectionEnabled: true, tokens: 50_000, calls: 5, fs })
  t.after(() => { c.cleanup(); rmSync(disk, { recursive: true, force: true }) })
  c.start()
  const session = c.session
  let writes = 0
  const hostWrite = async (content, turn) => {
    writeFileSync(diskFile, content, 'utf8')
    const callId = `full-auto-host-write-${++writes}`
    session.events.push({ type: 'tool/call', data: { callId, turn: String(turn) } })
    session.seq = session.events.length
    const exec = { name: 'str_replace_editor', token: Symbol(callId), rootCallId: callId,
      arguments: { command: writes === 1 ? 'create' : 'str_replace' }, signal: new AbortController().signal,
      agent: { session } }
    const target = await fs.resolve(virtualFile)
    const observed = await fs.stat(target)
    c.emit('fs/observed', { displayPath: virtualFile }, { kind: 'present', version: observed.version }, exec)
    c.emit('tools/result', exec, { isError: false })
    if (writes <= 3) assert.equal(await waitFor(() => c.service.engine.taskEvidenceStatus().records >= writes), true)
  }

  await driveTurn(c, session, 1, { prompt: '修复 package.json 的 scripts 字段并保留扩展字段。', duringTurn: async () => {
    await hostWrite('{"scripts":{"test":17},"extensionField":"allowed"}', 1)
    await hostWrite('{"scripts":{"test":"node --test"},"extensionField":"allowed"}', 1)
    await hostWrite('{"scripts":{"test":17},"extensionField":"allowed"}', 1)
  } })
  const sourceRow = c.service.engine.sourceStatus({ limit: 64 }).rows.find(row =>
    row.sessionHash === createHash('sha256').update(SESSION).digest('hex'))
  assert.equal(sourceRow?.driver, 'dsh_host_stream')
  assert.equal(sourceRow?.identity.reasoningState, 'explicit')
  assert.equal(sourceRow?.identity.reasoningValue, 'max')
  assert.equal(await waitFor(() => c.service.engine.problemStatus({ limit: 8 }).rows.some(row => row.state === 'candidate_created')),
    true, 'Host checker failure automatically produces a candidate')
  const candidate = c.reader.list({ projectKey: PROJECT, limit: 16 }).lessons.find(row =>
    row.kind === 'method' && row.instruction.includes('package.json'))
  assert.ok(candidate)
  assert.equal(packCases(PACKAGE_PACK).filter(row => row.split === 'development').length, 12)
  assert.equal(packCases(PACKAGE_PACK).filter(row => row.split === 'holdout').length, 4)
  let promoted = false
  const routeReads = []
  const sessionQuery = c.services.get('sessionQuery')
  const readSession = sessionQuery.readSession
  sessionQuery.readSession = async id => { routeReads.push(id); return readSession(id) }
  for (let attempt = 0; attempt < 20 && !promoted; attempt += 1) {
    c.emit('settings/document-updated', 'mse-learning')
    for (let poll = 0; poll < 60 && !promoted; poll += 1) {
      promoted = c.reader.list({ projectKey: PROJECT, limit: 16 }).lessons
        .find(row => row.id === candidate.id)?.status === 'validated'
      if (!promoted) await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  assert.equal(promoted, true,
  `automatic objective did not promote: ${JSON.stringify({ calls: c.modelCalls.length,
    status: c.reader.list({ projectKey: PROJECT, limit: 16 }).lessons.find(row => row.id === candidate.id),
    audit: c.service.autoValidation(), calls: c.modelCalls.map(row => ({ system: row.system.slice(0, 100),
      prompt: row.prompt.slice(0, 140), text: row.text })), routeReads,
    plans: c.reader.autoPlans() })}`)
  assert.ok(c.modelCalls.some(row => row.prompt.startsWith('{"scripts":{"test":17}')),
    'the frozen bad/control replay pair reached the automatic candidate arm')

  const adoptedVersion = c.reader.inspect({ projectKey: PROJECT, id: candidate.id }).lessons[0].version
  const taskAuthority = createTaskEvidenceAuthority(c.service.engine)
  const wrongScopeContent = '{"scripts":{"test":17},"binding":"wrong-scope"}'
  const wrongEnvironmentContent = '{"scripts":{"test":17},"binding":"wrong-environment"}'
  const recordUnbound = (eventId, content, projectKey, environmentId) => c.service.engine.recordPackageJsonArtifact(taskAuthority, {
    adapterId: 'dsh', content, environmentId, eventId, filename: 'package.json',
    fileHash: createHash('sha256').update(content).digest('hex'), lessonId: null, lessonVersion: null,
    model: 'fixture-model', projectKey, provider: 'fixture-provider', reasoningEffort: 'max',
    sessionId: SESSION, toolchain: 'dsh-file-editor-v1', turnId: '2' })
  recordUnbound('wrong-scope-before-adoption', wrongScopeContent, `${PROJECT}/other`, c.service.environmentId ?? null)
  recordUnbound('wrong-environment-before-adoption', wrongEnvironmentContent, PROJECT, 'different-environment')
  let preAdoptionDigest
  const adoption = await driveTurn(c, session, 2, { prompt: candidate.instruction,
    beforeStream: async () => {
      await hostWrite('{"scripts":{"test":17},"extensionField":"before-adoption-commit"}', 2)
      assert.equal(await waitFor(() => c.service.engine.taskEvidenceStatus().records >= 6), true)
      preAdoptionDigest = c.service.engine.store.read().taskEvidence.records.at(-1).digest
    },
    duringTurn: async () => {
      assert.ok(c.service.engine.taskEvidenceStatus().latest.length >= 1)
    } })
  assert.ok(adoption.decision.messages.some(row => row.source?.kind === 'plugin:mse-learning'),
    'the next natural task receives the promoted method through DSH recall')
  assert.equal(await waitFor(() => c.reader.inspect({ projectKey: PROJECT, id: candidate.id }).lessons[0]?.status === 'suspended'),
    true, 'same-turn trusted Host counterevidence withdraws the promoted method')
  const evidenceLedger = c.service.engine.store.read().taskEvidence
  assert.equal(evidenceLedger.adoptionAttributions.length, 1)
  const sourceBinding = evidenceLedger.records.find(row => row.digest === preAdoptionDigest).sourceBinding
  assert.deepEqual(evidenceLedger.adoptionAttributions[0], { ...sourceBinding, evidenceDigest: preAdoptionDigest,
    lessonId: candidate.id, version: adoptedVersion, at: evidenceLedger.adoptionAttributions[0].at },
  'accept binds only the exact scope/environment raw fact to the accepted version without rewriting its digest')
  const retired = c.reader.inspect({ projectKey: PROJECT, id: candidate.id }).lessons[0]
  assert.equal(retired.suspensionReason, 'regression')
  const cold = new LearningEngine({ stateRoot: c.stateRoot, adapterId: 'dsh', now: () => Date.now(),
    evaluationTokensPerDay: 50_000, evaluationCallsPerDay: 5 })
  const next = cold.prepare({ sessionId: SESSION, turnId: '3', origin: 'user', projectKey: PROJECT,
    prompt: candidate.instruction })
  assert.equal(next.lessonVersions?.some(row => row.id === candidate.id), false,
    'the Host-withdrawn version remains out of recall after a cold core restart')
  assert.deepEqual(cold.store.read().taskEvidence.adoptionAttributions, evidenceLedger.adoptionAttributions,
    'the exact evidence attribution survives store reopen')
  assert.ok(c.service.engine.status().evaluationCallsLast24h <= 5)
  assert.ok(c.service.engine.status().evaluationTokensReserved24h <= 50_000)
})

const method = (engine, instruction) => {
  const recorded = engine.record({ projectKey: PROJECT, source: 'host_proposal', kind: 'method',
    eventId: `chain-${Math.random().toString(16).slice(2)}`, instruction,
    // A complete source identity — session AND turn — so the run is bound to the session whose
    // route the host directory above really records.
    sessionId: SESSION, sourceTurn: 'a'.repeat(64) })
  return engine.list({ projectKey: PROJECT, limit: 10 }).lessons.find(row => row.id === recorded.id)
}

/**
 * Drive the plugin the way the HOST does: a real settings/turn event schedules a scan, the scan
 * prepares its own feed (including each session's recorded route, which is what a paid run needs),
 * and the lesson's own state is polled until the background work has settled.
 */
const settle = async (c, lessonId, stateOf, expected) => {
  c.emit('settings/document-updated', 'mse-learning')
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = c.reader.list({ projectKey: PROJECT, limit: 10 }).lessons.find(row => row.id === lessonId)
    if (stateOf(state) === expected) return state
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`the chain did not reach ${expected}: ${JSON.stringify({
    review: c.reader.list({ projectKey: PROJECT, limit: 10 }).lessons.find(row => row.id === lessonId)?.review ?? null,
    plans: c.service.autoValidation().plans, events: c.service.autoValidation().events })}`)
}

test('an unrelated method is refused by the REAL adapter before any plan, ticket or call', async () => {
  const c = chain()
  try {
    const lesson = method(c.reader, OUT_OF_DOMAIN)
    c.emit('settings/document-updated', 'mse-learning')
    // Nothing is scheduled for it, so the wait is observed after the host's own scan has run.
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if ((c.service.autoValidation().events ?? []).some(row => row.code.startsWith('review_out_of_domain:'))) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const state = c.service.autoValidation()
    assert.equal(state.plans, 0, 'an out-of-domain method registers no plan at all')
    assert.equal(c.reader.status().evaluationJobsOpen, 0, 'no ticket was reserved')
    assert.equal(c.reader.status().evaluationTokensReserved24h, 0, 'no paid call was reserved')
    const reasons = (state.events ?? []).map(row => row.code)
    assert.ok(reasons.some(code => code.startsWith('review_out_of_domain:')),
      `the wait states the refusing predicate: ${JSON.stringify(reasons)}`)
    assert.equal(c.modelCalls.length, 0, 'the provider was never reached')
    const stored = c.reader.list({ projectKey: PROJECT, limit: 10 }).lessons.find(row => row.id === lesson.id)
    assert.equal(stored.trial ?? null, null)
  } finally { c.cleanup() }
})

test('an admitting method runs the frozen pack scenario and earns a domain-bound trial', async () => {
  const c = chain()
  try {
    const lesson = method(c.reader, IN_DOMAIN)
    const stored = await settle(c, lesson.id, row => row?.review?.state ?? null, 'reviewed')
    // Two arms and two judge passes on the frozen scenario: the chain really paid for a comparison,
    // and the two judge passes really saw the labels in opposite orders. The objective track runs
    // its own pack cases in the same process, so the review calls are counted apart by their own
    // frozen-scenario system prompt rather than by "everything the provider saw".
    // The review track is the one whose calls carry the frozen scenario's judge system prompt; the
    // objective track answers the pack's own cases with the task-executor prompt. `maxTokens` is not
    // a usable discriminator here (both tracks pass their reservation size to the provider).
    const isReview = call => call.system.includes('你在执行一个冻结验证场景')
      || call.system.includes('你是独立的答案评审')
    const reviewCalls = c.modelCalls.filter(isReview)
    assert.equal(reviewCalls.length, 4, `expected four review calls, got ${reviewCalls.length}`)
    const judgeCalls = reviewCalls.filter(call => call.system.includes('准则'))
    assert.equal(judgeCalls.length, 2, 'two judge passes, one per blind labelling')
    // The objective track answers the pack's own cases on the SAME route in the same process: its
    // extra calls are counted apart, never folded into the review run's four.
    assert.ok(c.modelCalls.length > reviewCalls.length, 'the objective track really ran beside the review')
    // Both arms answer the SAME fixed text here, so the two judge passes are textually identical by
    // construction: what makes the pair a real cross-check is the label→arm ledger the host owns,
    // and the run being accepted as a swapped pair is the observable proof it was one (a
    // position-only agreement is refused as `swapped_only`, and did not happen here).
    assert.equal(stored.review.agreement, 'neutral_safe', JSON.stringify(stored.review))
    assert.deepEqual(stored.review.reasons, ['review_neutral_safe'],
      'a legal tie passes the guard without inventing a winner')
    assert.equal(stored.review.benefit, 'unproven', 'the trial is a licence to try, never a proven benefit')
    assert.equal(stored.review.packId, PACK_ID, 'the review row records the domain it was judged in')
    assert.equal(stored.trial.state, 'trial')
    assert.equal(stored.trial.packId, PACK_ID, 'the trial carries the domain it was earned in')
    assert.equal(stored.trial.packVersion, 1)
    assert.equal(c.service.autoValidation().plans, 2, 'both tracks registered for an admitted method')
  } finally { c.cleanup() }
})

test('the trial earned through the chain is recalled inside the pack domain only', async () => {
  const c = chain()
  try {
    const lesson = method(c.reader, IN_DOMAIN)
    await settle(c, lesson.id, row => row?.review?.state ?? null, 'reviewed')
    const bridge = createHarnessBridge({ engine: c.reader,
      createMessage: text => ({ id: 'plugin-1', role: 'user', source: mseMessageSource('instructions'),
        content: [{ type: 'text', text }] }) })
    // The session carries the project directory, which is what maps this turn to the same scope the
    // lesson was learned in: a receipt is only ever written for the scope the recall resolved.
    const ask = (prompt, turnId) => bridge.preStep({ agent: { session: { id: SESSION, header: { cwd: PROJECT }, events: [] } },
      step: 1, turn: 1, messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }],
      signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
    // Out of domain: the trial is not offered, so no line and no bytes are spent on it.
    // In the pack's own domain the trial is offered: the bridge appends exactly one plugin message,
    // and it says what the tier is. Out of domain nothing at all is appended — no line, no bytes.
    const inside = await ask('处理请求时先记录代次，再把迟到结果按代次丢弃，然后提交结算', '1')
    assert.equal(inside.messages.length, 1, 'the pack domain recalls the trial')
    const injected = inside.messages[0].content.map(part => part.text).join('')
    const outside = await ask('数字排序时先将字符串转换为数值，再按照数值从小到大排序', '2')
    assert.equal(outside.messages.length, 0,
      `an out-of-domain task injects nothing: ${JSON.stringify(bridge.lastRecall(SESSION))}`)
    assert.ok(injected.includes('仅供'), 'a trial line says what it is')
    assert.equal(Buffer.byteLength(injected), 234, 'the trial line keeps its bounded size')
    const state = c.reader.list({ projectKey: PROJECT, limit: 10 }).lessons.find(row => row.id === lesson.id)
    assert.equal(state.trial.packId, PACK_ID)
  } finally { c.cleanup() }
})

test('the chain stops asking when the reservation it was authorised for is withdrawn', async () => {
  const c = chain()
  try {
    const lesson = method(c.reader, IN_DOMAIN)
    let stored = await settle(c, lesson.id, row => row?.trial?.state ?? null, 'trial')
    // The withdrawal is the operator's, and it happens through the core the plugin writes to.
    c.reader.withdrawTrial({ lessonId: lesson.id, projectKey: PROJECT, reason: 'user_correction' })
    stored = c.reader.list({ projectKey: PROJECT, limit: 10 }).lessons.find(row => row.id === lesson.id)
    assert.equal(stored.trial.state, 'withdrawn')
    assert.equal(stored.status, 'tested', 'a withdrawal does not promote anything')
    assert.equal(stored.review.state, 'reviewed', 'the review that happened is kept as history')
  } finally { c.cleanup() }
})

/**
 * Stage 3b, through the REAL plugin: no test calls `maintainLearning` here.
 *
 * The licence is earned exactly the way production earns one (the core's own review contract, the
 * registered pack, the frozen case) — only the clock is fifteen days in the past. The plugin's engine
 * runs on the REAL clock, so its own bounded wake-up is what has to recognise the expiry. A business
 * fixture calling maintenance by hand only proves the core; this proves the plugin's lifecycle path.
 */
test('the plugin wakes up, retires an expired licence and buys no renewal without new evidence', async () => {
  const c = chain()
  try {
    // Run the effects the host would run once the plugin finished loading, so this test exercises the
    // plugin's own settings listener (the deferred effect), not only its startup pass.
    c.start()
    const past = new LearningEngine({ stateRoot: c.stateRoot, adapterId: 'dsh', now: () => Date.now() - 15 * DAY,
      evaluationTokensPerDay: 20_000, evaluationCallsPerDay: 3 })
    const lesson = method(past, IN_DOMAIN)
    const plan = past.autoPlanRegister({ lessonId: lesson.id, version: lesson.version, environment: 'default',
      track: 'review', source: { kind: 'turn', sessionId: SESSION, turnId: lesson.sourceTurn,
        route: { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'max' } },
      suite: { packId: PACK_ID, version: 1 }, criteria: packCases(PACK_ID)[0].criteria }).plan
    const caseId = packCases(PACK_ID)[0].caseId
    const reserved = past.reviewRequest({ lessonId: lesson.id, projectKey: PROJECT, expectedVersion: lesson.version,
      maxTokens: 4_000, steps: 4, inputChars: 1, stepOutputTokens: 1,
      planHash: plan.planHash, queueKey: plan.queueKey, packId: PACK_ID, caseId,
      scenarioHash: packScenarioHash(PACK_ID, caseId), criteriaHash: packCaseCriteriaHash(PACK_ID, caseId),
      criteria: packCases(PACK_ID)[0].criteria })
    assert.ok(reserved.ticket, 'the fixture must really reserve the review')
    const verdict = past.reviewResult({ ticket: reserved.ticket, projectKey: PROJECT, planHash: plan.planHash,
      first: '{"winner":"A"}', second: '{"winner":"B"}', swapped: true, structuredPassed: true,
      answers: { candidate: '先记录代次，迟到结果按代次丢弃，并说明如何处理旧结果。',
        baseline: '直接处理即可，不需要额外记录任何东西，也不用核对代次。' },
      criteria: packCases(PACK_ID)[0].criteria,
      route: { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'max' },
      judge: 'fixture-provider/fixture-model', spent: 80, costKnown: true })
    assert.equal(verdict.trial, 'trial', 'the fixture must really earn a trial fifteen days ago')
    const before = c.modelCalls.length
    // The host's ordinary notification: this is the plugin's own wake-up, not a test-only entry point.
    c.emit('settings/document-updated', 'mse-learning')
    let stored = null
    for (let attempt = 0; attempt < 200; attempt += 1) {
      stored = c.reader.list({ projectKey: PROJECT, limit: 10 }).lessons.find(row => row.id === lesson.id)
      if (stored?.trial?.reason === 'trial_expired') break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(stored.trial.state, 'withdrawn', 'the plugin retired the licence on its own wake-up')
    assert.equal(stored.trial.reason, 'trial_expired')
    assert.equal(stored.renewal.state, 'waiting_evidence', 'no new evidence means no renewal window opens')
    assert.equal(stored.renewal.reason, 'none')
    assert.ok(Math.abs(stored.renewal.licenceAt - (Date.now() - 15 * DAY)) < 60_000,
      `the retired licence is named in the audit: ${stored.renewal.licenceAt}`)
    // Nothing was bought for the renewal: the review track issued no call at all. (The objective track
    // is an INDEPENDENT judgement against the host pack and may legitimately run for the new edition.)
    const isReview = call => call.system.includes('你在执行一个冻结验证场景')
      || call.system.includes('你是独立的答案评审')
    assert.equal(c.modelCalls.slice(before).filter(isReview).length, 0,
      'an expired licence without new evidence buys no review run')
    // One more ordinary wake-up: the feed is rebuilt from the retired row, the plugin sees the NEW
    // edition — and still buys no review. What happens to that edition is one of exactly two things,
    // both governed by the host: it WAITS with its own reason visible on the operator surface, or the
    // independent OBJECTIVE track judges it against the host pack (which outranks the trial question
    // entirely). A model renewal review is neither.
    const callsAfterRetirement = c.modelCalls.length
    c.emit('settings/document-updated', 'mse-learning')
    let events = []
    let current = null
    for (let attempt = 0; attempt < 200; attempt += 1) {
      events = c.service.autoValidation().events ?? []
      current = c.reader.list({ projectKey: PROJECT, limit: 10 }).lessons.find(row => row.id === lesson.id)
      if (events.some(row => row.code === 'renewal_waiting_evidence') || current?.status === 'validated') break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const waited = events.some(row => row.code === 'renewal_waiting_evidence')
    assert.ok(waited || current?.status === 'validated',
      `the edition either waits with its reason or is judged by the host pack: ${JSON.stringify({
        events, status: current?.status, version: current?.version, trial: current?.trial,
        renewal: current?.renewal, auto: current?.auto, queue: c.service.autoValidation() })}`)
    assert.equal(c.modelCalls.slice(callsAfterRetirement).filter(isReview).length, 0,
      'and the deferred scan still buys no review run')
  } finally { c.cleanup() }
})

/**
 * The session-facts cache lifecycle, through the REAL plugin listeners.
 *
 * The confirmed directory is a POINT-IN-TIME fact with a 30-second lifetime. A session created after
 * it is simply absent from it — and that absence used to be read as `session_deleted`, which refused
 * the live session's own settlement (`lastError=session_deleted`, never withdrawn). These two cases
 * drive a real turn through `agent/pre-step` → `llm/stream` → `session/event`, so the REAL guard and
 * the REAL settlement queue decide; nothing here refreshes, restores or scans on the product's behalf.
 */
const driveTurn = async (c, session, turn = 1, { prompt = IN_DOMAIN, beforeStream = async () => {},
  duringTurn = async () => {} } = {}) => {
  const handlers = name => c.listeners.filter(row => row.name === name).map(row => row.handler)
  const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }
  const decision = await handlers('agent/pre-step')[0]({ agent: { session,
    options: { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'max' } }, step: 1, turn,
    messages: [message], signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [message] }))
  await beforeStream({ decision })
  for await (const chunk of handlers('llm/stream')[0]({ sessionId: session.header.id, messages: decision.messages },
    async function * () { yield { type: 'finish', reason: { kind: 'stop' } } })) assert.equal(chunk.type, 'finish')
  await duringTurn({ handlers, decision })
  for (const handler of handlers('session/event')) {
    handler(session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return { decision }
}
/** Poll a REAL observable — the durable queue and the live retry set — never a manual nudge. */
const waitFor = async predicate => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

test('a session created after the confirmed directory is never judged deleted', async () => {
  const c = chain()
  try {
    c.start()
    // One lesson with a live trial, so a turn really recalls — and therefore really settles.
    const lesson = method(c.reader, IN_DOMAIN)
    await settle(c, lesson.id, row => row?.review?.state ?? null, 'reviewed')
    // A mutable host directory: A exists now, B does not exist yet.
    const a = { id: SESSION, header: { id: SESSION, cwd: PROJECT }, events: [] }
    const b = { id: 'late-session', header: { id: 'late-session', cwd: PROJECT }, events: [] }
    let sessions = [a]
    let pulls = 0
    const query = c.services.get('sessionQuery')
    query.listSessions = async () => { pulls += 1; return sessions }
    query.readSession = async id => sessions.find(row => row.header.id === id) ?? a
    // THE STALE SNAPSHOT: a settings save confirms the directory NOW, while B does not exist.
    c.emit('settings/document-updated', 'mse-learning')
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.ok(pulls > 0, 'the confirmed directory was really pulled')
    // B is CREATED after that snapshot, well inside the 30-second TTL.
    sessions = [a, b]
    const turn = await driveTurn(c, b)
    assert.equal(turn.decision.messages.length, 2, 'the trial really recalls for the new session')
    const settled = await waitFor(() => c.service.durableStatus().counts.pending === 0)
    assert.equal(settled, true, `the late session settled: ${JSON.stringify({
      durable: c.service.durableStatus(), rows: c.service.settlementStatus() })}`)
    assert.equal(c.service.settlementStatus().some(row => row.lastError === 'session_deleted'), false,
      'a session the snapshot simply predates is never a deletion')
    assert.notEqual(c.service.recallStatus(b.header.id)?.last?.settleError ?? null, 'session_deleted')
  } finally { c.cleanup() }
})

test('a failing directory refuses with unknown, never with a deletion, and converges', async () => {
  const c = chain()
  try {
    c.start()
    const lesson = method(c.reader, IN_DOMAIN)
    await settle(c, lesson.id, row => row?.review?.state ?? null, 'reviewed')
    const a = { id: SESSION, header: { id: SESSION, cwd: PROJECT }, events: [] }
    const d = { id: 'outage-session', header: { id: 'outage-session', cwd: PROJECT }, events: [] }
    let sessions = [a]
    let failing = true
    const query = c.services.get('sessionQuery')
    query.listSessions = async () => { if (failing) throw new Error('directory unavailable'); return sessions }
    query.readSession = async id => sessions.find(row => row.header.id === id) ?? a
    c.emit('settings/document-updated', 'mse-learning')
    await new Promise(resolve => setTimeout(resolve, 80))
    // The directory cannot answer, and the session is new: the only honest answer is "unknown".
    await driveTurn(c, d)
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(c.service.durableStatus().counts.pending, 1, 'a refused settlement really stays pending')
    assert.equal(c.service.settlementStatus().some(entry => entry.lastError === 'session_deleted'), false,
      `an unreachable directory is not a deletion: ${JSON.stringify(c.service.settlementStatus())}`)
    // The host answers again with the session present: the product's OWN retry converges — the queue
    // schedules it and the guard asks for the refresh — with no manual restore, refresh or scan.
    failing = false
    sessions = [a, d]
    const settled = await waitFor(() => c.service.durableStatus().counts.pending === 0)
    assert.equal(settled, true, `the outage recovered: ${JSON.stringify({
      durable: c.service.durableStatus(), rows: c.service.settlementStatus() })}`)
  } finally { c.cleanup() }
})

test('a listing that started before a new session appeared can never stop it', async () => {
  const c = chain()
  try {
    // The directory stub is installed BEFORE the host effects run: the plugin's very first listing
    // (its startup readiness pull) is then the one that hangs, which is the race itself.
    const a = { id: SESSION, header: { id: SESSION, cwd: PROJECT }, events: [] }
    const b = { id: 'race-session', header: { id: 'race-session', cwd: PROJECT }, events: [] }
    let sessions = [a]
    let deferred = true
    let pulls = 0
    const answering = []
    const query = c.services.get('sessionQuery')
    query.listSessions = () => {
      pulls += 1
      const captured = [...sessions]
      if (deferred !== true) return Promise.resolve(captured)
      deferred = false
      return new Promise(resolve => { answering.push(() => resolve(captured)) })
    }
    query.readSession = async id => sessions.find(row => row.header.id === id) ?? a
    c.start()
    // A settings save is the plugin's own readiness moment: it confirms the directory and its listing
    // is the one that now hangs, holding [A].
    c.emit('settings/document-updated', 'mse-learning')
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(pulls, 1, 'exactly one listing is in flight')
    // A lesson with a real trial, written through the core's own contract: no settings save, so the
    // in-flight listing is NOT invalidated and the race is really exercised.
    const lesson = method(c.reader, IN_DOMAIN)
    const plan = c.reader.autoPlanRegister({ lessonId: lesson.id, version: lesson.version, environment: 'default',
      track: 'review', source: { kind: 'turn', sessionId: SESSION, turnId: lesson.sourceTurn,
        route: { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'max' } },
      suite: { packId: PACK_ID, version: 1 }, criteria: packCases(PACK_ID)[0].criteria }).plan
    const caseId = packCases(PACK_ID)[0].caseId
    const reserved = c.reader.reviewRequest({ lessonId: lesson.id, projectKey: PROJECT, expectedVersion: lesson.version,
      maxTokens: 4_000, steps: 4, inputChars: 1, stepOutputTokens: 1,
      planHash: plan.planHash, queueKey: plan.queueKey, packId: PACK_ID, caseId,
      scenarioHash: packScenarioHash(PACK_ID, caseId), criteriaHash: packCaseCriteriaHash(PACK_ID, caseId),
      criteria: packCases(PACK_ID)[0].criteria })
    assert.ok(reserved.ticket)
    assert.equal(c.reader.reviewResult({ ticket: reserved.ticket, projectKey: PROJECT, planHash: plan.planHash,
      first: '{"winner":"A"}', second: '{"winner":"B"}', swapped: true, structuredPassed: true,
      answers: { candidate: '先记录代次，迟到结果按代次丢弃，并说明如何处理旧结果。',
        baseline: '直接处理即可，不需要额外记录任何东西，也不用核对代次。' },
      criteria: packCases(PACK_ID)[0].criteria,
      route: { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'max' },
      judge: 'fixture-provider/fixture-model', spent: 80, costKnown: true }).trial, 'trial')
    // B APPEARS while that listing is still in flight, and really recalls and really settles.
    sessions = [a, b]
    const turn = await driveTurn(c, b)
    assert.equal(turn.decision.messages.length, 2, 'the new session really recalls')
    // The OLD listing answers NOW, holding [A] — long after B was evidenced to exist.
    answering.splice(0).forEach(answer => answer())
    await new Promise(resolve => setTimeout(resolve, 150))
    // The directory really contains B, and the product converges to a normal settlement on its own.
    const settled = await waitFor(() => c.service.durableStatus().counts.pending === 0)
    assert.equal(settled, true, `the raced session settled: ${JSON.stringify({
      durable: c.service.durableStatus(), rows: c.service.settlementStatus() })}`)
    assert.equal(c.service.durableStatus().control.stops, 0, 'and B was never permanently stopped')
    assert.equal(c.service.durableStatus().pending.some(row => row.lastError === 'session_deleted'), false,
      'the raced session was never judged deleted')
    assert.equal(c.service.settlementStatus().some(row => row.state === 'stopped'), false,
      JSON.stringify(c.service.settlementStatus()))
    // Control: a session a NEWER listing confirms gone is still refused — the gate is not relaxed.
    // This one runs a turn (which is what evidences it) while the directory — sampled afterwards —
    // does not list it at all, so its settlement must not commit.
    const gone = { id: 'gone-session', header: { id: 'gone-session', cwd: PROJECT }, events: [] }
    const goneTurn = await driveTurn(c, gone)
    assert.equal(goneTurn.decision.messages.length, 2, 'the confirmation case really recalls first')
    // The CORE's own row carries the guard's reason (`session_deleted`); the local row carries the
    // wrapper's code, so the honest observable is the durable one.
    const refused = await waitFor(() => c.service.durableStatus().pending.some(row => row.lastError === 'session_deleted')
      || c.service.durableStatus().control.stops > 0)
    assert.equal(refused, true, `a confirmed deletion is still refused: ${JSON.stringify({
      durable: c.service.durableStatus(), rows: c.service.settlementStatus() })}`)
    assert.equal(c.service.durableStatus().counts.pending, 1, 'and a refused settlement never commits')
  } finally { c.cleanup() }
})
