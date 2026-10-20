import { z } from 'zod';

const confidence = z.number().min(0).max(1);

export const ClassificationResultSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('move'),
    targetFolderId: z.string().min(1),
    confidence,
    reason: z.string().trim().min(1).max(500),
  }).strict(),
  z.object({
    action: z.literal('suggest_folder'),
    suggestedFolder: z.object({
      name: z.string().trim().min(1).max(64),
      parentId: z.string().min(1),
    }).strict(),
    confidence,
    reason: z.string().trim().min(1).max(500),
  }).strict(),
  z.object({
    action: z.literal('keep'),
    confidence,
    reason: z.string().trim().min(1).max(500),
  }).strict(),
]);

export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;
export const SummaryTagResultSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  tags: z.array(z.string().trim().min(1).max(32)).min(1).max(8),
}).strict().superRefine((value, context) => {
  const normalized = value.tags.map((tag) => tag.toLocaleLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    context.addIssue({ code: 'custom', message: 'tags must be unique', path: ['tags'] });
  }
});
export const BookmarkMetadataSchema = SummaryTagResultSchema.extend({
  generatedAt: z.number().finite().nonnegative(),
}).strict();
export type SummaryTagResult = z.infer<typeof SummaryTagResultSchema>;
export type BookmarkMetadata = z.infer<typeof BookmarkMetadataSchema>;
export type ClassificationSource = 'cache' | 'rule' | 'ai';
export type OrganizerMode = 'automatic' | 'confirm';
export const ProviderProtocolSchema = z.enum(['anthropic-messages', 'openai-chat-completions', 'openai-responses']);
export type ProviderProtocol = z.infer<typeof ProviderProtocolSchema>;

export const SettingsSchema = z.object({
  enabled: z.boolean(),
  protocol: ProviderProtocolSchema,
  baseUrl: z.string().min(1),
  model: z.string().min(1),
  apiKey: z.string(),
  confidenceThreshold: z.number().min(0.5).max(1),
  mode: z.enum(['automatic', 'confirm']),
  forceOrganize: z.boolean(),
  notificationsEnabled: z.boolean(),
  successNotifications: z.boolean(),
}).strict();

export type Settings = z.infer<typeof SettingsSchema>;
export type PublicSettings = Omit<Settings, 'apiKey'> & { hasApiKey: boolean };
export const SettingsDraftSchema = SettingsSchema.partial().strict();
export type SettingsDraft = z.infer<typeof SettingsDraftSchema>;

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  protocol: 'openai-chat-completions',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
  confidenceThreshold: 0.85,
  mode: 'automatic',
  forceOrganize: false,
  notificationsEnabled: true,
  successNotifications: false,
};

export interface BookmarkSnapshot {
  id: string;
  title: string;
  url: string;
  parentId: string;
  dateAdded?: number;
}

export interface BookmarkSample {
  title: string;
  url: string;
  hostname: string;
}

export interface FolderSummary {
  id: string;
  name: string;
  path: string;
  parentId?: string;
  folderType?: string;
  unmodifiable?: string;
  samples?: BookmarkSample[];
}

export type JobStatus =
  | 'queued'
  | 'processing'
  | 'awaiting_configuration'
  | 'awaiting_permission'
  | 'pending_review'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface BookmarkJob {
  bookmark: BookmarkSnapshot;
  status: JobStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt?: number;
  lastError?: string;
  classification?: ClassificationResult;
  classificationSource?: ClassificationSource;
  scanId?: string;
  duplicateOf?: string;
  metadata?: BookmarkMetadata;
}

export type ReviewStatus = 'pending' | 'approving' | 'approved' | 'rejected' | 'stale';

export interface ReviewItem {
  id: string;
  bookmarkId: string;
  title: string;
  url: string;
  sourceParentId: string;
  classification: ClassificationResult;
  source: ClassificationSource;
  targetFolderPath?: string;
  parentFolderPath?: string;
  createdAt: number;
  status: ReviewStatus;
  targetFolderId?: string;
  scanId?: string;
  metadata?: BookmarkMetadata;
}

