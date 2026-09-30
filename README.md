# MSE Learning 0.8.0-alpha.4

自家插件不再限制 DSH 宿主版本号；运行时按实际接口能力工作。开发依赖版本用于复现构建，不是安装门槛。本轮验证基线为 0.2.0-rc.1 与 0.2.0-rc.2，其他版本尚未验证。

同一个持久学习核心，供 DSH、Hermes 及其他 Agent 分别接入。当前是隔离开发候选：没有替换已安装的 MSE，没有导入旧学习库，也没有改动任何宿主的模型设置。

## 已实现

- 从直接用户消息中学习明确的未来纠错，例如“以后导出金额前先转换为数值，再按金额排序”。经验内容开放，不需要为每一种问题增加代码枚举。
- 在相关新任务开始前召回，并跨进程、跨会话保存。默认宿主独立存储；有权威项目标识时进一步隔离项目。
- 完整经验优先，不截掉否定词或适用条件。无关任务零注入；每轮默认最多 **768 UTF-8 字节、2 条经验**，可设置 128–1536 字节。同一会话每个经验版本仅提供一次，累计提供最多 **1536 字节**，包括说明文字。字节上限不是模型 token 实测值。
- 收据确认经验实际进入宿主消息或成功的模型请求。取消、重复事件、迟到版本和普通“完成”不产生验证通过记录。
- 宿主可信检查器可以报告结果。方法在两个不同会话被采用且检查通过后标为 `tested`；任何失败会降回候选。这表示有通过记录，不能证明方法造成了改善。
- 任务结束后的复盘使用独立短请求：最多 3 次/24 小时，间隔至少 30 分钟，最多输出 384 tokens；摘要最多 800 + 1200 字符。候选不会因为模型自评而升级。复盘不追加到主任务会话。
- 保存经验、摘要哈希及有界计数，不保存完整聊天和工具输出。常见凭据、路径和指令越权模式会拒绝，但过滤不保证覆盖所有敏感信息。
- 文件原子替换、私有权限、写锁、幂等事件。读写失败时跳过学习，保留 Agent 原有任务流程。

## 构建与验证

需要 Node.js >= 22.19；核心没有第三方运行时依赖。Hermes 适配器还需要宿主 Python。Node 可执行文件需在 Hermes 环境的 PATH 中，也可通过 `MSE_NODE_EXECUTABLE` 指定绝对路径。

```sh
npm test
python3 -B -m unittest discover -s tests -p 'test_hermes.py' -v
npm run pack:dsh
```

本轮 `pack:dsh` 仅生成通用 SDK/CLI + DSH Bundle 的 npm 包及源码/产物 SHA-256 清单，不生成新的 Hermes 安装包。Hermes 适配器和既有 alpha.2 包保持原样。联合打包命令 `pack:local` 要求两种适配器的版本一致；版本独立时会拒绝打出名实不符的 Hermes 包。压缩包不包含宿主配置、凭据或学习记录。打包不会安装或发布。

## 接入

DSH：包内 `cordis.patch.yml` 注册 `@missher/dsh-mse-learning/adapters/dsh`。本版将 `@deepseek-ai/dsh-llm` 的宿主版本约束改为 `*`；其他版本应先验收。旧 alpha.2 的 0.1.7-rc.2 声明会被当前宿主拒绝，需使用新的 alpha.4 候选；不要用版本豁免绕过检查。状态位于当前 profile 的 `dshHomePath('mse-learning')`。配置 `reflectionEnabled: false` 可关闭复盘；检测到 `missherEvolutionCore` 时暂停新控制器，避免双重学习。

本版只处理 DSH 兼容；先使用 0.2.0-rc.1 的真实 AgentLoop 和内存假模型核验持久召回、实际请求内容、工具失败、可信结果、独立复盘及卸载重载，并记录验证基线。未发现需要变更适配业务代码的接口差异。学习算法、数据格式和上下文预算保持不变，Hermes 未升级。安装/Loader 检查使用隔离 profile，不等于已经升级日常应用。已知的 DSH 暂停后排队复盘和请求准入失败归因问题仍见源码 `PROJECT_CONTEXT.md`，本版未修复。

