# 偏好替代、方法到期重学与结算重试（2026-10-01）

本轮补齐三个生命周期缺口。全部为进程内、有界、可注入时钟/调度器的实现；没有新增模型调用，没有放宽验证门槛。

## 1. 偏好冲突：只处理明确替代

**结构化槽位。** `record({ topicKey, value, supersedes, expectedSupersededVersion })` 接受由可信宿主提供的偏好键；键形如 `report.currency`，值形如 `CNY`，两者都受格式校验（`invalid_topic_key` / `invalid_topic_value`）。槽位与值写入事件 fingerprint 与持久化校验，旧 schema 2 数据缺少这两个字段时按未标注处理，不批量补键。

**自然语言识别（有界）。** `prepare` 只对产品明确理解的槽位做识别：当前为 `report.currency`（人民币/CNY/RMB、美元/USD/美金、港币/HKD、日元/JPY、欧元/EUR）。同一句里出现多个币种视为歧义，不产生槽位。其他自由文本一律按普通纠错处理，**不会被描述为“已识别冲突”**。

**替代语义。**

- 同一作用域、同一 kind、同一 topic 出现不同 value：只有存在明确替代依据才替换 —— 文本含 纠正一下/改成/改为/换成/改用/替换为/不再用/以…为准（`REPLACEMENT_CUE`），或显式传 `supersedes`。
- 替换在同一事务内完成：旧规则 `suspended`、`version + 1`、`replaces` 指向新规则；新规则 `reminder`、`replaces = 旧 ID`。
- 没有替代依据：返回 `conflict_unresolved`（含 `topicKey`/`value`/`existing`），**不写入新值**，旧规则继续生效；重复请求幂等。
- 同一 topic 且同一 value：去重，返回既有 lesson ID（`same_preference`）。
- `expectedSupersededVersion` 不匹配时报 `stale_replacement`，不覆盖另一客户端刚完成的替代。
- 跨项目 / 跨 kind / 跨环境（方法）的替代被拒绝，库不变。
- 方法沿用既有策略：新候选评测通过才停用旧方法，不与 correction 混用。

**迟到结果。** 替代会使旧版本 `version + 1` 并停用；旧 receipt 的 `complete` 因 `receipt_stale` / `evidence_not_adopted` 被拒绝，旧规则的 verified/failed 不增加，也不会把信用转给新规则。

## 2. 方法到期重学：新世代候选

- 只有**新的、可信的** `host_proposal` 事件再次提交同一方法时才重开；`prepare`/`diagnose`/读取库/普通任务命中都不会续期。
- 重开动作：沿用 lesson ID，`version + 1`，`status = candidate`，`validation = null`，`expiresAt = now + 90 天`，更新 `sourceTurn`，并在实验历史里记一条 `reopened`。
- 旧实验、旧计数、旧采用记录保留为历史，不继承；评测必须带新版本号（`expectedVersion`），旧版本号报 `stale_version`。
- 重开前不召回；新评测通过后才恢复召回。
- 手动撤回、回归停用的方法**不因到期或重提自动复活**；另一环境是独立世代，不继承本环境验证。
- 每个 lesson 记录有界的 `eventIds`（最多 8 条）。事件账本本身 90 天裁剪，因此过期后重放同一 `eventId` 仍返回 `duplicate`，不会偷偷重开。
- 会话预算不受重学影响：既有字节借记保留，新版本按原预算规则再次提供。

## 3. 结算重试：只重放冻结的 complete

**共享语义。** DSH `SettlementQueue`（`src/settlement.mjs`）与 Hermes `SettlementQueue`（`adapters/hermes/bridge.py`）行为一致：

- 回合终止时冻结**唯一 payload**：sessionId/turnId/projectKey/environmentId、最终 outcome，以及已由可信检查绑定的 lesson/version/checkId。
- 重试**只调用 `complete`**，不重新 prepare、accept、verifyArtifact、执行工具、复盘或评测；payload 逐字节一致（测试断言每次传参相同）。
- 依靠核心 `complete` 的 turn 幂等事件：重复提交返回 `duplicate` 与原 `outcome`/`attributed`，因此“已提交但响应失败”的重放会把真实归因恢复出来，而不是显示成新的失败或 0。
- 边界：队列上限 **64**，单项最多 **4 次尝试**（首次 + 250ms / 1s / 3s），总年龄上限 **5 分钟**，并进一步受原 receipt 有效期约束（`prepare` 返回 `receiptExpiresAt`）。达到上限报 `exhausted` + 最后错误 + 尝试次数；容量满报 `capacity`，不静默挤掉旧项。
- 只对明确瞬时错误重试（`lock_busy`、`state_unavailable`、`state_busy`、`runtime_unavailable`、超时等）；`invalid_store`、`owner_or_schema_mismatch`、`migration_required`、`invalid_evidence`、`event_conflict` 等永久错误立刻终止并展示。
- 同一 turn 出现**不同 payload** 直接报 `conflict`，不形成第二条队列任务，也不把 outcome 改成 unknown/cancelled 凑成功。
- 暂停：停止调度、代次失效，保留有界快照与 deadline；恢复时只重放未过期的本地 `complete`，不恢复复盘/评测 runner。
- 会话关闭：该会话的计时器停止并标记 `stopped`，其他会话继续；已冻结的终态不被改写。
- 卸载：停止全部计时器，返回后不再启动任何重试；迟到回调因代次不匹配而失效。
- 一个队列项单飞：重复 `turn/end`、`post_llm_call`、`on_session_end` 与重复计时器都不会产生第二次归因。

**范围声明。** 本轮是**进程内有界重试**。跨进程/崩溃恢复需要持久 outbox（可信身份 + payload hash + deadline + 去重）与“主库已提交但 outbox 未删”的另立验收，本轮不做，也不宣称。

## 4. 状态与能力

- 新原因码 `conflict_unresolved` 及其它原因码都有中文标签；`/mse` 会打印冲突槽位、现有规则 ID 与“当前未写入”。
- 结算状态进入 `recallStatus().settlement`（DSH）与 `settlement_status()`（Hermes）：`state`、`attempts`、`lastError`、`delivery`。
- 回合状态显示与核心一致：`verified`/`failed`/`cancelled`/`unknown`，写入失败显示 `pending` + 错误码 + 尝试次数。
