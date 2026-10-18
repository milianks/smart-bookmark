import type { FolderSummary } from '../types/domain';

export interface BookmarkNode {
  id: string;
  title: string;
  url?: string;
  parentId?: string;
  dateAdded?: number;
  folderType?: string;
  unmodifiable?: string;
  children?: BookmarkNode[];
}

export interface BookmarkApi {
  getTree(): Promise<BookmarkNode[]>;
  get(id: string): Promise<BookmarkNode[]>;
  move(id: string, destination: { parentId: string }): Promise<BookmarkNode>;
  create(details: { parentId: string; title: string }): Promise<BookmarkNode>;
}

export interface ProfileUserInfoApi {
  getProfileUserInfo(): Promise<{ email?: string }>;
}

export interface SmartBookmarkRootInitialization {
  rootId: string;
  title: string;
  created: boolean;
  defaultsCreated: number;
}

export const SMART_BOOKMARK_DEFAULT_FOLDERS = [
  '📥 待分类',
  '💼 工作',
  '🚀 项目',
  '🧑‍💻 开发',
  '📚 学习',
  '🔬 研究',
  '📰 阅读',
  '🛠️ 工具',
  '🎨 灵感',
  '🌿 生活',
  '🗄️ 归档',
] as const;

export interface BookmarkPort {
  getTree(): Promise<BookmarkNode[]>;
  getBookmark(id: string): Promise<BookmarkNode | null>;
  getFolder(id: string): Promise<BookmarkNode | null>;
  getFolders(): Promise<FolderSummary[]>;
  isWithinRoot?(nodeId: string, rootId: string): Promise<boolean>;
  getFoldersWithinRoot?(rootId: string): Promise<FolderSummary[]>;
  isValidTargetFolder?(targetFolderId: string, rootId: string): Promise<boolean>;
  getFolderPath(id: string): Promise<string | null>;
  folderExists(id: string): Promise<boolean>;
  isEligibleRoot(id: string): Promise<boolean>;
  moveBookmark(bookmarkId: string, targetFolderId: string): Promise<void>;
  createFolder(name: string, parentId: string): Promise<BookmarkNode>;
}

export interface HistoricalBookmarkCandidate {
  id: string;
  title: string;
  url: string;
  parentId: string;
  dateAdded?: number;
}

