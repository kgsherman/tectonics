import type { ClimateInput, ClimateParams, ClimateResult, SphereMesh, WorldSnapshot } from '../core/types';

// CONTRACT STUB — implemented by the climate-dynamics owner. Keep the exported signatures.
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

/**
 * Resample a tectonic snapshot's elevation onto the climate grid (params.gridW x gridH) with
 * land-aware supersampling (e.g. build a 4x MeshGridMap, classify sub-samples vs params.seaLevel,
 * landFraction = mean(land); elev = mean land elevation if landFraction ≥ 0.5 else mean sea-floor).
 */
export function climateInputFromSnapshot(mesh: SphereMesh, snapshot: WorldSnapshot, params: ClimateParams): ClimateInput { return NI(); }

/**
 * Full monthly climate (SPEC.md §6): insolation → coupled seasonal energy balance (land, mixed-layer
 * ocean, sea ice) → pressure & winds → wind-driven ocean currents & upwelling → SST/air temperature
 * with advection → moisture transport & precipitation (computeHydrology) → Köppen.
 * Pure and deterministic: same (input, params, warmStart) ⇒ same result.
 * `warmStart` (a previous result on the same w×h grid) initializes the iterative solvers so `fast`
 * mode converges toward the full solution; ignored if the grid size differs.
 */
export function computeClimate(
  input: ClimateInput,
  params: ClimateParams,
  onProgress?: (stage: string, fraction: number) => void,
  warmStart?: ClimateResult | null,
): ClimateResult { return NI(); }
