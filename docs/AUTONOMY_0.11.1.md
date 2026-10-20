# 0.11.1 决策模型设置 / Decision model settings

选择“跟随来源会话”时，MSE 使用经验来源会话的模型，页面只显示必要说明。选择 OpenAI 兼容、Jev 或 Laya 后，会展开模型名称、服务地址和密钥环境变量名；切换来回保留草稿，保存与取消使用原来的设置流程。

这次统一了字段宽度、标签和间距，并修正 Hermes 包遗漏本说明文档的问题。学习核心、预算、调度和模型调用没有变化。密钥字段填写环境变量名称，不填写密钥内容；保存设置不会发起连接测试。

31 项客户端检查通过。隔离 Ubuntu 社区 0.2.1-rc.2 原生界面已验证中文、英文、四种后端、键盘选择、草稿保留、正确保存后的磁盘回读和取消；实际内容宽约 311 / 559 像素。宿主弹窗宽度有限，没有修改宿主去凑 700 像素。本轮没有新模型请求，也没有重新验证 0.11.0 核心或其他平台。

See [delivery status and checksums](../PUBLICATION.md) and [validation history](../VALIDATION.md).

When following the source session, MSE uses the experience source session's model and shows only a short explanation. Choosing OpenAI compatible, Jev or Laya reveals the remote fields. Drafts survive switching, and the existing save/discard flow remains in use.

This patch aligns labels, fields and spacing and includes the missing release note in the Hermes package. Core, budgets, scheduling and model calls are unchanged. The secret field takes an environment-variable name, not a secret value; saving does not probe the service.

All 31 client checks passed. Native Chinese/English layouts and save/discard behavior were checked in an isolated Ubuntu community 0.2.1-rc.2 desktop at approximately 311/559 content pixels. No new model calls, repeated core acceptance, or other-platform native acceptance were performed.
