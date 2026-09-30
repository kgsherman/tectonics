/**
 * Coastline hygiene after a continent-brush stroke: a stroke is a union of rough, overlapping dabs,
 * which can leave pinhole "lakes" of ocean crust enclosed by the new land and single-cell specks of
 * land just off the new coast. Both read as noise (and become deep holes / needle islands after
 * "Simulate"), so small ones next to the stroke are resolved: pinholes become land, specks painted
 * by this very stroke go back to ocean.
 */
import { oceanDepthForAge } from '../tectonics/draft';
import { CRUST_CONTINENTAL, CRUST_OCEANIC } from '../core/types';
import { PAINTED_CONTINENT_AGE } from './editorConstants';
import type { Mutator } from './plateOps';

export interface HygieneResult {
  /** Ocean pinholes filled (cells). */
  filled: number;
  /** Land specks removed (cells). */
  removed: number;
  /** Every cell whose crust changed (their coastal relief must be recomputed). */
  cells: number[];
}

/**
 * Size limits (cells) for a stroke of `radius` radians on a mesh of `spacing` radians: pinholes up to
 * ~6% of a dab's area (at least 3 cells), specks up to ~2% (none for brushes under 3 cells wide,
 * whose whole point may be a tiny island).
 */
export function hygieneLimits(radius: number, spacing: number): { pinhole: number; speck: number } {
  const cellsAcross = radius / spacing;
  const a = cellsAcross * cellsAcross;
  return {
    pinhole: Math.min(40, Math.max(3, Math.round(0.06 * a))),
    speck: cellsAcross < 3 ? 0 : Math.min(12, Math.max(2, Math.round(0.02 * a))),
  };
}

/**
 * `near`: cells the stroke touched; `painted[i] = 1` for cells the stroke turned continental;
 * `oceanAges`: per-plate ocean age for cells returned to the ocean.
 */
export function continentHygiene(
  mut: Mutator, near: ArrayLike<number>, painted: Uint8Array, oceanAges: Float64Array, limits: { pinhole: number; speck: number },
): HygieneResult {
  const { mesh, state } = mut;
  const d = state.draft;
  const { n, adjOffset, adj } = mesh;
  const out: HygieneResult = { filled: 0, removed: 0, cells: [] };
  // Flood only from candidate seeds (cells next to the stroke), stopping early once a region is
  // bigger than the limit — the open ocean and the continent itself are never walked in full.
  // `stamp` marks cells of the current flood only (a truncated flood must not wall in the next
  // one); `done` marks seeds already classified.
  const stamp = new Int32Array(n);
  const done = new Uint8Array(n);
  let gen = 0;
  const queue: number[] = [];
  const seed = (s: number) => {
    if (done[s]) return;
    const kind = d.crust[s] === CRUST_CONTINENTAL ? 1 : 0;
    const limit = kind ? limits.speck : limits.pinhole;
    if (limit <= 0) return;
    const g = ++gen;
    queue.length = 0;
    queue.push(s);
    stamp[s] = g;
    let big = false;
    let allPainted = kind === 1;
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h];
      if (kind && !painted[i]) allPainted = false;
      for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
        const j = adj[e];
        if (stamp[j] === g || (d.crust[j] === CRUST_CONTINENTAL ? 1 : 0) !== kind) continue;
        stamp[j] = g;
        queue.push(j);
      }
      if (queue.length > limit) {
        big = true;
        break;
      }
    }
    // A big region's other seeds would find it big again: mark what was walked as classified.
    for (const i of queue) done[i] = 1;
    if (big) return;
    if (kind === 0) {
      for (const i of queue) {
        mut.touch(i);
        d.crust[i] = CRUST_CONTINENTAL;
        d.age[i] = PAINTED_CONTINENT_AGE;
        d.elev[i] = -150;
        if (d.orogeny) d.orogeny[i] = 0;
        state.brushRelief[i] = 1;
        state.userElev[i] = 0;
        state.sourceRelief[i] = 0;
        mut.markCell(i);
        out.cells.push(i);
      }
      out.filled += queue.length;
    } else if (allPainted) {
      for (const i of queue) {
        mut.touch(i);
        const age = oceanAges[d.plate[i]];
        d.crust[i] = CRUST_OCEANIC;
        d.age[i] = age;
        d.elev[i] = Math.fround(oceanDepthForAge(age));
        if (d.orogeny) d.orogeny[i] = 0;
        state.brushRelief[i] = 0;
        state.userElev[i] = 0;
        state.sourceRelief[i] = 0;
        mut.markCell(i);
        out.cells.push(i);
      }
      out.removed += queue.length;
    }
  };
  for (let q = 0; q < near.length; q++) {
    const i = near[q];
    seed(i);
    for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) seed(adj[e]);
  }
  return out;
}
