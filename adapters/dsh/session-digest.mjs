/**
 * Bounded, trusted reading of one Host session's completed turns.
 *
 * A person may ask to review a task that already happened. Everything that request needs —
 * which turn, what was asked, what came back, and the provider/model/reasoning route that
 * turn actually used — has to come from the Host's own session log, never from the browser.
 * A browser-supplied "summary" would be unverifiable text pretending to be a task, and a
 * browser-supplied route would be a way to redirect a paid model call.
 *
 * The only supported source is the public `sessionQuery` service: `readSession(id)` returns a
 * replay-validated clone of the log, prefers the live in-memory session, and falls back to the
 * persistence backend, so a session from an earlier process run is readable without this
 * plugin ever opening a `.jsonl` file (which would bypass zstd framing, torn-tail refusal and
 * the fail-closed event-type check).
 *
 * Three rules keep the projection honest, and each of them exists because the obvious version
 * of it is wrong:
 *
 *  1. A turn's **result is its final visible answer**, not every assistant message joined and
 *     cut at a length cap — a long preamble would otherwise push the answer out of the window
 *     and let the process text be reviewed as the outcome. Earlier messages are kept only as a
 *     clearly-labelled bounded preview.
 *  2. A **fork's inherited history is not this session's work**. `readSession` reports
 *     `inheritedEventCount`; turns that begin before it are counted and reported as
 *     unsupported rather than re-listed under a new session id, which would be a way to review
 *     — and charge for — the same turn twice, attributed to the wrong session.
 *  3. A **turn with no header of its own keeps the series route**. `request/header` is written
 *     on a request-series boundary rather than per turn, so the newest real header from just
 *     before the processed window is carried forward. A default model is never substituted for
 *     the route the turn actually used.
 *
 * Nothing in this module writes, and nothing in it is reachable as a model tool.
 */

/** Bounded reads: a long session must not turn one click into an unbounded scan. */
export const MAX_EVENTS_SCANNED = 6000
export const MAX_TURNS_LISTED = 20
/** How far back a newest-first route search may look; a series header is far but not unbounded. */
export const MAX_ROUTE_LOOKBACK = 200_000
export const MAX_TASK_CHARS = 800
export const MAX_RESULT_CHARS = 1200
/** Bounded tail of the earlier assistant messages, kept for display only — never the result. */
export const MAX_PROCESS_CHARS = 400
/** Text types the Host may put in a content block. Anything else is ignored, not guessed at. */
const TEXTUAL = new Set(['text', 'input_text', 'output_text'])

const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : ''
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** One message's plain text, from the Host's own content-block shape. */
export function messageText(data) {
  const content = data?.content ?? data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => isPlainObject(block) && TEXTUAL.has(block.type) && typeof block.text === 'string')
    .map(block => block.text).join('\n')
}

/** Read one logged route event; null when it is not a usable provider/model pair. */
function routeAt(event) {
  if (event?.type !== 'request/header') return null
  const config = event.data?.header?.config
  if (!isPlainObject(config)) return null
  if (typeof config.provider !== 'string' || typeof config.model !== 'string') return null
  return { provider: text(config.provider, 128), model: text(config.model, 200),
    ...(typeof config.reasoningEffort === 'string' ? { reasoningEffort: text(config.reasoningEffort, 64) } : {}) }
}

/**
 * The route a turn actually used: the last `request/header` at or before its end.
 *
 * `request/header` is written on a request-series boundary (initial, resume, change), not once
 * per turn, so a turn usually has no header of its own and inherits the one that opened the
 * series. `fallback` carries the newest header from *before* the processed window, so a long
 * session does not lose its real route just because the window starts after it — and so this
 * never has to guess a default model the turn may not have used.
 */
function routeOf(events, endSeq, fallback = null) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.seq > endSeq) continue
    const route = routeAt(event)
    if (route !== null) return route
  }
  return fallback
}

/** The newest real route strictly before `seq`, searched inside a bounded look-back window. */
function routeBefore(events, seq) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.seq >= seq) continue
    const route = routeAt(event)
    if (route !== null) return route
  }
  return null
}

/** `turn/end` reason, as the plain string the rest of this plugin compares against. */
export const reasonOf = data => {
  const reason = data?.reason
  return typeof reason === 'string' ? reason : typeof reason?.kind === 'string' ? reason.kind : 'unknown'
}

/**
 * Read every completed turn of one session, newest last.
 *
 * A turn is only listed when it has a `turn/start`, a `turn/end` and at least one direct human
 * prompt: a turn whose prompt came from an injected context block is internal work, and asking
 * to "review" it would attribute someone else's text to the user.
 *
 * @param query - the public `sessionQuery` service (or anything with the same `readSession`).
 * @param sessionId - a session id that came from the Host's own directory.
 * @returns `{ ok, code?, projectKey, turns }`; `code` explains a refusal instead of an empty list.
 */
