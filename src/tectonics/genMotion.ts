import { EARTH_RADIUS_KM } from '../core/constants';
import { cross3, normalize3, tangentBasis } from '../core/math3';
import type { Rng } from '../core/rng';
import type { SphereMesh, Vec3 } from '../core/types';
import { CRUST_CONTINENTAL } from '../core/types';

// Plate motions (angular velocities, rad/Myr). Speeds follow SPEC §5: continental plates 15–40 km/Myr,
// oceanic 40–100 km/Myr (× plateSpeed/50) at the plate centroid, Euler poles mostly 60–90° from the
// centroid. Plates that share continental crust across a boundary form a cluster moving as one block
// plus a slow divergent spread (≤ 4.5 km/Myr each ⇒ relative speed < 10 km/Myr), so t = 0 has no
// collision shock through a continent and supercontinents slowly start to rift apart.

/** Plates with at least this continental area fraction move at continental speeds. */
export const CONTINENTAL_PLATE_FRACTION = 0.25;
export const CONTINENTAL_SPEED: [number, number] = [15, 40];
export const OCEANIC_SPEED: [number, number] = [40, 100];
/** Max intra-cluster spreading speed per plate, km/Myr (pairwise relative ≤ twice this). */
export const CLUSTER_SPREAD_MAX = 4.5;

export interface PlateStats {
  count: Float64Array;
  continental: Float64Array;
  /** Unit centroid per plate (3 per plate). */
  centroid: Float64Array;
}

export function plateStats(mesh: SphereMesh, plate: Int16Array, crust: Uint8Array, numPlates: number): PlateStats {
  const { n, xyz } = mesh;
  const count = new Float64Array(numPlates);
  const continental = new Float64Array(numPlates);
  const centroid = new Float64Array(3 * numPlates);
  const first = new Int32Array(numPlates).fill(-1);
  for (let i = 0; i < n; i++) {
    const k = plate[i];
    count[k]++;
    if (crust[i] === CRUST_CONTINENTAL) continental[k]++;
    centroid[3 * k] += xyz[3 * i];
    centroid[3 * k + 1] += xyz[3 * i + 1];
    centroid[3 * k + 2] += xyz[3 * i + 2];
    if (first[k] < 0) first[k] = i;
  }
  for (let k = 0; k < numPlates; k++) {
    const l = Math.hypot(centroid[3 * k], centroid[3 * k + 1], centroid[3 * k + 2]);
    if (l > 1e-9 * Math.max(1, count[k])) {
      for (let q = 0; q < 3; q++) centroid[3 * k + q] /= l;
    } else {
      // Degenerate (hemisphere-symmetric) plate: fall back to one of its cells.
      const f = Math.max(0, first[k]);
      for (let q = 0; q < 3; q++) centroid[3 * k + q] = xyz[3 * f + q];
    }
  }
  return { count, continental, centroid };
}

/** Union-find cluster id per plate: plates joined by a boundary edge with continental crust on both sides. */
export function continentClusters(mesh: SphereMesh, plate: Int16Array, crust: Uint8Array, numPlates: number): Int32Array {
  const parent = Int32Array.from({ length: numPlates }, (_, k) => k);
  const find = (k: number): number => {
    while (parent[k] !== k) {
      parent[k] = parent[parent[k]];
      k = parent[k];
    }
    return k;
  };
  const { n, adjOffset, adj } = mesh;
  for (let i = 0; i < n; i++) {
    if (crust[i] !== CRUST_CONTINENTAL) continue;
    const a = plate[i];
    for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
      const j = adj[e];
      const b = plate[j];
      if (b !== a && crust[j] === CRUST_CONTINENTAL) {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
      }
    }
  }
  const cluster = new Int32Array(numPlates);
  for (let k = 0; k < numPlates; k++) cluster[k] = find(k);
  return cluster;
}

/**
 * Angular velocity whose surface velocity at unit point c is `speed` km/Myr along unit tangent d,
 * with the Euler pole `poleAngle` radians from c (spin sign ±1 picks the side).
 */
export function omegaWithPoleAngle(c: Vec3, d: Vec3, speed: number, poleAngle: number, spinSign: number): Vec3 {
  const cd = normalize3(cross3(c, d));
  const s = Math.sin(poleAngle), co = Math.cos(poleAngle) * spinSign;
  // Axis a = cos θ·c + sin θ·(c × d) ⇒ ω × c = |ω| sin θ·d; |ω| = speed / (R sin θ).
  const mag = speed / (EARTH_RADIUS_KM * Math.max(1e-6, s));
  return [
    mag * (co * c[0] + s * cd[0]),
    mag * (co * c[1] + s * cd[1]),
    mag * (co * c[2] + s * cd[2]),
  ];
}

/** Random unit tangent at c. */
function randomTangent(c: Vec3, rng: Rng): Vec3 {
  const { east, north } = tangentBasis(c);
  const a = rng.float(0, 2 * Math.PI);
  return [east[0] * Math.cos(a) + north[0] * Math.sin(a), east[1] * Math.cos(a) + north[1] * Math.sin(a), east[2] * Math.cos(a) + north[2] * Math.sin(a)];
}

function projectTangent(c: Vec3, v: Vec3): Vec3 {
  const d = v[0] * c[0] + v[1] * c[1] + v[2] * c[2];
  return [v[0] - d * c[0], v[1] - d * c[1], v[2] - d * c[2]];
}

