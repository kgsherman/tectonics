import { EARTH_RADIUS_KM } from './constants';
import type { Quat, Vec3 } from './types';

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function length3(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** Returns a unit vector (or [0,0,1] for a zero vector). */
export function normalize3(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  if (!(l > 0)) return [0, 0, 1];
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Great-circle angle between two unit vectors, radians (numerically robust: atan2(|a x b|, a . b)). */
export function angleBetween(a: Vec3, b: Vec3): number {
  const c = cross3(a, b);
  return Math.atan2(Math.hypot(c[0], c[1], c[2]), dot3(a, b));
}

/** lat/lon radians -> unit vector (z = north). */
export function latLonToVec(lat: number, lon: number): Vec3 {
  const cl = Math.cos(lat);
  return [cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat)];
}

/** Unit (or any non-zero) vector -> {lat, lon} radians, lon in (-PI, PI]. */
export function vecToLatLon(x: number, y: number, z: number): { lat: number; lon: number } {
  const r = Math.hypot(x, y, z) || 1;
  const lat = Math.asin(Math.max(-1, Math.min(1, z / r)));
  let lon = Math.atan2(y, x);
  if (lon <= -Math.PI) lon += 2 * Math.PI;
  return { lat, lon };
}

/**
 * Local tangent basis at unit point p: east = normalize(z_hat x p), north = p x east.
 * At the exact poles east is defined as +y; never returns NaN.
 */
export function tangentBasis(p: Vec3): { east: Vec3; north: Vec3 } {
  // z_hat x p = (-p.y, p.x, 0)
  let ex = -p[1];
  let ey = p[0];
  const l = Math.hypot(ex, ey);
  if (l < 1e-12) {
    ex = 0;
    ey = 1;
  } else {
    ex /= l;
    ey /= l;
  }
  const east: Vec3 = [ex, ey, 0];
  const north = normalize3(cross3(p, east));
  return { east, north };
}

/** Surface velocity at p for angular velocity omega: omega x p (unit sphere). */
export function velocityAt(omega: Vec3, p: Vec3): Vec3 {
  return cross3(omega, p);
}

/**
 * Angular velocity (rad/Myr) whose surface velocity at unit point p points along the local
 * (east, north) direction with the given speed in km/Myr, i.e. the Euler pole is 90 deg from p:
 * omega = (p x d) * speed / radiusKm, where d is the 3D unit tangent direction. Optional spin (rad/Myr)
 * adds a rotation about p itself. radiusKm defaults to EARTH_RADIUS_KM.
 */
export function omegaFromDirection(
  p: Vec3,
  east: number,
  north: number,
  speedKmPerMyr: number,
  radiusKm: number = EARTH_RADIUS_KM,
  spin = 0,
): Vec3 {
  const { east: e, north: nn } = tangentBasis(p);
  const dl = Math.hypot(east, north);
  let w: Vec3 = [0, 0, 0];
  if (dl > 0 && speedKmPerMyr !== 0) {
    const d: Vec3 = [
      (e[0] * east + nn[0] * north) / dl,
      (e[1] * east + nn[1] * north) / dl,
      (e[2] * east + nn[2] * north) / dl,
    ];
    // (p x d) x p = d for unit p ⟂ d, so velocity = omega x p = d * speed / R.
    w = scale3(cross3(p, d), speedKmPerMyr / radiusKm);
  }
  if (spin) w = add3(w, scale3(p, spin));
  return w;
}

export function quatIdentity(): Quat {
  return [0, 0, 0, 1];
}

/** Rotation of `angle` radians about unit `axis` (right-hand rule). */
export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const a = normalize3(axis);
  const s = Math.sin(angle / 2);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(angle / 2)];
}

/** Hamilton product a*b: rotating by the result = rotate by b, then by a. */
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatConjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(l > 0)) return [0, 0, 0, 1];
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const m = quatToMat3(q);
  const out = [0, 0, 0];
  mat3MulVec(m, v[0], v[1], v[2], out, 0);
  return [out[0], out[1], out[2]];
}

/** Row-major 3x3 rotation matrix of q. out[0..8]. */
export function quatToMat3(q: Quat, out: Float64Array = new Float64Array(9)): Float64Array {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  out[0] = 1 - 2 * (yy + zz);
  out[1] = 2 * (xy - wz);
  out[2] = 2 * (xz + wy);
  out[3] = 2 * (xy + wz);
  out[4] = 1 - 2 * (xx + zz);
  out[5] = 2 * (yz - wx);
  out[6] = 2 * (xz - wy);
  out[7] = 2 * (yz + wx);
  out[8] = 1 - 2 * (xx + yy);
  return out;
}

/** out[o..o+2] = m * (x,y,z), m row-major 3x3. */
export function mat3MulVec(m: Float64Array, x: number, y: number, z: number, out: Float64Array | number[], o = 0): void {
  out[o] = m[0] * x + m[1] * y + m[2] * z;
  out[o + 1] = m[3] * x + m[4] * y + m[5] * z;
  out[o + 2] = m[6] * x + m[7] * y + m[8] * z;
}

/** out[o..o+2] = transpose(m) * (x,y,z) (inverse rotation for orthonormal m). */
export function mat3TMulVec(m: Float64Array, x: number, y: number, z: number, out: Float64Array | number[], o = 0): void {
  out[o] = m[0] * x + m[3] * y + m[6] * z;
  out[o + 1] = m[1] * x + m[4] * y + m[7] * z;
  out[o + 2] = m[2] * x + m[5] * y + m[8] * z;
}
