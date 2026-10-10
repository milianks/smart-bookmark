# Research: Chrome 书签事件、MV3 恢复与 WXT API 域名权限

- Query: 核对 `bookmarks.onCreated` 是否能识别用户接受默认目录还是主动选择目录；导入事件的边界；MV3 Service Worker 的监听器注册与中断恢复；WXT 的 MV3 后台入口及自定义 OpenAI 兼容 API 地址的最小动态 host permission。
- Scope: mixed
- Date: 2026-10-09

## Findings

### Chrome 书签事件不能暴露“用户是否主动选目录”

`chrome.bookmarks.onCreated` 的监听器只收到 `id` 与新建的 `BookmarkTreeNode`。节点的 `parentId` 表示最终所在父文件夹，但 API 没有来源、用户手势或“使用默认位置/主动选择”字段。因此能识别“它现在在哪个文件夹”，不能可靠判断“用户是否在原生收藏弹窗中明确选择了该文件夹”。

这使“默认尊重用户明确选择的非默认文件夹”无法仅靠本事件精确实现。可落地的策略是把非捕获目录一律视为用户已有意图并保留原位；或让用户设置专用自动整理入口目录；强制整理模式再允许覆盖。单靠 `parentId` 推断显式选择会误判。

### 导入事件只为 Chrome 书签导入会话提供边界

Chrome 提供 `onImportBegan` / `onImportEnded`。官方说明建议在导入会话期间忽略 `onCreated` 更新，直到收到 `onImportEnded`；可用它避免原生书签导入逐条触发分类。事件本身没有逐个书签参数，也没有在 `onCreated` 上附加“这是导入项”的标记。它是导入会话信号，不是任意快速创建、扩展 API 批量创建或书签同步变化的通用批处理检测器；不要把“所有批量变化都会触发导入事件”当作 API 保证。

导入状态若只存在 Service Worker 全局变量中，Worker 停止后会丢失。建议在 `onImportBegan` / `onImportEnded` 更新 `storage.local` 中带开始时间的导入标记，并对遗留标记设置超时恢复；任务队列也应持久化。对无法确认是否属于导入的突发创建可做有限并发/合并防护，确保异常情况下不会发出大量并行 LLM 请求。

### `folderType` 可在 Chrome 134+ 识别浏览器内置书签文件夹

`BookmarkTreeNode.folderType` 从 Chrome 134 起提供，枚举值为 `bookmarks-bar`、`other`、`mobile`、`managed`。在支持此属性的运行时，它能识别对应的浏览器内置根文件夹类型；普通用户文件夹没有这些类型。`getTree()` 可用于取得实际树结构（Chrome 90+）。注意 `folderType` 描述内置文件夹本身，是否可编辑仍应检查 `unmodifiable`，并区分“不能修改根文件夹属性”和“可把书签放入该文件夹”。

不必仅为了可选的根类型提示把扩展最低版本提高到 134。推荐对 `folderType` 做运行时能力检测：存在时使用枚举；不存在时仍遍历 `getTree()`，用当前返回的节点 ID、父子关系和完整路径完成通用分类与移动验证，但不要通过本地化标题、固定 ID 或子节点顺序猜测 `bookmarks-bar` / `other` / `mobile` 语义。旧版无法可靠提供这些根类型标签时，应降级为普通文件夹选择/路径显示；若产品必须依赖这些类型来保证行为，则应在 manifest 设置 `minimum_chrome_version: "134"`。

设置 `minimum_chrome_version` 会阻止低于该版本的新用户安装；对已安装在旧版 Chrome 的用户，提高门槛会使其停止收到扩展更新。因此只有当 134+ 的 `folderType` 是不可替代的正确性要求时才应设门槛。另注意 `chrome.bookmarks.ROOT_NODE_ID` 是 Chrome 145+ 才增加的常量，不能作为 134–144 的替代方案；兼容代码可从 `getTree()` 的返回树动态遍历，而不是依赖该新常量。

### MV3 Worker 会休眠；入口必须同步注册事件并从持久状态恢复

Chrome 文档要求扩展事件监听器在 Service Worker 顶层同步注册。MV3 Worker 是事件驱动的：休眠后新扩展事件会唤醒 Worker，但不能依赖进程内变量、定时器或一次运行把长任务做完。官方生命周期说明通常会在 30 秒无活动后终止 Worker；单个事件/API 请求超过 5 分钟或 `fetch()` 等待响应超过 30 秒也可能导致终止。

建议在 WXT 后台入口同步注册 `bookmarks.onCreated`、`onImportBegan`、`onImportEnded`、`runtime.onStartup` 等监听器，再异步启动队列恢复；不要先 `await` 读取配置再注册监听器。接到新增书签后先把幂等任务写入 `chrome.storage.local`，恢复时重新校验书签/文件夹仍存在，再做有限次数重试。可以用 `chrome.alarms` 作为后续恢复唤醒手段，但不能用 `setInterval` 或永驻 Worker 替代持久化。LLM 请求应设置短于 Worker 网络处理上限的超时，失败时保留书签。

### WXT 与可配置 API 地址的权限方案

