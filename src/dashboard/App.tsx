import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { send } from '../lib/messaging';
import { allTags, makeSessionIndex } from '../lib/search';
import { exportSessions, importSessions, type ExportFormat } from '../lib/exporter';
import { tabCount } from '../lib/sessions';
import { createWorkspace, deleteWorkspace } from '../lib/workspaces';
import type { Session } from '../lib/types';
import { SessionCard } from './components/SessionCard';
import { CommandPalette } from './components/CommandPalette';
import { SettingsPanel } from './components/SettingsPanel';
import { AskPanel } from './components/AskPanel';

type Filter = { kind: 'all' | Session['kind'] | 'trash'; tag: string | null; workspace: string | null };

export function App() {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>({ kind: 'all', tag: null, workspace: null });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const sessions = useLiveQuery(() => db.sessions.orderBy('updatedAt').reverse().toArray(), [], [] as Session[]) ?? [];
  const workspaces = useLiveQuery(() => db.workspaces.orderBy('createdAt').toArray(), [], []) ?? [];

  // hash routing from background (#palette, #q=...)
  useEffect(() => {
    const apply = () => {
      const h = location.hash;
      if (h.startsWith('#palette')) setPaletteOpen(true);
      else if (h.startsWith('#q=')) setQuery(decodeURIComponent(h.slice(3)));
      else if (h.startsWith('#settings')) setSettingsOpen(true);
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2400); };

  const active = useMemo(() => sessions.filter((s) => (filter.kind === 'trash' ? !!s.deletedAt : !s.deletedAt)), [sessions, filter.kind]);
  const tags = useMemo(() => allTags(active), [active]);

  const filtered = useMemo(() => {
    let list = active;
    if (filter.kind !== 'all' && filter.kind !== 'trash') list = list.filter((s) => s.kind === filter.kind);
    if (filter.workspace) list = list.filter((s) => s.workspaceId === filter.workspace);
    if (filter.tag) list = list.filter((s) => s.tags.includes(filter.tag!));
    if (query.trim()) {
      const idx = makeSessionIndex(list);
      list = idx.search(query).map((r) => r.item);
    } else {
      // favorites first, then most-recent (search results keep relevance order)
      list = [...list].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || b.updatedAt - a.updatedAt);
    }
    return list;
  }, [active, filter, query]);

  const totalTabs = useMemo(() => active.reduce((n, s) => n + tabCount(s), 0), [active]);

  async function doExport(format: ExportFormat) {
    const { filename, mime, data } = exportSessions(active, format);
    const blob = new Blob([data], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function doImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.html,.txt,.csv,.md';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      const imported = importSessions(text, file.name.replace(/\.[^.]+$/, ''));
      if (!imported.length) return flash('Nothing importable found.');
      await db.sessions.bulkPut(imported);
      flash(`Imported ${imported.length} session(s) ✓`);
    };
    input.click();
  }

  return (
    <div className="min-h-screen bg-vault-bg text-white">
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        sessions={active}
        onAction={async (a) => {
          if (a.type === 'saveWindow') { await send({ type: 'SAVE_CURRENT_WINDOW' }); flash('Saved window ✓'); }
          if (a.type === 'saveAll') { await send({ type: 'SAVE_ALL_WINDOWS' }); flash('Saved all ✓'); }
          if (a.type === 'sync') { const r: any = await send({ type: 'SYNC_NOW' }); flash(r.ok ? `Synced ↑${r.pushed} ↓${r.pulled}` : r.error); }
          if (a.type === 'settings') setSettingsOpen(true);
        }}
      />
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {askOpen && <AskPanel onClose={() => setAskOpen(false)} />}

      <header className="sticky top-0 z-30 border-b border-vault-border bg-vault-bg/90 backdrop-blur">
        <div className="mx-auto max-w-5xl px-4 py-3 flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-vault-accent to-vault-accent2" />
            <span className="font-semibold tracking-tight text-lg">Sessflow</span>
          </div>
          <input
            className="input flex-1"
            placeholder="Search sessions & tags…  (press ⌘K for tab search)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') setPaletteOpen(true); }}
          />
          <button className="btn-ghost border border-vault-border" onClick={() => setAskOpen(true)} title="Search & ask your archived tabs">🔮 Ask</button>
          <button className="btn-primary" onClick={async () => { await send({ type: 'SAVE_CURRENT_WINDOW' }); flash('Saved window ✓'); }}>+ Save window</button>
          <button className="btn-ghost border border-vault-border" onClick={() => setSettingsOpen(true)} title="Settings">⚙️</button>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 py-6 grid grid-cols-[200px_1fr] gap-6">
        <aside className="space-y-4">
          <div className="card p-3 space-y-1 text-sm">
            <FilterBtn active={filter.kind === 'all' && !filter.workspace} onClick={() => setFilter({ kind: 'all', tag: null, workspace: null })}>All sessions</FilterBtn>
            <FilterBtn active={filter.kind === 'manual'} onClick={() => setFilter({ kind: 'manual', tag: null, workspace: filter.workspace })}>Manual</FilterBtn>
            <FilterBtn active={filter.kind === 'auto'} onClick={() => setFilter({ kind: 'auto', tag: null, workspace: filter.workspace })}>Auto-saved</FilterBtn>
            <FilterBtn active={filter.kind === 'crash'} onClick={() => setFilter({ kind: 'crash', tag: null, workspace: filter.workspace })}>Recovered</FilterBtn>
            <FilterBtn active={filter.kind === 'imported'} onClick={() => setFilter({ kind: 'imported', tag: null, workspace: filter.workspace })}>Imported</FilterBtn>
            <FilterBtn active={filter.kind === 'trash'} onClick={() => setFilter({ kind: 'trash', tag: null, workspace: null })}>🗑 Trash</FilterBtn>
          </div>

          <div className="card p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs uppercase tracking-wide text-vault-muted">Workspaces</div>
              <button className="text-xs text-vault-accent hover:text-white" onClick={async () => { const name = prompt('Workspace name'); if (name) { const ws = await createWorkspace(name); setFilter((f) => ({ ...f, workspace: ws.id, kind: 'all', tag: null })); } }}>+ new</button>
            </div>
            <div className="space-y-1 text-sm">
              {workspaces.length === 0 && <div className="text-xs text-vault-muted">Group sessions by project.</div>}
              {workspaces.map((w) => (
                <div key={w.id} className="group flex items-center gap-2">
                  <button
                    className={`flex-1 text-left rounded-md px-2 py-1.5 flex items-center gap-2 transition-colors ${filter.workspace === w.id ? 'bg-vault-card text-white' : 'text-vault-muted hover:text-white hover:bg-vault-card/60'}`}
                    onClick={() => setFilter((f) => ({ ...f, workspace: f.workspace === w.id ? null : w.id, kind: 'all', tag: null }))}
                  >
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: w.color }} />
                    <span className="truncate">{w.name}</span>
                  </button>
                  <button className="opacity-0 group-hover:opacity-100 text-xs text-red-400" title="Delete workspace" onClick={async () => { if (confirm(`Delete workspace “${w.name}”? Sessions are kept.`)) { await deleteWorkspace(w.id); if (filter.workspace === w.id) setFilter((f) => ({ ...f, workspace: null })); } }}>✕</button>
                </div>
              ))}
            </div>
          </div>

          {tags.length > 0 && (
            <div className="card p-3">
              <div className="text-xs uppercase tracking-wide text-vault-muted mb-2">Tags</div>
              <div className="flex flex-wrap gap-1.5">
                {tags.map(({ tag, count }) => (
                  <button key={tag} className={`chip hover:text-white ${filter.tag === tag ? 'border-vault-accent text-white' : ''}`} onClick={() => setFilter((f) => ({ ...f, tag: f.tag === tag ? null : tag }))}>
                    #{tag} <span className="opacity-60">{count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="card p-3 space-y-2 text-sm">
            <div className="text-xs uppercase tracking-wide text-vault-muted">Data</div>
            <button className="btn-ghost w-full justify-start" onClick={doImport}>Import…</button>
            <details>
              <summary className="cursor-pointer btn-ghost w-full justify-start">Export…</summary>
              <div className="mt-1 flex flex-col gap-1 pl-2">
                {(['json', 'markdown', 'html', 'csv', 'text'] as ExportFormat[]).map((f) => (
                  <button key={f} className="text-left text-xs text-vault-muted hover:text-white" onClick={() => doExport(f)}>as {f.toUpperCase()}</button>
                ))}
              </div>
            </details>
          </div>

          <div className="text-xs text-vault-muted px-1">{active.length} sessions · {totalTabs} tabs</div>
        </aside>

        <main className="space-y-3">
          {filter.kind === 'trash' && filtered.length > 0 && (
            <div className="text-xs text-vault-muted">Deleted sessions — restore by re-saving, or empty trash below.</div>
          )}
          {filtered.length === 0 ? (
            <div className="card p-10 text-center text-vault-muted">
              <p className="text-lg mb-1">No sessions here yet</p>
              <p className="text-sm">Hit <b>+ Save window</b> or press <kbd className="chip">Ctrl+Shift+S</kbd> on any window.</p>
            </div>
          ) : (
            filtered.map((s) => <SessionCard key={s.id} session={s} onToast={flash} />)
          )}
        </main>
      </div>

      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 rounded-lg bg-vault-card border border-vault-border px-4 py-2 text-sm shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}

function FilterBtn({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button className={`w-full text-left rounded-md px-2 py-1.5 transition-colors ${active ? 'bg-vault-card text-white' : 'text-vault-muted hover:text-white hover:bg-vault-card/60'}`} onClick={onClick}>
      {children}
    </button>
  );
}
