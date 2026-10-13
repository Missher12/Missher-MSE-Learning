# MSE Learning 验证记录

## 0.9.0 最终交付

正式交付采用 rev3 冻结运行包，精确摘要和分层验收见 [PUBLICATION](PUBLICATION.md)。最终包通过 14 个真实 DSH Host 服务上的隔离自动流程及独立进程冷重建：47 次合成请求、0 次真实供应商请求；最终源码另有 36 项独立检查通过。Hermes 的 20K 跨窗口断点恢复及预算组件检查按未变字节复用已有证据。

下面保留开发阶段和历史版本记录，其中“未发布”、rev2 路径与早期真实模型结果只描述各自当时状态。源码发布、安装、原生界面和真实模型质量分别验收；不能用正式 Release 标记替代后几项。

## 开发阶段记录：2026-10-13，0.9.0 发布前候选

本节只记录本轮候选源码和离线验收，不代表已发布、已安装到日常环境或做过真实付费 provider 调用。本轮真实 provider 调用 **0**。

| 层级 | 结果 | 证明范围与边界 |
| --- | --- | --- |
| Node 核心/DSH 定向回归 | 108/108 通过；stage3-chain 9/9 通过 | 原核心回归含真实自动计划调用链、滚动 24h 任务与物理请求计数、跨窗口 reserve→start 事务重核；另复跑改动相关 DSH chain |
| DSH 生产 callModel + scheduler checkpoint | 1/1 通过 | 真实 DSH `callEvaluationModel`、Node 核心和 `createAutoValidation.scan`；无绑定票据确认为 30 分钟，跨日过期后 scheduler 新票重新准入，已完成步骤复用，剩余物理步骤继续；message ID 不参与身份，route/content/effort/output cap 变化被拒绝 |
| Hermes Stage 4c | 21/21 通过 | 真实 Hermes bridge/driver/pass、真实 Node 核心和已存在的 SDK 环境；provider 使用内存假 transport，不发外部请求。20K 窗口先保存 22 个 step，跨日重建 driver/pass 后保留相同 stepKey/requestHash，只发剩余 14 个，总计 36 个唯一步骤 |
| Hermes 来源边界 | 通过 | 新进程只在原 session 的 `pre_api_request` 事实重新到达后续跑；不以全局 resolver 猜原 session 路由。缺少新鲜证明时安全等待 |
| 设置组件审查 | 2/2 通过 | 独立审查覆盖预算档位、旧缺省 0/2 与显式保存；不是原生 DOM/视觉或日常安装验收 |
| JS/Python 语法检查 | 通过 | Node `--check` 与 Hermes Python `py_compile` |
| 包构建/manifest/SHA | 通过 | `dist/0.9.0-final-20261013-luna-rev2/` 三个产物均与 manifest 匹配；`verify-package` 的源码覆盖、Hermes/SDK 同 core 与便携检查通过 |
| 原生安装、Release、日常预算 | 未执行 | 未发布、未安装、未更改日常配置；50K/5 仍需用户明确保存后才会在目标环境生效 |

滚动任务上限计算不同 ticket：当前 24 小时窗口内至少 dispatch 一次才计为任务；同一 ticket 多步骤只计一次。物理请求另计。已完成 checkpoint 的身份包括 provider、model、reasoning effort、system、用户内容和输出上限；DSH 宿主生成的临时 message ID 不属于有效 provider 请求内容，因此不参与 hash。未知费用的已 dispatch 步骤不会重放。

自动评审可因假 transport 的 judge 内容而结束为 `review_inconclusive`；本跨日测试证明的是计划/账务恢复和 checkpoint 复用，不代表评审收益。`benefit` 仍为 `unproven`；试用不是已验证收益。客观验证只覆盖登记领域。没有真实 provider 调用，不能据此声称实际模型质量或长期收益已通过。

---

## 历史记录：2026-10-07，0.9.0-alpha.18 交付候选

