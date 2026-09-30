/**
 * Translucent static clouds for the 2D map: the globe's weather model (coverage-driven, domain-warped
 * noise, regimes, storm-track cyclones) rasterized by cloudsRaster.ts into an equirect canvas that the
 * map draws stretched. The climate-independent noise is built once (lazily); each set() only re-runs
 * the cheap per-pixel pass.
 */
import type { CloudSpec } from '../core/types';
import { context2d } from './mapCanvas';
import { buildCloudNoiseRaster, rasterizeClouds, type CloudNoiseRaster, type CloudRasterStats } from './cloudsRaster';

const CW = 1024;
const CH = 512;
/** Default opacity on the map: a lighter veil than the globe so the terrain stays readable. */
export const MAP_CLOUD_OPACITY = 0.8;

let sharedRaster: CloudNoiseRaster | null = null;

export class MapClouds {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private image: ImageData | null = null;
  active = false;
  /** Statistics of the last rasterization (area-weighted). */
  stats: CloudRasterStats | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CW;
    this.canvas.height = CH;
    this.ctx = context2d(this.canvas);
  }

  set(clouds: CloudSpec | null, opacity = MAP_CLOUD_OPACITY): void {
    this.active = clouds !== null;
    if (!clouds) return;
    if (!(clouds.w > 0 && clouds.h > 0) || clouds.cover.length < clouds.w * clouds.h) {
      throw new Error(`MapClouds: cover does not match ${clouds.w}x${clouds.h}`);
    }
    sharedRaster ??= buildCloudNoiseRaster(CW, CH);
    this.image ??= this.ctx.createImageData(CW, CH);
    this.stats = rasterizeClouds(sharedRaster, clouds, opacity, this.image.data);
    this.ctx.putImageData(this.image, 0, 0);
  }
}
