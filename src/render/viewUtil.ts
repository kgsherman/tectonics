/**
 * Pure view math shared by GlobeView and MapView (no DOM, no Three.js).
 *
 * Frames used here:
 *  - geo:    lat/lon radians, unit vector (x, y, z) with z = north (SPEC §2).
 *  - tex:    equirect texture coordinates (s, t) ∈ [0,1)², s = 0 at lon −π, t = 0 at the north edge
 *            (t follows the row order of our row-0-north rasters).
 *  - sphere UV: Three.js SphereGeometry `uv` attribute: u = s, v = 1 − t (v = 1 at the north pole).
 *  - Three:  world axes with Y up: (X, Y, Z) = (x, z, −y). This is a proper rotation, so cross
 *            products (east/north frames) carry over unchanged.
 *  - NDC / client: WebGL normalized device coordinates and CSS client pixels.
 *
 * Arrow geometry, vector-field sampling / particle advection and the 2D map transform live in
 * sibling modules and are re-exported here so consumers have a single import.
 */
import { EARTH_RADIUS_KM } from '../core/constants';
import type { GeoPoint, Vec3 } from '../core/types';

export * from './viewArrows';
export * from './viewField';
export * from './viewMapTransform';

export const TWO_PI = Math.PI * 2;
export const HALF_PI = Math.PI / 2;
/** Planet radius in meters: converts elevations to unit-sphere displacement. */
export const PLANET_RADIUS_M = EARTH_RADIUS_KM * 1000;
/** Vertical exaggeration applied to the globe at reliefScale = 1. */
export const RELIEF_BASE_EXAGGERATION = 12;
/**
 * Minimum slope exaggeration for relief shading (globe normals and map hillshade). Planetary relief
 * is nearly invisible at true scale on ~10–40 km texels; ~60× reads like a classic small-scale hillshade.
 */
export const SHADE_EXAGGERATION = 60;

/* ------------------------------------------------------------------ */
/* Longitude wrap                                                      */
/* ------------------------------------------------------------------ */

/** Wraps a longitude into (−π, π]. */
export function wrapLon(lon: number): number {
  let l = (lon + Math.PI) % TWO_PI;
  if (l < 0) l += TWO_PI;
  l -= Math.PI;
  return l <= -Math.PI ? l + TWO_PI : l;
}

/** Returns lon + 2πk for the integer k that brings it closest to `ref` (continuous unwrapping). */
export function unwrapLonNear(lon: number, ref: number): number {
  return lon + TWO_PI * Math.round((ref - lon) / TWO_PI);
}

/** Signed shortest longitude difference b − a, in (−π, π]. */
export function lonDelta(a: number, b: number): number {
  return wrapLon(b - a);
}

/* ------------------------------------------------------------------ */
/* geo <-> texture <-> sphere UV                                        */
/* ------------------------------------------------------------------ */

/** Equirect texture coordinates of a geo point: s ∈ [0,1) (lon −π → 0), t ∈ [0,1] (north → 0). */
export function geoToTex(lat: number, lon: number): { s: number; t: number } {
  let s = (lon + Math.PI) / TWO_PI;
  s -= Math.floor(s);
  return { s, t: (HALF_PI - lat) / Math.PI };
}

export function texToGeo(s: number, t: number): GeoPoint {
  return { lat: HALF_PI - t * Math.PI, lon: wrapLon(s * TWO_PI - Math.PI) };
}

/** Three.js SphereGeometry uv of a geo point (the shader samples textures at (u, 1 − v) = (s, t)). */
export function geoToSphereUv(lat: number, lon: number): { u: number; v: number } {
  const { s, t } = geoToTex(lat, lon);
  return { u: s, v: 1 - t };
}

/** Inverse of geoToSphereUv (works for the raw SphereGeometry attribute, u ∈ [0, 1]). */
export function sphereUvToGeo(u: number, v: number): GeoPoint {
  return { lat: (v - 0.5) * Math.PI, lon: wrapLon(u * TWO_PI - Math.PI) };
}

/** Fractional pixel coordinates (col, row) of a geo point in a w×h row-0-north raster (centers at integers). */
export function geoToPixel(w: number, h: number, lat: number, lon: number): { col: number; row: number } {
  const { s, t } = geoToTex(lat, lon);
  return { col: s * w - 0.5, row: t * h - 0.5 };
}

