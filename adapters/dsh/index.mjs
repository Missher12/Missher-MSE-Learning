import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { LearningEngine, reflect, guardedAction, RECALL_REASONS } from '../../src/index.mjs'
import { createHarnessBridge } from '../harness.mjs'
import { formatRecallLine, handleMseCommand } from '../../src/status.mjs'
import { apply as applyDetails } from './details.mjs'

export const name = 'mse-learning'
export const inject = ['agents', 'tools', 'llm', 'dshHomePath']

export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  // Environment identity stays the SDK default (`default`) unless the operator opts
  // into a narrower fingerprint. Changing the default would silently orphan every
  // validated method recorded by an older version of this plugin.
  const environmentId = config.environmentId
  const engine = new LearningEngine({ stateRoot: ctx.dshHomePath('mse-learning'), adapterId: 'dsh',
    maxContextBytes: config.maxContextBytes ?? 768,
    evaluationTokensPerDay: config.evaluationTokensPerDay ?? 0, evaluationCallsPerDay: config.evaluationCallsPerDay ?? 2 })
  const lifetime = new AbortController()
  const bridge = createHarnessBridge({ engine, environmentId,
    // Optional controlled-verification seams: an injected clock/timer lets a host exercise the
    // bounded settlement retry without real sleeping. Unset in normal use.
    ...(config.now === undefined ? {} : { now: config.now }),
    ...(config.settlement === undefined ? {} : { settlement: config.settlement }),
    createMessage: text => createUserMessage({ content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'mse-learning', form: 'instructions' } }),
    warn: code => ctx.logger.warn('mse-learning: %s', code),
    review: config.reflectionEnabled === false ? undefined : (input, route, signal) => {
      if (lifetime.signal.aborted || typeof route?.provider !== 'string' || typeof route?.model !== 'string') return
      return reflect(engine, input, async (request, signal) => {
        let text = '', finished = false
        for await (const chunk of ctx.llm.stream({ provider: route.provider, model: route.model,
          ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}),
          messages: [createUserMessage({ content: [{ type: 'text', text: request.text }],
            source: { kind: 'plugin', plugin: 'mse-learning', form: 'instructions' } })],
          system: request.system, maxTokens: request.maxTokens, signal })) {
          if (chunk.type === 'text-delta') { text += chunk.text; if (Buffer.byteLength(text) > 2048) throw new Error('reflection_too_large') }
          if (chunk.type === 'finish') { if (['error', 'aborted'].includes(chunk.reason.kind)) throw new Error('reflection_failed'); finished = true }
        }
        if (!finished) throw new Error('reflection_incomplete')
        return text
      }, AbortSignal.any([lifetime.signal, signal]))
    } })
  const statusFor = (sessionId, projectKey) => ({ ...bridge.recallStatus(sessionId, projectKey), environmentId })
  const service = { engine, bridge, environmentId, capabilities: bridge.capabilities,
    verifyArtifact: input => bridge.verifyArtifact(input),
    guardedAction: (input, action) => guardedAction(engine, input, action),
    recallStatus: (sessionId, projectKey) => statusFor(sessionId, projectKey),
    lastRecall: sessionId => bridge.lastRecall(sessionId),
    settlementStatus: () => bridge.settlementStatus(),
    diagnose: input => bridge.diagnose(input) }
  ctx.provide('mseLearning', service)
  // The read-only Settings detail Remote is a separate Cordis service beside the core: it
  // reads through the public engine/bridge surfaces, resolves every scope itself, and is
  // never reachable from a model tool.
  applyDetails(ctx)
  // A visible slash command is the plugin-owned status surface: it is logged as a
  // command row, never appended to the model conversation, and costs no recall budget.
  ctx.inject(['commands'], child => child.effect(() => {
    if (typeof child.commands?.register !== 'function') return () => {}
    return child.commands.register({
      definitionId: 'missher-dsh-mse-learning/status',
      name: 'mse',
      description: 'MSE 持久学习召回状态与原因（不进入模型上下文）',
      // The trusted session header supplies the project identity, so a first command in a
      // fresh or restored session reports the right scope without a warm turn cache.
      handler: invocation => Promise.resolve(handleMseCommand(bridge, invocation.rawInput, {
        sessionId: invocation.agent?.session?.id, projectKey: invocation.agent?.session?.header?.cwd })),
    })
  }))
  // Local, bounded visibility for the host log; diagnostics never enter the conversation.
  const noted = new Set()
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    // Memory-only read: the routine log line must not touch the learning store.
    const last = bridge.lastRecall(session.id)
    if (!last) return
    if (last.reason === RECALL_REASONS.storeFailure) ctx.logger.warn('mse-learning: %s', formatRecallLine({ last }))
    else if ((last.lessons ?? []).length > 0 && !noted.has(session.id)) {
      noted.add(session.id)
      if (noted.size > 512) noted.clear()
      ctx.logger.info('mse-learning: %s', formatRecallLine({ last }))
    }
  })
  // Do not run two automatic MSE controllers in the same host.
  ctx.inject(['missherEvolutionCore'], child => child.effect(() => {
    bridge.setEnabled(false)
    ctx.logger.warn('mse-learning: legacy MSE active; new learning paused')
    return () => bridge.setEnabled(true)
  }))
  ctx.on('agent/pre-step', (payload, next) => bridge.preStep(payload, next))
  ctx.on('llm/stream', (options, next) => bridge.stream(options, next))
  ctx.on('session/event', (session, event) => bridge.sessionEvent(session, event))
  ctx.on('session/disposed', session => bridge.closeSession(session.id))
  ctx.on('tools/result', (exec, result) => bridge.toolExecution(exec, result))
  ctx.on('agent/error', payload => bridge.toolResult({ sessionId: payload.agent.session.id,
    turnId: payload.turn, failed: true }))
  ctx.effect(() => () => { lifetime.abort(); bridge.dispose() })
}

export default { name, inject, apply }
