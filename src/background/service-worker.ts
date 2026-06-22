import browser from '../lib/browser';
import { db } from '../lib/db';
import { getSettings } from '../lib/settings';
import {
  captureWindow,
  captureWindows,
  createSession,
  findDuplicates,
  restore,
  restoreToWindow,
  saveAllWindows,
  saveCurrentWindow,
  updateSession,
} from '../lib/sessions';
import { applyAiGroups, groupSessionWithAi } from '../lib/ai';
import { syncNow } from '../lib/sync';
import { autoSuspendSweep, suspendTab, unsuspendTab } from '../lib/suspend';
import { dayStamp, dueSchedules } from '../lib/schedules';
import type { Msg, SavedWindow } from '../lib/types';

const ALARMS = {
  crash: 'sessflow-crash',
  autosave: 'sessflow-autosave',
  suspend: 'sessflow-suspend',
  sync: 'sessflow-sync',
  schedule: 'sessflow-schedule',
};

// last-active timestamps for the suspension sweep (in-memory; fine for MV3 SW lifetime)
const lastActive = new Map<number, number>();
const touch = (id?: number) => id != null && lastActive.set(id, Date.now());

// ---------------------------------------------------------------- install
browser.runtime.onInstalled.addListener(async () => {
  await ensureAlarms();
  await setupContextMenus();
  await seedWindowCache();
});
browser.runtime.onStartup?.addListener(async () => {
  await promoteCrashSnapshot();
  await ensureAlarms();
  await seedWindowCache();
});

async function ensureAlarms() {
  const s = await getSettings();
  await browser.alarms.create(ALARMS.crash, { periodInMinutes: Math.max(1, s.crashSnapshotIntervalMin) });
  if (s.autoSave) await browser.alarms.create(ALARMS.autosave, { periodInMinutes: Math.max(5, s.autoSaveIntervalMin) });
  else await browser.alarms.clear(ALARMS.autosave);
  if (s.suspendEnabled) await browser.alarms.create(ALARMS.suspend, { periodInMinutes: 1 });
  else await browser.alarms.clear(ALARMS.suspend);
  if (s.sync.provider !== 'none' && s.sync.autoSync)
    await browser.alarms.create(ALARMS.sync, { periodInMinutes: 5 });
  else await browser.alarms.clear(ALARMS.sync);
  // scheduling alarm is cheap and always on (fires due schedules)
  await browser.alarms.create(ALARMS.schedule, { periodInMinutes: 1 });
}

// ---------------------------------------------------------------- scheduled sessions
async function runDueSchedules() {
  const all = await db.schedules.toArray();
  const now = new Date();
  const due = dueSchedules(all, now);
  for (const sched of due) {
    await restore(sched.sessionId, sched.newWindow).catch(() => {});
    await db.schedules.update(sched.id, { lastFired: dayStamp(now) });
  }
}

// ---------------------------------------------------------------- auto-save on close
// Keep a live snapshot of each normal window so we can save it after it's gone.
const windowCache = new Map<number, SavedWindow>();
async function refreshWindowCache(windowId?: number) {
  if (windowId == null) return;
  const w = await captureWindow(windowId).catch(() => null);
  if (w) windowCache.set(windowId, w);
}
async function seedWindowCache() {
  const wins = await browser.windows.getAll();
  for (const w of wins) if (w.id != null) await refreshWindowCache(w.id);
}

// ---------------------------------------------------------------- crash recovery
// Continuously overwrite a single "current" snapshot. On a clean startup it gets
// promoted to a normal recoverable session; if the browser crashed, it's there waiting.
const CRASH_KEY = 'sessflow-current-snapshot';

async function writeCrashSnapshot() {
  const windows = await captureWindows({ currentOnly: false });
  if (windows.length === 0) return;
  await browser.storage.local.set({
    [CRASH_KEY]: { windows, at: Date.now() },
  });
}

