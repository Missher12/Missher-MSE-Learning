/**
 * Bounded adoption index and the ATTRIBUTION half of the correction path (Stage 3c).
 *
 * A settlement deletes its receipt, so once `complete` has run there is no durable trace of
 * WHICH method version a turn really offered and used. This module keeps that trace — and
 * nothing else — so a later user correction can be attributed back to the exact adopted
 * version instead of guessing from topic words.
 *
 * Why the rules are shaped this way:
 *  • ONLY a real `accept()` writes a record. `prepare` offers context and `session.offered`
 *    is a debit, not a use; neither may ever produce a binding. Recording at accept, inside
 *    the same transaction that marks the receipt accepted, is what makes the record survive
 *    the receipt deletion that follows.
 *  • The record stores identity HASHES and version numbers only: no instruction text, no
 *    context bytes, no project path, no session id, no model output. It cannot leak a
 *    conversation, and it is useless without the live store it points into.
 *  • Capacity and TTL are enforced by the WRITE lifecycle (`pruneRecentAdoptions` /
 *    `recordAdoptionInState`), never by a reader: a status read must not mutate the document.
 *  • Attribution is deliberately NARROW. A correction must (a) point at one session that
 *    really adopted something, (b) be a later turn in that same session, (c) carry the literal
 *    method text in a quotation and give a rejecting cue, (d) resolve to exactly ONE current
 *    version that is still a live trial in the same scope and environment. Anything else —
 *    "刚才不对", a pasted example, a tool or internal message, a brand-new preference, two
 *    plausible methods, a correction aimed at an edition that has since moved on — is
 *    reported as `pending` and changes nothing. Natural language is never allowed to forge a
 *    failure verdict, and no topic-word similarity is ever treated as causation.
 */
import { createHash } from 'node:crypto'

/** One field under schema-2 `state.recentAdoptions`; an absent field is the empty read-only view. */
export const ADOPTION_FORMAT = 1
/** Max SESSIONS kept in the index; the oldest adoption is evicted first. */
export const ADOPTION_SESSION_LIMIT = 64
/** Max lesson bindings kept per session (the recall contract offers at most this many). */
export const ADOPTION_LESSON_LIMIT = 2
/**
 * How long one adoption binding stays usable as attribution evidence.
 *
 * DELIBERATELY SHORTER than the design's 30-day ceiling, and shorter than the 14-day trial licence
 * it can withdraw. That ordering is the whole point: it makes "this adoption binding has expired"
 * and "this trial licence has expired" two provably different events, so the TTL behaviour can be
 * tested — and reasoned about — without either one masking the other. An adoption is evidence about
 * the answer the user just received; a week is already far more than "the next turn", and the
 * oldest-first capacity rule keeps the most recent sessions for exactly as long as they matter.
 */
export const ADOPTION_TTL_MS = 7 * 24 * 60 * 60_000
/**
 * The tier vocabulary of one binding, taken VERBATIM from the receipt that offered it.
 *
 * `verified` is the recall tier of a row a host verifier or a promotion actually vouched for;
 * `trial` is the explicit unverified reference. There is deliberately NO `validated` member: a
 * correction reminder carries `status: 'reminder'` and `verified: 0`, and inventing a promotion
 * label for it would forge an objective fact out of a tier name. Translating the receipt's own
 * vocabulary instead of re-labelling it is what keeps the index a RECORD rather than a verdict.
 */
export const ADOPTION_TIERS = Object.freeze(['verified', 'trial'])
/** The reason a correction attribution is stored under when it is NOT precise enough to act on. */
export const ATTRIBUTION_PENDING_REASON = 'correction_attribution_pending'
/** The reason a correction attribution carries when it did withdraw exactly one licensing trial. */
export const ATTRIBUTION_WITHDRAWN_REASON = 'user_correction'

const hash = text => createHash('sha256').update(text).digest('hex')
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const isPlainObject = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

/** Read-only default; never creates the field. */
export const recentAdoptionsOf = state => state.recentAdoptions ?? { format: ADOPTION_FORMAT, sessions: [] }
/** Write-side constructor; only called inside a write transaction. */
export function ensureRecentAdoptions(state) {
  state.recentAdoptions ??= { format: ADOPTION_FORMAT, sessions: [] }
  return state.recentAdoptions
}

