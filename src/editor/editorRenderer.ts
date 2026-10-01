/**
 * Preview pipeline of the plate editor: pushes the incremental fast preview (PreviewRaster) into
 * the WorldView once per animation frame, swaps in a debounced full-quality render when the user
 * pauses, and keeps motion arrows / seed markers / brush cursor in sync.
 */
import { FrameTask } from '../app/frameTask';
import { vecToLatLon } from '../core/math3';
import type { ArrowSpec, BrushCursor, MarkerSpec, RGB, SphereMesh, Vec3, WorldPointerEvent, WorldView } from '../core/types';
import { plateColor } from '../tectonics/draft';
import type { EditorCore } from './editorCore';
import type { FullRenderFn, FullRenderResult } from './fullRender';
import type { MotionReadout } from './interaction';
import { PerfRing } from './perf';
import { viewVisibility, type MotionHandles } from './handles';
import { fibonacciPoints, plateArrow, velocityFieldArrows } from './motion';
import type { PreviewSource, PreviewStyle } from './preview';
import { PreviewRaster } from './preview';
import type { ToolId } from './tools';
import { toolInfo } from './tools';

/** Delay after the last edit before the full-quality preview is requested, ms. */
const FULL_RENDER_DELAY = 350;
/** Sample points of the ω×p field shown while a motion is dragged. */
const FIELD_SAMPLES = 170;
/** Field arrows are drawn at this fraction of the plate-arrow scale. */
const FIELD_SCALE = 0.45;
/** How often the arrow layout is checked against the camera (hidden tails move to visible points), ms. */
const HANDLE_CHECK_MS = 200;

/** What the renderer reads from the editor shell. */
export interface RendererContext {
  readonly core: EditorCore;
  style(): PreviewStyle;
  seaLevel(): number;
  tool(): ToolId;
  selectedIndex(): number;
  seeds(): readonly Vec3[];
  /** A pointer interaction is in progress (the full render waits for it to finish). */
  interacting(): boolean;
  /** A frame applied draft changes (refresh the plate list, notify listeners). */
  onDraftFrame(): void;
  /** The full-quality renderer failed; it is disabled afterwards. */
  onFullRenderError(err: unknown): void;
  /** Where motion arrows are drawn (kept visible while the globe turns). */
  readonly handles: MotionHandles;
}

export interface RendererSizes {
  preview: [number, number];
  full: [number, number];
}

function tint(c: RGB, t: number): RGB {
  return [Math.round(c[0] + (255 - c[0]) * t), Math.round(c[1] + (255 - c[1]) * t), Math.round(c[2] + (255 - c[2]) * t)];
}

export class EditorRenderer {
  private raster: PreviewRaster | null = null;
  private viewRef: WorldView | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Next preview flush: animation frame, or a macrotask while the page is hidden (rAF paused). */
  private readonly frame = new FrameTask(() => this.flush());
  private repaintAll = true;
  private pendingCells: number[] = [];
  private readonly highlightMask: Uint8Array;
  private highlightCells: number[] = [];
  private showing: 'proxy' | 'full' | null = null;
  private lastFull: (FullRenderResult & { revision: number; style: PreviewStyle; seaLevel: number }) | null = null;
  private fullTimer: ReturnType<typeof setTimeout> | null = null;
  private overlaysDirty = true;
  private seenRevision = -1;
  private motionDragPlate: number | null = null;
  private hoverArrowPlate: number | null = null;
  private hoverSeedIndex: number | null = null;
  private readout: MotionReadout | null = null;
  private cursorCss: string | null = null;
  private handleTimer: ReturnType<typeof setInterval> | null = null;
  private readonly fieldSamples = fibonacciPoints(FIELD_SAMPLES);
  /** Wall-clock cost of each preview frame (drain + recolour + push), ms. */
  readonly frameTimes = new PerfRing(240);

  constructor(
    private readonly mesh: SphereMesh,
    private readonly ctx: RendererContext,
    private readonly sizes: RendererSizes,
    private renderFull: FullRenderFn | null,
  ) {
    this.highlightMask = new Uint8Array(mesh.n);
  }

