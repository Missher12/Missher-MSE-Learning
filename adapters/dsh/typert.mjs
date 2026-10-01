/**
 * Plugin-owned Host invocation manifest, discovered by the Harness Typert loader through
 * this package's `./typert` export.
 *
 * The endpoints are read-only projections of the local learning state. The single JSON
 * parameter carries an optional request object; the Host — never the browser — resolves
 * which scope that request may read. Result codecs are strict with a pass-through factory,
 * because `adapters/dsh/project.mjs` already bounds and serializes everything that leaves
 * the core, so no raw object can cross the wire.
 */
const passthrough = () => ({ parse: value => value })

const REQUEST_CODEC = { mode: 'strict', typeSymbol: '@missher/dsh-mse-learning/types#MseDetailsRequest', create: passthrough }
const RESULT_CODEC = { mode: 'strict', typeSymbol: '@missher/dsh-mse-learning/types#MseDetailsResult', create: passthrough }

const invocation = method => ({
  id: `@missher/dsh-mse-learning#mseDetails/${method}`,
  service: 'mseDetails',
  namespace: 'mseDetails',
  method,
  invocation: { kind: 'direct' },
  parameters: [{ name: 'input', wire: 'input', source: 'json', acceptsUndefined: true, codec: REQUEST_CODEC }],
  result: RESULT_CODEC,
  sourceLocation: { file: 'adapters/dsh/details.mjs', line: 1, column: 1 },
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

export const TYPERT = {
  package: '@missher/dsh-mse-learning',
  face: 'host',
  schemas: [],
  invocations: METHODS.map(invocation),
  model: {
    services: [{
      key: 'mseDetails',
      exportName: 'MseDetails',
      summary: 'Read-only projections of the local MSE learning state for the Settings detail page.',
      tags: ['read-only', 'settings'],
      members: METHODS.map(name => ({ kind: 'method', name, signature: SIGNATURES[name] })),
      types: [],
    }],
    events: [],
    objects: [],
  },
}

export default TYPERT
