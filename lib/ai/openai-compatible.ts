import { ClassificationResultSchema, type ClassificationResult, type FolderSummary } from '../../types/domain';
import { buildClassificationMessages, type ClassificationInput } from './prompts';
import { chatCompletionsUrl, type ProviderConfig } from './provider-config';

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 22_000;

export class ProviderError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ClassifierProvider {
  classify(input: ClassificationInput, folders: FolderSummary[], config: ProviderConfig): Promise<ClassificationResult>;
  test(config: ProviderConfig): Promise<void>;
}

export class OpenAICompatibleProvider implements ClassifierProvider {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async classify(
    input: ClassificationInput,
    folders: FolderSummary[],
    config: ProviderConfig,
  ): Promise<ClassificationResult> {
    const payload = await this.request(config, {
      model: config.model,
      messages: buildClassificationMessages(input, folders),
      temperature: 0.1,
      max_tokens: 500,
    });
    const choices = payload.choices;
    if (!Array.isArray(choices)) throw new ProviderError('AI 返回格式不完整', false);
    const content = choices[0]?.message?.content;
    if (typeof content !== 'string' || content.length > 16_000) {
      throw new ProviderError('AI 没有返回可读取的分类内容', false);
    }
    const parsed = parseJsonContent(content);
    const result = ClassificationResultSchema.safeParse(parsed);
    if (!result.success) throw new ProviderError('AI 分类结果不符合安全格式，书签已保留原位', false);
    return result.data;
  }

  async test(config: ProviderConfig): Promise<void> {
    const payload = await this.request(config, {
      model: config.model,
      messages: [
        { role: 'system', content: '只回复 ok。' },
        { role: 'user', content: '连接测试' },
      ],
      max_tokens: 8,
      temperature: 0,
    });
    if (!Array.isArray(payload.choices)) throw new ProviderError('服务已响应，但返回格式不兼容', false);
  }

  private async request(config: ProviderConfig, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!config.apiKey.trim()) throw new ProviderError('请先配置 API Key', false);
    let endpoint: string;
    try {
      endpoint = chatCompletionsUrl(config.baseUrl);
    } catch (error) {
      throw new ProviderError(error instanceof Error ? error.message : 'API 地址无效', false);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await readLimitedText(response, MAX_RESPONSE_BYTES);
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const statusText = response.status === 401 || response.status === 403
          ? 'API Key 或服务权限无效'
          : `AI 服务返回错误 (${response.status})`;
        throw new ProviderError(statusText, retryable);
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ProviderError('AI 服务返回了无效 JSON', false);
      }
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        throw new ProviderError('AI 服务返回结构无效', false);
      }
      return json as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const timedOut = controller.signal.aborted;
      throw new ProviderError(timedOut ? 'AI 请求超时，书签已保留原位' : '无法连接 AI 服务，书签已保留原位', true);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseJsonContent(content: string): unknown {
  const clean = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(clean) as unknown;
  } catch {
    throw new ProviderError('AI 分类内容不是有效 JSON，书签已保留原位', false);
  }
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > limit) throw new ProviderError('AI 响应超过大小限制', false);
  if (!response.body) {
    const text = await response.text();
    if (text.length > limit) throw new ProviderError('AI 响应超过大小限制', false);
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new ProviderError('AI 响应超过大小限制', false);
      }
      output += decoder.decode(value, { stream: true });
    }
    return output + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