/** One lesson binding of one adoption record. */
function bindingValid(row) {
  return isPlainObject(row) && Object.keys(row).every(key => ['id', 'version', 'tier'].includes(key))
    && typeof row.id === 'string' && /^lesson_[a-f0-9]{24}$/u.test(row.id)
    && Number.isSafeInteger(row.version) && row.version > 0
    && ADOPTION_TIERS.includes(row.tier)
}

/** One session record: at most one per session, always the session's most recent adoption. */
export function adoptionRecordValid(row) {
  return isPlainObject(row) && Object.keys(row).every(key => ['sessionHash', 'scope', 'environment', 'turnHash',
    'at', 'lessons'].includes(key))
    && hex64(row.sessionHash) && hex64(row.scope) && hex64(row.environment) && hex64(row.turnHash)
    && Number.isFinite(row.at)
    && Array.isArray(row.lessons) && row.lessons.length >= 1 && row.lessons.length <= ADOPTION_LESSON_LIMIT
    && row.lessons.every(bindingValid)
    && new Set(row.lessons.map(x => x.id)).size === row.lessons.length
}

/** Whole-index shape validation, run wherever the document is validated. */
export function adoptionIndexValid(state) {
  if (state.recentAdoptions === undefined) return true
  const index = state.recentAdoptions
  if (!isPlainObject(index) || !Object.keys(index).every(key => ['format', 'sessions'].includes(key))
    || index.format !== ADOPTION_FORMAT || !Array.isArray(index.sessions)
    || index.sessions.length > ADOPTION_SESSION_LIMIT) return false
  const sessions = new Set()
  for (const row of index.sessions) {
    if (!adoptionRecordValid(row) || sessions.has(row.sessionHash)) return false
    sessions.add(row.sessionHash)
  }
  return true
}

/**
 * Drop everything the index may no longer use as evidence: expired records and, when the
 * capacity is exceeded, the OLDEST adoptions. Returns the number of records removed.
 *
 * Only ever called inside a write transaction. Retention is oldest-first because a correction
 * arrives right after the adoption it refers to; the newest bindings are the ones worth keeping.
 */
export function pruneRecentAdoptions(index, now) {
  const before = index.sessions.length
  index.sessions = index.sessions.filter(row => row.at + ADOPTION_TTL_MS > now)
    .sort((left, right) => left.at - right.at)
  if (index.sessions.length > ADOPTION_SESSION_LIMIT) {
    index.sessions = index.sessions.slice(index.sessions.length - ADOPTION_SESSION_LIMIT)
  }
  return before - index.sessions.length
}

/**
 * Record one REAL adoption for one session, inside the transaction that accepted it.
 *
 * The record is a SNAPSHOT OF ONE TURN: the turn's own identity (scope, environment, turn hash) and
 * exactly the lessons that turn's receipt really selected, each with the tier it had when it was
 * accepted. A session therefore keeps exactly ONE record — its most recent adoption — and a later
 * adoption REPLACES it outright. Carrying the previous turn's bindings forward would be wrong in
 * three separate ways, all of which were real defects:
 *   • it would attach last turn's `scope`/`environment`/`turnHash` to this turn's selection, so a
 *     correction of the older answer could match an identity it never had;
 *   • it would keep a superseded method listed as attribution evidence after the session moved on;
 *   • it would let a session that simply re-adopted the same edition look like a continuation
 *     instead of a fresh, later use.
 *
 * `at` is always this accept's own time. That is NOT a TTL extension without a fact: this function
 * only runs when `accept()` really wrote, and the core refuses a second accept of the same receipt
 * before reaching it, so one acceptance writes exactly one record, once.
 *
 * The `tier` is frozen as read here, from the row's live state at acceptance time: a later status
 * change (a promotion, a suspension, a withdrawal) must never rewrite what the adoption WAS.
 *
 * @returns the stored record.
 */
