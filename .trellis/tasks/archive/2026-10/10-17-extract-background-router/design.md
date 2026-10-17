# Design: Batch 3 Extract Background Message Router

## Module shape

    entrypoints/background.ts
      import router
      construct adapters and services
      register listeners

    entrypoints/background/router.ts
      export RequestSchema
      export handleRequest(request, services)

normalizeBaseUrl remains in the settings-update route and receives a copy of the parsed patch. The router never logs request bodies, URLs, API keys, or provider payloads.

## Compatibility

Move existing code without rewriting the request union. Preserve the sendResponse success/error envelope. Synchronous listener registration, storage access level, and alarm names remain unchanged.
