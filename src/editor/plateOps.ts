import { Rng } from '../core/rng';
import type { PlateSpec, RGB, SphereMesh, Vec3 } from '../core/types';
import { CRUST_CONTINENTAL } from '../core/types';
import { plateColor, plateName } from '../tectonics/draft';
import type { EditState } from './editState';
import { MIN_FRAGMENT_CELLS } from './editorConstants';
import { randomMotion } from './motion';
import { labelComponents, longestBorderNeighbor, plateAnchors, plateCounts } from './topology';

/**
 * Write access to an edit state that records undo information and change tracking. Implemented
 * by EditorCore; plate operations only mutate cells through it.
 */
export interface Mutator {
  readonly mesh: SphereMesh;
  readonly state: EditState;
  /** Plate cap for this editor. */
  readonly cap: number;
  /** Assign cell i to plate index k (records undo, marks both plates dirty and the cell for repaint). */
  setPlate(i: number, k: number): void;
  /** Record cell i's current values for undo (call before writing any of its fields directly). */
  touch(i: number): void;
  /** Cell i changed (repaint it and re-evaluate the boundaries around it). */
  markCell(i: number): void;
  /** Record every cell (before a global rewrite such as renumbering). */
  touchAll(): void;
  /** Mark plate index k as changed (outline or motion) — resolved to its id before indices shift. */
  markPlateDirty(k: number): void;
  /** Plate index k got a new motion: its boundary classes must be re-evaluated. */
  markMotionChanged(k: number): void;
  /** Resolve pending plate-index dirty marks into ids (call before plate indices change). */
  flushPlateDirty(): void;
  /** Deterministic random stream for this operation. */
  rng(salt: number): Rng;
}

/** First curated palette colour not used by any plate, else a fresh golden-angle hue. */
export function pickPlateColor(plates: PlateSpec[], id: number): RGB {
  const used = new Set(plates.map((p) => p.color.join(',')));
  for (let k = 0; k < 24; k++) {
    const c = plateColor(k);
    if (!used.has(c.join(','))) return c;
  }
  return plateColor(id - 1);
}

/** Append a new plate spec (fresh id / name / colour); returns its index. Motion and frame are copied from `like`. */
export function appendPlate(state: EditState, like: PlateSpec | null, omega?: Vec3): number {
  const d = state.draft;
  const id = Math.max(d.nextPlateId, ...d.plates.map((p) => p.id + 1), 1);
  d.nextPlateId = id + 1;
  const w = omega ?? like?.omega ?? [0, 0, 0];
  const spec: PlateSpec = {
    id,
    name: plateName(id, d.seed),
    color: pickPlateColor(d.plates, id),
    omega: [w[0], w[1], w[2]],
  };
  if (like?.frame) spec.frame = [like.frame[0], like.frame[1], like.frame[2], like.frame[3]];
  d.plates.push(spec);
  state.dirtyPlates.add(id);
  return d.plates.length - 1;
}

/** Remove plate index k, which must own no cells; later indices shift down by one. */
export function removeEmptyPlate(mut: Mutator, k: number): void {
  const d = mut.state.draft;
  mut.flushPlateDirty();
  mut.touchAll();
  for (let i = 0; i < d.n; i++) {
    const p = d.plate[i];
    if (p === k) throw new Error(`removeEmptyPlate: plate ${k} still owns cell ${i}`);
    if (p > k) d.plate[i] = p - 1;
  }
  d.plates.splice(k, 1);
}

/** Continental fraction of each plate's cells. */
export function continentalFractions(state: EditState): Float64Array {
  const d = state.draft;
  const np = d.plates.length;
  const cont = new Float64Array(np), cnt = new Float64Array(np);
  for (let i = 0; i < d.n; i++) {
    const k = d.plate[i];
    cnt[k]++;
    if (d.crust[i] === CRUST_CONTINENTAL) cont[k]++;
  }
  for (let k = 0; k < np; k++) cont[k] = cnt[k] > 0 ? cont[k] / cnt[k] : 0;
  return cont;
}

export interface TopologyResult {
  /** Ids of plates created by the operation's topology step (never by tidyFragments). */
  created: number[];
  /** Ids of plates removed (only explicit clean-ups remove plates). */
  removed: number[];
  /** Small detached slivers merged into neighbouring plates. */
  merged: number;
  /** Ids of plates the edit left without cells (they stay in the list, empty). */
  emptied?: number[];
}