export function recordAdoptionInState(index, now, { sessionHash, scope, environment, turnHash, lessons }) {
  pruneRecentAdoptions(index, now)
  index.sessions = index.sessions.filter(row => row.sessionHash !== sessionHash)
  // The recall contract offers at most ADOPTION_LESSON_LIMIT lessons per turn; the bound is enforced
  // here as well, so a stored document can never grow past the declared capacity.
  const record = { sessionHash, scope, environment, turnHash, at: now,
    lessons: lessons.slice(0, ADOPTION_LESSON_LIMIT).map(binding => ({ ...binding })) }
  index.sessions.push(record)
  pruneRecentAdoptions(index, now)
  return record
}

/**
 * Read-only, bounded view of the index: the ids an operator or an audit may compare with,
 * never lesson text. Entries are returned oldest-first; expired records are filtered out here
 * WITHOUT writing, so a read on an expired document is still a read.
 */
export function adoptionView(state, now = Date.now()) {
  const index = recentAdoptionsOf(state)
  return index.sessions.filter(row => row.at + ADOPTION_TTL_MS > now)
    .sort((left, right) => left.at - right.at)
    .map(row => ({ sessionHash: row.sessionHash, scope: row.scope, environment: row.environment,
      turnHash: row.turnHash, at: row.at,
      lessons: row.lessons.map(x => ({ id: x.id, version: x.version, tier: x.tier })) }))
}

/** The bounded contract an external reader may rely on. */
export const ADOPTION_CONTRACT = Object.freeze({ format: ADOPTION_FORMAT,
  maxSessions: ADOPTION_SESSION_LIMIT, lessonsPerSession: ADOPTION_LESSON_LIMIT, ttlMs: ADOPTION_TTL_MS })

/**
 * Quoted spans of the user's own message, as they were typed.
 *
 * Only explicit quotation is extracted — `` ` ``, `"…"`, `“…”`, `「…」`, `『…』` — and each span is
 * collapsed to single spaces and stripped of the emphasis markers the user may have wrapped it in.
 * A span shorter than {@link METHOD_REFERENCE_MIN_CHARS} is not a reference to anything: it is a
 * word the user quoted for some other reason ("unknown", a file name, a version number).
 */
