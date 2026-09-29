# MSE Learning 产品上下文

更新：2026-09-29。本文件仅描述 `learning-product/`；工作区分工以 [PROJECT_GOVERNANCE.md](/Users/missher/Documents/Deepseek-harness-Cordis/PROJECT_GOVERNANCE.md) 为准。当前执行 UPGRADE-20260929 中 MSE 独立导出的 DSH 兼容适配，不参与其他插件业务开发。

## 当前兼容性候选：0.8.0-alpha.3 / DSH 0.2.0-rc.1

- 唯一源码入口不变。基于父工作树 `5dc7842964a6fdf4113ad115d89be3a08c433027` 及前次 alpha.2 的既有未提交改动继续工作，保留旧包、旧文档和既有修改。
- 只读 SDK：`/Users/missher/Documents/Projects/03-DeepSeek-Harness/升级候选/cordis-0.2.0-rc.1-20260929`，HEAD `c7c457e5e07fa11a04bf8764d5f89585d789f258`。先验证真实 AgentLoop 中的用户消息、session/event、tools/result、复盘路由及卸载行为，再将 llm peer 精确改为 `0.2.0-rc.1`；不使用通配声明或版本豁免。
- 新增 `scripts/verify-dsh-agent.mjs`，只注册内存 fixture adapter，不调用真实供应商。它分别验证原适配业务代码及最终候选的行为，和安装准入验证分层报告。
- 学习核心与 DSH 适配业务代码无修改；Hermes 目录（包括 alpha.2 manifest）、配置和部署无修改。新增 `pack:dsh` / `--dsh-only` 只生成 DSH npm 候选和来源清单，避免随 DSH 升级产生未经授权的 Hermes 新版。
- 本轮候选输出：`dist/0.8.0-alpha.3/`。分层验收、包 SHA256 及剩余限制见 [专属升级回执](/Users/missher/Documents/Deepseek-harness-Cordis/coordination/2026-09-29/upgrade-020/mse.md)。安装由协调会话统一审核执行；本会话不写生产 profile、不重启应用、不提交/推送 Git。
- 已知 MSE-AUD-01/02 继续保留为历史待修问题，本次没有扩大为学习算法或后台控制器重构。字节预算、状态作用域和数据格式均保留。

## 2026-09-28 兼容性修复历史：0.8.0-alpha.2

- 基于下述 `5dc7842` 本地源码，版本升级为 `0.8.0-alpha.2`；DSH peer 从精确 `0.1.5-rc.2` 改为精确 `0.1.7-rc.2`，Hermes 包版本同步。没有扩大为未经验证的通配范围，也不添加版本豁免。
- 核心算法、宿主适配业务代码、数据格式及上下文预算不变；下面 MSE-AUD-01/02 两项已知问题仍待另行修复，不能把此次兼容修复说成已解决它们。
- `verify-dsh.mjs` 补充真实宿主兼容性门槛；新增 `verify-dsh-install.mjs`，用宿主实际包操作与 pnpm 在临时 profile 复现旧包拒绝、验证新包安装及 Bundle 组合。打包时关闭 macOS 附带元数据，重新生成候选来源与载荷清单。
- 新候选输出单独存放在 `dist/0.8.0-alpha.2/`；alpha.1 的归档及清单保留原样。对应分层结果记录在该目录 `VALIDATION.md`，它是此次安装候选的验收记录。
- 本次不改日常 profile，不重启应用，不迁移旧数据，不执行 Git 写操作；候选安装通过与生产已安装分开报告。

## 首轮审查基线与历史记录

