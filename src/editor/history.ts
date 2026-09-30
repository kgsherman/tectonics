import type { CellArray, EditState, MetaState } from './editState';
import { captureMeta, cellFields, cloneEditState, metaEqual, restoreMeta } from './editState';
import { HISTORY_BYTE_BUDGET, HISTORY_MAX_STEPS, HISTORY_MIN_STEPS } from './editorConstants';

/** One undo step stored as a sparse per-cell diff (only changed cells and changed fields). */
export interface SparseEntry {
  kind: 'sparse';
  label: string;
  cells: Int32Array;
  /** Field positions (see cellFields) that changed, with the values of `cells` before / after. */
  fields: number[];
  before: CellArray[];
  after: CellArray[];
  metaBefore: MetaState;
  metaAfter: MetaState;
  bytes: number;
}

/** One undo step that swaps whole states (loading a draft). */
export interface FullEntry {
  kind: 'full';
  label: string;
  before: EditState;
  after: EditState;
  bytes: number;
}

export type HistoryEntry = SparseEntry | FullEntry;

type CellArrayCtor = new (n: number) => CellArray;

function stateBytes(s: EditState): number {
  let b = 0;
  for (const f of cellFields(s)) b += f.byteLength;
  return b + 256 * s.draft.plates.length;
}

export function fullEntry(label: string, before: EditState, after: EditState): FullEntry {
  return { kind: 'full', label, before: cloneEditState(before), after: cloneEditState(after), bytes: stateBytes(before) + stateBytes(after) };
}

/**
 * Records the "before" values of the cells an operation touches (first touch wins) so the
 * operation can be committed as a sparse diff or reverted. Shadow arrays are reused between
 * operations, so touching a cell is O(fields) with no allocation.
 */
export class ChangeRecorder {
  private readonly n: number;
  private readonly stamp: Int32Array;
  private gen = 0;
  private touched: Int32Array;
  private count = 0;
  private all = false;
  private shadows: CellArray[] = [];
  private fields: CellArray[] = [];
  private metaBefore: MetaState | null = null;
  private label = '';

  constructor(n: number) {
    this.n = n;
    this.stamp = new Int32Array(n);
    this.touched = new Int32Array(Math.min(n, 4096));
  }

  get active(): boolean {
    return this.metaBefore !== null;
  }

  begin(state: EditState, label: string): void {
    if (this.active) throw new Error(`ChangeRecorder: '${label}' started while '${this.label}' is still recording`);
    this.fields = cellFields(state);
    for (let f = 0; f < this.fields.length; f++) {
      const src = this.fields[f];
      const sh = this.shadows[f];
      if (!sh || sh.constructor !== src.constructor || sh.length !== this.n) {
        this.shadows[f] = new (src.constructor as CellArrayCtor)(this.n);
      }
    }
    this.shadows.length = this.fields.length;
    this.metaBefore = captureMeta(state);
    this.label = label;
    this.count = 0;
    this.all = false;
    this.gen++;
    if (this.gen >= 0x7fffffff) {
      this.stamp.fill(0);
      this.gen = 1;
    }
  }

  /** Remember cell i's current values (no-op after the first touch in this operation). */
  touch(i: number): void {
    if (this.all || this.stamp[i] === this.gen) return;
    this.stamp[i] = this.gen;
    if (this.count === this.touched.length) {
      const t = new Int32Array(Math.min(this.n, this.touched.length * 2));
      t.set(this.touched);
      this.touched = t;
    }
    this.touched[this.count++] = i;
    const fl = this.fields, sh = this.shadows;
    for (let f = 0; f < fl.length; f++) sh[f][i] = fl[f][i];
  }

  /** Remember every cell (global operations). */
  touchAll(): void {
    if (this.all) return;
    for (let f = 0; f < this.fields.length; f++) {
      const src = this.fields[f];
      const sh = this.shadows[f];
      // Cells touched earlier already hold their true "before" values in the shadow.
      for (let i = 0; i < this.n; i++) if (this.stamp[i] !== this.gen) sh[i] = src[i];
    }
    this.all = true;
  }

  /** Cells touched so far (valid until the next begin). null = all cells. */
  touchedCells(): { cells: Int32Array; count: number } | null {
    return this.all ? null : { cells: this.touched, count: this.count };
  }

