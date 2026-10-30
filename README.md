# AI Bookmark Manager

> 一款 Chrome MV3 书签整理扩展：继续用原生收藏按钮，把书签保存到「智能书签」目录，让 AI 在后台分类。

[![CI](https://github.com/milianks/smart-bookmark/actions/workflows/ci.yml/badge.svg)](https://github.com/milianks/smart-bookmark/actions/workflows/ci.yml)
![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=google-chrome&logoColor=white)
![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-yellow.svg)
![Version](https://img.shields.io/badge/version-0.2.3-blue)
[![Changelog](https://img.shields.io/badge/changelog-view-blue)](CHANGELOG.md)

配置任意 OpenAI 兼容 API 后，扩展会监听新增书签、读取已有文件夹树、优先复用最接近的目录，并在低置信度或需要新建目录时等待你确认。所有数据保存在本机，不上传整套书签库。

> 仓库地址：https://github.com/milianks/smart-bookmark

## 目录

- [功能特性](#功能特性)
- [快速开始](#快速开始)
- [配置 AI](#配置-ai)
- [使用方式](#使用方式)
- [分类与整理策略](#分类与整理策略)
- [内容辅助分类](#内容辅助分类)
- [隐私与权限](#隐私与权限)
- [项目结构](#项目结构)
- [开发与测试](#开发与测试)
- [持续集成](#持续集成)
- [变更日志](#变更日志)
- [贡献](#贡献)
- [许可证](#许可证)

## 功能特性

- **原生收藏体验**：继续使用 Chrome 收藏按钮；默认保存到「智能书签」目录，也可显式开启内置根目录接管。
- **智能分类**：结合本地缓存、确定性标题/域名规则与 OpenAI 兼容模型，优先复用已有文件夹。
- **人工确认**：低置信度、需要新建目录或在确认模式下，建议进入 Review 页面，可改选目标目录后批准。
- **内容辅助分类（可选）**：读取已授权站点的网页正文，归纳为摘要/主题/内容类型辅助分类；原文不落盘。
- **纠错学习**：记住你的手动纠正，只对同一页面 URL 复用纠正，并聚合为主题/内容类型偏好；设置页可清除学习结果，撤销自动移动不会污染学习结果。
- **历史书签扫描**：枚举已有 HTTP(S) 书签，生成预览与重复项归档建议，支持逐条或批量批准与批量撤销。
- **摘要与标签**：在 Popup 或 Review 中为书签手动生成并持久化摘要与标签。
- **可撤销**：自动归档保留最近 10 次撤销记录，历史批量移动也可整体回退。
- **本地优先**：设置、任务、缓存、建议与日志全部保存在 `chrome.storage.local`。

## 快速开始

### 环境要求

- Node.js 20+
- pnpm 10+
- Chrome 134+

### 安装与开发

```bash
pnpm install
pnpm dev
```

`pnpm dev` 会启动 WXT 的 Chrome 开发构建。打开 `chrome://extensions`，开启「开发者模式」，加载 WXT 输出的开发目录。

### 构建生产版本

```bash
pnpm typecheck
pnpm test --run
pnpm build
```

生产构建位于 `.output/chrome-mv3/`。在 `chrome://extensions` 中选择「加载已解压的扩展程序」，指向该目录即可。

## 配置 AI

1. 点击扩展图标，进入「设置」。
2. 填写 OpenAI 兼容 API 地址、模型名称和 API Key。
3. 点击「授权并测试 AI」，按提示授予该 API 来源的可选网络权限。
4. 测试通过后，扩展开始处理之后新增的书签；未配置 API Key 时新书签保持原位。

- 支持 `https://` 地址；仅 `localhost`、`127.0.0.1`、`[::1]` 允许 HTTP。
- 地址填写到 API 版本根路径，例如 `https://api.openai.com/v1`，不要附加 `/chat/completions`。
- API Key 保存在浏览器扩展本地存储中，请使用可撤销、低额度的密钥，避免在共享设备上保存。

## 使用方式

| 场景 | 行为 |
| --- | --- |
| 收藏新网页 | 进入分类队列，命中规则/缓存时直接归档，否则请求模型 |
| 低置信度或需要新目录 | 进入 Review，等待确认 |
| 拒绝建议 | 记住「该域名保留原位」，后续同域名直接跳过模型 |
| 改选目录后批准 | 记住「该域名归入所选目录」，并聚合为主题偏好 |
| 自动归档后反悔 | Popup 中逐条撤销最近 10 次自动移动 |
| 整理历史书签 | Popup 启动历史扫描，只生成预览，逐条或批量批准 |
| 生成摘要/标签 | 在书签卡片或 Review 详情中手动触发 |

## 分类与整理策略

- 默认只整理「智能书签」目录及其子目录中的新增书签；开启「接管内置根目录」后，书签栏、其他书签与移动设备书签根目录的新增项也会参与分类。
- 智能书签目录外的自建文件夹不接管；历史扫描始终仅扫描智能书签目录。首次使用 Ctrl+D 时需选中该目录，或在设置页开启「接管内置根目录」。
- 分类顺序：页面 URL 纠错 → 主题/内容类型偏好 → 确定性规则 → 匹配当前单条分类上下文的 AI 缓存 → 模型；单条与批量共享逐条缓存，批量只请求未命中项。每条书签独立判断，不要求同批主题联动。
- 置信度达到阈值且处于自动模式时才自动移动到现有文件夹；新建文件夹始终需要确认。
- 历史扫描按约 15 条一批处理，未命中项按相同候选目录合并请求；候选不同可能拆成多次请求。扫描按规范化 URL 检测重复书签，保留最早添加的一条。
- 批量批准写入后台队列，每次最多处理 10 条；关闭 Popup 后继续，Worker 重启可恢复。界面自动更新进度，失败项保留供单独重试。
- AI 失败、超时、权限不足、返回无效结构或无效文件夹 ID 时，书签保留原位并显示原因。
- 旧版本按域名学习的纠错规则升级后重置，避免误用到同站其他页面；URL 纠错保留 hash 路由差异。终态审核记录保留最近 250 条（活动与恢复引用除外），摘要标签保留最近 2,000 条，删除书签时同步清理。

## 内容辅助分类

在设置中开启「读取网页内容辅助分类」并授权网页访问后：

- 收藏时会读取**当前活动标签页**，用 [Mozilla Readability](https://github.com/mozilla/readability) 提取正文（失败时回退到启发式清洗）。
- 从正文首、中、尾采样，结合页面描述形成最多 500 字符的摘录，并附加标题/标题段落推导的主题与内容类型。摘录随任务保存；**完整提取正文不落盘**。
- 正文取材范围默认 3,000 字符，可切换 1,000 / 3,000 / 6,000；影响采样位置，输出摘录上限固定，不保证范围越大越准确。
- 银行/支付、健康、登录/内网等敏感站点默认跳过；也可在设置中按域名排除。
- 未授权站点、无法访问的页面、非 HTTP(S) 页面自动回退到仅元数据分类。
- 历史书签扫描与手动重新分析仍只使用元数据，不抓取历史页面。

## 隐私与权限

安装时申请：`bookmarks`、`storage`、`notifications`、`alarms`、`scripting`。

- **默认没有静态网站 host 权限**，不读取网页正文、不访问浏览历史、不上传完整书签库、不使用登录服务或分析 SDK。
- 运行时可选 host 权限只在用户操作后请求：
  - 点击「授权并测试 AI」时，针对所填 API 来源请求；
  - 开启「内容辅助分类」时，另外请求网页访问权限。
- 模型输入只包含当前书签的标题、URL、域名、当前文件夹与目录清单；开启内容辅助后额外包含采样摘录与主题信息。
- 标题、URL 与网页画像均按不可信文本处理；模型结果经过 Zod Schema 与当前书签树 ID 校验后才进入决策层。
- API Key 只保存在本地存储，不写入源码、操作日志或通知。

## 项目结构

```text
entrypoints/     MV3 后台、Popup、Settings、Review 页面与按需注入的正文提取脚本
components/      React 页面与 shadcn 风格 Tailwind UI 组件
services/        Chrome 书签、分类、自动整理、扫描、通知、页面提取
lib/             AI Provider、规则分类、Prompt、存储与工具
types/           共享业务类型与 runtime message 契约
tests/           Vitest 单元测试与 Chrome API Mock
.github/         CI、发布工作流、Issue/PR 模板
```

## 开发与测试

```bash
pnpm dev            # Chrome 开发构建
pnpm typecheck      # 严格 TypeScript 检查
pnpm test --run     # 单次运行 Vitest
pnpm build          # 生产构建到 .output/chrome-mv3
```

测试使用 Vitest 与 Chrome API Mock，覆盖分类、整理、扫描、存储迁移、Provider 与页面画像。

## 持续集成

- `.github/workflows/ci.yml`：在 push / pull request 时运行 `typecheck`、`test`、`build`，并上传构建产物。
- `.github/workflows/release.yml`：推送 `v*` 标签时构建并创建 GitHub Release，附带扩展 zip。
- `.github/dependabot.yml`：每周检查 npm 与 GitHub Actions 依赖更新。

## 变更日志

各版本变更见 [CHANGELOG.md](CHANGELOG.md)。

## 贡献

欢迎 Issue 与 Pull Request。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，并确保提交前通过：

```bash
pnpm typecheck && pnpm test --run && pnpm build
```

## 许可证

[MIT](LICENSE)
