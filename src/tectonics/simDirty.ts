import type { SimState } from './simState';

/**
 * Change tracking for the settle passes (speck hand-over, orphan detection; SPEC §4.2 D).
 *
 * Whether a world cell is a speck depends only on the top plates of its closed ring, so after one
 * full scan only cells whose closed ring changed since they were last found clean (plus specks that
 * could not be resolved yet) need another look. Orphaned tops can only appear where a lattice cell was
 * released. Visiting exactly those cells in increasing index order reproduces the full scans' result
 * bit for bit at a fraction of the cost (a settle usually takes 2–3 rounds).
 */
export interface DirtySet {
  /** Cells to visit in the current resolveSpecks round (bitmap, 32 cells per word). */
  cur: Uint32Array;
  /** Cells to visit in the next round. */
  next: Uint32Array;
  /** Index the running speck scan has reached (−1 when no scan runs). */
  scanPos: number;
  /** True while a full (every cell) speck scan runs. */
  scanFull: boolean;
  /** World cells where lattice cells were released since the last orphan check. */
  releases: Int32Array;
  releaseCount: number;
  /** Candidates of the incremental orphan check (bitmap). */
  orphanCand: Uint32Array;
  /** Untracked edits happened (construction, step-level plate edits): the next settle scans fully. */
  full: boolean;
}

/**
 * Debug switches for equivalence tests: `fullScans` makes every settle round scan every cell (the
 * reference the incremental scans must reproduce bit for bit); `noDeepSkip` disables the interior
 * skipping of intermediate substeps (markDeepInterior).
 */
export const settleDebug = { fullScans: false, noDeepSkip: false };

const dirtyOf = new WeakMap<SimState, DirtySet>();

export function dirtySet(state: SimState): DirtySet {
  let d = dirtyOf.get(state);
  if (!d) {
    const words = (state.n + 31) >>> 5;
    d = {
      cur: new Uint32Array(words),
      next: new Uint32Array(words),
      scanPos: -1,
      scanFull: false,
      releases: new Int32Array(1024),
      releaseCount: 0,
      orphanCand: new Uint32Array(words),
      full: true,
    };
    dirtyOf.set(state, d);
  }
  return d;
}

/** Mark one cell for a speck check: later in the running scan if still ahead of it, else next round. */
function markOne(d: DirtySet, c: number): void {
  if (c > d.scanPos && d.scanPos >= 0) {
    if (!d.scanFull) d.cur[c >>> 5] |= 1 << (c & 31);
  } else {
    d.next[c >>> 5] |= 1 << (c & 31);
  }
}

/** The top plate of world cell i changed: i and its ring need a speck check. */
export function markTopChanged(state: SimState, i: number): void {
  const d = dirtySet(state);
  const { adjOffset, adj } = state.sm;
  markOne(d, i);
  for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e; q++) markOne(d, adj[q]);
}

/** Re-check world cell i in the next round (a speck that could not be resolved yet). */
export function markRecheck(state: SimState, i: number): void {
  const d = dirtySet(state);
  d.next[i >>> 5] |= 1 << (i & 31);
}

/** A lattice cell showing (or pushed) at world cell i was released: orphans may appear around i. */
export function markReleased(state: SimState, i: number): void {
  const d = dirtySet(state);
  if (d.releaseCount === d.releases.length) {
    const r = new Int32Array(2 * d.releases.length);
    r.set(d.releases);
    d.releases = r;
  }
  d.releases[d.releaseCount++] = i;
}

/** Request full scans at the next settle (after edits that are not tracked cell by cell). */
export function markAllDirty(state: SimState): void {
  dirtySet(state).full = true;
}
