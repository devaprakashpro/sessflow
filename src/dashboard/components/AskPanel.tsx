import { useEffect, useState } from 'react';
import { getSettings } from '../../lib/settings';
import { meshAsk, meshHealth, meshSearch, meshStats, type AskAnswer, type SearchHit } from '../../lib/mesh';
import { send } from '../../lib/messaging';

type Mode = 'search' | 'ask';

/**
 * Search & ask-your-tabs over the Mesh server's page archive.
 * - search: FTS5 full-text over archived page bodies.
 * - ask:    RAG — server retrieves relevant pages and answers via Claude.
 */
export function AskPanel({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('search');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);
  const [stats, setStats] = useState<{ sessions: number; archived: number; queued: number } | null>(null);

  useEffect(() => {
    (async () => {
      const { sync } = await getSettings();
      if (sync.provider !== 'mesh' || !sync.meshUrl) {
        setReady(false);
        return;
      }
      const h = await meshHealth();
      setReady(h.ok);
      if (h.ok) meshStats().then(setStats).catch(() => {});
    })();
  }, []);

  async function run() {
    if (!q.trim()) return;
    setBusy(true);
    setError('');
    setAnswer(null);
    setHits([]);
    try {
      if (mode === 'search') setHits(await meshSearch(q));
      else setAnswer(await meshAsk(q));
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[8vh]" onClick={onClose}>
      <div className="card w-full max-w-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-vault-border bg-vault-panel px-4 py-3">
          <div className="flex rounded-md border border-vault-border overflow-hidden text-sm">
            <button className={`px-3 py-1.5 ${mode === 'search' ? 'bg-vault-accent text-white' : 'text-vault-muted'}`} onClick={() => setMode('search')}>Search</button>
            <button className={`px-3 py-1.5 ${mode === 'ask' ? 'bg-vault-accent text-white' : 'text-vault-muted'}`} onClick={() => setMode('ask')}>Ask AI</button>
          </div>
          <input
            className="input flex-1"
            autoFocus
            placeholder={mode === 'search' ? 'Search your archived pages…' : 'Ask a question about everything you’ve saved…'}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
          />
          <button className="btn-primary" disabled={busy} onClick={run}>{busy ? '…' : 'Go'}</button>
          <button className="btn-ghost" onClick={onClose}>✕</button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-4 space-y-3">
          {ready === false && (
            <div className="text-sm text-vault-muted">
              This feature needs the <b>Mesh server</b>. Set it up in Settings → Cloud sync → Mesh; it archives your
              saved pages and powers search + AI.
            </div>
          )}
          {ready && stats && (
            <div className="text-xs text-vault-muted">
              {stats.archived} pages archived{stats.queued > 0 ? ` · ${stats.queued} queued` : ''} · {stats.sessions} sessions
            </div>
          )}
          {error && <div className="text-sm text-red-400">{error}</div>}

          {mode === 'search' &&
            hits.map((h) => (
              <button key={h.hash} className="card w-full p-3 text-left hover:border-vault-accent" onClick={() => send({ type: 'RESTORE_TAB', url: h.url })}>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate text-white">{h.title || h.url}</span>
                  <span className="chip ml-auto shrink-0">{h.site}</span>
                </div>
                <div className="mt-1 text-xs text-vault-muted line-clamp-2" dangerouslySetInnerHTML={{ __html: highlight(h.snippet) }} />
              </button>
            ))}
          {mode === 'search' && !busy && hits.length === 0 && q && !error && (
            <div className="text-sm text-vault-muted">No matches in your archive yet.</div>
          )}

          {mode === 'ask' && answer && (
            <div className="space-y-3">
              <div className="card p-3 text-sm whitespace-pre-wrap leading-relaxed">{answer.answer}</div>
              {answer.citations.length > 0 && (
                <div>
                  <div className="text-xs uppercase tracking-wide text-vault-muted mb-1">Sources</div>
                  <ol className="space-y-1 text-sm list-decimal list-inside">
                    {answer.citations.map((c, i) => (
                      <li key={i}>
                        <button className="text-vault-accent2 hover:underline" onClick={() => send({ type: 'RESTORE_TAB', url: c.url })}>{c.title || c.url}</button>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Render FTS5 «…» markers as highlights, escaping the rest. */
function highlight(s: string): string {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/«/g, '<mark class="bg-vault-accent/40 text-white rounded px-0.5">').replace(/»/g, '</mark>');
}