以下数据只属于 0.9.0-alpha.18 历史候选，不代表当前 0.9.0 候选的验收结果。旧 r2/r3 的测试、供应商和 UI 证据保留其原始版本归属，不能替代本页上方的本轮证据。

| 层级 | 结果与版本归属 | 证明范围与边界 |
| --- | --- | --- |
| Node 完整测试 | r2 303/303 | 核心、预算、持久队列、适配及既有逻辑；r3 的 DSH index 差异另验，不称 r3 完整重跑 |
| Hermes Python / Node CLI | 53/53，按不变字节复用至 r2/r3 | 共享 core、Hermes 适配器和相关测试输入已核对；本轮未重做原生 PluginManager、Hermes 真实供应商或日常安装 |
| 真实 DSH 适配器，离线固定供应商 | r3 同冻结复验 125/125（r2 亦通过） | 评审 55、客观轨 38、Host 状态负例 32；使用真实 Cordis/MSE 生命周期接线，零外部调用 |
| 生命周期 | r2 10/10 | 该阶段覆盖已约定的恢复边界；r3 的提交与控制差异另验，不以离线结果代替真实供应商中断行为 |
| r3 控制 / 提交 / 停止差异 | 同冻结 62/62 | 控制状态22（6+8+8）、提交竞态27、实际暂停8、卸载5；覆盖首次同值通知、持久启用/暂停状态与晚到写回，避免只读页面引发虚假的控制事务 |
| r3 受控浏览器 UI | 189/189，21 张截图 | 精确 UI 包，三种尺寸与明暗主题，选择项标签/高亮、长文本/错误、只读阶段学习数据严格字节比较；零模型调用。不是日常原生窗口点击验收 |
| 真实供应商有界评审 | **r2** 54/54；4 次请求，共 1437 tokens | 使用来源路线 deepseek-account / deepseek-flash / max。实际进入 reviewed/trial，benefit=unproven，validated=0、verified=0；停止后续客观评测，未运行付费客观验证轨，也未证明日常自动运行 |
| 日常安装 / Release / 市场 | 未在本记录中宣称完成 | 下载示例只有 Release 中存在同名资产和校验和才可用；源码发布、可下载和市场收录各自确认 |
| 其他平台 / 长期收益 | 未证明 | 不宣称纯官方 DSH、后续宿主、Windows/Ubuntu 原生全兼容，不保证所有 Agent 自动接入或永不犯错 |

### 如何解释这些结果

离线评审包含历史完整适用/排除条件、显式验证会话回填与新反思真实来源保存，再通过真实 prepare/accept/complete 接线检查召回和采用。中性但安全的建议只能进入 reviewed/trial；其收益仍为 unproven，不能增加 validated。试用正文保留条件和未验证标签。

离线客观轨由 Host 固定检查器检查 18 组两臂回答；模型只提供答案，不能自授验证信用。通过只建立登记领域内的验证结论。缺失 usage、截断、取消，以及来源删除、路线变化、前台任务开始等负例都必须实际触达对应故障，不能靠“没有调用模型”算通过。

真实供应商证据仅是一次有界评审：4 次请求不等于 4 个评测计划，1437 tokens 是这些请求报告的实际用量，不是每日额度或保守预约值。验收使用的隔离预算配置不改变产品默认值：自动验证仍默认关闭、评测 token 预算仍为 0。评审后的真实前台采用与真实客观两臂验证未在这次付费运行中执行；相关接线由上面的离线适配器测试证明。

所有试用继续占用既有上下文额度：每轮总计最多 2 条、默认 768 UTF-8 字节，每会话 1536 字节，其中试用最多 1 条，优先级低于纠错与已验证方法。全库可见不扩大项目 scope；原条件不能为通过测试而删除。自动/手动评测共用额度并先预占，未知成本不当零；复盘保留独立的 3 次/24小时、30分钟冷却和384输出 token 限制。

