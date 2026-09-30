import { describe, expect, it } from 'vitest';
import { createSphereMesh } from '../../src/core/sphereMesh';
import type { SphereMesh, WorldDraft } from '../../src/core/types';
import { draftFromSnapshot } from '../../src/tectonics/draft';
import { DEFAULT_GENERATE_PARAMS, generateRandomDraft } from '../../src/tectonics/generate';
import { TectonicSim } from '../../src/tectonics/sim';
import { runSubstep, substepCount } from '../../src/tectonics/simKinematics';
import type { SimState } from '../../src/tectonics/simState';
import { syntheticSnapshot } from '../helpers/fixtures';

// SPEC §4.4 budgets (Node, n = 100k, 12–20 plates, dt = 1): A–D ≤ 25 ms per substep, full step ≤ 60 ms.
// Assertions carry 2× slack for shared/noisy machines (SPEC §1).
const SLACK = 2;
const BUDGET_SUBSTEP_MS = 25;
const BUDGET_STEP_MS = 60;

function randomDraft(mesh: SphereMesh, seed: number, plateCount: number): WorldDraft {
  try {
    return generateRandomDraft(mesh, { ...DEFAULT_GENERATE_PARAMS, seed, plateCount });
  } catch (e) {
    if (!(e instanceof Error) || !/not implemented/.test(e.message)) throw e;
    return draftFromSnapshot(syntheticSnapshot(mesh, seed, plateCount), seed);
  }
}

const now = (): number => performance.now();

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

describe('TectonicSim performance (n = 100k)', () => {
  const mesh = createSphereMesh(100_000);

  for (const plates of [12, 20]) {
    it(`${plates} plates: substeps A–D and full steps within budget`, () => {
      const sim = new TectonicSim(mesh, randomDraft(mesh, 3, plates));
      sim.step(5); // warm-up (JIT, scratch allocation)
      const state = (sim as unknown as { state: SimState }).state;

      const substepMs: number[] = [];
      for (let s = 0; s < 8; s++) {
        const { count } = substepCount(state, 1);
        const t0 = now();
        for (let q = 0; q < count; q++) runSubstep(state, 1 / count);
        substepMs.push((now() - t0) / count);
      }
      const stepMs: number[] = [];
      for (let s = 0; s < 12; s++) {
        const t0 = now();
        sim.step();
        stepMs.push(now() - t0);
      }
      const sub = median(substepMs);
      const step = median(stepMs);
      console.log(`[tectonics perf] n=100k plates=${plates}: A–D ${sub.toFixed(1)} ms/substep (budget ${BUDGET_SUBSTEP_MS}), step ${step.toFixed(1)} ms (budget ${BUDGET_STEP_MS})`);
      expect(sub).toBeLessThan(BUDGET_SUBSTEP_MS * SLACK);
      expect(step).toBeLessThan(BUDGET_STEP_MS * SLACK);
    });
  }

  it('snapshot and toDraft stay interactive', () => {
    const sim = new TectonicSim(mesh, randomDraft(mesh, 4, 16));
    sim.step(3);
    const t0 = now();
    sim.snapshot();
    const snapMs = now() - t0;
    const t1 = now();
    sim.toDraft();
    const draftMs = now() - t1;
    console.log(`[tectonics perf] snapshot ${snapMs.toFixed(1)} ms, toDraft ${draftMs.toFixed(1)} ms`);
    expect(snapMs).toBeLessThan(40 * SLACK);
    expect(draftMs).toBeLessThan(20 * SLACK);
  });
});
