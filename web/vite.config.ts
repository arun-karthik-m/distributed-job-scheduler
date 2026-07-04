import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy: the dashboard calls /api/*, forwarded to the Fastify API on :3000 (strips /api).
// Keeps the client origin-relative and avoids CORS entirely.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});
