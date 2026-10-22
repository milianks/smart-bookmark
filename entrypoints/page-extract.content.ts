import { defineContentScript } from '#imports';
import { Readability } from '@mozilla/readability';

interface ExtractResult {
  url: string;
  title: string;
  description: string;
  headings: string[];
  text: string;
}

/**
 * Injected on demand (never auto-run) via `chrome.scripting.executeScript({ files })`.
 * Because it is bundled by WXT, `@mozilla/readability` can be used here while the regular
 * `func`-based injection cannot import modules. Results are exchanged through the isolated
 * world global so a follow-up `executeScript` call can read them.
 */
export default defineContentScript({
  registration: 'runtime',
  main() {
    const scope = globalThis as typeof globalThis & {
      __abmExtractLimit?: number;
      __abmExtractResult?: ExtractResult | null;
    };
    const limit = Number(scope.__abmExtractLimit) > 0 ? Number(scope.__abmExtractLimit) : 3000;
    const metaContent = (selector: string): string =>
      document.querySelector(selector)?.getAttribute('content')?.trim() ?? '';

    let text = '';
    try {
      const article = new Readability(document.cloneNode(true) as Document).parse();
      if (article?.textContent) text = article.textContent;
    } catch {
      text = '';
    }
    if (!text) {
      const main = document.querySelector('article, main, [role="main"]') ?? document.body;
      const clone = main ? (main.cloneNode(true) as HTMLElement) : null;
      clone?.querySelectorAll('script, style, nav, header, footer, aside, noscript, svg, form, iframe')
        .forEach((element) => element.remove());
      text = (clone?.innerText ?? document.body?.innerText ?? '') as string;
    }

    scope.__abmExtractResult = {
      url: location.href,
      title: document.title || '',
      description: (
        metaContent('meta[name="description"]') ||
        metaContent('meta[property="og:description"]') ||
        metaContent('meta[name="twitter:description"]')
      ).slice(0, 500),
      headings: Array.from(document.querySelectorAll('h1, h2, h3'))
        .slice(0, 12)
        .map((element) => (element.textContent ?? '').trim())
        .filter(Boolean),
      text: text.replace(/\s+/g, ' ').trim().slice(0, limit),
    };
  },
});
