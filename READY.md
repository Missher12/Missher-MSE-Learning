# MSE 0.11.1 UI 候选 — READY for r2 freeze（2026-10-21）

**状态：** Window42 客户端表单测试 31/31 通过。Desktop 原生 UI 尚未运行或验收；补齐 Hermes 文档白名单后待根冻结 r2。本追加修正未重跑测试或打包。

## 精确基线与增量

- 0.11.0/R10 已接受并安装，为本轮正式基线。R10 冻结源清单 142 个文件，`SOURCE.json` SHA-256：`f381809ff6c2040254f7b468b52fd160866dc6d3258e715d053c02f64364f55c`。
- 修改前的 canonical `adapters/dsh/client.js` 与 R10 副本字节一致，SHA-256：`56ad71e0e77a24b45763051366dc4c85d0b40c089c53f3f2018679a36f29c8b0`。
- 本候选 UI 增量：`adapters/dsh/client.js`、`tests/details-client.test.mjs`、版本 `package.json` / `adapters/hermes/plugin.yaml`、双语 README 与 `VALIDATION.md`、新增 `docs/AUTONOMY_0.11.1.md`。`HANDOVER.md` 与本 READY 仅为本地交接材料。
- UI 将模型来源独立标成“决策模型 / 模型来源”，Host 显示“跟随来源会话”并隐藏远程字段；远程字段同宽且只在远程后端显示。Host-only save 不夹带未编辑的隐藏字段，用户编辑继续原 trim/校验与 save/discard 语义。
- 没有改 Core、预算、调度、Host 业务逻辑、供应商调用、R10 历史、Tag、Release 或安装。精确候选快照由根用既有 `freeze-candidate.mjs` 创建；本实现者未创建冻结目录。

## Window42 验收与追加包装元数据

- Window42 由父级回报：客户端表单测试 31/31；Desktop 原生 UI 未运行、未通过验收。
- `scripts/pack.mjs` 的 Hermes 文档白名单已追加 `AUTONOMY_0.11.1.md`，用于包含 README 新增链接的目标文件。修改前该文件与 `candidate-ui-0111-r1/source/scripts/pack.mjs` 字节一致。
- 根冻结 r2 后，相对 r1 预期仅该白名单项变化；私有交接可另记。追加修正后未运行测试或打包，不触碰已通过的客户端代码和回归。

---

## Historical 0.11.0 acceptance record

## Window33 当前源码补丁：尚待验证

- 本轮在 R6 冻结源码之后增加一次性旧问题反思修复：只接受已 settled/cancelled、无 dispatch 收据且已知用量精确的旧票据；Core 原子登记授权，后续新 ticket 的输出上限 2,048。普通反思仍为 384。未知费用、已 dispatch/有 request metadata 的票据拒绝；finish 原因未留存时明确记录 `not_retained`，不声称证明截断。
- 新增合成回归覆盖完整 stop/合法 JSON、Host `max-tokens` 与自定义 `length`、缺 finish、stop 下坏 JSON；已知 713-token 旧 receipt 的 2,048-token 实际 wire 重试；budget/source wait 后恢复；事件裁剪与冷重启后的竞争签票；新证据重新开放普通机会；RPC 额外字段拒绝。回归尚未运行，R6 的 r11 结果不覆盖此源码补丁。
- Window33 修改了 `control.mjs`、客户端 Remote 描述符和 Typert Host manifest；只增加受认证的窄 RPC，不增加 UI 控件。R2 已验的中英文窄布局及保存→重启回读可沿用作 UI 行为证据；不因此声称当前三包、安装或整体验收通过。

### 正式授权 RPC

- Host invocation ID：`@missher/dsh-mse-learning#mseControl/authorizeProblemRecoveryRetry`
- Remote 方法接收一个直接 JSON `input` 参数；Typert gateway envelope 为：

```js
gateway.invoke({
  namespace: 'mseControl',
  method: 'authorizeProblemRecoveryRetry',
  args: { input: {
    problemId: '<64-character lowercase hex>',
    projectKey: '<trusted source project identity>',
    // environmentId is optional; omit to use the normal default binding.
    evidenceRevision: 2,
    priorTicket: '<settled legacy ticket>',
    authorizationId: '<verified authority record id>',
    authorizationRef: '<64-character lowercase SHA-256 reference>',
    failureCode: 'reflection_invalid_json',
    finishKind: 'not_retained',
    priorMaxTokens: 384,
  } },
})
```

