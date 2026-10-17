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

export interface BookmarkPort {
  getTree(): Promise<BookmarkNode[]>;
  getBookmark(id: string): Promise<BookmarkNode | null>;
  getFolder(id: string): Promise<BookmarkNode | null>;
  getFolders(): Promise<FolderSummary[]>;
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

export class ChromeBookmarkService implements BookmarkPort {
  constructor(private readonly api: BookmarkApi = chrome.bookmarks) {}

  getTree(): Promise<BookmarkNode[]> {
    return this.api.getTree();
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
