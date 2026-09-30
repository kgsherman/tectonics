import { MAX_PLATES } from '../core/constants';
import { RegionDijkstra } from './simDijkstra';
import type { SimState } from './simState';

export const FRONT_NONE = 0;
export const FRONT_SUBDUCTION = 1;
export const FRONT_COLLISION = 2;

/** Per-step working buffers (allocated once per sim). */
export interface StepScratch {
  /** World crust age of the top plate (raw lattice value). */
  wAge: Float32Array;
  /* Fronts (E). */
  frontV: Float32Array;
  frontKind: Uint8Array;
  frontOver: Int8Array;
  frontUnder: Int8Array;
  /** Unit boundary normal at the front, pointing toward the subducting plate (3 per cell). */
  frontN: Float32Array;
  frontList: Int32Array;
  frontCount: number;
  /** Boundary world cells per plate slot (perimeter proxy). */
  boundaryCells: Int32Array;
  /** Slab-pull least-squares accumulators per slot: 3×3 matrix and right-hand side. */
  slabA: Float64Array;
  slabB: Float64Array;
  slabCells: Int32Array;
  /** Sum of collision-front positions per plate pair (3 per pair index), this step. */
  contactSum: Float64Array;
  /* Fields (E). */
  /** Raw (unsaturated) tectonic uplift over the step, m; saturated per plate cell when gathered. */
  uplift: Float32Array;
  /** Hotspot uplift over the step, m (already saturating toward the volcanic target). */
  hotspotUp: Float32Array;
  arcMask: Uint8Array;
  /** Cells uplifted by a subduction front this step (their eroded sediment feeds the trench). */
  subMask: Uint8Array;
  diffusion: Float32Array;
  /** Free scratch (any pass may overwrite; never assume contents). */
  tmpA: Float32Array;
  tmpB: Float32Array;
  budgetAt: Float32Array;
  norm: Float32Array;
  /** Convergence speed at trench source cells (kept zero outside trenchField). */
  trenchV: Float32Array;
  sources: Int32Array;
  /** Ring index of cells reached by a breadth-first search (−1 = not reached). */
  ring: Int16Array;
  dijkstra: RegionDijkstra;
  /** Static hotspot footprints (world cells and kernel weights). */
  hotspotCells: Int32Array[] | null;
  hotspotWeight: Float32Array[] | null;
}

const scratchOf = new WeakMap<SimState, StepScratch>();

export function stepScratch(state: SimState): StepScratch {
  let s = scratchOf.get(state);
  if (!s) {
    const n = state.n;
    s = {
      wAge: new Float32Array(n),
      frontV: new Float32Array(n),
      frontKind: new Uint8Array(n),
      frontOver: new Int8Array(n).fill(-1),
      frontUnder: new Int8Array(n).fill(-1),
      frontN: new Float32Array(3 * n),
      frontList: new Int32Array(n),
      frontCount: 0,
      boundaryCells: new Int32Array(MAX_PLATES),
      slabA: new Float64Array(9 * MAX_PLATES),
      slabB: new Float64Array(3 * MAX_PLATES),
      slabCells: new Int32Array(MAX_PLATES),
      contactSum: new Float64Array(3 * MAX_PLATES * MAX_PLATES),
      uplift: new Float32Array(n),
      hotspotUp: new Float32Array(n),
      arcMask: new Uint8Array(n),
      subMask: new Uint8Array(n),
      diffusion: new Float32Array(n),
      tmpA: new Float32Array(n),
      tmpB: new Float32Array(n),
      budgetAt: new Float32Array(n),
      norm: new Float32Array(n),
      trenchV: new Float32Array(n),
      sources: new Int32Array(n),
      ring: new Int16Array(n),
      dijkstra: new RegionDijkstra(n),
      hotspotCells: null,
      hotspotWeight: null,
    };
    scratchOf.set(state, s);
  }
  return s;
}
