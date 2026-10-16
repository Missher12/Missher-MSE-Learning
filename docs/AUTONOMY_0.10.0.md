# 0.10.0 自动改进能力与宿主能力矩阵

本文说明当前产品行为与已知宿主边界。验证证据、版本范围及未完成验收见根目录 `VALIDATION.md`。
设置页截图仅为社区 alpha.2 英文版旧 inline 验证会话行的历史合成布局；不作为当前 stacked/wide 选择器或窄屏中文布局验收。

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
