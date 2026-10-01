/**
 * Pure (DOM-free) plate-editor model (SPEC §9): owns the edited WorldDraft with provenance flags,
 * applies every tool (brushes with slerp stroke interpolation, fill, split, lasso, seeds, plate
 * add/delete, motions), keeps plate topology valid (auto-split / merge), tracks changed cells for
 * the incremental preview and records undo/redo as sparse diffs.
 */
import { EARTH_RADIUS_KM, MAX_PLATES } from '../core/constants';
import { nearestCell } from '../core/sphereMesh';
import type { PlateSpec, RGB, SphereMesh, Vec3, WorldDraft } from '../core/types';
import { cloneDraft, finalizeDraft } from '../tectonics/draft';
import { BoundaryField } from './boundaries';
import type { StrokeTool } from './brushOps';
import { applyDab } from './brushOps';
import type { DraftSource, EditState } from './editState';
import { keepElevationMask, stateFromDraft } from './editState';
import { CONTINENT_EDGE_ROUGHNESS, MIN_FRAGMENT_CELLS, RAISE_DEFAULT_M, ZERO_MOTION_KM_MYR } from './editorConstants';
import { rejoinPlatePieces, simulationLabels } from './finalize';
import { continentHygiene, hygieneLimits } from './coastHygiene';
import { applyEntry, ChangeRecorder, fullEntry, History } from './history';
import type { PlateMotion } from './motion';
import { formatMotion, motionAt, randomMotion } from './motion';
import type { OpResult } from './opResult';
import { ok, refuse } from './opResult';
import { extendCut, pathCells } from './paths';
import type { Mutator, PlatePieces, TidyOptions, TopologyResult } from './plateOps';
import {
  appendPlate, boundaryCellsOf, continentalFractions, opRng, platePieces, removeEmptyPlate, removeEmptyPlates, smoothLabels,
  tidyFragments,
} from './plateOps';
import { lassoCells, regionStats, replaceWithSeedPlates, splitAlongCut } from './regionOps';
import { plateOceanAges, ReliefModel } from './relief';
import type { DabRoughness } from './stroke';
import { StrokeInterpolator } from './stroke';
import { floodRegion, longestBorderNeighbor, plateAnchors, plateCounts } from './topology';

export type { StrokeTool } from './brushOps';
export type { OpResult } from './opResult';

export interface StrokeOptions {
  /** Brush radius, radians (at least one mesh spacing is used). */
  radius: number;
  /** Target plate index (plate brush). */
  plate?: number;
  /** Peak elevation change per dab, m (raise / lower). */
  amount?: number;
}

/** What the preview must repaint since the last drainChanges(). Boundary classes are already updated. */
export interface ChangeSet {
  all: boolean;
  /** Cells to repaint (changed cells and their neighbours); may contain duplicates. */
  cells: number[];
}

export interface EditorCoreOptions {
  /** Plate cap (<= MAX_PLATES; default MAX_PLATES). */
  maxPlates?: number;
  /** Provenance of the initial draft (decides which ocean relief "Simulate" keeps). */
  source?: DraftSource;
}

const STROKE_LABELS: Record<StrokeTool, string> = {
  plate: 'Paint plate',
  continent: 'Paint continent',
  ocean: 'Paint ocean',
  raise: 'Raise terrain',
  lower: 'Lower terrain',
  smooth: 'Smooth boundaries',
};

interface ActiveStroke {
  tool: StrokeTool;
  radius: number;
  plate: number;
  amount: number;
  interp: StrokeInterpolator;
  countsBefore: Int32Array;
  oceanAges: Float64Array | null;
  rough: DabRoughness | null;
  painted: number;
  /** Continent brush: cells turned continental by this stroke. */
  paintMask: Uint8Array | null;
}

/** Throws on drafts the editor cannot hold (wrong sizes, invalid plate indices, too many plates). */
export function validateDraft(mesh: SphereMesh, d: WorldDraft): void {
  const n = mesh.n;
  if (d.n !== n) throw new Error(`EditorCore: draft.n (${d.n}) does not match mesh.n (${n})`);
  for (const [name, a] of [['plate', d.plate], ['crust', d.crust], ['elev', d.elev], ['age', d.age]] as const) {
    if (!a || a.length !== n) throw new Error(`EditorCore: draft.${name} must have ${n} entries`);
  }
  if (d.orogeny && d.orogeny.length !== n) throw new Error(`EditorCore: draft.orogeny must have ${n} entries`);
  if (d.plates.length < 1 || d.plates.length > MAX_PLATES) throw new Error(`EditorCore: draft must have 1..${MAX_PLATES} plates`);
  // Selection, provenance (dirtyPlates) and history all key plates by id; motions feed every tool.
  const ids = new Set<number>();
  for (const p of d.plates) {
    if (ids.has(p.id)) throw new Error(`EditorCore: duplicate plate id ${p.id}`);
    ids.add(p.id);
    if (!(p.omega && p.omega.length === 3 && p.omega.every(Number.isFinite))) throw new Error(`EditorCore: plate ${p.id} has a non-finite omega`);
  }
  for (let i = 0; i < n; i++) {
    const k = d.plate[i];
    if (!(k >= 0 && k < d.plates.length)) throw new Error(`EditorCore: cell ${i} has invalid plate index ${k}`);
  }
}

