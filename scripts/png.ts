/**
 * Minimal PNG/image helpers for the headless tools (Node only).
 * Images are equirectangular RGBA, row 0 = north, 4 bytes per pixel.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';
import type { RGB } from '../src/core/types';

export interface Image {
  width: number;
  height: number;
  rgba: Uint8ClampedArray | Uint8Array;
}

/** A colormap: ascending [value, color] stops, linearly interpolated, clamped at the ends. */
export type ColorStops = ReadonlyArray<readonly [number, RGB]>;

export function createImage(width: number, height: number, fill: RGB = [0, 0, 0]): Image {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[4 * i] = fill[0];
    rgba[4 * i + 1] = fill[1];
    rgba[4 * i + 2] = fill[2];
    rgba[4 * i + 3] = 255;
  }
  return { width, height, rgba };
}

/** Write an RGBA image as PNG (creates parent directories). */
export function writePng(path: string, img: Image): void {
  const { width, height, rgba } = img;
  if (rgba.length !== width * height * 4) throw new Error(`writePng: buffer size ${rgba.length} != ${width}x${height}x4`);
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PNG.sync.write(png));
}

/** Interpolate a color from stops. Non-finite values map to magenta so bugs are visible. */
export function colorAt(stops: ColorStops, v: number, out: number[] = [0, 0, 0]): number[] {
  if (!Number.isFinite(v)) {
    out[0] = 255; out[1] = 0; out[2] = 255;
    return out;
  }
  if (v <= stops[0][0]) {
    const c = stops[0][1];
    out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
    return out;
  }
  for (let k = 1; k < stops.length; k++) {
    if (v <= stops[k][0]) {
      const [v0, c0] = stops[k - 1];
      const [v1, c1] = stops[k];
      const t = v1 > v0 ? (v - v0) / (v1 - v0) : 0;
      out[0] = c0[0] + (c1[0] - c0[0]) * t;
      out[1] = c0[1] + (c1[1] - c0[1]) * t;
      out[2] = c0[2] + (c1[2] - c0[2]) * t;
      return out;
    }
  }
  const c = stops[stops.length - 1][1];
  out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
  return out;
}

/** Map a w×h scalar field through a colormap. `transform` (e.g. log) is applied before lookup. */
export function colormapImage(field: ArrayLike<number>, w: number, h: number, stops: ColorStops, transform?: (v: number) => number): Image {
  const img = createImage(w, h);
  const c = [0, 0, 0];
  for (let i = 0; i < w * h; i++) {
    colorAt(stops, transform ? transform(field[i]) : field[i], c);
    img.rgba[4 * i] = c[0];
    img.rgba[4 * i + 1] = c[1];
    img.rgba[4 * i + 2] = c[2];
  }
  return img;
}

/** Grayscale image of a field scaled from [min, max] to [0, 255]. */
export function grayscaleImage(field: ArrayLike<number>, w: number, h: number, min: number, max: number): Image {
  return colormapImage(field, w, h, [[min, [0, 0, 0]], [max, [255, 255, 255]]]);
}

/** Per-cell categorical colors (e.g. Köppen ids → class colors). */
export function categoricalImage(ids: ArrayLike<number>, w: number, h: number, palette: (id: number) => RGB): Image {
  const img = createImage(w, h);
  for (let i = 0; i < w * h; i++) {
    const c = palette(ids[i]);
    img.rgba[4 * i] = c[0];
    img.rgba[4 * i + 1] = c[1];
    img.rgba[4 * i + 2] = c[2];
  }
  return img;
}

/** Nearest-neighbour upscale by an integer factor (small climate grids are easier to inspect). */
export function upscale(img: Image, k: number): Image {
  if (k <= 1) return img;
  const W = img.width * k, H = img.height * k;
  const out = createImage(W, H);
  for (let y = 0; y < H; y++) {
    const sy = Math.floor(y / k);
    for (let x = 0; x < W; x++) {
      const s = 4 * (sy * img.width + Math.floor(x / k));
      const d = 4 * (y * W + x);
      out.rgba[d] = img.rgba[s];
      out.rgba[d + 1] = img.rgba[s + 1];
      out.rgba[d + 2] = img.rgba[s + 2];
      out.rgba[d + 3] = 255;
    }
  }
  return out;
}

/** Blend a color into one pixel (alpha 0..1), with longitude wrap and latitude clipping. */
export function blendPixel(img: Image, x: number, y: number, c: RGB, alpha = 1): void {
  const W = img.width;
  const xi = ((Math.round(x) % W) + W) % W;
  const yi = Math.round(y);
  if (yi < 0 || yi >= img.height) return;
  const p = 4 * (yi * W + xi);
  img.rgba[p] += (c[0] - img.rgba[p]) * alpha;
  img.rgba[p + 1] += (c[1] - img.rgba[p + 1]) * alpha;
  img.rgba[p + 2] += (c[2] - img.rgba[p + 2]) * alpha;
}

/** Filled disc marker at (lat, lon) degrees with a dark outline. */
export function drawMarker(img: Image, latDeg: number, lonDeg: number, radius: number, c: RGB): void {
  const x = ((lonDeg + 180) / 360) * img.width - 0.5;
  const y = ((90 - latDeg) / 180) * img.height - 0.5;
  const R = radius + 1;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot(dx, dy);
      if (d <= radius) blendPixel(img, x + dx, y + dy, c);
      else if (d <= R) blendPixel(img, x + dx, y + dy, [0, 0, 0], 0.8);
    }
  }
}

