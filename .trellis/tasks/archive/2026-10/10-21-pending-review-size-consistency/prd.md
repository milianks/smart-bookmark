# 修复待确认页与主界面尺寸不一致

## Goal

从 Popup 主界面进入“待确认”时，界面尺寸与 Popup 主界面保持一致（390px），不再在 Popup 内渲染整页 Review 布局导致尺寸跳变；同时保留 Review 的全部批准/拒绝/批量/元数据操作，并保留通知点击打开独立 Review 标签页的既有行为。

## Background / 已确认事实

- Popup 主视图固定为 `w-[390px]`（`components/PopupApp.tsx:122`），加载态同样为 `w-[390px]`（`components/PopupApp.tsx:97`）。
- Popup 的“待确认”入口是普通链接：`Stat` 接收 `href={reviewUrl}`（`components/PopupApp.tsx:144`），`Stat` 渲染 `<a href>`（`components/ui/stat.tsx:42`）；历史扫描区的“查看历史建议 →”也是普通 `<a href>`（`components/PopupApp.tsx:187`）。
- Review 当前按独立整页设计：`mx-auto w-full max-w-3xl ... px-5 py-7 sm:px-8 lg:px-10`（`components/ReviewApp.tsx:140`）。
- Chrome MV3 popup 宽度由渲染内容决定（`.trellis/spec/frontend/extension-ui-contract.md`）。在 Popup 内点击扩展页面普通 `<a href>` 会在 popup 文档内导航，Review 整页布局使 Popup 从 390px 重新计算为整页宽度/高度，造成用户报告的尺寸不一致。
- Settings 已采用“Popup 内第二视图、固定 390px、React 内切换”的方案（`components/SettingsApp.tsx:138,153`；`components/PopupApp.tsx:95`），用户已接受该承载方式。
- 通知点击仍通过 `chrome.tabs.create` 打开独立 Review 页（`entrypoints/background.ts:107`），该独立页面用法需保留。
- 上一次宽度修复（commit `a84ab9a`）只把 Review 从 `max-w-5xl` 改为 `max-w-3xl`，对齐的是独立设置页，并未解决与 390px Popup 主界面的尺寸差异。
- 可用校验：`pnpm typecheck`、`pnpm test --run`、`pnpm build`；无浏览器自动化/组件测试。

## Decisions

- **D1 — 承载方式：Popup 内第三视图。** 用户选择：待确认页像设置页一样作为 Popup 内第三视图渲染，固定 390px，在 React 内切换，不打开标签页或系统窗口。
- **D2 — 保留独立 Review 页。** `entrypoints/review/` 与通知点击打开的标签页继续可用；`ReviewApp` 增加 embedded 模式，不删除独立整页行为。
- **D3 — 入口改为视图切换。** Popup 的“待确认”摘要格与“查看历史建议 →”不再使用 `<a href>` 导航，改为触发 Popup 视图切换，并把历史扫描的 `scanId` 传给嵌入的 Review 视图。

## Requirements

- **R1 — Popup 尺寸稳定。** 从主视图进入/退出待确认视图时，Popup 宽度始终保持 390px；待确认视图的加载态与加载完成态宽度一致。
- **R2 — Review 复用。** `ReviewApp` 同时支持嵌入式（Popup 内 390px、带返回主视图回调）与独立整页（现有 `max-w-3xl` 布局、URL 查询参数 `item`/`scan`）两种模式。
- **R3 — 入口与过滤。** “待确认”摘要格进入无 `scanId` 的 Review 视图；“查看历史建议 →”进入带当前扫描 `scanId` 的 Review 视图。
- **R4 — 功能不回退。** 单条批准/拒绝、改选目标文件夹、批准本组、批准当前全部、撤销批量整理、生成/重新生成摘要与标签、空态/加载态/错误提示均保持可用，消息调用不变。
- **R5 — 导航。** 嵌入式 Review 的“← 返回书签管理”在 Popup 内返回主视图；独立 Review 仍链接回 `popup.html`。
- **R6 — 契约不变。** 不改变 `RuntimeRequest`、后台持久化、权限请求、书签移动行为、设置草稿流程；不新增依赖。
- **R7 — 验证。** `pnpm typecheck`、`pnpm test --run`、`pnpm build` 通过，并按 `implement.md` 完成手动验收。

## Acceptance Criteria

- [x] 在 Popup 主界面点击“待确认”后，Popup 宽度保持 390px，并在同一 Popup 内显示待确认视图；加载态与完成态均为 390px。
- [x] 在历史扫描区点击“查看历史建议 →”后，在同一 Popup 内显示仅属于该 `scanId` 的建议。
- [x] 嵌入式待确认视图可返回主视图，返回后主视图仍为 390px。
- [x] 独立 Review 标签页（`/review.html` 及通知入口）布局与行为保持不变，仍支持 `item`/`scan` 查询参数。
- [x] 所有 Review 操作在嵌入式模式下可用；成功提示使用 `role="status"`，错误使用 `role="alert"`。
- [x] 390px 下空态、加载态、长标题/长 URL、列表与详情无横向溢出。
- [x] `pnpm typecheck`、`pnpm test --run`、`pnpm build` 通过。

## Out of Scope

- 不重做 Review 视觉设计与交互语义；不改变批准/拒绝/批量/撤销的业务含义。
- 不新增标签页、系统窗口或窗口尺寸记忆。
- 不改变 Settings 的嵌入式 390px 方案。
- 不修改后台消息契约、存储结构、AI 分类行为或权限模型。
- 不新增依赖、组件测试框架或浏览器自动化。

## Verification

- `pnpm typecheck`：通过。
- `pnpm test --run`：11 个测试文件、143 个测试通过。
- `pnpm build`：通过，产物 `.output/chrome-mv3/`。
- Playwright 加载未打包扩展（390×600 视口）验证：主视图、嵌入待确认视图、返回后主视图的 `main` 宽度均为 390px，`documentElement.scrollWidth` 均为 390px；嵌入视图可返回；独立 `/review.html` 仍渲染。
- 嵌入视图手动截图检查：长标题、长 URL、列表与详情在 390px 下无横向溢出。

## Technical Notes

- 技术设计与权衡见 `design.md`；实施顺序、风险文件与回滚点见 `implement.md`。
- 无法自动化的 Popup 实际尺寸变化，在完成时记录手动验收结果，不声称未运行的检查。

## Open Questions

None blocking. D1–D3 已由用户选择与仓库证据确定。
