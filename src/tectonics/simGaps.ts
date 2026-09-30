import { CRUST_CONTINENTAL } from '../core/types';
import { RIDGE_MIN_DIVERGENCE, RIFT_BASIN_DROP } from './simConstants';
import { divergenceAt } from './simGeometry';
import {
  assignTop, claimCell, copyLatticeCell, createRidgeCrust, latticeDot, nearestOwnedAround, pullLattice, toPlateFrame,
} from './simLattice';
import { dirtySet, markTopChanged } from './simDirty';
import type { PlateSlot, SimState } from './simState';

/** Per-state scratch of the gap pass. */
interface GapScratch {
  pending: Int32Array;
  /** Cells handed to fillGaps (checked for new specks afterwards). */
  filled: Int32Array;
  /** Plate whose covering lattice cell disappeared under world cell i (orphaned top), else −1. */
  orphanOf: Int8Array;
}
const scratchOf = new WeakMap<SimState, GapScratch>();
function scratch(state: SimState): GapScratch {
  let s = scratchOf.get(state);
  if (!s) {
    s = { pending: new Int32Array(state.n), filled: new Int32Array(state.n), orphanOf: new Int8Array(state.n).fill(-1) };
    scratchOf.set(state, s);
  }
  return s;
}

const local = new Float64Array(3);
const distinct = new Int32Array(16);

/**
 * A lattice cell removed by the plate pass or a speck transfer may still be the pulled source of
 * other world cells (pull and push maps are not inverses): those lose their top and join the gaps.
 */
export function markOrphanedTops(state: SimState, full = true): void {
  const { n, top, src, slots, gaps } = state;
  const orphanOf = scratch(state).orphanOf;
  const d = dirtySet(state);
  let count = state.gapCount;
  const orphan = (i: number): void => {
    const t = top[i];
    if (t < 0 || (slots[t] as PlateSlot).owned[src[i]]) return;
    orphanOf[i] = t;
    top[i] = -1;
    state.loser[i] = 0;
    gaps[count++] = i;
    markTopChanged(state, i);
  };
  if (full) {
    for (let i = 0; i < n; i++) orphan(i);
  } else if (d.releaseCount > 0) {
    // Other world cells pulling a released lattice cell lie within ~2 rings of where it showed or
    // was pushed (both sit in its Voronoi region): check the 3-ring disks, in index order.
    const { diskOffset, disk } = state.sm;
    const cand = d.orphanCand;
    for (let r = 0; r < d.releaseCount; r++) {
      const i = d.releases[r];
      cand[i >>> 5] |= 1 << (i & 31);
      for (let q = diskOffset[i], e = diskOffset[i + 1]; q < e; q++) cand[disk[q] >>> 5] |= 1 << (disk[q] & 31);
    }
    for (let w = 0, words = cand.length; w < words; w++) {
      let bits = cand[w];
      if (bits === 0) continue;
      cand[w] = 0;
      while (bits !== 0) {
        const low = bits & -bits;
        bits ^= low;
        orphan((w << 5) + 31 - Math.clz32(low));
      }
    }
  }
  d.releaseCount = 0;
  state.gapCount = count;
}

/**
 * D. Fill all pending gaps (gaps without covered neighbours wait for their neighbours). Returns true
 * when a filled cell ended up isolated (no same-plate neighbour), i.e. a new speck.
 */
export function fillGaps(state: SimState): boolean {
  const sc = scratch(state);
  const filled = sc.filled;
  const filledCount = state.gapCount;
  filled.set(state.gaps.subarray(0, filledCount));
  let list = state.gaps;
  let count = state.gapCount;
  let other = sc.pending;
  while (count > 0) {
    let next = 0;
    for (let q = 0; q < count; q++) {
      const i = list[q];
      if (state.top[i] >= 0) continue;
      if (!fillGap(state, i, sc.orphanOf)) other[next++] = i;
      else markTopChanged(state, i);
    }
    if (next === count) throw new Error(`fillGaps: ${count} gap cells have no covered cell nearby`);
    const t = list;
    list = other;
    other = t;
    count = next;
  }
  state.gapCount = 0;
  // Filling a gap only adds same-plate neighbours to others, so only the filled cells can be specks.
  const { top } = state;
  const { adjOffset, adj } = state.sm;
  for (let q = 0; q < filledCount; q++) {
    const i = filled[q];
    let same = 0;
    for (let r = adjOffset[i], e = adjOffset[i + 1]; r < e && same < 2; r++) if (top[adj[r]] === top[i]) same++;
    if (same < 2) return true;
  }
  return false;
}

/** Distinct top plates within two rings of i, written to `distinct`; returns the count. */
function collectDistinctTops(state: SimState, i: number): number {
  const { diskOffset, disk, ring2End } = state.sm;
  const top = state.top;
  let cnt = 0;
  let seen = 0;
  for (let q = diskOffset[i], e = ring2End[i]; q < e && cnt < distinct.length; q++) {
    const t = top[disk[q]];
    if (t < 0 || (seen >>> t) & 1) continue;
    seen |= 1 << t;
    distinct[cnt++] = t;
  }
  return cnt;
}

