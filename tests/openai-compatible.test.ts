import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '../lib/ai/openai-compatible';
import type { ProviderConfig } from '../lib/ai/provider-config';
import { buildClassificationMessages, type ClassificationInput } from '../lib/ai/prompts';

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

  it('分类提示包含有界目录样例和保守分类规则', () => {
    const messages = buildClassificationMessages(input, [{
      id: 'folder', name: '开发', path: '智能书签 / 开发', samples: [
        { title: 'React', url: 'https://react.dev', hostname: 'react.dev' },
        { title: 'TypeScript', url: 'https://typescriptlang.org', hostname: 'typescriptlang.org' },
      ],
    }]);

    expect(messages[0]?.content).toContain('选择 keep');
    expect(messages[0]?.content).toContain('不要创建文件夹');
    expect(messages[0]?.content).toContain('名称语言与所选父目录下现有子目录名保持一致');
    expect(messages[0]?.content).toContain('泛目录只有在没有任何具体主题目录匹配时才可选');
    expect(messages[1]?.content).toContain('react.dev');
    expect(messages[1]?.content).toContain('samples');
  });

  it('最近用户纠错作为历史决定进入分类提示', () => {
    const messages = buildClassificationMessages(input, [], [
      { domain: 'react.dev', action: 'move', folderPath: '智能书签 / 开发' },
      { domain: 'medium.com', action: 'keep' },
    ]);

    expect(messages[0]?.content).toContain('recentUserDecisions 是用户此前的手动决定');
    expect(messages[1]?.content).toContain('"recentUserDecisions"');
    expect(messages[1]?.content).toContain('react.dev');
  });

  it('批量分类一次请求返回按 index 对齐的结果', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ results: [
        { index: 1, action: 'keep', confidence: 0.4, reason: '第二个保留。' },
        { index: 0, action: 'keep', confidence: 0.5, reason: '第一个保留。' },
      ] }) } }],
    }), { status: 200 }));
    const provider = new OpenAICompatibleProvider(fetcher);
    const inputs = [input, { ...input, url: 'https://example.com/page2' }];

    const results = await provider.classifyBatch(inputs, [], { ...baseConfig, protocol: 'openai-chat-completions' });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ reason: '第一个保留。' });
    expect(results[1]).toMatchObject({ reason: '第二个保留。' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ max_tokens: 4000 });
  });

  it('批量结果缺少 index 时判定可重试失败', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ results: [
        { index: 0, action: 'keep', confidence: 0.4, reason: 'only one' },
      ] }) } }],
    }), { status: 200 }));
    const provider = new OpenAICompatibleProvider(fetcher);

    await expect(provider.classifyBatch([input, input], [], { ...baseConfig, protocol: 'openai-chat-completions' }))
      .rejects.toThrow('AI 批量结果缺少某些书签');
  });

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
          temperature: 0.1,
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
          temperature: 0.1,
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
          temperature: 0.1,
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

  it('为书签元数据发送仅含允许字段的提示，并严格校验有界输出', async () => {
    const metadata = { summary: 'A concise summary', tags: ['docs', 'typescript'] };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(metadata) } }],
    }), { status: 200 }));
    const provider = new OpenAICompatibleProvider(fetcher);

    await expect(provider.generateMetadata!({
      title: 'TypeScript guide', url: 'https://example.com/guide', domain: 'example.com', currentFolder: 'Bookmarks / Dev',
    }, { ...baseConfig, protocol: 'openai-chat-completions' })).resolves.toEqual(metadata);
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as { messages: Array<{ content: string }> };
    expect(body.messages[1]?.content).toContain('TypeScript guide');
    expect(body.messages[1]?.content).toContain('Bookmarks / Dev');
    expect(body.messages[1]?.content).not.toContain('pageContent');

    const invalidProvider = new OpenAICompatibleProvider(vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ ...metadata, debug: 'secret response' }) } }],
    }), { status: 200 })));
    await expect(invalidProvider.generateMetadata!({
      title: 'Title', url: 'https://example.com', domain: 'example.com', currentFolder: 'Bookmarks',
    }, { ...baseConfig, protocol: 'openai-chat-completions' })).rejects.toMatchObject({
      name: 'ProviderError', retryable: false, message: 'AI 摘要标签结果不符合安全格式',
    });
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

  it('服务端声明 endpoint 已迁移时仅显示经过校验的 HTTPS 地址，不自动请求新地址', async () => {
    const migrationUrl = 'https://api.example.test/v1';
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: {
        code: 'ENDPOINT_MIGRATED',
        new_base_url: migrationUrl,
        message: 'private response containing test-key',
      },
    }), { status: 503 }));
    const provider = new OpenAICompatibleProvider(fetcher);

    const error = await provider.classify(input, [], { ...baseConfig, protocol: 'openai-chat-completions' })
      .catch((value: unknown) => value);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://aiaaa.cc/v1/chat/completions');
    expect(error).toMatchObject({
      name: 'ProviderError',
      message: `AI 服务地址已迁移，请将 API 地址改为 ${migrationUrl} 后重新测试；书签已保留原位`,
      retryable: true,
    });
    expect((error as Error).message).not.toContain('test-key');
    expect((error as Error).message).not.toContain('private response');
  });

  it.each([
    'http://api.example.test/v1',
    'https://user:password@api.example.test/v1',
    'https://api.example.test/v1?token=private',
    'https://api.example.test/v1#private',
    undefined,
  ])('迁移地址 %s 不安全或缺失时只提示联系服务提供方', async (migrationUrl) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      code: 'ENDPOINT_MIGRATED',
      new_base_url: migrationUrl,
      message: 'private response containing test-key',
    }), { status: 503 }));
    const provider = new OpenAICompatibleProvider(fetcher);

    const error = await provider.classify(input, [], { ...baseConfig, protocol: 'openai-chat-completions' })
      .catch((value: unknown) => value);

    expect(error).toMatchObject({
      name: 'ProviderError',
      message: 'AI 服务地址已迁移，请联系服务提供方确认新的 API 地址后重试；书签已保留原位',
      retryable: true,
    });
    expect((error as Error).message).not.toContain('private');
    expect((error as Error).message).not.toContain('test-key');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('model_not_found 提示检查模型名称，不透出服务端正文或密钥', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: {
        code: 'model_not_found',
        message: 'model deepseek-flash does not exist; test-key was included',
      },
    }), { status: 404 }));
    const provider = new OpenAICompatibleProvider(fetcher);

    const error = await provider.classify(input, [], { ...baseConfig, protocol: 'openai-chat-completions' })
      .catch((value: unknown) => value);

    expect(error).toMatchObject({
      name: 'ProviderError',
      message: '当前模型不存在，请检查模型名称并选择服务支持的模型',
      retryable: false,
    });
    expect((error as Error).message).not.toContain('deepseek-flash');
    expect((error as Error).message).not.toContain('test-key');
    expect(fetcher).toHaveBeenCalledOnce();
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

  it('用工具调用强制结构化输出，并优先读取 tool_calls 参数', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{
        id: 'call_1', type: 'function', function: { name: 'submit_classification', arguments: JSON.stringify(result) },
      }] } }],
    }), { status: 200 }));
    const provider = new OpenAICompatibleProvider(fetcher);

    const classified = await provider.classify(input, [], { ...baseConfig, protocol: 'openai-chat-completions' });

    expect(classified).toMatchObject(result);
    expect(fetcher).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      tools: Array<{ function: { name: string } }>;
      tool_choice: { function: { name: string } };
    };
    expect(body.tools[0]?.function.name).toBe('submit_classification');
    expect(body.tool_choice.function.name).toBe('submit_classification');
  });

  it('anthropic 协议读取 tool_use 块作为结构化结果', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'submit_metadata', input: { summary: '摘要内容', tags: ['标签'] } }],
    }), { status: 200 }));
    const provider = new OpenAICompatibleProvider(fetcher);

    await expect(provider.generateMetadata(
      { title: 't', url: 'https://example.com', domain: 'example.com', currentFolder: 'bar' },
      { ...baseConfig, protocol: 'anthropic-messages' },
    )).resolves.toEqual({ summary: '摘要内容', tags: ['标签'] });

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      tools: Array<{ name: string; input_schema: Record<string, unknown> }>;
      tool_choice: { type: string; name: string };
    };
    expect(body.tools[0]?.name).toBe('submit_metadata');
    expect(body.tools[0]?.input_schema).toHaveProperty('required');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'submit_metadata' });
  });

  it('网关拒绝 tools 参数时降级为文本模式，并把 system 指令并入 user 消息', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tools?: unknown };
      if (body.tools) return new Response(JSON.stringify({ error: 'tools unsupported' }), { status: 400 });
      return new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
      }), { status: 200 });
    });
    const provider = new OpenAICompatibleProvider(fetcher as typeof fetch);

    await expect(provider.classify(input, [], { ...baseConfig, protocol: 'openai-chat-completions' })).resolves.toMatchObject(result);

    expect(fetcher).toHaveBeenCalledTimes(2);
    const fallbackBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)) as {
      tools?: unknown;
      messages: Array<{ role: string; content: string }>;
    };
    expect(fallbackBody.tools).toBeUndefined();
    expect(fallbackBody.messages[1]?.content).toContain('书签分类器');
  });

  it('网关静默忽略 tools 并返回散文时，降级到文本模式并复用同一个 Provider 能力判断', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tools?: unknown };
      const content = body.tools ? '你发来的是一条书签数据，需要我做什么？' : JSON.stringify(result);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status: 200 });
    });
    const provider = new OpenAICompatibleProvider(fetcher as typeof fetch);
    const config = { ...baseConfig, protocol: 'openai-chat-completions' as const };

    await expect(provider.classify(input, [], config)).resolves.toMatchObject(result);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await expect(provider.classify(input, [], config)).resolves.toMatchObject(result);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const thirdBody = JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body)) as { tools?: unknown };
    expect(thirdBody.tools).toBeUndefined();
  });

  it('响应被 max_tokens 截断时给出可重试的独立错误', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { content: '{"action":"keep","confidence":0.9,"rea' } }],
    }), { status: 200 }));
    const provider = new OpenAICompatibleProvider(fetcher);

    await expect(provider.classify(input, [], { ...baseConfig, protocol: 'openai-chat-completions' })).rejects.toMatchObject({
      name: 'ProviderError',
      message: 'AI 响应被截断，请重试或减少书签数量',
      retryable: true,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
