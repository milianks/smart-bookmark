# Technical Design

## Boundaries

Keep the background service as the owner of persisted settings, provider requests, permissions, and bookmark operations. The options page sends a typed `settings:update`, refreshes `DashboardState`, and triggers `provider:test` only after saving. `PublicSettings` continues to expose `hasApiKey`, never the key.

Add a protocol discriminator to the settings model and provider configuration. The provider becomes a small dispatcher over three request/response adapters while `ClassifierProvider.classify()` and `test()` remain the service boundary. The existing `ClassificationResultSchema` remains the only accepted output contract.

## Protocol contract

Treat the configured URL as a base that may include `/v1`; append only the selected protocol suffix and strip a recognized already-entered endpoint suffix during normalization. Keep the existing HTTPS and loopback-only HTTP validation and origin-only optional permission.

| Protocol | Endpoint suffix | Authentication | Request shape | Text extraction |
|---|---|---|---|---|
| `anthropic-messages` | `/messages` | `x-api-key`, `anthropic-version: 2023-06-01` | `model`, `max_tokens`, `system`, one user message | Concatenate `content` blocks with `type: "text"` |
| `openai-chat-completions` | `/chat/completions` | Bearer token | Existing `model`, `messages`, `max_tokens`, `temperature` | `choices[0].message.content` |
| `openai-responses` | `/responses` | Bearer token | `model`, `instructions`, user `input`, `max_output_tokens` | Concatenate assistant `output` message content blocks with `type: "output_text"` |

Keep requests non-streaming and bounded by the current timeout and response-size limit. Continue prompting for a single JSON classification. Parse as unknown, then use strict Zod validation; do not trust HTTP 200 or JSON parsing alone. Sanitize all transport and provider errors; never surface raw response bodies or request details.

## Test AI flow

`SettingsApp` keeps the existing user-activation permission request. After the form is saved, `provider:test` reaches the background using the saved settings. The provider sends one short synthetic bookmark plus a synthetic folder list through the selected adapter; it does not use `BookmarkPort`, read application state beyond settings, write cache/activity state, or mutate a bookmark. Report success only after a response is extracted and accepted by `ClassificationResultSchema` (and, if the result references a destination, verify that it references the supplied synthetic folder). This exercises the actual classification shape without exposing user data.

## Settings and cache compatibility

- Add a required protocol value to `SettingsSchema` and its typed patch validation.
- During repository normalization, merge safe defaults with a legacy settings object before validation and set a missing protocol to `openai-chat-completions`. Preserve all valid existing values, especially `apiKey`, `baseUrl`, `model`, and organization preferences. The normalized value is returned on load and stored on the next state update. Keep the current local storage key and root state version; do not create a second persistence system.
- Include protocol in the classifier cache key alongside normalized base URL and model so identical bookmark/folder data cannot reuse a result from another route.
- The `aiaaa.cc` test base remains user-entered only and is never inserted into `DEFAULT_SETTINGS`.

## Compact UI

Keep one primary AI service card with protocol, base URL, model, write-only key field, status, and adjacent “保存设置” / “授权并测试 AI” actions. Keep the current automatic organization toggle easy to reach. Place confidence threshold, organization mode, force mode, notification preferences, privacy details, and recent operations in compact disclosure sections. Use native controls, preserve current labels/behavior and async status roles, and remove the duplicate bottom save action.

## Failure behavior and rollback

Provider failure, unsupported response shape, JSON parse failure, schema failure, timeout, or missing origin permission must leave bookmarks unchanged and produce a safe user-facing message. There is no backend service or external migration. Legacy data is normalized on load; the setting addition does not change the storage key or root version. A pre-feature build may not understand the new strict settings field, so rollback testing should use a copied local state fixture and must not overwrite a user's only settings copy.

## Official protocol references

See [protocol research](./research/api-protocols.md) for fetched OpenAI and Anthropic references and the compatibility decision.
