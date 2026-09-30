/**
 * Translucent static clouds for the 2D map: the globe's weather model (coverage-driven, domain-warped
 * multi-octave noise, regimes, cirrus, storm-track cyclones) rasterized by cloudsRaster.ts into an
 * equirect canvas that the map draws stretched.
 *
 * The raster is computed by the cloud worker (the climate-independent noise once, then one pass per
 * cloud spec) and arrives as an ImageBitmap, so set() costs the main thread nothing; `onUpdate` is
 * called when the new clouds are in the canvas (the map must redraw then). Without an `onUpdate`
 * listener (a host that cannot redraw later) set() falls back to rasterizing synchronously at a
 * lower resolution.
 */
import type { CloudSpec } from '../core/types';
import type { CloudRasterResult } from './cloudsJobs';
import { buildCloudNoiseRaster, rasterizeClouds, type CloudNoiseRaster, type CloudRasterStats } from './cloudsRaster';
import { context2d } from './mapCanvas';
import { cloudWorker } from './cloudsWorkerClient';

/**
 * Raster size: about a screen's width at map zoom 1 (the second detail octave is ~1.9 px per cell;
 * ~0.2 s per cloud spec in the worker, ~0.3 s once for the static noise).
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

let syncRaster: CloudNoiseRaster | null = null;
let instances = 0;

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
  private readonly channel = `map-clouds-${++instances}`;
  private seq = 0;
  private clearedAt = 0;
  private jobs = 0;

  constructor(onUpdate: (() => void) | null = null) {
    this.onUpdate = onUpdate;
    this.canvas = document.createElement('canvas');
    this.canvas.width = CW;
    this.canvas.height = CH;
    this.ctx = context2d(this.canvas);
  }

  /** A raster is being computed. */
  get pending(): boolean {
    return this.jobs > 0;
  }

  get busy(): boolean {
    return this.jobs > 0;
  }

  set(clouds: CloudSpec | null, opacity = MAP_CLOUD_OPACITY): void {
    const seq = ++this.seq;
    this.active = clouds !== null;
    if (!clouds) {
      this.clearedAt = seq;
      cloudWorker().cancel(this.channel);
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
    this.jobs++;
    void cloudWorker().run({ kind: 'raster', spec, w: CW, h: CH, opacity, time: 0 }, this.channel).then((res) => {
      this.jobs--;
      if (!res) return;
      if (seq < this.clearedAt) {
        res.bitmap?.close(); // dropped: free its backing store now, not at GC
        return;
      }
      this.draw(res);
      this.lastJobMs = res.ms;
      this.stats = res.stats;
      this.onUpdate?.();
    });
  }

  private draw(res: CloudRasterResult): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (res.bitmap) {
      ctx.drawImage(res.bitmap, 0, 0, this.canvas.width, this.canvas.height);
      res.bitmap.close();
    } else {
      const img = new ImageData(res.rgba as Uint8ClampedArray<ArrayBuffer>, res.w, res.h);
      if (res.w === this.canvas.width && res.h === this.canvas.height) {
        ctx.putImageData(img, 0, 0);
      } else {
        const tmp = document.createElement('canvas');
        tmp.width = res.w;
        tmp.height = res.h;
        context2d(tmp).putImageData(img, 0, 0);
        ctx.drawImage(tmp, 0, 0, this.canvas.width, this.canvas.height);
      }
    }
  }

  private setSync(clouds: CloudSpec, opacity: number): void {
    syncRaster ??= buildCloudNoiseRaster(SYNC_W, SYNC_H);
    const rgba = new Uint8ClampedArray(SYNC_W * SYNC_H * 4);
    this.stats = rasterizeClouds(syncRaster, clouds, opacity, rgba);
    this.draw({ kind: 'raster', w: SYNC_W, h: SYNC_H, rgba, stats: this.stats, ms: 0 });
  }
}
