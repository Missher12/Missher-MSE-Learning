# 当前公开产品上下文

## 2026-10-07：alpha.18 自动评审与验证交付候选

基于公开 alpha.17 包装升级，最终运行候选为 r3。下载示例已指向 alpha.18 固定资产；Release 中不存在同名文件时仍不可安装。日常安装、Release 与市场收录分别记录，本段不宣称已完成。

本轮共享 core 增加持久自动计划、独立模型评审、有限试用和 Host 固定领域检查。`reviewed/trial` 的收益为 `unproven`，不计作 validated；validated 需要可信客观证据并限定验证域。DSH 负责自动调度和可信会话接线，其他 Agent 仍需自己的适配，不保证自动接入所有 Agent 或永不犯错。

分层证据：r2 完整 Node 303/303、生命周期 10/10；Hermes Python/Node CLI 53/53 按共享运行字节及测试输入不变复用。r3 同冻结真实适配器离线 125/125，控制/提交/停止差异回归 62/62（控制状态22、提交竞态27、实际暂停8、卸载5）。r2 真实评审 54/54，4 次请求、1437 tokens，结果 reviewed/trial/unproven、validated=0；没有执行付费客观两臂验证。r3 仅修改 DSH index 的首次同值设置通知控制写入；精确包受控浏览器 UI 189/189、21 张截图通过，不等于日常原生窗口。具体版本归属与未测边界见 [VALIDATION](VALIDATION.md)，不要把 r2 真实调用写成 r3 实跑。

上手：设置 → 自我进化 → 开启自动验证；历史来源不可恢复时，显式选择有模型路线的验证会话，再设置可接受的非零评测额度。默认仍是自动验证 false、评测 token 0；自动与手动共用评测额度、调用前预占，复盘独立频次不变。历史回填不改原 scope，新反思持久保存来源会话/回合/路线。试用每轮≤1，计入总2条/默认768 UTF-8字节/会话1536字节。全库总览只扩大只读可见范围，不扩大召回或修改范围。总览/详情/诊断读取与用户配置、启停、手动复盘/验证的受控写入和调度分开。

保留双语 README、桌面/固定下载入口、MIT/metadata、DSH-only 包装、`.git` 排除、拒绝覆盖候选、显式 Host/UI/历史引擎环境入口。源码归档从干净公开暂存树构建；真实学习库、会话、凭据、本机审计 fixture 和机器路径不进入公开产品。

当前使用说明见 [README](README.md)，行为边界见 [BEHAVIOR](docs/BEHAVIOR.zh.md)。下方带日期内容逐字保留为历史，只说明对应版本；历史“核心未变”“未安装/未发布”等状态不覆盖本轮。

## 2026-10-06：alpha.17 会话选择显示对话标题

经验、召回、任务三处共用选择器现在以宿主标题为主文字，项目与运行/归档状态为辅助；未命名与重名使用短 ID 区分。只读标题来自 live projection 或 cold cache，权威空标题不会被旧缓存覆盖；只为实际显示的最多64行读取，不启动 Agent、不读冷会话完整日志。标题按 Unicode code point 限额，客户端保留标题文本并沿用宿主布局。该历史标题修复未调整 ID、项目作用域和预算，schema2 无迁移；不表示后续 alpha.18 的共享核心保持旧版本。alpha.16 的双语说明与公开包装修订保留。

本轮验证与日常安装/发布分别记录；下面各日期是历史阶段，不能用旧状态覆盖新版本。

# 公开产品上下文

历史说明（2026-10-05）：DSH alpha.16 当时仅为 MARKET-20261005 包装修订；alpha.18 的共享核心变化及待验收状态见顶部。当前使用及验证边界见 [README](README.md)；下面为带日期的研发历史，既有“未安装/未发布”等状态不代表本轮。原生业务源码与公开导出分工保持，真实数据不入库。

## 2026-10-03：0.9.0-alpha.15 持久 complete 结算（共享 core + DSH + Hermes）

同一核心、同一主文档、schema2 可选字段。`settlementOutbox`（pending≤64/终态≤32/单项≤4096B/总≤256KiB）与 `settlementControl`（单调代次、用户暂停、精确 stop 墓碑≤64）。抽出无锁 `completeInState` 供 public `complete` 与 `settlementApply` 共用，完成与退休同事务原子提交，不嵌套取锁。接口：`settlementEnqueue`（首事务提交才算 durable，ack 返回 key/payloadHash/deadline/generation）、`settlementStatus`（零写入）、`settlementApply`（严格校验必填 generation；终态优先回读；工作副本试算 complete，失败只提交次数/错误）、`settlementStop`（严格 XOR：raw sessionId 或本 owner 的 key+payloadHash，多余/混合/畸形一律 invalid_input 零写）、`settlementPause`。恢复只重放冻结的 `complete`，且消费冻结的原收据与接受事实（收据被替换即终态 `conflict`）。legacy 无 `sessionHash` 的 receipt 按「不可归属即保守绑定」保护，64 满且无可安全裁剪时明确拒绝控制。DSH 侧：服务就绪驱动恢复（`sessionQuery` 异步完整目录 + `workspaceRegistry` 归档真值，短时快照 + 代次失效；缺服务/异常/截断一律 unknown 且拒绝），归档/删除经 key 寻址精确 stop，dispose 保留 durable；只读配置重算不调度、不恢复、不记忆为「已恢复」。Hermes 侧：新增第 10 个 hook `on_session_finalize`，仅 `platform=cli && reason=session_boundary` 精确停旧 ID；Gateway 按 `old_session_id`；`shutdown`/unload 只停本进程。Node CLI 暴露结算操作（已移除不存在的死 API）。**已知限制**：持锁崩溃受既有 5 分钟死 PID grace 阻挡后只能明确 expired；`lock_busy` 在拿锁前发生，持久处理尝试数与锁争用调用次数是两件事。核心独立验收按轮次如实记：**r2 22 组通过**；**r3 8 组中 7 组通过、1 组失败**（失败项是 `settlementStop` 的 XOR 形态校验）；**r4 再新增 4 组，针对该形态修复做验证**。按函数与依赖字节边界复用已通过部分，不把 r3 的原 8 组整体写成通过。r2 覆盖真实跨进程恢复、SIGKILL 丢响应、双 PID 一次信用、rename 前后故障原子性与近 300 库容量。