/** Euler pole angle from the centroid: mostly 60–90°, sometimes 35–60° (rotation-dominated plates). */
function randomPoleAngle(rng: Rng): number {
  const deg = rng.bool(0.85) ? rng.float(60, 90) : rng.float(35, 60);
  return (deg * Math.PI) / 180;
}

/**
 * "Slab pull" direction for an oceanic plate: tangent direction (at its centroid) toward the mean
 * position of continental crust of other clusters across its boundaries, or null if it has none.
 */
function slabPullDirection(mesh: SphereMesh, plate: Int16Array, crust: Uint8Array, cluster: Int32Array, k: number, c: Vec3, cells: Int32Array, start: number, end: number): Vec3 | null {
  const { xyz, adjOffset, adj } = mesh;
  let sx = 0, sy = 0, sz = 0, cnt = 0;
  for (let q = start; q < end; q++) {
    const i = cells[q];
    for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
      const j = adj[e];
      const b = plate[j];
      if (b === k || cluster[b] === cluster[k] || crust[j] !== CRUST_CONTINENTAL) continue;
      sx += xyz[3 * j]; sy += xyz[3 * j + 1]; sz += xyz[3 * j + 2];
      cnt++;
    }
  }
  if (cnt === 0) return null;
  const t = projectTangent(c, [sx / cnt, sy / cnt, sz / cnt]);
  const l = Math.hypot(t[0], t[1], t[2]);
  return l > 1e-6 ? [t[0] / l, t[1] / l, t[2] / l] : null;
}

export interface Motions {
  omega: Vec3[];
  /** Cluster root per plate (equal ids = plates sharing continental crust). */
  cluster: Int32Array;
}

/** Assign motions to `numPlates` plates. `speedScale` = plateSpeed / 50. */
export function assignMotions(mesh: SphereMesh, plate: Int16Array, crust: Uint8Array, numPlates: number, speedScale: number, rng: Rng): Motions {
  const st = plateStats(mesh, plate, crust, numPlates);
  const cluster = continentClusters(mesh, plate, crust, numPlates);
  const cen = (k: number): Vec3 => [st.centroid[3 * k], st.centroid[3 * k + 1], st.centroid[3 * k + 2]];
  // Cells grouped by plate (CSR) for the per-plate boundary scans.
  const off = new Int32Array(numPlates + 1);
  for (let i = 0; i < mesh.n; i++) off[plate[i] + 1]++;
  for (let k = 0; k < numPlates; k++) off[k + 1] += off[k];
  const cells = new Int32Array(mesh.n);
  const fill = off.slice(0, numPlates);
  for (let i = 0; i < mesh.n; i++) cells[fill[plate[i]]++] = i;

  const omega: Vec3[] = new Array(numPlates);
  const done = new Uint8Array(numPlates);
  for (let k = 0; k < numPlates; k++) {
    if (done[k]) continue;
    const members: number[] = [];
    for (let m = k; m < numPlates; m++) if (cluster[m] === cluster[k]) members.push(m);
    // Area-weighted centroid of the block.
    let cx = 0, cy = 0, cz = 0, area = 0, cont = 0;
    for (const m of members) {
      cx += st.centroid[3 * m] * st.count[m];
      cy += st.centroid[3 * m + 1] * st.count[m];
      cz += st.centroid[3 * m + 2] * st.count[m];
      area += st.count[m];
      cont += st.continental[m];
    }
    const c: Vec3 = members.length === 1 ? cen(k) : normalize3([cx, cy, cz]);
    const continental = members.length > 1 || cont >= CONTINENTAL_PLATE_FRACTION * area;
    const [lo, hi] = continental ? CONTINENTAL_SPEED : OCEANIC_SPEED;
    const speed = rng.float(lo, hi) * speedScale;
    let dir = randomTangent(c, rng);
    if (!continental) {
      const pull = slabPullDirection(mesh, plate, crust, cluster, k, c, cells, off[k], off[k + 1]);
      if (pull) dir = normalize3(projectTangent(c, [dir[0] + 1.3 * pull[0], dir[1] + 1.3 * pull[1], dir[2] + 1.3 * pull[2]]));
    }
    const poleAngle = members.length > 1 ? ((rng.float(72, 90) * Math.PI) / 180) : randomPoleAngle(rng);
    const base = omegaWithPoleAngle(c, dir, speed, poleAngle, rng.bool() ? 1 : -1);
    for (const m of members) {
      let w: Vec3 = [base[0], base[1], base[2]];
      if (members.length > 1) {
        // Slow divergent spread away from the block centroid (young continental rifts).
        const cm = cen(m);
        let away = projectTangent(cm, [cm[0] - c[0], cm[1] - c[1], cm[2] - c[2]]);
        const l = Math.hypot(away[0], away[1], away[2]);
        away = l > 1e-3 ? [away[0] / l, away[1] / l, away[2] / l] : randomTangent(cm, rng);
        const spread = Math.min(CLUSTER_SPREAD_MAX, rng.float(2, CLUSTER_SPREAD_MAX) * Math.min(1, speedScale));
        const d = omegaWithPoleAngle(cm, away, spread, Math.PI / 2, 1);
        w = [w[0] + d[0], w[1] + d[1], w[2] + d[2]];
      }
      omega[m] = w;
      done[m] = 1;
    }
  }
  return { omega, cluster };
}