- 唯一源码入口：`/Users/missher/Documents/Deepseek-harness-Cordis/mse/learning-product`。
- 父工作树 HEAD：`5dc7842964a6fdf4113ad115d89be3a08c433027`；该提交中的产品目录 tree：`662e575cfbf3ddcdbe57f26c55575bb50d931e29`。审查开始时工作树干净。
- 产品版本仍为 `0.8.0-alpha.1`；npm 清单的 `private: true` 保留。这是独立的新学习路径，不能按版本号直接覆盖旧 MSE/Hermes 产品。
- [2026-09-28 Git 同步记录](/Users/missher/Documents/Deepseek-harness-Cordis/GIT-PUSH-20260928-REFRESH.md) 记载：仅本目录导出到公开 `Missher12/mse-learning`，公开 main 为 `60aa2ddb04c6e559a21b17950ec59a5092b639bd`。这是协调记录，本轮没有联网重新核验远端。父仓库仍按私有范围处理。
- [VALIDATION.md](/Users/missher/Documents/Deepseek-harness-Cordis/mse/learning-product/VALIDATION.md) 是 **2026-09-26 的历史实验记录**；其中“当前代码未提交”不代表本轮状态，历史真实模型实验也不算本轮实测。原文保留用于追溯。
- 工作区根 [PROJECT_CONTEXT.md](/Users/missher/Documents/Deepseek-harness-Cordis/PROJECT_CONTEXT.md)、[HANDOVER.md](/Users/missher/Documents/Deepseek-harness-Cordis/HANDOVER.md) 及父项目旧文档保留历史用途，不作为全工作区或本产品的最新总表。
- 本轮完整证据、限制和后续建议见 [MSE 审查回执](/Users/missher/Documents/Deepseek-harness-Cordis/coordination/2026-09-28/mse.md)。新增文档未提交、未推送；旧授权不延续为新 Git 操作授权。

## 产品目标与归属

MSE 用一个与宿主无关的持久学习核心，加上 DSH/Cordis、Hermes 等宿主的薄适配器，保存用户纠错和方法候选，在相关任务中有限召回，并记录可信宿主提供的采用与检查结果。它改善的是经验复用过程，不训练模型权重，也不保证从此不再犯错。

| 事项 | 归属和边界 |
| --- | --- |
| 持久经验、版本替代、相关召回、采用收据、结果归因、受限复盘 | MSE 主责；SDK/CLI 供其他宿主接入，不等于所有 Agent 已原生支持 |
| 请求准入、压缩历史、当前会话只读上下文视图和累计用量 | context-manager 主责；MSE 不注册第二套压缩器 |
| 会话身份、实时跨会话投递、工作区操作 | session-bridge 主责；MSE 跨会话复用经验不发送消息 |
| 跨会话 token、费用、工具与技能用量统计 | usage-statistics 主责；MSE 的 adopted/verified/failed/inconclusive 是学习证据计数 |
| 图片附件、输入引用、模型能力设置、输出布局 | 对应工作区负责人；本轮四项新需求没有转入 MSE，也没有开始实现 |

保留的既有功能：MSE 的学习上下文预算和独立短复盘请求。它们分别限制新增经验内容、产生方法候选，不因名称涉及“上下文”或“总结”而迁入其他插件；也不把其他插件的实现复制进本包。

## 上下文成本与证据含义

- 默认每轮最多 **768 UTF-8 字节、2 条完整经验**，配置范围 128–1536 字节；同一会话累计最多 **1536 字节**，包括提示外框。同一经验版本仅提供一次，跨重启保存；不相关任务返回空文本。
- 上述预算只计 MSE 提供的新增文本，是字节上限，不是模型 token 实测或整个上下文窗口。账目在提供时保守预留；取消或主库提交失败不返还。
- 宿主压缩历史后，同会话不会自动补注已提供的经验版本。这是现有限制；不得通过清空预算账目或重复注入规避上限。
- 复盘独立于主会话：最多 3 次/24 小时、间隔至少 30 分钟、输出上限 384 tokens，输入摘要最多 800 + 1200 字符。它有额外模型调用成本，产物只成为候选。
- DSH 目前在经验消息写入会话的 `user/message` 事件上确认采用；这证明消息提交，**不证明远端模型收到该内容**。Hermes 则核对最终请求中的文本与请求 ID，并在成功的 `post_api_request` 后确认采用。二者不能混成同一层证据。
- `verified` 必须由可信宿主检查器报告，不能靠普通完成、模型自评或工具零退出自动获得。方法需在两个不同会话被采用并通过检查，且无失败记录，才能成为 `tested`；它仍不是因果效果证明。
- `host_verifier` 是可信宿主接口契约，不是加密认证。宿主必须守住接口调用权，不能把自授采用、验证或复盘结算直接暴露给模型工具。

