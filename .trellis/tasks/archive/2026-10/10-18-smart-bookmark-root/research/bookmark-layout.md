# 书签初始化布局研究

## 研究时间

2026-10-18

## 公开方案摘录

- [Bookmarker: How to Organize Bookmarks](https://bookmarker.cc/blog/how-to-organize-bookmarks)：建议两级结构、5–8 个一级分类；常见分类为 Work、Learning、Reading、Inspiration、Tools、Personal、Projects；建议保留 Read Later/To Try 或归档类收件位置。
- [Forte Labs: PARA bookmarks](https://fortelabs.com/blog/organize-your-bookmarks-with-the-para-method-for-lightning-fast-web-browsing/)：用 Projects、Areas、Resources、Archives 按可行动性组织；项目完成后移入 Archive；避免空目录和深层层级。
- [Bookmarkify: bookmark organization systems](https://www.bookmarkify.io/blog/best-way-to-organize-bookmarks-bc9f1)：文件夹层级示例包含 Work、Personal、Research；Work 下可有 Clients、Projects、Resources，Research 下可有 Design、Development、Marketing；建议目录深度控制在 3–4 层，并设置 Unsorted 收件目录。
- [Raindrop.io](https://raindrop.io/)：使用 Collections 作为主分类，Tags/filters 作为交叉检索；说明了“一级集合 + 后续标签”比无限嵌套更易维护，但本项目只操作 Chrome 原生文件夹，首装不引入独立标签系统。

## 结论

首装布局采用“生命周期目录 + 主题目录”混合方案：`待分类`承接低置信度/失败分类，`归档`承接完成项目或旧链接；主题目录覆盖工作、项目、开发、学习、研究、阅读、工具、灵感、生活。目录名加 emoji 提升 Chrome 原生书签栏可扫描性，但分类器仍以去除符号后的语义和完整路径为依据。

首装只创建一级目录。用户或后续 Review 明确需要时再创建子目录，AI 每次读取实时目录树，不依赖固定的初始名称。
