/**
 * Hydrology behaviour on the analytic zonal dynamics (tests/helpers/fixtures.ts) over the
 * idealized continent (40° wide, 60°S–70°N, 3 km ridge near its west coast). The fixture's winds
 * are zonal belts (trades < 30°, westerlies 30–60°, polar easterlies), so the tests check the
 * asymmetries those winds imply; SPEC §6.4 asymmetries that need a real circulation (subtropical
 * highs, monsoons) and real coastal temperatures are covered in climate.hydro.dynamics.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { computeHydrology } from '../src/climate/hydrology';
import { HYDRO_TUNING } from '../src/climate/hydroTuning';
import type { DynamicsResult, HydrologyResult } from '../src/climate/internal';
import { idealContinentElevation, zonalDynamics } from './helpers/fixtures';

/** The dynamics of the planet mirrored east–west (longitude → −longitude, eastward components negated). */
function mirrorEastWest(d: DynamicsResult): DynamicsResult {
  const { w, h } = d;
  const n = w * h;
  const flip = <T extends Float32Array | Uint8Array>(a: T, negate = false): T => {
    const o = a.slice() as T;
    for (let k = 0; k < a.length; k += n) {
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) o[k + r * w + c] = (negate ? -1 : 1) * a[k + r * w + (w - 1 - c)];
      }
    }
    return o;
  };
  return {
    ...d,
    land: flip(d.land), landFraction: flip(d.landFraction), elev: flip(d.elev), surfaceHeight: flip(d.surfaceHeight),
    temp: flip(d.temp), sst: flip(d.sst), seaIce: flip(d.seaIce), pressure: flip(d.pressure),
    windU: flip(d.windU, true), windV: flip(d.windV), steerU: flip(d.steerU, true), steerV: flip(d.steerV),
    ascent: flip(d.ascent), baroclinic: flip(d.baroclinic), currentU: flip(d.currentU, true), currentV: flip(d.currentV),
    upwelling: flip(d.upwelling),
  };
}

const W = 180;
const H = 90;
const N = W * H;
const lat = (r: number) => 90 - ((r + 0.5) * 180) / H;
const lon = (c: number) => -180 + ((c + 0.5) * 360) / W;

let dyn: DynamicsResult;
let hy: HydrologyResult;

function annual(res: HydrologyResult, i: number): number {
  let s = 0;
  for (let m = 0; m < 12; m++) s += res.precip[m * N + i];
  return s;
}

/** Mean annual precipitation (mm) over land (or all) cells inside a lat/lon box (degrees). */
function boxMean(res: HydrologyResult, la0: number, la1: number, lo0: number, lo1: number, landOnly = true): number {
  let s = 0;
  let k = 0;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (lat(r) < la0 || lat(r) > la1 || lon(c) < lo0 || lon(c) > lo1) continue;
      if (landOnly && !dyn.land[i]) continue;
      s += annual(res, i);
      k++;
    }
  }
  if (k === 0) throw new Error('empty box');
  return s / k;
}

beforeAll(() => {
  dyn = zonalDynamics(W, H, idealContinentElevation(W, H), { fast: false });
  hy = computeHydrology(dyn);
});

