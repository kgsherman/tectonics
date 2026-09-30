/**
 * Internal contract between the two climate sub-modules (SPEC.md §6):
 *   climate-dynamics (energy balance, sea ice, pressure, winds, ocean) → DynamicsResult
 *   climate-hydrology (moisture, precipitation, ET, snowpack, clouds) consumes it → HydrologyResult
 * The orchestrator (climate.ts, dynamics owner) assembles ClimateResult and applies Köppen.
 *
 * All monthly arrays: 12*w*h, index m*w*h + r*w + c, finite everywhere.
 */
import type { ClimateParams } from '../core/types';

export interface DynamicsResult {
  w: number;
  h: number;
  params: ClimateParams;
  /** w*h: 1 = land (landFraction ≥ 0.5). */
  land: Uint8Array;
  /** w*h land fraction 0..1. */
  landFraction: Float32Array;
  /** w*h input elevation (m, not sea-level offset). */
  elev: Float32Array;
  /** w*h height above sea level used for lapse/orography: max(0, elev - seaLevel) on land, 0 on ocean. */
  surfaceHeight: Float32Array;
  /** Near-surface air temperature °C at surfaceHeight (land) / sea level (ocean; ice-surface air T over sea ice). */
  temp: Float32Array;
  /** Sea-surface temperature °C (≥ -1.8), extended under land. */
  sst: Float32Array;
  /** Sea-ice fraction 0..1, extended under land. */
  seaIce: Float32Array;
  /** Sea-level pressure, hPa. */
  pressure: Float32Array;
  /** Near-surface (frictional) wind, m/s. */
  windU: Float32Array;
  windV: Float32Array;
  /** Steering wind for moisture transport (less ageostrophic, ~850 hPa-like), m/s. */
  steerU: Float32Array;
  steerV: Float32Array;
  /** Vertical-motion proxy: positive = large-scale ascent (from smoothed -∇²p / convergence), s^-1 scale-free units. */
  ascent: Float32Array;
  /** Baroclinicity / storm-track proxy ≥ 0 (e.g. smoothed |∂T/∂y| × westerly component). */
  baroclinic: Float32Array;
  /** Surface ocean current, m/s (0 on land). */
  currentU: Float32Array;
  currentV: Float32Array;
  /** Upwelling velocity ≥ 0, m/day (0 on land). */
  upwelling: Float32Array;
  timings: Record<string, number>;
  stats: Record<string, number>;
}

export interface HydrologyResult {
  /** mm/month */
  precip: Float32Array;
  /** Actual ET (land) / evaporation (ocean), mm/month. */
  evap: Float32Array;
  /** Snow-cover fraction 0..1 from snowpack. */
  snow: Float32Array;
  /** Cloud-cover fraction 0..1. */
  cloud: Float32Array;
  /** Column relative humidity 0..~1.2 (diagnostic). */
  rh: Float32Array;
  timings: Record<string, number>;
  stats: Record<string, number>;
}