/* ------------------------------------------------------------------ */
/* geo <-> Three world                                                  */
/* ------------------------------------------------------------------ */

/** Geo lat/lon (radians) → Three world position at radius r (Y = north). */
export function geoToThree(lat: number, lon: number, r = 1, out: Vec3 = [0, 0, 0]): Vec3 {
  const cl = Math.cos(lat);
  out[0] = r * cl * Math.cos(lon);
  out[1] = r * Math.sin(lat);
  out[2] = -r * cl * Math.sin(lon);
  return out;
}

/** Geo unit vector (z = north) → Three axes. */
export function vecToThree(x: number, y: number, z: number, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = x;
  out[1] = z;
  out[2] = -y;
  return out;
}

/** Three axes → geo vector (z = north). */
export function threeToVec(X: number, Y: number, Z: number, out: Vec3 = [0, 0, 0]): Vec3 {
  out[0] = X;
  out[1] = -Z;
  out[2] = Y;
  return out;
}

/** Any non-zero Three-space vector → geo lat/lon (lon in (−π, π]). */
export function threeToGeo(X: number, Y: number, Z: number): GeoPoint {
  const r = Math.hypot(X, Y, Z) || 1;
  const lat = Math.asin(Math.max(-1, Math.min(1, Y / r)));
  let lon = Math.atan2(-Z, X);
  if (lon <= -Math.PI) lon += TWO_PI;
  return { lat, lon };
}

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

export interface ViewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** CSS client pixel → normalized device coordinates (y up). */
export function clientToNdc(clientX: number, clientY: number, rect: ViewRect): [number, number] {
  return [((clientX - rect.left) / rect.width) * 2 - 1, 1 - ((clientY - rect.top) / rect.height) * 2];
}

/** Normalized device coordinates → CSS client pixel. */
export function ndcToClient(nx: number, ny: number, rect: ViewRect): [number, number] {
  return [rect.left + ((nx + 1) / 2) * rect.width, rect.top + ((1 - ny) / 2) * rect.height];
}

/**
 * Projects a world point with a column-major 4×4 view-projection matrix (Three `elements` layout).
 * Returns NDC x, y, z and clip w (w ≤ 0: behind the camera).
 */
export function projectWorld(m: ArrayLike<number>, X: number, Y: number, Z: number): [number, number, number, number] {
  const cx = m[0] * X + m[4] * Y + m[8] * Z + m[12];
  const cy = m[1] * X + m[5] * Y + m[9] * Z + m[13];
  const cz = m[2] * X + m[6] * Y + m[10] * Z + m[14];
  const cw = m[3] * X + m[7] * Y + m[11] * Z + m[15];
  const iw = cw !== 0 ? 1 / cw : 0;
  return [cx * iw, cy * iw, cz * iw, cw];
}

/**
 * World-space ray through an NDC point, from the inverse view-projection matrix (column-major).
 * Origin on the near plane, unit direction toward the far plane.
 */
export function rayFromNdc(inv: ArrayLike<number>, nx: number, ny: number): { origin: Vec3; dir: Vec3 } {
  const unproject = (nz: number): Vec3 => {
    const x = inv[0] * nx + inv[4] * ny + inv[8] * nz + inv[12];
    const y = inv[1] * nx + inv[5] * ny + inv[9] * nz + inv[13];
    const z = inv[2] * nx + inv[6] * ny + inv[10] * nz + inv[14];
    const w = inv[3] * nx + inv[7] * ny + inv[11] * nz + inv[15];
    return [x / w, y / w, z / w];
  };
  const a = unproject(-1);
  const b = unproject(1);
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const l = Math.hypot(dx, dy, dz) || 1;
  return { origin: a, dir: [dx / l, dy / l, dz / l] };
}

/* ------------------------------------------------------------------ */
/* Ray casting against the (displaced) sphere                           */
/* ------------------------------------------------------------------ */

/** Smallest t ≥ 0 with |o + t·d| = r (d unit), or −1 if the ray misses. */
export function raySphere(o: ArrayLike<number>, d: ArrayLike<number>, r: number): number {
  const b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2];
  const c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq;
  return t >= 0 ? t : -1;
}

/** Unit-sphere radial displacement for an elevation (m): land above sea level is raised, seas stay flat. */
export function reliefDisplacement(elev: number, seaLevel: number, exaggeration: number): number {
  const d = elev - seaLevel;
  return d > 0 ? (exaggeration * d) / PLANET_RADIUS_M : 0;
}

