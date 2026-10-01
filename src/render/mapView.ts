import type {
  ArrowSpec, BrushCursor, CloudSpec, GeoPoint, LightingMode, MarkerSpec, VectorFieldSpec, WorldPointerEvent, WorldView,
} from '../core/types';
import { MapClouds } from './cloudsMap';
import { context2d, ImageCanvas, makeLayerCanvas } from './mapCanvas';
import { MapGlBase } from './mapGl';
import { MapInput } from './mapInput';
import { drawArrows, drawBrush, drawGraticule, drawMarkers } from './mapLayers';
import { applyShade, hillshade, nightShade } from './mapShading';
import { copyIfChanged, premultiply } from './viewBuffers';
import { copyVectorField, DEFAULT_PARTICLE_COUNT, ParticleSystem } from './particles';
import { MapParticles } from './particlesMap';
import { DetailFader, heightSignature } from './viewDetail';
import { HeightField } from './viewHeight';
import {
  mapClamp, mapMinScale, mapProject, mapUnproject, mapWorldCopies, mapWorldRect, type MapTransform,
} from './viewMapTransform';
import { PointerHub } from './viewPointer';
import { wrapLon } from './viewUtil';

const BACKGROUND = '#05070b';
const NIGHT_W = 360;
const NIGHT_H = 180;
/** A lost GPU context that was not restored after this long is replaced by a fresh one... */
const GPU_RECREATE_AFTER_MS = 2500;
/** ...at most this often. */
const GPU_RECREATE_EVERY_MS = 10000;

/**
 * 2D equirectangular canvas implementation of WorldView with pan/zoom and longitude wrap (SPEC.md §8.2).
 *
 * Layers (bottom → top): base canvas (image or relief-shaded image, clouds, night shade, overlay,
 * graticule; redrawn on view/data change), particle trails (faded every frame) and annotations
 * (arrows, brush, markers; redrawn on change). In 'relief'/'sun' lighting with a height map the base
 * is hillshaded, so feed the map the unshaded image (the same one the globe gets).
 *
 * The base image itself is rendered on the GPU when WebGL2 is available (MapGlBase: smooth
 * anti-aliased coastlines, lake and class edges from the height map and crisp relief at any zoom,
 * shading in the shader), and so is the overlay (crisp magnified lines); otherwise they are drawn
 * with Canvas 2D and the base is hillshaded on the CPU. A lost GPU context is re-initialised when the
 * browser restores it (or replaced by a fresh one if it does not), so the map never stays on the
 * fallback after a transient loss.
 */
export class MapView implements WorldView {
  readonly kind = 'map' as const;
  readonly element: HTMLElement;

  private readonly root: HTMLDivElement;
  private readonly baseCanvas = makeLayerCanvas();
  private readonly topCanvas = makeLayerCanvas();
  private readonly baseCtx: CanvasRenderingContext2D;
  private readonly topCtx: CanvasRenderingContext2D;
  private readonly particleLayer = new MapParticles();
  /** Clouds raster asynchronously in the cloud worker; redraw the base when a raster lands. */
  private readonly cloudLayer = new MapClouds(() => {
    this.baseDirty = true;
  });
  private readonly baseImage = new ImageCanvas();
  private readonly shadedImage = new ImageCanvas();
  private readonly overlayImage = new ImageCanvas();
  private readonly nightImage = new ImageCanvas();
  private readonly heights = new HeightField();
  private readonly pointers = new PointerHub();
  private readonly input: MapInput;
  private readonly resizeObserver: ResizeObserver;
  private gpu: MapGlBase | null;
  /** performance.now() of the last attempt to replace a lost GPU context. */
  private gpuRetryAt = 0;
  private readonly detailFader = new DetailFader();
  private detailAmount = 1;
  /** Detail strength of the last GPU base draw. */
  private drawnDetail = -1;
  /** The Canvas 2D copy of the base image is stale (only maintained for the CPU fallback). */
  private baseImageStale = false;
  /** Size (CSS px) and DPR last applied to the canvases; 0 = never. */
  private appliedW = 0;
  private appliedH = 0;
  private appliedDpr = 0;

