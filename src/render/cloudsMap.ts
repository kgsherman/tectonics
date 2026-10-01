/**
 * Translucent static clouds for the 2D map: the globe's weather model (coverage-driven, domain-warped
 * multi-octave noise, regimes, cirrus, anvils, storm-track cyclones) rasterized by cloudsRaster.ts
 * into an equirect canvas that the map draws stretched.
 *
 * The raster is computed by the cloud worker (the climate-independent noise once, then one pass per
 * cloud spec) and arrives as an ImageBitmap, so set() costs the main thread nothing; `onUpdate` is
 * called when the new clouds are in the canvas (the map must redraw then). Without an `onUpdate`
 * listener (a host that cannot redraw later) set() falls back to rasterizing synchronously at a
 * lower resolution.
 *
 * Zoomed-in maps: the world raster is ~1536 px wide, so at 8× it would be stretched ~8 px per texel
 * (blurry). A host that reports its view (setView) and draws the layer through drawCopy() gets a
 * second raster of the visible window (plus a margin) at screen resolution, with every detail octave
 * the zoom resolves, computed in the worker once the view settles and drawn over the world raster
 * where it covers (the world raster alone until it lands, and outside it while panning).
 */
import type { CloudSpec } from '../core/types';
import type { CloudRasterResult } from './cloudsJobs';
import { buildCloudNoiseRaster, rasterizeClouds, type CloudNoiseRaster, type CloudRasterStats, type CloudRasterWindow } from './cloudsRaster';
import { context2d } from './mapCanvas';
import { mapMinScale, type MapTransform } from './viewMapTransform';
import { cloudWorker } from './cloudsWorkerClient';

/**
 * Raster size: about a screen's width at map zoom 1 (the second detail octave is ~1.9 px per cell;
 * ~0.3 s per cloud spec in the worker, ~0.3 s once for the static noise).
 */
const CW = 1536;
const CH = 768;
/**
 * Synchronous fallback raster size (no onUpdate listener: the host cannot redraw later), about the
 * cost of the old synchronous path (tens of ms per spec).
 */
const SYNC_W = 768;
const SYNC_H = 384;
/** Default opacity on the map: a lighter veil than the globe so the terrain stays readable. */
export const MAP_CLOUD_OPACITY = 0.8;
/** Zoom (relative to fit-the-world) from which the visible window gets its own sharp raster. */
export const MAP_CLOUD_DETAIL_ZOOM = 1.8;
/** Margin around the visible window (fraction of its size per side): small pans stay sharp. */
const DETAIL_MARGIN = 0.12;
/** Largest window raster (pixels; ~1.2 s in the worker at 4 octaves for the maximum). */
const DETAIL_MAX_PX = 2.4e6;
/** The view must rest this long before a window raster is requested (ms). */
const DETAIL_SETTLE_MS = 220;

let syncRaster: CloudNoiseRaster | null = null;
let instances = 0;

/** A window raster on screen (or requested). */
interface Detail {
  win: CloudRasterWindow;
  /** Raster pixels per radian. */
  res: number;
  canvas: HTMLCanvasElement | null;
  /** Spec sequence it was rasterized for. */
  specSeq: number;
}

export class MapClouds {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  active = false;
  /** Statistics of the last rasterization (area-weighted). */
  stats: CloudRasterStats | null = null;
  /** Called when new clouds landed in `canvas` (asynchronously after set()). */
  onUpdate: (() => void) | null;
  /** Worker compute time of the last raster (ms, diagnostics). */
  lastJobMs = 0;
  /** Worker compute time of the last window raster (ms, diagnostics). */
  lastDetailMs = 0;
  private readonly channel = `map-clouds-${++instances}`;
  private readonly detailChannel = `${this.channel}-detail`;
  private seq = 0;
  private clearedAt = 0;
  private jobs = 0;
  private detailJobs = 0;
  /** Last cloud spec and opacity (window rasters are made from them). */
  private spec: CloudSpec | null = null;
  private opacity = MAP_CLOUD_OPACITY;
  private specSeq = 0;
  /** The window raster drawn over the world raster, and the one requested. */
  private detail: Detail | null = null;
  private wanted: Detail | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(onUpdate: (() => void) | null = null) {
    this.onUpdate = onUpdate;
    this.canvas = document.createElement('canvas');
    this.canvas.width = CW;
    this.canvas.height = CH;
    this.ctx = context2d(this.canvas);
  }

