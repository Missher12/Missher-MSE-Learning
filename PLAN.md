# PLAN — MSE 自主经验改进闭环（本库执行计划）

基线 `7415dc489d9feac98c1fbb2d37eefdf2a3c9e945` / `0.9.0-alpha.18`。写入会话
`session-bcefaf60-c0ea-4ac6-a336-aa5059a25492`（continuation-12；阶段 4b rev3 两项恢复窄缺陷已修、
自测，独立定向 6/6 已通过）；前任 continuation-11（4b 实现）正常结束。
模型按用户指令为 `deepseek-official / deepseek-flash`（显示 DeepSeek-V41-Flash）/ `max`，覆盖旧 SRD 约束
（本库 `AGENTS.md` 已同步并保留历史）。Codex 独立验收，不自行安装/发布/启用付费评测。
证据索引：`.probes/stage4b/PROGRESS.md`（4b：第 8 节为 rev3 两项修复、新增用例、反例与原始日志）、
`.probes/stage4a/PROGRESS.md`（4a）、`.probes/stage3c/PROGRESS.md`（3c）、`.probes/stage3b/PROGRESS.md`（3b）。

## 阶段4c 自动评审/客观验证与恢复 — 🚧 核心+受限CLI rev2 有界 checkpoint（continuation-12；Node 517/0，C7 golden 9/9）

- 范围：让「自动评审（review）」与「客观验证（objective）」两轨成为**同一冻结身份**下的真实可执行合同，
  并把多步付费执行所需的**逐步材料与逐步许可**交到宿主手里；审计只读、Host/profile/额度/凭据未动、未安装发布。
- `src/index.mjs`：`sourceBinding` 显式门扩展到两轨（`reviewRequest`/`reviewResult`/`evaluationRequest`/
  自动 `evaluate`），在**同一写事务**内冻结/复核 plan、正式 pack、来源 revision/bindingHash/epoch/routeId、
  scope/environment、control generation、lesson version；新增 `ticketContinuation` 让**每一步**（arm/judge/case）
  在付费前重核原票许可（暂停/精确 stop/来源漂移/plan 重注册/registry 漂移/到期都会在**下一次物理调用前**拒绝）；
  新增 `reviewMaterial`（按票、含双臂与 judge system/schema 与真实 `limits`）、`reviewJudge`（Node 构造匿名
  A/B judge 请求 + 私有 labels，超 7 680B 明确 `judge_material_too_large`）、`objectiveMaterial`（有界 case 游标）；
  票上独立记 `reserved` / `usage{known,tokens}` / `terminal`，区分合法 known-0、已知部分+unknown、逐步/累计/重复 IPC；
  `autoPlanHash` 只在显式绑定下追加来源身份（旧 DSH 序列逐字节不变），`autoPlanRegister` 记录正式 case 引用，
  `autoPlanUpdate` 强制 `planHash`；活票计入 `liveTicketReferences`/`sourcePins`/`releaseHoldInState`。
- `src/cli.mjs`：新增 `reviewPlan/reviewMaterial/reviewJudge/reviewRequest/reviewResult/evaluationPlan/
  objectiveMaterial/objectiveResult/autoPlanRegister/autoPlanIdentity/autoPlanUpdate/autoPlans/autoCandidates/
  autoCandidateFacts`，每项有显式投影与「全绑定或拒绝」形状守卫；released `evaluate`/`evaluationRequest`/
  `evaluationCancel` 文档不变；`autoConsiderAdvance`/`recoverAutoPlans`/`maintainLearning` 暂未开放（留待实际消费时）。
- 业务测试 `tests/stage4c-dual-track.test.mjs` 16 例（真实 core、临时 store、0 provider）：双轨正控、请求事务拒绝零预留、
  pause/stop/源漂移/plan 竞争、objective 票不可冒充、过期/取消/重复 IPC 的费用与终态、旧 DSH 身份独立重算、
  released 旧文档、传输守卫、只读材料、逐步许可、cursor 遍历、known0/partial/重复。
