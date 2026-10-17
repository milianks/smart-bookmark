# 恢复设置页界面并更换图标

## Goal

让设置页回到用户认可的扩展界面形态，并将当前单色字母图标替换为能表达“AI + 书签整理”的图标。

## Confirmed Facts

- 当前设置入口在 `components/PopupApp.tsx` 中调用 `chrome.windows.create`，打开独立的 Chrome popup 窗口。
- 当前设置入口此前也试过 `chrome.runtime.openOptionsPage()` 和 `wxt.openInTab`，分别对应短生命周期 action popup 和浏览器标签页；用户均未接受当前呈现。
- 当前扩展图标只有 `public/icon/128.png`，视觉上是单色紫色方块，没有书签或 AI 识别元素。

## Decision

- 设置页在 action popup 内作为第二个视图渲染，通过“设置”和“返回书签管理”切换，不打开标签页或系统窗口。
- 草稿由 background 通过 typed runtime messages 保存到扩展本地状态；popup 重新挂载时读取草稿，正式保存后清除草稿。
- 图标采用书签轮廓与 AI 星点的简洁双颜色图形，生成 `public/icon/128.png`，并在 popup 品牌区域复用。

## Requirements

- 设置页的最终承载形态需与用户所说的“初始界面一样”一致，并保持设置表单可正常输入、复制 API Key 和保存。
- 替换扩展图标，图形应简洁、清晰，能同时传达书签和智能整理，适合 128px 扩展图标及缩小后的浏览器工具栏图标。
- 保留现有 AI 协议、配置、连接测试和表单状态修复，不借此任务重写业务逻辑。
- action popup 关闭后再次打开，设置视图中的非敏感字段和 API Key 草稿仍能恢复。
- 草稿保存失败时显示错误，但不阻断用户继续编辑；正式保存成功后草稿被清理。

## Out of Scope

- 不新增浏览器标签页、系统弹窗、窗口位置记忆或跨设备同步。
- 不改变 AI provider 协议、设置字段含义或正式保存校验。

## Acceptance Criteria

- [x] 点击 action popup 的设置入口后，仍在同一个扩展 popup 中显示设置视图。
- [x] 修改任意设置字段会自动保存草稿；关闭再打开 popup 后字段和 API Key 草稿恢复。
- [x] 点击返回回到初始书签视图；正式保存后草稿被清除。
- [x] 图标不再是单色方块或字母占位，扩展图标和 popup 品牌图形均显示书签 + AI 星点标识。
- [x] `pnpm typecheck`、`pnpm test --run`、`pnpm build` 和 `git diff --check` 通过。
