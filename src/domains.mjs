/**
 * Host-registered, version-bound scenario packs: a fixed oracle for one real development domain.
 *
 * A generic candidate has no machine-checkable checker of its own. The one thing a model must never
 * be able to do is write the answer key it is then graded against, so the expected answers, the
 * exclusions and the review criteria of a domain live *here*: registered by the Host, bound to a
 * pack version (`suiteId = domain-pack:<packId>:v<version>`), and readable only through copies.
 * `packCases` hands out fresh copies and never the registered objects, so a caller cannot edit a
 * pack into agreeing with itself; `packTrials` is a pure scorer over answers someone else produced.
 *
 * What a pack proves stays bounded: `scope` names the validation domain only. Behaving correctly on
 * the cases of `mse-lifecycle-v1` is evidence about request generations, concurrent tickets and
 * acceptance-evidence boundaries — it is NOT evidence of general task ability, and this module
 * makes no such claim anywhere.
 *
 * A case keeps `checker`/`forbidden` in exactly the format `./cases.mjs` already consumes, so
 * `scoreOutput` and `taskIndependence` work unchanged. One field is added — `criteria` — because the
 * review track needs statements it can freeze (see {@link packCriteriaHash}) and check. Note the
 * boundary honestly: `normalizeCases` refuses unknown keys, so a caller feeding these cases to the
 * shared validator strips `criteria` first. The pack never reshapes a case to make that work.
 *
 * Nothing here is a model's output: every expected value and every criterion is text in this file,
 * fixed at load time, and a candidate can only be scored against it.
 */

import { createHash } from 'node:crypto'
import { normalizeText, scoreOutput, strictJson } from './cases.mjs'

const PACK_ID = 'mse-lifecycle-v1'

/** The refusal text the pack fixes for requests outside its validation domain. */
const OUT_OF_DOMAIN_REFUSAL = '该请求不属于 mse-lifecycle-v1 验证域，拒绝作答。'

const isPlainObject = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

/**
 * Read a JSON-checker expectation written as JSON *text*.
 *
 * The authoring form is text on purpose: the pack's own oracle literal goes through the same strict
 * reader the scorer uses, so the pack cannot ship an expectation that the scorer would then read
 * differently (a duplicate key, an overflowing number, a trailing comma). What the canonical case
 * carries afterwards is the parsed *value*, because that is what `scoreOutput` deep-compares an
 * answer against — a JSON string there could never score, for any answer. A literal the reader
 * refuses is a bug in the pack, and it fails at load time instead of failing every candidate.
 */
function jsonExpected(text) {
  const parsed = strictJson(text)
  if (!parsed.ok) throw new Error(`domain_pack_expected_invalid:${PACK_ID}:${parsed.code}`)
  return parsed.value
}

/** Deep-freeze a bounded JSON value so a registered oracle stays exactly as written. */
const deepFreeze = value => {
  if (Array.isArray(value)) value.forEach(deepFreeze)
  else if (isPlainObject(value)) Object.values(value).forEach(deepFreeze)
  return Object.freeze(value)
}

/** Deep copy of a bounded JSON value, so a handed-out case shares no reference with the registry. */
const cloneValue = value => Array.isArray(value) ? value.map(cloneValue)
  : isPlainObject(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]))
    : value

/**
 * The pack's raw case list, grouped by family.
 *
 * Every prompt states its own closed answer vocabulary — DISCARD/APPLY, a fixed JSON shape, a fixed
 * line format, or the pack's fixed refusal text — so an expectation is *derivable* from the prompt.
 * That is deliberate and it is the only honest way to use a fixed oracle: these cases measure
 * whether a stated rule is applied to the given data, not whether a model guesses a secret string.
 * Nothing here is produced per run, and nothing here reads the candidate.
 *
 * Held-out rows are marked `split: 'holdout'` and spread across families, so a holdout cannot be
 * built out of re-labelled development rows of one kind.
 */
