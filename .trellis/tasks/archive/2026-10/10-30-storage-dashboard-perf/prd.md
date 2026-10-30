# 存储写入与面板刷新性能

## Goal

让 5000 条书签的历史扫描与日常整理不因状态读写和面板刷新而线性变慢，并用可重复的基准测试量化改进。

## Background

- `ChromeStateRepository.update()`（`lib/storage/repository.ts:41-56`）：每次 `readNow` → `storage.get` → `normalizeState`（含每条缓存 `TextEncoder` 编码，`repository.ts:152`）→ mutator → 再次 `normalizeState` → 两次 `JSON.stringify` → 整包 `storage.set`。`load()` 同样每次走完整读取与校验。
- `organizer.service.ts` 29 处、`scan.service.ts` 4 处、`settings.service.ts` 4 处 `store.update`；单条书签处理路径会多次读写。
- 历史扫描在 `scan.service.ts:57` 一次写入全部候选 job，`coveredIds` 也随候选数增长。
- UI 只通过 runtime message 读取状态（`components/` 内无 `chrome.storage` 写入），但通过 `chrome.storage.onChanged` 订阅整个 state key，每次变更都会把完整新旧值序列化给每个打开的扩展页，再发一次 `state:get`。
- `getDashboardState` 每次调用 `getFoldersWithinSmartRoot` 重读书签树，并返回全部 `historicalReviews`。Popup 不使用 `historicalReviews`/`folders`，Settings 只使用 `activities`/`aiStatus`/`settings`。

## Requirements

- R1 基准：新增可在 Node/Vitest 下运行的基准（内存 `LocalStorageArea` 假实现），覆盖 5000 书签历史扫描入队、逐条 `update`、`getDashboardState`，记录调用次数、序列化字节数与耗时。默认测试运行中只断言调用次数/字节数等确定性指标，不断言墙钟耗时。
- R2 读取：同一 service worker 生命周期内避免重复从 storage 读取并全量校验未变化的状态；外部写入（其他上下文、旧版本、测试直接写 storage）必须仍能被观察到。
- R3 写入：保持现有 `update()` 的串行、原子语义与崩溃一致性（`pendingOperation` 必须在书签移动前落盘）。不得引入延迟合并写入导致 worker 被回收时丢数据。
- R4 校验：存储边界（缓存 200 条结果 / 单条 64 KiB、activities 100、jobs 250 已结束、reviews 250 已结束、metadata 2000 等）语义不变；从 storage 读入的数据仍做完整校验。
- R5 面板：UI 变更通知不再携带完整状态；`state:get` 按页面裁剪返回内容；文件夹列表在书签树未变化时复用。
- R6 兼容：`StateRepository` 接口与持久化 key、格式保持兼容；旧数据可读；回滚到旧版本后旧版本仍能读取新版本写入的数据。

## Acceptance Criteria

- AC1 (R1)：基准测试存在并可单独运行，并断言状态峰值 < 5 MB；PR 描述中给出改动前后的对比数字。
- AC2 (R2, R4)：连续两次 `load()` 且中间无写入时，`storage.get` 不重复调用全量校验；外部直接改 storage 后下一次 `load()` 能读到新值（有测试）。
- AC3 (R3)：`update()` 并发调用仍按顺序执行；mutator 抛错不污染缓存；现有 repository、organizer 的崩溃恢复测试全部通过。
- AC4 (R5)：5000 书签扫描期间，UI 每次变更收到的消息体积为常数级；Popup 的 `state:get` 响应不含 `historicalReviews`；书签树无变化时连续 `state:get` 只读一次树。
- AC5 (R6)：用旧版本格式的 state fixture 读写往返测试通过。
- AC6：`pnpm typecheck`、`pnpm test --run`、`pnpm build`、`git diff --check` 通过。

## Decision

- 不申请 `unlimitedStorage`（用户 2026-10-30 确认）。依靠现有存储上限控制体积：R1 基准断言 5000 书签扫描期间状态峰值 < 5 MB，为 `chrome.storage.local` 默认 10 MB 配额保留一半余量。单 key 超配额会使后续所有写入失败，若基准超出阈值，应收紧存储上限或另开分 key 任务，而不是扩大权限。

## Out of Scope

把状态拆成多个 storage key（见 design.md「第二阶段」，仅在基准证明必要时另开任务）、IndexedDB、新依赖、分类逻辑变更、UI 视觉改动。
