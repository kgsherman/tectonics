import { EARTH_RADIUS_KM } from '../core/constants';
import { tangentBasis } from '../core/math3';
import { ridged3 } from '../core/noise';
import type { Noise3 } from '../core/noise';
import type { Rng } from '../core/rng';
import { nearestCell } from '../core/sphereMesh';
import type { SphereMesh, Vec3 } from '../core/types';
import { CRUST_CONTINENTAL } from '../core/types';
import type { Components } from './genGraph';
import { multiSourceDijkstra } from './genGraph';
import type { BoundaryKinematics } from './genKinematics';
import { isNormalDominated } from './genKinematics';

// Continental mountain belts at t = 0:
//  * tectonic belts consistent with the plate motions: an Andean cordillera on the overriding
//    continental side of ocean–continent convergence (crest ~220 km from the front), a broad collisional
//    welt where continental crust converges on both sides, and a graben with raised shoulders along
//    continental rifts;
//  * a few old, eroded ranges (Appalachian / Ural-like) crossing continental interiors.

const KM = 1 / EARTH_RADIUS_KM;
/** Convergence rate (km/Myr) above which a boundary builds relief (matches the sim's v_conv gate). */
const MIN_CONVERGENCE = 3;
const MIN_RIFT_OPENING = 1.5;
/** A convergent front builds relief on a plate whose continental crust lies within this many rings of it. */
const FRONT_RINGS = 4;

/**
 * Rings (BFS hops, within the same plate) from each cell to that plate's continental crust, up to
 * `maxRings`; -1 beyond (or on plates without continental crust).
 */
function sameplateRingDistance(mesh: SphereMesh, plate: Int16Array, cont: Uint8Array, maxRings: number): Int8Array {
  const { n, adjOffset, adj } = mesh;
  const ring = new Int8Array(n).fill(-1);
  const queue = new Int32Array(n);
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (cont[i]) {
      ring[i] = 0;
      queue[tail++] = i;
    }
  }
  let head = 0;
  while (head < tail) {
    const i = queue[head++];
    if (ring[i] >= maxRings) continue;
    for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
      const j = adj[e];
      if (ring[j] >= 0 || plate[j] !== plate[i]) continue;
      ring[j] = ring[i] + 1;
      queue[tail++] = j;
    }
  }
  return ring;
}

export interface TectonicBelts {
  /** Elevation change, m (positive belts, negative rift floors). */
  uplift: Float32Array;
  /** Young (active) uplift, m — the draft's `orogeny`. */
  orogeny: Float32Array;
  /** 0..1 proximity to an active continental margin (keeps those coasts steep and emergent). */
  activeMargin: Float32Array;
}

const BELT_SUBDUCTION = 0;
const BELT_COLLISION = 1;
const BELT_RIFT = 2;

