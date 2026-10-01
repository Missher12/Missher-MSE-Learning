/**
 * Bounded, cancellable job queue for human-started MSE work.
 *
 * A manual review or a candidate verification is a real, paid, multi-request operation. Four
 * properties matter more than throughput, and each of them is a rule this queue enforces in
 * exactly one place:
 *
 *   1. **One runner at a time, and a cancelled runner still owns the slot.** Cancelling does
 *      not make a provider request disappear; a runner that ignores its AbortSignal keeps
 *      running. Releasing the slot on a timer would let a second job start beside it — the
 *      probe measured exactly two live runners that way — so the slot is held until the runner
 *      really settles. A timer only *labels* the job as `draining`; it never frees anything.
 *      "The request may still be alive" is not "the request has exited", and the queue refuses
 *      to confuse the two even at the cost of waiting.
 *   2. **A terminal state is final.** `cancelled` never becomes `failed` because a slow
 *      runner rejected afterwards, and `done` never becomes `failed` because a late error
 *      arrived. Late outcomes are recorded as ignored, never as a new state.
 *   3. **Deduplication is by request identity, not by id string.** A repeated `requestId`
 *      returns the original job only when the kind and the payload fingerprint match; reusing
 *      the id for a different task is refused. The record survives the retained-job window
 *      for a bounded time, so a browser that retries after the job row was trimmed still gets
 *      the same answer instead of paying for a second run.
 *   4. **Nothing is replayed after a restart.** The queue is in-process by construction: a
 *      Host restart leaves no job record and no ticket to resume, which is exactly what is
 *      reported ("interrupted"), instead of re-running a model to reconstruct a result.
 *
 * The permission gate is re-checked before the job starts *and* before its result may be
 * recorded, so a runner that ignores its signal and returns late cannot turn a cancelled job
 * into a stored lesson.
 */

/** A whole job is bounded well inside the core's 30-minute ticket window. */
export const JOB_DEADLINE_MS = 10 * 60_000
/** One model request inside a job is bounded on its own. */
export const CALL_DEADLINE_MS = 60_000
/** When a cancelled-but-unsettled runner starts being labelled `draining`; it frees nothing. */
export const DRAINING_LABEL_MS = 90_000
export const MAX_RETAINED_JOBS = 8
/** Bounded dedupe window for jobs that already left the retained list. */
export const MAX_COMPLETED_RECORDS = 64
export const COMPLETED_TTL_MS = 60 * 60_000
const REQUEST_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{7,63}$/u

export const JOB_STATES = Object.freeze(['queued', 'running', 'done', 'failed', 'cancelled', 'blocked'])
export const JOB_KINDS = Object.freeze(['review', 'registered', 'evaluation'])
const TERMINAL = Object.freeze(['done', 'failed', 'cancelled', 'blocked'])

const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : ''

/**
 * @param options.now - injectable clock, so a test can expire a job without sleeping.
 * @param options.schedule - injectable timer (`(fn, ms) => handle`).
 * @param options.cancelTimer - injectable timer cancellation.
 * @param options.onEvent - observability hook; never given prompt or lesson text.
 */
export class JobQueue {
  constructor({ now = Date.now, schedule = (fn, ms) => setTimeout(fn, ms),
    cancelTimer = handle => clearTimeout(handle), onEvent = () => {}, maxRetained = MAX_RETAINED_JOBS,
    jobDeadlineMs = JOB_DEADLINE_MS, drainingLabelMs = DRAINING_LABEL_MS,
    completedTtlMs = COMPLETED_TTL_MS, maxCompleted = MAX_COMPLETED_RECORDS } = {}) {
    this.now = now
    this.schedule = schedule
    this.cancelTimer = cancelTimer
    this.onEvent = onEvent
    this.maxRetained = maxRetained
    this.jobDeadlineMs = jobDeadlineMs
    this.drainingLabelMs = drainingLabelMs
    this.completedTtlMs = completedTtlMs
    this.maxCompleted = maxCompleted
    /** Ordered oldest-first; the tail is the newest submission. */
    this.jobs = []
    /** requestId → terminal record, kept past the retained window for bounded dedupe. */
    this.completed = new Map()
    this.running = null
    this.sequence = 0
    this.disposed = false
  }

