import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import { resolve } from 'node:path';
import { manifest } from './src/manifests/manifest';

// TARGET=firefox npm run build  →  Firefox MV3 build (background.scripts + browser_specific_settings)
const target = (process.env.TARGET as 'chrome' | 'firefox') ?? 'chrome';

export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  plugins: [
    react(),
    crx({ manifest: manifest(target), browser: target === 'firefox' ? 'firefox' : 'chrome' }),
  ],
  build: {
    outDir: target === 'firefox' ? 'dist-firefox' : 'dist',
    target: 'esnext',
    rollupOptions: {
      // Extra HTML entry points (popup + dashboard are wired via the manifest;
      // the suspended placeholder page is referenced at runtime).
      input: {
        suspended: resolve(__dirname, 'src/suspended/index.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Allow the unpacked extension's chrome-extension:// origin to fetch HMR
    // chunks + open the HMR WebSocket (Vite 5.4 tightened this default; we also
    // pin Vite to 5.3 whose permissive default keeps @crxjs HMR working).
    cors: { origin: [/^chrome-extension:\/\//, /^moz-extension:\/\//] },
  },
});
