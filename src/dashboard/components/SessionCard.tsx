import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { send } from '../../lib/messaging';
import { softDelete, tabCount, updateSession } from '../../lib/sessions';
import { db } from '../../lib/db';
import { assignToWorkspace } from '../../lib/workspaces';
import type { SavedTab, Session } from '../../lib/types';
import { shareableText } from '../../lib/suspend';
import { ScheduleDialog } from './ScheduleDialog';

export function SessionCard({ session, onToast }: { session: Session; onToast: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(session.name);
  const [aiBusy, setAiBusy] = useState(false);
  const [scheduling, setScheduling] = useState(false);

  const workspaces = useLiveQuery(() => db.workspaces.toArray(), [], []);
  const scheduled = useLiveQuery(() => db.schedules.where('sessionId').equals(session.id).count(), [session.id], 0);
  const grouped = groupTabs(session);

  async function renameCommit() {
    setEditing(false);
    if (name.trim() && name !== session.name) await updateSession(session.id, { name: name.trim() });
  }

  async function aiGroup() {
    setAiBusy(true);
    try {
      await send({ type: 'AI_GROUP_SESSION', sessionId: session.id });
      onToast('AI grouped ✓');
      setOpen(true);
    } catch (e: any) {
      onToast(e.message);
    } finally {
      setAiBusy(false);
    }
  }

  async function copyShare() {
    const urls = session.windows.flatMap((w) => w.tabs).map((t) => ({ title: t.title, url: t.url }));
    await navigator.clipboard.writeText(shareableText(session.name, urls));
    onToast('Copied share text ✓');
  }

  async function addTag() {
    const tag = prompt('Add tag')?.trim().toLowerCase();
    if (tag) await updateSession(session.id, { tags: Array.from(new Set([...session.tags, tag])) });
  }

  return (
    <div className="card p-4">
      <div className="flex items-start gap-3">
        <button className="mt-0.5 text-vault-muted hover:text-white" onClick={() => setOpen((o) => !o)} title="Expand">
          {open ? '▾' : '▸'}
        </button>
        <button
          className={`mt-0.5 ${session.favorite ? 'text-amber-400' : 'text-vault-muted hover:text-white'}`}
          onClick={() => updateSession(session.id, { favorite: !session.favorite })}
          title={session.favorite ? 'Unpin' : 'Pin to top'}
        >
          {session.favorite ? '★' : '☆'}
        </button>
        <div className="flex-1 min-w-0">
          {editing ? (
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={renameCommit} onKeyDown={(e) => e.key === 'Enter' && renameCommit()} />
          ) : (
            <h3 className="font-semibold truncate cursor-text" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
              {session.name}
            </h3>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-vault-muted">
            <span className="chip">{tabCount(session)} tabs</span>
            <span className="chip">{session.windows.length} win</span>
            <KindBadge kind={session.kind} />
            <span>{new Date(session.createdAt).toLocaleString()}</span>
            {session.tags.map((t) => (
              <span key={t} className="chip">#{t}</span>
            ))}
            <button className="chip hover:text-white" onClick={addTag}>+ tag</button>
            <select
              className="chip bg-vault-panel cursor-pointer"
              value={session.workspaceId ?? ''}
              onChange={(e) => assignToWorkspace(session.id, e.target.value || undefined)}
              title="Workspace"
            >
              <option value="">— no workspace —</option>
              {workspaces?.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
            {scheduled ? <span className="chip text-emerald-400">⏰ scheduled</span> : null}
            {session.live ? <span className="chip text-emerald-400">● live</span> : null}
          </div>
          {session.summary && <p className="mt-2 text-sm text-vault-muted italic">{session.summary}</p>}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn-primary" onClick={() => send({ type: 'RESTORE_SESSION', sessionId: session.id, newWindow: true })}>Restore ↗</button>
        <button className="btn-ghost border border-vault-border" onClick={() => send({ type: 'RESTORE_SESSION', sessionId: session.id, newWindow: false })}>Restore here</button>
        <button className="btn-ghost border border-vault-border" disabled={aiBusy} onClick={aiGroup}>{aiBusy ? 'Grouping…' : '✨ AI group'}</button>
        <button className="btn-ghost border border-vault-border" onClick={copyShare}>Share</button>
        <button className="btn-ghost border border-vault-border" onClick={() => setScheduling(true)}>⏰ Schedule</button>
        <button className="btn-ghost border border-vault-border" onClick={() => setEditing(true)}>Rename</button>
        <button className="btn-ghost border border-vault-border text-red-400 hover:bg-red-500/10" onClick={async () => { await softDelete(session.id); onToast('Deleted (undo in Trash)'); }}>Delete</button>
      </div>

      {open && (
        <div className="mt-3 space-y-3 border-t border-vault-border pt-3">
          {grouped.map(({ group, tabs }) => (
            <div key={group}>
              {group !== '__none__' && <div className="text-xs font-semibold uppercase tracking-wide text-vault-accent2 mb-1">{group}</div>}
              <ul className="space-y-0.5">
                {tabs.map((t, i) => (
                  <li key={i}>
                    <button
                      className="w-full flex items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-vault-panel"
                      onClick={() => send({ type: 'RESTORE_TAB', url: t.url })}
                      title={t.url}
                    >
                      <img src={t.favIconUrl || ''} alt="" className="h-4 w-4 shrink-0 rounded" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
                      <span className="truncate">{t.title || t.url}</span>
                      <span className="ml-auto truncate text-xs text-vault-muted max-w-[40%]">{hostOf(t.url)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <button className="text-xs text-vault-muted hover:text-white" onClick={async () => {
            const url = prompt('Add a tab URL to this session');
            if (url && /^https?:/.test(url)) {
              const s = await db.sessions.get(session.id);
              if (s) { s.windows[0]?.tabs.push({ url, title: url }); await updateSession(session.id, { windows: s.windows }); }
            }
          }}>+ add tab</button>
        </div>
      )}

      {scheduling && <ScheduleDialog session={session} onClose={() => setScheduling(false)} />}
    </div>
  );
}

function groupTabs(s: Session): { group: string; tabs: SavedTab[] }[] {
  const map = new Map<string, SavedTab[]>();
  for (const w of s.windows) for (const t of w.tabs) {
    const g = t.groupTitle || '__none__';
    map.set(g, [...(map.get(g) ?? []), t]);
  }
  // ungrouped last
  return [...map.entries()].sort((a) => (a[0] === '__none__' ? 1 : -1)).map(([group, tabs]) => ({ group, tabs }));
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function KindBadge({ kind }: { kind: Session['kind'] }) {
  const map: Record<Session['kind'], string> = { manual: 'manual', auto: 'auto', crash: 'recovered', imported: 'imported' };
  const color: Record<Session['kind'], string> = {
    manual: 'text-vault-accent', auto: 'text-emerald-400', crash: 'text-amber-400', imported: 'text-sky-400',
  };
  return <span className={`chip ${color[kind]}`}>{map[kind]}</span>;
}