describe('computeHydrology on the idealized continent (zonal dynamics)', () => {
  it('returns finite, physically bounded fields of the right size', () => {
    for (const a of [hy.precip, hy.evap, hy.snow, hy.cloud, hy.rh]) expect(a.length).toBe(12 * N);
    for (let k = 0; k < 12 * N; k++) {
      expect(Number.isFinite(hy.precip[k]) && hy.precip[k] >= 0).toBe(true);
      expect(Number.isFinite(hy.evap[k]) && hy.evap[k] >= 0).toBe(true);
      expect(hy.snow[k] >= 0 && hy.snow[k] <= 1).toBe(true);
      expect(hy.cloud[k] >= 0 && hy.cloud[k] <= 1).toBe(true);
      expect(Number.isFinite(hy.rh[k]) && hy.rh[k] >= 0 && hy.rh[k] < 2).toBe(true);
    }
  });

  it('closes the global water balance (|P − E| / E < 5%) with plausible magnitudes', () => {
    expect(hy.stats.waterBalanceError).toBeLessThan(0.05);
    expect(hy.stats.globalPrecipMmYr).toBeGreaterThan(500);
    expect(hy.stats.globalPrecipMmYr).toBeLessThan(2000);
    expect(hy.stats.hydroMonthsConverged).toBe(12);
  });

  it('land evapotranspiration never exceeds precipitation over land', () => {
    for (let i = 0; i < N; i++) {
      if (!dyn.land[i]) continue;
      let p = 0;
      let e = 0;
      for (let m = 0; m < 12; m++) {
        p += hy.precip[m * N + i];
        e += hy.evap[m * N + i];
      }
      expect(e).toBeLessThanOrEqual(p + 1e-3);
    }
  });

  it('the ITCZ rain belt follows the season', () => {
    const itcz = (m: number) => {
      let best = -1;
      let at = 0;
      for (let r = 0; r < H; r++) {
        let s = 0;
        for (let c = 0; c < W; c++) s += hy.precip[m * N + r * W + c];
        if (s > best) {
          best = s;
          at = lat(r);
        }
      }
      return at;
    };
    expect(itcz(6) - itcz(0)).toBeGreaterThanOrEqual(10);
    expect(itcz(6)).toBeGreaterThan(0);
    expect(itcz(0)).toBeLessThan(0);
  });

  it('polar regions are dry compared with the tropics', () => {
    const polar = (boxMean(hy, 75, 90, -180, 180, false) + boxMean(hy, -90, -75, -180, 180, false)) / 2;
    const tropics = boxMean(hy, -10, 10, -180, 180, false);
    expect(polar).toBeLessThan(300);
    expect(polar).toBeLessThan(0.1 * tropics);
  });

  it('rain shadow: lee of the 3 km ridge gets ≤ 0.5× the windward precipitation', () => {
    // Westerlies 40–55°N/S: windward = western flank, lee = eastern flank.
    for (const [a, b] of [[40, 55], [-55, -40]]) {
      const windward = boxMean(hy, a, b, -20, -15.5);
      const lee = boxMean(hy, a, b, -13, -9);
      expect(lee).toBeLessThanOrEqual(0.5 * windward);
    }
  });

  it('trade-wind coasts: onshore east coast ≥ 3× the leeward west coast (15–28°)', () => {
    for (const [a, b] of [[15, 28], [-28, -15]]) {
      const east = boxMean(hy, a, b, 16, 20);
      const west = boxMean(hy, a, b, -20, -16);
      expect(east).toBeGreaterThanOrEqual(3 * west);
    }
  });

  it('continental interior at 45–50° (≥ 1500 km inland) gets ≤ 0.5× the west coast', () => {
    const interior = boxMean(hy, 45, 50, -2, 6);
    const coast = boxMean(hy, 45, 50, -20, -18);
    expect(interior).toBeLessThanOrEqual(0.5 * coast);
  });

  it('snow cover is seasonal in continental interiors and absent in the tropical lowlands', () => {
    const at = (la: number, lo: number, m: number) => {
      const r = Math.round((90 - la) / (180 / H) - 0.5);
      const c = Math.round((lo + 180) / (360 / W) - 0.5);
      return hy.snow[m * N + r * W + c];
    };
    expect(at(60, 0, 0)).toBeGreaterThan(0.5);
    expect(at(60, 0, 6)).toBeLessThan(0.1);
    expect(at(-50, 0, 6)).toBeGreaterThan(0.5);
    expect(at(-50, 0, 0)).toBeLessThan(0.1);
    for (let m = 0; m < 12; m++) {
      for (let r = 0; r < H; r++) {
        if (Math.abs(lat(r)) > 25) continue;
        for (let c = 0; c < W; c++) {
          const i = r * W + c;
          if (dyn.surfaceHeight[i] < 1000) expect(hy.snow[m * N + i]).toBeLessThan(0.01);
        }
      }
    }
  });

  it('warm start converges faster and to the same answer', () => {
    const warm = computeHydrology(dyn, hy);
    expect(warm.stats.hydroSteps).toBeLessThan(0.5 * hy.stats.hydroSteps);
    let worst = 0;
    for (let i = 0; i < N; i++) {
      const a = annual(hy, i);
      if (a < 100) continue;
      worst = Math.max(worst, Math.abs(annual(warm, i) - a) / a);
    }
    expect(worst).toBeLessThan(0.05);
  });

  it('is deterministic', () => {
    const again = computeHydrology(dyn);
    expect(again.precip).toEqual(hy.precip);
    expect(again.snow).toEqual(hy.snow);
  });

  it('the moisture multiplier scales the hydrological cycle', () => {
    const d2 = zonalDynamics(W, H, idealContinentElevation(W, H), { fast: false, moisture: 0.5 });
    const dry = computeHydrology(d2, hy);
    expect(dry.stats.globalPrecipMmYr).toBeLessThan(0.8 * hy.stats.globalPrecipMmYr);
    expect(dry.stats.waterBalanceError).toBeLessThan(0.05);
  });
});

