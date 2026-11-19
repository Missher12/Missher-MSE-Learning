/**
 * MSE 的原生设置页和插件详情。设置通过宿主 ConfigForm 写入，学习状态由 Remote 读取。
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
  const TABS = ['overview', 'lessons', 'recall', 'tasks', 'usage', 'activity']
  const tabLabel = (id, dict) => id === 'overview' ? dict.tabOverview : id === 'lessons' ? dict.tabLessons
    : id === 'recall' ? dict.tabRecall : id === 'tasks' ? dict.tabTasks
      : id === 'activity' ? dict.tabActivity : dict.tabUsage

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
    settingsTitle: '自我进化', runtimeGroup: '学习', scheduleGroup: '调度与召回',
    tabOverview: '常规', tabLessons: '经验', tabRecall: '召回', tabTasks: '任务', tabUsage: '学习状态',
    tabActivity: '活动',
    activityTitle: '活动', activityToday: '今天新增', activityWeek: '本周新增',
    activityRetained: '当前保留', activityEntries: '条', activityDay: '每日', activityWeekMode: '每周',
    activityTotal: '累计', activityChart: '活动热力图',
    activityRule: '规则', activityLesson: '经验', activityDigest: '总结',
    activityHistoryNote: '按保留记录的创建时间统计。',
    activityDetails: '统计口径', activityImported: '导入记录', activityUnknown: '创建时间无效',
    activityFuture: '未来记录（未计入新增）', activityBeforeWindow: '一年窗口前',
    activityCumulativeThrough: '累计至', activityColorLabel: '活动配色', activityColorMenu: '配色',
    activityThemeColor: '跟随主题', activityVioletColor: '暮紫', activityBlueColor: '湖蓝',
    activityTealColor: '青绿', activityAmberColor: '暖金', activityRoseColor: '烟粉',
    activityCustomColor: '自定义颜色…',
    activityDayTooltip: '{date} · {count} 条', activityWeekTooltip: '{start} — {end} · {count} 条',
    activityTotalTooltip: '截至 {date} 累计 · {count} 条',
    adaptiveCandidates: '自适应候选', adaptiveNoCandidates: '暂无候选',
    adaptiveObserving: '观察中', adaptiveApproved: '已启用', adaptiveIsolated: '已停用',
    adaptiveLegacy: '旧版策略（不继承分数）', adaptiveTarget: '目标版本',
    adaptiveSource: '来源许可', adaptiveSourceYes: '有效', adaptiveSourceNo: '未获许可',
    adaptiveSourceUnknown: '无法确认', adaptiveReplay: '回放', adaptiveGain: '独立命中',
    adaptiveControl: '无关对照', adaptiveBlockers: '当前原因', adaptiveSuccessor: '已有新版后继，旧版证据不计入。',
    adaptiveTargetCurrent: '当前版本', adaptiveTargetChanged: '版本已变化', adaptiveTargetRetired: '已停用',
    adaptiveTargetRevision: '待修订',
    refresh: '刷新', loading: '读取中…',
    statusUnreadable: '状态不可读', lastRead: '上次数据',
    storageInvalidMemory: '学习库内容校验失败，已暂停读写与后台学习。',
    storageInvalidStore: '学习库文件或目录不安全，已暂停读写与后台学习。',
    storageUnavailable: '学习库当前不可读写，后台学习已暂停。',
    storageCapacity: '学习库容量已满，旧数据已保留，新条目暂缓保存。',
    storageDurability: '最近一次写入已提交，但持久化尚未确认。',
    storageBusy: '另一进程正在写入，本次写入已跳过。',
    storageWarning: '学习库状态',
    effectiveRunning: '运行中', effectivePaused: '已暂停', effectiveOff: '已关闭',
    learning: '自动学习', pauseControl: '后台任务',
    pause: '暂停', resume: '恢复',
    settingsSaveFailed: '保存失败，请重试。', saveSetting: '保存', cancelSetting: '取消',
    wakeInterval: '空闲检查间隔', minuteUnit: '分钟', invalidWake: '请输入 1–60 分钟。',
    dailyHour: '每日总结时间', dailyLocalTime: '本机时间，空闲时运行',
    recallBytes: '每轮召回上限',
    recallTokenEstimate: 'Token 估算', recallLegacyBytes: '旧设置',
    adaptiveByteEvidence: '旧版字节证据（≤768 B）',
    modelSettings: '后台模型', modelFromSource: '随来源会话', modelProvider: '服务商 ID',
    modelId: '模型 ID', reasoningEffort: '推理强度', defaultEffort: '默认',
    effortLow: '低', effortMedium: '中', effortHigh: '高',
    invalidModel: '请同时填写服务商 ID 和模型 ID，或将两项留空。',
    modelLimit: '服务商最多 32 字符，模型最多 64 字符。',
    modelNote: '两项留空时跟随来源会话。后台调用可能计费。',
    dailySection: '每日总结', moreSection: '更多信息',
    moreHow: '关闭或暂停学习后，已有经验仍可召回。',
    entriesSection: '规则与经验',
    filterType: '类型', filterStatus: '状态', allOption: '全部',
    typeRule: '用户规则', typeLesson: '失败经验', typeDigest: '每日总结',
    statusActive: '生效', statusSuperseded: '已被新版取代',
    version: '版本', scope: '范围', scopeGlobal: '全局', scopeScoped: '仅本项目',
    fixSteps: '修复步骤', checkMethod: '检查办法', injectedCount: '注入', recurrenceCount: '复发',
    evidenceHash: '证据指纹', updatedAt: '更新于', applicabilityLine: '适用情形',
    versionWindowLabel: '当前版窗口', coverageComplete: '完整（该版建立后全程）',
    coverageSinceUpgrade: '仅升级后（此前版本归属未知）',
    windowInjected: '本版注入', windowChecks: '本版检查通过/失败',
    recentRevisionLabel: '最近修订原因', recentRevisionNone: '暂无修订',
    modeGuard: '警示', modeMethod: '方法', modeLegacy: '旧格式回执',
    recallSection: '注入记录',
    offeredVersions: '提供版本', outcomeUnknown: '未判定', outcomeCompleted: '完成', outcomeAborted: '中止',
    outcomeVerified: '检查通过', outcomeFailed: '存在失败', outcomeCancelled: '已取消',
    rsiPersisted: '最近持久化决定', rsiRuntime: '最近运行记录', rsiNone: '暂无记录',
    rsiStageAdmission: '来源检查', rsiStageProbe: '探针', rsiStageToolResult: '工具结果',
    rsiStagePending: '待结算', rsiStageSettled: '回合结算',
    rsiResultCreated: '已建立策略', rsiResultHoldout: '独立命中', rsiResultMiss: '同题漏配',
    rsiResultControl: '负向对照',
    rsiResultApproved: '已批准', rsiResultRejected: '已拒绝', rsiResultIsolated: '已隔离',
    rsiResultUnknown: '未知', rsiResultFeatureRefused: '特征不足',
    rsiReasonProbeCreated: '已记录真实探针', rsiReasonFailureAdmitted: '失败证据已接纳',
    rsiReasonFailureDuplicate: '重复失败证据', rsiReasonFailureRejected: '失败证据未接纳',
    rsiReasonSourceRefused: '来源不再获准', rsiReasonMaterialRefused: '材料被拒绝',
    rsiReasonOutputIncomplete: '工具输出不完整', rsiReasonCancelled: '工具调用已取消',
    rsiReasonNoFailure: '没有工具失败', rsiReasonPendingSignal: '等待结算',
    rsiReasonNoPendingSignal: '没有待结算信号', rsiReasonStorageUnavailable: '学习库暂不可读',
    rsiReasonNoDecision: '没有自适应决定', rsiReasonUnknownOutcome: '客观结果未知',
    rsiReasonUniqueNative: '唯一原生失败匹配', rsiReasonIndependentSame: '独立同类命中',
    rsiReasonSameSession: '会话或任务重复', rsiReasonCompeting: '其他方法解释了失败',
    rsiReasonRecurrence: '同类失败复发', rsiReasonCheckerFailure: '原生检查失败',
    rsiReasonCancelledUnknown: '取消或结果未知', rsiReasonSourceRevoked: '来源许可撤销',
    rsiReasonMaterialRevoked: '材料许可撤销', rsiReasonPolicyStale: '策略版本失效',
    rsiReasonInsufficientFeatures: '安全特征不足', rsiReasonAlreadyTracked: '策略已跟踪',
    rsiReasonNotAdditive: '没有新增价值', rsiReasonAmbiguousFailure: '失败目标不唯一',
    rsiReasonBaselineExplains: '基线经验已解释失败', rsiReasonStaleProbe: '探针已过期',
    rsiReasonProbeCapacity: '探针容量已满', rsiReasonUnmatchedObjective: '目标不匹配',
    rsiReasonAwaitingControl: '等待负向对照', rsiReasonStrategyDisabled: '策略已停用',
    rsiReasonRevisionLimit: '策略修订次数已满', rsiReasonSameMechanism: '修订机制重复',
    rsiReasonCounterexampleChild: '反例修订已建立',
    settledYes: '已结算', settledNo: '在途', historicalEntry: '历史经验', fullId: '完整标识',
    summaryLabel: '摘要', requestLabel: '请求标识', rawCode: '原始结果码',
    tasksSection: '后台请求', retryGuide: '重试规则',
    tasksHint: '已知费用的截断仅自动重试一次。未知费用不重发。',
    inFlightNow: '在途', waitReasonLine: '等待原因', unknownCostHeld: '未知费用保留',
    taskKindReflect: '反思', taskKindRevise: '修订', taskKindDigest: '每日总结', taskKindExtract: '纠正提取',
    taskStatusSettled: '已结算', taskStatusRunning: '在途',
    usageTokens: '已知 tokens', usageCalls: '调用', usageUnknownCost: '未知费用',
    usageTotalRequests: '请求总数', usageSettled: '已结算',
    usageAuditSection: '近 24 小时用量',
    correctionsSection: '纠正提取',
    collectionScopeTitle: '采集范围',
    collectionWorkspaces: '注册工作区', collectionSkipped: '最近跳过', collectionNone: '无跳过记录',
    collectionUnknown: '未知', revisionsSection: '最近规则变更', revisionRetired: '停用',
    revisionNone: '暂无规则变更',
    correctionsFullTitle: '保存规则说明',
    correctionsFull: '可复用纠正在核对原话和范围后保存。临时要求只留回合记录。',
    saved: '已保存', pendingCorr: '待处理', dispatchedCorr: '提取中', ignoredReasons: '忽略原因',
    correctionsDecision: '最近决定', corrDurable: '长期', corrOneOff: '临时', corrUncertain: '长期性不明',
    corrGlobal: '全局', corrProject: '项目', corrScopeUnknown: '范围不明',
    corrSaved: '保存', corrIgnored: '忽略', corrContextOmitted: '上下文省略',
    existingSection: '现存经验', existingCount: '现存规则与经验', existingInjected: '注入合计',
    existingRecurrences: '复发合计', goLessons: '查看经验',
    auditedRetry: '审计重试', auditedRetryHint: '重试可能计费。',
    noEntries: '暂无经验。', noRecall: '暂无注入记录。', noTasks: '暂无后台请求。',
    lastSummaryLine: '总结', dailyState: '每日状态', lastDoneDay: '最后完成日', backlogDays: '待补日',
    dailyPartialLine: '部分完成（未核验来源的事实已安全排除）', dailyExcludedLine: '排除',
    nextStepLabel: '下一步', outputBytesLabel: '输出字节', finishKindLabel: '终止原因',
    verdictLabel: '输出诊断',
    reasoningSpace: '生成达到上限、未收到正文（可能用于推理）',
    daysProcessed: '已处理日', none: '无',
  }
  const en = {
    settingsTitle: 'Self-evolution', runtimeGroup: 'Learning', scheduleGroup: 'Schedule and recall',
    tabOverview: 'Overview', tabLessons: 'Lessons', tabRecall: 'Recall', tabTasks: 'Tasks',
    tabUsage: 'Learning', tabActivity: 'Activity', refresh: 'Refresh', loading: 'Loading…',
    statusUnreadable: 'Status unavailable', lastRead: 'Last read',
    storageInvalidMemory: 'Memory validation failed. Writes and background learning are paused.',
    storageInvalidStore: 'Memory path is unsafe. Writes and background learning are paused.',
    storageUnavailable: 'Memory is unavailable. Background learning is paused.',
    storageCapacity: 'Memory is full. Existing data is kept; new entries are on hold.',
    storageDurability: 'The latest write committed, but durability is unconfirmed.',
    storageBusy: 'Another process is writing. This write was skipped.', storageWarning: 'Memory status',
    effectiveRunning: 'Running', effectivePaused: 'Paused', effectiveOff: 'Off',
    learning: 'Automatic learning', pauseControl: 'Background work', pause: 'Pause', resume: 'Resume',
    settingsSaveFailed: 'Save failed. Try again.', saveSetting: 'Save',
    cancelSetting: 'Cancel', wakeInterval: 'Idle check interval', minuteUnit: 'min',
    invalidWake: 'Enter 1–60 minutes.', dailyHour: 'Daily summary time',
    dailyLocalTime: 'Local time, while idle', recallBytes: 'Per-turn recall limit',
    recallTokenEstimate: 'Token estimate', recallLegacyBytes: 'legacy setting',
    adaptiveByteEvidence: 'Legacy byte evidence (≤768 B)',
    modelSettings: 'Background model', modelFromSource: 'Source session', modelProvider: 'Provider ID',
    modelId: 'Model ID', reasoningEffort: 'Reasoning effort', defaultEffort: 'Default',
    effortLow: 'Low', effortMedium: 'Medium', effortHigh: 'High',
    invalidModel: 'Enter both IDs or leave both blank.',
    modelLimit: 'Provider IDs are limited to 32 characters, model IDs to 64.',
    modelNote: 'Leave both IDs blank to use the source session. Background calls may incur charges.',
    dailySection: 'Daily summary', moreSection: 'Details',
    moreHow: 'Existing lessons are still recalled when learning is paused or off.',
    entriesSection: 'Rules and lessons',
    filterType: 'Type', filterStatus: 'Status', allOption: 'All', typeRule: 'User rule',
    typeLesson: 'Lesson', typeDigest: 'Daily summary', statusActive: 'Active', statusSuperseded: 'Superseded',
    version: 'Version', scope: 'Scope', scopeGlobal: 'Global', scopeScoped: 'This project',
    fixSteps: 'Fix steps', checkMethod: 'Verification', injectedCount: 'Offered', recurrenceCount: 'Recurrences',
    evidenceHash: 'Evidence ID', updatedAt: 'Updated', applicabilityLine: 'Applies when',
    versionWindowLabel: 'Current version', coverageComplete: 'Complete since this version was created',
    coverageSinceUpgrade: 'Since upgrade only; older version attribution is unknown',
    windowInjected: 'Current version offers', windowChecks: 'Current version checks (pass/fail)',
    recentRevisionLabel: 'Latest revision', recentRevisionNone: 'No revisions',
    modeGuard: 'Warning', modeMethod: 'Method', modeLegacy: 'Legacy receipt', recallSection: 'Recall receipts',
    offeredVersions: 'Versions offered',
    outcomeUnknown: 'Unknown', outcomeCompleted: 'Completed', outcomeAborted: 'Aborted',
    outcomeVerified: 'Verified', outcomeFailed: 'Failed', outcomeCancelled: 'Cancelled',
    rsiPersisted: 'Recent saved decisions', rsiRuntime: 'Recent runtime events', rsiNone: 'No records',
    rsiStageAdmission: 'Source check', rsiStageProbe: 'Probe', rsiStageToolResult: 'Tool result',
    rsiStagePending: 'Pending', rsiStageSettled: 'Settled', rsiResultCreated: 'Policy created',
    rsiResultHoldout: 'Independent hit', rsiResultMiss: 'Same objective missed',
    rsiResultControl: 'Negative control', rsiResultApproved: 'Approved',
    rsiResultRejected: 'Rejected', rsiResultIsolated: 'Isolated', rsiResultUnknown: 'Unknown',
    rsiResultFeatureRefused: 'Insufficient features', rsiReasonProbeCreated: 'Real probe recorded',
    rsiReasonFailureAdmitted: 'Failure evidence accepted', rsiReasonFailureDuplicate: 'Duplicate failure evidence',
    rsiReasonFailureRejected: 'Failure evidence rejected', rsiReasonSourceRefused: 'Source no longer admitted',
    rsiReasonMaterialRefused: 'Material rejected', rsiReasonOutputIncomplete: 'Tool output incomplete',
    rsiReasonCancelled: 'Tool call cancelled', rsiReasonNoFailure: 'No tool failure',
    rsiReasonPendingSignal: 'Awaiting settlement', rsiReasonNoPendingSignal: 'No pending signal',
    rsiReasonStorageUnavailable: 'Memory unavailable', rsiReasonNoDecision: 'No adaptive decision',
    rsiReasonUnknownOutcome: 'Outcome unknown', rsiReasonUniqueNative: 'Unique native failure match',
    rsiReasonIndependentSame: 'Independent same-objective hit', rsiReasonSameSession: 'Repeated session or task',
    rsiReasonCompeting: 'Another method explains the failure', rsiReasonRecurrence: 'Same failure recurred',
    rsiReasonCheckerFailure: 'Native check failed', rsiReasonCancelledUnknown: 'Cancelled or unknown result',
    rsiReasonSourceRevoked: 'Source permission revoked', rsiReasonMaterialRevoked: 'Material permission revoked',
    rsiReasonPolicyStale: 'Policy version is stale', rsiReasonInsufficientFeatures: 'Insufficient safe features',
    rsiReasonAlreadyTracked: 'Policy already tracked', rsiReasonNotAdditive: 'No added value',
    rsiReasonAmbiguousFailure: 'Failure target is ambiguous', rsiReasonBaselineExplains: 'Baseline explains failure',
    rsiReasonStaleProbe: 'Probe expired', rsiReasonProbeCapacity: 'Probe capacity reached',
    rsiReasonUnmatchedObjective: 'Objective did not match', rsiReasonAwaitingControl: 'Awaiting negative control',
    rsiReasonStrategyDisabled: 'Strategy disabled', rsiReasonRevisionLimit: 'Revision limit reached',
    rsiReasonSameMechanism: 'Repeated revision mechanism', rsiReasonCounterexampleChild: 'Counterexample revision created',
    settledYes: 'Settled', settledNo: 'In progress', historicalEntry: 'Historical lesson', fullId: 'Full ID',
    summaryLabel: 'Summary', requestLabel: 'Request ID', rawCode: 'Result code',
    tasksSection: 'Background requests', retryGuide: 'Retry rules',
    tasksHint: 'One automatic retry for known-cost truncation. Unknown-cost calls stay on hold.',
    inFlightNow: 'In flight', waitReasonLine: 'Waiting', unknownCostHeld: 'Unknown cost held',
    taskKindReflect: 'Reflection', taskKindRevise: 'Revision', taskKindDigest: 'Daily summary',
    taskKindExtract: 'Correction extraction', taskStatusSettled: 'Settled', taskStatusRunning: 'In progress',
    usageTokens: 'Known tokens', usageCalls: 'Calls', usageUnknownCost: 'Unknown cost',
    usageTotalRequests: 'Requests / settled', usageSettled: 'settled',
    usageAuditSection: 'Usage (last 24 hours)',
    correctionsSection: 'Correction extraction',
    collectionScopeTitle: 'Collection scope', collectionWorkspaces: 'Registered workspaces',
    collectionSkipped: 'Recently skipped', collectionNone: 'No skipped events', collectionUnknown: 'Unknown',
    revisionsSection: 'Recent rule changes', revisionRetired: 'Retired', revisionNone: 'No rule changes',
    correctionsFullTitle: 'Rule saving', correctionsFull: 'Reusable corrections are checked for wording and scope. One-off requests stay with their turn.',
    saved: 'Saved', pendingCorr: 'Pending', dispatchedCorr: 'Extracting', ignoredReasons: 'Ignored because',
    correctionsDecision: 'Recent decisions', corrDurable: 'Reusable', corrOneOff: 'One-off',
    corrUncertain: 'Uncertain', corrGlobal: 'Global', corrProject: 'Project', corrScopeUnknown: 'Scope unknown',
    corrSaved: 'Saved', corrIgnored: 'Ignored', corrContextOmitted: 'Context omitted',
    existingSection: 'Retained entries', existingCount: 'Rules and lessons', existingInjected: 'Offers',
    existingRecurrences: 'Recurrences', goLessons: 'View lessons',
    auditedRetry: 'Audited retry',
    auditedRetryHint: 'Retries may incur charges.',
    noEntries: 'No entries.', noRecall: 'No recall receipts.', noTasks: 'No background requests.',
    lastSummaryLine: 'Summary', dailyState: 'Daily status', lastDoneDay: 'Last completed day',
    backlogDays: 'Days pending', dailyPartialLine: 'Partial; unverified facts were excluded',
    dailyExcludedLine: 'Excluded', nextStepLabel: 'Next step', outputBytesLabel: 'Output bytes',
    finishKindLabel: 'Finish reason', verdictLabel: 'Output diagnosis',
    reasoningSpace: 'Generation limit reached without body text (possibly reasoning output)',
    daysProcessed: 'Days processed', none: 'None',
    activityTitle: 'Activity', activityToday: 'Added today', activityWeek: 'Added this week',
    activityRetained: 'Retained', activityEntries: 'entries', activityDay: 'Daily', activityWeekMode: 'Weekly',
    activityTotal: 'Cumulative', activityChart: 'Activity heatmap',
    activityRule: 'Rules', activityLesson: 'Lessons',
    activityDigest: 'Summaries',
    activityHistoryNote: 'Counts use retained entries and original creation dates. Deleted archive history cannot be recovered.',
    activityDetails: 'Counting details', activityImported: 'Imported entries',
    activityUnknown: 'Invalid creation dates', activityFuture: 'Future entries excluded',
    activityBeforeWindow: 'Before this year window', adaptiveCandidates: 'Adaptive candidates',
    activityCumulativeThrough: 'Cumulative through', activityColorLabel: 'Activity colour',
    activityColorMenu: 'Colour', activityThemeColor: 'Follow theme', activityVioletColor: 'Dusk violet',
    activityBlueColor: 'Lake blue', activityTealColor: 'Teal', activityAmberColor: 'Warm gold',
    activityRoseColor: 'Dusty rose', activityCustomColor: 'Custom colour…',
    activityDayTooltip: '{date} · {count} entries', activityWeekTooltip: '{start} — {end} · {count} entries',
    activityTotalTooltip: 'Cumulative through {date} · {count} entries',
    adaptiveNoCandidates: 'No candidates', adaptiveObserving: 'Observing', adaptiveApproved: 'Active',
    adaptiveIsolated: 'Disabled', adaptiveLegacy: 'Legacy policy (evidence not inherited)',
    adaptiveTarget: 'Target version', adaptiveSource: 'Source permission', adaptiveSourceYes: 'Valid',
    adaptiveSourceNo: 'Not admitted', adaptiveSourceUnknown: 'Unknown', adaptiveReplay: 'Replay',
    adaptiveGain: 'Independent hits', adaptiveControl: 'Unrelated controls', adaptiveBlockers: 'Current blockers',
    adaptiveSuccessor: 'A newer v2 policy exists; v1 evidence is not counted.',
    adaptiveTargetCurrent: 'Current version', adaptiveTargetChanged: 'Version changed',
    adaptiveTargetRetired: 'Retired', adaptiveTargetRevision: 'Needs revision',
  }
  // Activity chart patterns are adapted from Missher-DSH-Usage-Statistics; all data stays MSE-owned.
  const ACTIVITY_COLOR_KEY = 'dsh.mse-learning.activity-color.v1'
  const ACTIVITY_MODES = ['day', 'week', 'total']
  const ACTIVITY_COLOR_PRESETS = [
    { id: 'themeColor', color: '', label: 'activityThemeColor' },
    { id: 'violetColor', color: '#8b6ccf', label: 'activityVioletColor' },
    { id: 'blueColor', color: '#447fcb', label: 'activityBlueColor' },
    { id: 'tealColor', color: '#369f97', label: 'activityTealColor' },
    { id: 'amberColor', color: '#c69749', label: 'activityAmberColor' },
    { id: 'roseColor', color: '#ca758f', label: 'activityRoseColor' },
  ]
  function readActivityColor() {
    try {
      const value = globalThis.localStorage?.getItem(ACTIVITY_COLOR_KEY)
      return typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value) ? value.toLowerCase() : ''
    } catch { return '' }
  }
  function writeActivityColor(value) {
    try {
      if (value === '') globalThis.localStorage?.removeItem(ACTIVITY_COLOR_KEY)
      else globalThis.localStorage?.setItem(ACTIVITY_COLOR_KEY, value)
    } catch { /* Renderer storage can be unavailable; the current choice still works in memory. */ }
  }
  function activityCounts(rows) {
    return rows.reduce((sum, row) => ({ total: sum.total + row.total,
      rule: sum.rule + row.rule, lesson: sum.lesson + row.lesson, digest: sum.digest + row.digest }),
    { total: 0, rule: 0, lesson: 0, digest: 0 })
  }
  function activityColorLevel(value, maximum) {
    return value <= 0 || maximum <= 0 ? 0 : Math.min(5, Math.max(1, Math.ceil(5 * value / maximum)))
  }
  function projectActivityWeeks(activity, mode) {
    const selectedMode = ACTIVITY_MODES.includes(mode) ? mode : 'day'
    const baseline = { total: activity.beforeWindow?.total ?? 0,
      rule: activity.beforeWindow?.rule ?? 0, lesson: activity.beforeWindow?.lesson ?? 0,
      digest: activity.beforeWindow?.digest ?? 0 }
    let running = { ...baseline }
    const periods = activity.weeks.map(week => {
      const visibleDays = week.days.filter(Boolean)
      const visibleCounts = activityCounts(visibleDays)
      const weekSummary = activity.weekSummaries?.find(row => row.start === week.start)
      const counts = weekSummary === undefined ? visibleCounts : {
        total: weekSummary.total, rule: weekSummary.rule, lesson: weekSummary.lesson, digest: weekSummary.digest,
      }
      running = { total: running.total + visibleCounts.total, rule: running.rule + visibleCounts.rule,
        lesson: running.lesson + visibleCounts.lesson, digest: running.digest + visibleCounts.digest }
      const end = new Date(`${week.start}T00:00:00.000Z`)
      end.setUTCDate(end.getUTCDate() + 6)
      return { start: week.start, end: weekSummary?.end ?? end.toISOString().slice(0, 10),
        actualEnd: visibleDays.at(-1)?.date ?? null, sourceDays: week.days, visibleCounts, counts,
        cumulativeCounts: { ...running } }
    })
    const maximum = selectedMode === 'day'
      ? Math.max(0, ...periods.flatMap(period => period.sourceDays.filter(Boolean).map(day => day.total)))
      : selectedMode === 'week'
        ? Math.max(0, ...periods.map(period => period.counts.total))
        : Math.max(baseline.total, ...periods.map(period => period.cumulativeCounts.total))
    return periods.map(period => {
      const displayTotal = selectedMode === 'day' ? null
        : selectedMode === 'week' ? period.counts.total : period.cumulativeCounts.total
      const level = selectedMode === 'day' ? null : activityColorLevel(displayTotal, maximum)
      const filledRows = selectedMode === 'week'
        ? (displayTotal <= 0 || maximum <= 0 ? 0
          : Math.min(7, Math.max(1, Math.ceil(Math.log1p(displayTotal) / Math.log1p(maximum) * 7))))
        : selectedMode === 'total'
          ? (displayTotal <= 0 || maximum <= 0 ? 0
            : Math.min(7, Math.max(1, Math.ceil(displayTotal / maximum * 7)))) : 7
      const visibleRows = period.sourceDays.flatMap((day, row) => day === null ? [] : [row])
      const visibleRank = new Map(visibleRows.map((row, index) => [row, index]))
      const visibleFillCount = Math.min(filledRows, visibleRows.length)
      return { ...period, days: period.sourceDays.map((day, row) => {
        if (day === null) return null
        const dayLevel = selectedMode === 'day' ? activityColorLevel(day.total, maximum)
          : visibleRank.get(row) >= visibleRows.length - visibleFillCount ? level : 0
        return { ...day, displayTotal: selectedMode === 'day' ? day.total : displayTotal,
          level: dayLevel, periodStart: selectedMode === 'day' ? day.date : period.start,
          periodEnd: selectedMode === 'day' ? day.date
            : selectedMode === 'week' ? period.end : period.actualEnd ?? day.date }
      }) }
    })
  }
  function activityTooltipText(dict, mode, day) {
    const template = mode === 'day' ? dict.activityDayTooltip
      : mode === 'week' ? dict.activityWeekTooltip : dict.activityTotalTooltip
    const values = { date: day.periodEnd, start: day.periodStart, end: day.periodEnd,
      count: String(day.displayTotal) }
    return template.replace(/\{(date|start|end|count)\}/gu, (_, key) => values[key])
  }
  function activityColorSwatch(value) {
    return h('span', { className: 'mse-activity-color-swatch',
      style: { '--mse-activity-swatch': value || 'var(--dsw-alias-state-business-primary)' },
      'aria-hidden': true }, [h('i', { key: '1' }), h('i', { key: '2' }), h('i', { key: '3' })])
  }
  function ActivityColorPicker({ color, onChange, dict }) {
    const [open, setOpen] = React.useState(false)
    const input = React.useRef(null)
    const selected = ACTIVITY_COLOR_PRESETS.find(preset => preset.color === color)
    return h('div', { className: 'mse-activity-color-control' }, [
      h(Menu, { open, onClose: () => setOpen(false), portal: true, compact: true,
        selectedId: selected?.id ?? 'customColor', listClassName: 'mse-activity-color-menu',
        anchor: h('button', { type: 'button', className: 'mse-activity-color-trigger',
          'aria-label': dict.activityColorLabel, 'aria-haspopup': 'menu', 'aria-expanded': open,
          onClick: () => setOpen(value => !value) }, [activityColorSwatch(color),
          h('span', { key: 'label' }, dict.activityColorMenu),
          h('svg', { key: 'arrow', viewBox: '0 0 16 16', width: 12, height: 12,
            fill: 'none', 'aria-hidden': true }, h('path', { d: 'm4 6 4 4 4-4',
            stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))]),
        items: [...ACTIVITY_COLOR_PRESETS.map(preset => ({ id: preset.id,
          label: dict[preset.label], icon: activityColorSwatch(preset.color) })),
        { type: 'separator', id: 'custom-separator' },
        { id: 'customColor', label: dict.activityCustomColor, icon: activityColorSwatch(color) }],
        onSelect: id => {
          setOpen(false)
          if (id === 'customColor') input.current?.click()
          else {
            const preset = ACTIVITY_COLOR_PRESETS.find(item => item.id === id)
            if (preset !== undefined) onChange(preset.color)
          }
        } }),
      h('input', { key: 'custom', ref: input, className: 'mse-activity-color-input',
        type: 'color', tabIndex: -1, 'aria-label': dict.activityCustomColor,
        value: color || '#4d6bfe', onChange: event => onChange(event.currentTarget.value.toLowerCase()) }),
    ])
  }
  const TYPE_ZH = { rule: zh.typeRule, lesson: zh.typeLesson, digest: zh.typeDigest }
  const TYPE_EN = { rule: en.typeRule, lesson: en.typeLesson, digest: en.typeDigest }
  const STATUS_ZH = { user_rule: zh.statusActive, pending: '待验证', check_passed: zh.statusActive,
    needs_revision: '需修订', superseded: zh.statusSuperseded }
  const STATUS_EN = { user_rule: en.statusActive, pending: 'Pending review', check_passed: en.statusActive,
    needs_revision: 'Needs revision', superseded: en.statusSuperseded }
  const STORAGE_REASON_ZH = { invalid_memory: zh.storageInvalidMemory,
    invalid_store: zh.storageInvalidStore, state_unavailable: zh.storageUnavailable,
    invalid_state_root: zh.storageUnavailable, capacity: zh.storageCapacity,
    entry_capacity: zh.storageCapacity, durability_unconfirmed: zh.storageDurability,
    lock_busy: zh.storageBusy, ENOSPC: zh.storageCapacity, EIO: zh.storageUnavailable,
    EACCES: zh.storageUnavailable, EROFS: zh.storageUnavailable,
    transaction_async: zh.storageUnavailable, transaction_reentry: zh.storageUnavailable }
  // EVOLUTION016: fixed revision-reason vocabulary for the EXISTING entry detail rows.
  const REVISION_REASON_ZH = { matched_recurrence: '同类任务再次失败', matched_recurrence_late: '旧版晚到同类失败',
    check_failed: '检查未通过', check_failed_late: '旧版晚到检查未通过', check_passed: '检查通过',
    check_passed_late: '旧版晚到检查通过', legacy_superseded_partial: '升级前旧快照（部分资料）',
    user_correction: '用户纠正', retired: '停用' }
  const revisionReasonText = reason => REVISION_REASON_ZH[reason] ?? String(reason ?? '—')
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
    entry_capacity: '学习库条目已满，新条目已等待或拒收，现有条目保留',
    turn_facts_rejected: '回合事实写入被既有字段边界拒绝，不影响当前回合',
    temp_workspace_excluded: '临时工作区未采集',
    user_correction: '用户纠正停用',
    temporary_scope: '临时限定，不长期保存', model_uncertain: '长期性不确定，未保存',
    scope_uncertain: '范围不明，未保存', anchor_not_current: '当前原话锚点缺失，已拒绝',
    reference_not_found: '引用的前文不存在，已拒绝', reference_not_actual: '当前并未真正指代前文，已拒绝',
    reference_not_related: '引用的前文与当前对象无关，已拒绝',
    reference_not_provided: '当前指代前文但未提供有效引用，已拒绝',
    quoted_context_not_authority: '引用/日志前文不是授权，已拒绝',
    context_material_outside: '上下文引用外部文件，整条省略',
    context_too_long: '上下文单条过长，整条省略',
    context_total_exceeded: '上下文合计超限，整条省略',
    context_overflow: '上下文条数超限，整条省略',
    context_invalid: '上下文来源不明，整条省略',
    context_no_turn_boundary: '上下文缺少真实回合边界，整条省略',
    context_current_turn: '上下文属于当前回合，未作为前文' }
  // Readable basis vocabulary for the existing corrections status line. Unknown text (including
  // any model-provided basis) stays verbatim, bounded elsewhere by statusView.
  const BASIS_ZH = { current_message: '当前消息', scope_conservative_project: '范围保守按项目',
    legacy_intent: '旧意图格式', model_one_off: '模型判一次性', model_uncertain: '模型长期性不明',
    legacy_uncertain: '旧格式不确定', temporary_sentence: '临时句', structured_work_order: '单次工单',
    invalid_row: '异常模型行',
    project_without_attributed_cwd: '项目归属不明', scope_uncertain_no_project: '范围不明且无项目',
    invalid_rows: '异常模型行' }
  const basisTextOf = basis => String(basis ?? '').split(';').filter(Boolean).map(part => {
    const turn = part.match(/^context_turn_(.+)$/u)
    return turn === null ? (BASIS_ZH[part] ?? part) : `引用第${turn[1]}轮`
  }).join('；')
  const contextOmittedTextOf = value => String(value ?? '').split(',').filter(Boolean)
    .map(code => REASON_ZH[code] ?? code).join('；')
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
    entry_capacity: '学习库条目已满，新经验暂缓保存',
    background_error_unexpected: '后台学习暂时异常，请查看诊断记录', null: '—' }
  // MSE21: a REAL next step for a settled task (never a fake dash / generic failure).
  const NEXT_ZH = { in_flight: '调用中', retry_pending: '已知费用，待唯一重试',
    exhausted_needs_evidence: '已用尽，需新证据或人工审计', unknown_cost_hold: '未知费用持有，不会自动重放' }
  const WAIT_EN = { paused: 'Paused', in_flight: 'Another background task is running', busy: 'Foreground work is active',
    done_today: 'Summary already completed today', no_activity: 'Empty day skipped', no_route: 'No model route available',
    digest_sources_unverified: 'Daily sources could not be verified; skipped safely',
    digest_facts_filtered: 'Some unverified facts were excluded', source_unproven: 'Waiting for attributable evidence',
    digest_ledger_full: 'Daily ledger is full', reflection_truncation_exhausted: 'Output remained truncated; new evidence or review is needed',
    reflection_compaction_exhausted: 'Output could not fit; new evidence or review is needed',
    no_source_route: 'No route for the source session', same_material_needs_audited_retry: 'This material needs a manual audited retry',
    unknown_cost_never_auto_replayed: 'Unknown-cost call held; it will not be replayed',
    background_error_invalid_memory: 'Background result failed validation; check diagnostics', entry_capacity: 'Memory is full; new lessons are on hold',
    background_error_unexpected: 'Background learning failed; check diagnostics', null: '—' }
  const NEXT_EN = { in_flight: 'Running', retry_pending: 'One known-cost retry pending',
    exhausted_needs_evidence: 'No retries remain; new evidence or review is needed',
    unknown_cost_hold: 'Unknown-cost call held; no replay' }
  const OUTCOME_ZH = { completed: zh.outcomeCompleted, aborted: zh.outcomeAborted,
    verified: zh.outcomeVerified, failed: zh.outcomeFailed, cancelled: zh.outcomeCancelled,
    unknown: zh.outcomeUnknown }
  const RSI_STAGE_ZH = { admission: zh.rsiStageAdmission, probe: zh.rsiStageProbe,
    tool_result: zh.rsiStageToolResult, pending: zh.rsiStagePending, settled: zh.rsiStageSettled }
  const RSI_RESULT_ZH = { created: zh.rsiResultCreated, holdout_hit: zh.rsiResultHoldout,
    holdout_miss: zh.rsiResultMiss,
    negative_control: zh.rsiResultControl, approved: zh.rsiResultApproved,
    rejected: zh.rsiResultRejected, isolated: zh.rsiResultIsolated,
    unknown: zh.rsiResultUnknown, feature_refused: zh.rsiResultFeatureRefused }
  const RSI_REASON_ZH = { probe_created: zh.rsiReasonProbeCreated,
    failure_admitted: zh.rsiReasonFailureAdmitted, failure_duplicate: zh.rsiReasonFailureDuplicate,
    failure_rejected: zh.rsiReasonFailureRejected, source_refused: zh.rsiReasonSourceRefused,
    material_refused: zh.rsiReasonMaterialRefused, output_incomplete: zh.rsiReasonOutputIncomplete,
    cancelled: zh.rsiReasonCancelled, no_failure: zh.rsiReasonNoFailure,
    pending_signal: zh.rsiReasonPendingSignal, no_pending_signal: zh.rsiReasonNoPendingSignal,
    storage_unavailable: zh.rsiReasonStorageUnavailable, no_adaptive_decision: zh.rsiReasonNoDecision,
    unknown_outcome: zh.rsiReasonUnknownOutcome,
    unique_native_method_match: zh.rsiReasonUniqueNative,
    independent_same_objective: zh.rsiReasonIndependentSame,
    same_session_or_query: zh.rsiReasonSameSession, competing_method_failure: zh.rsiReasonCompeting,
    same_signature_recurrence: zh.rsiReasonRecurrence, native_checker_failure: zh.rsiReasonCheckerFailure,
    cancelled_or_unknown: zh.rsiReasonCancelledUnknown, source_revoked: zh.rsiReasonSourceRevoked,
    material_revoked: zh.rsiReasonMaterialRevoked, policy_stale: zh.rsiReasonPolicyStale,
    insufficient_safe_features: zh.rsiReasonInsufficientFeatures, already_tracked: zh.rsiReasonAlreadyTracked,
    candidate_not_additive: zh.rsiReasonNotAdditive,
    ambiguous_native_failure: zh.rsiReasonAmbiguousFailure,
    baseline_explains_failure: zh.rsiReasonBaselineExplains, stale_probe: zh.rsiReasonStaleProbe,
    probe_capacity: zh.rsiReasonProbeCapacity,
    independent_unmatched_objective: zh.rsiReasonUnmatchedObjective,
    condition_missed_same_objective: '条件未命中同一目标',
    incomparable_evidence: '候选历史不一致', round_not_selected: '本轮选择了其他候选',
    awaiting_negative_control: zh.rsiReasonAwaitingControl, strategy_disabled: zh.rsiReasonStrategyDisabled,
    revision_limit: zh.rsiReasonRevisionLimit, same_mechanism_rejected: zh.rsiReasonSameMechanism,
    counterexample_child: zh.rsiReasonCounterexampleChild }
  const RSI_REASON_EN = { probe_created: 'Real probe recorded', failure_admitted: 'Failure evidence accepted',
    failure_duplicate: 'Duplicate failure evidence', failure_rejected: 'Failure evidence rejected',
    source_refused: 'Source no longer admitted', material_refused: 'Material rejected',
    output_incomplete: 'Tool output incomplete', cancelled: 'Tool call cancelled', no_failure: 'No tool failure',
    pending_signal: 'Awaiting settlement', no_pending_signal: 'No pending signal', storage_unavailable: 'Memory unavailable',
    no_adaptive_decision: 'No adaptive decision', unknown_outcome: 'Outcome unknown',
    unique_native_method_match: 'Unique native failure match', independent_same_objective: 'Independent same-objective hit',
    condition_missed_same_objective: 'Same objective missed by this condition',
    incomparable_evidence: 'Candidate histories differ', round_not_selected: 'Another candidate won this round',
    same_session_or_query: 'Repeated session or query', competing_method_failure: 'Another method explains the failure',
    same_signature_recurrence: 'Same failure recurred', native_checker_failure: 'Native check failed',
    cancelled_or_unknown: 'Cancelled or unknown result', source_revoked: 'Source permission revoked',
    material_revoked: 'Material permission revoked', policy_stale: 'Policy version is stale',
    insufficient_safe_features: 'Insufficient safe features', already_tracked: 'Policy already tracked',
    candidate_not_additive: 'No added value', ambiguous_native_failure: 'Failure target is ambiguous',
    baseline_explains_failure: 'Baseline explains failure', stale_probe: 'Probe expired',
    probe_capacity: 'Probe capacity reached', independent_unmatched_objective: 'Objective did not match',
    awaiting_negative_control: 'Awaiting negative control', strategy_disabled: 'Strategy disabled',
    revision_limit: 'Revision limit reached', same_mechanism_rejected: 'Repeated revision mechanism',
    counterexample_child: 'Counterexample revision created' }
  // Chinese reads first; the original code stays in parentheses for tracing.
  const TERMINAL_ZH = { saved: '已保存', committed: '已入库', linked: '已关联', skipped: '已跳过',
    entry_capacity: '经验容量已满，新条目未保存',
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
  const TERMINAL_EN = { saved: 'Saved', committed: 'Committed', linked: 'Linked', skipped: 'Skipped',
    entry_capacity: 'Entry capacity reached; not saved', truncated: 'Output truncated',
    output_too_large: 'Output too large', attempt_aborted: 'Attempt aborted', invalid_result: 'Invalid output',
    model_unparseable: 'Output could not be parsed', connection_reset: 'Connection reset', timeout: 'Timed out',
    paused: 'Paused', aborted: 'Aborted', audit_retry_accepted: 'Audited retry accepted',
    same_material_needs_audited_retry: 'Manual audited retry required', unknown_cost: 'Unknown cost; held',
    invalid_lesson: 'Lesson failed validation', needs_compaction: 'Text exceeded limit',
    not_grounded_evidence: 'Output was not grounded in evidence', problem_not_reflectable: 'Problem cannot be reflected',
    revision_already_attempted: 'Evidence already tried', reflection_interrupted: 'Reflection interrupted',
    attempt_in_flight: 'Attempt already in flight', not_reviseable: 'Cannot revise', no_digest: 'No daily activity',
    failed: 'Failed', model_failed: 'Model call failed' }
  // Success/normal endings NEVER get a retry button; unknown cost never gets one either.
  const OK_TERMINALS = new Set(['saved', 'committed', 'linked', 'skipped', 'audit_retry_accepted'])
  const summaryText = (text, max = 96) => {
    const one = String(text ?? '').replace(/\s+/gu, ' ').trim()
    return one.length <= max ? one : `${one.slice(0, max)}…`
  }
  const atText = at => Number.isFinite(at) ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '—'

  const STYLE = `
.mse-details{display:flex;flex-direction:column;width:100%;min-width:0;container-type:inline-size;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.mse-details *{box-sizing:border-box}
.mse-details p{margin:0}
.mse-details[data-mse-surface="settings"]{height:100%;min-height:0}
.mse-details .mse-toolbar{flex:none;padding:3px 2px 12px}
.mse-details .mse-heading{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;min-height:36px;margin-bottom:12px}
.mse-details .mse-heading-title{display:flex;align-items:center;gap:10px;min-width:0}
.mse-details h1{margin:0;font-size:20px;line-height:28px;font-weight:600;white-space:nowrap}
.mse-details .mse-status{display:inline-flex;align-items:center;gap:5px;min-width:0;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.mse-details .mse-status span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mse-details .mse-status[data-unavailable="true"]{color:var(--dsw-alias-state-error-primary)}
.mse-details .mse-heading-action{min-width:64px}
.mse-details .mse-pane{min-width:0;padding:4px 2px 8px}
.mse-details .mse-pane:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px;border-radius:8px}
.mse-details[data-mse-surface="settings"]>.mse-pane{flex:1 1 auto;min-height:0;overflow-y:auto;scrollbar-gutter:stable;overscroll-behavior-y:contain}
.mse-details .mse-pane>.mse-section-title:first-child{margin-top:2px}
.mse-details .mse-panel-message,.mse-details .mse-empty{padding:12px 14px;border-radius:10px;background:var(--dsw-alias-bg-module-platform)}
.mse-details .mse-empty{color:var(--dsw-alias-label-secondary);font-size:13px}
.mse-details .mse-panel-message{margin-bottom:12px}
.mse-details .mse-control-list{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:0 14px;background:var(--dsw-alias-bg-layer-3)}
.mse-details .mse-settings>.mse-section-title{margin:16px 0 6px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.mse-details .mse-settings>.mse-section-title:first-child{margin-top:0}
.mse-details .mse-settings>.mse-control-list+.mse-control-list{margin-top:12px}
.mse-details .mse-control-list>.mse-row,.mse-details .mse-control-list>.mse-disclosure>summary{min-height:46px;padding-block:8px}
.mse-details .mse-control-list>.mse-disclosure:last-child{border-bottom:0}
.mse-details .mse-row { display: flex; gap: 20px; align-items: center; padding: 10px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); min-width: 0; }
.mse-details .mse-row-top{align-items:flex-start}
.mse-details .mse-row-stacked{display:block}
.mse-details .mse-row-stacked .mse-row-side{display:flex;flex:initial;width:100%;justify-content:flex-start;flex-wrap:wrap;gap:8px 18px;max-width:100%;margin-top:8px;white-space:normal;overflow-wrap:anywhere}
.mse-details .mse-row:last-child{border-bottom:none}
.mse-details .mse-row-main{flex:1;min-width:0}
.mse-details .mse-row-title{font-weight:400;line-height:22px;overflow-wrap:anywhere}
.mse-details .mse-hint{font-size:13px;color:var(--dsw-alias-label-secondary);line-height:22px;margin-top:4px;overflow-wrap:anywhere}
.mse-details .mse-row-side{flex:none;min-width:0;display:flex;align-items:center;justify-content:flex-end;gap:8px;font-size:13px}
.mse-details .mse-settings .mse-row-side{max-width:65%}
.mse-details .mse-settings .mse-picker{width:7rem}
.mse-details .mse-settings .mse-picker-trigger{width:100%}
.mse-details .mse-setting-number{width:70px;min-width:0;font-variant-numeric:tabular-nums}
.mse-details .mse-setting-text{width:218px;max-width:100%;min-width:0}
.mse-details .mse-settings-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}
.mse-details .mse-settings .mse-detail-body>.mse-hint{margin-top:8px}
.mse-details .mse-unit{color:var(--dsw-alias-label-tertiary);font-size:12px}
.mse-details .mse-section-title{margin:20px 0 8px;font-size:15px;line-height:22px;color:var(--dsw-alias-label-primary);font-weight:600;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;min-width:0}
.mse-details .mse-count{font-size:12px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);padding-inline:7px;border-radius:8px;background:var(--dsw-alias-bg-module-platform)}
.mse-details .mse-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:0 0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3)}
.mse-details .mse-metrics>div{padding:10px 12px;min-width:0;overflow-wrap:anywhere}
.mse-details .mse-metrics>div+div{border-inline-start:1px solid var(--dsw-alias-border-l2)}
.mse-details .mse-metrics-2{grid-template-columns:repeat(2,minmax(0,1fr))}
.mse-details .mse-statline{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding:10px 0;font-size:13px;line-height:22px}
.mse-details .mse-statline b{font-size:14px;font-weight:500;font-variant-numeric:tabular-nums}
.mse-details .mse-metric-label{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:5px}
.mse-details .mse-metric-value{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.mse-details .mse-metric-value b{font-size:20px;line-height:28px;font-weight:500;font-variant-numeric:tabular-nums}
.mse-details .mse-metric-value span{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.mse-details .mse-disclosure{border-bottom:0.5px solid var(--dsw-alias-border-l2);min-width:0}
.mse-details .mse-disclosure>summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:pointer;padding:11px 0;font-size:14px;line-height:22px}
.mse-details .mse-disclosure>summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px;border-radius:6px}
.mse-details .mse-summary{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.mse-details .mse-meta{flex:none;display:inline-flex;gap:10px;align-items:center;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:normal;flex-wrap:wrap;justify-content:flex-end}
.mse-details .mse-summary-stack{display:flex;flex-direction:column;gap:4px;align-items:flex-start}
.mse-details .mse-summary-stack .mse-summary-line{font-size:14px;line-height:22px}
.mse-details .mse-summary-stack .mse-meta{justify-content:flex-start;width:100%}
.mse-details .mse-meta>span{white-space:nowrap}
.mse-details .mse-detail-text{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);margin-bottom:12px;overflow-wrap:anywhere;white-space:pre-line}
.mse-details .mse-disclosure>summary::-webkit-details-marker{display:none}
.mse-details .mse-chevron{width:14px;height:14px;flex:none;color:var(--dsw-alias-label-tertiary)}
.mse-details .mse-disclosure[open]>summary .mse-chevron{transform:rotate(90deg)}
.mse-details .mse-detail-body{padding:0 0 16px;min-width:0}
.mse-details .mse-definition{display:grid;grid-template-columns:minmax(90px,auto) minmax(0,1fr);gap:10px 20px;margin:0;font-size:12px;line-height:20px}
.mse-details .mse-definition dt{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.mse-details .mse-definition dd{margin:0;text-align:right;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.mse-details .mse-definition.mse-left dd{text-align:left}
.mse-details .mse-picker{display:inline-flex;flex:none;min-width:0;max-width:100%}
.mse-details .mse-picker-trigger{max-width:100%;justify-content:space-between;gap:8px}
.mse-details .mse-picker-label { flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: center; }
.mse-details .mse-picker-chevrons{flex:none;color:var(--dsw-alias-label-tertiary)}
.mse-details .mse-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:20px;overflow-wrap:anywhere}
.mse-details .mse-notice{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;min-height:20px;overflow-wrap:anywhere}
.mse-details .mse-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}
.mse-details .mse-lessons-heading{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,320px)}
.mse-details .mse-filters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;min-width:0}
.mse-details .mse-filters .mse-picker,.mse-details .mse-filters .mse-picker-trigger{width:100%}
.mse-details .mse-activity-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:0;overflow:hidden;border:0.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3)}
.mse-details .mse-activity-metric{display:flex;min-width:0;flex-direction:column;align-items:center;padding:8px 6px;text-align:center}
.mse-details .mse-activity-metric+.mse-activity-metric{border-left:0.5px solid var(--dsw-alias-border-l2)}
.mse-details .mse-activity-metric dt,.mse-details .mse-activity-metric dd{max-width:100%;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mse-details .mse-activity-metric dd{font-size:14px;line-height:21px;font-weight:500;font-variant-numeric:tabular-nums}
.mse-details .mse-activity-metric dt{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.mse-details .mse-activity-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:14px 0;min-width:0}
.mse-details .mse-activity-color-control{position:relative;display:flex;min-width:0}
.mse-details .mse-activity-color-trigger{display:inline-flex;align-items:center;gap:5px;min-height:30px;padding:5px 8px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:16px;cursor:pointer}
.mse-details .mse-activity-color-trigger:hover,.mse-details .mse-activity-color-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mse-details .mse-activity-color-swatch{display:inline-flex;align-items:center;gap:2px}
.mse-details .mse-activity-color-swatch i{width:4px;height:11px;border-radius:2px;background:var(--mse-activity-swatch)}
.mse-details .mse-activity-color-swatch i:first-child{opacity:.35}
.mse-details .mse-activity-color-swatch i:nth-child(2){opacity:.65}
.mse-details .mse-activity-color-menu{min-width:176px;border-radius:20px}
.mse-details .mse-activity-color-input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.mse-details .mse-activity-color-trigger:focus-visible,.mse-details .mse-activity-tabs button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.mse-details .mse-activity-tabs{display:inline-flex;flex:none;max-width:100%;gap:2px;padding:3px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover)}
.mse-details .mse-activity-tabs button{min-width:0;min-height:28px;padding:4px 10px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;line-height:18px;white-space:nowrap;cursor:pointer}
.mse-details .mse-activity-tabs button[aria-selected="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.mse-details .mse-activity-chart-panel,.mse-details .mse-activity-chart{width:100%;min-width:0}
.mse-details .mse-activity-chart{margin:0}
.mse-details .mse-activity-stage{position:relative;width:100%;min-width:0}
.mse-details .mse-activity-tooltip{position:absolute;z-index:2;top:-28px;left:var(--mse-activity-tooltip-x);max-width:calc(100% - 8px);overflow:hidden;transform:translateX(-50%);border:0;border-radius:8px;padding:5px 9px;background:var(--dsw-alias-bg-layer-3);box-shadow:var(--dsw-shadow-lv1);color:var(--dsw-alias-label-primary);font-size:11px;line-height:18px;pointer-events:none;text-overflow:ellipsis;white-space:nowrap}
.mse-details .mse-activity-tooltip[data-edge="left"]{left:0;transform:none}
.mse-details .mse-activity-tooltip[data-edge="right"]{right:0;left:auto;transform:none}
.mse-details .mse-activity-grid{display:grid;grid-template-columns:repeat(var(--mse-activity-weeks),minmax(0,1fr));grid-template-rows:repeat(7,minmax(0,1fr));grid-auto-flow:column;gap:3px;width:100%;min-width:0}
.mse-details .mse-activity-week{display:contents}
.mse-details .mse-activity-day{display:block;appearance:none;width:100%;height:auto;min-width:0;min-height:0;aspect-ratio:1;padding:0;border:0;border-radius:2px;background:var(--dsw-alias-bg-skeleton);font-size:0;line-height:0;cursor:pointer}
.mse-details .mse-activity-day[data-level="1"]{background:oklch(from var(--mse-activity-color,var(--dsw-alias-state-business-primary)) .89 calc(c * .35) h)}
.mse-details .mse-activity-day[data-level="2"]{background:oklch(from var(--mse-activity-color,var(--dsw-alias-state-business-primary)) .78 calc(c * .55) h)}
.mse-details .mse-activity-day[data-level="3"]{background:oklch(from var(--mse-activity-color,var(--dsw-alias-state-business-primary)) .67 calc(c * .75) h)}
.mse-details .mse-activity-day[data-level="4"]{background:oklch(from var(--mse-activity-color,var(--dsw-alias-state-business-primary)) .56 calc(c * .9) h)}
.mse-details .mse-activity-day[data-level="5"]{background:oklch(from var(--mse-activity-color,var(--dsw-alias-state-business-primary)) .45 c h)}
.mse-details .mse-activity-day[aria-pressed="true"]{outline:2px solid var(--dsw-alias-label-primary);outline-offset:1px}
.mse-details .mse-activity-day:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;z-index:1}
.mse-details .mse-activity-empty{display:block;width:100%;min-width:0;aspect-ratio:1;background:transparent}
.mse-details .mse-activity-months{display:grid;grid-template-columns:repeat(var(--mse-activity-weeks),minmax(0,1fr));column-gap:3px;width:100%;min-width:0;margin-top:7px;color:var(--dsw-alias-label-tertiary);font-size:9px;line-height:14px;text-align:left}
.mse-details .mse-activity-months span{min-width:0;overflow:hidden;white-space:nowrap}
.mse-details .mse-activity-months span.mse-activity-month-final{min-width:max-content;overflow:visible;justify-self:end}
.mse-details .mse-activity-history{margin:0 0 12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;overflow-wrap:anywhere}
@container(max-width:500px){
.mse-details .mse-lessons-heading{grid-template-columns:minmax(0,1fr)}
}
@container(max-width:450px){
.mse-details .mse-row { gap: 12px; padding: 10px 0; }
.mse-details .mse-metrics>div{padding:10px}
.mse-details .mse-disclosure>summary>.mse-meta{max-width:45%}
.mse-details .mse-meta>span{white-space:normal;overflow-wrap:anywhere}
.mse-details .mse-definition{grid-template-columns:minmax(70px,auto) minmax(0,1fr);gap:8px 12px}
.mse-details .mse-activity-grid,.mse-details .mse-activity-months{column-gap:2px}
}
@container(max-width:300px){
.mse-details .mse-settings .mse-row{align-items:flex-start;flex-direction:column;gap:4px}
.mse-details .mse-settings .mse-row-side{width:100%;max-width:100%;justify-content:flex-start}
.mse-details .mse-setting-text{width:100%}
.mse-details .mse-activity-header{flex-wrap:wrap;gap:6px}
}
.mse-details .mse-picker-trigger { position: relative; justify-content: center; padding-inline: 28px; }
.mse-details .mse-picker-chevrons { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); }
.mse-details .mse-picker-wide{width:100%}
.mse-details .mse-tabs-host button[role="tab"][aria-haspopup="menu"]{width:100%;padding-inline:12px 32px}
.mse-details .mse-tabs-host button[role="tab"][aria-haspopup="menu"] .mse-picker-label{text-align:left}
.mse-details input:not([type=checkbox]) { text-align: center; line-height: 30px; }
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
      open, portal: true, compact: true, align: 'end', minWidthFromAnchor: true,
      className: `mse-picker ${className}`.trim(),
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

  function settingsTabNavigation(tab, onChange, dict, compact, idPrefix = 'mse') {
    if (compact) return h('div', { role: 'tablist', 'aria-label': dict.settingsTitle },
      h(Picker, { label: tabLabel(tab, dict), value: tab,
        options: TABS.map(id => ({ id, label: tabLabel(id, dict) })), onChange,
        testId: 'settings-tabs-compact', className: 'mse-picker-wide',
        triggerProps: { id: `${idPrefix}-tab-${tab}`, role: 'tab', 'aria-selected': true,
          'aria-controls': `${idPrefix}-pane-${tab}` } }))
    return h(SegmentedTabs, { label: dict.settingsTitle, value: tab, onChange,
      items: TABS.map(id => ({ value: id, id: `${idPrefix}-tab-${id}`, panelId: `${idPrefix}-pane-${id}`,
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
    const [snapshot, setSnapshot] = React.useState(() => form?.getSnapshot() ?? null)
    React.useEffect(() => {
      if (form === undefined || form === null) return undefined
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
    const dict = locale === 'en' ? { ...zh, ...en } : zh
    const dateText = at => Number.isFinite(at) ? new Date(at).toLocaleString(
      locale === 'en' ? 'en-US' : 'zh-CN', { hour12: false }) : '—'
    const colon = locale === 'en' ? ': ' : '：'
    const listSeparator = locale === 'en' ? ', ' : '、'
    const typeLabels = locale === 'en' ? TYPE_EN : TYPE_ZH
    const statusLabels = locale === 'en' ? STATUS_EN : STATUS_ZH
    const storageReasonLabels = locale === 'en' ? { ...STORAGE_REASON_ZH,
      invalid_memory: en.storageInvalidMemory, invalid_store: en.storageInvalidStore,
      state_unavailable: en.storageUnavailable, invalid_state_root: en.storageUnavailable,
      capacity: en.storageCapacity, entry_capacity: en.storageCapacity,
      durability_unconfirmed: en.storageDurability, lock_busy: en.storageBusy,
      ENOSPC: en.storageCapacity, EIO: en.storageUnavailable, EACCES: en.storageUnavailable,
      EROFS: en.storageUnavailable, transaction_async: en.storageUnavailable,
      transaction_reentry: en.storageUnavailable } : STORAGE_REASON_ZH
    const waitLabels = locale === 'en' ? WAIT_EN : WAIT_ZH
    const nextLabels = locale === 'en' ? NEXT_EN : NEXT_ZH
    const kindLabels = locale === 'en' ? { reflect: en.taskKindReflect, revise: en.taskKindRevise,
      digest: en.taskKindDigest, extract: en.taskKindExtract } : KIND_ZH
    const outcomeLabels = locale === 'en' ? { completed: en.outcomeCompleted, aborted: en.outcomeAborted,
      verified: en.outcomeVerified, failed: en.outcomeFailed, cancelled: en.outcomeCancelled,
      unknown: en.outcomeUnknown } : OUTCOME_ZH
    const stageLabels = locale === 'en' ? { admission: en.rsiStageAdmission, probe: en.rsiStageProbe,
      tool_result: en.rsiStageToolResult, pending: en.rsiStagePending, settled: en.rsiStageSettled } : RSI_STAGE_ZH
    const resultLabels = locale === 'en' ? { created: en.rsiResultCreated, holdout_hit: en.rsiResultHoldout,
      holdout_miss: en.rsiResultMiss,
      negative_control: en.rsiResultControl, approved: en.rsiResultApproved, rejected: en.rsiResultRejected,
      isolated: en.rsiResultIsolated, unknown: en.rsiResultUnknown,
      feature_refused: en.rsiResultFeatureRefused } : RSI_RESULT_ZH
    const rsiReasonLabels = locale === 'en' ? RSI_REASON_EN : RSI_REASON_ZH
    const terminalLabel = code => locale === 'en'
      ? code === null || code === undefined ? null : TERMINAL_EN[code] ?? code : terminalZh(code)
    const reasonLabels = locale === 'en' ? { ...REASON_ZH, no_correction: 'Not a reusable correction',
      one_off: 'One-off adjustment', uncertain: 'Durability is uncertain', generic_advice: 'Generic advice rejected',
      negation_or_scope_dropped: 'Negation or scope was lost; rejected', evidence_not_verbatim: 'Evidence did not match the original wording',
      invalid_result: 'Invalid output; rejected', duplicate: 'Duplicate; not saved again', unknown_cost: 'Unknown cost; held without replay',
      extract_invalid: 'Invalid extraction; rejected', session_unattributed: 'Session is not in a registered workspace',
      registry_unavailable: 'Workspace registry is unavailable', turn_material_outside: 'Turn referenced an external file',
      material_outside_reference: 'Material referenced an external file', tool_material_outside: 'Tool material referenced an external path',
      tool_output_outside: 'Failure output referenced an external path', source_unverified: 'Source could not be verified',
      material_unverified: 'External material could not be verified', store_unavailable: 'Memory is unavailable; write skipped',
      entry_capacity: 'Memory is full; entry was held or rejected', user_correction: 'Rule retired after user correction',
      temporary_scope: 'Temporary scope; not saved as a rule', model_uncertain: 'Durability uncertain; not saved',
      scope_uncertain: 'Scope unclear; not saved' } : REASON_ZH
    const revisionLabels = locale === 'en' ? { matched_recurrence: 'Similar failure recurred',
      matched_recurrence_late: 'Late similar failure', check_failed: 'Check failed',
      check_failed_late: 'Late check failure', check_passed: 'Check passed',
      check_passed_late: 'Late check pass', legacy_superseded_partial: 'Legacy snapshot was partial',
      user_correction: 'User correction', retired: 'Retired' } : REVISION_REASON_ZH
    const basisLabels = locale === 'en' ? { current_message: 'Current message',
      scope_conservative_project: 'Conservative project scope', legacy_intent: 'Legacy intent',
      model_one_off: 'Model judged one-off', model_uncertain: 'Model judged uncertain',
      legacy_uncertain: 'Legacy uncertain', temporary_sentence: 'Temporary wording', structured_work_order: 'One-off work order',
      invalid_row: 'Invalid model row', project_without_attributed_cwd: 'Project attribution unknown',
      scope_uncertain_no_project: 'Scope unclear; no project', invalid_rows: 'Invalid model rows' } : BASIS_ZH
    const basisText = value => String(value ?? '').split(';').filter(Boolean).map(part => {
      const turn = part.match(/^context_turn_(.+)$/u)
      return turn === null ? (basisLabels[part] ?? part) : `${locale === 'en' ? 'Turn ' : '引用第'}${turn[1]}${locale === 'en' ? '' : '轮'}`
    }).join(locale === 'en' ? '; ' : '；')
    const contextOmittedText = value => String(value ?? '').split(',').filter(Boolean)
      .map(code => reasonLabels[code] ?? code).join(locale === 'en' ? '; ' : '；')
    const call = props.call
    const control = props.control
    const form = props.form
    const surface = props.surface ?? 'settings'
    const idPrefix = surface === 'settings' ? 'mse' : 'mse-bundle'
    const [tab, setTab] = React.useState(props.initialTab ?? 'overview')
    const [compactTabs, setCompactTabs] = React.useState(false)
    const tabsHost = React.useRef(null)
    const [reloadToken, setReloadToken] = React.useState(0)
    const [filter, setFilter] = React.useState({ type: '', status: '' })
    const [openEntry, setOpenEntry] = React.useState(null)
    const [activityMode, setActivityMode] = React.useState('day')
    const [activityDate, setActivityDate] = React.useState(null)
    const [activityColor, setActivityColorState] = React.useState(readActivityColor())
    const [activityTooltip, setActivityTooltip] = React.useState(null)
    const activityTabRefs = React.useRef([])
    const [shell, setShell] = React.useState({ status: 'loading', value: null, error: null })
    // Three-state like the original: "we could not read it" is NOT "it is running".
    const [controlState, setControlState] = React.useState({ status: 'unknown', paused: null })
    const [wakeDraft, setWakeDraft] = React.useState(null)
    const [modelDraft, setModelDraft] = React.useState(null)
    const [saveState, setSaveState] = React.useState(null)
    const generation = React.useRef(0)
    const formSnapshot = useFormSnapshot(form)
    const reading = shell.status === 'loading'
    const reloadStatus = () => {
      setShell(current => ({ ...current, status: 'loading' }))
      setReloadToken(current => current + 1)
    }

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
      setShell(current => current.status === 'loading' ? current : { ...current, status: 'loading' })
      void (async () => {
        try {
          const business = await callRemote(call, 'status')
          if (generation.current !== mine) return
          const view = business.view
          if (view == null) throw new Error(dict.statusUnreadable)
          if (view.storage?.available === false) {
            setShell({ status: 'error', value: null,
              error: storageReasonLabels[view.storage.reason] ?? dict.statusUnreadable })
            setControlState({ status: 'unknown', paused: null })
          } else {
            setShell({ status: 'ready', value: view, error: null })
            setControlState({ status: 'ready', paused: view.paused === true })
          }
        } catch (error) {
          if (generation.current !== mine) return
          setShell(current => ({ ...current, status: 'error', error: String(error?.message ?? error) }))
          setControlState({ status: 'unknown', paused: null })
        }
      })()
    }, [call, reloadToken])

    // Settings writes go through the REAL ConfigForm with its revision fence: one atomic
    // mutate(ops, revision); a refusal re-reads the truth instead of faking the switch.
    const mutateSettings = async values => {
      const snapshot = form?.getSnapshot?.() ?? null
      if (snapshot === null || snapshot.status !== 'ready' || snapshot.writable === false) {
        setSaveState({ kind: 'error', detail: dict.settingsSaveFailed })
        return false
      }
      const ops = Object.entries(values)
        .filter(([field, value]) => snapshot.value?.[field] !== value)
        .map(([field, value]) => ({ op: 'set', path: [field], value }))
      if (ops.length === 0) return true
      setSaveState({ kind: 'saving' })
      try {
        const ok = await form.mutate(ops, snapshot.revision)
        if (ok !== true) throw new Error('refused')
        setSaveState(null)
        return true
      } catch {
        setSaveState({ kind: 'error', detail: dict.settingsSaveFailed })
        reloadStatus()
        return false
      }
    }
    const settings = formSnapshot?.status === 'ready' ? formSnapshot.value : null
    const saving = saveState?.kind === 'saving'
    const canEdit = settings !== null && settings !== undefined && formSnapshot.writable !== false && !saving
    const learningOn = settings == null ? null
      : settings.enabled !== false && settings.reflectionEnabled !== false
    const effectiveStatus = learningOn === false ? dict.effectiveOff
      : controlState.paused === true ? dict.effectivePaused : dict.effectiveRunning
    const setLearning = next => {
      const values = next && settings?.reflectionEnabled === false
        ? { enabled: true, reflectionEnabled: true } : { enabled: next }
      return mutateSettings(values)
    }

    const togglePause = async () => {
      if (reading || controlState.status !== 'ready') return
      const next = !(controlState.paused === true)
      setControlState({ ...controlState, status: 'updating' })
      try {
        const result = await callRemote(control, 'pause', { paused: next })
        setControlState({ status: 'ready', paused: result.paused === true })
        setSaveState(null)
      } catch (error) {
        setSaveState({ kind: 'error', detail: reasonLabels[error?.message] ?? dict.settingsSaveFailed })
        setControlState({ status: 'unknown', paused: null })
        reloadStatus()
      }
    }
    const savedInterval = settings == null ? null : (settings.wakeIntervalMs ?? 600_000)
    const saveWake = async () => {
      const minutes = Number(wakeDraft)
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) {
        setSaveState({ kind: 'error', detail: dict.invalidWake })
        return
      }
      if (await mutateSettings({ wakeIntervalMs: Math.round(minutes * 60_000) })) setWakeDraft(null)
    }
    const savedModel = {
      modelProvider: settings?.modelProvider ?? '',
      modelId: settings?.modelId ?? '',
      reasoningEffort: settings?.reasoningEffort ?? '',
    }
    const model = modelDraft ?? savedModel
    const editModel = (field, value) => setModelDraft(current => ({ ...(current ?? savedModel), [field]: value }))
    const saveModel = async () => {
      const provider = model.modelProvider.trim()
      const id = model.modelId.trim()
      if ((provider === '') !== (id === '')) {
        setSaveState({ kind: 'error', detail: dict.invalidModel })
        return
      }
      if (provider.length > 32 || id.length > 64 || /[\u0000-\u001f\u007f]/u.test(provider + id)) {
        setSaveState({ kind: 'error', detail: dict.modelLimit })
        return
      }
      if (await mutateSettings({ modelProvider: provider, modelId: id,
        reasoningEffort: id === '' ? '' : model.reasoningEffort })) setModelDraft(null)
    }
    const auditedRetry = async ticket => {
      if (reading || shell.error !== null) return
      try { await callRemote(control, 'retryRequest', { ticket }) }
      catch (error) { setSaveState({ kind: 'error', detail: String(error?.message ?? error) }) }
      reloadStatus()
    }

    const view = shell.value
    const dailyBacklog = view?.daily?.backlog ?? []
    const dailyPartial = (view?.daily?.daysProcessed ?? []).filter(item => item.partial)

    // ── 常规 ──────────────────────────────────────────────────────────────────────────────
    const legacyRecallBytes = settings?.maxContextBytes ?? 768
    const configuredRecallTokens = settings?.maxContextTokens
    const recallTokenLimit = Number.isSafeInteger(configuredRecallTokens)
      && configuredRecallTokens >= 128 && configuredRecallTokens <= 1024
      ? configuredRecallTokens : legacyRecallBytes >= 768 ? 512 : null
    const recallValue = recallTokenLimit === null ? `bytes:${legacyRecallBytes}` : `tokens:${recallTokenLimit}`
    const recallChoices = [...new Set([128, 256, 384, 512, 640, 768, 896, 1024,
      ...(recallTokenLimit === null ? [] : [recallTokenLimit])])].sort((a, b) => a - b).map(tokens => ({
      id: `tokens:${tokens}`, label: `${tokens} ${dict.recallTokenEstimate}`,
    }))
    if (recallTokenLimit === null) recallChoices.unshift({ id: `bytes:${legacyRecallBytes}`,
      label: `${legacyRecallBytes} B · ${dict.recallLegacyBytes}` })
    const clockChoices = Array.from({ length: 24 }, (_, hour) => ({
      id: String(hour), label: `${String(hour).padStart(2, '0')}:00`,
    }))
    const runtimeSettings = tab === 'overview' ? [
      h('h2', { key: 'runtime-group', className: 'mse-section-title' }, dict.runtimeGroup),
      h('div', { key: 'learning-settings', className: 'mse-control-list' }, [
        row('enabled', dict.learning, null,
          h(Switch, { key: 'sw', label: dict.learning, checked: learningOn === true,
            disabled: !canEdit, onChange: setLearning })),
        row('pause', dict.pauseControl, null,
          h(Button, { key: 'b', variant: 'outline', size: 'sm', onClick: togglePause,
            disabled: reading || controlState.status !== 'ready' },
            controlState.paused === true ? dict.resume : dict.pause)),
      ]),
      h('h2', { key: 'schedule-group', className: 'mse-section-title' }, dict.scheduleGroup),
      h('div', { key: 'schedule-settings', className: 'mse-control-list' }, [
        row('wake', dict.wakeInterval, null, [
          h(Input, { key: 'i', type: 'number', min: 1, max: 60, step: 'any', inputMode: 'decimal',
            className: 'mse-setting-number', 'aria-label': dict.wakeInterval,
            value: wakeDraft ?? (savedInterval === null ? '' : String(savedInterval / 60_000)),
            disabled: !canEdit, onChange: event => setWakeDraft(event.currentTarget.value) }),
          h('span', { key: 'u', className: 'mse-unit' }, dict.minuteUnit),
          h(Button, { key: 'b', variant: 'outline', size: 'sm', onClick: saveWake,
            'aria-label': `${dict.saveSetting} · ${dict.wakeInterval}`,
            disabled: !canEdit || wakeDraft === null }, dict.saveSetting),
        ]),
        row('daily-hour', dict.dailyHour, null,
          h(Picker, { label: dict.dailyHour, value: String(settings?.dailyHour ?? 23), options: clockChoices,
            testId: 'daily-hour', disabled: !canEdit,
            triggerProps: { title: dict.dailyLocalTime, 'aria-description': dict.dailyLocalTime },
            onChange: value => mutateSettings({ dailyHour: Number(value) }) })),
        row('recall-limit', dict.recallBytes, null,
          h(Picker, { label: dict.recallBytes, value: recallValue, options: recallChoices,
            testId: 'recall-limit', disabled: !canEdit,
            onChange: value => String(value).startsWith('tokens:')
              ? mutateSettings({ maxContextTokens: Number(String(value).slice(7)) })
              : mutateSettings({ maxContextBytes: Number(String(value).slice(6)), maxContextTokens: null }) })),
      ]),
      h('div', { key: 'advanced-settings', className: 'mse-control-list' }, [
        disclosure('background-model', dict.modelSettings, [
          row('provider', dict.modelProvider, null, h(Input, { key: 'i', className: 'mse-setting-text',
            'aria-label': dict.modelProvider, value: model.modelProvider, maxLength: 32,
            disabled: !canEdit, onChange: event => editModel('modelProvider', event.currentTarget.value) })),
          row('model', dict.modelId, null, h(Input, { key: 'i', className: 'mse-setting-text',
            'aria-label': dict.modelId, value: model.modelId, maxLength: 64,
            disabled: !canEdit, onChange: event => editModel('modelId', event.currentTarget.value) })),
          row('effort', dict.reasoningEffort, null, h(Picker, { label: dict.reasoningEffort,
            value: model.reasoningEffort, options: [{ id: '', label: dict.defaultEffort },
              { id: 'low', label: dict.effortLow }, { id: 'medium', label: dict.effortMedium },
              { id: 'high', label: dict.effortHigh }],
            testId: 'reasoning-effort', disabled: !canEdit || model.modelId.trim() === '',
            onChange: value => editModel('reasoningEffort', value) })),
          h('p', { key: 'note', className: 'mse-hint' }, dict.modelNote),
          h('div', { key: 'actions', className: 'mse-settings-actions' }, [
            h(Button, { key: 'cancel', variant: 'ghost', size: 'sm',
              disabled: saving || modelDraft === null,
              onClick: () => { setModelDraft(null); setSaveState(null) } }, dict.cancelSetting),
            h(Button, { key: 'save', variant: 'outline', size: 'sm', disabled: !canEdit || modelDraft === null,
              'aria-label': `${dict.saveSetting} · ${dict.modelSettings}`, onClick: saveModel }, dict.saveSetting),
          ]),
        ], { id: 'background-model', meta: settings == null ? '—'
          : savedModel.modelProvider && savedModel.modelId ? summaryText(savedModel.modelId, 32) : dict.modelFromSource }),
        disclosure('more-how', dict.moreSection, h('p', { className: 'mse-hint' }, dict.moreHow),
          { id: 'more-how' }),
      ]),
    ] : null
    const overviewPanel = tab === 'overview' ? h(React.Fragment, { key: 'overview' }, [
      h('div', { key: 'settings', className: 'mse-settings', 'aria-busy': saving }, runtimeSettings),
      view?.daily?.lastSummary?.summary || dailyBacklog.length > 0 || dailyPartial.length > 0
        ? h('h2', { key: 'sec', className: 'mse-section-title' }, dict.dailySection) : null,
      view === null || (dailyBacklog.length === 0 && dailyPartial.length === 0) ? null
        : disclosure('daily-detail', `${dict.backlogDays} · ${dailyBacklog.length + dailyPartial.length}`,
          definition('daily-audit', [
            [dict.backlogDays, dailyBacklog.length === 0 ? dict.none : dailyBacklog.join(listSeparator)],
            dailyPartial.length === 0 ? null : [dict.dailyPartialLine,
              dailyPartial.map(item => `${item.day} (${dict.dailyExcludedLine} ${item.excluded})`).join(listSeparator)],
          ], { left: true }), { id: 'daily-detail' }),
      view?.daily?.lastSummary?.summary
        ? disclosure('summary', `${dict.lastSummaryLine} · ${view.daily.lastSummary.day}`,
          h('p', { className: 'mse-detail-text' }, view.daily.lastSummary.summary), { id: 'last-summary' })
        : null,
    ]) : null

    // ── 经验 ──────────────────────────────────────────────────────────────────────────────
    const entries = view?.entries ?? []
    const shown = entries.filter(entry => (filter.type === '' || entry.type === filter.type)
      && (filter.status === '' || (statusLabels[entry.status] ?? entry.status) === filter.status))
    const lessonsPanel = tab === 'lessons' && view !== null ? h(React.Fragment, { key: 'lessons' }, [
      h('h2', { key: 'sec', className: 'mse-section-title mse-lessons-heading' }, [
        h('span', { key: 't', className: 'mse-inline' }, [
          dict.entriesSection,
          h('span', { key: 'count', className: 'mse-count' },
            filter.type || filter.status ? `${shown.length}/${entries.length}` : String(entries.length)),
        ]),
        h('div', { key: 'f', className: 'mse-filters' }, [
          h(Picker, { key: 'type', label: dict.filterType, prefix: dict.filterType,
            value: filter.type, testId: 'filter-type',
            options: [{ id: '', label: dict.allOption },
              ...Object.entries(typeLabels).map(([id, label]) => ({ id, label }))],
            onChange: value => setFilter(current => ({ ...current, type: value })) }),
          h(Picker, { key: 'status', label: dict.filterStatus, prefix: dict.filterStatus,
            value: filter.status, testId: 'filter-status',
            options: [{ id: '', label: dict.allOption },
              ...[dict.statusActive, dict.statusSuperseded, statusLabels.pending, statusLabels.needs_revision]
                .map(label => ({ id: label, label }))],
            onChange: value => setFilter(current => ({ ...current, status: value })) }),
        ]),
      ]),
      shown.length === 0 ? h('p', { key: 'ne', className: 'mse-empty' }, dict.noEntries)
        : shown.map(entry => disclosure(`e-${entry.id}`,
          summaryText(entry.instruction, 64),
          h(React.Fragment, null, [
            h('p', { key: 'full', className: 'mse-detail-text' }, entry.instruction),
            definition('d', [
              [dict.version, `${entry.version}${entry.parentVersion ? ` ← ${entry.parentVersion}` : ''}`],
              [dict.scope, entry.visibility === 'scoped'
                ? `${dict.scopeScoped}（${entry.scopeHash ?? '—'}）` : dict.scopeGlobal],
              [dict.filterStatus, statusLabels[entry.status] ?? entry.status],
              [dict.injectedCount, String(entry.injected)],
              [dict.recurrenceCount, String(entry.recurrences)],
              [dict.updatedAt, dateText(entry.updatedAt)],
              entry.evidenceHash ? [dict.evidenceHash, String(entry.evidenceHash).slice(0, 12)] : null,
              entry.applicability ? [dict.applicabilityLine, entry.applicability] : null,
              // EVOLUTION016: appended rows inside the SAME detail disclosure — no new page,
              // no duplicated metadata column, no invented numbers.
              [dict.versionWindowLabel, `${entry.methodStats?.version ?? entry.version} · `
                + (entry.methodStats?.coverage === 'since_upgrade'
                  ? dict.coverageSinceUpgrade : dict.coverageComplete)],
              [dict.windowInjected, `${entry.methodStats?.injected ?? 0} · `
                + `${dict.recurrenceCount} ${entry.methodStats?.recurrences ?? 0} · `
                + `${dict.windowChecks} ${entry.methodStats?.checkPasses ?? 0}/${entry.methodStats?.checkFails ?? 0}`],
              entry.recentRevision
                ? [dict.recentRevisionLabel, `v${entry.recentRevision.version} · `
                  + `${revisionLabels[entry.recentRevision.reason] ?? entry.recentRevision.reason} · ${dateText(entry.recentRevision.at)}`]
                : [dict.recentRevisionLabel, dict.recentRevisionNone],
            ], { left: true }),
            Array.isArray(entry.steps) && entry.steps.length > 0
              ? h('p', { key: 's', className: 'mse-hint' },
                `${dict.fixSteps}${colon}${entry.steps.join(locale === 'en' ? '; ' : '；')}`) : null,
            entry.check?.check ? h('p', { key: 'c', className: 'mse-hint' },
              `${dict.checkMethod}${colon}${entry.check.check}`) : null,
          ]), { id: `e-${entry.id}`, open: openEntry === entry.id,
            onToggle: open => setOpenEntry(open ? entry.id : null), stackMeta: true,
            meta: [typeLabels[entry.type] ?? entry.type, statusLabels[entry.status] ?? entry.status,
              entry.guard ? dict.modeGuard : null,
              entry.visibility === 'scoped' ? dict.scopeScoped : dict.scopeGlobal,
              `v${entry.version}`] })),
    ]) : null

    // ── 召回 ──────────────────────────────────────────────────────────────────────────────
    const recall = view?.recall ?? []
    const adaptivePolicies = view?.recallStrategy?.adaptive?.recent ?? []
    const blockerLabels = locale === 'en' ? {
      target_missing: 'Target record removed', target_retired: 'Target retired',
      target_version_stale: 'Target version changed', needs_revision: 'Target lesson needs revision',
      source_unadmitted: 'Source not admitted', replay_counterexample: 'Replay found a counterexample',
      replay_incomplete: 'Replay evidence is incomplete', legacy_v1: 'Legacy evidence is historical only',
      awaiting_independent_gains: 'Independent hits still needed',
      awaiting_independent_controls: 'Unrelated controls still needed',
    } : {
      target_missing: '目标记录已删除', target_retired: '目标已停用',
      target_version_stale: '目标版本已变化', needs_revision: '目标经验待修订',
      source_unadmitted: '来源未获许可', replay_counterexample: '回放发现反例',
      replay_incomplete: '回放证据不完整', legacy_v1: '旧版证据仅供历史查看',
      awaiting_independent_gains: '仍需独立命中',
      awaiting_independent_controls: '仍需无关对照',
    }
    const blockerLabel = code => blockerLabels[code] ?? (locale === 'en' ? 'Needs review' : '状态待核对')
    const adaptiveCandidateRow = policy => {
      const ready = policy.readiness ?? {}
      const legacy = ready.schema === 'v1'
      const budgetLabel = policy.budget?.unit === 'dsh-memory-estimated-tokens-v1'
        ? `${policy.budget.limit} ${dict.recallTokenEstimate}`
        : policy.budget?.unit === 'bytes' ? `${policy.budget.limit} B` : dict.adaptiveByteEvidence
      const modeText = policy.mode === 'approved' ? dict.adaptiveApproved
        : policy.mode === 'isolated' ? dict.adaptiveIsolated : dict.adaptiveObserving
      const remainingGain = legacy ? null : Math.max(0,
        (ready.requiredIndependentGains ?? 2) - (ready.independentGains ?? 0))
      const remainingControl = legacy ? null : Math.max(0,
        (ready.requiredIndependentControls ?? 2) - (ready.independentControls ?? 0))
      const blockers = Array.isArray(ready.blockers) ? ready.blockers : []
      const progress = legacy ? dict.adaptiveLegacy : [
        remainingGain > 0 ? (locale === 'en' ? `${remainingGain} more ${dict.adaptiveGain}`
          : `还差 ${remainingGain} 次${dict.adaptiveGain}`) : `${dict.adaptiveGain} ${ready.independentGains ?? 0}/2`,
        remainingControl > 0 ? (locale === 'en' ? `${remainingControl} more ${dict.adaptiveControl}`
          : `还差 ${remainingControl} 次${dict.adaptiveControl}`) : `${dict.adaptiveControl} ${ready.independentControls ?? 0}/2`,
      ].join(' · ')
      const primaryBlocker = blockers.find(code => !['awaiting_independent_gains',
        'awaiting_independent_controls', 'legacy_v1'].includes(code))
      const targetStatus = ready.targetStatus === 'needs_revision' ? dict.adaptiveTargetRevision
        : ready.targetStatus === 'retired' ? dict.adaptiveTargetRetired
          : ready.targetCurrent ? dict.adaptiveTargetCurrent : dict.adaptiveTargetChanged
      const replay = policy.replay ?? {}
      const source = ready.sourceAdmitted === true ? dict.adaptiveSourceYes
        : ready.sourceAdmitted === false ? dict.adaptiveSourceNo : dict.adaptiveSourceUnknown
      return disclosure(`adaptive-${policy.id}`, `${policy.entryId?.slice(4, 12) ?? '—'} · v${policy.version}`,
        definition('readiness', [
          [dict.adaptiveGain, legacy ? '—' : `${ready.independentGains ?? 0}/2`],
          [dict.adaptiveControl, legacy ? '—' : `${ready.independentControls ?? 0}/2`],
          [dict.adaptiveTarget, `${targetStatus} · v${ready.targetVersion ?? policy.version}`],
          [dict.adaptiveSource, source],
          [dict.adaptiveReplay, `${rsiReasonLabels[replay.reason] ?? replay.reason ?? '—'} · ${dict.rsiResultApproved}: `
            + `${replay.approved === true ? (locale === 'en' ? 'Yes' : '是') : (locale === 'en' ? 'No' : '否')} · `
            + `${locale === 'en' ? 'Hits' : '命中'} ${replay.candidate?.hits ?? 0} · `
            + `${locale === 'en' ? 'Misses' : '漏配'} ${replay.candidate?.misses ?? 0} · `
            + `${locale === 'en' ? 'Counterexamples' : '反例'} ${replay.regressions ?? 0} · `
            + `${locale === 'en' ? 'Incomplete' : '不完整'} ${replay.incomplete ?? 0}`],
          [dict.adaptiveBlockers, blockers.length === 0 ? '—' : blockers.map(blockerLabel).join('；')],
        ], { left: true }), { id: `adaptive-${policy.id}`, stackMeta: true, meta: [modeText, progress,
          budgetLabel,
          primaryBlocker ? blockerLabel(primaryBlocker)
            : ready.legacySuccessor ? dict.adaptiveSuccessor : null] })
    }
    const recallPanel = tab === 'recall' && view !== null ? h(React.Fragment, { key: 'recall' }, [
      h('h2', { key: 'rsi-sec', className: 'mse-section-title' }, [
        dict.adaptiveCandidates,
        h('span', { key: 'count', className: 'mse-count' }, String(adaptivePolicies.length)),
      ]),
      adaptivePolicies.length === 0 ? h('p', { key: 'adaptive-empty', className: 'mse-empty' }, dict.adaptiveNoCandidates)
        : adaptivePolicies.slice(0, 8).map(adaptiveCandidateRow),
      recall.length === 0 ? null : disclosure('recall-history',
        `${dict.recallSection} · ${recall.length}`,
        recall.map(item => disclosure(`r-${item.at}`,
          `${dateText(item.at)} · ${dict.offeredVersions} ${item.offered.length}`,
          definition('d', item.offered.map(o => {
            const known = entries.find(entry => entry.id === o.id)
            return [known ? `${dict.summaryLabel} v${o.version}` : `${dict.historicalEntry} v${o.version}`,
              (known === undefined ? o.id : `${summaryText(known.instruction)}｜${o.id}`)
                + (o.mode === 'guard' ? `｜${dict.modeGuard}` : '')
                + (o.mode === null ? `｜${dict.modeLegacy}` : '')]
          }), { left: true }),
          { id: `r-${item.at}`,
            meta: [item.settled ? dict.settledYes : dict.settledNo,
              item.outcome === null ? dict.outcomeUnknown : (outcomeLabels[item.outcome] ?? item.outcome),
              item.budgetUnit === 'dsh-memory-estimated-tokens-v1'
                ? `${item.contextTokens} ${dict.recallTokenEstimate}` : `${item.bytes} B`] })), { id: 'recall-history' }),
      (view.recallStrategy?.adaptive?.decisions ?? []).length === 0 ? null
        : disclosure('rsi-decisions', `${dict.rsiPersisted} · ${view.recallStrategy.adaptive.decisions.length}`,
          view.recallStrategy.adaptive.decisions.slice(0, 8).map((item, index) => row(
            `rsi-decision-${index}`, resultLabels[item.result] ?? dict.rsiResultUnknown,
            `${rsiReasonLabels[item.reason] ?? (locale === 'en' ? 'Other decision' : '其他决定')} · `
              + `${item.policyId ? `${locale === 'en' ? 'Policy' : '策略'} ${item.policyId}` : (locale === 'en' ? 'No policy ID' : '无策略标识')} · `
              + `${item.entryId ? `${locale === 'en' ? 'Target' : '目标'} ${item.entryId}` : (locale === 'en' ? 'No target ID' : '无目标标识')}${Number.isSafeInteger(item.version) ? ` · v${item.version}` : ''}`,
            dateText(item.at), { top: true })), { id: 'rsi-decisions' }),
      (view.rsiDiagnostics?.recent ?? []).length === 0 ? null
        : disclosure('rsi-runtime', `${dict.rsiRuntime} · ${view.rsiDiagnostics.recent.length}`,
          view.rsiDiagnostics.recent.slice(0, 8).map((item, index) => row(
            `rsi-runtime-${index}`,
            `${stageLabels[item.stage] ?? dict.rsiStageSettled} · ${rsiReasonLabels[item.reason] ?? (locale === 'en' ? 'Other event' : '其他记录')}`,
            `${locale === 'en' ? 'Turn' : '回合'} ${item.turnHash}`
              + `${item.result ? ` · ${resultLabels[item.result] ?? dict.rsiResultUnknown}` : ''}`
              + `${item.outcome ? ` · ${outcomeLabels[item.outcome] ?? dict.outcomeUnknown}` : ''}`
              + `${item.policyId ? ` · ${locale === 'en' ? 'Policy' : '策略'} ${item.policyId}` : ''}`
              + `${item.entryId ? ` · ${locale === 'en' ? 'Target' : '目标'} ${item.entryId}` : ''}`
              + `${Number.isSafeInteger(item.version) ? ` · v${item.version}` : ''}`,
            dateText(item.at), { top: true })), { id: 'rsi-runtime' }),
    ]) : null

    // ── 任务 ──────────────────────────────────────────────────────────────────────────────
    const tasks = view?.tasks ?? []
    const tasksPanel = tab === 'tasks' && view !== null ? h(React.Fragment, { key: 'tasks' }, [
      h('h2', { key: 'sec', className: 'mse-section-title' }, dict.tasksSection),
      h('div', { key: 'm', className: 'mse-metrics mse-metrics-2' }, [
        metric(dict.inFlightNow, String((view.inFlight ?? []).length)),
        metric(dict.unknownCostHeld, String((view.unknownCostHeld ?? []).length)),
      ]),
      h('div', { key: 'wait', className: 'mse-statline' }, [
        h('span', { key: 'l' }, dict.waitReasonLine),
        h('b', { key: 'v' }, waitLabels[view.daily?.waitReason ?? null] ?? view.daily?.waitReason ?? '—')]),
      tasks.length === 0 ? h('p', { key: 'nt', className: 'mse-empty' }, dict.noTasks)
        : tasks.map(item => disclosure(`t-${item.ticket}`,
          `${kindLabels[item.kind] ?? item.kind} · ${dateText(item.at)}`,
          h(React.Fragment, null, [
            definition('d', [
              [dict.requestLabel, String(item.ticket)],
              [dict.rawCode, terminalLabel(item.terminal) ?? dict.taskStatusRunning],
              item.nextStep ? [dict.nextStepLabel, nextLabels[item.nextStep] ?? item.nextStep] : null,
              Number.isSafeInteger(item.outputBytes) ? [dict.outputBytesLabel, `${item.outputBytes} B`] : null,
              item.finishKind ? [dict.finishKindLabel, String(item.finishKind)] : null,
              item.verdictCode ? [dict.verdictLabel, (item.verdictCode === 'generation_limit_no_text'
                || item.verdictCode === 'reasoning_space_exhausted')
                ? dict.reasoningSpace : String(item.verdictCode)] : null,
              item.sourceSessionId ? [locale === 'en' ? 'Source session' : '来源会话', String(item.sourceSessionId)] : null,
            ], { left: true }),
            // Retry stays exactly on the original audited interface, and only where it MEANS
            // something: never after a committed/saved success, never on an unknown cost.
            item.settled && item.usageUnknown !== true && item.terminal !== null
              && !OK_TERMINALS.has(item.terminal)
              ? h('div', { key: 'retry', className: 'mse-inline' }, [
                h(Button, { key: 'b', variant: 'outline', size: 'sm',
                  disabled: reading || shell.error !== null, onClick: () => auditedRetry(item.ticket) }, dict.auditedRetry),
                h('span', { key: 'cost', className: 'mse-unit' }, dict.auditedRetryHint),
              ]) : null,
          ]), { id: `t-${item.ticket}`, stackMeta: true,
            meta: [item.settled ? dict.taskStatusSettled : dict.taskStatusRunning,
              item.usageUnknown ? dict.unknownCostHeld
                : item.usageTotal !== null ? `${item.usageTotal} tok` : null,
              item.settled && item.terminal !== null
                ? (reasonLabels[item.terminal] ?? terminalLabel(item.terminal) ?? '') : null]
              .filter(label => label !== null && label !== '') })),
      disclosure('retry-guide', dict.retryGuide, h('p', { className: 'mse-hint' }, dict.tasksHint),
        { id: 'retry-guide' }),
    ]) : null

    // ── 活动 ─────────────────────────────────────────────────────────────────────────
    const activity = tab === 'activity' ? view?.activity ?? null : null
    const activityProjection = activity === null ? [] : projectActivityWeeks(activity, activityMode)
    const selectedActivityDate = activity?.days.some(day => day.date === activityDate)
      ? activityDate : activity?.todayDate ?? null
    const selectedActivityDay = activity?.days.find(day => day.date === selectedActivityDate) ?? null
    const selectedActivityPeriod = activityProjection.find(period =>
      period.sourceDays.some(day => day?.date === selectedActivityDate)) ?? null
    const selectedActivityCounts = activityMode === 'day' ? selectedActivityDay
      : activityMode === 'week' ? selectedActivityPeriod?.counts
        : selectedActivityPeriod?.cumulativeCounts
    const selectedActivitySummary = selectedActivityCounts === null || selectedActivityCounts === undefined
      ? '—' : activityMode === 'day'
        ? `${selectedActivityDate} · ${selectedActivityCounts.total} ${dict.activityEntries}`
        : activityMode === 'week'
          ? `${selectedActivityPeriod.start} — ${selectedActivityPeriod.end} · ${selectedActivityCounts.total} ${dict.activityEntries}`
          : `${dict.activityCumulativeThrough} ${selectedActivityPeriod.actualEnd ?? activity.todayDate} · ${selectedActivityCounts.total} ${dict.activityEntries}`
    const updateActivityMode = mode => {
      setActivityMode(mode)
      setActivityTooltip(null)
    }
    const onActivityModeKey = (event, index) => {
      let next = null
      if (event.key === 'ArrowRight') next = (index + 1) % ACTIVITY_MODES.length
      else if (event.key === 'ArrowLeft') next = (index + ACTIVITY_MODES.length - 1) % ACTIVITY_MODES.length
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = ACTIVITY_MODES.length - 1
      if (next === null) return
      event.preventDefault()
      updateActivityMode(ACTIVITY_MODES[next])
      activityTabRefs.current[next]?.focus()
    }
    const updateActivityColor = value => {
      if (value !== '' && !/^#[0-9a-f]{6}$/iu.test(value)) return
      const normalized = value.toLowerCase()
      setActivityColorState(normalized)
      writeActivityColor(normalized)
    }
    const activityPanel = activity === null ? null : (() => {
      const visibleDate = week => week.days.find(day => day !== null)
      const monthPositions = []
      let priorMonth = null
      activity.weeks.forEach((week, index) => {
        const first = visibleDate(week)
        const month = first?.date.slice(0, 7)
        if (first === undefined || month === priorMonth) return
        const label = new Date(`${first.date}T00:00:00.000Z`).toLocaleDateString(
          locale === 'en' ? 'en-US' : 'zh-CN', { timeZone: 'UTC', month: 'short' })
        monthPositions.push({ key: week.start, start: index + 1, label })
        priorMonth = month
      })
      const months = monthPositions.map((position, index) => h('span', { key: position.key,
        className: index === monthPositions.length - 1 ? 'mse-activity-month-final' : undefined,
        style: { gridColumn: `${position.start} / ${monthPositions[index + 1]?.start
          ?? activity.weeks.length + 1}` } }, position.label))
      const showActivityTooltip = (day, weekIndex, source) => {
        const text = activityTooltipText(dict, activityMode, day)
        setActivityTooltip({ text, source, edge: weekIndex < 8 ? 'left'
          : weekIndex >= activity.weeks.length - 8 ? 'right' : 'middle',
        x: `${(weekIndex + 0.5) / activity.weeks.length * 100}%` })
      }
      const cells = activityProjection.map((week, weekIndex) => h('div', { key: week.start,
        className: 'mse-activity-week' }, week.days.map((day, index) => {
        if (day === null) return h('span', { key: `${week.start}-${index}`,
          className: 'mse-activity-empty', 'aria-hidden': true })
        const tooltipText = activityTooltipText(dict, activityMode, day)
        return h('button', { key: day.date, type: 'button', className: 'mse-activity-day',
          'data-activity-date': day.date, 'data-activity-mode': activityMode,
          'data-display-total': day.displayTotal, 'data-level': day.level,
          'aria-label': `${day.date}; ${tooltipText}`,
          'aria-pressed': day.date === selectedActivityDate,
          title: tooltipText,
          onClick: () => setActivityDate(day.date),
          onMouseEnter: () => showActivityTooltip(day, weekIndex, 'hover'),
          onFocus: () => showActivityTooltip(day, weekIndex, 'focus'),
          onBlur: () => setActivityTooltip(null) })
      })))
      const detail = selectedActivityCounts === null ? null : definition('activity-counts', [
        [dict.activityRule, String(selectedActivityCounts.rule ?? 0)],
        [dict.activityLesson, String(selectedActivityCounts.lesson ?? 0)],
        [dict.activityDigest, String(selectedActivityCounts.digest ?? 0)],
      ], { left: true })
      const summary = [
        [dict.activityToday, activity.today.total],
        [dict.activityWeek, activity.week.total],
        [dict.activityRetained, activity.retained],
      ].map(([label, value]) => h('div', { key: label, className: 'mse-activity-metric' }, [
        h('dt', { key: 'label' }, label),
        h('dd', { key: 'value' }, String(value)),
      ]))
      const tabs = ACTIVITY_MODES.map((mode, index) => {
        const label = mode === 'day' ? dict.activityDay
          : mode === 'week' ? dict.activityWeekMode : dict.activityTotal
        return h('button', { key: mode, id: `${idPrefix}-activity-${mode}-tab`, type: 'button', role: 'tab',
          'aria-selected': activityMode === mode, 'aria-controls': `${idPrefix}-activity-panel`,
          tabIndex: activityMode === mode ? 0 : -1, ref: node => { activityTabRefs.current[index] = node },
          onClick: () => updateActivityMode(mode), onKeyDown: event => onActivityModeKey(event, index) }, label)
      })
      return h(React.Fragment, null, [
        h('dl', { key: 'metrics', className: 'mse-activity-summary' }, summary),
        h('div', { key: 'header', className: 'mse-activity-header' }, [
          h(ActivityColorPicker, { key: 'color', color: activityColor, onChange: updateActivityColor, dict }),
          h('div', { key: 'tabs', className: 'mse-activity-tabs', role: 'tablist',
            'aria-label': dict.activityTitle }, tabs),
        ]),
        h('div', { key: 'chart-panel', id: `${idPrefix}-activity-panel`,
          className: 'mse-activity-chart-panel', role: 'tabpanel',
          'aria-labelledby': `${idPrefix}-activity-${activityMode}-tab`,
          style: { '--mse-activity-color': activityColor || 'var(--dsw-alias-state-business-primary)' } }, [
          h('div', { key: 'chart', className: 'mse-activity-chart',
            style: { '--mse-activity-weeks': activity.weeks.length } }, [
            h('div', { key: 'stage', className: 'mse-activity-stage',
              onMouseLeave: () => setActivityTooltip(current => current?.source === 'hover' ? null : current) }, [
              activityTooltip === null ? null : h('div', { key: 'tooltip', className: 'mse-activity-tooltip',
                'data-edge': activityTooltip.edge, role: 'tooltip',
                style: { '--mse-activity-tooltip-x': activityTooltip.x } }, activityTooltip.text),
              h('div', { key: 'grid', className: 'mse-activity-grid', role: 'group',
                'aria-label': dict.activityChart }, cells),
            ]),
            h('div', { key: 'months', className: 'mse-activity-months', 'aria-hidden': true }, months),
          ]),
        ]),
        disclosure('activity-selection', selectedActivitySummary, detail, { id: 'activity-selection' }),
        disclosure('activity-details', dict.activityDetails, h(React.Fragment, null, [
          h('p', { key: 'policy', className: 'mse-activity-history' }, dict.activityHistoryNote),
          definition('activity-meta', [
            [dict.activityImported, String(activity.imported)],
            [dict.activityUnknown, String(activity.unknownCreatedAt)],
            [dict.activityFuture, String(activity.futureExcluded)],
            [dict.activityBeforeWindow, `${activity.beforeWindow.total} · ${dict.activityEntries}`],
          ], { left: true }),
        ]), { id: 'activity-details' }),
      ])
    })()

    // ── 学习状态 ────────────────────────────────────────────────────────────────────
    const usage = view?.usageAudit ?? null
    const corrections = view?.corrections ?? null
    const ignoredRecent = corrections?.ignoredRecent ?? []
    const recentDecisions = corrections?.recentDecisions ?? []
    const processedDays = view?.daily?.daysProcessed ?? []
    const sum = pick => usage?.byKind === undefined ? 0
      : Object.values(usage.byKind).reduce((total, bucket) => total + bucket[pick], 0)
    const injectedTotal = entries.reduce((total, entry) => total + (entry.injected ?? 0), 0)
    const recurrenceTotal = entries.reduce((total, entry) => total + (entry.recurrences ?? 0), 0)
    const usagePanel = tab === 'usage' && view !== null ? h(React.Fragment, { key: 'usage' }, [
      h('h2', { key: 'sec', className: 'mse-section-title' }, dict.correctionsSection),
      corrections === null ? null : h('div', { key: 'm', className: 'mse-metrics' }, [
          metric(dict.saved, String(corrections.saved)),
          metric(dict.pendingCorr, String(corrections.pending)),
          metric(dict.dispatchedCorr, String(corrections.dispatched)),
        ]),
      disclosure('corr-full', dict.correctionsFullTitle, h('p', { className: 'mse-detail-text' },
        dict.correctionsFull), { id: 'corr-full' }),
      ignoredRecent.length === 0 ? null
        : disclosure('corr-ignored', `${dict.ignoredReasons} · ${ignoredRecent.length}`,
          definition('ignored', ignoredRecent.map(item => [
            reasonLabels[item.reason] ?? item.reason, dateText(item.at),
          ]), { left: true }), { id: 'corr-ignored' }),
      recentDecisions.length === 0 ? null
        // Real React children: the decision <span>s must NEVER be interpolated into a
        // template string (that is the rc.3 [object Object] defect). The text prefix and the
        // separators are strings; every decision is an element child.
        : disclosure('corr-decisions', `${dict.correctionsDecision} · ${recentDecisions.length}`,
          h('p', { className: 'mse-hint' }, [
          ...recentDecisions.flatMap((row, rowIndex) => [
            ...(rowIndex === 0 ? [] : [' ｜ ']),
            ...row.decisions.flatMap((decision, decisionIndex) => [
              ...(decisionIndex === 0 ? [] : ['；']),
              h('span', {
                key: `${row.at}-${rowIndex}-${decision.basis ?? ''}-${decision.reason ?? ''}`,
                title: decision.basis ?? '' }, [
                decision.durability === 'durable' ? dict.corrDurable
                  : decision.durability === 'one_off' ? dict.corrOneOff : dict.corrUncertain,
                decision.scope === 'global' ? dict.corrGlobal
                  : decision.scope === 'project' ? dict.corrProject : dict.corrScopeUnknown,
                decision.result === 'saved' ? dict.corrSaved : dict.corrIgnored,
                decision.basis === null ? '' : basisText(decision.basis),
                decision.reason === null ? '' : (reasonLabels[decision.reason] ?? decision.reason),
                row.contextOmitted === null ? ''
                  : `${dict.corrContextOmitted}: ${contextOmittedText(row.contextOmitted)}`,
              ].filter(Boolean).join(locale === 'en' ? ' / ' : '/')),
            ]),
          ]),
        ]), { id: 'corr-decisions' }),
      view.collection === undefined ? null : disclosure('coll-scope', dict.collectionScopeTitle,
        definition('collection', [
          [dict.collectionWorkspaces, view.collection.workspaces ?? dict.collectionUnknown],
          [dict.collectionSkipped, view.collection.skipped.length === 0 ? dict.collectionNone
            : view.collection.skipped.map(r => `${reasonLabels[r.reason] ?? r.reason} × ${r.count}`).join(listSeparator)],
        ], { left: true }), { id: 'coll-scope' }),
      (view.revisions ?? []).length === 0 ? null
          // MSE18: the revision audit is LONG TEXT, not a numeric stat — it must not be shoved
          // into a 1/3-width metric card (the whole v1→停用·原因·日期 string became a giant wrapped
          // headline). Full-width ordinary information rows on the page's EXISTING styles: the
          // #short-id and v1→停用 at normal body size (mse-row-title), reason and time on the
          // second line in muted small text (mse-hint), kept in the existing disclosure.
          : disclosure('recent-revisions', `${dict.revisionsSection} · ${view.revisions.length}`,
            view.revisions.map(item => h('div', { key: `rv-${item.id}`, className: 'mse-row mse-row-stacked' },
              h('div', { key: 'm', className: 'mse-row-main' }, [
                h('div', { key: 't', className: 'mse-row-title' },
                  `#${item.id.slice(4, 12)} · v${item.version} → `
                  + `${item.status === 'retired' ? dict.revisionRetired : `v${item.currentVersion}`}`),
                h('p', { key: 'h', className: 'mse-hint' },
                  `${reasonLabels[item.reason] ?? item.reason ?? ''} · ${dateText(item.at)}`),
              ]))), { id: 'recent-revisions' }),
      h('h2', { key: 'sec1', className: 'mse-section-title' }, [
        h('span', { key: 't' }, dict.existingSection),
        h(Button, { key: 'b', variant: 'ghost', size: 'sm', onClick: () => setTab('lessons') }, dict.goLessons),
      ]),
      h('div', { key: 'ex', className: 'mse-metrics mse-metrics-2' }, [
        metric(dict.existingCount, String(entries.length)),
        metric(`${dict.existingInjected}／${dict.existingRecurrences}`, `${injectedTotal}／${recurrenceTotal}`),
      ]),
      h('h2', { key: 'sec2', className: 'mse-section-title' }, dict.dailyState),
      h('div', { key: 'daily', className: 'mse-metrics mse-metrics-2' }, [
        metric(dict.lastDoneDay, view.daily?.lastDoneDay ?? '—'),
        metric(dict.backlogDays, String((view.daily?.backlog ?? []).length)),
      ]),
      dailyPartial.length === 0 ? null : row('daily-partial', dict.dailyPartialLine,
        `${dailyPartial.length}${locale === 'en' ? ' days' : ' 日'}`, null),
      (view.daily?.backlog ?? []).length === 0 && processedDays.length === 0 ? null
        : disclosure('daily-history', `${dict.daysProcessed} · ${processedDays.length}`,
          definition('daily-history-data', [
            [dict.backlogDays, (view.daily?.backlog ?? []).length === 0 ? dict.none
              : view.daily.backlog.join(listSeparator)],
            [dict.daysProcessed, processedDays.map(item => `${item.day} · ${item.status}`)
              .join(listSeparator) || dict.none],
            dailyPartial.length === 0 ? null : [dict.dailyPartialLine,
              dailyPartial.map(item => `${item.day} (${dict.dailyExcludedLine} ${item.excluded})`).join(listSeparator)],
          ], { left: true }), { id: 'daily-history' }),
      h('h2', { key: 'sec3', className: 'mse-section-title' }, dict.usageAuditSection),
      usage === null ? null : h('div', { key: 'm2', className: 'mse-metrics' }, [
        metric(dict.usageCalls, String(sum('calls'))),
        metric(dict.usageTokens, String(sum('knownTokens'))),
        metric(dict.usageUnknownCost, String(sum('unknownCost'))),
      ]),
      usage === null ? null : disclosure('usage-kinds',
        `${dict.usageTotalRequests}: ${usage?.total ?? 0} / ${usage?.settled ?? 0}`,
        h('div', { className: 'mse-row-main' }, [
          definition('d', Object.entries(usage.byKind).map(([kind, bucket]) => [
            kindLabels[kind] ?? kind,
            `${dict.usageCalls} ${bucket.calls}｜${dict.usageTokens} ${bucket.knownTokens}`
            + `${bucket.unknownCost > 0 ? `｜${dict.usageUnknownCost} ${bucket.unknownCost}` : ''}`,
          ]), { left: true })]), { id: 'usage-kinds' }),
    ]) : null

    const tabs = h('div', { key: 'tabs', ref: tabsHost, className: 'mse-tabs-host' },
      settingsTabNavigation(tab, setTab, dict, compactTabs, idPrefix))
    const body = tab === 'overview' ? overviewPanel : tab === 'lessons' ? lessonsPanel
      : tab === 'recall' ? recallPanel : tab === 'tasks' ? tasksPanel
        : tab === 'activity' ? activityPanel : usagePanel
    const statusText = shell.error !== null ? (view === null ? dict.statusUnreadable : dict.lastRead)
      : view === null ? dict.loading : effectiveStatus
    const storageNotice = view?.storage?.reason
      ? (storageReasonLabels[view.storage.reason] ?? dict.storageWarning) : null
    return h('section', { className: 'mse-details', 'data-mse-details': 'page', 'data-mse-surface': surface }, [
      h('div', { key: 'toolbar', className: 'mse-toolbar' }, [
        h('div', { key: 'heading', className: 'mse-heading' }, [
          h('div', { key: 'title', className: 'mse-heading-title' }, [
            h('h1', { key: 't' }, dict.settingsTitle),
            h('span', { key: 's', className: 'mse-status', 'data-unavailable': shell.error !== null,
              'aria-live': 'polite', title: statusText }, [
              h(StateDot, { key: 'd', state: view === null || shell.error !== null
                || learningOn === false || controlState.paused === true ? 'idle' : 'done' }),
              h('span', { key: 't' }, statusText),
            ]),
          ]),
          h(Button, { key: 'r', variant: 'ghost', size: 'sm', className: 'mse-heading-action',
            disabled: reading || controlState.status === 'updating', 'aria-busy': reading,
            onClick: reloadStatus }, dict.refresh),
        ]),
        tabs,
      ]),
      h('div', { key: tab, id: `${idPrefix}-pane-${tab}`, role: 'tabpanel', tabIndex: 0,
        'aria-labelledby': `${idPrefix}-tab-${tab}`, 'aria-busy': reading, className: 'mse-pane' }, [
        shell.error ? h('p', { key: 'read-error', role: 'status', className: 'mse-panel-message mse-error' },
          shell.error) : null,
        !shell.error && storageNotice ? h('p', { key: 'storage-notice', className: 'mse-panel-message mse-notice' },
          storageNotice) : null,
        saveState?.kind === 'error' ? h('p', { key: 'save-error', role: 'alert', className: 'mse-panel-message mse-error' },
          saveState.detail) : null,
        body,
      ]),
    ])
  }

  // Plugin detail page: the SAME panel and read face — never a README pointer.
  function BundlePage(props) {
    return MsePanel({ ...props, initialTab: 'usage', surface: 'bundle' })
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
      STATUS_ZH, TYPE_ZH, REASON_ZH, WAIT_ZH, en,
      row, disclosure, definition, metric, Picker, settingsTabNavigation, callRemote,
      useFormSnapshot, projectActivityWeeks, activityTooltipText, MsePanel, BundlePage },
  }
} })
