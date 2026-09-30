import { CRUST_CONTINENTAL } from '../core/types';
import {
  assignTop, claimCell, copyLatticeCell, nearestOwnedAround, pullLattice, releaseCell, toPlateFrame,
} from './simLattice';
import { dirtySet, markRecheck, markReleased, markTopChanged } from './simDirty';
import { slotBit, type PlateSlot, type SimState } from './simState';

const local = new Float64Array(3);
/** Ring cells of one other plate that make a two-neighbour cell a near-speck. */
const NEAR_SPECK_MAJORITY = 4;

/**
 * Isolated top cells (at most one same-plate neighbour) have no defined boundary normal, so the
 * convergence gate can never consume them; near-specks (two same-plate neighbours, at least four of
 * one other plate) are cell-scale serrations of the boundary. Hand them to the dominant ring plate T: a buoyant
 * continental fragment is accreted to T (terrane accretion, crust conserved); an oceanic speck
 * becomes hidden under T where T covers the cell; else it is accreted to T as well when T's crust
 * there is continental (crust conserved), or T's own oceanic crust is cloned there and the fragment
 * is consumed. Returns the number of cells handed over.
 */
export function resolveSpecks(state: SimState, full = true): number {
  const d = dirtySet(state);
  let fixed = 0;
  if (full) {
    // Everything is re-examined; only changes behind the scan position need a later look.
    d.next.fill(0);
    d.scanFull = true;
    for (let i = 0, n = state.n; i < n; i++) {
      d.scanPos = i;
      fixed += visitSpeck(state, i);
    }
  } else {
    // Visit the cells whose closed ring changed (and unresolved specks) in increasing index order;
    // cells marked ahead of the scan position during the round are picked up in the same round.
    const cur = d.next;
    d.next = d.cur;
    d.cur = cur;
    d.scanFull = false;
    for (let w = 0, words = cur.length; w < words; w++) {
      while (cur[w] !== 0) {
        const bits = cur[w];
        const low = bits & -bits;
        cur[w] = bits ^ low;
        const i = (w << 5) + 31 - Math.clz32(low);
        d.scanPos = i;
        fixed += visitSpeck(state, i);
      }
    }
  }
  d.scanPos = -1;
  d.scanFull = false;
  return fixed;
}

/** Hand world cell i to its dominant ring plate if it is a speck; returns 1 when handed over. */
function visitSpeck(state: SimState, i: number): number {
  const { top, src, loser, slots } = state;
  const { adjOffset, adj } = state.sm;
  const K = top[i];
  if (K < 0) return 0;
  // Ring plates; stop as soon as a third cell of K shows up (the common, interior case).
  let same = 0, seen = 0;
  for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e && same < 3; q++) {
    const t = top[adj[q]];
    if (t === K) same++;
    else if (t >= 0) seen |= 1 << t;
  }
  if (same > 2 || seen === 0) return 0;
  if (same === 2) {
    // Near-speck: a one-cell protrusion (or the filler of a one-cell notch) of K into another plate.
    // Smoothing the boundary by neighbour majority — handing it over like a speck when one other
    // plate holds at least 4 of the ring cells — removes the cell-scale serration that lattice
    // aliasing and gap filling leave along plate boundaries.
    const T = dominantNeighbour(state, i, seen);
    let cnt = 0;
    for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e; q++) if (top[adj[q]] === T) cnt++;
    if (cnt < NEAR_SPECK_MAJORITY) return 0;
  }
  const PK = slots[K] as PlateSlot;
  const jK = src[i];
  // Pull maps are not injective: an earlier speck of this pass may already have handed over the
  // lattice cell this world cell shows. It is an orphan now (markOrphanedTops turns it into a gap);
  // releasing / copying it again would double-count ownership and duplicate its crust.
  if (!PK.owned[jK]) {
    markRecheck(state, i);
    return 0;
  }
  const T = dominantNeighbour(state, i, seen);
  const PT = slots[T] as PlateSlot;
  const jT = pullLattice(state, T, i);
  const continental = PK.crust[jK] === CRUST_CONTINENTAL;
  if (PT.owned[jT]) {
    if (continental && PT.crust[jT] !== CRUST_CONTINENTAL) {
      copyLatticeCell(PK, jK, PT, jT);
      releaseCell(state, PK, jK, false);
      markReleased(state, i);
    }
  } else {
    // T has no lattice cell here yet (usually its jagged leading edge): extend T by one cell.
    let accrete = continental;
    if (!continental) {
      toPlateFrame(state, PT, i, local);
      const near = nearestOwnedAround(state, PT, jT, local);
      if (near < 0) {
        markRecheck(state, i);
        return 0;
      }
      // Next to T's continental crust the oceanic speck is accreted as it is (a forearc sliver) —
      // extending the continent over it would grow continental crust out of cell-scale aliasing at
      // every jagged convergent margin. Elsewhere T's own oceanic crust closes the hole.
      if (PT.crust[near] === CRUST_CONTINENTAL) accrete = true;
      else copyLatticeCell(PT, near, PT, jT);
    }
    if (accrete) copyLatticeCell(PK, jK, PT, jT);
    claimCell(PT, jT);
    releaseCell(state, PK, jK, !accrete);
    markReleased(state, i);
  }
  assignTop(state, T, jT, i);
  markTopChanged(state, i);
  if (PK.owned[jK]) loser[i] = slotBit(K);
  return 1;
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