  /** One bounded, JSON-safe view of a job. Never carries prompt, answer or lesson text. */
  view(job) {
    if (job === null || job === undefined) return null
    return {
      id: job.id, kind: job.kind, state: job.state, requestId: job.requestId,
      submittedAt: job.submittedAt, startedAt: job.startedAt, endedAt: job.endedAt,
      progress: { done: job.progress.done, total: job.progress.total },
      label: job.label, code: job.code, result: job.result, outstanding: job.outstanding ?? 0,
      // A late outcome that arrived after the job became terminal says so, instead of
      // quietly rewriting what actually happened. `draining` is the honest name for the window
      // in which a cancelled runner has still not returned: the slot is held so a new paid
      // request cannot be stacked on it, and once the bounded grace expires the job is reported
      // as draining rather than as "no request running".
      droppedLate: job.droppedLate === true, cancelledReason: job.cancelledReason ?? null,
      // Terminal for the *task*, but the underlying request has not returned yet: the queue
      // still counts it against its single slot and says so, rather than implying it exited.
      draining: job.terminal === true && job.settled !== true,
    }
  }

  list() { return this.jobs.map(job => this.view(job)) }
  get(id) {
    const job = this.jobs.find(row => row.id === id)
    if (job !== undefined) return this.view(job)
    for (const record of this.completed.values()) if (record.view.id === id) return record.view
    return null
  }

  /** How many jobs are waiting or running; used to refuse a new submission honestly. */
  get pending() { return this.jobs.filter(job => !TERMINAL.includes(job.state)).length }

  /** The decision one request id already produced, inside the bounded window. */
  lookup(requestId, kind, fingerprint) {
    const record = this.completed.get(requestId)
    if (record === undefined) return null
    if (this.now() - record.at > this.completedTtlMs) { this.completed.delete(requestId); return null }
    if (record.kind !== kind || record.fingerprint !== fingerprint) return { conflict: true, record }
    return { duplicate: true, record }
  }

  remember(job) {
    this.completed.set(job.requestId, { kind: job.kind, fingerprint: job.fingerprint, at: this.now(),
      view: this.view(job) })
    if (this.completed.size <= this.maxCompleted) return
    // Oldest first; the map preserves insertion order.
    for (const [key, record] of this.completed) {
      if (this.completed.size <= this.maxCompleted) break
      if (this.now() - record.at > 0) this.completed.delete(key)
    }
  }

  /**
   * Submit one job. A repeated `requestId` with the same kind and payload returns the original
   * job (or its terminal record) rather than starting a second paid run — the browser retrying
   * after a timeout must not double-charge, and reusing one id for a different task is refused.
   */
  submit({ requestId, kind, label = '', total = 0, run, gate, fingerprint = '' }) {
    if (this.disposed) return { ok: false, code: 'plugin_disposed' }
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return { ok: false, code: 'invalid_request_id' }
    if (!JOB_KINDS.includes(kind)) return { ok: false, code: 'invalid_job_kind' }
    if (typeof run !== 'function' || typeof gate !== 'function') return { ok: false, code: 'invalid_job' }
    const identity = `${kind}:${String(fingerprint)}`
    const existing = this.jobs.find(row => row.requestId === requestId)
    if (existing !== undefined) {
      if (existing.fingerprint !== identity) return { ok: false, code: 'request_conflict' }
      return { ok: true, duplicate: true, job: this.view(existing) }
    }
    const remembered = this.lookup(requestId, kind, identity)
    if (remembered !== null) {
      return remembered.conflict === true ? { ok: false, code: 'request_conflict' }
        : { ok: true, duplicate: true, job: remembered.record.view }
    }
    if (this.pending > 0) {
      // A person may only have one of their own jobs in flight; extra rows would be unbounded.
      return { ok: false, code: 'job_in_progress',
        job: this.list().find(job => !TERMINAL.includes(job.state)) ?? null }
    }
    this.sequence += 1
    const job = { id: `job_${this.sequence.toString(36)}_${Math.trunc(this.now()).toString(36)}`, kind, requestId,
      fingerprint: identity, label: text(label, 80), state: 'queued', submittedAt: this.now(), startedAt: null, endedAt: null,
      progress: { done: 0, total: Math.max(0, Math.trunc(total)) }, code: null, result: null,
      controller: new AbortController(), timer: null, labelTimer: null, run, gate,
      droppedLate: false, cancelledReason: null, terminal: false, settled: false, draining: false,
      outstanding: 0 }
    this.jobs.push(job)
    this.trim()
    this.onEvent({ kind: 'queued', id: job.id, jobKind: kind })
    this.pump()
    return { ok: true, duplicate: false, job: this.view(job) }
  }

