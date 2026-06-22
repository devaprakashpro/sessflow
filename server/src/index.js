#!/usr/bin/env node
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDb, makeQueries, hashUrl } from './db.js';
import { startArchiveWorker, enqueueSessionUrls } from './archive.js';
import { askYourTabs, toFtsQuery } from './ai.js';
import { WEB_PAGE } from './web.js';

// ----------------------------------------------------------------- config
const PORT = Number(process.env.SESSFLOW_PORT ?? 7777);
const HOST = resolveHost(); // 'tailscale' → auto-bind to this node's tailnet IP
const DB_PATH = resolve(process.env.SESSFLOW_DB ?? './data/sessflow.db');
const AI_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const AI_MODEL = process.env.SESSFLOW_AI_MODEL ?? 'claude-opus-4-8';
const TOKEN = resolveToken();

const db = openDb(DB_PATH);
const q = makeQueries(db);
startArchiveWorker(db, q);

// ----------------------------------------------------------------- app
const app = new Hono();
app.use('*', cors({ origin: '*', allowHeaders: ['authorization', 'content-type'], allowMethods: ['GET', 'POST', 'OPTIONS'] }));

app.get('/health', (c) => c.json({ ok: true, name: 'sessflow-mesh', version: '0.1.0', ai: !!AI_KEY }));

// web companion (mobile/desktop) — open in any browser on the tailnet
app.get('/', (c) => c.html(WEB_PAGE));

// bearer-token auth for everything under /v1
app.use('/v1/*', async (c, next) => {
  const auth = c.req.header('authorization') ?? '';
  const tok = auth.replace(/^Bearer\s+/i, '').trim();
  if (tok !== TOKEN.trim()) return c.json({ error: 'unauthorized' }, 401);
  await next();
});

app.get('/v1/stats', (c) => c.json(q.stats.get()));

// list sessions for the web companion
app.get('/v1/sessions', (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 200), 500);
  const sessions = q.listSessions.all(limit).map((r) => JSON.parse(r.payload));
  return c.json({ sessions });
});

// ---- sync: pull changes since `since`, push incoming sessions (LWW) ----
app.post('/v1/sync', async (c) => {
  const { since = 0, sessions = [] } = await c.req.json().catch(() => ({}));
  let pushed = 0;
  const tx = db.transaction((rows) => {
    for (const s of rows) {
      const info = q.upsertSession.run({
        id: s.id,
        rev: s.rev ?? 1,
        updated_at: s.updated_at ?? s.updatedAt ?? Date.now(),
        deleted: s.deleted ? 1 : 0,
        payload: JSON.stringify(s.payload ?? s),
      });
      if (info.changes > 0) {
        pushed++;
        if (!s.deleted) enqueueSessionUrls(q, s.payload ?? s);
      }
    }
  });
  tx(sessions);

  const changed = q.changedSince.all(since).map((r) => ({
    id: r.id,
    rev: r.rev,
    updated_at: r.updated_at,
    deleted: !!r.deleted,
    payload: JSON.parse(r.payload),
  }));

  if (pushed > 0) broadcast({ type: 'changed', at: Date.now() });
  return c.json({ ok: true, pushed, changed, now: Date.now() });
});

// ---- full-text search over archived pages ----
app.get('/v1/search', (c) => {
  const query = c.req.query('q') ?? '';
  const limit = Math.min(Number(c.req.query('limit') ?? 30), 100);
  const match = toFtsQuery(query);
  if (!match) return c.json({ results: [] });
  const results = q.ftsSearch.all(match, limit).map((r) => ({
    url: r.url, title: r.title, site: r.site, snippet: r.snippet, hash: r.url_hash,
  }));
  return c.json({ results });
});

