/**
 * Semi-Lagrangian departure-point stencils on the sphere (SPEC §6.1.7 machinery reused for
 * moisture): departure points are integrated in 3D, p_d = normalize(p − dt·V(p_mid)/R) with
 * midpoint iterations, then located on the grid as 4 indices + 4 bilinear weights per cell.
 * The wind is interpolated as a Cartesian 3D vector (projected onto the tangent plane at the
 * midpoint), so sampling across a pole never mixes east/north components of flipped bases.
 */
import { EARTH_RADIUS_M, locateBilinear } from './moistureGrid';
import type { HydroGrid } from './moistureGrid';

export interface Stencil {
  /** 4 source-cell indices per destination cell. */
  idx: Int32Array;
  /** 4 weights per destination cell (sum = the cell's scale factor, 1 unless scaled). */
  wt: Float32Array;
  /** Scratch: Cartesian wind (x, y, z per cell) used while building. */
  vel: Float64Array;
}

export function allocStencil(n: number): Stencil {
  return { idx: new Int32Array(4 * n), wt: new Float32Array(4 * n), vel: new Float64Array(3 * n) };
}

/** Apply a stencil: out[i] = Σ_k wt[4i+k] · src[idx[4i+k]]. */
export function applyStencil(s: Stencil, src: ArrayLike<number>, out: Float64Array, n: number): void {
  const { idx, wt } = s;
  for (let i = 0, k = 0; i < n; i++, k += 4) {
    out[i] = wt[k] * src[idx[k]] + wt[k + 1] * src[idx[k + 1]] + wt[k + 2] * src[idx[k + 2]] + wt[k + 3] * src[idx[k + 3]];
  }
}

const sIdx = new Int32Array(4);
const sWt = new Float64Array(4);

/**
 * Build departure-point stencils for the wind (u east, v north, m/s) read from the slice starting
 * at `offset` of u/v, over a time step dt (s). `scale` (optional, per cell) multiplies the 4
 * weights of each destination cell (e.g. the flux-form compression factor exp(−dt ∇·u)).
 */
export function buildDepartureStencil(
  g: HydroGrid,
  u: ArrayLike<number>,
  v: ArrayLike<number>,
  offset: number,
  dt: number,
  midpointIterations: number,
  out: Stencil,
  scale?: ArrayLike<number>,
): void {
  const { w, h } = g;
  const vel = out.vel;
  // Cartesian wind u ê + v n̂ with ê = (−sinλ, cosλ, 0), n̂ = (−sinφ cosλ, −sinφ sinλ, cosφ).
  for (let r = 0; r < h; r++) {
    const cl = g.cosLat[r];
    const sl = g.sinLat[r];
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const uu = u[offset + i];
      const vv = v[offset + i];
      vel[3 * i] = -g.sinLon[c] * uu - sl * g.cosLon[c] * vv;
      vel[3 * i + 1] = g.cosLon[c] * uu - sl * g.sinLon[c] * vv;
      vel[3 * i + 2] = cl * vv;
    }
  }
  const k = dt / EARTH_RADIUS_M;
  for (let r = 0; r < h; r++) {
    const cl = g.cosLat[r];
    const sl = g.sinLat[r];
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const px = cl * g.cosLon[c];
      const py = cl * g.sinLon[c];
      const pz = sl;
      // First guess with the arrival-point wind.
      let dx = px - k * vel[3 * i];
      let dy = py - k * vel[3 * i + 1];
      let dz = pz - k * vel[3 * i + 2];
      let inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
      dx *= inv;
      dy *= inv;
      dz *= inv;
      for (let it = 0; it < midpointIterations; it++) {
        let mx = px + dx;
        let my = py + dy;
        let mz = pz + dz;
        const ml = Math.sqrt(mx * mx + my * my + mz * mz);
        if (!(ml > 1e-9)) break;
        mx /= ml;
        my /= ml;
        mz /= ml;
        locateBilinear(g, Math.asin(mz > 1 ? 1 : mz < -1 ? -1 : mz), Math.atan2(my, mx), sIdx, sWt, 0);
        let vx = 0;
        let vy = 0;
        let vz = 0;
        for (let q = 0; q < 4; q++) {
          const j = 3 * sIdx[q];
          vx += sWt[q] * vel[j];
          vy += sWt[q] * vel[j + 1];
          vz += sWt[q] * vel[j + 2];
        }
        // Tangent-plane projection at the midpoint.
        const radial = vx * mx + vy * my + vz * mz;
        vx -= radial * mx;
        vy -= radial * my;
        vz -= radial * mz;
        dx = px - k * vx;
        dy = py - k * vy;
        dz = pz - k * vz;
        inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
        dx *= inv;
        dy *= inv;
        dz *= inv;
      }
      const o = 4 * i;
      locateBilinear(g, Math.asin(dz > 1 ? 1 : dz < -1 ? -1 : dz), Math.atan2(dy, dx), out.idx, out.wt, o);
      if (scale) {
        const s = scale[i];
        out.wt[o] *= s;
        out.wt[o + 1] *= s;
        out.wt[o + 2] *= s;
        out.wt[o + 3] *= s;
      }
    }
  }
}
