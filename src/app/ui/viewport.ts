/**
 * Center viewport: owns the active WorldView (GlobeView or MapView), keeps the last frame and every
 * view property so a freshly created view (globe ⇄ map switch) or the end of plate editing can
 * re-push the complete picture. While suspended (plate editor active) nothing is pushed.
 */
import type {
  CloudSpec, GeoPoint, LightingMode, VectorFieldSpec, WorldPointerEvent, WorldView,
} from '../../core/types';
import { GlobeView } from '../../render/globeView';
import { MapView } from '../../render/mapView';
import type { FrameMessage } from '../../worker/protocol';
import type { HeightMapRef } from '../inspect';
import type { ViewKind } from '../state';
import { h, setChildren, setText, toggleClass } from './dom';
import { button } from './controls';
import { icon } from './icons';

/** Optional capabilities both views implement beyond the WorldView contract. */
interface ViewExtras {
  setGraticule?(enabled: boolean, stepDeg?: number): void;
  setParticleCount?(count: number): void;
  getView?(): { center: GeoPoint };
  setView?(center: GeoPoint): void;
  /** Strength of the GPU close-up detail (0..1). */
  setSurfaceDetail?(amount: number): void;
}
export type AppView = WorldView & ViewExtras;

interface ImageRef {
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
}

export interface ViewportOptions {
  onPointer: (e: WorldPointerEvent) => void;
  /** A new view instance exists (initial creation or globe ⇄ map switch). */
  onViewChanged: (view: AppView) => void;
  onError: (title: string, detail: string) => void;
}

