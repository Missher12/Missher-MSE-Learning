/**
 * Stage 4b — the bounded, durable SOURCE IDENTITY a paid attempt is bound to.
 *
 * The problem ledger already binds a revision to the trusted session, turn and the three
 * provider/model/reasoning scalars the host reported (`src/problems.mjs` `origin`). That is enough
 * to say WHO produced the evidence, and it is deliberately not enough to say WHAT will be asked to
 * produce the reflection: two dispatches can agree on provider and model and still differ in the
 * wire protocol, the endpoint, or whether a reasoning effort is sent at all.
 *
 * This module is the missing half, and it is a LEDGER, not a policy engine:
 *
 *  • A row is a fact a trusted host PUBLISHED about a source session: the endpoint FINGERPRINT, the
 *    api mode, the reasoning identity as one of four PROVABLE states, the driver kind it proved it
 *    can run, and a MONOTONIC revision this core assigns.
 *  • It stores no credential and no raw endpoint. The endpoint arrives as a URL for the length of
 *    one call, is canonicalized, and is reduced to a domain-prefixed SHA-256 FINGERPRINT; only that
 *    fingerprint is stored, echoed, or returned by any surface. Userinfo, query strings and
 *    fragments are REFUSED rather than stripped, because "the same endpoint after dropping the
 *    parts I could not keep" is exactly how two different execution endpoints get conflated — and
 *    the PATH is kept IN FULL for the same reason (trimming it would make different tenants compare
 *    equal), which is precisely why the path must never be persisted in the clear.
 *  • `routeId` is a hash over the whole normalized identity INCLUDING that fingerprint. It is what
 *    a problem observation may record alongside the provider/model it already carries, so a ticket
 *    can prove that the identity a host would dispatch through is the one the evidence came from.
 *  • Nothing here decides whether a reflection may spend, whether evidence is mature, or what a
 *    budget is. The gate lives in the core transaction; this file only answers "is this the same
 *    execution identity, and is it still the one that was frozen".
 *
 * The four reasoning states exist because "we did not see an effort" is not one fact:
 *
 *   explicit         the host's own wire body carried a bounded effort value
 *   unspecified      the host reports a body it built, and it carries no effort field
 *   not_applicable   this provider/protocol has no such parameter
 *   unknown          the host cannot say (no body, an unreadable one, or an unusable value)
 *
 * `unknown` is NOT a default and NOT `unspecified`: a value that merely could not be read is never
 * treated as proof that nothing was sent.
 */
import { createHash } from 'node:crypto'
import { check } from './store.mjs'

/** One field under schema-2 `state.sourceLedger`; an absent field is the empty read-only view. */
export const SOURCE_FORMAT = 1
/** How many source sessions one owner may keep bound at a time. */
export const SOURCE_LIMIT = 32
/** How many session hashes one source row may remember as having run on this identity. */
export const SOURCE_SESSION_WINDOW = 8
/**
 * How long a row stays readable after a host last spoke about it.
 *
 * It is a bound on STALENESS, never a licence: an expired row still refuses a fresh binding until
 * the host re-publishes it, and a row referenced by a live reflection ticket is never evicted at
 * all (the commit gate needs the exact revision it froze).
 */
export const SOURCE_TTL_MS = 24 * 60 * 60_000
/** Extra life a row keeps once a ticket is no longer in flight, so a late commit is not orphaned. */
export const SOURCE_GRACE_MS = 60 * 60_000
/** Restricted driver kinds. Only the capability this build actually PROVED may be published. */
export const SOURCE_DRIVERS = Object.freeze(['async_openai_chat', 'dsh_host_stream'])
/** The four provable reasoning states. */
export const REASONING_STATES = Object.freeze(['explicit', 'unspecified', 'not_applicable', 'unknown'])
/** The api modes this core understands; anything else is stored as `null` (unknown), never guessed. */
export const API_MODES = Object.freeze(['chat_completions', 'responses', 'codex_responses', 'anthropic_messages'])
/** Longest canonical endpoint string this core will fingerprint. */
export const ENDPOINT_MAX_UNITS = 400
/**
 * The domain prefix of an endpoint fingerprint.
 *
 * The fingerprint is a HASH of the canonical endpoint and nothing else, and it carries its own
 * domain tag so a digest from some other scheme can never be mistaken for one of these. The
 * canonical string — which may contain a tenant id, an account slug or a path-shaped token — is
 * NEVER stored, echoed or logged: it exists for the length of one call and is reduced to this
 * digest immediately.
 */
