import { MAX_PLATES } from '../core/constants';
import type { GenerateParams } from '../core/types';

export const DEFAULT_GENERATE_PARAMS: GenerateParams = {
  seed: 1,
  plateCount: 12,
  continentalFraction: 0.35,
  continentMode: 'scattered',
  hotspotCount: 8,
  plateSpeed: 50,
  boundaryRoughness: 0.5,
};

/** Plate-count bounds: leave two slots free below MAX_PLATES for rifting in the simulation. */
export const MIN_GEN_PLATES = 3;
export const MAX_GEN_PLATES = MAX_PLATES - 2;

const MODES: ReadonlyArray<GenerateParams['continentMode']> = ['scattered', 'supercontinent', 'archipelago'];

function finite(name: string, v: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`generateRandomDraft: ${name} must be a finite number (got ${v})`);
  return v;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Validated, clamped copy of the generator parameters. Missing fields take the defaults; non-finite
 * numbers and unknown modes throw (they indicate a caller bug); out-of-range values are clamped to the
 * documented ranges.
 */
export function normalizeGenerateParams(p: Partial<GenerateParams>): GenerateParams {
  const q: GenerateParams = { ...DEFAULT_GENERATE_PARAMS };
  for (const k of Object.keys(p) as Array<keyof GenerateParams>) {
    if (p[k] !== undefined) (q as unknown as Record<string, unknown>)[k] = p[k];
  }
  if (!MODES.includes(q.continentMode)) throw new Error(`generateRandomDraft: unknown continentMode '${String(q.continentMode)}'`);
  return {
    seed: finite('seed', q.seed),
    plateCount: clamp(Math.round(finite('plateCount', q.plateCount)), MIN_GEN_PLATES, MAX_GEN_PLATES),
    continentalFraction: clamp(finite('continentalFraction', q.continentalFraction), 0, 0.85),
    continentMode: q.continentMode,
    hotspotCount: clamp(Math.round(finite('hotspotCount', q.hotspotCount)), 0, 64),
    plateSpeed: clamp(finite('plateSpeed', q.plateSpeed), 0, 200),
    boundaryRoughness: clamp(finite('boundaryRoughness', q.boundaryRoughness), 0, 1),
  };
}
