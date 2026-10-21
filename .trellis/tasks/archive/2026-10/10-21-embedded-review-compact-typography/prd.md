# 优化待确认嵌入视图紧凑排版

## Goal

让待确认（Review）视图嵌入 Popup 时使用与主界面一致的紧凑字号、按钮尺寸与间距，消除“整页排版塞进 390px Popup”的臃肿感；独立 Review 标签页保持现有整页排版。

## Background / 已确认事实

- 待确认视图已在 Popup 内以 390px 渲染（`components/ReviewApp.tsx:146`；`components/PopupApp.tsx:97`）。
- 嵌入视图仍沿用整页字号：页面标题 `text-xl`、建议列表标题 `text-base`、详情标题 `text-lg`、详情按钮默认 `md`（`components/ReviewApp.tsx:151,171,242,293`）。
- 主界面使用更紧凑的字号与按钮：页面标题 `text-base`、卡片标题 `text-sm`、主要按钮 `size="sm"`（`components/PopupApp.tsx:126,180`；`components/ui/button.tsx:17`）。
- 用户确认：采用“对齐主界面紧凑排版”，而不是保留大字号或只修局部断行。

## Requirements

- R1：嵌入模式下页面标题改为 `text-base`，建议列表标题改为 `text-sm`，详情标题改为 `text-base`。
- R2：嵌入模式下详情主操作按钮使用 `size="sm"`，与主界面按钮尺寸一致。
- R3：嵌入模式下详情区块间距由 `space-y-4` 收紧为 `space-y-3`，正文行高使用 `leading-5`。
- R4：独立 `/review.html` 整页排版保持不变。
- R5：不改后台消息、存储、业务语义与独立页面 URL 行为。

## Acceptance Criteria

- [x] 嵌入视图在 390px 下标题层级与主界面一致，无 20px 页面标题和 18px 详情标题。
- [x] 详情按钮为 `sm` 尺寸，窄屏下不横向溢出。
- [x] 独立 Review 页仍保持 `text-xl` / `text-lg` 整页排版。
- [x] `pnpm typecheck`、`pnpm test --run`、`pnpm build` 通过。

## Verification

- `pnpm typecheck`：通过。
- `pnpm test --run`：11 个测试文件、143 个测试通过。
- `pnpm build`：通过。
- Playwright（390×600，加载构建产物）：嵌入视图与返回后主视图 `main` 宽度均为 390px，`scrollWidth` 390px；截图确认标题 16px、详情标题 16px、按钮 `sm`，独立 Review 页仍正常渲染。

## Out of Scope

- 不调整主界面或 Settings 排版。
- 不改变 Review 业务操作、消息契约与视觉主色。