export const ENDPOINT_FINGERPRINT_DOMAIN = 'mse-endpoint-v1'
/** Bounds mirrored from the core's own route contract (`routeValid`). */
const PROVIDER_UNITS = 32
const MODEL_UNITS = 64
const EFFORT_UNITS = 16

const hash = text => createHash('sha256').update(text).digest('hex')
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const isPlainObject = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && /[\u0000-\u001f\u007f]/u.test(value) === false

/**
 * The canonical, non-secret identity of one endpoint, or `null` when it cannot be stated safely.
 *
 * A value is REFUSED (not cleaned) when it carries credentials, a query string or a fragment: each
 * of those can make two different execution endpoints look identical once removed, and guessing
 * which query parameters are "just versioning" is precisely the guess that must not be made here.
 * The PATH is kept in full for the same reason — trimming it would make two different execution
 * endpoints compare equal — but the value this returns is used ONLY to compute a digest and is
 * never persisted, echoed or logged.
 */
export function normalizeEndpoint(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null
  if (/[\u0000-\u001f\u007f]/u.test(value)) return null
  let parsed
  try { parsed = new URL(value) } catch { return null }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username !== '' || parsed.password !== '') return null
  if (parsed.search !== '' || parsed.hash !== '') return null
  const host = parsed.hostname.toLowerCase()
  if (host === '') return null
  const scheme = parsed.protocol.slice(0, -1)
  const port = parsed.port === '' ? (scheme === 'https' ? '443' : '80') : parsed.port
  if (!/^\d{1,5}$/u.test(port)) return null
  let path = parsed.pathname
  const collapsed = path.replace(/\/{2,}/gu, '/')
  if (collapsed !== path) return null
  path = path.replace(/\/+$/u, '')
  if (/[\u0000-\u001f\u007f]/u.test(path)) return null
  const text = `${scheme}://${host}:${port}${path}`
  return text.length <= ENDPOINT_MAX_UNITS ? text : null
}

/**
 * The domain-prefixed FINGERPRINT of an endpoint — the only form of it that is ever stored.
 *
 * `baseUrl` may be a string (canonicalized here) or an already-computed fingerprint (validated and
 * passed through). `null` means "no endpoint was stated", which is a different fact from a stated
 * one and is carried as its own tuple value so the two can never compare equal.
 */
export function endpointFingerprintOf(baseUrl) {
  if (baseUrl === null || baseUrl === undefined) return null
  if (typeof baseUrl === 'string' && hex64(baseUrl)) {
    // Already a fingerprint from this core: the caller is re-stating a fact it read back.
    return baseUrl
  }
  const endpoint = normalizeEndpoint(baseUrl)
  if (endpoint === null) return null
  return hash(`${ENDPOINT_FINGERPRINT_DOMAIN}:${endpoint}`)
}

/**
 * The full normalized identity of one dispatch, or `null` when it is not a usable identity.
 *
 * `null` is the ONLY refusal: every well-formed input yields an identity, and a field the host could
 * not prove is carried as `null`/`unknown` INSIDE it rather than making the whole thing absent, so a
 * later comparison can tell "unproven" from "different". The endpoint is present as a FINGERPRINT;
 * the canonical URL it was computed from is deliberately not part of the identity at all.
 */
export function sourceIdentity({ provider, model, apiMode = null, baseUrl = null, reasoningState, reasoningValue = null }) {
  if (!bounded(provider, PROVIDER_UNITS) || !bounded(model, MODEL_UNITS)) return null
  if (!REASONING_STATES.includes(reasoningState)) return null
  if (reasoningState === 'explicit') {
    if (!bounded(reasoningValue, EFFORT_UNITS)) return null
  } else if (reasoningValue !== null && reasoningValue !== undefined) {
    // Only an explicit state may carry a value: anything else would be a value nobody proved.
    return null
  }
  const mode = apiMode === null || apiMode === undefined ? null
    : (API_MODES.includes(apiMode) ? apiMode : null)
  const endpointFingerprint = baseUrl === null || baseUrl === undefined ? null : endpointFingerprintOf(baseUrl)
  if (baseUrl !== null && baseUrl !== undefined && endpointFingerprint === null) return null
  return { provider, model,
    apiMode: mode, endpointFingerprint,
    reasoningState,
    reasoningValue: reasoningState === 'explicit' ? reasoningValue : null }
}

/**
 * The stable digest of an identity: every field is type-tagged so two identities can never collide
 * by rendering the same way (`null` vs the string "null", an absent api mode vs an unknown one).
 */
