# 0.11.0 自动改进能力与宿主能力矩阵

本文说明当前产品行为与已知宿主边界。最新交付与包校验和见 [交付记录](../PUBLICATION.md)，分层验证结果见 [验收记录](../VALIDATION.md)。文中的旧冻结点结果保留用于追溯，不替代最新交付状态。
设置页截图仅为社区 alpha.2 英文版旧 inline 验证会话行的历史合成布局，本身不证明当前 UI 行为。另有 R2 原生验收覆盖中英文窄布局、设置保存与重启回读；证据范围见根目录 `VALIDATION.md`。

## 0.11.0 受控合并生成候选

- 决策模型只能从 Core 给出的 `mergeCandidates` 选择 `mergeTarget: {id,version}`；意见仍是建议，不产生验证或晋级信用。
- Core 在同一作用域、环境与已登记 verifier 下冻结两个父候选的版本、内容摘要、来源会话及适用/排除条件。父项变化、验证器不一致、条件冲突、来源不明或指向歧义时拒绝。
- 生成经现有 reflection driver 与单并发槽执行；派发前事务复核来源 revision/hash/epoch、暂停/停止控制、双亲版本和票据期限。只创建独立候选，不写 `methodId`，不沿用父项验证状态。
- 生成同时预留每日评测 token/call 预算，并受每日三次复盘配额约束。未实际派发的请求可释放预留；派发后崩溃按费用未知记账且不重试。
- DSH 与 Hermes 共享 Core 协议；Hermes 使用已配置 Host resolver，不因功能接线宣称各版本兼容。
- 2026-10-20 的 integration-r7/r9/r10 分阶段结果及早期 integration-r11 历史结果见根目录 `VALIDATION.md`；该轮 Node 8/8、provider 6/6、Hermes 1/1（均 0 skip），父级窗口已释放。这些结果早于 Window33 问题反思恢复补丁。Laya 的 1 次协议与 5 次决策请求也发生在早期 integration-r11：协议与记账通过（HTTP 200；3,624 已知 tokens / 23,650 保守预算；Core 结算和重启防重通过、未晋升），但语义五例仅 2/5 符合预期且存在标签敏感，不建议该实例独立裁决；golden 未改、未追加请求。R6 沿用这些历史记录，没有重新运行 r11 或 Laya 请求。R6 默认 Host 后端的有限实测结果另见 `VALIDATION.md`；远程 OpenAI-compatible/JEV 真实连接未测。0.11.0 三包、Git、正式 Release 与安装仍待验收。Window33 补丁和新增回归尚未验证。

## 配置与接口

DSH 配置中的决策后端可选 Host 或已实现的远程 OpenAI-compatible/JEV/Laya 适配器；Host 使用候选来源会话的已观察路由。决策模型、端点及 secret 环境变量名独立于普通聊天模型；保存设置不会测试连接。HTTP 仅允许回环地址；Laya 额外允许明确写出的 RFC1918 私有 IPv4 字面地址（10/8、172.16/12、192.168/16），其他后端仍拒绝非回环 HTTP。不会解析 DNS 名称来允许内网 HTTP；URL 用户信息、查询和片段都会拒绝，HTTP 重定向也会拒绝。secret 环境变量名只用于本地解析，实际 secret 不进入 URL、请求正文或持久化状态。协议入口为 Core `decisionContext` → `decisionRequest`/`decisionDispatch` → `decisionComplete`，建议合并时接 `decisionMergePlan` → source-bound `reflectionRequest` → `reflectionDispatch` → `reflectionResult`。所有调用都通过同一状态库和事务门禁。

自动验证设置关闭时不会由自动队列发起决策；暂停、会话 stop tombstone、取消和控制代次变化都会在物理派发门禁复核。设置 UI 的中英文窄布局、保存与重启回读已有 R2 原生验收；Window33 只增加已认证 recovery RPC 描述符和 Core 入口，不改页面控件或布局。其他 DSH/Hermes 版本适配仍未验收。早期 integration-r11 的 Laya 协议与记账结果通过，但决策质量未通过并对标签敏感；R6 沿用该记录，未重测。R6 默认 Host 后端已有有限真实决策、评审与 objective 拒绝结果；这些结果只证明本轮受限实测，不能外推为语义可靠或费用行为全面验收。远程 OpenAI-compatible/JEV 真实连接未测；Host 仍为默认后端。配置项存在或协议接通不证明决策语义可靠。

0.10.0 的 schema 2 数据无需结构迁移；新决策、合并状态和 generation spend 是可选字段。升级前仍应保留完整新鲜备份；回退至不认识新状态的旧包前，应停用自动任务并保留同版本数据备份。未验证过的 DSH/Hermes 版本、原生 UI 和平台安装行为不作兼容声明。

## 能力范围

- 以固定合同、来源身份和宿主事实建立可审计的任务证据。
- 对登记范围内的结构化工件执行确定性检查；不会运行任意项目脚本。
- 将失败与正常轨迹形成脱敏、有界的回放材料，并沿用现有预算、恢复和候选状态机制。
- 仅在已核实的宿主入口提供可撤销的 guard，并按宿主分别披露覆盖率。

## 设置客户端契约