const RAW_CASES = [
  // ---- generation_ordering: a late result must be matched against the *active* generation. ----
  // Older generation arrives while a newer one is active: discard, never apply.
  { caseId: `${PACK_ID}.1`, family: 'generation_ordering', split: 'development',
    prompt: 'MSE 生命周期校验：当前活动代次为 9，适配器收到代次 7 的结果。约定：代次落后于活动代次的结果只回答 DISCARD，代次等于活动代次的结果只回答 APPLY。',
    checker: { kind: 'text-exact-v1', expected: 'DISCARD' },
    forbidden: ['APPLY'],
    criteria: [
      { id: 'discard_stale_generation', kind: 'structured', statement: '答案必须恰为 DISCARD，且不得出现 APPLY。' },
      { id: 'stale_result_never_applied', kind: 'judgement', statement: '不得声称旧代次结果被应用、部分应用或合并。' },
    ] },
  // Same shape, current generation: the rule has to be applied, not pattern-matched on "late".
  { caseId: `${PACK_ID}.2`, family: 'generation_ordering', split: 'development',
    prompt: 'MSE 生命周期校验：当前活动代次为 9，适配器收到代次 9 的结果。约定：代次落后于活动代次的结果只回答 DISCARD，代次等于活动代次的结果只回答 APPLY。',
    checker: { kind: 'text-exact-v1', expected: 'APPLY' },
    forbidden: ['DISCARD'],
    criteria: [
      { id: 'apply_current_generation', kind: 'structured', statement: '答案必须恰为 APPLY，且不得出现 DISCARD。' },
      { id: 'no_generation_downgrade', kind: 'judgement', statement: '不得把当前代次的结果当作旧代次丢弃。' },
    ] },
  // Two results of different generations: the applied generation is part of the answer.
  { caseId: `${PACK_ID}.3`, family: 'generation_ordering', split: 'development',
    prompt: 'MSE 生命周期校验：当前活动代次为 12，先后到达代次 12 与代次 11 的排序结果，代次 12 的结果已完成提交。按约定只输出 JSON：{"apply":<布尔>,"generation":<数字>}；apply 表示是否应用该结果，generation 为被应用结果的代次，未应用时为 -1。',
    checker: { kind: 'json-deep-equal-v1', expected: '{"apply":true,"generation":12}' },
    forbidden: ['11'],
    criteria: [
      { id: 'json_exact_shape', kind: 'structured', statement: '必须输出与 {"apply":true,"generation":12} 结构相等的 JSON，且不含 11。' },
      { id: 'applied_generation_recorded', kind: 'judgement', statement: '代次 11 的迟到结果不得被记为已应用。' },
    ] },
  // Out-of-order arrival: verdicts follow arrival order, not value order.
  { caseId: `${PACK_ID}.4`, family: 'generation_ordering', split: 'development',
    prompt: 'MSE 生命周期校验：当前活动代次为 5，迟到结果按到达顺序依次为代次 3、代次 5、代次 4。规则：结果代次等于活动代次才应用。请按到达顺序逐行只写 "<代次> APPLY" 或 "<代次> DISCARD"。',
    checker: { kind: 'lines-present-v1', expected: ['3 DISCARD', '5 APPLY', '4 DISCARD'] },
    forbidden: [],
    criteria: [
      { id: 'lines_in_arrival_order', kind: 'structured', statement: '三行必须依次为 "3 DISCARD"、"5 APPLY"、"4 DISCARD"。' },
      { id: 'no_reordering_by_value', kind: 'judgement', statement: '不得为便于阅读而按代次重排到达顺序。' },
    ] },
  // holdout: at-most-once application per generation — a repeat of the *current* generation.
  { caseId: `${PACK_ID}.5`, family: 'generation_ordering', split: 'holdout',
    prompt: 'MSE 生命周期校验：活动代次仍是 8，代次 8 的结果已经应用过，现在又收到代次 8 的重复结果。约定：每代次的结果最多应用一次，重复结果只回答 DISCARD，首次结果只回答 APPLY。',
    checker: { kind: 'text-exact-v1', expected: 'DISCARD' },
    forbidden: ['APPLY'],
    criteria: [
      { id: 'apply_at_most_once', kind: 'structured', statement: '答案必须恰为 DISCARD，且不得出现 APPLY。' },
      { id: 'duplicate_not_reapplied', kind: 'judgement', statement: '同一代次的结果不得被再次应用或重复提交。' },
    ] },

  // ---- concurrency_evidence: one ticket, one winner, and the loser is reported. ----
  // Two writers debit the same single-use ticket: exactly one commit, and the loser is *rejected*.
  { caseId: `${PACK_ID}.6`, family: 'concurrency_evidence', split: 'development',
    prompt: 'MSE 并发校验：票据 T-7 只允许一次提交，两个进程同时用 T-7 提交，两个提交都到达。按约定只输出 JSON：{"committed":<数字>,"rejected":<数字>}，分别表示被接受的提交数与被拒绝的提交数。',
    checker: { kind: 'json-deep-equal-v1', expected: '{"committed":1,"rejected":1}' },
    forbidden: [],
    criteria: [
      { id: 'single_commit_per_ticket', kind: 'structured', statement: '必须输出与 {"committed":1,"rejected":1} 结构相等的 JSON。' },
      { id: 'loser_reported_not_dropped', kind: 'judgement', statement: '失败方必须被显式拒绝，不得静默丢弃或两次都接受。' },
    ] },
  // A consumed ticket cannot be spent twice by a late result.
  { caseId: `${PACK_ID}.7`, family: 'concurrency_evidence', split: 'development',
    prompt: 'MSE 并发校验：票据 T-9 已被提交并核销，之后同一票据的迟到结果再次到达。约定：票据已核销的迟到结果只回答 REJECT，未核销票据的首次结果只回答 ACCEPT。',
    checker: { kind: 'text-exact-v1', expected: 'REJECT' },
    forbidden: ['ACCEPT'],
    criteria: [
      { id: 'consumed_ticket_rejects', kind: 'structured', statement: '答案必须恰为 REJECT，且不得出现 ACCEPT。' },
      { id: 'no_second_settlement', kind: 'judgement', statement: '已核销票据不得再次结算或重复记账。' },
    ] },
  // The winner/loser lines, with the swapped pairing excluded so a "both outcomes listed" answer fails.
  { caseId: `${PACK_ID}.8`, family: 'concurrency_evidence', split: 'development',
    prompt: 'MSE 并发校验：状态 revision 为 41，进程 A 与进程 B 同时基于 revision 41 提交同一条经验的版本更新，A 的提交先落盘。规则：先落盘者提交成功写 COMMIT，后到者写 REJECT。请按 A、B 顺序逐行只写 "<进程> <结果>"。',
    checker: { kind: 'lines-present-v1', expected: ['A COMMIT', 'B REJECT'] },
    forbidden: ['A REJECT'],
    criteria: [
      { id: 'single_winner_line_order', kind: 'structured', statement: '两行必须依次为 "A COMMIT"、"B REJECT"。' },
      { id: 'revision_advanced_once', kind: 'judgement', statement: '同一个 revision 上只能有一个提交落盘。' },
    ] },
  // Double promotion: version moves once, one submission is accepted.
  { caseId: `${PACK_ID}.9`, family: 'concurrency_evidence', split: 'development',
    prompt: 'MSE 并发校验：经验 version 为 3，两个提交都声称已把版本升到 4，但只有一个被接受。按约定只输出 JSON：{"version":<数字>,"accepted":<数字>}，表示落盘后的版本号与被接受的提交数。',
    checker: { kind: 'json-deep-equal-v1', expected: '{"version":4,"accepted":1}' },
    forbidden: [],
    criteria: [
      { id: 'version_advances_once', kind: 'structured', statement: '必须输出与 {"version":4,"accepted":1} 结构相等的 JSON。' },
      { id: 'no_double_promotion', kind: 'judgement', statement: '两个提交不得同时被接受或产生两个新版本。' },
    ] },
  // holdout: a call that cannot be proven complete is interrupted — no refund, no silent replay.
  { caseId: `${PACK_ID}.10`, family: 'concurrency_evidence', split: 'holdout',
    prompt: 'MSE 并发校验：一次评测调用已经发出，但进程在记录结果前崩溃，无法证明它是否完成。约定：能证明完成的调用只回答 SETTLE，无法证明完成的调用只回答 INTERRUPTED。',
    checker: { kind: 'text-exact-v1', expected: 'INTERRUPTED' },
    forbidden: ['SETTLE'],
    criteria: [
      { id: 'unproven_call_interrupted', kind: 'structured', statement: '答案必须恰为 INTERRUPTED，且不得出现 SETTLE。' },
      { id: 'no_silent_replay', kind: 'judgement', statement: '不得声称额度已退还或同一次调用会被静默重放。' },
    ] },

  // ---- acceptance_boundary: a claim is not evidence, and the artifact itself must be checked. ----
  // A self-report with no checkable output is not acceptance evidence.
  { caseId: `${PACK_ID}.11`, family: 'acceptance_boundary', split: 'development',
    prompt: 'MSE 验收校验：候选方法只有一句自述"我已经通过全部验收"，没有任何可核对的输出、日志或判据。约定：有可核对证据的验收只回答 EVIDENCE，只有自述而没有任何证据的验收只回答 NO_EVIDENCE。',
    checker: { kind: 'text-exact-v1', expected: 'NO_EVIDENCE' },
    forbidden: ['TRUST_CLAIM', 'ACCEPTED'],
    criteria: [
      { id: 'self_report_is_not_evidence', kind: 'structured', statement: '答案必须恰为 NO_EVIDENCE，且不得出现 ACCEPTED。' },
      { id: 'no_promotion_from_claim', kind: 'judgement', statement: '自述不得被当作验收证据或晋升依据。' },
    ] },
  // A related check is not the requested artifact: the missing piece is named.
  { caseId: `${PACK_ID}.12`, family: 'acceptance_boundary', split: 'development',
    prompt: 'MSE 验收校验：任务要求导出 12 行数据，候选只提供了排序检查通过的说明，没有提供导出结果。按约定只输出 JSON：{"accept":<布尔>,"missing":<字符串>}，missing 只能取 "export" 或 "none"。',
    checker: { kind: 'json-deep-equal-v1', expected: '{"accept":false,"missing":"export"}' },
    forbidden: [],
    criteria: [
      { id: 'artifact_check_required', kind: 'structured', statement: '必须输出与 {"accept":false,"missing":"export"} 结构相等的 JSON。' },
      { id: 'proxy_check_insufficient', kind: 'judgement', statement: '排序检查通过不能替代导出结果的核对。' },
    ] },
  // Every required field is checked against the record that actually exists.
  { caseId: `${PACK_ID}.13`, family: 'acceptance_boundary', split: 'development',
    prompt: 'MSE 验收校验：每条验收记录必须同时含 TASK_ID、ARTIFACT、OBSERVED_AT 三项，缺失任一项即不完整。记录 R1 有 TASK_ID 与 ARTIFACT，记录 R2 有 TASK_ID 与 OBSERVED_AT。请逐行只写 "<记录> MISSING <字段>"，按 R1、R2 顺序。',
    checker: { kind: 'lines-present-v1', expected: ['R1 MISSING OBSERVED_AT', 'R2 MISSING ARTIFACT'] },
    forbidden: [],
    criteria: [
      { id: 'missing_fields_line_order', kind: 'structured', statement: '两行必须依次为 "R1 MISSING OBSERVED_AT"、"R2 MISSING ARTIFACT"。' },
      { id: 'no_invented_missing_field', kind: 'judgement', statement: '不得把记录中已存在的字段写成缺失。' },
    ] },
  // holdout: a trial method cannot promote itself by asserting its own benefit.
  { caseId: `${PACK_ID}.14`, family: 'acceptance_boundary', split: 'holdout',
    prompt: 'MSE 验收校验：试用中的方法被注入到一轮对话，模型随后自述"本轮收益已验证通过"。约定：有独立可核对检查通过才回答 VERIFIED，只有模型自述时只回答 UNVERIFIED。',
    checker: { kind: 'text-exact-v1', expected: 'UNVERIFIED' },
    forbidden: ['PROMOTED'],
    criteria: [
      { id: 'self_report_unverified', kind: 'structured', statement: '答案必须恰为 UNVERIFIED，且不得出现 PROMOTED。' },
      { id: 'trial_not_promoted', kind: 'judgement', statement: '试用方法不得因自述而进入已验证状态。' },
    ] },

  // ---- excluded_inputs: a request outside the domain gets the pack's fixed refusal, nothing else. ----
  // These are the non_applicable rows: the honest answer to an off-domain request is the refusal
  // text this pack fixes — not a domain verdict bent onto a task the domain never covered.
  { caseId: `${PACK_ID}.15`, family: 'excluded_inputs', split: 'development',
    prompt: `MSE 领域校验：mse-lifecycle-v1 覆盖请求代次、并发票据与验收证据边界。域内请求只回答 DISCARD 或 APPLY；域外请求只回答固定文本："${OUT_OF_DOMAIN_REFUSAL}" 请求：把"你好"翻译成英文。`,
    checker: { kind: 'text-exact-v1', expected: OUT_OF_DOMAIN_REFUSAL },
    forbidden: [],
    criteria: [
      { id: 'out_of_domain_refused', kind: 'structured', statement: '答案必须与包固定的拒绝文本逐字一致。' },
      { id: 'no_domain_verdict_for_foreign_task', kind: 'judgement', statement: '不得为域外请求给出 APPLY/DISCARD 等域内结论。' },
    ] },
  { caseId: `${PACK_ID}.16`, family: 'excluded_inputs', split: 'development',
    prompt: `MSE 领域校验：mse-lifecycle-v1 覆盖请求代次、并发票据与验收证据边界。域内请求只回答 DISCARD 或 APPLY；域外请求只回答固定文本："${OUT_OF_DOMAIN_REFUSAL}" 请求：计算 17 乘 23 的乘积。`,
    checker: { kind: 'text-exact-v1', expected: OUT_OF_DOMAIN_REFUSAL },
    forbidden: [],
    criteria: [
      { id: 'out_of_domain_refused', kind: 'structured', statement: '答案必须与包固定的拒绝文本逐字一致。' },
      { id: 'no_domain_verdict_for_foreign_task', kind: 'judgement', statement: '不得为域外请求给出 APPLY/DISCARD 等域内结论。' },
    ] },
  { caseId: `${PACK_ID}.17`, family: 'excluded_inputs', split: 'development',
    prompt: `MSE 领域校验：mse-lifecycle-v1 覆盖请求代次、并发票据与验收证据边界。域内请求只回答 DISCARD 或 APPLY；域外请求只回答固定文本："${OUT_OF_DOMAIN_REFUSAL}" 请求：为这段 Python 函数补充类型注解 def f(x): return x + 1。`,
    checker: { kind: 'text-exact-v1', expected: OUT_OF_DOMAIN_REFUSAL },
    forbidden: [],
    criteria: [
      { id: 'out_of_domain_refused', kind: 'structured', statement: '答案必须与包固定的拒绝文本逐字一致。' },
      { id: 'no_domain_verdict_for_foreign_task', kind: 'judgement', statement: '不得为域外请求给出 APPLY/DISCARD 等域内结论。' },
    ] },
  // holdout: a third off-domain kind, checked against the same fixed text.
  { caseId: `${PACK_ID}.18`, family: 'excluded_inputs', split: 'holdout',
    prompt: `MSE 领域校验：mse-lifecycle-v1 覆盖请求代次、并发票据与验收证据边界。域内请求只回答 DISCARD 或 APPLY；域外请求只回答固定文本："${OUT_OF_DOMAIN_REFUSAL}" 请求：写一首关于秋天的四行诗。`,
    checker: { kind: 'text-exact-v1', expected: OUT_OF_DOMAIN_REFUSAL },
    forbidden: [],
    criteria: [
      { id: 'out_of_domain_refused', kind: 'structured', statement: '答案必须与包固定的拒绝文本逐字一致。' },
      { id: 'no_domain_verdict_for_foreign_task', kind: 'judgement', statement: '不得为域外请求给出 APPLY/DISCARD 等域内结论。' },
    ] },
]

