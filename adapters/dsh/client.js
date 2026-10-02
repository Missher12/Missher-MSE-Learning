/**
 * MSE 自我进化 — browser half of the bundle.
 *
 * Registered as the bundle's `./client` export in this package's own manifest: the Host serves
 * this file to the web shell, the shell evaluates it, and `__ModuleLoader__` hands the module
 * back to Cordis. It registers two things, and they are deliberately not two copies of the UI:
 *
 *   • `settings.section` id `mse-learning` (`label: 自我进化`) — the real, global settings
 *     entry, reached from 设置 in the sidebar exactly like every other section. It owns the
 *     runtime switches, the manual actions and the four read-only views.
 *   • `plugins.bundle.config` — the row the host's own plugin manager renders on the bundle's
 *     page. It mounts the *same* panel component, so there is one implementation and one data
 *     source; the only thing it adds is a pointer to where the writable settings live, because
 *     this host exposes no public way for one client plugin to navigate another to a section.
 *
 * Reads go through the read-only `mseDetails` Remote; the switches go through the host Settings
 * form (`configForms`, with its own revision fence) and the manual actions through the separate
 * `mseControl` Remote, which the Host gates on the same permission decision as automatic
 * learning. Nothing here consumes recall budget on its own, and merely opening the page sends
 * no model request.
 *
 * One scope selector drives every view, and every request belongs to a generation: a response
 * from a scope or a moment the page has already left is dropped instead of repainting the
 * current one, and switching scope clears what the previous scope showed.
 */