- Browser call shape is `scope.remote.mseControl.authorizeProblemRecoveryRetry(input)`. Unknown fields are refused before forwarding; Core then rechecks the durable problem/ticket/event/spend under its transaction. Success registers one marker only; it does not dispatch a provider request.
- The RPC has no public read-back counterpart. For authorized isolated acceptance, read the persisted `problemLoop.problems[].recoveryRepair` marker after a cold restart; `problemStatus` and `problemDueFeed` are Core methods, not HTTP Remote endpoints. Do not use the registration response alone as durability evidence.
- Current authorization state for this handoff is `executionAuthorizedNow=false`: no RPC call or real retry was made. The root/Desktop owner must verify the external authority record before registration; the current source does not contain private project identifiers or that record's value.

### 精确待跑测试

父级在单一受限验证窗口可用以下命令运行新回归及既有兼容性控制。它包含所有 `P16:` 窄用例、RPC/manifest 契约、旧 Hermes 不传 `requestHash` 的 merge 结果，以及现有 DSH 生产 merge/restart 控制：

```sh
node --test --test-name-pattern='P16:|authenticated recovery RPC rejects extra fields|client descriptors mirror the Host manifest endpoint|merge generation requires a frozen verifier/source and creates only an independent candidate|the production DSH scheduler generates one merged candidate and does not repeat it after restart' tests/stage3d-recovery.test.mjs tests/details-project.test.mjs tests/details-client.test.mjs tests/decision.test.mjs tests/stage3-chain.test.mjs
```

本轮只做静态语法与差异检查，没有运行以上测试、构建、打包或 provider。

- Core、DSH、Hermes 合并生成接线及预算/恢复/来源复核已实现；修改位置与约束见 `HANDOVER.md` 顶部。
- 2026-10-20 的 0.11.0 integration 定向结果：r7 为 Node 113 项（101 通过、12 失败）和 Hermes 25 项（22 通过、3 失败）；r9 为 Node 12 项（8 通过、4 失败）和 Hermes 3 项（1 通过、2 失败），其中迁移 3 项全过且 DSH 生产 merge 通过；r10 为 Node 4 项（1 通过、3 失败）和 Hermes 2 项（1 通过、1 失败），另有 Hermes source-binding 2/2 通过。r11 最终复验待完成。
- r11 最终定向验收已通过：Node 8/8、provider 6/6、Hermes 1/1，均为 0 skip；父级 `WINDOW-RELEASE-14.json` 已释放。
- 真实 Laya：HTTP 200，model=`laya-rl-agent`；1 次协议请求与 5 次决策请求，共 3,624 已知 tokens、23,650 保守预算。Core 结算和重启防重通过，未产生晋升。协议与记账通过不代表语义质量通过：五例仅两例符合预期；中文无证据与英文可信反证均建议 merge，且相同状态的标签从 `suggest_merge` 翻转为 `reject`。golden 保持未改，未追加请求。该实例决策质量未通过且对标签敏感，不建议作为独立裁决器；Host 继续作为默认后端。
- JEV 真实连接未测。当前原生 UI、默认模型、0.11.0 三包、Git、正式 Release 和安装均待验收。本版本仍是源码候选，不得据此报告全通过。Laya 结果见父级 `integration-r11-run/LIVE-LAYA.json`。

## 历史候选快照

## 历史记录：2026-10-17 · 0.10.0 UI-r11 三项客户端修正

本节的 r11 指 0.10.0 UI 候选，与当前 0.11.0 的 r11 源码冻结无关。该历史候选的组件与包检查结果见 `VALIDATION.md`；真实原生 UI 和官方 Web 仍待 Desktop 集中验收，未发布或安装。

## 2026-10-17：最小验证会话行窄窗修正

- 依父级授权，仅在 `adapters/dsh/client.js` 将 `verifySession` 行设为 `{ stacked: true }`，Picker 改用已有 `mse-picker-wide`；选项、值、权限与保存/Discard 行为不变。
- `r9` 冻结目录保持原样；`r10` 尚待父级打包及 Desktop UI 原生验收。当前未运行动态检查、测试、构建、pack 或模型。
- `docs/images/en-normal.png` 是 alpha.2 旧 inline 行的历史图，文件保留不变；公开图注不将其表述为此次修复验收。