async function promoteCrashSnapshot() {
  const got = (await browser.storage.local.get(CRASH_KEY)) as {
    [CRASH_KEY]?: { windows: any[]; at: number };
  };
  const snap = got[CRASH_KEY];
  if (!snap || !snap.windows?.length) return;
  const settings = await getSettings();
  await createSession(snap.windows, {
    kind: 'crash',
    name: `Recovered — ${new Date(snap.at).toLocaleString()}`,
    tags: ['recovered'],
  });
  // prune old crash sessions beyond the keep-N limit
  const crashes = (await db.sessions.where('kind').equals('crash').reverse().sortBy('createdAt')).filter(
    (s) => !s.deletedAt,
  );
  for (const old of crashes.slice(settings.crashSnapshots)) await db.sessions.delete(old.id);
}

// ---------------------------------------------------------------- alarms
browser.alarms.onAlarm.addListener(async (alarm) => {
  switch (alarm.name) {
    case ALARMS.crash:
      await writeCrashSnapshot();
      break;
    case ALARMS.autosave: {
      await saveAllWindows(`Auto-save — ${new Date().toLocaleString()}`).then((s) =>
        db.sessions.update(s.id, { kind: 'auto', tags: ['auto'] }),
      );
      break;
    }
    case ALARMS.suspend:
      await autoSuspendSweep(lastActive);
      break;
    case ALARMS.sync:
      await syncNow();
      break;
    case ALARMS.schedule:
      await runDueSchedules();
      break;
  }
});

// ---------------------------------------------------------------- keyboard commands
browser.commands?.onCommand.addListener(async (command) => {
  switch (command) {
    case 'save-session':
      await saveCurrentWindow();
      await notify('Sessflow', 'Saved current window.');
      break;
    case 'open-dashboard':
      await openDashboard();
      break;
    case 'open-palette':
      await openDashboard('#palette');
      break;
  }
});

// ---------------------------------------------------------------- context menus
async function setupContextMenus() {
  await browser.contextMenus?.removeAll();
  browser.contextMenus?.create({ id: 'save-window', title: 'Sessflow: Save this window', contexts: ['action'] });
  browser.contextMenus?.create({ id: 'save-all', title: 'Sessflow: Save all windows', contexts: ['action'] });
  browser.contextMenus?.create({ id: 'suspend-tab', title: 'Sessflow: Suspend this tab', contexts: ['page'] });
  browser.contextMenus?.create({ id: 'open-dashboard', title: 'Sessflow: Open dashboard', contexts: ['action'] });
}

browser.contextMenus?.onClicked.addListener(async (info, tab) => {
  switch (info.menuItemId) {
    case 'save-window':
      await saveCurrentWindow();
      await notify('Sessflow', 'Window saved.');
      break;
    case 'save-all':
      await saveAllWindows();
      await notify('Sessflow', 'All windows saved.');
      break;
    case 'suspend-tab':
      if (tab?.id != null) await suspendTab(tab.id);
      break;
    case 'open-dashboard':
      await openDashboard();
      break;
  }
});

// ---------------------------------------------------------------- activity tracking
browser.tabs.onActivated.addListener(({ tabId }) => {
  touch(tabId);
  // auto-unsuspend on focus
  browser.tabs.get(tabId).then((t) => {
    if (t.url?.includes('/src/suspended/index.html')) unsuspendTab(tabId).catch(() => {});
  });
});
browser.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' || info.audible !== undefined) touch(tabId);
  if (info.status === 'complete') {
    refreshWindowCache(tab.windowId);
    onTabActivity(tab.windowId);
  }
});
browser.tabs.onCreated.addListener((tab) => {
  refreshWindowCache(tab.windowId);
  onTabActivity(tab.windowId);
});
browser.tabs.onRemoved.addListener((tabId, info) => {
  lastActive.delete(tabId);
  if (!info.isWindowClosing) {
    refreshWindowCache(info.windowId);
    onTabActivity(info.windowId);
  }
});
browser.tabs.onMoved.addListener((_id, info) => onTabActivity(info.windowId));
browser.tabs.onAttached.addListener((_id, info) => onTabActivity(info.newWindowId));

// when a window closes: clear its live binding and freeze the session as a
// normal saved snapshot; optionally auto-save windows that weren't tracked.
browser.windows.onRemoved.addListener(async (windowId) => {
  const cached = windowCache.get(windowId);
  windowCache.delete(windowId);

  const bindings = await getBindings();
  const liveSessionId = bindings[String(windowId)];
  if (liveSessionId) {
    await removeBinding(windowId);
    await updateSession(liveSessionId, { live: false }); // freeze final state
    return; // a live session was already being saved continuously
  }

  const s = await getSettings();
  if (!s.autoSaveOnClose || !cached || cached.tabs.length === 0) return;
  await createSession([cached], {
    kind: 'auto',
    name: `Closed window — ${new Date().toLocaleString()}`,
    tags: ['closed'],
  });
});

