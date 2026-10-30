# 验证记录（当前候选：0.16.0-rc.5）

当前候选 **0.16.0-rc.5** 仅同步版本与文档，运行代码沿用已验证的 **0.16.0-rc.4**（历史）。源码检查不代表任何设备安装，安装结果以对应回执为准。

## 0.16.0-rc.3（源码检查批次）

0.16.0-rc.3 上下文判断修正头：DSH 完整假 provider 套件 **169 tests / 164 pass / 0 fail / 5 skipped（exit 0）**。后续上下文绑定复核：Codex 独立原 7 例、引用/临时 3 例及最后历史状态借授权反例均有通过记录。本段是该批次的源码检查，不与下节 rc.2 历史批次混写；真实 provider 例子与安装不以离线结果代替。

当前验证入口（本仓库内可直接运行，使用临时库、合成事件与假 provider，不读取真实学习库）：

```sh
node --test rebuild/rebuild.test.mjs      # 真实学习库/私有 fixture 的少数用例需显式环境变量，否则如实 skip
node scripts/replay-recall.mjs            # 开发者只读召回回放（24 例人工标注回归；零模型、零 live 库）
node scripts/pack.mjs --dsh-only          # 打包候选（发布方环境执行）
node scripts/pack-source.mjs              # 白名单源码归档 + 原始 tar 成员核查（发布方环境执行）
node scripts/verify-package.mjs           # 包成员白名单 + 干净进程 API 冒烟（发布方环境执行）
```

## 0.16.0-rc.2（历史主仓批次）

0.16.0-rc.2 批次（含 REVIEW-FIX1/FIX2 与 NATURAL-GATE-FIX / NATURAL-PREDICATE-FIX 修正头）在最终改动头实际运行（真实 rc.4 SDK/假 provider，无私有 env，本机 2026-10-30）：

- 完整套件一次：**148 tests / 143 pass / 0 fail / 5 skipped（exit 0）**。5 个 skip 全部是未提供私有 fixture 的 opt-in 真实跳过：L1、R4、M6、D21a、E5c（E5c 为真实旧库只读备份副本迁移，需 `MSE_EVOLUTION016_LIVE_LIBRARY`）。另在本地用备份副本定向运行 E5c：format3 读取→临时目录原子迁移到 format4，旧行逐字保留、`legacy_partial` 不造统计/证据、备份文件 hash 不变（pass，未读取真实运行库）。
- 版本证据：format3 纯读取不重写、首次真实写一次性原子迁移；当前版窗口与家族累计分开；晚到 checker/复发只结算准确版本，缺证据保持不可归因；取消/unknown/guard 不作方法成功或失败；取消“3 次家族复发永久停整条”。
- 修订与容量：修订提交同时复核父版与已失败历史版机制（大小写/参数敏感）；历史行按自身冻结来源+当前 sourceGuard+材料重审（撤回/未知来源只留固定原因）；partial 不补造、完整旧法未知统计只 since_upgrade；修订 system 带 ≤6 条/1536 B 相关旧版结果；同机制确定性拒绝 `repeated_mechanism`；有效换版同事务归档旧版、重置窗口并清空 `evidenceHash`；发请求前容量预检。临时合法库实测：128 条历史触顶时 `finishWork` 整事务回滚（状态文件 hash 不变、请求未结算、历史未删）；接近 2 MiB 的合法库与“剩余空间小于该版实际归档行”的库均在模型前可读等待 `storage_capacity`、零新请求；不可表示的归档行拒绝而非截断。
- 召回回放（开发者工具）：24 例（6 类×4）人工标注回归，基线复现 ID/顺序/字节（`miss 0 / falseOffer 0 / critical 0`）；注入“无关规则优先”错误排序后 `critical 32 / miss 6 / falseOffer 26` 且退出码 1，字节总量不抵消关键回归；未标注案例单列、不计正确。**该 24 例是回归集，不是盲测**。
- REVIEW-FIX1（Codex 独立复现的 9 项反例）：A→B→A 已失败机制拒绝、大小写机制区分、撤回来源历史不入 prompt、partial 晚到结果不升级、取消后晚到 checker 不记分、native JSON checker 按实际 offered 版、guard 不伪造检查失败、legacy needs_revision 保守警示、emoji 合法 instruction 归档逐字节——全部转绿；Codex 探针另存复跑 9/9 通过（原 CODEX-REVIEW1.json 不变）。
- NATURAL-GATE-FIX（普通纠正准入）：否定识别改用 Node 内置 ICU 词边界（不再从分别/区别/类别/识别/特别中截「别」），来源与候选复用同一识别；正向限定说明仅在按顺序重新肯定被禁行动（代替/重复运行等）且共享 ≥3 bigram 时判反转，仅共享对象不误判；真实否定分句/对象反转/项目/临时保持原严格判定。E9 对修正前 FIX2 头 3 pass/4 fail → 初次修正 7/7；其后确认两条同谓词肯定句仍误收，改为真实谓词与受约束对象匹配，不要求“拿/用”等结构词逐字相同。最终 E9 8/8、定向 F/M/N+E9 29/29；Codex 独立原四例 4/4（两条保存并跨项目召回，两条矛盾拒收）。真实失败与原红证据保留。
- REVIEW-FIX2（Codex 同链边缘 5 项）：工具/checker/JSON 选择共用回执归因（取消首个晚到工具失败、历史 stats=null 晚到工具均不记 complete）；当前版本出生/修订冻结自身有界来源快照且归档只拷旧快照（多来源不丢、超限未知、旧正文进修订前先过来源+材料）；guard 带具体 failurePattern（两 guard 各自可辨、不重放旧步骤/不伪造检查）；容量预检按真实事务（request/material/ticket/迁移/归档/结果）在 provider 前可读等待——全部转绿；Codex 探针另存复跑 5/5、FIX1 原 9 例 9/9（原红证据不变）。
- 保留并复验：C1/C2 observer 隔离、W1 真实 Cordis gateway source-mode、普通纠正/问题/引文/条件停用、真实 workspaceRegistry 与 material 首次持久化前 realpath、单后台槽/暂停/每日 23:00 水位、官方徽章与当前精简公开源码树。

