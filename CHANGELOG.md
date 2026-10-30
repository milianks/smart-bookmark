# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.3] - 2026-10-30

### Changed

- 缓存已校验的存储快照，外部写入时失效，减少重复读取；合并保持原位分类的连续写入，保留失败恢复与移动前落盘顺序。
- Popup 与 Review 改用轻量端口通知并支持断线重连；面板按页面裁剪返回字段，复用文件夹列表并随书签变化失效。
- 新增 5000 条书签入队及单批处理基准，验证存储开销、状态体积与面板读树次数。

## [0.2.2] - 2026-10-30

### Changed

- 全面优化 Popup、Review、Settings 及基础 UI 组件的视觉风格与亮/暗色主题层次。
- 固定弹窗视图高度（`390px × 580px`，顶栏与底栏固定、中间内容区滚动），并为所有展开面板（`Disclosure`）及建议列表设置固定最大高度与内部滚动条，避免展开后无限拉长页面。

## [0.2.1] - 2026-10-30

### Fixed

- 纠错改为页面 URL 范围，保留 SPA hash 路由差异，避免同域不同主题互相误伤；设置页新增清除纠错与偏好入口。
- 收紧本地规则的弱证据匹配，避免单个中文双字词叠加同域样例后误触发自动移动。
- Popup 与 Review 自动刷新后台进度，并忽略乱序返回的旧状态；设置页明确默认接管范围。
- 内容辅助的字符预算实际影响正文采样，输出摘录上限固定为 500 字符，修正文案中的准确率与费用暗示。
- 批量审批采用持久化分批队列，支持 Worker 重启恢复、失败重试；修复审批异常后停留在“处理中”的状态。
- 完成扫描的统计不再因历史记录裁剪而改变。

### Changed

- 书签边界与路径检查改读实时祖先链；合并并发状态读取，跳过无变化写入，设置草稿增加防抖。
- 终态审核记录保留最近 250 条，活动和恢复引用除外；摘要标签保留最近 2,000 条，删除书签时同步清理。
- 移除无效的 `forceOrganize` 设置、未使用的持久化 `pageProfiles` 与旧历史枚举代码。
- 移除 `identity.email` 权限，新建根目录统一命名为“智能书签”，保留已有根目录 ID 和名称。
- 固定 WXT 与 React module 的现有依赖版本，保留 MV3 恢复、Zod 校验与无静态 host 权限边界。

### Migration

- 旧版按域名学习的纠错规则升级后重置，避免继续应用到同站其他页面；现有书签位置不变。

## [0.2.0] - 2026-10-23

### Added

- 内容辅助分类：收藏时按用户授权读取当前网页正文，优先使用 Mozilla Readability、失败时回退启发式清洗，归纳为摘要/主题/内容类型画像；原始正文不落盘。
- 网页画像注入分类提示，并纳入分类缓存指纹，避免切换开关后命中旧缓存。
- 纠错学习聚合：保留按域名即时路由，新增「主题/内容类型 → 倾向文件夹」偏好（计数/权重），撤销自动移动不写入学习结果。
- 内容辅助分类设置：开关（默认关闭）、正文提取上限 1,000 / 3,000 / 6,000 字符、敏感站点与单站点排除。
- 敏感站点默认跳过（银行/支付、健康、登录/内网等）。
- GitHub 工程配置：CI、Release、Dependabot、Issue/PR 模板、`CONTRIBUTING.md`、`LICENSE`（MIT）。

### Changed

- 版本号从 `0.1.0` 升级到 `0.2.0`。
- Chrome manifest 新增 `scripting` 权限，用于按需注入正文提取脚本。
- README 重写为 GitHub 风格，补充功能、使用、隐私与开发说明。

### Privacy

- 默认仍不读取网页正文、无静态网站 host 权限；只有开启「内容辅助分类」并授权后才会请求网页访问权限。

### Fixed

- 修复因模型世界知识过时（域名易主/产品改名，如 `muse.ai`）导致的分类错误：内容辅助开启后可依据网页现状归类。

## [0.1.0] - 2026-10-21

### Added

- Chrome MV3 扩展骨架（WXT + React + Tailwind），后台 Service Worker、Popup、Settings、Review 页面。
- 后台新增书签监听、智能书签根目录初始化、文件夹树读取/验证/创建/移动。
- 本地缓存 + 确定性标题/域名规则预分类，仅在规则无法高置信度匹配时调用模型。
- OpenAI 兼容 Provider：支持 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 三种协议，结构化输出走工具调用并支持文本降级。
- 持久化任务队列、导入抑制、失败重试与权限等待状态。
- Review 通知与确认：改选目标文件夹后批准、按目标文件夹分组与组级批准、低置信度/新目录进入确认。
- 用户纠错表按域名回喂分类并注入模型提示。
- 历史书签扫描：强制预览、逐条或批量批准、按规范化 URL 检测重复并生成「移入归档」建议、历史批量撤销、约 15 条/批合并请求。
- 摘要与标签生成，并在 Popup / Review 中持久化展示。
- 自动归档撤销栈（保留最近 10 条）。
- 设置页、Popup、操作日志，以及「接管内置根目录」开关（默认关闭）。

### Fixed

- 待确认视图嵌入 Popup，统一宽度与排版，修复布局跳动。

[Unreleased]: https://github.com/milianks/smart-bookmark/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/milianks/smart-bookmark/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/milianks/smart-bookmark/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/milianks/smart-bookmark/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/milianks/smart-bookmark/releases/tag/v0.2.0
