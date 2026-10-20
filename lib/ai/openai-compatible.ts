import { ClassificationResultSchema, SummaryTagResultSchema, type ClassificationResult, type FolderSummary, type SummaryTagResult } from '../../types/domain';
import { buildClassificationMessages, buildMetadataMessages, type BookmarkMetadataInput, type ClassificationInput, type RecentCorrection } from './prompts';
import { normalizeBaseUrl, providerUrl, type ProviderConfig } from './provider-config';

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CLASSIFICATION_TEXT_LENGTH = 16_000;
const REQUEST_TIMEOUT_MS = 22_000;

export class ProviderError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ClassifierProvider {
  classify(input: ClassificationInput, folders: FolderSummary[], config: ProviderConfig, recentCorrections?: RecentCorrection[]): Promise<ClassificationResult>;
  generateMetadata?(input: BookmarkMetadataInput, config: ProviderConfig): Promise<SummaryTagResult>;
  test(config: ProviderConfig): Promise<void>;
}

/**
 * Keeps the classifier boundary stable while adapting the three supported
 * non-streaming JSON APIs to the same prompt and strict result schema.
 */
export class OpenAICompatibleProvider implements ClassifierProvider {
  constructor(private readonly fetcher: typeof fetch = fetch.bind(globalThis)) {}

  async classify(
    input: ClassificationInput,
    folders: FolderSummary[],
    config: ProviderConfig,
    recentCorrections?: RecentCorrection[],
  ): Promise<ClassificationResult> {
    const messages = buildClassificationMessages(input, folders, recentCorrections);
    const payload = await this.request(config, buildRequestBody(config, messages));
    const content = extractClassificationText(payload, config.protocol);
    const parsed = parseJsonContent(content);
    const result = ClassificationResultSchema.safeParse(parsed);
    if (!result.success) throw new ProviderError('AI 分类结果不符合安全格式，书签已保留原位', false);
    return result.data;
  }

  async generateMetadata(input: BookmarkMetadataInput, config: ProviderConfig): Promise<SummaryTagResult> {
    const payload = await this.request(config, buildRequestBody(config, buildMetadataMessages(input)));
    const parsed = parseJsonContent(extractClassificationText(payload, config.protocol));
    const result = SummaryTagResultSchema.safeParse(parsed);
    if (!result.success) throw new ProviderError('AI 摘要标签结果不符合安全格式', false);
    return result.data;
  }

  async test(config: ProviderConfig): Promise<void> {
    const folders: FolderSummary[] = [{
      id: 'synthetic-folder',
      name: 'Synthetic folder',
      path: 'Synthetic folder',
    }];
    const input: ClassificationInput = {
      title: 'Synthetic developer documentation bookmark',
      url: 'https://example.test/docs',
      domain: 'example.test',
      currentFolder: 'Unsorted bookmarks',
      currentFolderId: 'synthetic-source',
    };
    const result = await this.classify(input, folders, config);
    const referencesSyntheticFolder = result.action === 'move'
      ? result.targetFolderId === folders[0]?.id
      : result.action === 'suggest_folder'
        ? result.suggestedFolder.parentId === folders[0]?.id
        : true;
    if (!referencesSyntheticFolder) {
      throw new ProviderError('AI 测试结果引用了无效的示例文件夹', false);
    }
  }

