import { z } from 'zod';
import { ClassificationResultSchema, SummaryTagResultSchema, type ClassificationResult, type FolderSummary, type SummaryTagResult } from '../../types/domain';
import { buildBatchMessages, buildClassificationMessages, buildMetadataMessages, type BookmarkMetadataInput, type ClassificationInput, type RecentCorrection } from './prompts';
import { normalizeBaseUrl, providerUrl, type ProviderConfig } from './provider-config';

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CLASSIFICATION_TEXT_LENGTH = 16_000;
const REQUEST_TIMEOUT_MS = 22_000;

export class ProviderError extends Error {
  constructor(message: string, readonly retryable = false, readonly status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

const BatchResultSchema = z.object({
  results: z.array(z.unknown()),
}).strict();

/**
 * 结构化输出的第一层：把结果形状写进工具的 JSON Schema。
 * 网关即使丢弃 system 消息或忽略 response_format，也必须按工具参数回填。
 */
interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

const classificationProperties = {
  action: { type: 'string', enum: ['move', 'suggest_folder', 'keep'] },
  targetFolderId: { type: 'string', minLength: 1 },
  suggestedFolder: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'parentId'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 64 },
      parentId: { type: 'string', minLength: 1 },
    },
  },
  confidence: { type: 'number', minimum: 0, maximum: 1 },
  reason: { type: 'string', minLength: 1, maxLength: 500 },
} as const;

const CLASSIFICATION_TOOL: ToolSpec = {
  name: 'submit_classification',
  description: '提交一个书签的分类建议。只能基于标题、URL、域名、当前文件夹和样例判断，不要声称读取网页正文，也不要向用户反问或索要内容。必须调用本工具返回结果，不要用自然语言回答。只能引用输入清单中真实存在的文件夹 ID。action=move 时给 targetFolderId；action=suggest_folder 时给 suggestedFolder；action=keep 时不移动。',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'confidence', 'reason'],
    properties: classificationProperties,
  },
};

const BATCH_TOOL: ToolSpec = {
  name: 'submit_classifications',
  description: '提交整批书签的分类建议。只能基于标题、URL、域名、当前文件夹和样例判断，不要声称读取网页正文，也不要向用户反问或索要内容。必须调用本工具返回结果，不要用自然语言回答。只能引用输入清单中真实存在的文件夹 ID。每一条书签恰好一个结果，index 与输入一致。',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'action', 'confidence', 'reason'],
          properties: {
            index: { type: 'integer', minimum: 0 },
            ...classificationProperties,
          },
        },
      },
    },
  },
};

const METADATA_TOOL: ToolSpec = {
  name: 'submit_metadata',
  description: '提交书签摘要与标签。只能基于标题、URL、域名和当前文件夹推断，不要声称读取网页正文，也不要访问链接，更不要向用户反问或索要内容。必须调用本工具返回结果，不要用自然语言回答。摘要不超过500字，标签最多8个且每个不超过32字。',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'tags'],
    properties: {
      summary: { type: 'string', minLength: 1, maxLength: 500 },
      tags: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 32 } },
    },
  },
};

export interface ClassifierProvider {
  getCacheRequest?(mode: 'single' | 'batch', inputs: ClassificationInput[], folders: FolderSummary[], config: ProviderConfig, recentCorrections?: RecentCorrection[]): Record<string, unknown> | undefined;
  getCacheVariant?(): number | undefined;
  classify(input: ClassificationInput, folders: FolderSummary[], config: ProviderConfig, recentCorrections?: RecentCorrection[], onRequest?: (body: Record<string, unknown>) => void): Promise<ClassificationResult>;
  classifyBatch?(inputs: ClassificationInput[], folders: FolderSummary[], config: ProviderConfig, recentCorrections?: RecentCorrection[], onRequest?: (body: Record<string, unknown>) => void): Promise<ClassificationResult[]>;
  generateMetadata?(input: BookmarkMetadataInput, config: ProviderConfig): Promise<SummaryTagResult>;
  test(config: ProviderConfig): Promise<void>;
}

