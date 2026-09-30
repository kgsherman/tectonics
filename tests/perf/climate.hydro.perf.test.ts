/**
 * Hydrology budgets (SPEC §6.2): full ≤ 2 s at 360×180, fast ≤ 0.4 s at 180×90 (Node), for cold and
 * warm starts. Measured on the analytic zonal dynamics over the idealized continent after a JIT
 * warm-up; assertions allow the 2× slack of a shared machine (SPEC §1), the measured times are logged.
 */
import { describe, expect, it } from 'vitest';
import { computeHydrology } from '../../src/climate/hydrology';
import { idealContinentElevation, zonalDynamics } from '../helpers/fixtures';

const SLACK = 2;
const now = () => performance.now();

function best(runs: number, f: () => void): number {
  let min = Infinity;
  for (let k = 0; k < runs; k++) {
    const t0 = now();
    f();
    min = Math.min(min, now() - t0);
  }
  return min;
}

describe('hydrology performance', () => {
  // JIT warm-up on a small grid (both code paths: direct and nested).
  computeHydrology(zonalDynamics(90, 44, idealContinentElevation(90, 44), { fast: false }));
  computeHydrology(zonalDynamics(180, 90, idealContinentElevation(180, 90), { fast: true }));

  it('full 360×180 cold start ≤ 2 s, and a warm start from another world too', () => {
    const dyn = zonalDynamics(360, 180, idealContinentElevation(360, 180), { fast: false });
    const ms = best(2, () => computeHydrology(dyn));
    // A poor seed (different world / changed parameters) used to cost up to 80 fine steps per month
    // (≈ 1.7× a cold start); warm starts now seed the coarse level of the nested solve.
    const other = computeHydrology(zonalDynamics(360, 180, new Float32Array(360 * 180).fill(-4000), { fast: false, axialTilt: 60 }));
    const warm = best(1, () => computeHydrology(dyn, other));
    console.log(`hydrology full 360x180: cold ${ms.toFixed(0)} ms, warm from another world ${warm.toFixed(0)} ms (budget 2000)`);
    expect(ms).toBeLessThan(2000 * SLACK);
    expect(warm).toBeLessThan(2000 * SLACK);
    expect(warm).toBeLessThan(1.3 * ms);
  });

  it('fast 180×90 cold and warm starts ≤ 0.4 s', () => {
    const dyn = zonalDynamics(180, 90, idealContinentElevation(180, 90), { fast: true });
    let res = computeHydrology(dyn);
    const cold = best(3, () => {
      res = computeHydrology(dyn);
    });
    const warm = best(3, () => computeHydrology(dyn, res));
    console.log(`hydrology fast 180x90: cold ${cold.toFixed(0)} ms, warm ${warm.toFixed(0)} ms (budget 400)`);
    expect(cold).toBeLessThan(400 * SLACK);
    expect(warm).toBeLessThan(400 * SLACK);
    // Nested warm starts only save coarse steps; they must not cost more than a cold start.
    expect(warm).toBeLessThan(1.15 * cold);
  });
});
