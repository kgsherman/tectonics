import { EARTH_RADIUS_KM } from '../core/constants';
import { createNoise3, fbm3 } from '../core/noise';
import { Rng } from '../core/rng';
import type { PlateInfo, PlateSpec, RGB, SphereMesh, Vec3, WorldDraft, WorldSnapshot } from '../core/types';
import {
  BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT, BOUNDARY_NONE, BOUNDARY_TRANSFORM, CRUST_CONTINENTAL, CRUST_OCEANIC,
} from '../core/types';

// Helpers shared by the generator, the simulation, the plate editor and the app.

const PALETTE: RGB[] = [
  [230, 97, 84], [72, 152, 214], [245, 181, 66], [104, 186, 110], [166, 110, 204], [64, 196, 190],
  [236, 132, 176], [150, 172, 64], [238, 146, 70], [96, 120, 222], [196, 84, 128], [120, 200, 160],
  [214, 196, 92], [84, 164, 150], [206, 120, 88], [140, 140, 230], [110, 206, 222], [226, 110, 214],
  [176, 146, 104], [96, 180, 84], [240, 206, 150], [124, 104, 170], [206, 70, 70], [70, 120, 150],
];

function hslToRgb(h: number, s: number, l: number): RGB {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** Distinct, pleasant plate color for the k-th plate (cycles a curated palette, then golden-angle hues). */
export function plateColor(k: number): RGB {
  const i = Math.max(0, Math.floor(k));
  if (i < PALETTE.length) return [...PALETTE[i]] as RGB;
  const h = (i * 0.61803398875) % 1;
  const l = 0.5 + 0.12 * (((i * 7) % 3) - 1);
  return hslToRgb(h, 0.55, l);
}

const SYL_A = ['Ka', 'Tho', 'Ve', 'Mar', 'Ise', 'Or', 'Lu', 'Sa', 'Dra', 'Ny', 'Pel', 'Qua', 'Ro', 'Tir', 'Ul', 'Ze', 'Aru', 'Bel', 'Cor', 'Hes'];
const SYL_B = ['ra', 'len', 'thi', 'mos', 'dar', 'nia', 'vel', 'ros', 'ka', 'tan', 'lis', 'gor', 'phe', 'dun', 'mar', 'sen'];
const SYL_C = ['', 'an', 'ic', 'ia', 'ean', 'ine', 'is', 'on'];

/** Evocative plate name for the k-th plate, deterministic in (k, seed). */
export function plateName(k: number, seed: number): string {
  const r = new Rng(((seed | 0) * 7919 + k * 104729 + 17) >>> 0);
  const name = r.pick(SYL_A) + r.pick(SYL_B) + r.pick(SYL_C);
  return `${name} Plate`;
}

/** Area/centroid/continental fraction/speed for each plate given a per-cell plate index array. */
export function computePlateInfos(mesh: SphereMesh, plate: Int16Array, crust: Uint8Array, plates: PlateSpec[]): PlateInfo[] {
  const np = plates.length;
  const sx = new Float64Array(np), sy = new Float64Array(np), sz = new Float64Array(np);
  const count = new Float64Array(np), cont = new Float64Array(np);
  const first = new Int32Array(np).fill(-1);
  const { xyz, n } = mesh;
  for (let i = 0; i < n; i++) {
    const k = plate[i];
    if (k < 0 || k >= np) continue;
    sx[k] += xyz[3 * i];
    sy[k] += xyz[3 * i + 1];
    sz[k] += xyz[3 * i + 2];
    count[k]++;
    if (crust[i] === CRUST_CONTINENTAL) cont[k]++;
    if (first[k] < 0) first[k] = i;
  }
  return plates.map((p, k) => {
    let c: Vec3 = [sx[k], sy[k], sz[k]];
    const l = Math.hypot(c[0], c[1], c[2]);
    if (l > 1e-9 * Math.max(1, count[k])) c = [c[0] / l, c[1] / l, c[2] / l];
    else if (first[k] >= 0) c = [xyz[3 * first[k]], xyz[3 * first[k] + 1], xyz[3 * first[k] + 2]];
    else c = [0, 0, 1];
    const w = p.omega;
    const vx = w[1] * c[2] - w[2] * c[1];
    const vy = w[2] * c[0] - w[0] * c[2];
    const vz = w[0] * c[1] - w[1] * c[0];
    return {
      id: p.id,
      name: p.name,
      color: [p.color[0], p.color[1], p.color[2]] as RGB,
      omega: [w[0], w[1], w[2]] as Vec3,
      centroid: c,
      area: count[k] / n,
      continentalFraction: count[k] > 0 ? cont[k] / count[k] : 0,
      speed: Math.hypot(vx, vy, vz) * EARTH_RADIUS_KM,
    };
  });
}

/**
 * Classify plate-boundary cells (cells with a neighbor on another plate) as
 * BOUNDARY_CONVERGENT / DIVERGENT / TRANSFORM from the relative surface velocity of the two plates
 * projected on the boundary normal; BOUNDARY_NONE elsewhere.
 */
export function classifyBoundaries(mesh: SphereMesh, plate: Int16Array, plates: PlateSpec[], out?: Uint8Array): Uint8Array {
  const { n, xyz, adjOffset, adj } = mesh;
  const o = out && out.length >= n ? out : new Uint8Array(n);
  o.fill(BOUNDARY_NONE, 0, n);
  const np = plates.length;
  for (let i = 0; i < n; i++) {
    const a = plate[i];
    if (a < 0 || a >= np) continue;
    const px = xyz[3 * i], py = xyz[3 * i + 1], pz = xyz[3 * i + 2];
    let normalSum = 0;
    let tangSum = 0;
    let cnt = 0;
    for (let k = adjOffset[i]; k < adjOffset[i + 1]; k++) {
      const j = adj[k];
      const b = plate[j];
      if (b === a || b < 0 || b >= np) continue;
      // Boundary normal: from i toward j, projected to the tangent plane at i.
      let nx = xyz[3 * j] - px, ny = xyz[3 * j + 1] - py, nz = xyz[3 * j + 2] - pz;
      const d = nx * px + ny * py + nz * pz;
      nx -= d * px; ny -= d * py; nz -= d * pz;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      // Velocity of the other plate relative to this one at i: (w_b - w_a) x p.
      const wa = plates[a].omega, wb = plates[b].omega;
      const wx = wb[0] - wa[0], wy = wb[1] - wa[1], wz = wb[2] - wa[2];
      const vx = wy * pz - wz * py, vy = wz * px - wx * pz, vz = wx * py - wy * px;
      const vn = vx * nx + vy * ny + vz * nz; // > 0: other plate moves away from us
      const tx = vx - vn * nx, ty = vy - vn * ny, tz = vz - vn * nz;
      normalSum += vn;
      tangSum += Math.hypot(tx, ty, tz);
      cnt++;
    }
    if (cnt === 0) continue;
    const vn = normalSum / cnt;
    const vt = tangSum / cnt;
    // ~2 km/Myr on the unit sphere
    const tiny = 2 / EARTH_RADIUS_KM;
    if (Math.abs(vn) < tiny && vt < tiny) o[i] = BOUNDARY_TRANSFORM;
    else if (Math.abs(vn) < 0.5 * vt) o[i] = BOUNDARY_TRANSFORM;
    else o[i] = vn < 0 ? BOUNDARY_CONVERGENT : BOUNDARY_DIVERGENT;
  }
  return o;
}

/** Build a WorldSnapshot view of a draft (orogeny = 0, boundaries classified) for rendering in the editor. */
export function snapshotFromDraft(mesh: SphereMesh, draft: WorldDraft): WorldSnapshot {
  return {
    time: draft.time,
    n: draft.n,
    plate: draft.plate.slice(),
    elev: draft.elev.slice(),
    crust: draft.crust.slice(),
    age: draft.age.slice(),
    boundary: classifyBoundaries(mesh, draft.plate, draft.plates),
    orogeny: new Float32Array(draft.n),
    plates: computePlateInfos(mesh, draft.plate, draft.crust, draft.plates),
    hotspots: draft.hotspots.map((h) => ({ pos: [...h.pos] as Vec3, strength: h.strength, radius: h.radius })),
  };
}

/** One oceanic plate covering the whole sphere, ocean floor at a uniform mid age. */
export function blankDraft(mesh: SphereMesh, seed = 1): WorldDraft {
  const n = mesh.n;
  const age = 60;
  return {
    n,
    plate: new Int16Array(n),
    crust: new Uint8Array(n).fill(CRUST_OCEANIC),
    elev: new Float32Array(n).fill(oceanDepthForAge(age)),
    age: new Float32Array(n).fill(age),
    plates: [{ id: 1, name: plateName(0, seed), color: plateColor(0), omega: [0, 0, 0] }],
    hotspots: [],
    time: 0,
    seed,
  };
}

/** Deep copy. */
export function cloneDraft(draft: WorldDraft): WorldDraft {
  return {
    n: draft.n,
    plate: draft.plate.slice(),
    crust: draft.crust.slice(),
    elev: draft.elev.slice(),
    age: draft.age.slice(),
    plates: draft.plates.map((p) => ({
      id: p.id,
      name: p.name,
      color: [p.color[0], p.color[1], p.color[2]] as RGB,
      omega: [p.omega[0], p.omega[1], p.omega[2]] as Vec3,
    })),
    hotspots: draft.hotspots.map((h) => ({ pos: [h.pos[0], h.pos[1], h.pos[2]] as Vec3, strength: h.strength, radius: h.radius })),
    time: draft.time,
    seed: draft.seed,
  };
}

/**
 * Assign every cell to the nearest seed (noise-warped distance so boundaries are irregular).
 * roughness 0..1. Returns per-cell index into `seeds`. Each resulting plate region is connected
 * (smaller disconnected fragments are absorbed by their neighbors).
 */
export function voronoiPlates(mesh: SphereMesh, seeds: Vec3[], roughness: number, seed: number): Int16Array {
  const { n, xyz } = mesh;
  const out = new Int16Array(n).fill(-1);
  if (seeds.length === 0) return out.fill(0);
  const nx = createNoise3(seed * 31 + 1), ny = createNoise3(seed * 31 + 2), nz = createNoise3(seed * 31 + 3);
  const amp = 0.45 * Math.max(0, Math.min(1, roughness));
  const f = 2.2;
  const S = seeds.map((s) => {
    const l = Math.hypot(s[0], s[1], s[2]) || 1;
    return [s[0] / l, s[1] / l, s[2] / l];
  });
  for (let i = 0; i < n; i++) {
    let x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
    if (amp > 0) {
      const wx = fbm3(nx, x * f, y * f, z * f, 4);
      const wy = fbm3(ny, x * f, y * f, z * f, 4);
      const wz = fbm3(nz, x * f, y * f, z * f, 4);
      x += amp * wx; y += amp * wy; z += amp * wz;
    }
    let best = 0, bd = -Infinity;
    for (let k = 0; k < S.length; k++) {
      const d = S[k][0] * x + S[k][1] * y + S[k][2] * z;
      if (d > bd) { bd = d; best = k; }
    }
    out[i] = best;
  }
  enforceConnectivity(mesh, out, S.length);
  return out;
}

/** Keep only the largest connected component of each label; reassign the rest by flood fill from neighbors. */
export function enforceConnectivity(mesh: SphereMesh, label: Int16Array, numLabels: number): void {
  const { n, adjOffset, adj } = mesh;
  const comp = new Int32Array(n).fill(-1);
  const compSize: number[] = [];
  const compLabel: number[] = [];
  const queue = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0 || label[s] < 0) continue;
    const c = compSize.length;
    const lab = label[s];
    let head = 0, tail = 0;
    queue[tail++] = s;
    comp[s] = c;
    while (head < tail) {
      const i = queue[head++];
      for (let k = adjOffset[i]; k < adjOffset[i + 1]; k++) {
        const j = adj[k];
        if (comp[j] < 0 && label[j] === lab) {
          comp[j] = c;
          queue[tail++] = j;
        }
      }
    }
    compSize.push(tail);
    compLabel.push(lab);
  }
  const bestComp = new Int32Array(numLabels).fill(-1);
  for (let c = 0; c < compSize.length; c++) {
    const lab = compLabel[c];
    if (lab < 0 || lab >= numLabels) continue;
    if (bestComp[lab] < 0 || compSize[c] > compSize[bestComp[lab]]) bestComp[lab] = c;
  }
  let tail = 0;
  for (let i = 0; i < n; i++) {
    const lab = label[i];
    if (lab >= 0 && lab < numLabels && comp[i] !== bestComp[lab]) label[i] = -1;
  }
  // Multi-source BFS from labeled cells into unlabeled ones.
  for (let i = 0; i < n; i++) {
    if (label[i] >= 0) continue;
    for (let k = adjOffset[i]; k < adjOffset[i + 1]; k++) {
      if (label[adj[k]] >= 0) {
        queue[tail++] = i;
        break;
      }
    }
  }
  let head = 0;
  while (head < tail) {
    const i = queue[head++];
    if (label[i] >= 0) continue;
    // Take the most common labeled neighbor.
    let bestLab = -1, bestCnt = 0;
    for (let k = adjOffset[i]; k < adjOffset[i + 1]; k++) {
      const lj = label[adj[k]];
      if (lj < 0) continue;
      let c = 0;
      for (let q = adjOffset[i]; q < adjOffset[i + 1]; q++) if (label[adj[q]] === lj) c++;
      if (c > bestCnt) { bestCnt = c; bestLab = lj; }
    }
    if (bestLab < 0) continue;
    label[i] = bestLab;
    for (let k = adjOffset[i]; k < adjOffset[i + 1]; k++) {
      const j = adj[k];
      if (label[j] < 0) queue[tail++] = j;
    }
  }
  for (let i = 0; i < n; i++) if (label[i] < 0) label[i] = 0;
}

