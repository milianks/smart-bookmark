# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

The extension background is the backend boundary for this single-repo WXT project. It owns bookmark mutation, durable queue coordination, provider calls, permissions, and typed messages. There is no server or database in the P0 application.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | Active |
| [Database Guidelines](./database-guidelines.md) | Local extension persistence patterns | Active |
| [Error Handling](./error-handling.md) | Error types, handling strategies | Active |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | Active |
| [Logging Guidelines](./logging-guidelines.md) | Diagnostics and activity history | Active |
| [Chrome Extension Runtime Contract](./extension-runtime-contract.md) | MV3 lifecycle, durable jobs, provider and bookmark mutation contracts | Active |

---

**Language**: All documentation should be written in **English**.
