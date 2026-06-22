import { useEffect, useMemo, useState } from 'react';
import { Command } from 'cmdk';
import { makeTabIndex, type TabHit } from '../../lib/search';
import { send } from '../../lib/messaging';
import type { Session } from '../../lib/types';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sessions: Session[];
  onAction: (a: { type: 'saveWindow' | 'saveAll' | 'sync' | 'settings' | 'restore'; sessionId?: string }) => void;
}

/** Cmd/Ctrl-K palette: fuzzy search across every saved tab + quick commands. */
export function CommandPalette({ open, onOpenChange, sessions, onAction }: Props) {
  const [query, setQuery] = useState('');
  const index = useMemo(() => makeTabIndex(sessions), [sessions]);
  const hits: TabHit[] = useMemo(
    () => (query ? index.search(query).slice(0, 40).map((r) => r.item) : []),
    [query, index],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[12vh]" onClick={() => onOpenChange(false)}>
      <div className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
        <Command className="card overflow-hidden shadow-2xl" shouldFilter={false} loop>
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search tabs, or type a command…"
            className="w-full bg-vault-panel px-4 py-3 text-base text-white placeholder:text-vault-muted focus:outline-none border-b border-vault-border"
          />
          <Command.List className="max-h-[55vh] overflow-y-auto p-1.5">
            <Command.Empty className="px-3 py-6 text-center text-sm text-vault-muted">
              No matches.
            </Command.Empty>

            {!query && (
              <Command.Group heading="Actions" className="text-xs text-vault-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1">
                <Item onSelect={() => { onAction({ type: 'saveWindow' }); onOpenChange(false); }}>💾 Save this window</Item>
                <Item onSelect={() => { onAction({ type: 'saveAll' }); onOpenChange(false); }}>🗂️ Save all windows</Item>
                <Item onSelect={() => { onAction({ type: 'sync' }); onOpenChange(false); }}>☁️ Sync now</Item>
                <Item onSelect={() => { onAction({ type: 'settings' }); onOpenChange(false); }}>⚙️ Open settings</Item>
              </Command.Group>
            )}

            {hits.length > 0 && (
              <Command.Group heading={`Tabs (${hits.length})`} className="text-xs text-vault-muted [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1">
                {hits.map((h, i) => (
                  <Command.Item
                    key={`${h.session.id}-${i}`}
                    value={`${h.tab.title} ${h.tab.url} ${i}`}
                    onSelect={() => { send({ type: 'RESTORE_TAB', url: h.tab.url }); onOpenChange(false); }}
                    className="flex items-center gap-2 rounded-md px-2 py-2 text-sm aria-selected:bg-vault-card cursor-pointer"
                  >
                    <img src={h.tab.favIconUrl || ''} alt="" className="h-4 w-4 shrink-0 rounded" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
                    <span className="truncate text-white">{h.tab.title || h.tab.url}</span>
                    <span className="ml-auto shrink-0 chip">{h.session.name}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
          <div className="border-t border-vault-border px-3 py-1.5 text-[11px] text-vault-muted flex gap-3">
            <span>↵ open</span><span>esc close</span><span>⌘K toggle</span>
          </div>
        </Command>
      </div>
    </div>
  );
}

function Item({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) {
  return (
    <Command.Item onSelect={onSelect} className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-white aria-selected:bg-vault-card cursor-pointer">
      {children}
    </Command.Item>
  );
}