export function tectonicBelts(mesh: SphereMesh, plate: Int16Array, crust: Uint8Array, kin: BoundaryKinematics, noise: Noise3, rng: Rng): TectonicBelts {
  const { n, xyz, adjOffset, adj } = mesh;
  const cont = new Uint8Array(n);
  for (let i = 0; i < n; i++) cont[i] = crust[i] === CRUST_CONTINENTAL ? 1 : 0;
  // Cells of a plate within FRONT_RINGS of that plate's own continental crust: the zone through which
  // a front at an active margin (usually a few oceanic cells offshore) reaches the continent.
  const nearCont = sameplateRingDistance(mesh, plate, cont, FRONT_RINGS);
  const sources: number[] = [];
  const kind: number[] = [];
  const rate: number[] = [];
  for (let i = 0; i < n; i++) {
    if (nearCont[i] < 0 || !kin.isBoundary[i] || !isNormalDominated(kin, i)) continue;
    const across = kin.convergeCell[i];
    if (kin.converge[i] > MIN_CONVERGENCE && across >= 0) {
      // Continental crust on both sides at the contact = collision; otherwise the plate carrying the
      // nearby continent overrides the oceanic plate (Andean margin).
      sources.push(i);
      kind.push(cont[i] && cont[across] ? BELT_COLLISION : BELT_SUBDUCTION);
      rate.push(kin.converge[i]);
      continue;
    }
    if (cont[i] && kin.diverge[i] > MIN_RIFT_OPENING) {
      for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
        const j = adj[e];
        if (plate[j] !== plate[i] && cont[j]) {
          sources.push(i);
          kind.push(BELT_RIFT);
          rate.push(kin.diverge[i]);
          break;
        }
      }
    }
  }
  const uplift = new Float32Array(n);
  const orogeny = new Float32Array(n);
  const activeMargin = new Float32Array(n);
  if (sources.length === 0) return { uplift, orogeny, activeMargin };
  // One per-world height jitter; along-strike variation comes from the low-frequency `strike` noise.
  const heightJitter = rng.float(0.85, 1.15);
  const zone = new Uint8Array(n);
  for (let i = 0; i < n; i++) zone[i] = nearCont[i] >= 0 ? 1 : 0;
  const { dist, tag } = multiSourceDijkstra(mesh, sources, sources.map((_, s) => s), { sameLabel: plate, mask: zone, maxDist: 1100 * KM });
  for (let i = 0; i < n; i++) {
    const t = tag[i];
    if (t < 0 || !cont[i]) continue;
    const d = dist[i] / KM;
    const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
    const r = ridged3(noise, x * 7, y * 7, z * 7, 4); // along/across-strike ruggedness 0..1
    const strike = 0.55 + 0.45 * ridged3(noise, x * 2.2 + 5, y * 2.2, z * 2.2, 2);
    const v = rate[t];
    let h = 0;
    if (kind[t] === BELT_SUBDUCTION) {
      // Andean cordillera: crest ~220 km from the front (trench), dying out by ~650 km.
      const H = (1900 + 2700 * Math.min(1, v / 60)) * heightJitter * strike;
      const g = Math.exp(-(((d - 220) / 190) ** 2)) + 0.25 * Math.exp(-((d / 60) ** 2));
      h = H * g * (0.6 + 0.5 * r);
      activeMargin[i] = Math.exp(-((d / 350) ** 2));
    } else if (kind[t] === BELT_COLLISION) {
      // Collisional welt: broad plateau-like belt centred on the suture.
      const H = (700 + 2300 * Math.min(1, v / 10)) * heightJitter * strike;
      h = H * Math.exp(-((d / 320) ** 2)) * (0.65 + 0.45 * r);
      activeMargin[i] = Math.exp(-((d / 250) ** 2));
    } else {
      // Rift: subsiding graben floor with uplifted shoulders.
      const s = Math.min(1, v / 8) * strike;
      h = s * (-260 * Math.exp(-((d / 80) ** 2)) + 220 * Math.exp(-(((d - 140) / 80) ** 2)));
    }
    uplift[i] = h;
    if (h > 0 && kind[t] !== BELT_RIFT) orogeny[i] = h;
  }
  return { uplift, orogeny, activeMargin };
}

function moveAlong(p: Vec3, heading: number, dist: number): Vec3 {
  const { east, north } = tangentBasis(p);
  const dx = Math.cos(heading), dy = Math.sin(heading);
  const c = Math.cos(dist), s = Math.sin(dist);
  const q: Vec3 = [
    p[0] * c + (east[0] * dx + north[0] * dy) * s,
    p[1] * c + (east[1] * dx + north[1] * dy) * s,
    p[2] * c + (east[2] * dx + north[2] * dy) * s,
  ];
  const l = Math.hypot(q[0], q[1], q[2]);
  return [q[0] / l, q[1] / l, q[2] / l];
}

/** Heading (radians from local east) at p that points along the tangent vector t. */
function headingOf(p: Vec3, t: Vec3): number {
  const { east, north } = tangentBasis(p);
  return Math.atan2(t[0] * north[0] + t[1] * north[1] + t[2] * north[2], t[0] * east[0] + t[1] * east[1] + t[2] * east[2]);
}

/**
 * Old eroded ranges: gently curving belts traced across continental interiors (length 900–2800 km,
 * crest 800–2100 m, half-width 130–260 km), roughly one per 2% of the sphere of continent. Returns
 * elevation added (m).
 */
