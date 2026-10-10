# API Protocol Research

## OpenAI official documentation

- [Chat Completions create](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) documents `POST /v1/chat/completions`, bearer authentication, `model` plus `messages`, and generated text in `choices[].message.content`. It supports JSON response formats, but compatible gateways vary in support.
- [Responses create](https://developers.openai.com/api/reference/resources/responses/methods/create) documents `POST /v1/responses`, `model` and `input`, optional `instructions` and `max_output_tokens`, and response output items. Generated text is carried in assistant message content blocks with type `output_text` (the SDK also exposes `output_text`).
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) documents schema-constrained output. The implementation plan does not depend on this extension because the user requests an OpenAI-compatible option and some gateways accept only the common request fields.

## Anthropic official documentation

- [Messages API](https://docs.anthropic.com/en/api/messages) and the [official TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) establish the Messages route, `x-api-key`, `anthropic-version: 2023-06-01`, and a response `content` array containing text blocks.
- [Structured Outputs](https://docs.anthropic.com/en/docs/build-with-claude/structured-outputs) documents `output_config.format` with a JSON Schema. The MVP uses the shared JSON-only prompt and local strict validation instead, avoiding a requirement that compatible proxies implement Anthropic's structured-output extension.

## Implementation consequence

The URL `https://aiaaa.cc/v1` is a base supplied for manual protocol tests. With the planned suffix mapping it targets `/v1/messages`, `/v1/chat/completions`, or `/v1/responses`. No request to this URL is part of planning or automated tests; automated protocol tests stub `fetch`.