  /** A raster is being computed. */
  get pending(): boolean {
    return this.jobs > 0 || this.detailJobs > 0 || this.timer !== null;
  }

  get busy(): boolean {
    return this.jobs > 0 || this.detailJobs > 0;
  }

  set(clouds: CloudSpec | null, opacity = MAP_CLOUD_OPACITY): void {
    const seq = ++this.seq;
    this.active = clouds !== null;
    if (!clouds) {
      this.clearedAt = seq;
      cloudWorker().cancel(this.channel);
      cloudWorker().cancel(this.detailChannel);
      this.spec = null;
      this.dropDetail();
      this.wanted = null;
      this.clearTimer();
      return;
    }
    if (!(clouds.w > 0 && clouds.h > 0) || clouds.cover.length < clouds.w * clouds.h) {
      throw new Error(`MapClouds: cover does not match ${clouds.w}x${clouds.h}`);
    }
    if (!this.onUpdate) {
      this.setSync(clouds, opacity);
      return;
    }
    const n = clouds.w * clouds.h;
    const spec: CloudSpec = { w: clouds.w, h: clouds.h, cover: clouds.cover.slice(0, n) };
    if (clouds.u && clouds.v && clouds.u.length >= n && clouds.v.length >= n) {
      spec.u = clouds.u.slice(0, n);
      spec.v = clouds.v.slice(0, n);
    }
    this.spec = spec;
    this.opacity = opacity;
    this.specSeq = seq;
    this.jobs++;
    void cloudWorker().run({ kind: 'raster', spec, w: CW, h: CH, opacity, time: 0 }, this.channel).then((res) => {
      this.jobs--;
      if (!res) return;
      if (seq < this.clearedAt) {
        res.bitmap?.close(); // dropped: free its backing store now, not at GC
        return;
      }
      this.paint(this.ctx, this.canvas, res);
      this.lastJobMs = res.ms;
      this.stats = res.stats;
      this.onUpdate?.();
    });
    // The window rasters follow the new clouds: the window the view is waiting for (still settling:
    // its timer requests it; already requested: re-requested), else the one on screen, which shows the
    // previous clouds until its new raster lands. (Re-requesting the on-screen window while a pan was
    // settling lost the new window: during season playback the sharp raster never followed the view.)
    const target = this.wanted ?? this.detail;
    if (target) {
      const want: Detail = { win: target.win, res: target.res, canvas: null, specSeq: seq };
      if (this.timer !== null) this.wanted = want;
      else this.requestDetail(want);
    }
  }

