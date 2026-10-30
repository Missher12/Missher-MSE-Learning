/**
 * mse-rebuild recall (EVOLUTION016) — the PURE relevance/selection algorithm that already lived
 * inside engine.prepare, mechanically extracted with no rule change:
 *
 *   rankForRecall  — candidate scope filter + the bundle's tiered relevance + deterministic order
 *   packRecall     — the existing 2-entry / 768-byte line packing, including guard warnings
 *   recallSelection— rank + pack (what prepare now calls)
 *   replayRecall   — offline developer replay over frozen cases; NO store, NO model, NO clock
 *
 * Both `rankForRecall` and `recallSelection` are deterministic functions of their inputs; the CLI
 * (scripts/replay-recall.mjs) never reads or writes the live learning library.
 */
import { analyze } from '../src/recall.mjs'
import { methodNeedsGuard, guardSummary } from './evolution.mjs'

export const DEFAULT_RECALL_MAX_ENTRIES = 2
export const DEFAULT_RECALL_MAX_BYTES = 768

const tokensOf = text => new Set(analyze(text).keys)
const overlap = (left, right) => [...left].filter(token => right.has(token)).length

/**
 * Candidates are the non-retired entries visible in this scope (global, or exactly this
 * project/environment), ranked by the SAME tiered relevance the live engine has always used.
 */
export function rankForRecall(entries, { prompt, scope, environment }) {
  const queryView = analyze(prompt)
  const queryTokens = new Set(queryView.keys)
  const queryBigrams = new Set(queryView.bigrams)
  const candidates = (entries ?? []).filter(entry => entry.status !== 'retired'
    && (entry.visibility === 'global'
      || (entry.originScope === scope && entry.originEnvironment === environment)))
  return candidates.map(entry => {
    // Exclusions are hard refusals; a match on the entry's own exclusion vocabulary ends it.
    if (entry.exclusions !== '' && overlap(tokensOf(entry.exclusions), queryTokens) > 0) {
      return { entry, score: 0 }
    }
    // Relevance is judged over the entry's APPLICABILITY and concrete content with the
    // bundle's own tiered recall view: a shared asserted FORMAT carries a recall on its own;
    // otherwise at least TWO strong topic words, or one strong word corroborated by a shared
    // bigram. A lone generic word (bash, 检查, 生成) never carries an unrelated fix.
    const body = analyze(`${entry.applicability} ${entry.instruction} `
      + `${entry.lesson?.failurePattern ?? ''}`)
    const sharedFormats = body.formats.filter(format => queryView.formats.includes(format)).length
    const strongShared = body.semantic.filter(term => queryView.semantic.includes(term)
      && !queryView.weak.has(term) && !body.weak.has(term)).length
    const bigramShared = overlap(new Set(body.bigrams), queryBigrams)
    const score = sharedFormats >= 1 ? 3
      : strongShared >= 2 || (strongShared >= 1 && bigramShared >= 1) ? 2 : 0
    // The SAME tiered relevance, judged SEPARATELY over the declared applicability. An entry
    // whose stated situation matches the task outranks one whose body is only brushed by
    // metadata tokens (paths, versions, tool names) inside a generic rule.
    const appView = analyze(entry.applicability)
    const appStrong = appView.semantic.filter(term => queryView.semantic.includes(term)
      && !queryView.weak.has(term) && !appView.weak.has(term)).length
    const appBigram = overlap(new Set(appView.bigrams), queryBigrams)
    const appMatch = appStrong >= 2 || (appStrong >= 1 && appBigram >= 1)
    // Bounded precision: capped counts keep this a tie-breaker inside the admission gate,
    // never a popularity contest; older-but-relevant still beats newer-but-irrelevant.
    const precision = Math.min(appStrong, 5) * 3 + Math.min(strongShared, 5)
      + Math.min(bigramShared, 8) + Math.min(appBigram, 8) / 8
    return { entry, score, appMatch, precision }
  }).filter(row => row.score >= 2)
    .sort((left, right) => right.score - left.score
      || Number(right.appMatch) - Number(left.appMatch)
      || right.precision - left.precision
      || (left.entry.type === 'rule' ? -1 : 1) - (right.entry.type === 'rule' ? -1 : 1)
      || right.entry.updatedAt - left.entry.updatedAt
      || (left.entry.id < right.entry.id ? -1 : 1))
}

/**
 * The existing packing rule (2 entries / 768 B, guard warnings inside the same cap). Extracted
 * verbatim so the frozen replay can compare bytes exactly.
 */
export function packRecall(ranked, { maxBytes = DEFAULT_RECALL_MAX_BYTES,
  maxEntries = DEFAULT_RECALL_MAX_ENTRIES, now = Date.now(), guardAdmit = null } = {}) {
  const lines = []
  let bytes = 0
  const offered = []
  for (const { entry } of ranked ?? []) {
    if (offered.length >= maxEntries) break
    // EVOLUTION016: a current edition that already failed under real use is a WARNING, not a
    // recommended method — no old repair steps are replayed.
    const guard = methodNeedsGuard(entry, now)
    const body = guard ? guardSummary(entry, now, { materialAdmit: guardAdmit })
      : entry.type === 'lesson' && entry.lesson
        ? `${entry.instruction}（验收：${entry.lesson.verification.check}→${entry.lesson.verification.expected}）`
        : entry.instruction
    const line = guard ? `\n- 风险警示：${body}`
      : `\n- ${entry.visibility === 'global' ? '经验' : '项目规则'}：${body}`
    const cost = Buffer.byteLength(line, 'utf8')
    if (bytes + cost > maxBytes) continue
    bytes += cost
    offered.push({ id: entry.id, version: entry.version, mode: guard ? 'guard' : 'method' })
    lines.push(line)
  }
  return { lines, bytes, offered }
}

export function recallSelection(entries, options) {
  const ranked = rankForRecall(entries, options)
  return { ranked, ...packRecall(ranked, options) }
}

/**
 * Offline developer replay. `cases` are frozen, hand-labelled cases; `ranker(entries, ctx)` returns
 * the same {offered,bytes} shape. Only labelled cases are scored — an unlabelled case is listed and
 * its bytes are still reported, but it can never be counted as "correct". Bytes never offset a
 * critical regression: miss and falseOffer are reported separately and summed critically.
 */
export function replayRecall(cases, ranker) {
  const report = { cases: [], miss: 0, falseOffer: 0, criticalRegressions: 0, bytes: 0,
    labelled: 0, unlabelled: 0, unlabelledCases: [] }
  for (const testCase of cases ?? []) {
    const expected = testCase.expect ?? {}
    const relevant = Array.isArray(expected.relevant) ? expected.relevant : []
    const excluded = Array.isArray(expected.excluded) ? expected.excluded : []
    const labelled = relevant.length > 0 || excluded.length > 0
    const selection = ranker(testCase.entries ?? [], {
      prompt: testCase.prompt, scope: testCase.scope, environment: testCase.environment })
    const selected = (selection.offered ?? []).map(offer => offer.id)
    const missed = relevant.filter(id => !selected.includes(id))
    const wrong = selected.filter(id => excluded.includes(id))
    report.bytes += selection.bytes ?? 0
    if (labelled) {
      report.labelled += 1
      report.miss += missed.length
      report.falseOffer += wrong.length
      report.criticalRegressions += missed.length + wrong.length
    } else {
      report.unlabelled += 1
      report.unlabelledCases.push(testCase.id)
    }
    report.cases.push({ id: testCase.id, labelled, selected, bytes: selection.bytes ?? 0,
      miss: missed, falseOffer: wrong })
  }
  return report
}
