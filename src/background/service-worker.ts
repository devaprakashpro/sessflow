import browser from '../lib/browser';
import { db } from '../lib/db';
import { getSettings } from '../lib/settings';
import {
  captureWindow,
  captureWindows,
  createSession,
  findDuplicates,
  restore,
  saveAllWindows,
  saveCurrentWindow,
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
  if (info.status === 'complete') refreshWindowCache(tab.windowId);
});
browser.tabs.onCreated.addListener((tab) => refreshWindowCache(tab.windowId));
browser.tabs.onRemoved.addListener((tabId, info) => {
  lastActive.delete(tabId);
  if (!info.isWindowClosing) refreshWindowCache(info.windowId);
});

// auto-save a window's tabs the moment it closes
browser.windows.onRemoved.addListener(async (windowId) => {
  const cached = windowCache.get(windowId);
  windowCache.delete(windowId);
  const s = await getSettings();
  if (!s.autoSaveOnClose || !cached || cached.tabs.length === 0) return;
  await createSession([cached], {
    kind: 'auto',
    name: `Closed window — ${new Date().toLocaleString()}`,
    tags: ['closed'],
  });
});

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
