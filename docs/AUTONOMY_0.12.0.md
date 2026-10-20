# 0.12.0 Remote decision settings / 远程决策模型设置

## 中文

0.12.0 为 DSH 远程决策模型设置增加模型名称、服务地址和 API Key 管理。Key 由宿主 credentials 服务保存，并按后端与规范化服务路线使用不同引用；普通配置、远程状态投影和错误消息只传递凭据元数据，不回传 Key。宿主凭据服务不可用时，可继续使用高级选项中的环境变量引用。旧引用保留原路线绑定，更换路线后不会自动把它发送给新地址；重新输入并保存引用才会绑定到当前路线。

设置页可通过只读 GET 获取已知模型目录，并从目录中选择模型，也可继续手动填写。发现请求限制为同源、拒绝重定向、最多 8 秒、64 KiB 响应和 500 个模型条目。OpenAI 兼容与 Jev 读取 `/v1/models`，Laya 校验 `/health` 状态，并只把 `loaded` 条目作为模型名。Laya 的 `auto` 是独立选择，不会伪装成目录中返回的模型。目录读取不运行推理、不写入设置、不触发学习或预算结算。目录支持、凭据已配置及服务可达均不能证明推理接口兼容或模型效果。

地址按已有协议规范化：OpenAI 兼容根地址、`/v1` 地址及明确写出的 `/<prefix>/v1` 代理地址映射到标准请求/模型目录路径。标准完整 `/v1/chat/completions` 地址保留实际请求路径（含末尾斜杠）；其他未知路径也继续原样用于旧版推理调用，不从末尾斜杠猜测它是代理根，也不会猜测目录路径。Jev 与 Laya 继续把旧配置视为服务根并追加 `/v1/systemone`；Laya 的目录检查使用同一路线前缀下的 `/health`。

评测预算预设独立使用从左开始的自适应网格，token 与任务数输入框宽度一致。原有滚动 24 小时、已预留/实测/未知用量含义保持不变，修改布局不改变预算数值或自动验证设置。

43 项客户端回归、相同源码的后端定向检查及隔离原生设置验收已完成，覆盖保存、目录、重启、窄屏布局与凭据冲突恢复。宿主凭据服务在本轮环境使用权限受限的本地文件，不是系统钥匙串或加密保险库。目录发现不是推理验收，本版没有新增真实供应商调用；各层边界见[验证记录](../VALIDATION.md)，正式发布和设备安装仍以独立交付记录为准。

## English

Version 0.12.0 adds a model name, service endpoint and API key controls to remote decision settings. The Host credentials service stores each key under a reference scoped to its backend and normalized service route. Ordinary settings, Remote projections and error messages expose credential metadata only. The Advanced environment-variable reference remains available when the Host credentials service is unavailable. Existing references keep their previous route binding; changing routes does not silently send a key to a new address. Re-entering and saving the reference explicitly binds it to the current route.

The settings page can fetch a known model directory using read-only GET and select a returned model, while keeping manual entry available. Discovery is same-origin, rejects redirects, times out after at most eight seconds, and caps responses at 64 KiB and lists at 500 models. OpenAI-compatible and Jev backends read `/v1/models`; Laya validates `/health` status and uses only its `loaded` entries as model names. Laya `auto` is a separate choice, never presented as a discovered model. Discovery does not run inference, save settings, trigger learning or settle a budget. A model list, configured credential or reachable service does not prove inference compatibility or model quality.

Address normalization follows the existing provider contracts: OpenAI-compatible origin roots, `/v1` bases and explicit `/<prefix>/v1` proxy bases map to standard request and directory paths. Standard full `/v1/chat/completions` addresses keep their exact request path, including a trailing slash. Other unrecognized paths also remain exact for legacy inference; a trailing slash does not turn them into proxy bases, and discovery does not guess a directory path. Jev and Laya continue treating older configured values as service bases and append `/v1/systemone`; Laya checks `/health` under the same route prefix.

Evaluation budget presets use a separate left-aligned responsive grid. Token and task-count inputs have equal widths. Existing rolling 24-hour accounting and the distinction between reserved, measured and unknown usage remain unchanged; the layout does not change allowance values or automatic-validation settings.

The 43 client regressions, retained backend checks on identical code and isolated native settings acceptance cover saves, discovery, restart readback, narrow layouts and credential-conflict recovery. The tested Host stores credentials in a permission-restricted local file, not an OS keychain or encrypted vault. Discovery is not inference acceptance, and this version adds no real provider calls. See the [validation record](../VALIDATION.md) for boundaries; publication and device installation require their own delivery records.