  private async request(config: ProviderConfig, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!config.apiKey.trim()) throw new ProviderError('请先配置 API Key', false);
    let endpoint: string;
    try {
      endpoint = providerUrl(config.baseUrl, config.protocol);
    } catch (error) {
      throw new ProviderError(error instanceof Error ? error.message : 'API 地址无效', false);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(endpoint, {
        method: 'POST',
        headers: requestHeaders(config),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await readLimitedText(response, MAX_RESPONSE_BYTES);
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const providerError = parseProviderError(text);
        const statusText = response.status === 401 || response.status === 403
          ? 'API Key 或服务权限无效'
          : providerError?.code === 'ENDPOINT_MIGRATED'
            ? migrationMessage(providerError.newBaseUrl)
            : providerError?.code === 'model_not_found'
              ? '当前模型不存在，请检查模型名称并选择服务支持的模型'
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

interface RecognizedProviderError {
  code?: string;
  newBaseUrl?: string;
}

function parseProviderError(text: string): RecognizedProviderError | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;

  const root = payload as Record<string, unknown>;
  const error = root.error && typeof root.error === 'object' && !Array.isArray(root.error)
    ? root.error as Record<string, unknown>
    : root;
  return {
    code: typeof error.code === 'string' ? error.code : undefined,
    newBaseUrl: typeof error.new_base_url === 'string' ? error.new_base_url : undefined,
  };
}

function migrationMessage(rawBaseUrl?: string): string {
  const safeBaseUrl = validateMigrationBaseUrl(rawBaseUrl);
  return safeBaseUrl
    ? `AI 服务地址已迁移，请将 API 地址改为 ${safeBaseUrl} 后重新测试；书签已保留原位`
    : 'AI 服务地址已迁移，请联系服务提供方确认新的 API 地址后重试；书签已保留原位';
}

function validateMigrationBaseUrl(rawBaseUrl?: string): string | undefined {
  if (!rawBaseUrl) return undefined;
  try {
    const url = new URL(rawBaseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return undefined;
    return normalizeBaseUrl(rawBaseUrl);
  } catch {
    return undefined;
  }
}

type ClassificationMessage = { role: 'system' | 'user'; content: string };

function buildRequestBody(config: ProviderConfig, messages: ClassificationMessage[]): Record<string, unknown> {
  if (config.protocol === 'anthropic-messages') {
    return {
      model: config.model,
      max_tokens: 500,
      temperature: 0.1,
      system: messages[0]?.content ?? '',
      messages: [{ role: 'user', content: messages[1]?.content ?? '' }],
    };
  }
  if (config.protocol === 'openai-responses') {
    return {
      model: config.model,
      instructions: messages[0]?.content ?? '',
      input: messages[1]?.content ?? '',
      max_output_tokens: 500,
      temperature: 0.1,
    };
  }
  return {
    model: config.model,
    messages,
    temperature: 0.1,
    max_tokens: 500,
  };
}

function requestHeaders(config: ProviderConfig): Record<string, string> {
  const common = { 'Content-Type': 'application/json' };
  if (config.protocol === 'anthropic-messages') {
    return {
      ...common,
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  return { ...common, Authorization: `Bearer ${config.apiKey}` };
}

function extractClassificationText(payload: Record<string, unknown>, protocol: ProviderConfig['protocol']): string {
  let content: unknown;
  if (protocol === 'anthropic-messages') {
    content = textFromBlocks(payload.content, 'text');
  } else if (protocol === 'openai-responses') {
    content = typeof payload.output_text === 'string'
      ? payload.output_text
      : responseOutputText(payload.output);
  } else {
    const choices = payload.choices;
    const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
    const message = firstChoice && typeof firstChoice === 'object' ? firstChoice.message : undefined;
    content = typeof message === 'object' && message !== null
      ? (message as Record<string, unknown>).content
      : undefined;
    if (Array.isArray(content)) content = textFromBlocks(content, 'text');
  }

  if (typeof content !== 'string' || content.length > MAX_CLASSIFICATION_TEXT_LENGTH) {
    throw new ProviderError('AI 没有返回可读取的分类内容', false);
  }
  return content;
}

function responseOutputText(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record.type !== 'message' || record.role !== 'assistant') continue;
    const text = textFromBlocks(record.content, 'output_text');
    if (typeof text === 'string') parts.push(text);
  }
  return parts.length ? parts.join('') : undefined;
}

function textFromBlocks(value: unknown, acceptedType: string): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const block of value) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (record.type === acceptedType && typeof record.text === 'string') parts.push(record.text);
  }
  return parts.length ? parts.join('') : undefined;
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
