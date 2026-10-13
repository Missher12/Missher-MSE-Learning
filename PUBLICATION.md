# MSE 0.9.1 交付说明

[返回桌面与全部插件](https://github.com/Missher12/Missher-DeepseekHarness-Desktop) · [中文用法](README.md) · [English](README.en.md) · [正式下载](https://github.com/Missher12/Missher-MSE-Learning/releases/tag/v0.9.1)

0.9.1 修复设置页“当前用量”读错字段的问题；保守预留与实测 Token 分开显示，缺失数据继续标记未上报。后台学习、预算和保存行为不变。

沿用 0.9.0 增加的预算档位、持久步骤检查点和跨预算窗口续跑。自动流程可以从有来源的失败中形成候选，进行安全评审、有限试用和限定领域的客观验证，再在相关会话中召回；可信失败可以撤回方法。普通经验的有限试用仍标记为未验证，不把模型自评当作客观事实。

预算不足、前台抢占或重启后复用已完成的步骤；已发出但费用或结果未知的请求保持等待，不自动重放。逻辑评测任务和物理模型请求分别计数，已完成步骤不重复计费。Hermes 新进程需要原来源会话重新提供可信路线事实，缺少时明确等待。

## 安装与预算

DSH 下载 `missher-dsh-mse-learning-0.9.1.tgz`，Hermes 下载独立归档；按各自宿主的插件安装方式使用。升级前备份学习库与设置，完成活动任务，再正常重启并回读版本、加载状态及实际控制确认。源码更新、可下载安装包和本机安装是不同步骤。

产品默认保持自动验证关闭、评测 Token 额度 0、任务额度 2。可选暂停、保守 20K/2、标准 50K/5、100K/10、200K/20 或自定义额度；只有明确选择并保存才生效。额度按滚动 24 小时统计，后台评测预算不包含正常聊天或开发用量。自动反思另有开关与频次约束。

召回限制保持每轮 768 UTF-8 字节、每会话 1536 字节、最多 2 条且最多 1 条试用。安装不复制用户学习数据、不自动提高已有额度，也不允许 DSH 和 Hermes 共用一个可写学习库。

## 兼容范围

维护目标是支持合理的宿主版本范围并持续适配最新版。最低能力要求与已测试版本分开：宽松 peer 范围不会证明所有版本已通过，测试基线也不表示只有该版本可用。DSH 需提供 README 所列 Cordis、LLM、设置和客户端接口；独立 CLI/核心需要 Node.js 22.19 或更高版本。

0.9.1 后端与已验 0.9.0 逐字节一致，复用其真实 DSH Host 服务与隔离配置上的自动流程和冷重建证据。Hermes 的真实 SDK/核心集成使用合成 transport；其他宿主、完整跨平台原生界面及真实模型质量仍需各自验证。

## 已验证范围

- 三个冻结包及公开源码逐文件核验：DSH 46 文件、Hermes 22 文件、公开源码 124 文件；路径与文件边界检查通过。
- 0.9.1 最终源码组件/包契约检查 30/30，独立预算档位/保存检查 2/2 通过。124 个源文件相对 0.9.0 只有界面、测试、版本 metadata 和说明共 7 个路径变化。
- 复用后端字节未变的 0.9.0 证据：DSH 包使用 14 个真实 Host 服务运行自动链：失败来源、反思候选、评审、客观验证、召回/采用和可信失败撤回。共 47 次合成请求，包括 6 次前台、1 次反思、4 次评审和 36 次客观验证；真实供应商请求为 0。
- 0.9.0 独立操作系统进程冷重建通过，持久会话、学习、费用与撤回保持，不重放已完成请求。
- 0.9.0 最终公开源码 36 项独立检查通过。先前核心/DSH 108 项回归与 Hermes 21 项集成保留原证据范围；未声称在最终包上完整重跑全部历史测试。
- 0.9.1 的独立预算组件 2 项已重新运行，覆盖各档位、自定义值与旧配置。Hermes 字节未变，复用其 20K 窗口耗尽后重建并恢复剩余步骤、检查点身份不变的证据。

以上证明受控流程和恢复行为，不证明真实模型的长期收益，也不替代各电脑的日常安装和原生窗口验收。旧版真实供应商测试只属于旧版。完整历史归属见 [VALIDATION](VALIDATION.md)。

## 冻结交付件

| 文件 | SHA-256 |
| --- | --- |
| `missher-dsh-mse-learning-0.9.1.tgz` | `ad219a9e04a0d7df541def71764d21f7be76f665797eddbbf3848b5053307387` |
| `mse-learning-hermes-0.9.1.tar.gz` | `6e41f9fb913a6b353c5416769b132d75c0ded6764e85885ad512aa8476e89db5` |
| `mse-learning-0.9.1-source.tar.gz` | `8d721328307d7bbd1b730e142683b9bc443bda95bc1a10dc1a0da2d10ceab84f` |

Git 产品代码和测试逐字节取自冻结公开源码归档；发布阶段仅更新中英文 README、VALIDATION 与本交付说明。下载归档保留构建时的文档，当前发布状态以本说明和 Release 为准。0.9.0 保留历史 Git 标签，正式安装包从 0.9.1 提供。个人学习库、会话、凭据及本机审查材料不进入公开仓库。源码采用 MIT 许可证。

## English summary

Version 0.9.1 fixes settings-page usage mapping and separates conservative reserved budget from measured tokens. Final-package component/contract checks passed 30/30, with 2/2 independent budget checks. Unchanged backend bytes reuse the 0.9.0 synthetic DSH Host flow, cold-rebuild and source evidence. Zero real-provider requests describes isolated validation, not daily operation after a user enables automatic evaluation. Automatic evaluation is off by default with a zero token allowance; users must opt into a budget. Host support follows required capabilities and evidenced version ranges, with continued adaptation to the latest release. Verify installation separately on each computer.