  /**
   * The host's current map transform (CSS px) and device pixel ratio; cheap, call it on every redraw.
   * Zoomed in beyond MAP_CLOUD_DETAIL_ZOOM, a sharp raster of the visible window is requested once the
   * view has rested DETAIL_SETTLE_MS (unless the one on screen already covers it at the resolution).
   */
  setView(t: MapTransform, dpr = 1): void {
    if (!this.active || !this.spec || !this.onUpdate) return;
    // A hidden / zero-size map has no window (its snapping grid would be 0: NaN windows).
    const ok = t.width > 0 && t.height > 0 && t.scale > 0 && Number.isFinite(t.centerLon) && Number.isFinite(t.centerLat);
    const zoom = ok ? t.scale / mapMinScale(t.width, t.height) : 0;
    if (zoom < MAP_CLOUD_DETAIL_ZOOM) {
      if (this.detail || this.wanted) {
        this.dropDetail();
        this.wanted = null;
        this.clearTimer();
        cloudWorker().cancel(this.detailChannel);
      }
      return;
    }
    // Visible window plus a margin (latitudes clamped to the poles).
    const hl = (t.width / 2 / t.scale) * (1 + 2 * DETAIL_MARGIN), hp = (t.height / 2 / t.scale) * (1 + 2 * DETAIL_MARGIN);
    const lat0 = Math.max(-Math.PI / 2, t.centerLat - hp), lat1 = Math.min(Math.PI / 2, t.centerLat + hp);
    const lon0 = t.centerLon - Math.min(hl, 0.95 * Math.PI), lon1 = t.centerLon + Math.min(hl, 0.95 * Math.PI);
    // Screen resolution (device pixels, at most 1.5 per CSS px), within the pixel budget.
    let res = t.scale * Math.min(1.5, Math.max(1, dpr));
    const area = (lon1 - lon0) * (lat1 - lat0) * res * res;
    if (area > DETAIL_MAX_PX) res *= Math.sqrt(DETAIL_MAX_PX / area);
    const need: CloudRasterWindow = { lon0, lon1, lat0, lat1 };
    const covers = (d: Detail | null): boolean => d !== null && d.specSeq === this.specSeq && d.res >= 0.85 * res && windowCovers(d.win, need);
    if (covers(this.detail)) {
      // Back inside the raster on screen: whatever was wanted for another window is moot.
      if (this.wanted) {
        this.wanted = null;
        this.clearTimer();
        cloudWorker().cancel(this.detailChannel);
      }
      return;
    }
    if (covers(this.wanted)) return;
    // Snap the window to a coarse grid of its own size (a pan by a few pixels reuses the raster).
    const q = (lat1 - lat0) / 16;
    const snap = (x: number, up: boolean): number => (up ? Math.ceil(x / q) : Math.floor(x / q)) * q;
    const win = { lon0: snap(lon0, false), lon1: snap(lon1, true), lat0: Math.max(-Math.PI / 2, snap(lat0, false)), lat1: Math.min(Math.PI / 2, snap(lat1, true)) };
    this.wanted = { win, res, canvas: null, specSeq: this.specSeq };
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.wanted) this.requestDetail(this.wanted);
    }, DETAIL_SETTLE_MS);
  }

  /**
   * Draws the clouds into world copy rectangle (x, y, w, h) (the equirect world at the host's
   * transform, in the context's current units): the world raster stretched and, where it covers, the
   * sharp window raster over it (neither outside the rectangle).
   */
  drawCopy(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    const d = this.detail;
    if (!d || !d.canvas) {
      ctx.drawImage(this.canvas, x, y, w, h);
      return;
    }
    // The window's rectangle(s) in this copy (it may cross the date line: ±1 world), edges snapped to
    // device pixels (axis-aligned transforms): the world raster's clip hole and the window raster then
    // meet exactly, instead of both covering the boundary pixel partly (a hairline seam while panning).
    const t = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
    const m = t !== null && t.b === 0 && t.c === 0 && t.a > 0 && t.d > 0 ? t : null;
    const sx = (v: number): number => (m ? (Math.round(m.a * v + m.e) - m.e) / m.a : v);
    const sy = (v: number): number => (m ? (Math.round(m.d * v + m.f) - m.f) / m.d : v);
    const rects: [number, number, number, number][] = [];
    const rx = (lon: number): number => sx(x + ((lon + Math.PI) / (2 * Math.PI)) * w);
    const ry0 = sy(y + ((Math.PI / 2 - d.win.lat1) / Math.PI) * h), ry1 = sy(y + ((Math.PI / 2 - d.win.lat0) / Math.PI) * h);
    for (const k of [-1, 0, 1]) {
      const a = rx(d.win.lon0 + 2 * Math.PI * k), b = rx(d.win.lon1 + 2 * Math.PI * k);
      if (b > x && a < x + w) rects.push([a, ry0, b - a, ry1 - ry0]);
    }
    if (rects.length === 0) {
      ctx.drawImage(this.canvas, x, y, w, h);
      return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    for (const r of rects) ctx.rect(r[0], r[1], r[2], r[3]);
    ctx.clip('evenodd');
    ctx.drawImage(this.canvas, x, y, w, h);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    // Snapped too: a window crossing the date line is split between two copies without a seam.
    const cx0 = sx(x), cy0 = sy(y);
    ctx.rect(cx0, cy0, sx(x + w) - cx0, sy(y + h) - cy0);
    ctx.clip();
    for (const r of rects) ctx.drawImage(d.canvas, r[0], r[1], r[2], r[3]);
    ctx.restore();
  }

  /** Stops pending window work and releases the rasters' canvases (late results are dropped). */
  dispose(): void {
    this.clearedAt = ++this.seq;
    this.onUpdate = null;
    this.clearTimer();
    cloudWorker().cancel(this.channel);
    cloudWorker().cancel(this.detailChannel);
    this.dropDetail();
    this.wanted = null;
    this.spec = null;
    this.active = false;
    this.canvas.width = this.canvas.height = 0;
  }

  /** Forgets the window raster on screen and frees its canvas now (not at GC). */
  private dropDetail(): void {
    if (this.detail?.canvas) this.detail.canvas.width = this.detail.canvas.height = 0;
    this.detail = null;
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private requestDetail(want: Detail): void {
    const spec = this.spec;
    if (!spec) return;
    this.wanted = want;
    const { win, res } = want;
    const w = Math.max(16, Math.round((win.lon1 - win.lon0) * res)), h = Math.max(8, Math.round((win.lat1 - win.lat0) * res));
    const seq = this.seq;
    this.detailJobs++;
    void cloudWorker().run({ kind: 'raster', spec, w, h, opacity: this.opacity, time: 0, win }, this.detailChannel).then((r) => {
      this.detailJobs--;
      if (!r) return;
      // Superseded by a request for the same window (newer clouds, e.g. season playback): still newer
      // than the screen, so shown while the newer one computes. Cleared, or for a window the view has
      // left: dropped (the bitmap freed now).
      const current = this.wanted === want;
      if (seq < this.clearedAt || !(current || (this.wanted !== null && sameWindow(this.wanted.win, win)))) {
        r.bitmap?.close();
        return;
      }
      if (this.detail && this.detail.canvas && this.detail.specSeq > want.specSeq) {
        r.bitmap?.close();
        return;
      }
      const reuse = this.detail?.canvas && this.detail.canvas.width === r.w && this.detail.canvas.height === r.h;
      const canvas = reuse ? this.detail!.canvas! : document.createElement('canvas');
      if (!reuse) this.dropDetail(); // the previous window's backing store, freed now
      canvas.width = r.w;
      canvas.height = r.h;
      this.paint(context2d(canvas), canvas, r);
      this.detail = { ...want, canvas };
      if (current) this.wanted = null;
      this.lastDetailMs = r.ms;
      this.onUpdate?.();
    });
  }

  private paint(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, res: CloudRasterResult): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (res.bitmap) {
      ctx.drawImage(res.bitmap, 0, 0, canvas.width, canvas.height);
      res.bitmap.close();
    } else {
      const img = new ImageData(res.rgba as Uint8ClampedArray<ArrayBuffer>, res.w, res.h);
      if (res.w === canvas.width && res.h === canvas.height) {
        ctx.putImageData(img, 0, 0);
      } else {
        const tmp = document.createElement('canvas');
        tmp.width = res.w;
        tmp.height = res.h;
        context2d(tmp).putImageData(img, 0, 0);
        ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
      }
    }
  }

  private setSync(clouds: CloudSpec, opacity: number): void {
    syncRaster ??= buildCloudNoiseRaster(SYNC_W, SYNC_H);
    const rgba = new Uint8ClampedArray(SYNC_W * SYNC_H * 4);
    this.stats = rasterizeClouds(syncRaster, clouds, opacity, rgba);
    this.paint(this.ctx, this.canvas, { kind: 'raster', w: SYNC_W, h: SYNC_H, rgba, stats: this.stats, ms: 0 });
  }
}

function sameWindow(a: CloudRasterWindow, b: CloudRasterWindow): boolean {
  return a.lon0 === b.lon0 && a.lon1 === b.lon1 && a.lat0 === b.lat0 && a.lat1 === b.lat1;
}

/** Window `a` contains window `b` (longitudes compared modulo 2π). */
function windowCovers(a: CloudRasterWindow, b: CloudRasterWindow): boolean {
  if (b.lat0 < a.lat0 - 1e-9 || b.lat1 > a.lat1 + 1e-9) return false;
  const k = Math.round(((a.lon0 + a.lon1) / 2 - (b.lon0 + b.lon1) / 2) / (2 * Math.PI));
  return b.lon0 + 2 * Math.PI * k >= a.lon0 - 1e-9 && b.lon1 + 2 * Math.PI * k <= a.lon1 + 1e-9;
}
