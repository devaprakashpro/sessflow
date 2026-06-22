import * as cheerio from 'cheerio';
import { hashUrl } from './db.js';

/**
 * Background archive worker. Fetches pending URLs, extracts readable text +
 * title, and indexes them into FTS5. Runs as a simple in-process loop so the
 * /sync endpoint can return immediately.
 */
export function startArchiveWorker(db, q, opts = {}) {
  const concurrency = opts.concurrency ?? 3;
  const intervalMs = opts.intervalMs ?? 4000;
  const maxBytes = opts.maxBytes ?? 2_000_000;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const batch = q.pendingPages.all(concurrency * 2);
      await Promise.all(batch.slice(0, concurrency).map((p) => archiveOne(p).catch(() => {})));
    } finally {
      running = false;
    }
  }

  async function archiveOne({ url_hash, url }) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12_000);
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'SessflowMesh/0.1 (+archive)' },
      }).finally(() => clearTimeout(t));

      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.includes('text/html')) {
        q.markPageError.run(Date.now(), url_hash);
        return;
      }
      const html = (await res.text()).slice(0, maxBytes);
      const { title, site, body } = extractReadable(html, url);

      const tx = db.transaction(() => {
        q.markPageOk.run(title, site, Date.now(), url_hash);
        q.ftsDelete.run(url_hash);
        q.ftsInsert.run(url_hash, url, title, site, body);
      });
      tx();
    } catch {
      q.markPageError.run(Date.now(), url_hash);
    }
  }

  const timer = setInterval(tick, intervalMs);
  tick();
  return () => clearInterval(timer);
}

/** Lightweight readability: strip chrome, keep meaningful block text. */
export function extractReadable(html, url) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, nav, footer, header, aside, form, iframe').remove();

  const title = ($('meta[property="og:title"]').attr('content') || $('title').first().text() || url).trim();
  let site = '';
  try {
    site = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* ignore */
  }

  const root = $('article').first().length ? $('article').first() : $('main').first().length ? $('main').first() : $('body');
  const parts = [];
  root.find('h1, h2, h3, p, li, blockquote').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t.length > 24) parts.push(t);
  });
  let body = parts.join('\n');
  if (body.length < 200) body = $('body').text().replace(/\s+/g, ' ').trim();
  return { title, site, body: body.slice(0, 200_000) };
}

/** Enqueue all http(s) tab URLs found in a synced session payload. */
export function enqueueSessionUrls(q, session) {
  const windows = session?.windows ?? [];
  for (const w of windows) {
    for (const tab of w.tabs ?? []) {
      const url = tab.url;
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;
      const h = hashUrl(url);
      const existing = q.pageExists.get(h);
      if (!existing) q.insertPagePending.run(h, url);
    }
  }
}
