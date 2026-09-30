import type { ClimateInput } from '../core/types';

// CONTRACT STUB — implemented by the headless/earth owner. Keep the exported signatures.
// Node/test-only: imports world-atlas data; never import this from browser app code.
const NI = (): never => {
  throw new Error('not implemented');
};

/**
 * Approximate present-day Earth on a w×h climate grid for validating the climate model:
 * land mask from world-atlas land-50m (land-aware supersampling → landFraction), elevation from a
 * continental base plus hand-authored major ranges, plateaus and ice sheets, and ocean depth
 * (shelves near coasts, abyssal elsewhere).
 */
export function buildEarthClimateInput(w: number, h: number): ClimateInput { return NI(); }

export interface ReferenceCity {
  name: string;
  lat: number; // degrees
  lon: number; // degrees
  /** Observed Köppen code (Beck et al. 2018). */
  koppen: string;
}

/** ~60 reference locations spanning all Köppen groups and continents. */
export const REFERENCE_CITIES: ReferenceCity[] = [];