/**
 * Keeps the classifier boundary stable while adapting the three supported
 * non-streaming JSON APIs to the same prompt and strict result schema.
 */
export class OpenAICompatibleProvider implements ClassifierProvider {
  constructor(private readonly fetcher: typeof fetch = fetch.bind(globalThis)) {}

  private cacheVariant = 0;

  getCacheVariant(): number | undefined {
    return Number.isSafeInteger(this.cacheVariant) ? this.cacheVariant : undefined;
  }

  getCacheRequest(
    mode: 'single' | 'batch',
    inputs: ClassificationInput[],
    folders: FolderSummary[],
    config: ProviderConfig,
    recentCorrections?: RecentCorrection[],
  ): Record<string, unknown> | undefined {
    if (mode === 'single' && inputs.length !== 1) return undefined;
    const messages = mode === 'single'
      ? buildClassificationMessages(inputs[0]!, folders, recentCorrections)
      : buildBatchMessages(inputs, folders, recentCorrections);
    const shape = `${config.protocol}:${config.baseUrl}:${config.model}`;
    const promptOnly = this.promptModeOnlyFor === shape;
    return buildRequestBody(config, promptOnly ? inlineInstructions(messages) : messages, {
      maxTokens: mode === 'batch' ? 4_000 : undefined,
      ...(promptOnly ? {} : { tool: mode === 'single' ? CLASSIFICATION_TOOL : BATCH_TOOL }),
      disableReasoning: this.reasoningOptOutFailedFor !== shape,
    });
  }

  async classify(
    input: ClassificationInput,
    folders: FolderSummary[],
    config: ProviderConfig,
    recentCorrections?: RecentCorrection[],
    onRequest?: (body: Record<string, unknown>) => void,
  ): Promise<ClassificationResult> {
    const messages = buildClassificationMessages(input, folders, recentCorrections);
    const parsed = await this.askStructured(config, messages, CLASSIFICATION_TOOL, undefined, onRequest);
    const result = ClassificationResultSchema.safeParse(parsed);
    if (!result.success) throw new ProviderError('AI 分类结果不符合安全格式，书签已保留原位', false);
    return result.data;
  }