## 2026-10-17：父级复核与文档收尾状态

本节记录 2026-10-17 的历史状态，不代表当前 0.11.0 验收结论；下方 10 月 14 日记录同为历史快照。

- 已复核：自动调度 11/11；私有陈旧快照各 4 次扫描、2 次冷启动，mock 预算下 0 dispatch 且状态保留；Hermes 完整单实例链路 61.156 秒（355 CLI 操作，无超时/锁忙、无外网）；官方 npm DSH alpha.5 Loader 正常、缺少 fs、缺少 tools 三场景通过，正常场景使用真实 fs-local。详细范围见 `VALIDATION.md`。
- UI 图只来自社区 alpha.2 英文设置页、合成数据、自动验证关闭；不能称作 alpha.5 原生 UI 通过。窄屏中文及目标桌面 UI 仍待桌面负责人验收。
- 已完成本轮公开说明、截图引用和 Hermes 文档闭包静态修改。后续允许的工作仅为父级静态检查、精确三包构建和受影响验证；本执行者未运行测试、打包、构建、浏览器或模型。
- 仍未证明：完整测试套件、付费真实 provider 效果、正式 Release、日常安装。首次锁持有者的历史原因未知，不以本轮证据调整锁逻辑。
- 历史候选及哈希如下文保留为历史记录，不能代表当前文档版源码或新冻结候选。

## 2026-10-14：0.10.0-auto-idempotency-r8

**状态：独立 DSH/Hermes/source 候选已构建；定向 Node、包结构和父级私有 cold-restart 经济探针通过。** r1、r4、r5、r6、r7 和中间候选均保留且未覆盖。Hermes 及 DSH native 回归由父级继续确认。本记录不表示完整测试通过、正式 Release、安装或日常运行验收。

- 目录：`dist/0.10.0-auto-idempotency-r8/`
- DSH 包：`missher-dsh-mse-learning-0.10.0.tgz`，573,510 bytes，SHA-256 `1a1b36ced0582f3aef21cf592fdc95420436f66d28b8ec60499f1c913ad1beee`。
- Hermes 插件：`mse-learning-hermes-0.10.0.tar.gz`，340,629 bytes，SHA-256 `bacfabb934ab87a9923dfbe75f3f1f88f73f0ded21b6e07f09862e4caab59a21`。
- 源码归档：`mse-learning-0.10.0-source.tar.gz`，1,018,050 bytes，SHA-256 `07057ffedd517667eb238b71adc0456b96535c72810a947a97f84c366fca6b09`。
- Manifest SHA-256：`d5406ba7f11dcfe7f7b1bcd609e484592cda183d3f63a464f9df18741af93141`；137 个 allowlist 源文件。
- 包含新 `adapters/dsh/evaluation-request.mjs` 与经济身份拒绝时保留原计划的修复；私有 `.probes/` 不在 allowlist。
- 定向 Node 回归：74/74；`node scripts/verify-package.mjs --dist dist/0.10.0-auto-idempotency-r8` 返回 `ok: true`，DSH/Hermes 共用核心一致。
- 父级从精确 source archive 提取后执行真实 `createAutoValidation`/`callEvaluationModel` 和 mock transport：两份快照各 4 次扫描、两次冷重建，0 dispatch，计划/ticket/checkpoint/spends/jobs 保持；partial 持续显示原 blocked reason。记录见父级私有 `economic-parent-04/REPORT.json`。
- 完整 Node 套件未运行。私有脱敏汇总位于 `.probes/auto-idempotency-r1/private-snapshot-readback.json`；该文件不在 allowlist。
- 真实 UI 盒子/宽窄截图待父级验收；未触发真实 provider，未写 Git、安装、发布或改日常自动验证设置。

## 历史：0.10.0-cordis-r5 修复候选

**状态：本地修复候选已完成有界回归和结构验证，待父会话独立复验。** 原 `dist/0.10.0/` r1 候选保留且未覆盖。本记录不表示完整测试通过、正式 Release、安装或日常运行验收。

## 本轮有界修复