export function sourceRouteId(identity) {
  if (!isPlainObject(identity) || !bounded(identity.provider, PROVIDER_UNITS)
    || !bounded(identity.model, MODEL_UNITS) || !REASONING_STATES.includes(identity.reasoningState)) return null
  const mode = identity.apiMode === null || identity.apiMode === undefined ? null : identity.apiMode
  if (mode !== null && !API_MODES.includes(mode)) return null
  const endpoint = identity.endpointFingerprint === null || identity.endpointFingerprint === undefined
    ? null : identity.endpointFingerprint
  // Only a domain-prefixed fingerprint may appear here; a canonical URL never does.
  if (endpoint !== null && !hex64(endpoint)) return null
  const value = identity.reasoningState === 'explicit' ? identity.reasoningValue : null
  if (identity.reasoningState === 'explicit' ? !bounded(value, EFFORT_UNITS) : value !== null && value !== undefined) {
    return null
  }
  return hash(JSON.stringify(['mse-source-route-1', `p:${identity.provider}`, `m:${identity.model}`,
    `a:${mode ?? 'unknown'}`, `e:${endpoint ?? 'unknown'}`,
    `r:${identity.reasoningState}`, `v:${value ?? '-'}`]))
}

/**
 * The digest of a whole source ROW: the identity, the driver capability that was proved, and the
 * ledger EPOCH.
 *
 * The epoch is what makes "released and published again" a DIFFERENT execution. A revision alone
 * cannot: a release removes the row, so the next publication legitimately starts at revision 1, and
 * a binding hash built from the revision would be byte-identical to the one an old ticket froze —
 * even in the same logical millisecond. The epoch is assigned by this core from a persistent
 * counter, so it can never repeat, and any old reference fails the comparison instead of coming
 * back to life.
 */
export function sourceBindingHash(row) {
  if (!isPlainObject(row) || !hex64(row.routeId) || !SOURCE_DRIVERS.includes(row.driver)) return null
  if (!Number.isSafeInteger(row.epoch) || row.epoch < 1) return null
  return hash(JSON.stringify(['mse-source-binding-2', row.routeId, `d:${row.driver}`,
    `b:${row.boundAt}`, `s:${row.sessionHash}`, `e:${row.epoch}`]))
}

/** Owner+session identity of one row: a session hash is never supplied by a caller. */
export function sourceKey(owner, sessionHash) {
  check(hex64(owner) && hex64(sessionHash), 'invalid_source')
  return hash(JSON.stringify([owner, sessionHash]))
}

/** Read-only default; never creates the field. */
export const sourceLedgerOf = state => state.sourceLedger ?? { format: SOURCE_FORMAT, sources: [], binds: 0, epoch: 0 }
/** Write-side constructor; only called inside a write transaction. */
export function ensureSourceLedger(state) {
  state.sourceLedger ??= { format: SOURCE_FORMAT, sources: [], binds: 0, epoch: 0 }
  state.sourceLedger.epoch ??= 0
  return state.sourceLedger
}

/**
 * The next monotonic epoch of this ledger. It only ever moves forward, it is never reset by a
 * release, and it survives restarts because it is stored in the document itself.
 */
export function nextSourceEpoch(ledger) {
  ledger.epoch = (Number.isSafeInteger(ledger.epoch) && ledger.epoch >= 0 ? ledger.epoch : 0) + 1
  return ledger.epoch
}

/** Whether one stored row passes every bounded shape rule. */
export function sourceRowValid(row) {
  if (!isPlainObject(row)) return false
  if (!Object.keys(row).every(key => ['id', 'owner', 'sessionHash', 'sessions', 'scope', 'environment', 'identity',
    'routeId', 'driver', 'revision', 'bindingHash', 'epoch', 'boundAt', 'firstAt', 'lastAt',
    'held'].includes(key))) return false
  if (!hex64(row.id) || !hex64(row.owner) || !hex64(row.sessionHash) || !hex64(row.scope) || !hex64(row.environment)) return false
  if (!Array.isArray(row.sessions) || row.sessions.length > SOURCE_SESSION_WINDOW
    || !row.sessions.every(entry => hex64(entry))) return false
  if (!Array.isArray(row.identity) || row.identity.length !== 6) return false
  const [kind, provider, model, mode, endpoint, reasoning] = row.identity
  if (kind !== 'mse-source-identity-1') return false
  if (!bounded(provider, PROVIDER_UNITS) || !bounded(model, MODEL_UNITS)) return false
  if (mode !== null && !API_MODES.includes(mode)) return false
  // The stored endpoint slot holds a domain-prefixed FINGERPRINT or nothing: a canonical URL in
  // this position is not a shape this build ever writes, so it is refused rather than tolerated.
  if (endpoint !== null && !hex64(endpoint)) return false
  if (!Array.isArray(reasoning) || reasoning.length !== 2) return false
  if (!REASONING_STATES.includes(reasoning[0])) return false
  if (reasoning[0] === 'explicit' ? !bounded(reasoning[1], EFFORT_UNITS)
    : reasoning[1] !== null) return false
  if (!hex64(row.routeId) || !SOURCE_DRIVERS.includes(row.driver)) return false
  if (!Number.isSafeInteger(row.revision) || row.revision < 1) return false
  if (!Number.isSafeInteger(row.epoch) || row.epoch < 1) return false
  if (!hex64(row.bindingHash)) return false
  if (!Number.isFinite(row.boundAt) || !Number.isFinite(row.firstAt) || !Number.isFinite(row.lastAt)) return false
  // A row written before this column existed stays valid; it is simply not held.
  if (row.held !== undefined && typeof row.held !== 'boolean') return false
  return sourceRouteId(identityOf(row)) === row.routeId
}

