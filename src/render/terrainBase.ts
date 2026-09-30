/**
 * Smooth display base for the height map: Laplacian smoothing on the mesh, barycentric
 * interpolation to the raster, then a separable metric-correct Gaussian (removes TIN facets).
 */
import type { SphereMesh } from '../core/types';

/**
 * Jacobi Laplacian smoothing on the mesh graph: e ← (1−λ)·e + λ·mean(neighbours), `iterations` times.
 * Returns a new array (input untouched).
 */
export function smoothMeshField(mesh: SphereMesh, field: ArrayLike<number>, iterations: number, lambda: number): Float32Array {
  const { n, adjOffset, adj } = mesh;
  let cur = Float32Array.from(field as ArrayLike<number>);
  let next = new Float32Array(n);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      const s = adjOffset[i], e = adjOffset[i + 1];
      let sum = 0;
      for (let k = s; k < e; k++) sum += cur[adj[k]];
      const mean = e > s ? sum / (e - s) : cur[i];
      next[i] = cur[i] + lambda * (mean - cur[i]);
    }
    const t = cur;
    cur = next;
    next = t;
  }
  return cur;
}

/** Discrete box kernel of real radius r: weight 1 for |k| ≤ ⌊r⌋, frac(r) for |k| = ⌊r⌋+1. */
function boxVariance(r: number): number {
  const ri = Math.floor(r), fr = r - ri;
  // Σ_{|k|≤ri} k² = ri(ri+1)(2ri+1)/3
  const num = (ri * (ri + 1) * (2 * ri + 1)) / 3 + 2 * fr * (ri + 1) * (ri + 1);
  return num / (2 * ri + 1 + 2 * fr);
}

