import type { ExtractedPage, PageExtractionPort } from './page-extractor.service';

/** WXT builds runtime content scripts to `content-scripts/<name>.js`. */
const EXTRACT_SCRIPT = 'content-scripts/page-extract.js';

/**
 * Runs inside the target page (serialized by `chrome.scripting.executeScript`), so it must stay
 * self-contained: no imports, no closures. Clones the DOM before cleaning so the live page is
 * never mutated.
 */
function extractInPage(limit: number): ExtractedPage | null {
  try {
    const metaContent = (selector: string): string =>
      document.querySelector(selector)?.getAttribute('content')?.trim() ?? '';
    const description =
      metaContent('meta[name="description"]') ||
      metaContent('meta[property="og:description"]') ||
      metaContent('meta[name="twitter:description"]');
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .slice(0, 12)
      .map((element) => (element.textContent ?? '').trim())
      .filter(Boolean);
    const main = document.querySelector('article, main, [role="main"]') ?? document.body;
    const clone = main ? (main.cloneNode(true) as HTMLElement) : null;
    clone?.querySelectorAll('script, style, nav, header, footer, aside, noscript, svg, form, iframe')
      .forEach((element) => element.remove());
    const text = ((clone?.innerText ?? document.body?.innerText ?? '') as string)
      .replace(/\s+/g, ' ')
      .trim();
    return {
      url: location.href,
      title: document.title || '',
      description: description.slice(0, 500),
      headings,
      text: text.slice(0, limit),
    };
  } catch {
    return null;
  }
}

function comparableUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path}${url.search}`;
  } catch {
    return rawUrl;
  }
}

/** Chrome-backed extraction: matches the active tab to the bookmark URL, then injects. */
export class ChromePageExtractionPort implements PageExtractionPort {
  async extract(url: string, limit: number): Promise<ExtractedPage | undefined> {
    if (!chrome.scripting?.executeScript) return undefined;
    let tabs: chrome.tabs.Tab[];
    try {
      tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    } catch {
      return undefined;
    }
    const tab = tabs[0];
    if (!tab?.id || !tab.url) return undefined;
    if (comparableUrl(tab.url) !== comparableUrl(url)) return undefined;
    const tabId = tab.id;

    // Preferred path: inject the WXT-bundled Readability extractor (can import modules).
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (value: number) => { (globalThis as Record<string, unknown>).__abmExtractLimit = value; },
        args: [limit],
      });
      await chrome.scripting.executeScript({ target: { tabId }, files: [EXTRACT_SCRIPT] });
      const [read] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => (globalThis as Record<string, unknown>).__abmExtractResult ?? null,
      });
      const fromReadability = read?.result as ExtractedPage | null | undefined;
      if (fromReadability?.text) return fromReadability;
    } catch {
      // fall through to the self-contained heuristic extraction
    }

    // Fallback: self-contained heuristic extraction via `func` serialization.
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractInPage,
        args: [limit],
      });
      const result = results[0]?.result as ExtractedPage | null | undefined;
      return result ?? undefined;
    } catch {
      return undefined;
    }
  }
}