// ---------------------------------------------------------------- live sessions
// A "live" session is bound to an open window and re-captured on every tab
// change, then pushed to the mesh/cloud. Bindings live in storage.session so
// they survive the ephemeral MV3 worker but reset on browser restart (when
// window ids are invalid anyway).
const LIVE_KEY = 'liveBindings';

async function getBindings(): Promise<Record<string, string>> {
  try {
    const got = (await browser.storage.session.get(LIVE_KEY)) as { [LIVE_KEY]?: Record<string, string> };
    return got[LIVE_KEY] ?? {};
  } catch {
    return {};
  }
}
async function setBinding(windowId: number, sessionId: string) {
  const b = await getBindings();
  b[windowId] = sessionId;
  await browser.storage.session.set({ [LIVE_KEY]: b });
}
async function removeBinding(windowId: number) {
  const b = await getBindings();
  delete b[windowId];
  await browser.storage.session.set({ [LIVE_KEY]: b });
}

// debounce live re-capture so multi-tab operations collapse into one update
const liveTimers = new Map<number, ReturnType<typeof setTimeout>>();
function scheduleLiveUpdate(windowId: number) {
  const t = liveTimers.get(windowId);
  if (t) clearTimeout(t);
  liveTimers.set(
    windowId,
    setTimeout(() => {
      liveTimers.delete(windowId);
      void updateLiveWindow(windowId);
    }, 800),
  );
}
async function updateLiveWindow(windowId: number) {
  const b = await getBindings();
  const sessionId = b[windowId];
  if (!sessionId) return;
  const session = await db.sessions.get(sessionId);
  if (!session || !session.live) {
    await removeBinding(windowId);
    return;
  }
  const w = await captureWindow(windowId).catch(() => null);
  if (!w) return;
  await updateSession(sessionId, { windows: [w] }); // bumps rev/updatedAt + marks dirty
  debouncedSync();
}

// react to ANY tab change in a tracked window
async function onTabActivity(windowId?: number) {
  if (windowId == null) return;
  const b = await getBindings();
  if (b[windowId]) scheduleLiveUpdate(windowId);
}

// coalesce mesh/cloud pushes triggered by live updates
let syncTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSync() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncNow().catch(() => {});
  }, 1500);
}

// ---------------------------------------------------------------- message router
browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handle(message as Msg)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
  return true; // async response
});

