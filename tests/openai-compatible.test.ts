import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '../lib/ai/openai-compatible';
import type { ClassificationInput } from '../lib/ai/prompts';

const input: ClassificationInput = {
  title: 'Untrusted page title',
  url: 'https://example.com/page',
  domain: 'example.com',
  currentFolder: 'Bookmarks bar',
  currentFolderId: 'bar',
};

const config = {
  baseUrl: 'https://api.example.com/v1',
  model: 'test-model',
  apiKey: 'test-key',
};

describe('OpenAICompatibleProvider', () => {
  afterEach(() => vi.useRealTimers());

  it('拒绝不符合分类 Schema 的模型输出', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        action: 'move', targetFolderId: 'bar', confidence: 1.5, reason: 'invalid confidence',
      }) } }],
    }), { status: 200 }));
    const provider = new OpenAICompatibleProvider(fetcher);

    await expect(provider.classify(input, [], config)).rejects.toMatchObject({
      name: 'ProviderError',
      retryable: false,
      message: 'AI 分类结果不符合安全格式，书签已保留原位',
    });
  });

  it('将超时作为可重试错误返回', async () => {
    vi.useFakeTimers();
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })) as typeof fetch;
    const provider = new OpenAICompatibleProvider(fetcher);
    const result = provider.classify(input, [], config);
    const rejection = expect(result).rejects.toMatchObject({
      name: 'ProviderError',
      retryable: true,
      message: 'AI 请求超时，书签已保留原位',
    });

    await vi.advanceTimersByTimeAsync(22_000);

    await rejection;
  });
});
