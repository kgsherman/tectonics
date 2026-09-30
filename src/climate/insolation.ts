/**
 * Top-of-atmosphere daily-mean insolation (SPEC §6.1.2) on a circular orbit, for any obliquity
 * 0–90°. Time is measured in years from Jan 1; the vernal equinox falls on ~Mar 20.
 */
import { SOLAR_CONSTANT } from '../core/constants';
import type { LatLonGrid } from './dynGrid';

/** Fraction of the year at which the (northern) vernal equinox occurs. */
export const VERNAL_EQUINOX_YEAR_FRACTION = 79.3 / 365.2422;

/** Solar declination (radians) at year fraction t for obliquity `tiltRad`. */
export function declinationAt(t: number, tiltRad: number): number {
  const L = 2 * Math.PI * (t - VERNAL_EQUINOX_YEAR_FRACTION);
  const s = Math.sin(tiltRad) * Math.sin(L);
  return Math.asin(Math.max(-1, Math.min(1, s)));
}

/**
 * Daily-mean TOA insolation (W/m²): Q = (S/π)(h0·sinφ·sinδ + cosφ·cosδ·sin h0), with the sunset
 * hour angle h0 from cos h0 = −tanφ·tanδ, clamped for polar day/night. Robust at |δ| → 90°.
 */
export function dailyInsolation(S: number, sinPhi: number, cosPhi: number, sinDec: number, cosDec: number): number {
  const a = sinPhi * sinDec;
  const b = cosPhi * cosDec;
  let h0: number;
  if (b <= 1e-12) h0 = a > 0 ? Math.PI : 0;
  else {
    const ch = -a / b;
    h0 = ch >= 1 ? 0 : ch <= -1 ? Math.PI : Math.acos(ch);
  }
  return Math.max(0, (S / Math.PI) * (h0 * a + b * Math.sin(h0)));
}

/**
 * Insolation table for `steps` equal time steps per year evaluated at each step's mid-time:
 * result[k*ny + j] for step k and grid row j.
 */
export function insolationTable(g: LatLonGrid, steps: number, tiltDeg: number, solarMultiplier: number): Float64Array {
  const S = SOLAR_CONSTANT * Math.max(0, solarMultiplier);
  const tilt = (Math.max(0, Math.min(90, tiltDeg)) * Math.PI) / 180;
  const out = new Float64Array(steps * g.ny);
  for (let k = 0; k < steps; k++) {
    const dec = declinationAt((k + 0.5) / steps, tilt);
    const sd = Math.sin(dec);
    const cd = Math.cos(dec);
    for (let j = 0; j < g.ny; j++) out[k * g.ny + j] = dailyInsolation(S, g.sinLat[j], Math.cos(g.lat[j]), sd, cd);
  }
  return out;
}
