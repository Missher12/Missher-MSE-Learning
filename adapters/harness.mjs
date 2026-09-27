const key = (session, turn) => JSON.stringify([session, String(turn)])
const internal = text => /\bMSE\b|missher[- ]evolution|Review the conversation above and/iu.test(text)
function directText(messages) {
  return messages.filter(x => x.role === 'user' && x.source?.kind === 'user')
    .flatMap(x => typeof x.content === 'string' ? [x.content] : (x.content ?? []).filter(p => p.type === 'text').map(p => p.text))
    .join('\n').slice(0, 32768)
}

/** Harness lifecycle seam, separate from the pure core so it can be tested with real host payloads. */
export function createHarnessBridge({ engine, createMessage, review, warn = () => {} }) {
  const turns = new Map()
  let enabled = true
  const guarded = fn => { try { return fn() } catch (error) { warn(error.code ?? 'learning_unavailable') } }
  const close = (session, turn, outcome) => {
    const k = key(session, turn), state = turns.get(k)
    if (!state) return
    guarded(() => engine.complete({ ...state.input, outcome,
      ...(outcome === 'verified' ? { evidence: state.evidence } : {}) }))
    turns.delete(k)
    if (outcome !== 'cancelled' && review && (outcome === 'failed' || outcome === 'verified' || state.tools >= 2) && state.resultSummary) {
      Promise.resolve().then(() => review({ ...state.input, taskSummary: state.taskSummary, resultSummary: state.resultSummary,
        outcome: outcome === 'unknown' ? 'supported' : outcome }, state.route)).catch(() => warn('reflection_unavailable'))
    }
  }
  return {
    async preStep(payload, next) {
      const decision = await next()
      if (!enabled || decision.kind === 'reject' || payload.signal?.aborted || payload.step !== 1
        || payload.agent.session.header?.origin === 'subagent' || (payload.agent.session.header?.delegationDepth ?? 0) > 0) return decision
      const prompt = directText(payload.messages ?? [])
      if (!prompt || internal(prompt)) return decision
      return guarded(() => {
        const session = payload.agent.session, k = key(session.id, payload.turn)
        // Returning no second message avoids repeated-step / re-entrant injection.
        if (turns.has(k)) return decision
        if (turns.size >= 256) throw new Error('turn_capacity')
        const input = { sessionId: session.id, turnId: String(payload.turn), prompt, origin: 'user',
          ...(session.header?.cwd ? { projectKey: session.header.cwd } : {}) }
        const prepared = engine.prepare(input)
        const message = prepared.context ? createMessage(prepared.context) : null
        turns.set(k, { input: { sessionId: input.sessionId, turnId: input.turnId, projectKey: input.projectKey },
          receipt: prepared.receipt, lessons: prepared.lessons, messageId: message?.id, failed: false, tools: 0,
          taskSummary: prompt.slice(0, 800), resultSummary: '', route: payload.agent.options })
        return message ? { ...decision, messages: [...decision.messages, message] } : decision
      }) ?? decision
    },
    sessionEvent(session, event) {
      if (!enabled) return
      if (event.type === 'user/message') {
        for (const state of turns.values()) if (state.input.sessionId === session.id && state.messageId === event.data.id && state.receipt) {
          guarded(() => engine.accept({ receipt: state.receipt, lessonIds: state.lessons })); state.receipt = null
        }
      }
      if (event.type === 'turn/end') {
        const state = turns.get(key(session.id, event.data.turn))
        const reason = typeof event.data.reason === 'string' ? event.data.reason : event.data.reason?.kind
        close(session.id, event.data.turn, reason === 'completed'
          ? state?.failed ? 'failed' : state?.evidence ? 'verified' : 'unknown'
          : reason === 'error' ? 'failed' : 'cancelled')
      }
      if (event.type === 'assistant/message') {
        const state = turns.get(key(session.id, event.data.turn))
        const message = event.data.message ?? event.data
        if (state) state.resultSummary = (typeof message.content === 'string' ? message.content
          : (message.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n')).slice(0, 1200)
      }
    },
    // Trusted integration points: not registered as model-callable tools.
    verification({ sessionId, turnId, checkId, passed }) {
      const state = turns.get(key(sessionId, turnId))
      if (!state || typeof checkId !== 'string' || !checkId || typeof passed !== 'boolean') return false
      state.failed = !passed
      state.evidence = passed ? { source: 'host_verifier', checkId } : undefined
      return true
    },
    toolResult({ sessionId, turnId, failed, readOnly = false }) {
      const state = turns.get(key(sessionId, turnId))
      if (!state) return
      state.tools += 1
      // A new write or unknown tool can invalidate prior verification.
      if (!readOnly) state.evidence = undefined
      if (failed) { state.failed = true; state.evidence = undefined }
    },
    toolExecution(exec, result) {
      const session = exec.agent?.session
      if (!session || typeof exec.callId !== 'string') return
      const count = session.seq ?? session.events?.length ?? 0
      for (let n = count - 1; n >= Math.max(0, count - 1000); n--) {
        const event = session.eventAt?.(n) ?? session.events?.[n]
        if (event?.type !== 'tool/call' || event.data.callId !== (exec.rootCallId ?? exec.callId)) continue
        this.toolResult({ sessionId: session.id, turnId: event.data.turn,
          failed: result.isError === true || exec.signal?.aborted === true || result.value?.timedOut === true
            || (typeof result.value?.exitCode === 'number' && result.value.exitCode !== 0),
          readOnly: exec.name === 'read' || exec.name === 'read_image' })
        break
      }
    },
    closeSession(sessionId) { for (const state of [...turns.values()]) if (state.input.sessionId === sessionId) close(sessionId, state.input.turnId, 'cancelled') },
    setEnabled(value) { enabled = value === true; if (!enabled) for (const state of [...turns.values()]) close(state.input.sessionId, state.input.turnId, 'cancelled') },
    dispose() { this.setEnabled(false) },
  }
}
