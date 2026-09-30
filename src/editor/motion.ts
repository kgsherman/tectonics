import { DEG, EARTH_RADIUS_KM, RAD } from '../core/constants';
import { angleBetween, cross3, dot3, tangentBasis, vecToLatLon } from '../core/math3';
import type { Rng } from '../core/rng';
import { nearestCell } from '../core/sphereMesh';
import type { ArrowSpec, PlateSpec, RGB, SphereMesh, Vec3 } from '../core/types';
import { ARROW_RAD_PER_KM_MYR, DEFAULT_SPEED_RANGE, MAX_PLATE_SPEED } from './editorConstants';

/** A plate's motion as seen at its anchor point. */
export interface PlateMotion {
  /** Surface speed at the anchor, km/Myr (10 km/Myr = 1 cm/yr). */
  speed: number;
  /** Compass bearing of the velocity, degrees clockwise from north, [0, 360). */
  bearing: number;
  /** Rotation rate about the anchor's own axis, rad/Myr (positive = counter-clockwise seen from above). */
  spin: number;
  /** Unit-sphere velocity components (rad/Myr) along local east / north. */
  east: number;
  north: number;
}

export function motionAt(omega: Vec3, anchor: Vec3): PlateMotion {
  const v = cross3(omega, anchor);
  const { east, north } = tangentBasis(anchor);
  const ve = dot3(v, east), vn = dot3(v, north);
  const speed = Math.hypot(ve, vn) * EARTH_RADIUS_KM;
  let bearing = Math.atan2(ve, vn) * RAD;
  if (bearing < 0) bearing += 360;
  if (bearing >= 360) bearing -= 360;
  return { speed, bearing, spin: dot3(omega, anchor), east: ve, north: vn };
}

/**
 * Angular velocity giving surface velocity v (speed km/Myr along `bearingDeg`) at anchor a, plus
 * `spin` rad/Myr about a:  ω = (a × v)/R + spin·a.  Then ω × a = v/R because a ⟂ v.
 * The simulation caps the fastest point of every plate, |ω|·R, at MAX_PLATE_SPEED by scaling ω
 * down; to keep the anchor velocity exactly as drawn, the speed is capped there and the spin is
 * trimmed to what remains (|ω|² = (v/R)² + spin²).
 */
export function omegaFromMotion(anchor: Vec3, speed: number, bearingDeg: number, spin: number): Vec3 {
  const { east, north } = tangentBasis(anchor);
  const b = bearingDeg * DEG;
  const sb = Math.sin(b), cb = Math.cos(b);
  const d: Vec3 = [east[0] * sb + north[0] * cb, east[1] * sb + north[1] * cb, east[2] * sb + north[2] * cb];
  const t = cross3(anchor, d);
  const wMax = MAX_PLATE_SPEED / EARTH_RADIUS_KM;
  const s = Math.min(Math.max(0, speed) / EARTH_RADIUS_KM, wMax);
  const spinMax = Math.sqrt(Math.max(0, wMax * wMax - s * s));
  const w = Math.max(-spinMax, Math.min(spinMax, spin));
  return [t[0] * s + w * anchor[0], t[1] * s + w * anchor[1], t[2] * s + w * anchor[2]];
}

/**
 * ω from dragging a plate's arrow head to `head`: the arrow's arc length sets the speed
 * (ARROW_RAD_PER_KM_MYR, capped at MAX_PLATE_SPEED), its initial great-circle direction the bearing.
 * The existing spin is preserved. `snapDeg` rounds the bearing (Shift-drag).
 */
export function omegaFromDrag(anchor: Vec3, head: Vec3, spin: number, snapDeg = 0): Vec3 {
  const theta = angleBetween(anchor, head);
  const speed = Math.min(MAX_PLATE_SPEED, theta / ARROW_RAD_PER_KM_MYR);
  if (speed < 0.05) return omegaFromMotion(anchor, 0, 0, spin);
  const { east, north } = tangentBasis(anchor);
  let bearing = Math.atan2(dot3(head, east), dot3(head, north)) * RAD;
  if (snapDeg > 0) bearing = Math.round(bearing / snapDeg) * snapDeg;
  return omegaFromMotion(anchor, speed, bearing, spin);
}