## 2026-10-03：0.9.0-alpha.14 共享 core 升级（可信学习与精确召回）

第一阶段三项，均由独立审计在 alpha.13 上以真实 core、隔离状态复现，本轮修复并各自带固定样例：

1. **评测任务身份与完整清单身份分离**。`src/cases.mjs` 新增 `caseTaskKey`（只取规范化 prompt：NFKC、零宽字符、空白折叠，不改大小写与标点语义）、共享的严格原始校验 `checkTaskPrompt`（字符串、原长度 ≤400、可打印字符、有效 Unicode、非权威改写）与 `taskIndependence`；协议由 `prompt` **字段是否存在**决定——只要任意行带该字段，全部行都必须通过原始校验，`''`/`null`/数字/自有 `undefined`/控制符/未配对代理项/超长折叠文本一律拒绝，只有完全无该字段才是 legacy。`normalizeCases` 与**共享 core** 的 `evaluationRequest`/`runEvaluation` 都在 ticket、扣费与 runner 之前执行。全部不带 prompt 的旧 trusted-runner 协议保持兼容（其独立性仍由可信宿主保证，`evaluate(trials)` 同属受信证据接口，不声称能从分数证明来源）。完整内容身份仍进 `planIdentity`。未声明的语义重复检测能力不做承诺。
2. **适用/排除条件进入召回准入**。`src/recall.mjs` 新增 `formatMentions`（按子句判定否定，且**同一格式的每一次出现**都参与极性）、`parseCondition`（**格式包装模板整句匹配**：有限模板（含 `仅/只 <格式表> 导出` 短前缀写法）+ 完整「或」格式表 + 限定词与报表/导出短尾；格式身份取已匹配原子且要求完整词边界（`JSONL`/`NDJSON` 各自成组 ≠ `JSON`；`XLSX`/`XLS`/`Excel` 仍同属既有 `excel` 策划组），同组内每个别名与每次出现分别记录肯定/否定，冲突格式按 unclear 保守拒绝；排除字段的裸格式模板按字段语义判为排除）、`registeredConditions`、`conditionVerdict`；通用措辞只做**整句白名单匹配**且适用/排除两个字段极性分开。`evaluateLessons` 在候选计数前先过条件门禁，`prepare` 与 `diagnose` 同一实现，新增唯一原因码 `condition_blocked` 与门禁标签。**明示能力边界**：不支持理解任意中文场景条件，此类条件按 `condition_unclear` 保守拒绝，不做子串近似。字节与条数上限、作用域、环境、版本、当轮不回灌、已发送不重复均未变。
3. **满库仍能接收用户纠错**。`put()` 满 300 行时按 `selectEviction` 置换：只限**同作用域**、先过期/停用、其次仅对用户纠错置换最弱的未验证方法候选；`protectedLessonIds` 保护已验证方法、纠错、开放回归反证窗口、receipt `selected[]`/`accepted[]`、在途 job、近期 experiment，以及 `replacedBy` 与 `replaces` 两端的回滚链。受保护时返回明确 `capacity`；`state.evictions` 保存有界最小审计（无经验正文）。其他作用域的经验不会被删除。

**本机验证**：包内 Node 188/188（含 `tests/quality-alpha14.test.mjs` 14 项针对性回归）、Hermes Python 39/39、DSH 与 Hermes 两包 `src/` 逐文件相同、包一致性与原生 Loader 检查。真实模型调用 0；未安装日常、未迁移真实库、未推 Git。第二阶段持久 outbox 仅交付设计说明，未实现。

## 2026-10-01：0.9.0-alpha.6 alpha.5 收尾修复（A/B/C/D 四组 11 项）

Codex 独立复验 `dist/review-20261001-alpha5/REVIEW.md` 提出 11 项后，本轮按"只修原因、不新增能力"完成收尾：

- 纠错提取改用**原文区间**：受保护区间（引号/反引号/成对单引号）内不分句、存储取原文切片；一次性限定语跨分句传播，只有新长期标记才重新收集。修 A1/A2。
- 偏好替代：切回历史值重开为新世代（版本升级、旧证据不给新世代信用）；只有选择语境才占用币种槽位，独立精度要求按普通纠错保存；所有显式替代共用 `expectedSupersededVersion` 检查，并拒绝替代已被替代且后继仍有效的行。修 B1/B2/B3。
- 到期重学：新增 `originEvent`/`generationEvent` 永久世代标识＋有界事件环；旧库缺世代证据时返回 `new_observation_required`，需 `newGeneration: true` 显式断言；已完成的历史替代不再阻断新世代评测。修 C1/C2。
- 结算重试：结果事件携带 session/turn 且只写自己的回合；`on_session_reset` 与 legacy 冲突停用真正停止/暂停队列；终态退出活动容量并进入有界历史；epoch 毫秒与队列时钟在单一边界换算。修 D1/D2/D3/D4。
- 验证：11 项正确行为 Node 11/11、Hermes 5/5；上轮 31 项仍 31/31（期望未改）；Node 128/128、Hermes 28/28；R1–R7 通过；打包与源码归档一致，干净解包即跑通全部套件；DSH 0.2.0-rc.2 隔离安装/Loader/真实 AgentLoop 与 Hermes PluginManager 通过。真实模型、日常安装与长期收益仍未验证；结算仍为进程内重试。
- 不可变候选、SHA256、兼容与回滚、未验证层见 `dist/0.9.0-alpha.6/DELIVERY.md`。本轮未安装日常、未迁移真实库、未提交 Git。