  /** Keep the retained window bounded, oldest finished first; never drop a live job. */
  trim() {
    while (this.jobs.length > this.maxRetained) {
      const index = this.jobs.findIndex(job => TERMINAL.includes(job.state) && job.settled)
      if (index === -1) break
      this.jobs.splice(index, 1)
    }
  }

  /** Start the oldest queued job if nothing holds the slot and the gate still allows it. */
  pump() {
    if (this.disposed || this.running !== null) return
    const job = this.jobs.find(row => row.state === 'queued')
    if (job === undefined) return
    const decision = this.checkGate(job)
    if (!decision.allowed) {
      // The gate is consulted here, so a job queued before a pause never starts after it.
      this.terminate(job, { state: 'blocked', code: decision.code })
      return this.pump()
    }
    this.running = job
    job.state = 'running'
    job.startedAt = this.now()
    this.onEvent({ kind: 'started', id: job.id, jobKind: job.kind })
    job.timer = this.schedule(() => this.terminate(job, { state: 'failed', code: 'deadline_exceeded', abort: true }),
      this.jobDeadlineMs)
    const context = {
      signal: job.controller.signal,
      progress: (done, total) => {
        if (TERMINAL.includes(job.state)) return
        job.progress.done = Math.max(0, Math.trunc(done))
        if (Number.isFinite(total)) job.progress.total = Math.max(0, Math.trunc(total))
      },
      /** How many underlying requests the runner still has outstanding. */
      outstanding: count => { job.outstanding = Math.max(0, Math.trunc(count)) },
      /** A runner asks before recording anything of its own. */
      allowed: () => !TERMINAL.includes(job.state) && job.controller.signal.aborted !== true
        && this.checkGate(job).allowed,
    }
    const settle = outcome => {
      job.settled = true
      // A terminal state is never rewritten: a late rejection belongs to a job that was
      // already cancelled or finished, and must not relabel it.
      if (job.terminal) { job.droppedLate = true; this.releaseSlot(job); return }
      if (outcome.state === 'done' && !context.allowed()) {
        this.terminate(job, { state: 'cancelled', code: 'cancelled', cancelledReason: 'permission_revoked' })
        job.droppedLate = true
        return
      }
      this.terminate(job, outcome)
    }
    Promise.resolve().then(() => {
      // Cancelled between `submit` and this microtask: the runner is never entered at all.
      if (job.terminal || job.controller.signal.aborted) {
        job.settled = true
        this.releaseSlot(job)
        return undefined
      }
      return job.run(context)
    }).then(
      value => settle(value !== null && typeof value === 'object' && typeof value.state === 'string'
        ? value : { state: 'done', result: value ?? null }),
      error => settle({ state: 'failed', code: text(error?.code ?? error?.message ?? 'job_failed', 64) }))
  }

  /** Every job travels through the same permission decision; a closed gate is never a success. */
  checkGate(job) {
    try {
      const decision = job.gate()
      if (decision === true) return { allowed: true, code: null }
      if (decision === false) return { allowed: false, code: 'learning_paused' }
      return { allowed: decision?.allowed === true, code: text(decision?.code ?? 'learning_paused', 64) }
    } catch { return { allowed: false, code: 'permission_unavailable' } }
  }

