/**
 * Lat-lon grid geometry for the climate dynamic core (row 0 = north, SPEC §2) and the resampling
 * operators between the climate output grid and the core grid.
 */
import { EARTH_RADIUS_KM } from '../core/constants';

export const EARTH_RADIUS_M = EARTH_RADIUS_KM * 1000;

export interface LatLonGrid {
  nx: number;
  ny: number;
  n: number;
  /** Row spacing / column spacing, radians. */
  dLat: number;
  dLon: number;
  /** Per row: center latitude, sin, cos (cos clamped ≥ 1e-6). */
  lat: Float64Array;
  sinLat: Float64Array;
  cosLat: Float64Array;
  /** Per face row k = 0..ny (k = north face of row k; k = ny is the south pole): sin and cos. */
  faceSin: Float64Array;
  faceCos: Float64Array;
  /** Per row: cell area on the unit sphere (sr). */
  area: Float64Array;
  /** Per column: center longitude, cos, sin. */
  lon: Float64Array;
  cosLon: Float64Array;
  sinLon: Float64Array;
  /** Area weight per row normalized so Σ_cells weight = 1. */
  rowWeight: Float64Array;
}

export function makeGrid(nx: number, ny: number): LatLonGrid {
  const dLat = Math.PI / ny;
  const dLon = (2 * Math.PI) / nx;
  const lat = new Float64Array(ny);
  const sinLat = new Float64Array(ny);
  const cosLat = new Float64Array(ny);
  const faceSin = new Float64Array(ny + 1);
  const faceCos = new Float64Array(ny + 1);
  const area = new Float64Array(ny);
  const rowWeight = new Float64Array(ny);
  for (let k = 0; k <= ny; k++) {
    const f = Math.PI / 2 - k * dLat;
    faceSin[k] = Math.sin(f);
    faceCos[k] = Math.max(0, Math.cos(f));
  }
  faceCos[0] = 0;
  faceCos[ny] = 0;
  faceSin[0] = 1;
  faceSin[ny] = -1;
  for (let j = 0; j < ny; j++) {
    lat[j] = Math.PI / 2 - (j + 0.5) * dLat;
    sinLat[j] = Math.sin(lat[j]);
    cosLat[j] = Math.max(1e-6, Math.cos(lat[j]));
    area[j] = dLon * (faceSin[j] - faceSin[j + 1]);
    rowWeight[j] = area[j] / (4 * Math.PI);
  }
  const lon = new Float64Array(nx);
  const cosLon = new Float64Array(nx);
  const sinLon = new Float64Array(nx);
  for (let c = 0; c < nx; c++) {
    lon[c] = -Math.PI + (c + 0.5) * dLon;
    cosLon[c] = Math.cos(lon[c]);
    sinLon[c] = Math.sin(lon[c]);
  }
  return { nx, ny, n: nx * ny, dLat, dLon, lat, sinLat, cosLat, faceSin, faceCos, area, lon, cosLon, sinLon, rowWeight };
}

/** Area-weighted global mean of a grid field (length n) or of slice `offset..offset+n`. */
export function globalMean(g: LatLonGrid, f: ArrayLike<number>, offset = 0): number {
  let s = 0;
  for (let j = 0; j < g.ny; j++) {
    let r = 0;
    const o = offset + j * g.nx;
    for (let c = 0; c < g.nx; c++) r += f[o + c];
    s += (r / g.nx) * g.rowWeight[j] * g.nx;
  }
  return s;
}

/**
 * Conservative (area-overlap) 1-D weights mapping n source intervals onto m destination
 * intervals of the same total span. For destination k: entries [off[k], off[k+1]) of idx/wt.
 */
export interface Overlap1D {
  off: Int32Array;
  idx: Int32Array;
  wt: Float64Array;
}

function overlap1D(n: number, m: number): Overlap1D {
  const off = new Int32Array(m + 1);
  const idx: number[] = [];
  const wt: number[] = [];
  for (let k = 0; k < m; k++) {
    const a = (k * n) / m;
    const b = ((k + 1) * n) / m;
    const i0 = Math.floor(a);
    const i1 = Math.min(n - 1, Math.ceil(b) - 1);
    let tot = 0;
    const start = idx.length;
    for (let i = i0; i <= i1; i++) {
      const w = Math.min(b, i + 1) - Math.max(a, i);
      if (w > 1e-12) {
        idx.push(i);
        wt.push(w);
        tot += w;
      }
    }
    for (let q = start; q < wt.length; q++) wt[q] /= tot;
    off[k + 1] = idx.length;
  }
  return { off, idx: Int32Array.from(idx), wt: Float64Array.from(wt) };
}