# MSE Learning 产品上下文

## 2026-10-01：0.9.0-alpha.10 DSH「学习详情」只读设置页

Codex 复验了 alpha.9 之后，本轮的交付是在同一 `@missher/dsh-mse-learning` Bundle 内新增设置页，并修掉复验提出的 6 项 + 1 项打包问题。

- **入口**：插件声明 `dsh.client`（web）与 `./client`；浏览器端把页面注册进公开 slot `plugins.bundle.config`，key 为本包名，渲染在 设置 → 插件 → MSE 详情页内的「学习详情」。未新增兼容插件、未改宿主、未要求手动命令。
- **只读 RPC**：新增 Cordis 服务 `mseDetails`（`TypertRemoteService` + 公开 `Remote` 装饰器按标准方法上下文手工标注并用 `remoteMethods()` 自检）与 `./typert` 清单；6 个端点 `overview/sessions/lessons/lesson/recall/diagnose`，全部只读、全部经真实 Gateway 验证。
- **作用域可信**：会话目录来自宿主公开服务 `sessionQuery.listSessions()`（`workspaceRegistry.archivedSessionIds`、`sessions.get`、`agents.get` 只读补充），因此进程重启前的历史会话与"刚建未发消息"的会话都可选择；子智能体会话不列为普通会话；未知/消失的 sessionId 一律 `session_unknown` 拒绝，浏览器传来的 `projectKey` 被忽略。`cwd` 只以中文标签 + 12 位单向哈希展示，不出现路径。
- **不伪装的状态**：`overview` 只给聚合结算计数，不给别的会话明细；`recall` 的结算按所选会话过滤并附该会话字节账本；`diagnose` 的原库错误（如 `migration_required`）原样上报而不是包装成 `ok:true`；存储不可读时 `counts` 为 null 且带 `countsError`；缺少会话目录服务时报 `session_directory_unavailable`。
- **完整而不是抽样**：核心新增只读 `inspect()`（返回作用域内全部行与真实已保存 metadata：`sourceTurn`、`environment`、`currentEnvironment`、适用/排除条件、评测结论），因为 `put()` 把库上限固定在 300 行，单个作用域的读取天然完整；列表页据此给出真实 `scopeTotal` 而不是每状态 100 条的截取片段。
- **前端请求代次**：作用域、列表查询、经验详情与只读诊断各持请求序号；跨作用域或同作用域内的迟到响应都不会覆盖当前视图（Codex 的 5 项组件检查与 2 项 query/detail 竞态检查全过）。
- **打包**：包根 `"."` 改为薄入口 `src/root.mjs`（重导出通用 core，只有宿主调用 `apply` 时才动态加载 `adapters/dsh/index.mjs`），`./core` 保留；`cordis.patch.yml` 的行名改为包根，前端才能被 `client-modules` 发现。`verify-package.mjs` 增加"无任何 DSH peer 的干净进程 import 包根并读到 LearningEngine"的检查。
- **验证**：Node 150/150、Hermes 39/39（同一轮内已跑）、Gateway 只读 RPC 39/39、固定 31/31（`casesSHA256` 未变）、alpha.6/7/8 基线与 R1–R7 结论不变、包一致性通过；隔离 web 宿主的 29 项页面断言与 11 张截图在最终 tgz 上复跑通过。未验证：真实供应商请求、日常安装；页面里的"发送一条消息以产生召回"这一步在隔离环境未完成（未配置模型，点击输入框超时），因此本轮的召回/注入不是实测结论，只读页面本身已验。

## 2026-10-01：0.9.0-alpha.9 alpha.8 复验收尾（R3 锁等待期间的有效性复核）

Codex 独立复验 `dist/review-20261001-alpha8/REVIEW.md` 复现 1 项后，本轮按"只修根因"收尾：

- R3：alpha.8 让后台结算在共用写入边界上**有界等待**，但等待前的许可/生命周期/期限检查在拿到边界后没有重做。等待期间 `set_enabled(False)`、关闭会话、卸载或收据到期，重试仍会调用 `complete`；`close_session` 已把条目退休为 stopped，随后又被追加 settled。
- 修复：把最终有效性检查和实际写入放进**同一个串行化边界**（`SettlementQueue.attempt` 持有边界后才复核），并复核 ①最新宿主许可 ②queue/queue-lifecycle（disposed/paused）③条目身份与存续（`entries.get(key) is entry`，含被 close/reset 移除或同键替换的情形）④当前时钟下的截止时间。失效项按原契约处理：暂停保留原冻结载荷（不吃尝试次数）、关闭/卸载只退出不写、过期退休为 expired；不记为 settled、不重复退休、不重新入队。边界通过 `Hooks._write_boundary()` **每次尝试重新解析**（不是构造时捕获），因此前台/后台始终用同一把锁。前台 `_foreground_call` 的退避也在每次重试前重读同一生命周期边界。有界等待、有限重试、冻结 outcome、恢复召回、单次信用与上下文预算全部保留。
- 验证：`scripts/verify-alpha9-fixes.py` R3 **6/6**（对照 2 次调用；许可撤回、显式暂停、关闭会话、卸载、到期五种等锁期间失效各 1 次且状态正确；暂停后恢复未过期重放一次、恢复已过期只退休；前台退避生命周期；原生前后台先后交错）；Codex 自己的 `mse-alpha8-adapter-review-wait-boundary.py` 重跑 **6/6**（原 0/6，其中对照 1/1 通过）；Hermes **39/39**（新增 5 项 R3 常驻回归）；Node **134/134**、固定 31 项 **31/31**、alpha.8 R1 8/8 与 R2 5/5、alpha.7 11/11+6/6、alpha.6 10/11+5/5 的既有结论不变。
- 未验证层：真实模型调用保持 0（受控替身/假核心分层标注）；日常安装/重启/原生窗口未做；R3 的确定性交错为受控时钟＋假核心验证，不据此声称真实学习库已被写坏或真实核心必然接受过期信用。候选与哈希见 `dist/0.9.0-alpha.9/DELIVERY.md`。

