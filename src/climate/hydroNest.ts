/**
 * Nested solve of the moisture solver (cold and warm starts on large grids). The slow part of the
 * monthly balance is global (moisture residence times of 1–2 weeks of pseudo-time), while
 * resolution-dependent detail (ridges, coasts) adjusts within a few steps. So the annual cycle is
 * first solved on a 2× coarser, box-averaged copy of the dynamics (≈ 8× cheaper per simulated day),
 * whose monthly column RH and precipitation are then interpolated to the full grid as the starting
 * state of a short fine relaxation. A warm start seeds the coarse level (downMonthly).
 */
import { resampleGrid } from '../core/grid';
import type { DynamicsResult } from './internal';

/** Box average of a 12-month field from (w, h) to (w2, h2) = (w/2, h/2). */
export function downMonthly(f: Float32Array, w: number, h: number, w2: number, h2: number): Float32Array {
  const n = w * h;
  const n2 = w2 * h2;
  const out = new Float32Array(12 * n2);
  for (let m = 0; m < 12; m++) out.set(resampleGrid(f.subarray(m * n, (m + 1) * n), w, h, w2, h2), m * n2);
  return out;
}

/** Whether `dyn` can be halved for a nested start (even dimensions, coarse grid ≥ minWidth wide). */
export function canNest(w: number, h: number, minWidth: number): boolean {
  return w % 2 === 0 && h % 2 === 0 && w / 2 >= minWidth && h / 2 >= 2;
}

/** Box-average every field of `dyn` onto a (w/2)×(h/2) grid. */
export function downsampleDynamics(dyn: DynamicsResult): DynamicsResult {
  const { w, h } = dyn;
  const w2 = w / 2;
  const h2 = h / 2;
  const landFraction = resampleGrid(dyn.landFraction, w, h, w2, h2);
  const land = new Uint8Array(w2 * h2);
  for (let i = 0; i < land.length; i++) land[i] = landFraction[i] >= 0.5 ? 1 : 0;
  const d = (f: Float32Array) => downMonthly(f, w, h, w2, h2);
  return {
    w: w2,
    h: h2,
    params: { ...dyn.params, gridW: w2, gridH: h2 },
    land,
    landFraction,
    elev: resampleGrid(dyn.elev, w, h, w2, h2),
    surfaceHeight: resampleGrid(dyn.surfaceHeight, w, h, w2, h2),
    temp: d(dyn.temp),
    sst: d(dyn.sst),
    seaIce: d(dyn.seaIce),
    pressure: d(dyn.pressure),
    windU: d(dyn.windU),
    windV: d(dyn.windV),
    steerU: d(dyn.steerU),
    steerV: d(dyn.steerV),
    ascent: d(dyn.ascent),
    baroclinic: d(dyn.baroclinic),
    currentU: d(dyn.currentU),
    currentV: d(dyn.currentV),
    upwelling: d(dyn.upwelling),
    timings: {},
    stats: {},
  };
}

/** Bilinear interpolation of a 12-month field from (w2, h2) to (w, h). */
export function upsampleMonthly(f: Float32Array, w2: number, h2: number, w: number, h: number): Float32Array {
  const n = w * h;
  const n2 = w2 * h2;
  const out = new Float32Array(12 * n);
  for (let m = 0; m < 12; m++) out.set(resampleGrid(f.subarray(m * n2, (m + 1) * n2), w2, h2, w, h), m * n);
  return out;
}