async function handle(msg: Msg): Promise<unknown> {
  switch (msg.type) {
    case 'SAVE_CURRENT_WINDOW':
      return saveCurrentWindow(msg.name);
    case 'SAVE_ALL_WINDOWS':
      return saveAllWindows(msg.name);
    case 'RESTORE_SESSION':
      return restore(msg.sessionId, msg.newWindow ?? true);
    case 'RESTORE_TAB':
      return browser.tabs.create({ url: msg.url });
    case 'OPEN_DASHBOARD':
      return openDashboard(msg.query ? `#q=${encodeURIComponent(msg.query)}` : '');
    case 'OPEN_PALETTE':
      return openDashboard('#palette');
    case 'AI_GROUP_SESSION': {
      const session = await db.sessions.get(msg.sessionId);
      if (!session) throw new Error('Session not found.');
      const result = await groupSessionWithAi(session);
      return applyAiGroups(msg.sessionId, result);
    }
    case 'SYNC_NOW':
      return syncNow();
    case 'SUSPEND_TAB':
      return suspendTab(msg.tabId);
    case 'FIND_DUPLICATES':
      return findDuplicates();
    case 'START_LIVE_WINDOW': {
      const windowId = msg.windowId ?? (await browser.windows.getCurrent()).id;
      if (windowId == null) throw new Error('No current window.');
      const w = await captureWindow(windowId);
      if (!w) throw new Error('No saveable tabs in this window.');
      const session = await createSession([w], { name: msg.name, kind: 'manual', tags: ['live'] });
      await db.sessions.update(session.id, { live: true });
      await setBinding(windowId, session.id);
      debouncedSync();
      return { ...session, live: true };
    }
    case 'STOP_LIVE': {
      await updateSession(msg.sessionId, { live: false });
      const b = await getBindings();
      for (const [wid, sid] of Object.entries(b)) if (sid === msg.sessionId) await removeBinding(Number(wid));
      return { stopped: true };
    }
    case 'RESUME_LIVE_SESSION': {
      // reopen the SAME session's tabs in a new window and keep it live
      const windowId = await restoreToWindow(msg.sessionId);
      if (windowId == null) throw new Error('Session has no tabs to open.');
      await updateSession(msg.sessionId, { live: true });
      await setBinding(windowId, msg.sessionId);
      debouncedSync();
      return { windowId };
    }
    case 'ATTACH_LIVE': {
      // bind the current window to an existing session as-is, then go live
      const windowId = msg.windowId ?? (await browser.windows.getCurrent()).id;
      if (windowId == null) throw new Error('No current window.');
      const w = await captureWindow(windowId);
      if (!w) throw new Error('No saveable tabs in this window.');
      await updateSession(msg.sessionId, { windows: [w], live: true });
      await setBinding(windowId, msg.sessionId);
      debouncedSync();
      return { windowId };
    }
    case 'GET_LIVE_STATUS': {
      const windowId = msg.windowId ?? (await browser.windows.getCurrent()).id;
      if (windowId == null) return { sessionId: null, name: null };
      const b = await getBindings();
      const sid = b[String(windowId)];
      if (!sid) return { sessionId: null, name: null };
      const s = await db.sessions.get(sid);
      if (!s || !s.live || s.deletedAt) {
        await removeBinding(windowId);
        return { sessionId: null, name: null };
      }
      return { sessionId: sid, name: s.name };
    }
    default:
      throw new Error(`Unknown message: ${(msg as any).type}`);
  }
}

// ---------------------------------------------------------------- helpers
async function openDashboard(hash = '') {
  const url = browser.runtime.getURL('src/dashboard/index.html') + hash;
  const existing = await browser.tabs.query({ url: browser.runtime.getURL('src/dashboard/index.html') + '*' });
  if (existing[0]?.id != null) {
    await browser.tabs.update(existing[0].id, { active: true, url });
    if (existing[0].windowId != null) await browser.windows.update(existing[0].windowId, { focused: true });
  } else {
    await browser.tabs.create({ url });
  }
}

async function notify(title: string, message: string) {
  try {
    await browser.notifications?.create({
      type: 'basic',
      iconUrl: browser.runtime.getURL('src/icons/icon48.png'),
      title,
      message,
    });
  } catch {
    /* notifications permission optional */
  }
}

// ---------------------------------------------------------------- mesh live push
let liveSocket: WebSocket | null = null;
let liveKey = '';
let liveRetry: ReturnType<typeof setTimeout> | null = null;

async function connectLive() {
  const { sync } = await getSettings();
  const meshUrl = sync.meshUrl?.trim();
  const meshToken = sync.meshToken?.trim();
  const want = sync.provider === 'mesh' && sync.autoSync && !!meshUrl && !!meshToken;
  const key = want ? `${meshUrl}|${meshToken}` : '';
  if (key === liveKey && liveSocket && liveSocket.readyState <= 1) return; // already connected
  liveKey = key;
  liveSocket?.close();
  liveSocket = null;
  if (!want) return;

  const wsUrl =
    meshUrl!.replace(/^http/, 'ws').replace(/\/+$/, '') +
    `/v1/live?token=${encodeURIComponent(meshToken!)}`;
  try {
    const ws = new WebSocket(wsUrl);
    liveSocket = ws;
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === 'changed') syncNow();
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      liveSocket = null;
      if (liveRetry) clearTimeout(liveRetry);
      liveRetry = setTimeout(connectLive, 15_000); // reconnect with backoff
    };
    ws.onerror = () => ws.close();
  } catch {
    if (liveRetry) clearTimeout(liveRetry);
    liveRetry = setTimeout(connectLive, 15_000);
  }
}

// react to settings changes (re-arm alarms + live socket)
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    ensureAlarms();
    connectLive();
  }
});

connectLive();
