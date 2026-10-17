# 修复 Popup 设置视图宽度跳变

## Goal

在扩展弹窗（popup）内，用户点击“设置”进入 embedded 设置视图时，弹窗宽度会发生跳变。目标是让主视图与设置视图保持相同宽度，使弹窗在视图切换时尺寸稳定，不再忽宽忽窄。

## Background（已确认事实）

- 弹窗主视图使用固定宽度 `w-[390px]`：`components/PopupApp.tsx:63`（主内容）、`components/PopupApp.tsx:55`（加载态）。
- 点击“设置”后，`PopupApp` 渲染 `<SettingsApp embedded onBack={...} />`：`components/PopupApp.tsx:54`。
- embedded 设置视图未使用固定宽度，而是 `w-full`：`components/SettingsApp.tsx:131`（主内容）、`components/SettingsApp.tsx:129`（加载态）。
- 弹窗 HTML/body 未设置显式宽度：`entrypoints/popup/index.html`。Chrome MV3 弹窗按内容计算宽度。
- 因此主视图被钉在 390px，设置视图按内容自适应，两者宽度不一致，切换时弹窗整体尺寸变化。
- 设置视图同时还作为独立整页使用（options 页，非 embedded 分支 `mx-auto ... max-w-5xl`），该整页用法不受本次修改影响。

## Requirements

- R1：embedded（`embedded === true`）设置视图主内容宽度与弹窗主视图一致，固定为 `w-[390px]`（`components/SettingsApp.tsx:131`）。
- R2：embedded 设置视图加载态宽度同样固定为 `w-[390px]`，避免加载过程中出现中间宽度跳变（`components/SettingsApp.tsx:129`）。
- R3：非 embedded 整页（options 页）宽度行为保持不变。
- R4：不改动弹窗全局 body/html 宽度，仅调整 embedded 分支，范围最小。

## Acceptance Criteria

- [ ] 在弹窗中，从主视图点击“设置”进入设置视图、再点“← 返回书签管理”返回，弹窗宽度全程保持 390px，无可见跳变。
- [x] 设置视图加载态与加载完成态宽度一致，均为 390px。
- [x] 存在设置草稿时打开弹窗，弹窗直接进入设置视图（`components/PopupApp.tsx:27-31`），宽度同样为 390px。
- [x] options 整页打开设置时布局与改动前一致（仍为居中、`max-w-5xl`）。
- [x] `pnpm typecheck` 通过。
- [x] `pnpm test --run` 通过。
- [x] `pnpm build` 通过。

## Key Decisions

- 修复方式采用“embedded 设置视图统一到 390px”，而非在 body/html 设置全局宽度。理由：改动范围最小、只触及 embedded 分支，不影响 options 整页，也不引入全局样式副作用。

## Risks and Deferred Items

- Chrome MV3 弹窗尺寸由内容布局决定，当前仓库没有覆盖 popup 实际窗口几何变化的浏览器自动化；宽度切换仍需在加载后的扩展中手动确认，类型检查、测试和构建只作为配套验证。

## Out of Scope

- 不改变弹窗宽度数值（保持现有 390px）。
- 不固定弹窗高度。高度继续随各视图内容变化（Chrome 弹窗高度上限 600px），主视图与设置视图高度不同属预期行为。
- 不调整设置页内部布局、组件或整页（options）用法。
- 不改动弹窗 body/html 全局样式。
