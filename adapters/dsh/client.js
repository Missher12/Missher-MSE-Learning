/**
 * MSE 学习详情（只读）— browser half of the MSE bundle.
 *
 * Registered as the bundle's `./client` export in this package's own manifest: the Host
 * serves this file to the web shell, the shell evaluates it, and `__ModuleLoader__` hands
 * the module back to Cordis. It adds one keyed entry to the Plugins page's public
 * `plugins.bundle.config` slot, so 设置 → 插件 → MSE 的详情页 directly carries a
 * 「学习详情」section. Nothing here writes: reads go through the read-only `mseDetails`
 * Remote, the page never appends model context and never consumes recall budget.
 *
 * One scope selector drives every view, and every request belongs to a generation: a response
 * from a scope or a moment the page has already left is dropped instead of repainting the
 * current one, and switching scope clears what the previous scope showed.
 */
window.__ModuleLoader__.load({ id: '@missher/dsh-mse-learning', factory: (require) => {
  const React = require('react')
  const NS = 'mse.details'
  const BUNDLE = '@missher/dsh-mse-learning'
  const REFRESH_INTERVAL_MS = 20_000
  const PAGE_SIZES = [10, 20, 50]
  const TABS = ['overview', 'lessons', 'recall', 'budget']
  const MAX_QUERY_CHARS = 64
  const MAX_PROMPT_CHARS = 200
  const METHODS = ['overview', 'sessions', 'lessons', 'lesson', 'recall', 'diagnose']

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

  const zh = {
    title: '学习详情',
    subtitle: '本机持久学习的只读视图；查询不会发送模型请求，也不消耗召回额度。',
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
    tabOverview: '总览',
    tabLessons: '经验',
    tabRecall: '召回',
    tabBudget: '预算',
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
    search: '搜索正文',
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
    diagnoseTitle: '只读诊断（dry run）',
    diagnosePrompt: '输入一个任务描述',
    diagnoseRun: '诊断',
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
    codeNames: {
      core_unavailable: '学习核心未加载（插件可能已停用或加载失败）',
      session_unknown: '该会话不在宿主会话目录中（可能已删除），请重新选择',
      session_required: '需要先选择一个会话',
      session_directory_unavailable: '宿主会话目录服务不可用',
      session_directory_failed: '读取会话目录失败',
      migration_required: '学习库需要迁移（schema 1 → 2），当前不可读',
      store_unavailable: '学习库不可读',
      lesson_not_in_scope: '该经验不属于当前作用域',
      history_unavailable: '世代记录不可读',
      library_counts_unavailable: '计数不可读',
      session_ledger_unavailable: '会话字节账本不可读',
      diagnose_unavailable: '只读诊断不可用',
      remote_failed: '远程调用失败',
      empty_result: '宿主返回了空结果',
    },
    unavailable: '当前不可读。',
    selected: '已选择',
  }
  const en = {
    title: 'Learning details',
    subtitle: 'Read-only view of the local learning state; queries send no model request and consume no recall budget.',
    refresh: 'Refresh', refreshing: 'Reading…', autoRefresh: 'Refresh every 20 s',
    scopePicker: 'Session', scopeDefault: 'Default (instance) scope', scopeProject: 'Project scope',
    scopeInstance: 'Instance scope', scopeArchived: 'Archived', scopeRunning: 'Running',
    scopePersisted: 'Persisted', scopeLive: 'In memory', scopeUnknown: 'Directory unavailable',
    tabOverview: 'Overview', tabLessons: 'Lessons', tabRecall: 'Recall', tabBudget: 'Budget',
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
    lessonsTitle: 'Learned lessons', search: 'Search text', kindFilter: 'Kind', statusFilter: 'Status', all: 'All',
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
    diagnoseTitle: 'Read-only dry run', diagnosePrompt: 'Describe a task', diagnoseRun: 'Diagnose',
    diagnoseNone: 'Not run yet.', diagnoseResult: 'Outcome', wouldInject: 'Would inject',
    reasonNames: { recalled: 'Injected', not_learned: 'Nothing learned', scope_mismatch: 'Scope mismatch',
      match_insufficient: 'Match insufficient', method_unvalidated: 'Method unvalidated', already_offered: 'Already offered',
      budget_exhausted: 'Budget exhausted', internal_task: 'Internal task skipped', store_failure: 'Store failure',
      correction_learned: 'Correction just learned', conflict_unresolved: 'Preference conflict', turn_closed: 'Turn closed',
      filtered_origin: 'Origin filtered' },
    settleNames: { settled: 'Settled', duplicate: 'Duplicate (recorded)', retrying: 'Retrying', exhausted: 'Exhausted',
      failed: 'Failed', expired: 'Expired', stopped: 'Stopped', capacity: 'At capacity', pending: 'Pending' },
    codeNames: { core_unavailable: 'The learning core is not loaded (plugin disabled or failed to load)',
      session_unknown: 'That session is not in the Host directory (it may be gone); pick another',
      session_required: 'Pick a session first', session_directory_unavailable: 'The Host session directory is unavailable',
      session_directory_failed: 'Reading the session directory failed', migration_required: 'The store needs migration (schema 1 → 2)',
      store_unavailable: 'The learning store is unreadable', lesson_not_in_scope: 'That lesson is not in this scope',
      history_unavailable: 'Generation history unreadable', library_counts_unavailable: 'Counts unreadable',
      session_ledger_unavailable: 'Session byte ledger unreadable', diagnose_unavailable: 'The dry run is unavailable',
      remote_failed: 'Remote call failed', empty_result: 'The Host returned an empty result' },
    unavailable: 'Unavailable.', selected: 'Selected',
  }

  const STYLE = `
.mse-details{display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px}
.mse-details h4{margin:0;font-size:14px;font-weight:600}
.mse-details p{margin:0;color:var(--dsw-alias-label-secondary)}
.mse-details .mse-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.mse-details .mse-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.mse-details .mse-tab{appearance:none;border:0;background:transparent;padding:6px 10px;border-radius:6px 6px 0 0;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:13px}
.mse-details .mse-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-weight:600}
.mse-details .mse-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}
.mse-details .mse-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:4px}
.mse-details .mse-card b{font-weight:600;font-size:16px}
.mse-details .mse-label{color:var(--dsw-alias-label-tertiary);font-size:12px}
.mse-details button,.mse-details select,.mse-details input{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px}
.mse-details button{cursor:pointer}
.mse-details button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mse-details button:disabled{opacity:.5;cursor:default}
.mse-details table{width:100%;border-collapse:collapse}
.mse-details th,.mse-details td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);vertical-align:top}
.mse-details th{color:var(--dsw-alias-label-tertiary);font-weight:500;font-size:12px}
.mse-details tr.mse-clickable{cursor:pointer}
.mse-details tr.mse-clickable:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mse-details .mse-chip{display:inline-block;padding:1px 6px;border-radius:10px;background:var(--dsw-alias-bg-layer-3);font-size:11px;color:var(--dsw-alias-label-secondary)}
.mse-details .mse-chip[data-tone="ok"]{color:var(--dsw-alias-state-business-primary)}
.mse-details .mse-chip[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary))}
.mse-details .mse-chip[data-tone="err"]{color:var(--dsw-alias-state-error-primary)}
.mse-details .mse-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.mse-details .mse-error{color:var(--dsw-alias-state-error-primary)}
.mse-details .mse-note{color:var(--dsw-alias-label-tertiary);font-size:12px}
.mse-details .mse-pre{white-space:pre-wrap;word-break:break-word}
.mse-details .mse-dl{display:grid;grid-template-columns:140px 1fr;gap:4px 10px}
.mse-details .mse-dl dt{color:var(--dsw-alias-label-tertiary)}
.mse-details .mse-scroll{max-height:360px;overflow:auto}
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

  function MseDetailsPage(props) {
    const dict = props.locale === 'en' ? en : zh
    const call = props.call
    const locale = props.locale
    const [tab, setTab] = React.useState('overview')
    const [sessionId, setSessionId] = React.useState('')
    const [auto, setAuto] = React.useState(false)
    const [reloadToken, setReloadToken] = React.useState(0)
    const [listQuery, setListQuery] = React.useState({ query: '', kind: '', status: '', page: 1, pageSize: 20 })
    // Every slot carries the scope it belongs to: a late answer can never repaint another scope.
    const [shell, setShell] = React.useState({ status: 'idle' })
    const [recall, setRecall] = React.useState(null)
    const [lessons, setLessons] = React.useState(null)
    const [detail, setDetail] = React.useState(null)
    const [prompt, setPrompt] = React.useState('')
    const [dryRun, setDryRun] = React.useState(null)
    const generation = React.useRef(0)
    // The scope generation covers "another scope"; these cover "another request of the same
    // resource in the same scope", so the newest query or click always wins.
    const listSeq = React.useRef(0)
    const detailSeq = React.useRef(0)
    const diagnoseSeq = React.useRef(0)
    const scopeKey = sessionId === '' ? 'default' : sessionId

    React.useEffect(() => {
      generation.current += 1
      const mine = generation.current
      setShell(current => ({ ...current, status: 'loading' }))
      // Leaving a scope drops everything that belonged to it.
      setDetail(null)
      setDryRun(null)
      setRecall(null)
      setLessons(null)
      listSeq.current += 1
      detailSeq.current += 1
      diagnoseSeq.current += 1
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
      return () => { if (generation.current === mine) generation.current += 1 }
    }, [call, sessionId, reloadToken, dict])

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

    const openDetail = async id => {
      const mine = generation.current
      const seq = detailSeq.current + 1
      detailSeq.current = seq
      const mineNow = () => generation.current === mine && detailSeq.current === seq
      try {
        const payload = await callRemote(call, 'lesson', { id, ...(sessionId === '' ? {} : { sessionId }) })
        if (!mineNow()) return
        setDetail({ scopeKey, payload })
      } catch (error) {
        if (!mineNow()) return
        setDetail({ scopeKey, error: failureText(dict, error) })
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
    const currentRecall = recall !== null && recall.scopeKey === scopeKey ? recall : null
    const currentLessons = lessons !== null && lessons.scopeKey === scopeKey ? lessons : null
    const currentDetail = detail !== null && detail.scopeKey === scopeKey ? detail : null
    const currentDryRun = dryRun !== null && dryRun.scopeKey === scopeKey ? dryRun : null
    const scope = currentRecall?.payload?.scope ?? currentLessons?.payload?.scope ?? null
    const ledger = currentRecall?.payload?.session ?? currentDryRun?.payload?.session ?? null

    const header = h('div', { key: 'header', className: 'mse-row' }, [
      h('h4', { key: 'title' }, dict.title),
      h('span', { key: 'version', className: 'mse-chip' }, `v${overview?.version ?? '—'}`),
      h('span', { key: 'state', className: 'mse-chip', 'data-tone': enabled ? 'ok' : 'warn' },
        enabled ? dict.enabled : (overview === undefined ? dict.loading : dict.paused)),
      legacy ? h('span', { key: 'legacy', className: 'mse-chip', 'data-tone': 'warn' }, dict.legacy) : null,
      h('span', { key: 'store', className: 'mse-chip', 'data-tone': store.tone }, store.text),
      h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
      h('button', { key: 'refresh', type: 'button', onClick: () => setReloadToken(current => current + 1),
        disabled: shell.status === 'loading' }, shell.status === 'loading' ? dict.refreshing : dict.refresh),
      h('label', { key: 'auto', className: 'mse-note', style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } },
        h('input', { type: 'checkbox', checked: auto, onChange: event => setAuto(event.target.checked) }), dict.autoRefresh),
    ])

    const picker = h('div', { key: 'picker', className: 'mse-row' }, [
      h('label', { key: 'label', className: 'mse-label', htmlFor: 'mse-details-scope' }, dict.scopePicker),
      h('select', { key: 'select', id: 'mse-details-scope', 'aria-label': dict.scopePicker, value: sessionId,
        onChange: event => setSessionId(event.target.value) },
      options.map(option => h('option', { key: option.id === '' ? 'default' : option.id, value: option.id }, option.label))),
      h('span', { key: 'scope', className: 'mse-note' }, scopeLine(dict, scope)),
      shell.sessions !== undefined && shell.sessions !== null && shell.sessions.ok !== true
        ? h('span', { key: 'dir', className: 'mse-error' }, codeLabel(dict, shell.sessions.code)) : null,
    ])

    const tabs = h('div', { key: 'tabs', className: 'mse-tabs', role: 'tablist' },
      TABS.map(id => h('button', { key: id, type: 'button', role: 'tab', className: 'mse-tab',
        'aria-selected': tab === id, onClick: () => setTab(id) },
      id === 'overview' ? dict.tabOverview : id === 'lessons' ? dict.tabLessons : id === 'recall' ? dict.tabRecall : dict.tabBudget)))

    const card = (label, value) => h('div', { key: label, className: 'mse-card' },
      h('span', { className: 'mse-label' }, label), h('b', null, String(value)))
    // One keyed fragment per term: a nested array of two elements would make React warn about
    // missing keys inside a definition list that is itself an array child.
    const term = (label, value) => h(React.Fragment, { key: label },
      h('dt', null, label), h('dd', { style: { margin: 0 } }, value))
    const select = (label, entries, value, onChange) => h('label', { className: 'mse-row', key: label },
      h('span', { className: 'mse-label' }, label),
      h('select', { 'aria-label': label, value, onChange: event => onChange(event.target.value) },
        entries.map(([id, text]) => h('option', { key: id, value: id }, text))))
    const diagnosticLine = diagnostics => diagnostics === null || diagnostics === undefined
      ? '—'
      : `匹配 ${diagnostics.matched ?? 0} / 候选 ${diagnostics.candidates ?? 0} / 可用 ${diagnostics.eligible ?? 0}` +
        ` · 已提供 ${diagnostics.alreadyOffered ?? 0} · 过期 ${diagnostics.expired ?? 0} · 停用 ${diagnostics.suspended ?? 0}` +
        ` · 其他作用域 ${diagnostics.otherScope ?? 0} · 方法未验证 ${diagnostics.methodUnvalidated ?? 0}`

    const overviewPanel = h('div', { key: 'overview', style: { display: 'grid', gap: '10px' } }, [
      h('p', { key: 'subtitle' }, dict.subtitle),
      h('p', { key: 'note', className: 'mse-note' }, dict.notLearnedNote),
      overview === undefined || overview.ok !== true
        ? h('p', { key: 'state', className: 'mse-error' }, codeLabel(dict, overview?.code ?? 'unavailable'))
        : h('div', { key: 'cards', style: { display: 'grid', gap: '8px' } }, [
          h('span', { key: 'counts', className: 'mse-label' }, dict.countsTitle),
          overview.countsError !== null && overview.countsError !== undefined
            ? h('p', { key: 'countsErr', className: 'mse-error' },
              `${dict.countsFailed}：${codeLabel(dict, overview.countsError)}`)
            : h('div', { key: 'grid', className: 'mse-grid' }, [
              card(dict.version, overview.version),
              card(dict.runtime, overview.runtime ?? 'dsh'),
              card(dict.activeCorrections, overview.counts?.activeCorrections ?? 0),
              card(dict.methodsValidated, overview.counts?.methodsValidated ?? 0),
              card(dict.methodsUnvalidated, overview.counts?.methodsUnvalidated ?? 0),
              card(dict.otherEnvironment, overview.counts?.otherEnvironment ?? 0),
              card(dict.suspended, overview.counts?.suspended ?? 0),
              card(dict.expired, overview.counts?.expired ?? 0),
              card(dict.scopeLessons, overview.counts?.scopeLessons ?? 0),
              card(dict.otherScope, overview.counts?.otherScope ?? 0),
              card(dict.total, overview.lessonsTotal ?? overview.counts?.total ?? 0),
              card(dict.turnBudget, formatBytes(overview.budget?.turnBytes)),
              card(dict.sessionBudget, formatBytes(overview.budget?.sessionBytes)),
              card(dict.maxLessons, String(overview.budget?.maxLessons ?? '—')),
              card(dict.sessionUsed, ledger === null ? '—' : `${formatBytes(ledger.bytes)} / ${formatBytes(ledger.budgetBytes)}`),
            ]),
        ]),
    ])

    const lessonsPanel = (() => {
      const page = currentLessons
      const controls = h('div', { key: 'controls', className: 'mse-row' }, [
        h('input', { key: 'search', type: 'search', placeholder: dict.search, 'aria-label': dict.search, value: listQuery.query,
          onChange: event => setListQuery(current => ({ ...current, query: event.target.value.slice(0, MAX_QUERY_CHARS), page: 1 })) }),
        select(dict.kindFilter, [['', dict.all], ['correction', dict.kindCorrection], ['method', dict.kindMethod]], listQuery.kind,
          value => setListQuery(current => ({ ...current, kind: value, page: 1 }))),
        select(dict.statusFilter, [['', dict.all], ['reminder', dict.activeCorrections], ['candidate', dict.methodsUnvalidated],
          ['validated', dict.methodsValidated], ['suspended', dict.suspended]], listQuery.status,
        value => setListQuery(current => ({ ...current, status: value, page: 1 }))),
        select(dict.pageSize, PAGE_SIZES.map(size => [String(size), String(size)]), String(listQuery.pageSize),
          value => setListQuery(current => ({ ...current, pageSize: Number(value), page: 1 }))),
      ])
      const heading = (extra = []) => h('div', { key: 'head', className: 'mse-row' }, [h('h4', { key: 't' }, currentDetail === null ? dict.lessonsTitle : dict.detail), ...extra])
      if (currentDetail !== null) {
        const back = h('button', { key: 'back', type: 'button', onClick: () => setDetail(null) }, dict.back)
        if (currentDetail.error !== undefined) return h('div', { key: 'lessons', style: { display: 'grid', gap: '10px' } },
          [heading([back]), h('p', { key: 'e', className: 'mse-error' }, currentDetail.error)])
        const payload = currentDetail.payload
        if (payload.ok !== true) return h('div', { key: 'lessons', style: { display: 'grid', gap: '10px' } },
          [heading([back]), h('p', { key: 'e', className: 'mse-error' }, codeLabel(dict, payload.code))])
        const row = payload.lesson
        return h('div', { key: 'lessons', style: { display: 'grid', gap: '10px' } }, [
          heading([back, h('span', { key: 'scope', className: 'mse-note' }, scopeLine(dict, payload.scope))]),
          h('dl', { key: 'dl', className: 'mse-dl' }, [
            term(dict.instruction, h('span', { className: 'mse-pre' }, row.instruction)),
            term(dict.kind, kindLabel(dict, row.kind)),
            term(dict.status, `${statusLabelOf(dict, row.status)} (${row.status})`),
            term(dict.savedAt, formatTime(row.createdAt, locale)),
            term(dict.expiresAt, formatTime(row.expiresAt, locale)),
            term(dict.source, row.sourceTurn === null ? dict.notRecorded
              : h('span', null, `${dict.sourceTurn} `, h('span', { className: 'mse-mono' }, row.sourceTurn))),
            term(dict.environment, environmentLabel(dict, row)),
            term(dict.counters, `${dict.adopted} ${row.adopted} · ${dict.verified} ${row.verified} · ${dict.failed} ${row.failed} · ${dict.inconclusive} ${row.inconclusive}`),
            term(dict.validation, row.validation === null ? dict.notRecorded : `${row.validation.decision} · ${row.validation.basis || '—'} · ${formatTime(row.validation.at, locale)}`),
            term(dict.topic, row.topicKey ?? dict.notRecorded),
            term(dict.value, row.value ?? dict.notRecorded),
            term(dict.history, row.historyComplete ? dict.historyComplete : dict.historyIncomplete),
            row.applicability ? term(dict.applicability, row.applicability) : null,
            row.exclusions ? term(dict.exclusions, row.exclusions) : null,
            term(dict.replaces, row.replaces ?? dict.notRecorded),
            term(dict.replacedBy, row.replacedBy ?? dict.notRecorded),
            term('ID', h('span', { className: 'mse-mono' }, row.id)),
            term('version', String(row.version ?? 0)),
          ]),
          h('div', { key: 'exp' }, [
            h('p', { key: 'l', className: 'mse-label' }, dict.experiments),
            row.experiments.length === 0 ? h('p', { key: 'none', className: 'mse-note' }, dict.notRecorded)
              : h('table', { key: 'table' }, h('tbody', null, row.experiments.map((record, index) => h('tr', { key: index }, [
                h('td', { key: 'd' }, record.decision), h('td', { key: 'v' }, `v${record.version}`),
                h('td', { key: 'a' }, formatTime(record.at, locale)),
                h('td', { key: 'r' }, record.reasons.join(', ') || '—')])))),
          ]),
          payload.historyError ? h('p', { key: 'herr', className: 'mse-note' },
            `${codeLabel(dict, payload.historyError)}（${payload.historyError}）`) : null,
        ])
      }
      if (page === null || page === undefined) return h('div', { key: 'lessons', style: { display: 'grid', gap: '10px' } },
        [heading(), controls, h('p', { key: 'l', className: 'mse-note' }, dict.loading)])
      if (page.error !== undefined) return h('div', { key: 'lessons', style: { display: 'grid', gap: '10px' } },
        [heading(), controls, h('p', { key: 'e', className: 'mse-error' }, page.error)])
      const payload = page.payload
      if (payload.ok !== true) return h('div', { key: 'lessons', style: { display: 'grid', gap: '10px' } },
        [heading(), controls, h('p', { key: 'e', className: 'mse-error' }, codeLabel(dict, payload.code))])
      const rows = payload.items ?? []
      return h('div', { key: 'lessons', style: { display: 'grid', gap: '10px' } }, [
        heading(),
        h('p', { key: 'scope', className: 'mse-note' }, scopeLine(dict, payload.scope)),
        controls,
        payload.countsError ? h('p', { key: 'cerr', className: 'mse-error' },
          `${dict.countsFailed}：${codeLabel(dict, payload.countsError)}`) : null,
        h('p', { key: 'complete', className: 'mse-note' },
          dict.complete.replace('{total}', String(payload.scopeTotal ?? 0)).replace('{cap}', String(payload.storeCap ?? '—'))),
        rows.length === 0
          ? h('p', { key: 'empty', className: 'mse-note' },
            listQuery.query || listQuery.kind || listQuery.status ? dict.emptyFiltered : dict.emptyLessons)
          : h('div', { key: 'table', className: 'mse-scroll' }, h('table', null, [
            h('thead', { key: 'h' }, h('tr', null, [dict.instruction, dict.kind, dict.status, dict.savedAt, dict.counters]
              .map(label => h('th', { key: label }, label)))),
            h('tbody', { key: 'b' }, rows.map(row => h('tr', { key: row.id, className: 'mse-clickable',
              onClick: () => { void openDetail(row.id) } }, [
              h('td', { key: 'i', className: 'mse-pre' }, row.instruction),
              h('td', { key: 'k' }, h('span', { className: 'mse-chip' }, kindLabel(dict, row.kind))),
              h('td', { key: 's' }, h('span', { className: 'mse-chip', 'data-tone': statusTone(row.status) }, statusLabelOf(dict, row.status))),
              h('td', { key: 't' }, formatTime(row.createdAt, locale)),
              h('td', { key: 'c', className: 'mse-mono' }, `${row.adopted}/${row.verified}/${row.failed}/${row.inconclusive}`),
            ]))),
          ])),
        h('div', { key: 'pager', className: 'mse-row' }, [
          h('button', { key: 'prev', type: 'button', disabled: payload.page <= 1,
            onClick: () => setListQuery(current => ({ ...current, page: Math.max(1, current.page - 1) })) }, dict.prev),
          h('span', { key: 'page', className: 'mse-note' },
            dict.page.replace('{page}', String(payload.page)).replace('{pages}', String(payload.pages))),
          h('button', { key: 'next', type: 'button', disabled: payload.page >= payload.pages,
            onClick: () => setListQuery(current => ({ ...current, page: current.page + 1 })) }, dict.next),
          h('span', { key: 'total', className: 'mse-note' }, `${payload.total} · ${dict.scopeLessons}`),
        ]),
      ])
    })()

    const recallPanel = (() => {
      if (sessionId === '') return h('div', { key: 'recall', style: { display: 'grid', gap: '10px' } },
        [h('h4', { key: 't' }, dict.recallTitle), h('p', { key: 'p', className: 'mse-note' }, dict.recallPick)])
      const slot = currentRecall
      if (slot === null) return h('div', { key: 'recall' }, [h('h4', { key: 't' }, dict.recallTitle),
        h('p', { key: 'l', className: 'mse-note' }, dict.loading)])
      if (slot.error !== undefined) return h('div', { key: 'recall' }, [h('h4', { key: 't' }, dict.recallTitle),
        h('p', { key: 'e', className: 'mse-error' }, slot.error)])
      const payload = slot.payload
      if (payload.ok !== true) return h('div', { key: 'recall' }, [h('h4', { key: 't' }, dict.recallTitle),
        h('p', { key: 'e', className: 'mse-error' }, codeLabel(dict, payload.code))])
      const recent = payload.recent ?? []
      const recentTable = h('div', { key: 'table', className: 'mse-scroll' }, h('table', null, [
        h('thead', { key: 'h' }, h('tr', null, [dict.turn, dict.at, dict.reason, dict.injected, dict.lessonsUsed, dict.settle]
          .map(label => h('th', { key: label }, label)))),
        h('tbody', { key: 'b' }, recent.map((row, index) => h('tr', { key: index }, [
          h('td', { key: 't', className: 'mse-mono' }, String(row.turn ?? '-')),
          h('td', { key: 'a' }, formatTime(row.at, locale)),
          h('td', { key: 'r' }, h('span', { className: 'mse-chip', 'data-tone': row.reason === 'recalled' ? 'ok' : 'warn' },
            reasonLabel(dict, row.reason))),
          h('td', { key: 'b' }, formatBytes(row.bytes)),
          h('td', { key: 's', className: 'mse-mono' },
            (row.sources ?? []).map(source => `${shortId(source.id)}@v${source.version}`).join(' ') || dict.notRecorded),
          h('td', { key: 'st' }, row.settleState === null || row.settleState === undefined ? dict.notRecorded
            : `${settleLabel(dict, row.settleState)}${row.settleError ? ` (${row.settleError})` : ''}`),
        ]))),
      ]))
      return h('div', { key: 'recall', style: { display: 'grid', gap: '10px' } }, [
        h('h4', { key: 't' }, dict.recallTitle),
        h('p', { key: 'scope', className: 'mse-note' }, scopeLine(dict, payload.scope)),
        h('p', { key: 'mem', className: 'mse-note' }, dict.recallNone),
        recent.length === 0 ? null : recentTable,
        h('div', { key: 'diag' }, [
          h('p', { key: 'l', className: 'mse-label' }, dict.diagnostics),
          recent.length === 0 ? h('p', { key: 'none', className: 'mse-note' }, dict.recallNone)
            : h('table', { key: 'table' }, h('tbody', null, recent.map((row, index) => h('tr', { key: index }, [
              h('td', { key: 't', className: 'mse-mono' }, String(row.turn ?? '-')),
              h('td', { key: 'd' }, diagnosticLine(row.diagnostics))])))),
        ]),
        h('div', { key: 'settle' }, [
          h('p', { key: 'l', className: 'mse-label' }, dict.settle),
          (payload.settlement?.live ?? []).length === 0 ? h('p', { key: 'none', className: 'mse-note' }, dict.settleNone)
            : h('table', { key: 'table' }, h('tbody', null, (payload.settlement?.live ?? []).map((row, index) =>
              h('tr', { key: index }, [
                h('td', { key: 't', className: 'mse-mono' }, row.turnId ?? '-'),
                h('td', { key: 's' }, settleLabel(dict, row.state)),
                h('td', { key: 'a' }, String(row.attempts ?? 0)),
                h('td', { key: 'c' }, row.code ?? '-'),
              ])))),
        ]),
        h('div', { key: 'dry' }, [
          h('p', { key: 'l', className: 'mse-label' }, dict.diagnoseTitle),
          h('div', { key: 'row', className: 'mse-row' }, [
            h('input', { key: 'prompt', type: 'text', placeholder: dict.diagnosePrompt, value: prompt,
              'aria-label': dict.diagnosePrompt,
              onChange: event => setPrompt(event.target.value.slice(0, MAX_PROMPT_CHARS)) }),
            h('button', { key: 'run', type: 'button', onClick: () => { void runDiagnose() } }, dict.diagnoseRun),
          ]),
          currentDryRun === null ? h('p', { key: 'none', className: 'mse-note' }, dict.diagnoseNone)
            : currentDryRun.error !== undefined ? h('p', { key: 'err', className: 'mse-error' }, currentDryRun.error)
              : currentDryRun.payload.ok !== true
                ? h('p', { key: 'err', className: 'mse-error' }, codeLabel(dict, currentDryRun.payload.code))
                : h('dl', { key: 'result', className: 'mse-dl' }, [
                  term(dict.diagnoseResult, currentDryRun.payload.prompted === null ? dict.notRecorded
                    : reasonLabel(dict, currentDryRun.payload.prompted?.reason)),
                  term(dict.wouldInject, formatBytes(currentDryRun.payload.prompted?.wouldInjectBytes ?? 0)),
                  term(dict.diagnostics, currentDryRun.payload.prompted === null
                    ? '-' : diagnosticLine(currentDryRun.payload.prompted)),
                  term(dict.sessionUsed, currentDryRun.payload.session === null ? dict.notRecorded
                    : `${formatBytes(currentDryRun.payload.session.bytes)} / ${formatBytes(currentDryRun.payload.session.budgetBytes)}`),
                ]),
        ]),
      ])
    })()

    const budgetPanel = h('div', { key: 'budget', style: { display: 'grid', gap: '10px' } }, [
      h('h4', { key: 't' }, dict.budget),
      h('div', { key: 'grid', className: 'mse-grid' }, [
        card(dict.turnBudget, formatBytes(overview?.budget?.turnBytes)),
        card(dict.sessionBudget, formatBytes(overview?.budget?.sessionBytes)),
        card(dict.maxLessons, String(overview?.budget?.maxLessons ?? '—')),
        card(dict.sessionUsed, ledger === null ? '—' : `${formatBytes(ledger.bytes)} / ${formatBytes(ledger.budgetBytes)}`),
        card(dict.sessionRemaining, ledger === null ? '—' : formatBytes(ledger.remainingBytes)),
      ]),
      sessionId === '' ? h('p', { key: 'pick', className: 'mse-note' }, dict.recallPick) : null,
      currentRecall?.payload?.sessionError ? h('p', { key: 'lerr', className: 'mse-error' },
        `${codeLabel(dict, currentRecall.payload.sessionError)}（${currentRecall.payload.sessionError}）`) : null,
      h('p', { key: 'note', className: 'mse-note' }, dict.bytesNote),
      h('p', { key: 'caveat', className: 'mse-note' }, dict.notLearnedNote),
      h('ul', { key: 'reasons', style: { margin: 0, paddingInlineStart: '18px' } },
        ['not_learned', 'match_insufficient', 'budget_exhausted', 'method_unvalidated', 'scope_mismatch', 'already_offered']
          .map(code => h('li', { key: code }, `${reasonLabel(dict, code)} — ${code}`))),
    ])

    const body = tab === 'overview' ? overviewPanel : tab === 'lessons' ? lessonsPanel : tab === 'recall' ? recallPanel : budgetPanel
    return h('section', { className: 'mse-details', 'data-mse-details': 'page' }, [
      header,
      picker,
      shell.error ? h('p', { key: 'err', className: 'mse-error' }, `${dict.loadFailed}: ${shell.error}`) : null,
      tabs,
      body,
    ])
  }

  /** Cordis client plugin: one read-only bundle-config entry beside the plugin's own row. */
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
    ctx.inject(['remote.mseDetails'], scope => {
      const call = (method, input) => scope.remote.mseDetails[method](input ?? {})
      scope.slots.inject('plugins.bundle.config', () => scope.slots.register({
        name: 'plugins.bundle.config',
        key: BUNDLE,
        locale: NS,
        inject: () => ({ call, locale: scope.locale.getLocale().active }),
      }, MseDetailsPage))
    })
  }

  // The loader takes whatever the factory returns as this package's module exports.
  return {
    name: 'mse-learning-details-client',
    inject: ['slots', 'locale', 'remote'],
    apply,
    // Pure helpers the packaged regression suite imports; the rendering path never reads them.
    __test: { NS, REMOTE, TABS, PAGE_SIZES, zh, en, reasonLabel, settleLabel, codeLabel, kindLabel, formatBytes,
      formatTime, storeState, statusLabelOf, environmentLabel, normalizeQuery, scopeLine, sessionOptions,
      callRemote, failureCode, failureText, MseDetailsPage },
  }
} })
