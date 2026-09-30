/**
 * Numerical building blocks for the climate core: tridiagonal solvers (plain and periodic via
 * Sherman–Morrison), running-sum box blurs on the sphere, and jump-flood nearest-valid fills.
 * All routines are allocation-free in their hot loops (callers pass work buffers).
 */
import { EARTH_RADIUS_M, type LatLonGrid } from './dynGrid';

/**
 * Thomas algorithm: a[i]·x[i-1] + b[i]·x[i] + c[i]·x[i+1] = d[i], i = 0..n-1 (a[0], c[n-1] ignored).
 * `cp` is a work buffer of length ≥ n. x may alias d.
 */
export function solveTridiag(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  c: ArrayLike<number>,
  d: ArrayLike<number>,
  x: Float64Array,
  n: number,
  cp: Float64Array,
): void {
  let beta = b[0];
  x[0] = d[0] / beta;
  for (let i = 1; i < n; i++) {
    cp[i] = c[i - 1] / beta;
    beta = b[i] - a[i] * cp[i];
    x[i] = (d[i] - a[i] * x[i - 1]) / beta;
  }
  for (let i = n - 2; i >= 0; i--) x[i] -= cp[i + 1] * x[i + 1];
}

/** Work buffers for {@link solveCyclic}. */
export interface CyclicWork {
  bb: Float64Array;
  cp: Float64Array;
  inv: Float64Array;
  y: Float64Array;
  z: Float64Array;
}

export function makeCyclicWork(n: number): CyclicWork {
  return { bb: new Float64Array(n), cp: new Float64Array(n), inv: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n) };
}

/**
 * Periodic tridiagonal solve (Sherman–Morrison): row i couples x[i-1], x[i], x[i+1] with indices
 * taken modulo n. a[0] multiplies x[n-1] and c[n-1] multiplies x[0]. Requires n ≥ 3.
 */
export function solveCyclic(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  c: ArrayLike<number>,
  d: ArrayLike<number>,
  x: Float64Array,
  n: number,
  w: CyclicWork,
): void {
  const { bb, cp, inv, y, z } = w;
  const gamma = -b[0];
  const alpha = a[0];
  const betaC = c[n - 1];
  for (let i = 0; i < n; i++) bb[i] = b[i];
  bb[0] = b[0] - gamma;
  bb[n - 1] = b[n - 1] - (alpha * betaC) / gamma;
  // Shared forward elimination for the two right-hand sides d and u = (γ, 0, …, 0, c[n-1]).
  let beta = bb[0];
  inv[0] = 1 / beta;
  y[0] = d[0] * inv[0];
  z[0] = gamma * inv[0];
  for (let i = 1; i < n; i++) {
    cp[i] = c[i - 1] * inv[i - 1];
    beta = bb[i] - a[i] * cp[i];
    inv[i] = 1 / beta;
    const ui = i === n - 1 ? betaC : 0;
    y[i] = (d[i] - a[i] * y[i - 1]) * inv[i];
    z[i] = (ui - a[i] * z[i - 1]) * inv[i];
  }
  for (let i = n - 2; i >= 0; i--) {
    y[i] -= cp[i + 1] * y[i + 1];
    z[i] -= cp[i + 1] * z[i + 1];
  }
  const fact = (y[0] + (alpha * y[n - 1]) / gamma) / (1 + z[0] + (alpha * z[n - 1]) / gamma);
  for (let i = 0; i < n; i++) x[i] = y[i] - fact * z[i];
}

/** Half-widths (cells) for a smoothing length `km`: zonal per row (capped at the full row) and meridional. */
export function smoothingHalfWidths(g: LatLonGrid, km: number): { hx: Int32Array; hy: number } {
  const L = km * 1000;
  const hx = new Int32Array(g.ny);
  const cap = Math.floor((g.nx - 1) / 2);
  for (let j = 0; j < g.ny; j++) {
    const v = L / (EARTH_RADIUS_M * g.cosLat[j] * g.dLon);
    hx[j] = Math.min(cap, Math.round(v));
  }
  return { hx, hy: Math.round(L / (EARTH_RADIUS_M * g.dLat)) };
}

/** cos/sin of the zonal wavenumber-1 phase 2π(c + ½)/nx per column, cached by nx. */
const phaseTables = new Map<number, { cos: Float64Array; sin: Float64Array }>();
export function zonalPhase(nx: number): { cos: Float64Array; sin: Float64Array } {
  let t = phaseTables.get(nx);
  if (!t) {
    const cos = new Float64Array(nx);
    const sin = new Float64Array(nx);
    for (let c = 0; c < nx; c++) {
      const a = (2 * Math.PI * (c + 0.5)) / nx;
      cos[c] = Math.cos(a);
      sin[c] = Math.sin(a);
    }
    t = { cos, sin };
    phaseTables.set(nx, t);
  }
  return t;
}

