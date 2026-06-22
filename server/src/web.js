/**
 * Mobile/desktop web companion served at GET / by the Mesh server.
 * Self-contained (inline CSS+JS). Holds the device token in localStorage and
 * calls the authed /v1/* API. Lets any tailnet device browse sessions, search
 * the archive, ask-your-tabs, and open saved tabs — no extension needed.
 */
export const WEB_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0f1115" />
<title>Sessflow</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin:0; background:#0f1115; color:#e6e9ef; font:16px/1.5 Inter,system-ui,sans-serif; }
  a { color:#22d3ee; text-decoration:none; }
  header { position:sticky; top:0; z-index:5; background:rgba(15,17,21,.92); backdrop-filter:blur(8px);
           border-bottom:1px solid #2a2f3a; padding:env(safe-area-inset-top) 0 0; }
  .bar { display:flex; align-items:center; gap:10px; padding:12px 14px; }
  .logo { width:28px; height:28px; border-radius:8px; background:linear-gradient(135deg,#6366f1,#22d3ee); }
  .title { font-weight:700; font-size:18px; }
  .stats { margin-left:auto; font-size:12px; color:#8b93a7; }
  .tabs { display:flex; gap:6px; padding:0 14px 10px; }
  .tab { flex:1; text-align:center; padding:8px; border-radius:9px; background:#171a21; color:#8b93a7; font-size:14px; font-weight:600; border:1px solid #2a2f3a; }
  .tab.active { background:#1d212b; color:#fff; border-color:#6366f1; }
  main { padding:14px; max-width:760px; margin:0 auto; }
  input, button { font:inherit; }
  .input { width:100%; padding:12px 14px; border-radius:10px; border:1px solid #2a2f3a; background:#171a21; color:#fff; }
  .btn { padding:12px 16px; border-radius:10px; border:0; background:#6366f1; color:#fff; font-weight:600; }
  .row { display:flex; gap:8px; }
  .card { background:#1d212b; border:1px solid #2a2f3a; border-radius:12px; padding:14px; margin-bottom:10px; }
  .name { font-weight:600; }
  .muted { color:#8b93a7; font-size:13px; }
  .chip { display:inline-block; font-size:11px; color:#8b93a7; border:1px solid #2a2f3a; border-radius:999px; padding:2px 8px; margin:2px 4px 0 0; }
  .tabrow { display:flex; align-items:center; gap:10px; padding:10px 6px; border-top:1px solid #232833; }
  .tabrow img { width:18px; height:18px; border-radius:4px; flex:0 0 auto; }
  .tabrow .t { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .hidden { display:none; }
  .center { min-height:70vh; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; text-align:center; }
  mark { background:#6366f199; color:#fff; border-radius:3px; padding:0 2px; }
  .spin { color:#8b93a7; padding:24px; text-align:center; }
  .err { color:#f87171; }
  .ans { white-space:pre-wrap; line-height:1.7; }
</style>
</head>
<body>
<div id="login" class="center hidden">
  <div class="logo" style="width:56px;height:56px;border-radius:14px"></div>
  <div class="title">Sessflow</div>
  <div class="muted">Enter your device token to connect.</div>
  <input id="tok" class="input" style="max-width:340px" type="password" placeholder="device token" autocomplete="off" />
  <button class="btn" onclick="saveToken()">Connect</button>
  <div id="loginErr" class="err"></div>
</div>

<div id="app" class="hidden">
  <header>
    <div class="bar">
      <div class="logo"></div><div class="title">Sessflow</div>
      <div class="stats" id="stats"></div>
    </div>
    <div class="tabs">
      <div class="tab active" data-v="sessions" onclick="view('sessions')">Sessions</div>
      <div class="tab" data-v="search" onclick="view('search')">Search</div>
      <div class="tab" data-v="ask" onclick="view('ask')">Ask</div>
    </div>
  </header>
  <main>
    <section id="v-sessions"></section>
    <section id="v-search" class="hidden">
      <div class="row"><input id="q" class="input" placeholder="Search archived pages…" />
        <button class="btn" onclick="doSearch()">Go</button></div>
      <div id="searchOut"></div>
    </section>
    <section id="v-ask" class="hidden">
      <div class="row"><input id="aq" class="input" placeholder="Ask about your saved tabs…" />
        <button class="btn" onclick="doAsk()">Ask</button></div>
      <div id="askOut"></div>
    </section>
    <div style="text-align:center;margin-top:20px"><button class="btn" style="background:#171a21;color:#8b93a7;border:1px solid #2a2f3a" onclick="logout()">Disconnect</button></div>
  </main>
</div>

<script>
const $ = (s) => document.querySelector(s);
const esc = (s) => (s||'').replace(/[&<>]/g,(m)=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
const host = (u) => { try { return new URL(u).hostname.replace(/^www\\./,''); } catch { return ''; } };
let TOKEN = localStorage.getItem('sessflow_token') || '';

// bootstrap token from ?token= then strip it from the URL
const p = new URLSearchParams(location.search);
if (p.get('token')) { TOKEN = p.get('token').trim(); localStorage.setItem('sessflow_token', TOKEN); history.replaceState({}, '', location.pathname); }

async function api(path, opts={}) {
  const r = await fetch(path, { ...opts, headers: { 'authorization':'Bearer '+TOKEN, 'content-type':'application/json', ...(opts.headers||{}) } });
  if (r.status === 401) { logout(); throw new Error('unauthorized'); }
  if (!r.ok) throw new Error('HTTP '+r.status);
  return r.json();
}
function saveToken() {
  TOKEN = $('#tok').value.trim();
  if (!TOKEN) return;
  localStorage.setItem('sessflow_token', TOKEN);
  start();
}
function logout() { localStorage.removeItem('sessflow_token'); TOKEN=''; $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
function view(v) {
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.v===v));
  ['sessions','search','ask'].forEach(x=>$('#v-'+x).classList.toggle('hidden', x!==v));
}

async function start() {
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  try {
    const s = await api('/v1/stats');
    $('#stats').textContent = s.sessions+' sessions · '+s.archived+' archived';
    renderSessions();
  } catch(e) { if (e.message!=='unauthorized'){ $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); $('#loginErr').textContent='Could not connect: '+e.message; } }
}

async function renderSessions() {
  const el = $('#v-sessions'); el.innerHTML='<div class="spin">Loading…</div>';
  try {
    const { sessions } = await api('/v1/sessions');
    if (!sessions.length) { el.innerHTML='<div class="card muted">No sessions yet. Save one from the desktop extension.</div>'; return; }
    el.innerHTML = sessions.map((s,i)=>{
      const tabs = (s.windows||[]).flatMap(w=>w.tabs||[]);
      const rows = tabs.map(t=>'<a class="tabrow" href="'+esc(t.url)+'" target="_blank" rel="noopener"><img src="'+esc(t.favIconUrl||'')+'" onerror="this.style.visibility=\\'hidden\\'"/><span class="t">'+esc(t.title||t.url)+'</span></a>').join('');
      const tags = (s.tags||[]).map(t=>'<span class="chip">#'+esc(t)+'</span>').join('');
      return '<div class="card"><div class="name" onclick="this.parentNode.querySelector(\\'.body\\').classList.toggle(\\'hidden\\')">'+esc(s.name)+'</div>'+
        '<div class="muted">'+tabs.length+' tabs · '+new Date(s.createdAt).toLocaleString()+'</div>'+tags+
        '<div class="body hidden">'+rows+'</div></div>';
    }).join('');
  } catch(e) { el.innerHTML='<div class="card err">'+esc(e.message)+'</div>'; }
}

async function doSearch() {
  const q = $('#q').value.trim(); const out=$('#searchOut'); if(!q) return;
  out.innerHTML='<div class="spin">Searching…</div>';
  try {
    const { results } = await api('/v1/search?q='+encodeURIComponent(q));
    out.innerHTML = results.length ? results.map(r=>'<a class="card" style="display:block" href="'+esc(r.url)+'" target="_blank" rel="noopener">'+
      '<div class="name">'+esc(r.title||r.url)+'</div><div class="muted">'+esc(r.site)+'</div>'+
      '<div class="muted">'+(r.snippet||'').replace(/«/g,'<mark>').replace(/»/g,'</mark>')+'</div></a>').join('')
      : '<div class="card muted">No matches.</div>';
  } catch(e){ out.innerHTML='<div class="card err">'+esc(e.message)+'</div>'; }
}

async function doAsk() {
  const q = $('#aq').value.trim(); const out=$('#askOut'); if(!q) return;
  out.innerHTML='<div class="spin">Thinking…</div>';
  try {
    const a = await api('/v1/ask', { method:'POST', body: JSON.stringify({ question:q }) });
    const cites = (a.citations||[]).map((c,i)=>'<a class="tabrow" href="'+esc(c.url)+'" target="_blank" rel="noopener"><span class="t">'+(i+1)+'. '+esc(c.title||c.url)+'</span></a>').join('');
    out.innerHTML='<div class="card"><div class="ans">'+esc(a.answer)+'</div></div>'+(cites?'<div class="card"><div class="muted">Sources</div>'+cites+'</div>':'');
  } catch(e){ out.innerHTML='<div class="card err">'+esc(e.message)+' (is ANTHROPIC_API_KEY set on the server?)</div>'; }
}

if (TOKEN) start(); else $('#login').classList.remove('hidden');
</script>
</body>
</html>`;
