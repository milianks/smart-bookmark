# 调整待确认嵌入视图排版

## Goal

修正待确认视图嵌入 Popup 时的布局问题：建议列表改为全宽纵向排列，详情标题与置信度改为上下布局，使 390px 下不再出现 224px 窄卡片和标题/置信度挤压。

## Background / 已确认事实

- 嵌入模式下列表容器仍使用 `flex gap-2 overflow-x-auto p-2 lg:block`，分组固定 `w-56 shrink-0`（`components/ReviewApp.tsx:180-181`），在 390px Popup 内条目仅 224px 宽，右侧留白。
- 详情头部使用 `flex flex-wrap items-start justify-between`，标题与固定 `min-w-[7rem]` 的置信度区域并排（`components/ReviewApp.tsx:235,245`），长标题被迫多行换行。
- 用户确认：同时调整列表宽度与详情头部布局。

## Requirements

- R1：嵌入模式下建议列表改为纵向堆叠，分组宽度为 `w-full`，不再横向滚动或固定 224px。
- R2：嵌入模式下详情头部改为纵向布局：标题独占整行，置信度区域移到标题下方并占满可用宽度。
- R3：独立 `/review.html` 保持现有 `lg` 两栏布局与横向 chip 列表。
- R4：不改后台消息、存储、业务语义。

## Acceptance Criteria

- [x] 嵌入视图建议列表条目占满 390px 内容宽度，右侧无大片空白。
- [x] 详情标题独占一行，置信度条位于标题下方。
- [x] 独立 Review 页在宽屏仍为左栏列表 + 右侧详情。
- [x] 390px 下无横向溢出。
- [x] `pnpm typecheck`、`pnpm test --run`、`pnpm build` 通过。

## Verification

- `pnpm typecheck`：通过。
- `pnpm test --run`：143 个测试通过。
- `pnpm build`：通过。
- Playwright 390×600：列表条目占满内容宽度，详情标题独占整行、置信度条位于标题下方；主/嵌入/返回视图宽度均 390px，无横向溢出。

## Out of Scope

- 不改变字号体系（上一任务已完成）。
- 不改 Review 业务操作与视觉主色。
