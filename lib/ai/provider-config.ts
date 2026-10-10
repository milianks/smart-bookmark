export interface ProviderConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('API 地址不能包含账号、密码、查询参数或片段');
  }
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error('API 地址必须使用 HTTPS；只有本机回环地址可以使用 HTTP');
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/i, '');
  return `${url.origin}${path === '/' ? '' : path}`;
}

export function originPermissionPattern(raw: string): string {
  const url = new URL(normalizeBaseUrl(raw));
  return `${url.protocol}//${url.host}/*`;
}

export function chatCompletionsUrl(raw: string): string {
  return `${normalizeBaseUrl(raw)}/chat/completions`;
}
