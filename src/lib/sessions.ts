import { nanoid } from 'nanoid';
import browser from './browser';
import { db } from './db';
import type { SavedTab, SavedWindow, Session, SessionKind } from './types';

const SKIP_PREFIXES = ['chrome://', 'edge://', 'about:', 'chrome-extension://', 'moz-extension://'];
const SUSPENDED_MARKER = '/src/suspended/index.html';

function isRestorableUrl(url: string | undefined): url is string {
  if (!url) return false;
  return !SKIP_PREFIXES.some((p) => url.startsWith(p));
}

/** Unwrap a suspended-tab URL back to the real target so saves stay clean. */
export function realUrl(url: string): string {
  if (url.includes(SUSPENDED_MARKER)) {
    try {
      const u = new URL(url);
      const target = u.searchParams.get('u');
      if (target) return decodeURIComponent(target);
    } catch {
      /* ignore */
    }
  }
  return url;
}

async function groupTitleMap(): Promise<Map<number, { title: string; color: string }>> {
  const map = new Map<number, { title: string; color: string }>();
  try {
    // tabGroups may be unavailable on older Firefox — guard it.
    if ((browser as any).tabGroups?.query) {
      const groups = await (browser as any).tabGroups.query({});
      for (const g of groups) map.set(g.id, { title: g.title ?? '', color: g.color ?? 'grey' });
    }
  } catch {
    /* no group support */
  }
  return map;
}

function tabToSaved(t: browser.Tabs.Tab, groups: Map<number, { title: string; color: string }>): SavedTab | null {
  const url = realUrl(t.url ?? (t as any).pendingUrl ?? '');
  if (!isRestorableUrl(url)) return null;
  const groupId = (t as any).groupId as number | undefined;
  const grp = groupId != null && groupId !== -1 ? groups.get(groupId) : undefined;
  return {
    url,
    title: t.title ?? url,
    favIconUrl: t.favIconUrl,
    pinned: t.pinned,
    groupTitle: grp?.title || undefined,
    groupColor: grp?.color,
  };
}

/** Capture the current browser layout into SavedWindow[]. */
export async function captureWindows(opts: { currentOnly: boolean }): Promise<SavedWindow[]> {
  const groups = await groupTitleMap();
  const wins = await browser.windows.getAll({ populate: true });
  const currentWin = opts.currentOnly ? await browser.windows.getCurrent() : null;

  const result: SavedWindow[] = [];
  for (const w of wins) {
    if (w.type !== 'normal') continue;
    if (currentWin && w.id !== currentWin.id) continue;
    const tabs = (w.tabs ?? [])
      .map((t) => tabToSaved(t, groups))
      .filter((t): t is SavedTab => t !== null);
    if (tabs.length === 0) continue;
    result.push({ id: nanoid(8), incognito: w.incognito, focused: w.focused, tabs });
  }
  return result;
}

/** Capture a single window by id (used for auto-save-on-close caching). */
export async function captureWindow(windowId: number): Promise<SavedWindow | null> {
  const groups = await groupTitleMap();
  const w = await browser.windows.get(windowId, { populate: true });
  if (w.type !== 'normal') return null;
  const tabs = (w.tabs ?? [])
    .map((t) => tabToSaved(t, groups))
    .filter((t): t is SavedTab => t !== null);
  if (tabs.length === 0) return null;
  return { id: nanoid(8), incognito: w.incognito, focused: w.focused, tabs };
}

function defaultName(windows: SavedWindow[]): string {
  const count = windows.reduce((n, w) => n + w.tabs.length, 0);
  const d = new Date();
  const stamp = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return `${count} tab${count === 1 ? '' : 's'} — ${stamp}`;
}

export async function createSession(
  windows: SavedWindow[],
  opts: { name?: string; kind?: SessionKind; tags?: string[] } = {},
): Promise<Session> {
  const now = Date.now();
  const session: Session = {
    id: nanoid(),
    name: opts.name?.trim() || defaultName(windows),
    kind: opts.kind ?? 'manual',
    createdAt: now,
    updatedAt: now,
    windows,
    tags: opts.tags ?? [],
    rev: 1,
    dirty: true,
  };
  await db.sessions.put(session);
  return session;
}

export async function saveCurrentWindow(name?: string): Promise<Session> {
  const windows = await captureWindows({ currentOnly: true });
  return createSession(windows, { name, kind: 'manual' });
}

export async function saveAllWindows(name?: string): Promise<Session> {
  const windows = await captureWindows({ currentOnly: false });
  return createSession(windows, { name, kind: 'manual' });
}

export async function listSessions(includeDeleted = false): Promise<Session[]> {
  const all = await db.sessions.orderBy('updatedAt').reverse().toArray();
  return includeDeleted ? all : all.filter((s) => !s.deletedAt);
}

export async function getSession(id: string): Promise<Session | undefined> {
  return db.sessions.get(id);
}

export async function updateSession(id: string, patch: Partial<Session>): Promise<void> {
  const s = await db.sessions.get(id);
  if (!s) return;
  await db.sessions.put({ ...s, ...patch, updatedAt: Date.now(), rev: s.rev + 1, dirty: true });
}

export async function softDelete(id: string): Promise<void> {
  await updateSession(id, { deletedAt: Date.now() });
}

export async function restore(id: string, asNewWindow = true): Promise<void> {
  const s = await db.sessions.get(id);
  if (!s) return;
  for (const w of s.windows) {
    const urls = w.tabs.map((t) => t.url);
    if (urls.length === 0) continue;
    if (asNewWindow) {
      await browser.windows.create({ url: urls, incognito: false });
    } else {
      for (const t of w.tabs) await browser.tabs.create({ url: t.url, pinned: t.pinned });
    }
  }
}

/** Open all of a session's tabs into ONE new window and return its id (for live re-binding). */
export async function restoreToWindow(id: string): Promise<number | undefined> {
  const s = await db.sessions.get(id);
  if (!s) return undefined;
  const urls = s.windows.flatMap((w) => w.tabs.map((t) => t.url));
  if (urls.length === 0) return undefined;
  const win = await browser.windows.create({ url: urls, incognito: false });
  return win.id;
}

/** Find duplicate tabs across all open windows. Returns groups keyed by URL. */
export async function findDuplicates(): Promise<{ url: string; tabIds: number[] }[]> {
  const tabs = await browser.tabs.query({});
  const byUrl = new Map<string, number[]>();
  for (const t of tabs) {
    const u = realUrl(t.url ?? '');
    if (!isRestorableUrl(u) || t.id == null) continue;
    byUrl.set(u, [...(byUrl.get(u) ?? []), t.id]);
  }
  return [...byUrl.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([url, tabIds]) => ({ url, tabIds }));
}

export function tabCount(s: Session): number {
  return s.windows.reduce((n, w) => n + w.tabs.length, 0);
}