- Cordis 的 `fs` 是可选服务。插件现通过 `ctx.inject(['fs'], ...)` 在已注入的子 scope 注册 package.json editor 监听；缺少 fs 时核心插件正常加载并显示 `not_connected`。fs 服务卸载时 disposer 清理监听并复位 capability；重新挂载后重新注册。
- `tests/pump-host.mjs` 现在在 Host turn 测试中驱动并消费成功的 `llm/stream` 事件，实际经过 Harness listener 和 `publishDshSource` 建立 `dsh_host_stream` 身份；没有直接调用 source ledger 的 publish API。
- `tests/auto-scheduler.test.mjs` fake 改为当前 ticket 合约：提供 suite 身份，断言 objective reservation 只传注册 `packId`/`suiteId`，不携带测试自行编造的 cases。

## 候选包

- 路径：`dist/0.10.0-cordis-r5/`。r1 `dist/0.10.0/`、r4 与中间修复候选均保留且未覆盖。
- DSH 包：`missher-dsh-mse-learning-0.10.0.tgz` — 569,698 bytes; SHA-256 `d2c2c7df1a251d1fba743c875c5c69fd8d9624dc9e3e7ad12a5b7fa232e0101b`。
- Hermes 插件：`mse-learning-hermes-0.10.0.tar.gz` — 338,816 bytes; SHA-256 `590171322fd6f23bb79d3f3c39384436683fe7ef4c8f3664787b0fcf9a892e4f`。
- 源码归档：`mse-learning-0.10.0-source.tar.gz` — 1,009,966 bytes; SHA-256 `804406c2682384c4d19cfb80d5aa3c938ffb5b1423ab3fda132d0afc1ef65dc8`。
- 包验证为 `ok: true`；manifest 与 136 个 allowlist 源文件和三个归档哈希一致，DSH/Hermes 共用核心代码。
- 复核：`node scripts/verify-package.mjs --dist dist/0.10.0-cordis-r2`

## 验证结果与限制

- 有界组合：98/98 通过。命令为 `node --test tests/auto-scheduler.test.mjs tests/dsh-guard-host.integration.test.mjs tests/stage3-chain.test.mjs tests/stage3d-pump.test.mjs tests/stage3d-recovery.test.mjs tests/stage3d-slot.test.mjs tests/stage4b-source-gate.test.mjs tests/task-evidence.test.mjs tests/task-replay-automatic.test.mjs tests/source-identity.test.mjs`。
- 覆盖真实 Cordis 4.0.5-alpha.1 的 MSE 加载；fs 缺失时 fail closed、真实 fs 挂载/卸载/重挂；真实 DSH fs/editor 文件事件；来源身份、预算/冷却恢复、来源变化拒绝、foreground/pause/late-answer、ticket/cancellation 和 slot draining。
- 父级对 r1 的完整隔离套件结果是 576 项、460 通过、116 失败；差分定位 98 项与冻结基线同诊断，新增 18 项来自以上两个测试契约过期问题。修复后没有重跑完整套件；97 项有界结果不能替代完整结果。
- Hermes 使用 fake provider 的真实 PluginManager/native dispatcher 3/3 是 r1 已独立验收证据；本轮未改 Hermes。未触发真实 provider。
- 通用注册项目测试 runner 不在此版本能力范围；不声称执行任意项目 scripts/tests。未验证完整桌面 UI、正式安装、Release 或长期真实模型收益。
- 冷重建回归创建真实 durable ACK，进程 A 因 `lock_busy` 留下 pending；真实 Cordis MSE 第一次冷启动从空 session directory 确认 workspace archive 并 stop；第二次冷重建不增加 stop/control 或结算计数。
- 父级 r5 精确包 Host harness：`/home/missher/Projects/DSH-Recovery-20261012/mse-autonomous-upgrade/audit/native-plan/mse-0.10.0-v4-source-r5/result.json`，first/rebuild 均 pass；first fixture requests=3，rebuild=0，realModelCalls=0，networkAttempts=0，归档 ACK 最终 stopped=1、pending=0、verified 保持 1。
- 公共包来自 `scripts/public-set.mjs` allowlist；`.probes`、未列入的协调材料、隐藏目录和缓存不得进入包或 manifest。

未执行 Git、安装或发布。候选交父会话独立复验；后续安装与正式 Release 仍由桌面负责人协调。
