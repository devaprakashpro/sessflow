import { db } from './db';
import { getSettings, saveSettings } from './settings';
import type { Session, SyncResult } from './types';

/**
 * Sessflow Mesh adapter — talks to the self-hosted server running on the user's
 * Tailscale node. Local-first, last-write-wins. Payloads are sent in plaintext
 * (it's the user's own machine, and the server needs URLs to archive pages).
 */

interface RemoteRow {
  id: string;
  rev: number;
  updated_at: number;
  deleted: boolean;
  payload: Session;
}

function endpoint(path: string, base: string): string {
  return base.replace(/\/+$/, '') + path;
}

async function meshFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { sync } = await getSettings();
  const base = sync.meshUrl?.trim();
  const token = sync.meshToken?.trim();
  if (!base || !token) throw new Error('Mesh server not configured.');
  const res = await fetch(endpoint(path, base), {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Mesh ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
  return res.json() as Promise<T>;
}

export async function meshHealth(): Promise<{ ok: boolean; ai?: boolean }> {
  const { sync } = await getSettings();
  const base = sync.meshUrl?.trim();
  if (!base) return { ok: false };
  try {
    const res = await fetch(endpoint('/health', base));
    return res.ok ? await res.json() : { ok: false };
  } catch {
    return { ok: false };
  }
}

export async function meshSync(): Promise<SyncResult> {
  try {
    const settings = await getSettings();
    const since = settings.sync.lastSyncedAt ?? 0;

    const dirty = await db.sessions.filter((s) => !!s.dirty).toArray();
    const sessions = dirty.map((s) => ({
      id: s.id,
      rev: s.rev,
      updated_at: s.updatedAt,
      deleted: !!s.deletedAt,
      payload: stripLocal(s),
    }));

    const out = await meshFetch<{ ok: boolean; pushed: number; changed: RemoteRow[]; now: number }>(
      '/v1/sync',
      { method: 'POST', body: JSON.stringify({ since, sessions }) },
    );

    // apply pulled changes (LWW)
    let pulled = 0;
    let conflicts = 0;
    for (const row of out.changed ?? []) {
      const local = await db.sessions.get(row.id);
      if (!local || row.rev > local.rev || (row.rev === local.rev && row.updated_at > local.updatedAt)) {
        if (row.deleted) {
          if (local) await db.sessions.put({ ...local, deletedAt: row.updated_at, dirty: false });
        } else {
          await db.sessions.put({ ...row.payload, remoteId: row.id, dirty: false });
          pulled++;
        }
      } else if (local.dirty && local.rev < row.rev) {
        conflicts++;
      }
    }

    // mark pushed rows clean
    if (dirty.length) {
      await db.transaction('rw', db.sessions, async () => {
        for (const s of dirty) await db.sessions.update(s.id, { dirty: false, remoteId: s.id });
      });
    }

    await saveSettings({ sync: { ...settings.sync, lastSyncedAt: out.now ?? Date.now() } });
    return { pushed: dirty.length, pulled, conflicts, ok: true };
  } catch (e: any) {
    return { pushed: 0, pulled: 0, conflicts: 0, ok: false, error: e?.message ?? String(e) };
  }
}

// ---- AI search + ask, served by the mesh archive ----
export interface SearchHit {
  url: string;
  title: string;
  site: string;
  snippet: string;
  hash: string;
}

export async function meshSearch(query: string): Promise<SearchHit[]> {
  const { results } = await meshFetch<{ results: SearchHit[] }>(
    `/v1/search?q=${encodeURIComponent(query)}`,
  );
  return results;
}

export interface AskAnswer {
  answer: string;
  citations: { url: string; title: string }[];
}

export async function meshAsk(question: string): Promise<AskAnswer> {
  return meshFetch<AskAnswer>('/v1/ask', { method: 'POST', body: JSON.stringify({ question }) });
}

export async function meshStats(): Promise<{ sessions: number; archived: number; queued: number }> {
  return meshFetch('/v1/stats');
}

export function meshPageUrl(hash: string, base: string, token: string): string {
  // server requires the bearer token; opened via fetch+blob in the UI rather than a raw link
  void token;
  return endpoint(`/v1/page/${hash}`, base);
}

function stripLocal(s: Session): Session {
  const { dirty, remoteId, ...rest } = s;
  void dirty;
  void remoteId;
  return rest as Session;
}