WXT 使用文件入口 `entrypoints/background.ts` 与 `defineBackground(...)`；MV3 下会生成 Service Worker。浏览器 API 运行时代码应放在 `defineBackground` 的主函数中，WXT 文档说明此主函数不能声明为 `async`。在其中同步注册 Chrome 事件，再通过 `void resumePendingJobs()` 之类启动异步恢复。WXT 从 `wxt.config.ts` 的 `manifest` 配置生成最终 `manifest.json`，产物可在 `.output/<target>/manifest.json` 检查。

对安装时未知的自定义 API 主机，Chrome 要求 manifest 先声明匹配的 `optional_host_permissions`；未授予时不会获得该主机的扩展跨源访问权。可仅声明 HTTPS 可选模式 `https://*/*`，并在设置页用户点击“保存/测试连接”时调用 `chrome.permissions.request({ origins: [exactPattern] })`。Chrome 要求 `permissions.request()` 在用户手势中调用，且请求域必须是 manifest 可选权限的子集。请求模式按用户输入解析成精确 scheme、hostname 与端口，例如 `https://api.example.com:8443/*`；Chrome 匹配模式允许指定端口，路径字段必填但对 host permission 会被忽略，因此不能用路径限制 API 权限。只请求目标 origin，不在静态 `host_permissions` 配置全站访问。若仅支持官方 OpenAI 地址，静态声明 `https://api.openai.com/*` 会更窄；接受任意兼容服务时才使用上述可选模式。

WXT 配置草图：

```ts
export default defineConfig({
  manifest: {
    permissions: ['bookmarks', 'storage', 'notifications'],
    optional_host_permissions: ['https://*/*'],
  },
});
```

实际需要以 `wxt build` 生成清单为准，确认没有意外的静态 `host_permissions` 或 `<all_urls>`。

WXT 官方安装文档使用 `pnpm dlx wxt@latest init` 引导创建项目，Starter 模板默认使用 TypeScript；React 支持通过 `@wxt-dev/module-react` 在 `wxt.config.ts` 的 `modules` 中启用。官方 scripts 至少包含 `dev: wxt`、`build: wxt build` 与 `postinstall: wxt prepare`。WXT 文档不固定一个 npm 稳定版号，因此在实现时通过 `@latest` 选择当时稳定发行版，并提交生成的 pnpm lockfile。

### 本地代码与相关规范

- `.trellis/workflow.md`：要求规划先于实现，复杂任务需 `prd.md`、`design.md`、`implement.md`；任务研究应持久化。
- `.trellis/tasks/10-09-ai-bookmark-manager/prd.md`：记录已确认的内置根目录整理规则，并吸收本研究的 Chrome/WXT 技术约束。
- 本任务最新产品决策：API Key 是 P0 自动处理的必填配置；本地缓存和确定性规则仅用于配置完成后的网络调用前预匹配，纯本地模式延后到 P2。
- `.trellis/spec/frontend/index.md` 与 `.trellis/spec/frontend/type-safety.md`：当前是待填写模板，没有项目级 WXT、扩展 API 或权限约定。
- 未发现 `package.json`、`wxt.config.*`、`entrypoints/` 或 `src/`；当前工作区尚无可引用的产品代码模式。

## Caveats / Not Found

- Chrome 与 WXT 官方页面为滚动更新文档，本次核对日期为 2026-10-09；页面没有给出一个可固定引用的 WXT npm 稳定版号。实现时应在初始化时选择当时稳定版本并提交 lockfile，且检查实际生成的 MV3 manifest。
- 官方 `onImportBegan` / `onImportEnded` 文档定义的是导入会话信号，没有承诺它覆盖其他批量变更来源；导入标记应持久化并设置过期恢复，不能只依赖内存状态。
- 由于书签事件不含“用户显式选择”的来源信息，若产品必须严格保护显式选择动作，需要调整为可观察的用户策略（捕获目录/设置开关），不能声称 `onCreated` 可准确区分。

## External References

- Chrome Bookmarks API（`onCreated`、导入事件、树节点）：https://developer.chrome.com/docs/extensions/reference/api/bookmarks
- Chrome `BookmarkTreeNode.folderType`（Chrome 134+）与 `getTree()`：https://developer.chrome.com/docs/extensions/reference/api/bookmarks
- Chrome `minimum_chrome_version` 安装与更新影响：https://developer.chrome.com/docs/extensions/reference/manifest/minimum-chrome-version
- Chrome 扩展更新生命周期与最低版本策略：https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle
- Chrome MV3 Service Worker 迁移与同步注册事件监听器：https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers
- Chrome Service Worker 生命周期与终止边界：https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- Chrome 可选权限与运行时请求（用户手势、manifest 子集约束）：https://developer.chrome.com/docs/extensions/reference/permissions
- Chrome 权限声明与 `optional_host_permissions` 说明：https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions
- Chrome Host Match Patterns（scheme/host/port/path；host permission 忽略 path）：https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
- Chrome 扩展跨源网络请求权限：https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- WXT Entrypoints（`defineBackground`、MV3 Worker、main 约束）：https://wxt.dev/guide/essentials/entrypoints
- WXT Manifest 配置与生成产物：https://wxt.dev/guide/essentials/config/manifest
- WXT 安装、pnpm 初始化与 TypeScript starter：https://wxt.dev/guide/installation.html
- WXT React module：https://wxt.dev/guide/essentials/frontend-frameworks
