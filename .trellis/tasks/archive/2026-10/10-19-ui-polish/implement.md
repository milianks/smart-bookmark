# 优化扩展 UI — 实施计划

## 阶段与顺序

### 0. 基线

- 记录 `git status`，确认 `10-18-recent-activity-tooltip` 的未提交改动存在且不被回退。
- 不修改 `lib/ai/rule-classifier.ts` 或 tooltip 相关文件，除非验证发现 UI 回归。
- 基线检查：`pnpm typecheck`、`pnpm test --run`。

### 1. 共享原语（先做，后续页面复用）

1. `components/ui/badge.tsx`：增加 `tone` 映射（neutral/primary/success/warning/danger），保留 `className`。
2. `components/ui/button.tsx`：统一 focus/active/disabled 与过渡；检查 `size="sm"` 在 390px 下不溢出。
3. `components/ui/field.tsx`：导出 `Select`，与 `Input/Textarea` 共用样式常量。
4. 新增 `components/ui/switch.tsx`：`role="switch"`、`aria-checked`、键盘 Space/Enter 原生行为、焦点环、尺寸变体。
5. 新增 `components/ui/notice.tsx`：success/error/warning/info，自动映射 `role`。
6. 新增 `components/ui/disclosure.tsx`：`<details><summary>` + chevron + focus-visible。
7. 新增 `components/ui/skeleton.tsx`、`components/ui/stat.tsx`。
8. `components/styles.css`：`prefers-reduced-motion` 降级；不引入全局宽度。

验证：`pnpm typecheck`。

### 2. Popup

1. 头部：图标、标题、副标题、AI badge（使用 badge tone）。
2. 自动整理卡：替换自绘开关为 `Switch`；说明文案随 `enabled/hasApiKey` 变化。
3. 新增状态摘要 `Stat` 三格：待确认（链接）、历史扫描状态、最近结果。
4. 删除独立“待确认”卡；保留等待配置/权限 banner（改用 `Notice` 或保留可操作卡片）。
5. 历史扫描、最近书签、最近操作改为 `Disclosure`；最近书签保留刷新按钮与 3 条 `BookmarkCard`。
6. 底栏：撤销按钮/不可用文案 + 设置入口；补深色样式与焦点环。
7. 加载态改用 `Skeleton`；`role="status/alerts"` 改用 `Notice`。
8. 保持根节点 `w-[390px]` 与嵌入 Settings 的切换逻辑不变。

验证：`pnpm typecheck`；窄宽度下逐项检查溢出。

### 3. Review

1. Header 响应式换行；批量操作按钮在窄屏不挤出。
2. 左栏：`lg` 垂直列表 + 选中强调条；`<lg` 横向滚动 chip；条目补 `focus-visible` 与状态点。
3. 详情：置信度条 + 百分比；URL、摘要标签、推荐操作、理由统一卡片内分区。
4. 空态/加载态统一；提示改用 `Notice`。
5. 不改变 approve/reject/approve-all/undo/metadata 的消息调用。

验证：`pnpm typecheck`；单条/多条/空列表/长标题/长 URL。

### 4. Settings

1. 协议与模式 `<select>` 改用 `Select`。
2. 自动整理用 `Switch` 整行可点击；通知项保持原生 checkbox 但统一布局与焦点。
3. 阈值滑杆补 `aria-valuetext` 与当前值展示。
4. 通知、隐私权限、最近操作改用 `Disclosure`。
5. 加载态 `Skeleton`；提示条 `Notice`。
6. 嵌入 Popup 时仍为 `w-[390px]`，不改变草稿与保存流程。

验证：`pnpm typecheck`。

### 5. 全量验证

```bash
pnpm typecheck
pnpm test --run
pnpm build
```

浏览器手动验收（加载 `.output/chrome-mv3/` 到 Chrome 134+）：

- Popup：浅/深色、390px、自动整理开关键盘操作、待确认摘要链接、三个折叠区、长标题/长 URL、空态、错误提示。
- Review：单条/多条/空列表、窄屏 chip 列表、长标题、长 URL、置信度、批准/拒绝/批量/撤销、键盘焦点。
- Settings：协议/模型/密钥保存、授权测试、自动整理开关、阈值、通知、折叠区、嵌入模式与独立页面。
- 三页：Tab 顺序可见焦点；`prefers-reduced-motion` 下无动画；深色下无低对比。

## 风险文件与回滚点

| 文件 | 风险 | 回滚 |
|---|---|---|
| `components/ui/*` | 共享原语影响三页 | 阶段 1 单独提交，整体回滚 |
| `components/PopupApp.tsx` | 390px 下溢出、信息缺失 | 单独提交回滚，不影响原语 |
| `components/ReviewApp.tsx` | 窄屏列表/详情布局 | 单独提交回滚 |
| `components/SettingsApp.tsx` | 表单与草稿行为 | 单独提交回滚；不改消息调用 |
| `components/styles.css` | 全局样式副作用 | 仅追加媒体查询，易回滚 |

## 完成定义

- PRD 全部验收项已勾选，或明确标注无法自动验证的手动项及实际结果。
- 三项命令通过；构建产物可加载。
- 无新依赖、无后台/存储/权限改动。
- 三页在浅色与深色下视觉一致，键盘可达。
