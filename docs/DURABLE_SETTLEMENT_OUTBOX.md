# 持久结算 outbox：已实现的契约（alpha.15）

2026-10-03，MSE 0.9.0-alpha.15。**本文描述已实现并经独立验收的持久结算**，取代 alpha.14 阶段随附的
设计提案。alpha.14 提案与最终实现的三处关键差异在 §8 单列；旧提案的正文不再作为现状。

范围：DSH 与 Hermes 共用同一核心，因此持久格式、控制与退休语义都定义在**共享核心**里
（`src/index.mjs`），两个适配器只负责触发、许可与客户端调度。

## 一、要解决的问题

结算队列原本只在**内存**里保存待重试项。进程一旦在“业务已完成、尚未落账”之间消失（崩溃、被强杀、
宿主重启），那次结算就永久丢失：宿主侧已经产生了真实用量，而学习库里没有对应的账。正常停止与全局
暂停是**有意**状态，不属于这类丢失。

## 二、存储与边界（与学习库同一份文档）

* 存放位置：学习库文档 `lessons-v1.json` 的 **schema 2 可选字段**，不新建文件、不新建 schema 版本。
* `settlementOutbox`：`pending ≤64`、`history ≤32`、单项 `≤4096B`、总量 `≤256KiB`。
* `settlementControl`：单调递增代次、用户暂停位、精确 stop 墓碑 `≤64`。
* 读写走与学习库**同一把锁、同一个事务**：完成与退休在**同一事务**里原子提交，不存在“记了账但条目
  还在 pending”或反过来的中间态。抽出无锁 `completeInState` 供 public `complete` 与 `settlementApply`
  共用，因此不会嵌套取锁。

条目只保存**重放所需的冻结坐标**，不保存经验正文、摘要或模型输出：`key`、`payloadHash`、`owner`、
`scope`、`environment`、`sessionHash`、`turnHash`、冻结的收据与接受事实（`receipts`）、`outcome`、
`evidence`(哈希)、`fingerprint`、`queuedAt`、`deadline`、`attempts`、`nextAttemptAt`、`lastError`。

## 三、公开接口（CLI 与适配器共用）

| 操作 | 语义 |
| --- | --- |
| `settlementEnqueue` | 首个事务提交才算 durable；ack 返回 `key`/`payloadHash`/`deadline`/`queuedAt`/`generation`。同一 key 同载荷是 `duplicate`，不同载荷是 `settlement_conflict`（绝不覆盖已确认的事实）。 |
| `settlementStatus` | **零写入**的只读视图：`pending`（含 `sessionHash`、`deadline`、`attempts`、`state`）、`history`、`counts`、`control{generation,userPaused,stops}`。旧文档不会因为它而被创建出这些字段。 |
| `settlementApply` | 必须带 `generation`。**终态优先回读**：条目已退休则直接返回它的事实（含 `terminal`）。未退休时按序判定：代次、用户暂停、该会话的墓碑、owner、`deadline`、尝试上限、宿主可信 guard；随后在工作副本上试算 `completeInState`，失败只提交次数与错误码。成功即在同一事务里落账并退休。 |
| `settlementStop` | 严格 XOR：要么 raw `sessionId`，要么本 owner 的 `key`+`payloadHash`；混合、残缺、畸形一律 `invalid_input` 且零写。`key` 形式在锁内从条目推导会话身份，调用方永不提供 owner/scope/session 哈希。 |
| `settlementPause` | 显式用户暂停：停止调度、保留每个 `deadline` 原值。 |

到期与尝试数**原样继承**：`deadline = min(排队时刻 + 5 分钟, 原收据到期)`，重启不刷新、不重置；
业务尝试上限为 4（`OUTBOX_MAX_ATTEMPTS`），`lock_busy` 发生在拿锁之前，**不计**业务尝试。

## 四、控制语义（谁结束什么）

| 事件 | 语义 | 重启/下一进程 |
| --- | --- | --- |
| 用户暂停 | 停止调度、保留条目与原 `deadline`；只由显式恢复解除 | **保留**，仍为暂停，不自动重放 |
| 一个会话的精确停止 | 写该会话的墓碑（`sessionHash`），并退休其 pending 行 | **保留**：墓碑比收据与 pending 行都长寿，`enqueue` 对该会话直接 `settlement_stopped` |
| 插件卸载 / 热重载 | 只停本进程的调度 | **保留** pending 行，由下一个进程按新鲜真值决定 |
| 正常退出（Hermes `reason="shutdown"`） | 同上：只停本进程 | **保留** pending 行 |
| 进程意外中断 | 未完成的尝试被截断 | 由下一个真实生命周期**重读公开状态**后重放 |

关键点：**没有“干净退出标记”**。恢复不靠猜测“上一进程是否正常退出”，而是让每个实际生命周期时刻
（服务就绪、真实回合边界）重新读公开 `settlementStatus`，再用当时的宿主真值决定每一项：暂停仍然暂停、
墓碑仍然停止、未过期继续、已过期由核心退休。只读状态读取永不触发恢复或补写。

