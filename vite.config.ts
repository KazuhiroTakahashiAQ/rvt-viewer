import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// GitHub Pages: https://kazuhirotakahashiaq.github.io/rvt-viewer/
const BASE = '/rvt-viewer/';

// Strict CSP for the production build: nothing but this origin is reachable,
// so a dropped .rvt can never leave the tab. (The dev server needs inline
// scripts for React Fast Refresh, so the policy is injected at build only.)
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' blob:",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const cspPlugin: Plugin = {
  name: 'rvt-viewer-csp',
  apply: 'build',
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
  ],
};

// Ship the license and notices (which cover the bundled rvt-rs WebAssembly).
const noticesPlugin: Plugin = {
  name: 'rvt-viewer-notices',
  apply: 'build',
  generateBundle() {
    for (const name of ['LICENSE', 'NOTICE']) {
      this.emitFile({ type: 'asset', fileName: `${name}.txt`, source: readFileSync(new URL(`./${name}`, import.meta.url), 'utf8') });
    }
  },
};

export default defineConfig({
  base: BASE,
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [
    react(),
    cspPlugin,
    noticesPlugin,
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        id: BASE,
        name: 'RVT ビューア',
        short_name: 'RVT ビューア',
        description: 'Revit ファイル (.rvt) をブラウザだけで閲覧するビューア。ファイルは端末外に送信されません。',
        lang: 'ja',
        dir: 'ltr',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        display_override: ['window-controls-overlay', 'standalone'],
        orientation: 'any',
        theme_color: '#1f3a5f',
        background_color: '#f0f0f0',
        categories: ['productivity', 'utilities'],
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        file_handlers: [
          {
            action: BASE,
            accept: {
              'application/octet-stream': ['.rvt', '.rfa', '.rte', '.rft'],
            },
          },
        ],
        launch_handler: { client_mode: 'focus-existing' },
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm,webmanifest,txt}'],
        // rvt_bg.wasm is ~4 MB.
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        navigateFallback: `${BASE}index.html`,
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: true,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
});
