import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = `http://127.0.0.1:${process.env.HARNESS_API_PORT ?? process.env.PORT ?? 4000}`;

export default defineConfig({
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1200 },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { target: api, changeOrigin: false } },
  },
});
