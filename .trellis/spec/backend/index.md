# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

The extension background is the backend boundary for this single-repo WXT project. It owns bookmark mutation, durable queue coordination, provider calls, permissions, and typed messages. There is no server or database in the P0 application.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | To fill |
| [Database Guidelines](./database-guidelines.md) | ORM patterns, queries, migrations | To fill |
| [Error Handling](./error-handling.md) | Error types, handling strategies | To fill |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | To fill |
| [Logging Guidelines](./logging-guidelines.md) | Structured logging, log levels | To fill |
| [Chrome Extension Runtime Contract](./extension-runtime-contract.md) | MV3 lifecycle, durable jobs, provider and bookmark mutation contracts | Active |

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English**.