export class EditorCore {
  readonly mesh: SphereMesh;
  readonly cap: number;
  private st: EditState;
  private readonly recorder: ChangeRecorder;
  private readonly history = new History();
  private relief: ReliefModel;
  private reliefSeed: number;
  private readonly bounds: BoundaryField;
  private rev: number;

  // Change tracking for the preview.
  private readonly dirtyStamp: Int32Array;
  private dirtyGen = 1;
  private dirtyList: number[] = [];
  private allDirty = true;
  /** Count of cell writes (markCell calls): tells whether a stroke step changed anything. */
  private cellWrites = 0;
  private readonly motionDirty = new Set<number>();

  // Caches (invalidated when plate membership changes).
  private anchorCache: Array<Vec3 | null> | null = null;
  private countCache: Int32Array | null = null;
  private piecesCache: { revision: number; value: PlatePieces } | null = null;

  private stroke: ActiveStroke | null = null;
  private motionEdit: number | null = null;
  private readonly plateDirtyIdx = new Uint8Array(MAX_PLATES);
  private readonly mut: Mutator;
  private readonly dabBuf: number[] = [];
  private readonly dabCenters: Vec3[] = [];

  constructor(mesh: SphereMesh, draft: WorldDraft, opts: EditorCoreOptions = {}) {
    validateDraft(mesh, draft);
    this.mesh = mesh;
    const maxPlates = opts.maxPlates ?? MAX_PLATES;
    if (typeof maxPlates !== 'number' || Number.isNaN(maxPlates)) throw new Error(`EditorCore: bad maxPlates ${opts.maxPlates}`);
    this.cap = Math.max(1, Math.min(MAX_PLATES, Math.floor(maxPlates)));
    this.st = stateFromDraft(draft, opts.source ?? 'unknown');
    this.rev = this.st.draft.revision ?? 0;
    this.recorder = new ChangeRecorder(mesh.n);
    this.reliefSeed = this.st.draft.seed;
    this.relief = new ReliefModel(mesh, this.reliefSeed);
    this.bounds = new BoundaryField(mesh);
    this.dirtyStamp = new Int32Array(mesh.n);
    this.bounds.reclassifyAll(this.st.draft.plate, this.st.draft.plates);
    const self = this;
    this.mut = {
      mesh,
      get state() {
        return self.st;
      },
      cap: this.cap,
      setPlate: (i, k) => this.setPlate(i, k),
      touch: (i) => this.recorder.touch(i),
      markCell: (i) => this.markCell(i),
      touchAll: () => {
        this.recorder.touchAll();
        this.markAll();
      },
      markPlateDirty: (k) => {
        this.plateDirtyIdx[k] = 1;
      },
      markMotionChanged: (k) => {
        this.motionDirty.add(k);
      },
      flushPlateDirty: () => this.flushPlateDirty(),
      rng: (salt) => opRng(this.st.draft.seed, this.rev, salt),
    };
  }

  /* ------------------------------------------------------------------ */
  /* State access                                                        */
  /* ------------------------------------------------------------------ */

  /** The live draft (do not mutate; use exportDraft() for a copy). */
  get draft(): WorldDraft {
    return this.st.draft;
  }

  get state(): EditState {
    return this.st;
  }

  get plates(): PlateSpec[] {
    return this.st.draft.plates;
  }

  /** Monotonic change counter (also written to draft.revision). */
  get revision(): number {
    return this.rev;
  }

  /** Current boundary class per cell (BOUNDARY_*), kept up to date by drainChanges(). */
  get boundary(): Uint8Array {
    return this.bounds.cls;
  }

  get busy(): boolean {
    return this.stroke !== null || this.motionEdit !== null;
  }

