/**
 * Smooth, land-aware sampling of climate grids for the data layers:
 *  - separable cubic B-spline resampling (C² smooth, no overshoot, no bilinear creases or 1° steps),
 *  - land / ocean extension of a field (values of one surface type diffused a few cells across the
 *    climate coastline) so land pixels are coloured from land cells and sea pixels from sea cells,
 *    with the land/sea switch following the high-resolution height map instead of the 1° mask,
 *  - the height map's signed distance to the display coastline (px) for anti-aliased coasts.
 */
import type { ClimateResult } from '../core/types';
import type { PaintCache } from './paintCache';
import type { HeightField } from './terrain';

/* ------------------------------------------------------------------------------------------- */
/* Scratch buffers (painting is synchronous; slots never escape a paint call).                   */
/* ------------------------------------------------------------------------------------------- */

const scratch: Float32Array[] = [];

/** Reusable Float32 scratch buffer #slot of at least n values (contents undefined). */
export function scratchF32(slot: number, n: number): Float32Array {
  let a = scratch[slot];
  if (!a || a.length < n) {
    a = new Float32Array(n);
    scratch[slot] = a;
  }
  return a.length === n ? a : a.subarray(0, n);
}

/* ------------------------------------------------------------------------------------------- */
/* Coast signed distance                                                                         */
/* ------------------------------------------------------------------------------------------- */

/** Signed distance to the coast is stored in 1/COAST_Q px steps, clamped to ±COAST_MAX px. */
export const COAST_Q = 60;
export const COAST_MAX = 2;

const coastMemo = new WeakMap<HeightField, Map<number, Int8Array>>();

/**
 * Per pixel: signed distance (px, positive on land) from the pixel centre to the display coastline
 * (height = sea), ≈ (H − sea)/|∇H|, quantized to Int8 (value / COAST_Q px, clamped to ±COAST_MAX).
 * Land pixels (H > sea) are always ≥ 1, sea pixels ≤ 0, so the sign is exactly the land/sea rule.
 * Memoized per height field object and sea level.
 */
export function coastDistance(hf: HeightField, sea: number): Int8Array {
  let bySea = coastMemo.get(hf);
  if (!bySea) {
    bySea = new Map();
    coastMemo.set(hf, bySea);
  }
  let d = bySea.get(sea);
  if (d) return d;
  const { w, h, height } = hf;
  d = new Int8Array(w * h);
  const lim = COAST_MAX * COAST_Q;
  for (let r = 0; r < h; r++) {
    const row = r * w;
    const rowN = (r > 0 ? r - 1 : 0) * w, rowS = (r < h - 1 ? r + 1 : h - 1) * w;
    for (let c = 0; c < w; c++) {
      const p = row + c;
      const e = height[p] - sea;
      const gx = 0.5 * (height[row + (c + 1 < w ? c + 1 : 0)] - height[row + (c > 0 ? c - 1 : w - 1)]);
      const gy = 0.5 * (height[rowN + c] - height[rowS + c]);
      const g2 = gx * gx + gy * gy;
      let q: number;
      // Far from the coast (|e| ≥ COAST_MAX·|∇e|): saturate without a square root.
      if (e * e >= COAST_MAX * COAST_MAX * g2) q = e > 0 ? lim : -lim;
      else {
        q = Math.round((e / Math.sqrt(g2)) * COAST_Q);
        q = q > lim ? lim : q < -lim ? -lim : q;
      }
      if (e > 0) { if (q < 1) q = 1; } else if (q > 0) q = 0;
      d[p] = q;
    }
  }
  bySea.set(sea, d);
  return d;
}

/** Land coverage 0..1 of a pixel from its quantized coast distance (box-filter approximation). */
export function coverageOf(q: number): number {
  const a = 0.5 + q / COAST_Q;
  return a <= 0 ? 0 : a >= 1 ? 1 : a;
}

/* ------------------------------------------------------------------------------------------- */
/* Land / ocean extension                                                                        */
/* ------------------------------------------------------------------------------------------- */

/** Number of cell rings a surface type's values are diffused across the climate coastline. */
export const EXTEND_RINGS = 3;