/**
 * Ray pick against the displaced surface r(p) = 1 + disp(p) (SPEC §8.1): intersect the unit sphere,
 * then refine by re-intersecting the sphere of radius 1 + disp(hit) `iterations` times.
 * Works in any frame where the planet is centered at the origin; `disp` receives a unit vector.
 * Rays that miss the unit sphere only count as hits if the refinement converges onto relief.
 */
export function pickDisplacedSphere(
  origin: ArrayLike<number>,
  dir: ArrayLike<number>,
  disp: (x: number, y: number, z: number) => number,
  maxDisp: number,
  iterations = 3,
): Vec3 | null {
  const tOuter = raySphere(origin, dir, 1 + Math.max(0, maxDisp));
  if (tOuter < 0) return null;
  let t = raySphere(origin, dir, 1);
  const hitBase = t >= 0;
  if (!hitBase) t = tOuter;
  const p: Vec3 = [0, 0, 0];
  const at = (tt: number): void => {
    const x = origin[0] + tt * dir[0], y = origin[1] + tt * dir[1], z = origin[2] + tt * dir[2];
    const l = Math.hypot(x, y, z) || 1;
    p[0] = x / l;
    p[1] = y / l;
    p[2] = z / l;
  };
  if (maxDisp > 0) {
    for (let k = 0; k < iterations; k++) {
      at(t);
      const tn = raySphere(origin, dir, 1 + disp(p[0], p[1], p[2]));
      if (tn < 0) {
        if (!hitBase) return null;
        break;
      }
      t = tn;
    }
  }
  at(t);
  return p;
}

/** Whether a surface point (unit vector n, radius r) faces a camera at `cam` (same frame). */
export function facesCamera(n: ArrayLike<number>, r: number, cam: ArrayLike<number>): boolean {
  const vx = cam[0] - n[0] * r, vy = cam[1] - n[1] * r, vz = cam[2] - n[2] * r;
  return n[0] * vx + n[1] * vy + n[2] * vz > 0;
}

/* ------------------------------------------------------------------ */
/* Sun / camera                                                        */
/* ------------------------------------------------------------------ */

/** Unit vector (Three frame) toward the sun at subsolar latitude `declination`, longitude `sunLon`. */
export function sunDirectionThree(declination: number, sunLon: number): Vec3 {
  return geoToThree(declination, sunLon, 1);
}

const POLE_EPS = HALF_PI - 1e-9;

/** Great-circle distance between two geo points, radians. */
export function geoDistance(a: GeoPoint, b: GeoPoint): number {
  const sa = Math.sin((b.lat - a.lat) / 2);
  const so = Math.sin((b.lon - a.lon) / 2);
  const h = sa * sa + Math.cos(a.lat) * Math.cos(b.lat) * so * so;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Points of the geodesic small circle of angular `radius` around `center` (for the map brush).
 * lon values are unwrapped continuously starting near center.lon (a circle enclosing a pole
 * spans a full 2π of longitude).
 */
export function smallCircle(center: GeoPoint, radius: number, n: number): { lat: Float64Array; lon: Float64Array } {
  const lat = new Float64Array(n + 1);
  const lon = new Float64Array(n + 1);
  // Exactly at a pole every bearing formula term vanishes (atan2(0, 0)); nudge off it so the circle
  // still sweeps all longitudes (the map pick returns lat = ±π/2 on the pole rows).
  const cLat = Math.max(-POLE_EPS, Math.min(POLE_EPS, center.lat));
  const sl = Math.sin(cLat), cl = Math.cos(cLat);
  const sr = Math.sin(radius), cr = Math.cos(radius);
  let prev = center.lon;
  for (let i = 0; i <= n; i++) {
    const brg = (i / n) * TWO_PI;
    // Destination point from `center` along bearing brg at angular distance radius.
    const s = sl * cr + cl * sr * Math.cos(brg);
    const la = Math.asin(Math.max(-1, Math.min(1, s)));
    const lo = center.lon + Math.atan2(Math.sin(brg) * sr * cl, cr - sl * s);
    const lu = i === 0 ? unwrapLonNear(lo, center.lon) : unwrapLonNear(lo, prev);
    lat[i] = la;
    lon[i] = lu;
    prev = lu;
  }
  return { lat, lon };
}

/** sRGB byte → linear [0,1]. */
export function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
