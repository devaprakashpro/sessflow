import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import browser from '../lib/browser';
import { db } from '../lib/db';
import { send, openDashboard } from '../lib/messaging';
import { tabCount } from '../lib/sessions';
import type { LiveStatus, Session } from '../lib/types';

export function Popup() {
  const [openTabs, setOpenTabs] = useState(0);
  const [openWindows, setOpenWindows] = useState(0);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [winId, setWinId] = useState<number | undefined>();
  const [live, setLive] = useState<LiveStatus>({ sessionId: null, name: null });

  const recent = useLiveQuery(
    async () =>
      (await db.sessions.orderBy('updatedAt').reverse().limit(5).toArray()).filter((s) => !s.deletedAt),
    [],
    [] as Session[],
  );

  useEffect(() => {
    (async () => {
      const wins = await browser.windows.getAll({ populate: true });
      const normal = wins.filter((w) => w.type === 'normal');
      setOpenWindows(normal.length);
      setOpenTabs(normal.reduce((n, w) => n + (w.tabs?.length ?? 0), 0));
      const cur = await browser.windows.getCurrent();
      setWinId(cur.id);
      try {
        setLive(await send<LiveStatus>({ type: 'GET_LIVE_STATUS', windowId: cur.id }));
      } catch {
        /* ignore */
      }
    })();
  }, []);

  async function startLive() {
    setBusy('live');
    try {
      const s = await send<Session>({ type: 'START_LIVE_WINDOW', name, windowId: winId });
      setName('');
      setLive({ sessionId: s.id, name: s.name });
      toast('● Live — this window now auto-syncs');
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function stopLive() {
    if (!live.sessionId) return;
    await send({ type: 'STOP_LIVE', sessionId: live.sessionId });
    setLive({ sessionId: null, name: null });
    toast('Live sync stopped (session kept)');
  }

  const toast = (m: string) => {
    setFlash(m);
    setTimeout(() => setFlash(null), 2200);
  };

  async function save(all: boolean) {
    setBusy(all ? 'all' : 'win');
    try {
      await send(all ? { type: 'SAVE_ALL_WINDOWS', name } : { type: 'SAVE_CURRENT_WINDOW', name });
      setName('');
      toast(all ? 'Saved all windows ✓' : 'Saved this window ✓');
    } catch (e: any) {
      toast(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bg-vault-bg text-white p-3 space-y-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-md bg-gradient-to-br from-vault-accent to-vault-accent2" />
          <span className="font-semibold tracking-tight">Sessflow</span>
        </div>
        <button className="btn-ghost text-xs" onClick={() => openDashboard()}>
          Dashboard ↗
        </button>
      </header>

      <div className="text-xs text-vault-muted">
        {openTabs} tabs · {openWindows} window{openWindows === 1 ? '' : 's'} open
      </div>

      <input
        className="input"
        placeholder="Session name (optional)…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && save(false)}
      />

      <div className="grid grid-cols-2 gap-2">
        <button className="btn-primary justify-center" disabled={busy !== null} onClick={() => save(false)}>
          {busy === 'win' ? 'Saving…' : 'Save window'}
        </button>
        <button className="btn-ghost justify-center border border-vault-border" disabled={busy !== null} onClick={() => save(true)}>
          {busy === 'all' ? 'Saving…' : 'Save all'}
        </button>
      </div>

      {live.sessionId ? (
        <div className="flex items-center justify-between rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2">
          <span className="flex items-center gap-2 text-sm min-w-0">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
            <span className="truncate">Live: <b>{live.name}</b></span>
          </span>
          <button className="btn-ghost text-xs shrink-0" onClick={stopLive}>Stop</button>
        </div>
      ) : (
        <button
          className="btn-ghost w-full justify-center border border-vault-border text-emerald-300 hover:bg-emerald-500/10"
          disabled={busy !== null}
          onClick={startLive}
          title="Keep this window continuously saved & synced on every tab change"
        >
          {busy === 'live' ? 'Starting…' : '● Live-sync this window'}
        </button>
      )}

      <div className="grid grid-cols-3 gap-2 text-xs">
        <QuickAction label="Search" onClick={() => openDashboard('#palette')} />
        <QuickAction label="Duplicates" onClick={async () => {
          const dups = await send<{ url: string; tabIds: number[] }[]>({ type: 'FIND_DUPLICATES' });
          toast(dups.length ? `${dups.length} duplicate URL(s)` : 'No duplicates 🎉');
        }} />
        <QuickAction label="Sync now" onClick={async () => {
          try {
            const r = await send<any>({ type: 'SYNC_NOW' });
            toast(r.ok ? `Synced ↑${r.pushed} ↓${r.pulled}` : r.error);
          } catch (e: any) {
            toast(e.message);
          }
        }} />
      </div>

      <div>
        <div className="text-xs uppercase tracking-wide text-vault-muted mb-1.5">Recent sessions</div>
        <ul className="space-y-1">
          {recent?.length ? (
            recent.map((s) => (
              <li key={s.id}>
                <button
                  className="w-full flex items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-vault-card"
                  onClick={() => send({ type: 'RESTORE_SESSION', sessionId: s.id }).then(() => toast('Restoring…'))}
                  title="Restore in a new window"
                >
                  <span className="truncate text-sm">{s.name}</span>
                  <span className="chip ml-2 shrink-0">{tabCount(s)}</span>
                </button>
              </li>
            ))
          ) : (
            <li className="text-xs text-vault-muted px-2 py-3">No sessions yet — save your first one ↑</li>
          )}
        </ul>
      </div>

      {flash && (
        <div className="text-center text-xs text-vault-accent2 bg-vault-card rounded-md py-1.5">{flash}</div>
      )}
    </div>
  );
}

function QuickAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="card px-2 py-2 hover:border-vault-accent text-vault-muted hover:text-white transition-colors" onClick={onClick}>
      {label}
    </button>
  );
}