### 候选身份与复用边界

- r3 冻结清单 SHA-256：`30930501d24c2a8cfc6f520604a303a68df3ed5088d6fe2f2f5e81c2ca65fc37`。
- r2 真实评审所属冻结清单 SHA-256：`d41d9eb4aa0ddd81b7f7d04db7506ea6b7778f3dbe2d055410f71a68798bd48d`。
- r3 已验 UI 包 SHA-256：`8b9ad2d87eac48ed5045972796b5ba4e0c70d0ddc129bcb3771c13aa1e956e5a`。它标识本次 UI 验收包；文档合并后重新归档的发行包有自己的校验和，不应沿用此值。
- Hermes 53 项复用基于运行文件及测试输入核对；公开包装 metadata 和测试文件无语义的尾部空白差异不伪称所有文件原字节相同。DSH index 的改动不在 Hermes 运行路径内。

公开记录只保留方法、计数和边界，不包含个人经验正文、真实会话/经验标识、凭据或维护者机器路径。开发/打包入口见 [README](README.md)，数据与回退约束见 [BEHAVIOR](docs/BEHAVIOR.zh.md)。受控测试不能替代长期对照评估。

---

## 以下为历史记录：0.8.0-alpha.1（2026-09-26）

下方原始记录按原文保留，只证明该历史版本。当时的宿主版本、测试数量、安装状态、模型与命令不属于 alpha.18 本轮验收，也不能覆盖上方的现行证据与限制。

# MSE Learning 0.8.0-alpha.1 验证记录

日期：2026-09-26。候选源码位于本工作树的 `learning-product/`；原 MSE 源码、已安装插件、实际学习库与模型设置均未替换。

## 分层结果

| 层级 | 结果 | 实际证明的范围 |
| --- | --- | --- |
| JavaScript 核心 / DSH 桥接 / 复盘 | 22/22 通过 | 跨进程保存、范围隔离、采用收据、版本替代、可信结果、取消、并发、损坏保留、预算、复盘限额 |
| Hermes Hook 回归 | 8/8 通过 | Node 子进程调用、真实请求匹配、原生错误状态、子任务过滤、会话重置、旧控制器冲突、卸载迟到结果 |
| 打包 Cordis 加载 | 通过 | 从 npm 包加载真实 Cordis 4.0.2；注册、事件分发、卸载重载、学习召回、提交确认、重复抑制及旧控制器暂停 |
| 打包 Hermes 加载 | 通过 | 真实 PluginManager 解析并加载压缩包；9 个 Hook、重载召回、请求采用、卸载清理、profile 及后台复盘隔离 |
| 真实模型纠错召回小样本 | 通过 | 当前 qwen3.7-plus / ultra，新会话采用已学偏好，独立检查 JSON 值与排序通过；额外上下文 177 字节，无关任务 0 字节 |
| 真实模型方法提炼 | 通过 | 同一配置路由在 384 输出 tokens 上限内生成一个开放方法候选；verified 计数保持 0 |
| 正式宿主安装、完整 Agent 工作流 | 未执行 | 未升级日常 profile，未进行原生 UI 或完整工具调用型任务验收 |
| 长期重复错误率 / 泛化收益 | 未证明 | 小样本和宿主检查记录不能代替长期对照评估 |

运行环境：macOS；Node v25.6.0；Hermes v0.21.1，检验时源码 SHA `0e9fc2cc15`，宿主 Python 3.11.15；Cordis 4.0.2 和 DSH 0.1.5-rc.2 使用本机已安装的官方包。未运行 Windows/Linux 原生验收，也未验证最低 Node 版本环境。

## 上下文与学习预算