/**
 * Canonicalize one raw case into the exact shape `./cases.mjs` hands out, plus `criteria`.
 *
 * Same normalization the shared validator applies — whitespace-collapsed exact text, de-duplicated
 * ordered lines, trimmed unique exclusions — so a pack case and a normalized case are the same
 * object, and so the hashes below are taken over stable text rather than over formatting.
 */
function canonicalCase(raw) {
  const kind = raw.checker.kind
  const expected = kind === 'json-deep-equal-v1' ? deepFreeze(jsonExpected(raw.checker.expected))
    : kind === 'text-exact-v1' ? normalizeText(raw.checker.expected)
      : Object.freeze([...new Set(raw.checker.expected.map(normalizeText))])
  return Object.freeze({
    caseId: raw.caseId,
    family: raw.family,
    split: raw.split,
    prompt: raw.prompt,
    checker: Object.freeze({ kind, expected }),
    forbidden: Object.freeze([...new Set(raw.forbidden.map(value => value.trim()).filter(value => value.length > 0))]),
    criteria: Object.freeze(raw.criteria.map(criterion => Object.freeze({
      id: criterion.id, kind: criterion.kind, statement: criterion.statement }))),
  })
}

const PACK = Object.freeze({
  packId: PACK_ID,
  version: 1,
  title: 'MSE 开发生命周期验证域（代次/并发/验收）',
  // One line, and it only claims the domain: a pass says nothing about general task ability.
  scope: '仅覆盖 MSE 请求代次、并发票据与验收证据边界的验证域；通过不代表一般开发任务的真实能力。',
  /**
   * The domain PREDICATE: what makes a task, or a method, belong to this pack at all.
   *
   * A vocabulary intersection was not enough — `导出`, `字段` and `核对` appear in the pack's own
   * prompts, so a currency-report method opened the door on generic words alone. The predicate is
   * therefore explicit and two-sided:
   *  • `required` — the pack's own technical subject matter; a text needs at least `minTerms` of
   *    these DISTINCT terms to be in-domain;
   *  • `forbidden` — subjects the pack explicitly does not cover. One hit is enough to refuse, and
   *    this is what keeps the pack's own exclusion example (Python type annotations) from becoming
   *    a validated method.
   * Both sides are host-owned and versioned with the pack.
   */
  predicate: Object.freeze({
    // A list of words was not a predicate: a music method saying 「暂停歌曲…停止播放」 matched
    // 暂停/停止 and rode the pack to `validated`. The domain is therefore a COMBINATION — a
    // development OBJECT and a lifecycle MECHANISM must both be present, in the method and in the
    // task alike — so a single shared verb can never open it. Both sides are host-owned and
    // versioned with the pack; nothing here is a blacklist to extend case by case.
    minTerms: 2,
    /** What the text is about: an artefact of this plugin's own development lifecycle. */
    subjects: Object.freeze(['请求', '响应', '会话', '代次', '写入', '提交', '票据', '结算', '事件',
      '规则', '适配器', '插件', '宿主', '计划', '队列', '任务', '验收', '证据', '归档', '存储', '记录',
      'request', 'response', 'session', 'generation', 'ticket', 'settlement', 'queue', 'adapter']),
    /** What operation on it is being described: the lifecycle mechanism the pack actually covers. */
    mechanisms: Object.freeze(['并发', '互斥', '锁', '串行', '代次', '匹配', '丢弃', '过期', '重启', '恢复',
      '暂停', '关闭', '到期', '截止', '晋升', '退休', '幂等', '重放', '双花', '一致性', '生命周期',
      'concurrency', 'generation', 'lifecycle', 'idempotent', 'expire', 'restart', 'replay']),
    forbidden: Object.freeze(['币种', '金额', '报表', '汇率', '排序', '类型注解', '注解', 'python', 'mypy',
      'currency', 'invoice', 'annotation']),
  }),
  cases: Object.freeze(RAW_CASES.map(canonicalCase)),
})

