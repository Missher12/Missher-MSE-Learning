# 学习成果 · Learning outcomes

## 已验证的例子

| 场景 | 隔离 DSH 的实际结果 |
| --- | --- |
| 学会一条纠正 | 普通纠正保存后，在另一个已登记工作区的新会话实际注入。一次性工单留在审计里。 [普通纠正验证](../VALIDATION.md#1316-单次工单边界) |
| 发现漏召回 | 1.3.16 漏掉两次同题匹配。1.4.0 的候选在两个独立会话中都补齐了匹配。 [同题对照](../VALIDATION.md#140-同题召回改进) |
| 验证后启用，复发后退回 | 达标后，同项目的新会话拿到 149 字节的原生注入回执，另一工作区的会话没有收到这条项目方法。匹配失败复发后，下一会话停止注入。 [原生宿主验收](../VALIDATION.md#140-同题召回改进) |

这组验收使用本地固定模型适配器，工作区、会话、工具执行和注入回执来自原生 DSH。候选的启用证据包括两项独立收益和两项独立对照。 [证据门槛](../VALIDATION.md#1315-旧纠正的原生路线接续)

## 在测试工作区试一条

在已登记的测试工作区用 DSH 命令栏保存一条项目规则：

```text
/mse --when "生成 JSON 配置" 生成 JSON 配置后先做一次 JSON.parse 检查。
```

在同一工作区开一个新会话，提出相关的 JSON 配置任务。「自我进化 → 经验」可以看规则的范围和版本。「召回 → 注入记录」可以确认新会话实际收到了哪个版本。

## 在仓库复现召回检查

```sh
node scripts/replay-recall.mjs
node scripts/replay-recall.mjs --ranker=irrelevant-first
```

| 1.4.2 的公开回放 | 人工标注用例 | 漏召回 | 误召回 |
| --- | ---: | ---: | ---: |
| 正常排序 | 24 | 0 | 0 |
| 故意有缺陷的对照 | 24 | 6 | 26 |

第二条命令预期退出码为 1。两条命令只读公开夹具，模型调用和日常学习库读写均为 0。 [回放代码](../scripts/replay-recall.mjs) · [公开夹具](../tests/fixtures/recall-cases.json)

## English

In the [controlled DSH run](../VALIDATION.md#140-同题召回改进), the 1.4.0 policy recovered two misses from 1.3.16. After qualification, a new session in the same project received a 149-byte native recall receipt. The other workspace did not receive that project method. A matching recurrence stopped the offer in the next session. The run used a fixed local model adapter with real DSH workspaces, sessions, tool executions, and recall receipts.

To try a project rule in a registered test workspace, enter `/mse --when "Generate JSON configuration" Use JSON.parse to check generated JSON configuration.` in the DSH command bar. Open a related task in a new session. Check **Lessons** for the saved rule and **Recall** for the version actually offered.

Run the two commands above from the repository root to reproduce the 1.4.2 replay. Across 24 labelled cases, normal ranking reports zero misses and false offers. The deliberately faulty ranking reports 6 misses and 26 false offers and exits with status 1. Both runs use only the public fixtures.