/** Tensor-product area-overlap regridder (exact when the grids nest; conservative otherwise). */
export interface OverlapRegrid {
  srcW: number;
  srcH: number;
  dstW: number;
  dstH: number;
  cols: Overlap1D;
  rows: Overlap1D;
}

export function makeOverlapRegrid(srcW: number, srcH: number, dstW: number, dstH: number): OverlapRegrid {
  return { srcW, srcH, dstW, dstH, cols: overlap1D(srcW, dstW), rows: overlap1D(srcH, dstH) };
}

/**
 * Weighted overlap average: dst = Σ w·wgt·src / Σ w·wgt (wgt optional per source cell). Cells with
 * zero total weight get `empty`. Row overlap weights also carry cos(lat) so averages are by area.
 */
export function overlapAverage(
  R: OverlapRegrid,
  src: ArrayLike<number>,
  wgt: ArrayLike<number> | null,
  out: Float64Array,
  empty = 0,
): Float64Array {
  const { cols, rows, srcW, srcH, dstW, dstH } = R;
  for (let r = 0; r < dstH; r++) {
    for (let c = 0; c < dstW; c++) {
      let s = 0;
      let t = 0;
      for (let a = rows.off[r]; a < rows.off[r + 1]; a++) {
        const sr = rows.idx[a];
        const wr = rows.wt[a] * Math.cos(Math.PI / 2 - ((sr + 0.5) * Math.PI) / srcH);
        const base = sr * srcW;
        for (let b = cols.off[c]; b < cols.off[c + 1]; b++) {
          const i = base + cols.idx[b];
          const w = wr * cols.wt[b] * (wgt ? wgt[i] : 1);
          s += w * src[i];
          t += w;
        }
      }
      out[r * dstW + c] = t > 0 ? s / t : empty;
    }
  }
  return out;
}

/** Precomputed bilinear stencil from a src grid to a dst grid (cell centers; lon wraps, lat clamps). */
export interface BilinearStencil {
  dstW: number;
  dstH: number;
  /** 4 source indices and weights per destination cell. */
  idx: Int32Array;
  wt: Float32Array;
}

export function makeBilinearStencil(srcW: number, srcH: number, dstW: number, dstH: number): BilinearStencil {
  const n = dstW * dstH;
  const idx = new Int32Array(4 * n);
  const wt = new Float32Array(4 * n);
  for (let r = 0; r < dstH; r++) {
    let fr = ((r + 0.5) * srcH) / dstH - 0.5;
    if (fr < 0) fr = 0;
    if (fr > srcH - 1) fr = srcH - 1;
    const r0 = Math.floor(fr);
    const r1 = Math.min(srcH - 1, r0 + 1);
    const tr = fr - r0;
    for (let c = 0; c < dstW; c++) {
      let fc = ((c + 0.5) * srcW) / dstW - 0.5;
      if (fc < 0) fc += srcW;
      const c0 = Math.floor(fc) % srcW;
      const c1 = (c0 + 1) % srcW;
      const tc = fc - Math.floor(fc);
      const k = 4 * (r * dstW + c);
      idx[k] = r0 * srcW + c0;
      idx[k + 1] = r0 * srcW + c1;
      idx[k + 2] = r1 * srcW + c0;
      idx[k + 3] = r1 * srcW + c1;
      wt[k] = (1 - tr) * (1 - tc);
      wt[k + 1] = (1 - tr) * tc;
      wt[k + 2] = tr * (1 - tc);
      wt[k + 3] = tr * tc;
    }
  }
  return { dstW, dstH, idx, wt };
}

/** Apply a bilinear stencil to src slice [srcOff, srcOff + srcN) writing dst slice at dstOff. */
export function applyBilinear(
  S: BilinearStencil,
  src: ArrayLike<number>,
  srcOff: number,
  dst: Float32Array | Float64Array,
  dstOff: number,
): void {
  const n = S.dstW * S.dstH;
  const { idx, wt } = S;
  for (let p = 0, k = 0; p < n; p++, k += 4) {
    dst[dstOff + p] =
      wt[k] * src[srcOff + idx[k]] +
      wt[k + 1] * src[srcOff + idx[k + 1]] +
      wt[k + 2] * src[srcOff + idx[k + 2]] +
      wt[k + 3] * src[srcOff + idx[k + 3]];
  }
}