  private t: MapTransform = { width: 1, height: 1, centerLon: 0, centerLat: 0, scale: 1 };
  /** Zoom relative to fit-the-world (kept across resizes). */
  private zoom = 1;
  private baseRgba: Uint8ClampedArray | null = null;
  private baseW = 0;
  private baseH = 0;
  private hasOverlay = false;
  /** Straight-alpha copy of the overlay (Canvas 2D fallback, context restore) and its premultiplied twin (GPU). */
  private overlayRgba: Uint8ClampedArray | null = null;
  private overlayPremul: Uint8Array | null = null;
  private overlayW = 0;
  private overlayH = 0;
  /** The Canvas 2D copy of the overlay is stale (only maintained for the CPU fallback). */
  private overlayImageStale = false;
  private shade: Float32Array | null = null;
  private seaLevel = 0;
  private lighting: LightingMode = { mode: 'relief' };
  private fixedSunLon: number | null = null;
  private nightKey = '';
  private graticuleStep = 0;
  private arrows: ArrowSpec[] = [];
  private markers: MarkerSpec[] = [];
  private brush: BrushCursor | null = null;
  private particles: ParticleSystem | null = null;
  private particleCount = DEFAULT_PARTICLE_COUNT;
  private mode: 'navigate' | 'paint' = 'navigate';

  private baseDirty = true;
  private topDirty = true;
  /** Shaded image is stale (recomputed on the next visible frame that needs it). */
  private shadeDirty = false;
  private raf = 0;
  private lastFrameMs = -1;
  private disposed = false;

