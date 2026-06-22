import { nanoid } from 'nanoid';
import type { SavedWindow, Session } from './types';
import { tabCount } from './sessions';

export type ExportFormat = 'json' | 'html' | 'csv' | 'text' | 'markdown';

const FILE_HEADER = 'Sessflow Export v1';

export function exportSessions(sessions: Session[], format: ExportFormat): { filename: string; mime: string; data: string } {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  switch (format) {
    case 'json':
      return {
        filename: `sessflow-${stamp}.json`,
        mime: 'application/json',
        data: JSON.stringify({ header: FILE_HEADER, exportedAt: Date.now(), sessions }, null, 2),
      };
    case 'csv':
      return { filename: `sessflow-${stamp}.csv`, mime: 'text/csv', data: toCsv(sessions) };
    case 'html':
      return { filename: `sessflow-${stamp}.html`, mime: 'text/html', data: toHtml(sessions) };
    case 'markdown':
      return { filename: `sessflow-${stamp}.md`, mime: 'text/markdown', data: toMarkdown(sessions) };
    case 'text':
    default:
      return { filename: `sessflow-${stamp}.txt`, mime: 'text/plain', data: toText(sessions) };
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function toText(sessions: Session[]): string {
  return sessions
    .map((s) => {
      const lines = [`# ${s.name} (${tabCount(s)} tabs)`];
      for (const w of s.windows) for (const t of w.tabs) lines.push(t.url);
      return lines.join('\n');
    })
    .join('\n\n');
}

function toMarkdown(sessions: Session[]): string {
  return sessions
    .map((s) => {
      const head = `## ${s.name}\n\n*${tabCount(s)} tabs · ${new Date(s.createdAt).toLocaleString()}*${s.tags.length ? ` · tags: ${s.tags.join(', ')}` : ''}\n`;
      const body = s.windows
        .map((w, i) =>
          [`\n### Window ${i + 1}`, ...w.tabs.map((t) => `- [${t.title}](${t.url})`)].join('\n'),
        )
        .join('\n');
      return head + body;
    })
    .join('\n\n---\n\n');
}

function toCsv(sessions: Session[]): string {
  const rows = [['session', 'window', 'title', 'url', 'tags', 'createdAt']];
  for (const s of sessions)
    s.windows.forEach((w, i) =>
      w.tabs.forEach((t) =>
        rows.push([s.name, String(i + 1), t.title, t.url, s.tags.join('|'), new Date(s.createdAt).toISOString()]),
      ),
    );
  return rows.map((r) => r.map((c) => `"${(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}

function toHtml(sessions: Session[]): string {
  const body = sessions
    .map((s) => {
      const tabs = s.windows
        .flatMap((w) => w.tabs)
        .map((t) => `<li><a href="${esc(t.url)}">${esc(t.title || t.url)}</a></li>`)
        .join('');
      return `<section><h2>${esc(s.name)}</h2><p>${tabCount(s)} tabs · ${new Date(s.createdAt).toLocaleString()}</p><ul>${tabs}</ul></section>`;
    })
    .join('\n');
  return `<!doctype html><meta charset="utf-8"><title>Sessflow Export</title><style>body{font-family:system-ui;max-width:760px;margin:40px auto;padding:0 16px}h2{margin-top:2rem}a{color:#4f46e5}</style><h1>Sessflow Export</h1>${body}`;
}

/** Parse an import file. Supports Sessflow JSON, plain URL lists, and HTML bookmark dumps. */
export function importSessions(raw: string, fallbackName = 'Imported session'): Session[] {
  const text = raw.trim();
  // 1) Sessflow / generic JSON
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      const sessions: Session[] = Array.isArray(parsed) ? parsed : parsed.sessions ?? [];
      if (Array.isArray(sessions) && sessions.length) {
        return sessions.map((s) => normalize(s, fallbackName));
      }
    } catch {
      /* fall through */
    }
  }
  // 2) HTML — pull all <a href>
  if (/<a\s/i.test(text)) {
    const urls = [...text.matchAll(/href="([^"]+)"[^>]*>([^<]*)</gi)].map((m) => ({ url: m[1], title: m[2] || m[1] }));
    if (urls.length) return [fromTabs(urls, fallbackName)];
  }
  // 3) plain newline-separated URLs
  const urls = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//.test(l))
    .map((url) => ({ url, title: url }));
  if (urls.length) return [fromTabs(urls, fallbackName)];
  return [];
}

function fromTabs(tabs: { url: string; title: string }[], name: string): Session {
  const now = Date.now();
  const windows: SavedWindow[] = [{ id: nanoid(8), tabs: tabs.map((t) => ({ url: t.url, title: t.title })) }];
  return {
    id: nanoid(),
    name,
    kind: 'imported',
    createdAt: now,
    updatedAt: now,
    windows,
    tags: ['imported'],
    rev: 1,
    dirty: true,
  };
}

function normalize(s: Partial<Session>, fallbackName: string): Session {
  const now = Date.now();
  return {
    id: s.id ?? nanoid(),
    name: s.name ?? fallbackName,
    kind: s.kind ?? 'imported',
    createdAt: s.createdAt ?? now,
    updatedAt: now,
    windows: s.windows ?? [],
    tags: s.tags ?? [],
    summary: s.summary,
    rev: 1,
    dirty: true,
  };
}
