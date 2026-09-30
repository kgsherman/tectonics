import type { SphereMesh, TectonicParams, TectonicStats, Vec3, WorldDraft, WorldSnapshot } from '../core/types';

// CONTRACT STUB — implemented by the tectonics-sim owner. Keep the exported signatures.
const NI = (): never => {
  throw new Error('not implemented');
};

export const DEFAULT_TECTONIC_PARAMS: TectonicParams = {
  dt: 1,
  maxPlates: 24,
  riftRate: 1.5,
  mergePlates: true,
  subductionUplift: 1,
  collisionUplift: 1,
  erosion: 1,
  hotspotActivity: 1,
  speedScale: 1,
  seed: 1,
};

/**
 * Plate-tectonics simulation on a SphereMesh (see SPEC.md §4).
 * Pure computation: no DOM, runs in a Web Worker and in Node.
 */
export class TectonicSim {
  readonly mesh: SphereMesh;
  params: TectonicParams;

  /** Builds per-plate frames from a world-frame draft (all plate rotations start at identity). Does not retain `draft`. */
  constructor(mesh: SphereMesh, draft: WorldDraft, params?: Partial<TectonicParams>) {
    this.mesh = mesh;
    this.params = { ...DEFAULT_TECTONIC_PARAMS, ...params };
    void draft;
  }

  /** Current simulation time, Myr. */
  get time(): number { return NI(); }

  /** Advance `steps` steps of params.dt Myr each. */
  step(steps?: number): void { return NI(); }

  /** World-frame state. Returns freshly allocated arrays (safe to transfer to another thread). */
  snapshot(): WorldSnapshot { return NI(); }

  /** World-frame editable draft of the current state (for the plate editor / save). */
  toDraft(): WorldDraft { return NI(); }

  setParams(params: Partial<TectonicParams>): void { return NI(); }

  /** Change one plate's angular velocity (world frame, rad/Myr). No-op if the id is unknown. */
  setPlateOmega(plateId: number, omega: Vec3): void { return NI(); }

  stats(): TectonicStats { return NI(); }
}
