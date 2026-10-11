# Repository Facts for Contributor Guide

## Project Layout

- `entrypoints/`: WXT Chrome extension background, popup, options, and review entrypoints.
- `components/`: React UI pages and reusable components.
- `services/`: bookmark, classification, organization, and notification services.
- `lib/`: storage, AI provider, classifier, prompts, and utilities.
- `types/`: shared domain types and runtime message contracts.
- `tests/`: Vitest unit tests with Chrome API mocks.
- `public/`: extension icons and static assets.

## Tooling and Commands

`package.json` defines `pnpm dev` (WXT Chrome dev build), `pnpm build`, `pnpm typecheck`, and `pnpm test`. The README documents `pnpm install`, `pnpm dev`, `pnpm typecheck`, `pnpm test --run`, and `pnpm build`. Runtime prerequisites are Node.js 20+, pnpm, and Chrome 134+.

Vitest runs in Node and includes `tests/**/*.test.ts`; existing test files use `.test.ts`. TypeScript strict checking is configured in `tsconfig.json`. No lint/format script or `.editorconfig`/Prettier/ESLint/Biome configuration was found. Source examples use two-space indentation, single quotes, and semicolons; React component exports use PascalCase.

## Contribution History

Recent commits use Conventional Commit-style prefixes, including `feat:`, `fix:`, `chore:`, and scoped forms such as `chore(task):`. No PR template or contribution guide was found. Recommend PRs summarize the behavior change and verification; include screenshots for UI changes.

## Evidence

Facts above were checked against `README.md`, `package.json`, `wxt.config.ts`, `vitest.config.ts`, `tsconfig.json`, representative component/test files, `.trellis/spec/frontend/index.md`, and recent `git log` entries.
