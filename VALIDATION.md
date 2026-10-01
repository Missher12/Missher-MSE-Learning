> 历史记录：本文保留 2026-09-26、0.8.0-alpha.1 的验证结果。当前源码为 0.9.0-alpha.13，版本与升级入口见 [README](README.md)，后续候选记录见 [PROJECT_CONTEXT](PROJECT_CONTEXT.md)。旧版结果不代表本版已重复完成真实模型或跨平台验收。

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

同场景做了两轮：持久预算账目改造前一次，改造后一次，结果一致。最后独立检查了真实复盘产物：candidate=1、verified=0，明确没有把模型自己的总结升级为正确性证据。结构化记录保存在 `evidence/live-correction-smoke.json` 和 `evidence/live-reflection-smoke.json`；没有保存完整模型响应或凭据。

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
