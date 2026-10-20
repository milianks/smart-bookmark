# 实施计划 — 分类质量与功能优化

## 顺序与清单（依赖驱动，小改动前置）

### 切片 1：R1 分词（基础，R4 依赖）
- [x] `lib/ai/rule-classifier.ts` `tokens()` CJK bigram
- [x] `tests/classifier.test.ts` 改既有断言 + 增 3 个中文用例
- 验证：`pnpm test --run tests/classifier.test.ts`

### 切片 2：R2 参数与 prompt
- [x] `lib/ai/openai-compatible.ts` `buildRequestBody` 三分支 temperature
- [x] `lib/ai/prompts.ts` 两条约束
- [x] `tests/openai-compatible.test.ts` 断言
- 验证：`pnpm test --run tests/openai-compatible.test.ts`

### 切片 3：R3 候选预算
- [x] `lib/ai/rule-classifier.ts` `rankFolderCandidates` 预算化
- [x] `tests/classifier.test.ts` 截断/保留当前文件夹用例
- 验证：`pnpm test --run tests/classifier.test.ts`

### 切片 4：R10 撤销栈（独立）
- [x] `types/domain.ts` `undoStack`；`lib/storage/repository.ts` `normalizeState` 迁移
- [x] `services/organizer.service.ts` push/pop；`getDashboardState` 暴露栈顶+计数
- [x] `tests/organizer.test.ts`/`repository.test.ts` 用例
- 验证：`pnpm test --run tests/organizer.test.ts tests/repository.test.ts`

### 切片 5：R6 重复检测（独立）
- [x] `services/scan.service.ts` 分组归并；ReviewItem `duplicates` 字段
- [x] 归档目录解析与降级路径；批量撤销计入
- [x] `tests/scan.service.test.ts` 用例
- 验证：`pnpm test --run tests/scan.service.test.ts`

### 切片 6：R5 Review 改目标（R4 数据源）
- [x] `types/domain.ts` `overrideFolderId`；`types/messages.ts` + router schema
- [x] `getDashboardState` 增 folders；`resolveReviewTarget` override 分支
- [x] `components/ReviewApp.tsx` 文件夹选择器
- [x] `tests/organizer.service.test.ts`/`background.router.test.ts` 用例
- 验证：`pnpm test --run tests/organizer.service.test.ts tests/background.router.test.ts`

### 切片 7：R4 纠错表
- [x] `types/domain.ts` `CorrectionEntry` + `PersistedState.corrections`；repository 默认值
- [x] organizer 写入（override 批准 / reject）；classifier 读取路由（域名命中免 API）
- [x] `lib/ai/prompts.ts` `recentCorrections` 注入；classifier.service 传参
- [x] `tests/classifier.test.ts` 纠错路由用例（断言 provider 未调用）
- 验证：`pnpm test --run tests/classifier.test.ts tests/organizer.service.test.ts`

### 切片 8：R9 分组 Review UI
- [x] `components/ReviewApp.tsx` 分组渲染 + 组批准循环
- 验证：`pnpm build` + 手工加载扩展走查 Review 页（截图）

### 切片 9：R8 批量分类
- [x] `lib/ai/prompts.ts` `buildBatchMessages`；`openai-compatible.ts` `classifyBatch`
- [x] `classifier.service.ts` 批量入口（缓存/规则/纠错先分流）
- [x] organizer `processPending` scan-job 聚批；单条失败隔离
- [x] `tests/openai-compatible.test.ts`/`classifier.test.ts` 批量用例
- 验证：`pnpm test --run`；`pnpm build` 后手工跑一次历史扫描观察调用数

### 切片 10：R7 外部根接管（最后，面最宽）
- [x] `types/domain.ts` settings + DEFAULT_SETTINGS；router patch schema；SettingsApp 开关
- [x] organizer 入口分支 + 边界放宽（externalRoot job）
- [x] README R7 段落与 F1 描述修订
- [x] 回归：开关关 = 现有全量测试零改动通过；开 = 新用例覆盖自动/Review/undo 路径
- 验证：`pnpm test --run`（全量）

## 每切片收尾

- [x] `pnpm typecheck` && `pnpm test --run`
- [x] 独立 commit（feat: R1 … 按序），保持可单 revert

## 全量验证

```bash
pnpm typecheck
pnpm test --run
pnpm build
```

手工冒烟（`pnpm dev` 或加载 `.output/chrome-mv3/`）：
1. 新增中文标题书签 → 观察规则命中（activity source=rule）
2. Review 改目标批准 → 书签落所选目录，同域名新书签免 API 直路由
3. 历史扫描含重复 URL → 单条重复 review；批准后较新项入归档
4. 开启外部根接管 → 星标到书签栏的新书签进队列；关闭后行为与现状一致
5. Popup 连续撤销 ≥2 次

## 风险文件与回滚点

| 文件 | 风险 | 缓解 |
|---|---|---|
| `services/organizer.service.ts`（1026 行，全部边界逻辑） | R5/R7/R8/R10 都动它 | 每切片独立 commit；R7 放最后单独评审 |
| `lib/storage/repository.ts` | 新字段默认值遗漏 → undefined 崩溃 | `normalizeState` 集中处理 + repository 测试 |
| `components/ReviewApp.tsx` | R5+R9 连续两轮改同一 UI | 切片 8 建立在切片 6 之上，中间隔切片 7 |
| `types/messages.ts` / router schema | 消息契约漂移 | 可选字段向后兼容；`background.router.test.ts` 同步 |

## task.py start 前检查

- [x] prd.md / design.md / implement.md 齐备（复杂任务三件套）
- [x] implement.jsonl / check.jsonl 若走子代理分发需真实条目；内联工作流跳过
- [x] 用户对最终规划摘要明确批准

## 验证记录（2026-10-20）

- `pnpm typecheck`：通过（0 错误）
- `pnpm test --run`：135/135 通过（11 个测试文件；新增 R1–R10 用例）
- `pnpm build`：通过，`.output/chrome-mv3/` 生成
- 行为冒烟：批次/撤销/纠错/重复/改目标/接管路径均由单测覆盖（含开关关闭时全量旧用例回归通过）
- 未覆盖：Chrome 内真实扩展 UI 冒烟需人工加载 `.output/chrome-mv3/`（本环境无浏览器交互）
- 提交：10 个切片独立 commit（6e86a6e..c5b12ef）
