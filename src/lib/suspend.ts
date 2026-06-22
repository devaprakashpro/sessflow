import browser from './browser';
import { getSettings } from './settings';
import { realUrl } from './sessions';

/**
 * Tab suspension: replace a tab's document with a lightweight placeholder page
 * that remembers the real URL, freeing the renderer's memory. Re-navigating the
 * placeholder restores the original page.
 */

export function suspendedPageUrl(target: { url: string; title: string; favIconUrl?: string }): string {
  const base = browser.runtime.getURL('src/suspended/index.html');
  const p = new URLSearchParams({
    u: encodeURIComponent(target.url),
    t: target.title ?? '',
  });
  if (target.favIconUrl) p.set('f', target.favIconUrl);
  return `${base}?${p.toString()}`;
}

export function isSuspendedUrl(url: string | undefined): boolean {
  return !!url && url.includes('/src/suspended/index.html');
}

async function shouldSuspend(tab: browser.Tabs.Tab): Promise<boolean> {
  const s = await getSettings();
  if (!s.suspendEnabled) return false;
  if (tab.active || tab.pinned || tab.audible) return false;
  const url = tab.url ?? '';
  if (!/^https?:/.test(url) || isSuspendedUrl(url)) return false;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (s.suspendNeverDomains.some((d) => host === d || host.endsWith(`.${d}`))) return false;
  } catch {
    return false;
  }
  return true;
}

export async function suspendTab(tabId: number): Promise<void> {
  const tab = await browser.tabs.get(tabId);
  if (!tab.url || isSuspendedUrl(tab.url)) return;
  const url = suspendedPageUrl({ url: tab.url, title: tab.title ?? tab.url, favIconUrl: tab.favIconUrl });
  await browser.tabs.update(tabId, { url });
}

export async function unsuspendTab(tabId: number): Promise<void> {
  const tab = await browser.tabs.get(tabId);
  if (tab.url && isSuspendedUrl(tab.url)) {
    await browser.tabs.update(tabId, { url: realUrl(tab.url) });
  }
}

/** Sweep all tabs and suspend those idle past the threshold. Called on an alarm. */
export async function autoSuspendSweep(lastActive: Map<number, number>): Promise<number> {
  const s = await getSettings();
  if (!s.suspendEnabled) return 0;
  const cutoff = Date.now() - s.suspendAfterMin * 60_000;
  const tabs = await browser.tabs.query({});
  let n = 0;
  for (const tab of tabs) {
    if (tab.id == null) continue;
    const seen = lastActive.get(tab.id) ?? 0;
    if (seen > cutoff) continue;
    if (await shouldSuspend(tab)) {
      await suspendTab(tab.id);
      n++;
    }
  }
  return n;
}

/** Build a shareable text/markdown blob for a set of URLs (used by "Share session"). */
export function shareableText(name: string, urls: { title: string; url: string }[]): string {
  return [`${name}`, ...urls.map((u) => `- ${u.title}: ${u.url}`)].join('\n');
}
