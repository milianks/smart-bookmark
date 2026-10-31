# 批量截断改为逐条兜底

## Goal

批量分类被 `max_tokens` 截断时，不再用同样大小的批次整批重试、最终整批失败，而是立刻改用单条分类逐条兜底。让截断批次里的每条书签都拿到结果，也不再浪费完整批量提示词的输入 token。

## Background（已核对代码）

- 批量请求固定 `max_tokens: 4000`（`lib/ai/openai-compatible.ts:134`、`:163`），每批最多 15 条（`services/organizer.service.ts:51` `MAX_BATCH_CLASSIFICATIONS`）；单条默认 500（`lib/ai/openai-compatible.ts:392`）。15 × 500 = 7500 > 4000，理由一写长就容易截断。
- `assertNotTruncated`（`lib/ai/openai-compatible.ts:513-533`）对三种协议的截断都抛 `ProviderError('AI 响应被截断…', true)`，和其他可重试错误（429/5xx）没有区别。
- `ClassifierService.classifyBatch`（`services/classifier.service.ts:144`）对 provider 异常不做处理，直接向上抛。
- `processBatch` 的 catch（`services/organizer.service.ts:751-757`）先做上下文过期检查，然后对每条调用 `handleClassifyError`。`handleClassifyError`（`:1017-1027`）看到 `retryable` 后执行 `attempts += 1`，并按 1.5s、3s 延迟重新入队（`MAX_RETRIES = 2`，`:50`）。重新入队后又组成同样的批次，于是 3 次完整批量请求都被截断，整批失败。
- 单条路径 `classifyViaProvider`（`:986-1003`）已经存在，`classifier.classify` 内部会先查规则和缓存。
- 无 `classifyBatch` 时的逐条循环（`:722-730`）已经采用「单条错误写入 `outcomes`，交给后续统一循环里的 `handleClassifyError` 处理」的模式，兜底可以直接复用。

## Requirements

- R1：新增截断专用错误类型 `ProviderTruncatedError extends ProviderError`（放在 `lib/ai/openai-compatible.ts`），`assertNotTruncated` 的三处 throw 都改用它。保留 `retryable = true` 和原提示文案，这样单条路径（`processJob`）在截断时的重试行为不变，现有 `instanceof ProviderError` 判断也不受影响。
- R2：`processBatch` 在调用 `classifyBatch` 的 catch 中，现有过期上下文检查保留在最前面、行为不变；检查通过后，如果错误是 `ProviderTruncatedError`，不调用 `handleClassifyError`，而是对 `batch` 中每条依次调用 `classifyViaProvider`，把成功结果或错误写入 `outcomes`，交给后续统一循环（过期检查、缓存变体检查、`applyClassification` / `handleClassifyError`）处理。
- R3：兜底中的单条失败沿用原规则：可重试错误消耗 attempts 并退避，不可重试错误 failJob，`PermissionRequiredError` 进入 `awaiting_permission`。单条自身也被截断时，按单条路径原有的可重试规则处理，不再触发二次兜底。
- R4：非截断的批量错误（429/5xx、格式错误、权限等）处理不变，仍按原逻辑走 `handleClassifyError`。
- R5：在 `.trellis/spec/backend/error-handling.md` 补一句：批量截断改为逐条兜底，不消耗 attempts。

## Acceptance Criteria

- AC1（organizer 测试）：15 条历史扫描书签，mock `classifyBatch` 抛 `ProviderTruncatedError`，`classify` 正常返回。断言 `classifyBatch` 只调用 1 次、`classify` 调用 15 次、15 条全部得到分类结果（移动或进入审核），并且每条 job 的 `attempts` 仍为 0。
- AC2（organizer 测试）：兜底中某一条 `classify` 抛可重试 `ProviderError`，只有这一条 `attempts` 变为 1 并重新入队，其余各条正常完成。
- AC3（provider 测试）：chat-completions 的 `finish_reason: 'length'`、anthropic 的 `stop_reason: 'max_tokens'`、responses 的 `incomplete/max_output_tokens` 都抛 `ProviderTruncatedError`，且 `instanceof ProviderError`、`retryable === true`。
- AC4：现有「批量遇到可重试错误按原规则重试」的测试不需修改即可通过（R4 回归）。
- AC5：`pnpm typecheck`、`pnpm test --run`、`pnpm build`、`git diff --check` 通过，测试数不减少。

## Out of Scope

- 调整批量 `max_tokens`、按条数动态计算预算、截断后对半拆批重试。
- 并发执行兜底单条请求（维持串行，和无 `classifyBatch` 分支一致）。
- 修改截断提示文案、UI 展示。
- `10-30-split-organizer-service` 拆分；本改动只动 `processBatch` 一个 catch，拆分任务开工时会自然带上。

## Risks / Notes

- 兜底改为串行单条请求后，最坏情况下一批要花 15 × 单条耗时（每条超时 22s），期间只占用 1 个分类并发位，和现有无批量分支一致。
- `ClassifierService.classifyBatch` 对多组候选依次请求。若第 2 组才截断，第 1 组已写入单条缓存（`classifier.service.ts:165`），兜底时 `classify` 会直接命中缓存，不会重复请求。
- 兜底只在过期上下文检查通过之后才执行，书签树变化时仍走 `retryStaleBatch`。
