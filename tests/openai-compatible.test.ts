import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '../lib/ai/openai-compatible';
import { ChromeStateRepository, type LocalStorageArea } from '../lib/storage/repository';
import { ClassificationService, PermissionRequiredError } from '../services/classifier.service';
import { DEFAULT_SETTINGS } from '../types/domain';
import type { ProviderConfig } from '../lib/ai/provider-config';
import { buildBatchMessages, buildClassificationMessages, type ClassificationInput } from '../lib/ai/prompts';

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
    const batch = buildBatchMessages([input, { ...input, url: 'https://example.com/other' }], []);
    expect(batch[0]?.content).toContain('每条书签独立判断');
    expect(batch[0]?.content).not.toContain('同一批中主题相近的书签应归入同一目录');
  });

  it('最近用户纠错作为历史决定进入分类提示', () => {
    const messages = buildClassificationMessages(input, [], [
      { domain: 'react.dev', url: 'https://react.dev/learn', action: 'move', folderPath: '智能书签 / 开发' },
      { domain: 'medium.com', action: 'keep' },
    ]);

    expect(messages[0]?.content).toContain('不能推广到整个域名');
    expect(messages[1]?.content).toContain('https://react.dev/learn');
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
    expect(results[0]).not.toHaveProperty('index');
    expect(results[1]).not.toHaveProperty('index');
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

  it('does not cache any member when the real provider returns duplicate indexes', async () => {
    const values: Record<string, unknown> = {};
    const repository = new ChromeStateRepository({
      get: async (key) => ({ [key]: values[key] }),
      set: async (items) => { Object.assign(values, structuredClone(items)); },
    });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results: [
      { index: 0, ...result }, { index: 0, ...result },
    ] }) } }] }), { status: 200 }));
    const service = new ClassificationService(new OpenAICompatibleProvider(fetcher), repository);
    await expect(service.classifyBatch([input, { ...input, url: 'https://example.com/other' }], [], { ...DEFAULT_SETTINGS, apiKey: 'test-key' }, true))
      .rejects.toThrow('AI 批量结果 index 不完整或重复');
    expect((await repository.load()).cache).toEqual({});
    expect(fetcher).toHaveBeenCalledOnce();
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

    // 先试“工具 + 关闭思考”，再试“工具”，最后才降级为纯文本。
    expect(fetcher).toHaveBeenCalledTimes(3);
    const toolsOnlyBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)) as { tools?: unknown; reasoning_effort?: string };
    expect(toolsOnlyBody.tools).toBeDefined();
    expect(toolsOnlyBody.reasoning_effort).toBeUndefined();

    const fallbackBody = JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body)) as {
      tools?: unknown;
      messages: Array<{ role: string; content: string }>;
    };
    expect(fallbackBody.tools).toBeUndefined();
    expect(fallbackBody.messages[1]?.content).toContain('书签分类器');
  });

  it('分类请求默认关闭思维链', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
    }), { status: 200 }));
    const provider = new OpenAICompatibleProvider(fetcher);

    await provider.classify(input, [], { ...baseConfig, protocol: 'openai-chat-completions' });

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ reasoning_effort: 'none' });
  });

  it('网关不接受关闭思维链参数时保留工具调用并记住该限制', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { reasoning_effort?: string };
      if (body.reasoning_effort) return new Response(JSON.stringify({ error: 'unknown field reasoning_effort' }), { status: 400 });
      return new Response(JSON.stringify({
        choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{
          id: 'call_1', type: 'function', function: { name: 'submit_classification', arguments: JSON.stringify(result) },
        }] } }],
      }), { status: 200 });
    });
    const provider = new OpenAICompatibleProvider(fetcher as typeof fetch);
    const config = { ...baseConfig, protocol: 'openai-chat-completions' as const };

    await expect(provider.classify(input, [], config)).resolves.toMatchObject(result);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await expect(provider.classify(input, [], config)).resolves.toMatchObject(result);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).not.toHaveProperty('reasoning_effort');
  });

  it('工具描述承载“不读正文、必须调用工具”约束，避免网关丢弃 system 时模型反问', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
    }), { status: 200 }));
    const provider = new OpenAICompatibleProvider(fetcher);

    await provider.classify(input, [], { ...baseConfig, protocol: 'openai-chat-completions' });

    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      tools: Array<{ function: { description: string } }>;
    };
    expect(body.tools[0]?.function.description).toContain('不要声称读取网页正文');
    expect(body.tools[0]?.function.description).toContain('必须调用本工具');
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

  it('default and fallback request variants only reuse proven matches across worker restarts', async () => {
    const values: Record<string, unknown> = {};
    const storage: LocalStorageArea = {
      get: async (key) => ({ [key]: values[key] }),
      set: async (items) => { Object.assign(values, structuredClone(items)); },
    };
    const response = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), { status: 200 });
    const settings = { ...DEFAULT_SETTINGS, apiKey: 'test-key', baseUrl: baseConfig.baseUrl, model: baseConfig.model };
    const candidates = [{ id: 'bar', name: 'Bookmarks bar', path: 'Bookmarks bar' }];
    let providerCalls = 0;
    const normalFetch = vi.fn<typeof fetch>(async () => response());
    const repository = new ChromeStateRepository(storage);
    await repository.update((state) => { state.settings = settings; });
    const firstProvider = new OpenAICompatibleProvider(normalFetch);
    const original = firstProvider.classify.bind(firstProvider);
    firstProvider.classify = async (...args) => { providerCalls += 1; return original(...args); };
    const service = new ClassificationService(firstProvider, repository);
    expect((await service.classify(input, candidates, settings, true)).source).toBe('ai');
    expect((await service.classify(input, candidates, settings, false)).source).toBe('cache');
    const restarted = new ClassificationService(new OpenAICompatibleProvider(normalFetch), new ChromeStateRepository(storage));
    expect((await restarted.classify(input, candidates, settings, false)).source).toBe('cache');
    expect(providerCalls).toBe(1);
    expect(normalFetch).toHaveBeenCalledTimes(1);

    const fallbackValues: Record<string, unknown> = {};
    const fallbackStorage: LocalStorageArea = {
      get: async (key) => ({ [key]: fallbackValues[key] }),
      set: async (items) => { Object.assign(fallbackValues, structuredClone(items)); },
    };
    const fallbackFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { tools?: unknown };
      return body.tools ? new Response('{}', { status: 400 }) : response();
    });
    const fallbackRepo = new ChromeStateRepository(fallbackStorage);
    await fallbackRepo.update((state) => { state.settings = settings; });
    let fallbackProviderCalls = 0;
    const fallbackProvider = new OpenAICompatibleProvider(fallbackFetch);
    const fallbackClassify = fallbackProvider.classify.bind(fallbackProvider);
    fallbackProvider.classify = async (...args) => { fallbackProviderCalls += 1; return fallbackClassify(...args); };
    const fallbackService = new ClassificationService(fallbackProvider, fallbackRepo);
    expect((await fallbackService.classify(input, candidates, settings, true)).source).toBe('ai');
    expect(fallbackFetch).toHaveBeenCalledTimes(3);
    expect((await fallbackService.classify(input, candidates, settings, true)).source).toBe('ai');
    expect((await fallbackService.classify(input, candidates, settings, false)).source).toBe('cache');
    expect(fallbackProviderCalls).toBe(2);
    expect(fallbackFetch).toHaveBeenCalledTimes(4);
    const fallbackRestarted = new ClassificationService(new OpenAICompatibleProvider(fallbackFetch), new ChromeStateRepository(fallbackStorage));
    await expect(fallbackRestarted.classify(input, candidates, settings, false)).rejects.toThrow('网络权限');
    expect((await fallbackRestarted.classify(input, candidates, settings, true)).source).toBe('ai');
    expect(fallbackFetch).toHaveBeenCalledTimes(7);
  });

  it.each(['single', 'batch'] as const)('rejects a stale %s cache hit when a concurrent real provider call changes the expected variant during signing', async (mode) => {
    const values: Record<string, unknown> = {};
    const storage: LocalStorageArea = { get: async (key) => ({ [key]: values[key] }), set: async (items) => { Object.assign(values, structuredClone(items)); } };
    let rejectTools = false;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { tools?: unknown; max_tokens?: number };
      if (rejectTools && body.tools) return new Response('{}', { status: 400 });
      const data = body.max_tokens === 4000 ? { results: [{ index: 0, ...result }, { index: 1, ...result }] } : result;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }] }), { status: 200 });
    });
    const provider = new OpenAICompatibleProvider(fetcher);
    const repository = new ChromeStateRepository(storage);
    const service = new ClassificationService(provider, repository);
    const settings = { ...DEFAULT_SETTINGS, apiKey: 'test-key', baseUrl: baseConfig.baseUrl, model: baseConfig.model };
    const candidates = [{ id: 'bar', name: 'Bookmarks bar', path: 'Bookmarks bar' }];
    const inputs = [input, { ...input, url: 'https://example.com/other' }];
    const config = { ...baseConfig, protocol: 'openai-chat-completions' as const };
    const classify = (permission: boolean) => mode === 'single'
      ? service.classify(input, candidates, settings, permission)
      : service.classifyBatch(inputs, candidates, settings, permission);
    await repository.update((state) => { state.settings = settings; });
    await classify(true);
    expect(fetcher).toHaveBeenCalledTimes(1);

    const subtle = globalThis.crypto.subtle;
    const originalSign = subtle.sign.bind(subtle);
    let enterSign!: () => void;
    let releaseSign!: () => void;
    const entered = new Promise<void>((resolve) => { enterSign = resolve; });
    const released = new Promise<void>((resolve) => { releaseSign = resolve; });
    const sign = vi.spyOn(subtle, 'sign').mockImplementationOnce(async (...args) => {
      enterSign();
      await released;
      return originalSign(...args);
    });
    try {
      const pending = classify(false);
      const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
      await entered;
      rejectTools = true;
      await provider.classify({ ...input, url: 'https://other.example/change' }, candidates, config);
      expect(fetcher).toHaveBeenCalledTimes(4);
      releaseSign();
      expect(await outcome).toEqual({ error: expect.any(PermissionRequiredError) });
      expect(fetcher).toHaveBeenCalledTimes(4);
      const after = await classify(true);
      if (Array.isArray(after)) {
        expect(after.map((item) => 'result' in item && item.result.source)).toEqual(['ai', 'ai']);
      } else {
        expect(after.source).toBe('ai');
      }
      const requestBody = JSON.parse(String(fetcher.mock.calls[4]?.[1]?.body)) as { tools?: unknown; max_tokens?: number };
      expect(requestBody.tools).toBeUndefined();
      expect(requestBody.max_tokens).toBe(mode === 'single' ? 500 : 4000);
      expect(fetcher).toHaveBeenCalledTimes(5);
    } finally {
      releaseSign();
      sign.mockRestore();
    }
  });

  it.each([
    { mode: 'single' as const, oldCached: true, permission: false },
    { mode: 'single' as const, oldCached: false, permission: false },
    { mode: 'single' as const, oldCached: true, permission: true },
    { mode: 'batch' as const, oldCached: true, permission: false },
    { mode: 'batch' as const, oldCached: false, permission: false },
    { mode: 'batch' as const, oldCached: true, permission: true },
  ])('rechecks the new $mode variant cache after a concurrent downgrade (oldCached=$oldCached, permission=$permission)', async ({ mode, oldCached, permission }) => {
    const values: Record<string, unknown> = {};
    const storage: LocalStorageArea = { get: async (key) => ({ [key]: values[key] }), set: async (items) => { Object.assign(values, structuredClone(items)); } };
    let rejectTools = false;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { tools?: unknown; max_tokens?: number };
      if (rejectTools && body.tools) return new Response('{}', { status: 400 });
      const response = { ...result, reason: body.tools ? 'default variant' : 'fallback variant' };
      const data = body.max_tokens === 4000 ? { results: [{ index: 0, ...response }, { index: 1, ...response }] } : response;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }] }), { status: 200 });
    });
    const repository = new ChromeStateRepository(storage);
    const provider = new OpenAICompatibleProvider(fetcher);
    const fallbackProvider = new OpenAICompatibleProvider(fetcher);
    const service = new ClassificationService(provider, repository);
    const fallbackService = new ClassificationService(fallbackProvider, repository);
    const settings = { ...DEFAULT_SETTINGS, apiKey: 'test-key', baseUrl: baseConfig.baseUrl, model: baseConfig.model };
    const candidates = [{ id: 'bar', name: 'Bookmarks bar', path: 'Bookmarks bar' }];
    const inputs = [input, { ...input, url: 'https://example.com/other' }];
    const config = { ...baseConfig, protocol: 'openai-chat-completions' as const };
    const classify = (target: ClassificationService, hasPermission: boolean) => mode === 'single'
      ? target.classify(input, candidates, settings, hasPermission)
      : target.classifyBatch(inputs, candidates, settings, hasPermission);
    await repository.update((state) => { state.settings = settings; });
    if (oldCached) await classify(service, true);
    rejectTools = true;
    await fallbackProvider.classify({ ...input, url: 'https://other.example/prepare' }, candidates, config);
    await classify(fallbackService, true);
    expect(Object.keys((await repository.load()).cache)).toHaveLength((oldCached ? 2 : 1) * (mode === 'batch' ? 3 : 1));

    const subtle = globalThis.crypto.subtle;
    const originalSign = subtle.sign.bind(subtle);
    let enterSign!: () => void;
    let releaseSign!: () => void;
    const entered = new Promise<void>((resolve) => { enterSign = resolve; });
    const released = new Promise<void>((resolve) => { releaseSign = resolve; });
    const sign = vi.spyOn(subtle, 'sign').mockImplementationOnce(async (...args) => {
      enterSign();
      await released;
      return originalSign(...args);
    });
    try {
      const pending = classify(service, permission);
      const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
      await entered;
      await provider.classify({ ...input, url: 'https://other.example/change' }, candidates, config);
      const callsAfterDowngrade = fetcher.mock.calls.length;
      releaseSign();
      const settled = await outcome;
      expect(settled).toHaveProperty('value');
      if ('value' in settled && Array.isArray(settled.value)) {
        expect(settled.value.map((item) => 'result' in item && [item.result.source, item.result.result.reason]))
          .toEqual([['cache', 'fallback variant'], ['cache', 'fallback variant']]);
      } else if ('value' in settled) {
        expect(settled.value).toMatchObject({ source: 'cache', result: { reason: 'fallback variant' } });
      }
      expect(sign).toHaveBeenCalledTimes(mode === 'single' ? 2 : 3);
      expect(fetcher).toHaveBeenCalledTimes(callsAfterDowngrade);
    } finally {
      releaseSign();
      sign.mockRestore();
    }
  });

  it('invalidates a paused cache hit when another request only disables reasoning', async () => {
    const values: Record<string, unknown> = {};
    const storage: LocalStorageArea = { get: async (key) => ({ [key]: values[key] }), set: async (items) => { Object.assign(values, structuredClone(items)); } };
    let rejectReasoning = false;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { reasoning_effort?: string };
      if (rejectReasoning && body.reasoning_effort) return new Response('{}', { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), { status: 200 });
    });
    const provider = new OpenAICompatibleProvider(fetcher);
    const repository = new ChromeStateRepository(storage);
    const settings = { ...DEFAULT_SETTINGS, apiKey: 'test-key', baseUrl: baseConfig.baseUrl, model: baseConfig.model };
    const candidates = [{ id: 'bar', name: 'Bookmarks bar', path: 'Bookmarks bar' }];
    const service = new ClassificationService(provider, repository);
    await repository.update((state) => { state.settings = settings; });
    await service.classify(input, candidates, settings, true);
    const subtle = globalThis.crypto.subtle;
    const originalSign = subtle.sign.bind(subtle);
    let enterSign!: () => void;
    let releaseSign!: () => void;
    const entered = new Promise<void>((resolve) => { enterSign = resolve; });
    const released = new Promise<void>((resolve) => { releaseSign = resolve; });
    const sign = vi.spyOn(subtle, 'sign').mockImplementationOnce(async (...args) => {
      enterSign();
      await released;
      return originalSign(...args);
    });
    try {
      const pending = service.classify(input, candidates, settings, false);
      const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
      await entered;
      rejectReasoning = true;
      await provider.classify({ ...input, url: 'https://other.example/change' }, candidates, { ...baseConfig, protocol: 'openai-chat-completions' });
      expect(fetcher).toHaveBeenCalledTimes(3);
      releaseSign();
      expect(await outcome).toEqual({ error: expect.any(PermissionRequiredError) });
      expect((await service.classify(input, candidates, settings, true)).source).toBe('ai');
      const body = JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body)) as { tools?: unknown; reasoning_effort?: string };
      expect(body.tools).toBeDefined();
      expect(body.reasoning_effort).toBeUndefined();
    } finally {
      releaseSign();
      sign.mockRestore();
    }
  });

  it.each(['single', 'batch'] as const)('validates the transient %s cache variant after a real provider fallback', async (mode) => {
    const values: Record<string, unknown> = {};
    const storage: LocalStorageArea = { get: async (key) => ({ [key]: values[key] }), set: async (items) => { Object.assign(values, structuredClone(items)); } };
    let rejectTools = false;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { tools?: unknown; max_tokens?: number };
      if (rejectTools && body.tools) return new Response('{}', { status: 400 });
      const data = body.max_tokens === 4000 ? { results: [{ index: 0, ...result }, { index: 1, ...result }] } : result;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }] }), { status: 200 });
    });
    const provider = new OpenAICompatibleProvider(fetcher);
    const repo = new ChromeStateRepository(storage);
    const service = new ClassificationService(provider, repo);
    const settings = { ...DEFAULT_SETTINGS, apiKey: 'test-key', baseUrl: baseConfig.baseUrl, model: baseConfig.model };
    const candidates = [{ id: 'bar', name: 'Bookmarks bar', path: 'Bookmarks bar' }];
    const inputs = [input, { ...input, url: 'https://example.com/other' }];
    await repo.update((state) => { state.settings = settings; });
    const classify = (permission: boolean) => mode === 'single'
      ? service.classify(input, candidates, settings, permission)
      : service.classifyBatch(inputs, candidates, settings, permission);
    const fresh = await classify(true);
    const warm = await classify(false);
    const cached = Array.isArray(warm)
      ? warm.map((item) => 'result' in item ? item.result : undefined)
      : [warm];
    expect(cached.every((item) => item?.source === 'cache' && item.cacheValidation?.() === true)).toBe(true);
    if (cached.length > 1) expect(cached[0]?.cacheValidation).toBe(cached[1]?.cacheValidation);
    if (Array.isArray(fresh)) {
      expect(fresh.every((item) => 'result' in item && item.result.source === 'ai' && !item.result.cacheValidation)).toBe(true);
    } else {
      expect(fresh.source).toBe('ai');
      expect(fresh.cacheValidation).toBeUndefined();
    }
    expect(JSON.stringify(warm)).not.toContain('test-key');
    expect(JSON.stringify(warm)).not.toContain(input.url);
    expect(JSON.stringify(await repo.load())).not.toContain('cacheValidation');
    rejectTools = true;
    await provider.classify({ ...input, url: 'https://other.example/change' }, candidates, { ...baseConfig, protocol: 'openai-chat-completions' });
    expect(cached.every((item) => item?.cacheValidation?.() === false)).toBe(true);
  });

  it('keeps a cached token stable for an equivalent same-shape concurrent fallback', async () => {
    const values: Record<string, unknown> = {};
    const storage: LocalStorageArea = { get: async (key) => ({ [key]: values[key] }), set: async (items) => { Object.assign(values, structuredClone(items)); } };
    let releaseReject!: () => void;
    const rejected = new Promise<void>((resolve) => { releaseReject = resolve; });
    let enterReject!: () => void;
    const entered = new Promise<void>((resolve) => { enterReject = resolve; });
    let waiting = false;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { tools?: unknown };
      if (body.tools && !waiting) {
        waiting = true;
        enterReject();
        await rejected;
        return new Response('{}', { status: 400 });
      }
      if (body.tools) return new Response('{}', { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), { status: 200 });
    });
    const provider = new OpenAICompatibleProvider(fetcher);
    const config = { ...baseConfig, protocol: 'openai-chat-completions' as const };
    const candidates = [{ id: 'bar', name: 'Bookmarks bar', path: 'Bookmarks bar' }];
    const slow = provider.classify({ ...input, url: 'https://slow.example/' }, candidates, config);
    try {
      await entered;
      await provider.classify({ ...input, url: 'https://fast.example/' }, candidates, config);
      expect(provider.getCacheVariant()).toBe(2);
      const repo = new ChromeStateRepository(storage);
      const settings = { ...DEFAULT_SETTINGS, ...config };
      await repo.update((state) => { state.settings = settings; });
      const service = new ClassificationService(provider, repo);
      await service.classify(input, candidates, settings, true);
      const cached = await service.classify(input, candidates, settings, false);
      expect(cached.cacheValidation?.()).toBe(true);
      releaseReject();
      await slow;
      expect(provider.getCacheVariant()).toBe(2);
      expect(cached.cacheValidation?.()).toBe(true);
    } finally {
      releaseReject();
      await slow;
    }
  });

  it('real batch fallback warm cache is reused after restart only after the variant is re-established', async () => {
    const values: Record<string, unknown> = {};
    const storage: LocalStorageArea = { get: async (key) => ({ [key]: values[key] }), set: async (items) => { Object.assign(values, structuredClone(items)); } };
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { tools?: unknown; max_tokens?: number };
      if (body.tools) return new Response('{}', { status: 400 });
      const data = body.max_tokens === 4000 ? { results: [{ index: 0, ...result }, { index: 1, ...result }] } : result;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }] }), { status: 200 });
    });
    const repo = new ChromeStateRepository(storage);
    const settings = { ...DEFAULT_SETTINGS, apiKey: 'test-key', baseUrl: baseConfig.baseUrl, model: baseConfig.model };
    const candidates = [{ id: 'bar', name: 'Bookmarks bar', path: 'Bookmarks bar' }];
    const inputs = [input, { ...input, url: 'https://example.com/other' }];
    await repo.update((state) => { state.settings = settings; });
    const provider = new OpenAICompatibleProvider(fetcher);
    const classifyBatch = vi.spyOn(provider, 'classifyBatch');
    const service = new ClassificationService(provider, repo);
    expect((await service.classifyBatch(inputs, candidates, settings, true)).every((item) => 'result' in item && item.result.source === 'ai')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect((await service.classifyBatch(inputs, candidates, settings, true)).every((item) => 'result' in item && item.result.source === 'ai')).toBe(true);
    expect((await service.classifyBatch(inputs, candidates, settings, false)).every((item) => 'result' in item && item.result.source === 'cache' && item.result.cacheValidation?.())).toBe(true);
    expect(classifyBatch).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledTimes(4);
    const restartedProvider = new OpenAICompatibleProvider(fetcher);
    const restartedBatch = vi.spyOn(restartedProvider, 'classifyBatch');
    const restarted = new ClassificationService(restartedProvider, new ChromeStateRepository(storage));
    await expect(restarted.classifyBatch(inputs, candidates, settings, false)).rejects.toBeInstanceOf(PermissionRequiredError);
    expect(restartedBatch).not.toHaveBeenCalled();
    expect((await restarted.classifyBatch(inputs, candidates, settings, true)).every((item) => 'result' in item && item.result.source === 'ai')).toBe(true);
    expect(restartedBatch).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(7);
    expect((await restarted.classifyBatch(inputs, candidates, settings, false)).every((item) => 'result' in item && item.result.source === 'cache' && item.result.cacheValidation?.())).toBe(true);
    expect(restartedBatch).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(7);
  });

  it('batch transport index is removed before caching strict real provider results', async () => {
    const values: Record<string, unknown> = {};
    const storage: LocalStorageArea = { get: async (key) => ({ [key]: values[key] }), set: async (items) => { Object.assign(values, structuredClone(items)); } };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results: [
      { index: 1, ...result }, { index: 0, ...result },
    ] }) } }] }), { status: 200 }));
    const service = new ClassificationService(new OpenAICompatibleProvider(fetcher), new ChromeStateRepository(storage));
    const settings = { ...DEFAULT_SETTINGS, apiKey: 'test-key' };
    const candidates = [{ id: 'bar', name: 'Bookmarks bar', path: 'Bookmarks bar' }];
    const inputs = [input, { ...input, url: 'https://example.com/other' }];
    const first = await service.classifyBatch(inputs, candidates, settings, true);
    const second = await service.classifyBatch(inputs, candidates, settings, false);
    expect(first.map((outcome) => 'result' in outcome && outcome.result.source)).toEqual(['ai', 'ai']);
    expect(second.map((outcome) => 'result' in outcome && outcome.result.source)).toEqual(['cache', 'cache']);
    expect(fetcher).toHaveBeenCalledOnce();
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