## 0.16.0-rc.4（真实 UI/范围验证）

- UI：真实 rc.3 打开学习状态时实际暴露 `[object Object]` 渲染缺陷；rc.4 修复后实际 CUA 通过，学习状态无 `[object Object]`，全局/项目两条决定中文可读。UI wiring/W1/CS18 **3/3 pass**，非 UI runtime 与已验证批次逐字节一致。
- 范围：真实普通纠正无需「记住/跨项目」口令自动保存 → 另一 workspace 注入并遵循；项目内规则同工作区可见、其他工作区不注入；临时要求不产生持久规则。上述均有对应实际记录，安装结果以回执为准。

范围与未验证（如实）：

- 离线假 provider 结果不代替真实模型的长期业务效果；安装后的原生页面/五页详情与长会话验收由发布方的原生环境完成，以独立回执为准。UI 只读改动已接线并有状态投影/静态检查，rc.1 的五页与插件详情已在真实宿主查看；rc.2 沿用相同 UI，安装后的版本与新增数据仍以实际回执为准。
- 自动产物检查目前仅接入项目 JSON 解析检查，结论仅覆盖该检查；exit 0 或模型自述成功不构成客观验证。
- 自然语言纠正提取不保证识别任意表达；同机制判定只覆盖“步骤+检查”的确定性同指纹，换词绕过属于未覆盖语义边界；来源不明的历史材料按“来源待确认”拒收。
- 方法历史有界（≤128 条/每条 ≤6144 B，总 2 MiB 不变）；旧 `superseded` 仅能迁成 partial 记录，超出 128 条的旧快照不会被补造或分摊。历史无限保存与 2 MiB 容量不能同时承诺。
- 宽松 peer 版本范围不证明宿主接口一定存在；未测宿主/平台组合不宣称兼容。真实 provider 回归与日常安装结论只以各自回执为准，本批未执行。
- 本文记录源码检查结论；打包与本机安装结果以对应版本的交付回执为准。本批不发布、不提交、不推送。
