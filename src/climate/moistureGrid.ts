/**
 * Lat-lon grid geometry for the hydrology stage (row 0 = north, col 0 = lon −180°, SPEC §2) and the
 * metric-correct spatial operators it needs: Gaussian smoothing, gradients, flux-form divergence
 * and bilinear point location with across-the-pole interpolation.
 */
import { EARTH_RADIUS_KM } from '../core/constants';

export const EARTH_RADIUS_M = EARTH_RADIUS_KM * 1000;

export interface HydroGrid {
  w: number;
  h: number;
  n: number;
  /** Row / column spacing (radians). */
  dLat: number;
  dLon: number;
  /** Per-row centre latitude, cos and sin. */
  lat: Float64Array;
  cosLat: Float64Array;
  sinLat: Float64Array;
  /** cos(latitude) of the face above row r (r = 0..h); faceCos[0] = faceCos[h] = 0 (poles). */
  faceCos: Float64Array;
  /** Per-row cell area as a fraction of the sphere (Σ over all cells = 1). */
  rowArea: Float64Array;
  /** Per-column cos/sin of the centre longitude. */
  cosLon: Float64Array;
  sinLon: Float64Array;
}

export function makeHydroGrid(w: number, h: number): HydroGrid {
  if (!(w >= 4 && h >= 2) || !Number.isInteger(w) || !Number.isInteger(h)) {
    throw new Error(`hydrology: invalid grid ${w}x${h}`);
  }
  const dLat = Math.PI / h;
  const dLon = (2 * Math.PI) / w;
  const lat = new Float64Array(h);
  const cosLat = new Float64Array(h);
  const sinLat = new Float64Array(h);
  const faceCos = new Float64Array(h + 1);
  const rowArea = new Float64Array(h);
  for (let r = 0; r < h; r++) {
    lat[r] = Math.PI / 2 - (r + 0.5) * dLat;
    cosLat[r] = Math.cos(lat[r]);
    sinLat[r] = Math.sin(lat[r]);
    // Exact band area (sin φ_north − sin φ_south) / 2 split over w cells.
    rowArea[r] = (Math.sin(Math.PI / 2 - r * dLat) - Math.sin(Math.PI / 2 - (r + 1) * dLat)) / (2 * w);
  }
  for (let r = 1; r < h; r++) faceCos[r] = Math.cos(Math.PI / 2 - r * dLat);
  const cosLon = new Float64Array(w);
  const sinLon = new Float64Array(w);
  for (let c = 0; c < w; c++) {
    const lon = -Math.PI + (c + 0.5) * dLon;
    cosLon[c] = Math.cos(lon);
    sinLon[c] = Math.sin(lon);
  }
  return { w, h, n: w * h, dLat, dLon, lat, cosLat, sinLat, faceCos, rowArea, cosLon, sinLon };
}

/** Area-weighted global mean of a w*h field (or of the slice starting at `offset`). */
export function globalMean(g: HydroGrid, f: ArrayLike<number>, offset = 0): number {
  let s = 0;
  for (let r = 0; r < g.h; r++) {
    let row = 0;
    const o = offset + r * g.w;
    for (let c = 0; c < g.w; c++) row += f[o + c];
    s += row * g.rowArea[r];
  }
  return s;
}

function gaussianKernel(sigmaCells: number, maxRadius: number): Float64Array {
  const rad = Math.max(0, Math.min(maxRadius, Math.ceil(3 * sigmaCells)));
  const k = new Float64Array(2 * rad + 1);
  let s = 0;
  for (let j = -rad; j <= rad; j++) {
    const v = Math.exp((-0.5 * j * j) / (sigmaCells * sigmaCells));
    k[j + rad] = v;
    s += v;
  }
  for (let j = 0; j < k.length; j++) k[j] /= s;
  return k;
}

/**
 * Separable, metric-correct Gaussian smoothing with standard deviation `sigmaKm` (same physical
 * width at every latitude): zonal pass per row (periodic, σ in cells = σ / (R cosφ Δλ), capped
 * at the row), then a meridional pass that continues across each pole onto the opposite meridian.
 */
export function blurSphere(g: HydroGrid, src: ArrayLike<number>, sigmaKm: number, out?: Float64Array): Float64Array {
  const { w, h, n } = g;
  const o = out && out.length >= n ? out : new Float64Array(n);
  const tmp = new Float64Array(n);
  const sigmaM = sigmaKm * 1000;
  const halfW = w >> 1;
  // Zonal pass.
  for (let r = 0; r < h; r++) {
    const dx = EARTH_RADIUS_M * Math.max(g.cosLat[r], 1e-6) * g.dLon;
    const sc = sigmaM / dx;
    const row = r * w;
    if (sc < 0.25) {
      for (let c = 0; c < w; c++) tmp[row + c] = src[row + c];
      continue;
    }
    if (sc > w / 2) {
      let s = 0;
      for (let c = 0; c < w; c++) s += src[row + c];
      s /= w;
      for (let c = 0; c < w; c++) tmp[row + c] = s;
      continue;
    }
    const k = gaussianKernel(sc, Math.floor((w - 1) / 2));
    const rad = (k.length - 1) >> 1;
    for (let c = 0; c < w; c++) {
      let s = 0;
      for (let j = -rad; j <= rad; j++) {
        let cc = c + j;
        if (cc < 0) cc += w;
        else if (cc >= w) cc -= w;
        s += k[j + rad] * src[row + cc];
      }
      tmp[row + c] = s;
    }
  }
  // Meridional pass.
  const sr = sigmaM / (EARTH_RADIUS_M * g.dLat);
  if (sr < 0.25) {
    o.set(tmp.subarray(0, n));
    return o;
  }
  const k = gaussianKernel(sr, h - 1);
  const rad = (k.length - 1) >> 1;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      let s = 0;
      for (let j = -rad; j <= rad; j++) {
        let rr = r + j;
        let cc = c;
        if (rr < 0) {
          rr = -rr - 1;
          cc = (c + halfW) % w;
        } else if (rr >= h) {
          rr = 2 * h - rr - 1;
          cc = (c + halfW) % w;
        }
        s += k[j + rad] * tmp[rr * w + cc];
      }
      o[r * w + c] = s;
    }
  }
  return o;
}

