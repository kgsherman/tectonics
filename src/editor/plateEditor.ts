import { DEG, EARTH_RADIUS_KM } from '../core/constants';
import { createSphereMesh } from '../core/sphereMesh';
import type { GenerateParams, SphereMesh, Vec3, WorldDraft, WorldPointerEvent, WorldView } from '../core/types';
import { CRUST_CONTINENTAL } from '../core/types';
import { blankDraft, resampleDraft } from '../tectonics/draft';
import type { DraftSource } from './editState';
import type { OpResult } from './editorCore';
import { EditorCore } from './editorCore';
import { BRUSH_DEFAULT_KM, RAISE_DEFAULT_M } from './editorConstants';
import { EditorRenderer } from './editorRenderer';
import type { FullRenderFn } from './fullRender';
import { WorkerFullRenderer } from './fullRender';
import type { InteractionHost, ToolSettings } from './interaction';
import { PointerInteraction } from './interaction';
import { MotionHandles } from './handles';
import { motionAt, omegaFromMotion } from './motion';
import type { PerfSummary } from './perf';
import { PerfRing } from './perf';
import type { ToolId } from './tools';
import { keyAction, stepBrushKm } from './tools';
import { plateCounts } from './topology';
import { isTypingTarget } from './ui/dom';
import type { PanelActions, PanelState, StartSource } from './ui/panel';
import { EditorPanel } from './ui/panel';
import type { PlateRow } from './ui/plateList';

export interface PlateEditorOptions {
  mesh: SphereMesh;
  /** The editor renders its tool UI (tools, brush settings, plate list) into this element. */
  panel: HTMLElement;
  /** Current view (the app may switch between globe and map while editing; see onViewChanged). */
  getView: () => WorldView;
  /** Called (throttled) whenever the draft changes. */
  onDraftChange?: (draft: WorldDraft) => void;
  /** User pressed "Simulate this world": the app should load the draft into the simulation. */
  onApply: (draft: WorldDraft) => void;
  /**
   * Obtain a starting draft: 'blank' (one ocean plate), 'random' (generator; may run in a worker),
   * or 'current' (the running simulation's state). The editor shows a busy state while pending.
   */
  requestDraft: (source: 'blank' | 'random' | 'current', gen?: Partial<GenerateParams>) => Promise<WorldDraft>;
  /** Display sea level used for preview rendering (m). */
  seaLevel?: number;
  /** Plate cap (default MAX_PLATES). */
  maxPlates?: number;
  /**
   * Full-quality preview renderer used when the user pauses (default: the editor's own module
   * worker running the shared painter). Pass null to keep the fast preview only.
   */
  renderFull?: FullRenderFn | null;
  /** Fast preview raster size (default 1024×512). */
  previewSize?: [number, number];
  /** Full-quality preview size (default 2048×1024). */
  fullSize?: [number, number];
}

/** Colour of the single ocean plate of a blank world. */
const BLANK_PLATE_COLOR: readonly [number, number, number] = [58, 120, 196];

/** onDraftChange throttle, ms. */
const DRAFT_CHANGE_THROTTLE = 300;
/** Plate list refresh interval while painting, ms. */
const LIST_THROTTLE = 150;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Interactive tectonic plate drawing tool (SPEC.md §9). Owns a WorldDraft and edits it with
 * brushes/tools; renders a preview (plates layer + velocity arrows) into the current view while active.
 *
 * Structure: EditorCore (pure model, tools, undo) ← PointerInteraction (view pointer events → core
 * operations) and EditorPanel (DOM side panel); EditorRenderer pushes the incremental preview,
 * the debounced full-quality render, arrows and markers into the view.
 */
