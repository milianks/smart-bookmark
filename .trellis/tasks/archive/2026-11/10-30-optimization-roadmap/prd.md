# 规模化性能与可维护性优化

## Goal

在大书签量（数千条）下保持后台整理与面板响应流畅，并降低核心服务的维护成本。本任务是父任务，只负责任务地图、跨子任务验收和最终集成复核，不直接承载实现。

## Background（2026-10-30 体检）

- 基线：`pnpm typecheck` 通过；`pnpm test --run` 15 个文件、282 个测试通过；`pnpm build` 产物 632 KB；源码无 TODO/FIXME。
- 全部状态存于单一 key `ai-bookmark-manager.state.v1`。`ChromeStateRepository.update()`（`lib/storage/repository.ts:41`）每次都读取、全量 `normalizeState`、两次 `JSON.stringify` 并整包写回；`organizer.service.ts` 有 29 处 `store.update`。
- 历史扫描把全部候选写入 `jobs`，未结束的 job 不被 `pruneJobs`（`services/activity-log.ts:13`）裁剪，状态体积随书签数线性增长，单次写入成本随之增长，整个扫描约为 O(n²)。
- 所有 UI 订阅 `chrome.storage.onChanged` 的整个 state key（`components/dashboard-subscription.ts`），每次写入都会把完整新旧值投递给每个打开的页面，并触发一次 `state:get`；`getDashboardState`（`services/organizer.service.ts:283`）每次都重读书签树并返回全部历史审核项。
- `services/organizer.service.ts` 1605 行，超过项目 800 行上限；`entrypoints/background.ts` 中 `hasProviderPermission` 重复 3 次；仓库无 lint 脚本。

## Task Map

| 子任务 | 交付 | 优先级 |
|---|---|---|
| `10-30-storage-dashboard-perf` | 基准测试 + 写入/读取/面板刷新开销下降 | P1，先做 |
| `10-30-split-organizer-service` | OrganizerService 拆分，行为不变 | P2，在 perf 之后 |
| `10-30-background-cleanup-lint` | 权限检查去重 + lint 脚本与 CI | P3，可随时独立做 |

顺序约束：拆分 organizer 会大面积移动 `store.update` 调用点，与 perf 任务冲突，必须在 perf 合入后开始。lint 任务与二者无依赖，但若先做，应只修 lint 报错、不做语义改动。

## Cross-child Acceptance Criteria

- 每个子任务完成后 `pnpm typecheck`、`pnpm test --run`、`pnpm build`、`git diff --check` 全部通过，测试数不减少（拆分可迁移测试但不删除断言）。
- 持久化格式保持向后兼容：旧版本写入的 state 能被新版本读取，未知字段不丢失原有语义。
- 不新增运行时依赖；不扩大权限（已确认不申请 `unlimitedStorage`）。
- 不声称 Chrome 实机或真实模型验证，除非确实执行。

## Out of Scope

新功能、UI 改版、分类策略变更、发版。
