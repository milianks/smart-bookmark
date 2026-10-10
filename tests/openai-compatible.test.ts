import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '../lib/ai/openai-compatible';
import type { ProviderConfig } from '../lib/ai/provider-config';
import type { ClassificationInput } from '../lib/ai/prompts';

const input: ClassificationInput = {
  title: 'Untrusted page title',
  url: 'https://example.com/page',
  domain: 'example.com',
  currentFolder: 'Bookmarks bar',
  currentFolderId: 'bar',
};

const result = {
  action: 'keep',
  confidence: 0.91,
  reason: 'The synthetic page does not need moving.',
};

const baseConfig: Omit<ProviderConfig, 'protocol'> = {
  baseUrl: 'https://aiaaa.cc/v1',
  model: 'test-model',
  apiKey: 'test-key',
};

describe('OpenAICompatibleProvider', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    {
      protocol: 'openai-chat-completions' as const,
      url: 'https://aiaaa.cc/v1/chat/completions',
      response: { choices: [{ message: { content: JSON.stringify(result) } }] },
      assertRequest: (init: RequestInit) => {
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key');
        expect(new Headers(init.headers).get('x-api-key')).toBeNull();
        expect(JSON.parse(String(init.body))).toMatchObject({
          model: 'test-model',
          messages: [{ role: 'system' }, { role: 'user' }],
          max_tokens: 500,
        });
      },
    },
    {
      protocol: 'anthropic-messages' as const,
      url: 'https://aiaaa.cc/v1/messages',
      response: { content: [{ type: 'text', text: JSON.stringify(result) }] },
      assertRequest: (init: RequestInit) => {
        const headers = new Headers(init.headers);
        expect(headers.get('x-api-key')).toBe('test-key');
        expect(headers.get('anthropic-version')).toBe('2023-06-01');
        expect(headers.get('authorization')).toBeNull();
        expect(JSON.parse(String(init.body))).toMatchObject({
          model: 'test-model',
          max_tokens: 500,
          system: expect.any(String),
          messages: [{ role: 'user', content: expect.any(String) }],
        });
      },
    },
    {
      protocol: 'openai-responses' as const,
      url: 'https://aiaaa.cc/v1/responses',
      response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] },
      assertRequest: (init: RequestInit) => {
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key');
        expect(JSON.parse(String(init.body))).toMatchObject({
          model: 'test-model',
          instructions: expect.any(String),
          input: expect.any(String),
          max_output_tokens: 500,
        });
      },
    },
  ])('$protocol sends the expected route and protocol request, then validates classification JSON', async ({ protocol, url, response, assertRequest }) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response), { status: 200 }));
    const provider = new OpenAICompatibleProvider(fetcher);

    await expect(provider.classify(input, [], { ...baseConfig, protocol })).resolves.toEqual(result);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(url);
    assertRequest(fetcher.mock.calls[0]?.[1] ?? {});
  });

  it('对已包含的具体 endpoint 只追加一次所选协议路径', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(result) } }],
    }), { status: 200 }));
    const provider = new OpenAICompatibleProvider(fetcher);

    await provider.classify(input, [], { ...baseConfig, baseUrl: `${baseConfig.baseUrl}/chat/completions`, protocol: 'openai-chat-completions' });

    expect(fetcher.mock.calls[0]?.[0]).toBe('https://aiaaa.cc/v1/chat/completions');
  });

  it('测试 AI 使用合成分类并拒绝无效目的文件夹', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        action: 'move', targetFolderId: 'real-user-folder', confidence: 0.9, reason: 'Unknown folder.',
      }) } }],
    }), { status: 200 }));
    const provider = new OpenAICompatibleProvider(fetcher);

    await expect(provider.test({ ...baseConfig, protocol: 'openai-chat-completions' }))
      .rejects.toMatchObject({ name: 'ProviderError', retryable: false });
    const requestBody = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as { messages: Array<{ content: string }> };
    expect(requestBody.messages[1]?.content).toContain('example.test');
    expect(requestBody.messages[1]?.content).toContain('synthetic-folder');
    expect(requestBody.messages[1]?.content).not.toContain('real-user-folder');
  });

  it('合成分类结果通过 Schema 和示例文件夹校验后才允许测试成功', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        action: 'move', targetFolderId: 'synthetic-folder', confidence: 0.9, reason: 'Matches the synthetic folder.',
      }) } }],
    }), { status: 200 }));
    const provider = new OpenAICompatibleProvider(fetcher);

    await expect(provider.test({ ...baseConfig, protocol: 'openai-chat-completions' })).resolves.toBeUndefined();

    const requestBody = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as { messages: Array<{ content: string }> };
    expect(requestBody.messages[1]?.content).toContain('example.test');
    expect(requestBody.messages[1]?.content).toContain('synthetic-folder');
    expect(requestBody.messages[1]?.content).not.toContain('example.com/page');
  });

  it('拒绝不符合分类 Schema 的模型输出', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        action: 'move', targetFolderId: 'bar', confidence: 1.5, reason: 'invalid confidence',
      }) } }],
    }), { status: 200 }));
    const provider = new OpenAICompatibleProvider(fetcher);

    await expect(provider.classify(input, [], { ...baseConfig, protocol: 'openai-chat-completions' })).rejects.toMatchObject({
      name: 'ProviderError',
      retryable: false,
      message: 'AI 分类结果不符合安全格式，书签已保留原位',
    });
  });

  it('将无效 JSON 作为安全失败返回，不透出响应正文', async () => {
    const secretResponse = 'sensitive provider payload';
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      output_text: secretResponse,
    }), { status: 200 }));
    const provider = new OpenAICompatibleProvider(fetcher);

    await expect(provider.classify(input, [], { ...baseConfig, protocol: 'openai-responses' })).rejects.toMatchObject({
      name: 'ProviderError',
      message: 'AI 分类内容不是有效 JSON，书签已保留原位',
    });
  });

  it('API 鉴权失败时只返回安全错误，不透出服务端正文或密钥', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: 'provider echoed test-key and private details',
    }), { status: 401 }));
    const provider = new OpenAICompatibleProvider(fetcher);

    await expect(provider.classify(input, [], { ...baseConfig, protocol: 'anthropic-messages' })).rejects.toMatchObject({
      name: 'ProviderError',
      message: 'API Key 或服务权限无效',
      retryable: false,
    });
  });

  it.each([429, 500])('HTTP %i 时标记为可重试且不透出服务端正文', async (status) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: 'provider echoed test-key and private details',
    }), { status }));
    const provider = new OpenAICompatibleProvider(fetcher);

    await expect(provider.classify(input, [], { ...baseConfig, protocol: 'openai-responses' })).rejects.toMatchObject({
      name: 'ProviderError',
      message: `AI 服务返回错误 (${status})`,
      retryable: true,
    });
  });

  it('网络异常转成安全错误，不保留底层错误中的密钥', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('request failed with test-key'); });
    const provider = new OpenAICompatibleProvider(fetcher);

    await expect(provider.classify(input, [], { ...baseConfig, protocol: 'anthropic-messages' })).rejects.toMatchObject({
      name: 'ProviderError',
      message: '无法连接 AI 服务，书签已保留原位',
      retryable: true,
    });
  });

  it('拒绝超出响应大小上限的 Provider 正文', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('x'.repeat(64 * 1024 + 1), { status: 200 }));
    const provider = new OpenAICompatibleProvider(fetcher);

    await expect(provider.classify(input, [], { ...baseConfig, protocol: 'openai-chat-completions' })).rejects.toMatchObject({
      name: 'ProviderError',
      message: 'AI 响应超过大小限制',
      retryable: false,
    });
  });

  it('将超时作为可重试错误返回', async () => {
    vi.useFakeTimers();
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })) as typeof fetch;
    const provider = new OpenAICompatibleProvider(fetcher);
    const resultPromise = provider.classify(input, [], { ...baseConfig, protocol: 'openai-chat-completions' });
    const rejection = expect(resultPromise).rejects.toMatchObject({
      name: 'ProviderError',
      retryable: true,
      message: 'AI 请求超时，书签已保留原位',
    });

    await vi.advanceTimersByTimeAsync(22_000);

    await rejection;
  });
});