/** The identity object of a stored row, reconstructed from its canonical field tuple. */
export function identityOf(row) {
  const [kind, provider, model, mode, endpointFingerprint, reasoning] = row.identity
  return { provider, model, apiMode: mode, endpointFingerprint,
    reasoningState: reasoning[0], reasoningValue: reasoning[1] }
}

/** The canonical field tuple an identity is stored as (arrays survive JSON round-trips exactly). */
export const identityTuple = identity => ['mse-source-identity-1', identity.provider, identity.model,
  identity.apiMode, identity.endpointFingerprint, [identity.reasoningState, identity.reasoningValue]]

/** Whole-ledger shape validation, run wherever the document is validated. */
export function sourceLedgerValid(state) {
  if (state.sourceLedger === undefined) return true
  const ledger = state.sourceLedger
  check(isPlainObject(ledger) && Object.keys(ledger).every(key => ['format', 'sources', 'binds', 'epoch']
    .includes(key))
    && ledger.format === SOURCE_FORMAT
    && Array.isArray(ledger.sources) && ledger.sources.length <= SOURCE_LIMIT
    && Number.isSafeInteger(ledger.binds) && ledger.binds >= 0
    && (ledger.epoch === undefined || (Number.isSafeInteger(ledger.epoch) && ledger.epoch >= 0)),
    'invalid_source_ledger')
  const ids = new Set()
  for (const row of ledger.sources) {
    check(sourceRowValid(row) && !ids.has(row.id), 'invalid_source_ledger')
    ids.add(row.id)
  }
  return true
}

/**
 * Set or clear the durable HOLD on one row: whether an unsettled attempt still references it.
 *
 * This travels with the row rather than being derived only from the event ring, because the ring is
 * bounded: an old but live ticket must not lose its protection merely because newer events pushed
 * its record out, and a transaction that returns early without writing must not be able to drop a
 * hold it never cleared.
 */
export function holdSourceInState(state, owner, sessionHash, held) {
  const row = sourceOf(sourceLedgerOf(state), owner, sessionHash)
  if (row === null) return false
  row.held = held === true
  return true
}

/** Whether a stored row is the exact revision a frozen attempt named. */
export function sourceAtRevision(row, revision, bindingHash) {
  return isPlainObject(row) && Number.isSafeInteger(revision) && row.revision === revision
    && typeof bindingHash === 'string' && row.bindingHash === bindingHash
}

/** Find one row of one owner by its raw session hash. */
export function sourceOf(ledger, owner, sessionHash) {
  return ledger.sources.find(row => row.owner === owner && row.sessionHash === sessionHash) ?? null
}