export async function readTurns(query, sessionId, { maxTurns = MAX_TURNS_LISTED } = {}) {
  if (query === null || query === undefined || typeof query.readSession !== 'function') {
    return { ok: false, code: 'session_query_unavailable', turns: [] }
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 512) {
    return { ok: false, code: 'session_required', turns: [] }
  }
  let snapshot
  try { snapshot = await query.readSession(sessionId) } catch (error) {
    const code = text(error?.code ?? '', 64)
    return { ok: false, code: code === '' ? 'session_read_failed' : code, turns: [] }
  }
  const all = Array.isArray(snapshot?.events) ? snapshot.events : null
  if (all === null) return { ok: false, code: 'session_read_failed', turns: [] }
  // One pass over the whole log. The scan window bounds what may be *listed*, never what may be
  // read: a `request/header` is written on a series boundary, not once per turn, so a turn deep
  // inside the window still belongs to a route established far outside it. Walking the whole
  // array keeps that route, and slicing first — the obvious version — lost it entirely.
  const windowStart = Math.max(0, all.length - MAX_EVENTS_SCANNED)
  const header = isPlainObject(snapshot.session) ? snapshot.session : {}
  const projectKey = typeof header.cwd === 'string' && header.cwd.length > 0 && header.cwd.length <= 512 ? header.cwd : undefined
  // A fork replays its parent's log. Those events are not turns of *this* session, and treating
  // them as such would let the same work be reviewed (and charged) again under a new session id.
  const inherited = Number.isSafeInteger(snapshot.inheritedEventCount) && snapshot.inheritedEventCount > 0
    ? snapshot.inheritedEventCount : 0
  const turns = []
  let inheritedTurns = 0, droppedOlder = 0, route = null, current = null
  for (let index = 0; index < all.length; index++) {
    const event = all[index]
    if (!isPlainObject(event)) continue
    const seq = Number.isSafeInteger(event.seq) ? event.seq : null
    const found = routeAt(event)
    if (found !== null) route = found
    if (event.type === 'turn/start') {
      current = { turn: Number.isSafeInteger(event.data?.turn) ? event.data.turn : null, prompts: [], results: [],
        resultCount: 0, startSeq: seq, at: Number.isFinite(event.time) ? event.time : 0, recordable: index >= windowStart }
      continue
    }
    if (current === null) continue
    if (event.type === 'user/message') {
      // Trusted structure, not text: only a direct human prompt counts as the task.
      if (event.data?.source?.kind === 'user') current.prompts.push(messageText(event.data))
      continue
    }
    if (event.type === 'assistant/message') {
      // Every assistant message is kept, in order: the last one is the turn's final visible
      // answer, while earlier ones are the process that produced it.
      current.results.push(messageText(event.data?.message).trim())
      current.resultCount += 1
      continue
    }
    if (event.type === 'turn/end') {
      const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : current.turn
      const task = current.prompts.join('\n').trim()
      const own = current.startSeq !== null && current.startSeq >= inherited
      if (!own) inheritedTurns += 1
      else if (!current.recordable) droppedOlder += 1
      else if (turn !== null && current.prompts.length > 0) {
        // The final visible answer is the result. Joining every assistant message and cutting at
        // the cap would let a long preamble push the answer out entirely, which would then be
        // reviewed as if the process text were the outcome.
        const answers = current.results.filter(Boolean)
        const result = (answers.length === 0 ? '' : answers[answers.length - 1]).slice(0, MAX_RESULT_CHARS)
        const process = answers.slice(0, -1).join('\n').trim()
        turns.push({ turn, startSeq: current.startSeq, endSeq: seq, at: current.at,
          reason: reasonOf(event.data), task: task.slice(0, MAX_TASK_CHARS), result,
          processPreview: process.length > MAX_PROCESS_CHARS ? process.slice(-MAX_PROCESS_CHARS) : process,
          assistantMessages: current.resultCount, route })
      }
      current = null
    }
  }
  return { ok: true, code: null, sessionId, projectKey, truncated: droppedOlder > 0,
    inheritedEventCount: inherited, inheritedTurns, inheritedUnsupported: inheritedTurns > 0,
    droppedOlder,
    turns: turns.slice(-maxTurns) }
}

/**
 * The newest route this session actually logged, for work that is not tied to one turn.
 *
 * A candidate verification has no turn of its own, so it runs on the route the session is
 * already using — read from a real `request/header`, never from a global default that this
 * session may not have been using at all.
 */
export async function latestRoute(query, sessionId) {
  if (query === null || query === undefined || typeof query.readSession !== 'function') {
    return { ok: false, code: 'session_query_unavailable' }
  }
  let snapshot
  try { snapshot = await query.readSession(sessionId) } catch (error) {
    const code = text(error?.code ?? '', 64)
    return { ok: false, code: code === '' ? 'session_read_failed' : code }
  }
  const all = Array.isArray(snapshot?.events) ? snapshot.events : null
  if (all === null) return { ok: false, code: 'session_read_failed' }
  // Scanned newest-first and stopped at the first hit, so the cost is bounded by how far back
  // the series header actually is rather than by the window a turn list happens to use.
  const route = routeBefore(all.slice(-MAX_ROUTE_LOOKBACK), Infinity)
  return route === null ? { ok: false, code: 'session_route_unknown' } : { ok: true, code: null, route }
}

/**
 * One turn's honest reviewability, decided before anything else happens.
 *
 * `reviewable` is not the same as "exists": a turn with no result, a turn that was cancelled,
 * or a turn whose route was never logged cannot produce a fair review, and each says why.
 */
export function reviewability(turn) {
  if (turn === null || turn === undefined) return { reviewable: false, code: 'turn_unknown' }
  if (!['completed', 'error', 'max-tokens'].includes(turn.reason)) {
    return { reviewable: false, code: turn.reason === 'aborted' ? 'turn_cancelled' : 'turn_not_finished' }
  }
  if (turn.route === null) return { reviewable: false, code: 'turn_route_unknown' }
  if (turn.task.trim().length < 8) return { reviewable: false, code: 'turn_task_too_short' }
  if (turn.result.trim().length < 8) return { reviewable: false, code: 'turn_result_too_short' }
  return { reviewable: true, code: null }
}

/** Outcome vocabulary the core's reflection gate accepts, derived from the turn, not typed in. */
export const outcomeOf = turn => turn.reason === 'error' ? 'failed' : turn.reason === 'max-tokens' ? 'failed' : 'supported'
