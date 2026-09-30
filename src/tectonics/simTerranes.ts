import { CRUST_CONTINENTAL } from '../core/types';
import { TERRANE_DOCK_SHORTENING, TERRANE_MAX_FRACTION, TERRANE_MIN_FRACTION } from './simConstants';
import { markAllDirty } from './simDirty';
import { assignTop, claimCell, copyLatticeCell, pullLattice, releaseCell } from './simLattice';
import { walkFrom } from './simMesh';
import { FRONT_COLLISION, stepScratch, type StepScratch } from './simScratch';
import { pairIndex, type PlateSlot, type SimState } from './simState';

interface TerraneScratch {
  /** Stamp of the fragment a world cell belongs to. */
  mark: Int32Array;
  /** Lattice cell of the lower plate shown at a fragment's world cell. */
  srcK: Int32Array;
  list: Int32Array;
  claimed: Int32Array;
  stamp: number;
}
const scratchOf = new WeakMap<SimState, TerraneScratch>();

function terraneScratch(state: SimState): TerraneScratch {
  let ts = scratchOf.get(state);
  if (!ts) {
    const n = state.n;
    ts = { mark: new Int32Array(n), srcK: new Int32Array(n), list: new Int32Array(n), claimed: new Int32Array(n), stamp: 0 };
    scratchOf.set(state, ts);
  }
  return ts;
}

/**
 * Terrane accretion. A small continental fragment (microcontinent, accreted arc) carried into a
 * collision front cannot be subducted, and it is far too small to stop its (usually oceanic) plate:
 * after a little collisional shortening it docks — the whole fragment (the continental cells of the
 * lower plate connected to the front, TERRANE_MIN_FRACTION..TERRANE_MAX_FRACTION of the sphere) is transferred to the
 * overriding plate with its crust, and the lower plate keeps subducting behind it (a subduction jump).
 * Crust is conserved, unlike consumption at the front; large continents still collide and build belts.
 * Requires this step's detectFronts(). Returns the number of world cells transferred.
 */
export function dockTerranes(state: SimState, sc: StepScratch = stepScratch(state)): number {
  const { top, slots, pairs } = state;
  const { adjOffset, adj } = state.sm;
  const ts = terraneScratch(state);
  const maxCells = Math.max(8, Math.floor(TERRANE_MAX_FRACTION * state.n));
  const minCells = Math.max(3, Math.round(TERRANE_MIN_FRACTION * state.n));
  let moved = 0;
  const base = ts.stamp;
  for (let q = 0; q < sc.frontCount; q++) {
    const f = sc.frontList[q];
    if (sc.frontKind[f] !== FRONT_COLLISION) continue;
    const T = sc.frontOver[f], K = sc.frontUnder[f];
    const PT = slots[T], PK = slots[K];
    if (!PT || !PK || top[f] !== T) continue;
    const pi = pairIndex(T, K);
    if (!(pairs.shortening[pi] >= TERRANE_DOCK_SHORTENING)) continue;
    // A front spans many cells of the same fragment (or continent): search each region once per call.
    let searched = false;
    for (let r = adjOffset[f], e = adjOffset[f + 1]; r < e && !searched; r++) searched = ts.mark[adj[r]] > base;
    if (searched) continue;
    const count = collectFragment(state, ts, f, K, PK, maxCells);
    // Slivers of a cell or two at a jagged front are part of the collision, not terranes.
    if (count < minCells) continue;
    moved += transferFragment(state, ts, count, T, PT, PK);
    // The pair's shortening is kept: other stretches of the same front may still be colliding (and
    // are slowed by it); it lapses by itself once the pair has no collision contacts left.
    state.counters.terranes++;
  }
  // Lattice ownership changed wholesale around the fragments: re-examine every cell when settling.
  if (moved > 0) markAllDirty(state);
  return moved;
}

/**
 * Continental world cells of plate K connected to front cell f (breadth first); their count, or −1
 * when the region exceeds maxCells (a real continent, not a terrane). Fills ts.list / ts.srcK and
 * stamps ts.mark with the new ts.stamp.
 */
function collectFragment(state: SimState, ts: TerraneScratch, f: number, K: number, PK: PlateSlot, maxCells: number): number {
  const { top, src } = state;
  const { adjOffset, adj } = state.sm;
  const stamp = ++ts.stamp;
  let count = 0;
  const visit = (a: number): boolean => {
    if (top[a] !== K || ts.mark[a] === stamp || PK.crust[src[a]] !== CRUST_CONTINENTAL) return true;
    if (count >= maxCells) return false;
    ts.mark[a] = stamp;
    ts.srcK[a] = src[a];
    ts.list[count++] = a;
    return true;
  };
  for (let r = adjOffset[f], e = adjOffset[f + 1]; r < e; r++) if (!visit(adj[r])) return -1;
  for (let head = 0; head < count; head++) {
    const c = ts.list[head];
    for (let r = adjOffset[c], e = adjOffset[c + 1]; r < e; r++) if (!visit(adj[r])) return -1;
  }
  return count;
}

/**
 * Move the fragment (ts.list[0..count)) from plate K to plate T: pull every world cell into T's
 * lattice, then close lattice-aliasing holes with a one-ring dilation (as mergePlates does), and
 * finally release K's cells. Returns the number of world cells moved.
 */
function transferFragment(state: SimState, ts: TerraneScratch, count: number, T: number, PT: PlateSlot, PK: PlateSlot): number {
  const { xyz, adjOffset, adj } = state.sm;
  const stamp = ts.stamp;
  let claimedCount = 0;
  for (let k = 0; k < count; k++) {
    const c = ts.list[k];
    const jK = ts.srcK[c];
    const jT = pullLattice(state, T, c);
    if (!PT.owned[jT]) {
      claimCell(PT, jT);
      ts.claimed[claimedCount++] = jT;
    }
    copyLatticeCell(PK, jK, PT, jT);
    assignTop(state, T, jT, c);
  }
  // Unowned lattice neighbours of the new cells that land on the fragment would open as gaps (and be
  // refilled by cloning) in the next substep: give them the fragment's crust now.
  const m = PT.m;
  for (let q = 0; q < claimedCount; q++) {
    const jT = ts.claimed[q];
    for (let r = adjOffset[jT], e = adjOffset[jT + 1]; r < e; r++) {
      const a = adj[r];
      if (PT.owned[a]) continue;
      const x = xyz[3 * a], y = xyz[3 * a + 1], z = xyz[3 * a + 2];
      const i2 = walkFrom(state.sm, m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z, PT.hint[jT]);
      if (ts.mark[i2] !== stamp) continue;
      claimCell(PT, a);
      copyLatticeCell(PK, ts.srcK[i2], PT, a);
      PT.hint[a] = i2;
    }
  }
  for (let k = 0; k < count; k++) {
    const jK = ts.srcK[ts.list[k]];
    if (PK.owned[jK]) releaseCell(state, PK, jK, false);
  }
  return count;
}
