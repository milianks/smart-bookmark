import type { ClassificationResult, FolderSummary } from '../../types/domain';
import type { ClassificationInput } from './prompts';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'www', 'com', 'org', 'net', 'html', 'https',
  'about', 'into', 'your', 'how', 'what', 'when', 'where', '教程', '介绍', '关于', '一个', '这个', '如何',
]);

const DOMAIN_HINTS: Record<string, string[]> = {
  'github.com': ['developer', 'development', 'programming', 'code', 'software', '开源', '开发'],
  'stackoverflow.com': ['developer', 'development', 'programming', 'code', 'software', '开发'],
  'openai.com': ['ai', 'artificial', 'intelligence', 'machine', 'learning', '模型', '人工智能'],
  'arxiv.org': ['research', 'paper', 'science', 'academic', '研究', '论文'],
  'youtube.com': ['video', 'tutorial', 'learning', 'media', '视频', '教程'],
  'medium.com': ['article', 'reading', 'writing', 'blog', '文章', '阅读'],
};

export function classifyWithRules(
  input: ClassificationInput,
  folders: FolderSummary[],
): ClassificationResult | null {
  const domain = input.domain.toLowerCase().replace(/^www\./, '');
  const hints = Object.entries(DOMAIN_HINTS)
    .filter(([host]) => domain === host || domain.endsWith(`.${host}`))
    .flatMap(([, tokens]) => tokens);
  const subjectTokens = new Set([...tokens(input.title), ...tokens(domain), ...hints.flatMap(tokens)]);
  const candidates = folders
    .filter((folder) => !folder.folderType && folder.unmodifiable !== 'managed')
    .map((folder) => {
      const folderTokens = new Set([...tokens(folder.name), ...tokens(folder.path)]);
      const overlap = [...subjectTokens].filter((token) => folderTokens.has(token));
      const exactName = folder.name.trim().toLocaleLowerCase() === input.title.trim().toLocaleLowerCase();
      const score = exactName ? 0.98 : overlap.length >= 2 ? 0.92 : overlap.length === 1 ? 0.86 : 0;
      return { folder, score, overlap: overlap.length };
    })
    .filter((candidate) => candidate.score >= 0.86)
    .sort((a, b) => b.score - a.score || a.folder.path.localeCompare(b.folder.path));

  const top = candidates[0];
  if (!top || top.folder.id === input.currentFolderId || top.score < 0.85) return null;
  if (candidates[1]?.score === top.score) return null;
  return {
    action: 'move',
    targetFolderId: top.folder.id,
    confidence: top.score,
    reason: top.overlap > 0 ? '标题或域名与现有文件夹主题明确匹配。' : '书签主题与现有文件夹名称匹配。',
  };
}

function tokens(value: string): string[] {
  return (value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}