Hermes：独立压缩包的根目录为 `mse-learning`，内含 Python Hook 与 `runtime/src`；解压后可放到一个**隔离测试 profile** 的 `plugins/`，再按宿主机制启用。数据位于该 profile 的 `mse-learning/`。默认不接管 `missher-evolution`；旧插件仍启用时新控制器暂停。`MSE_REFLECTION_ENABLED=0` 关闭复盘。若任务模型和配置路由无法可靠对应，跳过复盘。不得把旧插件的数据复制成新格式。

其他 Agent：导入 `LearningEngine`，或用 `mse-learn` / `node src/cli.mjs`，标准输入传一条 JSON，标准输出返回一条 JSON。需要宿主自动调用生命周期才能自动学习；当前没有 MCP Server。

```js
import { LearningEngine } from '@missher/dsh-mse-learning'
const engine = new LearningEngine({
  stateRoot: '/absolute/private/learning-state',
  adapterId: 'my-agent',
  maxContextBytes: 768,
})
const pending = engine.prepare({
  sessionId: 'new-conversation', turnId: '1', origin: 'user',
  projectKey: 'stable-project-id', prompt: '导出金额并排序',
})
// 只在宿主确认 pending.context 实际采用之后：
if (pending.receipt) engine.accept({ receipt: pending.receipt, lessonIds: pending.lessons })
engine.complete({ sessionId: 'new-conversation', turnId: '1', projectKey: 'stable-project-id', outcome: 'unknown' })
```

CLI 请求结构为 `{ "config": { ...构造参数 }, "op": "prepare", "input": { ...参数 } }`。支持 `record`、`prepare`、`accept`、`cancel`、`complete`、`status`、`reflectionRequest`、`reflectionResult`。

这些是**可信宿主接口**；不要把 `record(source=direct_user)`、`accept`、`complete(outcome=verified)` 或复盘结算直接暴露成模型工具。宿主必须识别直接用户输入、确认真正采用，并用独立检查器调用 DSH `ctx.mseLearning.bridge.verification(...)` 或 Hermes `Hooks.verification(...)`。两种适配器均没有自动注册任何能自授验证等级的模型工具。

## 当前限制与验收边界

- 这是 0.8 alpha 的新学习路径，旧版的 UI、导入导出、备份、管理器和完整实验生命周期仍留在原产品中；没有做自动迁移。SDK/CLI 兼容不代表所有 Agent 都已原生接入。
- 自动纠错识别目前要求“以后/下次/今后/from now on/next time”等明确起句，不覆盖所有自然纠错；召回使用本地词项匹配，可能漏掉同义改写。
- 提供了带版本的显式 `record({ supersedes: lessonId, ... })` 替代接口；尚无通用语义冲突裁决。新经验不能覆盖当前用户要求。
- 没有内置适用于任意任务的正确性检查器或执行阻断器。未接入可信检查器时，方法保持候选；正常完成和零退出不能被当作“再也不犯错”。
- 每个主状态库最多 300 条经验、256 个活动收据、2048 个近期事件，最多 2 MiB；经验 90 天过期，收据 30 分钟过期。达到上限会明确返回 capacity，绝不静默清空。会话预算另存为只含哈希、字节数和经验版本的私有小文件，每会话最多 4 KiB，不受会话总数量限制；这些账目会随使用增长，需要与主状态库一起备份。
- 上下文预算按提供内容保守扣费，取消也不返还。宿主压缩历史后，同一会话不会自动补注旧经验。复盘有少量独立模型调用开销，采用当前任务可核验的模型路由；不训练模型权重。
- 原生加载、离线闭环、真实模型行为与长期重复错误率分别验收。测试通过不能代替正式宿主安装和持续效果评估。验证详情见工作区交付记录。