  constructor(container: HTMLElement) {
    this.element = container;
    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: BACKGROUND,
      touchAction: 'none', cursor: 'grab', userSelect: 'none',
    });
    Object.assign(this.particleLayer.canvas.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', pointerEvents: 'none' });
    this.baseCtx = context2d(this.baseCanvas);
    this.topCtx = context2d(this.topCanvas);
    this.root.append(this.baseCanvas, this.particleLayer.canvas, this.topCanvas);
    container.appendChild(this.root);
    this.gpu = this.attachGpu(MapGlBase.create());

    this.input = new MapInput({
      root: this.root,
      pointers: this.pointers,
      mode: () => this.mode,
      transform: () => this.t,
      setTransform: (t) => this.setTransform(t),
      pick: (x, y) => this.pick(x, y),
    });
    // Size tracking: ResizeObserver plus visibility/window resizes and a per-frame / per-export check,
    // so a view created in a hidden or zero-size container never keeps a stale canvas size.
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.root);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('resize', this.onVisibility);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  /* ------------------------------------------------------------------ */
  /* WorldView data setters                                              */
  /* ------------------------------------------------------------------ */

  setBaseImage(rgba: Uint8ClampedArray, width: number, height: number): void {
    const n = width * height * 4;
    if (!(width > 0 && height > 0) || rgba.length < n) throw new Error(`MapView.setBaseImage: expected ${width}x${height}x4 bytes`);
    const sameSize = this.baseRgba !== null && this.baseRgba.length === n && this.baseW === width && this.baseH === height;
    if (!this.baseRgba || this.baseRgba.length !== n) this.baseRgba = new Uint8ClampedArray(n);
    const changed = copyIfChanged(rgba, this.baseRgba, width * height) || !sameSize;
    this.baseW = width;
    this.baseH = height;
    // Identical resend (pause re-push, lighting-only changes): nothing to upload or re-shade.
    if (!changed && (this.gpuActive ? this.gpu!.hasBase : !this.baseImageStale)) return;
    if (this.gpuActive) {
      this.gpu!.setBase(this.baseRgba, width, height);
      this.baseImageStale = true;
    } else {
      this.baseImage.put(this.baseRgba, width, height);
      this.baseImageStale = false;
    }
    this.shadeDirty = this.baseDirty = true;
  }

  setHeightMap(height: Float32Array | null, width: number, height_: number): void {
    if (height) {
      // Identical resend (month/layer change): no upload, no re-shade.
      if (!this.heights.set(height, width, height_) && (!this.gpuActive || this.gpu!.hasHeight)) return;
      this.detailFader.noteHeights(heightSignature(height, width * height_), performance.now());
    } else {
      this.heights.clear();
      this.detailFader.reset();
    }
    if (this.gpuActive) this.gpu!.setHeight(height ? this.heights.data : null, width, height_);
    this.shade = null;
    this.shadeDirty = this.baseDirty = true;
  }

  setSeaLevel(seaLevel: number): void {
    if (seaLevel === this.seaLevel) return;
    this.seaLevel = seaLevel;
    this.shade = null;
    this.shadeDirty = this.baseDirty = true;
  }

  setOverlayImage(rgba: Uint8ClampedArray | null, width: number, height: number): void {
    if (rgba && (!(width > 0 && height > 0) || rgba.length < width * height * 4)) {
      throw new Error(`MapView.setOverlayImage: expected ${width}x${height}x4 bytes`);
    }
    this.hasOverlay = rgba !== null;
    if (!rgba) {
      this.gpu?.setOverlay(null, 0, 0);
      this.baseDirty = true;
      return;
    }
    const n = width * height;
    if (!this.overlayRgba || this.overlayRgba.length !== 4 * n) {
      this.overlayRgba = new Uint8ClampedArray(4 * n);
      this.overlayPremul = new Uint8Array(4 * n);
      this.overlayImageStale = true;
    }
    const sameSize = width === this.overlayW && height === this.overlayH;
    this.overlayW = width;
    this.overlayH = height;
    const changed = copyIfChanged(rgba, this.overlayRgba, n) || !sameSize;
    if (changed) this.overlayImageStale = true;
    if (this.gpuActive) {
      // Unchanged overlays (month/layer changes) are neither re-premultiplied nor re-uploaded.
      if (changed || !this.gpu!.hasOverlay) {
        premultiply(this.overlayRgba, this.overlayPremul!, n);
        this.gpu!.setOverlay(this.overlayPremul, width, height);
      }
    } else if (this.overlayImageStale) {
      this.overlayImage.put(this.overlayRgba, width, height);
      this.overlayImageStale = false;
    }
    this.baseDirty = true;
  }

  setVectorField(spec: VectorFieldSpec | null): void {
    const field = spec ? copyVectorField(spec) : null;
    if (!field) this.particles = null;
    else if (this.particles && this.particles.kind === field.kind && this.particles.count === this.particleCount) this.particles.setField(field);
    else this.particles = new ParticleSystem(field, { count: this.particleCount, blocked: this.blockedFor(field.kind) });
    this.particleLayer.clear();
  }

  setClouds(clouds: CloudSpec | null): void {
    this.cloudLayer.set(clouds);
    this.baseDirty = true;
  }

  setArrows(arrows: ArrowSpec[]): void {
    this.arrows = arrows.map((a) => ({ ...a, color: [a.color[0], a.color[1], a.color[2]] }));
    this.topDirty = true;
  }

  setMarkers(markers: MarkerSpec[]): void {
    this.markers = markers.map((m) => ({ ...m, color: [m.color[0], m.color[1], m.color[2]] }));
    this.topDirty = true;
  }

  setBrushCursor(cursor: BrushCursor | null): void {
    const c = cursor?.color;
    this.brush = cursor ? { point: { ...cursor.point }, radius: cursor.radius, color: c ? [c[0], c[1], c[2]] : undefined } : null;
    this.topDirty = true;
  }

  setInteractionMode(mode: 'navigate' | 'paint'): void {
    this.mode = mode;
    this.root.style.cursor = this.input.idleCursor();
  }

  setLighting(lighting: LightingMode): void {
    this.lighting = { ...lighting };
    // The shaded copy does not depend on the mode (relief and sun share it): no reshade here, only a
    // recomposite. The app re-sends the lighting on every month change.
    this.baseDirty = true;
  }

  /** The 2D map has no vertical relief; kept for interface parity. */
  setReliefScale(_scale: number): void {}

  /* ------------------------------------------------------------------ */
  /* Optional extras (not in the WorldView contract)                     */
  /* ------------------------------------------------------------------ */

  /** Graticule lines every stepDeg degrees (equator/prime meridian emphasized). */
  setGraticule(enabled: boolean, stepDeg = 15): void {
    this.graticuleStep = enabled ? Math.max(1, stepDeg) : 0;
    this.baseDirty = true;
  }

  /** Strength of the procedural close-up detail on the GPU base (0 disables it; default 1). */
  setSurfaceDetail(amount: number): void {
    this.detailAmount = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount : 0));
    this.baseDirty = true;
  }

  /** Fixes the subsolar longitude (radians) in 'sun' lighting; null = follow the view center. */
  setSunLongitude(lon: number | null): void {
    this.fixedSunLon = lon;
    this.baseDirty = true;
  }

  /** Number of flow particles (default 8000). */
  setParticleCount(count: number): void {
    this.particleCount = Math.max(1, Math.floor(count));
    if (this.particles && this.particles.count !== this.particleCount) {
      this.particles = new ParticleSystem(this.particles.fieldSpec, { count: this.particleCount, blocked: this.blockedFor(this.particles.kind) });
      this.particleLayer.clear();
    }
  }

  /** Centers the map on a point; zoom is relative to fit-the-world (1 = whole world). */
  setView(center: GeoPoint, zoom?: number): void {
    if (zoom !== undefined) this.zoom = Math.max(1, zoom);
    this.setTransform({ ...this.t, centerLon: center.lon, centerLat: center.lat, scale: this.zoom * mapMinScale(this.t.width, this.t.height) });
  }

  getView(): { center: GeoPoint; zoom: number } {
    return { center: { lat: this.t.centerLat, lon: this.t.centerLon }, zoom: this.zoom };
  }

  /** Current map transform (CSS px). */
  getTransform(): MapTransform {
    return { ...this.t };
  }

  /* ------------------------------------------------------------------ */
  /* Picking & projection                                                */
  /* ------------------------------------------------------------------ */

  pick(clientX: number, clientY: number): GeoPoint | null {
    const rect = this.root.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    return mapUnproject(this.t, x, y);
  }

  project(point: GeoPoint): { x: number; y: number; visible: boolean } {
    const rect = this.root.getBoundingClientRect();
    const p = mapProject(this.t, point.lat, point.lon);
    return { x: rect.left + p.x, y: rect.top + p.y, visible: p.x >= 0 && p.y >= 0 && p.x <= this.t.width && p.y <= this.t.height };
  }

  onPointer(handler: (e: WorldPointerEvent) => void): () => void {
    return this.pointers.on(handler);
  }

  resize(): void {
    this.syncSize();
  }

  /** Applies the container size when it changed; false while the container has no area. */
  private syncSize(): boolean {
    if (this.disposed) return false;
    const w = this.root.clientWidth, h = this.root.clientHeight;
    if (w === 0 || h === 0) return false;
    const dpr = this.dpr();
    if (w === this.appliedW && h === this.appliedH && dpr === this.appliedDpr) return true;
    this.appliedW = w;
    this.appliedH = h;
    this.appliedDpr = dpr;
    for (const c of [this.baseCanvas, this.topCanvas]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this.particleLayer.resize(w, h, dpr);
    this.t = mapClamp({ ...this.t, width: w, height: h, scale: this.zoom * mapMinScale(w, h) });
    this.baseDirty = this.topDirty = true;
    return true;
  }

  private readonly onVisibility = (): void => {
    this.syncSize();
  };

  toDataURL(): string {
    this.syncSize();
    this.renderStatic();
    const out = document.createElement('canvas');
    out.width = this.baseCanvas.width;
    out.height = this.baseCanvas.height;
    const ctx = context2d(out);
    ctx.drawImage(this.baseCanvas, 0, 0);
    ctx.drawImage(this.particleLayer.canvas, 0, 0);
    ctx.drawImage(this.topCanvas, 0, 0);
    return out.toDataURL('image/png');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('resize', this.onVisibility);
    this.gpu?.dispose();
    this.cloudLayer.dispose(); // cancels pending window rasters, frees the window canvas
    this.input.dispose();
    this.pointers.clear();
    this.particles = null;
    this.baseRgba = null;
    this.shade = null;
    // Release canvas backing stores promptly.
    for (const c of [this.baseCanvas, this.topCanvas, this.particleLayer.canvas, this.cloudLayer.canvas]) c.width = c.height = 0;
    for (const img of [this.baseImage, this.shadedImage, this.overlayImage, this.nightImage]) img.release();
    this.root.remove();
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  private dpr(): number {
    return Math.min(2, window.devicePixelRatio || 1);
  }

  private blockedFor(kind: VectorFieldSpec['kind']): ((x: number, y: number, z: number) => boolean) | undefined {
    if (kind !== 'current') return undefined;
    return (x, y, z) => this.heights.present && this.heights.atVec(x, y, z) > this.seaLevel;
  }

  private setTransform(t: MapTransform): void {
    this.t = mapClamp(t);
    this.zoom = this.t.scale / mapMinScale(this.t.width, this.t.height);
    this.baseDirty = this.topDirty = true;
    this.particleLayer.clear();
  }

  private readonly frame = (ms: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.lastFrameMs < 0 ? 0 : Math.min(0.1, Math.max(0, (ms - this.lastFrameMs) / 1000));
    this.lastFrameMs = ms;
    if (!this.syncSize()) return;
    // Redraw for the detail fade only while its value moves (constant 0 through the hold, i.e. during
    // playback: no base redraws at display rate between streamed frames), up to the settled value.
    if (this.gpuActive && this.baseRgba && this.detailValue(performance.now()) !== this.drawnDetail) this.baseDirty = true;
    this.renderStatic();
    if (this.particles) {
      // Slower geographic speed when zoomed in keeps on-screen speed comparable.
      this.particles.step(dt, Math.pow(1 / this.zoom, 0.75));
      this.particleLayer.draw(this.particles, this.t, this.dpr(), dt);
    }
  };

  /** Redraws the base and annotation canvases if dirty. */
  private renderStatic(): void {
    this.reviveGpu(performance.now());
    if (this.shadeDirty) this.updateShading();
    if (this.lighting.mode === 'sun') this.updateNight();
    if (this.baseDirty) this.drawBase();
    if (this.topDirty) this.drawTop();
  }

  private detailValue(nowMs: number): number {
    return this.detailAmount * this.detailFader.value(nowMs);
  }

  /** The GPU base layer is in use (WebGL2 available and the context alive). */
  private get gpuActive(): boolean {
    return this.gpu !== null && this.gpu.usable;
  }

  private get shaded(): boolean {
    return this.lighting.mode !== 'flat' && this.heights.present && this.baseRgba !== null;
  }

  /** Recomputes the relief-shaded copy of the base image ('relief'/'sun' with a height map). */
  private updateShading(): void {
    // Stays dirty while unshaded (flat lighting / no height map) so a later switch recomputes it.
    // The GPU base shades in its shader (stays dirty too, in case the context is lost later).
    if (!this.shaded || this.gpuActive) return;
    this.shadeDirty = false;
    const hf = this.heights;
    this.shade ??= hillshade(hf.data!, hf.w, hf.h, this.seaLevel);
    const out = this.shadedImage.pixels(this.baseW, this.baseH);
    applyShade(this.baseRgba!, this.baseW, this.baseH, this.shade, hf.w, hf.h, out);
    this.shadedImage.commit();
  }

  /** Night overlay for the subsolar point (follows the view center unless fixed). */
  private updateNight(): void {
    if (this.lighting.mode !== 'sun') return;
    const sunLon = this.fixedSunLon ?? wrapLon(this.t.centerLon);
    const key = `${this.lighting.declination.toFixed(4)}:${sunLon.toFixed(3)}`;
    if (key === this.nightKey) return;
    this.nightKey = key;
    nightShade(NIGHT_W, NIGHT_H, this.lighting.declination, sunLon, this.nightImage.pixels(NIGHT_W, NIGHT_H));
    this.nightImage.commit();
    this.baseDirty = true;
  }

  private drawBase(): void {
    this.baseDirty = false;
    const ctx = this.baseCtx, t = this.t, dpr = this.dpr();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, t.width, t.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const layers: HTMLCanvasElement[] = [];
    let gpuBase: HTMLCanvasElement | null = null;
    if (this.baseRgba && this.gpuActive) {
      const detail = this.detailValue(performance.now());
      gpuBase = this.gpu!.render({ t, dpr, seaLevel: this.seaLevel, shade: this.shaded, detail });
      this.drawnDetail = detail;
    }
    if (gpuBase) {
      // One draw at device resolution (the shader wraps longitude itself).
      ctx.drawImage(gpuBase, 0, 0, t.width, t.height);
    } else if (this.baseRgba) {
      this.ensureCpuBase();
      layers.push(this.shaded ? this.shadedImage.canvas : this.baseImage.canvas);
    }
    if (this.cloudLayer.active) {
      // Zoomed in, the cloud worker rasterizes the visible window sharply once the view rests.
      this.cloudLayer.setView(t, dpr);
      layers.push(this.cloudLayer.canvas);
    }
    if (this.lighting.mode === 'sun') layers.push(this.nightImage.canvas);
    // Overlay on top: a GPU pass (crisp when magnified) when the GPU base ran, else Canvas 2D.
    const gpuOverlay = this.hasOverlay && gpuBase !== null && this.gpu!.hasOverlay;
    if (this.hasOverlay && !gpuOverlay) {
      this.ensureCpuOverlay();
      layers.push(this.overlayImage.canvas);
    }
    for (const k of mapWorldCopies(t)) {
      const r = mapWorldRect(t, k);
      // Snap to device pixels so adjacent copies meet without a hairline seam.
      const x0 = Math.round(r.x * dpr) / dpr, x1 = Math.round((r.x + r.w) * dpr) / dpr;
      const y0 = Math.round(r.y * dpr) / dpr, y1 = Math.round((r.y + r.h) * dpr) / dpr;
      for (const c of layers) {
        if (c === this.cloudLayer.canvas) this.cloudLayer.drawCopy(ctx, x0, y0, x1 - x0, y1 - y0);
        else ctx.drawImage(c, x0, y0, x1 - x0, y1 - y0);
      }
    }
    if (gpuOverlay) {
      const ov = this.gpu!.renderOverlay({ t, dpr, seaLevel: this.seaLevel, detail: Math.max(0, this.drawnDetail) });
      if (ov) ctx.drawImage(ov, 0, 0, t.width, t.height);
    }
    if (this.graticuleStep > 0) drawGraticule(ctx, t, this.graticuleStep);
  }

  /** Brings the Canvas 2D base (and its hillshade) up to date after running on the GPU path. */
  private ensureCpuBase(): void {
    if (!this.baseRgba) return;
    if (this.baseImageStale) {
      this.baseImage.put(this.baseRgba, this.baseW, this.baseH);
      this.baseImageStale = false;
      this.shadeDirty = true;
    }
    if (this.shadeDirty) this.updateShading();
  }

  /** Brings the Canvas 2D overlay up to date after running on the GPU path. */
  private ensureCpuOverlay(): void {
    if (!this.overlayImageStale || !this.overlayRgba) return;
    this.overlayImage.put(this.overlayRgba, this.overlayW, this.overlayH);
    this.overlayImageStale = false;
  }

  /** Wires a (new) GPU layer: re-sends the current images whenever its context is restored. */
  private attachGpu(gpu: MapGlBase | null): MapGlBase | null {
    if (gpu) gpu.onRestored = () => this.uploadAllToGpu();
    return gpu;
  }

  /** Sends base, height and overlay to the GPU layer (after a context restore or replacement). */
  private uploadAllToGpu(): void {
    const gpu = this.gpu;
    if (!gpu || !gpu.usable || this.disposed) return;
    if (this.baseRgba) {
      gpu.setBase(this.baseRgba, this.baseW, this.baseH);
      this.baseImageStale = true;
    }
    if (this.heights.present) gpu.setHeight(this.heights.data, this.heights.w, this.heights.h);
    if (this.hasOverlay && this.overlayRgba && this.overlayPremul) {
      premultiply(this.overlayRgba, this.overlayPremul, this.overlayW * this.overlayH);
      gpu.setOverlay(this.overlayPremul, this.overlayW, this.overlayH);
    }
    this.baseDirty = true;
  }

  /**
   * A GPU context lost and not restored by the browser (e.g. evicted for exceeding the per-page
   * context limit) is replaced by a fresh one after a grace period, rate-limited.
   */
  private reviveGpu(nowMs: number): void {
    const gpu = this.gpu;
    if (!gpu || gpu.usable || gpu.lostAt === 0 || this.disposed) return;
    if (nowMs - gpu.lostAt < GPU_RECREATE_AFTER_MS || nowMs - this.gpuRetryAt < GPU_RECREATE_EVERY_MS) return;
    this.gpuRetryAt = nowMs;
    const fresh = MapGlBase.create();
    if (!fresh) return;
    gpu.dispose();
    this.gpu = this.attachGpu(fresh);
    this.uploadAllToGpu();
  }

  private drawTop(): void {
    this.topDirty = false;
    const ctx = this.topCtx, t = this.t, dpr = this.dpr();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.topCanvas.width, this.topCanvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.arrows.length) drawArrows(ctx, t, this.arrows);
    if (this.brush) drawBrush(ctx, t, this.brush);
    if (this.markers.length) drawMarkers(ctx, t, this.markers);
  }
}