实现入口：[核心预算与召回](/Users/missher/Documents/Deepseek-harness-Cordis/mse/learning-product/src/index.mjs:128)、[结果归因](/Users/missher/Documents/Deepseek-harness-Cordis/mse/learning-product/src/index.mjs:198)、[DSH 消息提交确认](/Users/missher/Documents/Deepseek-harness-Cordis/mse/learning-product/adapters/harness.mjs:47)、[Hermes 请求确认](/Users/missher/Documents/Deepseek-harness-Cordis/mse/learning-product/adapters/hermes/bridge.py:92)。

## 宿主、数据与旧控制器隔离

- DSH 状态根来自当前 profile 的 `dshHomePath('mse-learning')`，`adapterId=dsh`；Hermes 使用加载时捕获的 profile 下的 `mse-learning/`，`adapterId=hermes`。Hermes 后台复盘显式恢复该 profile 的上下文绑定。
- 核心校验宿主/实例归属；有权威 projectKey 时进一步按项目隔离。跨宿主复用实现不意味着共用一个状态目录。不得迁移、读取或覆盖旧 Hermes 学习库。
- DSH 检测 `missherEvolutionCore`，Hermes 检测 `missher-evolution` 时暂停新学习控制器。当前 DSH 的暂停存在下面登记的复盘队列缺口，不能笼统宣称所有后台活动都会立即停止。
- 日常配置、模型/推理设置、已安装插件和已有产物保持原状。后续会写文件的测试和构建继续使用隔离副本及临时 profile。

## 2026-09-28 审查结论与待办

本轮 **9 项 Node 针对性测试 + 4 项 Hermes 针对性测试通过**；冻结包的真实 Cordis、Hermes PluginManager 加载和生命周期检查通过，均使用临时数据及受控服务，真实模型调用为 0。这不是全量测试、生产 UI、完整工具任务或长期学习收益验收。

两个问题已用临时探针复现，尚未修改业务代码：

1. **MSE-AUD-01：DSH 暂停后，已排队复盘仍可启动并保存候选。**暂停只清理活动回合，没有使已排队或已开始的复盘失效。后续应在 MSE 适配器中增加控制器代次、请求取消及结算前检查；保留既有经验。
2. **MSE-AUD-02：尚未发出模型请求的准入失败，被归到经验失败。**DSH 先按消息提交确认采用，再把所有回合错误映射为 failed；上下文准入阻断可发生在 provider 调用之前。后续应区分消息提交、请求采用和实际检查结果；未发出的准入失败不得直接惩罚经验。不改动 context-manager 合理的准入保护，也不追改历史学习记录。

兼容性还有两项待核验：包的可选精确 peer 仍为 DSH `0.1.5-rc.2`，本轮使用 Cordis `4.0.4` / DSH `0.1.7-rc.2` 的直接 Loader 检查通过，但普通安装器的 peer 解析未验收；旧候选全源码清单与当前 `.gitignore` 有一处哈希差异，冻结安装包哈希及受检运行文件一致。完整清单检查未通过，不能用局部载荷一致代替。

后续最小顺序：修复 MSE-AUD-01 的暂停/结算竞态并覆盖回归；补齐 MSE-AUD-02 的宿主请求阶段证据；再隔离验收安装器和 peer 范围，重新生成新的候选包与清单。每一步单独报告；正式安装、真实模型和 Git 发布另按当时明确授权执行。
