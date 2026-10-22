# 实施计划：内容感知的智能书签分类

## 前置

- 已确认决策 D1–D7（见 `prd.md`）。
- 变更面：新增页面提取服务、扩展类型/存储/设置、分类输入注入、纠错偏好、manifest/README。

## 有序清单

1. **类型与设置（先立契约）**
   - `types/domain.ts`：新增 `PageProfile`；`CorrectionEntry` 增可选 `topics/contentType/techDomain/count/lastAt`；新增 `PreferenceRule`；`PersistedState` 加 `pageProfiles?`、`preferences?`；`Settings` 加 `contentAssistEnabled`（默认 false）、`extractCharLimit`（默认 3000）。
   - `DEFAULT_SETTINGS` 同步。
   - 验证：`pnpm typecheck`。

2. **存储迁移**
   - `lib/storage/repository.ts`：`normalizePreferences`、`normalizePageProfiles`、放宽 `normalizeCorrections`；`normalizeState` 接入；保存时按上限截断。确保旧存档无新键可正常加载。
   - 验证：`pnpm test --run tests/repository.test.ts`。

3. **页面提取器（核心新增）**
   - 新增 `services/page-extractor.service.ts`：`tabs.query` 匹配活动标签页 → 敏感黑名单/单站点开关（`lib/` 小工具）→ `scripting.executeScript` 自包含 `func` 兜底 + Readability 增强 → 截断到 `extractCharLimit` → 返回 `ExtractedPage`。
   - 全流程 try/catch + 超时降级；不修改页面 DOM（克隆）。
   - 新增测试 `tests/page-extractor.service.test.ts`（mock `chrome.tabs`/`chrome.scripting`，覆盖：匹配成功、URL 不符、权限缺失、敏感站点、超时、截断）。

4. **画像生成与接线**
   - 画像生成复用 provider（或本地抽取），失败降级；结果存 `job.pageProfile` 与可选 `pageProfiles` 缓存。
   - `entrypoints/background.ts`：`onCreated` 在现有 import 抑制/外部根判断之后、入队之前调用提取；`contentAssistEnabled` 关闭时跳过。
   - 验证：`pnpm test --run tests/background.router.test.ts`（补充开关分支）。

5. **分类输入注入**
   - `lib/ai/prompts.ts`：`ClassificationInput` 加 `pageProfile?`；Prompt 增加画像说明并替换「不读取网页正文」措辞。
   - `services/classifier.service.ts`：`makeCacheKey` 纳入画像指纹；`classify`/`classifyBatch` 透传画像。
   - 验证：`pnpm test --run tests/classifier.test.ts tests/openai-compatible.test.ts`。

6. **纠错偏好**
   - `services/organizer.service.ts`：`recordCorrection` 在手动纠正时更新 `PreferenceRule`（撤销/自动移动不写）。
   - `services/classifier.service.ts`：`applyCorrection` 增聚合偏好加权匹配；`recentUserDecisions` 注入主题提示。
   - 验证：`pnpm test --run tests/organizer.service.test.ts tests/organizer.test.ts`。

7. **设置/UI 与权限**
   - `SettingsApp`（`entrypoints/options`）：加开关、字符上限选择、单站点管理；开启时用 `chrome.permissions.request` 请求 host。
   - `wxt.config.ts`：`permissions` 加 `scripting`。
   - 文案与 README 同步（隐私承诺改写）。

8. **最终校验**
   - `pnpm typecheck && pnpm test --run && pnpm build`。

## 验证命令

```bash
pnpm typecheck
pnpm test --run
pnpm build
```

## 风险文件 / 回滚点

- `entrypoints/background.ts`（onCreated 主流程）——提取失败必须不阻塞分类；用开关兜底。
- `lib/storage/repository.ts`（存档迁移）——normalize 必须容忍旧数据。
- `services/classifier.service.ts`（缓存键/纠错）——画像变化需让旧缓存失效。
- `wxt.config.ts`（权限）——新增 `scripting` 影响商店审核措辞。

## 开工前复查

- `implement.jsonl` / `check.jsonl` 需在 `task.py start` 前填入真实 spec/research 条目（当前为空，若走子代理流程则 `start` 会拒绝）。
- 确认 README 与设置文案已按 D1/D5/D7 更新，避免「不读取正文」与实现冲突。
