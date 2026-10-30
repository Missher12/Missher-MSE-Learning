/**
 * Host Remote services for the slim path — the released bundle's registration pattern:
 * `ctx.provide('mseRebuild', …)` for the engine handle, `ctx.plugin(Class)` for the typed
 * Remotes, with the invocation manifest declared in ./typert.mjs. Status is read-only; the
 * control face is the human path (pause, explicit audited retry, real checker run) and is
 * never a model tool.
 */
import { Remote, TypertRemoteService, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { runChecker } from './checker.mjs'

function markRemote(Class, method) {
  const descriptor = Object.getOwnPropertyDescriptor(Class.prototype, method)
  if (descriptor === undefined || typeof descriptor.value !== 'function') {
    throw new TypeError(`mse-rebuild: cannot mark missing Remote method ${method}`)
  }
  const initializers = []
  Remote(method)(descriptor.value, { kind: 'method', name: method, static: false, private: false,
    addInitializer: initializer => { initializers.push(initializer) } })
  const probe = Object.create(Class.prototype)
  for (const initializer of initializers) initializer.call(probe)
}

export class MseRebuildStatus extends TypertRemoteService {
  static inject = []

  constructor(ctx) {
    super(ctx, 'mseRebuildStatus')
  }

  core() {
    const service = this.ctx.get('mseRebuild')
    return service === undefined || service === null ? null : service
  }

  /** One shape end to end: the panel reads exactly these fields. The parameter is a bare
   * identifier — the real gateway's source-mode reflection (index.js#methodParameterNames)
   * rejects defaults/destructuring/rest in the signature, so nulls are handled in the body. */
  async status(input) {
    input ??= {}
    const core = this.core()
    if (core === null) return { ok: false, code: 'core_unavailable' }
    const view = core.statusView()
    return { ok: true, view }
  }
}

export class MseRebuildControl extends TypertRemoteService {
  static inject = []

  constructor(ctx) {
    super(ctx, 'mseRebuildControl')
  }

  core() {
    const service = this.ctx.get('mseRebuild')
    return service === undefined || service === null ? null : service
  }

  async pause(input) {
    input ??= {}
    const core = this.core()
    if (core === null) return { ok: false, code: 'core_unavailable' }
    core.engine.pause(input?.paused === true)
    return { ok: true, paused: core.engine.paused }
  }

  /** One explicit human retry for a known-truncated/failed request; audited, never automatic. */
  async retryRequest(input) {
    input ??= {}
    const core = this.core()
    if (core === null) return { ok: false, code: 'core_unavailable' }
    return core.allowRetry(typeof input?.ticket === 'string' ? input.ticket : '')
  }

  /** Run a real deterministic checker and bind the objective result to one injected version. */
  async runCheck(input) {
    input ??= {}
    const core = this.core()
    if (core === null) return { ok: false, code: 'core_unavailable' }
    const report = runChecker(String(input?.checkId ?? ''), { file: input?.file, root: core.stateRoot })
    if (report.status === 'not_applicable') return { ok: true, report }
    const settled = core.engine.recordCheck({
      checkId: report.checkId,
      passed: report.status === 'pass',
      evidence: { reason: report.reason, bytes: report.bytes ?? null },
      sessionId: String(input?.sessionId ?? 'checker'),
      turnId: String(input?.turnId ?? 'direct'),
      entryId: typeof input?.entryId === 'string' ? input.entryId : null,
      entryVersion: Number.isSafeInteger(input?.entryVersion) ? input.entryVersion : null,
      eventId: typeof input?.eventId === 'string' ? input.eventId : null,
    })
    return { ok: true, report, settled }
  }
}

const STATUS_ENDPOINTS = ['status']
const CONTROL_ENDPOINTS = ['pause', 'retryRequest', 'runCheck']
for (const method of STATUS_ENDPOINTS) markRemote(MseRebuildStatus, method)
for (const method of CONTROL_ENDPOINTS) markRemote(MseRebuildControl, method)

export function apply(ctx) {
  ctx.plugin(MseRebuildStatus)
  ctx.plugin(MseRebuildControl)
}

export { remoteMethods }
