/**
 * View inputs derived from a ClimateResult: particle vector fields, cloud cover and the sun's
 * declination for a month. Monthly fields are [month][row][col]; month −1 means the annual mean.
 */
import type { ClimateResult, CloudSpec, VectorFieldSpec } from '../core/types';

/** Jan 1 → March equinox (day 79.3 ≈ Mar 20, as in the climate model) in months. */
const EQUINOX_MONTH = (12 * 79.3) / 365.2422;

/**
 * Solar declination (radians) at the middle of `month` (0..11) for an axial tilt in degrees;
 * 0 for the annual view. Orbital longitude L is measured from the March equinox on a circular
 * orbit: δ = asin(sin ε · sin L).
 */
export function solarDeclination(month: number, axialTiltDeg: number): number {
  if (month < 0) return 0;
  const L = (2 * Math.PI * (month + 0.5 - EQUINOX_MONTH)) / 12;
  const eps = (Math.max(0, Math.min(90, axialTiltDeg)) * Math.PI) / 180;
  return Math.asin(Math.sin(eps) * Math.sin(L));
}

/** One month of a 12·N field (a view, no copy) or the annual mean (new array) for month −1. */
export function monthField(field: Float32Array, n: number, month: number): Float32Array {
  if (field.length !== 12 * n) throw new Error(`monthField: expected ${12 * n} values, got ${field.length}`);
  if (month >= 0 && month < 12) {
    const m = Math.floor(month);
    return field.subarray(m * n, (m + 1) * n);
  }
  const out = new Float32Array(n);
  for (let m = 0; m < 12; m++) {
    const off = m * n;
    for (let i = 0; i < n; i++) out[i] += field[off + i];
  }
  for (let i = 0; i < n; i++) out[i] /= 12;
  return out;
}

export function windFieldSpec(c: ClimateResult, month: number): VectorFieldSpec {
  const n = c.w * c.h;
  return { kind: 'wind', w: c.w, h: c.h, u: monthField(c.windU, n, month), v: monthField(c.windV, n, month) };
}

/** Surface currents with NaN on the climate model's land cells (particles respawn there). */
export function currentFieldSpec(c: ClimateResult, month: number): VectorFieldSpec {
  const n = c.w * c.h;
  const u = monthField(c.currentU, n, month).slice();
  const v = monthField(c.currentV, n, month).slice();
  for (let i = 0; i < n; i++) {
    if (c.land[i] === 1) {
      u[i] = NaN;
      v[i] = NaN;
    }
  }
  return { kind: 'current', w: c.w, h: c.h, u, v };
}

/** Cloud cover for the view, scaled by a display `density` (1 = the model's cover unchanged). */
export function cloudSpec(c: ClimateResult, month: number, density = 1): CloudSpec {
  const n = c.w * c.h;
  let cover = monthField(c.cloud, n, month);
  if (density !== 1) {
    const d = Math.max(0, density);
    const scaled = new Float32Array(n);
    for (let i = 0; i < n; i++) scaled[i] = Math.min(1, cover[i] * d);
    cover = scaled;
  }
  return { w: c.w, h: c.h, cover, u: monthField(c.windU, n, month), v: monthField(c.windV, n, month) };
}