  get view(): WorldView | null {
    return this.viewRef;
  }

  /** Tool paths are being highlighted (the full render waits). */
  get highlighting(): boolean {
    return this.highlightCells.length > 0;
  }

  setFullRenderer(fn: FullRenderFn | null): void {
    this.renderFull = fn;
  }

  /** Take over a view: flat lighting, no relief/particles/clouds, pointer events to `onPointer`. */
  bind(view: WorldView, onPointer: (e: WorldPointerEvent) => void): void {
    if (!this.raster) this.raster = new PreviewRaster(this.mesh, this.sizes.preview[0], this.sizes.preview[1]);
    const [w, h] = this.sizes.preview;
    this.viewRef = view;
    this.unsubscribe = view.onPointer(onPointer);
    view.setInteractionMode(toolInfo(this.ctx.tool()).paint ? 'paint' : 'navigate');
    this.applyCursor();
    view.setLighting({ mode: 'flat' });
    view.setReliefScale(0);
    view.setSeaLevel(this.ctx.seaLevel());
    view.setHeightMap(null, w, h);
    view.setVectorField(null);
    view.setClouds(null);
    const full = this.lastFull;
    if (full && this.fullIsCurrent(full) && !this.ctx.core.busy) {
      view.setBaseImage(full.rgba, full.width, full.height);
      view.setOverlayImage(full.overlay, full.width, full.height);
      this.showing = 'full';
    } else {
      this.showing = null;
      this.repaintAll = true;
    }
    this.overlaysDirty = true;
    this.schedule();
    // The camera moves without telling the editor: re-place arrows whose tails turned out of view.
    if (this.handleTimer) clearInterval(this.handleTimer);
    this.handleTimer = setInterval(() => this.checkHandles(), HANDLE_CHECK_MS);
  }

  private checkHandles(): void {
    const v = this.viewRef;
    if (!v || this.overlaysDirty) return;
    try {
      if (this.ctx.handles.stale(this.ctx.core, viewVisibility(v))) this.invalidateOverlays();
    } catch {
      // A view being torn down (globe ⇄ map switch) may not project; the next check retries.
    }
  }

  /** Release the view (clear = also drop the overlay and return it to navigate mode). */
  unbind(clear: boolean): void {
    this.cancelFrame();
    if (this.handleTimer) clearInterval(this.handleTimer);
    this.handleTimer = null;
    if (this.fullTimer) clearTimeout(this.fullTimer);
    this.fullTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const v = this.viewRef;
    this.viewRef = null;
    this.showing = null;
    if (!v) return;
    v.setBrushCursor(null);
    v.setArrows([]);
    v.setMarkers([]);
    delete v.element.dataset.peCursor;
    if (clear) {
      v.setOverlayImage(null, this.sizes.preview[0], this.sizes.preview[1]);
      v.setInteractionMode('navigate');
    }
  }

  setInteractionMode(tool: ToolId): void {
    this.viewRef?.setInteractionMode(toolInfo(tool).paint ? 'paint' : 'navigate');
  }

  setCursor(c: BrushCursor | null): void {
    this.viewRef?.setBrushCursor(c);
  }

  /** CSS cursor override for the view (null: the view's own cursor for its mode). */
  setPointerCursor(css: string | null): void {
    this.cursorCss = css;
    this.applyCursor();
  }

  private applyCursor(): void {
    const v = this.viewRef;
    if (!v) return;
    if (this.cursorCss) v.element.dataset.peCursor = this.cursorCss;
    else delete v.element.dataset.peCursor;
  }

  /** Highlight the motion arrow of plate index k (grabbable under the pointer); null clears. */
  setHoverArrow(k: number | null): void {
    if (k === this.hoverArrowPlate) return;
    this.hoverArrowPlate = k;
    this.invalidateOverlays();
  }

  /** Highlight seed marker k (under the pointer); null clears. */
  setHoverSeed(k: number | null): void {
    if (k === this.hoverSeedIndex) return;
    this.hoverSeedIndex = k;
    this.invalidateOverlays();
  }

