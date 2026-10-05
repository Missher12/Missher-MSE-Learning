# MSE Learning 行为与数据契约

本文保留 alpha.15 的已验收行为；DSH alpha.16 仅调整发布包装，业务源码未改。安装、平台范围与当前发布入口见 [中文说明](../README.md) / [English](../README.en.md)。

## 已实现行为

- **alpha.14 起，同一任务只算一个评测样本。** 协议由 `prompt` **字段是否存在**决定，不由它的值决定：只要任意行带该字段，全部行都必须通过同一套严格原始校验（字符串、原长度 ≤400、可打印字符、有效 Unicode、非权威改写），先校验再用 `caseTaskKey`（只取规范化 prompt：NFKC、零宽字符、空白折叠；不改大小写与标点语义）判任务独立；`normalizeCases` 与**共享 core** 的 `evaluationRequest` 都在任何 ticket、扣费或 runner 调用之前拒绝，`prompt: ''`/`null`/数字/自有 `undefined` 一律不能退回 legacy 路径。只有**没有任何一行带该字段**才是旧的 trusted-runner 协议，其独立性仍由可信宿主保证，不由分数证明。完整内容身份仍绑定计划哈希用于冻结与防篡改。
- **经验自带的适用/排除条件参与召回准入，且排除优先。** 只处理三种写法：①**格式包装模板整体匹配**（`仅适用于 <格式表> 格式的报表导出`、`仅/只 <格式表> 导出`、`<格式表> 导出场景`、`不适用于 <格式表> …`、`<格式表> 除外` 等有限模板，`<格式表>` 是完整的「或」列表）；②登记方法标识对应的**规范条件对**（与注册表逐字符比对，任意 snake_case 不被当作登记）；③整句匹配的通用措辞（适用与排除两个字段各有各自的白名单，极性由字段决定，不混用）。模板必须**整句匹配**，因此 `仅当 CSV 报表包含字段时。`、`仅在 CSV 报表必须备份时。`、`仅适用于管理员批准的 CSV 报表。`、`仅适用于税率为19%的 CSV 报表。` 都不会因为出现格式词而被放行 → `condition_unclear`，**保守不召回**。格式身份取**已匹配的完整原子**，不做子串识别：`JSONL`/`NDJSON` 各自成组，不等于 `JSON`；`XLSX`/`XLS`/`Excel` 仍按既有策划组同属 `excel`（本轮只改识别方式，不改动既有同义分组）。一个格式在同一句里被同时肯定与否定时按无法判定处理（unclear，保守不召回）；纯否定不算肯定。因此 `仅适用于管理员批准的 CSV 报表。`、`仅当金额为正时的 CSV 报表。`、`仅适用于税率为19%的 CSV 报表。` 都不会因为“出现了格式词”而被放行。否定按子句判定，且**同一格式的每一次出现都参与极性**（`不用 CSV，改成 JSON` 不是 CSV 任务；`导出 CSV…，不使用 JSON` 不会被 JSON 排除）。**明确的能力边界：不支持理解任意中文场景条件**（如“仅适用于月度财务结算报表”），这类条件按 unclear 保守拒绝，不做子串近似。`/mse` 与设置页会解释被排除、不适用或无法判定。每轮 ≤768 字节/2 条、每会话 ≤1536 字节不变，被条件拒绝时零注入、零扣费。
- **满库时明确用户纠错仍可落库。** 300 行硬上限不变；仅当同作用域内存在**未验证方法候选**时才按确定性顺序（未采用 → 结论最少 → 最早 → id）置换一条，且已验证方法、用户纠错、开放回归窗口的反证、receipt `selected[]`/`accepted[]`、在途 job、experiment 与 `replacedBy`/`replaces` 回滚链全部受保护。**不删除其他项目/作用域的经验**；同作用域全部受保护时返回明确 `capacity` 而不是伪装成功。置换写最小的审计记录（id、版本、原因、作用域、被谁置换），不复制经验正文。
- **alpha.15：结算的持久 complete 闭环。** 首个事务提交才算 durable acknowledged；ack 与只读 status 都返回不可变的 `key`+`payloadHash`+控制代次执行句柄，重启后无需读库即可续办。恢复**只重放原 `complete`**，不重跑模型/工具/复盘/付费评测/prepare/accept；完成与 outbox 退休在同一次原子提交里，因此不存在「已授信但仍 pending」或反之。终态行优先幂等回读——已提交但丢响应的结算即使后来被暂停、停止或跨过期限，也返回原结果。`apply` 必带控制代次：先提交的暂停/精确 stop 使其失效，而先拿到主库锁的短 apply 可以合法完成（请求到达 ≠ 成功确认）。持久项的回放消费**冻结的原收据与接受事实**，收据被换掉即 `settlement_receipt_changed` 终态冲突，不会改用新收据授信。上限：pending ≤64、终态 ≤32、单项 ≤4 KiB、总 ≤256 KiB，另受原 2 MiB 库上限；旧 schema2 缺字段视为空且只读不写，未知/损坏格式拒绝而非清空。**已知限制**：持锁进程崩溃会受既有 5 分钟死 PID grace 阻挡，只能明确记 `expired`，不偷延期限也不删活 PID 锁；`lock_busy` 发生在拿锁前，故「持久处理尝试」（≤4）与锁争用调用次数是两件事。设计说明见 [docs/DURABLE_SETTLEMENT_OUTBOX.md](DURABLE_SETTLEMENT_OUTBOX.md)（已实现）。只读状态/设置读取只投影事实，不写库、不调度、不恢复；恢复只由真实设置保存、服务就绪或明确 turn/resume 生命周期驱动。
- 用户明确的未来纠错即时保存；直接用户来源由宿主确认。普通聊天、工具输出和模型自评不能伪造用户指令或验证等级。捕获句式见 [召回与纠错说明](RECALL_2026-09-30.md)；正常讨论或开发 MSE 的任务不会被当成内部调用跳过。
- 召回使用本地术语归一、主题强弱键与 CJK 二元佐证，不调用模型、不建索引；每次 prepare 返回唯一原因码（已召回/未学到/作用域不符/匹配不足/方法未验证/已提供过/预算不足/内部任务跳过/存储失败等），供用户判断是否真的生效。只有真正选中非空经验才报告 `recalled`；匹配成功但放不下报 `budget_exhausted`。同类技术格式（JSON/YAML/XML/TOML/CSV/Excel）各成一体，不做同义归一。
- 只有用户自己的持续性要求才会落库：疑问句、他人转述与引号内容都不保存；混合语句只保留长期分句（详见 [召回说明](RECALL_2026-09-30.md)）。**一次性限定语跨分句生效**（`仅这次，把报表金额统一为人民币` 不落库），只有明确的新长期标记才重新开始长期收集；存储直接取用户原文切片，起止偏移分别按"只从左侧删除的字符数"累计（句尾空白不再挪动起点，`不要把…` 不会被截成肯定句），只有学习提示词自身、没有内容的分句不再把后面的逗号带进存储；引号与反引号里的英文逗号、空白与 JSON 字面量逐字节保留。
- 明确替代的偏好只保留当前值：同一作用域的金额币种被明确纠正后，旧规则停用且不再共注入；切回曾经用过的值时把它重开为新世代（版本升级，旧证据不给新世代记信用）。币种必须出现在选择语境才占用槽位（提示词按词判定，`以后…` 不再因为一个"以"字被当成选择），`人民币金额保留两位小数` 这类独立要求按普通纠错单独保存；**同一币种的同义改写仍归该槽位**（仅作为同义选择去重，不再退化成普通纠错），因此后续替代会停用该槽位**所有**旧值，不以原文字面相同为前提。所有显式替代都校验 `expectedSupersededVersion`，过时调用返回 `stale_replacement` 且不改变库。无明确替代依据时返回 `conflict_unresolved` 并保持旧规则。
- 方法到期后可由新的可信提案重开为新世代候选，旧验证只作历史；重学不改变已有会话预算，手动/回归撤回不会被到期自动复活。每行永久记住开启本世代的事件并保留有界事件环，重放不会重开；**到期重开需要可核验的世代证据**：行是否"历史完整"是**持久标记**，只在确定性建立该行时写入，并只在追加事件导致淘汰、或为原本没有事件环的行补环时永久失效（写满但从未淘汰仍算完整）。只有标记为完整的行，环外事件才能证明为新观察；否则旧事件与"看似新"的事件无法区分，必须由已重新观察该行的宿主给出 `expectedVersion` 与 `expectedGeneration`（事务内核对并进入事件指纹，旧输入与过时条件分别返回 `new_observation_required`、`stale_generation`）。升级前的旧行、旧版本写入的短环、以及任何缺该标记的行一律保守处理，合法重开也不会追溯补全历史；旧库报告 `generation 0`，同样不接受单独的布尔断言。已完成的历史替代不再阻断新世代评测。
- 结算写入分**两层**，两层合起来才是完整语义。**内存调度层**（`src/settlement.mjs` 与 Hermes `SettlementQueue` 同语义）：只重放冻结的 `complete`，不重跑模型/工具/复盘/付费评测/prepare/accept；活动条目 ≤64、退避 250ms/1s/3s、年龄上限 5 分钟、永久错误立即终止；结果事件带 session/turn 标识，迟到结果只写自己的回合；`on_session_reset` 与 legacy 冲突停用都会真正停止/暂停队列（每回合正常结束不算关闭）；终态退出活动容量（有界历史保留）；receipt 的 epoch 毫秒截止时间在单一边界换算到各自的队列时钟。**持久层**（alpha.15 起，见上一条与 [持久结算契约](DURABLE_SETTLEMENT_OUTBOX.md)）：拿到 ack 之后条目的终态属于核心，内存队列的「结束」不再等于记录消失——暂停/卸载/正常退出只停止本进程的调度，pending 行与原 `deadline` 原样保留，只有核心在自己的事务里写下的 `expired`/`stopped`/`failed`/`conflict` 才是终态，客户端只转述。两条路径的到期因此不同：**未 ack**（核心从未接管）由适配器本地收敛，达到次数或期限即本地 `exhausted`/`expired`，**绝不晚写**；**已 ack** 的条目不会到期后再授信，但允许**一次**核心退休尝试——最后一次自动尝试排在原 `deadline` 上，交给核心按自己的时钟决定，期限从不延长；该尝试若因真实锁忙/运行时不可用仍拿不到核心确认，就诚实标记为可见的 `unconfirmed` 并**不再排后继定时器**，由下一个合法生命周期或重启重读核心（只读状态永不触发补写）。显式恢复同样只重放未过期的同一条 `complete`，不重新调用模型/工具/复盘，也不把已冻结结果改写成 cancelled；**后台结算与前台召回共用同一个写入边界**（后台有界等待，前台永不因后台丢注入），恢复回合的召回不会因为旧取消结算同时落库而被静默跳过；**最终有效性检查与实际写入在同一串行化边界内**——取得边界后重新核验最新宿主许可、Hooks/queue 生命周期、条目身份与存续、收据期限：许可被撤回或会话被暂停/关闭的等待者保留原冻结载荷而不写出，卸载只停本进程（pending 行保留给下一个进程按新鲜真值决定）；前台退避等待同样在每次重试前重读该边界。
- 未验证的方法只保留为候选。泛化方法的可信宿主评测默认需要至少 12 对样本、4 个保留样本、2 类任务、5 次改善，配对符号检验通过，且没有回归、关键约束失败或无法解释的成本增加。门槛只能收紧；样本来源与独立性仍由宿主保证。
- 内置三个登记方法：保留空值、复制来源日期、精确数值升序排序。固定回归证明有限数据契约内的转换正确，不代表模型一定遵循文字方法；报告分别标记 registered_algorithm 和 host_trial。
- 实验只保存摘要、哈希、版本和判决，不保存原始样本。成本未知不能当零；基础设施错误不能直接证明经验有害。已证伪的同一假设在相同环境/作用域中受到阻止，环境变化后可重新评估。
- 替代方法在验证通过后才停用前任。检查器确认回归时停用当前方法，并恢复符合条件的前任；并列候选不能误恢复别人的替代链。手动 resume 回到候选，重新验证后生效。
- 导入导出只携带方法正文、适用条件、登记方法标识及校验和。目标宿主从候选开始，不复制项目身份、实时状态或成功信誉；校验和用于检测内容变化，不是作者签名。
- 旧 schema 1 数据需要显式 migrate，先保存原始字节备份。历史 tested 降为候选，原计数保留；不伪造新的通过记录。迁移继续保留会话预算。

