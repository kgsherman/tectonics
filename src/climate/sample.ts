import { LAPSE_RATE } from '../core/constants';
import { gridIndexAt } from '../core/grid';
import type { ClimateResult } from '../core/types';
import { classifyKoppen } from './koppen';

export interface ClimateSample {
  /** Grid cell index used (nearest cell). */
  index: number;
  land: boolean;
  /** Cell elevation (m). */
  elev: number;
  /** 12 monthly temperatures (°C), lapse-corrected to `elevOverride` when given. */
  temp: Float32Array;
  /** 12 monthly precipitation totals (mm). */
  precip: Float32Array;
  /** Köppen class for these T/P (recomputed when elevOverride shifts temperatures; else koppenAll). */
  koppen: number;
  tempAnnual: number;
  precipAnnual: number;
  /** Values for `month` (or annual means if month < 0). */
  sst: number;
  seaIce: number;
  windU: number;
  windV: number;
  pressure: number;
  snow: number;
  cloud: number;
}

/** Temperature shifts smaller than this (°C) keep the stored class (avoids float-noise reclassification). */
const RECLASSIFY_EPS = 1e-3;

function monthOrMean(field: Float32Array, n: number, i: number, month: number): number {
  if (month >= 0) return field[month * n + i];
  let s = 0;
  for (let m = 0; m < 12; m++) s += field[m * n + i];
  return s / 12;
}

/**
 * Nearest-cell climate sample at (lat, lon) radians, so the climograph and the Köppen class shown
 * always agree. If elevOverride (m, e.g. the displayed amplified surface) is given, temperatures are
 * lapse-corrected from the cell's reference height to it and the class recomputed. Used by the hover
 * inspector and by the painter's per-pixel alpine logic.
 *
 * Heights follow the ClimateResult convention: reference = max(0, elev − seaLevel) and target =
 * max(0, elevOverride − seaLevel), both relative to the climate's sea level. `month` in [0, 12) is
 * floored; anything else (or omitted) selects annual means for the per-month scalars. `out` is
 * reused (no allocation).
 */
export function sampleClimateAt(
  c: ClimateResult,
  lat: number,
  lon: number,
  month?: number,
  elevOverride?: number,
  out?: ClimateSample,
): ClimateSample {
  const { w, h } = c;
  const n = w * h;
  const i = gridIndexAt(w, h, lat, lon);
  const m = month !== undefined && month >= 0 && month < 12 ? Math.floor(month) : -1;
  const seaLevel = c.params.seaLevel;
  const elev = c.elev[i];
  let dT = 0;
  if (elevOverride !== undefined && Number.isFinite(elevOverride)) {
    const ref = Math.max(0, elev - seaLevel);
    const target = Math.max(0, elevOverride - seaLevel);
    dT = LAPSE_RATE * (ref - target);
  }
  const s: ClimateSample = out ?? {
    index: 0,
    land: false,
    elev: 0,
    temp: new Float32Array(12),
    precip: new Float32Array(12),
    koppen: 0,
    tempAnnual: 0,
    precipAnnual: 0,
    sst: 0,
    seaIce: 0,
    windU: 0,
    windV: 0,
    pressure: 0,
    snow: 0,
    cloud: 0,
  };
  let tSum = 0;
  let pSum = 0;
  for (let k = 0; k < 12; k++) {
    const t = c.temp[k * n + i] + dT;
    const p = c.precip[k * n + i];
    s.temp[k] = t;
    s.precip[k] = p;
    tSum += t;
    pSum += p;
  }
  s.index = i;
  s.land = c.land[i] === 1;
  s.elev = elev;
  s.tempAnnual = tSum / 12;
  s.precipAnnual = pSum;
  // Hemisphere of the cell (the orchestrator's convention, row ≥ h/2), not of the query point:
  // on odd-height grids the equator row straddles 0° and must classify the same either side.
  s.koppen = Math.abs(dT) > RECLASSIFY_EPS ? classifyKoppen(s.temp, s.precip, Math.floor(i / w) >= h / 2) : c.koppenAll[i];
  s.sst = monthOrMean(c.sst, n, i, m);
  s.seaIce = monthOrMean(c.seaIce, n, i, m);
  s.windU = monthOrMean(c.windU, n, i, m);
  s.windV = monthOrMean(c.windV, n, i, m);
  s.pressure = monthOrMean(c.pressure, n, i, m);
  s.snow = monthOrMean(c.snow, n, i, m);
  s.cloud = monthOrMean(c.cloud, n, i, m);
  return s;
}
