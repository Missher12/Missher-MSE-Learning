import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { LearningEngine, reflect } from '../../src/index.mjs'
import { createHarnessBridge } from '../harness.mjs'

export const name = 'mse-learning'
export const inject = ['agents', 'tools', 'llm', 'dshHomePath']
export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const engine = new LearningEngine({ stateRoot: ctx.dshHomePath('mse-learning'), adapterId: 'dsh',
    maxContextBytes: config.maxContextBytes ?? 768 })
  const lifetime = new AbortController()
  const bridge = createHarnessBridge({ engine,
    createMessage: text => createUserMessage({ content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'mse-learning', form: 'instructions' } }),
    warn: code => ctx.logger.warn('mse-learning: %s', code),
    review: config.reflectionEnabled === false ? undefined : (input, route) => {
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
      }, lifetime.signal)
    } })
  ctx.provide('mseLearning', { engine, bridge })
  // Do not run two automatic MSE controllers in the same host.
  ctx.inject(['missherEvolutionCore'], child => child.effect(() => {
    bridge.setEnabled(false)
    ctx.logger.warn('mse-learning: legacy MSE active; new learning paused')
    return () => bridge.setEnabled(true)
  }))
  ctx.on('agent/pre-step', (payload, next) => bridge.preStep(payload, next))
  ctx.on('session/event', (session, event) => bridge.sessionEvent(session, event))
  ctx.on('session/disposed', session => bridge.closeSession(session.id))
  ctx.on('tools/result', (exec, result) => bridge.toolExecution(exec, result))
  ctx.on('agent/error', payload => bridge.toolResult({ sessionId: payload.agent.session.id,
    turnId: payload.turn, failed: true }))
  ctx.effect(() => () => { lifetime.abort(); bridge.dispose() })
}

export default { name, inject, apply }
