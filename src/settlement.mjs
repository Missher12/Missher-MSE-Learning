/**
 * Bounded, idempotent settlement queue.
 *
 * A finished turn freezes exactly one payload — its identity, final outcome and the
 * lesson/version/check bindings already established by a trusted check — and retries
 * only the core's idempotent `complete`. It never re-runs a model, tool, reflection or
 * evaluation, never re-derives the outcome, and never turns an already committed result
 * into a failure: the core's duplicate branch reports what was actually recorded.
 *
 * Scope is deliberately in-process. The clock and scheduler are injectable so tests
 * exercise every branch without sleeping, and pause/close/dispose invalidate scheduled
 * callbacks through a generation counter instead of trying to cancel committed work.
 */

/** Storage/transport failures that may genuinely succeed on a later attempt. */
export const TRANSIENT_CODES = Object.freeze(new Set([
  'lock_busy', 'state_unavailable', 'session_state_unavailable', 'state_busy',
  'runtime_unavailable', 'timeout', 'ETIMEDOUT', 'EAGAIN', 'EBUSY', 'transport_error',
]))

export const isTransient = code => typeof code === 'string' && TRANSIENT_CODES.has(code)

const BACKOFF_MS = Object.freeze([250, 1000, 3000])

/**
 * Convert an epoch-millisecond receipt deadline into the queue clock's own unit.
 *
 * The core reports `receiptExpiresAt` in epoch milliseconds. A host clock may instead be
 * monotonic (the Hermes adapter uses `time.monotonic` seconds), so the remaining wall time
 * must be transferred at this single boundary; comparing the two scales directly would
 * silently ignore the receipt and let a retry outlive it.
 *
 * @param options.receiptExpiresAt - core deadline in epoch milliseconds.
 * @param options.wallNow - current wall clock in epoch milliseconds.
 * @param options.now - current queue clock reading.
 * @param options.maxAgeMs - total age bound in milliseconds.
 * @param options.clockUnit - `'ms'` for an epoch-millisecond queue clock (Date.now),
 *   `'s'` for a monotonic-seconds clock (Python-style `time.monotonic`).
 * @returns absolute deadline in the queue clock's unit (never later than the age bound).
 */
export function deadlineFromReceipt({ receiptExpiresAt, wallNow, now, maxAgeMs, clockUnit = 'ms' }) {
  const scale = clockUnit === 's' ? 1000 : 1
  const limits = [now + maxAgeMs / scale]
  if (Number.isFinite(receiptExpiresAt) && Number.isFinite(wallNow)) {
    // An already-expired receipt yields "now": exactly the current attempt may still run,
    // no later attempt can.
    limits.push(now + Math.max(0, receiptExpiresAt - wallNow) / scale)
  }
  return Math.min(...limits)
}

/**
 * @param options.complete - idempotent applier, called with the frozen payload.
 * @param options.now - injectable clock.
 * @param options.schedule - injectable timer (`(fn, ms) => handle`).
 * @param options.cancel - injectable timer cancellation.
 * @param options.isTransient - error classifier; defaults to {@link isTransient}.
 * @param options.deadlineForReceipt - converts the core's epoch-millisecond
 *   `receiptExpiresAt` into this queue's own clock at enqueue time
 *   (see {@link deadlineFromReceipt}). Omitting it keeps the raw deadline.
 */