/**
 * Zonal running-sum box blur of one row-major field slice (lon wraps). `tmp` length ≥ nx.
 *
 * Zonal wavenumbers 0 and 1 pass unchanged: a field that is smooth across a pole varies around a
 * polar latitude circle like a + b·cos(λ − λ₀) (a gradient across the pole), which the wide boxes of
 * the polar rows would otherwise flatten row by row into zonal bands, with inconsistent gradients
 * (winds, thermal wind, convergence) in the last rows. Away from the poles the boxes are narrow and
 * their wavenumber-1 response is ≈ 1 anyway.
 */
export function boxBlurZonal(
  f: Float64Array | Float32Array,
  off: number,
  nx: number,
  ny: number,
  hx: Int32Array,
  tmp: Float64Array,
): void {
  const ph = zonalPhase(nx);
  const pc = ph.cos, ps = ph.sin;
  for (let j = 0; j < ny; j++) {
    const h = hx[j];
    if (h <= 0) continue;
    const base = off + j * nx;
    // Wavenumber-1 part of the row and the box's response to it.
    let a1 = 0;
    let b1 = 0;
    for (let c = 0; c < nx; c++) {
      const v = f[base + c];
      a1 += v * pc[c];
      b1 += v * ps[c];
    }
    a1 *= 2 / nx;
    b1 *= 2 / nx;
    const L = 2 * h + 1;
    if (L >= nx) {
      let s = 0;
      for (let c = 0; c < nx; c++) s += f[base + c];
      const m = s / nx;
      for (let c = 0; c < nx; c++) f[base + c] = m + a1 * pc[c] + b1 * ps[c];
      continue;
    }
    const keep = 1 - Math.sin((Math.PI * L) / nx) / (L * Math.sin(Math.PI / nx));
    for (let c = 0; c < nx; c++) tmp[c] = f[base + c];
    let s = 0;
    for (let k = -h; k <= h; k++) s += tmp[(k + nx) % nx];
    const inv = 1 / L;
    const ka = keep * a1;
    const kb = keep * b1;
    for (let c = 0; c < nx; c++) {
      f[base + c] = s * inv + ka * pc[c] + kb * ps[c];
      const add = c + h + 1;
      const rem = c - h;
      s += tmp[add >= nx ? add - nx : add] - tmp[rem < 0 ? rem + nx : rem];
    }
  }
}

/**
 * Meridional running-sum box blur. The window continues across each pole onto the opposite
 * meridian (row −1 − k at column c ≡ row k at column c + nx/2), as a great circle through the pole
 * does, so a gradient across the pole is kept (its wavenumber-1 part changes sign across the pole)
 * and polar rows are not biased toward their equatorward neighbours. With an odd nx the opposite
 * column is rounded down. `tmp` length ≥ ny + 2·min(hy, ny).
 */
export function boxBlurMeridional(
  f: Float64Array | Float32Array,
  off: number,
  nx: number,
  ny: number,
  hy: number,
  tmp: Float64Array,
): void {
  if (hy <= 0) return;
  const e = Math.min(hy, ny);
  const len = ny + 2 * e;
  const half = nx >> 1;
  const ext = tmp.length >= len ? tmp : new Float64Array(len);
  // The rows beyond the poles are read from the opposite columns, which the in-place sweep may
  // already have smoothed: keep the unsmoothed polar rows.
  const north = new Float64Array(e * nx);
  const south = new Float64Array(e * nx);
  for (let k = 0; k < e; k++) {
    for (let c = 0; c < nx; c++) {
      north[k * nx + c] = f[off + k * nx + c];
      south[k * nx + c] = f[off + (ny - 1 - k) * nx + c];
    }
  }
  for (let c = 0; c < nx; c++) {
    const co = c + half < nx ? c + half : c + half - nx;
    // ext[k] = row k − e of the great circle through column c (column c + nx/2 beyond the poles).
    for (let k = 0; k < e; k++) {
      ext[e - 1 - k] = north[k * nx + co];
      ext[e + ny + k] = south[k * nx + co];
    }
    for (let j = 0; j < ny; j++) ext[e + j] = f[off + j * nx + c];
    // Window of row j: ext[e + j − hy .. e + j + hy], clipped to the extended column.
    let s = 0;
    let cnt = 0;
    const last = Math.min(len - 1, e + hy);
    for (let k = Math.max(0, e - hy); k <= last; k++) {
      s += ext[k];
      cnt++;
    }
    for (let j = 0; j < ny; j++) {
      f[off + j * nx + c] = s / cnt;
      const add = e + j + hy + 1;
      const rem = e + j - hy;
      if (add < len) {
        s += ext[add];
        cnt++;
      }
      if (rem >= 0) {
        s -= ext[rem];
        cnt--;
      }
    }
  }
}