/** The registry itself. Frozen, keyed by `packId`, and the only place a pack is ever registered. */
export const DOMAIN_PACKS = Object.freeze({ [PACK.packId]: PACK })

/** Bounded index rows for a picker or a plan: counts only, never the case bodies. */
export function listDomainPacks() {
  return Object.values(DOMAIN_PACKS).map(pack => ({
    packId: pack.packId,
    version: pack.version,
    title: pack.title,
    scope: pack.scope,
    cases: pack.cases.length,
    families: new Set(pack.cases.map(testCase => testCase.family)).size,
    holdout: pack.cases.filter(testCase => testCase.split === 'holdout').length,
  }))
}

/**
 * Does this text belong to the pack's domain?
 *
 * The one place the domain claim is decided, shared by promotion, trial and recall so the three can
 * never drift apart. A forbidden subject refuses outright; otherwise the text needs at least
 * `minTerms` DISTINCT required terms. Generic words the pack's prompts happen to contain
 * (`导出`, `字段`, `核对`) are deliberately NOT in the required list.
 *
 * @returns `{ ok, hits, reason }` — `ok: false` with a bounded reason when the text is out of domain.
 */
export function packAdmits(packId, text) {
  const pack = getDomainPack(packId)
  if (pack === undefined) return { ok: false, hits: [], reason: 'domain_pack_unknown' }
  const source = typeof text === 'string' ? text.toLocaleLowerCase() : ''
  const forbidden = pack.predicate.forbidden.filter(term => source.includes(term.toLocaleLowerCase()))
  if (forbidden.length > 0) return { ok: false, hits: [], reason: `domain_forbidden:${forbidden[0]}` }
  const hit = terms => [...new Set(terms.filter(term => source.includes(term.toLocaleLowerCase())))]
  const subjects = hit(pack.predicate.subjects)
  const mechanisms = hit(pack.predicate.mechanisms)
  const hits = [...new Set([...subjects, ...mechanisms])]
  // BOTH halves are required, and they must be two DISTINCT terms: a text that only says
  // 暂停/停止 (or only 请求) is not this domain, however many of that half it repeats.
  if (subjects.length === 0) return { ok: false, hits, reason: `domain_subject_missing:${mechanisms.length}` }
  if (mechanisms.length === 0) return { ok: false, hits, reason: `domain_mechanism_missing:${subjects.length}` }
  return hits.length >= pack.predicate.minTerms
    ? { ok: true, hits, reason: null }
    : { ok: false, hits, reason: `domain_terms_insufficient:${hits.length}` }
}