墓碑的裁剪是保守的：只有当它**不可能再约束任何东西**（没有该会话的 pending 行、也没有仍有效的收据）
才允许裁剪；无法证明可裁剪时，控制写入**明确拒绝**（`settlement_stop_capacity`），而不是静默复活一个
已停止的会话。旧版本写入、没有 `sessionHash` 的收据按“不可归属即保守绑定”处理。

## 五、客户端调度（两个适配器同策略）

适配器只重放**冻结的结算操作**：不重放模型、工具、复盘或付费评测。得到 ack 之后，条目的终态属于核心，
客户端：

1. **不本地冒充终态**：已 ack 的条目不会因为本地期限到达而被本地标记为 expired/exhausted；核心在
   自己的事务里记录 `expired`/`stopped`/`failed`/`conflict`，客户端只是转述。
2. **最后一次自动尝试排在原 `deadline`**：退避的下一次若会越过期限，就改排到期限本身，让核心用自己
   的时钟做出到期决定（从未过期的一侧越界，也不延长期限）。
3. **到期尝试仍无法确认时诚实停下**：条目标记为可见的 `unconfirmed`（保留原 `deadline`、保留条目、
   **不排后继定时器**），由下一个合法生命周期或重启再读核心；只读状态永不补写。
4. **许可与边界**：后台重放与前台召回共用同一个写入边界（后台有界等待、前台永不因后台丢注入）；
   最终有效性检查与实际写入在同一串行化边界内重做（最新许可、生命周期、条目身份与存续、期限）。
5. **停止是精确且按会话的**：未确认的精确停止只阻断它自己命名的那个会话（raw id、核心公开
   `sessionHash`、或已确认条目 handle），绝不暂停其他会话；用户暂停才是全局门禁。身份按共享核心的
   同一条规则映射：`sessionHash = sha256(UTF-8(sessionId))`（`identity()` 校验后原样返回），不猜 key。

**锁限制**：持锁进程**崩溃**后，既有的 5 分钟死 PID grace 会挡住后来的写者，此后条目只能明确
`expired`；这是已知限制，不是可绕过的路径。

## 六、端到端恢复（各适配器）

* **DSH**：服务就绪驱动恢复（异步完整目录 `sessionQuery.listSessions` + `workspaceRegistry` 归档真值；
  短时快照 + 代次失效；缺服务、异常、截断一律 unknown 且拒绝）。归档/删除由 key 寻址精确 stop；
  已确认的永久停止即使遭遇真实锁忙，也由本进程**有界调度**在解锁后自行收敛（重试预算摊在整个窗口内，
  越界即停止并保留可见的未确认状态），不依赖用户再开一个回合。处置（dispose）保留 durable 行。
* **Hermes**：新增第 10 个 hook `on_session_finalize`，只有 `platform="cli" && reason="session_boundary"`
  精确停旧 ID；Gateway 用 `old_session_id`；`shutdown`/unload 只停本进程。恢复失败可有限重试，
  精确停止有真实上限（3 次提交、30 秒窗口）与有界后台重试。

## 七、验收（已完成的层）

* 核心：r2 22 组通过；r3 8 组中 **7 通过、1 失败**（XOR 形态）；r4 新增 4 组为形态修复验证。
* 到期与客户端调度：真实 core/bridge + 受控时钟的过期 4 例（含重启已过期、本地 timer 跨期限、
  暂停后跨期限恢复）全过；截止边界两场景（截止前锁忙排到原 deadline、已跨期锁忙 `unconfirmed` + 0 timer
  且后续显式恢复正常退休）全过。
* 宿主竞态：pause、TTL 过 31 秒后真实 pre-step、只读后显式恢复通过；归档/删除的精确停止收敛由本进程
  有界调度完成后复验。
* Hermes：适配器 53/53 单元与边界、真实核心 + 真实锁的会话隔离两场景、真实 PluginManager/CLI 生命周期
  连续通过（模型调用 0）。

## 八、与 alpha.14 提案的差异（提案正文不再作为现状）

| 提案 | 已实现的契约 | 原因 |
| --- | --- | --- |
| 独立文件 `outbox-v1.json`、独立 schema 1 | 学习库同一文档的 schema 2 可选字段 | 完成与退休必须与账目同事务原子提交；第二个文件会让“记了账”和“条目还在”可以各自成功 |
| 干净的 dispose 退出标记来决定是否重放 | 没有标记：由每个真实生命周期重读公开状态 + 当前宿主真值决定 | 标记本身需要可靠写入，而它恰恰要在崩溃路径上生效；公开状态已经是权威事实 |
| 卸载/热重载 = 不重放（与正常停止同义） | 卸载只停本进程，**pending 行保留**，由下一个进程决定 | 卸载不是“这次结算不该发生”，而“会话已停止”由墓碑表达；把两者混同会丢账或复活已停会话 |
