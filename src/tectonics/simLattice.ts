import { nearestCell } from '../core/sphereMesh';
import { CRUST_OCEANIC } from '../core/types';
import { oceanDepthForAge } from './draft';
import { walkFrom } from './simMesh';
import { markOwned, markUnowned, slotBit, type PlateSlot, type SimState } from './simState';

// Small helpers shared by the passes that edit plate lattices (gaps, specks, merges).

/** Nearest lattice cell of plate k to world cell i, using the freshest push data as a hint. */
export function pullLattice(state: SimState, k: number, i: number): number {
  const P = state.slots[k] as PlateSlot;
  const sm = state.sm;
  const { xyz, adjOffset, adj, mesh } = sm;
  const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
  const m = P.m;
  const lx = m[0] * x + m[3] * y + m[6] * z;
  const ly = m[1] * x + m[4] * y + m[7] * z;
  const lz = m[2] * x + m[5] * y + m[8] * z;
  let h = -1;
  if ((state.presenceCur[i] >>> k) & 1) h = P.pushInv[i];
  else if (state.top[i] === k) h = state.src[i];
  else {
    for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e; q++) {
      const a = adj[q];
      if ((state.presenceCur[a] >>> k) & 1) {
        h = P.pushInv[a];
        break;
      }
    }
  }
  return h >= 0 ? walkFrom(sm, lx, ly, lz, h) : nearestCell(mesh, lx, ly, lz);
}

/** Plate-frame coordinates of world cell i in plate P, written to out[0..2]. */
export function toPlateFrame(state: SimState, P: PlateSlot, i: number, out: Float64Array): void {
  const { xyz } = state.sm;
  const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
  const m = P.m;
  out[0] = m[0] * x + m[3] * y + m[6] * z;
  out[1] = m[1] * x + m[4] * y + m[7] * z;
  out[2] = m[2] * x + m[5] * y + m[8] * z;
}

/**
 * Owned lattice cell of plate P nearest to the plate-frame direction p (p[0..2]), searched in the
 * first and then the second lattice ring of j; −1 when neither ring holds an owned cell.
 */
export function nearestOwnedAround(state: SimState, P: PlateSlot, j: number, p: Float64Array): number {
  const { xyz, adjOffset, adj, diskOffset, disk, ring2End } = state.sm;
  const px = p[0], py = p[1], pz = p[2];
  let best = -1, bestDot = -2;
  for (let q = adjOffset[j], e = adjOffset[j + 1]; q < e; q++) {
    const a = adj[q];
    if (!P.owned[a]) continue;
    const d = xyz[3 * a] * px + xyz[3 * a + 1] * py + xyz[3 * a + 2] * pz;
    if (d > bestDot) {
      bestDot = d;
      best = a;
    }
  }
  if (best >= 0) return best;
  // Disk entries are sorted by ring: [diskOffset, ring2End) = rings 1–2 (ring 1 already checked).
  for (let q = diskOffset[j], e = ring2End[j]; q < e; q++) {
    const a = disk[q];
    if (!P.owned[a]) continue;
    const d = xyz[3 * a] * px + xyz[3 * a + 1] * py + xyz[3 * a + 2] * pz;
    if (d > bestDot) {
      bestDot = d;
      best = a;
    }
  }
  return best;
}

/** Dot product of lattice cell j with the direction p (p[0..2]). */
export function latticeDot(state: SimState, j: number, p: Float64Array): number {
  const { xyz } = state.sm;
  return xyz[3 * j] * p[0] + xyz[3 * j + 1] * p[1] + xyz[3 * j + 2] * p[2];
}

/** Record that lattice cell j of plate g now covers world cell i (top, src and push data). */
export function assignTop(state: SimState, g: number, j: number, i: number): void {
  const P = state.slots[g] as PlateSlot;
  state.top[i] = g;
  state.src[i] = j;
  state.loser[i] = 0;
  P.hint[j] = i;
  P.pushInv[i] = j;
  state.presenceCur[i] |= slotBit(g);
}

export function copyLatticeCell(from: PlateSlot, jf: number, to: PlateSlot, jt: number): void {
  to.crust[jt] = from.crust[jf];
  to.elev[jt] = from.elev[jf];
  to.age[jt] = from.age[jf];
  to.orogeny[jt] = from.orogeny[jf];
}

/** Take ownership of lattice cell j for plate P (its properties must be written by the caller). */
export function claimCell(P: PlateSlot, j: number): void {
  markOwned(P, j);
  P.ownedCount++;
}

/** Remove lattice cell j from plate P (transferred elsewhere, or consumed when `subducted`). */
export function releaseCell(state: SimState, P: PlateSlot, j: number, subducted: boolean): void {
  markUnowned(P, j);
  P.ownedCount--;
  if (subducted) state.counters.subductedCells++;
}

/** New oceanic crust (age 0, ridge depth) in lattice cell j of plate P. */
export function createRidgeCrust(state: SimState, P: PlateSlot, j: number): void {
  claimCell(P, j);
  P.crust[j] = CRUST_OCEANIC;
  P.age[j] = 0;
  P.elev[j] = oceanDepthForAge(0);
  P.orogeny[j] = 0;
  state.counters.ridgeCells++;
}