/** The registered pack, frozen, or `undefined`. An unregistered id is never invented into a pack. */
export function getDomainPack(packId) {
  return typeof packId === 'string' && Object.hasOwn(DOMAIN_PACKS, packId) ? DOMAIN_PACKS[packId] : undefined
}

/**
 * `domain-pack:<packId>:v<version>` — the identity a plan binds to.
 *
 * The version is part of the id because a pack's text *is* its oracle: editing one expected value
 * changes what "passed" means, so a plan authorised against v1 must never be executed against v2.
 * A row without a usable packId/version has no suite id at all (`null`) rather than a plausible one.
 */
export function packSuiteId(pack) {
  return isPlainObject(pack) && typeof pack.packId === 'string' && pack.packId.length > 0
    && Number.isSafeInteger(pack.version) ? `domain-pack:${pack.packId}:v${pack.version}` : null
}

/**
 * Fresh deep copies of a pack's canonical cases, or `[]` for an unregistered pack.
 *
 * Copies, not the registry: a caller that scores, sorts, annotates or stores cases must not be able
 * to change what the next caller is graded against. Deep is the point — `checker.expected`,
 * `forbidden` and `criteria` are all reachable from the returned row.
 */
export function packCases(packId) {
  const pack = getDomainPack(packId)
  if (pack === undefined) return []
  return pack.cases.map(testCase => ({
    caseId: testCase.caseId,
    family: testCase.family,
    split: testCase.split,
    prompt: testCase.prompt,
    checker: { kind: testCase.checker.kind, expected: cloneValue(testCase.checker.expected) },
    forbidden: [...testCase.forbidden],
    criteria: testCase.criteria.map(criterion => ({ ...criterion })),
  }))
}