export class PlateEditor {
  private readonly opts: PlateEditorOptions;
  private readonly mesh: SphereMesh;
  private readonly core: EditorCore;
  private readonly panel: EditorPanel;
  private readonly interaction: PointerInteraction;
  private readonly renderer: EditorRenderer;
  private readonly settings: ToolSettings = {
    tool: 'plate',
    brushKm: BRUSH_DEFAULT_KM,
    continentMode: 'land',
    raiseMode: 'raise',
    raiseAmount: RAISE_DEFAULT_M,
    lassoTarget: 'new',
    seedRoughness: 0.5,
    style: 'plates',
  };
  private readonly seeds: Vec3[] = [];
  /** Where motion arrows are drawn (user's drag points, visible stand-ins for hidden anchors). */
  private readonly handles = new MotionHandles();
  private seaLevel: number;
  private selectedId: number;
  private active = false;
  private disposed = false;
  private ownRenderer: WorkerFullRenderer | null = null;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDraftNotify = 0;
  private notifiedRevision = -1;
  private listTimer: ReturnType<typeof setTimeout> | null = null;
  private lastListUpdate = 0;
  private listDirty = true;
  private loading = false;
  private applying = false;
  /** Show the "Draw your own world" checklist (blank starts). */
  private guideActive = true;
  private contCache: { revision: number; cells: number; moving: boolean } | null = null;
  private lastPieces: { pieces: Int32Array; tiny: Int32Array } | null = null;
  /** Pointer-event handling cost (strokes, drags, hover), ms. */
  private readonly eventTimes = new PerfRing(240);
  private readonly onKeyDown = (e: KeyboardEvent) => this.handleKey(e);
  private readonly onPointer = (e: WorldPointerEvent) => {
    const t0 = performance.now();
    this.interaction.handle(e);
    if (e.type === 'move' || e.type === 'down') this.eventTimes.push(performance.now() - t0);
  };

  constructor(opts: PlateEditorOptions) {
    this.opts = opts;
    this.mesh = opts.mesh;
    this.seaLevel = opts.seaLevel ?? 0;
    this.core = new EditorCore(this.mesh, blankDraft(this.mesh, 1), { maxPlates: opts.maxPlates, source: 'blank' });
    this.selectedId = this.core.plates[0].id;
    this.panel = new EditorPanel(opts.panel, this.panelActions());
    this.renderer = new EditorRenderer(
      this.mesh,
      {
        core: this.core,
        style: () => this.settings.style,
        seaLevel: () => this.seaLevel,
        tool: () => this.settings.tool,
        selectedIndex: () => this.selectedIndex(),
        seeds: () => this.seeds,
        interacting: () => this.interaction.busy,
        onDraftFrame: () => {
          this.listDirty = true;
          this.refreshListThrottled();
          this.scheduleDraftChange();
        },
        onFullRenderError: (err) => {
          console.error('[plate editor] full-quality preview failed', err);
          this.panel.setStatus(`Full-quality preview unavailable (${errorText(err)}); showing the fast preview.`, 'warn', 8000);
        },
        handles: this.handles,
      },
      { preview: opts.previewSize ?? [1024, 512], full: opts.fullSize ?? [2048, 1024] },
      opts.renderFull ?? null,
    );
    const host: InteractionHost = {
      core: this.core,
      settings: this.settings,
      seeds: this.seeds,
      handles: this.handles,
      view: () => this.renderer.view,
      selectedIndex: () => this.selectedIndex(),
      select: (k) => this.selectIndex(k),
      seedsChanged: () => {
        this.refreshPanel();
        this.renderer.invalidateOverlays();
      },
      highlight: (cells) => this.renderer.setHighlight(cells),
      changed: () => this.renderer.schedule(),
      opDone: (res) => this.opDone(res),
      motionDrag: (k) => this.renderer.setMotionDrag(k),
      setCursor: (c) => this.renderer.setCursor(c),
      hover: (t) => this.panel.setHover(t),
      pointerCursor: (css) => this.renderer.setPointerCursor(css),
      hoverArrow: (k) => this.renderer.setHoverArrow(k),
      hoverSeed: (k) => this.renderer.setHoverSeed(k),
      motionReadout: (r) => {
        this.renderer.setMotionReadout(r);
        if (r) this.panel.setStatus(r.text, 'info', 2500);
      },
    };
    this.interaction = new PointerInteraction(host);
    this.refreshPanel();
  }

  /* ------------------------------------------------------------------ */
  /* Public API (contract)                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Replace the edited draft (clears undo). A draft from a mesh of another resolution is
   * resampled onto the editor's mesh. `source` (optional) says whether its ocean-floor relief is
   * worth keeping when the world is applied.
   */
  setDraft(draft: WorldDraft, source: DraftSource = 'unknown'): void {
    this.interaction.cancel();
    this.core.reset(this.onEditorMesh(draft), source);
    const d = this.core.draft;
    this.guideActive = source === 'blank' || (d.plates.length === 1 && !d.crust.includes(CRUST_CONTINENTAL));
    this.afterLoad();
  }

