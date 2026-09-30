import { CRUST_CONTINENTAL } from '../core/types';
import { claimCell, copyLatticeCell, pullLattice } from './simLattice';
import { walkNearest } from './simMesh';
import { freePlateSlot, slotBit, type PlateSlot, type SimState } from './simState';

interface MergeScratch {
  /** Lattice cell of the absorbed plate visible at world cell i (−1 elsewhere). */
  srcS: Int32Array;
  list: Int32Array;
  claimed: Uint8Array;
  claimedList: Int32Array;
  usedS: Uint8Array;
}
const scratchOf = new WeakMap<SimState, MergeScratch>();
function scratch(state: SimState): MergeScratch {
  let s = scratchOf.get(state);
  if (!s) {
    const n = state.n;
    s = {
      srcS: new Int32Array(n).fill(-1),
      list: new Int32Array(n),
      claimed: new Uint8Array(n),
      claimedList: new Int32Array(n),
      usedS: new Uint8Array(n),
    };
    scratchOf.set(state, s);
  }
  return s;
}

/**
 * Merge plate `small` into plate `large` by footprint: the small plate's visible world cells (plus a
 * 1-ring dilation in the large plate's lattice, which closes lattice-aliasing holes) are pulled into
 * the large plate's frame. Where both own the target lattice cell, the currently visible (small)
 * crust wins. The small plate's hidden cells are dropped and its slot is freed.
 */
export function mergePlates(state: SimState, small: number, large: number): void {
  const S = state.slots[small] as PlateSlot;
  const L = state.slots[large] as PlateSlot;
  const { n, top, src } = state;
  const { xyz, adjOffset, adj } = state.sm;
  const mk = scratch(state);
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    if (top[i] !== small) continue;
    mk.list[cnt++] = i;
    mk.srcS[i] = src[i];
  }
  const bitL = slotBit(large);
  let claimedCount = 0;
  for (let q = 0; q < cnt; q++) {
    const i = mk.list[q];
    const jS = mk.srcS[i];
    const jL = pullLattice(state, large, i);
    if (!L.owned[jL]) claimCell(L, jL);
    copyLatticeCell(S, jS, L, jL);
    mk.usedS[jS] = 1;
    L.hint[jL] = i;
    L.pushInv[i] = jL;
    top[i] = large;
    src[i] = jL;
    state.presenceCur[i] |= bitL;
    if (!mk.claimed[jL]) {
      mk.claimed[jL] = 1;
      mk.claimedList[claimedCount++] = jL;
    }
  }
  // Dilation: unowned lattice neighbours of claimed cells that land on the absorbed footprint.
  const m = L.m;
  for (let q = 0; q < claimedCount; q++) {
    const jL = mk.claimedList[q];
    for (let r = adjOffset[jL], e = adjOffset[jL + 1]; r < e; r++) {
      const a = adj[r];
      if (L.owned[a]) continue;
      const x = xyz[3 * a], y = xyz[3 * a + 1], z = xyz[3 * a + 2];
      const i2 = walkNearest(
        xyz, adjOffset, adj, m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z,
        L.hint[jL],
      );
      const jS2 = mk.srcS[i2];
      if (jS2 < 0) continue;
      claimCell(L, a);
      copyLatticeCell(S, jS2, L, a);
      L.hint[a] = i2;
    }
  }
  // Hidden cells of the large plate under the absorbed footprint (lattice cells no world cell pulls,
  // so the pull transfer above missed them) take the absorbed crust visible where they push to.
  for (let j = 0; j < n; j++) {
    if (!L.owned[j] || mk.claimed[j]) continue;
    const jS = mk.srcS[L.hint[j]];
    if (jS >= 0) copyLatticeCell(S, jS, L, j);
  }
  // Hidden continental crust of the absorbed plate is lost with it.
  for (let j = 0; j < n; j++) {
    if (S.owned[j] && !mk.usedS[j] && S.crust[j] === CRUST_CONTINENTAL) state.counters.continentalDestroyed++;
    mk.usedS[j] = 0;
  }
  for (let q = 0; q < cnt; q++) mk.srcS[mk.list[q]] = -1;
  for (let q = 0; q < claimedCount; q++) mk.claimed[mk.claimedList[q]] = 0;
  freePlateSlot(state, small);
  state.counters.merges++;
}

/** Drop a plate that has no visible cells (its hidden cells vanish). */
export function dropHiddenPlate(state: SimState, k: number): void {
  const P = state.slots[k] as PlateSlot;
  for (let j = 0; j < state.n; j++) {
    if (P.owned[j] && P.crust[j] === CRUST_CONTINENTAL) state.counters.continentalDestroyed++;
  }
  freePlateSlot(state, k);
}