/** Real box radius whose kernel variance is `v` (monotone; bisection). */
export function boxRadiusForVariance(v: number): number {
  if (!(v > 0)) return 0;
  let lo = 0, hi = Math.max(1, Math.sqrt(3 * v) + 1);
  while (boxVariance(hi) < v) hi *= 2;
  for (let k = 0; k < 40; k++) {
    const mid = 0.5 * (lo + hi);
    if (boxVariance(mid) < v) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

const BOX_PASSES = 3;

/** One periodic horizontal box pass of real radius r over `src` row → `dst` row (length w). */
function boxRowPeriodic(src: Float32Array, so: number, dst: Float32Array, w: number, r: number, pad: Float32Array): void {
  const ri = Math.floor(r), fr = r - ri;
  const ext = ri + 1;
  if (2 * ext + 1 > w) {
    let s = 0;
    for (let c = 0; c < w; c++) s += src[so + c];
    const m = s / w;
    for (let c = 0; c < w; c++) dst[so + c] = m;
    return;
  }
  // pad[j] = src[(j − ext) mod w], j ∈ [0, w + 2·ext)
  for (let j = 0; j < ext; j++) pad[j] = src[so + w - ext + j];
  for (let c = 0; c < w; c++) pad[ext + c] = src[so + c];
  for (let j = 0; j < ext; j++) pad[ext + w + j] = src[so + j];
  const inv = 1 / (2 * ri + 1 + 2 * fr);
  let s = 0;
  for (let k = -ri; k <= ri; k++) s += pad[ext + k];
  for (let c = 0; c < w; c++) {
    const j = ext + c;
    dst[so + c] = (s + fr * (pad[j - ri - 1] + pad[j + ri + 1])) * inv;
    s += pad[j + ri + 1] - pad[j - ri];
  }
}

/** One vertical box pass (rows clamped at the poles) of real radius r, all columns at once. */
function boxColumns(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, acc: Float64Array): void {
  const ri = Math.floor(r), fr = r - ri;
  const inv = 1 / (2 * ri + 1 + 2 * fr);
  const clampRow = (q: number) => (q < 0 ? 0 : q >= h ? h - 1 : q) * w;
  acc.fill(0, 0, w);
  for (let k = -ri; k <= ri; k++) {
    const o = clampRow(k);
    for (let c = 0; c < w; c++) acc[c] += src[o + c];
  }
  for (let row = 0; row < h; row++) {
    const oa = clampRow(row - ri - 1), ob = clampRow(row + ri + 1), od = row * w;
    for (let c = 0; c < w; c++) dst[od + c] = (acc[c] + fr * (src[oa + c] + src[ob + c])) * inv;
    const oadd = clampRow(row + ri + 1), osub = clampRow(row - ri);
    for (let c = 0; c < w; c++) acc[c] += src[oadd + c] - src[osub + c];
  }
}

const scratch: Float32Array[] = [];

/**
 * Reusable scratch buffer #slot of at least n floats (painting is single-threaded per worker; the
 * content is only valid until the next call with the same slot). Avoids per-frame allocations.
 */
export function scratchFloat32(slot: number, n: number): Float32Array {
  let b = scratch[slot];
  if (!b || b.length < n) {
    b = new Float32Array(n);
    scratch[slot] = b;
  }
  return b.length === n ? b : b.subarray(0, n);
}

const scratchU8: Uint8Array[] = [];

/** Reusable Uint8 scratch buffer #slot of at least n bytes (same contract as scratchFloat32). */
export function scratchUint8(slot: number, n: number): Uint8Array {
  let b = scratchU8[slot];
  if (!b || b.length < n) {
    b = new Uint8Array(n);
    scratchU8[slot] = b;
  }
  return b.length === n ? b : b.subarray(0, n);
}

/** Direct Gaussian kernels are used up to this σ (px); wider blurs use the box-pass approximation. */
const DIRECT_MAX_SIGMA = 2;

/**
 * Normalized Gaussian taps w[0..R] (symmetric) for σ in pixels, truncated at R = ⌈2.5σ⌉. Below
 * ~0.6 px the sampled Gaussian falls well short of the requested variance (σ = 0.4 → ½ of it): a
 * 3-tap kernel with exactly σ² of variance is used instead.
 */
function gaussTaps(sigma: number): Float64Array {
  if (sigma < 0.6) {
    const a = 0.5 * sigma * sigma;
    return Float64Array.of(1 - 2 * a, a);
  }
  const R = Math.max(1, Math.ceil(2.5 * sigma));
  const t = new Float64Array(R + 1);
  let sum = 0;
  for (let k = 0; k <= R; k++) {
    t[k] = Math.exp((-0.5 * k * k) / (sigma * sigma));
    sum += k === 0 ? t[k] : 2 * t[k];
  }
  for (let k = 0; k <= R; k++) t[k] /= sum;
  return t;
}

/** Periodic direct Gaussian on one row (src row → dst row). */
function gaussRowPeriodic(src: Float32Array, o: number, dst: Float32Array, w: number, taps: Float64Array): void {
  const R = taps.length - 1;
  const t0 = taps[0];
  for (let c = 0; c < w; c++) {
    let s = t0 * src[o + c];
    if (c >= R && c < w - R) {
      for (let k = 1; k <= R; k++) s += taps[k] * (src[o + c - k] + src[o + c + k]);
    } else {
      // Proper modulo: on tiny rasters the kernel can be wider than the row (R > w).
      for (let k = 1; k <= R; k++) s += taps[k] * (src[o + ((((c - k) % w) + w) % w)] + src[o + ((c + k) % w)]);
    }
    dst[o + c] = s;
  }
}

/** Direct Gaussian down the columns (rows clamped at the poles), row-major for locality. */
function gaussColumns(src: Float32Array, dst: Float32Array, w: number, h: number, taps: Float64Array): void {
  const R = taps.length - 1;
  for (let r = 0; r < h; r++) {
    const o = r * w, t0 = taps[0];
    for (let c = 0; c < w; c++) dst[o + c] = t0 * src[o + c];
    for (let k = 1; k <= R; k++) {
      const a = (r - k < 0 ? 0 : r - k) * w, b = (r + k >= h ? h - 1 : r + k) * w, tk = taps[k];
      for (let c = 0; c < w; c++) dst[o + c] += tk * (src[a + c] + src[b + c]);
    }
  }
}

/**
 * Metric-correct Gaussian blur of an equirectangular w×h field in place: σ is an angle (rad); the
 * horizontal pixel σ grows as 1/cos(lat) (rows near the poles average widely), longitude wraps.
 * Direct Gaussian kernels for σ ≤ DIRECT_MAX_SIGMA px, otherwise BOX_PASSES box passes with
 * fractional radii (cost independent of σ).
 */
export function blurMetric(field: Float32Array, w: number, h: number, sigmaRad: number): void {
  if (!(sigmaRad > 0)) return;
  const tmp = scratchFloat32(1, w * h);
  const dLat = Math.PI / h, dLon = (2 * Math.PI) / w;
  // Horizontal, per row.
  const pad = new Float32Array(3 * w + 8);
  let tapsCache: Float64Array | null = null, tapsSigma = -1;
  for (let row = 0; row < h; row++) {
    const cl = Math.max(1e-6, Math.cos(Math.PI / 2 - ((row + 0.5) * Math.PI) / h));
    const sPx = sigmaRad / (dLon * cl);
    const o = row * w;
    if (sPx <= DIRECT_MAX_SIGMA) {
      // Rows are symmetric about the equator: reuse taps for identical σ.
      if (sPx !== tapsSigma) {
        tapsCache = gaussTaps(sPx);
        tapsSigma = sPx;
      }
      gaussRowPeriodic(field, o, tmp, w, tapsCache as Float64Array);
      field.set(tmp.subarray(o, o + w), o);
      continue;
    }
    const r = boxRadiusForVariance((sPx * sPx) / BOX_PASSES);
    let a: Float32Array = field, b: Float32Array = tmp;
    for (let p = 0; p < BOX_PASSES; p++) {
      boxRowPeriodic(a, o, b, w, r, pad);
      const t = a;
      a = b;
      b = t;
    }
    if (a !== field) field.set(a.subarray(o, o + w), o);
  }
  // Vertical.
  const sv = sigmaRad / dLat;
  if (sv <= DIRECT_MAX_SIGMA) {
    gaussColumns(field, tmp, w, h, gaussTaps(sv));
    field.set(tmp);
    return;
  }
  const rv = boxRadiusForVariance((sv * sv) / BOX_PASSES);
  const acc = new Float64Array(w);
  let a: Float32Array = field, b: Float32Array = tmp;
  for (let p = 0; p < BOX_PASSES; p++) {
    boxColumns(a, b, w, h, rv, acc);
    const t = a;
    a = b;
    b = t;
  }
  if (a !== field) field.set(a);
}