- 回归：Node **36 文件 512/0**（`.probes/stage4c/logs/node-all-rev5.log`）；C7 旧 golden 用**冻结审计验证器**
  `verify` 模式 **9/9 pass、0 provider、exit 0**（`.probes/stage4c/logs/c7-legacy-verify-rev5.log`，输出只写 `.probes`）。
  三处 4b 之前 released 断言按 4c「原票重交返回旧终态/明确 consumed」升级（意图不变：不重派、不重扣）。
- rev2 合并全部已报审查项：**冷启动正式域/case 发现**（`autoPlanProposal` + material 发现形式 + 注册/身份从 pack
  解析 case）；**整份协议响应上界**（序列化 UTF-8 > 8192B → 小拒绝 `response_too_large`，不放宽 IPC）；
  **统一 plan 许可谓词**（终态 blocked/done/failed 在每步前拒绝）；**撤回 licence** 同样在每步前拒绝；
  **签票事务即消费尝试**（`plan.attempt`，丢 IPC/崩溃不重放，未签票等待仍可恢复）；**费用事实**（known usage
  抬高预算下界并驱动超额拒绝、`costKnown` 不能盖过持久 unknown）；**逐步 `ticketUsage`**（非终态、同一合并器、
  重复/倒序幂等，continuation 会看到已发生超额并拒绝再付费）。
- 明确未做：Hermes 多步 Python driver 接线、调度/timer/公平游标、`autoConsiderAdvance/recoverAutoPlans/
  maintainLearning` 开放、冷恢复重确认、4d/UI/打包/安装/发布；本 checkpoint **未经独立验收**，逐项映射与
  确切 API 见 `.probes/stage4c/PROGRESS.md`。

## 阶段4b 有来源绑定与持久最终门的单次反思驱动 — ✅ 实现并自测；rev2 两项恢复缺陷已修，rev3 定向独立 6/6（Node 496/0、Python 108/OK）

### rev3 恢复窄修复（continuation-12）

- `adapters/hermes/driver.py`：把“普通撤销”与“永久拒绝”拆开。新增 `cancel_in_flight()`（只撤销当前作业、
  置 `invalidated`、冻结旧结果），`begin_shutdown()` = `_withdraw(permanent=True)` 仅由真正 unload 调用；
  新增 `_retire(key, outcome)`，在**job Task 与 owner 侧 cleanup 都真正结束、slot 已释放之后**才移除
  注册引用，只保留 `status().registered` 与有界脱敏计数
  `finished.{jobs,committed,cancelled,closed,refused,other}`；drain 期间登记仍在，可取消可结算。
- `adapters/hermes/bridge.py`：`cancel_pending()` 改为普通撤销（不再永久 shutdown driver），`dispose()`
  在**同实例锁内**发布永久拒绝（`_reflect` 也在同锁下读 driver，卸载窗口未被放宽）；其余合同不变
  （cleanup 独立 shield 等主 job 结束、物理 slot 到 cleanup 结束才释放、取消先于 commit 不授 candidate、
  合法先 commit 保留、profile 跨 await 保持）。
- 新增业务用例 6 条（真实 core/SDK/driver，0 真实 provider）：`test_hermes_stage4b.py::JobRegistryTests`
  4 条与 `test_hermes_stage4b_lifecycle.py::PauseResumeRecoveryTests` 2 条；新增 `tests/node_clock.py`
  仅用透明 `NODE_OPTIONS --import` 时钟跨越 core 真实 30 分钟冷却（不改 spends/限额/最终门）。
- 反例：把 `adapters/hermes/{driver,bridge}.py` 换回 rev2 冻结字节（core 同一 `src` 软链）后，同 6 条
  用例 **5 失败 1 错误**，失败点正是两条真实缺陷；日志
  `.probes/stage4b/logs/py-negative-prefix-rev2.log`（树 `.probes/stage4b/negative-rev2/`）。
