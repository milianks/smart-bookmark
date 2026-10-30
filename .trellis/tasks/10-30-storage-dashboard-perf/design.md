# 存储与面板刷新性能设计

## 原则

先测量后优化。每一步都以 R1 基准的调用次数/字节数作为判断依据，基准不支持的步骤不做。保持单 key 持久化格式，所有改动可单独回滚。

## 1. 基准（先行）

- `tests/perf/state-scale.test.ts`：内存 `LocalStorageArea`，计数 `get`/`set` 次数与 `set` 的 `JSON.stringify` 字节数。
- 场景：5000 书签树 → `startHistoricalScan` → 以假 provider 处理 N 个批次 → 连续 3 次 `getDashboardState`。
- 默认只断言确定性指标的上限（防回归）；墙钟耗时仅在 `PERF=1` 时打印，不作为断言。
- 记录并断言状态峰值字节数 < 5 MB（不申请 `unlimitedStorage`，默认配额 10 MB）。

## 2. Repository 读缓存（R2）

- `ChromeStateRepository` 持有最近一次已校验的 `PersistedState` 及其序列化串。
- `load()`/`update()` 命中缓存时跳过 `storage.get` 与读侧 `normalizeState`，仍返回 `structuredClone`，避免调用方改写缓存。
- 失效：每次写入在持久化对象中附带内部写入标记（与现有 `_classificationCacheEpoch` 同样放在不被旧版本白名单保留的位置）；通过可注入的 `onChanged` 订阅，收到该 key 变更且不是本实例尚未消费的自写事件时清空缓存（每个 token 仅忽略一次，外部保留同一 token 的写入仍失效）。未注入订阅（测试默认）时退化为当前行为：每次都读。
- mutator 抛错、`storage.set` 失败：丢弃缓存，下次重新读取。
- 旧版本读取新数据：内部标记被其 `normalizeState` 丢弃，不影响读取。

## 3. 写入侧开销（R3, R4）

- 无变更检测改用缓存的序列化串，省去 mutator 前的一次 `JSON.stringify`。
- 不使用 `WeakMap`：`structuredClone` 与 Zod parse 均产生新对象，引用缓存没有稳定命中基础。保留每次写入的完整缓存 schema/字节校验，读缓存命中则直接省去读侧校验。
- 减少调用点：只在不跨越书签 API 调用、且不破坏 `pendingOperation` 先落盘顺序的地方，合并 organizer 单条路径上相邻的 `update`。每处合并需有现有测试覆盖，否则不动。不引入定时合并写入。

## 4. 面板通知与裁剪（R5）

- 通知：background 维护 `chrome.runtime.onConnect` 的 `dashboard` 端口集合。worker 的 `storage.onChanged` 收到状态变更后，经 100 ms 合并向端口发送 `{ type: 'state:changed' }`。`subscribeDashboard` 改用端口，移除 `storage.onChanged` 监听，使扩展页不再接收整包状态的变更事件。端口断开（worker 回收）时 UI 等待 1 秒重连，连接成功后合并刷新一次；后台连接握手也通知，关闭初次请求与订阅注册间隙。书签事件失效文件夹缓存时也通知 UI。
  - 需在 Chrome 中确认：没有 `storage.onChanged` 监听器的扩展页不会收到该事件负载。不能实机确认时保留该项结论为「推断」，并在 PR 中说明。
- 裁剪：`state:get` 增加可选 `view: 'popup' | 'review' | 'settings'`，缺省返回当前完整结构以兼容旧调用；保留完整 `DashboardState`；使用 `PopupDashboardState = Omit<...>` 和 `SettingsDashboardState = Pick<...>` 表达投影，避免旧调用字段被普遍弱化为可选。Popup 不返回 `historicalReviews`/`folders`；Settings 只返回其使用字段。
- 文件夹缓存：`OrganizerService` 缓存 `getFoldersWithinSmartRoot` 结果。background 在 `bookmarks.onCreated/onRemoved/onChanged/onMoved/onChildrenReordered/onImportEnded` 时调用 `invalidateFolders()`。仅 `getDashboardState` 使用缓存；分类与移动前的校验路径继续实时读树，不放宽 live mutation 检查。

## 兼容与回滚

- 持久化 key、字段、上限不变；新增的只有被旧版本忽略的内部标记。
- 第 2、3、4 节各自独立提交，任一节可单独 revert。

## 第二阶段（不在本任务内）

若基准显示单 key 写入字节数仍主导开销（例如 jobs 占比过大），再另开任务评估将 `jobs`/`reviews`/`bookmarkMetadata` 拆成分 key 存储，并设计迁移与回滚。

## 实施记录

- 合并 `applyClassification` 的 keep 分支：分类结果、completed 状态、活动记录一次持久化；原本 3 次写入降为 1 次。移动/审批/WAL 路径不合并。
- 文件夹缓存以 root ID 与 Promise 隔离并发加载；失效清除入口，旧请求完成不回填；失败不缓存，下一次重试。
- R1 工作量固定为 5000 条入队、其中 15 条一个真实 organizer 批次、3 次完整 dashboard 查询；不是扫描完全部 5000 条。默认无耗时断言，`PERF=1` 打印时间供参考。
