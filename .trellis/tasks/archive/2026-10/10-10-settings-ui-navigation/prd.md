# 修复设置页宽度与导航状态

## Goal

修复打开设置页时的页面宽度变化，以及设置页失焦/关闭后无法恢复到设置页的问题。

## Requirements

- 设置入口打开后，设置页保持与扩展主界面一致、稳定且适合配置表单的宽度，不因从弹窗切换到设置页而出现明显变窄。
- 从主界面进入设置后，设置页必须获得正常的页面焦点，用户可以立即点击并复制 API Key 等内容，不应因为弹窗关闭或失焦而被关闭。
- 用户再次打开扩展时，设置入口和设置页导航行为应保持一致；从设置页返回主界面后再次点击设置，仍应打开设置页而不是停留在初始页面。
- 修复应沿用现有 WXT/React 页面结构，不引入全局状态库，不改变 AI 配置和保存逻辑。

## Acceptance Criteria

- [x] 设置页在浏览器扩展页面中具有稳定的最小宽度和可用布局，AI 配置表单不会被压缩到不美观的窄栏。
- [x] 设置页打开后可直接聚焦、输入和复制 API Key；页面不会因原弹窗关闭而意外消失。
- [x] 设置页与主界面之间的进入、返回、再次进入路径均能到达正确页面。
- [x] `pnpm typecheck`、`pnpm test --run`、`pnpm build` 和 `git diff --check` 通过。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
