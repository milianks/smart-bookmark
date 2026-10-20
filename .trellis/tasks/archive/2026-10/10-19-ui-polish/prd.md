# 优化扩展 UI

## Goal

提升 AI Bookmark Manager 三个用户界面（Popup、Review、Settings）的视觉质量、信息层级与交互可用性，同时不改变后台数据流、权限模型和书签操作语义。

用户价值：用户能更快看懂当前整理状态、更少误操作，并在浅色/深色、鼠标/键盘、窄屏/宽屏下获得一致体验。

## Background / 已确认事实

- 三个页面共享 `components/styles.css` 与 `components/ui/` 原语；Popup 固定 `390px` 宽，Review/Settings 使用 `max-w-5xl` 响应式布局（`.trellis/spec/frontend/extension-ui-contract.md`；`components/PopupApp.tsx:100`；`components/ReviewApp.tsx:84`；`components/SettingsApp.tsx:135`）。
- 现有视觉语言为 violet 主色、slate 中性色、`rounded-2xl` 卡片与浅/深色 variant（`components/ui/*.tsx`、`components/styles.css`）。
- Popup 首屏依次渲染头部、自动整理开关、历史扫描、待配置/权限提示、待确认、最近书签、最近操作、底栏，信息密度高（`components/PopupApp.tsx:100-112`）。
- 深色模式覆盖不完整：错误/成功提示、待确认入口、刷新/设置文字按钮缺少深色 variant（`components/PopupApp.tsx:105,106,109,110,112`）。
- 自动整理控件不一致：Popup 为自绘 `role="switch"`，无过渡与 focus-visible 环；Settings 为原生 checkbox（`components/PopupApp.tsx:104`；`components/SettingsApp.tsx:175`）。
- Settings 的两个 `<select>` 内联重复样式且缺少 focus ring/disabled 样式（`components/SettingsApp.tsx:146,184`），而 `Input/Textarea` 已在 `components/ui/field.tsx:18` 统一。
- 折叠区 `<summary>` 无 focus-visible 样式，键盘焦点不可见（`components/PopupApp.tsx:110,111`；`components/SettingsApp.tsx:178,196,206,218`）。
- 三页加载态均为纯文本（`components/PopupApp.tsx:97`；`components/ReviewApp.tsx:94`；`components/SettingsApp.tsx:131`）。
- 书签状态徽章仅 `failed` 着色，排队/扫描/待确认等状态辨识度低（`components/BookmarkCard.tsx:20`）。
- Review 左栏固定 `260px`，条目仅标题+域名；窄屏时列表在详情上方，长列表会把详情推出首屏（`components/ReviewApp.tsx:95-100`）。
- 可用校验为 `pnpm typecheck`、`pnpm test --run`、`pnpm build`；无 lint、组件测试或浏览器自动化（`.trellis/spec/frontend/quality-guidelines.md`）。
- 仓库存在未完成的 tooltip 任务（`10-18-recent-activity-tooltip`）及未提交改动；本任务不得回退这些改动。

## 已确认的范围决策

- **D1 — 三页全面打磨。** 范围包含视觉一致性、Popup 信息架构、可访问性与深色模式；允许调整区块顺序、密度、文案与控件形态，但不改变后台契约。交付按阶段拆分：共享原语 → Popup → Review → Settings → 全量验证。
- **D2 — Popup 保留单页 + 状态摘要 + 折叠次要内容。** 头部下方增加紧凑状态摘要；自动整理与待确认保持首要位置；历史扫描、最近书签、最近操作折叠。
- **D3 — 延续现有 violet + slate。** 不引入渐变或强品牌表面，只精修层级、间距、阴影、状态色与微交互。

## Requirements