  async classifyBatch(
    inputs: ClassificationInput[],
    folders: FolderSummary[],
    config: ProviderConfig,
    recentCorrections?: RecentCorrection[],
    onRequest?: (body: Record<string, unknown>) => void,
  ): Promise<ClassificationResult[]> {
    if (inputs.length === 0) return [];
    const messages = buildBatchMessages(inputs, folders, recentCorrections);
    const parsed = await this.askStructured(config, messages, BATCH_TOOL, 4_000, onRequest);
    const batch = BatchResultSchema.safeParse(parsed);
    if (!batch.success) throw new ProviderError('AI 批量结果不符合安全格式', false);
    const byIndex = new Map<number, ClassificationResult>();
    for (const entry of batch.data.results) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ProviderError('AI 批量结果不符合安全格式', false);
      }
      const { index, ...value } = entry as Record<string, unknown>;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= inputs.length || byIndex.has(index)) {
        throw new ProviderError('AI 批量结果 index 不完整或重复', true);
      }
      const result = ClassificationResultSchema.safeParse(value);
      if (!result.success) throw new ProviderError('AI 批量结果不符合安全格式', false);
      byIndex.set(index, result.data);
    }
    if (byIndex.size !== inputs.length) throw new ProviderError('AI 批量结果缺少某些书签', true);
    return inputs.map((_, index) => byIndex.get(index)!);
  }

  async generateMetadata(input: BookmarkMetadataInput, config: ProviderConfig): Promise<SummaryTagResult> {
    const parsed = await this.askStructured(config, buildMetadataMessages(input), METADATA_TOOL);
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

  /** 记录“这个网关不支持工具调用”的判断，配置变化时自动失效。 */
  private promptModeOnlyFor?: string;

  /** 记录“这个网关不接受 reasoning_effort”，配置变化时自动失效。 */
  private reasoningOptOutFailedFor?: string;

  /**
   * 结构化输出：优先用工具调用强制形状，网关不支持或静默忽略时降级为
   * “指令并入 user 消息”的纯文本模式（兼容丢弃 system 的网关）。
   */
  private async askStructured(
    config: ProviderConfig,
    messages: ClassificationMessage[],
    tool: ToolSpec,
    maxTokens?: number,
    onRequest?: (body: Record<string, unknown>) => void,
  ): Promise<unknown> {
    const shape = `${config.protocol}:${config.baseUrl}:${config.model}`;
    if (this.promptModeOnlyFor !== shape) {
      // 关闭思维链：分类/摘要只需要结构化结论，推理既慢又占 max_tokens。
      // 网关拒绝该参数时先退回“有工具但不关思考”，再退回纯文本模式。
      const attempts = this.reasoningOptOutFailedFor === shape ? [false] : [true, false];
      for (const disableReasoning of attempts) {
        try {
          const body = buildRequestBody(config, messages, { maxTokens, tool, disableReasoning });
          const payload = await this.request(config, body);
          assertNotTruncated(payload, config.protocol);
          const structured = extractToolPayload(payload, config.protocol);
          if (structured !== undefined) {
            onRequest?.(body);
            return structured;
          }
          const text = readContentText(payload, config.protocol);
          const parsed = text === undefined ? undefined : tryParseJson(text);
          if (parsed !== undefined) {
            onRequest?.(body);
            return parsed;
          }
          if (this.promptModeOnlyFor !== shape) {
            this.promptModeOnlyFor = shape;
            this.cacheVariant += 1;
          }
          break;
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          const status = error.status;
          // 400/422 才可能是参数不被接受；404 通常是地址或模型不对，不应降级重试。
          if (status !== 400 && status !== 422) throw error;
          if (disableReasoning) {
            if (this.reasoningOptOutFailedFor !== shape) {
              this.reasoningOptOutFailedFor = shape;
              this.cacheVariant += 1;
            }
            continue;
          }
          if (this.promptModeOnlyFor !== shape) {
            this.promptModeOnlyFor = shape;
            this.cacheVariant += 1;
          }
          break;
        }
      }
    }
    const body = buildRequestBody(config, inlineInstructions(messages), {
      maxTokens,
      disableReasoning: this.reasoningOptOutFailedFor !== shape,
    });
    const payload = await this.request(config, body);
    assertNotTruncated(payload, config.protocol);
    const parsed = parseJsonContent(extractClassificationText(payload, config.protocol));
    onRequest?.(body);
    return parsed;
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
        throw new ProviderError(statusText, retryable, response.status);
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

interface RequestOptions {
  maxTokens?: number;
  tool?: ToolSpec;
  disableReasoning?: boolean;
}

function buildRequestBody(
  config: ProviderConfig,
  messages: ClassificationMessage[],
  { maxTokens = 500, tool, disableReasoning = false }: RequestOptions = {},
): Record<string, unknown> {
  if (config.protocol === 'anthropic-messages') {
    // Anthropic 默认不返回 thinking 块，无需显式关闭。
    return {
      model: config.model,
      max_tokens: maxTokens,
      temperature: 0.1,
      system: messages[0]?.content ?? '',
      messages: [{ role: 'user', content: messages[1]?.content ?? '' }],
      ...(tool ? {
        tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema }],
        tool_choice: { type: 'tool', name: tool.name },
      } : {}),
    };
  }
  if (config.protocol === 'openai-responses') {
    return {
      model: config.model,
      instructions: messages[0]?.content ?? '',
      input: messages[1]?.content ?? '',
      max_output_tokens: maxTokens,
      temperature: 0.1,
      ...(tool ? {
        tools: [{ type: 'function', name: tool.name, description: tool.description, parameters: tool.schema, strict: tool.strict === true }],
        tool_choice: { type: 'function', name: tool.name },
      } : {}),
    };
  }
  return {
    model: config.model,
    messages,
    temperature: 0.1,
    max_tokens: maxTokens,
    ...(disableReasoning ? { reasoning_effort: 'none' } : {}),
    ...(tool ? {
      tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.schema, strict: tool.strict === true } }],
      tool_choice: { type: 'function', function: { name: tool.name } },
    } : {}),
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