## 2026-10-01：0.9.0-alpha.8 alpha.7 复验收尾（R1 历史完整性、R2 前后台写入互斥）

Codex 独立复验 `dist/review-20261001-alpha7/REVIEW.md` 复现 2 项后，本轮按"只修根因"收尾：

- R1 历史完整性：`completeHistory` 原先只看 `eventIds.length < 8`，而短环根本不构成完整证据——升级时给旧行补出的短环、以及合法重开后新建的环都不含此前的历史。现改为**持久标记** `historyComplete`：只在建立行时写入 `true`，只在追加导致淘汰（第 9 个事件）或为原本没有环的行补环时永久写为 `false`；缺该标记的旧行/旧版本短环一律不完整。只有标记完整的行才能走"环外事件即新观察"，否则必须由已重新观察该行的宿主给出 `expectedVersion`+`expectedGeneration`。一次合法重开不再能追溯补全历史，`generation` 字段本身也不作为证明。
- R2 前后台写入互斥：F5 的许可门禁让取消结算留在暂停队列，恢复时零延迟后台 `complete` 与前台 `prepare` 并发争抢核心存储锁，前台 `lock_busy` 时静默跳过注入。现让后台 `_settle_payload` 与前台 hook 共用同一把可重入锁，后台以 2 秒**有界**超时获取，超时按可重试的 `lock_busy` 延后（保留冻结载荷与尝试预算）；前台另加 50/150ms 两次有界重试，仅针对瞬时忙，永久失败仍不注入。不删除排他锁、不用固定长 sleep、不吞错、不关闭重试。
- 验证：`scripts/verify-alpha8-fixes.mjs` R1 **8/8**（含用冻结 alpha.4/alpha.6 引擎重跑的两条真实跨版本链）、`scripts/verify-alpha8-fixes.py` R2 **5/5**；Codex 自己的 alpha.7 生命周期探针重跑 **17/17**（原 14/17）；Node **134/134**、Hermes **34/34**（各新增 R1/R2 常驻回归）；固定 31 项仍 **31/31**（`casesSHA256` 未变）；alpha.7 定向脚本 Node 11/11、Hermes 6/6 与 alpha.6 契约脚本 10/11 的既有结论不变。
- 未验证层：真实模型调用保持 0；日常安装/重启/原生窗口未做；R2 的确定性交错为受控假时钟＋假存储验证，受控慢 I/O 不等同自然稳定复现。候选与哈希见 `dist/0.9.0-alpha.8/DELIVERY.md`。

## 2026-10-01：0.9.0-alpha.7 alpha.6 收尾修复（F1–F5 五项根因）

Codex 独立复验 `dist/review-20261001-alpha6/REVIEW.md` 复现 5 项后，本轮按"只修根因、不新增能力"收尾：

- F1 原文偏移：起点/终点分别追踪，每一步只累计**左侧**删除量，句尾空白不再把起点右移（`不要把空值改成零 ，保留原始空值` 曾存成 `要把空值改成零 …` 并跨会话注入）；顺带修正"只有学习提示词、没有内容"的分句把后继逗号带进存储（`纠正一下，以后…` 曾存成 `，以后…`）。
- F2 币种同义要求：选择提示词改为按词判定（`以后` 里的"以"不再被当成选择语境），独立精度要求因此走普通纠错而不被槽位吞掉；同一币种的同义改写保留槽位归属并作为同义选择去重（不再清空 `topicKey/value` 退化成普通纠错）；替代停用该槽位**所有**旧值，`expectedSupersededVersion` 仍对主行校验。
- F3 重开契约（公开输入契约变化，已在 README 与 ADAPTER_PROTOCOL 标注）：事件环完整（`eventIds.length < 8`，从未淘汰）时，环外事件可证明为新观察；环写满后必须由已重新观察该行的宿主传 `newGeneration: true` + `expectedVersion` + `expectedGeneration`，事务内核对并进入事件指纹，旧输入返回 `new_observation_required`、过时条件返回 `stale_generation`；每行新增有界 `generation` 计数（旧行报告 0），不再接受"单个布尔值即证明新鲜"。历史 31 项无重开用例，期望文件未改。
- F4 DSH receipt 截止：`SettlementQueue` 构造器接收并保存 `deadlineForReceipt`（此前被丢弃，`enqueue` 只看到 `undefined`），转换回到实际 bridge→队列路径；真实 receipt 剩 100ms 时第二次 `complete` 不再发出。Hermes 的秒制换算与 5 分钟总年龄上限保留。
- F5 Hermes 停用绕过：队列在每次真正写入前重新读取最新许可（`permitted` 回调，无 hook 也会生效）；许可消失则暂停并保留原冻结载荷，恢复只重放未过期的同一条 `complete`，不重跑模型/工具/复盘，不改写为 cancelled。
- 验证：新增 `scripts/verify-alpha7-fixes.mjs`（11/11）与 `scripts/verify-alpha7-fixes.py`（6/6）；Codex 自己的 alpha.6 探针重跑为提取 **4/4**（原 1/4）、生命周期 **13/13**（原 10/13）、DSH 适配器 `ok:true`（D4 由 2 次调用降为 1 次）、Hermes 适配器 `ok:true`（`legacy_idle` 由 2 次降为 1 次）；上轮 31 项仍 31/31（`casesSHA256` 未变）；Node 131/131、Hermes 30/30；alpha.6 修复脚本 Node 11 项中 10 项通过、1 项为**已标注的兼容性变化**（重开用例需世代条件）；Hermes 侧 5/5 不变。
- 与 alpha.6 的已知差异仅此一项公开契约变化；`prepare`（用户当轮直接要求）仍按当轮新事实续期，环写满的行需宿主显式重开。
- 未验证层：真实供应商请求与长期收益、日常安装/重启/原生窗口、跨进程结算恢复（仍为进程内有界重试）、结算并发的全部交错；F5 为假时钟＋假存储受控验证。不可变候选、SHA256、兼容与回滚见 `dist/0.9.0-alpha.7/DELIVERY.md`。本轮未安装日常、未迁移真实库、未提交 Git。

