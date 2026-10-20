# 分类质量与功能优化

## Goal

提升书签自动分类的准确率与一致性，降低 API 成本，补齐功能缺口（Review 改目标、重复检测、内置根目录接管、批量分类、分组批准、撤销栈），并使 README 与实际行为一致。用户主诉："分类上做得不是很好，功能上有些欠缺"。

## Background（代码证据，2026-10-19 全量审查确认）

当前链路：`onBookmarkCreated` → 队列 → 缓存 → 规则引擎 → LLM（逐条）→ 自动移动 / Review。

### 分类质量缺陷

| # | 缺陷 | 证据 |
|---|---|---|
| Q1 | 中文未分词，规则引擎与候选排序对中文书签失效（整串成一个 token，与文件夹名永不相等 → 全部走 API） | `lib/ai/rule-classifier.ts:186` `tokens()` 用 `[\p{L}\p{N}]+`；默认文件夹全中文 `services/bookmark.service.ts:33` |
| Q2 | 候选文件夹截断到固定 6 个，截断依赖 Q1 的弱排序；默认建 11 个文件夹，开箱即触发 | `lib/ai/rule-classifier.ts:23,37-55` |
| Q3 | 无反馈学习：用户 reject / 手动移动不回喂分类；缓存 key 含 URL+标题，纠错不扩散 | `services/organizer.service.ts:411`；`services/classifier.service.ts:104` |
| Q4 | 历史扫描逐条调 API，并发 2、单条超时 22s，大批量慢且贵 | `services/organizer.service.ts:36-38`；`lib/ai/openai-compatible.ts:7` |
| Q5 | 置信度语义混杂：规则层硬编码 0.86–0.98，LLM 自报，共用阈值 0.85 | `lib/ai/rule-classifier.ts:154-161`；`types/domain.ts:54` |
| Q6 | temperature 仅 chat-completions 设 0.1；anthropic-messages / openai-responses 未设 | `lib/ai/openai-compatible.ts:170-193` |
| Q7 | Prompt 未约束新目录命名语言；未告知泛文件夹仅在无具体匹配时使用 | `lib/ai/prompts.ts:30-44` |

### 功能缺口

| # | 缺口 | 证据 |
|---|---|---|
| F1 | 入口断裂：星标落到书签栏/其他/移动根的书签被静默忽略（仅 smart root 内建 job）；README:47 宣称相反；`isEligibleRoot`、`enumerateHistoricalBookmarks` 生产路径无人调用 | `services/organizer.service.ts:63-67`；`README.md:47` |
| F2 | Review 页只能批准/拒绝，不能改目标文件夹 | `components/ReviewApp.tsx:105-163`；`types/messages.ts:10` |
| F3 | 无重复书签检测（`normalizedUrl()` 已具备） | `lib/utils/ids.ts` |
| F4 | 历史扫描建议不按目标文件夹分组，逐条点 | `components/ReviewApp.tsx` |
| F5 | 撤销栈仅一步（`lastUndo` 被每次自动移动覆盖） | `services/organizer.service.ts:700-707` |

## Requirements（用户已确认 2026-10-20：R1–R10 全部一轮做完）

| ID | 需求 | 对应缺陷 | 量级 |
|----|------|----------|------|
| R1 | `tokens()` 增加 CJK bigram 切分，规则引擎对中文产生有效证据 | Q1 | 小 |
| R2 | 三协议补 temperature ≤0.1；prompt 补目录命名语言约束 + 泛文件夹使用约束 | Q6, Q7 | 小 |
| R3 | 候选文件夹按序列化预算动态上限（替代固定 6），当前文件夹始终保留 | Q2 | 小 |
| R4 | 纠错表：改目标批准/拒绝时记录 (域名→文件夹/保留)，prompt 注入 few-shot，域名精确命中高置信路由 | Q3 | 中 |
| R5 | Review 批准时可改目标文件夹（含 suggest_folder / keep 场景），纠错数据落地 | F2 | 中 |
| R6 | 扫描时同 normalizedUrl 归并为"重复"review（纯本地，不触发 AI） | F3 | 小 |
| R7 | 内置根目录接管：设置开关 `organizeExternalRoots`（默认关）。开启后内置根新增书签建 job；满足自动条件才移入智能目录，否则留原地等 Review | F1 | 中 |
| R8 | 历史扫描批量分类：一次 ~15 条，返回 JSON 数组，逐条 Zod + ID 校验 | Q4 | 中 |
| R9 | Review 按目标文件夹分组，组级批量批准 | F4 | 中 |
| R10 | 撤销栈：最近 10 次自动移动可逐条回退 | F5 | 小 |

依赖关系：R4 依赖 R1（签名用 bigram）与 R5（数据来源）；R9 依赖 R5 引入的 DashboardState 文件夹列表；R7 放最后（边界条件面最宽）。

## Key Decisions（用户已定）

- 范围：R1–R10 全做（2026-10-20）。
- R7 方式：opt-in 开关、默认关；接管后仅"automatic 模式且置信度达标"才移动，低置信度/确认模式留原地进 Review（2026-10-20）。

## Out of Scope

- Q5 置信度分源阈值与被拒率展示：需先有 R4 的结果数据积累，本轮不做，R4 的纠错日志为后续提供数据面。
- 死链检测（需 host 权限，隐私权衡，单独立项）、批量摘要/标签生成、i18n、无 API Key 纯本地分类模式。
## Acceptance Criteria

- R1：中文标题与目录名共享实际词汇时规则层可命中：如标题"机器学习入门"在含"机器学习"目录时 `classifyWithRules` 返回非 null 且目标正确（`tests/classifier.test.ts` 增 3 个中文用例：命中、排序限候选、泛化词不误触发）；纯中文标题不再必然落到 API 路径。
- R2：`buildRequestBody` 三分支均含 temperature ≤0.1（单测覆盖三分支）；`buildClassificationMessages` 输出含命名语言与泛文件夹两条新约束。
- R3：文件夹数 ≤ 预算时不截断；超限按排序截断且当前文件夹始终在候选内（单测覆盖）。
- R4：改目标批准或拒绝后，同域名书签下次分类 prompt 出现该纠错样本；域名精确命中"move 纠错"时不调用 API（单测断言 provider 未被调用）。
- R5：Review 详情有文件夹选择器；改选后批准，书签移入所选文件夹，activity 与纠错表记录正确。
- R6：同一 normalizedUrl 多条书签在扫描中归并为一条"重复"review，不产生 AI 调用；批准=较新重复项移入"🗄️ 归档"，拒绝=全部保留；计入历史批量撤销。
- R7：开关默认关时行为与现状完全一致（回归保障）；开启后内置根新增 HTTP(S) 书签建 job，automatic+达标→移入智能目录，其余进 Review；README 同步修订。
- R8：扫描 N 条书签的 API 调用数 ≈ ceil(N/15)（缓存命中的不计）；批量结果单条无效只失败该条，其余正常分发。
- R9：Review 列表按目标文件夹分组，组级"批准本组"生效并计入历史批量撤销。
- R10：连续 >10 次自动移动后仍可逐条回退最近 10 条；越界/已手动移动条目跳过（沿用现有保护）；旧 `lastUndo` 数据迁移为栈顶。
- 全量：`pnpm typecheck`、`pnpm test --run`、`pnpm build` 通过；README 与实际行为一致（R7 段落 + F1 描述修订）。
