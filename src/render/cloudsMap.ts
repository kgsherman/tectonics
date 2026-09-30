/**
 * Translucent static clouds for the 2D map: the cover field thresholded against a fixed fbm noise
 * field (built once per view, lazily), rasterized into a small canvas that is drawn stretched.
 */
import { createNoise3, fbm3 } from '../core/noise';
import type { CloudSpec } from '../core/types';
import { context2d } from './mapCanvas';
import { cloudAlpha } from './mapShading';

const CW = 512;
const CH = 256;
const NOISE_FREQ = 4.2;

/** fbm over the sphere converted to an approximately uniform [0, 1] variable (logistic ≈ normal CDF). */
function uniformNoise(w: number, h: number): Float32Array {
  const n = createNoise3(0xc10d);
  const raw = new Float32Array(w * h);
  let sum = 0, sum2 = 0;
  for (let r = 0; r < h; r++) {
    const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
    const cl = Math.cos(lat), z = Math.sin(lat) * NOISE_FREQ;
    for (let c = 0; c < w; c++) {
      const lon = -Math.PI + ((c + 0.5) * 2 * Math.PI) / w;
      const v = fbm3(n, cl * Math.cos(lon) * NOISE_FREQ, cl * Math.sin(lon) * NOISE_FREQ, z, 4);
      raw[r * w + c] = v;
      sum += v;
      sum2 += v * v;
    }
  }
  const mean = sum / (w * h);
  const sd = Math.sqrt(Math.max(1e-12, sum2 / (w * h) - mean * mean));
  for (let i = 0; i < w * h; i++) raw[i] = 1 / (1 + Math.exp((-1.702 * (raw[i] - mean)) / sd));
  return raw;
}

export class MapClouds {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private noise: Float32Array | null = null;
  private image: ImageData | null = null;
  active = false;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CW;
    this.canvas.height = CH;
    this.ctx = context2d(this.canvas);
  }

  set(clouds: CloudSpec | null, opacity = 0.85): void {
    this.active = clouds !== null;
    if (!clouds) return;
    if (!(clouds.w > 0 && clouds.h > 0) || clouds.cover.length < clouds.w * clouds.h) {
      throw new Error(`MapClouds: cover does not match ${clouds.w}x${clouds.h}`);
    }
    this.noise ??= uniformNoise(CW, CH);
    this.image ??= this.ctx.createImageData(CW, CH);
    cloudAlpha(clouds.cover, clouds.w, clouds.h, this.noise, CW, CH, opacity, this.image.data);
    this.ctx.putImageData(this.image, 0, 0);
  }
}
