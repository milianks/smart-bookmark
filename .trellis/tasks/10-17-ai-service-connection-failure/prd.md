# 排查 AI 服务连接失败

## Goal

定位新增书签分类时提示“无法连接 AI 服务，书签已保留原位”的实际原因，并确定最小、可验证的修复范围，避免把服务迁移或模型配置错误误报成网络故障。

## Confirmed facts

- 用户本次提供的测试基础地址是 `https://aiaaa.cc/v1`，协议为 OpenAI Chat Completions，模型填写为 `deepseek-flash`。API Key 仅在当前运行上下文使用，不写入任务、代码、日志或最终回复。
- 脱敏实测 `https://aiaaa.cc/v1/models` 和 `/chat/completions` 均返回 HTTP 503，JSON 错误码为 `ENDPOINT_MIGRATED`，服务返回迁移目标 `https://api.aibvv.cn/v1`。
- 脱敏实测迁移后的 `https://api.aibvv.cn/v1/models` 返回 4 个模型：`deepseek-v4-flash-0731`、`deepseek-v4-pro-0813`、`deepseek-v4-flash-vision-exp`、`deepseek-v4.1-flash`；其中不包含 `deepseek-flash`。
- 脱敏实测迁移后的地址使用 `deepseek-v4-flash-0731` 调用 `/chat/completions` 返回 HTTP 200、`finish_reason=stop`，且有可读取的消息内容；使用 `deepseek-flash` 返回 HTTP 404，错误码为 `model_not_found`。
- 本轮无凭据复核 `https://aiaaa.cc/v1/models`，响应仍为 `ENDPOINT_MIGRATED` 并指向 `https://api.aibvv.cn/v1`；新地址匿名访问 `/models` 返回 `API_KEY_REQUIRED`，因此未重复枚举模型或发送带密钥请求。
- 当前 Provider 会由基础地址追加 `/chat/completions`，并在请求阶段把普通异常统一转换为“无法连接 AI 服务，书签已保留原位”（`lib/ai/openai-compatible.ts`）；服务端 HTTP 错误则只保留状态码，未解析迁移信息或模型错误详情。
- 设置页只有“授权并测试 AI”按钮会申请 API 来源权限；单独保存设置不会申请权限。未授权路径理论上应显示权限错误，但网络异常的原始原因目前不会保留。
- 用户反馈仍看到同一条笼统提示。按当前源码，若 Service Worker 真正收到旧地址的 HTTP 503，应先得到 `AI 服务返回错误 (503)` 并重试；仍显示“无法连接”说明浏览器运行时的 `fetch` 在拿到可读 HTTP 响应前就失败，或用户正在运行旧的扩展构建产物。需要在扩展的 Service Worker 控制台核对实际请求地址和异常类型。
- 本地 `.output/chrome-mv3/background.js` 构建时间为 2026-10-17 11:27，包含与源码相同的通用网络错误映射；当前浏览器 DevTools 没有 Bookmark 扩展页或 Service Worker 可供检查，因此无法据此确认用户实际加载的构建、已保存地址/模型或来源权限。
- 2026-10-17 下午复测：来源权限已授予、已保存 baseUrl/model 正确、Service Worker Console 手动 `fetch` 同一端点返回 200（带已存 Key 的 POST 也返回 200），排除网络与配置原因。
- 通过临时 `[debug]` 日志构建定位根因：`OpenAICompatibleProvider` 构造函数默认参数保存裸 `fetch`，调用点 `this.fetcher(...)` 把 receiver 变为 provider 实例，Chrome Service Worker 中原生 `fetch` 要求全局 receiver，抛出 `TypeError: Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation`，被通用 catch 映射成「无法连接 AI 服务，书签已保留原位」。请求从未发出，所以 Network 面板无记录。单元测试注入的是普通函数 fetcher，无 receiver 约束，因此未覆盖该回归。
- 修复：默认参数改为 `fetch.bind(globalThis)`（`lib/ai/openai-compatible.ts`），`pnpm typecheck`、`pnpm test --run`（64 项）、`pnpm build` 通过；临时 `[debug]` 日志已全部移除。

## Requirements

- R1：明确记录并验证 `aiaaa.cc` 迁移和 `deepseek-flash` 不存在是本次测试配置失败的直接原因。
- R2：修复方案必须让迁移、模型不存在、鉴权失败和真正的网络异常显示可行动的安全错误，不泄露 API Key、完整响应正文或敏感请求信息。
- R3：不自动替换用户已保存的 API 地址、模型或密钥；是否切换到迁移后的地址和可用模型由用户明确决定。
- R4：通过 Provider 层测试覆盖迁移错误和模型不存在错误，保留现有失败安全语义：分类失败时书签保持原位。

## Acceptance Criteria

- [x] 收到 `ENDPOINT_MIGRATED` 时显示迁移提示；只有通过 HTTPS、敏感 URL 字段和基础地址校验的地址才会显示。
- [x] 收到 `model_not_found` 时显示模型名称提示，不暴露服务端消息。
- [x] 不自动请求或保存迁移地址；迁移失败保持当前有限重试规则。
- [x] 无效/缺失迁移地址和真正的网络异常仍显示安全提示，不包含 API Key 或原始响应正文。
- [x] Provider 单元测试使用 stub 覆盖成功映射、拒绝不安全地址、不泄密及不跟随迁移地址。
- [x] `pnpm typecheck`、`pnpm test --run` 和 `pnpm build` 通过。

## Scope

- Provider 层安全解析已知错误码，为 endpoint 迁移和模型不存在给出可操作提示。
- 对服务返回的迁移地址只在 HTTPS、无凭证、查询或片段且通过基础 URL 校验时展示；绝不自动请求或保存该地址。
- 保留现有鉴权、HTTP 状态、重试、超时和网络错误语义；不显示原始响应正文或底层异常。
- 补充 Provider stub 测试；不发送外部请求，不触碰真实书签。

## Runtime limitation

- 需要在用户实际运行的扩展 Service Worker 中核对请求地址和异常类型，并确认配置/权限；当前可见浏览器没有 Bookmark 扩展运行页，不能从本地构建产物推断线上运行状态。

## Out of scope

- 不把测试服务地址或任何 API Key 写入默认设置、源码、任务文件或日志。
- 不自动调用迁移目标替换用户配置，不自动选择模型，不改变其他 Provider 协议的请求契约。
