# 技术设计 — 分类质量与功能优化

## 总原则

沿用现有分层：`services/`（编排与边界）→ `lib/ai/`（prompt/provider/规则）→ `types/`（契约）。所有新持久化字段经 `normalizeState`（`lib/storage/repository.ts:77`）默认初始化，不做版本号迁移。破坏性边界检查（managed 目录、smart root）语义不变，仅对 R7 外部来源路径做显式放宽。

## R1 — CJK bigram 分词

`lib/ai/rule-classifier.ts` `tokens()`：token 含 CJK（`/\p{Script=Han}/u` 或统一 `\p{Unified_Ideograph}`）且长度 ≥2 时，输出滑窗 bigram 替代整串（"性能优化实战" → 性能/能优/优化/化实/实战）；非 CJK token 原样。同一函数被 subject 与 folder 两侧共用，天然对称。

- 现有 `STOP_WORDS`/`GENERIC_FOLDER_TOKENS` 中文条目均为双字，本身就是 bigram，无需改。
- 影响 `tests/classifier.test.ts` 既有断言：整串匹配用例改为 bigram 语义，新增 3 个中文用例（规则命中、排序、规则不误命中）。

## R2 — temperature 与 prompt 约束

- `lib/ai/openai-compatible.ts` `buildRequestBody`：anthropic-messages 分支加 `temperature: 0.1`；openai-responses 分支加 `temperature: 0.1`。
- `lib/ai/prompts.ts` system prompt 追加两条：『建议新目录时，名称语言与该父目录下现有子目录名一致；无参照时跟随书签标题的主要语言』『"工具/待分类/杂项"等泛目录仅在没有具体主题目录匹配时使用』。
- `tests/openai-compatible.test.ts` 断言三分支 temperature。

## R3 — 候选预算

`rankFolderCandidates`：固定 `MAX_CANDIDATE_FOLDERS=6` 改为序列化预算估算——每文件夹按 name+path+≤3 samples 估字节数，累计 ≤ 10KB 全送；超限截断到预算内（下限 12 个，不足 12 时剥 samples 保 id/name/path）。保留"当前文件夹必须在候选内"的现有语义与弱证据路径。

## R4 — 纠错表

- `types/domain.ts` 新增 `CorrectionEntry { domain: string; action: 'move'|'keep'; folderId?: string; createdAt: number }`；`PersistedState.corrections: CorrectionEntry[]`（每域名保留最新 1 条，总量上限 50，`normalizeState` 默认 `[]`）。
- 写入点（organizer.service.ts）：`resolveReviewTarget` 采纳 `overrideFolderId` 批准时记 `{domain, move, folderId: override}`；`rejectReview` 记 `{domain, keep}`。普通按建议批准不记（弱信号）。
- 读取点（classifier.service.ts `classify`）：规则层之前查纠错表，域名精确匹配 `move` 且 folderId 仍在 folders 列表 → 直接返回 `confidence 0.93, source 'rule'`，不发 API；`keep` → 返回 keep 0.9。
- prompt 注入：`buildClassificationMessages` 增加可选 `recentCorrections` 参数（top 5，按 createdAt 倒序），以"用户历史决定"数据块注入；标题/域名仍按不可信数据处理。

## R5 — Review 改目标文件夹

- `ReviewItem.overrideFolderId?: string`；`types/messages.ts` `review:approve` 增可选 `overrideFolderId`；router `RequestSchema` 同步。
- `DashboardState` 增 `folders: Array<{id, path}>`（getDashboardState 从 smart root 子树取，排除 managed）。
- `resolveReviewTarget`：override 存在且通过 `isValidSmartTarget` 校验 → 用之（覆盖 move / suggest_folder / keep 三种 classification）；approve 结束时写入 R4 纠错。
- `ReviewApp.tsx` ReviewDetail：目标区加 `<select>`（默认显示原建议），change 即存本地 state，批准时携带。
- suggest_folder + override 语义：用户改选现有目录 = 不再新建目录，目标为 override。

## R6 — 重复检测

