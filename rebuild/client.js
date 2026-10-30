/**
 * mse-learning (rebuilt) · 浏览器面板 —— 用户原设计（adapters/dsh/client.js 的布局、组件与交互）
 *
 * 视觉与结构按原实现恢复：宿主自己的设置组件（Button/Switch/SegmentedTabs/Input/Menu/StateDot/
 * 图标，来自平台静态模块表）、原 STYLE（同一字号/行高/16px 行距/0.5px 发丝分隔/折叠详情/窄屏
 * compact Picker 选项卡与 media query）、原 settingsTabNavigation 五页（常规、经验、召回、任务、
 * 学习状态）、原 row/disclosure/definition/metric/Picker 原语、原生状态点与刷新按钮。
 * 内部只接精简新引擎：状态经 `mseRebuildStatus`（网关 RemoteResult {ok,value} 套宿主业务
 * {ok:true,view}，两层都解，失败绝不显示假状态），暂停/审计重试经 `mseRebuildControl`，设置开关
 * 走真实 ConfigForm（getSnapshot/subscribe + mutate(ops, revision) 修订栅栏，失败可读回滚）。
 * 不恢复预算、配额、付费评测或旧评测链；打开任何页面都不发起模型请求。
 */
window.__ModuleLoader__.load({ id: '@missher/dsh-mse-learning', factory: (require) => {
  const React = require('react')
  // The host's own settings components, loaded from the platform's static module table — they
  // carry the real control sizes, radii, borders, hover/focus rings and light/dark tokens,
  // which is why this page needs no control styling of its own.
  const {
    Button, IconChevronRightOutlineRegular, IconChevronsUpDownOutlineRegular, Input, Menu,
    SegmentedTabs, StateDot, Switch,
  } = require('@deepseek-ai/dsh-client-ui-primitives')
  const h = React.createElement
  const NS = 'mse-learning'
  const BUNDLE = '@missher/dsh-mse-learning'
  const SETTINGS_ID = 'mse-learning'
  const TABS = ['overview', 'lessons', 'recall', 'tasks', 'usage']
  const tabLabel = (id, dict) => id === 'overview' ? dict.tabOverview : id === 'lessons' ? dict.tabLessons
    : id === 'recall' ? dict.tabRecall : id === 'tasks' ? dict.tabTasks : dict.tabUsage

  // rc.4 $mount takes a FULL contribution {package, descriptors}; these mirror the package's
  // Host typert manifest (rebuild/typert.mjs) — the same methods the real gateway reflects.
  const passthrough = () => ({ parse: value => value })
  const descriptor = (service, method, requestType, resultType) => ({
    id: `${BUNDLE}#${service}/${method}`, service, namespace: service, method,
    invocation: { kind: 'direct' },
    parameters: [{ name: 'input', wire: 'input', source: 'json', acceptsUndefined: true,
      codec: { mode: 'strict', typeSymbol: `${BUNDLE}/types#${requestType}`, create: passthrough } }],
    result: { mode: 'strict', typeSymbol: `${BUNDLE}/types#${resultType}`, create: passthrough },
    sourceLocation: { file: 'rebuild/remote.mjs', line: 1, column: 1 },
  })
  const STATUS_CONTRIB = { package: BUNDLE,
    descriptors: ['status'].map(method => descriptor('mseRebuildStatus', method,
      'MseRebuildStatusRequest', 'MseRebuildStatusView')) }
  // A second contribution MUST carry a different package label; the label is local identity.
  const CONTROL_CONTRIB = { package: `${BUNDLE}-control`,
    descriptors: ['pause', 'retryRequest', 'runCheck'].map(method => descriptor('mseRebuildControl', method,
      'MseRebuildControlRequest', 'MseRebuildControlResult')) }

  const zh = {
    settingsTitle: '自我进化',
    tabOverview: '常规', tabLessons: '经验', tabRecall: '召回', tabTasks: '任务', tabUsage: '学习状态',
    refresh: '刷新', refreshing: '读取中…', loading: '读取中…',
    statusUnreadable: '状态不可读', loadFailed: '读取失败',
    effectiveRunning: '运行中', effectivePaused: '已暂停',
    learning: '学习开关', learningHint: '关闭后只记录事实，不再产生新的反思、每日总结或纠正提取。',
    enabledOn: '已开启', enabledOff: '已关闭',
    pauseControl: '后台暂停', pauseHint: '暂停只停止后台任务；前台记录与已存经验照常注入。',
    pause: '暂停', resume: '恢复',
    settingsSaveFailed: '设置未保存，已重新读取真实状态。',
    wakeInterval: '空闲触发间隔（毫秒）', wakeSave: '保存',
    dailySection: '最近每日总结', dailyHint: '本地 23:00 后空闲自动汇总，一天一次；空白日跳过；停机积压与晚到事实在后续空闲逐个补做。',
    moreSection: '更多信息',
    moreHowTitle: '工作原理', moreHow: '前台只记录可信用户消息与真实工具结果；反思、修订、每日总结和纠正提取都在空闲后台槽运行，打开本页不发起模型请求。',
    moreSaveTitle: '普通纠正何时保存', moreSave: '明确表达长期意图且非临时任务要求的纠正才直接长期保存；普通纠正先入持久审计队列，再经提取门做原话核对、否定保留与范围核对，确认可复用才长期保存——「别再」不是无条件全局保存；一次性调整和不确定的只留回合事实，忽略原因可读，不会伪装成已保存。',
    moreScopeTitle: '作用范围', moreScope: '全局经验跨项目注入；带「仅本项目/仓库/文件」条件的规则只在本项目注入，不会外泄。',
    moreCheckTitle: '检查边界', moreCheck: '只跑本次改动影响的检查，不重复运行已经通过的测试；未知费用的调用不会自动重发。',
    entriesSection: '记住的规则与经验', entriesHint: '用户明确纠错立即长期保存；真实失败经验在两次独立同类观察后形成，仍须具体证据。长期规则不机械过期。',
    filterType: '类型', filterStatus: '状态', allOption: '全部',
    typeRule: '用户规则', typeLesson: '失败经验', typeDigest: '每日总结',
    statusActive: '生效', statusSuperseded: '已被新版取代',
    version: '版本', scope: '范围', scopeGlobal: '全局', scopeScoped: '仅本项目',
    fixSteps: '修复步骤', checkMethod: '检查办法', injectedCount: '注入', recurrenceCount: '复发',
    evidenceHash: '证据指纹', updatedAt: '更新于', applicabilityLine: '适用情形',
    recallSection: '注入记录', recallHint: '每次注入都有凭据：提供了哪些经验的哪个版本，以及回合结局。',
    offeredVersions: '提供版本', outcomeUnknown: '未判定', outcomeCompleted: '完成', outcomeAborted: '中止',
    outcomeVerified: '检查通过', outcomeFailed: '存在失败', outcomeCancelled: '已取消',
    settledYes: '已结算', settledNo: '在途', historicalEntry: '历史经验', fullId: '完整标识',
    summaryLabel: '摘要', fullText: '完整原文', requestLabel: '请求标识', rawCode: '原始结果码',
    tasksSection: '后台请求', tasksHint: '反思、修订、每日总结与纠正提取共用同一个在途槽；一次已知费用的输出截断最多有一次有界自动重试，未知费用与其它失败都不会自动重发，可发起人工审计重试。',
    inFlightNow: '在途', waitReasonLine: '等待原因', unknownCostHeld: '未知费用保留',
    taskKindReflect: '反思', taskKindRevise: '修订', taskKindDigest: '每日总结', taskKindExtract: '纠正提取',
    taskStatusSettled: '已结算', taskStatusRunning: '在途',
    usageTokens: '已知 tokens', usageCalls: '调用', usageUnknownCost: '未知费用',
    usageTotalRequests: '请求总数', usageSettled: '已结算',
    usageAuditSection: '调用用量（近 24 小时）', usageAuditNote: '按类型统计真实调用与 tokens；未测量的调用不计入 0。',
    correctionsSection: '纠正提取',
    collectionSection: '采集范围', collectionScopeTitle: '工作区与跳过原因（只读）',
    collectionWorkspaces: '注册工作区', collectionSkipped: '最近跳过', collectionNone: '无跳过记录',
    collectionUnknown: '未知', revisionsSection: '最近规则变更', revisionRetired: '停用',
    revisionNone: '暂无规则变更',
    correctionsShort: '可复用的纠正会在空闲时整理为长期规则。',
    correctionsFullTitle: '保存规则说明',
    correctionsFull: '明确表达长期意图且非临时任务要求的纠正才直接长期保存；普通纠正先入持久审计队列，再经提取门做原话核对、否定保留与范围核对，确认可复用才长期保存——「别再」不是无条件全局保存；一次性调整和不确定的只留回合事实，忽略原因可读，不会伪装成已保存。',
    saved: '已保存', pendingCorr: '待处理', dispatchedCorr: '提取中', ignoredReasons: '忽略原因',
    existingSection: '现存经验', existingCount: '现存规则与经验', existingInjected: '注入合计',
    existingRecurrences: '复发合计', existingScopeNote: '按当前现存经验统计，不是全历史总量。',
    goLessons: '查看经验列表',
    auditedRetry: '审计重试', auditedRetryHint: '对已核对的失败材料发起一次人工重试；绝不自动重发。',
    noEntries: '暂无经验。', noRecall: '暂无注入记录。', noTasks: '暂无后台请求。',
    lastSummaryLine: '总结', dailyState: '每日状态', lastDoneDay: '最后完成日', backlogDays: '待补日',
    dailyPartialLine: '部分完成（未核验来源的事实已安全排除）', dailyExcludedLine: '排除',
    nextStepLabel: '下一步', outputBytesLabel: '输出字节', finishKindLabel: '终止原因',
    verdictLabel: '输出诊断',
    reasoningSpace: '生成达到上限、未收到正文（可能用于推理）',
    daysProcessed: '已处理日', none: '无',
  }
  const TYPE_ZH = { rule: zh.typeRule, lesson: zh.typeLesson, digest: zh.typeDigest }
  const STATUS_ZH = { user_rule: zh.statusActive, pending: '待验证', check_passed: zh.statusActive,
    needs_revision: '需修订', superseded: zh.statusSuperseded }
  const REASON_ZH = { no_correction: '不是可复用纠正', one_off: '一次性调整，不升级为长期规则',
    uncertain: '不确定，不强行升级', generic_advice: '通用空话被拒绝',
    negation_or_scope_dropped: '否定或项目条件被改写，已拒绝', evidence_not_verbatim: '证据非原话，已拒绝',
    invalid_result: '输出不符合契约，已拒绝', duplicate: '重复，未再存',
    unknown_cost: '未知费用，已保留记录且不自动重发', extract_invalid: '输出不符合契约，已拒绝',
    session_unattributed: '会话未登记到注册工作区，未采集',
    registry_unavailable: '工作区注册表暂不可用，未采集',
    turn_material_outside: '本轮材料引用外部文件，未采集',
    material_outside_reference: '材料引用外部文件，未入队',
    tool_material_outside: '工具材料涉及外部路径，未采集',
    tool_output_outside: '失败输出涉及外部路径，未采集',
    source_unverified: '旧材料来源未能确认，不再发送',
    material_unverified: '旧材料涉及外部文件，不再发送',
    immediate_rule_rejected: '不符合即时入库的既有校验（过长/含敏感形态），未即时保存',
    candidate_rejected: '纠正审计写入被既有字段边界拒绝（已按 UTF-16 单位裁剪；仍未入库）',
    store_unavailable: '学习库暂时不可读写（已跳过本次审计写入，不影响当前步骤）',
    turn_facts_rejected: '回合事实写入被既有字段边界拒绝，不影响当前回合',
    temp_workspace_excluded: '临时工作区未采集',
    user_correction: '用户纠正停用' }
  const WAIT_ZH = { paused: '已暂停', in_flight: '已有一次后台复盘在进行', busy: '前台任务进行中，稍后再试',
    done_today: '今天已总结', no_activity: '空白日已跳过', no_route: '还没有可用的模型路由',
    digest_sources_unverified: '当日事实来源无法核验，已安全跳过',
    digest_facts_filtered: '部分事实来源未核验，已安全跳过',
    source_unproven: '证据没有可证来源，安全等待',
    digest_ledger_full: '日账身份容量已满，诚实等待',
    reflection_truncation_exhausted: '输出截断且唯一重试已用尽，需新证据或人工审计',
    reflection_compaction_exhausted: '字段超限且唯一压缩重试已用尽，需新证据或人工审计',
    no_source_route: '来源会话没有可用路线', same_material_needs_audited_retry: '同一材料需人工审计重试',
    unknown_cost_never_auto_replayed: '一次未知费用的调用已保留记录，不会自动重发',
    background_error_invalid_memory: '后台记录未通过校验，请查看诊断记录',
    background_error_unexpected: '后台学习暂时异常，请查看诊断记录', null: '—' }
  // MSE21: a REAL next step for a settled task (never a fake dash / generic failure).
  const NEXT_ZH = { in_flight: '调用中', retry_pending: '已知费用，待唯一重试',
    exhausted_needs_evidence: '已用尽，需新证据或人工审计', unknown_cost_hold: '未知费用持有，不会自动重放' }
  const OUTCOME_ZH = { completed: zh.outcomeCompleted, aborted: zh.outcomeAborted,
    verified: zh.outcomeVerified, failed: zh.outcomeFailed, cancelled: zh.outcomeCancelled,
    unknown: zh.outcomeUnknown }
  // Chinese reads first; the original code stays in parentheses for tracing.
  const TERMINAL_ZH = { saved: '已保存', committed: '已入库', linked: '已关联', skipped: '已跳过',
    truncated: '输出截断', output_too_large: '输出过长', attempt_aborted: '尝试中止',
    invalid_result: '输出不符合契约', model_unparseable: '输出无法解析', connection_reset: '连接中断',
    timeout: '超时', paused: '已暂停', aborted: '已中止', audit_retry_accepted: '审计重试已受理',
    same_material_needs_audited_retry: '同一材料需人工审计重试', unknown_cost: '未知费用，已保留',
    invalid_lesson: '经验不符合契约', needs_compaction: '文本超限', not_grounded_evidence: '内容与证据脱节',
    problem_not_reflectable: '问题不可反思', revision_already_attempted: '该证据已尝试过',
    reflection_interrupted: '反思被中断', attempt_in_flight: '已有尝试在途',
    not_reviseable: '不可修订', no_digest: '当日无内容', failed: '失败',
    model_failed: '模型调用失败' }
  const terminalZh = code => code === null || code === undefined ? null
    : TERMINAL_ZH[code] ? `${TERMINAL_ZH[code]}（${code}）` : code
  // Success/normal endings NEVER get a retry button; unknown cost never gets one either.
  const OK_TERMINALS = new Set(['saved', 'committed', 'linked', 'skipped', 'audit_retry_accepted'])
  const summaryText = (text, max = 96) => {
    const one = String(text ?? '').replace(/\s+/gu, ' ').trim()
    return one.length <= max ? one : `${one.slice(0, max)}…`
  }
  const minutesHint = ms => Number.isSafeInteger(ms) && ms > 0 ? `约 ${Math.round(ms / 60_000)} 分钟` : ''
  const atText = at => Number.isFinite(at) ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '—'

  // The original STYLE (adapters/dsh/client.js), general parts verbatim: same fonts, hairlines,
  // row rhythm, disclosures, pickers and the narrow-screen media query. Only the removed
  // budget/evaluation rules are gone; nothing here is new visual design.
  const STYLE = `
.mse-details{display:flex;flex-direction:column;width:100%;min-width:0;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.mse-details *{box-sizing:border-box}
.mse-details p{margin:0}
.mse-details .mse-heading{display:flex;align-items:center;gap:10px;margin-bottom:20px;flex-wrap:wrap;min-width:0}
.mse-details h1{margin:0;font-size:16px;line-height:24px;font-weight:500}
.mse-details .mse-status{font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;gap:6px;min-width:0}
.mse-details .mse-heading-action{margin-left:auto}
.mse-details .mse-pane{display:flex;flex-direction:column;min-width:0}
.mse-details .mse-row{display:flex;gap:20px;align-items:center;padding:16px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2);min-width:0}
.mse-details .mse-row-top{align-items:flex-start}
.mse-details .mse-row-stacked{display:block}
.mse-details .mse-row-stacked .mse-row-side{display:flex;flex:initial;width:100%;justify-content:flex-start;flex-wrap:wrap;gap:8px 18px;max-width:100%;margin-top:8px;white-space:normal;overflow-wrap:anywhere}
.mse-details .mse-row:last-child{border-bottom:none}
.mse-details .mse-row-main{flex:1;min-width:0}
.mse-details .mse-row-title{font-weight:400;line-height:22px;overflow-wrap:anywhere}
.mse-details .mse-hint{font-size:13px;color:var(--dsw-alias-label-secondary);line-height:22px;margin-top:4px;overflow-wrap:anywhere}
.mse-details .mse-row-side{flex:none;min-width:0;display:flex;align-items:center;justify-content:flex-end;gap:8px;font-size:13px}
.mse-details .mse-unit{color:var(--dsw-alias-label-tertiary);font-size:12px}
.mse-details .mse-section-title{margin:24px 0 8px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);font-weight:500;display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.mse-details .mse-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;padding:16px 0 20px;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.mse-details .mse-metrics>div{padding:12px 14px;background:var(--dsw-alias-bg-module-platform);border-radius:8px;min-width:0;overflow-wrap:anywhere}
.mse-details .mse-metrics-2{grid-template-columns:repeat(2,minmax(0,1fr))}
.mse-details .mse-statline{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding:10px 0;font-size:13px;line-height:22px}
.mse-details .mse-statline b{font-size:14px;font-weight:500;font-variant-numeric:tabular-nums}
.mse-details .mse-metric-label{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:5px}
.mse-details .mse-metric-value{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.mse-details .mse-metric-value b{font-size:20px;line-height:28px;font-weight:500;font-variant-numeric:tabular-nums}
.mse-details .mse-metric-value span{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.mse-details .mse-disclosure{border-bottom:0.5px solid var(--dsw-alias-border-l2);min-width:0}
.mse-details .mse-disclosure>summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;padding:16px 0;font-size:14px;line-height:22px}
.mse-details .mse-summary{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.mse-details .mse-meta{flex:none;display:inline-flex;gap:10px;align-items:center;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:normal;flex-wrap:wrap;justify-content:flex-end}
.mse-details .mse-summary-stack{display:flex;flex-direction:column;gap:4px;align-items:flex-start}
.mse-details .mse-summary-stack .mse-summary-line{font-size:14px;line-height:22px}
.mse-details .mse-summary-stack .mse-meta{justify-content:flex-start;width:100%}
.mse-details .mse-meta>span{white-space:nowrap}
.mse-details .mse-detail-text{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);margin-bottom:12px;overflow-wrap:anywhere;white-space:pre-line}
.mse-details .mse-disclosure>summary::-webkit-details-marker{display:none}
.mse-details .mse-chevron{transition:transform 150ms;width:14px;height:14px;flex:none;color:var(--dsw-alias-label-tertiary)}
.mse-details .mse-disclosure[open]>summary .mse-chevron{transform:rotate(90deg)}
.mse-details .mse-detail-body{padding:0 0 16px;min-width:0}
.mse-details .mse-definition{display:grid;grid-template-columns:minmax(90px,auto) minmax(0,1fr);gap:10px 20px;margin:0;font-size:12px;line-height:20px}
.mse-details .mse-definition dt{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.mse-details .mse-definition dd{margin:0;text-align:right;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.mse-details .mse-definition.mse-left dd{text-align:left}
.mse-details .mse-picker{display:inline-flex;flex:none;min-width:0;max-width:100%}
.mse-details .mse-picker-trigger{max-width:100%;justify-content:space-between;gap:8px}
.mse-details .mse-picker-label{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;text-align:left}
.mse-details .mse-picker-chevrons{flex:none;color:var(--dsw-alias-label-tertiary)}
.mse-details .mse-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:20px;overflow-wrap:anywhere}
.mse-details .mse-notice{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;min-height:20px;overflow-wrap:anywhere}
.mse-details .mse-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}
@media(max-width:620px){
.mse-details .mse-row{gap:12px}
.mse-details .mse-metrics{gap:8px}
.mse-details .mse-metrics>div{padding:10px}
.mse-details .mse-disclosure>summary{flex-wrap:wrap;gap:8px}
.mse-details .mse-summary{flex-basis:calc(100% - 26px)}
.mse-details .mse-meta{order:3;justify-content:flex-start;flex:1 1 100%}
.mse-details .mse-definition{grid-template-columns:minmax(70px,auto) minmax(0,1fr);gap:8px 12px}
}
`

  /** The page's shared primitives — the confirmed design's own shapes (original client). */
  const row = (key, title, hint, side, options = {}) => h('div', { key,
    className: `mse-row${options.top === true ? ' mse-row-top' : ''}${options.stacked === true ? ' mse-row-stacked' : ''}`
      + (typeof options.className === 'string' && options.className !== '' ? ` ${options.className}` : '') }, [
    h('div', { key: 'main', className: 'mse-row-main' }, [
      typeof title === 'string' ? h('div', { key: 't', className: 'mse-row-title' }, title) : title,
      hint === null || hint === undefined ? null : h('p', { key: 'h', className: 'mse-hint' }, hint),
    ]),
    side === null || side === undefined ? null : h('div', { key: 'side', className: 'mse-row-side' },
      Array.isArray(side) ? side.filter(node => node !== null && node !== undefined) : [side]),
  ])
  const disclosure = (key, title, body, options = {}) => h('details', { key, className: 'mse-disclosure',
    'data-mse-disclosure': options.id, open: options.open === true,
    ...(typeof options.onToggle === 'function'
      ? { onToggle: e => options.onToggle(e?.currentTarget?.open === true || e?.target?.open === true) }
      : {}) },
  h('summary', { key: 's' }, [h('span', { key: 't',
    className: `mse-summary${options.stackMeta === true ? ' mse-summary-stack' : ''}` },
  options.stackMeta === true ? [h('span', { key: 'x', className: 'mse-summary-line' }, title),
    options.meta === null || options.meta === undefined ? null : h('span', { key: 'm', className: 'mse-meta' },
      (Array.isArray(options.meta) ? options.meta.filter(Boolean) : [options.meta])
        .map((label, index) => h('span', { key: index }, label)))] : title),
    // MSE17: when the meta line is STACKED under the summary title (experiences page), it must
    // not ALSO render on the right of the summary — it drew twice and squeezed the summary.
    // Right-side meta stays for every non-stacked disclosure; the native chevron is untouched.
    options.stackMeta === true || options.meta === null || options.meta === undefined ? null : h('span', { key: 'm', className: 'mse-meta' },
      (Array.isArray(options.meta) ? options.meta.filter(Boolean) : [options.meta])
        .map((label, index) => h('span', { key: index }, label))),
    h(IconChevronRightOutlineRegular, { key: 'c', className: 'mse-chevron' })]),
  h('div', { key: 'b', className: 'mse-detail-body' }, body))
  const definition = (key, rows, options = {}) => h('dl', { key,
    className: `mse-definition${options.left === true ? ' mse-left' : ''}` },
  rows.filter(Boolean).flatMap(([label, value], index) => [
    h('dt', { key: `t${index}` }, label),
    h('dd', { key: `d${index}` }, value),
  ]))
  const metric = (label, value, unit) => h('div', { key: label }, [
    h('div', { key: 'l', className: 'mse-metric-label' }, label),
    h('div', { key: 'v', className: 'mse-metric-value' }, [h('b', { key: 'b' }, String(value)),
      unit ? h('span', { key: 'u' }, unit) : null]),
  ])

  function Picker({ label, value, options, onChange, disabled = false, testId = undefined, className = '',
    prefix = null, triggerProps = {} }) {
    const [open, setOpen] = React.useState(false)
    const selected = options.find(option => option.id === value) ?? options[0]
    const items = options.map(option => ({ id: option.id === '' ? '__default' : option.id, label: option.label }))
    return h(Menu, {
      open, portal: true, compact: true, className: `mse-picker ${className}`.trim(),
      'data-mse-picker': testId,
      anchor: h(Button, { ...triggerProps, variant: 'outline', size: 'sm', disabled, className: 'mse-picker-trigger',
        'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-label': label,
        onClick: () => setOpen(current => !current) }, [
        h('span', { key: 'l', className: 'mse-picker-label',
          title: prefix === null ? (selected?.label ?? label) : `${prefix}：${selected?.label ?? label}` },
        prefix === null ? (selected?.label ?? label) : `${prefix}：${selected?.label ?? label}`),
        h(IconChevronsUpDownOutlineRegular, { key: 'c', className: 'mse-picker-chevrons' }),
      ]),
      items,
      selectedId: value === '' ? '__default' : value,
      onSelect: id => { onChange(id === '__default' ? '' : id); setOpen(false) },
      onClose: () => setOpen(false),
    })
  }

  function settingsTabNavigation(tab, onChange, dict, compact) {
    if (compact) return h('div', { role: 'tablist', 'aria-label': dict.settingsTitle },
      h(Picker, { label: tabLabel(tab, dict), value: tab,
        options: TABS.map(id => ({ id, label: tabLabel(id, dict) })), onChange,
        testId: 'settings-tabs-compact', className: 'mse-picker-wide',
        triggerProps: { id: `mse-tab-${tab}`, role: 'tab', 'aria-selected': true,
          'aria-controls': `mse-pane-${tab}` } }))
    return h(SegmentedTabs, { label: dict.settingsTitle, value: tab, onChange,
      items: TABS.map(id => ({ value: id, id: `mse-tab-${id}`, panelId: `mse-pane-${id}`,
        label: tabLabel(id, dict) })) })
  }

  /**
   * Two envelopes, both REAL, never assumed: the gateway RemoteResult {ok, value} wraps the
   * HOST business result {ok:true,…} / {ok:false, code}. A failure at either layer is a
   * labelled failure — the page never paints made-up state over it.
   */
  async function callRemote(call, method, input) {
    const result = await call(method, input ?? {})
    if (result === undefined || result === null) throw new Error('empty_result')
    if (result.ok !== true) throw new Error(String(result.code ?? result.error?.code ?? 'remote_failed'))
    const business = result.value
    if (business === undefined || business === null) throw new Error('empty_result')
    if (business.ok !== true) throw new Error(String(business.code ?? 'host_failed'))
    return business
  }

  function useFormSnapshot(form) {
    const [snapshot, setSnapshot] = React.useState(() => form === undefined ? null : form.getSnapshot())
    React.useEffect(() => {
      if (form === undefined) return undefined
      setSnapshot(form.getSnapshot())
      return form.subscribe(() => setSnapshot(form.getSnapshot()))
    }, [form])
    return snapshot
  }

  const KIND_ZH = { reflect: zh.taskKindReflect, revise: zh.taskKindRevise, digest: zh.taskKindDigest,
    extract: zh.taskKindExtract }

  function MsePanel(props) {
    const locale = typeof props.useLocale === 'function'
      ? props.useLocale(snapshot => snapshot.active) : props.locale
    const dict = locale === 'en' ? { ...zh, settingsTitle: 'Self-evolution' } : zh
    const call = props.call
    const control = props.control
    const form = props.form
    const [tab, setTab] = React.useState(props.initialTab ?? 'overview')
    const [compactTabs, setCompactTabs] = React.useState(false)
    const tabsHost = React.useRef(null)
    const [reloadToken, setReloadToken] = React.useState(0)
    const [filter, setFilter] = React.useState({ type: '', status: '' })
    const [openEntry, setOpenEntry] = React.useState(null)
    const [shell, setShell] = React.useState({ status: 'idle', value: null, error: null })
    // Three-state like the original: "we could not read it" is NOT "it is running".
    const [controlState, setControlState] = React.useState({ status: 'unknown', paused: null })
    const [wakeDraft, setWakeDraft] = React.useState('')
    const [saveState, setSaveState] = React.useState(null)
    const generation = React.useRef(0)
    const formSnapshot = useFormSnapshot(form)

    React.useEffect(() => {
      const node = tabsHost.current
      if (node === null || node === undefined) return undefined
      const update = () => setCompactTabs(node.getBoundingClientRect().width < 340)
      update()
      if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(update)
        observer.observe(node)
        return () => observer.disconnect()
      }
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }, [])

    React.useEffect(() => {
      const mine = generation.current + 1
      generation.current = mine
      setShell(current => ({ ...current, status: current.value === null ? 'loading' : current.status }))
      void (async () => {
        try {
          const business = await callRemote(call, 'status')
          if (generation.current !== mine) return
          setShell({ status: 'ready', value: business.view ?? null, error: null })
          setControlState({ status: 'ready', paused: business.view?.paused === true })
        } catch (error) {
          if (generation.current !== mine) return
          setShell({ status: 'error', value: null, error: String(error?.message ?? error) })
        }
      })()
    }, [call, reloadToken])

    // Settings writes go through the REAL ConfigForm with its revision fence: one atomic
    // mutate(ops, revision); a refusal re-reads the truth instead of faking the switch.
    const mutateSetting = async (path, value) => {
      const snapshot = form?.getSnapshot?.() ?? null
      if (form === undefined || form === null || snapshot === null || snapshot.status !== 'ready') {
        setSaveState({ kind: 'error', detail: dict.settingsSaveFailed })
        return
      }
      try {
        const ok = await form.mutate([{ op: 'set', path: [path], value }], snapshot.revision)
        if (ok !== true) throw new Error('refused')
        setSaveState(null)
      } catch {
        setSaveState({ kind: 'error', detail: dict.settingsSaveFailed })
        setReloadToken(current => current + 1) // show the host's truth, never a fake flip
      }
    }
    const enabled = formSnapshot?.status === 'ready'
      ? formSnapshot.value?.enabled !== false : true

    const togglePause = async () => {
      const next = !(controlState.paused === true)
      try {
        await callRemote(control, 'pause', { paused: next })
        setControlState({ status: 'ready', paused: next })
        setSaveState(null)
      } catch (error) {
        setSaveState({ kind: 'error', detail: `${dict.settingsSaveFailed}（${String(error?.message ?? error)}）` })
        setReloadToken(current => current + 1) // the truth comes from the host re-read
      }
    }
    const saveWake = async () => {
      const parsed = Number(String(wakeDraft).trim())
      if (!Number.isSafeInteger(parsed) || parsed < 60_000 || parsed > 3_600_000) {
        setSaveState({ kind: 'error', detail: `${dict.wakeInterval} 60000–3600000` })
        return
      }
      await mutateSetting('wakeIntervalMs', parsed)
    }
    const auditedRetry = async ticket => {
      try { await callRemote(control, 'retryRequest', { ticket }) }
      catch (error) { setSaveState({ kind: 'error', detail: String(error?.message ?? error) }) }
      setReloadToken(current => current + 1)
    }

    const view = shell.status === 'ready' ? shell.value : null
    const state = shell.status === 'error' ? 'error' : shell.status === 'idle' ? 'loading' : 'ready'

    // ── 常规 ──────────────────────────────────────────────────────────────────────────────
    const overviewPanel = h(React.Fragment, { key: 'overview' }, [
      h('div', { key: 'm', className: 'mse-metrics mse-metrics-2' }, [
        metric(dict.pauseControl, controlState.paused === null ? '—'
          : controlState.paused === true ? dict.effectivePaused : dict.effectiveRunning),
        metric(dict.lastDoneDay, view?.daily?.lastDoneDay ?? '—'),
      ]),
      row('enabled', dict.learning, dict.learningHint,
        h(Switch, { key: 'sw', checked: enabled, onChange: next => void mutateSetting('enabled', next) })),
      row('pause', dict.pauseControl, dict.pauseHint,
        h(Button, { key: 'b', variant: 'outline', size: 'sm', onClick: togglePause },
          controlState.paused === true ? dict.resume : dict.pause)),
      row('wake', dict.wakeInterval,
        formSnapshot?.status === 'ready'
          ? `当前 ${formSnapshot.value?.wakeIntervalMs ?? '—'}`
            + (formSnapshot.value?.wakeIntervalMs ? `（${minutesHint(formSnapshot.value.wakeIntervalMs)}）` : '')
          : null,
        [h(Input, { key: 'i', value: wakeDraft, placeholder: '600000', onChange: setWakeDraft }),
          h(Button, { key: 'b', variant: 'outline', size: 'sm', onClick: saveWake }, dict.wakeSave)]),
      saveState?.kind === 'error' ? h('p', { key: 'err', className: 'mse-error' }, saveState.detail) : null,
      h('div', { key: 'sec', className: 'mse-section-title' }, dict.dailySection),
      h('p', { key: 'dh', className: 'mse-hint' }, dict.dailyHint),
      view === null ? null : row('daily',
        `${dict.waitReasonLine}：${WAIT_ZH[view.daily?.waitReason ?? null] ?? view.daily?.waitReason ?? '—'}`,
        `${dict.backlogDays}：${(view.daily?.backlog ?? []).length === 0 ? dict.none : (view.daily.backlog ?? []).join('、')}`,
        null, { stacked: true }),
      (view?.daily?.daysProcessed ?? []).some(row => row.partial)
        ? h('p', { key: 'dph', className: 'mse-hint' },
          `${dict.dailyPartialLine}：` + view.daily.daysProcessed.filter(row => row.partial)
            .map(row => `${row.day}（${dict.dailyExcludedLine} ${row.excluded}）`).join('、'))
        : null,
      view?.daily?.lastSummary?.summary
        ? row('summary', `${dict.lastSummaryLine} ${view.daily.lastSummary.day}`, view.daily.lastSummary.summary,
          null, { stacked: true })
        : null,
      h('div', { key: 'secm', className: 'mse-section-title' }, dict.moreSection),
      disclosure('more-how', dict.moreHowTitle, h('p', { className: 'mse-hint' }, dict.moreHow),
        { id: 'more-how' }),
      disclosure('more-save', dict.moreSaveTitle, h('p', { className: 'mse-hint' }, dict.moreSave),
        { id: 'more-save' }),
      disclosure('more-scope', dict.moreScopeTitle, h('p', { className: 'mse-hint' }, dict.moreScope),
        { id: 'more-scope' }),
      disclosure('more-check', dict.moreCheckTitle, h('p', { className: 'mse-hint' }, dict.moreCheck),
        { id: 'more-check' }),
    ])

    // ── 经验 ──────────────────────────────────────────────────────────────────────────────
    const entries = view?.entries ?? []
    const shown = entries.filter(entry => (filter.type === '' || entry.type === filter.type)
      && (filter.status === '' || (STATUS_ZH[entry.status] ?? entry.status) === filter.status))
    const lessonsPanel = h(React.Fragment, { key: 'lessons' }, [
      h('div', { key: 'sec', className: 'mse-section-title' }, [
        h('span', { key: 't' }, dict.entriesSection),
        h('div', { key: 'f', className: 'mse-inline' }, [
          h(Picker, { key: 'type', label: dict.filterType, prefix: dict.filterType,
            value: filter.type, testId: 'filter-type',
            options: [{ id: '', label: dict.allOption },
              ...Object.entries(TYPE_ZH).map(([id, label]) => ({ id, label }))],
            onChange: value => setFilter(current => ({ ...current, type: value })) }),
          h(Picker, { key: 'status', label: dict.filterStatus, prefix: dict.filterStatus,
            value: filter.status, testId: 'filter-status',
            options: [{ id: '', label: dict.allOption },
              ...[dict.statusActive, dict.statusSuperseded, '待验证', '需修订'].map(label => ({ id: label, label }))],
            onChange: value => setFilter(current => ({ ...current, status: value })) }),
        ]),
      ]),
      h('p', { key: 'eh', className: 'mse-hint' }, dict.entriesHint),
      view === null ? null : h('p', { key: 'cnt', className: 'mse-statline' }, [
        h('span', { key: 'c' }, `${dict.existingCount}`), h('b', { key: 'n' }, String(shown.length)),
        filter.type !== '' || filter.status !== ''
          ? h('span', { key: 'f', className: 'mse-unit' },
            `/${entries.length}（${dict.filterType}·${dict.filterStatus}）`) : null]),
      view === null ? null : shown.length === 0 ? h('p', { key: 'ne', className: 'mse-hint' }, dict.noEntries)
        : shown.map(entry => disclosure(`e-${entry.id}`,
          summaryText(entry.instruction, 64),
          h(React.Fragment, null, [
            h('p', { key: 'full', className: 'mse-detail-text' }, `${dict.fullText}：${entry.instruction}`),
            definition('d', [
              [dict.version, `${entry.version}${entry.parentVersion ? ` ← ${entry.parentVersion}` : ''}`],
              [dict.scope, entry.visibility === 'scoped'
                ? `${dict.scopeScoped}（${entry.scopeHash ?? '—'}）` : dict.scopeGlobal],
              [dict.filterStatus, STATUS_ZH[entry.status] ?? entry.status],
              [dict.injectedCount, String(entry.injected)],
              [dict.recurrenceCount, String(entry.recurrences)],
              [dict.updatedAt, atText(entry.updatedAt)],
              entry.evidenceHash ? [dict.evidenceHash, String(entry.evidenceHash).slice(0, 12)] : null,
              entry.applicability ? [dict.applicabilityLine, entry.applicability] : null,
            ], { left: true }),
            Array.isArray(entry.steps) && entry.steps.length > 0
              ? h('p', { key: 's', className: 'mse-hint' },
                `${dict.fixSteps}：${entry.steps.join('；')}`) : null,
            entry.check?.check ? h('p', { key: 'c', className: 'mse-hint' },
              `${dict.checkMethod}：${entry.check.check}`) : null,
          ]), { id: `e-${entry.id}`, open: openEntry === entry.id,
            onToggle: open => setOpenEntry(open ? entry.id : null), stackMeta: true,
            meta: [TYPE_ZH[entry.type] ?? entry.type, STATUS_ZH[entry.status] ?? entry.status,
              entry.visibility === 'scoped' ? dict.scopeScoped : dict.scopeGlobal,
              `v${entry.version}`, `${dict.injectedCount} ${entry.injected}`] })),
    ])

    // ── 召回 ──────────────────────────────────────────────────────────────────────────────
    const recall = view?.recall ?? []
    const recallPanel = h(React.Fragment, { key: 'recall' }, [
      h('div', { key: 'sec', className: 'mse-section-title' }, dict.recallSection),
      h('p', { key: 'rh', className: 'mse-hint' }, dict.recallHint),
      view === null ? null : recall.length === 0 ? h('p', { key: 'nr', className: 'mse-hint' }, dict.noRecall)
        : recall.map(item => disclosure(`r-${item.at}`,
          `${atText(item.at)} · ${dict.offeredVersions} ${item.offered.length}`,
          definition('d', item.offered.map(o => {
            const known = entries.find(entry => entry.id === o.id)
            return [known ? `${dict.summaryLabel} v${o.version}` : `${dict.historicalEntry} v${o.version}`,
              known === undefined ? o.id : `${summaryText(known.instruction)}｜${o.id}`]
          }), { left: true }),
          { id: `r-${item.at}`,
            meta: [item.settled ? dict.settledYes : dict.settledNo,
              item.outcome === null ? dict.outcomeUnknown : (OUTCOME_ZH[item.outcome] ?? item.outcome),
              `${item.bytes} B`] })),
    ])

    // ── 任务 ──────────────────────────────────────────────────────────────────────────────
    const tasks = view?.tasks ?? []
    const tasksPanel = h(React.Fragment, { key: 'tasks' }, [
      h('div', { key: 'sec', className: 'mse-section-title' }, dict.tasksSection),
      h('p', { key: 'th', className: 'mse-hint' }, dict.tasksHint),
      h('div', { key: 'm', className: 'mse-metrics mse-metrics-2' }, [
        metric(dict.inFlightNow, String((view?.inFlight ?? []).length)),
        metric(dict.unknownCostHeld, String((view?.unknownCostHeld ?? []).length)),
      ]),
      view === null ? null : h('div', { key: 'wait', className: 'mse-statline' }, [
        h('span', { key: 'l' }, dict.waitReasonLine),
        h('b', { key: 'v' }, WAIT_ZH[view.daily?.waitReason ?? null] ?? view.daily?.waitReason ?? '—')]),
      view === null ? null : tasks.length === 0 ? h('p', { key: 'nt', className: 'mse-hint' }, dict.noTasks)
        : tasks.map(item => disclosure(`t-${item.ticket}`,
          `${KIND_ZH[item.kind] ?? item.kind} · ${atText(item.at)}`,
          h(React.Fragment, null, [
            definition('d', [
              [dict.requestLabel, String(item.ticket)],
              [dict.rawCode, terminalZh(item.terminal) ?? dict.taskStatusRunning],
              item.nextStep ? [dict.nextStepLabel, NEXT_ZH[item.nextStep] ?? item.nextStep] : null,
              Number.isSafeInteger(item.outputBytes) ? [dict.outputBytesLabel, `${item.outputBytes} B`] : null,
              item.finishKind ? [dict.finishKindLabel, String(item.finishKind)] : null,
              item.verdictCode ? [dict.verdictLabel, (item.verdictCode === 'generation_limit_no_text'
                || item.verdictCode === 'reasoning_space_exhausted')
                ? dict.reasoningSpace : String(item.verdictCode)] : null,
              item.sourceSessionId ? ['来源会话', String(item.sourceSessionId)] : null,
            ], { left: true }),
            // Retry stays exactly on the original audited interface, and only where it MEANS
            // something: never after a committed/saved success, never on an unknown cost.
            item.settled && item.usageUnknown !== true && item.terminal !== null
              && !OK_TERMINALS.has(item.terminal)
              ? h(Button, { key: 'b', variant: 'outline', size: 'sm',
                onClick: () => auditedRetry(item.ticket) }, dict.auditedRetry) : null,
          ]), { id: `t-${item.ticket}`,
            meta: [item.settled ? dict.taskStatusSettled : dict.taskStatusRunning,
              item.usageUnknown ? dict.unknownCostHeld
                : item.usageTotal !== null ? `${item.usageTotal} tok` : null,
              item.settled && item.terminal !== null
                ? (REASON_ZH[item.terminal] ?? terminalZh(item.terminal) ?? '') : null]
              .filter(label => label !== null && label !== '') })),
      h('p', { key: 'rh', className: 'mse-hint' }, dict.auditedRetryHint),
    ])

    // ── 学习状态 ────────────────────────────────────────────────────────────────────
    const usage = view?.usageAudit ?? null
    const corrections = view?.corrections ?? null
    const sum = pick => usage?.byKind === undefined ? 0
      : Object.values(usage.byKind).reduce((total, bucket) => total + bucket[pick], 0)
    const injectedTotal = entries.reduce((total, entry) => total + (entry.injected ?? 0), 0)
    const recurrenceTotal = entries.reduce((total, entry) => total + (entry.recurrences ?? 0), 0)
    const usagePanel = h(React.Fragment, { key: 'usage' }, [
      h('div', { key: 'sec', className: 'mse-section-title' }, dict.correctionsSection),
      corrections === null ? h('p', { key: 'cl', className: 'mse-hint' }, dict.loading)
        : h('div', { key: 'm', className: 'mse-metrics' }, [
          metric(dict.saved, String(corrections.saved)),
          metric(dict.pendingCorr, String(corrections.pending)),
          metric(dict.dispatchedCorr, String(corrections.dispatched)),
        ]),
      h('p', { key: 'ch', className: 'mse-hint' }, dict.correctionsShort),
      disclosure('corr-full', dict.correctionsFullTitle, h('p', { className: 'mse-detail-text' },
        dict.correctionsFull), { id: 'corr-full' }),
      (corrections?.ignoredRecent ?? []).length === 0 ? null
        : h('p', { key: 'ig', className: 'mse-hint' },
          `${dict.ignoredReasons}：${(corrections.ignoredRecent ?? [])
            .map(r => `${REASON_ZH[r.reason] ?? r.reason}（${atText(r.at)}）`).join('、')}`),
      h('div', { key: 'secCol', className: 'mse-section-title' }, dict.collectionSection),
      disclosure('coll-scope', dict.collectionScopeTitle,
        view?.collection === undefined ? dict.loading
          : `${dict.collectionWorkspaces}：${view.collection.workspaces ?? dict.collectionUnknown}`
            + (view.collection.skipped.length === 0 ? `；${dict.collectionNone}`
              : `；${dict.collectionSkipped}：${view.collection.skipped
                .map(r => `${REASON_ZH[r.reason] ?? r.reason}×${r.count}`).join('、')}`),
        { id: 'coll-scope' }),
      h('div', { key: 'secRev', className: 'mse-section-title' }, dict.revisionsSection),
      view?.revisions === undefined ? h('p', { key: 'rvl', className: 'mse-hint' }, dict.loading)
        : view.revisions.length === 0
          ? h('p', { key: 'rvn', className: 'mse-hint' }, dict.revisionNone)
          // MSE18: the revision audit is LONG TEXT, not a numeric stat — it must not be shoved
          // into a 1/3-width metric card (the whole v1→停用·原因·日期 string became a giant wrapped
          // headline). Full-width ordinary information rows on the page's EXISTING styles: the
          // #short-id and v1→停用 at normal body size (mse-row-title), reason and time on the
          // second line in muted small text (mse-hint). Nothing hidden, nothing truncated.
          : view.revisions.map(row => h('div', { key: `rv-${row.id}`, className: 'mse-row mse-row-stacked' },
            h('div', { key: 'm', className: 'mse-row-main' }, [
              h('div', { key: 't', className: 'mse-row-title' },
                `#${row.id.slice(4, 12)} · v${row.version} → `
                + `${row.status === 'retired' ? dict.revisionRetired : `v${row.currentVersion}`}`),
              h('p', { key: 'h', className: 'mse-hint' },
                `${REASON_ZH[row.reason] ?? row.reason ?? ''} · ${atText(row.at)}`),
            ]))),
      row('go-lessons', dict.goLessons, null,
        h(Button, { key: 'b', variant: 'outline', size: 'sm', onClick: () => setTab('lessons') },
          dict.tabLessons)),
      h('div', { key: 'sec1', className: 'mse-section-title' }, dict.existingSection),
      h('div', { key: 'ex', className: 'mse-metrics mse-metrics-2' }, [
        metric(dict.existingCount, String(entries.length)),
        metric(`${dict.existingInjected}／${dict.existingRecurrences}`, `${injectedTotal}／${recurrenceTotal}`),
      ]),
      h('p', { key: 'exn', className: 'mse-hint' }, dict.existingScopeNote),
      h('div', { key: 'sec2', className: 'mse-section-title' }, dict.dailyState),
      view === null ? null : h('div', { key: 'daily', className: 'mse-row mse-row-stacked' }, [
        h('div', { key: 't', className: 'mse-row-main' }, [
          definition('d', [
            [dict.lastDoneDay, view.daily?.lastDoneDay ?? '—'],
            [dict.backlogDays, (view.daily?.backlog ?? []).length === 0 ? dict.none
              : (view.daily.backlog ?? []).join('、')],
            [dict.daysProcessed, (view.daily?.daysProcessed ?? []).map(d => `${d.day}·${d.status}`).join('、')
              || dict.none],
          ], { left: true })]),
      ]),
      h('div', { key: 'sec3', className: 'mse-section-title' }, dict.usageAuditSection),
      h('p', { key: 'un', className: 'mse-hint' }, dict.usageAuditNote),
      usage === null ? null : h('div', { key: 'm2', className: 'mse-metrics' }, [
        metric(dict.usageCalls, String(sum('calls'))),
        metric(dict.usageTokens, String(sum('knownTokens'))),
        metric(dict.usageUnknownCost, String(sum('unknownCost'))),
      ]),
      usage === null ? null : disclosure('usage-kinds',
        `${dict.usageTotalRequests}／${dict.usageSettled}：${usage?.total ?? 0}／${usage?.settled ?? 0}`,
        h('div', { className: 'mse-row-main' }, [
          definition('d', Object.entries(usage.byKind).map(([kind, bucket]) => [
            KIND_ZH[kind] ?? kind,
            `${dict.usageCalls} ${bucket.calls}｜${dict.usageTokens} ${bucket.knownTokens}`
            + `${bucket.unknownCost > 0 ? `｜${dict.usageUnknownCost} ${bucket.unknownCost}` : ''}`,
          ]), { left: true })]), { id: 'usage-kinds' }),
    ])

    const tabs = h('div', { key: 'tabs', ref: tabsHost, className: 'mse-tabs-host' },
      settingsTabNavigation(tab, setTab, dict, compactTabs))
    const body = tab === 'overview' ? overviewPanel : tab === 'lessons' ? lessonsPanel
      : tab === 'recall' ? recallPanel : tab === 'tasks' ? tasksPanel : usagePanel
    return h('section', { className: 'mse-details', 'data-mse-details': 'page' }, [
      h('div', { key: 'heading', className: 'mse-heading' }, [
        h('h1', { key: 't' }, dict.settingsTitle),
        state === 'error'
          ? h('span', { key: 's', className: 'mse-error' }, dict.statusUnreadable)
          : h('span', { key: 's', className: 'mse-status' }, [
            h(StateDot, { key: 'd', state: view === null ? 'idle' : view.paused === true ? 'idle' : 'done' }),
            h('span', { key: 't' }, view === null ? dict.loading
              : view.paused === true ? dict.effectivePaused : dict.effectiveRunning),
          ]),
        h(Button, { key: 'r', variant: 'ghost', size: 'sm', className: 'mse-heading-action',
          disabled: shell.status === 'loading', onClick: () => setReloadToken(current => current + 1) },
        shell.status === 'loading' ? dict.refreshing : dict.refresh),
      ]),
      shell.error !== null && shell.error !== undefined && shell.error !== ''
        ? h('p', { key: 'err', className: 'mse-error' }, `${dict.loadFailed}: ${shell.error}`) : null,
      tabs,
      h('div', { key: 'pane', id: `mse-pane-${tab}`, role: 'tabpanel', 'aria-labelledby': `mse-tab-${tab}`,
        className: 'mse-pane' }, body),
    ])
  }

  // Plugin detail page: the SAME panel and read face — never a README pointer.
  function BundlePage(props) {
    return MsePanel({ ...props, initialTab: 'usage' })
  }

  async function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh }), 'mse-learning: rebuild dictionaries')
    ctx.effect(() => {
      const style = document.createElement('style')
      style.dataset.plugin = BUNDLE
      style.textContent = STYLE
      document.head.append(style)
      return () => style.remove()
    }, 'mse-learning: rebuild styles')
    const unmount = await ctx.remote.$mount(STATUS_CONTRIB)
    ctx.effect(() => unmount, 'mse-learning: status remote')
    const unmountControl = await ctx.remote.$mount(CONTROL_CONTRIB)
    ctx.effect(() => unmountControl, 'mse-learning: control remote')
    // The pages bind only once the REAL namespace services are injected and callable.
    ctx.inject(['remote.mseRebuildStatus', 'remote.mseRebuildControl'], scope => {
      const call = (method, input) => scope.remote.mseRebuildStatus[method](input ?? {})
      const control = (method, input) => scope.remote.mseRebuildControl[method](input ?? {})
      const form = ctx.configForms.get(SETTINGS_ID)
      ctx.effect(() => ctx.configForms.whileServed([SETTINGS_ID], () => scope.slots.inject('settings.section',
        () => scope.slots.register({
          name: 'settings.section',
          id: SETTINGS_ID,
          order: 66,
          label: () => (scope.locale.getLocale().active === 'en' ? 'Self-evolution' : '自我进化'),
          locale: NS,
          inject: () => ({ call, control, form, locale: scope.locale.getLocale().active,
            hooks: { locale: ctx.locale } }),
        }, MsePanel))), 'mse-learning: settings section')
      scope.slots.inject('plugins.bundle.config', () => scope.slots.register({
        name: 'plugins.bundle.config',
        key: BUNDLE,
        locale: NS,
        inject: () => ({ call, control, form, locale: scope.locale.getLocale().active,
          hooks: { locale: ctx.locale } }),
      }, BundlePage))
    })
  }

  return {
    name: 'mse-learning-rebuild-client',
    inject: ['slots', 'locale', 'remote', 'configForms'],
    apply,
    __test: { NS, SETTINGS_ID, BUNDLE, TABS, STYLE, STATUS_CONTRIB, CONTROL_CONTRIB, zh,
      STATUS_ZH, TYPE_ZH, REASON_ZH, WAIT_ZH,
      row, disclosure, definition, metric, Picker, settingsTabNavigation, callRemote,
      useFormSnapshot, MsePanel, BundlePage },
  }
} })
