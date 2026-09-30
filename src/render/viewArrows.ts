/**
 * Great-circle arrow geometry (pure). An ArrowSpec starts at its tail and follows the great circle
 * leaving the tail in the (east, north) direction for `length` radians of arc. The globe renders
 * the same formulas in its instanced vertex shader (shadersPrimitives.ts); the map samples the
 * centerline with `arrowCenterline`.
 */
import type { ArrowSpec, Vec3 } from '../core/types';

/** Tail point and unit tangent direction (geo frame, z = north) of an arrow. */
export interface ArrowFrame {
  tail: Vec3;
  dir: Vec3;
  length: number;
}

/** Widths/lengths of an arrow's parts, radians of arc. */
export interface ArrowDims {
  shaftHalfWidth: number;
  headHalfWidth: number;
  headLength: number;
}

/** Tail + direction for a spec, or null when it has no usable direction or length. */
export function arrowFrame(spec: ArrowSpec): ArrowFrame | null {
  const dl = Math.hypot(spec.east, spec.north);
  if (!(dl > 0) || !(spec.length > 0) || !Number.isFinite(spec.lat) || !Number.isFinite(spec.lon)) return null;
  const cla = Math.cos(spec.lat), sla = Math.sin(spec.lat);
  const clo = Math.cos(spec.lon), slo = Math.sin(spec.lon);
  const tail: Vec3 = [cla * clo, cla * slo, sla];
  // Local basis from lat/lon (well defined even at the poles, where `lon` picks the meridian).
  const east: Vec3 = [-slo, clo, 0];
  const north: Vec3 = [-sla * clo, -sla * slo, cla];
  const e = spec.east / dl, n = spec.north / dl;
  const dir: Vec3 = [e * east[0] + n * north[0], e * east[1] + n * north[1], e * east[2] + n * north[2]];
  return { tail, dir, length: spec.length };
}

/**
 * Part sizes from the arc length. `minHalfWidth` (radians) keeps the shaft visible when zoomed out.
 * The head never exceeds 45% of the arrow.
 */
export function arrowDims(length: number, minHalfWidth = 0): ArrowDims {
  const shaftHalfWidth = Math.max(minHalfWidth, Math.min(0.012, 0.05 * length));
  const headHalfWidth = shaftHalfWidth * 2.6;
  const headLength = Math.min(0.45 * length, headHalfWidth * 2.4);
  return { shaftHalfWidth, headHalfWidth, headLength };
}

/**
 * Point at arc distance `along` from the tail on the arrow's great circle, displaced sideways by
 * `lateral` radians (positive = left of the direction of travel). Writes a unit vector into `out`.
 */
export function arrowPoint(f: ArrowFrame, along: number, lateral: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const ca = Math.cos(along), sa = Math.sin(along);
  const t = f.tail, d = f.dir;
  const px = t[0] * ca + d[0] * sa, py = t[1] * ca + d[1] * sa, pz = t[2] * ca + d[2] * sa;
  if (lateral === 0) {
    out[0] = px;
    out[1] = py;
    out[2] = pz;
    return out;
  }
  // Tangent of travel T = dP/da, left side = P × T (unit since P ⟂ T).
  const tx = -t[0] * sa + d[0] * ca, ty = -t[1] * sa + d[1] * ca, tz = -t[2] * sa + d[2] * ca;
  const sx = py * tz - pz * ty, sy = pz * tx - px * tz, sz = px * ty - py * tx;
  const cl = Math.cos(lateral), sl = Math.sin(lateral);
  out[0] = px * cl + sx * sl;
  out[1] = py * cl + sy * sl;
  out[2] = pz * cl + sz * sl;
  return out;
}

/** n+1 points (geo unit vectors, flattened xyz) along the centerline from tail to tip. */
export function arrowCenterline(f: ArrowFrame, n: number): Float64Array {
  const out = new Float64Array(3 * (n + 1));
  const p: Vec3 = [0, 0, 0];
  for (let i = 0; i <= n; i++) {
    arrowPoint(f, (i / n) * f.length, 0, p);
    out[3 * i] = p[0];
    out[3 * i + 1] = p[1];
    out[3 * i + 2] = p[2];
  }
  return out;
}
