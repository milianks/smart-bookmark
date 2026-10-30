import type { ClassificationResult, FolderSummary } from '../../types/domain';
import type { ClassificationInput } from './prompts';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'www', 'com', 'org', 'net', 'html', 'https',
  'about', 'into', 'your', 'how', 'what', 'when', 'where', '教程', '介绍', '关于', '一个', '这个', '如何',
]);

const GENERIC_FOLDER_TOKENS = new Set([
  'work', 'project', 'projects', 'dev', 'development', 'misc', 'other', 'general', 'inbox', '收藏', '其他',
  '工作', '项目', '开发', '工具', '资料', '杂项', '待分类', '未分类',
]);

const DOMAIN_HINTS: Record<string, string[]> = {
  'github.com': ['developer', 'development', 'programming', 'code', 'software', '开源', '开发'],
  'stackoverflow.com': ['developer', 'development', 'programming', 'code', 'software', '开发'],
  'openai.com': ['ai', 'artificial', 'intelligence', 'machine', 'learning', '模型', '人工智能'],
  'arxiv.org': ['research', 'paper', 'science', 'academic', '研究', '论文'],
  'youtube.com': ['video', 'tutorial', 'learning', 'media', '视频', '教程'],
  'medium.com': ['article', 'reading', 'writing', 'blog', '文章', '阅读'],
};

const MAX_CANDIDATE_BUDGET_BYTES = 10_000;
const MIN_CANDIDATE_FOLDERS = 12;

interface FolderEvidence {
  folder: FolderSummary;
  score: number;
  folderOverlap: number;
  hintOverlap: number;
  pathOverlap: number;
  sampleOverlap: number;
  exactSampleDomain: boolean;
  exactSampleUrl: boolean;
  hasStrongTopic: boolean;
}

/** Rank folders for the provider without losing the full list on weak signals. */
export function rankFolderCandidates(
  input: ClassificationInput,
  folders: FolderSummary[],
): FolderSummary[] {
  const totalBytes = folders.reduce((sum, folder) => sum + estimateFolderBytes(folder), 0);
  if (totalBytes <= MAX_CANDIDATE_BUDGET_BYTES) return folders;
  const ranked = scoreFolders(input, folders);
  const top = ranked[0];
  if (!top || !hasMeaningfulEvidence(top, ranked[1])) return folders;

  const selected: FolderSummary[] = [];
  let budget = MAX_CANDIDATE_BUDGET_BYTES;
  for (const { folder } of ranked) {
    const cost = estimateFolderBytes(folder);
    if (cost > budget) {
      if (selected.length >= MIN_CANDIDATE_FOLDERS) break;
      // Floor: keep id/name/path so small-but-fat trees still surface the full taxonomy.
      const { samples: _samples, ...slim } = folder;
      selected.push(slim);
      continue;
    }
    selected.push(folder);
    budget -= cost;
  }
  const current = input.currentFolderId
    ? folders.find((folder) => folder.id === input.currentFolderId)
    : undefined;
  if (current && !selected.some((folder) => folder.id === current.id)) {
    selected.pop();
    selected.push(current);
  }
  return selected;
}

function estimateFolderBytes(folder: FolderSummary): number {
  let size = folder.name.length + folder.path.length + 40;
  for (const sample of (folder.samples ?? []).slice(0, 3)) {
    size += sample.title.length + sample.url.length + sample.hostname.length + 20;
  }
  return size;
}

/** Keep folders in order until the serialized budget is exhausted (floor 12, samples stripped). */
export function trimFolderBudget(folders: FolderSummary[]): FolderSummary[] {
  let budget = MAX_CANDIDATE_BUDGET_BYTES;
  const selected: FolderSummary[] = [];
  for (const folder of folders) {
    const cost = estimateFolderBytes(folder);
    if (cost > budget) {
      if (selected.length >= MIN_CANDIDATE_FOLDERS) break;
      const { samples: _samples, ...slim } = folder;
      selected.push(slim);
      continue;
    }
    selected.push(folder);
    budget -= cost;
  }
  return selected;
}

