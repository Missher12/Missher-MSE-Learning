# MSE Learning

中文 | [English](README.en.md) · [桌面端与下载](https://github.com/Missher12/Missher-DeepseekHarness-Desktop)

为 DSH 保存按项目隔离的用户纠错与方法候选，在相关任务中限额召回，并记录可信宿主确认的采用和验证结果。它不训练模型权重，也不保证模型永不犯错。

包名：`@missher/dsh-mse-learning`。**0.9.0-alpha.18 升级候选**增加自动评审、有限试用、限定领域的客观验证和全库总览。分层验收记录见 [VALIDATION](VALIDATION.md)：包含 r2 核心与真实供应商评审，以及 r3 的控制状态差异回归和受控浏览器 UI。日常安装、Release 下载与市场收录仍是独立阶段，本说明不宣称这些阶段已经完成。

alpha.17 的宿主会话标题选择器继续保留。标题仅用于显示，不改变经验归属、召回身份或预算。本轮共享学习核心发生变化，DSH 的自动调度不等于其他 Agent 已具备同样的宿主接线。它与历史产品 `dsh-missher-evolution` 不同，不读取或迁移后者的数据。

## 能做什么

- 保存宿主确认的明确用户纠错；相关任务按作用域、适用条件和预算召回。
- 推断方法先作为候选；安全评审通过可进入有限试用，客观验证通过才成为限定验证范围内的已验证方法。
- 提供“设置 → 自我进化”，查看经验、召回原因、运行状态、手动复盘及预算；支持暂停/恢复和未确认状态提示。
- 已确认的完成结算可跨重启恢复，不重跑模型或工具，不重复计算同一结果的信用。
- `/mse` 查看状态，`/mse why` 查看最近来源与原因，`/mse now <任务>` 只读预演。命令注册在宿主 commands 服务，不作为普通消息发给模型。

召回默认每轮最多 **2 条、768 UTF-8 字节**，每会话最多 **1536 字节**；字节不是 token。召回本身不调用模型。自动复盘可额外使用触发复盘的来源回合所用模型与推理级别，至多3次/24小时、间隔至少30分钟、单次输出最多384 tokens，可在设置关闭。额外模型评测默认 `evaluationTokensPerDay=0`，不会自动启用付费评测。

## 自动评审与验证

- **试用不是已验证收益。** 同一路由的候选/基线独立作答，再由新上下文判官盲评并交换标签复核。满足安全、适用、排除与成本门槛的建议可标为 `reviewed` / `trial`；即使是安全平局，`benefit` 仍为 `unproven`。正文标明“仅供参考·未通过宿主验证”。
- **客观证据决定 validated。** 固定登记算法或 Host 的 `mse-lifecycle-v1` 场景包提供判据，模型只提交答案；模型自评、被注入或声称成功均不是验证事实。领域验证只覆盖请求代次、并发票据与验收证据等登记范围，不证明任意任务收益。
- **自动验证默认关闭**（`autoValidationEnabled=false`），评测 token 预算默认 **0**；显式 0 不发付费评测。开启且有可信路线、非零预算后才运行。自动与手动评测共用滚动24小时额度，先预约后请求，未知成本不能当零。它与已有自动复盘的独立频次限制不同；一项评测可包含多次供应商请求。
- 新候选绑定真实来源会话/回合及路线；缺少可恢复来源的历史候选需**显式选择验证会话**。回填只使用该会话的 provider/model/推理档，不改变经验原项目，不静默借用最近会话的模型。
- 总览区分全库已记录、纠错、待处理、试用、已验证和采用；全库查看不放宽召回 scope。适用条件与排除条件保留，无法解释时仍拒绝召回并显示原因。

试用每轮最多 **1 条**、排在纠错与已验证方法之后，计入既有 **总2条/默认768B、每会话1536B**，不另加上下文额度；试用有期限，可因可信失败/纠错撤回。暂停或关闭自动验证会停止后续步骤，重启后的不确定请求保留中断事实和保守费用，不把同一次请求静默重放。总览、经验详情、状态与诊断读取不写入学习库，也不触发付费任务。设置页还提供人类主动发起的配置保存、启用/暂停与手动复盘/验证操作；这些是写入或调度入口，开启自动验证后可按预算触发后台评测。取消、恢复与预算的已测范围及未测边界见 [验收记录](VALIDATION.md)。

## 安装固定版本

需要已配置模型的 DSH 宿主以及 Node.js ≥22.19.0。包已包含可运行的 JavaScript，不需要安装时构建，也不通过 npm registry 发布；`private:true` 用于防止误发 npm，不限制 GitHub tarball 安装。

以下为 alpha.18 的固定版本资产地址。它是安装示例，不表示资产已发布；必须先确认 Release 中存在同名文件及校验和：

```text
https://github.com/Missher12/Missher-MSE-Learning/releases/download/v0.9.0-alpha.18/missher-dsh-mse-learning-0.9.0-alpha.18.tgz
```

**桌面版**：打开 **插件 → 添加插件**，粘贴该地址；按宿主提示启用/重新加载。随后打开 **设置 → 自我进化**，核对版本和运行状态。桌面 profile 由应用管理，不使用下方 CLI 命令修改它。

**已有 CLI / Web profile**（示例使用 `web`；换成你实际使用的非桌面 profile）：

```sh
dsh plugin --profile web add https://github.com/Missher12/Missher-MSE-Learning/releases/download/v0.9.0-alpha.18/missher-dsh-mse-learning-0.9.0-alpha.18.tgz
```

也可下载并校验 Release 的 `SHA256SUMS` 后安装本地同名 `.tgz`。源码推送、Release 下载、市场收录是独立状态；[Releases](https://github.com/Missher12/Missher-MSE-Learning/releases) 中没有本版资产时，这个地址尚不能用于安装。不要使用带版本文件名的 `latest/download` 链接。

## 开始使用自动验证

1. 安装可下载且已核对校验和的 alpha.18 包，打开 **设置 → 自我进化**，核对版本与启用状态。
2. 开启 **自动验证**。对缺少可恢复来源的历史候选，显式选择一个已配置模型路线的**验证会话**；该会话只提供 provider、模型和推理档，不改变经验原项目。
3. 在评测预算中设置你接受的**非零 token 额度**，并确认评测次数额度允许执行。保存后查看实际控制确认、队列阶段与阻塞原因；有候选不代表会立即晋升。
4. 区分“已记录”“试用”和“已验证”：安全评审可以进入试用，客观验证通过后才在登记领域内标为 validated。关闭自动验证可停止后续自动步骤；自动复盘另有独立开关和频次限制。

默认仍是**自动验证关闭、评测 token 额度为 0**，上述操作不会替你设置预算。评测次数按评测计划计，一项计划可能发出多次模型请求；不要把它当作供应商请求数。页面只读查看不启动模型。

## 验收证据与平台边界

| 环境 | 证据与边界 |
| --- | --- |
| macOS Intel + Missher 定制 DSH 0.2.0-rc.2 | alpha.18 r2 完整 Node 303/303、生命周期 10/10；r3 同冻结真实适配器离线 125/125、控制/提交/停止差异回归 62/62、受控浏览器 UI 189/189。r2 真实评审 54/54，4 次请求共 1437 tokens，仅进入 reviewed/trial/unproven，validated=0。版本归属与复用边界见 [VALIDATION](VALIDATION.md)，不代表日常原生安装验收。 |
| 纯官方 DSH、后续 DSH 版本、Windows、Ubuntu | 本次不宣称完整通过；宽松 peer `*` 只表示不锁宿主版本，不等于接口兼容。 |
| Hermes 0.21.1 | 本轮隔离 Python/Node CLI 回归 53/53，按共享 core、Hermes 适配器及测试输入字节不变复用至 r2/r3；不是新一轮原生 PluginManager 或真实供应商测试。alpha.15 的 PluginManager 结果为历史。当前按 DSH-only 准备分发，不承诺新的 Hermes 发布或日常安装。 |
| 其他 Agent | 可使用 Node SDK/JSON CLI，但需要编写可信生命周期适配；不是安装后自动适配所有 Agent，也不是浏览器 SDK。 |

DSH 必须提供 Cordis、LLM、Typert、Schemastery 与 commands/settings 等服务。完整设置页还需要 `@deepseek-ai/dsh-client-ui-primitives` 静态模块和对应设置扩展点；当前已测组合是 Missher 桌面版。官方依赖由宿主提供，本包不内嵌另一套宿主或兼容包。缺少能力时请附宿主版本及脱敏加载错误反馈，不用版本豁免代替验证。

## 暂停、卸载与数据保留

在 **设置 → 自我进化** 关闭启用开关，并查看持久控制是否已确认；锁忙时显示未确认，不把“设置已保存”当作结算已停止。关闭“自动复盘”可保留召回而停止新的后台复盘；“自动验证”另有独立开关。

卸载前等待任务结束，备份宿主解析的整个 `dshHomePath('mse-learning')` 目录（通常在 DSH 数据根下的 `mse-learning/`），包含 `lessons-v1.json` 和 `sessions/`。桌面版从插件管理卸载本包；CLI / Web 使用相同 profile：

```sh
dsh plugin --profile web remove @missher/dsh-mse-learning
```

插件没有卸载删除数据的脚本；包卸载不会主动清除学习库。要删除个人数据，须先停止相关宿主，并由你自行处理备份及该目录。不要删除整个 DSH 数据根或其他插件目录。DSH 与 Hermes 不共用正在写入的学习库；检测到旧 `missherEvolutionCore` 时，新控制器会暂停。

历史 alpha.15/alpha.16→alpha.17 同属 schema 2、无需迁移。alpha.18 拟沿用 schema 2 可选字段，但最终兼容与回退检查尚未完成；升级前保留完整新鲜备份。schema 1 必须显式迁移；降级到不支持持久结算的旧包前，应先让待结算项结束，或同时恢复对应旧包与升级前的完整备份。详见[数据与回退契约](docs/BEHAVIOR.zh.md#数据升级与回退)。

## 开发与验证

源码包含合成旧库 fixtures，不含用户真实学习记录。测试默认单 worker：

```sh
npm test
node scripts/pack.mjs --dsh-only
node scripts/pack-source.mjs
node scripts/verify-package.mjs
```

每次使用新的源码副本或输出目录；打包器拒绝覆盖已有候选。`MSE_SOURCE_COMMIT` 可标注无 `.git` 导出快照的40位来源提交。隔离 Host 验证脚本接收明确的 tarball、Host modules 和 pnpm 路径；UI脚本要求显式 `MSE_DSH_SOURCE`、`MSE_PLAYWRIGHT_ANCHOR`，不会寻找维护者的电脑路径。历史 alpha8 跨版本探针可用 `MSE_ALPHA4_ENGINE` / `MSE_ALPHA6_ENGINE` 指定旧引擎文件。

[行为细节](docs/BEHAVIOR.zh.md) · [适配协议](docs/ADAPTER_PROTOCOL.md) · [持久结算](docs/DURABLE_SETTLEMENT_OUTBOX.md) · [召回规则](docs/RECALL_2026-09-30.md)

任意自由中文条件尚不能可靠解释，会保守不召回；未确认入队的任务及手动模型作业不承诺跨崩溃耐久。单元/隔离测试、设置页可读和计数增长均不证明长期真实模型收益。本轮真实供应商验收只覆盖有界评审，未执行付费客观两臂验证；受控浏览器 UI 不等于日常原生窗口验收。

## 许可证与来源

[MIT](LICENSE)，Copyright © 2026 Missher。DSH/Cordis/Schemastery 接口来自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，相关包由宿主提供并保留各自许可；Hermes 适配面向 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)。[RRSI 研究说明](docs/RRSI_RESEARCH_2026-09-30.md)记录设计参考，不表示捆绑 RRSI 代码或获得上游背书。