## 2026-10-01：0.9.0-alpha.5 两阶段完善（纠错来源/格式适用 + 三个生命周期缺口）

依据 `dist/handoff-20261001-completion/PROMPT.md` 与 `ACCEPTANCE.md`，并保留已通过的 R2/R3/R5/R6/R7。

- **纠错来源**：分句保留标点后再判疑问；`仅这次` 与转述（引号、逗号、冒号变体）不再落库；混合语句只保存长期分句；不再因为出现引号就拒绝整条 —— 英文撇号、字符串字面量、反引号字段名照常保存；被讨论的引用内容（`从「以后」这个词…`）不触发标记。
- **格式适用**：JSON/JSONL/YAML/XML/TOML/CSV/TSV/Excel 各自独立，并且是**适用条件**：经验绑定格式时，另一格式的任务直接判 `format_mismatch`；转换/多格式任务按交集放行，通用规则不被过度限制。
- **明确替代**：新增结构化 `topicKey`/`value`（当前 `report.currency`）与自然语言识别；明确替代（纠正一下/改成…或显式 supersedes）在同一事务内停用旧规则，无依据时返回 `conflict_unresolved` 且旧规则继续生效；迟到结果不得给新版本加信用。
- **到期重学**：到期方法在**新的可信提案**下重开为候选（同 ID、version+1、validation 清空、expiresAt 续期、实验历史记 `reopened`）；事件重放仍是 duplicate（lesson 级 `eventIds` 账本，覆盖 90 天事件裁剪）；手动/回归撤回不自动复活；跨环境独立。
- **结算重试**：`src/settlement.mjs` 与 Hermes `SettlementQueue` 同语义：冻结唯一 payload，只重放 `complete`；64 条 / 4 次 / 5 分钟 / receipt 截止；永久错误立即终止；暂停、会话关闭、卸载分别停止；重复事件单飞。仅进程内，不宣称跨重启。
- 交付：新增 `scripts/pack-source.mjs`（生成并从原始条目验证源码归档，过滤并拒绝 Mac 元数据），`scripts/verify-package.mjs` 增加源码归档覆盖校验；`tests/upgrade.test.mjs` 只按真实账本文件名读取会话预算。
- 分层结果、SHA256 与剩余限制见 `dist/0.9.0-alpha.5/DELIVERY.md`；设计细节见 [召回说明](docs/RECALL_2026-09-30.md) 与 [生命周期说明](docs/LIFECYCLE_2026-10-01.md)。

## 2026-10-01：0.9.0-alpha.4 检修回归修复（R1—R7）

按独立检修报告 `dist/review-20261001-alpha3/REVIEW.md` 修复 7 项并补齐交付边界。alpha.3 冻结产物保留。

- **R1（P1）**：疑问句、仅限本次的要求、他人转述与引号内容不再成为长期纠错；分句保留标点，明确纠错与反引号字段引用保持。
- **R2（P1）**：会话关闭恢复取消排队/在途复盘，迟到结果不落库，且不影响其他会话（`closeSession` 的 ID 类型统一）。
- **R3**：DSH/Hermes/SDK 默认环境统一为核心默认 `default`，alpha.2 登记的 validated 方法升级后仍召回；显式换环境仍不召回，不放宽验证范围。
- **R4**：JSON/YAML/XML/TOML/CSV/Excel 各自独立成组，JSON 专属经验不会因归一注入 YAML 任务。
- **R5**：prepare 与 diagnose 共用“选择和字节核算”计划；只有实际装入非空上下文才报 `recalled`，匹配但放不下报 `budget_exhausted`。
- **R6**：`/mse` 从可信 `session.header.cwd` 取项目身份，新会话/重启恢复/缓存淘汰后首次查询即正确。
- **R7**：状态结算显示与核心一致的结果；学习库写入失败显示 `pending` + 错误码，不显示成功。
- 交付边界：schema 2 小版本升级与 schema 1 → 2 显式迁移分开表述并有真实旧库形状回归（`tests/fixtures/`）；`/mse now` 反映控制器暂停；内部判定以可信结构优先，文本信封标注为启发式兜底。
- 反例回归脚本：`scripts/verify-review-counters.mjs`（R1—R7 逐项，0 模型调用）。分层结果与 SHA256 见 `dist/0.9.0-alpha.4/DELIVERY.md`。
- 未修旧账继续登记：相反偏好并存、到期方法重学、结果写入失败重试（现显示为 pending）。日常安装仍由唯一安装负责人执行。