export function classifyWithRules(
  input: ClassificationInput,
  folders: FolderSummary[],
): ClassificationResult | null {
  const ranked = scoreFolders(input, folders);
  const top = ranked[0];
  if (!top || top.folder.id === input.currentFolderId || !hasMeaningfulEvidence(top, ranked[1])) return null;

  if (!top.exactSampleUrl && !top.hasStrongTopic) return null;

  const confidence = confidenceFor(top);
  if (confidence < 0.86) return null;
  if (ranked[1] && confidenceFor(ranked[1]) >= confidence - 0.04) return null;
  if (top.exactSampleDomain && top.sampleOverlap === 0 && top.folderOverlap === 0 && top.pathOverlap === 0) return null;

  return {
    action: 'move',
    targetFolderId: top.folder.id,
    confidence,
    reason: top.exactSampleDomain || top.exactSampleUrl
      ? '书签域名或地址与目标文件夹已有书签样例匹配。'
      : top.sampleOverlap > 0
        ? '书签主题与目标文件夹已有书签样例匹配。'
        : '书签标题、网址路径或域名与目标文件夹主题明确匹配。',
  };
}

function scoreFolders(input: ClassificationInput, folders: FolderSummary[]): FolderEvidence[] {
  const domain = normalizeHost(input.domain);
  const pathTokens = urlPathTokens(input.url);
  const hints = Object.entries(DOMAIN_HINTS)
    .filter(([host]) => domain === host || domain.endsWith(`.${host}`))
    .flatMap(([, values]) => values.flatMap(tokens));
  const hintTokens = new Set(hints);
  const topicalTokens = new Set([...tokens(input.title), ...pathTokens]);
  const subjectTokens = new Set([...tokens(input.title), ...tokens(domain), ...pathTokens, ...hints]);

  return folders
    .filter((folder) => !folder.folderType && folder.unmodifiable !== 'managed')
    .map((folder): FolderEvidence => {
      const folderNameTokens = new Set(tokens(folder.name));
      const folderPathTokens = new Set(tokens(folder.path));
      const folderTokens = new Set([...folderNameTokens, ...folderPathTokens]);
      const topicalMatches = new Set([...topicalTokens].filter((token) => folderTokens.has(token) && !GENERIC_FOLDER_TOKENS.has(token)));
      const folderOverlap = informativeOverlap(subjectTokens, folderTokens);
      const hintOverlap = informativeOverlap(hintTokens, folderNameTokens);
      const pathOverlap = informativeOverlap(new Set(pathTokens), folderPathTokens);
      let score = weightedOverlap(subjectTokens, folderTokens, 0.2, 0.06);
      score += pathOverlap * 0.16;
      const exactName = folder.name.trim().toLocaleLowerCase() === input.title.trim().toLocaleLowerCase();
      if (exactName) score += 0.65;

      let sampleOverlap = 0;
      let exactSampleDomain = false;
      let exactSampleUrl = false;
      for (const sample of folder.samples ?? []) {
        const sampleDomain = normalizeHost(sample.hostname || safeHostname(sample.url));
        const samplePath = urlPathTokens(sample.url);
        const sampleTokens = new Set([...tokens(sample.title), ...samplePath]);
        for (const token of topicalTokens) {
          if (sampleTokens.has(token) && !GENERIC_FOLDER_TOKENS.has(token)) topicalMatches.add(token);
        }
        const sampleMatches = informativeOverlap(subjectTokens, sampleTokens);
        sampleOverlap += sampleMatches;
        if (sampleDomain && domain && (domain === sampleDomain || domain.endsWith(`.${sampleDomain}`) || sampleDomain.endsWith(`.${domain}`))) {
          exactSampleDomain = true;
          score += 0.58;
        }
        if (sameUrl(input.url, sample.url)) {
          exactSampleUrl = true;
          score += 0.68;
        }
        score += Math.min(sampleMatches, 3) * 0.13;
        score += overlap(new Set(pathTokens), new Set(samplePath)) * 0.11;
      }

      return {
        folder,
        score,
        folderOverlap,
        hintOverlap,
        pathOverlap,
        sampleOverlap,
        exactSampleDomain,
        exactSampleUrl,
        // A lone Han bigram is too ambiguous, even when repeated by path/domain signals.
        hasStrongTopic: topicalMatches.size >= 2 || [...topicalMatches].some((token) => !/\p{sc=Han}/u.test(token)),
      };
    })
    .sort((a, b) => b.score - a.score || b.sampleOverlap - a.sampleOverlap || a.folder.path.localeCompare(b.folder.path));
}

