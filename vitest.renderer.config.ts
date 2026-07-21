import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['src/renderer/test/setupDomTests.ts'],
    include: ['src/renderer/**/*.dom.test.{ts,tsx}'],
    minWorkers: 1,
    maxWorkers: 2
  }
});