## 2026-09-30：0.9.0-alpha.3 召回可用性与可观测性修复

本轮按日常检修报告修复三个问题并保持 0.9 语义：正常含「MSE」的用户任务不再被内部任务过滤跳过；纠错句式与召回判定改为本地术语归一 + 主题强弱键 + CJK 二元佐证；每次 prepare 返回唯一原因码并提供插件内可见状态（`/mse`、`/mse why`、`/mse now`、`recallStatus`、`diagnose`）。环境身份在记录、复盘票据、评测与召回之间保持一致。

- 内部任务判定只用可信结构信号（子代理/非首步/非 user 来源/内部复盘信封/旧控制器暂停），不再匹配用户正文里的产品名。
- 召回不再依赖入库时的 `terms`：按 `instruction` 现场归一，旧经验同样适用，无需迁移；存储字段与校验未变。
- 未验证方法依旧不召回；768 字节/2 条、会话 1536 字节、同会话同版本只提供一次均未放宽；日常 3 条候选不会因本版变为可召回。
- 状态展示只读、不进入模型上下文、不占召回预算；它不是注入成功的证据，注入证据仍来自消息、最终请求与检查结果。
- 未包含 REVIEW 中的相反偏好冲突、到期重学与 DSH 结算重试，登记为后续范围。
- 设计、原因码表与门槛标定见 [召回与纠错说明](docs/RECALL_2026-09-30.md)；分层结果、包 SHA256 与限制见 `dist/0.9.0-alpha.3/DELIVERY.md`。日常安装仍由项目约定唯一负责人执行，本会话不写日常 profile。

## 2026-09-30：0.9.0-alpha.2 完整学习闭环

用户在 RRSI 研究后明确要求“完成度大一点、一步到位”，本轮已授权实现全套闭环。当前权威源码仍为本目录，既有改动已在 `dist/upgrade-20260930-baseline/` 保存源码与 SHA256。具体单写分工见 [实施记录](docs/UPGRADE_2026-09-30.md)，协议见 [Adapter 协议](docs/ADAPTER_PROTOCOL.md)。下方 alpha.3/alpha.2 均是历史。

- 新核心 schema 2：用户纠错即时召回，方法候选先评测；实验摘要、未知成本、反证、晋升、替代、撤回、前任回滚与可移植方法已实现。保留现有字节预算和宿主状态隔离。
- 三种登记算法覆盖日期、空值、精确数值升序排序，带纯检查/转换和 SDK 执行前检查入口。泛化方法使用可信宿主的成对评测；登记算法通过不能冒充真实模型效果。
- DSH 已修复 MSE-AUD-01/02：暂停取消排队/在途复盘，成功 llm/stream 内容匹配后采用，普通 error 不再惩罚经验。Hermes 对齐版本检查与代次失效；同步模型请求只能取消结算和丢弃迟到结果。
- SDK/CLI 新增诊断、评测、方法治理、导入导出与显式迁移。旧 tested 迁移为候选，原计数/会话预算保留，原主库字节另行备份。模型评测默认额度为 0，需独立配置；不改变模型或推理设置。
- alpha.1 的真实模型纠错召回通过，但当前 qwen3.7-plus / ultra 的复盘触发旧 15 秒超时；alpha.2 将复盘等待上限设为 60 秒，保留输出额度、模型/推理路由与取消结算保护。alpha.1 冻结包及证据保留。
- DSH 与 Hermes 包版本统一为 0.9.0-alpha.2；候选从隔离源码副本构建，保留旧包。本轮未写日常 profile、未重启宿主、未执行 Git 发布。日常安装仍由项目约定唯一负责人执行。
- 分层结果、产物路径与尚未验证的效果以 `dist/0.9.0-alpha.2/DELIVERY.md` 为准；该回执在最终打包与原生验收后写入，不把下面历史真实模型实验算作本版通过。

2026-09-29 追加 UI-REFINE：当前 DSH 包名统一为 `@missher/dsh-mse-learning`，配置和存储标识保留。此处为源码候选；本轮安装与验收以协调目录 `coordination/2026-09-29/ui-refinements/` 的回执为准，下面的版本与透明空格等描述保留为历史。

更新：2026-09-29。本文件仅描述 `learning-product/`；工作区分工以 PROJECT_GOVERNANCE.md（维护者本机历史记录，未随公开产品分发） 为准。当前执行 UPGRADE-20260929 中 MSE 独立导出的 DSH 兼容适配，不参与其他插件业务开发。

## 当前兼容性候选：0.8.0-alpha.3 / DSH 0.2.0-rc.1

- 唯一源码入口不变。基于父工作树 `5dc7842964a6fdf4113ad115d89be3a08c433027` 及前次 alpha.2 的既有未提交改动继续工作，保留旧包、旧文档和既有修改。
- 只读 SDK：`维护者本机历史路径（未随公开产品分发）`，HEAD `c7c457e5e07fa11a04bf8764d5f89585d789f258`。先验证真实 AgentLoop 中的用户消息、session/event、tools/result、复盘路由及卸载行为，再将 llm peer 精确改为 `0.2.0-rc.1`；不使用通配声明或版本豁免。
- 新增 `scripts/verify-dsh-agent.mjs`，只注册内存 fixture adapter，不调用真实供应商。它分别验证原适配业务代码及最终候选的行为，和安装准入验证分层报告。
- 学习核心与 DSH 适配业务代码无修改；Hermes 目录（包括 alpha.2 manifest）、配置和部署无修改。新增 `pack:dsh` / `--dsh-only` 只生成 DSH npm 候选和来源清单，避免随 DSH 升级产生未经授权的 Hermes 新版。
- 本轮候选输出：`dist/0.8.0-alpha.3/`。分层验收、包 SHA256 及剩余限制见 专属升级回执（维护者本机历史记录，未随公开产品分发）。安装由协调会话统一审核执行；本会话不写生产 profile、不重启应用、不提交/推送 Git。
- 已知 MSE-AUD-01/02 继续保留为历史待修问题，本次没有扩大为学习算法或后台控制器重构。字节预算、状态作用域和数据格式均保留。

