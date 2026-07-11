import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { DEV_API_TOKEN_HEADER } from './src/dev/devApiAuthorization';

const devApiToken = process.env.TASK_MANAGER_DEV_API_TOKEN;

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    cors: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3099',
        headers: devApiToken ? { [DEV_API_TOKEN_HEADER]: devApiToken } : undefined
      }
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}']
  }
});