  /** Live motion readout next to the dragged arrow head; null clears. */
  setMotionReadout(r: MotionReadout | null): void {
    this.readout = r;
    this.invalidateOverlays();
  }

  setSeaLevel(seaLevel: number): void {
    this.viewRef?.setSeaLevel(seaLevel);
    this.invalidateAll();
  }

  /** Everything must be repainted (style / sea level / whole-draft changes). */
  invalidateAll(): void {
    this.repaintAll = true;
    this.schedule();
  }

  /** Arrows or markers changed (selection, tool, seeds). */
  invalidateOverlays(): void {
    this.overlaysDirty = true;
    this.schedule();
  }

  /** A new draft was loaded: cached full renders are meaningless. */
  forgetFullRender(): void {
    this.lastFull = null;
    this.invalidateAll();
  }

  setMotionDrag(k: number | null): void {
    this.motionDragPlate = k;
    this.invalidateOverlays();
  }

  /** Highlight tool-path cells (split / lasso outline); null clears. */
  setHighlight(cells: number[] | null): void {
    if (cells === null) {
      for (const c of this.highlightCells) this.highlightMask[c] = 0;
      this.pendingCells.push(...this.highlightCells);
      this.highlightCells = [];
    } else {
      for (const c of cells) {
        if (this.highlightMask[c]) continue;
        this.highlightMask[c] = 1;
        this.highlightCells.push(c);
        this.pendingCells.push(c);
      }
    }
    this.schedule();
  }

  schedule(): void {
    if (!this.viewRef) return;
    this.frame.schedule();
  }

  cancelFrame(): void {
    this.frame.cancel();
  }

  dispose(): void {
    this.unbind(true);
    this.raster = null;
    this.lastFull = null;
  }

  private previewSource(): PreviewSource {
    const core = this.ctx.core;
    const d = core.draft;
    return {
      plate: d.plate,
      crust: d.crust,
      elev: d.elev,
      boundary: core.boundary,
      plates: d.plates,
      seaLevel: this.ctx.seaLevel(),
      style: this.ctx.style(),
      highlight: this.highlightCells.length ? this.highlightMask : null,
    };
  }

  /** One frame: recolour changed cells, push the preview, arrows and markers. */
  private flush(): void {
    const view = this.viewRef;
    const raster = this.raster;
    if (!view || !raster) return;
    const t0 = performance.now();
    this.flushInner(view, raster);
    this.frameTimes.push(performance.now() - t0);
  }

  private flushInner(view: WorldView, raster: PreviewRaster): void {
    const core = this.ctx.core;
    const ch = core.drainChanges();
    const src = this.previewSource();
    let repainted = false;
    if (ch.all || this.repaintAll) {
      raster.renderAll(src);
      this.repaintAll = false;
      this.pendingCells = [];
      repainted = true;
    } else if (ch.cells.length || this.pendingCells.length) {
      if (ch.cells.length) raster.renderCells(src, ch.cells);
      if (this.pendingCells.length) raster.renderCells(src, this.pendingCells);
      this.pendingCells = [];
      repainted = true;
    }
    if (repainted || this.showing === null) {
      view.setBaseImage(raster.rgba, raster.w, raster.h);
      if (this.showing !== 'proxy') view.setOverlayImage(null, raster.w, raster.h);
      this.showing = 'proxy';
      this.scheduleFullRender();
    }
    if (ch.all || ch.cells.length || core.revision !== this.seenRevision) {
      this.seenRevision = core.revision;
      this.overlaysDirty = true;
      this.ctx.onDraftFrame();
    }
    if (this.overlaysDirty) {
      this.overlaysDirty = false;
      this.pushArrowsAndMarkers(view);
    }
  }