- 设置控件仅在 ConfigForm 快照 `status=ready`、`writable=true` 且宿主提供 `mutate` 时启用。旧契约若提供 `mode`，只接受 `host`；新契约省略 `mode` 时按 `writable` 能力处理。保存前重新读取快照确认写权限，但仍以草稿读取时的原 revision 调用一次原子 `mutate`。
- 设置正文宽度低于 340px 时用宿主 Picker 提供五个完整页签标签；较宽时保留宿主 SegmentedTabs。宽度取实际内容容器并随容器变化更新。
- 设置区和 Bundle 设置入口通过宿主 locale hook 订阅活动语言。切换语言只更新显示文案，不通过语言变化触发数据刷新。

## 源码核验的能力矩阵

| Host/input | 可信入口与事实 | 验证/执行边界 | Preflight |
| --- | --- | --- | --- |
| DSH | 本机 Host `@deepseek-ai/dsh-tools 0.2.1-alpha.2`：`tools/pre-execute` waterfall 后同步执行 `tools.guard()`；`tools/result` 收到冻结结果。独立的文件 intake 只读取项目根 `package.json`。 | guard 在 `prepareExecution` 中，dispatch 前；取消在 gate 前及 guard 后检查。package checker 检查 JSON 语法、顶层对象及登记字段的 JSON 类型；字段可缺省，未知扩展字段允许。它不检查 npm 语义、依赖安装或测试通过。项目测试执行器尚未接入自动队列。 | 工具管线覆盖已进入 ToolRuntime 的调用；不覆盖 shell 内部子命令、工具外写入或其他 Agent。可撤销注册 disposer。 |
| Hermes | editable host 源码的 `agent/tool_executor.py`、`model_tools.py` 和 `agent/agent_runtime_helpers.py` 均在实际 dispatch 前调用 `_dispatch_pre_tool_call_hooks`；结果 `action:block` 在工具 body 前返回。MSE 注册 `pre_tool_call`，按固定合同模板返回 block；配置从插件 `guardTemplates` 读取，即 `plugins.entries.mse-learning.settings.guardTemplates`。 | 确认该事件覆盖上述三条实际工具执行路径；Hook API 用 callback lease 在插件卸载时移除，hook dispatch 有时间上限。模板默认空，只有 operator 配置才生效。当前模板只约束工具名、参数对象、必需键与允许键；每模板最多 64 个必需键、128 个允许键、注册最多 32 个。 | 代码路径已接线；DSH 设置页不读取或声称 Hermes 实例的实时状态。不是任意代码 runner，也不构成可信项目测试 attestation。 |
| Project tests | 仓库/Host 事件本身不证明任意 test script 可信或隔离。 | 通用项目测试 runner 与固定 test IDs 仅有保留合同，尚未接入 DSH 项目测试执行，也未连入自动 objective/fair queue/checkpoint/budget。独立支持的根 `package.json` JSON/登记字段类型检查见下方 Structured artifact 行；它不运行项目脚本。不得据此报告项目测试已通过。 | 未接入。 |
| Structured artifact/tool contract | DSH 当前可信 intake 针对根 `package.json` 的固定 checker。 | 确定性检查 JSON 可解析、顶层为对象及已登记字段类型。字段是可选的、未知字段允许；不判断 package manager 语义、依赖可安装性、脚本行为或项目测试结果。摘要/哈希绑定数据，不建立 oracle 信任。 | 根 package checker 已注册时展示该范围；固定参数 guard 是独立能力，不能等同产物检查或任务成功。 |

## 来源身份与 Host 能力绑定

| Host driver | 实际路由来源 | 可声明内容 | 必须拒绝的情况 |
| --- | --- | --- | --- |
| `async_openai_chat` | Hermes `pre_api_request` 的真实 request/body 与经过 resolver 证明的安装驱动 | chat-completions route、规范 endpoint fingerprint、已证明的 reasoning 状态 | resolver/body 不一致、endpoint/API mode 未证明、未知 reasoning、来源 scope 或 control 漂移 |
| `dsh_host_stream` | DSH 成功 `llm/stream` 生命周期持有的 `bridge.taskContext` route，并由该 session 的 `request/header` 与 cwd/目录事实核对 | 实际 Host provider/model；reasoning 为明确值或明确 absent。API mode 与 endpoint 保持 null，不猜测 | route 缺失/不合法、Host header 不同、session/archive/scope/control 状态未知或变化、CAS revision/epoch 过期 |

两种 driver 共用核心 source ledger 的 revision、binding hash、epoch、scope/environment 和 ticket control gate，但执行能力不互相冒充。相同身份重复发布是幂等心跳，不改变 revision；DSH 问题恢复的实际 `reflectionRequest` 冻结并复核 source revision/hash/epoch/control generation。

## 当前执行约束

- `tools.guard()` 必须同步、纯函数、不会等待或读模型；观察/影子记录走有界的非阻塞旁路，不能把异步存储结果冒充执行前决定。
- DSH pre-execute 只可匹配明确注册、具备不可变合同身份的检查；默认 observe，显式 shadow/enforce 经足够反例及正常例验收后才启用。
- guard dispose 后立即停止新 execution 的策略评估；仅保留 dispose 前已由 guard 接纳的 execution lease，直到其 Host `tools/result` 收尾。待处理 lease 有界 64；不会让一个旧 lease 将策略继续施加到后续新调用。
- 支持范围取决于宿主实际提供的接口能力；宽泛 peer 范围本身不构成兼容证明。
- 测试、真实供应商评测、原生 UI、安装与发布是独立验收层；一层通过不能替代另一层。
