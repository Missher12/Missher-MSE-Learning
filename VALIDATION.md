# 验证记录

## 1.3.5 瘦身与跨平台核心验证

- 封面 2172×724、RGB 解码像素逐字节一致，转为无损 WebP；编码工具仅用于构建，安装包不增加运行依赖。移除的旧写入器和演示试验函数在当前运行/开发闭包中无调用；保留实际 getMethod 及 LearningError/check/MAX_STORE_BYTES 契约。
- 原生平台用例不覆盖 process.platform，也不替换原生文件系统：检查旧库兼容、实际写入/重开/快照、同目录替换失败、符号链接/目录联接拒收、JSON 检查、跨进程锁和跨项目召回。Windows 路径语义另有定向检查。测试只使用临时目录，不接触 live 库或真实 provider。
- [Core portability 工作流](https://github.com/Missher12/Missher-MSE-Learning/actions/workflows/portability.yml) 覆盖 Windows、macOS、Linux 的 x64/ARM64，在最低 Node 22.19 与 Node 24 下运行。具体通过结果以对应提交的真实运行记录为准。
- 上述为核心 OS/文件系统与路径验证；不等于每种 DSH 宿主版本或桌面界面的端到端验收。日常 macOS DSH 的安装、UI 和数据保留按本版交付回执核对。未验证组合（包括移动端独立宿主、特定网络盘/ACL、其他架构）不宣称可用。
- 宿主通道检查另覆盖原生 `bash` 与 `pwsh`：同样的 Cordis source-mode 配对案例分别运行，通过结果、失败结果、外部材料、取消、晚到、回合/步骤/调用错配，以及入队后工具名被替换均有断言。Windows PowerShell 的结构化前台结果与本机 SDK `@deepseek-ai/dsh-tool-pwsh` 契约对照；这不冒充 Windows DSH 桌面端到端运行。

## 1.3.3 Windows 存储与路径兼容

- 在独立进程中模拟 Windows 缺少 `process.getuid`、POSIX 权限位及目录句柄的接口限制，修复前旧库读写复现 `state_unavailable`，修复后真实临时文件读写、重新打开、独占导出、写前失败保留旧库及写后同步失败告警均通过。不是 Windows 实机测试。
- Windows 盘符、UNC、大小写与长路径前缀的同根判断通过；兄弟目录、跨盘和 `..` 逃逸仍被拒收。原生适配器的注册工作区/普通纠正、带空格路径、外部材料首次持久化前拒收均有定向检查；Windows 使用实际 TEMP 根，不把普通 `C:\tmp` 工作区按 POSIX 名字排除。
- 完整标准假 provider 套件：332 tests / 327 pass / 0 fail / 5 skip（跳过既有需显式私人快照的检查）。随后 Windows TEMP 根分支的最终定向检查见本次交付记录。原有 UID/权限、目录同步、并发锁和损坏库保护保持有效。未进行真实模型付费回归。
- Windows 使用 DSH 用户目录继承的 ACL；文件同步、同目录替换与替换后文件同步均要求成功。Windows 不冒充 POSIX 目录 fsync；Windows 实机、具体 ACL/杀毒软件/网络文件系统及断电恢复尚未验证。macOS 的日常安装与数据保留以发布交付回执为准。

## 1.3.2 活动页视觉与投影

- 按 Usage 统计的摘要栏、配色、分段按钮、热力图和提示适配 MSE；纯投影沿用每日记录、周汇总及 `beforeWindow` 基数。首/末不完整周和窗口外记录有定向断言。
- 客户端与用例语法检查通过；六页 UI wiring 及日/周/累计投影检查 1/1 通过。独立复核确认首周计数、本周截止日和非空显示、累计不重复计数。未重跑未变全套或性能测试，未改 Usage 源码或 MSE 后台运行模块。本段记录源码检查，实际宿主验收随 Release 交付。

## 1.3.1 活动热力图修复（源码检查）

- 原生页面实测发现：365 个日期按钮都渲染可见计数（包括 0），15px 固定方格与 `max-content` 让日历横向尺寸约为设置面板两倍；每个新月份固定 `span 4`，末月越出列界并与相邻短间隔月份重叠。
- 候选改为无可见文本的原生方形按钮，保留日期/数量 `aria-label`、`title`、选择态与选中区间统计；图表采用共享 53/54 周列、移除错位的左侧星期缩写、固定紧凑最小宽度和容器内横向溢出；月份标签占用至下一月起点的列区间，末月右对齐且完整显示，区间不越过实际列数。
- `node --check` 对客户端和 UI 用例通过；六页 UI wiring 的受影响渲染检查 1/1 通过，覆盖 53/54 列、365 个日期按钮、无可见数字、日期与计数标签、月份区间不重叠/不越界及所选统计。按本次纯 UI 范围未重跑 1.3.0 的完整套件或性能测量。
- **检查范围：** 本节记录客户端源码与渲染检查，不将它当作实际宿主验收；最终包、原生安装与实际页面结果见 [v1.3.1 发布记录](https://github.com/Missher12/Missher-MSE-Learning/releases/tag/v1.3.1)。

## 1.3.0

- **只读统计与就绪说明：** Activity 从当前保留记录派生统计，不写学习库；已对实际保留记录做只读核对，学习记录与导入记录分开计算，原文件不变。独立审核确认候选的 discovery 不计入门槛，旧 v1 分数不继承，来源、目标版本、隔离与待修订原因按当前证据呈现。
- **pytest 检查器：** 只识别安全白名单内的直接 pytest 或 `python -m pytest` 命令；要求退出码和唯一完整摘要一致，零测试及非结论状态不通过。真实进程样本：1 passed → pass；1 failed → fail；零测试退出 5 → unknown；默认进度样式的 1 passed → pass。样本不保存完整输出进学习库。
- **原生钩子测量：** 冻结 1.2.2 与候选以真实 Cordis `agent/pre-step` 接线做 30 组配对测量（小库 1,730 B；近容量库 1,925,018 B），四种冷热/库大小组合的语义比较均一致。大库 pre-step p95：热态 286.75→260.91 ms，冷态 297.76→281.16 ms；读取 10→8 次，写入与 fsync 均保持 4 次。小库热态 turn-end p95 为 136.35→149.88 ms；大库冷态 pre-step、工具结果、turn-end 三段总时长 p95 为 671.46→698.55 ms，不能据此宣称完整链路更快。该测量不含模型响应，不代表宿主 SLA。原始配对数据和测量脚本保留在本地验收记录中，不上传私人运行材料。
- **源码检查：** 定向检查通过；标准假 provider 套件 exit 0，325 项 / 320 pass / 0 fail / 5 个 opt-in skip，138.179 秒。skip 是未提供私有真实状态副本的 L1、R4、M6、D21a、E5c。第一次全套曾 exit 1，原因和修正后的完整输出保留在本地检查日志。完整套件后只调整了任务提示文案及相应断言；最终 UI wiring 渲染定向检查 1/1 通过。
- **验证边界：** 上述性能与开发检查使用真实 Cordis 接线及隔离样本，不代表模型长期收益或宿主 SLA。日常安装、六页实际界面和数据保留的验收记录留存在本地；1.3.0 未推送、打标签或发布。纯对话没有客观检查时仍记为 unknown。

## 1.2.2

- 冻结 1.2.1 基线中，同特征 observing v1 未创建 successor；补丁后的独立复核仅 observing 建立 1 个 fresh v2，isolated、needs_revision/guarded 与 cancelled 均为 0 个。v2 初始为 positives 1、controls 0、observing；旧 v1 行不变。
- 后续复核序列为 discovery `1/0` → holdout `2/0` → control `2/1`（positives/controls）；v2 保持 observing，legacy v1 逐字段未变。旧历史 counters 3/4 未被继承。继续增加第二项独立增益与第二项负控后，v2 自动批准；实际引擎选择该方法时注入 117 字节。可归因的竞争目标反例使策略自动隔离，下一回合不再选用。此闭环在隔离临时库运行，没有给生产候选注入测试证据。
- 临时副本 read/write 复核仅作用于副本：format 4，46 条经验与 4 条策略均保留；读取不重写文件。真实生产库、配置与 provider 未触碰。
- 本机定向验证：adaptive engine 全文件 13/13、原生 Cordis bridge 1/1、既有原生诊断 1/1；源码用例为 `rebuild/adaptive-engine.test.mjs`、`rebuild/adaptive-legacy-host.test.mjs`、`rebuild/rsi-native-diagnostics.test.mjs`。Cordis 检查使用真实上下文与临时状态，provider stub 禁止模型调用，不能据此声称生产候选已经自动达标。完整仓库套件和真实模型回归未运行。

## 1.2.1 候选

- step 1 引擎调用链用 frozen 1.2.0 与候选 1.2.1 做 32 组配对比较：p50 146.702→99.773 ms，p95 157.603→109.502 ms；facts/route/prepare 降为 2 次事务（原 3 次），每次提交仍保留文件与目录同步。结果仅覆盖临时库中的实际引擎调用，不代表完整 Cordis hook 或宿主/模型 SLA；详见 `delivery/performance121/RESULTS.md`。
- 针对事务合并、无效路由、重复 prepare、format3 迁移、验证默认值、容量 partial-success 与 step2 早退的定向用例：7/7 通过。标准全套 exit 0：311 tests，306 pass、0 fail、5 skipped（132.366 s；stderr 空）。原始输出见 `delivery/performance121/final-suite.stdout`。

## 1.2.0 候选（历史验证）

- 原生 Cordis 事件检查：实际 probe 的失败→pending→settled、外部材料拒绝、取消、无客观结果保持 unknown、无 probe 普通工具事件不记录、最多 32 条、字段脱敏与重启清空，1/1 通过；测试假 provider 会在任何模型调用时失败。
- 用户规则召回：正式共享 helper 对同一 34 个冻结标签回放，仅 rsi-02 变化；miss 1→0、falseOffer 2→1，标签未改，0 provider、0 真库写入。rsi-09 excluded-only 的单个 falseOffer 仍保留并如实报告。完整证据：`delivery/enterprise/ROOT-RULE-PRIORITY-REPLAY.json`；单例 engine path 与计时另见 `ROOT-CANDIDATE-PREPARE-PROFILE2.json`。
- 包源码白名单只读检查：32 个声明包文件均存在且属于 78 个公开源码文件，局部相对导入闭包完整。
- 同条件 prepare-only 探针：45 条库 p95 55.116 ms，256 条库 p95 91.578 ms，近容量合法样本 p95 130.115 ms。旧 1.1.1 包基线分别为 4.626/9.329/55.321 ms。近容量旧值为同样的 256 条、2,041,208 B、32-turn 临时库，含 1,843,200 B 合法 unknown legacy padding（非典型库/语义复杂度）；见 `delivery/enterprise/BASELINE-NEAR-LIMIT-PERFORMANCE.json`。候选耗时高于旧包；本机同步持久化影响该结果，不代表宿主 SLA。
- 完整假 provider 套件运行一次：304 tests，298 pass、1 fail、5 skipped。唯一失败是 E6b 中仍写死旧版本 `1.1.1`；将断言同步为候选 `1.2.0` 后，E6b 与 UI 阶段文案两项定向重跑均通过。完整套件没有在该测试修正后重跑，不能将整套结果称为 exit 0。原始输出见 `delivery/enterprise/FINAL-SUITE.stdout`。

## 0.17.0（历史验证）

该版本的离线对照单独计算旧策略和新策略的命中、漏用和误发；发现样本、重复会话、重复提问不算独立增益。用学习库副本核对了：证据不足时不启用，启用时保留原有方法和警示，可归因的退步只隔离新增策略，重建引擎后仍然有效。库接近容量上限时，优先保留原有方法。该对照不测模型整体能力；真实会话验收单独记录。

## 0.16.2（历史验证）

**0.16.2** 的验收包括独立样本的增益、真实回合触发、后续策略的注入记录和可归因失败的退回。每轮最多两条方法和一条警示，合计不超过 768 UTF-8 字节。已安装版本以宿主回执为准。

离线发现集共 34 例，命中由 37 增至 38，明确误召回由 2 降至 1。独立控制共 9 例，命中由 4 增至 7，明确误召回均为 3。打包会重新计算对照并核对选择代码、输入和结果。保留的重复题与无增益题用于确认程序会继续沿用基线。

真实结构的学习库副本已覆盖并发换版、撤回来源、基线已覆盖同类失败、保留已有警示、暂停、关停及容量不足。两种方法分别获准时，其中一种的失败只退回对应改进。合法的新方法版本需要重新获得证据。

## 0.16.1（本批召回接入，打包前源码检查）

- 生产选择器：最多 2 条方法 + 最多 1 条风险警示，合计 ≤3 条 / 768B；`rsi-10` 为两条方法 + 真实 guard = 341B。
- 新生产测试 **5/5 pass，exit 0**；标准假 provider 套件 **169 tests / 164 pass / 0 fail / 5 skipped**；生产选择器与已批准 v3 的 34 例 offered/order/version/mode/bytes **34/34 一致**。
- 本段是打包前的源码检查记录；真实安装、宿主加载版本与实际 CUA 结果以本批安装验收回执为准。

## 0.16.0-rc.3（历史源码检查批次）

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

## 0.16.0-rc.4（历史：真实 UI/范围验证）

- UI：真实 rc.3 打开学习状态时实际暴露 `[object Object]` 渲染缺陷；rc.4 修复后实际 CUA 通过，学习状态无 `[object Object]`，全局/项目两条决定中文可读。UI wiring/W1/CS18 **3/3 pass**，非 UI runtime 与已验证批次逐字节一致。
- 范围：真实普通纠正无需「记住/跨项目」口令自动保存 → 另一 workspace 注入并遵循；项目内规则同工作区可见、其他工作区不注入；临时要求不产生持久规则。上述均有对应实际记录，安装结果以回执为准。

范围与未验证（如实）：

- 离线假 provider 结果不代替真实模型的长期业务效果；安装后的原生页面/五页详情与长会话验收由发布方的原生环境完成，以独立回执为准。UI 只读改动已接线并有状态投影/静态检查，rc.1 的五页与插件详情已在真实宿主查看；rc.2 沿用相同 UI，安装后的版本与新增数据仍以实际回执为准。
- 自动产物检查目前仅接入项目 JSON 解析检查，结论仅覆盖该检查；exit 0 或模型自述成功不构成客观验证。
- 自然语言纠正提取不保证识别任意表达；同机制判定只覆盖“步骤+检查”的确定性同指纹，换词绕过属于未覆盖语义边界；来源不明的历史材料按“来源待确认”拒收。
- 方法历史有界（≤128 条/每条 ≤6144 B，总 2 MiB 不变）；旧 `superseded` 仅能迁成 partial 记录，超出 128 条的旧快照不会被补造或分摊。历史无限保存与 2 MiB 容量不能同时承诺。
- 宽松 peer 版本范围不证明宿主接口一定存在；未测宿主/平台组合不宣称兼容。真实 provider 回归与日常安装结论只以各自回执为准，本批未执行。
- 本文记录源码检查结论；打包与本机安装结果以对应版本的交付回执为准。本批不发布、不提交、不推送。