- 旧 `UnloadDrainTests` 断言按真实时序强化（不删断言、不改 runtime）：held cleanup gate 下确定性断言
  “未排空则 loop 必须保持、登记不得提前丢失”；快速 cleanup 分支必须自证 drain 已结束且 registry/tasks
  归零、票据终态与用量保留。实测证据 `.probes/stage4b/logs/unload-race-probe-01.log`（8 次：7/8 仍持有
  cleanup，1/8 已完成）。
- 回归：Hermes Python 四套件 **108 例 OK / exit0 / 无 skip**（53+22+21+12），日志
  `.probes/stage4b/logs/py-final-rev3.log`；Node/core 未改（`src/index.mjs` `03eb6810…`），不重复全量。
- 独立验收（协调者，非本会话自证）：`audit/hermes-review/runs/stage4b-rev3/DRIVER-REVIEW.md` 定向 6/6
  （FREEZE `48e61dc1…`，driver `62170d20…`、bridge `0f7c264e…`）；`audit/native-plan/hermes-stage4/
  STAGE4B-NATIVE-REV3-RESULT.md` 真实 PM/AIAgent 正控、前台取消、unload 排空 + 一次独立 OS 冷读通过。
  这两文件已冻结，本会话不再改动。
- 未做：4c（评审/客观验证/续审与 Hermes 侧恢复 pass）、UI、打包、安装、发布。

### rev2 已完成部分（保留）

- `src/sources.mjs`：有界持久来源身份账本；端点只存 `sha256("mse-endpoint-v1:"+canonical)` 指纹，
  userinfo/query/fragment 保守拒绝不裁剪，path 全保留；reasoning 四态；单调 revision + 永不复用 epoch；
  发布 CAS；容量不足保守拒绝，不驱逐活引用。
- `src/index.mjs`：`sourcePublish/Release/Status`；`reflectionRequest` 显式 `sourceBinding` 门在同一事务复核
  pause/精确 stop/generation/revision/epoch/scope/env/冻结路由；`reflectionResult` 提交前复读同一批事实，
  拒绝为终态且已消费；已登记方法第二事务同门保护但**仅对冻结绑定的票**（旧 DSH 合同不回退）；
  `problemRecoveryPlan` 改为**报告** `source.gateReady` 而非强制；持久 per-ticket 用量（保持按次数计、
  同票幂等、过期/撤销仍留已发生费用、unknown 不为 0）；终态与过期分离；stop 保留实时读活票/source 行/receipt/settlement。
- `src/cli.mjs`：新增 `problemDueFeed`/`problemConsiderAdvance`/`controlGeneration`/`recoverProblems`/
  `sourcePublish`/`sourceRelease`/`sourceStatus`，逐项显式投影；`reflectionRequest` 增加形状守卫。
- `adapters/hermes/driver.py`：唯一已证单次 driver（真实 AsyncOpenAI/chat_completions/max_retries=0）；`prove()`
  只认宿主真实事实且与 resolver 逐项一致；`prepare_source()` 在**原 factory profile** 内 prove+publish；
  raw usage 先于 parse 且只接受三字段齐全/非负/JS safe/总额一致；全部退出路径经同一收尾块关票；
  最后 await 后复核 cancel/`invalidated` 再提交；物理槽 peak=1 且只在 Task 真正结束（含已 await 的 close）后释放。
- 测试：`tests/stage4b-source-gate.test.mjs` 29 例、`tests/test_hermes_stage4b.py` 21 例、
  `tests/test_hermes_stage4b_lifecycle.py` 12 例；全部离线，0 真实 provider。
- 明确未做：4c 评审/客观验证/续审与 Hermes 侧恢复 pass、UI、打包、安装、发布。

## 阶段1 问题账本与宿主接线 — ✅ 完成（31/31；rev6 15/15 独立放行）
- src/problems.mjs 账本；observeProblem/problemStatus；harness 无摘要失败发现与 ready 绑定；
  DSH agent/error 仅诊断；取消/供应商/权限不变方法失败；in-flight 不取消已付费结果；同 scope/env 绑定。