## 2026-09-28 兼容性修复历史：0.8.0-alpha.2

- 基于下述 `5dc7842` 本地源码，版本升级为 `0.8.0-alpha.2`；DSH peer 从精确 `0.1.5-rc.2` 改为精确 `0.1.7-rc.2`，Hermes 包版本同步。没有扩大为未经验证的通配范围，也不添加版本豁免。
- 核心算法、宿主适配业务代码、数据格式及上下文预算不变；下面 MSE-AUD-01/02 两项已知问题仍待另行修复，不能把此次兼容修复说成已解决它们。
- `verify-dsh.mjs` 补充真实宿主兼容性门槛；新增 `verify-dsh-install.mjs`，用宿主实际包操作与 pnpm 在临时 profile 复现旧包拒绝、验证新包安装及 Bundle 组合。打包时关闭 macOS 附带元数据，重新生成候选来源与载荷清单。
- 新候选输出单独存放在 `dist/0.8.0-alpha.2/`；alpha.1 的归档及清单保留原样。对应分层结果记录在该目录 `VALIDATION.md`，它是此次安装候选的验收记录。
- 本次不改日常 profile，不重启应用，不迁移旧数据，不执行 Git 写操作；候选安装通过与生产已安装分开报告。

## 首轮审查基线与历史记录

- 唯一源码入口：`维护者本机历史路径（未随公开产品分发）`。
- 父工作树 HEAD：`5dc7842964a6fdf4113ad115d89be3a08c433027`；该提交中的产品目录 tree：`662e575cfbf3ddcdbe57f26c55575bb50d931e29`。审查开始时工作树干净。
- 产品版本仍为 `0.8.0-alpha.1`；npm 清单的 `private: true` 保留。这是独立的新学习路径，不能按版本号直接覆盖旧 MSE/Hermes 产品。
- 2026-09-28 Git 同步记录（维护者本机历史记录，未随公开产品分发） 记载：仅本目录导出到公开 `Missher12/mse-learning`，公开 main 为 `60aa2ddb04c6e559a21b17950ec59a5092b639bd`。这是协调记录，本轮没有联网重新核验远端。父仓库仍按私有范围处理。
- [VALIDATION.md](VALIDATION.md) 是 **2026-09-26 的历史实验记录**；其中“当前代码未提交”不代表本轮状态，历史真实模型实验也不算本轮实测。原文保留用于追溯。
- 工作区根 PROJECT_CONTEXT.md（维护者本机历史记录，未随公开产品分发）、HANDOVER.md（维护者本机历史记录，未随公开产品分发） 及父项目旧文档保留历史用途，不作为全工作区或本产品的最新总表。
- 本轮完整证据、限制和后续建议见 MSE 审查回执（维护者本机历史记录，未随公开产品分发）。新增文档未提交、未推送；旧授权不延续为新 Git 操作授权。

## 产品目标与归属

MSE 用一个与宿主无关的持久学习核心，加上 DSH/Cordis、Hermes 等宿主的薄适配器，保存用户纠错和方法候选，在相关任务中有限召回，并记录可信宿主提供的采用与检查结果。它改善的是经验复用过程，不训练模型权重，也不保证从此不再犯错。

| 事项 | 归属和边界 |
| --- | --- |
| 持久经验、版本替代、相关召回、采用收据、结果归因、受限复盘 | MSE 主责；SDK/CLI 供其他宿主接入，不等于所有 Agent 已原生支持 |
| 请求准入、压缩历史、当前会话只读上下文视图和累计用量 | context-manager 主责；MSE 不注册第二套压缩器 |
| 会话身份、实时跨会话投递、工作区操作 | session-bridge 主责；MSE 跨会话复用经验不发送消息 |
| 跨会话 token、费用、工具与技能用量统计 | usage-statistics 主责；MSE 的 adopted/verified/failed/inconclusive 是学习证据计数 |
| 图片附件、输入引用、模型能力设置、输出布局 | 对应工作区负责人；本轮四项新需求没有转入 MSE，也没有开始实现 |

保留的既有功能：MSE 的学习上下文预算和独立短复盘请求。它们分别限制新增经验内容、产生方法候选，不因名称涉及“上下文”或“总结”而迁入其他插件；也不把其他插件的实现复制进本包。

## 上下文成本与证据含义

- 默认每轮最多 **768 UTF-8 字节、2 条完整经验**，配置范围 128–1536 字节；同一会话累计最多 **1536 字节**，包括提示外框。同一经验版本仅提供一次，跨重启保存；不相关任务返回空文本。
- 上述预算只计 MSE 提供的新增文本，是字节上限，不是模型 token 实测或整个上下文窗口。账目在提供时保守预留；取消或主库提交失败不返还。
- 宿主压缩历史后，同会话不会自动补注已提供的经验版本。这是现有限制；不得通过清空预算账目或重复注入规避上限。
- 复盘独立于主会话：最多 3 次/24 小时、间隔至少 30 分钟、输出上限 384 tokens，输入摘要最多 800 + 1200 字符。它有额外模型调用成本，产物只成为候选。
- DSH 目前在经验消息写入会话的 `user/message` 事件上确认采用；这证明消息提交，**不证明远端模型收到该内容**。Hermes 则核对最终请求中的文本与请求 ID，并在成功的 `post_api_request` 后确认采用。二者不能混成同一层证据。
- `verified` 必须由可信宿主检查器报告，不能靠普通完成、模型自评或工具零退出自动获得。方法需在两个不同会话被采用并通过检查，且无失败记录，才能成为 `tested`；它仍不是因果效果证明。
- `host_verifier` 是可信宿主接口契约，不是加密认证。宿主必须守住接口调用权，不能把自授采用、验证或复盘结算直接暴露给模型工具。