  /** A copy of the current draft. */
  getDraft(): WorldDraft {
    return this.core.exportDraft();
  }

  /** Start editing: subscribe to view pointer events, switch view to paint mode, render preview. */
  activate(): void {
    if (this.disposed) throw new Error('PlateEditor: activate() after dispose()');
    if (this.active) return;
    this.active = true;
    if (this.opts.renderFull === undefined && !this.ownRenderer && typeof Worker !== 'undefined') {
      try {
        this.ownRenderer = new WorkerFullRenderer();
        this.renderer.setFullRenderer(this.ownRenderer.render);
      } catch (err) {
        // The editor stays usable with the fast preview; say so instead of failing to open.
        console.error('[plate editor] could not start the preview worker', err);
        this.panel.setStatus(`Full-quality preview unavailable (${errorText(err)}); showing the fast preview.`, 'warn', 8000);
      }
    }
    this.renderer.bind(this.opts.getView(), this.onPointer);
    window.addEventListener('keydown', this.onKeyDown, true);
    this.listDirty = true;
    this.refreshPanel();
  }

  /** Stop editing: unsubscribe, restore navigate mode, clear brush cursor/arrows. */
  deactivate(): void {
    if (!this.active) return;
    this.interaction.cancel();
    this.active = false;
    window.removeEventListener('keydown', this.onKeyDown, true);
    if (this.listTimer) clearTimeout(this.listTimer);
    this.listTimer = null;
    this.renderer.unbind(true);
    if (this.draftTimer || this.core.revision !== this.notifiedRevision) this.flushDraftChange();
  }

  get isActive(): boolean {
    return this.active;
  }

  /** The app swapped globe <-> map: re-bind pointer handlers and re-render the preview. */
  onViewChanged(): void {
    if (!this.active) return;
    this.interaction.cancel();
    this.renderer.unbind(false);
    this.renderer.bind(this.opts.getView(), this.onPointer);
  }

