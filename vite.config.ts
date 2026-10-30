import { defineConfig, type Plugin } from 'vite';

// Strict Content Security Policy, injected into production builds only (the dev server needs inline HMR
// scripts). Scripts, styles and workers come from the app itself; the only outside hosts are the map tile
// servers, for images. `connect-src 'none'` blocks fetch, XHR, WebSocket and beacons, so even buggy or
// tampered code has no channel to send your data with. frame-ancestors cannot be set from a meta tag; set
// it (and the other headers in the README) on the web server if you host the app yourself.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data: https://tile.openstreetmap.org https://a.tile.opentopomap.org https://b.tile.opentopomap.org https://c.tile.opentopomap.org",
  "worker-src 'self' blob:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const csp = (): Plugin => ({
  name: 'inject-csp',
  apply: 'build',
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
  ],
});

export default defineConfig({
  base: './',
  plugins: [csp()],
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false },
  test: { include: ['tests/**/*.test.ts'] },
} as never);
