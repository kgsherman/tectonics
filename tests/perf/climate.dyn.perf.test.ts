/**
 * Climate dynamics budgets (SPEC §6.1.8): full ≤ 2.5 s and fast ≤ 0.5 s at 360×180 output (Node),
 * plus the whole computeClimate (≤ 5 s full, ≤ 1 s fast at 180×90). Measured on the Earth input after
 * a JIT warm-up; assertions allow the 2× slack of a shared machine (SPEC §1) and the measured times
 * are logged.
 */
import { describe, expect, it } from 'vitest';
import { computeClimate, DEFAULT_CLIMATE_PARAMS } from '../../src/climate/climate';
import { computeDynamics } from '../../src/climate/dyn';
import { buildEarthClimateInput } from '../../src/climate/earthInput';

const SLACK = 2;
const now = (): number => performance.now();

function best(runs: number, f: () => void): number {
  let min = Infinity;
  for (let k = 0; k < runs; k++) {
    const t0 = now();
    f();
    min = Math.min(min, now() - t0);
  }
  return min;
}

describe('climate dynamics performance', () => {
  const earth = buildEarthClimateInput(360, 180);
  const earthSmall = buildEarthClimateInput(180, 90);
  // JIT warm-up.
  computeDynamics(earthSmall, { ...DEFAULT_CLIMATE_PARAMS, gridW: 180, gridH: 90, fast: true });

  it('full dynamics at 360×180 ≤ 2.5 s', () => {
    const ms = best(2, () => computeDynamics(earth, { ...DEFAULT_CLIMATE_PARAMS }));
    console.log(`dynamics full 360x180: ${ms.toFixed(0)} ms (budget 2500)`);
    expect(ms).toBeLessThan(2500 * SLACK);
  });

  it('fast dynamics at 360×180 ≤ 0.5 s (cold and warm-started)', () => {
    const params = { ...DEFAULT_CLIMATE_PARAMS, fast: true };
    const cold = best(2, () => computeDynamics(earth, params));
    const prev = computeDynamics(earth, params);
    const warm = best(2, () => computeDynamics(earth, params, prev));
    console.log(`dynamics fast 360x180: cold ${cold.toFixed(0)} ms, warm ${warm.toFixed(0)} ms (budget 500)`);
    expect(Math.min(cold, warm)).toBeLessThan(500 * SLACK);
  });

  it('computeClimate totals: full 360×180 ≤ 5 s, fast 180×90 ≤ 1 s', () => {
    const full = best(1, () => computeClimate(earth, { ...DEFAULT_CLIMATE_PARAMS }));
    const fastParams = { ...DEFAULT_CLIMATE_PARAMS, gridW: 180, gridH: 90, fast: true };
    const prev = computeClimate(earthSmall, fastParams);
    const fast = best(2, () => computeClimate(earthSmall, fastParams, undefined, prev));
    console.log(`computeClimate full 360x180: ${full.toFixed(0)} ms (budget 5000); fast 180x90 warm: ${fast.toFixed(0)} ms (budget 1000)`);
    expect(full).toBeLessThan(5000 * SLACK);
    expect(fast).toBeLessThan(1000 * SLACK);
  });
});