## 上下文与费用

每轮默认最多 **768 UTF-8 字节、2 条完整经验**，配置范围 128–1536 字节；同一会话累计提供最多 **1536 字节**。同一经验版本只提供一次，跨进程保存账目；不相关任务不注入。适用/排除条件一起计入预算，放不下时整条跳过。状态查询（`/mse`、`recallStatus`、`diagnose`）是只读的，不注入上下文也不占预算。

独立复盘最多 3 次/24 小时、至少间隔 30 分钟、最多输出 384 tokens；任务/结果摘要最多 800/1200 字符。新模型评测另有预算，默认 evaluationTokensPerDay=0（不启动额外模型评测），配置后 runEvaluation 每次预留整个任务额度、并发 1、60 秒超时、取消不退款。登记算法回归不调用模型。直接 evaluate 接收宿主已完成的试验，外部试验费用由运行它的宿主管理。

字节上限不是实际 token 费用：已存在的历史可能随请求重复发送。主会话压缩后不会偷偷重新追加旧经验。DSH 可以取消复盘请求；Hermes 同步客户端不提供请求中断时取消票据并丢弃迟到结果，同步客户端请求超时设为 60 秒；DSH 复盘也设 60 秒总截止。输出和每日调用预算不变。

## DSH

npm Bundle 包名为 `@missher/dsh-mse-learning`，patch 仍注册同一个 mse-learning 服务，配置/数据标识不变。peer 保持 `@deepseek-ai/dsh-llm: "*"`，不使用版本豁免；本轮原生验收目标为 0.2.0-rc.2，具体结果以交付回执为准。

