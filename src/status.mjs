/**
 * User-visible recall status. Pure formatting only: these strings are returned to
 * the caller that displays them (the `/mse` command, the SDK, the CLI) and are
 * never added to the model conversation, so a status can be shown without
 * consuming the bounded recall budget it describes.
 */
import { RECALL_REASONS } from './index.mjs'

/** Skip labels for an internal-task turn; the text envelope is a heuristic, not a source. */
const SKIP_LABELS = Object.freeze({
  internal_review_text: '内部复盘句（启发式前缀，不是可信来源）',
  internal_review_metadata: '内部复盘元数据',
  nested_or_later_step: '子代理、非首步或内部元数据',
})

export const REASON_LABELS = Object.freeze({
  [RECALL_REASONS.recalled]: '已召回',
  [RECALL_REASONS.notLearned]: '未学到',
  [RECALL_REASONS.scopeMismatch]: '作用域不符',
  [RECALL_REASONS.matchInsufficient]: '匹配不足',
  [RECALL_REASONS.methodUnvalidated]: '方法未验证',
  [RECALL_REASONS.alreadyOffered]: '已提供过',
  [RECALL_REASONS.budgetExhausted]: '预算不足',
  [RECALL_REASONS.internalTask]: '内部任务跳过',
  [RECALL_REASONS.storeFailure]: '存储失败',
  [RECALL_REASONS.correctionLearned]: '已学到本轮纠错',
  [RECALL_REASONS.conflictUnresolved]: '偏好冲突未解决（未落库，旧规则保持）',
  [RECALL_REASONS.turnClosed]: '本轮已结束',
  [RECALL_REASONS.filteredOrigin]: '非用户来源',
})

const GATE_LABELS = Object.freeze({
  no_overlap: '无共同主题词',
  weak_only: '只有通用动作词',
  no_topic_term: '缺主题词',
  single_term: '只有单一主题词',
  too_thin: '证据过薄',
  query_coverage: '用户任务主题覆盖不足',
  lesson_coverage: '经验主题覆盖不足',
})
const OUTCOME_LABELS = Object.freeze({ verified: '已验证', failed: '未通过宿主检查', unknown: '未获检查',
  cancelled: '已取消', adopted: '已采用', supported: '有支持', pending: '结果待结算' })

const label = table => value => table[value] ?? value ?? '未知'
const reasonLabel = label(REASON_LABELS)
const byId = values => [...new Set(values)].map(id => (id ?? '未知').replace(/^lesson_/u, '')).join('、')

function preview(text, limit) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

/**
 * Format one short status. `detail` adds the recall sources and the last turns.
 * @param report - `bridge.recallStatus()` result.
 * @param options - `{ detail, lessons }` optional lesson rows for source text.
 * @returns short multi-line status text bounded to a few hundred bytes.
 */
export function formatRecallStatus(report, { detail = false, lessons = [] } = {}) {
  const last = report?.last ?? null
  const library = report?.library ?? null
  const lines = ['MSE 学习状态（本地诊断，不进入模型上下文）']
  if (report?.enabled === false) lines.push('控制器已暂停：本轮不会注入任何经验（诊断仅作参考）。')
  if (!last) lines.push('本轮：暂无召回记录（尚未处理用户任务）')
  else {
    const outcome = last.outcome === undefined ? '' : ` → ${label(OUTCOME_LABELS)(last.outcome)}${
      last.attributed ? `（归因 ${last.attributed} 条）` : ''}`
    lines.push(`本轮 turn ${last.turn}：${reasonLabel(last.reason)} ${(last.lessons ?? []).length} 条 / ${last.bytes ?? 0} 字节`
      + `（${last.reason}）${outcome}`)
    if (last.reason === RECALL_REASONS.storeFailure && last.code) lines.push(`存储错误码：${last.code}`)
    if (last.settleError) lines.push(`结算未完成：${last.settleError}（结果待结算，不代表已成功）`)
    if (last.reason === RECALL_REASONS.internalTask && last.skipped) lines.push(`跳过依据：${label(SKIP_LABELS)(last.skipped)}`)
    if (last.reason === RECALL_REASONS.conflictUnresolved && last.diagnostics?.conflict) {
    lines.push(`偏好冲突：${last.diagnostics.conflict.topicKey}=${last.diagnostics.conflict.value} `
      + `与现有 ${last.diagnostics.conflict.existing.replace(/^lesson_/u, '')} 冲突；需明确替代，当前未写入。`)
  }
  if (last.reason === RECALL_REASONS.budgetExhausted && last.wouldInjectBytes === 0) {
      lines.push('预算不足：有匹配经验，但没有任何一条完整经验能放入本轮或本会话额度。')
    }
    const nearest = last.diagnostics?.nearest
    if (nearest) lines.push(`最近候选：${nearest.lessonId.replace(/^lesson_/u, '')}（${label(GATE_LABELS)(nearest.gate)}）`)
  }
  if (report?.libraryError) lines.push(`库不可读：${report.libraryError}`)
  else if (library) {
    lines.push(`库（${library.scopeKind === 'project' ? '本项目作用域' : '实例作用域'}）：纠错 ${library.library.activeCorrections} 条；`
      + `方法 ${library.library.methodsValidated} 已验证 / ${library.library.methodsUnvalidated} 未验证候选；`
      + `其他作用域 ${library.library.otherScope} 条、其他环境 ${library.library.otherEnvironment} 条、已失效 ${library.library.expired} 条`)
    if (library.session) lines.push(`会话预算：${library.session.bytes}/${library.session.budgetBytes} 字节已用；`
      + `单轮上限 ${library.budgetBytes} 字节 / ${library.maxLessons} 条`)
    else lines.push(`单轮上限 ${library.budgetBytes} 字节 / ${library.maxLessons} 条`)
  }
  lines.push('原因码：' + Object.values(RECALL_REASONS).map(reason => `${reason}（${reasonLabel(reason)}）`).join('、'))
  if (!detail) {
    lines.push('用 /mse why 查看来源与最近轮次。')
    return lines.join('\n')
  }
  const sources = last?.sources ?? []
  if (sources.length) {
    const text = new Map((lessons ?? []).map(row => [row.id, row.instruction]))
    lines.push('本轮来源：')
    for (const source of sources) lines.push(`- ${source.id.replace(/^lesson_/u, '')} v${source.version}`
      + `${source.kind ? `（${source.kind === 'correction' ? '纠错' : '方法'}）` : ''} ${source.bytes} 字节`
      + `${text.has(source.id) ? `：${preview(text.get(source.id), 80)}` : ''}`)
  }
  const recent = (report?.recent ?? []).slice(-8).reverse()
  if (recent.length) {
    lines.push('最近轮次：')
    for (const row of recent) lines.push(`- turn ${row.turn} ${reasonLabel(row.reason)}`
      + `${(row.lessons ?? []).length ? `：${byId(row.lessons)}` : ''} ${row.bytes ?? 0} 字节`
      + `${row.outcome === undefined ? '' : ` → ${label(OUTCOME_LABELS)(row.outcome)}`}`)
  }
  if (report?.reasons) lines.push(`协议原因码共 ${report.reasons.length} 项。`)
  return lines.join('\n')
}

