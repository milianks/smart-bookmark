# 拆分 organizer.service

## Goal

把 1605 行的 `services/organizer.service.ts` 拆为职责清晰、各自低于 800 行的模块，外部行为与持久化格式完全不变。

## Background

- `OrganizerService` 同时承担：书签事件入口（`onBookmarkCreated/Removed/Import*`）、任务调度（`resume/processPending/processJob/processBatch/prepareJob`）、审核流程（`approveReview` 及 `loadReviewForApproval/resolveReviewTarget/revalidateReviewBeforeMove/validateDuplicateReview/prepareReviewMove/recordApprovedReview`、`rejectReview`）、撤销（`undoLastMove/undoHistoricalLast`）、面板组装（`getDashboardState`）以及模块级辅助函数（`organizer.service.ts:1496-1605`）。
- `tests/organizer.service.test.ts` 1754 行、`tests/organizer.test.ts` 536 行，覆盖大量崩溃恢复与并发场景，是本次拆分的安全网。

## Dependency

必须在 `10-30-storage-dashboard-perf` 合入后开始，避免与其对 `store.update` 调用点的改动冲突。

## Requirements

- R1：`OrganizerService` 保留为对外门面，公开方法签名、`OrganizerDependencies`、`background.ts` 与 router 的调用方式不变。
- R2：按职责拆出内部模块（建议：`organizer/review-flow.ts`、`organizer/undo.ts`、`organizer/job-runner.ts`、`organizer/dashboard.ts`、`organizer/helpers.ts`），模块间通过显式参数共享依赖，不引入全局状态。最终方案在开工前写入 `design.md`。
- R3：纯移动优先。拆分提交中不修改业务逻辑；发现的问题另记，不在本任务修。
- R4：现有测试不删除断言；仅在 import 路径变化时调整。可为新模块补充直接单测。

## Acceptance Criteria

- AC1：拆分后每个文件 < 800 行，`OrganizerService` 门面文件 < 400 行。
- AC2：`git diff` 中除 import/导出与方法搬移外无逻辑改动（review 时逐块确认）。
- AC3：`pnpm typecheck`、`pnpm test --run`、`pnpm build`、`git diff --check` 通过，测试数 ≥ 拆分前。

## Out of Scope

行为修复、性能优化、测试文件大规模重组（可随后另开任务）。