- 最后修复：problems-harness rev4 fixture（withReflect 真实驱动反思；状态断言与 rev6 对齐）。

## 阶段2 有界公平调度 — ✅ 实现完成，待 Codex rev3 最终放行
验收：`../mse-autonomous-upgrade/audit/matrix/phase2-baseline/PREPARED.md`（5 缺陷+3 正对照）、
`phase2-rev1/REVIEW.md`（P1 三类根因）、`phase2-rev2/REVIEW.md` + `covered-tail-*`（covered 无持久轮转）。
步骤：
- [x] 1. `src/index.mjs` `autoCandidates()` 公平 feed：未注册 open 最老优先 → live → 终态 last，有界 ≤limit（rev1 A）。
- [x] 2. `src/index.mjs` `autoCandidateFacts({lessonId})`：推进所需事实独立完整索引，feed 截断不误报 missing_criteria（rev1 B）。
- [x] 3. `src/index.mjs` `autoPlanIdentity()` 只读全 binding, + `adapters/dsh/auto.mjs` enqueue 按完整 planHash 裁决重登记，
      route/suite/criteria 变化走 core 替换，同 binding settled 不重付（rev1 C/D）。
- [x] 4. `adapters/dsh/auto.mjs` enqueue `registerTrack` 每轨注册前查 8 上限（rev1 E）；scan `lessonOf` 回退 facts。
- [x] 5. `tests/auto-fairness.test.mjs`：8 基线轨迹 + rev1 6 边界 + settled 不重付 = 15/15（旧断言保持不变）。
- [x] 6. **rev2 covered 持久轮转**（continuation-05 完成）：`state.autoConsider.cursor`（有界、持久、读取不写盘）+
      `autoCandidates` 旋转注册窗口 + `autoConsiderAdvance` 只由真实 `scan()` 调用（同 clock 也推进、重启稳定）；
      追加 6 条 rev2 回归 → auto-fairness **21/21**、auto 相关回归 **72/72**。
- 待办：Codex rev3 独立复验（原 14 轨迹全过、covered-tail route 已过、suite 有界全覆盖核验中）后阶段2 放行。
- 回归口径：只跑真实存在的 auto 相关文件；`node --test tests/` 目录形式无效，不作全量通过依据。

## 阶段3a 撤回许可 + 领域准入/冻结身份 — ✅ 本会话（continuation-06）完成并自测
- [x] 1. `withdrawTrial` 同事务递增 `lesson.reviewRevoked`；`reviewRequest` 冻结、`reviewResult` 事务内比对，
      不一致即拒绝并消费 ticket（重启同样拒绝；不提全局 control generation、不靠 AbortSignal、不退款）。
- [x] 2. review 与 objective 共用注册谓词与正式身份：`packId` 必须注册、显式 `packVersion` 必须等于注册版本、
      场景/准则由 `resolvePackScenario` 从注册表推导（新增逐案例 `packCaseCriteriaHash`）、
      `queueKey` 无 pack ⇒ `domain_pack_required`；提交端改写身份与注册表漂移都在提交时再次拒绝。
- [x] 3. trial 携带 `packId/packVersion/epoch`；召回走 `domainAdmission`（域内才召回；旧无域 trial 保守不召回）。
- [x] 4. adapter 预约前 `reviewAdmission`（零计划/零票/零调用，记 `review_out_of_domain:<reason>`），
      `auto.mjs` 透传 `packId/caseId`；`events` 只读暴露最近 8 条原因供操作者/审查查看。
- [x] 5. 测试：`tests/stage3-closure.test.mjs` 17/17、`tests/stage3-chain.test.mjs` 4/4（真实 adapter→scheduler→core→
      harness 召回），受影响回归全部 exit=0；日志与哈希见 `.probes/stage3a/`。
