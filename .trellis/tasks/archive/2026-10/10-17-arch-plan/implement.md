# 后续执行计划

## 本任务边界

本任务只交付架构梳理与重构路线，不执行产品代码重构。后续每个 Batch 独立建立 Trellis 任务，完成规划、实现、检查、提交和回滚验证。

## Batch 1：拆分扫描与设置服务

- 从 `OrganizerService` 提取 `scan.service.ts`：历史扫描生命周期、历史批量审批、历史批量撤销、扫描摘要。
- 提取 `settings.service.ts`：设置更新、草稿、Provider 测试、设置触发的恢复。
- 保持 `PersistedState`、runtime message 类型、background DI 装配行为不变。
- 从现有 `tests/organizer*.test.ts` 逐条迁移扫描/设置用例；断言内容不变，用例数量不得减少。
- 验证：`pnpm typecheck && pnpm test --run && pnpm build`，再加载 `.output/chrome-mv3/` 做启动、设置、扫描、Review 冒烟。
- 回滚：只回滚 Batch 1 提交；不回滚后续任务或用户本地状态。

## Batch 2：抽取活动日志与整理管道步骤

- 提取 `activity-log.ts` 纯状态变换，减少 Organizer 对日志细节的耦合。
- 将 `approveReview` 的实时校验、目录解析、移动恢复、状态记录拆为私有步骤，保持同一 mutation lock 和 pending intent。
- 合并两个 Organizer 测试文件前先逐条对账，保持断言和行为不变。
- 复跑全量质量门和 Chrome 手动冒烟。

## Batch 3：分离 runtime message 契约与路由

- 将 background 内联 `RequestSchema` 与 `handleRequest` 移到 `entrypoints/background/router.ts`。
- background 只保留 DI 装配、Chrome 监听器和错误边界。
- 保持 Zod strict 校验、API Key 隔离、所有书签变更仍经过服务。
- 顺手清理 `classifier.service.ts` 重复 import；不扩大到 UI 重构。

## 条件 Batch 4：存储分域

- 仅在单 blob 超过约 100KB 或整体写入延迟可感知时启动。
- 先设计迁移与回滚，再按 `settings/jobs/reviews/scans/activity` 分 key；现阶段不执行。

## 完成标准

- 每个 Batch 单独提交、可回滚、无用户可见行为变化。
- 每个 Batch 通过 `pnpm typecheck`、`pnpm test --run`、`pnpm build`、`git diff --check`。
- 任何行为变化、持久化字段变化或新增依赖必须回到独立 PRD 重新评审。
