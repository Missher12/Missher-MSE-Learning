# MSE Learning 验收记录

版本：0.10.0。本文区分已验证切片与尚未验证的发布层。单项离线或 Loader 通过不代表完整套件、真实模型效果、原生 UI、正式 Release 或日常安装通过。

## 当前证据

| 验收层 | 结果 | 证据与边界 |
| --- | --- | --- |
| 自动调度 | 11/11 | `auto-scheduler` 定向离线回归；不代表全量测试通过。 |
| 私有陈旧快照恢复 | 4 次扫描、2 次冷启动 | 隔离私有快照副本，仅公开无正文汇总；启用且配置 mock 预算时仍为 0 dispatch，11 步 checkpoint、计划与终态保留。仅证明离线经济幂等性。 |
| Hermes 原生 Host 完整链路 | 通过，单实例 61.156 秒 | 精确 r8 归档在隔离 profile 的已安装 Hermes PluginManager / lifecycle / model_tools 上真实派发；真实 CLI/core，fake HTTP transport。完成反思→12+4 与 replay→晋升→召回/采用→反证撤回→冷读 1/1；355 次 CLI 操作，无 `TimeoutExpired` / `lock_busy`，未访问外网。此为离线替身 provider 验收，不计作真实 provider 调用。首次锁持有者历史原因未知；不据此调整锁实现。 |
| 官方 DSH npm alpha.5 Loader | 3/3 场景通过 | 正常加载、缺少 fs、缺少 tools；正常场景使用真实 `fs-local`。证明 Loader 与缺失能力降级，不证明 alpha.5 原生 UI 或完整 DSH 插件验收。 |
| 实际界面与截图 | 两宿主通过；2 张当前截图 | 社区 alpha.2 Linux 原生桌面及官方 npm alpha.5 Web；中英文宽窄导航、保存/回读/放弃、同页语言切换保留草稿/会话/当前页、正式停用清理。截图与精确包见 [交付记录](PUBLICATION.md)。旧图仍作为历史保留。 |
| 设置客户端契约修正 | 源码语法检查通过；`details-client` 30/30 通过 | 父级受限检查回执：组件回归 30/30、0 失败、0 跳过。随后真实窄窗、语言热切换与 alpha.5 保存均通过，详见交付记录。 |
| 完整测试套件 | 未验证 | 本轮未运行完整套件。 |
| 真实 provider / 真实付费效果 | 未验证 | 本表所述隔离验收未调用真实 provider；不覆盖历史日常运行或其费用。 |
| 正式 Release / 日常安装 | 分别核对 | 安装包下载与校验值见 [交付记录](PUBLICATION.md)；各电脑日常安装不由源码、包或隔离 UI 验收替代。 |

## 能力与兼容边界

- package checker 只检查根 `package.json` 的 JSON 语法、顶层对象及登记字段类型；不检查包管理器语义、依赖能否安装或项目测试是否通过。
- DSH alpha.5 Loader 场景不是 UI 或完整生命周期验收。截图对应社区 alpha.2 英文设置页，不能外推至 alpha.5、官方原生 UI 或其他语言/尺寸。
- Hermes 当前证据来自真实已安装 Host 的隔离 profile，使用离线替身 provider；不是生产 profile 或真实供应商运行。
- 未测试的宿主版本不作兼容承诺。宽松 peer 范围本身不能证明所需接口存在；其他 Agent 仍需可信生命周期适配器。
- 自动验证默认关闭，评测 token 预算默认 0。历史版本、其他宿主和长期真实模型收益不由本记录证明。

## 数据与公开包范围

公开包使用 `scripts/public-set.mjs` 的单一 allowlist。维护交接、协调资料、私有探针、个人学习数据、隐藏目录和本地构建产物不属于公开内容。截图为合成数据，不含用户真实记录。