function hasMeaningfulEvidence(top: FolderEvidence, second?: FolderEvidence): boolean {
  const strongSignal = top.exactSampleUrl
    || top.exactSampleDomain
    || top.sampleOverlap >= 2
    || top.folderOverlap >= 2
    || (top.hintOverlap >= 1 && top.folderOverlap >= 1)
    || top.pathOverlap >= 2
    || (top.pathOverlap >= 1 && top.folderOverlap >= 1)
    || top.score >= 0.78;
  if (!strongSignal) return false;
  if (!second) return true;
  return top.score - second.score >= 0.12 || top.exactSampleUrl || top.exactSampleDomain;
}

function confidenceFor(candidate: FolderEvidence): number {
  if (candidate.exactSampleUrl) return 0.98;
  if (candidate.sampleOverlap >= 2 || candidate.folderOverlap >= 2 || (candidate.hintOverlap >= 1 && candidate.folderOverlap >= 1)) return 0.92;
  if (candidate.exactSampleDomain && candidate.sampleOverlap >= 1) return 0.9;
  if (candidate.pathOverlap >= 1 && candidate.folderOverlap >= 1) return 0.9;
  if (candidate.folderOverlap >= 1 || candidate.pathOverlap >= 1) return 0.86;
  return 0;
}

function weightedOverlap(subject: Set<string>, target: Set<string>, regularWeight: number, genericWeight: number): number {
  let score = 0;
  for (const token of subject) {
    if (!target.has(token)) continue;
    score += GENERIC_FOLDER_TOKENS.has(token) ? genericWeight : regularWeight;
  }
  return score;
}

function overlap(subject: Set<string>, target: Set<string>): number {
  let count = 0;
  for (const token of subject) if (target.has(token)) count += 1;
  return count;
}

function informativeOverlap(subject: Set<string>, target: Set<string>): number {
  let count = 0;
  for (const token of subject) {
    if (target.has(token) && !GENERIC_FOLDER_TOKENS.has(token)) count += 1;
  }
  return count;
}

function tokens(value: string): string[] {
  const result: string[] = [];
  const push = (token: string) => {
    if (token.length > 1 && !STOP_WORDS.has(token)) result.push(token);
  };
  for (const run of value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    // Han runs carry no separators; whole-run tokens only match on exact equality,
    // so segment by script and emit overlapping bigrams for Chinese text.
    for (const segment of run.match(/\p{sc=Han}+|\P{sc=Han}+/gu) ?? []) {
      if (/\p{sc=Han}/u.test(segment)) {
        for (let index = 0; index + 1 < segment.length; index += 1) push(segment.slice(index, index + 2));
      } else {
        push(segment);
      }
    }
  }
  return result;
}

function urlPathTokens(rawUrl: string): string[] {
  try {
    return tokens(new URL(rawUrl).pathname);
  } catch {
    return [];
  }
}

function normalizeHost(value: string): string {
  return value.toLocaleLowerCase().trim().replace(/^www\./, '').replace(/\.$/, '');
}

function safeHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return '';
  }
}

function sameUrl(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    a.hash = '';
    b.hash = '';
    return a.toString() === b.toString();
  } catch {
    return left === right;
  }
}
