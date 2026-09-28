import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = 'http://127.0.0.1:3001';

// In development the browser only ever talks to the Vite dev server, which
// proxies API and WebSocket traffic to the backend. This keeps everything
// same-origin, so no CORS configuration is needed and auth cookies just work.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/ws': { target: backend, ws: true, changeOrigin: false },
    },
  },
});