  /** Move a job into its one terminal state. Idempotent: the first call wins. */
  terminate(job, { state, code = null, result = null, abort = false, cancelledReason = null }) {
    if (job.terminal) return
    job.terminal = true
    job.state = state
    job.code = code
    job.result = state === 'done' ? (result ?? null) : null
    job.cancelledReason = cancelledReason
    job.endedAt = this.now()
    if (job.timer !== null) { this.cancelTimer(job.timer); job.timer = null }
    if (abort) job.controller.abort()
    // A job that never started has no runner to wait for, so it is settled by definition —
    // otherwise a refused submission would leave a timer behind and hold a slot nobody used.
    if (job.startedAt === null) job.settled = true
    this.onEvent({ kind: state, id: job.id, jobKind: job.kind, code })
    this.remember(job)
    if (job.settled) this.releaseSlot(job)
    else {
      // The runner has not returned, so a real request may still be in flight. The slot stays
      // held; the timer below only updates the label the status reports. A runner that never
      // returns leaves the queue waiting on purpose — that is the truthful state, and starting
      // another paid request beside it is the one thing this must not do.
      job.drainingSince = this.now()
      job.labelTimer = this.schedule(() => { job.draining = true }, this.drainingLabelMs)
    }
  }

  /** Free the single slot. Idempotent; only the job that holds it can release it. */
  releaseSlot(job) {
    if (job.labelTimer !== null && job.labelTimer !== undefined) { this.cancelTimer(job.labelTimer); job.labelTimer = null }
    if (this.running === job) this.running = null
    this.pump()
  }

  /** Cancel one job. A queued job stops before running; a running job is aborted and ignored. */
  cancel(id, reason = 'user_cancelled') {
    const job = this.jobs.find(row => row.id === id)
    if (job === undefined) return { ok: false, code: 'job_unknown' }
    if (job.terminal) return { ok: true, job: this.view(job) }
    if (job.state === 'queued') {
      // It never started, so it never held the slot; the queued microtask checks `terminal`.
      this.terminate(job, { state: 'cancelled', code: 'cancelled', cancelledReason: text(reason, 64) })
      return { ok: true, job: this.view(job) }
    }
    job.controller.abort()
    this.terminate(job, { state: 'cancelled', code: 'cancelled', cancelledReason: text(reason, 64) })
    return { ok: true, job: this.view(job) }
  }

  /** Cancel everything still live; used when MSE is paused, taken over or unloaded. */
  cancelAll(reason = 'permission_revoked') {
    let cancelled = 0
    for (const job of [...this.jobs]) {
      if (TERMINAL.includes(job.state)) continue
      this.cancel(job.id, reason)
      cancelled += 1
    }
    return cancelled
  }

  status() {
    for (const [key, record] of this.completed) {
      if (this.now() - record.at > this.completedTtlMs) this.completed.delete(key)
    }
    const draining = this.jobs.filter(job => job.terminal === true && job.settled !== true).length
    return { pending: this.pending, running: this.running === null ? null : this.running.id,
      slotHeld: this.running !== null, draining, retained: this.jobs.length, capacity: this.maxRetained,
      remembered: this.completed.size, inMemoryOnly: true,
      dedupeWindowMs: this.completedTtlMs, dedupeCapacity: this.maxCompleted }
  }

  dispose() {
    this.cancelAll('plugin_disposed')
    this.disposed = true
    // Every timer this queue created is dropped here, including the ones belonging to a job
    // whose runner never returned: a disposed plugin must not keep the process alive.
    for (const job of this.jobs) {
      for (const handle of [job.timer, job.labelTimer]) if (handle !== null && handle !== undefined) this.cancelTimer(handle)
      job.timer = null; job.labelTimer = null
    }
    this.jobs = []
    this.completed.clear()
    this.running = null
  }
}