export class Viewport {
  readonly el = h('main', { class: 'wg-viewport' });
  readonly host = h('div', { class: 'wg-view-host' });
  readonly toolbar = h('div', { class: 'wg-toolbar' });
  readonly perf = h('div', { class: 'wg-view-perf wg-float', attrs: { hidden: true } });
  private readonly cover = h('div', { class: 'wg-view-cover' });
  /** Announced (polite live region) only when the task changes, never per percent. */
  private readonly renderingLabel = h('span', { text: 'Rendering…' });
  private readonly renderingDetail = h('span', { class: 'wg-view-render-detail', attrs: { 'aria-hidden': 'true' } });
  private readonly rendering = h('div', { class: 'wg-view-render wg-float' },
    h('span', { class: 'wg-spinner', attrs: { 'aria-hidden': 'true' } }),
    h('span', { attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } }, this.renderingLabel),
    this.renderingDetail);

  private current: AppView | null = null;
  private currentKind: ViewKind | null = null;
  private unsubscribe: (() => void) | null = null;
  private suspended = false;

  private base: ImageRef | null = null;
  private heights: HeightMapRef | null = null;
  private overlay: ImageRef | null = null;
  private seaLevel = 0;
  private lighting: LightingMode = { mode: 'relief' };
  private relief = 1;
  private graticule = false;
  private field: VectorFieldSpec | null = null;
  private clouds: CloudSpec | null = null;
  private particleCount = 8000;
  private surfaceDetail = 1;

  constructor(private readonly opts: ViewportOptions) {
    this.el.append(this.host, this.toolbar, this.perf, this.rendering, this.cover);
  }

  get view(): AppView | null {
    return this.current;
  }

  get kind(): ViewKind | null {
    return this.currentKind;
  }

  /** Displayed height map (for the hover inspector). */
  get heightMap(): HeightMapRef | null {
    return this.heights;
  }

  get hasImage(): boolean {
    return this.base !== null;
  }

  /** Create (or switch to) a globe or map view. Falls back to the map if WebGL is unavailable. */
  setKind(kind: ViewKind): ViewKind {
    if (this.current && this.currentKind === kind) return kind;
    const center = this.current?.getView?.().center ?? null;
    this.disposeView();
    const slot = h('div');
    this.host.appendChild(slot);
    let view: AppView;
    try {
      view = kind === 'globe' ? new GlobeView(slot) : new MapView(slot);
    } catch (e) {
      slot.remove();
      if (kind === 'globe') {
        this.opts.onError('3D globe unavailable', `${e instanceof Error ? e.message : String(e)} — showing the map instead.`);
        return this.setKind('map');
      }
      throw e;
    }
    this.current = view;
    this.currentKind = kind;
    this.unsubscribe = view.onPointer((ev) => this.opts.onPointer(ev));
    if (center && view.setView) view.setView(center);
    this.pushAll();
    this.opts.onViewChanged(view);
    return kind;
  }

  applyFrame(f: FrameMessage): void {
    if (f.rgba) this.base = { rgba: f.rgba, w: f.width, h: f.height };
    if (f.heightMap) this.heights = { data: f.heightMap, w: f.width, h: f.height };
    if (f.overlayRepainted) this.overlay = f.overlay ? { rgba: f.overlay, w: f.width, h: f.height } : null;
    const v = this.current;
    if (!v || this.suspended) return;
    if (f.rgba) v.setBaseImage(f.rgba, f.width, f.height);
    if (f.heightMap) v.setHeightMap(f.heightMap, f.width, f.height);
    if (f.overlayRepainted) v.setOverlayImage(f.overlay, f.width, f.height);
  }

  /** Forget the displayed world (new world loading). */
  clearImage(): void {
    this.base = null;
    this.heights = null;
    this.overlay = null;
  }

  setSeaLevel(v: number): void {
    this.seaLevel = v;
    if (this.live) this.current!.setSeaLevel(v);
  }

  setLighting(l: LightingMode): void {
    this.lighting = l;
    if (this.live) this.current!.setLighting(l);
  }

  setReliefScale(s: number): void {
    this.relief = s;
    if (this.live) this.current!.setReliefScale(s);
  }

  setGraticule(on: boolean): void {
    this.graticule = on;
    if (this.live) this.current!.setGraticule?.(on, 15);
  }

  setVectorField(f: VectorFieldSpec | null): void {
    this.field = f;
    if (this.live) this.current!.setVectorField(f);
  }

  setClouds(c: CloudSpec | null): void {
    this.clouds = c;
    if (this.live) this.current!.setClouds(c);
  }

  setParticleCount(n: number): void {
    this.particleCount = n;
    if (this.live) this.current!.setParticleCount?.(n);
  }

  /** GPU close-up detail strength (0..1), scaled by the Terrain detail setting. */
  setSurfaceDetail(amount: number): void {
    this.surfaceDetail = amount;
    if (this.live) this.current!.setSurfaceDetail?.(amount);
  }

  /** Stop pushing (the plate editor draws into the view). */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    const v = this.current;
    if (!v) return;
    v.setVectorField(null);
    v.setClouds(null);
    v.setOverlayImage(null, 1, 1);
  }

  /** Editor done: restore the complete picture. */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    const v = this.current;
    if (v) {
      v.setArrows([]);
      v.setMarkers([]);
      v.setBrushCursor(null);
      v.setInteractionMode('navigate');
    }
    this.pushAll();
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  /** Loading / error cover over the viewport; null hides it. */
  showCover(state: { kind: 'loading' | 'error' | 'empty'; title: string; detail?: string; action?: { label: string; onClick: () => void } } | null): void {
    if (!state) {
      this.cover.hidden = true;
      return;
    }
    this.cover.hidden = false;
    setChildren(this.cover,
      h('div', { class: `wg-cover-card${state.kind === 'error' ? ' is-error' : ''}` },
        state.kind === 'loading' ? h('div', { class: 'wg-spinner is-large' }) : icon(state.kind === 'error' ? 'alert' : 'globe', 28),
        h('h2', { text: state.title }),
        state.detail ? h('p', { text: state.detail }) : null,
        state.action ? button({ label: state.action.label, variant: 'primary', onClick: state.action.onClick }) : null,
      ));
  }

  /**
   * Busy badge over the view ("Rendering…", "Computing climate…" + "40%"). Only `label` is in the
   * live region, so a screen reader hears the task once, not every percent; `detail` (the progress
   * readout) changes silently. The hidden badge is out of the accessibility tree (CSS visibility).
   */
  setRendering(on: boolean, label = 'Rendering…', detail = ''): void {
    toggleClass(this.rendering, 'is-visible', on);
    if (!on) return;
    setText(this.renderingLabel, label);
    setText(this.renderingDetail, detail);
  }

  setPerf(text: string | null, detail?: string): void {
    this.perf.hidden = text === null;
    if (text !== null) setText(this.perf, text);
    this.perf.title = detail ?? '';
  }

  screenshot(): string {
    if (!this.current) throw new Error('No view to capture');
    return this.current.toDataURL();
  }

  dispose(): void {
    this.disposeView();
  }

  private get live(): boolean {
    return this.current !== null && !this.suspended;
  }

  private pushAll(): void {
    const v = this.current;
    if (!v || this.suspended) return;
    v.setSeaLevel(this.seaLevel);
    v.setLighting(this.lighting);
    v.setReliefScale(this.relief);
    v.setGraticule?.(this.graticule, 15);
    v.setParticleCount?.(this.particleCount);
    v.setSurfaceDetail?.(this.surfaceDetail);
    if (this.base) v.setBaseImage(this.base.rgba, this.base.w, this.base.h);
    v.setHeightMap(this.heights?.data ?? null, this.heights?.w ?? 1, this.heights?.h ?? 1);
    v.setOverlayImage(this.overlay?.rgba ?? null, this.overlay?.w ?? 1, this.overlay?.h ?? 1);
    v.setVectorField(this.field);
    v.setClouds(this.clouds);
  }

  private disposeView(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.current) {
      const slot = this.current.element;
      this.current.dispose();
      slot.remove();
    }
    this.current = null;
    this.currentKind = null;
  }
}
