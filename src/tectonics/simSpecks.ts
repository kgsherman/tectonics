import { CRUST_CONTINENTAL } from '../core/types';
import {
  assignTop, claimCell, copyLatticeCell, nearestOwnedAround, pullLattice, releaseCell, toPlateFrame,
} from './simLattice';
import { slotBit, type PlateSlot, type SimState } from './simState';

const local = new Float64Array(3);

/**
 * Isolated top cells (at most one same-plate neighbour) have no defined boundary normal, so the
 * convergence gate can never consume them. Hand them to the dominant ring plate T: a buoyant
 * continental fragment is accreted to T (terrane accretion, crust conserved); an oceanic speck
 * becomes hidden under T where T covers the cell, else T's own crust is cloned there and the fragment
 * is consumed. Returns the number of cells handed over.
 */
export function resolveSpecks(state: SimState): number {
  const { n, top, src, loser, slots } = state;
  const { adjOffset, adj } = state.sm;
  let fixed = 0;
  for (let i = 0; i < n; i++) {
    const K = top[i];
    if (K < 0) continue;
    // Ring plates; stop as soon as a second cell of K shows up (the common, non-speck case).
    let same = 0, seen = 0;
    for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e && same < 2; q++) {
      const t = top[adj[q]];
      if (t === K) same++;
      else if (t >= 0) seen |= 1 << t;
    }
    if (same > 1 || seen === 0) continue;
    const PK = slots[K] as PlateSlot;
    const jK = src[i];
    // Pull maps are not injective: an earlier speck of this pass may already have handed over the
    // lattice cell this world cell shows. It is an orphan now (markOrphanedTops turns it into a gap);
    // releasing / copying it again would double-count ownership and duplicate its crust.
    if (!PK.owned[jK]) continue;
    const T = dominantNeighbour(state, i, seen);
    const PT = slots[T] as PlateSlot;
    const jT = pullLattice(state, T, i);
    const continental = PK.crust[jK] === CRUST_CONTINENTAL;
    if (PT.owned[jT]) {
      if (continental && PT.crust[jT] !== CRUST_CONTINENTAL) {
        copyLatticeCell(PK, jK, PT, jT);
        releaseCell(state, PK, jK, false);
      }
    } else {
      if (continental) copyLatticeCell(PK, jK, PT, jT);
      else {
        toPlateFrame(state, PT, i, local);
        const near = nearestOwnedAround(state, PT, jT, local);
        if (near < 0) continue;
        copyLatticeCell(PT, near, PT, jT);
        // Closing an oceanic hole with T's continental crust creates continental crust.
        if (PT.crust[jT] === CRUST_CONTINENTAL) state.counters.continentalCreated++;
      }
      claimCell(PT, jT);
      releaseCell(state, PK, jK, !continental);
    }
    assignTop(state, T, jT, i);
    if (PK.owned[jK]) loser[i] = slotBit(K);
    fixed++;
  }
  return fixed;
}

/**
 * Plate among `candidates` (bitmask) with the most cells in the ring of i; ties prefer a plate that
 * covers i (loser bit), then the lowest slot.
 */
function dominantNeighbour(state: SimState, i: number, candidates: number): number {
  const { adjOffset, adj } = state.sm;
  const top = state.top;
  let best = -1, bestScore = -1;
  let c = candidates;
  while (c !== 0) {
    const low = c & -c;
    c ^= low;
    const t = 31 - Math.clz32(low);
    let cnt = 0;
    for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e; q++) if (top[adj[q]] === t) cnt++;
    const score = 2 * cnt + ((state.loser[i] >>> t) & 1);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}
