import { defineConfig } from 'vitest/config';

export default defineConfig({
  worker: { format: 'es' },
  server: { port: 5173, strictPort: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/perf/**', 'node_modules/**'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