/** Isotropic-ish smoothing on the sphere: `passes` rounds of zonal + meridional box blur of length km. */
export function smoothField(g: LatLonGrid, f: Float64Array | Float32Array, km: number, passes = 3, off = 0): void {
  if (km <= 0 || passes <= 0) return;
  const { hx, hy } = smoothingHalfWidths(g, km);
  const tmp = new Float64Array(Math.max(g.nx, 3 * g.ny));
  for (let p = 0; p < passes; p++) {
    boxBlurZonal(f, off, g.nx, g.ny, hx, tmp);
    boxBlurMeridional(f, off, g.nx, g.ny, hy, tmp);
  }
}

/** 1-2-1 filter in both directions (lon wraps), `passes` times; cells with mask=0 are left unchanged and excluded. */
export function smooth121Masked(g: LatLonGrid, f: Float64Array, mask: Uint8Array | null, passes: number): void {
  const { nx, ny, n } = g;
  const tmp = new Float64Array(n);
  for (let p = 0; p < passes; p++) {
    tmp.set(f);
    for (let j = 0; j < ny; j++) {
      for (let c = 0; c < nx; c++) {
        const i = j * nx + c;
        if (mask && !mask[i]) continue;
        let s = 2 * tmp[i];
        let w = 2;
        const cw = j * nx + (c === 0 ? nx - 1 : c - 1);
        const ce = j * nx + (c === nx - 1 ? 0 : c + 1);
        if (!mask || mask[cw]) { s += tmp[cw]; w++; }
        if (!mask || mask[ce]) { s += tmp[ce]; w++; }
        f[i] = s / w;
      }
    }
    tmp.set(f);
    for (let j = 0; j < ny; j++) {
      for (let c = 0; c < nx; c++) {
        const i = j * nx + c;
        if (mask && !mask[i]) continue;
        let s = 2 * tmp[i];
        let w = 2;
        if (j > 0 && (!mask || mask[i - nx])) { s += tmp[i - nx]; w++; }
        if (j < ny - 1 && (!mask || mask[i + nx])) { s += tmp[i + nx]; w++; }
        f[i] = s / w;
      }
    }
  }
}

/**
 * Jump-flood nearest-valid index on a lat-lon grid (great-circle metric via 3D chords, lon wraps).
 * Returns for every cell the index of the (approximately) nearest cell with valid[i] = 1, the cell
 * itself when valid, or -1 everywhere if no cell is valid.
 */
export function nearestValidIndex(nx: number, ny: number, valid: ArrayLike<number>): Int32Array {
  const n = nx * ny;
  const X = new Float64Array(n);
  const Y = new Float64Array(n);
  const Z = new Float64Array(n);
  for (let j = 0; j < ny; j++) {
    const la = Math.PI / 2 - ((j + 0.5) * Math.PI) / ny;
    const cl = Math.cos(la);
    const sl = Math.sin(la);
    for (let c = 0; c < nx; c++) {
      const lo = -Math.PI + ((c + 0.5) * 2 * Math.PI) / nx;
      const i = j * nx + c;
      X[i] = cl * Math.cos(lo);
      Y[i] = cl * Math.sin(lo);
      Z[i] = sl;
    }
  }
  let cur = new Int32Array(n).fill(-1);
  let any = false;
  for (let i = 0; i < n; i++) {
    if (valid[i]) {
      cur[i] = i;
      any = true;
    }
  }
  if (!any) return cur;
  let next = new Int32Array(n);
  let step = 1;
  while (step * 2 < Math.max(nx, ny)) step *= 2;
  const steps: number[] = [];
  for (let s = step; s >= 1; s >>= 1) steps.push(s);
  steps.push(1);
  for (const s of steps) {
    for (let j = 0; j < ny; j++) {
      for (let c = 0; c < nx; c++) {
        const i = j * nx + c;
        let best = cur[i];
        let bd = best >= 0 ? dist2(X, Y, Z, i, best) : Infinity;
        for (let dj = -s; dj <= s; dj += s) {
          const jj = j + dj;
          if (jj < 0 || jj >= ny) continue;
          for (let dc = -s; dc <= s; dc += s) {
            if (dj === 0 && dc === 0) continue;
            let cc = (c + dc) % nx;
            if (cc < 0) cc += nx;
            const cand = cur[jj * nx + cc];
            if (cand < 0 || cand === best) continue;
            const d = dist2(X, Y, Z, i, cand);
            if (d < bd) {
              bd = d;
              best = cand;
            }
          }
        }
        next[i] = best;
      }
    }
    const t = cur;
    cur = next;
    next = t;
  }
  return cur;
}

function dist2(X: Float64Array, Y: Float64Array, Z: Float64Array, a: number, b: number): number {
  const dx = X[a] - X[b];
  const dy = Y[a] - Y[b];
  const dz = Z[a] - Z[b];
  return dx * dx + dy * dy + dz * dz;
}

/** out[off+i] = src[off + nearest[i]] for every cell whose own value is invalid (nearest[i] ≠ i). */
export function fillFromNearest(f: Float32Array | Float64Array, off: number, nearest: Int32Array): void {
  const n = nearest.length;
  for (let i = 0; i < n; i++) {
    const k = nearest[i];
    if (k !== i && k >= 0) f[off + i] = f[off + k];
  }
}
