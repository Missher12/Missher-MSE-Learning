# MSE Learning 0.13.0 — Evaluation budget modes / 评测预算模式

## 中文

本版增加 `evaluationBudgetMode: "limited" | "unlimited"`，默认 `limited`；旧配置没有该字段时也按 `limited` 处理。

### 有限与不限额

- **有限**沿用保存的滚动 24 小时 token 与逻辑任务额度。切换模式不会改写这些数值；切回有限时继续使用原额度。
- **不限额**只移除共享的滚动 24 小时 token 与逻辑任务上限，覆盖决策、复审、客观评测和受控合并生成。API 状态显式返回模式与说明，剩余 token/任务额度为 `null`，实际预留 token、已测 token、逻辑任务、物理请求及未知费用计数继续如实显示。
- 切换即时作用于已运行 Core。它不会清空已有票据、费用账本或 checkpoint，也不会重放已派发请求；未派发的预算等待项只在允许的等待条件下重新排队。
- 自动验证仍由独立开关控制，默认关闭。切换预算模式不会开启自动验证，也不会代替操作者启用付费任务。

### 两种模式都保留的保护

每次请求的输入/输出上限、实际用量和保守预留记账、物理请求与逻辑任务区分、单并发、未知费用隔离、去重、pause/stop、来源与版本围栏、失败退避、验证/晋级门槛及上下文上限保持不变。自动复盘仍有自己的每 24 小时三次上限和至少 30 分钟间隔，不受本评测预算模式影响。

付费收据最多保留 **4096 行**，主状态文档上限为 **2 MiB**。空间不足时，新的付费准入返回 `spend_ledger_full` 并等待可用容量；不会合并或丢弃仍需审计的明细。DSH 只在账本实际满载时显示容量信息，正常状态不增加常驻容量数字。旧库接近存储上限时，减少实际占用的修复事务仍可提交。

### 配置入口

- SDK：`new LearningEngine({ evaluationBudgetMode: "unlimited" })`，或对运行实例调用 `configure({ evaluationBudgetMode: "unlimited" })`。省略时采用有限模式。
- CLI：CLI 从 stdin 接收 JSON 请求，预算模式放在请求的 `config` 中。例如：`printf '%s\n' '{"config":{"stateRoot":"/absolute/private/state","adapterId":"generic","evaluationBudgetMode":"unlimited"},"op":"status","input":{}}' | mse-learn`。该设置只用于本次 CLI 调用，不改写日常 Host profile。
- Hermes：配置 `evaluationBudgetMode`；未显式提供时可用 `MSE_EVALUATION_BUDGET_MODE=limited|unlimited`。不合法值回退到有限模式。
- DSH：在“设置 → 自我进化 → 评测预算”选择模式并保存。有限 token/任务数值会保留；模式切换不修改自动验证开关。

本版预算滑轨和模式功能一并交付。回归、包校验、原生界面与实际安装分别记录在[验证记录](../VALIDATION.md)及[交付记录](https://github.com/Missher12/Missher-MSE-Learning/blob/main/PUBLICATION.md)中。升级不会自动把其他用户切成不限额；只有明确选择并保存模式后才生效。

## English

This update adds `evaluationBudgetMode: "limited" | "unlimited"`. The default is `limited`, including when older configuration omits the field.

### Limited and Unlimited

- **Limited** keeps the saved rolling 24-hour token and logical-task allowances. Switching modes preserves those values; returning to Limited uses them again.
- **Unlimited** removes only the shared rolling 24-hour token and logical-task caps. It applies to decisions, reviews, objective evaluations and controlled merge generation. API status reports the selected mode and explanation, sets remaining token/task allowance to `null`, and continues to report actual reserved and measured tokens, logical tasks, physical requests and unknown-cost counts.
- The change takes effect in the running Core. It does not clear tickets, cost receipts or checkpoints and does not replay dispatched requests. Only eligible budget-waiting work is rearmed.
- Automatic validation remains a separate opt-in and stays off by default. Changing the budget mode does not enable automatic validation or paid work.

### Safeguards shared by both modes

Per-request input/output ceilings, measured and conservative reservation accounting, physical-request versus logical-task counts, one-at-a-time concurrency, unknown-cost isolation, deduplication, pause/stop controls, source and version fences, failure backoff, verification/promotion gates and context limits remain unchanged. Automatic reflection retains its separate limit of three attempts per 24 hours and a minimum 30-minute interval.

The paid receipt ledger retains at most **4096 rows**, and the state document remains capped at **2 MiB**. When space runs out, new paid admissions return `spend_ledger_full` and wait for capacity; auditable details are not merged or discarded. DSH shows storage capacity only when the ledger is actually full. A repair that reduces an older near-limit store can still be committed.

### Configuration

- SDK: use `new LearningEngine({ evaluationBudgetMode: "unlimited" })` or call `configure({ evaluationBudgetMode: "unlimited" })` on a running instance. Omitting the option selects Limited.
- CLI: the CLI reads a JSON request from stdin, with the mode in `config`. For example: `printf '%s\n' '{"config":{"stateRoot":"/absolute/private/state","adapterId":"generic","evaluationBudgetMode":"unlimited"},"op":"status","input":{}}' | mse-learn`. This applies only to that CLI invocation and does not change the daily Host profile.
- Hermes: set `evaluationBudgetMode`; when it is absent, `MSE_EVALUATION_BUDGET_MODE=limited|unlimited` may provide the value. Invalid values fall back to Limited.
- DSH: choose and save the mode in **Settings → Self-evolution → Evaluation budget**. Finite token/task values are retained, and the mode switch does not change the automatic-validation toggle.

The budget slider and mode controls ship together. Regression tests, package checks, native UI and installation are recorded separately in [Validation](../VALIDATION.md) and [Publication](https://github.com/Missher12/Missher-MSE-Learning/blob/main/PUBLICATION.md). Upgrading does not automatically switch other users to Unlimited; it requires an explicit saved choice.