状态目录为当前 profile 的 `dshHomePath('mse-learning')`。配置支持 enabled、reflectionEnabled、maxContextBytes、environmentId、evaluationTokensPerDay、evaluationCallsPerDay。`environmentId` 缺省不设置：记录与召回统一落在核心默认环境 `default`，与旧版本写入的方法保持同一身份；显式设置后才启用更窄的环境绑定，且不会扩大既有方法的验证范围。模型与推理级别沿用当前任务路由。检测到旧 missherEvolutionCore 时暂停新控制器。

可见状态面：`/mse`（本轮条数/字节/原因与会话预算）、`/mse why`（来源与最近轮次）、`/mse now <任务>`（只读预演）。命令经公开 commands 服务注册，只写入可见命令行，不进入模型上下文；项目作用域来自会话可信 `header.cwd`，暂停时明确显示不会注入。插件另提供 `ctx.mseLearning.recallStatus(sessionId, projectKey)`、`ctx.mseLearning.lastRecall(sessionId)` 与 `ctx.mseLearning.diagnose({...})`。会话关闭只取消该会话的排队/在途复盘，迟到结果不落库。

本版通过 llm/stream 检查本轮完整学习消息，并在成功 finish 后确认采用；该证据称为 llm_stream_success，不宣称拿到了 HTTP wire 回执。消息提交本身不再增加 adopted。可信集成可以使用 `ctx.mseLearning.verifyArtifact(...)` 或 `bridge.verification(...)` 绑定检查项、经验 ID 与版本；`ctx.mseLearning.guardedAction(input, action)` 为宿主提供执行前检查入口。

