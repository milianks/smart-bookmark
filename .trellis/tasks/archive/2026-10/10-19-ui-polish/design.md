# 优化扩展 UI — 技术设计

## 1. 边界与原则

- 仅改 `components/` 与 `components/styles.css`；`entrypoints/*/main.tsx` 保持薄挂载。
- 不新增依赖、不引入组件库、不改变 `types/messages.ts`、后台服务、存储结构与权限流程。
- 所有用户/模型文本仍作为 React 文本节点渲染。
- 延续 violet 主色 + slate 中性色；浅色/深色同等对待。
- 交付顺序：共享原语 → Popup → Review → Settings → 全量验证。每阶段可独立回滚。

## 2. 共享原语

| 文件 | 变更 |
|---|---|
| `components/ui/button.tsx` | 统一 `focus-visible` 环、`active` 反馈、过渡；保持 `primary/secondary/ghost/danger` 与 `sm/md`。补 `icon` 尺寸仅在有实际图标按钮时加入。 |
| `components/ui/badge.tsx` | 增加 `tone: neutral / primary / success / warning / danger` 映射；保留 `className` 覆盖能力。 |
| `components/ui/field.tsx` | 抽取并导出 `Select`，与 `Input/Textarea` 共用边框、圆角、focus ring、disabled、深色样式；`Field` 增加可选 `htmlFor` 不强制。 |
| `components/ui/switch.tsx`（新） | 原生 button + `role="switch"` + `aria-checked`；`sm/md` 两种尺寸；带滑块过渡、`focus-visible` 环、disabled 态；支持 `label` 渲染为可点击整行。 |
| `components/ui/notice.tsx`（新） | `role="status"` / `role="alert"` 提示条，`tone: success / error / warning / info`；统一浅/深色、边框与图标位置（图标用文本符号，避免新依赖）。 |
| `components/ui/disclosure.tsx`（新） | 原生 `<details>` + 样式化 `<summary>`：可见焦点环、chevron 旋转、`open` 时标题强调；内容区统一间距。 |
| `components/ui/skeleton.tsx`（新） | 加载占位块，`animate-pulse` + `motion-reduce:animate-none`；用于三页初始加载。 |
| `components/ui/stat.tsx`（新，可选） | Popup 状态摘要的紧凑指标单元：label + value + 可选链接/描述，保证 390px 下三列不溢出。 |

`components/styles.css`：

- 保留现有字体与背景；补充 `::selection`、`@media (prefers-reduced-motion: reduce)` 下关闭过渡。
- 不设置全局 `html/body` 宽度；Popup 仍由页面根节点 `w-[390px]` 决定。

## 3. Popup 信息架构

目标：390px 首屏先回答“现在是否在整理、有没有等我处理的事”，再提供历史与明细。

顺序：

1. **Header**：图标、产品名、副标题、AI 状态 badge。
2. **自动整理卡**：标题 + 说明 + `Switch`；说明文案根据 `hasApiKey`、`enabled` 变化。
3. **状态摘要**：三格紧凑指标（`Stat`）：
   - 待确认：`pendingReviews.length`；>0 时整格为链接，跳转 Review。
   - 历史扫描：`historicalScan.status` 对应文案；进行中显示强调色。
   - 最近结果：`activities[0]` 的 kind 标签；无记录显示“暂无记录”。
4. **需要处理的提示**：等待 API Key / 等待权限的 banner，保留“前往设置”操作。
5. **Disclosure：历史书签整理**（默认折叠）：summary 内显示状态；内容含进度、计数、开始扫描/撤销按钮。
6. **Disclosure：最近书签**（默认折叠）：刷新入口 + 最近 3 条 `BookmarkCard`。
7. **Disclosure：最近操作**（默认折叠）：`RecentActivity`。
8. **Footer**：撤销上次归档（不可用时弱化说明）+ 设置。

移除现有独立的“待确认”卡片，避免与状态摘要重复。历史扫描卡不再常驻展开。

## 4. Review 页面

- Header：返回链接、标题、说明、待处理计数、批量批准/撤销按钮；窄屏换行不溢出。
- 左栏：
  - `lg` 及以上：垂直列表，条目显示标题、域名、状态点与来源；选中项使用 primary surface + 左侧强调条；所有条目有 `focus-visible`。
  - `lg` 以下：列表变为横向滚动 chip 行，避免长列表把详情推到首屏之外。
- 详情卡：
  - 来源 badge + 标题 + 置信度条（视觉条 + 百分比文本，不只靠颜色）。
  - URL 链接、摘要/标签块、推荐操作块、理由。
  - 操作区按优先级排列；非 pending 状态显示状态 badge。
- 空态与加载态使用共享 `Skeleton` / 统一空态样式。
- 保留 `role="status"` / `role="alert"`，改用 `Notice`。

## 5. Settings 页面

- Header：返回、标题、说明、连接状态 badge。
- AI 服务卡：`Select` 统一协议选择；输入/密钥保持现有行为；保存与“授权并测试”按钮分组，说明当前连接状态。
- 书签整理卡：自动整理改用共享 `Switch`（整行可点击）；阈值滑杆显示当前值并加 `aria-valuetext`；模式选择改用 `Select`。
- 通知设置、隐私与权限、最近操作改为 `Disclosure`，默认折叠。
- 保留草稿持久化与所有 runtime message 调用不变；嵌入 Popup 时仍为 `w-[390px]`。
- 加载态使用 `Skeleton`，错误/成功使用 `Notice`。

## 6. 状态、可用性与响应式

- 焦点：所有按钮、链接、summary、列表项、开关、输入均有可见 `focus-visible`（violet ring + offset），深色下 offset 使用 slate-950。
- 状态传达：颜色 + 文本/图标；badge 文案保持现有中文标签。
- 动效：仅使用 `transition-colors`、滑块位移、chevron 旋转；`prefers-reduced-motion` 下关闭。
- 触控目标：交互控件最小高度 32px（紧凑）或 40px（常规）。
- 响应式断点：`sm`、`lg` 与现有页面一致；不新增自定义断点。
- 文案：保持中文；动词开头、避免内部术语；错误信息仍来自后台消息，不新增堆栈信息。

## 7. 兼容与回滚

- 无数据迁移、无后台契约变更；旧状态与新 UI 完全兼容。
- `RecentActivity` 与 tooltip 行为保持不变，仅调整容器与间距；不回退未提交的 tooltip 改动。
- 每个阶段独立提交；如 Review 布局在窄屏出现回归，可单独回滚该文件而不影响共享原语。

## 8. 权衡

- **原生 `<details>` vs 自建折叠**：选原生，键盘与可访问性免费；代价是 summary 样式需跨浏览器适配（Chrome 134+ 目标环境可控）。
- **保留三个页面组件为单文件**：不拆 hooks/store，避免扩大范围；仅抽取视觉原语。
- **不引入图标库**：用既有 emoji/文本箭头与 CSS 形状；代价是图标精细度有限，但零依赖、零打包体积。
- **状态摘要 vs 独立待确认卡**：选摘要，减少重复；代价是待确认入口变小，因此整格可点击并保留计数。