export interface CorrectionEntry {
  domain: string;
  action: 'move' | 'keep';
  folderId?: string;
  createdAt: number;
}

export type HistoricalScanStatus = 'idle' | 'scanning' | 'awaiting_review' | 'completed' | 'failed';

export interface HistoricalScanState {
  id: string;
  status: HistoricalScanStatus;
  startedAt: number;
  updatedAt: number;
  eligibleTotal: number;
  processedCount: number;
  pendingReviewCount: number;
  failedCount: number;
  skippedCount: number;
  coveredIds: string[];
  forceOrganize: boolean;
  lastError?: string;
}

export type ActivityKind =
  | 'received'
  | 'moved'
  | 'review_created'
  | 'review_approved'
  | 'review_rejected'
  | 'kept'
  | 'failed'
  | 'skipped'
  | 'undone';

export interface ActivityRecord {
  id: string;
  kind: ActivityKind;
  bookmarkId?: string;
  title: string;
  url?: string;
  message: string;
  at: number;
  source?: ClassificationSource;
  fromFolderId?: string;
  toFolderId?: string;
}

export interface CacheEntry {
  key: string;
  result: ClassificationResult;
  source: 'cache' | 'ai';
  createdAt: number;
}

export interface UndoRecord {
  bookmarkId: string;
  title: string;
  fromFolderId: string;
  toFolderId: string;
  movedAt: number;
  operationId: string;
}

export interface PendingOperation extends UndoRecord {
  state: 'prepared';
  kind: 'automatic' | 'review' | 'undo';
  reviewId?: string;
  scanId?: string;
}

export interface HistoricalBatchUndoRecord {
  scanId: string;
  moved: UndoRecord[];
  createdAt: number;
}

export interface PersistedState {
  version: 1;
  smartBookmarkRootId?: string;
  smartBookmarkInitialized: boolean;
  settings: Settings;
  jobs: Record<string, BookmarkJob>;
  reviews: Record<string, ReviewItem>;
  cache: Record<string, CacheEntry>;
  activities: ActivityRecord[];
  lastUndo?: UndoRecord;
  undoStack: UndoRecord[];
  pendingOperation?: PendingOperation;
  importStartedAt?: number;
  settingsDraft?: SettingsDraft;
  historicalScan?: HistoricalScanState;
  lastHistoricalUndo?: HistoricalBatchUndoRecord;
  bookmarkMetadata: Record<string, BookmarkMetadata>;
  corrections: Record<string, CorrectionEntry>;
}

export interface HistoricalScanSummary extends Omit<HistoricalScanState, 'coveredIds' | 'forceOrganize'> {
  hasUndo: boolean;
}

export interface DashboardState {
  settings: PublicSettings;
  pendingReviews: ReviewItem[];
  historicalReviews: ReviewItem[];
  recentJobs: BookmarkJob[];
  activities: ActivityRecord[];
  awaitingConfigurationCount: number;
  awaitingPermissionCount: number;
  lastUndo?: UndoRecord;
  undoStackCount: number;
  folders: Array<{ id: string; path: string }>;
  aiStatus: 'configured' | 'missing-key' | 'permission-needed';
  historicalScan?: HistoricalScanSummary;
  historicalUndoAvailable: boolean;
}

export interface ClassifiedResult {
  result: ClassificationResult;
  source: ClassificationSource;
}

export const emptyPersistedState = (): PersistedState => ({
  version: 1,
  smartBookmarkInitialized: false,
  settings: { ...DEFAULT_SETTINGS },
  jobs: {},
  reviews: {},
  cache: {},
  activities: [],
  undoStack: [],
  historicalScan: undefined,
  corrections: {},
  bookmarkMetadata: {},
});