## Hermes

独立包解压根目录为 mse-learning，含 Python hooks 与同一 Node 核心。需要 Node >=22.19，可用 MSE_NODE_EXECUTABLE 指定；插件始终绑定加载时的 profile，并与旧 missher-evolution 库隔离。

核对 pre_api_request 最终消息和 request ID，在成功 post_api_request 后确认采用。可信集成使用 `Hooks.verify_artifact(...)` / `verification(...)`。后台暂停、卸载或会话重置撤销旧代次的写回资格。

MSE_REFLECTION_ENABLED=0 可停用复盘。MSE_EVALUATION_TOKENS_PER_DAY / MSE_EVALUATION_CALLS_PER_DAY 默认 0/2，只为宿主显式接入的评测运行器提供额度；插件不会因此自行更换模型或启动基准跑分。非法环境变量回落到默认值。

## 通用 SDK / JSON CLI

包根 `@missher/dsh-mse-learning` 同时是通用 SDK 与 DSH Bundle 入口：它重导出 `./core` 的全部符号，且只有在 DSH 宿主调用 `apply` 时才动态加载宿主适配器，因此没有任何 DSH 依赖的进程也能 `import '@missher/dsh-mse-learning'` 拿到 `LearningEngine`。DSH 侧同一 Bundle 还带浏览器端「学习详情」只读页（设置 → 自我进化）。其他 Agent 通过可信生命周期接入，能力语义见 [Adapter 协议](ADAPTER_PROTOCOL.md) 与 [召回说明](RECALL_2026-09-30.md)。SDK 可导入 LearningEngine、reflect、runEvaluation、guardedAction、getMethod、listMethods、checkArtifact、applyMethod、assessEvaluation、RECALL_REASONS，以及 `@missher/dsh-mse-learning/status` 的状态格式化与命令实现。`LearningEngine#diagnose({ projectKey, sessionId, environmentId, prompt })` 给出只读库状态或在给定任务下的召回预演。

