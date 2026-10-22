# 内容感知的智能书签分类（原：修正 Muse 书签的 AI 分类）

## Goal

让新增书签的分类依据从「只有标题/URL/域名」升级为「网页内容画像 + 用户纠错偏好」，从而修正因模型世界知识过时（域名易主、产品改名）导致的误分类，并让纠错「教一次、以后都对」；不长期保存网页全文、不微调模型。

触发案例是 `muse.ai`：它已是 Meta 的 Muse 个人 AI 智能体（2026-09-08 上线，https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/），旧「在线视频平台」信息已过时（2026-03-03 改名 Skiv，https://muse.ai/blog/muse-ai-is-now-skiv 现 401）。

## Background（仓库证据）

- 分类链路：缓存 → 域名纠错表 → 确定性规则 → LLM。`services/classifier.service.ts:57-95`。
- 分类/摘要输入只有标题、URL、域名、当前文件夹与目录清单，**不读取网页正文**。`lib/ai/prompts.ts:9-16,24-26,32-66`、`services/bookmark-metadata.service.ts:52-60`。
- Prompt 明确禁止声称读取正文。`lib/ai/prompts.ts:49,83`。
- Manifest 权限只有 `bookmarks/storage/notifications/alarms/identity.email`；`optional_host_permissions` 已含 `https://*/*`、`http://localhost/*`、`http://127.0.0.1/*`、`http://[::1]/*`；**缺 `scripting`**。`wxt.config.ts:14-15`。README 承诺「不读取网页正文」。`README.md:9,61`。
- 纠错表按域名（`hostnameKey`）记录，仅两种写入：Review「保留原位」写 `keep`（`services/organizer.service.ts:463`）；改选文件夹后批准写 `move→folderId`（`services/organizer.service.ts:432`，`recordCorrection` 在 `:1236-1242`）。撤销（`:472-510`）不写纠错表。读取见 `services/classifier.service.ts:63,106,197-215`。
- 存储：单个 `chrome.storage.local` key；activities 截断到 100、cache 截断到 200；`normalizeSettings` 按 `DEFAULT_SETTINGS` 逐键迁移，新增设置键可安全回填默认值。`lib/storage/repository.ts`。
- 默认目录无「视频/媒体」类目。`services/bookmark.service.ts:35-47`。
- **Chrome 约束**：`bookmarks.onCreated` 只能感知收藏事件，不携带 `tabId`，也不能据此获得网页读取权限；自动提取需预先获得 host 权限 + `scripting`，并通过 `tabs.query` 找到匹配 URL 的活动标签页。

## Technical Notes & Decisions

### 提取方向

1. 两级提取：一级用 `chrome.scripting.executeScript` 提取 `title/meta description/og/headings/正文`；二级用 Mozilla Readability（克隆 DOM）清洗正文，按页面类型降级（文章→Readability；GitHub→README/topics；AI 工具→meta+H1；文档→正文+标题层级；视频→标题/描述/字幕；不可访问→基础信息）。
2. AI 生成简短网页画像（摘要 + 标签 + 内容类型），作为分类主依据；原始正文处理后丢弃。
3. 纠错学习轻量化：不保存全文、不微调模型；保存少量人工纠正并聚合为偏好；区分「AI 自动移动」与「用户手动纠正」；只处理智能书签根目录内操作。
4. 数据分层：书签基础数据交给 Chrome；画像只留摘要/标签/类型；偏好存聚合结果；最近纠错保留少量。优先 `chrome.storage.local`，复杂查询再上 IndexedDB。第一版不引入向量库/Embedding。

### 已确认决策

