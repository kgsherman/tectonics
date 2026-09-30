/**
 * Semi-Lagrangian transport on the lat-lon grid (SPEC §6.1.7): departure points are computed in
 * 3D on the unit sphere, p_d = normalize(p − dt·(u ê + v n̂)/R), with two midpoint iterations,
 * and stored as precomputed 4-index / 4-weight bilinear stencils (one per month and sub-step length).
 */
import { EARTH_RADIUS_M, type LatLonGrid } from './dynGrid';

export interface SLStencil {
  /** Number of sub-steps of length dtSub that make up one model step. */
  nSub: number;
  dtSub: number;
  idx: Int32Array;
  wt: Float32Array;
}

/** Bilinear interpolation of (u, v) at (lat, lon); returns via out[0], out[1]. */
function sampleUV(g: LatLonGrid, u: ArrayLike<number>, v: ArrayLike<number>, off: number, lat: number, lon: number, out: Float64Array): void {
  const { nx, ny } = g;
  let fr = ((Math.PI / 2 - lat) / Math.PI) * ny - 0.5;
  if (fr < 0) fr = 0;
  else if (fr > ny - 1) fr = ny - 1;
  let fc = ((lon + Math.PI) / (2 * Math.PI)) * nx - 0.5;
  fc -= Math.floor(fc / nx) * nx;
  const r0 = Math.floor(fr);
  const r1 = r0 + 1 < ny ? r0 + 1 : ny - 1;
  const tr = fr - r0;
  const c0f = Math.floor(fc);
  const c0 = c0f % nx;
  const c1 = c0 + 1 < nx ? c0 + 1 : 0;
  const tc = fc - c0f;
  const i00 = off + r0 * nx + c0, i01 = off + r0 * nx + c1, i10 = off + r1 * nx + c0, i11 = off + r1 * nx + c1;
  const w00 = (1 - tr) * (1 - tc), w01 = (1 - tr) * tc, w10 = tr * (1 - tc), w11 = tr * tc;
  out[0] = w00 * u[i00] + w01 * u[i01] + w10 * u[i10] + w11 * u[i11];
  out[1] = w00 * v[i00] + w01 * v[i01] + w10 * v[i10] + w11 * v[i11];
}

/**
 * Build the stencil for velocity (u, v) m/s (slice at `off`, scaled by `scale`) over a model step
 * `dt` seconds, sub-stepped so that no sub-step moves more than `maxCells` meridional cell sizes.
 */
export function buildStencil(
  g: LatLonGrid,
  u: ArrayLike<number>,
  v: ArrayLike<number>,
  off: number,
  scale: number,
  dt: number,
  maxCells: number,
  maxSub: number,
): SLStencil {
  const { nx, ny, n } = g;
  let vmax = 0;
  for (let i = 0; i < n; i++) {
    const s = Math.sqrt(u[off + i] * u[off + i] + v[off + i] * v[off + i]) * Math.abs(scale);
    if (s > vmax) vmax = s;
  }
  const cell = EARTH_RADIUS_M * g.dLat;
  const nSub = Math.max(1, Math.min(maxSub, Math.ceil((vmax * dt) / (maxCells * cell))));
  const dtSub = dt / nSub;
  const idx = new Int32Array(4 * n);
  const wt = new Float32Array(4 * n);
  const k = (dtSub * scale) / EARTH_RADIUS_M;
  const uv = new Float64Array(2);
  for (let j = 0; j < ny; j++) {
    const la = g.lat[j];
    const cl = Math.cos(la);
    const sl = Math.sin(la);
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      const px = cl * g.cosLon[c], py = cl * g.sinLon[c], pz = sl;
      let uu = u[off + i], vv = v[off + i];
      // East and north unit vectors at p.
      let ex = -g.sinLon[c], ey = g.cosLon[c];
      let nxv = -sl * g.cosLon[c], nyv = -sl * g.sinLon[c], nzv = cl;
      let dx = px - k * (uu * ex + vv * nxv);
      let dy = py - k * (uu * ey + vv * nyv);
      let dz = pz - k * (vv * nzv);
      for (let it = 0; it < 2; it++) {
        let l = Math.sqrt(dx * dx + dy * dy + dz * dz);
        dx /= l; dy /= l; dz /= l;
        // Midpoint of p and p_d.
        let mx = px + dx, my = py + dy, mz = pz + dz;
        l = Math.sqrt(mx * mx + my * my + mz * mz);
        if (l < 1e-9) break;
        mx /= l; my /= l; mz /= l;
        const mlat = Math.asin(Math.max(-1, Math.min(1, mz)));
        const mlon = Math.atan2(my, mx);
        sampleUV(g, u, v, off, mlat, mlon, uv);
        uu = uv[0];
        vv = uv[1];
        const hl = Math.sqrt(mx * mx + my * my);
        if (hl > 1e-9) {
          // Local basis at the midpoint: ê = (−sinλ, cosλ, 0), n̂ = (−sinφ cosλ, −sinφ sinλ, cosφ).
          ex = -my / hl; ey = mx / hl;
          nxv = (-mz * mx) / hl; nyv = (-mz * my) / hl; nzv = hl;
        }
        dx = px - k * (uu * ex + vv * nxv);
        dy = py - k * (uu * ey + vv * nyv);
        dz = pz - k * (vv * nzv);
      }
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      dx /= l; dy /= l; dz /= l;
      const dlat = Math.asin(Math.max(-1, Math.min(1, dz)));
      const dlon = Math.atan2(dy, dx);
      writeBilinear(g, dlat, dlon, idx, wt, 4 * i);
    }
  }
  return { nSub, dtSub, idx, wt };
}

function writeBilinear(g: LatLonGrid, lat: number, lon: number, idx: Int32Array, wt: Float32Array, k: number): void {
  const { nx, ny } = g;
  let fr = ((Math.PI / 2 - lat) / Math.PI) * ny - 0.5;
  if (fr < 0) fr = 0;
  else if (fr > ny - 1) fr = ny - 1;
  let fc = ((lon + Math.PI) / (2 * Math.PI)) * nx - 0.5;
  fc -= Math.floor(fc / nx) * nx;
  const r0 = Math.floor(fr);
  const r1 = r0 + 1 < ny ? r0 + 1 : ny - 1;
  const tr = fr - r0;
  const c0f = Math.floor(fc);
  const c0 = c0f % nx;
  const c1 = c0 + 1 < nx ? c0 + 1 : 0;
  const tc = fc - c0f;
  idx[k] = r0 * nx + c0;
  idx[k + 1] = r0 * nx + c1;
  idx[k + 2] = r1 * nx + c0;
  idx[k + 3] = r1 * nx + c1;
  wt[k] = (1 - tr) * (1 - tc);
  wt[k + 1] = (1 - tr) * tc;
  wt[k + 2] = tr * (1 - tc);
  wt[k + 3] = tr * tc;
}

/** out[i] = Σ w·src[idx] for all cells (one semi-Lagrangian sub-step). */
export function applyStencil(S: SLStencil, src: Float64Array, out: Float64Array): void {
  const { idx, wt } = S;
  const n = out.length;
  for (let i = 0, k = 0; i < n; i++, k += 4) {
    out[i] = wt[k] * src[idx[k]] + wt[k + 1] * src[idx[k + 1]] + wt[k + 2] * src[idx[k + 2]] + wt[k + 3] * src[idx[k + 3]];
  }
}
