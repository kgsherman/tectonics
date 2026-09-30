/**
 * Cloud-cover fraction (0..1) for rendering clouds / weather (SPEC §6.2 "Clouds"). Diagnostic only.
 *
 * Cloud regimes, combined with random overlap (cover = 1 − Π(1 − c_k)):
 *  - layer cloud from column relative humidity, thinned by large-scale subsidence (the dry air of
 *    the subtropical highs and deserts);
 *  - precipitating cloud (deep convection in the ITCZ and monsoons, fronts) from precipitation;
 *  - frontal cloud of the storm tracks from the baroclinic index;
 *  - marine stratocumulus over water colder than its latitude (upwelling coasts, cold currents),
 *    thickened under subsidence (the inversion that traps it);
 *  - polar low cloud over open water and melting sea ice in the warm season;
 *  - a base of shallow (trade) cumulus over open water.
 */
import { SECONDS_PER_MONTH } from '../core/constants';
import type { HydroTuning } from './hydroTuning';

function smoothstep(e0: number, e1: number, x: number): number {
  const u = e1 > e0 ? (x - e0) / (e1 - e0) : x >= e1 ? 1 : 0;
  const c = u < 0 ? 0 : u > 1 ? 1 : u;
  return c * c * (3 - 2 * c);
}

const clamp01 = (x: number): number => (x > 1 ? 1 : x > 0 ? x : 0);

/**
 * Cloud cover for one cell: column RH, precipitation (mm/day), cold-SST stability (K), open-water
 * fraction `ocean`, and optionally the normalized large-scale ascent `asc` (negative = subsidence),
 * the normalized storm-track index `storm` and the surface temperature `tempC` (polar low cloud).
 */
export function cloudCover(rh: number, precipMmDay: number, stab: number, ocean: number, t: HydroTuning, asc = 0, storm = 0, tempC = 20): number {
  const sub = asc < 0 ? Math.min(1.5, -asc) : 0;
  const cRh = t.cloudRhWeight * smoothstep(t.cloudRhLow, t.cloudRhHigh, rh) * Math.max(0, 1 - t.cloudSubsidenceThinning * sub);
  const cP = t.cloudPrecipWeight * (1 - Math.exp(-Math.max(0, precipMmDay) / t.cloudPrecipRefMmDay));
  const cStorm = t.cloudStormWeight * clamp01(storm);
  // Stratocumulus decks need cool water under the inversion; over warm water the regime is trade cumulus.
  const cSc = t.cloudStratusWeight * clamp01(ocean) * clamp01(stab / t.cloudStratusRefK) * (1 + t.cloudStratusSubsidence * sub) * (1 - smoothstep(19, 27, tempC));
  // Polar low cloud (Arctic summer stratus): open water or melting ice near 0 °C.
  const cPolar = t.cloudPolarWeight * clamp01(ocean + 0.5 * (1 - ocean)) * smoothstep(-30, -5, tempC) * (1 - smoothstep(4, 12, tempC));
  // Shallow (trade) cumulus over open water, present almost everywhere over the oceans.
  const cCu = t.cloudMarineBase * clamp01(ocean);
  // Clouds need water: the storm, stratocumulus, polar and marine-base regimes fade out in a
  // (nearly) dry column (below cloudRhLow; a planet with moisture 0 is clear).
  const wet = smoothstep(0, t.cloudRhLow, rh);
  const c = 1 - (1 - clamp01(cRh)) * (1 - clamp01(cP)) * (1 - wet * clamp01(cStorm)) * (1 - wet * clamp01(cSc)) * (1 - wet * clamp01(cPolar)) * (1 - wet * clamp01(cCu));
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
  /**
   * Optional 12*n condensation reference r0 of each cell (the humidity-gate threshold without its
   * storm-track shift): the layer-cloud RH is taken relative to it (× (gateThreshold / r0)^e), since
   * cloud forms as the column approaches its own condensation onset, which sub-grid variability
   * (land surfaces, surface-heated convection, the ice phase) lowers below the oceanic reference;
   * e = cloudThresholdExponent < 1 because part of that variance is dry (desert boundary layers).
   */
  gateR0?: Float32Array;
  /** Optional 12*n normalized ascent (negative = subsidence) and storm-track index, and air temperature (°C). */
  ascent?: Float32Array;
  storm?: Float32Array;
  temp?: Float32Array;
}

/** 12*n cloud-cover field. */
export function computeCloudCover(inp: CloudInputs, t: HydroTuning, out: Float32Array): void {
  const { n, rh, precip, stab, landFraction, seaIce, ascent, storm, temp, gateR0 } = inp;
  const daysPerMonth = SECONDS_PER_MONTH / 86400;
  for (let m = 0; m < 12; m++) {
    for (let i = 0; i < n; i++) {
      const k = m * n + i;
      const lf = landFraction[i];
      const ice = seaIce[k];
      const openWater = (1 - (lf > 1 ? 1 : lf > 0 ? lf : 0)) * (1 - (ice > 1 ? 1 : ice > 0 ? ice : 0));
      const r = gateR0 && gateR0[k] > 0.05 ? rh[k] * Math.pow(t.gateThreshold / gateR0[k], t.cloudThresholdExponent) : rh[k];
      out[k] = cloudCover(r, precip[k] / daysPerMonth, stab[k], openWater, t, ascent ? ascent[k] : 0, storm ? storm[k] : 0, temp ? temp[k] : 20);
    }
  }
}
