import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.ADMIN_DEV_PORT ?? 5174), strictPort: true, proxy: { '/admin/v1': process.env.ADMIN_API_PROXY ?? 'http://127.0.0.1:9555' } },
});