const QUOTE_SPANS = Object.freeze([/`([^`\n]{1,400})`/gu, /"([^"\n]{1,400})"/gu, /“([^”\n]{1,400})”/gu,
  /「([^」\n]{1,400})」/gu, /『([^』\n]{1,400})』/gu])
export const METHOD_REFERENCE_MIN_CHARS = 6
const normalize = text => String(text ?? '').replace(/\*\*/gu, '').replace(/\s+/gu, ' ').trim()
const cleanSpan = text => normalize(text).replace(/^[，,。.；;：:\s]+|[，,。.；;：:\s]+$/gu, '')
export function quotedSpans(prompt) {
  const spans = []
  for (const pattern of QUOTE_SPANS) {
    for (const match of String(prompt ?? '').matchAll(pattern)) {
      const text = cleanSpan(match[1])
      if ([...text].length >= METHOD_REFERENCE_MIN_CHARS) spans.push(text)
    }
  }
  return [...new Set(spans)]
}

/**
 * Does the user's message literally name this exact method?
 *
 * Containment in either direction, on normalized text, is the strongest reference a correction can
 * carry without a structured field: the user quoted the method (the audit's own contract does exactly
 * that) or quoted a longer passage that contains it. Nothing here compares topics, keywords or
 * "similarity" — that inference is what the design forbids.
 */
export function referencesMethod(prompt, instruction) {
  const method = normalize(instruction)
  if ([...method].length < METHOD_REFERENCE_MIN_CHARS) return false
  return quotedSpans(prompt).some(span => span.includes(method) || method.includes(span))
}

/**
 * The user states that a method must NOT be used any more.
 *
 * The cue vocabulary is word-level and deliberately small. Merely quoting a method is not a
 * rejection: the same quote appears in a "explain this to me" or a quoted-example message, and
 * neither may withdraw anything.
 */
const REJECTION_CUES = Object.freeze([
  /不要再/gu, /不再用/gu, /不要用/gu, /不能用/gu, /别再用/gu, /别再/gu, /不许再/gu,
  /不(?:对|行|准|可|应该|要再)/gu, /有(?:误|问题|错)/gu, /错(?:了|误)/gu, /(?:停|终)止(?:使用|采用|用)/gu,
  // "The method I just used is INCOMPLETE / incorrect" is the plainest way a user rejects one, and it
  // is not a negation of the method text itself — it is an assessment OF it, which is why it needs its
  // own cue rather than being caught by the general negation above.
  /(?:不|有)(?:完整|准确|正确|妥当|严谨)/gu,
  /改(?:成|为|用)/gu, /换(?:成|为|掉)/gu, /替换(?:成|为)/gu, /纠正/gu, /更正/gu, /作废/gu,
  /\bnot\s+use\b/giu, /\bdon'?t\s+use\b/giu, /\binstead\s+of\b/giu, /\bwrong\b/giu,
])
export const rejectionCuePresent = text => REJECTION_CUES.some(pattern => new RegExp(pattern.source, pattern.flags).test(String(text ?? '')))

/**
 * Is this method REJECTED by the message — by a clause at or after the one that names it?
 *
 * Scanning the whole message for a rejection word is not enough, and the difference is a real one.
 * `“甲方法”这条不对，以后不要再用；“乙方法”这条可以继续用` rejects 甲 and explicitly KEEPS 乙, while
 * `“甲方法”很好用，另外“乙方法”这条不对` rejects only 乙. One global cue would withdraw whichever
 * method happened to be mentioned — including the one the user asked to keep.
 *
 * The scope is therefore the CLAUSE, with two deliberate exceptions, both taken from how people
 * actually write corrections:
 *   • the rejection may follow the reference in a LATER clause of the same sentence
 *     (`“…”这条方法不完整。以后不要再用这条方法`), because the second clause refers back to the first;
 *   • punctuation inside a quotation never splits a clause.
 *
 * A rejection in an EARLIER clause never reaches forward onto a later reference: that is exactly the
 * "改用其他方法" shape, and any later quotation is about something else.
 *
 * A back-reference without the method text ("以后不要再用这条方法") is deliberately NOT sufficient on
 * its own: it counts only alongside a reference in the same clause or before it. Requiring the
 * quotation keeps the rule decidable instead of similarity-based, and a false refusal only leaves a
 * real correction visible to the operator as pending.
 */
const SENTENCE_DELIMITERS = new Set(['。', '！', '!', '？', '?', '\r', '\n'])
const CLAUSE_DELIMITERS = new Set([',', '，', '、', ';', '；', '：', ':'])
/**
 * A clause that SWITCHES to something is not a clause that rejects the method named in it.
 *
 * `改用“乙方法”处理` names 乙 as the replacement: the selector verb is exactly what makes 乙 wanted.
 * Reading the selector as a rejection would withdraw the method the user just chose.
 */
const REPLACEMENT_CUES = Object.freeze([
  /改用/gu, /换成/gu, /替换为/gu, /替换成/gu, /改为/gu, /用.{0,12}(?:代替|替代)/gu, /以.{0,12}为准/gu,
  /replace/giu, /switch\s+to/giu, /instead\s+use/giu,
])
export const replacementCuePresent = text => REPLACEMENT_CUES.some(pattern => new RegExp(pattern.source, pattern.flags).test(String(text ?? '')))
/**
 * A contrast marker OPENS A NEW TOPIC inside one sentence.
 *
 * `“甲方法”很好用，另外“乙方法”这条不对` rejects 乙 and merely mentions 甲 — and because the rejection
 * is in a LATER clause than 甲's quotation, the "rejection reaches back" rule would otherwise convict
 * 甲 for 乙's complaint. A clause that opens with 另外/不过/但是/… is the user moving on to something
 * else, so the back-reach stops there and only quotations inside that clause (or after it) count.
 *
 * A clause with no such marker keeps the back-reach, which is what makes the ordinary correction
 * shape work: `“…”这条方法不完整。以后不要再用这条方法` has no topic shift between its two clauses.
 */
const CONTRAST_LEAD = /^\s*(?:另外|此外|还有|不过|但是|但|然而|可是|至于|另|顺便说|顺便|再另外|另一方面|其他方法|其他|其它|另一个|另一条|另一些)(?=[\s，,、；;：:“"「『]|$)|^\s*(?:besides|however|but|also|additionally|meanwhile|on another note|otherwise|as for)\b/iu
/**
 * The user POINTING AT the method they just quoted: 这条方法 / 该方法 / 刚才那条 / that method.
 *
 * This is what makes a rejection "about the referenced method" instead of about anything else in the
 * sentence. It is the ordinary way the shape is written — `“…”这条方法不完整`, `以后不要再用这条方法` —
 * and it is deliberately narrow: it is a demonstrative, not a list of topics.
 */
const METHOD_POINTER = /(?:这|那|该|此|上述|上面|刚才(?:这|那)?|前面(?:这|那)?|this|that|the)\s*(?:条|个|种|套|项|方法|做法|处理方式|规则|写法|method|approach|rule|pattern)|(?:这|那|该|此)(?=[\s，,、；;：:。！!？?]|$)/iu
export function referenceRejectedInClause(prompt, instruction) {
  const text = String(prompt ?? '')
  const method = normalize(instruction)
  if ([...method].length < METHOD_REFERENCE_MIN_CHARS) return false
  const quotes = quotedSpanRanges(text)
  const methodQuotes = quotes.filter(span => span.text.includes(method) || method.includes(span.text))
  if (methodQuotes.length === 0) return false
  return delimitedRanges(text, SENTENCE_DELIMITERS).some(sentence => {
    // Where the back-reach currently starts: a quotation before this position is out of scope.
    let scopeStart = sentence.start
    for (const clause of delimitedRanges(text, CLAUSE_DELIMITERS, sentence)) {
      const body = text.slice(clause.start, clause.end)
      // A contrast marker opens a topic: from here a rejection only talks about its OWN clause.
      const shifted = CONTRAST_LEAD.test(body)
      if (shifted) scopeStart = clause.end
      if (replacementCuePresent(body)) continue
      // THE decisive boundary: a rejection must be the user's own words ABOUT the method, so it has
      // to be OUTSIDE the quotation and has to point at it. The quotation is the method's own text —
      // `…不要用旧代次覆盖当前状态…` is a command the METHOD gives, and reading its verbs as the
      // user's complaint withdrew a method the user had just asked to keep. `outside` removes the
      // quoted material before anything is judged, so no negation inside a citation can ever count.
      const outside = stripSpans(text, quotes, clause)
      if (!METHOD_POINTER.test(outside)) continue
      if (!rejectionCuePresent(outside)) continue
      // The pointer names a method. The quotation it refers to is the one inside this clause, or —
      // when the clause does not shift topic — the last one before it in the same sentence, which is
      // how `“…”这条方法不完整。以后不要再用这条方法` reads.
      if (shifted) {
        if (quotes.some(span => span.start >= clause.start && span.start < clause.end
          && (span.text.includes(method) || method.includes(span.text)))) return true
        continue
      }
      if (methodQuotes.some(span => span.start >= scopeStart && span.start < clause.end)) return true
    }
    return false
  })
}

/** The text of one range with every quoted span replaced by a single space. */
function stripSpans(text, spans, range) {
  let output = '', cursor = range.start
  for (const span of spans) {
    if (span.end <= range.start || span.start >= range.end) continue
    output += text.slice(cursor, Math.max(cursor, span.start)) + ' '
    cursor = Math.max(cursor, span.end)
  }
  return output + text.slice(cursor, range.end)
}

/**
 * Split a message at the first-level punctuation that is NOT inside a quotation.
 *
 * `“甲乙，丙丁”` stays one range; `甲乙，丙丁` does not. Positions refer to the original bytes, so a
 * refusal can always be quoted back to the operator without any rewriting. When `within` is given,
 * only that outer range is split: the geometry of one sentence, in the coordinates of the message.
 */
function delimitedRanges(text, delimiters, within = { start: 0, end: text.length }) {
  const ranges = []
  let start = within.start
  for (let index = within.start; index < within.end; index++) {
    if (!delimiters.has(text[index]) || isProtectedAt(text, index)) continue
    ranges.push({ start, end: index })
    start = index + 1
  }
  ranges.push({ start, end: within.end })
  return ranges.filter(range => text.slice(range.start, range.end).trim() !== '')
}

/** Whether one position sits inside a quoted span of the message. */
function isProtectedAt(text, index) {
  return quotedSpanRanges(text).some(span => index >= span.start && index < span.end)
}

/** Every quoted span of the message, with the position it was written at. */
function quotedSpanRanges(text) {
  const spans = []
  for (const pattern of QUOTE_SPANS) {
    for (const match of String(text).matchAll(pattern)) {
      const value = cleanSpan(match[1])
      if ([...value].length >= METHOD_REFERENCE_MIN_CHARS) {
        spans.push({ start: match.index, end: match.index + match[0].length, text: value })
      }
    }
  }
  return spans
}

/** The quoted spans of ONE message, with their positions, so a caller can scope them to a clause. */
function quotedSpansIn(clause) {
  const found = []
  for (const pattern of QUOTE_SPANS) {
    for (const match of String(clause).matchAll(pattern)) {
      const text = cleanSpan(match[1])
      if ([...text].length >= METHOD_REFERENCE_MIN_CHARS) found.push(text)
    }
  }
  return found
}

/**
 * Is this message the user's OWN words?
 *
 * A quoted method is not enough: the same quotation appears in `他说：“…”`, in `据说…`, and inside a
 * pasted transcript. Those are RELAYS of someone else's requirement, and acting on one would let a
 * pasted conversation withdraw a licence the user never rejected.
 *
 * The cue is matched ANYWHERE in the message rather than only immediately before the quotation: a
 * relay typically introduces a whole clause ("他说：刚才你采用的“…”这条方法不对") and the quotation
 * follows inside it. The engine's own correction parser draws the same distinction with the same
 * kind of cue, so the two boundaries agree.
 *
 * The direction is conservative in exactly one way: anything that reads as relayed material is
 * refused, and a false refusal only leaves a real correction visible as pending.
 */
const RELAY_CUES = Object.freeze([
  /(?:他|她|他们|对方|有人|同事|老板|客户|领导|朋友|用户|he|she|they|someone|the user)\s*(?:说|讲|提到|要求|让|指出|表示|问|said|says|asked|wrote)\s*[:：,，]/giu,
  /^(?:\s*>|\s*[-—]\s*|(?:user|assistant|用户|助手)\s*[:：])/gmu,
  /(?:据说|转述|转达|原话|引用|话术|例如|示例|举例子|举例说明|假设|比如|以下材料)/giu,
  /\b(?:said|says|according to|quoted|example|e\.g\.|for instance|hypothetical)\b/giu,
])
export const firstPersonOwnWords = prompt => !RELAY_CUES.some(pattern => new RegExp(pattern.source, pattern.flags).test(String(prompt ?? '')))

/**
 * Resolve ONE user correction against the adoption index and the live state.
 *
 * Pure over its inputs: it decides, it never writes. The caller applies the verdict inside the
 * same transaction that observed the correction, which is what makes "the correction was recorded"
 * and "the licence was withdrawn" one atomic fact instead of two racing ones.
 *
 * @param state - working state of the write transaction.
 * @param input - `{ owner, scope, environment, sessionHash, turnHash, prompt, now }`.
 * @returns `{ action, reason, lessonId?, version?, record?, candidates }` where `action` is
 *   `withdrawn` (exactly one current-version live trial was precisely named and rejected),
 *   `pending` (a real correction that is not precise enough to act on — shown to the operator)
 *   or `none` (nothing in this input is an attribution at all).
 */
export function resolveAdoptionAttribution(state, { owner, scope, environment, sessionHash, turnHash, prompt, now }) {
  if (!hex64(sessionHash) || !hex64(turnHash) || !hex64(scope) || !hex64(environment)) {
    return { action: 'none', reason: 'invalid_attribution_identity', candidates: [] }
  }
  const index = recentAdoptionsOf(state)
  const record = index.sessions.find(row => row.sessionHash === sessionHash
    && row.scope === scope && row.environment === environment && row.at + ADOPTION_TTL_MS > now)
  if (record === undefined) return { action: 'none', reason: 'no_current_adoption', candidates: [] }
  // The correction must be about the PREVIOUS answer. A correction arriving in the very turn that
  // adopted something is not a "next turn" reference, and an adoption FROM ANOTHER SESSION cannot
  // be attributed to this one: both are refusals, not guesses.
  if (record.turnHash === turnHash) return { action: 'none', reason: 'same_turn_as_adoption', record: publicRecord(record), candidates: [] }
  if (!firstPersonOwnWords(prompt)) return { action: 'none', reason: 'relayed_material', record: publicRecord(record), candidates: [] }
  if (!rejectionCuePresent(prompt)) return { action: 'none', reason: 'not_a_rejection', record: publicRecord(record), candidates: [] }
  const rejecting = new Set()
  const candidates = []
  for (const row of state.lessons) {
    const binding = record.lessons.find(x => x.id === row.id && x.version === row.version)
    if (binding === undefined) continue
    if (row.status === 'suspended' || row.status === 'validated' || row.expiresAt <= now) continue
    // The REJECTION has to be about this method: a clause that both names it and rejects it. A
    // message that rejects one method and merely re-uses another must not withdraw the other.
    if (!referenceRejectedInClause(prompt, row.instruction)) continue
    rejecting.add(`${row.id}:${row.version}`)
    // Only a lesson that is STILL HOLDING a live 14-day licensing trial is a candidate for
    // withdrawal: the binding makes the reference precise, and a licence that has not expired makes
    // it actionable. A licence the CLOCK already ended must be left alone — withdrawing it would
    // rewrite `trial_expired` into the permanent reason `user_correction` and silently disqualify
    // the renewal that `maintainLearning` has not run for yet (Stage 3b's whole recovery path).
    if (!trialLicenceLive(row, now)) continue
    candidates.push({ lessonId: row.id, version: row.version })
  }
  // Two adopted methods named in one message is exactly the ambiguity the design refuses to resolve
  // by itself — "两条都不对" must withdraw nothing, and is shown as pending instead.
  if (rejecting.size !== 1 || candidates.length !== 1) {
    return { action: 'pending', reason: rejecting.size > 1 ? 'attribution_ambiguous'
      : rejecting.size === 0 ? 'attribution_unreferenced' : 'attribution_not_a_live_trial',
      record: publicRecord(record), candidates }
  }
  const chosen = candidates[0]
  const lesson = state.lessons.find(row => row.id === chosen.lessonId)
  if (lesson.environment !== environment || lesson.scope !== scope) {
    return { action: 'pending', reason: 'attribution_out_of_binding', record: publicRecord(record), candidates }
  }
  return { action: 'withdrawn', reason: ATTRIBUTION_WITHDRAWN_REASON, lessonId: chosen.lessonId,
    version: chosen.version, record: publicRecord(record), candidates }
}

/**
 * Is this row holding a trial licence that the CLOCK has not already ended?
 *
 * The window is the product's own 14-day licence TTL, mirrored here rather than imported: the engine
 * is the writer and this module is pure logic over the document it is handed. `maintainLearning`
 * converts an expired licence into the withdrawal `trial_expired`, which Stage 3b treats as
 * re-openable once new evidence arrives, while `user_correction` is a decision that never reopens.
 * A correction must therefore never be the thing that retires an expired licence.
 */
const TRIAL_LICENCE_TTL_MS = 14 * 24 * 60 * 60_000
export const trialLicenceLive = (lesson, now) => isPlainObject(lesson?.trial)
  && lesson.trial.state === 'trial' && Number.isFinite(lesson.trial.at)
  && lesson.trial.at + TRIAL_LICENCE_TTL_MS > now

/** The operator-visible half of one record: identity hashes and versions, never lesson text. */
function publicRecord(record) {  return { sessionHash: record.sessionHash, turnHash: record.turnHash, at: record.at,
    lessons: record.lessons.map(x => ({ ...x })) }
}

export { hash as adoptionHash }
