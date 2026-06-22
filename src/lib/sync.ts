import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { db } from './db';
import type { Session, SyncResult } from './types';
import { getSettings, saveSettings } from './settings';
import { decryptJson, encryptJson, isEncrypted, type Encrypted } from './crypto';
import { meshSync } from './mesh';

export type { SyncResult };

/**
 * Local-first cloud sync. The local IndexedDB is the source of truth; the
 * cloud is a mirror/backup that also fans changes out to other devices.
 *
 * Conflict policy: last-write-wins by (rev, updatedAt). Payloads are optionally
 * end-to-end encrypted so the provider stores opaque blobs.
 *
 * Expected Supabase table (see README for SQL):
 *   create table sessions (
 *     id text primary key,
 *     owner uuid default auth.uid(),
 *     rev int not null,
 *     updated_at bigint not null,
 *     deleted boolean default false,
 *     payload jsonb not null
 *   );
 */

let client: SupabaseClient | null = null;
let clientKey = '';

async function getClient(): Promise<SupabaseClient | null> {
  const { sync } = await getSettings();
  if (sync.provider !== 'supabase' || !sync.supabaseUrl || !sync.supabaseAnonKey) return null;
  const key = `${sync.supabaseUrl}|${sync.supabaseAnonKey}`;
  if (!client || clientKey !== key) {
    client = createClient(sync.supabaseUrl, sync.supabaseAnonKey, {
      auth: { persistSession: true, storageKey: 'sessflow-auth' },
    });
    clientKey = key;
  }
  return client;
}

interface RemoteRow {
  id: string;
  rev: number;
  updated_at: number;
  deleted: boolean;
  payload: Session | Encrypted;
}

export async function syncNow(): Promise<SyncResult> {
  const { sync } = await getSettings();
  // Self-hosted Tailscale mesh provider has its own adapter.
  if (sync.provider === 'mesh') return meshSync();

  const supabase = await getClient();
  if (!supabase) return { pushed: 0, pulled: 0, conflicts: 0, ok: false, error: 'Sync not configured.' };

  const settings = await getSettings();
  const pass = settings.sync.e2ePassphrase;

  try {
    // 1) PULL — fetch everything changed since last sync.
    const since = settings.sync.lastSyncedAt ?? 0;
    const { data: rows, error } = await supabase
      .from('sessions')
      .select('id,rev,updated_at,deleted,payload')
      .gt('updated_at', since);
    if (error) throw error;

    let pulled = 0;
    let conflicts = 0;
    for (const row of (rows ?? []) as RemoteRow[]) {
      const local = await db.sessions.get(row.id);
      const incoming = await decodeRow(row, pass);
      if (!local || row.rev > local.rev || (row.rev === local.rev && row.updated_at > local.updatedAt)) {
        if (row.deleted) {
          if (local) await db.sessions.put({ ...local, deletedAt: row.updated_at, dirty: false });
        } else if (incoming) {
          await db.sessions.put({ ...incoming, remoteId: row.id, dirty: false });
          pulled++;
        }
      } else if (local.dirty && local.rev < row.rev) {
        conflicts++;
      }
    }

    // 2) PUSH — upload every dirty local session.
    const dirty = await db.sessions.filter((s) => !!s.dirty).toArray();
    let pushed = 0;
    if (dirty.length) {
      const payloads = await Promise.all(
        dirty.map(async (s) => ({
          id: s.id,
          rev: s.rev,
          updated_at: s.updatedAt,
          deleted: !!s.deletedAt,
          payload: pass ? await encryptJson(stripLocal(s), pass) : stripLocal(s),
        })),
      );
      const { error: upErr } = await supabase.from('sessions').upsert(payloads, { onConflict: 'id' });
      if (upErr) throw upErr;
      // mark clean
      await db.transaction('rw', db.sessions, async () => {
        for (const s of dirty) await db.sessions.update(s.id, { dirty: false, remoteId: s.id });
      });
      pushed = dirty.length;
    }

    await saveSettings({ sync: { ...settings.sync, lastSyncedAt: Date.now() } });
    return { pushed, pulled, conflicts, ok: true };
  } catch (e: any) {
    return { pushed: 0, pulled: 0, conflicts: 0, ok: false, error: e?.message ?? String(e) };
  }
}

async function decodeRow(row: RemoteRow, pass?: string): Promise<Session | null> {
  if (isEncrypted(row.payload)) {
    if (!pass) return null; // can't read encrypted blob without passphrase
    try {
      return await decryptJson<Session>(row.payload, pass);
    } catch {
      return null;
    }
  }
  return row.payload as Session;
}

/** Drop sync-only bookkeeping before upload. */
function stripLocal(s: Session): Session {
  const { dirty, remoteId, ...rest } = s;
  void dirty;
  void remoteId;
  return rest as Session;
}

// ---- auth helpers (email magic-link / password) ----
export async function signIn(email: string, password: string) {
  const supabase = await getClient();
  if (!supabase) throw new Error('Sync not configured.');
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signUp(email: string, password: string) {
  const supabase = await getClient();
  if (!supabase) throw new Error('Sync not configured.');
  return supabase.auth.signUp({ email, password });
}

export async function signOut() {
  const supabase = await getClient();
  await supabase?.auth.signOut();
}

export async function currentUser() {
  const supabase = await getClient();
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  return data.user;
}
