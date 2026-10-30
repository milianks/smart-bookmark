# 提交计划

一个完整任务提交：`perf(storage): 降低状态读写与面板刷新开销`

用户已批准提交，并追加更新版本号至 0.2.3。额外纳入 `package.json`、`wxt.config.ts`、`README.md`、`CHANGELOG.md`。

## 文件清单

- `.trellis/spec/backend/database-guidelines.md`
- `.trellis/spec/backend/extension-runtime-contract.md`
- `.trellis/spec/frontend/extension-ui-contract.md`
- `.trellis/spec/frontend/state-management.md`
- `.trellis/tasks/10-30-storage-dashboard-perf/check.jsonl`
- `.trellis/tasks/10-30-storage-dashboard-perf/commit-plan.md`
- `.trellis/tasks/10-30-storage-dashboard-perf/design.md`
- `.trellis/tasks/10-30-storage-dashboard-perf/implement.jsonl`
- `.trellis/tasks/10-30-storage-dashboard-perf/implement.md`
- `.trellis/tasks/10-30-storage-dashboard-perf/prd.md`
- `.trellis/tasks/10-30-storage-dashboard-perf/task.json`
- `.trellis/tasks/10-30-storage-dashboard-perf/validation.md`
- `components/PopupApp.tsx`
- `components/ReviewApp.tsx`
- `components/SettingsApp.tsx`
- `components/dashboard-subscription.ts`
- `entrypoints/background.ts`
- `entrypoints/background/dashboard.ts`
- `entrypoints/background/router.ts`
- `lib/storage/repository.ts`
- `services/organizer.service.ts`
- `tests/background.approval.test.ts`
- `tests/background.router.test.ts`
- `tests/dashboard-notifications.test.ts`
- `tests/dashboard-subscription.test.ts`
- `tests/organizer.service.test.ts`
- `tests/perf/state-scale.test.ts`
- `tests/repository.test.ts`
- `types/domain.ts`
- `types/messages.ts`

## 保留且不纳入提交

- `.trellis/tasks/10-30-optimization-roadmap/`
- `.trellis/tasks/10-30-split-organizer-service/`
- `.trellis/tasks/10-30-background-cleanup-lint/`

任务提交后，归档与会话日志单独记录；不推送。