export function oldRanges(mesh: SphereMesh, crust: Uint8Array, comps: Components, coastDistKm: Float32Array, noise: Noise3, rng: Rng): Float32Array {
  const { n, xyz } = mesh;
  const out = new Float32Array(n);
  const sources: number[] = [];
  const along: number[] = [];
  const rangeOf: number[] = [];
  const heights: number[] = [];
  const widths: number[] = [];
  // Interior cells (candidate range starts) per continent.
  const interior = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const c = comps.comp[i];
    if (c < 0 || crust[i] !== CRUST_CONTINENTAL || coastDistKm[i] < 300) continue;
    let l = interior.get(c);
    if (!l) interior.set(c, (l = []));
    l.push(i);
  }
  const step = 0.6 * mesh.spacing;
  const cont = new Uint8Array(n);
  for (let i = 0; i < n; i++) cont[i] = crust[i] === CRUST_CONTINENTAL ? 1 : 0;
  for (const [c, cells] of [...interior.entries()].sort((a, b) => a[0] - b[0])) {
    const areaFrac = comps.size[c] / n;
    const expected = areaFrac / 0.02;
    let count = Math.floor(expected) + (rng.bool(expected - Math.floor(expected)) ? 1 : 0);
    count = Math.min(5, count);
    for (let r = 0; r < count; r++) {
      const start = cells[rng.int(0, cells.length)];
      const p0: Vec3 = [xyz[3 * start], xyz[3 * start + 1], xyz[3 * start + 2]];
      const lengthKm = rng.float(900, 2800);
      const heading = rng.float(0, 2 * Math.PI);
      const rangeId = heights.length;
      heights.push(rng.float(800, 2100));
      widths.push(rng.float(130, 260));
      // Trace both ways from the start point so the start sits mid-range.
      const pathCells: number[] = [];
      for (const dirSign of [1, -1]) {
        let p = p0;
        let h = heading + (dirSign < 0 ? Math.PI : 0);
        let hint = start;
        const half: number[] = [];
        for (let s = 0; s * step * EARTH_RADIUS_KM < lengthKm / 2; s++) {
          const q = moveAlong(p, h, step);
          // Parallel-transport the heading to the new point, then let it wander gently.
          const { east, north } = tangentBasis(p);
          const t: Vec3 = [
            east[0] * Math.cos(h) + north[0] * Math.sin(h),
            east[1] * Math.cos(h) + north[1] * Math.sin(h),
            east[2] * Math.cos(h) + north[2] * Math.sin(h),
          ];
          const dq = t[0] * q[0] + t[1] * q[1] + t[2] * q[2];
          h = headingOf(q, [t[0] - dq * q[0], t[1] - dq * q[1], t[2] - dq * q[2]]) + rng.normal(0, 0.06);
          p = q;
          hint = nearestCell(mesh, p[0], p[1], p[2], hint);
          if (!cont[hint] || coastDistKm[hint] < 100) break;
          half.push(hint);
        }
        if (dirSign > 0) pathCells.push(...half.reverse());
        else pathCells.push(start, ...half);
      }
      const m = pathCells.length;
      for (let q = 0; q < m; q++) {
        sources.push(pathCells[q]);
        along.push(m > 1 ? q / (m - 1) : 0.5);
        rangeOf.push(rangeId);
      }
    }
  }
  if (sources.length === 0) return out;
  const maxW = Math.max(...widths);
  const { dist, tag } = multiSourceDijkstra(mesh, sources, sources.map((_, s) => s), { mask: cont, maxDist: 3 * maxW * KM });
  for (let i = 0; i < n; i++) {
    const t = tag[i];
    if (t < 0) continue;
    const rid = rangeOf[t];
    const d = dist[i] / KM;
    const taper = Math.sqrt(Math.max(0, Math.sin(Math.PI * along[t])));
    const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
    const r = ridged3(noise, x * 8 + 3, y * 8, z * 8, 4);
    out[i] = heights[rid] * taper * Math.exp(-((d / widths[rid]) ** 2)) * (0.55 + 0.55 * r);
  }
  return out;
}
