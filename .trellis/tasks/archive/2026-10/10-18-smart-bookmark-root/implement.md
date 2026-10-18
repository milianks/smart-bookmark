# 实施计划：智能书签专属目录

## 顺序

1. **Manifest 与状态契约**
   - 在 `wxt.config.ts` 增加 `identity.email`。
   - 在 `types/domain.ts` 增加智能根目录 ID/初始化状态字段。
   - 在 `lib/storage/repository.ts` 保持旧状态可读，并为新字段做安全归一化。
2. **根目录初始化**
   - 在现有书签服务复用树读取、创建、managed 检查能力。
   - 实现账号邮箱本地部分解析、`bookmark` 回退、书签栏根查找、根目录幂等创建和一次性默认布局。
   - 在 `entrypoints/background.ts` 的 `onInstalled`、`onStartup` 和 worker 首次运行路径调用初始化；失败只记录安全错误并允许重试。
3. **根目录范围 API**
   - 给 `BookmarkPort` 增加根目录后代判定、受限文件夹枚举和受限历史枚举所需能力。
   - 将 `OrganizerService` 的新增事件、分类、自动移动、Review 审批、撤销恢复全部改为实时根目录校验。
   - 保留旧 `forceOrganize` 字段但取消其扩大范围的效果，移除设置页对应开关。
4. **分类输入与 AI 隔离**
   - 分类器只接收根目录内文件夹摘要和书签元数据。
   - 目标 ID、建议父目录 ID 均在发送后和移动/创建前再次验证。
   - `BookmarkMetadataService` 增加根目录检查。
5. **历史扫描**
   - 将 `ScanService` 改为只扫描智能根目录子树，更新 scan 状态和测试夹具。
   - 维持现有 Review、批量审批、批量撤销和重启恢复语义。
6. **测试与回归**
   - 更新 Bookmark、Organizer、Scan、Repository、Metadata 测试。
   - 增加初始化幂等、身份回退、根外不触发 AI、根外目标拒绝、用户手动移动不覆盖、根删除后安全失败测试。
   - 运行类型检查、Vitest 和生产构建。

## 涉及文件

- `wxt.config.ts`
- `entrypoints/background.ts`
- `services/bookmark.service.ts`
- `services/organizer.service.ts`
- `services/scan.service.ts`
- `services/bookmark-metadata.service.ts`
- `lib/storage/repository.ts`
- `types/domain.ts`
- `components/SettingsApp.tsx`
- `tests/bookmark.service.test.ts`
- `tests/organizer.test.ts`
- `tests/organizer.service.test.ts`
- `tests/scan.service.test.ts`
- `tests/repository.test.ts`
- `tests/bookmark-metadata.service.test.ts`

## 验证命令

```bash
pnpm typecheck
pnpm test --run
pnpm build
```

## 风险与回滚点

- Chrome 身份 API 可能返回空邮箱：必须走 `bookmark` 回退，不阻塞目录初始化。
- 用户已存在同名文件夹：只复用书签栏下唯一匹配目录，不能触碰根外同名目录。
- 根目录被用户删除：清除失效 ID，重新初始化；不扫描或移动根外旧书签。
- 旧任务仍在队列：移动前重新做根目录和 parentId 校验，拒绝越界任务。