- 待办：Codex 冻结 rev3 后按 STAGE3-ACCEPTANCE 表选必要用例；不再重复跑已过的无关检查。

## 阶段3b Host 兼容修复（V4 消息来源）— ✅ 本会话（continuation-07）完成并自测
- [x] 1. 写入端三处统一 `mseMessageSource(form)` → `{kind:'plugin:mse-learning', form:...}`：
       `adapters/dsh/index.mjs`（recall + reflection）、`adapters/dsh/control.mjs`（readModel，保留 pluginForm）；
       旧 `{kind:'plugin',plugin:'mse-learning'}` wrapper 不再产生（V4 持久化会拒绝它）。
- [x] 2. `adapters/harness.mjs` 新增 `MSE_PRODUCER_KIND/mseMessageSource/isMseSource`；accept 只认精确 producer
       身份或旧 wrapper 指本插件，仍要求相同 message id/context/receipt；用户与其他 producer 不计数。
- [x] 3. internal-review 守卫对新 producer 身份、旧 wrapper 与任意 `plugin:*` envelope 生效；普通任务不受影响。
- [x] 4. 测试 `tests/source-identity.test.mjs` 4/4（写入身份、真实采用、迁移识别、internal 不过度学习），
       既有 harness/status/upgrade/settlement/control-plane/stage3-chain fixtures 迁移到新形状。
- [x] 5. 会话事实缓存：`adapters/dsh/index.mjs` 新增 sighting 表 + `factsProveGone`（可证伪缺席）+ 共享 in-flight
       拉取 + 生命周期刷新（pre-step / 新会话 turn-start / guard 拒绝与 settlement recovery）；`stage3-chain` 7/7。
- 未宣称：真实 Host flush/冷启动端到端通过（Codex runner 独立验证）。

## 阶段3b/3c/3d 到期维护/纠错归因/问题 pump
- 3b：trial 14 天到期只影响召回，缺"恰好一次"的续审身份与消费水位 — ✅ 本会话（continuation-07）完成并自测：
  [x] 1. `maintainLearning()`：自然到期恰好一次 version+1、终止旧许可并吊销 review 许可、有界轮转（≤8/趟、共用 cursor）、
       无工作零写入；重启/重复维护不重升版本。
  [x] 2. 证据水位用单调 revision/计数（adopted、problem evidenceRevision 映射 ≤8、冻结 verifier 身份 hash），
       不用墙钟；未见身份保守采纳为基线；无水位旧记录先采纳基线不猜来源。
  [x] 3. 三处门禁（reviewPlan/reviewRequest/autoPlanRegister）保证无授权续审零预约零调用；objective 轨道独立不受门禁。
  [x] 4. 失败续审消费证据；真实新证据开有界新尝试身份（attempt 参与 planHash ≤3 次），同水位永不重放；
       manual/user_correction/regression 撤回永不复活；成功仍走 TTL 与原流程。
  [x] 5. adapter 把维护挂在真实后台扫描入口（受 dispose/暂停/前台门禁），并丢弃本趟刚退休版本的旧 feed 行。
  [x] 6. 回归：`tests/stage3-renewal.test.mjs` 29/29（含同毫秒、时钟回退、失败后新 revision、容量收敛 9→8 零写、
       `tokens=0` 不签票不消费 + 恢复后恰好一轮、跨进程 registry version/同版本 criteriaHash 漂移）；
       显式列文件全跑 **29 文件 393 例 exit=0**（日志 `.probes/stage3b/logs/`）。
  [x] 7. **会话事实缓存生命周期**（native 第二阻断，最小修 `adapters/dsh/index.mjs`）：判缺席用**进程内单调序号**
       （不用墙钟）；在途拉取竞态下旧结果永不判新会话删除，共享仅在"拉取开始后无新证据"时成立，否则链式补一次真实拉取
       （≤1 在途 + 1 排队）；sighting 有界（含目录列出的会话，重启后仍可判真实删除）；只在生命周期入口刷新；
       归档/真实删除/查询失败仍拒绝；真实插件链 3 例覆盖新会话结算、目录故障恢复与在途竞态正例+删除控制。