- **D1（权限与触发）**：设置中提供「读取网页内容辅助分类」开关；用户开启时一次性请求可选 host 权限；收藏时用 `scripting` 提取，未授权站点/找不到匹配标签页时自动降级为仅元数据。manifest 需新增 `scripting`（host 权限复用现有 `optional_host_permissions`）。同步改写 README 隐私承诺。
- **D2（方向）**：网页提取 + AI 画像 + 轻量纠错学习同时做，不保存全文、不微调模型。
- **D3（提取上限）**：默认正文上限 **3,000 字符**；设置可切 1,000 / 3,000 / 6,000，后续按真实数据调优。
- **D4（纠错粒度）**：混合式——保留按域名纠错表做即时路由；新增「主题/内容类型 + 技术领域 → 倾向文件夹」聚合偏好作为辅助信号（计数/权重/反例）。
- **D5（敏感站点）**：对已授权的 http(s) 页面默认提取，内置小型敏感类别黑名单（银行/支付、健康、登录/内网等）默认跳过，并提供单站点开关。
- **D6（提取范围）**：仅对新增书签（收藏时活动标签页）自动提取；历史扫描与手动「重新分析」继续仅用元数据，不抓取历史页面。历史书签靠纠错学习逐步改善。
- **D7（开关默认）**：内容辅助分类默认关闭；用户主动开启并授权后才生效，不开启时体验与现状一致。

## Requirements

- R1（提取管道）：新增仅后台可调用的提取模块，按 D1/D3/D5 在收藏时提取并清洗正文（≤ 字符上限），输出网页画像；克隆 DOM、不修改当前页面；任何失败安全降级为仅元数据，不阻塞分类。锚点：新增 `services/page-extractor`、`entrypoints/background.ts` 的 `onCreated` 处理。
- R2（画像）：画像含 `summary`、`tags/主题`、`contentType`，不含原文；存入 `chrome.storage.local` 且设上限；`BookmarkJob`/`ReviewItem` 可携带画像（参照 `types/domain.ts` 的 `BookmarkMetadata`）。
- R3（分类输入）：网页画像存在时，作为 `ClassificationInput` 的新增字段注入分类 Prompt（`lib/ai/prompts.ts`），且 Prompt 不再声称「不读取网页正文」；无画像时行为回退到当前仅元数据。画像文本按不可信数据处理。
- R4（纠错学习）：保存最近 ≤200 条人工纠正；区分自动移动（不写纠错）与手动纠正（写纠错）；将纠错聚合为「主题/内容类型 + 技术领域 → 倾向文件夹」的偏好（含计数/最近反馈/反例权重），作为模型提示与本地匹配的辅助信号；按域名即时纠错仍生效。锚点：`services/organizer.service.ts:432,463,1236-1242`、`services/classifier.service.ts:63,106,197-215`、`types/domain.ts` 的 `CorrectionEntry`。
- R5（设置与迁移）：新增 `contentAssistEnabled`（默认 false）、`extractCharLimit`（默认 3000）、敏感站点与单站点开关的持久化；在 `SettingsSchema`/`DEFAULT_SETTINGS`/`normalizeSettings` 中安全迁移，旧存档不缺省破坏。
- R6（隐私/权限一致性）：manifest 增加 `scripting`；README 与设置页文案如实说明「开启后读取网页内容、原文不落盘、敏感站点跳过」。
- R7（Muse 案例）：`muse.ai` 类「域名含义已变」的书签在开启内容辅助后能被正确归类或请求确认；未开启时仍可通过纠错学习改善。

## Out of Scope

- 微调模型 / 训练专属模型。
- 向量库或 Embedding 语义匹配（第一版不做）。
- 保存完整网页正文或全文索引。
- 历史书签自动抓取网页（D6）。
- 接管 Chrome 原生收藏弹窗的目录选择。

## Acceptance Criteria

- [ ] 开启内容辅助且站点已授权时，新增书签的分类输入包含网页画像；原始正文不落盘（`chrome.storage.local` 中无可还原全文）。
- [ ] 未授权站点、非 http(s)、无匹配标签页、敏感黑名单站点均安全降级为仅元数据分类，不报错、不阻塞。
- [ ] 网页画像在分类 Prompt 中按不可信数据处理，不影响现有 Schema/文件夹 ID 校验与自动/确认阈值逻辑。
- [ ] 用户手动纠正后，同主题/内容类型书签下次优先命中纠正目录；撤销自动移动不写入纠错。
- [ ] 纠错记录 ≤200 条且可聚合为偏好；存储无原文。
- [ ] `contentAssistEnabled` 默认 false；关闭时行为与现状一致。
- [ ] `pnpm typecheck`、`pnpm test --run`、`pnpm build` 通过；manifest 含 `scripting`，README 隐私描述与实现一致。
- [ ] `muse.ai` 类「域名含义已变」书签在开启内容辅助后能正确归类或被请求确认。