/** Anti-aliasing-free line (DDA), wrapping in x. */
export function drawLine(img: Image, x0: number, y0: number, x1: number, y1: number, c: RGB, alpha = 1): void {
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    blendPixel(img, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, c, alpha);
  }
}

/**
 * Vector-field arrows on an image whose pixels map onto a gw×gh grid (u east, v north, m/s).
 * One arrow every `step` grid cells; length = speed × `pxPerUnit` pixels (capped at 1.6 steps).
 * Cells where `skip(i)` is true are omitted.
 */
export function drawArrows(
  img: Image, gw: number, gh: number, u: ArrayLike<number>, v: ArrayLike<number>,
  step: number, pxPerUnit: number, c: RGB, skip?: (i: number) => boolean,
): void {
  const sx = img.width / gw, sy = img.height / gh;
  const maxLen = 1.6 * step * Math.min(sx, sy);
  for (let r = Math.floor(step / 2); r < gh; r += step) {
    for (let col = Math.floor(step / 2); col < gw; col += step) {
      const i = r * gw + col;
      if (skip?.(i)) continue;
      const uu = u[i], vv = v[i];
      if (!Number.isFinite(uu) || !Number.isFinite(vv)) continue;
      const sp = Math.hypot(uu, vv);
      if (sp < 1e-6) continue;
      const len = Math.min(maxLen, sp * pxPerUnit);
      const x0 = (col + 0.5) * sx, y0 = (r + 0.5) * sy;
      const dx = (uu / sp) * len, dy = (-vv / sp) * len;
      const x1 = x0 + dx, y1 = y0 + dy;
      drawLine(img, x0, y0, x1, y1, c);
      // Arrow head: two short barbs at ±150°.
      const hl = Math.max(2, len * 0.35);
      const ang = Math.atan2(dy, dx);
      for (const a of [ang + 2.6, ang - 2.6]) drawLine(img, x1, y1, x1 + Math.cos(a) * hl, y1 + Math.sin(a) * hl, c);
    }
  }
}

/** Darken pixels on the boundary between land and ocean cells of a w×h mask drawn at k× scale. */
export function drawCoastlines(img: Image, land: ArrayLike<number>, w: number, h: number, c: RGB = [20, 20, 20], alpha = 0.85): void {
  const sx = img.width / w, sy = img.height / h;
  for (let y = 0; y < img.height; y++) {
    const r = Math.min(h - 1, Math.floor(y / sy));
    for (let x = 0; x < img.width; x++) {
      const col = Math.min(w - 1, Math.floor(x / sx));
      const i = r * w + col;
      const me = land[i] ? 1 : 0;
      const xr = Math.min(w - 1, Math.floor((x + 1) / sx)) % w;
      const yd = Math.min(h - 1, Math.floor((y + 1) / sy));
      const right = land[r * w + xr] ? 1 : 0;
      const down = land[yd * w + col] ? 1 : 0;
      if (right !== me || down !== me) blendPixel(img, x, y, c, alpha);
    }
  }
}

/* ------------------------------ colormaps ------------------------------ */

/** Hypsometric tints: bathymetry blues, lowland greens, highland browns, ice white (meters). */
export const ELEVATION_STOPS: ColorStops = [
  [-8000, [8, 20, 60]], [-5000, [18, 45, 110]], [-3000, [30, 75, 150]], [-1000, [60, 120, 190]],
  [-200, [110, 170, 220]], [-1, [160, 205, 235]], [0, [70, 130, 70]], [200, [110, 160, 90]],
  [600, [190, 190, 120]], [1200, [185, 150, 95]], [2000, [150, 110, 75]], [3000, [130, 100, 90]],
  [4500, [175, 165, 160]], [6000, [250, 250, 250]],
];

/** Air/sea temperature (°C). */
export const TEMPERATURE_STOPS: ColorStops = [
  [-50, [60, 0, 90]], [-30, [80, 40, 170]], [-15, [60, 100, 220]], [0, [150, 210, 245]],
  [10, [120, 200, 120]], [20, [250, 220, 90]], [28, [240, 120, 40]], [38, [160, 20, 20]],
];

/** Precipitation, applied to log10(mm/yr). */
export const PRECIP_LOG_STOPS: ColorStops = [
  [1, [140, 70, 20]], [2, [200, 150, 80]], [2.5, [235, 220, 150]], [2.8, [170, 220, 140]],
  [3, [80, 180, 120]], [3.3, [40, 130, 190]], [3.6, [30, 60, 160]], [4, [60, 20, 110]],
];

/** Speed (m/s) for winds / currents. */
export const SPEED_STOPS: ColorStops = [
  [0, [20, 20, 40]], [0.25, [40, 60, 130]], [0.5, [40, 120, 170]], [1, [80, 190, 150]],
  [1.5, [220, 220, 80]], [2.5, [240, 120, 40]],
];

/** Pressure (hPa). */
export const PRESSURE_STOPS: ColorStops = [
  [985, [60, 30, 120]], [1000, [60, 110, 200]], [1010, [180, 220, 240]], [1015, [245, 235, 200]],
  [1022, [240, 150, 70]], [1035, [150, 30, 30]],
];

/** Diverging (e.g. model − observed), symmetric around 0 with half-range `a`. */
export function divergingStops(a: number): ColorStops {
  return [[-a, [40, 60, 170]], [-a / 3, [140, 170, 230]], [0, [245, 245, 245]], [a / 3, [240, 160, 130]], [a, [170, 30, 30]]];
}
