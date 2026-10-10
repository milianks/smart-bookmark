# 精简设置并支持多种 AI API 协议

## Goal

缩短 AI Bookmark Manager 的设置页面，并让所选 API 协议真实影响连接测试和书签分类，同时保留现有整理、安全与审核能力。

## Current behavior

- `components/SettingsApp.tsx` 在同一长页面展示 AI 服务、整理策略、通知、隐私说明和最近操作；服务配置与底部各有保存按钮。
- `Settings` 在 `types/domain.ts` 中保存可配置的 `baseUrl`、`model` 和 `apiKey`，没有协议字段。`lib/ai/openai-compatible.ts` 仅发送 Chat Completions 请求。
- `ChromeStateRepository` 从 `chrome.storage.local` 读取并通过 `SettingsSchema` 校验设置；目前没有独立迁移器。页面只接收 `hasApiKey`，不能读取已保存密钥。
- 测试 AI 当前只检查服务是否返回 Chat Completions 外层结构，没有验证分类输出。分类结果在业务流程中还会通过 Zod 与实时文件夹清单校验。

## Requirements

1. **设置精简**：初始视图突出 AI 配置、连接状态和整理开关。置信度、整理模式、强制整理、通知细项等低频选项可以收纳，但必须保留且可访问。保留隐私/权限说明和最近操作；去除重复的保存入口。
2. **协议选择**：提供 Anthropic Messages、OpenAI Chat Completions 兼容协议、OpenAI Responses API 三种协议。所选协议必须同时决定测试与分类的 endpoint、认证方式、请求体和响应解析。
3. **基础 URL**：继续允许用户配置 URL。`https://aiaaa.cc/v1` 是验证协议调用的测试地址，不是默认值或固定 Provider。用户提供基础 URL（通常包含 `/v1`），程序按协议追加 endpoint 后缀；UI 提示不要填写具体 endpoint。
4. **有效测试**：点击“测试 AI”时，使用当前表单保存的协议、URL、模型和密钥发起一条合成分类请求；仅在响应通过现有 `ClassificationResultSchema` 校验后报告成功。测试不得读取、记录或更改真实书签。
5. **分类安全**：后续书签分类走同一协议适配器；响应通过严格 Schema 校验，并由现有服务校验目标文件夹仍存在。请求或结果无效时，书签留在原位。
6. **原功能保留**：保留自动/确认模式、阈值、强制整理、通知、操作历史、审核、撤销、本地规则与缓存、来源权限流程。
7. **向后兼容与密钥**：旧设置迁移到原有 Chat Completions 行为并保留 URL、模型、密钥及整理偏好；密钥仍为仅写入字段，不得进入 dashboard、日志、错误、通知或页面显示值。

## Acceptance Criteria

- [x] 设置初始视图短而清晰；AI 配置、状态、整理开关和测试操作容易找到。收纳区中的所有旧选项仍可编辑并保存。
- [x] 协议选择可持久化；老配置缺失协议时继续使用 Chat Completions，且原有密钥、URL、模型和偏好不变。
- [x] 基础 URL `https://aiaaa.cc/v1` 分别得到 `/messages`、`/chat/completions`、`/responses`，不会重复追加 endpoint；该地址不会成为默认 Provider。
- [x] 三种协议都有覆盖 endpoint、请求体、认证头、响应提取的单元测试；错误响应、超时、无效 JSON 和无效分类结果均安全失败。
- [x] “测试 AI”请求只带合成样例，验证分类 Schema 后才成功；该测试不会访问书签 API 或写入活动记录。
- [x] 分类缓存键包含协议，协议切换后不会复用另一协议产生的缓存结果；真实分类仍执行现有实时文件夹校验。
- [x] API Key 不出现在公开状态、用户错误、日志、通知或界面中；动态来源权限仍只针对当前配置的 origin。
- [x] `pnpm typecheck`、`pnpm test --run`、`pnpm build` 全部通过。

## Out of scope

- 删除或改变现有整理、安全、通知、审核、撤销、本地规则/缓存行为。
- 将 `https://aiaaa.cc/v1` 固定为默认地址，或在本次规划中使用它发送真实请求。
- 添加其他协议、Provider 账号管理、云端服务或新书签权限范围。

## Decisions

- 三种协议标识采用 `anthropic-messages`、`openai-chat-completions`、`openai-responses`；旧数据默认 `openai-chat-completions`。
- 分类 JSON 沿用公共提示词，并由本地 Zod 校验。MVP 不依赖不同服务商对 Structured Outputs 的扩展支持，降低兼容端点拒绝请求体的风险。
- 用户触发测试前先保存当前表单，再由后台以已保存配置测试，沿用现有 optional host permission 流程。