/** Rows this owner may still act on at `now`, oldest first (the eviction order). */
function rankedForEviction(ledger, owner, now, pinned) {
  return ledger.sources.filter(row => row.owner === owner && !pinned(row))
    .sort((left, right) => (left.lastAt - right.lastAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/**
 * Publish (or refresh) the durable identity of one source session.
 *
 * `options.pinned` — session hashes this owner still holds a live ticket for. Such a row is NEVER
 * evicted: the commit gate has to be able to compare against the exact revision the ticket froze,
 * and "the record was trimmed to make room" must never be the reason a paid answer is accepted.
 */
export function publishInState(state, now, input, options = {}) {
  const ledger = ensureSourceLedger(state)
  const pinned = typeof options.pinned === 'function' ? options.pinned : () => false
  const row = sourceOf(ledger, input.owner, input.sessionHash)
  const epoch = nextSourceEpoch(ledger)
  const derived = sourceBindingHash({ routeId: input.routeId, driver: input.driver,
    boundAt: now, sessionHash: input.sessionHash, epoch })
  check(derived !== null, 'invalid_source')
  if (row === null) {
    const evictable = rankedForEviction(ledger, input.owner, now, pinned)
      .filter(candidate => candidate.lastAt + SOURCE_TTL_MS + SOURCE_GRACE_MS <= now)
    if (ledger.sources.length >= SOURCE_LIMIT) {
      // Capacity is REFUSED rather than resolved by dropping a row that is still protecting an
      // attempt: an explicit refusal leaves the caller waiting, a silent eviction would revoke a
      // gate whose ticket is already paid for.
      check(evictable.length > 0, 'source_capacity')
      ledger.sources = ledger.sources.filter(candidate => candidate !== evictable[0])
    }
    const created = { id: hash(JSON.stringify([input.owner, input.sessionHash])), owner: input.owner,
      sessionHash: input.sessionHash, sessions: [...new Set([input.sessionHash, ...input.sessions])]
        .slice(0, SOURCE_SESSION_WINDOW),
      scope: input.scope, environment: input.environment, identity: identityTuple(input.identity),
      routeId: input.routeId, driver: input.driver, revision: 1, bindingHash: derived, epoch,
      boundAt: now, firstAt: now, lastAt: now, held: false }
    ledger.sources.push(created)
    ledger.binds += 1
    return { created: true, row: created }
  }
  // A publication for a row that has since drifted out of its owner's scope is REFUSED, not
  // rewritten: the row's revision is what an in-flight ticket compares against, and rebinding it
  // under a different scope would silently move the attempt's target.
  check(row.scope === input.scope && row.environment === input.environment, 'source_scope_mismatch')
  const sessions = [...new Set([input.sessionHash, ...input.sessions, ...row.sessions])].slice(0, SOURCE_SESSION_WINDOW)
  const unchanged = row.routeId === input.routeId && row.driver === input.driver
    && JSON.stringify(row.sessions) === JSON.stringify(sessions)
  if (unchanged) {
    // An idempotent re-publication of the SAME fact advances nothing: a revision bump that meant
    // "a new identity" would otherwise be indistinguishable from a heartbeat, and every in-flight
    // ticket would be invalidated by a host that merely repeated itself. The epoch that was consumed
    // above is GIVEN BACK, so the counter only ever reflects real identity changes.
    ledger.epoch = epoch - 1
    row.lastAt = now
    return { created: false, duplicate: true, row }
  }
  row.identity = identityTuple(input.identity)
  row.routeId = input.routeId
  row.driver = input.driver
  row.sessions = sessions
  row.revision += 1
  row.epoch = epoch
  row.boundAt = now
  row.lastAt = now
  row.bindingHash = derived
  ledger.binds += 1
  return { created: false, duplicate: false, row }
}

/**
 * Withdraw one source identity, with an explicit CAS precondition.
 *
 * `expectRevision` is required and must still be the row's revision: a release that arrived from a
 * stale read can never retire a NEWER identity the host has since published.
 */
export function releaseInState(state, now, input) {
  const ledger = ensureSourceLedger(state)
  const row = sourceOf(ledger, input.owner, input.sessionHash)
  if (row === null) return { released: false, code: 'source_unknown' }
  if (row.revision !== input.expectRevision
    || (input.expectBindingHash !== undefined && input.expectBindingHash !== null
      && row.bindingHash !== input.expectBindingHash)) {
    return { released: false, code: 'source_stale_revision' }
  }
  ledger.sources = ledger.sources.filter(candidate => candidate !== row)
  return { released: true, code: null }
}

/**
 * Drop rows nothing can still act on.
 *
 * This is the ONLY place rows disappear outside an explicit release, and it is deliberately shy:
 * a row survives its whole TTL plus a grace period, and a row referenced by a live ticket or by a
 * stop tombstone is not touched at all.
 */
export function pruneSourcesInState(state, now, options = {}) {
  const ledger = ensureSourceLedger(state)
  const pinned = typeof options.pinned === 'function' ? options.pinned : () => false
  const stops = Array.isArray(options.stops) ? options.stops : []
  const kept = ledger.sources.filter(row => {
    if (pinned(row)) return true
    // A stop tombstone outlives everything that could still act on the session. A source row is
    // one of those things now: trimming it while the tombstone is in force would mean a later
    // publication could re-open a session the operator stopped.
    if (stops.some(stop => stop.sessionHash === row.sessionHash)) return true
    return row.lastAt + SOURCE_TTL_MS + SOURCE_GRACE_MS > now
  })
  ledger.sources = kept
  return ledger.sources.length
}
