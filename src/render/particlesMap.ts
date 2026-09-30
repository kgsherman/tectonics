/**
 * Map particle trails on a 2D canvas using the classic fade technique: each frame the canvas alpha
 * is multiplied by FADE and the new prev→pos segments are stroked, batched by speed color bucket.
 * Segments across the antimeridian (|Δlon| > π) and polar streaks are dropped. A float16 canvas is
 * used when available so faded trails decay to zero instead of leaving 8-bit residue.
 */
import { particleRamp, type ParticleSystem } from './particles';
import type { MapTransform } from './viewMapTransform';

/** Trail alpha kept per 1/60 s (applied as FADE^(60·dt), so trails look the same at any refresh rate). */
const FADE = 0.9;
const BUCKETS = 8;
/** Longitude jumps above this (radians) are not drawn (antimeridian crossings, polar streaks). */
const MAX_DLON = 0.5;

export class MapParticles {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  readonly floatBacked: boolean;
  private readonly colors: string[];
  private bucketOf = new Uint8Array(0);

  constructor() {
    this.canvas = document.createElement('canvas');
    const settings = { colorType: 'float16' } as CanvasRenderingContext2DSettings;
    const ctx = this.canvas.getContext('2d', settings) ?? this.canvas.getContext('2d');
    if (!ctx) throw new Error('MapParticles: 2D canvas unavailable');
    this.ctx = ctx;
    const attrs = ctx.getContextAttributes() as CanvasRenderingContext2DSettings & { colorType?: string };
    this.floatBacked = attrs.colorType === 'float16';
    this.colors = [];
    for (let b = 0; b < BUCKETS; b++) {
      const c = particleRamp((b + 0.5) / BUCKETS);
      this.colors.push(`rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},0.92)`);
    }
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * dpr));
    this.clear();
  }

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Fades existing trails by `dt` seconds and draws the latest step of `ps` under transform `t`. */
  draw(ps: ParticleSystem, t: MapTransform, dpr: number, dt = 1 / 60): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const keep = Math.pow(FADE, Math.max(0, dt) * 60);
    if (keep < 1) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = `rgba(0,0,0,${keep.toFixed(4)})`;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // One device pixel with butt caps hits Skia's hairline fast path (~7x cheaper than 1.1 px
    // round-capped strokes for 8k segments); HiDPI screens get a slightly heavier line.
    ctx.lineWidth = (dpr < 1.5 ? 1 : 1.6) / dpr;
    ctx.lineCap = 'butt';

    const n = ps.count;
    if (this.bucketOf.length !== n) this.bucketOf = new Uint8Array(n);
    const inv = 1 / ps.style.colorMax;
    for (let i = 0; i < n; i++) {
      const b = Math.floor(ps.speed[i] * inv * BUCKETS);
      this.bucketOf[i] = b < 0 ? 0 : b >= BUCKETS ? BUCKETS - 1 : b;
    }
    const worldW = 2 * Math.PI * t.scale;
    const { pos, prev, alive, respawned } = ps;
    const halfW = t.width / 2, halfH = t.height / 2;
    for (let b = 0; b < BUCKETS; b++) {
      ctx.beginPath();
      let any = false;
      for (let i = 0; i < n; i++) {
        if (this.bucketOf[i] !== b || !alive[i] || respawned[i]) continue;
        const o = 3 * i;
        const lat0 = Math.asin(Math.max(-1, Math.min(1, prev[o + 2])));
        const lon0 = Math.atan2(prev[o + 1], prev[o]);
        const lat1 = Math.asin(Math.max(-1, Math.min(1, pos[o + 2])));
        const lon1 = Math.atan2(pos[o + 1], pos[o]);
        const dLon = lon1 - lon0;
        if (dLon > MAX_DLON || dLon < -MAX_DLON) continue;
        const lu = lon0 + 2 * Math.PI * Math.round((t.centerLon - lon0) / (2 * Math.PI));
        const x0 = halfW + (lu - t.centerLon) * t.scale;
        const y0 = halfH - (lat0 - t.centerLat) * t.scale;
        const x1 = x0 + dLon * t.scale;
        const y1 = halfH - (lat1 - t.centerLat) * t.scale;
        if ((y0 < 0 && y1 < 0) || (y0 > t.height && y1 > t.height)) continue;
        // Every horizontal repeat of the world that shows this segment.
        const mMin = Math.ceil(-Math.max(x0, x1) / worldW);
        const mMax = Math.floor((t.width - Math.min(x0, x1)) / worldW);
        for (let m = mMin; m <= mMax; m++) {
          const ox = m * worldW;
          ctx.moveTo(x0 + ox, y0);
          ctx.lineTo(x1 + ox, y1);
          any = true;
        }
      }
      if (any) {
        ctx.strokeStyle = this.colors[b];
        ctx.stroke();
      }
    }
  }
}
