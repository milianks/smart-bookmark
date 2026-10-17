# Directory Structure

> How backend code is organized in this project.

---

## Overview

The backend is the Chrome Manifest V3 extension service worker, not a web server. `entrypoints/background.ts` wires Chrome events and runtime messages to services. Business orchestration, Chrome API adapters, AI integration, and local persistence live in separate modules below the repository root.

## Directory Layout

```text
entrypoints/
├── background.ts             # MV3 adapters, dependency assembly, and listeners
└── background/
    └── router.ts             # strict runtime schema and request dispatch
services/
├── activity-log.ts            # bounded activity append and job-pruning transformations
├── bookmark.service.ts        # Chrome Bookmarks API adapter and port
├── classifier.service.ts      # local rules/cache and provider orchestration
├── notification.service.ts    # Chrome notifications adapter
├── organizer.service.ts       # jobs, review, bookmark mutation, undo, and recovery
├── scan-state.ts              # pure historical scan transitions and projection
├── scan.service.ts            # historical scan start and batch approval
└── settings.service.ts        # settings, drafts, and provider tests
lib/
├── ai/                        # provider, prompts, rules, and URL config
├── storage/repository.ts      # chrome.storage.local repository
└── utils/ids.ts               # stable IDs and URL fingerprints
types/
├── domain.ts                  # domain schemas and persisted-state types
└── messages.ts                # page/background message contract
tests/                         # Vitest unit tests and test doubles
```

The React extension pages are under `components/` and `entrypoints/{popup,options,review}/`; those are covered by the frontend guides.

## Module Organization

- Keep Chrome listener registration, dependency assembly, and the response/error boundary in `entrypoints/background.ts`; strict request validation and dispatch live in `entrypoints/background/router.ts`.
- Pass typed service facades and `normalizeBaseUrl` to the router; it must not access Chrome APIs, storage, or bookmarks.
- Put orchestration in the existing services. `OrganizerService` owns persisted jobs, review/mutation workflows, undo, and recovery; `ScanService` coordinates historical scan and batch-approval work through narrow Organizer callbacks; `SettingsService` owns settings, drafts, and provider tests.
- Keep historical scan state transitions in the pure `scan-state.ts` module and activity append/job-pruning transformations in `activity-log.ts`; invoke state mutations only inside `StateRepository.update()` callbacks.
- Keep Chrome API access behind the existing service or repository adapter (`ChromeBookmarkService`, `ChromeNotificationService`, `ChromeStateRepository`). The organizer receives ports so its tests can use fakes.
- Put provider-specific HTTP and response parsing in `lib/ai/`; keep shared domain and runtime message shapes in `types/`.
- This project has no server routes, controllers, SQL layer, or ORM. Do not introduce those as if they were established layers.

## Naming Conventions

Existing service files use lower-case domain names with `.service.ts` (for example, `services/bookmark.service.ts`). AI and utility modules use lower-case kebab-case names, while shared type modules use lower-case names such as `types/domain.ts`. Exported classes use PascalCase (`OrganizerService`, `ChromeStateRepository`); functions and values use camelCase.

## Examples

- `entrypoints/background.ts` registers `chrome.bookmarks.onCreated` synchronously and delegates to `organizer.onBookmarkCreated`.
- `services/organizer.service.ts` owns the queued/review/move workflow and depends on `BookmarkPort` and `StateRepository`.
- `services/bookmark.service.ts` adapts Chrome bookmark operations to `BookmarkPort`; `lib/storage/repository.ts` adapts `chrome.storage.local` to `StateRepository`.
