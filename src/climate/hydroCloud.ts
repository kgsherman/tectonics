/**
 * Cloud-cover fraction (0..1) from column relative humidity, precipitation and marine
 * stratocumulus over cold, stable water (SPEC §6.2 "Clouds"). Diagnostic only (for rendering).
 */
import { SECONDS_PER_MONTH } from '../core/constants';
import type { HydroTuning } from './hydroTuning';

function smoothstep(e0: number, e1: number, x: number): number {
  const u = e1 > e0 ? (x - e0) / (e1 - e0) : x >= e1 ? 1 : 0;
  const c = u < 0 ? 0 : u > 1 ? 1 : u;
  return c * c * (3 - 2 * c);
}

/**
 * Cloud cover for one cell: RH ramp + precipitation term + stratocumulus (open water fraction
 * `ocean` × clamp(stab / ref)), clamped to [0, 1].
 */
export function cloudCover(rh: number, precipMmDay: number, stab: number, ocean: number, t: HydroTuning): number {
  const fromRh = t.cloudRhWeight * smoothstep(t.cloudRhLow, t.cloudRhHigh, rh);
  const fromP = t.cloudPrecipWeight * (1 - Math.exp(-Math.max(0, precipMmDay) / t.cloudPrecipRefMmDay));
  const s = stab / t.cloudStratusRefK;
  const fromSc = t.cloudStratusWeight * ocean * (s > 1 ? 1 : s > 0 ? s : 0);
  const c = fromRh + fromP + fromSc;
  return c > 1 ? 1 : c < 0 ? 0 : c;
}

export interface CloudInputs {
  n: number;
  /** 12*n column RH, precipitation (mm/month) and cold-SST stability (K). */
  rh: Float32Array;
  precip: Float32Array;
  stab: Float32Array;
  /** n land fraction; 12*n sea-ice fraction. */
  landFraction: Float32Array;
  seaIce: Float32Array;
}

/** 12*n cloud-cover field. */
export function computeCloudCover(inp: CloudInputs, t: HydroTuning, out: Float32Array): void {
  const { n, rh, precip, stab, landFraction, seaIce } = inp;
  const daysPerMonth = SECONDS_PER_MONTH / 86400;
  for (let m = 0; m < 12; m++) {
    for (let i = 0; i < n; i++) {
      const k = m * n + i;
      const lf = landFraction[i];
      const ice = seaIce[k];
      const openWater = (1 - (lf > 1 ? 1 : lf > 0 ? lf : 0)) * (1 - (ice > 1 ? 1 : ice > 0 ? ice : 0));
      out[k] = cloudCover(rh[k], precip[k] / daysPerMonth, stab[k], openWater, t);
    }
  }
}