/** Most common top plate in the first ring of i other than `exclude` (ties → lowest slot); −1 if none. */
function mostCommonNeighbourTop(state: SimState, i: number, exclude: number): number {
  const { adjOffset, adj } = state.sm;
  const top = state.top;
  let best = -1, bestCnt = 0;
  for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e; q++) {
    const t = top[adj[q]];
    if (t < 0 || t === exclude) continue;
    let c = 0;
    for (let r = adjOffset[i]; r < e; r++) if (top[adj[r]] === t) c++;
    if (c > bestCnt || (c === bestCnt && t < best)) {
      bestCnt = c;
      best = t;
    }
  }
  return best;
}

/**
 * D. Fill one gap (world cell no plate covers). The fastest-separating pair of plates within two
 * rings decides: > RIDGE_MIN_DIVERGENCE opens new ridge crust, otherwise (transform, aliasing, slow
 * stretching) the covering plate's own crust is cloned. Returns false when no plate is nearby yet.
 */
function fillGap(state: SimState, i: number, orphanOf: Int8Array): boolean {
  const nd = collectDistinctTops(state, i);
  if (nd === 0) return false;
  const consumed = orphanOf[i];
  orphanOf[i] = -1;
  let maxDiv = 0, pa = -1, pb = -1;
  for (let u = 0; u < nd; u++) {
    for (let w = u + 1; w < nd; w++) {
      const d = divergenceAt(state, i, distinct[u], distinct[w]);
      if (d > maxDiv) {
        maxDiv = d;
        pa = distinct[u];
        pb = distinct[w];
      }
    }
  }
  if (maxDiv > RIDGE_MIN_DIVERGENCE) openRidge(state, i, pa, pb);
  else cloneFill(state, i, consumed);
  return true;
}

/**
 * New ridge crust goes to the plate whose nearest edge crust is OLDER (ties: nearer material).
 * Receiving crust makes a plate's edge young, so the next opening goes to the other side: the plates
 * alternate and spreading is symmetric about a ridge moving at the mean plate velocity. (Assigning to
 * the vacating plate would pin ridges to the mantle frame; assigning to the nearer material always
 * favours the moving plate.)
 */
function openRidge(state: SimState, i: number, pa: number, pb: number): void {
  let g = -1, gj = -1, gAge = -Infinity, gDot = -2;
  for (let side = 0; side < 2; side++) {
    const c = side === 0 ? pa : pb;
    const P = state.slots[c] as PlateSlot;
    const j = pullLattice(state, c, i);
    if (P.owned[j]) {
      assignTop(state, c, j, i);
      return;
    }
    toPlateFrame(state, P, i, local);
    const near = nearestOwnedAround(state, P, j, local);
    if (near < 0) continue;
    const edgeAge = P.age[near];
    const dot = latticeDot(state, near, local);
    if (edgeAge > gAge || (edgeAge === gAge && dot > gDot)) {
      gAge = edgeAge;
      gDot = dot;
      g = c;
      gj = j;
    }
  }
  if (g < 0) {
    g = pa;
    gj = pullLattice(state, pa, i);
  }
  createRidgeCrust(state, state.slots[g] as PlateSlot, gj);
  assignTop(state, g, gj, i);
}

/**
 * Clone the covering plate's own nearest crust into the gap (never another plate's). The plate is
 * the previous top (it just moved away); a cell orphaned by consumption goes to a neighbouring plate
 * other than the consumed one (usually the overriding plate), so consumed crust is not cloned back.
 */
function cloneFill(state: SimState, i: number, consumed: number): void {
  let g = consumed >= 0 ? mostCommonNeighbourTop(state, i, consumed) : state.topPrev[i];
  if (g < 0 || !state.slots[g]) g = mostCommonNeighbourTop(state, i, -1);
  if (g < 0) g = distinct[0];
  const P = state.slots[g] as PlateSlot;
  const j = pullLattice(state, g, i);
  if (P.owned[j]) {
    assignTop(state, g, j, i);
    return;
  }
  toPlateFrame(state, P, i, local);
  let from = nearestOwnedAround(state, P, j, local);
  if (from < 0) {
    // g's material near i is only visible at neighbouring world cells (it covered i through an edge).
    const { diskOffset, disk, ring2End } = state.sm;
    for (let q = diskOffset[i], e = ring2End[i]; q < e && from < 0; q++) if (state.top[disk[q]] === g) from = state.src[disk[q]];
  }
  if (from < 0) {
    // Isolated opening with no material of g nearby: genuinely new sea floor.
    createRidgeCrust(state, P, j);
    assignTop(state, g, j, i);
    return;
  }
  claimCell(P, j);
  copyLatticeCell(P, from, P, j);
  if (P.crust[j] === CRUST_CONTINENTAL) {
    P.elev[j] -= RIFT_BASIN_DROP;
    state.counters.continentalCreated++;
    state.counters.continentalClones++;
  }
  assignTop(state, g, j, i);
}