- `scan.service.ts` `startHistoricalScan`：候选按 `normalizedUrl` 分组，组内 >1 → 生成一条 `ReviewItem`（复用现有结构，`classification` 塞 `{action:'move', targetFolderId:<归档 id>, confidence:1, reason:'重复书签：保留最早一条，其余移入归档'}`，`duplicateOf` 元数据放 review 新可选字段 `duplicates?: string[]`），组内所有 id 建 job 但标记跳过 AI（job.status 直接待 review）。
- "🗄️ 归档" id 从 smart root 子树按名解析，缺失则该组降级为普通批量 review（不静默创建文件夹）。
- 批准/拒绝走现有 `approveReview`/`rejectReview`；批准时逐条移动较新项，计入 `lastHistoricalUndo`（复用现有 per-scan 聚合）。

## R7 — 内置根目录接管（opt-in，默认关）

- `Settings.organizeExternalRoots: boolean`（`SettingsSchema`、`DEFAULT_SETTINGS=false`、router `SettingsPatchSchema`、SettingsApp 开关、README 修订）。
- `onBookmarkCreated`：不在 smart root 内时，若开关开 && `isEligibleRoot(parentId)` && HTTP(S) → 建 job，snapshot 增 `externalRoot: true`。
- 边界放宽（organizer.service.ts，仅 `externalRoot` job）：`isWithinSmartRoot(bookmark)` 前置检查改为"在 smart root 内 或 parent 是合法 eligible root"；`isValidSmartTarget(fromFolderId)` 在 `moveWithRecovery`/`reconcilePendingOperation`/`undoLastMove` 对外部 from 放宽（只校验 to）；Review 的 `sourceParentId` 校验同理。
- 自动移动目标仍必须是 smart root 内合法目录；确认/低置信 → Review，书签留原地。
- 回归红线：开关关时所有现有测试零改动通过。

## R8 — 批量分类

- `ClassifierProvider` 增可选 `classifyBatch(inputs, folders, config): Promise<ClassificationResult[]>`；`OpenAICompatibleProvider` 实现：`buildBatchMessages`（书签数组 + 同一文件夹清单，输出 `{"results":[{index, ...ClassificationResult}]}`），Zod `z.array` + index 对齐校验，长度不齐 → 整批 `ProviderError(retryable=true)`。
- `ClassificationService.classifyBatch`：先逐条查缓存/规则/纠错命中，剩余未决项打包一次 API；结果逐条过 `resultReferencesFolders`，无效者该条抛错由调用方按单条失败处理；全部写缓存。
- organizer `processPending`：`scanId` 存在的 queued job 收集 ≤15 条走批量；实时（非 scan）job 维持单条路径。MAX_CONCURRENT_CLASSIFICATIONS 语义变为并发批次数（维持 2）。
- 每批内 job 的 attempts/nextAttemptAt 沿用现有单条重试策略。

## R9 — 分组 Review UI

- `ReviewApp.tsx`：待处理 scan review 按 `targetFolderPath ?? parentFolderPath+建议名 ?? '重复'` 分组渲染，组头显示计数与目标路径 + "批准本组"。
- 组批准 = 客户端顺序循环现有 `review:approve`（无 AI，每条快），失败条目显示原因继续下一条；不新增 router 消息。
- 与 `scan:approve-all` 并存（后者保留）。

## R10 — 撤销栈

- `PersistedState.undoStack: UndoRecord[]`（cap 10，`normalizeState` 默认 `[]`，旧 `lastUndo` 迁移为栈首）。
- `automaticMove` 成功后 push（超 10 弹尾）；`undo:last` 语义 = pop 栈顶执行（沿用现有防覆盖检查）；`reconcilePendingOperation` 成功路径同样入栈。
- Popup 撤销按钮文案不变（每次撤最近一条），`DashboardState.lastUndo` 改为返回栈顶 + `undoStackCount`。

## 兼容与回滚

- 状态：仅增字段 + `normalizeState` 默认值；不写迁移脚本，不删旧字段（`lastUndo` 保留只读兼容一版）。
- 协议：`review:approve` 消息加可选字段，旧 popup 消息仍合法。
- 回滚点：每个 R 独立成 commit（见 implement.md），可单 revert。
