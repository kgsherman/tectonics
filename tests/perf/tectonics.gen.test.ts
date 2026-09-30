import { describe, expect, it } from 'vitest';
import { createSphereMesh } from '../../src/core/sphereMesh';
import type { GenerateParams } from '../../src/core/types';
import { finalizeDraft, resampleDraft } from '../../src/tectonics/draft';
import { DEFAULT_GENERATE_PARAMS, generateRandomDraft } from '../../src/tectonics/generate';

const now = (): number => globalThis.performance?.now?.() ?? Date.now();

/** Best of `runs` wall-clock timings (ms); the first call also warms up the JIT. */
function best(runs: number, f: (k: number) => void): number {
  let b = Infinity;
  for (let k = 0; k < runs; k++) {
    const t = now();
    f(k);
    b = Math.min(b, now() - t);
  }
  return b;
}

describe('tectonics-generate perf (n = 100k)', () => {
  const mesh = createSphereMesh(100_000);
  const modes: GenerateParams['continentMode'][] = ['scattered', 'supercontinent', 'archipelago'];

  it('generateRandomDraft ≤ 600 ms', () => {
    generateRandomDraft(mesh, DEFAULT_GENERATE_PARAMS); // warm-up (JIT, edge-length cache)
    for (const mode of modes) {
      const ms = best(3, (k) => generateRandomDraft(mesh, { ...DEFAULT_GENERATE_PARAMS, continentMode: mode, seed: 10 + k }));
      console.log(`generateRandomDraft ${mode}: ${ms.toFixed(0)} ms`);
      expect(ms).toBeLessThanOrEqual(600);
    }
    const ms30 = best(2, (k) => generateRandomDraft(mesh, { ...DEFAULT_GENERATE_PARAMS, plateCount: 30, seed: 20 + k }));
    console.log(`generateRandomDraft 30 plates: ${ms30.toFixed(0)} ms`);
    expect(ms30).toBeLessThanOrEqual(600);
  });

  it('finalizeDraft and resampleDraft', () => {
    const d = generateRandomDraft(mesh, DEFAULT_GENERATE_PARAMS);
    const fin = best(3, () => finalizeDraft(mesh, d, 1));
    const m40 = createSphereMesh(40_000);
    const down = best(2, () => resampleDraft(mesh, m40, d));
    const d40 = resampleDraft(mesh, m40, d);
    const up = best(2, () => resampleDraft(m40, mesh, d40));
    console.log(`finalizeDraft 100k: ${fin.toFixed(0)} ms; resample 100k→40k: ${down.toFixed(0)} ms; 40k→100k: ${up.toFixed(0)} ms`);
    // ~50 / ~10 / ~20 ms on the dev machine; the resample bounds catch a nearestCell hint regression
    // (walking from the previous Fibonacci cell made both ~6× slower).
    expect(fin).toBeLessThanOrEqual(200);
    expect(down).toBeLessThanOrEqual(60);
    expect(up).toBeLessThanOrEqual(100);
  });
});