window.__ModuleLoader__.load({ id: '@missher/dsh-mse-learning', factory: (require) => {
  const React = require('react')
  // The host's own settings components, loaded from the platform's static module table — they
  // are part of the shell, not a plugin this bundle has to activate, so they are deliberately
  // absent from `dsh.client.inject` (declaring them there would demand a package that is
  // already present). They carry the real control sizes, radii, borders, hover/focus rings and
  // light/dark tokens, which is why this page needs no control styling of its own.
  const {
    Button, IconChevronRightOutlineRegular, IconChevronsUpDownOutlineRegular, Input, Menu, SegmentedTabs,
    StateDot, Switch,
  } = require('@deepseek-ai/dsh-client-ui-primitives')
  const NS = 'mse.details'
  const BUNDLE = '@missher/dsh-mse-learning'
  const SETTINGS_ID = 'mse-learning'
  const REFRESH_INTERVAL_MS = 20_000
  const JOB_POLL_MS = 1_500
  const PAGE_SIZES = [10, 20, 50]
  const TABS = ['overview', 'lessons', 'recall', 'manual', 'budget']
  const MAX_QUERY_CHARS = 64
  const MAX_PROMPT_CHARS = 200
  const MAX_CASE_JSON_CHARS = 20_000
  const METHODS = ['overview', 'sessions', 'lessons', 'lesson', 'recall', 'diagnose']
  const CONTROL_METHODS = ['status', 'turns', 'planReview', 'startReview', 'planEvaluation', 'startEvaluation', 'job', 'cancel']
  const CONTEXT_MIN = 128
  const CONTEXT_MAX = 1536
  const EVAL_TOKENS_MAX = 1_000_000
  const EVAL_CALLS_MAX = 8

  /** Client-side descriptor of the read-only Remote; mirrors the Host manifest. */
  const REMOTE = {
    package: BUNDLE,
    descriptors: METHODS.map(method => ({
      id: `${BUNDLE}#mseDetails/${method}`,
      service: 'mseDetails',
      namespace: 'mseDetails',
      method,
      invocation: { kind: 'direct' },
      parameters: [{ name: 'input', wire: 'input', source: 'json', acceptsUndefined: true,
        codec: { mode: 'strict', typeSymbol: `${BUNDLE}/types#MseDetailsRequest`, create: () => ({ parse: value => value }) } }],
      result: { mode: 'strict', typeSymbol: `${BUNDLE}/types#MseDetailsResult`, create: () => ({ parse: value => value }) },
      sourceLocation: { file: 'adapters/dsh/details.mjs', line: 1, column: 1 },
    })),
  }

  /**
   * The control contribution. It must mount under a *different* package label: the Remote
   * registry refuses a second contribution that reuses one, and the label is a local identity
   * that never crosses the wire.
   */
  const CONTROL = {
    package: `${BUNDLE}-control`,
    descriptors: CONTROL_METHODS.map(method => ({
      // The local id mirrors the Host manifest entry for readability, but the *package label*
      // below must stay distinct: the registry refuses a second contribution that reuses one.
      id: `${BUNDLE}#mseControl/${method}`,
      service: 'mseControl',
      namespace: 'mseControl',
      method,
      invocation: { kind: 'direct' },
      parameters: [{ name: 'input', wire: 'input', source: 'json', acceptsUndefined: true,
        codec: { mode: 'strict', typeSymbol: `${BUNDLE}/types#MseControlRequest`, create: () => ({ parse: value => value }) } }],
      result: { mode: 'strict', typeSymbol: `${BUNDLE}/types#MseControlResult`, create: () => ({ parse: value => value }) },
      sourceLocation: { file: 'adapters/dsh/control.mjs', line: 1, column: 1 },
    })),
  }

  const zh = {
    title: '学习详情',
    settingsTitle: '自我进化',
    subtitle: '本机持久学习；读取不会发送模型请求，也不消耗召回额度。',
    refresh: '刷新',
    refreshing: '读取中…',
    autoRefresh: '每 20 秒自动刷新',
    scopePicker: '选择会话',
    scopeDefault: '默认（实例）作用域',
    scopeProject: '项目作用域',
    scopeInstance: '实例作用域',
    scopeArchived: '已归档',
    scopeRunning: '运行中',
    scopePersisted: '已保存',
    scopeLive: '在内存',
    scopeUnknown: '目录不可用',
    tabOverview: '常规',
    tabLessons: '经验',
    tabRecall: '召回',
    tabManual: '任务',
    tabBudget: '额度',
    version: '版本',
    runtime: '适配器',
    enabled: '启用',
    paused: '已暂停',
    disabled: '已停用',
    legacy: '旧控制器接管',
    storeReadable: '学习库可读',
    storeMigration: '学习库需要迁移（schema 1 → 2）',
    storeError: '学习库不可读',
    countsTitle: '经验计数（默认作用域）',
    total: '库内合计',
    scopeLessons: '本作用域',
    otherScope: '其他作用域',
    activeCorrections: '可用纠错',
    methods: '方法',
    methodsValidated: '已验证方法',
    methodsUnvalidated: '待验证方法',
    suspended: '已停用',
    expired: '已过期',
    otherEnvironment: '其他环境方法',
    countsFailed: '计数不可读',
    budget: '字节额度',
    turnBudget: '单轮上限',
    sessionBudget: '会话上限',
    sessionUsed: '当前会话已用',
    sessionRemaining: '当前会话剩余',
    maxLessons: '单轮最多条数',
    bytes: '字节',
    bytesNote: '单位是 UTF-8 字节，不是 token，也不是费用。',
    notLearnedNote: '“已安装/已启用”只是插件状态，不等于已经学到经验或已经注入过上下文。',
    lessonsTitle: '经验列表',
    search: '搜索经验内容',
    kindFilter: '类型',
    statusFilter: '状态',
    all: '全部',
    kindCorrection: '纠错',
    kindMethod: '方法',
    page: '第 {page} / {pages} 页',
    prev: '上一页',
    next: '下一页',
    pageSize: '每页',
    emptyLessons: '这个作用域里还没有经验。',
    emptyFiltered: '没有符合筛选条件的经验。',
    complete: '本作用域共 {total} 条，已全部读取（库上限 {cap}）。',
    detail: '经验详情',
    back: '返回列表',
    instruction: '正文',
    status: '状态',
    kind: '类型',
    savedAt: '保存时间',
    expiresAt: '有效期至',
    source: '来源依据',
    sourceTurn: '宿主回合',
    notRecorded: '未记录',
    counters: '采用与验证',
    adopted: '采用',
    verified: '宿主验证通过',
    failed: '宿主验证失败',
    inconclusive: '无结论',
    validation: '评测结论',
    experiments: '世代记录',
    applicability: '适用条件',
    exclusions: '排除条件',
    environment: '环境',
    environmentCurrent: '本环境适用',
    environmentOther: '其他环境（此处不适用）',
    environmentNone: '与环境无关（纠错）',
    topic: '偏好槽位',
    value: '槽位取值',
    history: '历史完整性',
    historyComplete: '事件环完整（未淘汰）',
    historyIncomplete: '事件环可能已淘汰事件',
    replaces: '替代',
    replacedBy: '被替代',
    loading: '读取中…',
    loadFailed: '读取失败',
    recallTitle: '召回详情',
    recallPick: '请在上方选择一个会话',
    recallRecent: '本次运行的最近轮次',
    recallNone: '暂无本次运行记录（只在宿主进程启动后、且该会话发生过回合时才有）。',
    turn: '回合',
    at: '时间',
    reason: '结果',
    injected: '注入字节',
    lessonsUsed: '来源经验',
    settle: '结算',
    settleNone: '本会话无待重试结算',
    diagnostics: '判定过程',
    diagnoseTitle: '预览经验注入',
    diagnosePrompt: '任务描述',
    diagnoseRun: '预览注入',
    diagnoseNone: '尚未诊断。',
    diagnoseResult: '结论',
    wouldInject: '预计注入',
    reasonNames: {
      recalled: '已召回并注入', not_learned: '没有可召回的经验', scope_mismatch: '作用域不符',
      match_insufficient: '匹配不足', method_unvalidated: '方法未验证', already_offered: '本轮已提供过',
      budget_exhausted: '字节预算不足', internal_task: '内部任务跳过', store_failure: '存储读取失败',
      correction_learned: '本轮刚学到纠错', conflict_unresolved: '偏好冲突未解决', turn_closed: '回合已结算',
      filtered_origin: '来源被过滤',
    },
    settleNames: { settled: '已结算', duplicate: '重复（已记录）', retrying: '待重试', exhausted: '重试耗尽',
      failed: '失败', expired: '已过期', stopped: '已停止', capacity: '容量已满', pending: '待处理' },
    durablePending: '核心待结算', durableTerminal: '核心终态', durableUnreadable: '核心状态不可读',
    durableNone: '空', pauseState: '用户暂停', pauseNotSet: '未设置', pauseConfirmed: '已确认生效',
    pausePending: '暂停未确认（{reason}，第 {n} 次）', resumePending: '恢复未确认（{reason}，第 {n} 次）',
    stopsUnconfirmed: '未确认的精确停止',
    stopsExhaustedSuffix: '，其中 {n} 已耗尽', stopsClean: '无',
    savedButControlPending: '设置已保存；持久暂停尚未确认（{reason}），会在下一个人工回合重试。',
    codeNames: {
      core_unavailable: '学习核心未加载（插件可能已停用或加载失败）',
      session_unknown: '该会话不在宿主会话目录中（可能已删除），请重新选择',
      session_required: '需要先选择一个会话',
      session_internal: '该会话是子智能体或内部会话，不支持在此复盘',
      session_query_unavailable: '宿主会话查询服务不可用，无法读取可信回合',
      session_read_failed: '读取会话记录失败',
      session_route_unknown: '该会话没有可用的模型路由记录',
      turn_unknown: '该会话里找不到这个回合',
      turn_not_finished: '该回合尚未正常结束',
      turn_cancelled: '该回合已被取消，不能作为复盘来源',
      turn_route_unknown: '该回合没有记录模型路由，无法沿用原模型',
      turn_task_too_short: '该回合的用户输入过短，不足以复盘',
      turn_result_too_short: '该回合没有可见的最终结果，不足以复盘',
      settings_unavailable: '宿主设置服务不可用',
      session_directory_unavailable: '宿主会话目录服务不可用',
      session_directory_failed: '读取会话目录失败',
      migration_required: '学习库需要迁移（schema 1 → 2），当前不可读',
      store_unavailable: '学习库不可读',
      lesson_not_in_scope: '该经验不属于当前作用域',
      invalid_lesson_id: '经验 ID 格式不正确',
      stale_version: '该经验在确认后已被修改，请重新载入详情再试',
      history_unavailable: '世代记录不可读',
      library_counts_unavailable: '计数不可读',
      session_ledger_unavailable: '会话字节账本不可读',
      diagnose_unavailable: '只读诊断不可用',
      remote_failed: '远程调用失败',
      empty_result: '宿主返回了空结果',
      invalid_request_id: '请求标识不合法，请重新点击',
      invalid_expected_version: '本次预览没有绑定经验版本，已拒绝启动；请重新预览',
      plan_hash_required: '本次启动缺少预览凭据，已拒绝；请重新预览后再开始',
      stale_plan: '预览已过期：会话、经验版本、案例或模型路由已经变化，请重新预览',
      request_conflict: '同一个请求标识已经用于别的任务',
      job_in_progress: '已有手动任务在排队或运行，请等它结束或先取消',
      job_unknown: '找不到该任务（宿主重启会中断并丢弃未完成的任务，不会重放）',
      plugin_disposed: '插件正在卸载，无法开始新的手动任务',
      plugin_disposed_reason: '插件正在卸载',
      legacy_controller: '旧版 MSE 控制器正在接管',
      user_paused: '用户已暂停自我进化',
      reflection_disabled: '自动复盘已关闭',
      route_unavailable: '没有可用的模型路由',
      model_failed: '模型返回失败',
      model_incomplete: '模型响应不完整',
      reflection_too_large: '复盘输出超过上限',
      reflection_unavailable: '复盘调用失败或超时',
      reflection_disabled_code: '自动复盘已关闭',
      sensitive_summary: '摘要包含敏感内容，已拒绝发送',
      insufficient_summary: '摘要过短，无法复盘',
      duplicate: '这个回合已经复盘过（每日额度与同一回合去重由核心统一记账）',
      reflection_budget: '复盘额度已用完或仍在 30 分钟冷却期内',
      abstained: '模型判断信息不足，没有产出经验',
      evaluation_budget: '评测预算不足',
      evaluation_job_open: '已有评测票据未结算',
      evaluation_calls_exhausted: '当日评测次数已用完',
      evaluation_tokens_exhausted: '当日评测 token 余量不足',
      evaluation_incomplete: '评测未完成',
      invalid_cases: '案例格式不合法',
      invalid_case_prompt: '案例里的任务描述不合法',
      invalid_expected_value: '案例的预期值不合法',
      invalid_family: '案例的族（family）标签不合法',
      invalid_split: '案例的 split 必须是 development 或 holdout',
      invalid_checker: '案例的判据不合法（只支持 text-exact-v1 / json-deep-equal-v1 / lines-present-v1）',
      unknown_case_field: '案例含未知字段',
      too_few_cases: '案例数不足',
      too_many_cases: '案例数超过上限',
      duplicate_case_id: '案例 ID 重复',
      duplicate_case_content: '存在内容完全相同的重复案例（改 ID/族名不算新案例）',
      insufficient_holdout: 'holdout 案例不足',
      insufficient_families: '案例族不足',
      insufficient_holdout_families: 'holdout 案例族不足',
      output_empty: '该次输出为空',
      output_too_large: '该次输出超长',
      output_not_json: '输出不是完整的 JSON',
      output_ambiguous_json: '输出 JSON 含重复键、指数写法或不安全整数，判为不明确',
      output_truncated: '输出被长度上限截断，不能公平评分',
      forbidden_substring_present: '输出包含禁止出现的字符串',
      cancelled: '已取消',
      deadline_exceeded: '超过作业总时限',
      job_failed: '作业失败',
      method_not_evaluable: '该方法当前不可评测（已停用或版本不符）',
      lesson_unavailable: '该经验不可用（可能已过期）',
      environment_mismatch: '该经验属于其他环境',
    },
    previewStale: '预览已失效：会话或回合已经改变，请重新预览后再开始。',
    verifyStale: '预览已失效：会话、经验版本、案例内容或模型路由已经改变，请重新预览后再开始。',
    verifyBoundaryTitle: '这次验证能说明什么',
    yes: '是', no: '否', unknown: '未知', retry: '重试',
    statusUnreadable: '运行状态不可读',
    statusUnavailable: '无法读取运行状态',
    draftStale: '宿主值已被其他地方修改。你的编辑仍然保留，请先重新载入宿主值再保存。',
    reloadHost: '重新载入宿主值',
    savedStatusFailed: '设置已保存，但读取运行状态失败：{reason}',
    jobDraining: '取消已生效；旧请求可能仍在等待返回，队列在它退出前不会叠加新的付费请求。',
    jobReviewLearned: '已提炼候选经验',
    jobReviewDuplicate: '该回合已复盘过（没有重复调用模型）',
    jobReviewAbstained: '模型判断信息不足，未产出经验',
    jobReviewSkipped: '已跳过：{reason}',
    jobReviewUnknown: '结果无法识别',
    jobDoneNoResult: '作业已完成，没有需要展示的结论。',
    jobTokens: '实耗 token',
    tokensUnknown: '未知（供应商未报告用量）',
    jobEvaluationImproved: '改善/退化',
    jobEvaluationUnknownCost: '有 {n} 次成对请求未报告用量',
    usageUnknownNote: '：已按预留上限保守记账，成本未知；这不改变上面的结论。',
    jobRaw: '原始结果',
    recentRecall: '最近一次召回',
    detailsMore: '版本与只读明细',
    runtimeHelpTitle: '运行详情与使用说明',
    budgetHelp: '额度单位与未注入原因',
    unitBytes: '字节',
    notReported: '未上报',
    unknownError: '未知错误',
    evalTokensLimit: '每日 token 上限',
    evalCallsLimit: '每日调用上限',
    unitItems: '条',
    unitCalls: '次',
    discard: '取消',
    unsaved: '有未保存的更改',
    goLessons: '查看经验 →',
    gotoBudget: '调整额度',
    dismiss: '收起',
    progress: '进度',
    jobsEmpty: '暂无任务。预览后手动开始，执行中可取消。',
    storeState: '学习库',
    suspendedExpired: '已停用 / 已过期',
    lessonId: '经验标识',
    runtimeMode: '运行方式',
    runtimeModeValue: '等待任务事件',
    model: '模型',
    reasoning: '思考强度',
    contextBudgetTitle: '上下文额度',
    turnBudgetHint: '只计经验文本，单位为 UTF-8 字节。',
    sessionBudgetHint: '在同一会话中限制经验占用。',
    evalBudgetTitle: '模型评测额度',
    evalBudgetHint: '验证候选经验会调用模型。额度为 0 时不执行。',
    evalUsageTitle: '当前用量与计算说明',
    evalTokensUsed: '评测 token 已用',
    evalCallsUsed: '评测调用已用',
    evalJobsOpen: '进行中的评测作业',
    bytesUnit: '额度单位',
    emptyLessonsHint: '试试其他关键词或筛选条件。',
    recallPickHint: '在上方选择一个会话后，可查看它的召回记录与结算。',
    recallNoneHint: '发生任务回合后，可在这里查看经验是否注入。',
    diagnoseHint: '输入任务描述，查看可能匹配的经验。预览不调用模型。',
    turnsHint: '选择已完成回合，提炼可复用经验。先预览将处理哪次任务，再开始。',
    turnsIdle: '读取该会话的已完成回合。',
    turnsNoneHint: '该会话还没有可复盘的已完成回合。',
    verifyNoLessonHint: '所选作用域里还没有方法类经验。',
    previewNote: '将使用所选会话的模型复盘这一回合。只提炼候选经验，不自动标记为验证通过。',
    previewModel: '本次模型',
    previewSource: '复盘来源',
    advancedHint: '模型评测额度在「额度」页调整。',
    settingsPath: '设置 → 自我进化',
    settingsPointer: '完整设置在这里：左侧「设置 → 自我进化」。启用/暂停、自动复盘、上下文上限、手动复盘与候选验证，以及总览、经验、召回、预算四个视图都在那个页面；本页只保留宿主的插件管理信息，不再挂第二份面板。',
    reasonNamesForControl: { plugin_disposed: '插件正在卸载', legacy_controller: '旧版 MSE 控制器接管',
      user_paused: '用户已暂停', plugin_not_started: '尚未开始' },
    unavailable: '当前不可读。',
    selected: '已选择',
    // ---- runtime controls ----
    controls: '运行控制',
    controlsNote: '保存只改变下一次实际使用的有效值；保存本身不调用模型、不注入上下文。',
    masterSwitch: '持久学习',
    masterHint: '随任务自动学习，暂停后保留已有经验',
    masterHintFull: '随 DSH 加载、按任务事件工作，不需要另启常驻进程。暂停后本页与只读诊断仍然可用，随时可以再启用；已有经验、已用预算和待结算记录都不会被清空。',
    autoReflect: '自动复盘',
    autoReflectHint: '任务结束后提炼经验，每日最多 3 次',
    autoReflectHintFull: '沿用当前任务的模型与推理路由；24 小时内最多 3 次、间隔至少 30 分钟，单次输出不超过 384 tokens。关闭会取消本插件排队与在途的自动复盘，不影响纠错学习、召回与可信结算。',
    contextBytes: '单轮上下文上限',
    contextBytesHint: '单轮注入上限，单位：字节',
    contextBytesHintFull: '合法范围 {min}–{max} 字节，默认 {def}。会话累计 1536 字节、单轮最多 2 条经验由核心固定，不能在此调整；调整只影响下一次实际注入，不会退还或清零已经用掉的会话额度。',
    advanced: '高级：模型评测预算',
    advancedHint: '默认 0 表示停用“基于模型”的候选验证；登记方法的确定性回归不使用模型，也不消耗这里任何额度。',
    evalTokens: '每日评测 token 上限',
    evalCalls: '每日评测次数上限',
    save: '保存',
    saving: '保存中…',
    saved: '已保存并生效。',
    saveFailed: '未保存：{reason}',
    reloadNeeded: '保存被拒绝：配置可能已在别处更改，或数值超出合法范围。已重新载入宿主值，请确认后再试。',
    saveUnavailable: '当前客户端不能写入宿主设置（非本机或只读），只显示已保存的值。',
    configUnavailable: '宿主设置命名空间暂不可用，开关为只读。',
    userEnabled: '用户是否启用',
    effectiveState: '当前实际状态',
    effectiveRunning: '运行中（等待任务事件）',
    effectivePaused: '已暂停',
    effectiveReasons: '原因',
    autoReflectEffective: '自动复盘配置',
    autoReflectOn: '开启（{used}/{limit} 已于 24 小时内使用）',
    autoReflectOff: '已关闭',
    recentRun: '最近召回/失败',
    noRuns: '本进程内尚无运行记录（重启后从零开始统计；已保存的经验与用量不受影响）。',
    runsObserved: '本进程记录过 {n} 个会话的回合',
    jobsTitle: '任务记录',
    jobsNone: '暂无手动任务。',
    jobsNote: '任务只存在于本进程：宿主重启会中断并丢弃未完成的任务，不会重放模型请求。',
    jobState: { queued: '排队中', running: '运行中', done: '已完成', failed: '失败', cancelled: '已取消', blocked: '被许可阻断' },
    jobKind: { review: '手动复盘', registered: '登记方法验证', evaluation: '候选对照验证' },
    cancelJob: '取消',
    // ---- manual ----
    manualTitle: '手动复盘与验证',
    manualNote: '只使用宿主自己的会话记录；预览不发送模型请求，确认后才会开始。',
    turnsTitle: '手动复盘',
    turnsPick: '先在上方选择一个会话，再读取它的回合。',
    turnsLoad: '读取该会话的回合',
    turnsNone: '该会话没有可复盘的已结束回合。',
    turnLine: '第 {turn} 轮 · {reason}',
    turnPreview: '预览',
    turnStart: '开始复盘',
    turnUsed: '已复盘',
    turnBlocked: '不可复盘',
    previewTitle: '本次将处理',
    previewTask: '任务（截断）',
    previewResult: '结果（截断）',
    previewRoute: '将使用的模型',
    previewOutcome: '复盘结论依据',
    previewQuota: '复盘额度',
    previewQuotaValue: '24 小时内剩余 {allowance}/{limit} 次',
    previewCooldown: '冷却至 {at}',
    previewDuplicate: '这个回合已经复盘过，不会重复发送模型请求。',
    previewPermission: '当前许可：{reason}',
    previewEnabled: '允许',
    inheritedUnsupported: '该会话含继承的历史回合（来自分叉），不在此列出；继承回合不能作为本会话的证据。',
    verifyTitle: '验证候选经验',
    verifyPickLesson: '选择一条方法经验',
    verifyNoLesson: '当前作用域没有方法经验。',
    verifyLoad: '读取本作用域的方法',
    verifyLesson: '{kind} · {status} · v{version}',
    verifyRegistered: '该方法已登记固定算法：验证不调用模型，也不消耗评测额度。',
    verifyGeneric: '该方法没有登记算法：验证会用同一模型、同一批案例分别运行“无经验基线”和“候选经验”，由宿主按固定判据评分。',
    verifyCases: '验证集（JSON 数组）',
    verifyCasesHint: '每条 {caseId, family, split: development|holdout, prompt, checker:{kind, expected}}；最少 {min} 条、最多 {max} 条，holdout ≥ 4 条且整体/holdout 各 ≥ 2 个族。案例内容相同的重复项会被拒绝。',
    verifyCaseTemplate: '填入示例',
    verifyPlan: '预览与校验',
    verifyStart: '开始验证',
    verifyPlanTitle: '验证计划',
    verifyTarget: '验证对象',
    verifyPlanCases: '案例',
    verifyPlanCasesValue: '接受 {accepted} 条 · 族 {families} · holdout {holdout}',
    verifyPlanRequests: '预计成对请求',
    verifyPlanReserve: '预留 token 上限',
    verifyPlanRemaining: '当日余量',
    verifyPlanRemainingValue: 'token 剩余 {tokens}，次数剩余 {calls}',
    verifyPlanDeadline: '作业总时限 {minutes} 分钟（单次请求 ≤ 1 分钟）',
    verifyPlanReady: '可以开始',
    verifyPlanBlocked: '暂不能开始：{reason}',
    verifyResult: '验证结论',
    verifyDecision: { accepted: '通过（仅限本次验证集）', rejected: '拒绝', inconclusive: '无结论' },
    verifyBoundaryTitle: '这次验证能说明什么',
    verifyBoundary: '结论只覆盖本次验证集：案例由你提供，不代表在真实任务中普遍有效；族标签只证明数量，不证明统计独立性。',
    verifyRegisteredDone: '登记方法的确定性回归不使用模型，token 消耗为 0。',
    usageUnknown: '本次有请求未报告真实用量，已按预留上限保守记账，结论为无结论。',
    resultSummary: '汇总',
    resultReasons: '原因',
    resultLesson: '经验版本',
  }
  const en = {
    title: 'Learning details',
    settingsTitle: 'Self-evolution',
    subtitle: 'Local persistent learning; reading sends no model request and consumes no recall budget.',
    refresh: 'Refresh', refreshing: 'Reading…', autoRefresh: 'Refresh every 20 s',
    scopePicker: 'Session', scopeDefault: 'Default (instance) scope', scopeProject: 'Project scope',
    scopeInstance: 'Instance scope', scopeArchived: 'Archived', scopeRunning: 'Running',
    scopePersisted: 'Persisted', scopeLive: 'In memory', scopeUnknown: 'Directory unavailable',
    tabOverview: 'General', tabLessons: 'Lessons', tabRecall: 'Recall', tabManual: 'Tasks', tabBudget: 'Budget',
    version: 'Version', runtime: 'Adapter', enabled: 'Enabled', paused: 'Paused', disabled: 'Disabled',
    legacy: 'Legacy controller active', storeReadable: 'Store readable',
    storeMigration: 'Store needs migration (schema 1 → 2)', storeError: 'Store unreadable',
    countsTitle: 'Lesson counts (default scope)', total: 'Library total', scopeLessons: 'In scope',
    otherScope: 'Other scopes', activeCorrections: 'Active corrections', methods: 'Methods',
    methodsValidated: 'Validated methods', methodsUnvalidated: 'Unvalidated methods', suspended: 'Suspended',
    expired: 'Expired', otherEnvironment: 'Other-environment methods', countsFailed: 'Counts unreadable',
    budget: 'Byte budget', turnBudget: 'Per turn', sessionBudget: 'Per session', sessionUsed: 'This session used',
    sessionRemaining: 'This session left', maxLessons: 'Lessons per turn', bytes: 'bytes',
    bytesNote: 'UTF-8 bytes — not tokens and not cost.',
    notLearnedNote: '“Installed / enabled” is plugin state only: it does not mean something was learned or injected.',
    lessonsTitle: 'Learned lessons', search: 'Search lessons', kindFilter: 'Kind', statusFilter: 'Status', all: 'All',
    kindCorrection: 'Correction', kindMethod: 'Method', page: 'Page {page} / {pages}', prev: 'Previous',
    next: 'Next', pageSize: 'Per page', emptyLessons: 'No lessons exist in this scope yet.',
    emptyFiltered: 'No lesson matches these filters.',
    complete: 'Scope holds {total} lessons, all read (library cap {cap}).',
    detail: 'Lesson detail', back: 'Back to list', instruction: 'Text', status: 'Status', kind: 'Kind',
    savedAt: 'Saved at', expiresAt: 'Expires at', source: 'Provenance', sourceTurn: 'Host turn',
    notRecorded: 'Not recorded', counters: 'Adoption and verification', adopted: 'Adopted',
    verified: 'Host verified', failed: 'Host failed', inconclusive: 'Inconclusive', validation: 'Evaluation',
    experiments: 'Generations', applicability: 'Applies when', exclusions: 'Excluded when', environment: 'Environment',
    environmentCurrent: 'Applies in this environment', environmentOther: 'Other environment (not applicable here)',
    environmentNone: 'Environment-independent (correction)', topic: 'Preference slot', value: 'Slot value',
    history: 'History completeness', historyComplete: 'Event ring complete (nothing evicted)',
    historyIncomplete: 'Event ring may have evicted events', replaces: 'Replaces', replacedBy: 'Replaced by',
    loading: 'Reading…', loadFailed: 'Read failed', recallTitle: 'Recall detail', recallPick: 'Pick a session above',
    recallRecent: 'Recent turns of this run',
    recallNone: 'No record from this run yet (only turns that happened after the Host process started).',
    turn: 'Turn', at: 'Time', reason: 'Outcome', injected: 'Injected bytes', lessonsUsed: 'Lessons',
    settle: 'Settlement', settleNone: 'No pending settlement for this session', diagnostics: 'Diagnostics',
    diagnoseTitle: 'Preview lesson injection', diagnosePrompt: 'Task description', diagnoseRun: 'Diagnose',
    diagnoseNone: 'Not run yet.', diagnoseResult: 'Outcome', wouldInject: 'Would inject',
    reasonNames: { recalled: 'Injected', not_learned: 'Nothing learned', scope_mismatch: 'Scope mismatch',
      match_insufficient: 'Match insufficient', method_unvalidated: 'Method unvalidated', already_offered: 'Already offered',
      budget_exhausted: 'Budget exhausted', internal_task: 'Internal task skipped', store_failure: 'Store failure',
      correction_learned: 'Correction just learned', conflict_unresolved: 'Preference conflict', turn_closed: 'Turn closed',
      filtered_origin: 'Origin filtered' },
    settleNames: { settled: 'Settled', duplicate: 'Duplicate (recorded)', retrying: 'Retrying', exhausted: 'Exhausted',
      failed: 'Failed', expired: 'Expired', stopped: 'Stopped', capacity: 'At capacity', pending: 'Pending' },
    durablePending: 'Pending in the core', durableTerminal: 'Terminal records', durableUnreadable: 'Core state unreadable',
    durableNone: 'Empty', pauseState: 'User pause', pauseNotSet: 'Not set', pauseConfirmed: 'Confirmed',
    pausePending: 'Pause not confirmed ({reason}, attempt {n})',
    resumePending: 'Resume not confirmed ({reason}, attempt {n})', stopsUnconfirmed: 'Unconfirmed exact stops',
    stopsExhaustedSuffix: ', {n} exhausted', stopsClean: 'None',
    savedButControlPending: 'Saved; the durable pause is not confirmed yet ({reason}) and will be retried at the next explicit turn.',
    codeNames: { core_unavailable: 'The learning core is not loaded (plugin disabled or failed to load)',
      session_unknown: 'That session is not in the Host directory (it may be gone); pick another',
      session_required: 'Pick a session first', session_directory_unavailable: 'The Host session directory is unavailable',
      session_directory_failed: 'Reading the session directory failed', migration_required: 'The store needs migration (schema 1 → 2)',
      store_unavailable: 'The learning store is unreadable', lesson_not_in_scope: 'That lesson is not in this scope',
      history_unavailable: 'Generation history unreadable', library_counts_unavailable: 'Counts unreadable',
      session_ledger_unavailable: 'Session byte ledger unreadable', diagnose_unavailable: 'The dry run is unavailable',
      remote_failed: 'Remote call failed', empty_result: 'The Host returned an empty result' },
    previewStale: 'This preview is stale: the session or turn changed. Preview again before starting.',
    verifyStale: 'This preview is stale: the session, lesson version or cases changed. Preview again before starting.',
    verifyBoundaryTitle: 'What this verification does and does not show',
    yes: 'Yes', no: 'No', unknown: 'Unknown', retry: 'Retry',
    statusUnreadable: 'Runtime state unreadable',
    statusUnavailable: 'Could not read the runtime state',
    draftStale: 'The host values changed elsewhere. Your edit is kept; reload the host values before saving.',
    reloadHost: 'Reload host values',
    savedStatusFailed: 'Saved, but reading the runtime state failed: {reason}',
    jobDraining: 'Cancelled; the old request may still be returning. No new paid request will be stacked on it until it exits.',
    jobReviewLearned: 'Candidate lesson extracted',
    jobReviewDuplicate: 'This turn was already reviewed (no second model call)',
    jobReviewAbstained: 'The model found too little to learn from',
    jobReviewSkipped: 'Skipped: {reason}',
    jobReviewUnknown: 'Unrecognised result',
    jobDoneNoResult: 'The job finished with nothing to report.',
    jobTokens: 'Measured tokens',
    tokensUnknown: 'unknown (the provider reported no usage)',
    jobEvaluationImproved: 'improved/regressed',
    jobEvaluationUnknownCost: '{n} paired requests reported no usage',
    usageUnknownNote: ': charged conservatively at the reserved cap, so the cost is unknown. This does not change the verdict above.',
    jobRaw: 'Raw result',
    recentRecall: 'Most recent recall',
    detailsMore: 'Version and read-only details',
    runtimeHelpTitle: 'Runtime details and how it works',
    budgetHelp: 'Units and non-injection reasons',
    unitBytes: 'bytes',
    notReported: 'not reported',
    unknownError: 'unknown error',
    evalTokensLimit: 'Daily token cap',
    evalCallsLimit: 'Daily call cap',
    unitItems: '',
    unitCalls: '',
    discard: 'Discard',
    unsaved: 'Unsaved changes',
    goLessons: 'Open lessons →',
    gotoBudget: 'Adjust budget',
    dismiss: 'Dismiss',
    progress: 'Progress',
    jobsEmpty: 'No tasks yet. Preview, then start; a running task can be cancelled.',
    storeState: 'Store',
    suspendedExpired: 'Suspended / expired',
    lessonId: 'Lesson id',
    runtimeMode: 'How it runs',
    runtimeModeValue: 'Waiting for task events',
    model: 'Provider',
    reasoning: 'Reasoning',
    contextBudgetTitle: 'Context budget',
    turnBudgetHint: 'Counts lesson text only, in UTF-8 bytes.',
    sessionBudgetHint: 'Caps what lessons may occupy in one session.',
    evalBudgetTitle: 'Model evaluation budget',
    evalBudgetHint: 'Verifying a candidate calls a model. A budget of 0 disables it.',
    evalUsageTitle: 'Current usage and how it is computed',
    evalTokensUsed: 'Evaluation tokens used',
    evalCallsUsed: 'Evaluation calls used',
    evalJobsOpen: 'Evaluation jobs in flight',
    bytesUnit: 'Unit',
    emptyLessonsHint: 'Try another keyword or filter.',
    recallPickHint: 'Pick a session above to see its recall records and settlement.',
    recallNoneHint: 'Once a task turn happens, this shows whether lessons were injected.',
    diagnoseHint: 'Describe a task to see which lessons could match. The preview calls no model.',
    turnsHint: 'Pick a finished turn and distil a reusable lesson. Preview which task it is first.',
    turnsIdle: 'Read this session\u2019s finished turns.',
    turnsNoneHint: 'This session has no finished turn to review yet.',
    verifyNoLessonHint: 'This scope has no method lesson yet.',
    previewNote: 'The review uses the selected session\u2019s own model. It only proposes a candidate lesson; nothing is marked verified.',
    previewModel: 'Model for this run',
    previewSource: 'Review source',
    advancedHint: 'The model evaluation budget lives on the Budget page.',
    settingsPath: 'Settings → Self-evolution',
    settingsPointer: 'The complete settings live at “Settings → Self-evolution” in the sidebar: enable/pause, automatic reflection, the context cap, manual review and candidate verification, plus the overview, lessons, recall and budget views. This page keeps the host’s plugin-management information only and mounts no second panel.',
    reasonNamesForControl: { plugin_disposed: 'Plugin unloading', legacy_controller: 'Legacy MSE controller active',
      user_paused: 'Paused by the user', plugin_not_started: 'Not started' },
    unavailable: 'Unavailable.', selected: 'Selected',
    controls: 'Runtime controls',
    controlsNote: 'Saving only changes the value the next real use sees; saving itself calls no model and injects nothing.',
    masterSwitch: 'Persistent learning',
    masterHint: 'Learns from tasks automatically; pausing keeps what was learned',
    masterHintFull: 'Loaded with DSH and driven by task events; no extra daemon. While paused this page and the read-only diagnostics stay available, and stored lessons, spent budget and pending settlements are all kept.',
    autoReflect: 'Automatic reflection',
    autoReflectHint: 'Distils a lesson after a task, at most 3 per day',
    autoReflectHintFull: 'Uses the task’s own model and reasoning route; at most 3 per 24 h, at least 30 min apart, at most 384 output tokens each. Turning it off cancels this plugin’s queued and in-flight automatic reflection only; corrections, recall and trusted settlement are unaffected.',
    contextBytes: 'Per-turn context cap',
    contextBytesHint: 'Per-turn injection cap, in bytes',
    contextBytesHintFull: 'Valid range {min}–{max} bytes, default {def}. The 1536-byte session cap and the 2-lessons-per-turn cap are fixed by the core and cannot be changed here; an edit applies to the next injection and never refunds or clears budget a session already spent.',
    advanced: 'Advanced: model evaluation budget',
    advancedHint: 'Default 0 disables model-based candidate verification. Registered-algorithm regressions use no model and no budget.',
    evalTokens: 'Daily evaluation token cap', evalCalls: 'Daily evaluation call cap',
    save: 'Save', saving: 'Saving…', saved: 'Saved and in effect.',
    saveFailed: 'Not saved: {reason}',
    reloadNeeded: 'Rejected: the configuration may have changed elsewhere, or a value is out of range. Host values were reloaded.',
    saveUnavailable: 'This client cannot write host settings (not loopback, or read-only); showing saved values.',
    configUnavailable: 'The host settings namespace is unavailable; switches are read-only.',
    userEnabled: 'User enabled', effectiveState: 'Effective state', effectiveRunning: 'Running (waiting for task events)',
    effectivePaused: 'Paused', effectiveReasons: 'Reasons', autoReflectEffective: 'Automatic reflection',
    autoReflectOn: 'On ({used}/{limit} used in 24 h)', autoReflectOff: 'Off',
    recentRun: 'Recent recall / failures',
    noRuns: 'No record in this process yet (counting restarts at zero; stored lessons and usage are unaffected).',
    runsObserved: 'This process has recorded turns for {n} sessions',
    jobsTitle: 'Task log', jobsNone: 'No manual job yet.',
    jobsNote: 'Jobs live in this process only: a Host restart interrupts and drops unfinished jobs and never replays a model request.',
    jobState: { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled', blocked: 'Blocked' },
    jobKind: { review: 'Manual review', registered: 'Registered-method verification', evaluation: 'Paired candidate verification' },
    cancelJob: 'Cancel',
    manualTitle: 'Manual review and verification',
    manualNote: 'Uses the Host’s own session log; previewing sends no model request.',
    turnsTitle: 'Manual review', turnsPick: 'Pick a session above, then read its turns.',
    turnsLoad: 'Read this session’s turns', turnsNone: 'This session has no finished turn to review.',
    turnLine: 'Turn {turn} · {reason}', turnPreview: 'Preview', turnStart: 'Start review',
    turnUsed: 'Reviewed', turnBlocked: 'Not reviewable',
    previewTitle: 'About to process', previewTask: 'Task (truncated)', previewResult: 'Result (truncated)',
    previewRoute: 'Model to use', previewOutcome: 'Review basis', previewQuota: 'Review allowance',
    previewQuotaValue: '{allowance}/{limit} left in 24 h', previewCooldown: 'Cooling down until {at}',
    previewDuplicate: 'This turn was already reviewed; no second model request will be sent.',
    previewPermission: 'Current permission: {reason}', previewEnabled: 'Allowed',
    inheritedUnsupported: 'This session contains inherited turns (from a fork); they are not listed here and cannot be used as this session’s evidence.',
    verifyTitle: 'Verify a candidate lesson', verifyPickLesson: 'Pick a method lesson',
    verifyNoLesson: 'No method lesson in this scope.', verifyLoad: 'Read this scope’s methods',
    verifyLesson: '{kind} · {status} · v{version}',
    verifyRegistered: 'This method has a registered algorithm: verification calls no model and consumes no evaluation budget.',
    verifyGeneric: 'This method has no registered algorithm: the same model runs the same cases with an experience-free baseline and with the candidate, and the Host scores both with a fixed checker.',
    verifyCases: 'Validation set (JSON array)',
    verifyCasesHint: 'Each item {caseId, family, split: development|holdout, prompt, checker:{kind, expected}}; {min}–{max} items, holdout ≥ 4 with ≥ 2 families overall and in holdout. Content-identical duplicates are refused.',
    verifyCaseTemplate: 'Insert example', verifyPlan: 'Preview and validate', verifyStart: 'Start verification',
    verifyPlanTitle: 'Verification plan', verifyTarget: 'Target', verifyPlanCases: 'Cases',
    verifyPlanCasesValue: '{accepted} accepted · {families} families · {holdout} holdout',
    verifyPlanRequests: 'Paired requests', verifyPlanReserve: 'Reserved token cap',
    verifyPlanRemaining: 'Daily allowance', verifyPlanRemainingValue: '{tokens} tokens and {calls} calls left',
    verifyPlanDeadline: 'Whole job ≤ {minutes} min (≤ 1 min per request)',
    verifyPlanReady: 'Ready to start', verifyPlanBlocked: 'Cannot start yet: {reason}',
    verifyResult: 'Result', verifyDecision: { accepted: 'Accepted (this validation set only)', rejected: 'Rejected', inconclusive: 'Inconclusive' },
    verifyBoundaryTitle: 'What this verification does and does not show',
    verifyBoundary: 'The verdict covers this validation set only: you supplied the cases, so it is not evidence of general effectiveness, and family labels prove counts, not statistical independence.',
    verifyRegisteredDone: 'The registered deterministic regression uses no model; token usage is 0.',
    usageUnknown: 'Some requests reported no real usage; the reserved cap was charged conservatively and the verdict is inconclusive.',
    resultSummary: 'Summary', resultReasons: 'Reasons', resultLesson: 'Lesson version',
  }

  /**
   * Layout only. Every colour, radius, border and type size comes from the host's own CSS
   * variables, so this page follows the shell's light and dark themes without defining a
   * single value of its own.
   */
  /**
   * The confirmed design's layout, expressed only in host tokens.
   *
   * Two rules matter more than the rest:
   *   * nothing inside the host's single scrolling column may paint its own opaque surface —
   *     the column is transparent by contract, so a filled card meets the scroll clip edge and
   *     appears to bleed under the panel header;
   *   * the five tabs are the host's own `SegmentedTabs`, whose sliding indicator is laid out
   *     on a grid over the full list width. Overriding its `display` desynchronises the
   *     indicator from the labels, so no geometry class is passed to it at all.
   */
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
.mse-details .mse-row:last-child{border-bottom:none}
.mse-details .mse-row-main{flex:1;min-width:0}
.mse-details .mse-row-title{font-weight:400;line-height:22px;overflow-wrap:anywhere}
.mse-details .mse-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:20px;margin-top:3px;overflow-wrap:anywhere}
.mse-details .mse-row-side{flex:none;min-width:0;display:flex;align-items:center;justify-content:flex-end;gap:8px;font-size:13px}
.mse-details .mse-unit{color:var(--dsw-alias-label-tertiary);font-size:12px}
.mse-details .mse-num{width:88px}
.mse-details .mse-num-wide{width:118px}
.mse-details .mse-section-title{margin:24px 0 2px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);font-weight:400;display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.mse-details .mse-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;padding:16px 0 20px;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.mse-details .mse-metric-label{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:5px}
.mse-details .mse-metric-value{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.mse-details .mse-metric-value b{font-size:20px;line-height:28px;font-weight:500;font-variant-numeric:tabular-nums}
.mse-details .mse-metric-value span{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.mse-details .mse-disclosure{border-bottom:0.5px solid var(--dsw-alias-border-l2);min-width:0}
.mse-details .mse-disclosure>summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;padding:16px 0;font-size:13px}
.mse-details .mse-disclosure>summary::-webkit-details-marker{display:none}
.mse-details .mse-chevron{transition:transform 150ms;width:14px;height:14px;flex:none;color:var(--dsw-alias-label-tertiary)}
.mse-details .mse-disclosure[open]>summary .mse-chevron{transform:rotate(90deg)}
.mse-details .mse-detail-body{padding:0 0 16px;min-width:0}
.mse-details .mse-definition{display:grid;grid-template-columns:minmax(90px,auto) minmax(0,1fr);gap:10px 20px;margin:0;font-size:12px;line-height:20px}
.mse-details .mse-definition dt{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.mse-details .mse-definition dd{margin:0;text-align:right;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.mse-details .mse-definition.mse-left dd{text-align:left}
.mse-details .mse-scope{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0 16px;border-bottom:0.5px solid var(--dsw-alias-border-l2);margin-bottom:16px;min-width:0}
.mse-details .mse-scope label{font-size:12px;color:var(--dsw-alias-label-tertiary);flex:none}
/* One picker for every choice on the page: the host's Button + anchored Menu, so the trigger
   carries the shell's own border, radius, hover and focus ring in both themes. */
.mse-details .mse-picker{display:inline-flex;flex:none;min-width:0;max-width:100%}
.mse-details .mse-picker-trigger{max-width:100%;justify-content:space-between;gap:8px}
.mse-details .mse-picker-label{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;text-align:left}
.mse-details .mse-picker-chevrons{flex:none;color:var(--dsw-alias-label-tertiary)}
.mse-details .mse-picker-scope{width:245px;max-width:calc(100% - 58px)}
.mse-details .mse-picker-scope .mse-picker-trigger{width:100%}
.mse-details .mse-picker-filter{max-width:140px}
.mse-details .mse-picker-filter .mse-picker-label{max-width:104px}
.mse-details .mse-picker-wide,.mse-details .mse-picker-wide .mse-picker-trigger{width:100%}
.mse-details .mse-scope .mse-picker-scope{width:245px;max-width:calc(100% - 58px)}
.mse-details .mse-toolbar{display:flex;gap:8px;margin:12px 0 6px;align-items:center;min-width:0}
.mse-details .mse-search{flex:1;min-width:0}
.mse-details .mse-toolbar select{max-width:120px}
.mse-details .mse-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;min-width:0}
.mse-details .mse-badge{font-size:11px;line-height:18px;border-radius:4px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);padding:1px 6px;display:inline-flex;white-space:nowrap;font-weight:400}
.mse-details .mse-lesson{border-bottom:0.5px solid var(--dsw-alias-border-l2);min-width:0}
.mse-details .mse-lesson>summary{cursor:pointer;display:flex;align-items:flex-start;gap:12px;list-style:none;padding:16px 0}
.mse-details .mse-lesson>summary::-webkit-details-marker{display:none}
.mse-details .mse-lesson-heading{flex:1;min-width:0}
.mse-details .mse-lesson-title{font-size:13px;line-height:22px;overflow-wrap:anywhere;margin-bottom:4px}
.mse-details .mse-lesson-detail{padding:0 0 18px;min-width:0}
.mse-details .mse-lesson-detail .mse-definition{padding:12px 0}
.mse-details .mse-note{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:20px;padding:12px 0;overflow-wrap:anywhere}
.mse-details .mse-callout{padding:12px 14px;background:var(--dsw-alias-bg-module-platform);border-radius:8px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:20px;margin:12px 0;overflow-wrap:anywhere}
.mse-details .mse-callout p{color:inherit}
.mse-details .mse-footline{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0;color:var(--dsw-alias-label-tertiary);font-size:12px;flex-wrap:wrap}
.mse-details .mse-empty{padding:44px 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:22px}
.mse-details .mse-empty p+p{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:6px}
.mse-details .mse-form-block{margin:16px 0;min-width:0}
.mse-details .mse-form-block>label{display:block;font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:7px}
.mse-details .mse-textarea{display:block;width:100%;min-height:80px;resize:vertical;font:inherit;font-size:13px;line-height:22px;color:inherit;background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;overflow-wrap:anywhere}
.mse-details .mse-cases{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;min-height:120px;white-space:pre-wrap}
.mse-details .mse-actions{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap;padding-top:12px}
.mse-details .mse-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:20px;overflow-wrap:anywhere}
.mse-details .mse-notice{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;min-height:20px;overflow-wrap:anywhere}
.mse-details .mse-ok{color:var(--dsw-alias-state-business-primary);font-size:12px;line-height:20px}
.mse-details .mse-job{padding:16px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2);min-width:0}
.mse-details .mse-job:last-child{border-bottom:none}
.mse-details .mse-job-head{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}
.mse-details .mse-job-head h3{margin:0;font-size:13px;font-weight:400}
.mse-details .mse-job-actions{display:flex;gap:8px;align-items:center;flex:none}
.mse-details .mse-steps{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:10px;flex-wrap:wrap}
.mse-details .mse-pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.mse-details .mse-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow-wrap:anywhere}
.mse-details .mse-test-long{overflow-wrap:anywhere;word-break:break-word}
.mse-details .mse-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}
@media(max-width:620px){
.mse-details .mse-row{gap:12px}
.mse-details .mse-metrics{gap:8px}
.mse-details .mse-definition{grid-template-columns:minmax(70px,auto) minmax(0,1fr);gap:8px 12px}
.mse-details .mse-toolbar{flex-wrap:wrap}
.mse-details .mse-toolbar .mse-search{flex-basis:100%}
.mse-details .mse-scope{gap:8px}
.mse-details .mse-scope select{width:100%;max-width:100%}
.mse-details .mse-num{width:74px}
.mse-details .mse-row-side{gap:5px}
}
`

  const h = React.createElement
  const reasonLabel = (dict, code) => (dict.reasonNames && dict.reasonNames[code]) || code || ''
  const settleLabel = (dict, state) => (dict.settleNames && dict.settleNames[state]) || state || ''
  const codeLabel = (dict, code) => (dict.codeNames && dict.codeNames[code]) || code || ''
  const kindLabel = (dict, kind) => kind === 'method' ? dict.kindMethod : dict.kindCorrection
  const formatBytes = value => `${Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0} B`
  const formatTime = (value, locale) => Number.isFinite(value) && value > 0
    ? new Date(value).toLocaleString(locale === 'zh' ? 'zh-CN' : locale || 'en', { hour12: false }) : '—'
  const shortId = value => typeof value === 'string' ? value.replace(/^lesson_/u, '').slice(0, 8) : '—'
  /** What the in-process recall memory can actually say about the newest observed turn. */
  const recentLine = (dict, turn) => {
    if (turn === null || turn === undefined) return dict.recallNone
    const when = Number.isFinite(turn.at) && turn.at > 0
      ? new Date(turn.at).toLocaleTimeString('zh-CN', { hour12: false }) : '—'
    return `${turn.reason === 'recalled' ? dict.reasonNames.recalled : reasonLabel(dict, turn.reason)} · ${when}` +
      `${turn.bytes > 0 ? ` · ${formatBytes(turn.bytes)}` : ''}`
  }
  const fill = (template, values) => Object.entries(values)
    .reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template)
  const storeState = (dict, store) => {
    if (store === undefined || store === null) return { tone: 'err', text: dict.unavailable }
    if (store.migrationRequired === true) return { tone: 'warn', text: dict.storeMigration }
    if (store.readable !== true) return { tone: 'err', text: `${dict.storeError}${store.error ? ` · ${store.error}` : ''}` }
    return { tone: 'ok', text: `${dict.storeReadable} · schema ${store.schema}` }
  }
  const statusTone = status => status === 'validated' ? 'ok' : status === 'suspended' || status === 'expired' ? 'err' : 'warn'
  const statusLabelOf = (dict, status) => ({ reminder: dict.activeCorrections, candidate: dict.methodsUnvalidated,
    tested: dict.methodsUnvalidated, validated: dict.methodsValidated, suspended: dict.suspended }[status] || status || '—')
  const environmentLabel = (dict, row) => row?.currentEnvironment === null || row?.currentEnvironment === undefined
    ? dict.environmentNone : row.currentEnvironment === true ? dict.environmentCurrent : dict.environmentOther
  const normalizeQuery = input => ({
    query: typeof input.query === 'string' ? input.query.slice(0, MAX_QUERY_CHARS) : '',
    kind: ['correction', 'method'].includes(input.kind) ? input.kind : '',
    status: ['reminder', 'candidate', 'tested', 'validated', 'suspended'].includes(input.status) ? input.status : '',
    page: Number.isSafeInteger(input.page) && input.page > 0 ? input.page : 1,
    pageSize: PAGE_SIZES.includes(input.pageSize) ? input.pageSize : 20,
    sessionId: typeof input.sessionId === 'string' && input.sessionId.length > 0 ? input.sessionId : undefined,
  })
  const scopeLine = (dict, scope) => scope === null || scope === undefined
    ? dict.scopeDefault
    : `${scope.label ?? '—'} · ${scope.kind === 'project' ? dict.scopeProject : dict.scopeInstance}` +
      `${scope.scopeHash ? ` · ${scope.scopeHash}` : ''}${scope.archived === true ? ` · ${dict.scopeArchived}` : ''}`

  /** Session options: one default scope plus the Host's own directory, honestly labelled. */
  function sessionOptions(dict, payload) {
    const options = [{ id: '', label: dict.scopeDefault }]
    if (payload === null || payload === undefined) return options
    if (payload.ok !== true) {
      options.push({ id: '', label: dict.scopeUnknown })
      return options
    }
    for (const row of payload.sessions ?? []) {
      const flags = [row.scope === 'project' ? dict.scopeProject : dict.scopeInstance,
        row.running === true ? dict.scopeRunning : null,
        row.archived === true ? dict.scopeArchived : null,
        row.live === true ? dict.scopeLive : null,
        row.persisted === true ? dict.scopePersisted : null].filter(Boolean)
      options.push({ id: row.id, label: `${row.label ?? '—'} · ${flags.join(' · ')}` })
    }
    return options
  }

  /**
   * The host's anchored picker: an outline Button carrying a chevrons affordance, and a
   * portalled Menu for the list.
   *
   * This replaces the native `<select>`. A `<select>` cannot be made to look like a DSH
   * control — its arrow, inner padding and popup are the platform's — and the settings panel
   * clips its popup (`overflow: hidden`), so it also behaved worse. Every choice on this page
   * uses this one control, so 会话, 经验筛选 and 候选经验 cannot drift apart visually.
   */
  function Picker({ label, value, options, onChange, disabled = false, testId = undefined, className = '' }) {
    const [open, setOpen] = React.useState(false)
    const selected = options.find(option => option.id === value) ?? options[0]
    const items = options.map(option => ({ id: option.id === '' ? '__default' : option.id, label: option.label }))
    return h(Menu, {
      open, portal: true, compact: true, className: `mse-picker ${className}`.trim(),
      'data-mse-picker': testId,
      // `Button.icon` renders a LEADING icon; a picker's affordance belongs at the trailing
      // edge, after the label, which is why the chevrons are an ordinary child here.
      anchor: h(Button, { variant: 'outline', size: 'sm', disabled, className: 'mse-picker-trigger',
        'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-label': label,
        onClick: () => setOpen(current => !current) }, [
        h('span', { key: 'l', className: 'mse-picker-label' }, selected?.label ?? label),
        h(IconChevronsUpDownOutlineRegular, { key: 'c', className: 'mse-picker-chevrons' }),
      ]),
      items,
      selectedId: value === '' ? '__default' : value,
      onSelect: id => { onChange(id === '__default' ? '' : id); setOpen(false) },
      onClose: () => setOpen(false),
    })
  }

  /**
   * One remote call, unwrapped into the Host payload or a labelled failure.
   * The Remote envelope is `{ok, value}`; the page only ever reads `value`.
   */
  async function callRemote(call, method, input) {
    const result = await call(method, input)
    if (result === undefined || result === null) throw new Error('empty_result')
    if (result.ok !== true) {
      const code = String(result.code ?? result.error?.code ?? 'remote_failed')
      const detail = typeof result.error?.message === 'string' ? result.error.message.slice(0, 200) : ''
      throw new Error(detail === '' ? code : `${code}: ${detail}`)
    }
    if (result.value === undefined || result.value === null) throw new Error('empty_result')
    return result.value
  }

  const failureCode = error => String(error?.message ?? error).split(':')[0].trim() || 'remote_failed'
  const failureText = (dict, error) => {
    const code = failureCode(error)
    const label = codeLabel(dict, code)
    return label === code ? String(error?.message ?? code) : `${label}（${code}）`
  }

  /** Control-plane payloads are `{ok:false, code}` objects too; unwrap them without throwing. */
  const controlCall = async (control, method, input) => {
    const value = await callRemote(control, method, input ?? {})
    return value
  }

  // One keyed fragment per term: a nested array of two elements would make React warn about
  // missing keys inside a definition list that is itself an array child. Defined once, at
  // factory scope, because the manual panel builds the same definition lists.
  const term = (label, value) => h(React.Fragment, { key: label },
    h('dt', null, label), h('dd', { style: { margin: 0 } }, value))
  const card = (label, value) => h('div', { key: label, className: 'mse-card' },
    h('span', { className: 'mse-label' }, label), h('b', null, String(value)))
  /**
   * The page's shared primitives. Every one of them is the confirmed design's own shape:
   * a plain 16px row with a hairline, a native disclosure whose chevron is always visible,
   * and a right-aligned definition list.
   */
  const row = (key, title, hint, side, options = {}) => h('div', { key,
    className: `mse-row${options.top === true ? ' mse-row-top' : ''}` }, [
    h('div', { key: 'main', className: 'mse-row-main' }, [
      typeof title === 'string' ? h('div', { key: 't', className: 'mse-row-title' }, title) : title,
      hint === null || hint === undefined ? null : h('p', { key: 'h', className: 'mse-hint' }, hint),
    ]),
    side === null || side === undefined ? null : h('div', { key: 'side', className: 'mse-row-side' },
      Array.isArray(side) ? side : [side]),
  ])
  const disclosure = (key, title, body, options = {}) => h('details', { key, className: 'mse-disclosure',
    'data-mse-disclosure': options.id, open: options.open === true },
  h('summary', { key: 's' }, [h('span', { key: 't' }, title),
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
      unit === undefined ? null : h('span', { key: 'u' }, unit)]),
  ])
  const sectionTitle = (key, title, action) => h('h2', { key, className: 'mse-section-title' }, [
    h('span', { key: 't' }, title),
    action === undefined ? null : action,
  ])
  const emptyState = (key, title, hint) => h('div', { key, className: 'mse-empty' }, [
    h('p', { key: 't' }, title),
    hint === undefined ? null : h('p', { key: 'h' }, hint),
  ])
  const scopeRow = (key, label, entries, value, onChange, disabled = false) => h('div', { key, className: 'mse-scope' }, [
    h('label', { key: 'l', id: `mse-scope-label-${key}` }, label),
    h(Picker, { key: 'p', label, value, options: entries, onChange, disabled, testId: `scope-${key}`,
      className: 'mse-picker-scope' }),
  ])
  const filterSelect = (label, entries, value, onChange) => h(Picker, {
    key: label, label, value, options: entries.map(([id, text]) => ({ id: id === '' ? '__default' : id, label: text })),
    onChange: next => onChange(next === '__default' ? '' : next), testId: `filter-${label}`, className: 'mse-picker-filter',
  })
  /** One settings row with label, hint and control. */
  const field = (key, label, hint, control) => h('label', { key, className: 'mse-field' },
    h('span', { className: 'mse-label' }, label),
    control,
    hint === null || hint === undefined ? null : h('span', { className: 'mse-note' }, hint))

  const diagnosticLine = diagnostics => diagnostics === null || diagnostics === undefined
    ? '—'
    : `匹配 ${diagnostics.matched ?? 0} / 候选 ${diagnostics.candidates ?? 0} / 可用 ${diagnostics.eligible ?? 0}` +
      ` · 已提供 ${diagnostics.alreadyOffered ?? 0} · 过期 ${diagnostics.expired ?? 0} · 停用 ${diagnostics.suspended ?? 0}` +
      ` · 其他作用域 ${diagnostics.otherScope ?? 0} · 方法未验证 ${diagnostics.methodUnvalidated ?? 0}`

  /** Live host-config snapshot bound to a React render, without assuming React 18 APIs. */
  function useFormSnapshot(form) {
    const [snapshot, setSnapshot] = React.useState(() => form === undefined ? null : form.getSnapshot())
    React.useEffect(() => {
      if (form === undefined) return undefined
      setSnapshot(form.getSnapshot())
      return form.subscribe(() => setSnapshot(form.getSnapshot()))
    }, [form])
    return snapshot
  }

  const defaultDraft = value => ({
    enabled: value?.enabled !== false,
    reflectionEnabled: value?.reflectionEnabled !== false,
    maxContextBytes: String(value?.maxContextBytes ?? 768),
    evaluationTokensPerDay: String(value?.evaluationTokensPerDay ?? 0),
    evaluationCallsPerDay: String(value?.evaluationCallsPerDay ?? 2),
  })

  /**
   * Turn a draft plus the accepted host values into the smallest atomic op list.
   *
   * Numbers are validated here so an obvious typo is reported before it travels, but the
   * authoritative check is the Host schema: this is convenience, not a second rulebook.
   */
  function diffOps(draft, value) {
    const ops = []
    const problems = []
    if (draft.enabled !== (value?.enabled !== false)) ops.push({ op: 'set', path: ['enabled'], value: draft.enabled })
    if (draft.reflectionEnabled !== (value?.reflectionEnabled !== false)) {
      ops.push({ op: 'set', path: ['reflectionEnabled'], value: draft.reflectionEnabled })
    }
    const number = (raw, min, max, label) => {
      const parsed = Number(String(raw).trim())
      if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        problems.push(`${label} ${min}–${max}`)
        return null
      }
      return parsed
    }
    const bytes = number(draft.maxContextBytes, CONTEXT_MIN, CONTEXT_MAX, 'maxContextBytes')
    if (bytes !== null && bytes !== value?.maxContextBytes) ops.push({ op: 'set', path: ['maxContextBytes'], value: bytes })
    const tokens = number(draft.evaluationTokensPerDay, 0, EVAL_TOKENS_MAX, 'evaluationTokensPerDay')
    if (tokens !== null && tokens !== value?.evaluationTokensPerDay) {
      ops.push({ op: 'set', path: ['evaluationTokensPerDay'], value: tokens })
    }
    const calls = number(draft.evaluationCallsPerDay, 0, EVAL_CALLS_MAX, 'evaluationCallsPerDay')
    if (calls !== null && calls !== value?.evaluationCallsPerDay) {
      ops.push({ op: 'set', path: ['evaluationCallsPerDay'], value: calls })
    }
    return { ops, problems }
  }

  /**
   * A job row. A raw JSON dump is not an answer, so each kind gets a plain-language outcome,
   * with the raw payload one click away for anyone who wants it. An unknown cost is reported
   * as unknown *alongside* the verdict rather than instead of it: a rejected candidate stays
   * rejected even when some request never reported usage.
   */
  function JobRow({ dict, job, locale, onCancel }) {
    if (job === null || job === undefined) return null
    const state = dict.jobState[job.state] ?? job.state
    const tone = job.state === 'done' ? 'done' : job.state === 'failed' || job.state === 'blocked' ? 'error' : 'ongoing'
    const result = job.result ?? null
    const lines = []
    if (result !== null && result.kind === 'review') {
      if (result.status === 'learned') {
        lines.push(`${dict.jobReviewLearned} · ${shortId(result.lessonId)} v${result.version ?? 0}` +
          `${result.evaluation ? ` · ${result.evaluation}` : ''}`)
      } else if (result.status === 'duplicate') lines.push(`${dict.jobReviewDuplicate} · ${shortId(result.lessonId)}`)
      else if (result.status === 'abstained') lines.push(dict.jobReviewAbstained)
      else if (result.status === 'skipped') lines.push(fill(dict.jobReviewSkipped, { reason: codeLabel(dict, result.reason) }))
      else lines.push(dict.jobReviewUnknown)
      lines.push(`${dict.jobTokens}：${result.usage === 'unknown' || result.usage === undefined
        ? dict.tokensUnknown : String(result.usage)}`)
    } else if (result !== null && result.kind === 'evaluation') {
      const decision = result.decision ?? 'inconclusive'
      const summary = result.summary ?? null
      lines.push(`${dict.verifyResult}：${dict.verifyDecision[decision] ?? decision}` +
        `${result.basis === 'registered_algorithm' ? ` · ${dict.verifyRegisteredDone}` : ''}`)
      if (summary !== null) {
        lines.push(`${dict.verifyPlanCases}：${summary.pairs ?? 0} · ${dict.jobEvaluationImproved} ` +
          `${summary.improved ?? 0}/${summary.regressed ?? 0} · p=${summary.pValue ?? '—'}`)
        if (summary.unknownCostPairs > 0) {
          lines.push(fill(dict.jobEvaluationUnknownCost, { n: summary.unknownCostPairs }) + dict.usageUnknownNote)
        }
      }
      if (Array.isArray(result.reasons) && result.reasons.length > 0) {
        lines.push(`${dict.resultReasons}：${result.reasons.map(code => codeLabel(dict, code)).join('、')}`)
      }
    } else if (job.state === 'done') lines.push(dict.jobDoneNoResult)
    const live = job.state === 'queued' || job.state === 'running'
    return h('div', { className: 'mse-job', 'data-mse-job': job.state }, [
      h('div', { key: 'head', className: 'mse-job-head' }, [
        h('h3', { key: 't' }, [dict.jobKind[job.kind] ?? job.kind, job.label ? ` · ${job.label}` : '']),
        h('div', { key: 'a', className: 'mse-job-actions' }, [
          h('span', { key: 's', className: 'mse-meta' }, [
            h(StateDot, { key: 'd', state: tone, size: 6 }),
            h('span', { key: 't' }, state),
          ]),
          live ? h(Button, { key: 'c', variant: 'outline', size: 'sm', disabled: job.draining === true,
            onClick: () => onCancel(job.id) }, dict.cancelJob) : null,
        ]),
      ]),
      job.progress?.total > 0 ? h('p', { key: 'p', className: 'mse-steps' },
        `${dict.progress}：${job.progress.done ?? 0} / ${job.progress.total}`) : null,
      lines.length === 0 ? null : h('div', { key: 'l' },
        lines.map((line, index) => h('p', { key: index, className: 'mse-hint' }, line))),
      job.draining === true ? h('p', { key: 'draining', className: 'mse-hint' }, dict.jobDraining) : null,
      job.code ? h('p', { key: 'code', className: 'mse-error' },
        `${dict.reason}：${codeLabel(dict, job.code)}（${job.code}）`) : null,
      h('p', { key: 'id', className: 'mse-hint mse-mono' },
        `${job.id} · ${formatTime(job.submittedAt, locale)}${job.endedAt ? ` → ${formatTime(job.endedAt, locale)}` : ''}`),
      h('details', { key: 'raw', className: 'mse-disclosure' }, [
        h('summary', { key: 's' }, [h('span', { key: 't' }, dict.jobRaw),
          h(IconChevronRightOutlineRegular, { key: 'c', className: 'mse-chevron' })]),
        h('div', { key: 'b', className: 'mse-detail-body' },
          h('pre', { key: 'p', className: 'mse-pre mse-mono' }, JSON.stringify(job, null, 2))),
      ]),
    ])
  }

  /**
   * The shared panel. The settings section and the plugin page both render this component; the
   * settings section additionally receives `form` (and therefore the switches).
   */
  function MsePanel(props) {
    const dict = props.locale === 'en' ? en : zh
    const call = props.call
    const control = props.control
    const form = props.form
    const locale = props.locale
    const [tab, setTab] = React.useState(props.initialTab ?? 'overview')
    const [sessionId, setSessionId] = React.useState('')
    const [auto, setAuto] = React.useState(false)
    const [reloadToken, setReloadToken] = React.useState(0)
    const [listQuery, setListQuery] = React.useState({ query: '', kind: '', status: '', page: 1, pageSize: 20 })
    // Every slot carries the scope it belongs to: a late answer can never repaint another scope.
    const [shell, setShell] = React.useState({ status: 'idle' })
    const [recall, setRecall] = React.useState(null)
    const [lessons, setLessons] = React.useState(null)
    const [detail, setDetail] = React.useState(null)
    // One row open at a time: every row reads the same fetched detail, so letting two stand open
    // would show "reading…" in one of them for as long as the other stayed open.
    const [openLesson, setOpenLesson] = React.useState(null)
    const [prompt, setPrompt] = React.useState('')
    const [dryRun, setDryRun] = React.useState(null)
    // `controlState` is a three-state slot, not a nullable payload: "we could not read the
    // runtime state" is a different fact from "the runtime is paused", and showing the second
    // when the first is true would tell the operator their pause worked when nobody checked.
    const [controlState, setControlState] = React.useState({ status: 'loading' })
    const [controlError, setControlError] = React.useState(null)
    const [job, setJob] = React.useState(null)
    const [draft, setDraft] = React.useState(null)
    const [advanced, setAdvanced] = React.useState(false)
    const [helpOpen, setHelpOpen] = React.useState(false)
    const [saveState, setSaveState] = React.useState(null)
    // A save changes the revision too; without this the page would accuse itself of a remote
    // edit and show the stale-draft warning about the write it just made.
    const ownWrite = React.useRef(false)
    const generation = React.useRef(0)
    // The scope generation covers "another scope"; these cover "another request of the same
    // resource in the same scope", so the newest query or click always wins.
    const listSeq = React.useRef(0)
    const detailSeq = React.useRef(0)
    const diagnoseSeq = React.useRef(0)
    const controlSeq = React.useRef(0)
    const jobSeq = React.useRef(0)
    const scopeKey = sessionId === '' ? 'default' : sessionId
    const snapshot = useFormSnapshot(form)

    const accepted = snapshot !== null && snapshot.status === 'ready' ? snapshot.value : undefined
    const writable = snapshot !== null && snapshot.writable === true && snapshot.mode === 'host'

    React.useEffect(() => {
      generation.current += 1
      const mine = generation.current
      setShell(current => ({ ...current, status: 'loading' }))
      // Leaving a scope drops everything that belonged to it.
      setDetail(null)
      setOpenLesson(null)
      setDryRun(null)
      setRecall(null)
      setLessons(null)
      setJob(null)
      listSeq.current += 1
      detailSeq.current += 1
      diagnoseSeq.current += 1
      controlSeq.current += 1
      jobSeq.current += 1
      setListQuery(current => ({ ...current, page: 1 }))
      void (async () => {
        try {
          const [overview, sessions] = await Promise.all([
            callRemote(call, 'overview', {}),
            callRemote(call, 'sessions', {}),
          ])
          if (generation.current !== mine) return
          setShell({ status: 'ready', overview, sessions, error: null })
        } catch (error) {
          if (generation.current !== mine) return
          setShell(current => ({ ...current, status: 'error', error: failureText(dict, error) }))
        }
      })()
      if (control !== undefined && control !== null) {
        setControlState({ status: 'loading' })
        void (async () => {
          try {
            const payload = await controlCall(control, 'status', {})
            if (generation.current !== mine) return
            setControlState(payload.ok === true ? { status: 'ready', payload }
              : { status: 'error', error: `${codeLabel(dict, payload.code)}（${payload.code}）` })
          } catch (error) {
            if (generation.current !== mine) return
            setControlState({ status: 'error', error: failureText(dict, error) })
          }
        })()
      }
      return () => { if (generation.current === mine) generation.current += 1 }
    }, [call, control, sessionId, reloadToken, dict])

    // Recall and the session byte ledger follow the selection, not the tab, so the budget view
    // reads the same answer instead of refetching it and losing it.
    React.useEffect(() => {
      const mine = generation.current
      void (async () => {
        try {
          const payload = await callRemote(call, 'recall', sessionId === '' ? {} : { sessionId })
          if (generation.current !== mine) return
          setRecall({ scopeKey, payload })
        } catch (error) {
          if (generation.current !== mine) return
          setRecall({ scopeKey, error: failureText(dict, error) })
        }
      })()
    }, [call, sessionId, scopeKey, reloadToken, dict])

    React.useEffect(() => {
      if (tab !== 'lessons') return undefined
      const mine = generation.current
      const seq = listSeq.current + 1
      listSeq.current = seq
      const mineNow = () => generation.current === mine && listSeq.current === seq
      void (async () => {
        try {
          const payload = await callRemote(call, 'lessons', { ...normalizeQuery(listQuery), sessionId })
          if (!mineNow()) return
          setLessons({ scopeKey, payload })
        } catch (error) {
          if (!mineNow()) return
          setLessons({ scopeKey, error: failureText(dict, error) })
        }
      })()
      return undefined
    }, [call, tab, sessionId, scopeKey, listQuery, reloadToken, dict])

    React.useEffect(() => {
      if (!auto) return undefined
      const timer = setInterval(() => setReloadToken(current => current + 1), REFRESH_INTERVAL_MS)
      return () => clearInterval(timer)
    }, [auto])

    // A job is polled only while it can still change, and never after the page is gone.
    React.useEffect(() => {
      if (job === null || job === undefined || !['queued', 'running'].includes(job.state)) return undefined
      if (control === undefined || control === null) return undefined
      const id = job.id
      const timer = setInterval(() => {
        const seq = jobSeq.current + 1
        jobSeq.current = seq
        void (async () => {
          try {
            const payload = await controlCall(control, 'job', { id })
            if (jobSeq.current !== seq) return
            if (payload.ok === true && payload.job !== null) setJob(payload.job)
          } catch { /* a transient read failure never becomes a fake success */ }
        })()
      }, JOB_POLL_MS)
      return () => clearInterval(timer)
    }, [control, job])

    // A draft carries the revision it was read at, and is only replaced by a remote update when
    // nothing local would be lost. Silently re-seeding from the Host would discard what the
    // person was typing; saving with the *current* revision instead of the draft's would let a
    // stale form overwrite a change made elsewhere. So: seed once, keep a dirty draft, and mark
    // it stale when the Host moved underneath it.
    React.useEffect(() => {
      if (accepted === undefined) return
      setDraft(current => {
        if (current === null) return { values: defaultDraft(accepted), revision: snapshot?.revision, from: accepted }
        if (current.revision === snapshot?.revision) return current
        if (ownWrite.current) { ownWrite.current = false; return { values: defaultDraft(accepted), revision: snapshot?.revision, from: accepted } }
        const dirty = JSON.stringify(current.values) !== JSON.stringify(defaultDraft(current.from))
        return dirty ? { ...current, stale: true } : { values: defaultDraft(accepted), revision: snapshot?.revision, from: accepted }
      })
    }, [accepted, snapshot])

    /** Re-read the runtime state; a failure here is reported, never shown as a pause. */
    const reloadControl = async () => {
      if (control === undefined || control === null) return
      try {
        const payload = await controlCall(control, 'status', {})
        setControlState(payload.ok === true ? { status: 'ready', payload }
          : { status: 'error', error: `${codeLabel(dict, payload.code)}（${payload.code}）` })
      } catch (error) { setControlState({ status: 'error', error: failureText(dict, error) }) }
    }
    /** Local edits never touch the revision the draft was read at. */
    const edit = patch => setDraft(current => current === null ? current
      : { ...current, values: { ...current.values, ...patch } })
    const save = async () => {
      if (draft === null || form === undefined) return
      const { ops, problems } = diffOps(draft.values, accepted)
      if (problems.length > 0) { setSaveState({ kind: 'invalid', detail: problems.join('、') }); return }
      if (ops.length === 0) { setSaveState({ kind: 'saved', count: 0 }); return }
      setSaveState({ kind: 'saving' })
      try {
        // One atomic mutate under the revision this draft was read at; `false` means the Host
        // refused (conflict or schema rejection) and the controller has already re-read it.
        const ok = await form.mutate(ops, draft.revision)
        if (ok !== true) { setSaveState({ kind: 'failed' }); return }
        ownWrite.current = true
        setSaveState({ kind: 'saved', count: ops.length })
        // "Saved" is a statement about the file, not about the running plugin. Re-read both the
        // runtime state and the read-only overview, and say so if that read fails, so a store
        // that accepted the write cannot be mistaken for a plugin that stopped.
        setReloadToken(current => current + 1)
        void (async () => {
          const before = controlState?.status
          await reloadControl()
          if (before === 'error') setControlError(null)
        })()
      } catch (error) {
        setSaveState({ kind: 'error', detail: String(error?.message ?? error).slice(0, 160) })
      }
    }
    const reseed = () => {
      if (accepted === undefined) return
      setDraft({ values: defaultDraft(accepted), revision: snapshot?.revision, from: accepted })
      setSaveState(null)
    }

    const openDetail = async id => {
      const mine = generation.current
      const seq = detailSeq.current + 1
      detailSeq.current = seq
      const mineNow = () => generation.current === mine && detailSeq.current === seq
      try {
        const payload = await callRemote(call, 'lesson', { id, ...(sessionId === '' ? {} : { sessionId }) })
        if (!mineNow()) return
        // The slot names the row it belongs to: a late answer for a row that was closed in the
        // meantime can then never paint itself into the row that is open now.
        setDetail({ scopeKey, id, payload })
      } catch (error) {
        if (!mineNow()) return
        setDetail({ scopeKey, id, error: failureText(dict, error) })
      }
    }
    const runDiagnose = async () => {
      const mine = generation.current
      const seq = diagnoseSeq.current + 1
      diagnoseSeq.current = seq
      const mineNow = () => generation.current === mine && diagnoseSeq.current === seq
      try {
        const payload = await callRemote(call, 'diagnose', { prompt, ...(sessionId === '' ? {} : { sessionId }) })
        if (!mineNow()) return
        setDryRun({ scopeKey, payload })
      } catch (error) {
        if (!mineNow()) return
        setDryRun({ scopeKey, error: failureText(dict, error) })
      }
    }

    const overview = shell.overview
    const store = storeState(dict, overview?.store)
    const enabled = overview?.enabled === true
    const legacy = overview?.legacyOwner === true
    const options = sessionOptions(dict, shell.sessions)
    // Read-only durable/control view. Absent control state means "unknown", never "confirmed".
    const durable = controlState?.status === 'ready' ? controlState.payload.runtime?.durable ?? null : null
    const currentRecall = recall !== null && recall.scopeKey === scopeKey ? recall : null
    const currentLessons = lessons !== null && lessons.scopeKey === scopeKey ? lessons : null
    const currentDetail = detail !== null && detail.scopeKey === scopeKey ? detail : null
    const currentDryRun = dryRun !== null && dryRun.scopeKey === scopeKey ? dryRun : null
    const scope = currentRecall?.payload?.scope ?? currentLessons?.payload?.scope ?? null
    const ledger = currentRecall?.payload?.session ?? currentDryRun?.payload?.session ?? null
    const controlReady = controlState?.status === 'ready'
    const state = controlState?.status ?? 'loading'
    const effective = controlReady ? controlState.payload.effective ?? null : null
    const settings = controlReady ? controlState.payload.settings ?? null : null
    const reasons = effective?.reasons ?? []
    const review = settings?.review ?? null

    // ---------------------------------------------------------------- shared pieces
    // Whether the draft differs from what the Host holds. A save is offered only then, and the
    // discard control is the mirror image of the same fact.
    const dirtyNow = draft !== null && accepted !== undefined && diffOps(draft.values, accepted).ops.length > 0
    const saveRow = (() => {
      const feedback = saveState === null ? null
        : saveState.kind === 'saving' ? h('span', { key: 'f', className: 'mse-hint' }, dict.saving)
          : saveState.kind === 'saved' ? h('span', { key: 'f', className: 'mse-ok' },
            controlState?.status === 'ready' && controlState.payload.runtime?.durable?.pause?.pending
              ? fill(dict.savedButControlPending, {
                reason: codeLabel(dict, controlState.payload.runtime.durable.pause.pending.error) })
              : dict.saved)
            // A refused write is not a validation problem we can name: the controller has already
            // re-read the document, so the honest next step is to look at the host's values again.
            : saveState.kind === 'failed' ? h('span', { key: 'f', className: 'mse-error' }, dict.reloadNeeded)
              : saveState.kind === 'invalid' ? h('span', { key: 'f', className: 'mse-error' },
                fill(dict.saveFailed, { reason: saveState.detail }))
                : h('span', { key: 'f', className: 'mse-error' },
                  fill(dict.saveFailed, { reason: saveState.detail ?? dict.unknownError }))
      const note = draft !== null && draft.stale === true ? dict.draftStale
        : form === undefined || snapshot === null || snapshot.status !== 'ready' ? dict.configUnavailable
          : !writable ? dict.saveUnavailable : null
      return h('div', { key: 'save', className: 'mse-row' }, [
        h('div', { key: 'main', className: 'mse-row-main' }, [
          h('div', { key: 'n', className: 'mse-notice', 'aria-live': 'polite' },
            note === null ? feedback ?? (dirtyNow ? dict.unsaved : '') : note),
          note !== null && feedback !== null ? h('div', { key: 'f', className: 'mse-notice' }, feedback) : null,
        ]),
        h('div', { key: 'side', className: 'mse-row-side' }, [
          draft !== null && draft.stale === true
            ? h(Button, { key: 'reload', variant: 'ghost', size: 'sm', onClick: reseed }, dict.reloadHost) : null,
          saveState?.kind === 'failed'
            ? h(Button, { key: 'reread', variant: 'ghost', size: 'sm', onClick: () => { reseed(); void reloadControl() } },
              dict.reloadHost) : null,
          h(Button, { key: 'discard', variant: 'ghost', size: 'sm', disabled: !writable || !dirtyNow,
            onClick: () => setDraft(current => current === null ? current
              : { ...current, values: { ...accepted }, stale: false }) }, dict.discard),
          h(Button, { key: 'save', variant: 'primary', size: 'sm',
            disabled: !writable || saveState?.kind === 'saving' || !dirtyNow, onClick: () => { void save() } },
          saveState?.kind === 'saving' ? dict.saving : dict.save),
        ]),
      ])
    })()

    const settingsRows = (() => {
      if (form === undefined || snapshot === null || draft === null || snapshot.status !== 'ready') {
        return h('div', { key: 'settings' }, [h('p', { key: 'n', className: 'mse-note' },
          snapshot?.status === 'unavailable' ? dict.configUnavailable : dict.loading)])
      }
      return h('div', { key: 'settings' }, [
        row('enabled', dict.masterSwitch, dict.masterHint,
          h(Switch, { checked: draft.values.enabled, disabled: !writable, label: dict.masterSwitch,
            onChange: next => edit({ enabled: next }) })),
        row('reflect', dict.autoReflect, dict.autoReflectHint,
          h(Switch, { checked: draft.values.reflectionEnabled, disabled: !writable, label: dict.autoReflect,
            onChange: next => edit({ reflectionEnabled: next }) })),
        row('bytes', dict.contextBytes, dict.contextBytesHint,
          [h(Input, { key: 'i', type: 'number', min: CONTEXT_MIN, max: CONTEXT_MAX, step: 1, disabled: !writable,
            className: 'mse-num', 'aria-label': dict.contextBytes, value: draft.values.maxContextBytes,
            onChange: event => edit({ maxContextBytes: event.target.value }) }),
          h('span', { key: 'u', className: 'mse-unit' }, dict.unitBytes)]),
        saveRow,
      ])
    })()

    // A real problem stays on the surface; everything else about how the plugin works is in
    // the disclosures, so the five pages are not pushed below the fold by prose.
    const problemLine = state === 'error'
      ? h('div', { key: 'problem', className: 'mse-row' }, [
        h('div', { key: 'main', className: 'mse-row-main' },
          h('div', { key: 'e', className: 'mse-error' }, `${dict.statusUnavailable}：${controlState.error}`)),
        h('div', { key: 'side', className: 'mse-row-side' },
          h(Button, { variant: 'ghost', size: 'sm', onClick: () => { void reloadControl() } }, dict.retry)),
      ])
      : null

    const overviewPanel = (() => {
      if (overview === undefined || overview.ok !== true) {
        return h('div', { key: 'overview', className: 'mse-pane' }, [
          settingsRows,
          overview === undefined ? h('p', { key: 'l', className: 'mse-note' }, dict.loading)
            : emptyState('e', codeLabel(dict, overview.code ?? 'unavailable')),
        ])
      }
      const counts = overview.counts ?? {}
      return h('div', { key: 'overview', className: 'mse-pane' }, [
        // The three runtime controls are the first thing on the page, exactly as the confirmed
        // design has them. They were computed but never mounted once — this is that omission.
        settingsRows,
        h('h2', { key: 'h', className: 'mse-section-title' }, [
          h('span', { key: 't' }, dict.countsTitle),
          h(Button, { key: 'go', variant: 'ghost', size: 'sm', onClick: () => setTab('lessons') }, dict.goLessons),
        ]),
        overview.countsError !== null && overview.countsError !== undefined
          ? h('p', { key: 'ce', className: 'mse-note' }, `${dict.countsFailed}：${codeLabel(dict, overview.countsError)}`)
          : h('div', { key: 'm', className: 'mse-metrics' }, [
            metric(dict.activeCorrections, counts.activeCorrections ?? 0, dict.unitItems),
            metric(dict.methodsUnvalidated, counts.methodsUnvalidated ?? 0, dict.unitItems),
            metric(dict.methodsValidated, counts.methodsValidated ?? 0, dict.unitItems),
          ]),
        disclosure('versions', dict.detailsMore, [
          definition('d', [
            [dict.version, `${overview.version ?? settings?.pluginVersion ?? '—'}`],
            [dict.runtime, String(overview.runtime ?? 'dsh')],
            [dict.storeState, `${store.text}${overview.lessonsTotal === undefined ? '' : ` · ${dict.total} ${overview.lessonsTotal}`}`],
            [dict.turnBudget, formatBytes(overview.budget?.turnBytes)],
            [dict.sessionBudget, formatBytes(overview.budget?.sessionBytes)],
            [dict.maxLessons, `${overview.budget?.maxLessons ?? '—'} ${dict.unitItems}`],
            [dict.sessionUsed, ledger === null ? dict.notRecorded : `${formatBytes(ledger.bytes)} / ${formatBytes(ledger.budgetBytes)}`],
            [dict.scopeLessons, `${counts.scopeLessons ?? 0} ${dict.unitItems}`],
            [dict.otherScope, `${counts.otherScope ?? 0} ${dict.unitItems}`],
            [dict.otherEnvironment, `${counts.otherEnvironment ?? 0} ${dict.unitItems}`],
            [dict.suspendedExpired, `${counts.suspended ?? 0} / ${counts.expired ?? 0} ${dict.unitItems}`],
          ]),
          h('p', { key: 'n', className: 'mse-hint' }, dict.notLearnedNote),
        ], { id: 'versions' }),
        disclosure('runtime', dict.runtimeHelpTitle, [
          h('p', { key: 'n', className: 'mse-note' }, dict.controlsNote),
          definition('d', [
            [dict.runtimeMode, dict.runtimeModeValue],
            [dict.autoReflectEffective, review === null ? dict.unknown
              : review.autoEnabled === true
                ? fill(dict.autoReflectOn, { used: review.usedLast24h ?? dict.unknown, limit: review.perDay })
                : dict.autoReflectOff],
            [dict.userEnabled, settings?.user?.enabled === undefined ? dict.unknown
              : settings.user.enabled === true ? dict.yes : dict.no],
            [dict.recentRun, controlState?.status !== 'ready' ? dict.statusUnreadable
              : (controlState.payload.runtime?.turnsObserved ?? 0) === 0 ? dict.noRuns
                : `${recentLine(dict, Array.isArray(currentRecall?.payload?.recent) && currentRecall.payload.recent.length > 0
                  ? currentRecall.payload.recent[currentRecall.payload.recent.length - 1] : null)} · ${fill(dict.runsObserved, { n: controlState.payload.runtime?.turnsObserved ?? 0 })}`],
            // The durable queue as the CORE sees it, and whether the user's pause is really in
            // force. Saving the settings document is not this confirmation, so a pause that is
            // still retrying is shown with its own cause rather than as an effective one.
            [dict.durablePending, durable === null ? dict.unknown
              : durable.core?.ok !== true ? dict.durableUnreadable
                : `${durable.core?.pending ?? 0}${(durable.core?.expired ?? 0) > 0 ? ` (+${durable.core.expired} ${settleLabel(dict, 'expired')})` : ''}`],
            [dict.durableTerminal, durable?.core?.ok !== true ? dict.unknown
              : `${settleLabel(dict, 'settled')} ${durable.core?.settled ?? 0} · ${settleLabel(dict, 'stopped')} ${durable.core?.stopped ?? 0}`],
            // The UNCONFIRMED fact comes first: a first pause can leave `userPaused` null, and
            // reading that as "not set" would hide a control change that is still retrying. A
            // resume is a different statement from a pause, so both are named explicitly.
            [dict.pauseState, durable === null ? dict.unknown
              : durable.pause?.pending !== null && durable.pause?.pending !== undefined
                ? fill(durable.pause.pending.paused === true ? dict.pausePending : dict.resumePending,
                  { reason: codeLabel(dict, durable.pause.pending.error), n: durable.pause.pending.attempts ?? 0 })
                : durable.pause?.userPaused === true ? dict.pauseConfirmed
                  : durable.pause?.userPaused === false ? dict.pauseNotSet : dict.unknown],
            [dict.stopsUnconfirmed, durable?.stops?.unconfirmed > 0
              ? `${durable.stops.unconfirmed}（${(durable.stops.errors ?? []).map(code => codeLabel(dict, code)).join('，') || codeLabel(dict, 'host_state_unknown')}）` +
                `${durable.stops.exhausted > 0 ? fill(dict.stopsExhaustedSuffix, { n: durable.stops.exhausted }) : ''}`
              : dict.stopsClean],
          ]),
          h('p', { key: 'm', className: 'mse-hint' }, dict.masterHintFull),
          h('p', { key: 'r', className: 'mse-hint' }, dict.autoReflectHintFull),
          h('p', { key: 'b', className: 'mse-hint' }, fill(dict.contextBytesHintFull,
            { min: CONTEXT_MIN, max: CONTEXT_MAX, def: 768 })),
          h('p', { key: 'a', className: 'mse-hint' },
            `${dict.advancedHint} ${dict.evalTokensLimit} ${settings?.budget?.evaluationTokensPerDay ?? dict.unknown}` +
            ` · ${dict.evalCallsLimit} ${settings?.budget?.evaluationCallsPerDay ?? dict.unknown}`),
          h('div', { key: 'refresh', className: 'mse-inline' }, [
            h(Switch, { key: 's', checked: auto, label: dict.autoRefresh, onChange: next => setAuto(next) }),
            h('span', { key: 'l', className: 'mse-hint', style: { marginTop: 0 } }, dict.autoRefresh),
          ]),
          h('p', { key: 'j', className: 'mse-hint' }, dict.jobsNote),
        ], { id: 'runtime' }),
      ])
    })()

    const lessonsPanel = (() => {
      const page = currentLessons
      const entries = options
      const rows = page !== null && page.error === undefined && page.payload?.ok === true ? page.payload.items ?? [] : []
      const controls = h('div', { key: 'controls', className: 'mse-toolbar' }, [
        h('div', { key: 'search', className: 'mse-search' },
          h(Input, { type: 'search', placeholder: dict.search, 'aria-label': dict.search, value: listQuery.query,
            onChange: event => setListQuery(current => ({ ...current, query: event.target.value.slice(0, MAX_QUERY_CHARS), page: 1 })) })),
        filterSelect(dict.kindFilter, [['', dict.all], ['correction', dict.kindCorrection], ['method', dict.kindMethod]],
          listQuery.kind, value => setListQuery(current => ({ ...current, kind: value, page: 1 }))),
        filterSelect(dict.statusFilter, [['', dict.all], ['reminder', dict.activeCorrections], ['candidate', dict.methodsUnvalidated],
          ['validated', dict.methodsValidated], ['suspended', dict.suspended]], listQuery.status,
        value => setListQuery(current => ({ ...current, status: value, page: 1 }))),
        filterSelect(dict.pageSize, PAGE_SIZES.map(size => [String(size), String(size)]), String(listQuery.pageSize),
          value => setListQuery(current => ({ ...current, pageSize: Number(value), page: 1 }))),
      ])
      const detailBody = rowItem => {
        if (currentDetail === null) return h('p', { key: 'l', className: 'mse-note' }, dict.loading)
        if (currentDetail.id !== rowItem.id) return h('p', { key: 'l', className: 'mse-note' }, dict.loading)
        if (currentDetail.error !== undefined) return h('p', { key: 'e', className: 'mse-error' }, currentDetail.error)
        const payload = currentDetail.payload
        if (payload.ok !== true) return h('p', { key: 'e', className: 'mse-error' }, codeLabel(dict, payload.code))
        const item = payload.lesson
        return h('div', { key: 'body' }, [
          definition('d', [
            [dict.kind, kindLabel(dict, item.kind)],
            [dict.status, `${statusLabelOf(dict, item.status)} (${item.status})`],
            [dict.savedAt, formatTime(item.createdAt, locale)],
            [dict.expiresAt, formatTime(item.expiresAt, locale)],
            [dict.source, item.sourceTurn === null ? dict.notRecorded
              : h('span', { key: 's', className: 'mse-mono' }, item.sourceTurn)],
            [dict.environment, environmentLabel(dict, item)],
            [dict.applicability, item.applicability || dict.notRecorded],
            [dict.exclusions, item.exclusions || dict.notRecorded],
            [dict.counters, `${dict.adopted} ${item.adopted} · ${dict.verified} ${item.verified} · ` +
              `${dict.failed} ${item.failed} · ${dict.inconclusive} ${item.inconclusive}`],
            [dict.validation, item.validation === null ? dict.notRecorded
              : `${item.validation.decision} · ${item.validation.basis || '—'} · ${formatTime(item.validation.at, locale)}`],
            [dict.topic, item.topicKey ?? dict.notRecorded],
            [dict.value, item.value ?? dict.notRecorded],
            [dict.history, item.historyComplete ? dict.historyComplete : dict.historyIncomplete],
            [dict.replaces, item.replaces ?? dict.notRecorded],
            [dict.replacedBy, item.replacedBy ?? dict.notRecorded],
            [dict.lessonId, h('span', { key: 'i', className: 'mse-mono mse-test-long' }, item.id)],
            ['version', String(item.version ?? 0)],
          ], { left: true }),
          item.experiments.length === 0 ? null : h('div', { key: 'exp' }, [
            h('p', { key: 'l', className: 'mse-hint' }, dict.experiments),
            ...item.experiments.map((record, index) => h('p', { key: `e${index}`, className: 'mse-hint' },
              `${record.decision} · v${record.version} · ${formatTime(record.at, locale)}` +
              `${record.reasons.length > 0 ? ` · ${record.reasons.join(', ')}` : ''}`)),
          ]),
          payload.historyError ? h('p', { key: 'herr', className: 'mse-error' },
            `${codeLabel(dict, payload.historyError)}（${payload.historyError}）`) : null,
        ])
      }
      const list = rows.map(item => h('details', { key: item.id, className: 'mse-lesson',
        // Controlled: opening a second row closes the first, so the one fetched detail can
        // never be shown under two headings at once.
        open: openLesson === item.id, 'data-mse-lesson': item.id,
        onToggle: event => {
          if (event.target.open === true) { setOpenLesson(item.id); void openDetail(item.id) }
          else setOpenLesson(current => current === item.id ? null : current)
        } },
      h('summary', { key: 's' }, [
        h('div', { key: 'main', className: 'mse-lesson-heading' }, [
          h('div', { key: 't', className: 'mse-lesson-title' }, item.instruction),
          h('div', { key: 'm', className: 'mse-meta' }, [
            h('span', { key: 'k', className: 'mse-badge' }, kindLabel(dict, item.kind)),
            h('span', { key: 's', className: 'mse-badge' }, statusLabelOf(dict, item.status)),
            h('span', { key: 't' }, formatTime(item.createdAt, locale)),
            h('span', { key: 'c', className: 'mse-mono' },
              `${item.adopted}/${item.verified}/${item.failed}/${item.inconclusive}`),
          ]),
        ]),
        h(IconChevronRightOutlineRegular, { key: 'c', className: 'mse-chevron' }),
      ]),
      h('div', { key: 'd', className: 'mse-lesson-detail' }, detailBody(item))))
      const pager = page !== null && page.error === undefined && page.payload?.ok === true
        ? h('div', { key: 'pager', className: 'mse-footline' }, [
          h('span', { key: 'c' }, `${dict.complete.replace('{total}', String(page.payload.scopeTotal ?? 0))
            .replace('{cap}', String(page.payload.storeCap ?? '—'))}`),
          h('div', { key: 'n', className: 'mse-inline' }, [
            h(Button, { key: 'prev', variant: 'ghost', size: 'sm', disabled: page.payload.page <= 1,
              onClick: () => setListQuery(current => ({ ...current, page: Math.max(1, current.page - 1) })) }, dict.prev),
            h('span', { key: 'p', className: 'mse-meta' },
              dict.page.replace('{page}', String(page.payload.page)).replace('{pages}', String(page.payload.pages))),
            h(Button, { key: 'next', variant: 'ghost', size: 'sm', disabled: page.payload.page >= page.payload.pages,
              onClick: () => setListQuery(current => ({ ...current, page: current.page + 1 })) }, dict.next),
          ]),
        ])
        : null
      return h('div', { key: 'lessons', className: 'mse-pane' }, [
        scopeRow('lessons', dict.scopePicker, entries, sessionId, setSessionId),
        controls,
        page === null || page === undefined
          ? h('p', { key: 'l', className: 'mse-note' }, dict.loading)
          : page.error !== undefined ? h('p', { key: 'e', className: 'mse-error' }, page.error)
            : page.payload.ok !== true ? h('p', { key: 'e', className: 'mse-error' }, codeLabel(dict, page.payload.code))
              : rows.length === 0
                ? emptyState('empty', listQuery.query || listQuery.kind || listQuery.status ? dict.emptyFiltered : dict.emptyLessons,
                  dict.emptyLessonsHint)
                : h('div', { key: 'list' }, list),
        pager,
      ])
    })()

    const recallPanel = (() => {
      const head = scopeRow('recall', dict.scopePicker, options, sessionId, setSessionId)
      if (sessionId === '') {
        return h('div', { key: 'recall', className: 'mse-pane' }, [head,
          emptyState('pick', dict.recallPick, dict.recallPickHint)])
      }
      const slot = currentRecall
      if (slot === null) return h('div', { key: 'recall', className: 'mse-pane' }, [head,
        h('p', { key: 'l', className: 'mse-note' }, dict.loading)])
      if (slot.error !== undefined) return h('div', { key: 'recall', className: 'mse-pane' }, [head,
        h('p', { key: 'e', className: 'mse-error' }, slot.error)])
      const payload = slot.payload
      if (payload.ok !== true) return h('div', { key: 'recall', className: 'mse-pane' }, [head,
        h('p', { key: 'e', className: 'mse-error' }, codeLabel(dict, payload.code))])
      const recent = payload.recent ?? []
      const turnRows = recent.map((entry, index) => h('div', { key: index, className: 'mse-row' }, [
          h('div', { key: 'main', className: 'mse-row-main' }, [
            h('div', { key: 't', className: 'mse-row-title' }, [
              `${dict.turn} ${entry.turn ?? '-'} `,
              h('span', { key: 'b', className: 'mse-badge' }, reasonLabel(dict, entry.reason)),
            ]),
            h('p', { key: 'h', className: 'mse-hint' },
              `${dict.injected} ${formatBytes(entry.bytes)} · ${(entry.sources ?? []).length} ${dict.unitItems}` +
              `${(entry.sources ?? []).length === 0 ? '' : ` · ${(entry.sources ?? []).map(source => `${shortId(source.id)}@v${source.version}`).join(' ')}`}`),
          ]),
          h('span', { key: 'meta', className: 'mse-meta' }, formatTime(entry.at, locale)),
        ]))
      return h('div', { key: 'recall', className: 'mse-pane' }, [
        head,
        recent.length === 0
          ? emptyState('empty', dict.recallNone, dict.recallNoneHint)
          : h('div', { key: 'rows' }, turnRows),
        recent.length === 0 ? null : disclosure('diagnostics', dict.diagnostics, [
          definition('d', [
            ...recent.slice(-3).map(entry => [`${dict.turn} ${entry.turn ?? '-'}`,
              diagnosticLine(entry.diagnostics)]),
            [dict.settle, (payload.settlement?.live ?? []).length === 0 ? dict.settleNone
              : (payload.settlement?.live ?? []).map(row =>
                `${row.turnId ?? '-'} · ${settleLabel(dict, row.state)} · ${row.attempts ?? 0}`).join('；')],
            [dict.sessionUsed, payload.session === null ? dict.notRecorded
              : `${formatBytes(payload.session.bytes)} / ${formatBytes(payload.session.budgetBytes)}`],
            [dict.bytesUnit, dict.bytesNote],
          ], { left: true }),
        ], { id: 'diagnostics' }),
        sectionTitle('dry', dict.diagnoseTitle),
        h('p', { key: 'd', className: 'mse-hint' }, dict.diagnoseHint),
        h('div', { key: 'form', className: 'mse-form-block' }, [
          h('label', { key: 'l', htmlFor: 'mse-diagnose' }, dict.diagnosePrompt),
          h('textarea', { key: 'ta', id: 'mse-diagnose', className: 'mse-textarea', maxLength: MAX_PROMPT_CHARS,
            placeholder: dict.diagnosePrompt, value: prompt,
            onChange: event => setPrompt(event.target.value.slice(0, MAX_PROMPT_CHARS)) }),
          h('div', { key: 'a', className: 'mse-actions' }, [
            currentDryRun?.error !== undefined ? h('span', { key: 'e', className: 'mse-error' }, currentDryRun.error) : null,
            h(Button, { key: 'run', variant: 'outline', size: 'sm', onClick: () => { void runDiagnose() } }, dict.diagnoseRun),
          ]),
        ]),
        currentDryRun === null || currentDryRun.error !== undefined ? null
          : currentDryRun.payload.ok !== true
            ? h('p', { key: 'e', className: 'mse-error' }, codeLabel(dict, currentDryRun.payload.code))
            : h('div', { key: 'r', className: 'mse-callout' }, definition('d', [
              [dict.diagnoseResult, currentDryRun.payload.prompted === null ? dict.notRecorded
                : reasonLabel(dict, currentDryRun.payload.prompted?.reason)],
              [dict.wouldInject, formatBytes(currentDryRun.payload.prompted?.wouldInjectBytes ?? 0)],
              [dict.diagnostics, currentDryRun.payload.prompted === null ? '—' : diagnosticLine(currentDryRun.payload.prompted)],
              [dict.sessionUsed, currentDryRun.payload.session === null ? dict.notRecorded
                : `${formatBytes(currentDryRun.payload.session.bytes)} / ${formatBytes(currentDryRun.payload.session.budgetBytes)}`],
            ], { left: true })),
      ])
    })()

    const budgetPanel = h('div', { key: 'budget', className: 'mse-pane' }, [
      sectionTitle('c', dict.contextBudgetTitle),
      row('t', dict.turnBudget, dict.turnBudgetHint, formatBytes(overview?.budget?.turnBytes)),
      row('s', dict.sessionBudget, dict.sessionBudgetHint, formatBytes(overview?.budget?.sessionBytes)),
      row('m', dict.maxLessons, null,
        [h('span', { key: 'v' }, String(overview?.budget?.maxLessons ?? '—')), h('span', { key: 'u', className: 'mse-unit' }, dict.unitItems)]),
      row('u', dict.sessionUsed, null,
        [h('span', { key: 'v' }, ledger === null ? dict.notRecorded
          : `${formatBytes(ledger.bytes)} / ${formatBytes(ledger.budgetBytes)}`)]),
      currentRecall?.payload?.sessionError ? h('p', { key: 'lerr', className: 'mse-error' },
        `${codeLabel(dict, currentRecall.payload.sessionError)}（${currentRecall.payload.sessionError}）`) : null,
      sectionTitle('e', dict.evalBudgetTitle),
      h('p', { key: 'ed', className: 'mse-hint' }, dict.evalBudgetHint),
      draft === null ? h('p', { key: 'l', className: 'mse-note' }, dict.loading) : h('div', { key: 'rows' }, [
        row('tokens', dict.evalTokens, null,
          h(Input, { type: 'number', min: 0, max: EVAL_TOKENS_MAX, step: 1000, disabled: !writable,
            className: 'mse-num-wide', 'aria-label': dict.evalTokens, value: draft.values.evaluationTokensPerDay,
            onChange: event => edit({ evaluationTokensPerDay: event.target.value }) })),
        row('calls', dict.evalCalls, null,
          h(Input, { type: 'number', min: 0, max: EVAL_CALLS_MAX, step: 1, disabled: !writable,
            className: 'mse-num', 'aria-label': dict.evalCalls, value: draft.values.evaluationCallsPerDay,
            onChange: event => edit({ evaluationCallsPerDay: event.target.value }) })),
        saveRow,
      ]),
      disclosure('usage', dict.evalUsageTitle, [
        definition('d', [
          // A counter the current read-only projection does not forward is reported as
          // unreported. Printing 0 here would tell the operator a day's budget is untouched
          // when nobody actually looked.
          [dict.evalTokensLimit, String(settings?.budget?.evaluationTokensPerDay ?? dict.unknown)],
          [dict.evalCallsLimit, `${settings?.budget?.evaluationCallsPerDay ?? dict.unknown} ${dict.unitCalls}`],
          [dict.evalTokensUsed, overview?.evaluationTokensReserved24h === undefined ? dict.notReported
            : String(overview.evaluationTokensReserved24h)],
          [dict.evalCallsUsed, overview?.evaluationCallsLast24h === undefined ? dict.notReported
            : `${overview.evaluationCallsLast24h} ${dict.unitCalls}`],
          [dict.autoReflectEffective, review === null ? dict.unknown
            : fill(dict.autoReflectOn, { used: review.usedLast24h ?? dict.unknown, limit: review.perDay })],
          [dict.evalJobsOpen, String(controlState?.status === 'ready' ? controlState.payload.runtime?.jobs?.length ?? 0 : 0)],
        ], { left: true }),
        h('p', { key: 'n', className: 'mse-hint' }, dict.bytesNote),
        h('p', { key: 'c', className: 'mse-hint' }, dict.notLearnedNote),
      ], { id: 'usage' }),
    ])

    const jobs = controlState?.status === 'ready' ? controlState.payload.runtime?.jobs ?? [] : []
    const cancelJob = id => { void (async () => {
      const payload = await controlCall(control, 'cancel', { id })
      if (payload.job) setJob(payload.job)
      setReloadToken(current => current + 1)
    })() }
    const manualPanel = h(ManualPanel, { key: 'manual', dict, locale, control, sessionId, call, job, setJob,
      onScope: setSessionId, scopeOptions: options, jobs, onCancelJob: cancelJob })

    const tabs = h(SegmentedTabs, { key: 'tabs', label: dict.settingsTitle, value: tab, onChange: setTab,
      items: TABS.map(id => ({ value: id, id: `mse-tab-${id}`, panelId: `mse-pane-${id}`,
        label: id === 'overview' ? dict.tabOverview : id === 'lessons' ? dict.tabLessons
          : id === 'recall' ? dict.tabRecall : id === 'manual' ? dict.tabManual : dict.tabBudget })) })

    const body = tab === 'overview' ? overviewPanel : tab === 'lessons' ? lessonsPanel
      : tab === 'recall' ? recallPanel : tab === 'manual' ? manualPanel : budgetPanel
    return h('section', { className: 'mse-details', 'data-mse-details': 'page' }, [
      h('div', { key: 'heading', className: 'mse-heading' }, [
        h('h1', { key: 't' }, dict.settingsTitle),
        state === 'error'
          ? h('span', { key: 's', className: 'mse-error' }, dict.statusUnreadable)
          : h('span', { key: 's', className: 'mse-status' }, [
            h(StateDot, { key: 'd', state: effective === null ? 'idle' : effective.learning === true ? 'done' : 'idle' }),
            h('span', { key: 't' }, effective === null ? dict.loading
              : effective.learning === true ? dict.effectiveRunning : dict.effectivePaused),
            ...reasons.map(code => h('span', { key: `r-${code}`, className: 'mse-error' },
              dict.reasonNamesForControl[code] ?? code)),
          ]),
        h(Button, { key: 'r', variant: 'ghost', size: 'sm', className: 'mse-heading-action',
          disabled: shell.status === 'loading', onClick: () => setReloadToken(current => current + 1) },
        shell.status === 'loading' ? dict.refreshing : dict.refresh),
      ]),
      shell.error ? h('p', { key: 'err', className: 'mse-error' }, `${dict.loadFailed}: ${shell.error}`) : null,
      problemLine,
      tabs,
      h('div', { key: 'pane', id: `mse-pane-${tab}`, role: 'tabpanel', 'aria-labelledby': `mse-tab-${tab}`,
        className: 'mse-pane' }, body),
    ])
  }

  /**
   * Manual actions: review one finished Host turn, or verify one candidate lesson.
   *
   * Both start a real, bounded, cancellable Host job. Nothing here can mark a lesson verified:
   * the page submits a session id, a turn id, a lesson id and a version, and the Host decides
   * everything else — the scope, the model route, the case oracle and the final verdict.
   */
  function ManualPanel(props) {
    const { dict, locale, control, sessionId, call, job, setJob } = props
    const [turns, setTurns] = React.useState(null)
    const [preview, setPreview] = React.useState(null)
    const [lessonsPage, setLessonsPage] = React.useState(null)
    const [lessonId, setLessonId] = React.useState('')
    const [cases, setCases] = React.useState('')
    const [plan, setPlan] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    // One counter per resource, so reading the turn list does not cancel the lesson list.
    const turnsSeq = React.useRef(0)
    const lessonsSeq = React.useRef(0)
    const planSeq = React.useRef(0)
    const available = control !== undefined && control !== null
    const step = ref => { ref.current += 1; return ref.current }
    const current = (ref, token) => ref.current === token
    const requestId = prefix => `${prefix}-${Date.now().toString(36)}-${Math.trunc(Math.random() * 1e6).toString(36)}`
    // The panel is rendered under the shared scope picker, so changing the scope must throw
    // away every manual result — including a preview that was authorised for the old scope.
    // Without this, a preview read for session A stayed on screen while the picker moved to B,
    // and pressing "start" would have asked the Host to review a turn the person never saw.
    React.useEffect(() => {
      turnsSeq.current += 1
      lessonsSeq.current += 1
      planSeq.current += 1
      setTurns(null)
      setPreview(null)
      setLessonsPage(null)
      setLessonId('')
      setCases('')
      setPlan(null)
      setBusy(false)
    }, [sessionId])

    const loadTurns = async () => {
      if (!available || sessionId === '') return
      const token = step(turnsSeq)
      setBusy(true); setPreview(null)
      try {
        const payload = await controlCall(control, 'turns', { sessionId })
        if (current(turnsSeq, token)) setTurns(payload)
      } catch (error) {
        if (current(turnsSeq, token)) setTurns({ ok: false, code: failureCode(error), turns: [] })
      } finally { if (current(turnsSeq, token)) setBusy(false) }
    }
    const loadLessons = async () => {
      const token = step(lessonsSeq)
      setBusy(true)
      try {
        const payload = await callRemote(call, 'lessons', { kind: 'method', pageSize: 50, page: 1,
          ...(sessionId === '' ? {} : { sessionId }) })
        if (!current(lessonsSeq, token)) return
        setLessonsPage(payload)
        if (payload.ok === true && (payload.items ?? []).length > 0) setLessonId(payload.items[0].id)
      } catch (error) {
        if (current(lessonsSeq, token)) setLessonsPage({ ok: false, code: failureCode(error) })
      } finally { if (current(lessonsSeq, token)) setBusy(false) }
    }
    const reviewTurn = async turn => {
      if (!available) return
      const token = step(planSeq)
      setBusy(true)
      try {
        const payload = await controlCall(control, 'planReview', { sessionId, turnId: turn })
        if (current(planSeq, token)) setPreview({ ...payload, bound: { sessionId, turnId: turn } })
      } catch (error) {
        if (current(planSeq, token)) setPreview({ ok: false, code: failureCode(error) })
      } finally { if (current(planSeq, token)) setBusy(false) }
    }
    const startReview = async () => {
      if (!available || preview?.ok !== true) return
      // The request is built from the frozen preview, never from the live picker: the person
      // authorised one specific turn, and a scope change since then invalidates that consent.
      const bound = preview.bound
      if (bound === undefined || bound.sessionId !== sessionId) {
        setPreview({ ...preview, stale: true })
        return
      }
      const token = step(planSeq)
      setBusy(true)
      try {
        const payload = await controlCall(control, 'startReview', { sessionId: bound.sessionId, turnId: bound.turnId,
          requestId: requestId('review') })
        if (!current(planSeq, token)) return
        if (payload.ok === true) { setJob(payload.job); setPreview({ ...preview, started: true }) }
        else setPreview({ ...preview, startError: payload.code })
      } catch (error) {
        if (current(planSeq, token)) setPreview({ ...preview, startError: failureCode(error) })
      } finally { if (current(planSeq, token)) setBusy(false) }
    }
    const casesRaw = cases.trim()
    const readCases = () => {
      if (casesRaw === '') return null
      try { return JSON.parse(casesRaw) } catch { return undefined }
    }
    const planEvaluation = async () => {
      if (!available || lessonId === '') return
      const parsed = readCases()
      if (parsed === undefined) { setPlan({ ok: false, code: 'invalid_cases' }); return }
      const token = step(planSeq)
      setBusy(true)
      try {
        const payload = await controlCall(control, 'planEvaluation', { sessionId, lessonId,
          ...(Array.isArray(parsed) ? { cases: parsed } : {}) })
        if (current(planSeq, token)) {
          setPlan({ ...payload, bound: { sessionId, lessonId, casesHash: casesRaw,
            version: payload?.lesson?.version, planHash: payload?.planHash } })
        }
      } catch (error) {
        if (current(planSeq, token)) setPlan({ ok: false, code: failureCode(error) })
      } finally { if (current(planSeq, token)) setBusy(false) }
    }
    const startEvaluation = async () => {
      if (!available || lessonId === '') return
      const bound = plan?.bound
      // Same rule as the review: scope, lesson, version and the exact case text must all still
      // be the ones that were previewed, otherwise the plan is stale and must be redone.
      if (bound === undefined || bound.sessionId !== sessionId || bound.lessonId !== lessonId
        || bound.casesHash !== cases.trim()) {
        setPlan({ ...(plan ?? {}), stale: true })
        return
      }
      const parsed = readCases()
      const token = step(planSeq)
      setBusy(true)
      try {
        const payload = await controlCall(control, 'startEvaluation', { sessionId: bound.sessionId, lessonId: bound.lessonId,
          expectedVersion: bound.version, planHash: bound.planHash,
          ...(Array.isArray(parsed) ? { cases: parsed } : {}), requestId: requestId('verify') })
        if (!current(planSeq, token)) return
        if (payload.ok === true) setJob(payload.job)
        else setPlan({ ...(plan ?? {}), ok: true, startError: payload.code })
      } catch (error) {
        if (current(planSeq, token)) setPlan({ ...(plan ?? {}), ok: true, startError: failureCode(error) })
      } finally { if (current(planSeq, token)) setBusy(false) }
    }

    const template = () => JSON.stringify([
      { caseId: 'case-1', family: 'family-a', split: 'development', prompt: '把下面三个数字按升序列成一行：3, 1, 2',
        checker: { kind: 'text-exact-v1', expected: '1, 2, 3' } },
    ], null, 2)

    const turnsBlock = (() => {
      if (!available) return h('p', { key: 'na', className: 'mse-note' }, dict.configUnavailable)
      const rows = turns !== null && turns.ok === true ? turns.turns ?? [] : []
      return h('div', { key: 'turns' }, [
        sectionTitle('t', dict.turnsTitle,
          h(Button, { key: 'l', variant: 'ghost', size: 'sm', disabled: busy, onClick: () => { void loadTurns() } },
            dict.turnsLoad)),
        h('p', { key: 'd', className: 'mse-hint' }, dict.turnsHint),
        turns === null ? h('p', { key: 'i', className: 'mse-note' }, sessionId === '' ? dict.turnsPick : dict.turnsIdle)
          : turns.ok !== true ? h('p', { key: 'e', className: 'mse-error' }, codeLabel(dict, turns.code))
            : rows.length === 0 ? emptyState('empty', dict.turnsNone, dict.turnsNoneHint)
              : h('div', { key: 'list' }, rows.map(entry => h('div', { key: entry.turn, className: 'mse-row' }, [
                h('div', { key: 'main', className: 'mse-row-main' }, [
                  h('div', { key: 't', className: 'mse-row-title' }, [
                    entry.taskPreview,
                    ' ',
                    h('span', { key: 'b', className: 'mse-badge' },
                      fill(dict.turnLine, { turn: entry.turn, reason: entry.reason })),
                  ]),
                  h('p', { key: 'h', className: 'mse-hint' }, entry.reviewable
                    ? `${entry.route?.provider ?? '—'} / ${entry.route?.model ?? '—'}`
                    : codeLabel(dict, entry.reviewCode)),
                ]),
                entry.reviewable
                  ? h(Button, { key: 'b', variant: 'outline', size: 'sm', disabled: busy,
                    onClick: () => { void reviewTurn(entry.turn) } }, dict.turnPreview)
                  : null,
              ]))),
        preview === null ? null : preview.ok !== true
          ? h('p', { key: 'pe', className: 'mse-error' }, codeLabel(dict, preview.code))
          : h('div', { key: 'preview' }, [
            h('div', { key: 'c', className: 'mse-callout' }, [
              h('p', { key: 't' }, dict.previewNote),
              definition('d', [
                [dict.model, preview.route === null ? dict.notRecorded : preview.route.provider],
                [dict.reasoning, preview.route?.reasoningEffort ?? dict.notRecorded],
                [dict.previewModel, preview.route === null ? dict.notRecorded : preview.route.model],
                [dict.previewResult, preview.task.resultPreview],
                [dict.previewQuota, fill(dict.previewQuotaValue, { allowance: preview.plan.allowance, limit: preview.plan.limit })],
                [dict.previewSource, fill(dict.turnLine, { turn: preview.plan.turnId ?? '—', reason: preview.plan.outcome ?? '—' })],
                preview.plan.cooldownUntil > Date.now()
                  ? [dict.previewCooldown, formatTime(preview.plan.cooldownUntil, locale)] : null,
                [dict.previewPermission, preview.plan.allowed ? dict.previewEnabled
                  : codeLabel(dict, preview.plan.permission ?? preview.plan.skipped)],
                preview.plan.duplicate ? [dict.turnUsed, dict.previewDuplicate] : null,
              ], { left: true }),
            ]),
            preview.stale === true ? h('p', { key: 'stale', className: 'mse-error' }, dict.previewStale) : null,
            preview.startError ? h('p', { key: 'se', className: 'mse-error' }, codeLabel(dict, preview.startError)) : null,
            h('div', { key: 'a', className: 'mse-actions' }, [
              h(Button, { key: 'dismiss', variant: 'ghost', size: 'sm', onClick: () => setPreview(null) }, dict.dismiss),
              h(Button, { key: 'start', variant: 'primary', size: 'sm',
                disabled: busy || !preview.plan.allowed || preview.started === true || preview.stale === true,
                onClick: () => { void startReview() } }, dict.turnStart),
            ]),
          ]),
      ])
    })()

    const verifyBlock = (() => {
      if (!available) return null
      const items = lessonsPage?.ok === true ? (lessonsPage.items ?? []) : []
      const chosen = items.find(row => row.id === lessonId) ?? null
      const registered = chosen !== null && typeof chosen.methodId === 'string' && chosen.methodId !== ''
      const canStart = plan !== null && plan.ok === true && plan.stale !== true
        && plan.permitted === true && (plan.plan === null || plan.plan.allowed === true)
      return h('div', { key: 'verify' }, [
        sectionTitle('t', dict.verifyTitle,
          h(Button, { key: 'l', variant: 'ghost', size: 'sm', disabled: busy, onClick: () => { void loadLessons() } },
            dict.verifyLoad)),
        h('p', { key: 'd', className: 'mse-hint' }, dict.verifyGeneric),
        lessonsPage !== null && lessonsPage.ok !== true
          ? h('p', { key: 'le', className: 'mse-error' }, codeLabel(dict, lessonsPage.code)) : null,
        lessonsPage !== null && lessonsPage.ok === true && items.length === 0
          ? emptyState('none', dict.verifyNoLesson, dict.verifyNoLessonHint) : null,
        items.length === 0 ? null : h('div', { key: 'pick', className: 'mse-form-block' }, [
          h('label', { key: 'l', id: 'mse-candidate-label' }, dict.verifyPickLesson),
          h(Picker, { key: 'p', label: dict.verifyPickLesson, className: 'mse-picker-wide',
            testId: 'candidate', value: lessonId,
            options: items.map(entry => ({ id: entry.id,
              label: `${shortId(entry.id)} · ${entry.instruction.slice(0, 60)}` })),
            onChange: next => { setLessonId(next); setPlan(null) } }),
        ]),
        chosen === null ? null : h('p', { key: 'chosen', className: 'mse-hint' },
          fill(dict.verifyLesson, { kind: kindLabel(dict, chosen.kind),
            status: statusLabelOf(dict, chosen.status), version: chosen.version })),
        chosen === null || registered ? null : disclosure('cases', dict.verifyCases, [
          h('div', { key: 'f', className: 'mse-form-block' }, [
            h('label', { key: 'l', htmlFor: 'mse-cases' }, fill(dict.verifyCasesHint, { min: 12, max: 24 })),
            h('textarea', { key: 'ta', id: 'mse-cases', className: 'mse-textarea mse-cases',
              'aria-label': dict.verifyCases, spellCheck: false, value: cases, maxLength: MAX_CASE_JSON_CHARS,
              onChange: event => { setCases(event.target.value.slice(0, MAX_CASE_JSON_CHARS)); setPlan(null) } }),
          ]),
          h('div', { key: 'a', className: 'mse-actions' },
            [h(Button, { key: 'tpl', variant: 'ghost', size: 'sm', onClick: () => setCases(template()) },
              dict.verifyCaseTemplate)]),
        ], { id: 'cases' }),
        chosen === null ? null : h('div', { key: 'a', className: 'mse-actions' }, [
          h(Button, { key: 'plan', variant: 'outline', size: 'sm', disabled: busy,
            onClick: () => { void planEvaluation() } }, dict.verifyPlan),
          h(Button, { key: 'start', variant: 'primary', size: 'sm', disabled: busy || !canStart,
            onClick: () => { void startEvaluation() } }, dict.verifyStart),
        ]),
        plan === null ? null : plan.ok !== true
          ? h('p', { key: 'pe', className: 'mse-error' }, codeLabel(dict, plan.code))
          : h('div', { key: 'plan' }, [
            h('div', { key: 'c', className: 'mse-callout' }, [
              h('p', { key: 't' }, canStart ? dict.verifyPlanReady
                : fill(dict.verifyPlanBlocked, { reason: codeLabel(dict, plan.plan?.reasons?.[0] ?? plan.permission) })),
              definition('d', [
                [dict.verifyTarget, chosen?.instruction ?? dict.notRecorded],
                [dict.model, plan.route === null ? codeLabel(dict, plan.routeError ?? 'session_route_unknown')
                  : `${plan.route.provider} / ${plan.route.model}`],
                [dict.reasoning, plan.route?.reasoningEffort ?? dict.notRecorded],
                [dict.verifyPlanCases, plan.basis === 'registered_algorithm' ? dict.verifyRegisteredDone
                  : `${plan.cases.valid ? '' : `${codeLabel(dict, plan.cases.code)} · `}${fill(dict.verifyPlanCasesValue, {
                    accepted: plan.cases.accepted, families: plan.cases.families, holdout: plan.cases.holdout })}`],
                [dict.verifyPlanRequests, String(plan.plan?.pairedRequests ?? 0)],
                [dict.verifyPlanReserve, String(plan.plan?.reservedTokens ?? 0)],
                [dict.verifyPlanRemaining, fill(dict.verifyPlanRemainingValue,
                  { tokens: plan.plan?.remainingTokens ?? 0, calls: plan.plan?.remainingCalls ?? 0 })],
              ], { left: true }),
            ]),
            plan.startError ? h('p', { key: 'se', className: 'mse-error' }, codeLabel(dict, plan.startError)) : null,
            plan.stale === true ? h('p', { key: 'stale', className: 'mse-error' }, dict.verifyStale) : null,
          ]),
        disclosure('boundary', dict.verifyBoundaryTitle,
          h('p', { key: 'p', className: 'mse-note' }, dict.verifyBoundary), { id: 'boundary' }),
      ])
    })()

    const jobList = (() => {
      const jobs = Array.isArray(props.jobs) ? props.jobs : []
      const shown = job !== null && job !== undefined && !jobs.some(row => row.id === job.id) ? [...jobs, job] : jobs
      return h('div', { key: 'jobs' }, [
        sectionTitle('t', dict.jobsTitle),
        shown.length === 0 ? h('p', { key: 'none', className: 'mse-note' }, dict.jobsEmpty)
          : h('div', { key: 'list' }, shown.map(entry => h(JobRow, { key: entry.id, dict, job: entry, locale,
            onCancel: id => { props.onCancelJob?.(id) } }))),
      ])
    })()

    return h('div', { key: 'manual', className: 'mse-pane' }, [
      scopeRow('tasks', dict.scopePicker, props.scopeOptions ?? [], sessionId, value => props.onScope?.(value)),
      h('p', { key: 'n', className: 'mse-hint' }, dict.manualNote),
      turnsBlock,
      verifyBlock,
      jobList,
    ])
  }

  /** The global settings section: the one complete panel. */
  function SettingsSection(props) {
    return h(MsePanel, { ...props, variant: 'settings' })
  }

  /**
   * The bundle row inside the host's own plugin manager.
   *
   * It deliberately does not mount a second copy of the panel: the settings section is the
   * single full surface, and a duplicate here would be a second implementation to keep in
   * step. The host owns the row's management controls; this contributes the honest pointer,
   * because rc.2 exposes no public way for one client plugin to navigate another to a
   * settings section — the section it would open is one click away in the same modal.
   */
  function BundlePage(props) {
    const dict = props.locale === 'en' ? en : zh
    return h('section', { className: 'mse-details', 'data-mse-details': 'pointer' }, [
      h('div', { key: 'heading', className: 'mse-heading' }, [h('h1', { key: 't' }, dict.settingsTitle)]),
      row('path', dict.settingsPath, dict.settingsPointer, null),
      row('note', dict.notLearnedNote, null, null),
    ])
  }

  async function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mse-learning: detail dictionaries')
    ctx.effect(() => {
      const style = document.createElement('style')
      style.dataset.plugin = BUNDLE
      style.textContent = STYLE
      document.head.append(style)
      return () => style.remove()
    }, 'mse-learning: detail styles')
    const unmount = await ctx.remote.$mount(REMOTE)
    ctx.effect(() => unmount, 'mse-learning: detail remote')
    const unmountControl = await ctx.remote.$mount(CONTROL)
    ctx.effect(() => unmountControl, 'mse-learning: control remote')
    ctx.inject(['remote.mseDetails', 'remote.mseControl'], scope => {
      const call = (method, input) => scope.remote.mseDetails[method](input ?? {})
      const control = (method, input) => scope.remote.mseControl[method](input ?? {})
      const locale = () => scope.locale.getLocale().active
      scope.slots.inject('plugins.bundle.config', () => scope.slots.register({
        name: 'plugins.bundle.config',
        key: BUNDLE,
        locale: NS,
        inject: () => ({ call, control, locale: locale() }),
      }, BundlePage))
      const form = ctx.configForms.get(SETTINGS_ID)
      // The section exists only while the host actually serves this namespace, so a profile
      // without the row never shows a page whose switches could not be saved.
      ctx.effect(() => ctx.configForms.whileServed([SETTINGS_ID], () => scope.slots.inject('settings.section',
        () => scope.slots.register({
          name: 'settings.section',
          id: SETTINGS_ID,
          order: 66,
          label: () => (locale() === 'en' ? 'Self-evolution' : '自我进化'),
          locale: NS,
          inject: () => ({ call, control, form, locale: locale() }),
        }, SettingsSection))))
    })
  }

  // The loader takes whatever the factory returns as this package's module exports.
  return {
    name: 'mse-learning-details-client',
    inject: ['slots', 'locale', 'remote', 'configForms'],
    apply,
    // Pure helpers the packaged regression suite imports; the rendering path never reads them.
    __test: { NS, SETTINGS_ID, BUNDLE, REMOTE, CONTROL, TABS, PAGE_SIZES, zh, en, reasonLabel, settleLabel,
      codeLabel, kindLabel, formatBytes, formatTime, storeState, statusLabelOf, environmentLabel, normalizeQuery,
      scopeLine, sessionOptions, callRemote, controlCall, failureCode, failureText, diffOps, defaultDraft, fill,
      MsePanel, SettingsSection, BundlePage, ManualPanel, JobRow, useFormSnapshot, CONTEXT_MIN, CONTEXT_MAX },
  }
} })
