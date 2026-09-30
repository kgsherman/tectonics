import { EARTH_RADIUS_KM, MAX_PLATES } from '../core/constants';
import { createNoise3, fbm3 } from '../core/noise';
import { nearestCell } from '../core/sphereMesh';
import { latLonToVec } from '../core/math3';
import type { Hotspot, PlateInfo, PlateSpec, Quat, RGB, SphereMesh, Vec3, WorldDraft, WorldSnapshot } from '../core/types';
import {
  BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT, BOUNDARY_NONE, BOUNDARY_TRANSFORM, CRUST_CONTINENTAL, CRUST_OCEANIC,
} from '../core/types';
import { enforceConnectivity, oceanDepthForAge, plateColor, plateName } from './genCommon';
import { finalizeDraftImpl } from './genFinalize';
import { resampleDraftImpl } from './genResample';

// Helpers shared by the generator, the simulation, the plate editor and the app.
// The leaf helpers live in genCommon.ts (so gen* modules never import this file) and are re-exported here.
export { enforceConnectivity, oceanDepthForAge, plateColor, plateName };

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
    const fr: Quat = p.frame ? [p.frame[0], p.frame[1], p.frame[2], p.frame[3]] : [0, 0, 0, 1];
    return {
      id: p.id,
      name: p.name,
      color: [p.color[0], p.color[1], p.color[2]] as RGB,
      omega: [w[0], w[1], w[2]] as Vec3,
      frame: [fr[0], fr[1], fr[2], fr[3]] as Quat,
      rotation: fr,
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
let snapshotCounter = 0;

export function snapshotFromDraft(mesh: SphereMesh, draft: WorldDraft): WorldSnapshot {
  snapshotCounter = (snapshotCounter + 1) % 0x40000000;
  return {
    // Negative ids never collide with sim ids (sim ids are positive).
    id: -(snapshotCounter + 1),
    time: draft.time,
    n: draft.n,
    plate: draft.plate.slice(),
    elev: draft.elev.slice(),
    crust: draft.crust.slice(),
    age: draft.age.slice(),
    boundary: classifyBoundaries(mesh, draft.plate, draft.plates),
    orogeny: draft.orogeny ? draft.orogeny.slice() : new Float32Array(draft.n),
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
    nextPlateId: 2,
    stepIndex: 0,
    revision: 0,
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
    orogeny: draft.orogeny ? draft.orogeny.slice() : undefined,
    plates: draft.plates.map(clonePlateSpec),
    hotspots: draft.hotspots.map(cloneHotspot),
    time: draft.time,
    seed: draft.seed,
    nextPlateId: Math.max(draft.nextPlateId ?? 0, ...draft.plates.map((p) => p.id + 1), 1),
    stepIndex: draft.stepIndex,
    revision: draft.revision,
  };
}

export function clonePlateSpec(p: PlateSpec): PlateSpec {
  const o: PlateSpec = {
    id: p.id,
    name: p.name,
    color: [p.color[0], p.color[1], p.color[2]] as RGB,
    omega: [p.omega[0], p.omega[1], p.omega[2]] as Vec3,
  };
  if (p.frame) o.frame = [p.frame[0], p.frame[1], p.frame[2], p.frame[3]];
  return o;
}

function cloneHotspot(h: Hotspot): Hotspot {
  return { pos: [h.pos[0], h.pos[1], h.pos[2]] as Vec3, strength: h.strength, radius: h.radius };
}

/**
 * Assign every cell to the nearest seed (noise-warped distance so boundaries are irregular).
 * roughness 0..1. Returns per-cell index into `seeds`. Each resulting plate region is connected
 * (smaller disconnected fragments are absorbed by their neighbors).
 */
export function voronoiPlates(mesh: SphereMesh, seeds: Vec3[], roughness: number, seed: number): Int16Array {
  if (seeds.length > MAX_PLATES) throw new Error(`voronoiPlates: at most ${MAX_PLATES} seeds`);
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

/**
 * World-frame draft from a snapshot (e.g. a history keyframe) so the sim can resume from it.
 * Plate frames (PlateInfo.rotation) are carried into PlateSpec.frame; orogeny is kept.
 */
export function draftFromSnapshot(s: WorldSnapshot, seed: number, stepIndex = 0): WorldDraft {
  const plates: PlateSpec[] = s.plates.map((p) =>
    clonePlateSpec({ id: p.id, name: p.name, color: p.color, omega: p.omega, frame: p.rotation }),
  );
  return {
    n: s.n,
    plate: s.plate.slice(),
    crust: s.crust.slice(),
    elev: s.elev.slice(),
    age: s.age.slice(),
    orogeny: s.orogeny.slice(),
    plates,
    hotspots: s.hotspots.map(cloneHotspot),
    time: s.time,
    seed,
    nextPlateId: Math.max(1, ...plates.map((p) => p.id + 1)),
    stepIndex,
    revision: 0,
  };
}

export interface CellSample {
  cell: number;
  plateIndex: number;
  plate: PlateInfo | null;
  elev: number;
  crust: number;
  age: number;
  boundary: number;
  orogeny: number;
}

/** Nearest-cell sample of a snapshot at (lat, lon) radians (hover inspector). */
export function sampleSnapshotAt(mesh: SphereMesh, s: WorldSnapshot, lat: number, lon: number, hint?: number): CellSample {
  const v = latLonToVec(lat, lon);
  const cell = nearestCell(mesh, v[0], v[1], v[2], hint);
  const k = s.plate[cell];
  return {
    cell,
    plateIndex: k,
    plate: k >= 0 && k < s.plates.length ? s.plates[k] : null,
    elev: s.elev[cell],
    crust: s.crust[cell],
    age: s.age[cell],
    boundary: s.boundary[cell],
    orogeny: s.orogeny[cell],
  };
}

/**
 * Make a hand-edited draft simulation-ready (editor "Simulate this world" + app). Compacts plates,
 * splits disconnected plate components into separate plates (fragments < 20 cells merge into a
 * neighbour; new plates keep the parent's motion/frame), gives motionless plates a random 30–60 km/Myr
 * motion (deterministic in `seed`), synthesizes oceanic crust age from distance to the divergent
 * boundaries of the current motions and sets ocean depth with oceanDepthForAge plus a continental rise
 * on passive margins (cells flagged in `keepElevation` keep their elevation and, if valid, their age),
 * and gives continental cells with no plausible elevation (< −1000 m) a shelf-to-plateau coastal
 * profile. Returns a new draft (input unmodified; revision + 1). Throws on malformed drafts (wrong
 * lengths, invalid plate indices, non-finite motions).
 */
export function finalizeDraft(mesh: SphereMesh, draft: WorldDraft, seed: number, keepElevation?: Uint8Array): WorldDraft {
  return finalizeDraftImpl(mesh, draft, seed, keepElevation);
}

/**
 * Carry a draft to a mesh of another resolution: nearest cell for plate/crust, barycentric (within the
 * same crust type) for elev/age/orogeny, then compaction + connectivity cleanup. Input unmodified.
 * Throws on malformed drafts (wrong lengths, invalid plate indices).
 */
export function resampleDraft(from: SphereMesh, to: SphereMesh, draft: WorldDraft): WorldDraft {
  return resampleDraftImpl(from, to, draft);
}
