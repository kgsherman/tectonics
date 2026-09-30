import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
  server: { port: 5173, strictPort: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
