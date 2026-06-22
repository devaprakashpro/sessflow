import browser from './browser';
import type { Msg } from './types';

/** Typed wrapper around runtime.sendMessage with unwrapped {ok,result|error}. */
export async function send<T = unknown>(msg: Msg): Promise<T> {
  const res = (await browser.runtime.sendMessage(msg)) as
    | { ok: true; result: T }
    | { ok: false; error: string };
  if (!res?.ok) throw new Error(res?.error ?? 'Background did not respond.');
  return res.result;
}

export function openDashboard(hash = ''): void {
  const url = browser.runtime.getURL('src/dashboard/index.html') + hash;
  browser.tabs.create({ url }).catch(() => window.open(url, '_blank'));
}
