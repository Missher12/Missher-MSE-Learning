# MSE 0.9.0-alpha.19 交付说明

[返回桌面与全部插件](https://github.com/Missher12/Missher-DeepseekHarness-Desktop) · [项目说明](README.md) · [English](README.en.md)

当前源码来自已经冻结并验收的 alpha.19 公开源码归档。本仓库仅发布产品源码和公开验证材料，不包含个人学习库、会话、模型凭据或本机审查记录。原开发工作区及私有材料保留在维护者本机。

## 本次变化

补齐按来源和项目隔离的问题记账、自动反思候选、评审与有限试用、限定领域验证，以及持久调度和到期恢复。Hermes 增加单一计时链、共享执行与取消、已产生费用的持久记账。未知用量仍为未知；只读设置刷新不会中断任务。

召回仍限制为每轮 768 UTF-8 字节、每会话 1536 字节，最多 2 条，试用最多 1 条。自动验证默认关闭，每日验证 token 预算默认 0；安装不会替用户开启付费评测。

## 验证与安装状态

最终包已完成必要的正常评审、已派发请求取消记账、实际 Hermes PluginManager / AgentLoop 加载及独立进程冷读验证。这些轨迹使用合成 transport，没有新增真实供应商评测；不能据此声称任意任务收益或模型能力已改善。

Ubuntu 的 Missher DSH 0.2.1-alpha.2.20261012.1 已安装下表中的 DSH 包，46 个包文件校验一致，原生 Host 激活和设置 namespace 已核对。学习数据只增加正常恢复的事务 revision，其余字段一致。Hermes 分发包已验收，但日常安装尚未完成；自我进化专用页未单独完成视觉验收，其他平台仍须分别核验。

## 固定交付件

| 产物 | SHA256 |
| --- | --- |
| `missher-dsh-mse-learning-0.9.0-alpha.19.tgz` | `c2908da2ea845134d6723a296daa3b4bcd5b09458317bb8b1cc4fef1bb019588` |
| `mse-learning-hermes-0.9.0-alpha.19.tar.gz` | `89fb049922ec59617005a8a67b7845a1e9da399aa30d53877752780bb274272d` |
| `mse-learning-0.9.0-alpha.19-source.tar.gz` | `fc32cd05ef7ef6e8d1da3436efd3ddf524c0a320c0735d948abcbc174c76ad64` |

本次 Git 同步不代表这些安装包已经上传到 [Releases](https://github.com/Missher12/Missher-MSE-Learning/releases)。只有实际存在对应版本和文件时才使用下载链接；不要把下方旧 README 中的 alpha.18 示例当成 alpha.19 下载地址。

Git 中的运行源码与公开归档一致；README 仅补充当前版本提示，本说明是另外加入的发布文档。既有仓库公开文件保留，未从本机复制私有审查目录。

## English summary

This repository contains the accepted 0.9.0-alpha.19 public source export. It adds durable scheduling, provenance, cancellation accounting, and the Hermes integration described above. Package checks, Host activation, synthetic runtime tests, Git publication, Release downloads, and real-provider outcomes are separate acceptance layers. No new paid model evaluation was enabled. See the SHA256 table for the exact accepted artifacts; Release assets and non-Ubuntu daily installations remain separate delivery work.