- **R1 — 共享原语一致性。** 按钮、badge、输入/选择器、开关、提示条、折叠区、加载占位统一由 `components/ui/` 提供；页面中不再重复同类控件样式。
- **R2 — Popup 信息架构。** 首屏顺序为：Header → 自动整理卡 → 状态摘要（待确认、历史扫描、最近结果）→ 需要处理的提示 → 历史书签整理（折叠）→ 最近书签（折叠）→ 最近操作（折叠）→ Footer。移除与摘要重复的独立“待确认”卡。
- **R3 — 视觉方向。** 保持 violet 主色与 slate 中性色；通过字号、字重、间距、边框与阴影建立层级，不新增彩色大面积背景。
- **R4 — 状态与反馈。** 成功/错误/等待/扫描/待确认状态使用统一 `Notice` 与 badge tone；异步操作展示进行中、完成、失败反馈；状态不只靠颜色传达。
- **R5 — 可访问性与深色模式。** 所有交互控件具备可见 `focus-visible`；折叠区、列表项、开关可键盘操作；浅/深色下均无低对比或漏配背景/文字色；尊重 `prefers-reduced-motion`。
- **R6 — 响应式。** Popup 在 390px、Review/Settings 在窄屏与宽屏下无横向溢出、无遮挡；Review 在窄屏使用横向滚动选择器，详情保持首屏可见。
- **R7 — 契约不变。** 不改变 `RuntimeRequest`、后台持久化、权限请求、书签移动行为、设置草稿流程；不引入新依赖或组件库。
- **R8 — 验证。** 三项仓库命令通过，并按 `implement.md` 完成浏览器手动验收。

## Acceptance Criteria

- [x] **R1**：三页均使用共享 `Button`、`Badge`、`Input/Select`、`Switch`、`Notice`、`Disclosure`；Settings 中不再存在内联 `<select>` 样式，Popup 不再存在自绘开关。
- [x] **R2**：Popup 首屏按 D2 顺序渲染；状态摘要三格数据来自 `pendingReviews`、`historicalScan`、`activities`；待确认 >0 时摘要格可跳转 Review；原独立待确认卡已移除。
- [x] **R3**：三页无新增渐变/彩色大表面；主操作仍为 violet，次级操作为 secondary/ghost。
- [x] **R4**：书签状态 badge 按 queued/processing/awaiting/pending/completed/failed/skipped 显示不同 tone；所有异步结果使用 `role="status"` 或 `role="alert"`。
- [x] **R5**：Tab 遍历按钮、链接、summary、列表项、开关时焦点可见；键盘可切换自动整理；深色模式下所有提示条、链接、文字按钮有对应样式；`prefers-reduced-motion` 下无滑块/chevron 动画。
- [x] **R6**：Popup 390px 下无横向滚动；Review 在 `<lg` 显示横向 chip 列表且详情仍可见；长标题/长 URL 不撑破卡片。
- [x] **R7**：本任务未修改 `types/`、`services/`、`lib/`；`package.json` 依赖不变；既有 tooltip 与 `lib/ai/rule-classifier.ts` 未提交改动保留。
- [x] **R8**：`pnpm typecheck`、`pnpm test --run`、`pnpm build` 通过；手动验收覆盖三页、浅/深色、键盘、空态/错误态、长文本。

## Verification

- `pnpm typecheck`：通过。
- `pnpm test --run`：11 个测试文件、112 个测试通过。
- `pnpm build`：通过，产物 `.output/chrome-mv3/`。
- Chromium 加载未打包扩展（临时 profile）后验证：Popup、Review、Settings 真实渲染；Popup 开关真实持久化；Settings 无 API Key 时保存/测试按钮禁用，输入 Key 后启用。
- 浏览器视口：Popup 390px 无横向滚动；Review 420px 无横向溢出，列表为横向滚动 chip；Settings 390px 无溢出。
- 浅色/深色截图检查；修复深色 `html` 背景白带与 Review 窄屏网格溢出。
- 键盘 Tab 顺序与 `focus-visible` 环可见；Space 切换 `role="switch"` 生效。
- `prefers-reduced-motion: reduce` 下滑块/动画时长降至 0.01ms。
- 加载骨架、空态、错误 `Notice`、长标题/长 URL 均已检查。

## Out of Scope

- 后台逻辑、存储结构、AI 分类行为、权限模型、消息契约。
- 新页面、新功能、组件库或图标依赖。
- 国际化；界面文案保持中文。
- 修改或回退 `10-18-recent-activity-tooltip` 的 tooltip 行为。
- 深色/浅色之外的主题（如高对比度主题）与移动端原生适配。

## Technical Notes

- 技术设计、组件清单与权衡见 `design.md`；实施顺序、风险文件与回滚点见 `implement.md`。
- 手动验收无法自动化的部分，在完成时记录实际观察结果，不声称未运行的检查。

## Open Questions

None blocking.
