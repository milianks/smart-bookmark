import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../types/domain';
import {
  PageExtractorService,
  buildPageProfile,
  isSensitiveHost,
  type ExtractedPage,
  type PageExtractionPort,
} from '../services/page-extractor.service';

const page: ExtractedPage = {
  url: 'https://github.com/example/agent',
  title: 'example/agent · AI Agent in Python',
  description: 'A Python agent for automating tasks with LLMs.',
  headings: ['Features', 'Installation', 'Python Agent'],
  text: 'A Python agent for automating tasks with LLMs. '.repeat(20),
};

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, contentAssistEnabled: true, ...patch };
}

function port(result: ExtractedPage | undefined): PageExtractionPort {
  return { extract: async () => result };
}

describe('isSensitiveHost', () => {
  it('flags banking and account hosts', () => {
    expect(isSensitiveHost('mybank.com')).toBe(true);
    expect(isSensitiveHost('accounts.google.com')).toBe(true);
    expect(isSensitiveHost('intranet.local')).toBe(true);
  });

  it('allows ordinary content hosts', () => {
    expect(isSensitiveHost('github.com')).toBe(false);
    expect(isSensitiveHost('muse.ai')).toBe(false);
  });
});

describe('buildPageProfile', () => {
  it('builds a bounded sampled profile', () => {
    const profile = buildPageProfile(page, 123);
    expect(profile.summary).toContain('Python agent');
    expect(profile.summary.length).toBeLessThanOrEqual(500);
    expect(profile.contentType).toBe('repo');
    expect(profile.topics.length).toBeGreaterThan(0);
    expect(profile.charCount).toBe(page.text.trim().length);
    expect(profile.generatedAt).toBe(123);
    expect('text' in profile).toBe(false);
  });

  it('samples later body text even when a meta description exists, with a fixed output bound', () => {
    const text = 'a'.repeat(800) + 'first-budget-marker' + 'b'.repeat(1800) + 'second-budget-marker' + 'c'.repeat(2800) + 'third-budget-marker';
    const input = { ...page, description: 'Fixed meta description', text };
    const profiles = [1000, 3000, 6000].map((limit) => buildPageProfile(input, 0, limit));
    expect(new Set(profiles.map((profile) => profile.summary)).size).toBe(3);
    expect(profiles[2]!.summary).toContain('third-budget-marker');
    expect(profiles[0]!.summary).not.toContain('third-budget-marker');
    for (const profile of profiles) {
      expect(profile.summary).toContain('Fixed meta description');
      expect(profile.summary.length).toBeLessThanOrEqual(500);
    }
  });

  it('detects video content', () => {
    const profile = buildPageProfile({ ...page, url: 'https://www.youtube.com/watch?v=1', title: 'How to build an agent' }, 0);
    expect(profile.contentType).toBe('video');
  });

  it('falls back to a title-based summary when description is empty', () => {
    const profile = buildPageProfile({ ...page, description: '', text: '' }, 0);
    expect(profile.summary.length).toBeGreaterThan(0);
  });
});

describe('PageExtractorService', () => {
  it('returns undefined when content assist is disabled', async () => {
    const service = new PageExtractorService({ port: port(page) });
    expect(await service.extractProfile(page.url, settings({ contentAssistEnabled: false }), 'github.com')).toBeUndefined();
  });

  it('builds a profile from the extracted page', async () => {
    const service = new PageExtractorService({ port: port(page), now: () => 42 });
    const profile = await service.extractProfile(page.url, settings(), 'github.com');
    expect(profile).toBeDefined();
    expect(profile?.contentType).toBe('repo');
    expect(profile?.generatedAt).toBe(42);
  });

  it('enforces the selected extraction budget even if the port returns extra text', async () => {
    const service = new PageExtractorService({ port: port({ ...page, text: 'a'.repeat(1000) + 'outside-budget' }) });
    const profile = await service.extractProfile(page.url, settings({ extractCharLimit: 1000 }), 'github.com');
    expect(profile?.charCount).toBe(1000);
    expect(profile?.summary).not.toContain('outside-budget');
  });

  it('skips sensitive hosts and disabled sites', async () => {
    const service = new PageExtractorService({ port: port(page) });
    expect(await service.extractProfile('https://mybank.com/x', settings(), 'mybank.com')).toBeUndefined();
    expect(await service.extractProfile(page.url, settings({ contentAssistDisabledSites: ['github.com'] }), 'github.com')).toBeUndefined();
  });

  it('skips non-http urls', async () => {
    const service = new PageExtractorService({ port: port(page) });
    expect(await service.extractProfile('chrome://extensions', settings(), 'chrome://extensions')).toBeUndefined();
  });

  it('degrades to undefined when the port throws', async () => {
    const service = new PageExtractorService({ port: { extract: async () => { throw new Error('boom'); } } });
    expect(await service.extractProfile(page.url, settings(), 'github.com')).toBeUndefined();
  });
});