export class SettlementQueue {
  constructor({ complete, now = Date.now, schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = handle => clearTimeout(handle), isTransient: classifier = error => isTransient(error?.code),
    deadlineForEntry,
    maxItems = 64, maxAttempts = 4, baseDelayMs = BACKOFF_MS, maxAgeMs = 5 * 60_000, onEvent = () => {},
    maxHistory = 32, deadlineForReceipt }) {
    this.complete = complete
    this.now = now
    this.schedule = schedule
    this.cancel = cancel
    this.isTransient = classifier
    this.maxItems = maxItems
    this.maxAttempts = maxAttempts
    this.delays = [...baseDelayMs]
    this.maxAgeMs = maxAgeMs
    this.onEvent = onEvent
    this.maxHistory = maxHistory
    // The receipt bound only exists if the caller supplies the cross-clock conversion.
    // Dropping it here silently ignored every receipt deadline the bridge passed in.
    this.deadlineForReceipt = typeof deadlineForReceipt === 'function' ? deadlineForReceipt : undefined
    // The same boundary, in the other direction: a durable deadline returns to this clock.
    this.deadlineForEntry = typeof deadlineForEntry === 'function' ? deadlineForEntry : undefined
    this.entries = new Map()
    this.retired = []
    this.timers = new Map()
    this.generation = 0
    this.paused = false
    this.disposed = false
  }
  /**
   * Live retry slots only. A terminal state is retired into {@link history}, so a stopped
   * or expired settlement can never hold capacity hostage for the rest of the process.
   */
  get size() { return this.entries.size }
  /** Every settlement still eligible for a retry: the host status surface reads this. */
  status() {
    return [...this.entries.values()].map(entry => ({ key: entry.key, sessionId: entry.sessionId, turnId: entry.turnId,
      attempts: entry.attempts, state: entry.state, lastError: entry.lastError ?? null, queuedAt: entry.queuedAt,
      deadline: entry.deadline, delivery: entry.delivery }))
  }
  /** Bounded terminal history, newest last; carries the same session/turn identity. */
  history() { return [...this.retired] }
  entry(key) { return this.entries.get(key) }
  /**
   * Move one entry out of the live set. The compact record keeps the identity a status
   * reader needs without retaining the frozen payload.
   */
  retire(entry, state) {
    const handle = this.timers.get(entry.key)
    if (handle !== undefined) { this.cancel(handle); this.timers.delete(entry.key) }
    const record = { key: entry.key, sessionId: entry.sessionId, turnId: entry.turnId, state,
      attempts: entry.attempts, lastError: entry.lastError ?? null, at: this.now() }
    this.entries.delete(entry.key)
    this.retired.push(record)
    if (this.retired.length > this.maxHistory) this.retired.splice(0, this.retired.length - this.maxHistory)
    return record
  }
  deadlineFor({ deadline, now = this.now() } = {}) {
    const limits = [now + this.maxAgeMs]
    if (Number.isFinite(deadline)) limits.push(deadline)
    return Math.min(...limits)
  }
  /**
   * Track one frozen settlement. Repeating the same payload is a no-op; a different
   * payload for the same turn is reported as a conflict instead of replacing the frozen one.
   */
  enqueue({ key, payload, sessionId, deadline, receiptExpiresAt, maxAttempts, durable }) {
    if (this.disposed) return { state: 'disposed' }
    const existing = this.entries.get(key)
    if (existing) {
      return JSON.stringify(existing.payload) === JSON.stringify(payload)
        ? { state: 'duplicate', entry: existing }
        : { state: 'conflict', entry: existing }
    }
    if (this.entries.size >= this.maxItems) {
      this.onEvent({ kind: 'capacity', key, sessionId, turnId: payload.turnId, size: this.entries.size, maxItems: this.maxItems })
      return { state: 'capacity' }
    }
    // A receipt deadline is converted at this boundary; a raw queue-clock deadline is used
    // as-is. Both are then clamped by the total age bound. A conversion that cannot be
    // completed leaves the age bound in place instead of failing the settlement.
    let converted = deadline
    if (receiptExpiresAt !== undefined && this.deadlineForReceipt !== undefined) {
      try { converted = this.deadlineForReceipt({ receiptExpiresAt, now: this.now() }) }
      catch { converted = undefined }
    } else if (deadline !== undefined && this.deadlineForEntry !== undefined) {
      // A deadline that came back from the durable document is in the store's clock; it is
      // converted here so a restart continues the ORIGINAL window instead of a fresh one.
      try { converted = this.deadlineForEntry({ deadline, now: this.now() }) }
      catch { converted = undefined }
    }
    const entry = { key, sessionId, turnId: payload.turnId, payload, attempts: 0, state: 'pending',
      lastError: null, queuedAt: this.now(), deadline: this.deadlineFor({ deadline: converted }), delivery: 'pending',
      // A durable entry's expiry belongs to the CORE, which records it in the same document that
      // holds the pending item. Marking it here is what lets `attempt` and `resume` hand the
      // decision to the store instead of retiring it locally, where nothing would be written.
      ...(durable === true ? { durable: true } : {}),
      // An entry may bound itself by its deadline alone. A settlement waiting behind a temporary
      // gate (paused, host state unknown) is not failing — it must be allowed to wait for the
      // explicit resume, and the absolute deadline is what ends it.
      ...(Number.isSafeInteger(maxAttempts) && maxAttempts > 0 ? { maxAttempts } : {}) }
    this.entries.set(key, entry)
    return { state: 'queued', entry }
  }
  /**
   * Apply one entry right now. Success removes it; a permanent error ends it; a transient
   * error schedules the next attempt until the attempt, age or deadline bound is reached.
   */
  attempt(key) {
    const entry = this.entries.get(key)
    if (!entry) return { state: 'missing' }
    if (this.disposed || this.paused) return { state: entry.state }
    const now = this.now()
    if (now > entry.deadline && entry.durable !== true) {
      entry.lastError = entry.lastError ?? 'deadline_exceeded'
      const record = this.retire(entry, 'expired')
      this.onEvent({ kind: 'expired', key, sessionId: entry.sessionId, turnId: entry.turnId, attempts: entry.attempts,
        code: 'deadline_exceeded' })
      return { state: 'expired', entry, record }
    }
    // A lifecycle-driven re-read may give an `unconfirmed` entry one more attempt; an automatic
    // retry never reaches here, because the deadline attempt schedules no successor.
    if (entry.state === 'unconfirmed') entry.state = 'pending'
    entry.attempts += 1
    try {
      const result = this.complete(entry.payload)
      const record = this.retire(entry, 'settled')
      this.onEvent({ kind: 'settled', key, sessionId: entry.sessionId, turnId: entry.turnId,
        attempts: entry.attempts, result, record })
      return { state: 'settled', entry, result, record }
    } catch (error) {
      const code = error?.code ?? 'learning_unavailable'
      entry.lastError = code
      if (!this.isTransient(error)) {
        // A durable item the core itself retired as expired is recorded as expired, not as a
        // local failure: the terminal row already exists in the document with that state.
        const terminal = code === 'settlement_expired' ? 'expired' : 'failed'
        const record = this.retire(entry, terminal)
        this.onEvent({ kind: 'failed', key, sessionId: entry.sessionId, turnId: entry.turnId,
          attempts: entry.attempts, code, record })
        return { state: terminal, entry, code, record }
      }
      const delay = this.delays[Math.min(entry.attempts - 1, this.delays.length - 1)]
      if (entry.durable === true) {
        // A durable item's terminal state belongs to the CORE, which records it in the same
        // document as the pending row — so it is never retired locally. It is not retried for
        // ever either: the last automatic attempt is placed exactly ON the original deadline, so
        // the store gets its one chance to record `expired` from its own clock. If that attempt
        // still cannot be confirmed, automatic scheduling stops here with an explicit, honest
        // `unconfirmed` state: the core keeps the record and the original deadline, and the next
        // legitimate lifecycle (or a restart) re-reads it. The deadline is never refreshed.
        if (now >= entry.deadline) {
          entry.state = 'unconfirmed'
          this.onEvent({ kind: 'unconfirmed', key, sessionId: entry.sessionId, turnId: entry.turnId,
            attempts: entry.attempts, code, deadline: entry.deadline })
          return { state: 'unconfirmed', entry, code }
        }
        this.scheduleNext(entry, now + delay > entry.deadline ? entry.deadline - now : delay)
        return { state: 'retrying', entry, code }
      }
      const attemptBound = entry.maxAttempts ?? this.maxAttempts
      if (entry.attempts >= attemptBound || now + delay > entry.deadline) {
        const record = this.retire(entry, 'exhausted')
        this.onEvent({ kind: 'exhausted', key, sessionId: entry.sessionId, turnId: entry.turnId,
          attempts: entry.attempts, code, record })
        return { state: 'exhausted', entry, code, record }
      }
      this.scheduleNext(entry, delay)
      return { state: 'retrying', entry, code }
    }
  }
  scheduleNext(entry, delay) {
    const generation = this.generation
    const handle = this.schedule(() => {
      this.timers.delete(entry.key)
      if (generation !== this.generation || this.disposed || this.paused) return
      this.attempt(entry.key)
    }, delay)
    this.timers.set(entry.key, handle)
  }
  /** Stop scheduling new attempts; pending entries keep their frozen payload and deadline. */
  pause() {
    if (this.disposed) return
    this.generation += 1
    this.paused = true
    for (const [key, handle] of this.timers) { this.cancel(handle); this.timers.delete(key) }
    return this.status()
  }
  /**
   * Resume after an explicit pause. A pending entry is re-driven; a durable `unconfirmed` entry
   * gets one more read of the core (which is what retires it if its deadline has passed), and
   * scheduling stays bounded because a failing deadline attempt schedules no successor.
   */
  resume() {
    if (this.disposed || !this.paused) return this.status()
    this.paused = false
    const now = this.now()
    for (const entry of [...this.entries.values()]) {
      if (entry.state !== 'pending' && entry.state !== 'unconfirmed') continue
      // Same rule as `attempt`: a durable entry is retried so the core can retire it, never
      // expired locally into a state the document never heard about.
      if (now > entry.deadline && entry.durable !== true) {
        const record = this.retire(entry, 'expired')
        this.onEvent({ kind: 'expired', key: entry.key, sessionId: entry.sessionId, turnId: entry.turnId, attempts: entry.attempts,
          code: 'deadline_exceeded', record })
        continue
      }
      this.scheduleNext(entry, 0)
    }
    return this.status()
  }
  /** Stop retrying every entry of one session; other sessions keep their timers. */
  stopSession(sessionId) {
    const stopped = []
    for (const entry of [...this.entries.values()]) {
      if (entry.sessionId !== sessionId) continue
      stopped.push(entry.key)
      const record = this.retire(entry, 'stopped')
      this.onEvent({ kind: 'stopped', key: entry.key, sessionId, turnId: entry.turnId, attempts: entry.attempts, record })
    }
    return stopped
  }
  /** No attempt may start after dispose; late callbacks are inert. */
  dispose() {
    this.generation += 1
    for (const handle of this.timers.values()) this.cancel(handle)
    this.timers.clear()
    this.disposed = true
    return this.status()
  }
}
