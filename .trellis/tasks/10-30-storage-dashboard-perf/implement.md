# Implementation plan

## Prerequisites

- 用户批准 PRD/design。已确定不申请 `unlimitedStorage`。
- 开始前确认源码干净（保留已有四个未跟踪任务目录）；在 `perf/storage-dashboard` 分支上工作。

## Ordered work

1. 基准：新增 `tests/perf/state-scale.test.ts` 与内存 storage 计数器。记录基线数字（get/set 次数、写入总字节、状态峰值字节），写入 `validation.md`。**回滚点 A**。
2. Repository 读缓存与外部写入失效（design §2）。补测试：重复 load 不重读、外部写入可见、mutator 抛错、`set` 失败、旧格式 fixture 往返。重跑基准记录差值。**回滚点 B**。
3. 写入侧开销（design §3）：无变更检测复用序列化串；取消无稳定引用基础的 WeakMap 记忆化，保留写侧校验。逐处评估 organizer 相邻 `update` 合并，每合并一处跑 `tests/organizer.service.test.ts`。**回滚点 C**。
4. 面板（design §4）：端口通知替换 `storage.onChanged`；`state:get` 的 `view` 参数与类型调整；文件夹缓存与失效。更新 `tests/dashboard-subscription.test.ts`、`tests/background.router.test.ts`，新增文件夹缓存失效测试。**回滚点 D**。
5. 更新 `.trellis/spec/backend/extension-runtime-contract.md`（读缓存与失效、通知通道、`view` 契约）和 `.trellis/spec/frontend/state-management.md`。
6. 最终基准对比写入 `validation.md`，独立 review，跑完整门禁。

## Validation

Focused:

```bash
pnpm test --run tests/perf tests/repository.test.ts tests/dashboard-subscription.test.ts
pnpm test --run tests/organizer.service.test.ts tests/scan.service.test.ts tests/background.router.test.ts
```

Final gate:

```bash
pnpm typecheck
pnpm test --run
pnpm build
git diff --check
```

如条件允许，在 Chrome 加载 `.output/chrome-mv3/` 导入约 5000 条书签做一次手动验证；否则在 PR 中明确只有 Node 基准数据。

## 实施进度

- [x] 用户批准方案；任务激活，分支 `perf/storage-dashboard`。
- [x] 旧版基线、缓存实现、keep 写入合并、端口通知和视图投影、文件夹缓存。
- [x] 缓存失败/竞态/旧格式、视图、文件夹失效、端口通知/重连测试。
- [x] 独立检查与完整门禁通过；验证记录已完成。
- [x] 用户批准提交并更新版本为 0.2.3；提交后归档与记录会话。

主代理维护规范；实现代理维护代码、测试与 `validation.md`。本轮尚未提交。
