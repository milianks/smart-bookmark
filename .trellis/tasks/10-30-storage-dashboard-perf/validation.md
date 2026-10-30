# 存储与面板性能验证

## 范围与方法

- 基线源码：`00a2619`，改动前先添加相同场景基准运行，未改生产代码。
- 命令：`PERF=1 pnpm test --run tests/perf/state-scale.test.ts`。
- 固定工作量：5000 条书签历史扫描入队；将其中 15 条设为 queued，由真实 `OrganizerService.processPending()` 与假分类器执行一个 keep 批次；连续查询 3 次完整 dashboard。
- 内存 storage 模拟 Chrome 数据复制；计数 get/set、序列化写入字节与峰值。新版注入 storage 变更监听；旧版没有缓存接口。
- **未运行全部 5000 条分类完成流程**。测量大状态下的一批处理成本，不能外推为完整扫描总耗时。

## 相同工作量对比

| 指标 | 改动前 | 改动后 |
|---|---:|---:|
| storage.get 次数 | 136 | 1 |
| storage.set 次数 | 63 | 33 |
| 累计写入字节 | 71,614,991 B | 37,500,863 B |
| 状态写入峰值 | 1,139,257 B | 1,139,326 B |
| 连续 3 次 dashboard 读树 | 3 | 1 |
| 完整 dashboard 响应合计 | 17,349 B | 17,349 B |
| 单次观测耗时，仅参考 | 9072 ms | 5096 ms |

累计写入减少约 47.6%；峰值增加 69 B（写入 token），低于 5,000,000 B 门槛。完整 dashboard 结构兼容，因此同样请求的响应大小不变；popup/settings 的投影分别由契约测试验证字段缺省。

默认基准断言：get=1、set≤33、累计写入<38,000,000 B、峰值<5,000,000 B、3 次 dashboard 读树=1。无墙钟耗时断言。

## 正确性覆盖

- 缓存连续读取、独立快照、外部直接写入（含保留本实例 token）、删除状态、并发 update 顺序。
- mutator 抛错、mutator 保留引用后修改、storage.set 失败后恢复。
- 外部事件抢先于 get 返回、外部写入抢先于本次 set 完成，均不回填陈旧缓存。
- 旧格式 fixture 往返、旧版设置白名单兼容、原有 AI cache epoch 测试保留。
- popup 不含 folders/historicalReviews；settings 仅含 settings/activities/aiStatus；默认请求保留完整响应；router 严格验证 view。
- 文件夹 root 变化、失效、读失败重试、进行中旧请求完成后不回填新缓存。
- 5000 次模拟 storage 变更合并为常量消息 `{ type: 'state:changed' }`（24 字节）；无关 key/区域忽略；端口断开与连接失败后重连，卸载清理。
- 原有 organizer 崩溃恢复、WAL、移动失败与缓存有效性测试全部保留。

## 完整门禁

- `pnpm typecheck`：通过。
- `pnpm test --run`：17 文件、294 测试通过。
- `pnpm build`：通过，产物 634.39 kB；Zod 依赖的 PURE 注释位置警告不影响产物。
- `git diff --check`：通过。
- 无 lint 脚本，未新增依赖、权限或修改 manifest。

## 设计偏差与剩余限制

- 不实施 WeakMap：clone/schema parse 产生新对象，无稳定引用命中基础；保留写入边界完整校验。
- 仅合并 keep 路径的 3 次相邻写入；涉及 bookmark API/WAL 的写入顺序保持。
- worker storage 监听转发端口通知，可覆盖外部写入；不只在本实例 set 后通知。
- 保留 DashboardState 完整类型，增加页面投影类型，而非把所有字段设为可选。
- 单 key 与整体克隆/序列化仍然随状态大小增长；本次降低调用次数，未消除该复杂度。
- 未运行 Chrome 实机、真实 provider 或浏览器传输量采样。没有 storage 监听器的页面避免接收整包事件负载目前是架构推断；已实测的是 Node 端口消息契约。
- 未提交、未推送、未归档。


## 独立检查

- `trellis-check` 全范围检查：存储缓存及自写/外部事件、串行更新与失败恢复、keep 合并、视图调用链、端口订阅与重连、文件夹失效与旧格式兼容；未发现需修复的代码缺陷。
- 修正规范表述：Dashboard 文件夹缓存不用于分类/移动检查；端口订阅消费者是 Popup/Review，Settings 保留挂载与操作后的刷新。
- 独立运行 `pnpm typecheck`、`pnpm test --run`：通过，17 文件、294 测试。`git diff --check`：通过。
- 构建沿用实现阶段通过记录；检查阶段只改文档，未重复构建。Chrome 实机与完整 5000 条扫描仍未验证。

## 0.2.3 版本更新

用户批准提交并更新版本号。package.json、wxt.config.ts、README badge 与 CHANGELOG 同步为 0.2.3；重新执行 typecheck、17文件294项测试、build、diff check 全通过，产物 manifest.version 为 0.2.3。