  dispose(): void {
    if (this.disposed) return;
    this.deactivate();
    this.disposed = true;
    this.renderer.dispose();
    this.ownRenderer?.dispose();
    this.ownRenderer = null;
    this.panel.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* Optional extras                                                     */
  /* ------------------------------------------------------------------ */

  /** Change the display sea level used by the preview (m). */
  setSeaLevel(seaLevel: number): void {
    if (!Number.isFinite(seaLevel) || seaLevel === this.seaLevel) return;
    this.seaLevel = seaLevel;
    this.renderer.setSeaLevel(seaLevel);
  }

  /** Current tool (for app-level UI). */
  get tool(): ToolId {
    return this.settings.tool;
  }

  /**
   * Interactive cost so far (ms): `frame` = one preview update (recolour changed cells, boundaries,
   * push to the view), `event` = handling one pointer down/move (brush dabs, relief, drags).
   */
  perfStats(): { frame: PerfSummary; event: PerfSummary } {
    return { frame: this.renderer.frameTimes.summary(), event: this.eventTimes.summary() };
  }

  /** Forget the collected timings. */
  resetPerfStats(): void {
    this.renderer.frameTimes.clear();
    this.eventTimes.clear();
  }

  /* ------------------------------------------------------------------ */
  /* Draft change notification                                           */
  /* ------------------------------------------------------------------ */

  private scheduleDraftChange(): void {
    if (!this.opts.onDraftChange || this.draftTimer) return;
    const wait = Math.max(0, DRAFT_CHANGE_THROTTLE - (performance.now() - this.lastDraftNotify));
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      this.flushDraftChange();
    }, wait);
  }

  private flushDraftChange(): void {
    const cb = this.opts.onDraftChange;
    if (!cb) return;
    if (this.draftTimer) {
      clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
    this.lastDraftNotify = performance.now();
    this.notifiedRevision = this.core.revision;
    cb(this.core.exportDraft());
  }

  /* ------------------------------------------------------------------ */
  /* Selection & operations                                              */
  /* ------------------------------------------------------------------ */

  private selectedIndex(): number {
    let k = this.core.indexOfId(this.selectedId);
    if (k < 0 && this.core.plates.length > 0) {
      k = 0;
      this.selectedId = this.core.plates[0].id;
    }
    return k;
  }

  private selectIndex(k: number): void {
    const p = this.core.plates[k];
    if (!p || p.id === this.selectedId) return;
    this.selectedId = p.id;
    this.listDirty = true;
    this.refreshPanel();
    this.interaction.refreshCursor();
    this.renderer.invalidateOverlays();
  }

  /** Common epilogue of every operation: status message, panel, preview. */
  private opDone(res: OpResult): void {
    if (res.ok && res.created.length && this.settings.tool === 'lasso' && this.settings.lassoTarget === 'new') {
      if (this.core.indexOfId(res.created[0]) >= 0) this.selectedId = res.created[0];
    }
    this.panel.setStatus(res.message, res.ok ? 'ok' : 'warn');
    this.listDirty = true;
    this.refreshPanel();
    this.renderer.invalidateOverlays();
  }

  private setTool(id: ToolId): void {
    if (id === this.settings.tool) return;
    this.interaction.cancel();
    this.settings.tool = id;
    this.renderer.setInteractionMode(id);
    this.interaction.refreshCursor();
    this.refreshPanel();
    this.renderer.invalidateOverlays();
  }

  private setBrushKm(km: number): void {
    this.settings.brushKm = km;
    this.interaction.refreshCursor();
    this.refreshPanel();
  }

  /** Undo/redo pressed mid-drag only abandons the drag (it must not also undo the previous step). */
  private cancelInteraction(): boolean {
    if (!this.interaction.busy) return false;
    this.interaction.cancel();
    this.panel.setStatus('Cancelled', 'info', 2500);
    this.listDirty = true;
    this.refreshPanel();
    return true;
  }

  private undo(): void {
    if (this.cancelInteraction()) return;
    const label = this.core.undoLabel;
    if (!label) return;
    this.core.undo();
    this.afterHistory(`Undid ${label}`);
  }

  private redo(): void {
    if (this.cancelInteraction()) return;
    const label = this.core.redoLabel;
    if (!label) return;
    this.core.redo();
    this.afterHistory(`Redid ${label}`);
  }

  private afterHistory(msg: string): void {
    this.selectedIndex();
    this.interaction.refreshHover();
    this.panel.setStatus(msg, 'info', 2500);
    this.listDirty = true;
    this.refreshPanel();
    this.renderer.invalidateOverlays();
  }

  private afterLoad(): void {
    this.handles.clear();
    this.selectedId = this.core.plates[0].id;
    this.lastPieces = null;
    this.interaction.refreshHover();
    this.listDirty = true;
    this.refreshPanel();
    this.renderer.forgetFullRender();
  }

  private onEditorMesh(draft: WorldDraft): WorldDraft {
    if (draft.n === this.mesh.n) return draft;
    return resampleDraft(createSphereMesh(draft.n), this.mesh, draft);
  }

  private async start(src: StartSource): Promise<void> {
    if (this.loading) return;
    this.interaction.cancel();
    this.loading = true;
    const label = src === 'blank' ? 'Blank world' : src === 'random' ? 'Random world' : 'Current simulation';
    this.panel.setBusy(src === 'random' ? 'Generating a random world…' : src === 'current' ? 'Loading the simulation state…' : 'Clearing…');
    try {
      // A fresh seed per click: "Random" should give a new world every time.
      const gen: Partial<GenerateParams> | undefined = src === 'random' ? { seed: (Math.random() * 0x7fffffff) >>> 0 } : undefined;
      const draft = this.onEditorMesh(await this.opts.requestDraft(src, gen));
      if (this.disposed) return;
      // A blank world is one ocean plate: give it a calm ocean blue rather than palette colour #1.
      if (src === 'blank' && draft.plates.length === 1) draft.plates[0] = { ...draft.plates[0], color: [...BLANK_PLATE_COLOR] };
      const res = this.core.load(draft, src, label);
      this.guideActive = src === 'blank';
      this.afterLoad();
      if (src === 'blank') {
        // A blank world is one ocean plate: have the continent brush ready and show relief, so the
        // first strokes read as land and sea (plate boundaries are still drawn).
        this.setTool('continent');
        if (this.settings.style !== 'relief') {
          this.settings.style = 'relief';
          this.renderer.invalidateAll();
        }
        this.panel.setStatus('Blank world: one ocean plate. Paint continents, then cut it into plates. Undo to go back.', 'ok', 8000);
      } else this.panel.setStatus(`${res.message}. Undo to go back.`, 'ok');
    } catch (err) {
      console.error('[plate editor] requestDraft failed', err);
      this.panel.setStatus(`Could not load ${label.toLowerCase()}: ${errorText(err)}`, 'error', 8000);
    } finally {
      this.loading = false;
      this.panel.setBusy(null);
    }
  }

  private apply(): void {
    if (this.applying) return;
    this.interaction.cancel();
    this.applying = true;
    this.panel.setApplyBusy(true);
    // Let the busy state paint before the (synchronous, ~0.1 s at 100k cells) finalize runs.
    setTimeout(() => {
      if (this.disposed) {
        this.applying = false;
        return;
      }
      try {
        const { draft: fin, mergedPieces, droppedEmpty } = this.core.finalizeWithReport(this.core.draft.seed);
        this.opts.onApply(fin);
        const extras: string[] = [];
        if (mergedPieces) extras.push(`${mergedPieces} tiny piece${mergedPieces > 1 ? 's' : ''} merged into neighbours`);
        if (droppedEmpty) extras.push(`${droppedEmpty} empty plate${droppedEmpty > 1 ? 's' : ''} left out`);
        this.panel.setStatus(`Simulating ${fin.plates.length} plate${fin.plates.length > 1 ? 's' : ''}${extras.length ? ` (${extras.join(', ')})` : ''}.`, 'ok', 6000);
      } catch (err) {
        console.error('[plate editor] apply failed', err);
        this.panel.setStatus(`Could not start the simulation: ${errorText(err)}`, 'error', 8000);
      } finally {
        this.applying = false;
        this.panel.setApplyBusy(false);
      }
    }, 20);
  }

  private generateSeeds(): void {
    if (!this.seeds.length) return;
    this.interaction.cancel();
    const res = this.core.applySeeds(this.seeds, this.settings.seedRoughness);
    if (res.ok) {
      this.seeds.length = 0;
      this.selectedId = this.core.plates[0].id;
    }
    this.opDone(res);
  }

  /* ------------------------------------------------------------------ */
  /* Panel                                                               */
  /* ------------------------------------------------------------------ */

  private panelActions(): PanelActions {
    const byId = (id: number, fn: (k: number) => void) => {
      const k = this.core.indexOfId(id);
      if (k >= 0) fn(k);
    };
    const setting = (fn: () => void) => {
      fn();
      this.interaction.refreshCursor();
      this.refreshPanel();
    };
    return {
      tool: (id) => this.setTool(id),
      brushKm: (km) => this.setBrushKm(km),
      continentMode: (m) => setting(() => (this.settings.continentMode = m)),
      raiseMode: (m) => setting(() => (this.settings.raiseMode = m)),
      raiseAmount: (m) => setting(() => (this.settings.raiseAmount = m)),
      lassoTarget: (t) => setting(() => (this.settings.lassoTarget = t)),
      seedRoughness: (v) => setting(() => (this.settings.seedRoughness = v)),
      seedsGenerate: () => this.generateSeeds(),
      seedsClear: () => {
        this.seeds.length = 0;
        this.refreshPanel();
        this.renderer.invalidateOverlays();
      },
      dismissGuide: () => {
        this.guideActive = false;
        this.refreshPanel();
      },
      removeEmpty: () => {
        this.interaction.cancel();
        this.opDone(this.core.removeEmptyPlates());
      },
      smoothAll: () => this.opDone(this.core.smoothAll()),
      randomizeMotions: () => {
        this.interaction.cancel();
        this.opDone(this.core.randomizeMotions());
      },
      addPlate: () => {
        this.interaction.cancel();
        const res = this.core.addPlate();
        if (res.ok && res.created.length) {
          this.selectedId = res.created[0];
          if (this.settings.tool !== 'lasso' && this.settings.tool !== 'fill') this.setTool('plate');
        }
        this.opDone(res);
      },
      undo: () => this.undo(),
      redo: () => this.redo(),
      start: (src) => void this.start(src),
      style: (s) => {
        if (s === this.settings.style) return;
        this.settings.style = s;
        this.refreshPanel();
        this.renderer.invalidateAll();
      },
      apply: () => this.apply(),
      select: (id) => byId(id, (k) => this.selectIndex(k)),
      remove: (id) => byId(id, (k) => this.opDone(this.core.deletePlate(k))),
      rename: (id, name) => byId(id, (k) => this.opDone(this.core.renamePlate(k, name))),
      recolor: (id, color) => byId(id, (k) => this.opDone(this.core.recolorPlate(k, color))),
      setMotion: (id, speedCmYr, bearingDeg, spinDegMyr) =>
        byId(id, (k) => {
          // The list shows the motion where the plate's arrow starts (the user's drag point, else
          // its anchor): edits there round-trip.
          const a = this.handles.preferred(this.core, k);
          if (!a) return;
          this.opDone(this.core.setMotion(k, omegaFromMotion(a, speedCmYr * 10, bearingDeg, spinDegMyr * DEG), a));
        }),
    };
  }

  private refreshPanel(): void {
    this.panel.update(this.panelState());
    if (this.listDirty) this.refreshListThrottled();
  }

  /** Rebuild the plate rows (throttled while a stroke is in progress). */
  private refreshListThrottled(): void {
    const now = performance.now();
    const wait = this.core.busy ? LIST_THROTTLE - (now - this.lastListUpdate) : 0;
    if (wait > 0) {
      this.listTimer ??= setTimeout(() => {
        this.listTimer = null;
        this.refreshListThrottled();
      }, wait);
      return;
    }
    this.lastListUpdate = now;
    this.listDirty = false;
    const core = this.core;
    const d = core.draft;
    // Live counts (cheap) so areas update while painting; motions use the committed anchors.
    const counts = plateCounts(d.plate, d.plates.length);
    // Pieces need a full component labelling: refresh them between edits, not on every dab.
    if (!core.busy || !this.lastPieces || this.lastPieces.pieces.length !== d.plates.length) this.lastPieces = core.pieces();
    const pieces = this.lastPieces;
    const rows: PlateRow[] = d.plates.map((p, k) => {
      const at = counts[k] > 0 ? this.handles.preferred(core, k) : null;
      const m = at ? motionAt(p.omega, at) : null;
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        area: counts[k] / d.n,
        cells: counts[k],
        speed: m ? m.speed : null,
        bearing: m ? m.bearing : 0,
        spin: m ? m.spin : 0,
        pieces: counts[k] > 0 ? pieces.pieces[k] : 0,
        tinyPieces: counts[k] > 0 ? pieces.tiny[k] : 0,
      };
    });
    this.panel.updatePlates(rows, this.selectedId);
    this.panel.update(this.panelState());
  }

  /** Continental cell count and whether every placed plate moves (cached per revision). */
  private worldSummary(): { cells: number; moving: boolean } {
    const core = this.core;
    const c = this.contCache;
    if (c && c.revision === core.revision) return c;
    const d = core.draft;
    let cells = 0;
    for (let i = 0; i < d.n; i++) if (d.crust[i] === CRUST_CONTINENTAL) cells++;
    const counts = core.counts();
    let moving = true;
    for (let k = 0; k < d.plates.length; k++) {
      if (counts[k] === 0) continue;
      const w = d.plates[k].omega;
      if (Math.hypot(w[0], w[1], w[2]) * EARTH_RADIUS_KM < 0.5) moving = false;
    }
    this.contCache = { revision: core.revision, cells, moving };
    return this.contCache;
  }

  /** Usage hint for the current tool, with the live context (selected plate, cap, seeds). */
  private toolHint(): { hint: string; warn: boolean } {
    const core = this.core;
    const sel = this.selectedIndex();
    const name = sel >= 0 ? core.plates[sel].name : 'the selected plate';
    const atCap = core.plates.length >= core.cap;
    const counts = core.counts();
    let empty = 0;
    for (let k = 0; k < counts.length; k++) if (counts[k] === 0) empty++;
    const free = empty > 0 ? `Remove the ${empty} empty plate${empty > 1 ? 's' : ''} or delete one` : 'Delete or merge a plate';
    const s = this.settings;
    switch (s.tool) {
      case 'select':
        return { hint: 'Click a plate to select it. Drag to turn the view.', warn: false };
      case 'plate':
        return { hint: `Paints ${name} — detached islands included. Ctrl+click picks a plate · [ ] size.`, warn: false };
      case 'continent':
        return {
          hint: s.continentMode === 'land'
            ? 'Paint land: shelves, coastal plains and uplands come automatically. Shift paints ocean · X swaps · [ ] size.'
            : 'Paint ocean floor (carve seas and bays). Shift paints land · X swaps · [ ] size.',
          warn: false,
        };
      case 'raise':
        return { hint: `Drag to ${s.raiseMode === 'raise' ? 'raise' : 'lower'} terrain (Shift inverts). Sculpted relief is kept when you simulate.`, warn: false };
      case 'fill':
        return { hint: `Click a region to give it to ${name}.`, warn: false };
      case 'split':
        return atCap
          ? { hint: `Plate limit reached (${core.cap}). ${free} to split again.`, warn: true }
          : { hint: 'Drag a line on a plate: it continues straight to the plate\'s edges, and each side becomes its own plate.', warn: false };
      case 'lasso':
        if (s.lassoTarget === 'new') {
          return atCap
            ? { hint: `Plate limit reached (${core.cap}). Lasso into the selected plate instead, or ${free.toLowerCase()}.`, warn: true }
            : { hint: 'Draw a loop: the region inside becomes a new plate.', warn: false };
        }
        return { hint: `Draw a loop: the region inside joins ${name}.`, warn: false };
      case 'seeds':
        return {
          hint: `Click to place seeds (${this.seeds.length}/${core.cap}), drag to move, Shift+click removes. Enter replaces all plates with regions around them.`,
          warn: false,
        };
      case 'motion':
        return { hint: 'Drag an arrow to change speed and heading, or drag from anywhere on a plate to draw a new arrow. Shift snaps to 15° / 0.5 cm/yr.', warn: false };
      case 'smooth':
        return { hint: 'Brush over jagged plate boundaries to straighten them.', warn: false };
    }
  }

  private panelState(): PanelState {
    const sel = this.selectedIndex();
    const p = sel >= 0 ? this.core.plates[sel] : null;
    const { hint, warn } = this.toolHint();
    const counts = this.core.counts();
    let placed = 0, empty = 0;
    for (let k = 0; k < counts.length; k++) {
      if (counts[k] > 0) placed++;
      else empty++;
    }
    let guide: PanelState['guide'] = null;
    if (this.guideActive) {
      const w = this.worldSummary();
      guide = { continents: w.cells > 0, plates: placed > 1, motions: placed > 0 && w.moving };
    }
    return {
      hint,
      hintWarn: warn,
      emptyPlates: empty,
      guide,
      tool: this.settings.tool,
      brushKm: this.settings.brushKm,
      minBrushKm: this.mesh.spacing * EARTH_RADIUS_KM,
      continentMode: this.settings.continentMode,
      raiseMode: this.settings.raiseMode,
      raiseAmount: this.settings.raiseAmount,
      lassoTarget: this.settings.lassoTarget,
      seedRoughness: this.settings.seedRoughness,
      seedCount: this.seeds.length,
      cap: this.core.cap,
      plateCount: this.core.plates.length,
      selected: p ? { name: p.name, color: p.color } : null,
      style: this.settings.style,
      canUndo: this.core.canUndo,
      canRedo: this.core.canRedo,
      undoLabel: this.core.undoLabel,
      redoLabel: this.core.redoLabel,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Keyboard                                                            */
  /* ------------------------------------------------------------------ */

  private handleKey(e: KeyboardEvent): void {
    if (!this.active || e.defaultPrevented || isTypingTarget(e.target)) return;
    const a = keyAction(e, { tool: this.settings.tool, busy: this.interaction.busy });
    if (!a) return;
    // Enter on a focused button or link activates it (e.g. the seeds "Clear" button), not the shortcut.
    if (a.kind === 'generateSeeds' && e.target instanceof Element && e.target.closest('button, a[href], [role="button"]')) return;
    switch (a.kind) {
      case 'undo':
        this.undo();
        break;
      case 'redo':
        this.redo();
        break;
      case 'brush':
        this.setBrushKm(stepBrushKm(this.settings.brushKm, a.dir));
        break;
      case 'cancel':
        this.interaction.cancel();
        break;
      case 'generateSeeds':
        this.generateSeeds();
        break;
      case 'toggleContinent':
        this.settings.continentMode = this.settings.continentMode === 'land' ? 'ocean' : 'land';
        this.interaction.refreshCursor();
        this.refreshPanel();
        break;
      case 'tool':
        this.setTool(a.tool);
        break;
    }
    // Editor shortcuts win over app shortcuts (e.g. [ ] also step the month in the app).
    e.preventDefault();
    e.stopPropagation();
  }
}
