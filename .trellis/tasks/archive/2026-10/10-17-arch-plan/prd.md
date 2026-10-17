# PRD: 架构梳理与重构规划(仅规划)

## Goal

用户感知"当前架构有点乱"。产出架构改进规划文档;本任务不改任何产品代码。后续重构由独立任务按规划分批执行。

## 背景(代码证据)

产品代码约 4.6k 行(不含 tests/ 与 .wxt)。分层:`entrypoints → services → lib → types`。

### 保留的优点(规划中不动)

- UI 只依赖 `types/`,经 runtime messages 与 background 通信,components 无 chrome API 调用
- `entrypoints/background.ts:42-64` 是唯一 DI 装配点;`OrganizerDependencies` + ports(`RetryAlarmPort`)注入,服务可测试
- Zod 在消息边界校验(`background.ts:13-39`);不记录敏感信息

### 确认的问题(按影响排序)

1. **`services/organizer.service.ts` 1063 行 god class**(约 22% 产品代码)。单一 `OrganizerService` 约 19 个 public 方法,混合至少 6 类职责:
   - 实时监听 + 导入抑制(`onBookmarkCreated`/`onImportBegan`/`onImportEnded`,L56-116)
   - 任务队列 + 重试 + 恢复(`resume`/`processPending`,L225-289)
   - 历史扫描/批量批准/批量撤销(`startHistoricalScan` 等,L118-224)
   - Review 确认队列(`approveReview`/`rejectReview`,L366-493,`approveReview` 单方法 117 行)
   - 设置 + 草稿 + Provider 测试(L325-365)
   - Dashboard 状态/撤销/活动日志(L290-324, L494+)
   测试侧 490 + 257 行两个文件,命名不一致(`organizer.test.ts` vs `organizer.service.test.ts`)。
2. **`PersistedState` 单 blob 存储**:设置、任务、缓存、待确认、日志全在一个对象,每次更新整体读改写;`pruneJobs`(`organizer.service.ts:1039`)说明已有膨胀迹象。
3. **`background.ts` 内联消息 Zod schema + 路由 switch + DI 装配**三件事混在 154 行;当前可接受,每加一种消息必增长。
4. 小问题:`classifier.service.ts:11-12` 重复 import;`PopupApp.tsx:6` 跨页面导入 `SettingsApp`;`SettingsApp.tsx` 231 行单组件。

## Requirements

- R1: 规划文档给出目标模块划分:拆解 `organizer.service.ts` 各职责到独立模块,标注每个模块的职责边界、依赖方向、预估行数
- R2: 规划文档给出分批重构路线:每批行为零变化、可独立验证、可回滚;明确验证命令
- R3: 规划文档覆盖次要问题处置(存储演进、消息契约分离、零碎问题),标注做/不做/何时做
- R4: 依赖方向保持 `entrypoints → services → lib → types` 不变;DI 装配仍集中于 background

## Acceptance Criteria

- `design.md` 含:现状图、目标模块清单(职责/边界/依赖/预估行数)、分批路线(每批含验证命令与回滚点)
- 不引入新依赖、不改产品代码(本任务 diff 仅 `.trellis/` 内文档)
- 分批路线中第一批(organizer 拆分)规模足够小,可单任务完成
- 每批完成标准:`pnpm typecheck`、`pnpm test --run`、`pnpm build` 全绿,现有测试断言不变

## Out of Scope

- 任何产品代码修改(重构留给后续独立任务)
- P2 功能(摘要/标签/正文抓取/多 Provider/同步)
- UI 视觉重设计
- 存储分域的实际实施(仅在规划中记录演进路径)

## Key Decisions

- 交付范围:仅规划文档(用户确认,2026-10-17)
- 重构策略:外科手术式——拆 god class 为主,分层骨架不动