// ---- ask-your-tabs (RAG over archive via Claude) ----
app.post('/v1/ask', async (c) => {
  const { question } = await c.req.json().catch(() => ({}));
  if (!question) return c.json({ error: 'missing question' }, 400);
  try {
    const out = await askYourTabs(q, { question, apiKey: AI_KEY, model: AI_MODEL });
    return c.json(out);
  } catch (e) {
    return c.json({ error: String(e.message ?? e) }, 500);
  }
});

// ---- read an archived page as plain readable HTML ----
app.get('/v1/page/:hash', (c) => {
  const row = q.getBody.get(c.req.param('hash'));
  if (!row) return c.text('Not archived.', 404);
  const esc = (s) => String(s).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
  return c.html(
    `<!doctype html><meta charset=utf-8><title>${esc(row.title)}</title>` +
      `<style>body{font:16px/1.7 system-ui;max-width:720px;margin:40px auto;padding:0 16px;color:#222}a{color:#4f46e5}</style>` +
      `<h1>${esc(row.title)}</h1><p><a href="${esc(row.url)}">${esc(row.url)}</a> · archived by Sessflow Mesh</p>` +
      `<article>${esc(row.body).split('\n').map((p) => `<p>${p}</p>`).join('')}</article>`,
  );
});

// ----------------------------------------------------------------- start + ws
const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`\n  Sessflow Mesh running → http://${HOST}:${info.port}`);
  console.log(`  DB: ${DB_PATH}`);
  console.log(`  AI ask-your-tabs: ${AI_KEY ? 'enabled' : 'disabled (set ANTHROPIC_API_KEY)'}`);
  const tnet = tailnetUrl(info.port);
  console.log(`\n  Point the extension here (Settings → Cloud sync → Mesh):`);
  if (tnet) console.log(`    ${tnet}`);
  console.log(`    http://${displayHost()}:${info.port}`);
  console.log(`\n  Device token:`);
  console.log(`    ${TOKEN}\n`);
});

const wss = new WebSocketServer({ server, path: '/v1/live' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('token') !== TOKEN) {
    ws.close(4001, 'unauthorized');
    return;
  }
  ws.send(JSON.stringify({ type: 'hello' }));
});
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(data);
}

// ----------------------------------------------------------------- helpers
/** Resolve the bind host. `SESSFLOW_HOST=tailscale` auto-detects this node's tailnet IP. */
function resolveHost() {
  const h = process.env.SESSFLOW_HOST ?? '0.0.0.0';
  if (h === 'tailscale' || h === 'ts') {
    const ip = tailscaleIp();
    if (ip) {
      console.log(`  Binding to Tailscale IP ${ip} (private to your tailnet)`);
      return ip;
    }
    console.warn('  ⚠ Could not detect a Tailscale IP — falling back to 0.0.0.0');
    return '0.0.0.0';
  }
  return h;
}

/** This node's IPv4 tailnet address, or '' if Tailscale isn't available. */
function tailscaleIp() {
  try {
    return execSync('tailscale ip -4', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')[0]
      .trim();
  } catch {
    return '';
  }
}

/** A MagicDNS URL for this node if resolvable, else an IP URL — for the startup hint. */
function tailnetUrl(port) {
  try {
    const json = JSON.parse(
      execSync('tailscale status --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    );
    const dns = (json?.Self?.DNSName ?? '').replace(/\.$/, '');
    if (dns) return `http://${dns}:${port}`;
  } catch {
    /* ignore */
  }
  const ip = tailscaleIp();
  return ip ? `http://${ip}:${port}` : '';
}

/** Friendlier display when bound to 0.0.0.0. */
function displayHost() {
  return HOST === '0.0.0.0' ? (tailscaleIp() || 'localhost') : HOST;
}

function resolveToken() {
  if (process.env.SESSFLOW_TOKEN) return process.env.SESSFLOW_TOKEN;
  const file = resolve(dirname(DB_PATH), '.sessflow-token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dirname(file), { recursive: true });
  const tok = randomBytes(24).toString('base64url');
  writeFileSync(file, tok, { mode: 0o600 });
  return tok;
}