  get strokeTool(): StrokeTool | null {
    return this.stroke?.tool ?? null;
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  get undoLabel(): string | null {
    return this.history.undoLabel;
  }

  get redoLabel(): string | null {
    return this.history.redoLabel;
  }

  get historyLength(): number {
    return this.history.length;
  }

  /** Cells per plate index. */
  counts(): Int32Array {
    if (!this.countCache) this.countCache = plateCounts(this.st.draft.plate, this.st.draft.plates.length);
    return this.countCache;
  }

  /** Interior point per plate index (motion handle), null for plates without cells. */
  anchors(): Array<Vec3 | null> {
    if (!this.anchorCache) this.anchorCache = plateAnchors(this.mesh, this.st.draft.plate, this.st.draft.plates.length);
    return this.anchorCache;
  }

  /**
   * Connected pieces per plate index (cached per revision). Plates may be in several pieces while
   * editing; "Simulate" keeps them as one plate and merges only tiny detached pieces.
   */
  pieces(): PlatePieces {
    const c = this.piecesCache;
    if (c && c.revision === this.rev && c.value.pieces.length === this.st.draft.plates.length) return c.value;
    const value = platePieces(this.mesh, this.st.draft.plate, this.st.draft.plates.length);
    this.piecesCache = { revision: this.rev, value };
    return value;
  }

  /** Motion of plate k at its anchor, or null if it has no cells. */
  plateMotion(k: number): PlateMotion | null {
    const a = this.anchors()[k];
    return a ? motionAt(this.st.draft.plates[k].omega, a) : null;
  }

  indexOfId(id: number): number {
    return this.st.draft.plates.findIndex((p) => p.id === id);
  }

  cellAt(p: Vec3, hint?: number): number {
    return nearestCell(this.mesh, p[0], p[1], p[2], hint);
  }

  plateAt(p: Vec3): number {
    return this.st.draft.plate[this.cellAt(p)];
  }

  /** Deep copy of the draft (revision included). */
  exportDraft(): WorldDraft {
    return cloneDraft(this.st.draft);
  }

  /** Elevation provenance mask for finalizeDraft (see editState.keepElevationMask). */
  keepElevationMask(): Uint8Array {
    return keepElevationMask(this.st);
  }

  /**
   * "Simulate this world": finalizeDraft on a copy with the keep-elevation mask, keeping the user's
   * plates as drawn — a plate in several pieces stays ONE plate (same id, name, colour and motion);
   * only detached pieces smaller than MIN_FRAGMENT_CELLS merge into their neighbours. Empty plates
   * are dropped.
   */
  finalize(seed: number): WorldDraft {
    return this.finalizeWithReport(seed).draft;
  }

  /** finalize() plus what it tidied (for the status line). */
  finalizeWithReport(seed: number): { draft: WorldDraft; mergedPieces: number; droppedEmpty: number } {
    const src = cloneDraft(this.st.draft);
    // Motionless plates get their default motion here (as the editor would give them) so that all
    // pieces of a plate share it (finalizeDraft would draw a separate motion for every piece).
    const anchors = this.anchors();
    const counts = this.counts();
    const cf = continentalFractions(this.st);
    src.plates.forEach((p, k) => {
      const a = anchors[k];
      if (!a || counts[k] === 0 || Math.hypot(p.omega[0], p.omega[1], p.omega[2]) * EARTH_RADIUS_KM >= ZERO_MOTION_KM_MYR) return;
      p.omega = randomMotion(opRng(seed, 0, p.id), a, cf[k]);
    });
    const droppedEmpty = counts.reduce((acc, v) => acc + (v === 0 ? 1 : 0), 0);
    // Tiny detached pieces merge here (not in finalizeDraft, which would also flood whole pieces
    // into their surroundings once splitting them reaches MAX_PLATES); every other piece is given
    // back its drawn plate after finalizeDraft.
    const labels = simulationLabels(this.mesh, src.plate, src.plates.length);
    src.plate = labels.plate;
    const fin = finalizeDraft(this.mesh, src, seed, keepElevationMask(this.st));
    return { draft: rejoinPlatePieces(src, fin, labels.loose), mergedPieces: labels.merged, droppedEmpty };
  }

  /* ------------------------------------------------------------------ */
  /* Loading & history                                                   */
  /* ------------------------------------------------------------------ */

  /** Replace the draft and clear the undo history (new session / mesh change). */
  reset(draft: WorldDraft, source: DraftSource = 'unknown'): void {
    validateDraft(this.mesh, draft);
    this.cancel();
    this.history.clear();
    this.replaceState(stateFromDraft(draft, source));
  }

  /** Load a draft as an undoable step (Start: Blank / Random / From current). */
  load(draft: WorldDraft, source: DraftSource, label = 'Load world'): OpResult {
    validateDraft(this.mesh, draft);
    this.cancel();
    const next = stateFromDraft(draft, source);
    this.history.push(fullEntry(label, this.st, next));
    this.replaceState(next);
    return ok(`${label}: ${draft.plates.length} plate${draft.plates.length > 1 ? 's' : ''}`);
  }

  undo(): boolean {
    if (this.busy) {
      this.cancel();
      return true;
    }
    const e = this.history.takeUndo();
    if (!e) return false;
    this.afterHistoryMove(applyEntry(this.st, e, 'undo'));
    return true;
  }

  redo(): boolean {
    if (this.busy) return false;
    const e = this.history.takeRedo();
    if (!e) return false;
    this.afterHistoryMove(applyEntry(this.st, e, 'redo'));
    return true;
  }

  private afterHistoryMove(next: EditState): void {
    if (next !== this.st) this.replaceState(next);
    else {
      this.invalidate();
      this.markAll();
      this.bumpRevision();
    }
  }

  private replaceState(next: EditState): void {
    this.st = next;
    if (next.draft.seed !== this.reliefSeed) {
      this.reliefSeed = next.draft.seed;
      this.relief = new ReliefModel(this.mesh, this.reliefSeed);
    }
    this.invalidate();
    this.markAll();
    this.bumpRevision();
  }

  private bumpRevision(): void {
    this.rev = Math.max(this.rev, this.st.draft.revision ?? 0) + 1;
    this.st.draft.revision = this.rev;
  }

  private invalidate(): void {
    this.anchorCache = null;
    this.countCache = null;
  }

  /* ------------------------------------------------------------------ */
  /* Change tracking                                                     */
  /* ------------------------------------------------------------------ */

  private markCell(i: number): void {
    this.cellWrites++;
    if (this.allDirty || this.dirtyStamp[i] === this.dirtyGen) return;
    this.dirtyStamp[i] = this.dirtyGen;
    this.dirtyList.push(i);
  }

  private markAll(): void {
    this.allDirty = true;
  }

  /**
   * Hand the accumulated changes to the preview: reclassifies plate boundaries around changed
   * cells (or everywhere) and returns what to repaint.
   */
  drainChanges(): ChangeSet {
    const d = this.st.draft;
    let out: ChangeSet;
    if (this.allDirty) {
      this.bounds.reclassifyAll(d.plate, d.plates);
      out = { all: true, cells: [] };
    } else {
      const cells: number[] = [];
      if (this.dirtyList.length) this.bounds.reclassifyAround(d.plate, d.plates, this.dirtyList, this.dirtyList.length, cells);
      for (const k of this.motionDirty) if (k < d.plates.length) this.bounds.reclassifyPlate(d.plate, d.plates, k, cells);
      out = { all: false, cells };
    }
    this.allDirty = false;
    this.dirtyList = [];
    this.motionDirty.clear();
    this.dirtyGen++;
    if (this.dirtyGen >= 0x7fffffff) {
      this.dirtyStamp.fill(0);
      this.dirtyGen = 1;
    }
    return out;
  }

  /** True if something changed since the last drainChanges(). */
  get hasChanges(): boolean {
    return this.allDirty || this.dirtyList.length > 0 || this.motionDirty.size > 0;
  }

  /* ------------------------------------------------------------------ */
  /* Low-level mutation                                                  */
  /* ------------------------------------------------------------------ */

  private setPlate(i: number, k: number): void {
    const d = this.st.draft;
    const old = d.plate[i];
    if (old === k) return;
    this.recorder.touch(i);
    d.plate[i] = k;
    this.plateDirtyIdx[old] = 1;
    this.plateDirtyIdx[k] = 1;
    this.markCell(i);
  }

  private flushPlateDirty(): void {
    const plates = this.st.draft.plates;
    for (let k = 0; k < MAX_PLATES; k++) {
      if (!this.plateDirtyIdx[k]) continue;
      this.plateDirtyIdx[k] = 0;
      if (k < plates.length) this.st.dirtyPlates.add(plates[k].id);
    }
  }

  /** Run a one-shot operation as one undo step. A refused result reverts any partial change. */
  private run(label: string, body: () => OpResult): OpResult {
    if (this.busy) return refuse('Finish the current stroke first');
    this.recorder.begin(this.st, label);
    let res: OpResult;
    try {
      res = body();
    } catch (err) {
      this.abortRecording();
      throw err;
    }
    if (!res.ok) {
      this.abortRecording();
      return res;
    }
    this.commit();
    return res;
  }

  /** Revert the recording in progress and repaint what it had touched. */
  private abortRecording(): void {
    const t = this.recorder.touchedCells();
    const cells = t ? Array.from(t.cells.subarray(0, t.count)) : null;
    const plateCount = this.plates.length;
    this.recorder.revert(this.st);
    this.plateDirtyIdx.fill(0);
    this.invalidate();
    if (!cells || this.plates.length !== plateCount) this.markAll();
    else for (const i of cells) this.markCell(i);
  }

  private commit(): void {
    this.flushPlateDirty();
    const entry = this.recorder.commit(this.st);
    this.invalidate();
    if (entry) {
      this.history.push(entry);
      this.bumpRevision();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Brush strokes                                                       */
  /* ------------------------------------------------------------------ */

  beginStroke(tool: StrokeTool, opts: StrokeOptions): void {
    if (this.busy) throw new Error('EditorCore.beginStroke: another edit is in progress');
    const d = this.st.draft;
    const radius = Math.max(opts.radius, this.mesh.spacing);
    if (!(radius > 0) || !Number.isFinite(radius)) throw new Error(`EditorCore.beginStroke: bad radius ${opts.radius}`);
    const plate = opts.plate ?? 0;
    if (tool === 'plate' && !(plate >= 0 && plate < d.plates.length)) throw new Error(`EditorCore.beginStroke: bad plate index ${plate}`);
    const amount = Math.abs(opts.amount ?? RAISE_DEFAULT_M);
    if (!Number.isFinite(amount)) throw new Error(`EditorCore.beginStroke: bad amount ${opts.amount}`);
    const additive = tool === 'raise' || tool === 'lower';
    const rough: DabRoughness | null =
      tool === 'continent' || tool === 'ocean'
        ? { noise: this.relief.noiseFn, amp: CONTINENT_EDGE_ROUGHNESS, freq: Math.max(3, Math.min(60, 3 / radius)) }
        : null;
    this.recorder.begin(this.st, STROKE_LABELS[tool]);
    this.stroke = {
      tool,
      radius,
      plate,
      amount,
      interp: new StrokeInterpolator(radius / 2, additive ? 'uniform' : 'cover'),
      countsBefore: this.counts().slice(),
      oceanAges: tool === 'ocean' ? plateOceanAges(this.st) : null,
      rough,
      painted: 0,
      paintMask: tool === 'continent' ? new Uint8Array(this.mesh.n) : null,
    };
  }

  /** Move the brush to p (null = pointer left the planet: breaks the stroke). */
  strokeTo(p: Vec3 | null): void {
    const s = this.stroke;
    if (!s) throw new Error('EditorCore.strokeTo without beginStroke');
    const centers = this.dabCenters;
    centers.length = 0;
    s.interp.moveTo(p, centers);
    if (centers.length === 0) return;
    const writes = this.cellWrites;
    for (const c of centers) s.painted += applyDab(this.mut, s, c, this.dabBuf);
    if (s.tool === 'continent' || s.tool === 'ocean') this.updateReliefAround(centers, s.radius * (1 + CONTINENT_EDGE_ROUGHNESS));
    // The draft changed mid-edit: keep draft.revision a valid cache key for exports taken now.
    if (this.cellWrites !== writes) this.bumpRevision();
  }

  /** Recompute brush-painted coastal relief over the cap covering this batch of dabs. */
  private updateReliefAround(centers: Vec3[], reach: number): void {
    let sx = 0, sy = 0, sz = 0;
    for (const c of centers) {
      sx += c[0];
      sy += c[1];
      sz += c[2];
    }
    const l = Math.hypot(sx, sy, sz);
    const center: Vec3 = l > 1e-9 ? [sx / l, sy / l, sz / l] : centers[0];
    let spread = 0;
    for (const c of centers) {
      const dot = c[0] * center[0] + c[1] * center[1] + c[2] * center[2];
      spread = Math.max(spread, Math.acos(Math.max(-1, Math.min(1, dot))));
    }
    const changed: number[] = [];
    this.relief.updateCoastalRelief(this.st, center, spread + reach, (i) => this.recorder.touch(i), changed);
    for (const i of changed) this.markCell(i);
  }

  /** Finish the stroke: fix plate topology and record one undo step. */
  endStroke(): OpResult {
    const s = this.stroke;
    if (!s) throw new Error('EditorCore.endStroke without beginStroke');
    let topo: TopologyResult | undefined;
    if (s.tool === 'plate' || s.tool === 'smooth') {
      this.invalidate();
      try {
        topo = this.tidy(s.countsBefore, { keep: s.tool === 'plate' ? s.plate : undefined });
      } catch (err) {
        // Never leave the editor stuck mid-stroke (every later edit would be refused).
        this.cancel();
        throw err;
      }
    }
    if (s.tool === 'continent' && s.paintMask && s.painted > 0) {
      const t = this.recorder.touchedCells();
      const near = t ? Array.from(t.cells.subarray(0, t.count)) : [];
      const h = continentHygiene(this.mut, near, s.paintMask, plateOceanAges(this.st), hygieneLimits(s.radius, this.mesh.spacing));
      if (h.cells.length) {
        const xyz = this.mesh.xyz;
        this.updateReliefAround(h.cells.map((i): Vec3 => [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]]), this.mesh.spacing);
      }
    }
    this.stroke = null;
    this.commit();
    const what = STROKE_LABELS[s.tool];
    const res = ok(s.painted > 0 || s.tool === 'smooth' ? what : `${what}: nothing changed`, topo);
    return this.withEmptied(res, topo);
  }

  /** tidyFragments around the cells the current recording touched. */
  private tidy(countsBefore: Int32Array, opts: TidyOptions = {}): TopologyResult {
    const t = this.recorder.touchedCells();
    return tidyFragments(this.mut, countsBefore, { ...opts, near: t ? t.cells.subarray(0, t.count) : null });
  }

  /** Mention plates an edit left empty (they stay in the list until deleted or painted back). */
  private withEmptied(res: OpResult, topo?: TopologyResult): OpResult {
    const ids = topo?.emptied ?? [];
    if (!res.ok || ids.length === 0) return res;
    const names = ids.map((id) => this.plates.find((p) => p.id === id)?.name).filter((x): x is string => !!x);
    if (!names.length) return res;
    const one = names.length === 1;
    const who = one ? names[0] : `${names.length} plates`;
    return { ...res, message: `${res.message} · ${who} ${one ? 'is' : 'are'} now empty (paint ${one ? 'it' : 'them'} back or delete)` };
  }

  /** Abandon the current stroke or motion drag, restoring the state before it. */
  cancel(): void {
    if (!this.stroke && this.motionEdit === null) return;
    const k = this.motionEdit;
    this.stroke = null;
    this.motionEdit = null;
    this.abortRecording();
    if (k !== null) this.motionDirty.add(k);
    this.bumpRevision();
  }

  /* ------------------------------------------------------------------ */
  /* Motion                                                              */
  /* ------------------------------------------------------------------ */

  /** Start a live motion edit of plate k (arrow drag); updateMotion() while dragging, endMotion() on release. */
  beginMotion(k: number): void {
    if (this.busy) throw new Error('EditorCore.beginMotion: another edit is in progress');
    if (!(k >= 0 && k < this.plates.length)) throw new Error(`EditorCore.beginMotion: bad plate index ${k}`);
    this.recorder.begin(this.st, 'Set motion');
    this.motionEdit = k;
  }

  updateMotion(omega: Vec3): void {
    const k = this.motionEdit;
    if (k === null) throw new Error('EditorCore.updateMotion without beginMotion');
    if (!omega.every(Number.isFinite)) throw new Error('EditorCore.updateMotion: non-finite omega');
    this.plates[k].omega = [omega[0], omega[1], omega[2]];
    this.motionDirty.add(k);
    this.bumpRevision();
  }

  /** Finish the motion drag; the message reports the motion at `at` (the arrow's tail; default the anchor). */
  endMotion(at?: Vec3): OpResult {
    const k = this.motionEdit;
    if (k === null) throw new Error('EditorCore.endMotion without beginMotion');
    this.motionEdit = null;
    this.plateDirtyIdx[k] = 1;
    this.commit();
    const m = at ? motionAt(this.plates[k].omega, at) : this.plateMotion(k);
    return ok(m ? `${this.plates[k].name}: ${formatMotion(m.speed, m.bearing)}` : 'Motion set');
  }

  /** Set a plate's angular velocity (numeric edit) as one undo step; the message reports the motion at `at` (default the anchor). */
  setMotion(k: number, omega: Vec3, at?: Vec3): OpResult {
    return this.run('Set motion', () => {
      if (!(k >= 0 && k < this.plates.length)) return refuse('No such plate');
      if (!omega.every(Number.isFinite)) return refuse('Invalid motion');
      this.plates[k].omega = [omega[0], omega[1], omega[2]];
      this.plateDirtyIdx[k] = 1;
      this.motionDirty.add(k);
      const a = at ?? this.anchors()[k];
      const m = a ? motionAt(this.plates[k].omega, a) : null;
      return ok(m ? `${this.plates[k].name}: ${formatMotion(m.speed, m.bearing)}` : 'Motion set');
    });
  }

  randomizeMotions(): OpResult {
    return this.run('Randomize motions', () => {
      const anchors = this.anchors();
      const cf = continentalFractions(this.st);
      this.plates.forEach((p, k) => {
        const a = anchors[k];
        if (!a) return;
        p.omega = randomMotion(this.mut.rng(p.id), a, cf[k]);
        this.plateDirtyIdx[k] = 1;
      });
      this.markAll();
      return ok('Randomized all plate motions');
    });
  }

  /* ------------------------------------------------------------------ */
  /* Plate list                                                          */
  /* ------------------------------------------------------------------ */

  addPlate(): OpResult {
    return this.run('Add plate', () => {
      if (this.plates.length >= this.cap) return refuse(`Plate limit reached (${this.cap})`);
      const k = appendPlate(this.st, null);
      const p = this.plates[k];
      return ok(`Added ${p.name} — paint it onto the globe`, undefined, [p.id]);
    });
  }

  /** Delete plate k; its cells join the neighbour with the longest shared boundary. */
  deletePlate(k: number): OpResult {
    return this.run('Delete plate', () => {
      const d = this.st.draft;
      if (!(k >= 0 && k < d.plates.length)) return refuse('No such plate');
      if (d.plates.length <= 1) return refuse('A world needs at least one plate');
      const name = d.plates[k].name;
      const id = d.plates[k].id;
      // Each connected piece joins its own longest-border neighbour (plates loaded from a simulation
      // may be in several pieces; sending them all to one neighbour would leave it disconnected).
      const targets: number[] = [];
      for (let s = 0; s < d.n; s++) {
        if (d.plate[s] !== k) continue;
        const piece = floodRegion(this.mesh, d.plate, s);
        const t = longestBorderNeighbor(this.mesh, d.plate, piece, k, d.plates.length);
        if (t < 0) return refuse(`${name} has no neighbour to merge into`);
        if (!targets.includes(t)) targets.push(t);
        for (const i of piece) this.setPlate(i, t);
      }
      const into = targets.length === 0 ? '' : targets.length === 1 ? ` (merged into ${d.plates[targets[0]].name})` : ` (merged into ${targets.length} neighbours)`;
      removeEmptyPlate(this.mut, k);
      this.markAll();
      return { ok: true, message: `Deleted ${name}${into}`, created: [], removed: [id] };
    });
  }

  renamePlate(k: number, name: string): OpResult {
    const clean = name.trim().slice(0, 48);
    return this.run('Rename plate', () => {
      if (!(k >= 0 && k < this.plates.length)) return refuse('No such plate');
      if (!clean) return refuse('Plate names cannot be empty');
      if (clean === this.plates[k].name) return refuse('Name unchanged');
      this.plates[k].name = clean;
      return ok(`Renamed to ${clean}`);
    });
  }

  recolorPlate(k: number, color: RGB): OpResult {
    return this.run('Recolor plate', () => {
      if (!(k >= 0 && k < this.plates.length)) return refuse('No such plate');
      const c: RGB = [color[0], color[1], color[2]].map((v) => Math.max(0, Math.min(255, Math.round(v)))) as RGB;
      this.plates[k].color = c;
      this.markAll();
      return ok('Color changed');
    });
  }

  /* ------------------------------------------------------------------ */
  /* Region tools                                                        */
  /* ------------------------------------------------------------------ */

  /** Flood-fill the connected region of the plate under p with plate `target`. */
  fill(p: Vec3, target: number): OpResult {
    return this.run('Fill', () => {
      const d = this.st.draft;
      if (!(target >= 0 && target < d.plates.length)) return refuse('No such plate');
      const start = this.cellAt(p);
      if (d.plate[start] === target) return refuse(`That region already belongs to ${d.plates[target].name}`);
      const before = this.counts().slice();
      const region = floodRegion(this.mesh, d.plate, start);
      for (const i of region) this.setPlate(i, target);
      const topo = this.tidy(before, { keep: target });
      return this.withEmptied(ok(`Filled ${region.length.toLocaleString('en-US')} cells with ${d.plates[target].name}`, topo), topo);
    });
  }

  /**
   * Split every plate the cut crosses from edge to edge. The largest side keeps the plate; each
   * other side of at least MIN_FRAGMENT_CELLS becomes a new plate with the same motion. Cut cells
   * join the side most of their neighbours are on. Unless `extend` is false, ends of the line inside
   * the plate being cut continue straight (great circle) to its edge — see extendCut — so a short
   * line splits a plate and a line on a whole-sphere plate cuts it into two.
   */
  split(path: ReadonlyArray<Vec3 | null>, opts: { extend?: boolean } = {}): OpResult {
    return this.run('Split plate', () => {
      const line = opts.extend === false ? path : extendCut(this.mesh, this.st.draft.plate, path);
      const cut = pathCells(this.mesh, line, false);
      if (cut.length < 2) return refuse('Drag a line across a plate to split it');
      const before = this.counts().slice();
      const { created, capped } = splitAlongCut(this.mut, cut);
      if (created.length === 0) {
        return refuse(capped ? `Plate limit reached (${this.cap})` : 'The cut must cross a plate from edge to edge');
      }
      // The plates actually cut (each lost a whole piece, >= MIN_FRAGMENT_CELLS, to a new plate), not
      // the neighbours the line's ends brush against: only those and the new pieces may receive a
      // default motion.
      const d = this.st.draft;
      const after = plateCounts(d.plate, d.plates.length);
      const cutIds = new Set<number>(created);
      for (let k = 0; k < before.length; k++) if (before[k] - after[k] >= MIN_FRAGMENT_CELLS) cutIds.add(d.plates[k].id);
      const topo = this.tidy(before);
      this.giveMotionlessPlatesMotion(cutIds);
      const msg = `Split into ${created.length + 1} plates` + (capped ? ` (plate limit ${this.cap} reached)` : '');
      return ok(msg, topo, created);
    });
  }

  /**
   * Plates of `ids` that have no motion (the pieces of a split motionless plate, e.g. the single
   * plate of a blank world) get distinct default motions, so the new boundaries show real
   * convergence / divergence at once.
   */
  private giveMotionlessPlatesMotion(ids: ReadonlySet<number>): void {
    const d = this.st.draft;
    this.invalidate();
    const anchors = this.anchors();
    const cf = continentalFractions(this.st);
    let any = false;
    d.plates.forEach((p, k) => {
      const a = anchors[k];
      if (!ids.has(p.id) || !a || p.omega[0] !== 0 || p.omega[1] !== 0 || p.omega[2] !== 0) return;
      p.omega = randomMotion(this.mut.rng(p.id + 7919), a, cf[k]);
      this.plateDirtyIdx[k] = 1;
      any = true;
    });
    if (any) this.markAll();
  }

  /**
   * Assign the cells inside a closed lasso (and under its outline) to a new plate (random default
   * motion) or to plate index `target`.
   */
  lasso(poly: ReadonlyArray<Vec3>, target: number | 'new'): OpResult {
    return this.run('Lasso', () => {
      const d = this.st.draft;
      if (poly.length < 3) return refuse('Draw a closed loop to lasso a region');
      const cells = lassoCells(this.mesh, poly);
      if (cells.length === 0) return refuse('Lasso too small');
      const before = this.counts().slice();
      let k: number;
      if (target === 'new') {
        if (d.plates.length >= this.cap) return refuse(`Plate limit reached (${this.cap})`);
        const { centroid, continental } = regionStats(this.mesh, d.crust, cells);
        k = appendPlate(this.st, null, randomMotion(this.mut.rng(d.nextPlateId), centroid, continental));
      } else {
        if (!(target >= 0 && target < d.plates.length)) return refuse('No such plate');
        k = target;
      }
      const { name, id } = d.plates[k];
      let moved = 0;
      for (const i of cells) {
        if (d.plate[i] === k) continue;
        this.setPlate(i, k);
        moved++;
      }
      if (moved === 0) return refuse(`That region already belongs to ${name}`);
      const topo = this.tidy(before, { keep: k });
      const res = target === 'new' ? ok(`Created ${name}`, topo, [id]) : ok(`Added ${moved.toLocaleString('en-US')} cells to ${name}`, topo);
      return this.withEmptied(res, topo);
    });
  }

  /** Replace all plates by noise-warped Voronoi regions around `seeds` (new ids, default motions). */
  applySeeds(seeds: ReadonlyArray<Vec3>, roughness: number): OpResult {
    return this.run('Plates from seeds', () => {
      if (seeds.length < 1) return refuse('Place at least one seed');
      if (seeds.length > this.cap) return refuse(`At most ${this.cap} seeds`);
      const noiseSeed = (this.st.draft.seed * 977 + this.rev * 31 + 7) >>> 0;
      replaceWithSeedPlates(this.mut, seeds, roughness, noiseSeed);
      this.invalidate();
      // Seeds swallowed by their neighbours' regions leave empty plates: remove them (this tool
      // regenerates the whole plate list anyway), then tidy stray slivers of the warped regions.
      removeEmptyPlates(this.mut);
      const topo = tidyFragments(this.mut, new Int32Array(this.plates.length).fill(1));
      return ok(`Generated ${this.plates.length} plates from seeds`, topo);
    });
  }

  /** Majority-smooth every plate boundary (two passes). */
  smoothAll(): OpResult {
    return this.run('Smooth boundaries', () => {
      const before = this.counts().slice();
      const cells = boundaryCellsOf(this.mesh, this.st.draft.plate);
      smoothLabels(this.mut, cells);
      const topo = this.tidy(before);
      return this.withEmptied(ok('Smoothed all plate boundaries', topo), topo);
    });
  }

  /** Delete every plate that has no cells (explicit clean-up; strokes never remove plates). */
  removeEmptyPlates(): OpResult {
    return this.run('Remove empty plates', () => {
      const counts = this.counts();
      const empty = counts.reduce((acc, v) => acc + (v === 0 ? 1 : 0), 0);
      if (empty === 0) return refuse('No empty plates');
      const removed = removeEmptyPlates(this.mut);
      this.markAll();
      return { ok: true, message: `Removed ${removed.length} empty plate${removed.length > 1 ? 's' : ''}`, created: [], removed };
    });
  }
}
