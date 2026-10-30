/**
 * Plugin-owned Host invocation manifest for the slim path, discovered by the Harness Typert
 * loader through this package's `./typert` export. One manifest per package, two faces:
 * `mseRebuildStatus` is read-only; `mseRebuildControl` is the human path (pause, one audited
 * retry, one real checker run) and is never registered as a model tool.
 *
 * Result codecs are strict with a pass-through factory: the engine's views are already bounded
 * and serialized by the core, so no raw object crosses the wire.
 */
const passthrough = () => ({ parse: value => value })

const STATUS_REQUEST_CODEC = { mode: 'strict', typeSymbol: '@missher/dsh-mse-learning/types#MseRebuildStatusRequest', create: passthrough }
const STATUS_RESULT_CODEC = { mode: 'strict', typeSymbol: '@missher/dsh-mse-learning/types#MseRebuildStatusView', create: passthrough }
const CONTROL_REQUEST_CODEC = { mode: 'strict', typeSymbol: '@missher/dsh-mse-learning/types#MseRebuildControlRequest', create: passthrough }
const CONTROL_RESULT_CODEC = { mode: 'strict', typeSymbol: '@missher/dsh-mse-learning/types#MseRebuildControlResult', create: passthrough }

const invocation = (service, method, file) => ({
  id: `@missher/dsh-mse-learning#${service}/${method}`,
  service,
  namespace: service,
  method,
  invocation: { kind: 'direct' },
  parameters: [{ name: 'input', wire: 'input', source: 'json', acceptsUndefined: true,
    codec: service === 'mseRebuildStatus' ? STATUS_REQUEST_CODEC : CONTROL_REQUEST_CODEC }],
  result: service === 'mseRebuildStatus' ? STATUS_RESULT_CODEC : CONTROL_RESULT_CODEC,
  sourceLocation: { file, line: 1, column: 1 },
})

const STATUS_METHODS = ['status']
const STATUS_SIGNATURES = {
  status: 'status(input?: MseRebuildStatusRequest): Promise<MseRebuildStatusView>',
}
const CONTROL_METHODS = ['pause', 'retryRequest', 'runCheck']
const CONTROL_SIGNATURES = {
  pause: 'pause(input: MseRebuildControlRequest): Promise<MseRebuildControlResult>',
  retryRequest: 'retryRequest(input: MseRebuildControlRequest): Promise<MseRebuildControlResult>',
  runCheck: 'runCheck(input: MseRebuildControlRequest): Promise<MseRebuildControlResult>',
}

export const TYPERT = {
  package: '@missher/dsh-mse-learning',
  face: 'host',
  schemas: [],
  invocations: [
    ...STATUS_METHODS.map(method => invocation('mseRebuildStatus', method, 'rebuild/remote.mjs')),
    ...CONTROL_METHODS.map(method => invocation('mseRebuildControl', method, 'rebuild/remote.mjs')),
  ],
  model: {
    services: [{
      key: 'mseRebuildStatus',
      exportName: 'MseRebuildStatus',
      summary: 'Read-only view of the slim learning chain: entries, daily digest boundaries and in-flight work.',
      tags: ['read-only', 'settings'],
      members: STATUS_METHODS.map(name => ({ kind: 'method', name, signature: STATUS_SIGNATURES[name] })),
      types: [],
    }, {
      key: 'mseRebuildControl',
      exportName: 'MseRebuildControl',
      summary: 'Human control surface: pause, one audited retry per known-failed material, real deterministic checker runs.',
      tags: ['settings', 'human-only'],
      members: CONTROL_METHODS.map(name => ({ kind: 'method', name, signature: CONTROL_SIGNATURES[name] })),
      types: [],
    }],
    events: [],
    objects: [],
  },
}

export default TYPERT
