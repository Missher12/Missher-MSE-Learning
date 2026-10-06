# MSE Learning

中文 | [English](README.en.md) · [桌面端与下载](https://github.com/Missher12/Missher-DeepseekHarness-Desktop)

为 DSH 保存按项目隔离的用户纠错与方法候选，在相关任务中限额召回，并记录可信宿主确认的采用和验证结果。它不训练模型权重，也不保证模型永不犯错。

包名：`@missher/dsh-mse-learning`。本版 **0.9.0-alpha.17** 修复经验、召回、任务页的会话选择：优先显示宿主中的对话标题，重名和未命名对话用短 ID 区分。标题仅用于显示，不改变经验归属、召回身份或预算；共享学习核心与 Hermes 适配器保持 alpha.15 原样。它与历史产品 `dsh-missher-evolution` 不同，不读取或迁移后者的数据。

## 能做什么

- 保存宿主确认的明确用户纠错；相关任务按作用域、适用条件和预算召回。
- 推断方法先作为候选；只有符合可信评测或登记算法检查要求的方法才进入日常召回。
- 提供“设置 → 自我进化”，查看经验、召回原因、运行状态、手动复盘及预算；支持暂停/恢复和未确认状态提示。
- 已确认的完成结算可跨重启恢复，不重跑模型或工具，不重复计算同一结果的信用。
- `/mse` 查看状态，`/mse why` 查看最近来源与原因，`/mse now <任务>` 只读预演。命令注册在宿主 commands 服务，不作为普通消息发给模型。

召回默认每轮最多 **2 条、768 UTF-8 字节**，每会话最多 **1536 字节**；字节不是 token。召回本身不调用模型。自动复盘可额外使用当前任务的模型，至多3次/24小时、间隔至少30分钟、单次输出最多384 tokens，可在设置关闭。额外模型评测默认 `evaluationTokensPerDay=0`，不会自动启用付费评测。

## 安装固定版本

需要已配置模型的 DSH 宿主以及 Node.js ≥22.19.0。包已包含可运行的 JavaScript，不需要安装时构建，也不通过 npm registry 发布；`private:true` 用于防止误发 npm，不限制 GitHub tarball 安装。

本版 Release 发布后，固定资产地址为：

```text
https://github.com/Missher12/Missher-MSE-Learning/releases/download/v0.9.0-alpha.17/missher-dsh-mse-learning-0.9.0-alpha.17.tgz
```

**桌面版**：打开 **插件 → 添加插件**，粘贴该地址；按宿主提示启用/重新加载。随后打开 **设置 → 自我进化**，核对版本和运行状态。桌面 profile 由应用管理，不使用下方 CLI 命令修改它。

**已有 CLI / Web profile**（示例使用 `web`；换成你实际使用的非桌面 profile）：

```sh
dsh plugin --profile web add https://github.com/Missher12/Missher-MSE-Learning/releases/download/v0.9.0-alpha.17/missher-dsh-mse-learning-0.9.0-alpha.17.tgz
```

也可下载并校验 Release 的 `SHA256SUMS` 后安装本地同名 `.tgz`。源码推送、Release 下载、市场收录是独立状态；[Releases](https://github.com/Missher12/Missher-MSE-Learning/releases) 中没有本版资产时，这个地址尚不能用于安装。不要使用带版本文件名的 `latest/download` 链接。

## 已测范围与要求

| 环境 | 证据与边界 |
| --- | --- |
| macOS Intel + Missher 定制 DSH 0.2.0-rc.2 | alpha.15 已做实际 Loader、设置/命令 RPC、日常加载及数据保留验收；alpha.17 增加会话标题读取与选择器显示，隔离标题接口和客户端检查单列；本轮未重做原生视觉验收。 |
| 纯官方 DSH、后续 DSH 版本、Windows、Ubuntu | 本次不宣称完整通过；宽松 peer `*` 只表示不锁宿主版本，不等于接口兼容。 |
| Hermes 0.21.1 | alpha.15 曾通过隔离 PluginManager/CLI 验收；本次仅发布 DSH 包，Hermes manifest 仍为 alpha.15，没有新的 Hermes 发布或日常安装。 |
| 其他 Agent | 可使用 Node SDK/JSON CLI，但需要编写可信生命周期适配；不是安装后自动适配所有 Agent，也不是浏览器 SDK。 |

DSH 必须提供 Cordis、LLM、Typert、Schemastery 与 commands/settings 等服务。完整设置页还需要 `@deepseek-ai/dsh-client-ui-primitives` 静态模块和对应设置扩展点；当前已测组合是 Missher 桌面版。官方依赖由宿主提供，本包不内嵌另一套宿主或兼容包。缺少能力时请附宿主版本及脱敏加载错误反馈，不用版本豁免代替验证。

## 暂停、卸载与数据保留

在 **设置 → 自我进化** 关闭启用开关，并查看持久控制是否已确认；锁忙时显示未确认，不把“设置已保存”当作结算已停止。关闭“自动复盘”可保留召回而停止新的后台复盘。

卸载前等待任务结束，备份宿主解析的整个 `dshHomePath('mse-learning')` 目录（通常在 DSH 数据根下的 `mse-learning/`），包含 `lessons-v1.json` 和 `sessions/`。桌面版从插件管理卸载本包；CLI / Web 使用相同 profile：

```sh
dsh plugin --profile web remove @missher/dsh-mse-learning
```

插件没有卸载删除数据的脚本；包卸载不会主动清除学习库。要删除个人数据，须先停止相关宿主，并由你自行处理备份及该目录。不要删除整个 DSH 数据根或其他插件目录。DSH 与 Hermes 不共用正在写入的学习库；检测到旧 `missherEvolutionCore` 时，新控制器会暂停。

同属 schema 2 的 alpha.15/alpha.16→alpha.17 无需迁移。schema 1 必须显式迁移；降级到不支持持久结算的旧包前，应先让待结算项结束，或同时恢复对应旧包与升级前的完整备份。详见[数据与回退契约](docs/BEHAVIOR.zh.md#数据升级与回退)。

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

任意自由中文条件尚不能可靠解释，会保守不召回；未确认入队的任务及手动模型作业不承诺跨崩溃耐久。单元/隔离测试、设置页可读和计数增长均不证明长期真实模型收益。完整平台、原生视觉和真实供应商效果需分别验证。

## 许可证与来源

[MIT](LICENSE)，Copyright © 2026 Missher。DSH/Cordis/Schemastery 接口来自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，相关包由宿主提供并保留各自许可；Hermes 适配面向 [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)。[RRSI 研究说明](docs/RRSI_RESEARCH_2026-09-30.md)记录设计参考，不表示捆绑 RRSI 代码或获得上游背书。
