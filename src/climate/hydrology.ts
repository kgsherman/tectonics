import type { DynamicsResult, HydrologyResult } from './internal';

// CONTRACT STUB — implemented by the climate-hydrology owner. Keep the exported signature.
const NI = (): never => {
  throw new Error('not implemented');
};

/**
 * Moisture transport and precipitation (SPEC.md §6.3): column water advected by the steering wind,
 * ocean evaporation, land ET recycling, humidity-gated precipitation with ascent / baroclinic /
 * orographic / stability modifiers applied as an implicit sink, eddy diffusion, snowpack, clouds.
 * `warmStart` (previous result on the same grid) seeds the iteration.
 */
export function computeHydrology(
  dyn: DynamicsResult,
  warmStart?: HydrologyResult | null,
  onProgress?: (fraction: number) => void,
): HydrologyResult { return NI(); }