/** Enumerate editable HTTP(S) bookmarks without crossing the protection boundary. */
export function enumerateHistoricalBookmarks(tree: BookmarkNode[], forceOrganize: boolean): HistoricalBookmarkCandidate[] {
  const result: HistoricalBookmarkCandidate[] = [];
  const seen = new Set<string>();
  const visit = (node: BookmarkNode, rootType?: string, rootManaged = false, directBuiltinChild = false) => {
    const nextRootType = node.folderType ?? rootType;
    const managed = rootManaged || node.unmodifiable === 'managed' || node.folderType === 'managed';
    if (node.url && node.parentId && isHttpUrl(node.url) && !managed) {
      const eligible = nextRootType !== undefined && (!forceOrganize ? directBuiltinChild : true);
      if (eligible && !seen.has(node.id)) {
        seen.add(node.id);
        result.push({ id: node.id, title: node.title || '(无标题)', url: node.url, parentId: node.parentId, ...(node.dateAdded ? { dateAdded: node.dateAdded } : {}) });
      }
    }
    const isBuiltinRoot = !node.url && ['bookmarks-bar', 'other', 'mobile'].includes(node.folderType ?? '') && !managed;
    for (const child of node.children ?? []) visit(child, nextRootType, managed, isBuiltinRoot);
  };
  for (const root of tree) visit(root);
  return result;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Return the first editable node with the requested id, including its ancestor state. */
function findNodeInTree(
  nodes: BookmarkNode[],
  id: string,
  inheritedManaged = false,
): { node: BookmarkNode; managed: boolean } | null {
  for (const node of nodes) {
    const managed = inheritedManaged || node.unmodifiable === 'managed' || node.folderType === 'managed';
    if (node.id === id) return { node, managed };
    const found = findNodeInTree(node.children ?? [], id, managed);
    if (found) return found;
  }
  return null;
}

function isFolder(node: BookmarkNode): boolean {
  return !node.url;
}

/** Check whether a node is the smart root or an editable descendant of it. */
export function isNodeWithinRoot(tree: BookmarkNode[], nodeId: string, rootId: string): boolean {
  const root = findNodeInTree(tree, rootId);
  if (!root || !isFolder(root.node) || root.managed) return false;
  if (nodeId === rootId) return true;

  const visit = (node: BookmarkNode, inheritedManaged: boolean): boolean => {
    const managed = inheritedManaged || node.unmodifiable === 'managed' || node.folderType === 'managed';
    if (node.id === nodeId) return !managed;
    return (node.children ?? []).some((child) => visit(child, managed));
  };
  return (root.node.children ?? []).some((child) => visit(child, root.managed));
}

/** Build folder summaries for the smart root subtree, excluding managed branches. */
export function getFoldersWithinRoot(tree: BookmarkNode[], rootId: string): FolderSummary[] {
  const root = findNodeInTree(tree, rootId);
  if (!root || !isFolder(root.node) || root.managed) return [];
  const folders: FolderSummary[] = [];
  const visit = (node: BookmarkNode, ancestors: string[], inheritedManaged: boolean) => {
    const managed = inheritedManaged || node.unmodifiable === 'managed' || node.folderType === 'managed';
    if (managed || !isFolder(node)) return;
    const currentPath = node.title.trim() ? [...ancestors, node.title] : ancestors;
    if (node.children !== undefined && node.title.trim()) {
      folders.push({
        id: node.id,
        name: node.title,
        path: currentPath.join(' / '),
        ...(node.parentId ? { parentId: node.parentId } : {}),
        ...(node.folderType ? { folderType: node.folderType } : {}),
        ...(node.unmodifiable ? { unmodifiable: node.unmodifiable } : {}),
      });
    }
    for (const child of node.children ?? []) visit(child, currentPath, managed);
  };
  visit(root.node, [], root.managed);
  return folders;
}

/** Check that an editable folder is inside the smart root subtree. */
export function isValidTargetFolder(tree: BookmarkNode[], targetFolderId: string, rootId: string): boolean {
  const target = findNodeInTree(tree, targetFolderId);
  return Boolean(target && isFolder(target.node) && !target.managed && isNodeWithinRoot(tree, targetFolderId, rootId));
}

/** Enumerate editable HTTP(S) bookmarks in the smart root subtree. */
export function enumerateHistoricalBookmarksWithinRoot(
  tree: BookmarkNode[],
  rootId: string,
): HistoricalBookmarkCandidate[] {
  const root = findNodeInTree(tree, rootId);
  if (!root || !isFolder(root.node) || root.managed) return [];
  const result: HistoricalBookmarkCandidate[] = [];
  const seen = new Set<string>();
  const visit = (node: BookmarkNode, inheritedManaged: boolean) => {
    const managed = inheritedManaged || node.unmodifiable === 'managed' || node.folderType === 'managed';
    if (managed) return;
    if (node.url && node.parentId && isHttpUrl(node.url) && !seen.has(node.id)) {
      seen.add(node.id);
      result.push({
        id: node.id,
        title: node.title || '(无标题)',
        url: node.url,
        parentId: node.parentId,
        ...(node.dateAdded ? { dateAdded: node.dateAdded } : {}),
      });
      return;
    }
    for (const child of node.children ?? []) visit(child, managed);
  };
  for (const child of root.node.children ?? []) visit(child, root.managed);
  return result;
}

export function smartBookmarkOwnerName(email: string | undefined): string {
  const localPart = typeof email === 'string' ? email.trim().split('@', 1)[0]?.trim() : '';
  return localPart || 'bookmark';
}

function findBookmarksBar(tree: BookmarkNode[]): BookmarkNode | null {
  const visit = (nodes: BookmarkNode[]): BookmarkNode | null => {
    for (const node of nodes) {
      if (!node.url && node.folderType === 'bookmarks-bar') return node;
      const found = visit(node.children ?? []);
      if (found) return found;
    }
    return null;
  };
  return visit(tree);
}

export class ChromeBookmarkService implements BookmarkPort {
  constructor(private readonly api: BookmarkApi = chrome.bookmarks) {}

  getTree(): Promise<BookmarkNode[]> {
    return this.api.getTree();
  }

  async initializeSmartBookmarkRoot(options: {
    storedRootId?: string;
    initializeDefaults?: boolean;
    identity?: ProfileUserInfoApi;
  } = {}): Promise<SmartBookmarkRootInitialization> {
    const identity = options.identity ?? chrome.identity;
    let email: string | undefined;
    try {
      email = (await identity.getProfileUserInfo()).email;
    } catch {
      email = undefined;
    }
    const title = `${smartBookmarkOwnerName(email)} 的智能书签`;
    const tree = await this.api.getTree();
    const bar = findBookmarksBar(tree);
    if (!bar || bar.unmodifiable === 'managed') throw new Error('Chrome 书签栏不可用');

    let root: BookmarkNode | undefined;
    let replacedStoredRoot = false;
    if (options.storedRootId) {
      const stored = findNodeInTree(tree, options.storedRootId);
      if (stored && isFolder(stored.node) && !stored.managed && bar.children?.some((child) => child.id === stored.node.id)) {
        root = stored.node;
      } else {
        replacedStoredRoot = true;
      }
    }
    if (!root) {
      const matches = (bar.children ?? []).filter((child) =>
        isFolder(child) && child.title === title && child.unmodifiable !== 'managed' && child.folderType !== 'managed');
      if (matches.length === 1) root = matches[0];
    }

    let created = false;
    if (!root) {
      root = await this.createFolder(title, bar.id);
      created = true;
    }

    const shouldCreateDefaults = options.initializeDefaults !== false || created || replacedStoredRoot;
    let defaultsCreated = 0;
    if (shouldCreateDefaults) {
      const existingTitles = new Set((root.children ?? []).filter((child) => isFolder(child)).map((child) => child.title));
      for (const folderName of SMART_BOOKMARK_DEFAULT_FOLDERS) {
        if (existingTitles.has(folderName)) continue;
        await this.createFolder(folderName, root.id);
        existingTitles.add(folderName);
        defaultsCreated += 1;
      }
    }
    return { rootId: root.id, title: root.title || title, created, defaultsCreated };
  }

  async getBookmark(id: string): Promise<BookmarkNode | null> {
    try {
      const [node] = await this.api.get(id);
      return node?.url ? node : null;
    } catch {
      return null;
    }
  }

  async getFolder(id: string): Promise<BookmarkNode | null> {
    const node = await this.getNode(id);
    return node && !node.url ? node : null;
  }

  async getFolders(): Promise<FolderSummary[]> {
    const tree = await this.api.getTree();
    const folders: FolderSummary[] = [];
    const visit = (node: BookmarkNode, ancestors: string[]) => {
      const currentPath = node.title ? [...ancestors, node.title] : ancestors;
      if (!node.url && node.children !== undefined && node.title.trim()) {
        folders.push({
          id: node.id,
          name: node.title,
          path: currentPath.join(' / '),
          ...(node.parentId ? { parentId: node.parentId } : {}),
          ...(node.folderType ? { folderType: node.folderType } : {}),
          ...(node.unmodifiable ? { unmodifiable: node.unmodifiable } : {}),
        });
      }
      for (const child of node.children ?? []) visit(child, currentPath);
    };
    for (const root of tree) visit(root, []);
    return folders;
  }

  async isWithinRoot(nodeId: string, rootId: string): Promise<boolean> {
    return isNodeWithinRoot(await this.api.getTree(), nodeId, rootId);
  }

  async getFoldersWithinRoot(rootId: string): Promise<FolderSummary[]> {
    return getFoldersWithinRoot(await this.api.getTree(), rootId);
  }

  async isValidTargetFolder(targetFolderId: string, rootId: string): Promise<boolean> {
    return isValidTargetFolder(await this.api.getTree(), targetFolderId, rootId);
  }

  async getFolderPath(id: string): Promise<string | null> {
    const folders = await this.getFolders();
    return folders.find((folder) => folder.id === id)?.path ?? null;
  }

  async folderExists(id: string): Promise<boolean> {
    return (await this.getFolder(id)) !== null;
  }

  async isEligibleRoot(id: string): Promise<boolean> {
    const folder = await this.getFolder(id);
    return ['bookmarks-bar', 'other', 'mobile'].includes(folder?.folderType ?? '')
      && folder?.unmodifiable !== 'managed';
  }

  async moveBookmark(bookmarkId: string, targetFolderId: string): Promise<void> {
    const target = await this.getFolder(targetFolderId);
    if (!target || target.unmodifiable === 'managed') throw new Error('目标文件夹不存在或不可修改');
    await this.api.move(bookmarkId, { parentId: targetFolderId });
  }

  async createFolder(name: string, parentId: string): Promise<BookmarkNode> {
    const parent = await this.getFolder(parentId);
    if (!parent || parent.unmodifiable === 'managed') throw new Error('新文件夹的上级目录不存在或不可修改');
    return this.api.create({ parentId, title: name });
  }

  private async getNode(id: string): Promise<BookmarkNode | null> {
    try {
      const [node] = await this.api.get(id);
      return node ?? null;
    } catch {
      return null;
    }
  }
}
