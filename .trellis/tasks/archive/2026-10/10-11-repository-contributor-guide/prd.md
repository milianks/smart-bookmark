# Repository Contributor Guide

## Goal

Add a concise guide for contributors to this repository in the root `AGENTS.md`.

## Confirmed Facts

- The root `AGENTS.md` contains only a Trellis-managed instruction block.
- The user explicitly authorized modifying `AGENTS.md` and completing this task.
- The repository uses TypeScript, React, WXT, pnpm, and Vitest; verify exact commands and layout before documenting them.

## Requirements

- Title the guide “Repository Guidelines” and keep its explanatory content within 200–400 words.
- Cover only applicable repository structure, development/test commands, coding and test conventions, and commit/PR expectations.
- Add the guide before the existing `<!-- TRELLIS:START -->` through `<!-- TRELLIS:END -->` block and preserve that block unchanged.
- Base every command and convention on repository files or Git history.

## Acceptance Criteria

- [x] `AGENTS.md` contains the concise contributor guide before the original Trellis block, which remains unchanged.
- [x] Commands, paths, test framework, and commit guidance match verified repository evidence.
- [x] Appropriate document and task checks pass; unrelated working-tree changes remain untouched.

## Out of Scope

- Source-code changes or edits to unrelated files.
