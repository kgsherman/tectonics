/**
 * Vector-field sampling and particle advection on the unit sphere (pure).
 *
 * Grid (u, v) components are local east/north. Interpolating those components directly breaks
 * down near the poles (the local basis spins with longitude), so each bilinear corner is lifted
 * into 3D with its own east/north basis, the 3D vectors are blended, and the result is projected
 * onto the tangent plane at the sample point. This is smooth across the poles and the antimeridian.
 */
import type { VectorFieldSpec } from '../core/types';

const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI / 2;

export class VectorFieldSampler {
  readonly w: number;
  readonly h: number;
  private readonly u: Float32Array;
  private readonly v: Float32Array;
  private readonly cosLon: Float64Array;
  private readonly sinLon: Float64Array;
  private readonly cosLat: Float64Array;
  private readonly sinLat: Float64Array;

  constructor(field: Pick<VectorFieldSpec, 'w' | 'h' | 'u' | 'v'>) {
    const { w, h } = field;
    if (!(w > 0 && h > 0) || field.u.length < w * h || field.v.length < w * h) {
      throw new Error(`VectorFieldSampler: field arrays do not match ${w}x${h}`);
    }
    this.w = w;
    this.h = h;
    this.u = field.u;
    this.v = field.v;
    this.cosLon = new Float64Array(w);
    this.sinLon = new Float64Array(w);
    for (let c = 0; c < w; c++) {
      const lon = -Math.PI + ((c + 0.5) * TWO_PI) / w;
      this.cosLon[c] = Math.cos(lon);
      this.sinLon[c] = Math.sin(lon);
    }
    this.cosLat = new Float64Array(h);
    this.sinLat = new Float64Array(h);
    for (let r = 0; r < h; r++) {
      const lat = HALF_PI - ((r + 0.5) * Math.PI) / h;
      this.cosLat[r] = Math.cos(lat);
      this.sinLat[r] = Math.sin(lat);
    }
  }

  /**
   * Velocity (m/s) at unit point (x, y, z) as a 3D tangent vector written to out[0..2].
   * Returns false (out untouched beyond scratch) if any contributing grid corner is NaN.
   */
  sample(x: number, y: number, z: number, out: Float64Array | number[]): boolean {
    const { w, h } = this;
    const lat = Math.asin(z > 1 ? 1 : z < -1 ? -1 : z);
    const lon = Math.atan2(y, x);
    let fr = ((HALF_PI - lat) / Math.PI) * h - 0.5;
    if (fr < 0) fr = 0;
    else if (fr > h - 1) fr = h - 1;
    let fc = ((lon + Math.PI) / TWO_PI) * w - 0.5;
    if (fc < 0) fc += w;
    else if (fc >= w) fc -= w;
    const r0 = Math.floor(fr);
    const r1 = r0 + 1 < h ? r0 + 1 : h - 1;
    const tr = fr - r0;
    const c0f = Math.floor(fc);
    const c0 = c0f >= w ? 0 : c0f;
    const c1 = c0 + 1 < w ? c0 + 1 : 0;
    const tc = fc - c0f;
    let vx = 0, vy = 0, vz = 0;
    for (let k = 0; k < 4; k++) {
      const r = k < 2 ? r0 : r1;
      const c = (k & 1) === 0 ? c0 : c1;
      const wt = (k < 2 ? 1 - tr : tr) * ((k & 1) === 0 ? 1 - tc : tc);
      if (wt === 0) continue;
      const i = r * w + c;
      const uu = this.u[i], vv = this.v[i];
      if (uu !== uu || vv !== vv) return false;
      const cl = this.cosLon[c], sl = this.sinLon[c], sp = this.sinLat[r], cp = this.cosLat[r];
      // east = (−sinλ, cosλ, 0), north = (−sinφ cosλ, −sinφ sinλ, cosφ)
      vx += wt * (-uu * sl - vv * sp * cl);
      vy += wt * (uu * cl - vv * sp * sl);
      vz += wt * (vv * cp);
    }
    // Project onto the tangent plane at p.
    const dp = vx * x + vy * y + vz * z;
    out[0] = vx - dp * x;
    out[1] = vy - dp * y;
    out[2] = vz - dp * z;
    return true;
  }
}

/**
 * One advection step on the sphere: p ← normalize(p + vel·k·dt), with the angular step clamped
 * to `maxStep` radians. `p` is a flat xyz array (read/written at offset o); `vel` is a 3D tangent
 * vector in m/s; `k` converts m/s·s to radians of arc. Returns the arc length moved (radians).
 */
export function advectOnSphere(
  p: Float32Array | Float64Array,
  o: number,
  vel: ArrayLike<number>,
  kDt: number,
  maxStep: number,
): number {
  let dx = vel[0] * kDt, dy = vel[1] * kDt, dz = vel[2] * kDt;
  let step = Math.hypot(dx, dy, dz);
  if (step > maxStep) {
    const s = maxStep / step;
    dx *= s;
    dy *= s;
    dz *= s;
    step = maxStep;
  }
  const x = p[o] + dx, y = p[o + 1] + dy, z = p[o + 2] + dz;
  const l = Math.hypot(x, y, z);
  p[o] = x / l;
  p[o + 1] = y / l;
  p[o + 2] = z / l;
  return step;
}
