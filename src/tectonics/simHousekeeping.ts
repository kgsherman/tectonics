import { MAX_PLATES } from '../core/constants';
import { CRUST_CONTINENTAL } from '../core/types';
import { CONSUME_MIN_VCONV, TINY_PLATE_CELLS } from './simConstants';
import { convergenceAt } from './simGeometry';
import { dropHiddenPlate, mergePlates } from './simMerge';
import { freePlateSlot, type PlateSlot, type SimState } from './simState';

const shared = new Int32Array(MAX_PLATES);
const nonConvergent = new Int32Array(MAX_PLATES);

/** Recount visible cells per plate from the world top map. */
export function recountVisible(state: SimState): void {
  for (const p of state.slots) if (p) p.visible = 0;
  const { top, slots, n } = state;
  for (let i = 0; i < n; i++) (slots[top[i]] as NonNullable<(typeof slots)[number]>).visible++;
}

/**
 * Neighbour to absorb plate k: the one with the longest non-convergent shared boundary (ties: the
 * longest shared boundary). -1 when k touches no other plate.
 */
function mergeTarget(state: SimState, k: number): number {
  const { n, top } = state;
  const { adjOffset, adj } = state.sm;
  shared.fill(0);
  nonConvergent.fill(0);
  for (let i = 0; i < n; i++) {
    if (top[i] !== k) continue;
    let seen = 0;
    for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e; q++) {
      const K = top[adj[q]];
      if (K === k || (seen >>> K) & 1) continue;
      seen |= 1 << K;
      shared[K]++;
      if (convergenceAt(state, i, K, k) <= CONSUME_MIN_VCONV) nonConvergent[K]++;
    }
  }
  let best = -1;
  for (let K = 0; K < MAX_PLATES; K++) {
    if (shared[K] === 0) continue;
    if (best < 0 || nonConvergent[K] > nonConvergent[best] || (nonConvergent[K] === nonConvergent[best] && shared[K] > shared[best])) best = K;
  }
  return best;
}

/**
 * Close single-cell oceanic basins trapped inside continental crust (sutures after collisions):
 * the cell becomes continental with its neighbours' mean elevation and age. Below the mesh
 * resolution such a remnant is a pit artifact rather than an inland sea.
 */
export function closeTrappedBasins(state: SimState): void {
  const { n, top, src, slots } = state;
  const { adjOffset, adj } = state.sm;
  for (let i = 0; i < n; i++) {
    const P = slots[top[i]] as PlateSlot;
    const j = src[i];
    if (P.crust[j] === CRUST_CONTINENTAL) continue;
    let enclosed = true, sumH = 0, sumA = 0, cnt = 0;
    for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e; q++) {
      const a = adj[q];
      const Q = slots[top[a]] as PlateSlot;
      const ja = src[a];
      if (Q.crust[ja] !== CRUST_CONTINENTAL) {
        enclosed = false;
        break;
      }
      sumH += Q.elev[ja];
      sumA += Q.age[ja];
      cnt++;
    }
    if (!enclosed || cnt === 0) continue;
    P.crust[j] = CRUST_CONTINENTAL;
    P.elev[j] = sumH / cnt;
    P.age[j] = sumA / cnt;
    state.counters.continentalCreated++;
  }
}

/**
 * J. Plates without owned cells die; plates with fewer than TINY_PLATE_CELLS visible cells merge into
 * a neighbour (or vanish if nothing of them is visible). The last plate is never removed.
 */
export function housekeeping(state: SimState): void {
  closeTrappedBasins(state);
  recountVisible(state);
  for (let k = 0; k < MAX_PLATES; k++) {
    const P = state.slots[k];
    if (!P) continue;
    let live = 0;
    for (const p of state.slots) if (p) live++;
    if (live <= 1) return;
    if (P.ownedCount === 0) {
      if (P.visible > 0) throw new Error(`housekeeping: plate slot ${k} is visible but owns no cells`);
      freePlateSlot(state, k);
      continue;
    }
    if (P.visible >= TINY_PLATE_CELLS) continue;
    if (P.visible === 0) {
      dropHiddenPlate(state, k);
      continue;
    }
    const target = mergeTarget(state, k);
    if (target < 0) continue;
    mergePlates(state, k, target);
    (state.slots[target] as NonNullable<(typeof state.slots)[number]>).visible += P.visible;
  }
}
