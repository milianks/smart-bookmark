# Design: 架构改进规划(仅规划,不执行)

## 设计原则

第一性原理:分层骨架(entrypoints → services → lib → types,消息边界 Zod 校验,background 唯一装配点)健康,不动。乱源只有一个——`organizer.service.ts` 把 6 类职责装进一个类。手术式拆分,不引入新层、新依赖、新抽象。

拆分约束:6 类职责共享同一个 `PersistedState`(经 repository 读改写)。按"数据所有权"切块,不做 6 个服务各自碰全量状态的假解耦。

## 目标架构

### 目标文件树(services/ 内)

```
services/
  organizer.service.ts   任务管道(实时监听 → 分类 → 决策 → 移动/Review/撤销)
  scan.service.ts        历史扫描生命周期
  settings.service.ts    设置 + 草稿 + Provider 测试
  activity-log.ts        活动日志共享纯函数
  bookmark.service.ts    (不变)
  classifier.service.ts  (不变)
  notification.service.ts(不变)
```

### 模块边界

| 模块 | 职责(迁入方法,现行号) | 依赖 | 预估行数 |
|---|---|---|---|
| `organizer.service.ts`(瘦身) | onBookmarkCreated/onImportBegan/Ended(L56-116)、resume/processPending(L225-289)、approveReview/rejectReview(L366-493)、undoLastMove(L494+)、getDashboardState(L290-324) | classifier、bookmark、store、notifications、alarms port | ~380 |
| `scan.service.ts` | startHistoricalScan/approveAllHistoricalReviews/undoHistoricalLast(L118-224)、historicalScanSummary(L1057) | classifier、bookmark、store、notifications | ~150 |
| `settings.service.ts` | updateSettings(L325)、getSettingsDraft/updateSettingsDraft/clearSettingsDraft(L341-352)、testProvider(L356)、onSettingsUpdated(L266) | provider、store、hasProviderPermission port | ~100 |
| `activity-log.ts` | appendActivity(L1029)、pruneJobs(L1039) 等纯状态变换 | types | ~40 |

规则:

- 依赖方向不变:`services → lib/types`,服务间不互相 import(共享只经 repository 与 activity-log)
- `PersistedState` 结构不改,所有写仍走 `repository.update` 读改写,保持现有串行安全
- DI 沿用既有 ports 模式,background 为每个服务传各自 deps 对象(同 `OrganizerDependencies` 风格)
- `getDashboardState` 是跨域只读聚合,留在 organizer,不为它建模块

### 明确不做(及何时重新评估)

- **存储分域**:单 blob 在当前规模(书签任务量级)可接受;触发条件 = 状态超 ~100KB 或写入延迟可感。届时按域拆 key:settings / jobs / reviews / scans / activity。现在只记录此演进路径
- **UI 组件拆分**(SettingsApp 231 行、PopupApp 跨页面导入 SettingsApp):非痛点,下次改到时顺手
- **classifier/bookmark/notification 服务**:不动
- **types/domain.ts**(239 行):不动,zod schema 与类型同放是好结构

## 分批路线

每批 = 一个独立 Trellis 任务,行为零变化,现有测试断言不改;验证统一:`pnpm typecheck && pnpm test --run && pnpm build`,再 Chrome 手动冒烟(装 `.output/chrome-mv3/`)。回滚 = revert 该批提交。

**Batch 1:抽出 scan.service.ts + settings.service.ts**(最大、最干净的两刀,拿走 ~250 行)
- 迁移方法见上表;background.ts 装配与消息路由改为调用对应服务
- 测试随模块走:新增 scan.test.ts、settings.test.ts(从现有两文件迁用例)
- 完成后 organizer.service.ts 降至 ~800 行

**Batch 2:抽 activity-log.ts + 瘦身 organizer 到纯管道**
- 迁 appendActivity/pruneJobs;`approveReview`(117 行)拆私有步骤:校验 → 执行移动 → 记录 + 通知
- 合并 `organizer.test.ts` 与 `organizer.service.test.ts` 为一份,断言零修改
- 完成后 organizer.service.ts ~380 行,全部文件 <400

**Batch 3:background.ts 分离消息契约**
- `RequestSchema` + `handleRequest` 移至 `entrypoints/background/router.ts`;background 只留监听注册与 DI 装配
- 顺手修 `classifier.service.ts:11-12` 重复 import
- 完成后 background.ts ~60 行装配 + router ~90 行

**Batch 4(条件触发,暂不排期)**:存储分域,触发条件见上

## 风险与对策

- 共享状态竞态:MV3 事件循环单线程 + 所有写走 repository 读改写,现状已安全;拆分不新增写路径
- 行为漂移:每批以现有测试为契约,断言不许改;发现断言本身错才可改,须在任务 PRD 记录理由
- 测试迁移丢用例:Batch 1/2 迁移用例时逐条对账,迁移前后用例计数不减
