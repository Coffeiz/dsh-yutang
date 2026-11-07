import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const appsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_DEV_PORT ?? 9556),
    strictPort: true,
    fs: { allow: [appsDir] },
    proxy: {
      '/v1': { target: process.env.API_PROXY ?? 'http://127.0.0.1:9555', ws: true },
      '/admin/v1': process.env.ADMIN_API_PROXY ?? 'http://127.0.0.1:9555',
      '/admin': { target: process.env.ADMIN_WEB_PROXY ?? 'http://127.0.0.1:5174', ws: true, rewrite: path => path === '/admin' ? '/admin/' : path },
    },
  },
});
