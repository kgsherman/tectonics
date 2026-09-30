import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Dev-only helper: POST a data URL (or raw PNG bytes) to /__snap?name=foo.png and it is written to
 * scratch/snaps/foo.png. Used for full-resolution visual QA of the WebGL canvas during development.
 */
function devSnapshots(): Plugin {
  return {
    name: 'worldgen-dev-snapshots',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__snap', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const url = new URL(req.url ?? '', 'http://localhost');
        const name = (url.searchParams.get('name') ?? 'snap.png').replace(/[^\w.-]/g, '_');
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          let body = Buffer.concat(chunks);
          const text = body.subarray(0, 32).toString('latin1');
          if (text.startsWith('data:')) body = Buffer.from(body.toString('latin1').split(',')[1] ?? '', 'base64');
          const file = resolve(__dirname, 'scratch/snaps', name);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, body);
          res.setHeader('content-type', 'text/plain');
          res.end(file);
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [devSnapshots()],
  worker: { format: 'es' },
  server: { port: 5188, strictPort: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/perf/**', 'node_modules/**'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