/**
 * Score supplied answers against a pack, in the exact trial shape the core consumes.
 *
 * Pure and offline: it takes raw answers someone else produced and never calls a model, reads a
 * store or accepts a caller's `passed`/`tokens`. `answers[caseId]` may be
 *   - a string — the candidate arm's answer, when no baseline arm was run, or
 *   - `{ baseline?, candidate?, truncated? }` — both arms' raw outputs, where `truncated: true`
 *     states that a side was cut off mid-answer by the caller's own output cap.
 *
 * Both arms go through {@link scoreOutput}, so `checker`, `forbidden` and the output guards mean
 * exactly what they mean everywhere else. A truncated side makes the pair unusable evidence:
 * `guardPassed: false`, just as `scoreOutput` reports for a cut-off answer. A side that was never
 * supplied is not quietly excused either — an absent answer scores as an empty one, whose own guard
 * is already false — which is why a call with no answers at all returns rows the core refuses to
 * promote instead of rows that merely look like failures.
 */
export function packTrials(packId, { answers, usage } = {}) {
  const pack = getDomainPack(packId)
  if (pack === undefined) return []
  const given = isPlainObject(answers) ? answers : {}
  const spent = isPlainObject(usage) ? usage : {}
  /** One arm's real token spend, or null when the provider never reported one. */
  const tokensOf = (caseId, arm) => {
    const row = spent[caseId]
    const value = isPlainObject(row) ? row[arm] : undefined
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  return pack.cases.map(testCase => {
    const entry = given[testCase.caseId]
    const arms = isPlainObject(entry) ? entry : { candidate: entry }
    const truncated = arms.truncated === true
    const baseline = scoreOutput(testCase, arms.baseline, { truncated })
    const candidate = scoreOutput(testCase, arms.candidate, { truncated })
    const baselineTokens = tokensOf(testCase.caseId, 'baseline')
    const candidateTokens = tokensOf(testCase.caseId, 'candidate')
    // Unknown usage stays `null` — the shape the assessment already counts as an unknown-cost pair.
    // A fixed 0 would have claimed a measurement nobody took, and would have made the cost gate
    // compare the candidate against a fabricated baseline.
    return { caseId: testCase.caseId, family: testCase.family, split: testCase.split,
      baseline: { passed: baseline.passed, tokens: baselineTokens },
      candidate: { passed: candidate.passed, tokens: candidateTokens },
      guardPassed: baseline.guardPassed && candidate.guardPassed }
  })
}

/** Rebuild a value with object keys sorted at every depth, arrays left in their declared order. */
const canonicalize = value => Array.isArray(value) ? value.map(canonicalize)
  : isPlainObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
    : value

/** Deterministic JSON: sorted keys everywhere, so key order or formatting cannot move a hash. */
const canonicalJson = value => JSON.stringify(canonicalize(value))

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex')

/**
 * Hash of the pack's review criteria, bound to the pack version.
 *
 * A review plan freezes this so a criterion cannot be restated after the fact: the statements are
 * the pack's, and a changed statement is a different hash. Unregistered ids return `null` — never a
 * hash of something adjacent, which would look like a frozen criterion that was never registered.
 */
export function packCriteriaHash(packId) {
  const pack = getDomainPack(packId)
  if (pack === undefined) return null
  return sha256(canonicalJson({ packId: pack.packId, version: pack.version,
    criteria: pack.cases.map(testCase => ({ caseId: testCase.caseId, criteria: testCase.criteria })) }))
}

/**
 * Hash of one case's scoreable scenario: task, oracle and exclusions, plus the pack version it
 * belongs to.
 *
 * The criteria are hashed separately on purpose — the scenario is what a candidate is asked and
 * scored on, while the criteria describe how a reviewer reads that same case. Unregistered pack or
 * case ids return `null`.
 */
export function packScenarioHash(packId, caseId) {
  const pack = getDomainPack(packId)
  if (pack === undefined) return null
  const testCase = pack.cases.find(row => row.caseId === caseId)
  if (testCase === undefined) return null
  return sha256(canonicalJson({ packId: pack.packId, version: pack.version, caseId: testCase.caseId,
    family: testCase.family, split: testCase.split, prompt: testCase.prompt,
    checker: testCase.checker, forbidden: testCase.forbidden }))
}
