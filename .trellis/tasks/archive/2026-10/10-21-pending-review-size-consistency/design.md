# 待确认页嵌入 Popup — 技术设计

## 架构与边界

- 保持三层结构不变：Popup 视图切换在 `components/PopupApp.tsx`；Review 展示与操作在 `components/ReviewApp.tsx`；后台消息契约不变。
- `ReviewApp` 新增可选 props：
  - `embedded?: boolean`：为 `true` 时使用 Popup 内 390px 布局与返回回调。
  - `scanId?: string`：嵌入模式下由 Popup 传入，替代 URL 查询参数。
  - `onBack?: () => void`：嵌入模式的返回主视图回调。
- 独立入口 `entrypoints/review/main.tsx` 不传 props，`ReviewApp` 继续从 `window.location.search` 读取 `item` / `scan`，保持通知与直接打开行为。

## 数据流与契约

- Popup 点击“待确认”时：`setReviewScanId(''); setView('review')`；点击“查看历史建议”时：`setReviewScanId(scan.id); setView('review')`。
- 嵌入的 `ReviewApp` 仍通过 `state:get` 读取 dashboard，通过既有 `RuntimeRequest`（`review:approve`、`review:reject`、`scan:approve-all`、`undo:historical-last`、`bookmark:metadata:generate`）执行操作；不新增消息类型。
- `scanId` 初始化优先级：显式 prop 优先，其次 URL 查询参数，最后空字符串。

## 布局与尺寸

- `ReviewApp` 根节点条件类：
  - embedded：`w-[390px] space-y-4 p-4`
  - standalone：`mx-auto w-full max-w-3xl space-y-4 px-5 py-7 sm:px-8 lg:px-10`
- 与 `SettingsApp` 的 embedded 宽度策略一致（`components/SettingsApp.tsx:138,153`），确保 Popup 内容宽度稳定为 390px。
- 390px 下 `lg:grid-cols-[280px_1fr]` 不生效，列表保持横向滚动 chip、详情在下方；不新增断点。
- Popup 高度仍受 Chrome 上限约束，待确认视图纵向滚动；不固定高度。

## 组件改动

1. `components/ui/stat.tsx`：增加 `onClick?: () => void`。当传入 `onClick` 时渲染 `<button type="button" className="text-left">`；否则维持 `href`/`div` 分支。保留 hover/focus 样式。
2. `components/PopupApp.tsx`：
   - `view` 扩展为 `'main' | 'settings' | 'review'`。
   - 新增 `reviewScanId` 状态。
   - 在 `view === 'settings'` 分支旁新增 `view === 'review'`：返回 `<ReviewApp embedded scanId={reviewScanId} onBack={() => { setView('main'); void refresh(); }} />`。
   - `Stat` 改为 `onClick`；“查看历史建议”由 `<a href>` 改为 `<button type="button">`，保留原文字样式与 focus ring。
   - 删除不再使用的 `reviewUrl` 变量。
3. `components/ReviewApp.tsx`：
   - 函数签名改为接收 props，并保留默认值 `embedded = false`。
   - `useEffect` 初始化 `scanId` 时使用 `props.scanId ?? query.get('scan') ?? ''`；仅在 standalone 时读取 URL。
   - 根节点 class 条件化。
   - 返回链接：embedded 渲染 `<button type="button" onClick={onBack}>← 返回书签管理</button>`；standalone 保持 `<a href={popup.html}>`。

## 兼容与迁移

- 无数据迁移、无存储变更。
- 独立 Review 页面的 URL 参数、通知深链保持不变。
- Popup 原有 Settings 视图、草稿恢复逻辑不变。

## 权衡

- **嵌入 vs 新标签页**：嵌入使尺寸一致、操作不离开 Popup，符合用户选择；代价是 390px 下列表+详情更拥挤，长列表需要滚动。复用现有响应式布局降低改动量。
- **改 `Stat` 支持 onClick**：避免在 Popup 内嵌套 `<a>` 触发整页导航；比外层包 `<button>` 更语义化，且不影响其他 `Stat` 用法。
- **保留 standalone 模式**：避免破坏通知入口与既有深链。

## 运维与回滚

- 变更集中在三个前端文件，可整体回滚。
- 无后台/权限/依赖变更，回滚不影响数据。
