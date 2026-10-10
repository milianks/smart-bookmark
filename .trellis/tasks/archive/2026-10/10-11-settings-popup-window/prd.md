# 改为独立设置小窗口

## Goal

将设置入口从浏览器标签页改为固定尺寸、可持续操作的 Chrome 独立弹窗窗口。

## Background

- 当前 `components/PopupApp.tsx` 通过 `chrome.runtime.openOptionsPage()` 打开设置。
- 当前 `entrypoints/options/index.html` 带有 `wxt.openInTab=true`，构建产物因此生成 `options_ui.open_in_tab=true`，Chrome 会打开浏览器网页标签页。
- 用户需要一个独立的小窗口，以便复制 API Key、切换焦点和返回主界面时保持设置页可用。

## Requirements

- 设置入口打开 Chrome 独立 popup 窗口，固定初始尺寸约 640×760，窗口获得焦点并可自由复制、输入 API Key。
- 设置窗口不能依赖 action popup 的短生命周期；点击外部区域或关闭主弹窗后，设置窗口仍保持打开。
- 移除 options 页的 `wxt.openInTab` 配置，避免生成浏览器标签页选项页。
- 为创建窗口补充必要的 `windows` 扩展权限。
- 保留当前设置页的宽度布局、AI 配置、保存、测试和导航内容，不改动业务数据流。

## Technical Notes

- `PopupApp` 的“前往设置”和“设置”入口共用固定窗口创建逻辑。
- 直接使用 `chrome.windows.create` 打开 `chrome.runtime.getURL('/options.html')`；不把 options 页面嵌入 action popup，也不改为浏览器标签页。
- 这是 UI 入口修复，不新增持久化状态、后台 API 或 provider 行为。

## Out of Scope

- 不重做设置页视觉设计，不改变表单字段或 API 协议支持。
- 不实现窗口位置记忆、跨重启单实例管理或系统级窗口置顶。

## Acceptance Criteria

- [x] 点击主界面的“设置”或“前往设置”后，出现独立的小型 Chrome popup 窗口，而不是浏览器标签页。
- [x] 设置窗口初始宽度约 640px、高度约 760px，表单可正常显示并可直接聚焦、输入和复制 API Key。
- [x] 主 action popup 关闭或失去焦点后，设置窗口仍然存在。
- [x] 构建产物不再依赖 `wxt.openInTab=true`，并包含创建窗口所需权限。
- [x] `pnpm typecheck`、`pnpm test --run`、`pnpm build` 和 `git diff --check` 通过。
- [x] 既有设置保存、测试连接和表单编辑行为保持不变。

## Open Questions

- None. The requested product behavior is fixed to an independent popup window; 640×760 is the implementation default and may be clamped by the browser or display bounds.