/**
 * Copy of `src` (cw×ch, lon wraps) where cells with keep[i] ≠ want keep their value if they lie
 * within `rings` cells of a kept cell: they are replaced ring by ring by the weighted mean of their
 * already-known 8-neighbours. Cells further away keep the source value (e.g. an island pixel far
 * out at sea uses the local sea cell's own climate). Writes into `out` (may not alias src).
 */
export function extendField(
  src: Float32Array, cw: number, ch: number, keep: Uint8Array, want: number, rings: number, out: Float32Array, known: Uint8Array,
): Float32Array {
  const N = cw * ch;
  out.set(src.subarray(0, N));
  let any = false;
  for (let i = 0; i < N; i++) {
    const k = keep[i] === want ? 1 : 0;
    known[i] = k;
    if (!k) any = true;
  }
  if (!any) return out;
  const next = scratchF32(15, N);
  const stamp = scratchI32(N);
  for (let ring = 1; ring <= rings; ring++) {
    let n = 0;
    for (let r = 0; r < ch; r++) {
      const rN = r > 0 ? r - 1 : 0, rS = r < ch - 1 ? r + 1 : ch - 1;
      for (let c = 0; c < cw; c++) {
        const i = r * cw + c;
        if (known[i]) continue;
        const cL = c > 0 ? c - 1 : cw - 1, cR = c + 1 < cw ? c + 1 : 0;
        let s = 0, ws = 0, j: number;
        j = r * cw + cL; if (known[j]) { s += out[j]; ws += 1; }
        j = r * cw + cR; if (known[j]) { s += out[j]; ws += 1; }
        j = rN * cw + c; if (known[j] && rN !== r) { s += out[j]; ws += 1; }
        j = rS * cw + c; if (known[j] && rS !== r) { s += out[j]; ws += 1; }
        j = rN * cw + cL; if (known[j] && rN !== r) { s += 0.7 * out[j]; ws += 0.7; }
        j = rN * cw + cR; if (known[j] && rN !== r) { s += 0.7 * out[j]; ws += 0.7; }
        j = rS * cw + cL; if (known[j] && rS !== r) { s += 0.7 * out[j]; ws += 0.7; }
        j = rS * cw + cR; if (known[j] && rS !== r) { s += 0.7 * out[j]; ws += 0.7; }
        if (ws > 0) {
          next[n] = s / ws;
          stamp[n++] = i;
        }
      }
    }
    if (n === 0) break;
    for (let q = 0; q < n; q++) {
      out[stamp[q]] = next[q];
      known[stamp[q]] = 1;
    }
  }
  return out;
}

let scratchInt: Int32Array | null = null;
function scratchI32(n: number): Int32Array {
  if (!scratchInt || scratchInt.length < n) scratchInt = new Int32Array(n);
  return scratchInt;
}

let knownScratch: Uint8Array | null = null;
function knownBuf(n: number): Uint8Array {
  if (!knownScratch || knownScratch.length < n) knownScratch = new Uint8Array(n);
  return knownScratch;
}

/** Drops this module's scratch buffers (between paint calls only); returns the bytes released. */
export function releaseSampleScratch(): number {
  let bytes = (scratchInt?.byteLength ?? 0) + (knownScratch?.byteLength ?? 0);
  for (const b of scratch) bytes += b ? b.byteLength : 0;
  scratch.length = 0;
  scratchInt = null;
  knownScratch = null;
  return bytes;
}

/** Month slice (0..11) of a monthly field, or its annual mean (month < 0; `annual` if given). */
export function monthSlice(field: Float32Array, N: number, month: number, annual?: Float32Array, slot = 14): Float32Array {
  if (field.length === N) return field;
  if (month >= 0) return field.subarray(month * N, (month + 1) * N);
  if (annual) return annual;
  const out = scratchF32(slot, N);
  out.fill(0);
  for (let m = 0; m < 12; m++) {
    const o = m * N;
    for (let i = 0; i < N; i++) out[i] += field[o + i];
  }
  for (let i = 0; i < N; i++) out[i] /= 12;
  return out;
}

/**
 * The field extended from the climate's land cells (surface = 1) or sea cells (surface = 0) into
 * `out` (N values).
 */
export function surfaceField(c: ClimateResult, src: Float32Array, surface: 0 | 1, out: Float32Array): Float32Array {
  return extendField(src, c.w, c.h, c.land, surface, EXTEND_RINGS, out, knownBuf(c.w * c.h));
}

