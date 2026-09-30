import { DEG, EARTH_RADIUS_KM } from '../core/constants';
import { createSphereMesh } from '../core/sphereMesh';
import type { GenerateParams, SphereMesh, Vec3, WorldDraft, WorldView } from '../core/types';
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
import { omegaFromMotion } from './motion';
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
  private readonly onKeyDown = (e: KeyboardEvent) => this.handleKey(e);

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
      },
      { preview: opts.previewSize ?? [1024, 512], full: opts.fullSize ?? [2048, 1024] },
      opts.renderFull ?? null,
    );
    const host: InteractionHost = {
      core: this.core,
      settings: this.settings,
      seeds: this.seeds,
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
    this.renderer.bind(this.opts.getView(), (e) => this.interaction.handle(e));
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
    this.renderer.bind(this.opts.getView(), (e) => this.interaction.handle(e));
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
    this.selectedId = this.core.plates[0].id;
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
      const res = this.core.load(draft, src, label);
      this.afterLoad();
      this.panel.setStatus(`${res.message}. Undo to go back.`, 'ok');
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
        const fin = this.core.finalize(this.core.draft.seed);
        this.opts.onApply(fin);
        this.panel.setStatus(`Simulating ${fin.plates.length} plates.`, 'ok');
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
          const a = this.core.anchors()[k];
          if (!a) return;
          this.opDone(this.core.setMotion(k, omegaFromMotion(a, speedCmYr * 10, bearingDeg, spinDegMyr * DEG)));
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
    const rows: PlateRow[] = d.plates.map((p, k) => {
      const m = counts[k] > 0 ? core.plateMotion(k) : null;
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        area: counts[k] / d.n,
        cells: counts[k],
        speed: m ? m.speed : null,
        bearing: m ? m.bearing : 0,
        spin: m ? m.spin : 0,
      };
    });
    this.panel.updatePlates(rows, this.selectedId);
    this.panel.update(this.panelState());
  }

  private panelState(): PanelState {
    const sel = this.selectedIndex();
    const p = sel >= 0 ? this.core.plates[sel] : null;
    return {
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