export interface TidyOptions {
  /**
   * Plate index whose pieces are never merged away (the plate being painted / filled / lassoed:
   * painted cells keep the brush's plate, however small the piece).
   */
  keep?: number;
  /** Cells the edit changed; only slivers next to them are tidied (null: consider every sliver). */
  near?: ArrayLike<number> | null;
}

/**
 * Tidy the plate topology after an edit that moved cells between plates, WITHOUT ever creating or
 * removing plates (a stroke must not change the plate list behind the user's back):
 *  - detached slivers (< MIN_FRAGMENT_CELLS cells, not the plate's largest piece) of plates other
 *    than `keep`, touching an edited cell, merge into the neighbour with the longest shared
 *    boundary — the specks a brush leaves behind when it paints over a plate's edge;
 *  - larger pieces stay with their plate: a plate may be in several pieces while editing (the list
 *    shows a "pieces" badge; "Simulate" keeps the pieces as one plate);
 *  - a plate painted over entirely stays in the list, empty (delete it explicitly, or paint it back);
 *  - plates that just received their first cells and have no motion get a default random motion.
 */
export function tidyFragments(mut: Mutator, countsBefore: Int32Array, opts: TidyOptions = {}): TopologyResult {
  const { mesh, state } = mut;
  const d = state.draft;
  const n = d.n;
  const result: TopologyResult = { created: [], removed: [], merged: 0 };
  const np = d.plates.length;
  const comps = labelComponents(mesh, d.plate);
  const nc = comps.size.length;
  const main = new Int32Array(np).fill(-1);
  for (let c = 0; c < nc; c++) {
    const k = comps.label[c];
    if (main[k] < 0 || comps.size[c] > comps.size[main[k]]) main[k] = c;
  }
  const keep = opts.keep ?? -1;
  const isSliver = (c: number) => main[comps.label[c]] !== c && comps.size[c] < MIN_FRAGMENT_CELLS && comps.label[c] !== keep;
  const pick = new Uint8Array(nc);
  let any = false;
  const consider = (c: number) => {
    if (pick[c] || !isSliver(c)) return;
    pick[c] = 1;
    any = true;
  };
  if (opts.near) {
    const { adjOffset, adj } = mesh;
    const near = opts.near;
    for (let q = 0; q < near.length; q++) {
      const i = near[q];
      consider(comps.comp[i]);
      for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) consider(comps.comp[adj[e]]);
    }
  } else {
    for (let c = 0; c < nc; c++) consider(c);
  }
  if (any) {
    const lists = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const c = comps.comp[i];
      if (!pick[c]) continue;
      let l = lists.get(c);
      if (!l) lists.set(c, (l = []));
      l.push(i);
    }
    // Largest first (deterministic): a sliver merging into a neighbouring sliver's plate is fine,
    // nothing here requires plates to be connected.
    const order = [...lists.keys()].sort((a, b) => comps.size[b] - comps.size[a] || a - b);
    for (const c of order) {
      const cells = lists.get(c) as number[];
      const own = d.plate[cells[0]];
      const t = longestBorderNeighbor(mesh, d.plate, cells, own, np);
      if (t < 0) continue;
      result.merged++;
      for (const i of cells) mut.setPlate(i, t);
    }
  }
  const counts = assignFirstMotions(mut, countsBefore);
  for (let k = 0; k < Math.min(np, countsBefore.length); k++) {
    if (countsBefore[k] > 0 && counts[k] === 0) (result.emptied ??= []).push(d.plates[k].id);
  }
  return result;
}

/** Plates that just received their first cells and have no motion get a default motion at their interior point. */
function assignFirstMotions(mut: Mutator, countsBefore: Int32Array): Int32Array {
  const { mesh, state } = mut;
  const d = state.draft;
  const counts = plateCounts(d.plate, d.plates.length);
  let anchors: Array<Vec3 | null> | null = null;
  let contFrac: Float64Array | null = null;
  for (let k = 0; k < Math.min(d.plates.length, countsBefore.length); k++) {
    const w = d.plates[k].omega;
    if (countsBefore[k] !== 0 || counts[k] === 0 || w[0] !== 0 || w[1] !== 0 || w[2] !== 0) continue;
    anchors ??= plateAnchors(mesh, d.plate, d.plates.length);
    contFrac ??= continentalFractions(state);
    const a = anchors[k];
    if (a) {
      d.plates[k].omega = randomMotion(mut.rng(d.plates[k].id), a, contFrac[k]);
      mut.markPlateDirty(k);
      mut.markMotionChanged(k);
    }
  }
  return counts;
}

