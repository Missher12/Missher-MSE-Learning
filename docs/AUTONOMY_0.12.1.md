# 0.12.1 Budget slider / 预算档位滑轨

## 中文

这是并入 0.13.0 的预算滑轨设计记录，0.12.1 没有独立发布或安装。本版把评测预算预设按钮改为紧凑的五档原生滑轨，刻度标签为 0、20K、50K、100K、200K；状态行显示完整档位名称、token 数和每日任务数。滑轨按 token 值定位，支持鼠标、触屏、方向键以及 Home/End，并提供可见焦点和读屏值。

不符合预设的现有数值显示为“自定义”，且不会错误标记某个预设；若 token 与某档相同但任务数不同，拇指可位于该刻度而档位仍保持未选中。渲染、切页和保存不会归一化自定义数值；只有明确选择滑轨档位才会同时更改 token 上限和任务数。数字输入、保存、放弃和 revision 冲突处理沿用原有草稿流程；只读、保存及重新加载期间预算控件禁用。

这份滑轨设计本身不修改 Core、计费或模型路由；0.13.0 的预算模式与配套改动另见[版本说明](AUTONOMY_0.13.0.md)。已合并实现的回归、原生界面与验收限制统一见[验证记录](../VALIDATION.md)，不把桌面指针操作外推为真实触屏验收。

## English

This is the budget-slider design record incorporated into 0.13.0; 0.12.1 was not separately released or installed. This update replaces the evaluation budget preset buttons with a compact five-stop native range control. Its tick labels are 0, 20K, 50K, 100K and 200K; the status row shows the full tier name, token allowance and daily task allowance. The thumb follows the token allowance and supports pointer/touch input, arrow keys and Home/End, with visible focus and an accessible value.

Existing values that do not match a preset appear as Custom, and no preset is marked. When the token value matches a stop but the task count differs, the thumb can rest on that stop while the tier remains unselected. Rendering, changing pages and saving do not normalize custom values; only an explicit slider selection changes both the token and task limits. Numeric entry, Save, Discard and revision-conflict behavior continue through the existing draft flow. Budget controls are disabled while settings are read-only, saving or reloading.

The slider design itself does not change the Core, accounting or model routes. The combined budget-mode changes are described in the [0.13.0 notes](AUTONOMY_0.13.0.md). The [validation record](../VALIDATION.md) covers the merged implementation and its limitations; desktop pointer checks do not establish physical touch-device acceptance.
