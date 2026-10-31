# 后台重复代码清理与 lint

## Goal

消除 `entrypoints/background.ts` 中的重复权限检查，并为仓库加上 lint 脚本和 CI 检查，让代码风格不再只靠人工对照。

## Background

- `hasProviderPermission` 的同一实现在 `entrypoints/background.ts:21`、`:38`、`:66` 出现 3 次（`chrome.permissions.contains` + 失败返回 `false`）。
- `package.json` 无 lint/format 脚本；CI（`.github/workflows/`）只跑 typecheck、test、build。AGENTS.md 要求两空格缩进、单引号、分号，目前靠参照邻近文件。

## Requirements

- R1：抽出单一 `hasProviderPermission(baseUrl)` 函数，三个服务共用；行为（异常时返回 `false`）不变。
- R2：引入 ESLint flat config，使用 `typescript-eslint` 与 `eslint-plugin-react-hooks`，版本精确锁定。规则以「不需大面积改代码」为准：先启用推荐规则，确有大量违规的规则暂设为 `warn` 并在 PRD 末尾记录。
- R3：新增 `pnpm lint` 脚本，并在 CI 的 Typecheck 之后增加 Lint 步骤。
- R4：不引入格式化工具的全量重排（避免巨大 diff）；如需 Prettier，另开任务。

## Acceptance Criteria

- AC1：`entrypoints/background.ts` 中 `chrome.permissions.contains` 只出现一次。
- AC2：`pnpm lint` 在当前代码上以 0 error 通过；CI 配置包含 lint 步骤。
- AC3：`pnpm typecheck`、`pnpm test --run`、`pnpm build`、`git diff --check` 通过。

## Notes

- 新增 devDependencies 属于中等风险操作，开工时向用户列出包名与版本。
- 与其他子任务无依赖；若在 perf 任务之前完成，lint 修复只限机械性改动。
