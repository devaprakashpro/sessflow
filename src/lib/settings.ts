import browser from './browser';
import { DEFAULT_SETTINGS, type Settings } from './types';

const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const stored = (await browser.storage.local.get(KEY)) as { settings?: Partial<Settings> };
  return deepMerge(DEFAULT_SETTINGS, stored.settings ?? {});
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = deepMerge(current, patch);
  await browser.storage.local.set({ [KEY]: next });
  return next;
}

export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, browser.Storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[KEY]) {
      cb(deepMerge(DEFAULT_SETTINGS, (changes[KEY].newValue as Partial<Settings>) ?? {}));
    }
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

/** Shallow-ish merge that preserves nested `sync` object defaults. */
function deepMerge(base: Settings, patch: Partial<Settings>): Settings {
  return {
    ...base,
    ...patch,
    sync: { ...base.sync, ...(patch.sync ?? {}) },
  };
}