  private pushArrowsAndMarkers(view: WorldView): void {
    const core = this.ctx.core;
    // Arrow tails: where the user set the motion, else the anchor — or a visible interior point
    // of the plate when that one is on the far side of the globe.
    let tails: Array<Vec3 | null>;
    try {
      tails = this.ctx.handles.layout(core, viewVisibility(view));
    } catch {
      tails = this.ctx.handles.layout(core, null);
    }
    const sel = this.ctx.selectedIndex();
    const arrows: ArrowSpec[] = [];
    const anchorsMarks: MarkerSpec[] = [];
    core.plates.forEach((p, k) => {
      const a = tails[k];
      if (!a) return;
      // The selected plate's arrow is brighter; the view's heavy "highlighted" outline marks the
      // arrow being dragged.
      const dragged = k === this.motionDragPlate;
      const hot = dragged || (k === this.hoverArrowPlate && this.motionDragPlate === null);
      const s = plateArrow(a, p.omega, tint(p.color, dragged ? 0.3 : hot ? 0.7 : k === sel ? 0.9 : 0.55), p.id, hot);
      if (s) arrows.push(s);
      else if (k === sel && this.ctx.tool() === 'motion') {
        // A stationary selected plate: mark its anchor so the user sees where arrows start.
        const { lat, lon } = vecToLatLon(a[0], a[1], a[2]);
        anchorsMarks.push({ lat, lon, color: tint(p.color, 0.9), radiusPx: 4, label: 'stationary — drag to set motion' });
      }
    });
    if (this.motionDragPlate !== null) {
      const d = core.draft;
      arrows.push(...velocityFieldArrows(this.mesh, d.plate, d.plates, this.fieldSamples, FIELD_SCALE, this.motionDragPlate));
    }
    view.setArrows(arrows);
    const markers: MarkerSpec[] = [...anchorsMarks];
    if (this.ctx.tool() === 'seeds') {
      this.ctx.seeds().forEach((s, k) => {
        const { lat, lon } = vecToLatLon(s[0], s[1], s[2]);
        markers.push({ lat, lon, color: plateColor(k), radiusPx: 7, id: k, label: String(k + 1), highlighted: k === this.hoverSeedIndex });
      });
    }
    const r = this.readout;
    if (r && r.plate < core.plates.length) {
      const { lat, lon } = vecToLatLon(r.head[0], r.head[1], r.head[2]);
      markers.push({ lat, lon, color: tint(core.plates[r.plate].color, 0.5), radiusPx: 1, label: r.label });
    }
    view.setMarkers(markers);
  }

  private fullIsCurrent(f: { revision: number; style: PreviewStyle; seaLevel: number }): boolean {
    return f.revision === this.ctx.core.revision && f.style === this.ctx.style() && f.seaLevel === this.ctx.seaLevel();
  }

  private scheduleFullRender(): void {
    if (!this.renderFull) return;
    if (this.fullTimer) clearTimeout(this.fullTimer);
    this.fullTimer = setTimeout(() => {
      this.fullTimer = null;
      void this.requestFullRender();
    }, FULL_RENDER_DELAY);
  }

  /** True while the user is mid-edit (a full render would be stale or would flash). */
  private editing(): boolean {
    const core = this.ctx.core;
    return this.ctx.interacting() || core.busy || core.hasChanges || this.highlightCells.length > 0;
  }

  private async requestFullRender(): Promise<void> {
    const render = this.renderFull;
    if (!render || !this.viewRef) return;
    if (this.editing()) {
      this.scheduleFullRender();
      return;
    }
    const core = this.ctx.core;
    const key = { revision: core.revision, style: this.ctx.style(), seaLevel: this.ctx.seaLevel() };
    let res: FullRenderResult | null;
    const cached = this.lastFull;
    if (cached && cached.revision === key.revision && cached.style === key.style && cached.seaLevel === key.seaLevel) res = cached;
    else {
      try {
        const [width, height] = this.sizes.full;
        res = await render({ draft: core.exportDraft(), style: key.style, width, height, seaLevel: key.seaLevel });
      } catch (err) {
        this.renderFull = null;
        this.ctx.onFullRenderError(err);
        return;
      }
    }
    if (!res || !this.fullIsCurrent(key) || this.editing()) return;
    this.lastFull = { ...res, ...key };
    const view = this.viewRef;
    if (!view) return;
    view.setBaseImage(res.rgba, res.width, res.height);
    view.setOverlayImage(res.overlay, res.width, res.height);
    this.showing = 'full';
  }
}
