import type { GenerateParams, SphereMesh, WorldDraft } from '../core/types';

// CONTRACT STUB — implemented by the tectonics-generate owner. Keep the exported signatures.
const NI = (): never => {
  throw new Error('not implemented');
};

export const DEFAULT_GENERATE_PARAMS: GenerateParams = {
  seed: 1,
  plateCount: 12,
  continentalFraction: 0.35,
  continentMode: 'scattered',
  hotspotCount: 8,
  plateSpeed: 50,
  boundaryRoughness: 0.5,
};

/** Random Earth-like starting world (see SPEC.md §5). Deterministic for (mesh.n, params). */
export function generateRandomDraft(mesh: SphereMesh, params: GenerateParams): WorldDraft { return NI(); }
