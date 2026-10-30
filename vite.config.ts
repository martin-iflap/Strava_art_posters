import { defineConfig, type Plugin } from 'vite';

// Strict CSP, injected for production builds only. The only outside hosts are the optional map tile servers
// (images only, and only after the user turns a map background on). Formerly:
// Strict CSP, injected for production builds only (the dev server needs inline HMR scripts).
const CSP = [
  "default-src 'self'",
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
