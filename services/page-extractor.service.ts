import type { PageProfile, Settings } from '../types/domain';

/** Raw structure returned from an injected page extraction. Never persisted verbatim. */
export interface ExtractedPage {
  url: string;
  title: string;
  description: string;
  headings: string[];
  text: string;
}

export interface PageExtractionPort {
  /** Locate the active browser tab whose URL matches `url` and run extraction on it. */
  extract(url: string, limit: number): Promise<ExtractedPage | undefined>;
}

export interface PageExtractorDependencies {
  port: PageExtractionPort;
  now?: () => number;
}

const SENSITIVE_PATTERNS = [
  'bank', 'banking', 'paypal', 'alipay', 'stripe.com', 'wise.com', 'coinbase', 'binance',
  'health', 'hospital', 'patient', 'mychart', 'medicare', 'clinic',
  '1password', 'lastpass', 'bitwarden',
  'mail.google.com', 'outlook.', 'accounts.google.com', 'login.', 'signin.', 'auth.',
  'localhost', '127.0.0.1', '0.0.0.0', '.local', '[::1]',
];

const TOPIC_STOPWORDS: Record<string, true> = {
  home: true, untitled: true, 'new tab': true, 首页: true, 未命名: true, index: true,
};

/** A page profile is never built for these hosts (privacy default, D5). */
export function isSensitiveHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return SENSITIVE_PATTERNS.some((pattern) => host === pattern || host.includes(pattern));
}

export class PageExtractorService {
  private readonly now: () => number;

  constructor(private readonly deps: PageExtractorDependencies) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Best-effort: returns a bounded sampled {@link PageProfile} or `undefined` whenever extraction is
   * disabled, the site is excluded, the page is unavailable, or anything fails. Never throws.
   */
  async extractProfile(url: string, settings: Settings, hostname: string): Promise<PageProfile | undefined> {
    if (!settings.contentAssistEnabled) return undefined;
    let protocol = '';
    try { protocol = new URL(url).protocol; } catch { return undefined; }
    if (protocol !== 'http:' && protocol !== 'https:') return undefined;
    const host = hostname.toLowerCase();
    if (!host || isSensitiveHost(host)) return undefined;
    if (settings.contentAssistDisabledSites.some((site) => host === site.toLowerCase() || host.endsWith(`.${site.toLowerCase()}`))) {
      return undefined;
    }
    try {
      const page = await this.deps.port.extract(url, settings.extractCharLimit);
      if (!page || !page.text || page.text.trim().length === 0) return undefined;
      return buildPageProfile(page, this.now(), settings.extractCharLimit);
    } catch {
      return undefined;
    }
  }
}

export function buildPageProfile(page: ExtractedPage, now: number, limit = 3000): PageProfile {
  const text = page.text.slice(0, limit).replace(/\s+/g, ' ').trim();
  const description = page.description.replace(/\s+/g, ' ').trim();
  const introduction = description.slice(0, 150);
  const budget = 500 - introduction.length - (introduction ? 1 : 0);
  const width = Math.floor((budget - 2) / 3);
  const excerpt = text.length <= budget ? text : [
    text.slice(0, width),
    text.slice(Math.floor((text.length - width) / 2), Math.floor((text.length - width) / 2) + width),
    text.slice(-width),
  ].join('…');
  const summary = [introduction, excerpt].filter(Boolean).join(' ') || page.title.trim().slice(0, 500) || '(无描述)';
  return {
    summary,
    topics: collectTopics(page),
    contentType: detectContentType(page),
    charCount: text.length,
    generatedAt: now,
  };
}

function collectTopics(page: ExtractedPage): string[] {
  const raw = [page.title, ...page.headings].join(' | ');
  const parts = raw.split(/[|·•—–\-:,/()\[\]【】]+/).map((part) => part.replace(/\s+/g, ' ').trim());
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const part of parts) {
    if (part.length < 2 || part.length > 32) continue;
    const key = part.toLocaleLowerCase();
    if (TOPIC_STOPWORDS[key] || seen.has(key)) continue;
    seen.add(key);
    topics.push(part);
    if (topics.length >= 8) break;
  }
  return topics;
}

function detectContentType(page: ExtractedPage): string {
  let host = '';
  try { host = new URL(page.url).hostname.toLowerCase(); } catch { host = ''; }
  const url = page.url.toLowerCase();
  const title = page.title.toLowerCase();
  if (/youtube\.com|youtu\.be|vimeo\.com|bilibili\.com/.test(host) || /video|视频/.test(title)) return 'video';
  if (/(^|\.)github\.com$/.test(host)) return 'repo';
  if (/docs?\./.test(host) || /\/docs?\//.test(url) || /documentation|文档/.test(title)) return 'doc';
  if (/\.ai$/.test(host) || /\bai\b|tool|工具/.test(title)) return 'tool';
  return 'article';
}

