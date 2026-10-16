# MSE Learning

中文 | [English](README.en.md) · [桌面端与下载](https://github.com/Missher12/Missher-DeepseekHarness-Desktop)

为 DSH 保存按项目隔离的用户纠错与方法候选，在相关任务中限额召回，并记录可信宿主确认的采用和验证结果。它不训练模型权重，也不保证模型永不犯错。

包名：`@missher/dsh-mse-learning`，版本 0.10.0。提供宿主来源任务证据、受限 package.json 工件检查、坏/正常轨迹回放，以及 DSH/Hermes 适配。当前证据按验收层分别列于[验证记录](VALIDATION.md)；功能与能力边界见[实施说明](docs/AUTONOMY_0.10.0.md)。原生桌面与官方 Web 的界面复验、包校验和下载说明见[0.10.0 交付记录](PUBLICATION.md)。完整测试套件、各电脑日常安装及真实付费模型效果不在本次已验证范围内。

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
- **自动验证默认关闭**（`autoValidationEnabled=false`），评测 token 预算默认 **0**；显式 0 不发付费评测。自动与手动评测共用滚动24小时额度，先预约后请求，未知成本不能当零。
- **评测预算档位**为暂停、20K/2、50K/5、100K/10、200K/20 和自定义；任务按滚动24小时内至少发出一次物理请求的不同 ticket 计数，同一任务的多个步骤只计一次。真实物理供应商请求另行计数。旧配置缺失预算字段时继续 0/2；只有明确选择档位并保存后才生效。
- DSH 与 Hermes 自动评测保存逐步请求身份、结果和用量；续跑复用已完成步骤，费用未知的已 dispatch 步骤不会重放。Hermes 新进程只在原 source session 再次报告可信 `pre_api_request` 路由后继续；无法重新证明来源时保持等待。
- 新候选绑定真实来源会话/回合及路线；缺少可恢复来源的历史候选需**显式选择验证会话**。回填只使用该会话的 provider/model/推理档，不改变经验原项目，不静默借用最近会话的模型。
- 总览区分全库已记录、纠错、待处理、试用、已验证和采用；全库查看不放宽召回 scope。适用条件与排除条件保留，无法解释时仍拒绝召回并显示原因。

试用每轮最多 **1 条**、排在纠错与已验证方法之后，计入既有 **总2条/默认768B、每会话1536B**，不另加上下文额度；试用有期限，可因可信失败/纠错撤回。暂停或关闭自动验证会停止后续步骤，重启后的不确定请求保留中断事实和保守费用，不把同一次请求静默重放。总览、经验详情、状态与诊断读取不写入学习库，也不触发付费任务。设置页还提供人类主动发起的配置保存、启用/暂停与手动复盘/验证操作；这些是写入或调度入口，开启自动验证后可按预算触发后台评测。取消、恢复与预算的已测范围及未测边界见 [验收记录](VALIDATION.md)。

## 安装状态

0.10.0 已完成下列隔离验收。请从[正式下载页](https://github.com/Missher12/Missher-MSE-Learning/releases/tag/v0.10.0)获取对应安装包并核对校验值；Git 和下载包更新不表示各电脑已安装。具体范围见[交付记录](PUBLICATION.md)。

## 开始使用自动验证

1. 从项目正式 Release 页面确认版本与校验和后再安装。
2. 开启 **自动验证**。对缺少可恢复来源的历史候选，显式选择一个已配置模型路线的**验证会话**；该会话只提供 provider、模型和推理档，不改变经验原项目。
3. 在评测预算中设置你接受的**非零 token 额度**，并确认评测次数额度允许执行。保存后查看实际控制确认、队列阶段与阻塞原因；有候选不代表会立即晋升。
4. 区分“已记录”“试用”和“已验证”：安全评审可以进入试用，客观验证通过后才在登记领域内标为 validated。关闭自动验证可停止后续自动步骤；自动复盘另有独立开关和频次限制。

默认仍是**自动验证关闭、token 额度为 0、任务额度为 2**；旧配置缺失预算字段也按 0/2 处理。预算档位由用户明确选择并保存。任务数与真实物理请求数分别统计；页面只读查看不启动模型。

## 设置页示例

以下两张图使用同一 0.10.0 安装包、隔离配置和合成数据，自动验证关闭。

官方 npm DSH 0.2.1-alpha.5 的实际 Web 中文设置页；保存、刷新回读与放弃编辑已验证。

![官方 alpha.5 中文设置页（合成数据）](docs/images/official-alpha5-zh-r11.png)

社区 Desktop 0.2.1-alpha.2.20261014.1 在 Linux 上的真实最小窗口（520×600）；英文导航使用宿主下拉菜单，五项均可打开正确页面。

![原生最小窗口的英文导航（合成数据）](docs/images/native-en-minimum-r11.png)

[旧版英文截图](docs/images/en-normal.png)仅保留历史布局，不代表当前界面。

## 验收证据与平台边界

| 环境 | 证据与边界 |
| --- | --- |
| 0.10.0 核心与宿主证据 | 自动调度 11/11；Hermes 单实例完整链路 61.156 秒；官方 npm DSH alpha.5 Loader 在正常、缺少 fs、缺少 tools 三种条件下通过。范围及限制见 [验证记录](VALIDATION.md)。 |
| alpha.18 Intel Mac 历史候选 | 303/303 Node、125/125 离线适配器、189/189 受控 UI，以及 4 次真实评审调用都只属于历史候选。不能将其作为当前候选、日常安装或本轮真实 provider 证据。 |
| 纯官方 DSH、后续 DSH 版本、Windows、Ubuntu | 本次不宣称完整通过；宽松 peer `*` 只表示不锁宿主版本，不等于接口兼容。 |
| Hermes 0.21.1 | 历史适配器/核心层 Stage 4c 离线集成 21/21，含 20K 窗口、重建 driver/pass 和原 session 可信路由事件；本轮隔离原生 PluginManager 单实例验收另列于上方，不重复计数，也不是真实供应商调用。 |
| 其他 Agent | 可使用 Node SDK/JSON CLI，但需要编写可信生命周期适配；不是安装后自动适配所有 Agent，也不是浏览器 SDK。 |

DSH 必须提供 Cordis、LLM、Typert、Schemastery 与 commands/settings 等服务。完整设置页还需要 `@deepseek-ai/dsh-client-ui-primitives` 静态模块和对应设置扩展点；当前已测组合是 Missher 桌面版。官方依赖由宿主提供，本包不内嵌另一套宿主或兼容包。缺少能力时请附宿主版本及脱敏加载错误反馈，不用版本豁免代替验证。

## 暂停、卸载与数据保留

在 **设置 → 自我进化** 关闭启用开关，并查看持久控制是否已确认；锁忙时显示未确认，不把“设置已保存”当作结算已停止。关闭“自动复盘”可保留召回而停止新的后台复盘；“自动验证”另有独立开关。

卸载前等待任务结束，备份宿主解析的整个 `dshHomePath('mse-learning')` 目录（通常在 DSH 数据根下的 `mse-learning/`），包含 `lessons-v1.json` 和 `sessions/`。桌面版从插件管理卸载本包；CLI / Web 使用相同 profile：

```sh
dsh plugin --profile web remove @missher/dsh-mse-learning
```

插件没有卸载删除数据的脚本；包卸载不会主动清除学习库。要删除个人数据，须先停止相关宿主，并由你自行处理备份及该目录。不要删除整个 DSH 数据根或其他插件目录。DSH 与 Hermes 不共用正在写入的学习库；检测到旧 `missherEvolutionCore` 时，新控制器会暂停。

历史 alpha.15/alpha.16→alpha.17 同属 schema 2、无需迁移。0.10.0 继续使用 schema 2 的可选字段；正式升级时仍应先保留完整新鲜备份。schema 1 必须显式迁移；降级到不支持持久结算的旧包前，应先让待结算项结束，或同时恢复对应旧包与升级前的完整备份。详见[数据与回退契约](docs/BEHAVIOR.zh.md#数据升级与回退)。

## 开发与验证

源码包含合成旧库 fixtures，不含用户真实学习记录。测试默认单 worker：

```sh
npm test
node scripts/pack.mjs --dsh-only
node scripts/pack-source.mjs
node scripts/verify-package.mjs
```

每次使用新的源码副本或输出目录；打包器拒绝覆盖已有候选。`MSE_SOURCE_COMMIT` 可标注无 `.git` 导出快照的40位来源提交。隔离 Host 验证脚本接收明确的 tarball、Host modules 和 pnpm 路径；UI脚本要求显式 `MSE_DSH_SOURCE`、`MSE_PLAYWRIGHT_ANCHOR`，不会寻找维护者的电脑路径。历史 alpha8 跨版本探针可用 `MSE_ALPHA4_ENGINE` / `MSE_ALPHA6_ENGINE` 指定旧引擎文件。

[自动改进实施说明](docs/AUTONOMY_0.10.0.md) · [行为细节](docs/BEHAVIOR.zh.md) · [适配协议](docs/ADAPTER_PROTOCOL.md) · [持久结算](docs/DURABLE_SETTLEMENT_OUTBOX.md) · [召回规则](docs/RECALL_2026-09-30.md)

任意自由中文条件尚不能可靠解释，会保守不召回；单元/隔离测试、设置页可读和计数增长均不证明长期真实模型收益。本轮没有真实 provider 调用；alpha.18 的历史真实评审不属于当前版本证据。界面截图只证明社区 alpha.2 英文设置页的合成数据布局，不代表 alpha.5 原生 UI 或日常安装验收。

## 许可证与来源

[MIT](LICENSE)，Copyright © 2026 Missher。DSH/Cordis/Schemastery 接口来自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，相关包由宿主提供并保留各自许可；Hermes 适配面向 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)。[RRSI 研究说明](docs/RRSI_RESEARCH_2026-09-30.md)记录设计参考，不表示捆绑 RRSI 代码或获得上游背书。
