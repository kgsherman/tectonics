import type { ClimateResult } from '../core/types';

// CONTRACT STUB — implemented by the climate-hydrology owner. Keep the exported signatures.
const NI = (): never => {
  throw new Error('not implemented');
};

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

/**
 * Nearest-cell climate sample at (lat, lon) radians, so the climograph and the Köppen class shown
 * always agree. If elevOverride (m, e.g. the displayed amplified surface) is given, temperatures are
 * lapse-corrected from the cell's reference height to it and the class recomputed. Used by the hover
 * inspector and by the painter's per-pixel alpine logic.
 */
export function sampleClimateAt(
  c: ClimateResult,
  lat: number,
  lon: number,
  month?: number,
  elevOverride?: number,
  out?: ClimateSample,
): ClimateSample { return NI(); }