/** Where the arrow of a plate with angular velocity ω ends (its drag handle). */
export function arrowHead(anchor: Vec3, omega: Vec3): Vec3 {
  const m = motionAt(omega, anchor);
  const len = m.speed * ARROW_RAD_PER_KM_MYR;
  if (len < 1e-9) return [anchor[0], anchor[1], anchor[2]];
  const { east, north } = tangentBasis(anchor);
  const l = Math.hypot(m.east, m.north);
  const de = m.east / l, dn = m.north / l;
  const d: Vec3 = [east[0] * de + north[0] * dn, east[1] * de + north[1] * dn, east[2] * de + north[2] * dn];
  const c = Math.cos(len), s = Math.sin(len);
  return [anchor[0] * c + d[0] * s, anchor[1] * c + d[1] * s, anchor[2] * c + d[2] * s];
}

/** Motion arrow for a plate (null when it is not moving). */
export function plateArrow(anchor: Vec3, omega: Vec3, color: RGB, id: number, highlighted: boolean, scale = 1): ArrowSpec | null {
  const m = motionAt(omega, anchor);
  if (m.speed < 0.05) return null;
  const { lat, lon } = vecToLatLon(anchor[0], anchor[1], anchor[2]);
  return { lat, lon, east: m.east, north: m.north, length: m.speed * ARROW_RAD_PER_KM_MYR * scale, color, id, highlighted };
}

/**
 * Random plausible motion for a plate anchored at `anchor`: speed within `speedRange` (SPEC §9:
 * 30–60 km/Myr), continental plates drawn from the slower half of it, Euler pole 60–90° away from
 * the anchor (small spin).
 */
export function randomMotion(rng: Rng, anchor: Vec3, continentalFraction: number, speedRange: readonly [number, number] = DEFAULT_SPEED_RANGE): Vec3 {
  const cf = Math.max(0, Math.min(1, continentalFraction));
  const lo = speedRange[0], hi = speedRange[1] - 0.5 * (speedRange[1] - speedRange[0]) * cf;
  const speed = rng.float(lo, hi);
  const bearing = rng.float(0, 360);
  // Pole angle ψ from the anchor: tan ψ = (v/R) / spin.
  const psi = rng.float(60, 90) * DEG;
  const spin = ((speed / EARTH_RADIUS_KM) / Math.tan(psi)) * (rng.bool() ? 1 : -1);
  return omegaFromMotion(anchor, speed, bearing, Math.abs(spin) < 1e-12 ? 0 : spin);
}

/** ~m quasi-uniform points on the sphere (Fibonacci lattice), 3m floats. */
export function fibonacciPoints(m: number): Float64Array {
  const out = new Float64Array(3 * m);
  const ga = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < m; i++) {
    const z = 1 - (2 * i + 1) / m;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const phi = 2 * Math.PI * ((i * ga) % 1);
    out[3 * i] = r * Math.cos(phi);
    out[3 * i + 1] = r * Math.sin(phi);
    out[3 * i + 2] = z;
  }
  return out;
}

/**
 * Sparse field of small ω×p arrows (one per sample point, coloured by plate) shown while a motion
 * is being dragged, so the whole plate's rotation — not just its anchor velocity — is visible.
 */
export function velocityFieldArrows(
  mesh: SphereMesh, plate: Int16Array, plates: PlateSpec[], samples: Float64Array, scale: number, highlightPlate = -1,
): ArrowSpec[] {
  const out: ArrowSpec[] = [];
  let hint = 0;
  const m = samples.length / 3;
  for (let s = 0; s < m; s++) {
    const p: Vec3 = [samples[3 * s], samples[3 * s + 1], samples[3 * s + 2]];
    hint = nearestCell(mesh, p[0], p[1], p[2], hint);
    const k = plate[hint];
    if (k < 0 || k >= plates.length) continue;
    const spec = plates[k];
    const mo = motionAt(spec.omega, p);
    if (mo.speed < 0.5) continue;
    const { lat, lon } = vecToLatLon(p[0], p[1], p[2]);
    // The dragged plate's arrows are near-white, the others a light tint of their plate colour.
    const c = spec.color;
    const t = k === highlightPlate ? 0.85 : 0.5;
    const tint: RGB = [Math.round(c[0] + (255 - c[0]) * t), Math.round(c[1] + (255 - c[1]) * t), Math.round(c[2] + (255 - c[2]) * t)];
    out.push({ lat, lon, east: mo.east, north: mo.north, length: mo.speed * ARROW_RAD_PER_KM_MYR * scale, color: tint });
  }
  return out;
}
