/** A single saved tab. */
export interface SavedTab {
  url: string;
  title: string;
  favIconUrl?: string;
  pinned?: boolean;
  /** chrome.tabGroups group title at save time (for AI / native groups). */
  groupTitle?: string;
  groupColor?: string;
  /** Free-text content snippet for full-text search (optional, opt-in). */
  excerpt?: string;
}

/** A window inside a session — preserves multi-window layouts. */
export interface SavedWindow {
  id: string;
  incognito?: boolean;
  focused?: boolean;
  tabs: SavedTab[];
}

export type SessionKind = 'manual' | 'auto' | 'crash' | 'imported';

export interface Session {
  /** nanoid */
  id: string;
  name: string;
  kind: SessionKind;
  createdAt: number;
  updatedAt: number;
  windows: SavedWindow[];
  tags: string[];
  /** AI-generated one-line summary, if any. */
  summary?: string;
  /** Soft-delete to keep an undo window. */
  deletedAt?: number;
  /** Workspace this session belongs to (undefined = unfiled). */
  workspaceId?: string;
  /** Pinned to the top of its list. */
  favorite?: boolean;
  /** Live session: bound to an open window and auto-updated on every tab change. */
  live?: boolean;
  /** Sync bookkeeping. */
  remoteId?: string;
  /** monotonically increasing local revision for conflict resolution. */
  rev: number;
  /** Whether the local copy has unsynced changes. */
  dirty?: boolean;
}

/** A project grouping of sessions. */
export interface Workspace {
  id: string;
  name: string;
  color: string;
  createdAt: number;
}

/** A scheduled auto-open of a session (e.g. open my "Work" set at 9am weekdays). */
export interface Schedule {
  id: string;
  name: string;
  sessionId: string;
  /** "HH:MM" 24h local time. */
  time: string;
  /** Days of week to fire on: 0=Sun … 6=Sat. Empty = every day. */
  days: number[];
  newWindow: boolean;
  enabled: boolean;
  /** Last fired day-stamp ("YYYY-MM-DD") to avoid double-firing. */
  lastFired?: string;
}

export interface Settings {
  theme: 'dark' | 'light' | 'system';
  /** Auto-save the current window on an interval. */
  autoSave: boolean;
  autoSaveIntervalMin: number;
  /** Auto-save a window's tabs when it is closed. */
  autoSaveOnClose: boolean;
  /** Keep N crash-recovery snapshots. */
  crashSnapshots: number;
  crashSnapshotIntervalMin: number;
  /** AI */
  anthropicApiKey?: string;
  aiModel: string;
  aiEnabled: boolean;
  /** Index page-content excerpts for full-text search (needs scripting). */
  indexContent: boolean;
  /** Tab suspension. */
  suspendEnabled: boolean;
  suspendAfterMin: number;
  suspendNeverDomains: string[];
  /** Cloud sync. */
  sync: SyncConfig;
}

export interface SyncConfig {
  provider: 'none' | 'supabase' | 'mesh';
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  /** Self-hosted Mesh server (e.g. http://laptop.tailnet.ts.net:7777). */
  meshUrl?: string;
  meshToken?: string;
  /** Optional end-to-end passphrase (encrypts payloads before upload — Supabase only). */
  e2ePassphrase?: string;
  autoSync: boolean;
  lastSyncedAt?: number;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: number;
  ok: boolean;
  error?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  autoSave: false,
  autoSaveIntervalMin: 30,
  autoSaveOnClose: false,
  crashSnapshots: 5,
  crashSnapshotIntervalMin: 2,
  anthropicApiKey: '',
  aiModel: 'claude-opus-4-8',
  aiEnabled: false,
  indexContent: false,
  suspendEnabled: false,
  suspendAfterMin: 60,
  suspendNeverDomains: [],
  sync: { provider: 'none', autoSync: false },
};

/** Messages exchanged between UI ↔ background service worker. */
export type Msg =
  | { type: 'SAVE_CURRENT_WINDOW'; name?: string }
  | { type: 'SAVE_ALL_WINDOWS'; name?: string }
  | { type: 'RESTORE_SESSION'; sessionId: string; newWindow?: boolean }
  | { type: 'RESTORE_TAB'; url: string }
  | { type: 'OPEN_DASHBOARD'; query?: string }
  | { type: 'OPEN_PALETTE' }
  | { type: 'AI_GROUP_SESSION'; sessionId: string }
  | { type: 'SYNC_NOW' }
  | { type: 'SUSPEND_TAB'; tabId: number }
  | { type: 'FIND_DUPLICATES' }
  // live sessions — bind the current window to a session that auto-updates
  | { type: 'START_LIVE_WINDOW'; name?: string; windowId?: number }
  | { type: 'STOP_LIVE'; sessionId: string }
  | { type: 'GET_LIVE_STATUS'; windowId?: number };

export interface LiveStatus {
  /** sessionId bound to the caller's current window, or null. */
  sessionId: string | null;
  name: string | null;
}

export interface CurrentTab {
  id?: number;
  url: string;
  title: string;
  favIconUrl?: string;
  active?: boolean;
  windowId?: number;
}