/** Remove every plate without cells (keeps at least one plate). Returns the removed ids. */
export function removeEmptyPlates(mut: Mutator): number[] {
  const d = mut.state.draft;
  const counts = plateCounts(d.plate, d.plates.length);
  const removed: number[] = [];
  for (let k = d.plates.length - 1; k >= 0; k--) {
    if (counts[k] !== 0 || d.plates.length <= 1) continue;
    removed.push(d.plates[k].id);
    removeEmptyPlate(mut, k);
  }
  return removed.reverse();
}

/** Connected pieces of every plate: total pieces and pieces below MIN_FRAGMENT_CELLS (per plate index). */
export interface PlatePieces {
  pieces: Int32Array;
  /** Detached pieces (not the largest) smaller than MIN_FRAGMENT_CELLS: they merge into neighbours on "Simulate". */
  tiny: Int32Array;
}

export function platePieces(mesh: SphereMesh, plate: Int16Array, numPlates: number): PlatePieces {
  const comps = labelComponents(mesh, plate);
  const pieces = new Int32Array(numPlates);
  const tiny = new Int32Array(numPlates);
  const biggest = new Int32Array(numPlates).fill(-1);
  for (let c = 0; c < comps.size.length; c++) {
    const k = comps.label[c];
    if (k < 0 || k >= numPlates) continue;
    pieces[k]++;
    if (biggest[k] < 0 || comps.size[c] > comps.size[biggest[k]]) biggest[k] = c;
  }
  for (let c = 0; c < comps.size.length; c++) {
    const k = comps.label[c];
    if (k < 0 || k >= numPlates) continue;
    if (c !== biggest[k] && comps.size[c] < MIN_FRAGMENT_CELLS) tiny[k]++;
  }
  return { pieces, tiny };
}

/**
 * Majority filter for plate labels over `cells` (two passes): a cell adopts the plate held by more
 * than half of its neighbours. Straightens jagged boundaries without moving them far.
 */
export function smoothLabels(mut: Mutator, cells: ArrayLike<number>): void {
  const { mesh, state } = mut;
  const { adjOffset, adj } = mesh;
  const plate = state.draft.plate;
  const next = new Int16Array(cells.length);
  const cand = new Int16Array(16), cnt = new Int32Array(16);
  for (let pass = 0; pass < 2; pass++) {
    for (let q = 0; q < cells.length; q++) {
      const i = cells[q];
      let m = 0;
      const deg = adjOffset[i + 1] - adjOffset[i];
      for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
        const p = plate[adj[e]];
        let s = 0;
        while (s < m && cand[s] !== p) s++;
        if (s === m) {
          if (m === cand.length) continue;
          cand[m] = p;
          cnt[m++] = 0;
        }
        cnt[s]++;
      }
      let best = plate[i], bestCnt = 0;
      for (let s = 0; s < m; s++) if (cnt[s] > bestCnt) { bestCnt = cnt[s]; best = cand[s]; }
      next[q] = 2 * bestCnt > deg ? best : plate[i];
    }
    for (let q = 0; q < cells.length; q++) if (next[q] !== plate[cells[q]]) mut.setPlate(cells[q], next[q]);
  }
}

/** All cells lying on a plate boundary (a neighbour on another plate). */
export function boundaryCellsOf(mesh: SphereMesh, plate: Int16Array): number[] {
  const { n, adjOffset, adj } = mesh;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
      if (plate[adj[e]] !== plate[i]) {
        out.push(i);
        break;
      }
    }
  }
  return out;
}

/** Deterministic plate-operation random stream from the draft seed, revision and a salt. */
export function opRng(seed: number, revision: number, salt: number): Rng {
  return new Rng(seed).fork(revision * 131 + salt);
}
