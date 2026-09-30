import { EARTH_RADIUS_KM } from '../core/constants';
import type { Rng } from '../core/rng';
import { cellsWithinRadius, nearestCell } from '../core/sphereMesh';
import type { Hotspot, SphereMesh, Vec3 } from '../core/types';
import { CRUST_CONTINENTAL } from '../core/types';

// Mantle hotspots (fixed in the world frame) and their t = 0 relief: a broad thermal swell, an active
// volcanic edifice over the plume, and — on oceanic plates — a seamount chain trailing along the
// plate's motion (Hawaii–Emperor style): crust that passed over the plume t Myr ago now sits at
// R(ω, t)·p_hotspot and has subsided/eroded with age.

const DEG = Math.PI / 180;
/** Minimum separation between hotspots. */
const MIN_SEPARATION = 16 * DEG;
/** How far back (Myr) seamount chains are traced. */
const TRACK_MYR = 70;

export function placeHotspots(count: number, rng: Rng): Hotspot[] {
  const out: Hotspot[] = [];
  for (let k = 0; k < count; k++) {
    let best: Vec3 = rng.unitVector();
    let bestD = -1;
    for (let t = 0; t < 24; t++) {
      const c = rng.unitVector();
      let d = Math.PI;
      for (const h of out) d = Math.min(d, Math.acos(Math.max(-1, Math.min(1, c[0] * h.pos[0] + c[1] * h.pos[1] + c[2] * h.pos[2]))));
      if (d > bestD) { bestD = d; best = c; }
      if (d >= MIN_SEPARATION * 1.5) break;
    }
    out.push({ pos: best, strength: rng.float(0.5, 1.5), radius: rng.float(1.5, 3) * DEG });
  }
  return out;
}

/** Rotate unit vector p about unit axis a by angle θ (Rodrigues). */
function rotateAbout(p: Vec3, a: Vec3, theta: number): Vec3 {
  const c = Math.cos(theta), s = Math.sin(theta);
  const d = (1 - c) * (a[0] * p[0] + a[1] * p[1] + a[2] * p[2]);
  return [
    p[0] * c + (a[1] * p[2] - a[2] * p[1]) * s + a[0] * d,
    p[1] * c + (a[2] * p[0] - a[0] * p[2]) * s + a[1] * d,
    p[2] * c + (a[0] * p[1] - a[1] * p[0]) * s + a[2] * d,
  ];
}

/** Adds hotspot swells, volcanoes and seamount chains to `elev` in place. */
export function applyHotspotRelief(
  mesh: SphereMesh,
  plate: Int16Array,
  crust: Uint8Array,
  omega: Vec3[],
  hotspots: Hotspot[],
  elev: Float32Array,
  rng: Rng,
): void {
  const { n, xyz } = mesh;
  const volcano = new Float32Array(n); // max edifice height above the local floor
  const swell = new Float32Array(n);
  const cells: number[] = [];
  const edifice = (center: Vec3, radius: number, height: number): void => {
    cellsWithinRadius(mesh, center, 2.2 * radius, cells);
    for (const i of cells) {
      if (crust[i] === CRUST_CONTINENTAL) continue;
      const d = Math.acos(Math.max(-1, Math.min(1, xyz[3 * i] * center[0] + xyz[3 * i + 1] * center[1] + xyz[3 * i + 2] * center[2])));
      const h = height * Math.exp(-((d / radius) ** 2));
      if (h > volcano[i]) volcano[i] = h;
    }
  };
  for (const hs of hotspots) {
    const p = hs.pos;
    // Thermal swell: ~0.5–1 km over the plume head (half on continents).
    cellsWithinRadius(mesh, p, 2.5 * hs.radius, cells);
    for (const i of cells) {
      const d = Math.acos(Math.max(-1, Math.min(1, xyz[3 * i] * p[0] + xyz[3 * i + 1] * p[1] + xyz[3 * i + 2] * p[2])));
      const amp = (crust[i] === CRUST_CONTINENTAL ? 350 : 700) * hs.strength;
      swell[i] = Math.max(swell[i], amp * Math.exp(-((d / (1.2 * hs.radius)) ** 2)));
    }
    const radius = Math.max(1.1 * mesh.spacing, 0.35 * hs.radius);
    const height = 4200 * Math.sqrt(hs.strength);
    edifice(p, radius, height);
    const k = plate[nearestCell(mesh, p[0], p[1], p[2])];
    const w = omega[k];
    const wm = Math.hypot(w[0], w[1], w[2]);
    if (!(wm * EARTH_RADIUS_KM > 1)) continue;
    const axis: Vec3 = [w[0] / wm, w[1] / wm, w[2] / wm];
    // Discrete volcanoes every ~1.5–2.5 cell spacings along the track.
    let t = 0;
    let hint = -1;
    for (;;) {
      t += (rng.float(1.5, 2.5) * mesh.spacing) / wm;
      if (t > TRACK_MYR) break;
      const q = rotateAbout(p, axis, wm * t);
      hint = nearestCell(mesh, q[0], q[1], q[2], hint >= 0 ? hint : undefined);
      if (plate[hint] !== k || crust[hint] === CRUST_CONTINENTAL) break;
      edifice(q, radius * rng.float(0.8, 1.1), height * Math.exp(-t / 28) * rng.float(0.55, 1));
    }
  }
  for (let i = 0; i < n; i++) elev[i] += swell[i] + volcano[i];
}