/**
 * Horizontal gradient (per metre) of a scalar field: centred differences, eastward component
 * ∂f/(R cosφ ∂λ) into gx and northward ∂f/(R ∂φ) into gy (one-sided in the polar rows).
 */
export function gradient(g: HydroGrid, f: ArrayLike<number>, gx: Float64Array, gy: Float64Array): void {
  const { w, h } = g;
  for (let r = 0; r < h; r++) {
    const invDx = 1 / (2 * EARTH_RADIUS_M * Math.max(g.cosLat[r], 1e-6) * g.dLon);
    const rn = r > 0 ? r - 1 : r;
    const rs = r < h - 1 ? r + 1 : r;
    const invDy = 1 / ((rs - rn) * EARTH_RADIUS_M * g.dLat);
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const ce = c + 1 < w ? c + 1 : 0;
      const cw = c > 0 ? c - 1 : w - 1;
      gx[i] = (f[r * w + ce] - f[r * w + cw]) * invDx;
      gy[i] = (f[rn * w + c] - f[rs * w + c]) * invDy;
    }
  }
}

/**
 * Finite-volume divergence (s⁻¹) of a wind field (u east, v north, m/s) read from the slice at
 * `offset`: face values are neighbour averages, pole faces carry zero flux, so Σ area·div = 0.
 */
export function divergence(g: HydroGrid, u: ArrayLike<number>, v: ArrayLike<number>, offset: number, out: Float64Array): void {
  const { w, h, faceCos, dLat, dLon } = g;
  for (let r = 0; r < h; r++) {
    const inv = 1 / (EARTH_RADIUS_M * Math.max(g.cosLat[r], 1e-6));
    // Exact band metric: ∂(v cosφ)/∂φ over the cell → (v_n cosφ_n − v_s cosφ_s) / (sinφ_n − sinφ_s) · cosφ.
    const bandHeight = (Math.sin(Math.PI / 2 - r * dLat) - Math.sin(Math.PI / 2 - (r + 1) * dLat)) / g.cosLat[r];
    for (let c = 0; c < w; c++) {
      const i = offset + r * w + c;
      const ce = offset + r * w + (c + 1 < w ? c + 1 : 0);
      const cw = offset + r * w + (c > 0 ? c - 1 : w - 1);
      const ue = 0.5 * (u[i] + u[ce]);
      const uw = 0.5 * (u[i] + u[cw]);
      const vn = r > 0 ? 0.5 * (v[i] + v[i - w]) * faceCos[r] : 0;
      const vs = r < h - 1 ? 0.5 * (v[i] + v[i + w]) * faceCos[r + 1] : 0;
      out[r * w + c] = inv * ((ue - uw) / dLon + (vn - vs) / bandHeight);
    }
  }
}

/**
 * Bilinear location of the point (lat, lon) on the grid: writes 4 cell indices and weights at
 * idx[o..o+3] / wt[o..o+3]. Points poleward of the first/last row centre interpolate across the
 * pole towards the opposite meridian (row −1 ≡ row 0 shifted by half a turn).
 */
export function locateBilinear(
  g: HydroGrid,
  lat: number,
  lon: number,
  idx: Int32Array,
  wt: Float32Array | Float64Array,
  o: number,
): void {
  const { w, h } = g;
  const halfW = w >> 1;
  const fr = (Math.PI / 2 - lat) / g.dLat - 0.5;
  let fc = (lon + Math.PI) / g.dLon - 0.5;
  fc -= Math.floor(fc / w) * w;
  let c0 = Math.floor(fc);
  const tc = fc - c0;
  if (c0 >= w) c0 -= w;
  const c1 = c0 + 1 < w ? c0 + 1 : 0;
  const r0 = Math.floor(fr);
  const tr = fr - r0;
  let a0: number, a1: number, b0: number, b1: number;
  if (r0 < 0) {
    a0 = (c0 + halfW) % w;
    a1 = (c1 + halfW) % w;
  } else {
    const rr = r0 < h ? r0 : h - 1;
    a0 = rr * w + c0;
    a1 = rr * w + c1;
  }
  const r1 = r0 + 1;
  if (r1 >= h) {
    b0 = (h - 1) * w + ((c0 + halfW) % w);
    b1 = (h - 1) * w + ((c1 + halfW) % w);
  } else {
    const rr = r1 < 0 ? 0 : r1;
    b0 = rr * w + c0;
    b1 = rr * w + c1;
  }
  idx[o] = a0;
  idx[o + 1] = a1;
  idx[o + 2] = b0;
  idx[o + 3] = b1;
  wt[o] = (1 - tc) * (1 - tr);
  wt[o + 1] = tc * (1 - tr);
  wt[o + 2] = (1 - tc) * tr;
  wt[o + 3] = tc * tr;
}
