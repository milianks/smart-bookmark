# Contributing

感谢你愿意参与改进。提交前请先确认下面的约定。

## 环境

- Node.js 20+
- pnpm 10+
- Chrome 134+

```bash
pnpm install
pnpm dev
```

## 提交前检查

```bash
pnpm typecheck
pnpm test --run
pnpm build
```

三项都必须通过。修改分类、存储、Provider 或页面提取行为时，请补充对应 Vitest 用例。

## 代码风格

- TypeScript strict；两空格缩进、单引号、分号。
- React 组件使用 PascalCase 导出。
- 共享业务类型与 runtime message 契约放在 `types/`。
- 遵循 `.trellis/spec/` 中按层划分的规范。

## 提交信息

使用 Conventional Commits，例如：

```text
feat: add content-aware classification
fix: keep bookmarks in place on invalid folder ids
chore(ci): add release workflow
```

## 分支与 PR

1. 从 `main`（或 `master`）创建功能分支：`feat/...`、`fix/...`、`chore/...`。
2. PR 描述说明用户可见变化，并列出实际执行的验证命令与结果。
3. UI 变更请附截图或录屏。
4. 不要提交密钥、`.env`、`.output/`、`node_modules/` 或本地运行时状态。

## 隐私约定

本项目默认不读取网页正文、不申请静态网站 host 权限。任何会扩大数据采集范围的改动都必须在 PR 中说明，并同步更新 README 与设置页文案。