- 3c：**✅ 本会话（continuation-08）完成，独立 rev2 通过（完整 27/27 + 边界 12/12）**：
  [x] 1. 新增 `src/adoptions.mjs`（纯逻辑）：有界持久索引 `state.recentAdoptions`，契约
       `{format:1, maxSessions:64, lessonsPerSession:2, ttlMs:604800000}`。**TTL 有意 7 天**（短于 14 天
       试用许可，使"采用窗口过期"与"许可过期"可区分、互不遮蔽；仍在设计 30 天上限内）。每条记录 =
       一次 accept 的快照 `sessionHash/scope/environment/turnHash/at` + 该次 receipt 实际 selected 的
       `{id, version, tier}`；`tier ∈ {'verified','trial'}` 直接取自 receipt 冻结值（保持召回层级词汇，
       不翻译成 `validated`，避免把未验证用户规则伪造成已验证事实）。容量/TTL 只在真实写事务清理；
       `recentAdoptions()` 只读、读不写盘；旧文档读取不初始化字段。
  [x] 2. `accept()` 同事务记录（settlement 删 receipt，必须在此落盘）；仅真实 accept 写入；
       同 turn 重复 accept 由 core 先返回 duplicate，不重写时间；新采用整体替换旧记录（单回合快照）。
  [x] 3. `prepare()` 同事务：`observeInState` 写 `user_correction` 观察 + 归因判定 + 必要时私有
       `withdrawTrialInState` 撤回（同一事务，无"事件已记但撤回失败"半状态）。
  [x] 4. offer→accept 之间许可被撤回 ⇒ `accept` 以 **`receipt_stale`** 明确拒绝；
       `selected[].licensed` 冻结"此行是否为临时许可"，tier 取自 offered 值而非 live 状态。
  [x] 5. 归因规则（窄、可解释）：同 session/scope/env + 非采用回合 + 用户本人话语（转述/引用/工具/内部
       一律不进入观察与学习）+ **引用之外**的拒绝线索且该子句**指回**被引用方法 + 分句作用域
       （`另外/不过` 转题截断回溯；`改用/换成` 视为选择而非拒绝）+ 唯一当前版本且许可仍活；歧义或无指向
       ⇒ `pending` 待审。**引用内部的命令/否定不能当作用户拒绝**（真实反例修复）。
  [x] 6. 新增 `tests/stage3c-adoption.test.mjs` **46/46**（正例、同 turn 幂等、未 accept/取消、别
       session/scope/env、含糊/引用/转述/工具/内部/新偏好、二义性、旧版本、独立进程重建、容量淘汰、
       7 天 TTL 前后同活 trial、自然到期不改写为 user_correction、offer/accept 之间撤回、reminder tier）。
  [x] 7. 回归口径（据实际日志）：**31 个套件逐文件 exit=0** = 30 个 `tests/*.test.mjs`（`node --test`，
       **439 例** = 原 393 + stage3c 46，root 逐 TAP 解析
       `../mse-autonomous-upgrade/audit/phase3c-native-tap-summary.json`）
       + `tests/test_hermes.py`（`python3 -m unittest`，**53 例**）；日志 `.probes/stage3c/logs/reg-*.log`；
       独立边界探针 12/12（`.probes/stage3c/logs/boundary-selfcheck.log`）。
  [x] 8. Codex 独立 rev2：完整 27/27、边界 12/12、真实薄 Host 全链（14 服务、5 合成前台 stream、
       327 bytes recall、accept/complete 后 receipt 删除、转述不观察/学习、明确纠错撤回、public flush +
       第二独立进程冷读）；报告 `audit/native-plan/STAGE3C-REV2-RESULT.md`。真实供应商调用 0。
  - 未做/未宣称：通用自然语言因果推断、3d、Hermes、UI；未安装/发布/push/改日常配置与预算。
    3a/3b 已验收文件哈希未变。