- 完整注入文本（含标题、类型标签）默认每轮 ≤768 UTF-8 字节，最多 2 条；配置最多 1536 字节。
- 同会话的同一经验版本仅提供一次，跨重启仍保留；整段会话累计 ≤1536 字节。20 轮新经验回归覆盖累计上限。
- 会话账目保存为哈希文件，无 256 会话总数量限制；单个文件 ≤4 KiB。主库提交失败时，已经保留的预算不返还，防止恢复后超额注入。
- 无关问题返回空上下文。当前匹配是本地词项匹配，不是 embedding，也不调用额外检索模型。
- 复盘单独请求，不进入主对话；输入摘要 ≤800 + 1200 字符，输出 ≤384 tokens，最多 3 次/24 小时，间隔 ≥30 分钟。
- 以上“字节”是严格实现上限，不是所有模型的实际 token 数。模型输出 token 上限也不代表网络请求总耗时。

## 真实模型实验如何解释

合成任务要求把两条金额记录升序导出 JSON。基线未被告知自定义字段和单位要求，未输出后续偏好的结构；因此不能把基线判成一般能力错误。随后只在纠正会话中说明：字段用 `id`、`amount_cents`，金额从元转为整数分。

核心结束进程后，在全新会话只再次给出原任务，没有在用户提示中重述要求。MSE 召回 177 字节经验；真实模型输出与独立预期 `[{"id":"B","amount_cents":250},{"id":"A","amount_cents":1235}]` 相同。宿主检查器授予一次 verified 记录。另一个无关问题的召回为空。

同场景做了两轮：持久预算账目改造前一次，改造后一次，结果一致。最后独立检查了真实复盘产物：candidate=1、verified=0，明确没有把模型自己的总结升级为正确性证据。当时的结构化记录为 `evidence/live-correction-smoke.json` 和 `evidence/live-reflection-smoke.json`；这些历史文件不纳入当前 0.9.0 公开源码归档，此处只保留历史结论，不作为新版验收。

这证明了“已有偏好跨会话影响行为”和“开放方法可生成候选”两条路径，尚不能证明任意错误被主动阻断、同义改写完全召回、所有 Agent 都能自动接入或长期效果提升。

## 复现命令

在 `learning-product/` 执行：

```sh
node --test --test-concurrency=1 tests/*.test.mjs
python3 -B -m unittest discover -s tests -p 'test_hermes.py' -v
npm run pack:local
node scripts/verify-package.mjs
node scripts/verify-dsh.mjs dist/missher-mse-learning-0.8.0-alpha.1.tgz /absolute/host/node_modules
/absolute/hermes/venv/bin/python -B scripts/verify-hermes.py dist/mse-learning-hermes-0.8.0-alpha.1.tar.gz /absolute/hermes
```

真实模型脚本会发起小量真实调用，使用当前 Hermes 配置路由与推理设置；仅输入脚本内的合成内容：

```sh
/absolute/hermes/venv/bin/python -B scripts/live-smoke.py /absolute/hermes
/absolute/hermes/venv/bin/python -B scripts/live-smoke.py /absolute/hermes --reflection-only
```

各宿主加载脚本使用临时 profile，不加载或复制日常学习库。Hermes profile 隔离测试故意把进程 `HERMES_HOME` 指向另一临时位置，验证控制器和后台复盘仍使用加载时的 profile。该测试的首个复盘夹具只有 7 字符，被“摘要不足 8 字符”门槛正确跳过；补成完整任务后回归通过，没有降低门槛。

## 交付与剩余事项

`dist/candidate-manifest.json` 记录基线 SHA、所有候选源码哈希及两个安装包 SHA-256。当前代码未提交，产物未发布。核心 SDK、CLI 与两个宿主适配器都属于这份新增候选；旧版的 UI、管理器、备份/迁移流程不在此包中。

正式升级前还应覆盖完整原生 Agent 任务、更多同义任务和负例、明确错误的真实检查器、新旧语义冲突及旧库可回滚迁移。当前主库最多 300 条经验、90 天有效期；达到容量时明确停止新增并保留原记录。不得把这些边界描述成无限学习或保证永不重犯。