/* ------------------------------------------------------------------------------------------- */
/* Cubic B-spline resampling                                                                     */
/* ------------------------------------------------------------------------------------------- */

/** Per output column / row: first source index of the 4-tap support and the 4 weights. */
interface SplineTables {
  /** 4 column indices per output column (lon wraps). */
  ci: Int32Array;
  cwt: Float32Array;
  /** 4 row offsets (row·cw… no: row indices) per output row (clamped at the poles). */
  ri: Int32Array;
  rwt: Float32Array;
}

function bsplineWeights(t: number, out: Float32Array, o: number): void {
  const t2 = t * t, t3 = t2 * t, u = 1 - t;
  out[o] = (u * u * u) / 6;
  out[o + 1] = (3 * t3 - 6 * t2 + 4) / 6;
  out[o + 2] = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6;
  out[o + 3] = t3 / 6;
}

export function splineTables(w: number, h: number, cw: number, ch: number, cache: PaintCache): SplineTables {
  return cache.getOrBuild(`splinetab|${w}x${h}|${cw}x${ch}`, () => {
    const ci = new Int32Array(4 * w), cwt = new Float32Array(4 * w);
    for (let c = 0; c < w; c++) {
      const x = ((c + 0.5) * cw) / w - 0.5;
      const i = Math.floor(x);
      bsplineWeights(x - i, cwt, 4 * c);
      for (let k = 0; k < 4; k++) ci[4 * c + k] = (((i - 1 + k) % cw) + cw) % cw;
    }
    const ri = new Int32Array(4 * h), rwt = new Float32Array(4 * h);
    for (let r = 0; r < h; r++) {
      const y = ((r + 0.5) * ch) / h - 0.5;
      const j = Math.floor(y);
      bsplineWeights(y - j, rwt, 4 * r);
      for (let k = 0; k < 4; k++) ri[4 * r + k] = Math.min(ch - 1, Math.max(0, j - 1 + k));
    }
    return { ci, cwt, ri, rwt };
  });
}

/**
 * Cubic B-spline resampling of a cw×ch grid (row 0 north, lon wraps, rows clamp) onto a w×h
 * raster, written into `out`. Separable: one horizontal pass over the source rows, one vertical pass.
 */
export function splineSample(src: Float32Array, cw: number, ch: number, w: number, h: number, out: Float32Array, cache: PaintCache): Float32Array {
  const { ci, cwt, ri, rwt } = splineTables(w, h, cw, ch, cache);
  const tmp = scratchF32(13, ch * w);
  for (let j = 0; j < ch; j++) {
    const s = j * cw, t = j * w;
    for (let c = 0, k = 0; c < w; c++, k += 4) {
      tmp[t + c] = cwt[k] * src[s + ci[k]] + cwt[k + 1] * src[s + ci[k + 1]] + cwt[k + 2] * src[s + ci[k + 2]] + cwt[k + 3] * src[s + ci[k + 3]];
    }
  }
  for (let r = 0, k = 0; r < h; r++, k += 4) {
    const a = ri[k] * w, b = ri[k + 1] * w, cc = ri[k + 2] * w, d = ri[k + 3] * w;
    const wa = rwt[k], wb = rwt[k + 1], wc = rwt[k + 2], wd = rwt[k + 3];
    const o = r * w;
    for (let c = 0; c < w; c++) out[o + c] = wa * tmp[a + c] + wb * tmp[b + c] + wc * tmp[cc + c] + wd * tmp[d + c];
  }
  return out;
}

/**
 * Land-aware smooth sample of a climate field: `land` receives the land-extended field and `sea`
 * the sea-extended field (either may be null to skip it), both B-spline resampled to w×h.
 */
export function sampleSurfaces(
  c: ClimateResult, src: Float32Array, w: number, h: number, land: Float32Array | null, sea: Float32Array | null, cache: PaintCache,
): void {
  const N = c.w * c.h;
  const ext = scratchF32(12, N);
  if (land) splineSample(surfaceField(c, src, 1, ext), c.w, c.h, w, h, land, cache);
  if (sea) splineSample(surfaceField(c, src, 0, ext), c.w, c.h, w, h, sea, cache);
}
