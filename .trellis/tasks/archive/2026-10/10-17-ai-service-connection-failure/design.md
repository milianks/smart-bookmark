# Design: Safe Provider Error Guidance

## Boundary

Handle known provider error codes inside `OpenAICompatibleProvider.request()`. Keep the request contract, settings model, runtime message shape, and bookmark workflow unchanged. The UI already displays `ProviderError.message` through the background response, so no UI or message-contract change is needed.

## Error mapping

- Keep 401/403 mapped to the existing authentication/permission message.
- For `ENDPOINT_MIGRATED`, show a migration instruction. Include `new_base_url` only when it parses as HTTPS, contains no username/password/query/fragment, and passes `normalizeBaseUrl()` validation. Otherwise show a migration message without a URL.
- For `model_not_found`, show a model-selection instruction without forwarding provider text.
- Preserve the current status-based fallback and retryability for every other HTTP failure.
- Keep fetch rejection and timeout messages unchanged. Never include raw response text, request details, or the underlying exception.

## Data flow

The provider already reads a bounded response body before handling status. Parse that text only for non-2xx responses, extract only the two recognized codes and the migration URL field, then map to fixed user-safe messages. Do not follow the migration or modify persisted settings.

## Compatibility and rollback

No persisted fields or runtime contracts change. Existing providers and unknown HTTP error codes retain current behavior. Rollback is limited to the provider mapping and its focused tests.

## Risks

Provider error bodies are untrusted. Validate the migration URL before displaying it, and never echo arbitrary `message`, `error`, or body fields. A real browser fetch rejection remains a separate runtime diagnosis; this change improves HTTP error guidance but does not bypass missing permissions or connectivity failures.