```js
import { LearningEngine } from '@missher/dsh-mse-learning/core'
const engine = new LearningEngine({ stateRoot: '/absolute/private/state', adapterId: 'my-agent' })
const lesson = engine.record({ eventId: 'source-date-method', source: 'host_proposal',
  kind: 'method', methodId: 'copy-source-date-v1' })
const assessment = engine.evaluateRegistered({ lessonId: lesson.id })
const report = engine.checkArtifact({ lessonId: lesson.id,
  source: [{ id: 'a', value: '2024-02-29' }], artifact: [{ id: 'a', value: '2024-03-01' }] })
// report.status === 'fail'；检查本身不执行写入，也不增加线上成功记录。
```

`mse-learn --help` 显示协议。一条请求对应一条 JSON 输出：

```json
{"config":{"stateRoot":"/absolute/private/state","adapterId":"my-agent"},"op":"status","input":{}}
```

支持 prepare/record/accept/cancel/complete/status、diagnose、list/history、evaluate/evaluateRegistered、checkArtifact、suspend/resume/rollback、exportLesson/importLesson、migrate、reflectionRequest/reflectionResult/reflectionCancel、evaluationRequest/evaluationCancel。后台运行器和带 action 回调的执行检查属于 SDK 接口。

这些是可信宿主接口。不要将采用、验证、迁移或评测接口直接注册成模型可以自授信用的工具。自动阻止写入需宿主实际使用 guardedAction，并提供可靠来源数据和明确任务语义；仅安装插件不会自动识别任意工具输出。

## 生命周期细节

偏好槽位、到期重学与结算重试的边界、状态与验收见 [生命周期说明](LIFECYCLE_2026-10-01.md)；召回与纠错捕获规则见 [召回说明](RECALL_2026-09-30.md)。

## 数据升级与回退

区分两种升级：

- **schema 2 内的小版本升级**（0.9.0-alpha.N → alpha.M）：alpha.15 新增可选的持久结算字段；此前缺字段的 schema 2 库可读，无需 schema 迁移。控制初始化和正常写事务可能更新 revision，不能理解为启动永不写库。
- **schema 1 → 2**（0.8.x 及更早写入的日常库）：必须显式迁移。先停用旧学习控制器/等待任务结束并备份完整 mse-learning 目录（含 sessions），再由同一宿主身份对该目录调用 `migrate({ fromSchema: 1 })`。返回 `before-schema2-rN.json` 为主状态原字节快照，迁移不改写会话预算文件；未迁移时 prepare 明确返回 `migration_required`。只迁移新 learning-product 的 schema 1，不读取旧 missher-evolution 产品库。

旧版核心拒绝 schema 2。回退时先停用新版，恢复升级前完整目录及对应旧包；不要在两个控制器运行期间替换 JSON 或共用数据库。日常 DSH 安装由项目约定的唯一安装负责人执行。

**同 schema 写者风险（alpha.13 及更早的 0.9.0 版本）**：这些版本与 alpha.15 同属 schema 2，但它们不认识
`settlementOutbox` / `settlementControl`。把 alpha.15 写过的库交给它们，字段本身会被原样带过（旧校验不会因
未知顶层字段拒绝整库），但那些**尚未落账的 pending 行既不会被重放、也不会被退休**：旧写者的调度、暂停与
归档语义都不覆盖它们，于是「已经发生但未落账」的结算会一直悬着，直到再次运行 alpha.15 才按当时的真值处理。
因此回退到同 schema 旧版本时必须二选一：

- **先 drain/retire**：在 alpha.15 下等 pending 行落账或过期退休（`settlementStatus` 的 `counts.pending` 为 0），
  再停用新版、回退旧包；
- **配对回滚**：直接恢复升级前取的新鲜完整备份（含 `sessions` 与 `lessons-v1.json`）与对应的旧包，两者成对，
  不把新库喂给旧写者。

局部回退（只换包不换库）不是受支持的路径；也不要在两个控制器运行期间替换 JSON。

主状态最多 300 条经验、256 个活动收据、2048 个近期事件、256 条实验摘要和 2 MiB；经验 90 天到期。反证阻止受同一保留期限制。会话预算文件每个最多 4 KiB，会随会话数量增长，备份需包含它们。达到上限明确失败，不静默清库；损坏状态不自动重置。