  /** Finish recording. Returns the diff, or null if nothing changed. */
  commit(state: EditState): SparseEntry | null {
    const metaBefore = this.metaBefore;
    if (!metaBefore) throw new Error('ChangeRecorder.commit without begin');
    this.metaBefore = null;
    const fl = this.fields, sh = this.shadows;
    const nf = fl.length;
    const m = this.all ? this.n : this.count;
    const idx = (k: number) => (this.all ? k : this.touched[k]);
    const fieldChanged = new Uint8Array(nf);
    const changed: number[] = [];
    for (let k = 0; k < m; k++) {
      const i = idx(k);
      let any = false;
      for (let f = 0; f < nf; f++) {
        if (sh[f][i] !== fl[f][i]) {
          fieldChanged[f] = 1;
          any = true;
        }
      }
      if (any) changed.push(i);
    }
    const metaAfter = captureMeta(state);
    if (changed.length === 0 && metaEqual(metaBefore, metaAfter)) return null;
    changed.sort((a, b) => a - b);
    const cells = Int32Array.from(changed);
    const fields: number[] = [];
    const before: CellArray[] = [];
    const after: CellArray[] = [];
    let bytes = cells.byteLength + 256 * (metaBefore.plates.length + metaAfter.plates.length);
    for (let f = 0; f < nf; f++) {
      if (!fieldChanged[f]) continue;
      const Ctor = fl[f].constructor as CellArrayCtor;
      const b = new Ctor(cells.length), a = new Ctor(cells.length);
      for (let k = 0; k < cells.length; k++) {
        b[k] = sh[f][cells[k]];
        a[k] = fl[f][cells[k]];
      }
      fields.push(f);
      before.push(b);
      after.push(a);
      bytes += b.byteLength + a.byteLength;
    }
    return { kind: 'sparse', label: this.label, cells, fields, before, after, metaBefore, metaAfter, bytes };
  }

  /** Abandon the operation, restoring every touched cell and the plate list. */
  revert(state: EditState): void {
    const metaBefore = this.metaBefore;
    if (!metaBefore) return;
    this.metaBefore = null;
    const fl = this.fields, sh = this.shadows;
    const m = this.all ? this.n : this.count;
    for (let k = 0; k < m; k++) {
      const i = this.all ? k : this.touched[k];
      for (let f = 0; f < fl.length; f++) fl[f][i] = sh[f][i];
    }
    restoreMeta(state, metaBefore);
  }
}

/**
 * Apply a history entry in one direction. Sparse entries patch `state` in place and return it;
 * full entries return a fresh copy of the stored state (the history keeps its own copies).
 */
export function applyEntry(state: EditState, e: HistoryEntry, dir: 'undo' | 'redo'): EditState {
  if (e.kind === 'full') return cloneEditState(dir === 'undo' ? e.before : e.after);
  const fl = cellFields(state);
  const vals = dir === 'undo' ? e.before : e.after;
  for (let q = 0; q < e.fields.length; q++) {
    const dst = fl[e.fields[q]];
    const src = vals[q];
    for (let k = 0; k < e.cells.length; k++) dst[e.cells[k]] = src[k];
  }
  restoreMeta(state, dir === 'undo' ? e.metaBefore : e.metaAfter);
  return state;
}

/** Linear undo/redo stack with a step cap and a byte budget (never below HISTORY_MIN_STEPS). */
export class History {
  private entries: HistoryEntry[] = [];
  private pos = 0;
  private totalBytes = 0;

  push(e: HistoryEntry): void {
    for (let k = this.pos; k < this.entries.length; k++) this.totalBytes -= this.entries[k].bytes;
    this.entries.length = this.pos;
    this.entries.push(e);
    this.totalBytes += e.bytes;
    this.pos++;
    while (
      this.entries.length > HISTORY_MAX_STEPS ||
      (this.totalBytes > HISTORY_BYTE_BUDGET && this.entries.length > HISTORY_MIN_STEPS)
    ) {
      const old = this.entries.shift();
      if (old) this.totalBytes -= old.bytes;
      this.pos--;
    }
  }

  get canUndo(): boolean {
    return this.pos > 0;
  }

  get canRedo(): boolean {
    return this.pos < this.entries.length;
  }

  get undoLabel(): string | null {
    return this.canUndo ? this.entries[this.pos - 1].label : null;
  }

  get redoLabel(): string | null {
    return this.canRedo ? this.entries[this.pos].label : null;
  }

  /** Entry to undo (moves the cursor back), or null. */
  takeUndo(): HistoryEntry | null {
    if (!this.canUndo) return null;
    return this.entries[--this.pos];
  }

  /** Entry to redo (moves the cursor forward), or null. */
  takeRedo(): HistoryEntry | null {
    if (!this.canRedo) return null;
    return this.entries[this.pos++];
  }

  clear(): void {
    this.entries = [];
    this.pos = 0;
    this.totalBytes = 0;
  }

  get length(): number {
    return this.entries.length;
  }

  get bytes(): number {
    return this.totalBytes;
  }
}
