import type { ManifestV3Export } from '@crxjs/vite-plugin';

/**
 * Cross-browser MV3 manifest factory.
 * Chrome/Edge use `background.service_worker`; Firefox MV3 needs
 * `background.scripts` + `browser_specific_settings`.
 */
export function manifest(target: 'chrome' | 'firefox'): ManifestV3Export {
  const base: ManifestV3Export = {
    manifest_version: 3,
    name: 'Sessflow — Sessions, AI Groups & Sync',
    version: '0.1.0',
    description:
      'Save, search, sync and restore your tabs & windows. AI auto-grouping, full-text search, command palette, tab suspension and crash recovery.',
    icons: {
      16: 'src/icons/icon16.png',
      48: 'src/icons/icon48.png',
      128: 'src/icons/icon128.png',
    },
    action: {
      default_popup: 'src/popup/index.html',
      default_title: 'Sessflow',
      default_icon: { 16: 'src/icons/icon16.png', 48: 'src/icons/icon48.png' },
    },
    options_page: 'src/dashboard/index.html',
    permissions: [
      'tabs',
      'tabGroups',
      'storage',
      'unlimitedStorage',
      'alarms',
      'contextMenus',
      'favicon',
      'notifications',
    ],
    host_permissions: ['https://api.anthropic.com/*'],
    optional_host_permissions: ['https://*/*', 'http://*/*'], // Supabase/mesh (Tailscale serves over http) origins
    web_accessible_resources: [
      {
        resources: ['src/suspended/index.html', 'src/icons/*'],
        matches: ['<all_urls>'],
      },
    ],
    commands: {
      _execute_action: {
        suggested_key: { default: 'Alt+S', mac: 'Alt+S' },
        description: 'Open Sessflow popup',
      },
      'save-session': {
        suggested_key: { default: 'Ctrl+Shift+S', mac: 'Command+Shift+S' },
        description: 'Save all tabs in the current window as a session',
      },
      'open-dashboard': {
        suggested_key: { default: 'Ctrl+Shift+E', mac: 'Command+Shift+E' },
        description: 'Open the Sessflow dashboard',
      },
      'open-palette': {
        suggested_key: { default: 'Ctrl+Shift+K', mac: 'Command+Shift+K' },
        description: 'Open the command palette',
      },
    },
  };

  if (target === 'firefox') {
    return {
      ...base,
      background: { scripts: ['src/background/service-worker.ts'], type: 'module' } as any,
      browser_specific_settings: {
        gecko: { id: '{c0ffee00-5e55-4f10-9abc-5e5510000001}', strict_min_version: '121.0' },
      } as any,
    };
  }

  return {
    ...base,
    background: { service_worker: 'src/background/service-worker.ts', type: 'module' },
    minimum_chrome_version: '116',
  };
}
