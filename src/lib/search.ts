import Fuse from 'fuse.js';
import type { SavedTab, Session } from './types';

export interface TabHit {
  session: Session;
  windowIndex: number;
  tab: SavedTab;
}

/** Flatten all sessions to a searchable list of tab-level records. */
export function flattenTabs(sessions: Session[]): TabHit[] {
  const out: TabHit[] = [];
  for (const session of sessions) {
    session.windows.forEach((w, windowIndex) => {
      for (const tab of w.tabs) out.push({ session, windowIndex, tab });
    });
  }
  return out;
}

export function makeTabIndex(sessions: Session[]): Fuse<TabHit> {
  return new Fuse(flattenTabs(sessions), {
    includeScore: true,
    threshold: 0.4,
    ignoreLocation: true,
    keys: [
      { name: 'tab.title', weight: 0.5 },
      { name: 'tab.url', weight: 0.3 },
      { name: 'tab.excerpt', weight: 0.1 },
      { name: 'session.name', weight: 0.1 },
    ],
  });
}

export function makeSessionIndex(sessions: Session[]): Fuse<Session> {
  return new Fuse(sessions, {
    includeScore: true,
    threshold: 0.4,
    ignoreLocation: true,
    keys: ['name', 'tags', 'summary'],
  });
}

export function allTags(sessions: Session[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const s of sessions) for (const t of s.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}
