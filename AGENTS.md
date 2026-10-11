# Repository Guidelines

## Project Structure & Module Organization

`entrypoints/` contains the WXT Chrome extension background and page entrypoints. React pages and shared UI components live in `components/`; bookmark, classification, organization, and notification logic lives in `services/`. `lib/` holds storage, AI provider, classifier, prompt, and utility code. Shared domain types and runtime message contracts are in `types/`. Vitest tests are under `tests/`, and extension icons and static assets are under `public/`.

## Build, Test, and Development Commands

Use Node.js 20 or newer, pnpm, and Chrome 134+ for extension testing. Run `pnpm install` to install dependencies. `pnpm dev` starts the WXT Chrome development build; `pnpm build` creates the production extension in `.output/chrome-mv3/`. Run `pnpm typecheck` for strict TypeScript checks and `pnpm test --run` to execute Vitest once without watch mode. To test the built extension in Chrome, enable Developer mode at `chrome://extensions` and load the generated directory.

## Coding Style & Naming Conventions

Follow the existing TypeScript style: two-space indentation, single-quoted strings, and semicolons. TypeScript strict checking is enabled. Use PascalCase for React component exports and preserve typed runtime message contracts in `types/`. The repository does not define a lint or formatting script, so use nearby files as the style reference.

## Testing Guidelines

Vitest runs in Node and discovers `tests/**/*.test.ts`; current tests use the `.test.ts` suffix and Chrome API mocks. Add or update tests in `tests/` when changing tested service or provider behavior, then run `pnpm test --run` and `pnpm typecheck`. `pnpm build` checks the WXT production build.

## Commit & Pull Request Guidelines

Recent commits use Conventional Commit prefixes such as `feat:`, `fix:`, and `chore:`, including scoped forms like `chore(task):`. Use a short imperative summary after the prefix. PR descriptions should explain the user-visible change and list verification commands/results. Include screenshots for popup, settings, review, or other UI changes, and link a related issue when one exists.

<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->