/**
 * Ocean-floor depth (m, negative) for crust of the given age (Myr): GDH1 plate-cooling model
 * (Stein & Stein 1992): 2600 + 365·sqrt(t) for t < 20 Myr, 5651 − 2473·exp(−0.0278·t) after.
 */
export function oceanDepthForAge(ageMyr: number): number {
  const t = Math.max(0, ageMyr);
  if (t < 20) return -(2600 + 365 * Math.sqrt(t));
  return -(5651 - 2473 * Math.exp(-0.0278 * t));
}

/**
 * Remove plates that own no cells and renumber the per-cell plate indices accordingly.
 * Returns a new draft (input not modified).
 */
export function compactDraft(draft: WorldDraft): WorldDraft {
  const d = cloneDraft(draft);
  const np = d.plates.length;
  const used = new Uint8Array(np);
  for (let i = 0; i < d.n; i++) {
    const k = d.plate[i];
    if (k >= 0 && k < np) used[k] = 1;
  }
  const remap = new Int16Array(np).fill(-1);
  const plates: PlateSpec[] = [];
  for (let k = 0; k < np; k++) {
    if (used[k]) {
      remap[k] = plates.length;
      plates.push(d.plates[k]);
    }
  }
  if (plates.length === 0 && np > 0) {
    plates.push(d.plates[0]);
    remap[0] = 0;
  }
  for (let i = 0; i < d.n; i++) {
    const k = d.plate[i];
    d.plate[i] = k >= 0 && k < np && remap[k] >= 0 ? remap[k] : 0;
  }
  d.plates = plates;
  return d;
}
