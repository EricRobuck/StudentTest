import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = 'http://127.0.0.1:3001';

// Page headers. The exam and instructor pages must never be framed by
// another site (clickjacking). The production CSP (used by `vite preview`,
// and to copy into whatever serves the built site) also limits scripts and
// connections to this origin. The dev server can't use it because Vite's
// hot reload injects inline scripts.
const baseHeaders = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const productionCsp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // xterm.js sets inline styles
  "connect-src 'self'", // REST + same-origin WebSocket
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// In development the browser only ever talks to the Vite dev server, which
// proxies API and WebSocket traffic to the backend. This keeps everything
// same-origin, so no CORS configuration is needed and auth cookies just work.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    headers: { ...baseHeaders, 'Content-Security-Policy': "frame-ancestors 'none'" },
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/ws': { target: backend, ws: true, changeOrigin: false },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    headers: { ...baseHeaders, 'Content-Security-Policy': productionCsp },
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/ws': { target: backend, ws: true, changeOrigin: false },
    },
  },
});