- 3d：**✅ 本会话（continuation-09）实现并自测**（独立统一快照复验进行中）：
  [x] 1. `src/problems.mjs`：问题行有界来源绑定 `origin`（session/turnHash/route/at，旧文档兼容）；
      `problemRecoverable`/`problemRecoveryRefusal` 统一 revision 消费语义（签票即消费，绝不重放；
      只有真实新独立证据 +1 才开新机会）；`reflectionReady` 由二者组合；`parkProblemInState` 正向等待；
      有界旋转 due feed（`problemFeedView` + `dueTotal`）与持久水位校验。
  [x] 2. `src/index.mjs`：`reflectionGate.releaseAt`（冷却是 30 分钟，真释放是 24h 窗口第 (n-3) 笔 +DAY）；
      `observeProblem` 接受有界 route；只读 `problemDueFeed` / `problemRecoveryPlan`（含 in-flight 读取）；
      写入口 `problemConsiderAdvance` / `problemDefer`；`recoverProblems` 释放死进程遗留尝试（不退款不重放）；
      `status()` 增 recoverable/due 计数（保持纯读）。
  [x] 3. `adapters/harness.mjs`：可信 turn route 随 host observation 落盘（恢复用原 route 的唯一来源）。
  [x] 4. `adapters/dsh/index.mjs`：即时/恢复复盘共用 `createSourceCheck` + `runReflectionInSlot`（真实 JobQueue
      单槽）+ dispatch/最终同步 commit 门禁；`problemPass` 与自动队列共用唯一 timer 与串行门（只服从
      reflectionEnabled）；`confirmedAbsence` 有界合流确认目录事实；显式迭代器 + abort-before-drain；
      `consumed` 反映真实签票；`automation.start` 后置修 startup TDZ；`schedule/cancelTimer` 生产注入缝。
  [x] 5. `adapters/dsh/auto.mjs`：`dueWork` 选项 + 可注入 timer。
  [x] 6. 新增回归 23 例（`tests/stage3d-pump|recovery|slot.test.mjs`）与 `tests/pump-host.mjs` 受控 Host 夹具；
      全量 33 个 Node 文件逐文件 exit=0；日志 `.probes/stage3d/logs/`（SUMMARY-full3d-rev2.txt）。
  - 未做/未宣称：Hermes/UI 未扩；未安装/发布/push/改日常配置；3d 独立验收未完成（reviewer 统一快照复验中）。
    隔离验收 0 真实供应商调用（与开发会话自身调用分开表述）。
  - 下一步：停止改动 → 统一冻结候选哈希 → reviewer 复验；按具体失败点修，不为润色改动冻结产品。

## 阶段4 宿主接线与可见性 — 4a 已实现并自测，4b/4c/4d 未开始
- 4a（Hermes 无 receipt 可信失败发现、无摘要学习与真实采用）本会话完成：见下节。共享核心状态规则未变；
  DSH/Hermes 各自真实 session/route/权限/取消/费用；Hermes 无完整自动验证驱动，如实单列 `capability_waiting`。
- UI 沿用自我进化风格展示发现/关联/等待原因；默认 768B/轮、1536B/会话、max2 保持；问题日志不注入提示词。

### 阶段4a — ✅ 实现并自测（continuation-10，待 Codex 独立验收）
接口映射以 `../mse-autonomous-upgrade/audit/hermes-review/STAGE4-CORE-INTERFACES.md` 与
`STAGE4A-MINIMUM-HANDOFF.md` 为合同，实际签名以 `src/index.mjs` 为准。
- [x] 1. `adapters/hermes/bridge.py` 原生 `post_tool_call` 归一：稳定 `tool_call_id`、受限
      `status`/`error_type` 分类、无 id 时 `degraded:<turn>:<tool>:<class>` 单槽（不造 UUID）、有界 roster(16)、
      **args/result/error_message 不读不存**；可用性四类不进 roster。
