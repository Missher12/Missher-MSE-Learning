/**
 * Plugin-owned Host invocation manifest, discovered by the Harness Typert loader through
 * this package's `./typert` export.
 *
 * One package ships exactly one manifest, so both of this bundle's faces are declared here:
 * `mseDetails` is the read-only projection of the local learning state, and `mseControl` is
 * the human Settings control path. They are separate namespaces on purpose — a page can hold
 * the read Remote without ever being able to start a model call, and the control methods are
 * never registered as model tools.
 *
 * The single JSON parameter carries an optional request object; the Host — never the browser —
 * resolves which scope that request may touch. Result codecs are strict with a pass-through
 * factory, because `project.mjs` already bounds and serializes everything that leaves the
 * core, so no raw object can cross the wire.
 */
const passthrough = () => ({ parse: value => value })

const REQUEST_CODEC = { mode: 'strict', typeSymbol: '@missher/dsh-mse-learning/types#MseDetailsRequest', create: passthrough }
const RESULT_CODEC = { mode: 'strict', typeSymbol: '@missher/dsh-mse-learning/types#MseDetailsResult', create: passthrough }
const CONTROL_REQUEST_CODEC = { mode: 'strict', typeSymbol: '@missher/dsh-mse-learning/types#MseControlRequest', create: passthrough }
const CONTROL_RESULT_CODEC = { mode: 'strict', typeSymbol: '@missher/dsh-mse-learning/types#MseControlResult', create: passthrough }

const invocation = (service, method, file) => ({
  id: `@missher/dsh-mse-learning#${service}/${method}`,
  service,
  namespace: service,
  method,
  invocation: { kind: 'direct' },
  parameters: [{ name: 'input', wire: 'input', source: 'json', acceptsUndefined: true,
    codec: service === 'mseDetails' ? REQUEST_CODEC : CONTROL_REQUEST_CODEC }],
  result: service === 'mseDetails' ? RESULT_CODEC : CONTROL_RESULT_CODEC,
  sourceLocation: { file, line: 1, column: 1 },
})

const METHODS = ['overview', 'sessions', 'lessons', 'lesson', 'recall', 'diagnose']
const SIGNATURES = {
  overview: 'overview(): Promise<MseDetailsResult>',
  sessions: 'sessions(): Promise<MseDetailsResult>',
  lessons: 'lessons(input?: MseDetailsRequest): Promise<MseDetailsResult>',
  lesson: 'lesson(input: MseDetailsRequest): Promise<MseDetailsResult>',
  recall: 'recall(input: MseDetailsRequest): Promise<MseDetailsResult>',
  diagnose: 'diagnose(input?: MseDetailsRequest): Promise<MseDetailsResult>',
}

const CONTROL_METHODS = ['status', 'turns', 'planReview', 'startReview', 'planEvaluation', 'startEvaluation', 'job', 'cancel']
const CONTROL_SIGNATURES = {
  status: 'status(input?: MseControlRequest): Promise<MseControlResult>',
  turns: 'turns(input: MseControlRequest): Promise<MseControlResult>',
  planReview: 'planReview(input: MseControlRequest): Promise<MseControlResult>',
  startReview: 'startReview(input: MseControlRequest): Promise<MseControlResult>',
  planEvaluation: 'planEvaluation(input: MseControlRequest): Promise<MseControlResult>',
  startEvaluation: 'startEvaluation(input: MseControlRequest): Promise<MseControlResult>',
  job: 'job(input: MseControlRequest): Promise<MseControlResult>',
  cancel: 'cancel(input: MseControlRequest): Promise<MseControlResult>',
}

export const TYPERT = {
  package: '@missher/dsh-mse-learning',
  face: 'host',
  schemas: [],
  invocations: [
    ...METHODS.map(method => invocation('mseDetails', method, 'adapters/dsh/details.mjs')),
    ...CONTROL_METHODS.map(method => invocation('mseControl', method, 'adapters/dsh/control.mjs')),
  ],
  model: {
    services: [{
      key: 'mseDetails',
      exportName: 'MseDetails',
      summary: 'Read-only projections of the local MSE learning state for the Settings detail page.',
      tags: ['read-only', 'settings'],
      members: METHODS.map(name => ({ kind: 'method', name, signature: SIGNATURES[name] })),
      types: [],
    }, {
      key: 'mseControl',
      exportName: 'MseControl',
      summary: 'Human Settings control surface: effective state, manual review and candidate verification jobs.',
      tags: ['settings', 'human-only'],
      members: CONTROL_METHODS.map(name => ({ kind: 'method', name, signature: CONTROL_SIGNATURES[name] })),
      types: [],
    }],
    events: [],
    objects: [],
  },
}

export default TYPERT