describe('computeHydrology robustness', () => {
  const finiteAll = (r: HydrologyResult) => {
    for (const a of [r.precip, r.evap, r.snow, r.cloud, r.rh]) {
      for (let k = 0; k < a.length; k++) if (!Number.isFinite(a[k]) || a[k] < 0) return false;
    }
    return true;
  };

  it('handles an aquaplanet, tilt 0 and 90, retrograde spin and a 70%-land world', () => {
    const w = 90;
    const h = 45;
    const ocean = new Float32Array(w * h).fill(-4000);
    // 70% land (SPEC §6.4 extreme): an ocean sector spanning 30% of the longitudes.
    const land = new Float32Array(w * h).fill(500);
    for (let r = 0; r < h; r++) for (let c = 0; c < Math.round(0.3 * w); c++) land[r * w + c] = -3000;
    const cases: DynamicsResult[] = [
      zonalDynamics(w, h, ocean),
      zonalDynamics(w, h, ocean, { axialTilt: 0 }),
      zonalDynamics(w, h, idealContinentElevation(w, h), { axialTilt: 90 }),
      zonalDynamics(w, h, idealContinentElevation(w, h), { retrograde: true }),
      zonalDynamics(w, h, land),
    ];
    for (const d of cases) {
      const r = computeHydrology(d);
      expect(finiteAll(r)).toBe(true);
      expect(r.stats.globalPrecipMmYr).toBeGreaterThan(0);
      expect(r.stats.waterBalanceError).toBeLessThan(0.05);
    }
  });

  it('aquaplanet at tilt 0 is zonally uniform and north–south symmetric', () => {
    // Even row count: the fixture's winds are only mirror-symmetric without an equator row.
    const w = 88;
    const h = 44;
    const d = zonalDynamics(w, h, new Float32Array(w * h).fill(-4000), { axialTilt: 0 });
    const r = computeHydrology(d);
    const n = w * h;
    let worstZonal = 0;
    let worstNS = 0;
    for (let row = 0; row < h; row++) {
      let mean = 0;
      for (let c = 0; c < w; c++) for (let m = 0; m < 12; m++) mean += r.precip[m * n + row * w + c] / w;
      for (let c = 0; c < w; c++) {
        let a = 0;
        let b = 0;
        for (let m = 0; m < 12; m++) {
          a += r.precip[m * n + row * w + c];
          b += r.precip[m * n + (h - 1 - row) * w + c];
        }
        worstZonal = Math.max(worstZonal, Math.abs(a - mean) / (mean + 10));
        worstNS = Math.max(worstNS, Math.abs(a - b) / (a + 10));
      }
    }
    expect(worstZonal).toBeLessThan(1e-3);
    expect(worstNS).toBeLessThan(0.02);
    // No stripes around ±10° (SPEC §6.4): the annual zonal mean falls monotonically from the
    // ITCZ flank (5°) to the subtropics (25°).
    const zonal = (row: number) => {
      let s = 0;
      for (let c = 0; c < w; c++) for (let m = 0; m < 12; m++) s += r.precip[m * n + row * w + c];
      return s / w;
    };
    for (let row = 0; row < h; row++) {
      const la = Math.abs(90 - ((row + 0.5) * 180) / h);
      const inner = row < h / 2 ? row + 1 : row - 1; // one row closer to the equator
      if (la < 5 || la > 25) continue;
      expect(zonal(row)).toBeLessThan(zonal(inner));
    }
  });

  it('rejects malformed input instead of guessing', () => {
    const d = zonalDynamics(90, 45);
    expect(() => computeHydrology({ ...d, temp: new Float32Array(10) })).toThrow(/temp/);
    // A non-finite dynamics value is reported by field, not as a non-finite output far away.
    const ascent = d.ascent.slice();
    ascent[1234] = NaN;
    expect(() => computeHydrology({ ...d, ascent })).toThrow(/ascent\[1234\]/);
  });

  it('retrograde mirror symmetry: east–west mirrored dynamics give the mirrored hydrology', () => {
    const w = 90;
    const h = 45;
    const n = w * h;
    const d = zonalDynamics(w, h, idealContinentElevation(w, h));
    const a = computeHydrology(d);
    const b = computeHydrology(mirrorEastWest(d));
    let worst = 0;
    for (let m = 0; m < 12; m++) {
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          const pa = a.precip[m * n + r * w + c];
          const pb = b.precip[m * n + r * w + (w - 1 - c)];
          worst = Math.max(worst, Math.abs(pa - pb) / (pa + 1));
        }
      }
    }
    expect(worst).toBeLessThan(1e-4);
  });

  it('moisture 0 is a dry planet (no leftover initial or warm-start water raining out)', () => {
    const e = idealContinentElevation(90, 45);
    const wet = computeHydrology(zonalDynamics(90, 45, e));
    for (const warm of [null, wet]) {
      const r = computeHydrology(zonalDynamics(90, 45, e, { moisture: 0 }), warm);
      expect(finiteAll(r)).toBe(true);
      expect(r.precip.every((p) => p === 0)).toBe(true);
      expect(r.evap.every((v) => v === 0)).toBe(true);
      expect(r.stats.waterBalanceError).toBe(0);
    }
  });

  it('stays finite for calibration overrides at their edges', () => {
    const w = 90;
    const h = 45;
    // Rows 0–10 all land: an ocean-weighted zonal reference with land weight 0 has no cells.
    const e = new Float32Array(w * h).fill(500);
    for (let r = 11; r < h; r++) for (let c = 0; c < 20; c++) e[r * w + c] = -3000;
    expect(finiteAll(computeHydrology(zonalDynamics(w, h, e), null, undefined, { referenceLandWeight: 0 }))).toBe(true);
    // More sink sub-steps than the per-cell Uint8 counter holds (small grid: 255 sub-steps per cell).
    const d = zonalDynamics(32, 16, idealContinentElevation(32, 16));
    expect(finiteAll(computeHydrology(d, null, undefined, { maxSinkSubsteps: 300, sinkStiffnessBound: 0.004 }))).toBe(true);
  });

  it('a warm start from another world seeds the coarse level of a nested solve', () => {
    // 180×90 in fast mode nests (SPEC budget case). Seeding the full grid directly used to run up to
    // maxStepsFast fine steps per month from a poor seed — slower than a cold start — and, capped,
    // left cells 80% away from the cold answer.
    const w = 180;
    const h = 90;
    const n = w * h;
    const d = zonalDynamics(w, h, idealContinentElevation(w, h), { fast: true });
    const cold = computeHydrology(d);
    const other = computeHydrology(zonalDynamics(w, h, new Float32Array(n).fill(-4000), { fast: true, axialTilt: 60 }));
    const warm = computeHydrology(d, other);
    expect(warm.stats.hydroCoarseSteps).toBeGreaterThan(0);
    expect(warm.stats.hydroSteps).toBeLessThanOrEqual(12 * HYDRO_TUNING.nestFineStepsFast);
    // Bounded cost: fine relaxation plus coarse steps (≈ 8× cheaper each) under their caps.
    expect(warm.stats.hydroCoarseSteps).toBeLessThanOrEqual(12 * HYDRO_TUNING.maxStepsFast);
    let worst = 0;
    let diff = 0;
    let total = 0;
    for (let i = 0; i < n; i++) {
      let pc = 0;
      let pw = 0;
      for (let m = 0; m < 12; m++) {
        pc += cold.precip[m * n + i];
        pw += warm.precip[m * n + i];
      }
      diff += Math.abs(pw - pc);
      total += pc;
      if (pc > 100) worst = Math.max(worst, Math.abs(pw - pc) / pc);
    }
    // Fast mode caps the coarse steps, so a far-off seed is not fully forgotten: small, bounded.
    expect(diff / total).toBeLessThan(0.005);
    expect(worst).toBeLessThan(0.1);
  });

  it('reports progress monotonically up to ~1', () => {
    const seen: number[] = [];
    computeHydrology(zonalDynamics(90, 45), null, (f) => seen.push(f));
    expect(seen.length).toBeGreaterThan(5);
    for (let k = 1; k < seen.length; k++) expect(seen[k]).toBeGreaterThanOrEqual(seen[k - 1]);
    expect(seen[seen.length - 1]).toBeGreaterThan(0.9);
    expect(seen[seen.length - 1]).toBeLessThanOrEqual(1);
  });
});