- [x] 2. `post_llm_call` 解耦：宿主事实 → **问题持久化** → settlement → 独立反思；空库无 receipt 不再被
      `settlement_no_receipt` 挡住整轮，不伪造 receipt；有 receipt 仍走原 durable settlement。
- [x] 3. 失败驱动反思**只能绑定成熟问题**：签票前调用 core `problemRecoveryPlan` 复核 owner/scope/env/
      `origin` route，返回 `source_unbound`/`source_route_unbound`/`scope_mismatch`/`environment_mismatch`/
      `recovery_summary_unsafe` 时用 `problemDefer` 正向停放，0 票 0 reviewer 0 消耗；单失败+摘要/重放/取消
      0 候选；候选与 problem 链接由 core 原子写入。
- [x] 4. `src/cli.mjs` 最小可信入口：新增 `observeProblem/problemStatus/recentAdoptions/reflectionPlan/
      problemRecoveryPlan/problemDefer`（仅新增入口显式投影，其余已发布操作**原样透传**）；`reflectionRequest`
      的问题绑定严格化（出现任一字段即必须成对合规，否则 `invalid_problem_binding`）；65KiB/未知 op 拒绝不变。
- [x] 5. 来源路线：读真实 `request.body.reasoning_effort`（只取该标量）；边界与 core `routeValid` 一致
      （32/64/16）；超界/空/控制字符不截断而**清空并使同 turn 旧记录失效**；未绑定则 `source_route_unbound` 等待。
- [x] 6. 真实采用保持：`pre_api_request` 零 receipt 也捕获来源，采用仍要求最终 request 含本次 context 且同
      `api_request_id` 成功；裁剪/失败/别 id/重复成功四反例一正例；正常结束 `verified=0`。
- [x] 7. 生产注册 `register()` 不注入旧 `call_llm` wrapper → `capability_waiting`、0 票；
      `profile_bound_review` factory 捕获 home、worker set+finally reset（真实 ContextVar 语义）。
- [x] 8. 回归（逐文件真实 exit）：Node **34 文件 / 467 例 / 0 失败文件**（新增 `tests/cli-contract.test.mjs` 5 例）、
      `test_hermes.py` **53 例 OK**、`test_hermes_stage4a.py` **22 例 OK**；日志与哈希见 `.probes/stage4a/`
      （`PROGRESS.md`、`logs/SUMMARY-node4a.txt`、`HASHES.txt`）。
- 未做/未宣称：真实 provider driver（4b）、完整 route 身份（endpoint/api_mode/推理三态）、Node 侧最终许可门、
  恢复 pass（`problemDueFeed`/`problemConsiderAdvance`/`recoverProblems`/`controlGeneration` 刻意未开放）、
  UI/打包/安装；4a 局部通过不等于全闭环 READY；本轮真实供应商调用 0。
- 下一步：交 Codex 独立验收 4a；通过后同模型连续接 4b（普通 AsyncOpenAI 单 attempt + raw usage + Task
  drain + 完整 route + Node 最终门 + 已证实 driver 注册）。

## 阶段5 验收冻结 — 未开始
- 相关测试 + Node/Hermes 全量 + 包检查 + 冻结明确候选；写 READY（源码/离线/包/Host/UI/真实模型/安装发布分层）。
- Host 双进程 runner 由 Codex 准备并运行；不改版本掩盖 DSH/Hermes 包规则不一致。

## 全程纪律
- 先失败用例再修复；模型自报/exit0/正常结束不算 verified；测试用隔离临时目录与替身模型。
- 阶段完成即更新 HANDOVER；临近上下文限制先落盘 HANDOVER 再保留现场；不提高预算/关 Context/自行换模型继续。
  模型变更仅由用户直接指令触发（本轮即如此：SRD → deepseek-official/deepseek-flash），并在 HANDOVER 如实记录；
  单写权、只读边界与 Codex 验收分工不变。