/**
 * Format a dry-run diagnosis for a prompt that was never injected.
 * @param diagnosis - `bridge.diagnose()` / `engine.diagnose()` result.
 * @returns short status text.
 */
export function formatDiagnosis(diagnosis, { enabled = true } = {}) {
  if (!diagnosis || diagnosis.ok !== true) return `MSE 诊断不可用：${diagnosis?.code ?? '未知错误'}`
  const prompted = diagnosis.prompted
  if (!prompted) return 'MSE 诊断：未提供任务文本。'
  const lines = [enabled
    ? `MSE 只读诊断（不注入、不写库）：${reasonLabel(prompted.reason)}`
    : `MSE 只读诊断（控制器已暂停：本轮不会注入）：${reasonLabel(prompted.reason)}`,
    `作用域内经验 ${prompted.scopeLessons} 条：命中 ${prompted.matched}、已提供过 ${prompted.alreadyOffered}、`
    + `未验证方法 ${prompted.methodUnvalidated}、其他环境 ${prompted.otherEnvironment}、已失效 ${prompted.expired}、`
    + `其他作用域 ${prompted.otherScope}`]
  if (prompted.nearest) lines.push(`最近候选 ${prompted.nearest.lessonId.replace(/^lesson_/u, '')}：${label(GATE_LABELS)(prompted.nearest.gate)}`
    + `（共同主题词 ${prompted.nearest.matched}，其中对象词 ${prompted.nearest.matchedStrong}）`)
  lines.push(`本轮可用额度 ${prompted.budgetBytes} 字节；实际可注入 ${prompted.wouldInjectBytes ?? 0} 字节`
    + `${prompted.fitted ? `（${prompted.fitted} 条）` : '（0 条）'}`)
  if (prompted.queryTopics?.length) lines.push(`任务主题词：${prompted.queryTopics.join('、')}`)
  if (diagnosis.session) lines.push(`会话预算：${diagnosis.session.bytes}/${diagnosis.session.budgetBytes} 字节`)
  return lines.join('\n')
}

const COMMAND_USAGE = '用法：/mse 查看状态；/mse why 查看来源与最近轮次；/mse now <任务文本> 只读预演一次召回。'

/**
 * Command body of the plugin-owned `/mse` status command. Pure routing over the
 * read-only bridge surface: it never writes learning state, never injects
 * context, and never calls a model.
 * @param bridge - `createHarnessBridge()` instance.
 * @param rawInput - text after the command name.
 * @param target - invoking session: `{ sessionId, projectKey }`, or a bare session id.
 * @returns a CommandResult-shaped `{ kind, text }`.
 */
export function handleMseCommand(bridge, rawInput, target) {
  const raw = String(rawInput ?? '').trim()
  const { sessionId, projectKey } = typeof target === 'string' || target === undefined
    ? { sessionId: target, projectKey: undefined } : target
  try {
    const enabled = bridge.isEnabled?.() !== false
    if (raw === '' || raw === 'status') return { kind: 'success', text: formatRecallStatus(bridge.recallStatus(sessionId, projectKey)) }
    if (raw === 'why' || raw === 'detail') {
      return { kind: 'success', text: formatRecallStatus(bridge.recallStatus(sessionId, projectKey),
        { detail: true, lessons: bridge.listLessons(sessionId, projectKey) }) }
    }
    if (raw === 'now' || raw.startsWith('now ')) {
      const prompt = raw.slice(3).trim()
      if (!prompt) return { kind: 'error', text: `缺少任务文本。${COMMAND_USAGE}` }
      return { kind: 'success', text: formatDiagnosis(bridge.diagnose({ sessionId, projectKey, prompt }), { enabled }) }
    }
    return { kind: 'error', text: COMMAND_USAGE }
  } catch (error) {
    return { kind: 'error', text: `MSE 状态不可用：${error?.code ?? 'unknown_error'}` }
  }
}

/** Format a short status line for the host log, bounded to one line. */
export function formatRecallLine(report) {
  const last = report?.last
  if (!last) return 'recall=none'
  return `recall=${last.reason} lessons=${(last.lessons ?? []).length} bytes=${last.bytes ?? 0}`
}

export { GATE_LABELS }
