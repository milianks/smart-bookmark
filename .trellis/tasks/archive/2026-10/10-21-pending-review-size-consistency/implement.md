# 待确认页嵌入 Popup — 实施计划

## 实施顺序

1. **基线与上下文**
   - 记录 `git status`，确认工作区无未提交改动。
   - 阅读 `components/PopupApp.tsx`、`components/ReviewApp.tsx`、`components/ui/stat.tsx`、`components/SettingsApp.tsx`，确认 embedded 宽度策略。

2. **扩展 Stat 交互**
   - `components/ui/stat.tsx`：新增 `onClick?: () => void`；`onClick` 存在时渲染 `<button type="button" className={cn(classes, 'text-left')}>`。
   - 保持 `href` 与 `div` 分支不变。

3. **Popup 增加 Review 视图**
   - `components/PopupApp.tsx`：
     - `view` 类型加入 `'review'`；新增 `reviewScanId` state。
     - 在 settings 分支后添加 review 分支渲染 `<ReviewApp embedded scanId={reviewScanId} onBack={...} />`。
     - “待确认” `Stat` 改为 `onClick={() => { setReviewScanId(''); setView('review'); }}`。
     - “查看历史建议 →”改为 `<button type="button">`，点击设置当前 `scan.id` 并切换视图。
     - 移除未使用的 `reviewUrl`。

4. **ReviewApp 支持 embedded**
   - `components/ReviewApp.tsx`：
     - 增加 props 接口与默认值。
     - `scanId` 初始化改为 `props.scanId ?? query.get('scan') ?? ''`。
     - 根 `<main>` 使用条件 class：embedded `w-[390px] space-y-4 p-4`；否则现有整页 class。
     - 返回入口按 embedded 切换 button/anchor。
   - 不改任何 `sendMessage` 调用与状态标签。

5. **验证**
   - `pnpm typecheck`
   - `pnpm test --run`
   - `pnpm build`
   - 手动验收（`pnpm dev` 或加载 `.output/chrome-mv3/`）：
     - Popup 390px；点击“待确认”后 Popup 宽度不变，显示 Review。
     - 点击“查看历史建议 →”仅显示对应扫描建议。
     - 返回主视图后宽度仍为 390px。
     - 独立 `/review.html` 与通知入口行为不变。
     - 浅/深色、空态、加载态、长标题/长 URL、批准/拒绝/批量/撤销/元数据操作。

## 风险文件与回滚点

| 文件 | 风险 | 回滚 |
|---|---|---|
| `components/PopupApp.tsx` | 视图切换或入口回归 | 单文件回滚 |
| `components/ReviewApp.tsx` | standalone 行为或窄屏布局回归 | 单文件回滚 |
| `components/ui/stat.tsx` | 其他 Stat 渲染变化 | 单文件回滚 |

## 完成定义

- PRD 验收项全部勾选，或记录无法自动验证项的实际手动结果。
- 三项命令通过。
- 无后台、存储、权限、依赖改动。
- 独立 Review 页与通知深链保持可用。
