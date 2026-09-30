import type { ClimateInput, ClimateParams, ClimateResult, SphereMesh, WorldSnapshot } from '../core/types';

// CONTRACT STUB — implemented by the climate owner. Keep the exported signatures.
const NI = (): never => {
  throw new Error('not implemented');
};

export const DEFAULT_CLIMATE_PARAMS: ClimateParams = {
  gridW: 360,
  gridH: 180,
  axialTilt: 23.44,
  solarMultiplier: 1,
  globalTempOffset: 0,
  seaLevel: 0,
  moisture: 1,
  oceanCurrents: 1,
  retrograde: false,
  fast: false,
};

/** Resample a tectonic snapshot's elevation onto the climate grid (params.gridW x gridH). */
export function climateInputFromSnapshot(mesh: SphereMesh, snapshot: WorldSnapshot, params: ClimateParams): ClimateInput { return NI(); }

/**
 * Full monthly climate: insolation -> temperature -> pressure & winds -> ocean currents & SST ->
 * air temperature with advection -> moisture transport & precipitation -> Koppen (SPEC.md §6).
 * Pure computation. onProgress(stage, fraction 0..1) is called between stages.
 */
export function computeClimate(input: ClimateInput, params: ClimateParams, onProgress?: (stage: string, fraction: number) => void): ClimateResult { return NI(); }