function readContentText(payload: Record<string, unknown>, protocol: ProviderConfig['protocol']): string | undefined {
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

  if (typeof content !== 'string' || content.length > MAX_CLASSIFICATION_TEXT_LENGTH) return undefined;
  return content;
}

function extractClassificationText(payload: Record<string, unknown>, protocol: ProviderConfig['protocol']): string {
  const content = readContentText(payload, protocol);
  if (content === undefined) throw new ProviderError('AI 没有返回可读取的分类内容', false);
  return content;
}

/** 取出工具调用的参数（已经是对象或可解析的 JSON 字符串），没有则返回 undefined。 */
function extractToolPayload(payload: Record<string, unknown>, protocol: ProviderConfig['protocol']): unknown {
  if (protocol === 'anthropic-messages') {
    const blocks = payload.content;
    if (!Array.isArray(blocks)) return undefined;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const record = block as Record<string, unknown>;
      if (record.type === 'tool_use') return record.input;
    }
    return undefined;
  }
  if (protocol === 'openai-responses') {
    const output = payload.output;
    if (!Array.isArray(output)) return undefined;
    for (const item of output) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (record.type === 'function_call' && typeof record.arguments === 'string') return tryParseJson(record.arguments);
    }
    return undefined;
  }
  const choices = payload.choices;
  const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
  const message = firstChoice && typeof firstChoice === 'object' ? firstChoice.message : undefined;
  const calls = typeof message === 'object' && message !== null
    ? (message as Record<string, unknown>).tool_calls
    : undefined;
  if (!Array.isArray(calls)) return undefined;
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue;
    const fn = (call as Record<string, unknown>).function;
    const args = typeof fn === 'object' && fn !== null ? (fn as Record<string, unknown>).arguments : undefined;
    if (typeof args === 'string') return tryParseJson(args);
  }
  return undefined;
}

/** 被 max_tokens 截断时给出可重试的独立错误，避免和“不是合法 JSON”混为一谈。 */
function assertNotTruncated(payload: Record<string, unknown>, protocol: ProviderConfig['protocol']): void {
  const truncated = (reason: unknown) => reason === 'length' || reason === 'max_tokens' || reason === 'max_output_tokens';
  if (protocol === 'anthropic-messages') {
    if (truncated(payload.stop_reason)) throw new ProviderError('AI 响应被截断，请重试或减少书签数量', true);
    return;
  }
  if (protocol === 'openai-responses') {
    const details = payload.incomplete_details;
    const reason = typeof details === 'object' && details !== null
      ? (details as Record<string, unknown>).reason
      : undefined;
    if (payload.status === 'incomplete' && truncated(reason)) throw new ProviderError('AI 响应被截断，请重试或减少书签数量', true);
    return;
  }
  const choices = payload.choices;
  const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
  const reason = firstChoice && typeof firstChoice === 'object'
    ? (firstChoice as Record<string, unknown>).finish_reason
    : undefined;
  if (truncated(reason)) throw new ProviderError('AI 响应被截断，请重试或减少书签数量', true);
}

/**
 * 纯文本降级：把 system 内容并入 user 消息尾部。
 * 指令放在数据之后，且不再依赖会被部分网关丢弃的 system 角色。
 */
function inlineInstructions(messages: ClassificationMessage[]): ClassificationMessage[] {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const user = messages.filter((message) => message.role === 'user').map((message) => message.content).join('\n\n');
  if (!system) return messages;
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${user}\n\n---\n${system}` },
  ];
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

function tryParseJson(content: string): unknown {
  const clean = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(clean) as unknown;
  } catch {
    return undefined;
  }
}

function parseJsonContent(content: string): unknown {
  const parsed = tryParseJson(content);
  if (parsed === undefined) throw new ProviderError('AI 分类内容不是有效 JSON，书签已保留原位', false);
  return parsed;
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
