/**
 * Perf suite (SPEC §1 rules: perf assertions live in tests/perf/, run with `npm run perf`).
 * The default config (vite.config.ts) excludes tests/perf/** so `npm test` stays fast; vitest applies
 * that exclude even to explicit file filters, so the perf suite needs its own include/exclude lists.
 *   npm run perf                       # whole suite, files run sequentially
 *   npm run perf -- tests/perf/<file>  # one file
 */
import { defineConfig } from 'vitest/config';
import base from './vite.config.ts';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    // Replaced, not merged (mergeConfig would concatenate and keep the tests/perf exclude).
    include: ['tests/perf/**/*.test.ts'],
    exclude: ['node_modules/**'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