实现入口：[核心预算与召回](src/index.mjs)、[结果归因](src/index.mjs)、[DSH 消息提交确认](adapters/harness.mjs)、[Hermes 请求确认](adapters/hermes/bridge.py)。

## 宿主、数据与旧控制器隔离

- DSH 状态根来自当前 profile 的 `dshHomePath('mse-learning')`，`adapterId=dsh`；Hermes 使用加载时捕获的 profile 下的 `mse-learning/`，`adapterId=hermes`。Hermes 后台复盘显式恢复该 profile 的上下文绑定。
- 核心校验宿主/实例归属；有权威 projectKey 时进一步按项目隔离。跨宿主复用实现不意味着共用一个状态目录。不得迁移、读取或覆盖旧 Hermes 学习库。
- DSH 检测 `missherEvolutionCore`，Hermes 检测 `missher-evolution` 时暂停新学习控制器。当前 DSH 的暂停存在下面登记的复盘队列缺口，不能笼统宣称所有后台活动都会立即停止。
- 日常配置、模型/推理设置、已安装插件和已有产物保持原状。后续会写文件的测试和构建继续使用隔离副本及临时 profile。

## 2026-09-28 审查结论与待办

本轮 **9 项 Node 针对性测试 + 4 项 Hermes 针对性测试通过**；冻结包的真实 Cordis、Hermes PluginManager 加载和生命周期检查通过，均使用临时数据及受控服务，真实模型调用为 0。这不是全量测试、生产 UI、完整工具任务或长期学习收益验收。

两个问题已用临时探针复现，尚未修改业务代码：

1. **MSE-AUD-01：DSH 暂停后，已排队复盘仍可启动并保存候选。**暂停只清理活动回合，没有使已排队或已开始的复盘失效。后续应在 MSE 适配器中增加控制器代次、请求取消及结算前检查；保留既有经验。
2. **MSE-AUD-02：尚未发出模型请求的准入失败，被归到经验失败。**DSH 先按消息提交确认采用，再把所有回合错误映射为 failed；上下文准入阻断可发生在 provider 调用之前。后续应区分消息提交、请求采用和实际检查结果；未发出的准入失败不得直接惩罚经验。不改动 context-manager 合理的准入保护，也不追改历史学习记录。

兼容性还有两项待核验：包的可选精确 peer 仍为 DSH `0.1.5-rc.2`，本轮使用 Cordis `4.0.4` / DSH `0.1.7-rc.2` 的直接 Loader 检查通过，但普通安装器的 peer 解析未验收；旧候选全源码清单与当前 `.gitignore` 有一处哈希差异，冻结安装包哈希及受检运行文件一致。完整清单检查未通过，不能用局部载荷一致代替。

后续最小顺序：修复 MSE-AUD-01 的暂停/结算竞态并覆盖回归；补齐 MSE-AUD-02 的宿主请求阶段证据；再隔离验收安装器和 peer 范围，重新生成新的候选包与清单。每一步单独报告；正式安装、真实模型和 Git 发布另按当时明确授权执行。

## 2026-10-03 alpha.15 精确停止与恢复收口（当前契约补充）

以上历史章节保持其写作时的身份与结论，不改写；以下是 alpha.15 落地后的**当前契约**补充。

- **身份映射是共享协议**：`sessionHash = sha256(UTF-8(sessionId))`（`identity()` 校验后原样返回，长度按 UTF-16
  单元计 512 上界，不归一化 Unicode）。DSH 按同一规则匹配宿主 ID，Hermes 依据它把 raw-id 停止精确映射到
  恢复出来的、没有 raw id 的条目。对照验证使用**真实核心写出的** `pending/history.sessionHash`（普通 ID、
  CJK+emoji、组合/分解重音），不猜 key。
- **停止按会话生效**：未确认的精确停止只阻断它自己命名的那个会话（raw id、核心公开 `sessionHash`、已确认
  条目 handle 三种寻址），不再退化为全局门禁，也不放行被停会话；用户暂停才是全局门禁。意图在任何可能等待
  的锁之前发布，条目被「hold」（取消调度、保留冻结载荷与原 `deadline`、保持可见），确认后按核心返回的
  hash 精确退休。
- **收敛不依赖新回合**：DSH 已确认的归档/删除若遇到真实锁忙，由本进程**有界调度**收敛——重试预算摊在整个
  30 秒窗口内（1/2/4/8/14 秒，最多 6 次提交），解锁后自动退休为 `stopped`，越界则保留可见的未确认状态并
  停止，不谎称成功、不刷新期限、不在只读路径触发。归档判定按公开 `sessionHash` 对照现有归档集合，不因
  记录缺少 raw id 而被撤销（`stopStillJustified`）。
- **运维提示**：回退到同 schema 的旧写者（alpha.13 及更早的 0.9.0）前，必须先 drain/retire 未落账的
  pending 行，或按升级前的新鲜完整备份配对回滚；旧写者不认识 `settlementOutbox`/`settlementControl`，
  会让这些行一直悬着。详见 README「数据升级与回退」。
