import { MAX_PLATES } from '../core/constants';
import { quatIdentity, quatMul } from '../core/math3';
import type { Hotspot, PlateSpec, Quat, TectonicStats, Vec3, WorldDraft, WorldSnapshot } from '../core/types';
import { CRUST_CONTINENTAL } from '../core/types';
import { classifyBoundaries, clonePlateSpec, computePlateInfos } from './draft';
import { walkFrom, type SimMesh } from './simMesh';
import type { PlateSlot, SimState } from './simState';

/** Live slots in ascending order and slot → compact index. */
function compactSlots(state: SimState): { order: number[]; index: Int16Array } {
  const index = new Int16Array(MAX_PLATES).fill(-1);
  const order: number[] = [];
  for (let k = 0; k < MAX_PLATES; k++) {
    if (!state.slots[k]) continue;
    index[k] = order.length;
    order.push(k);
  }
  return { order, index };
}

/** Material frame → world: q_k ⊗ (spec.frame ?? identity). */
export function plateRotation(p: PlateSlot): Quat {
  return quatMul(p.q, p.spec.frame ?? quatIdentity());
}

/** Compact PlateSpecs with `frame` = current cumulative rotation. */
function compactSpecs(state: SimState, order: number[]): PlateSpec[] {
  return order.map((k) => {
    const p = state.slots[k] as PlateSlot;
    return clonePlateSpec({ ...p.spec, frame: plateRotation(p) });
  });
}

function cloneHotspots(hs: Hotspot[]): Hotspot[] {
  return hs.map((h) => ({ pos: [h.pos[0], h.pos[1], h.pos[2]] as Vec3, strength: h.strength, radius: h.radius }));
}

const bary = new Float64Array(3);
const triV = new Int32Array(3);

/** Test the triangles incident to lattice vertex v for containment of direction (x, y, z). */
function testFan(sm: SimMesh, v: number, x: number, y: number, z: number): boolean {
  const { vtOff, vtTri, xyz } = sm;
  const tris = sm.mesh.triangles;
  for (let q = vtOff[v], e = vtOff[v + 1]; q < e; q++) {
    const t = vtTri[q];
    const a = tris[3 * t], b = tris[3 * t + 1], c = tris[3 * t + 2];
    const ax = xyz[3 * a], ay = xyz[3 * a + 1], az = xyz[3 * a + 2];
    const bx = xyz[3 * b], by = xyz[3 * b + 1], bz = xyz[3 * b + 2];
    const cx = xyz[3 * c], cy = xyz[3 * c + 1], cz = xyz[3 * c + 2];
    // Barycentrics of a direction in a spherical triangle: w_a ∝ d·(b×c), etc.
    const wa = x * (by * cz - bz * cy) + y * (bz * cx - bx * cz) + z * (bx * cy - by * cx);
    if (wa < -1e-12) continue;
    const wb = x * (cy * az - cz * ay) + y * (cz * ax - cx * az) + z * (cx * ay - cy * ax);
    if (wb < -1e-12) continue;
    const wc = x * (ay * bz - az * by) + y * (az * bx - ax * bz) + z * (ax * by - ay * bx);
    if (wc < -1e-12) continue;
    const s = wa + wb + wc;
    if (!(s > 0)) continue;
    triV[0] = a;
    triV[1] = b;
    triV[2] = c;
    bary[0] = Math.max(0, wa) / s;
    bary[1] = Math.max(0, wb) / s;
    bary[2] = Math.max(0, wc) / s;
    return true;
  }
  return false;
}

/**
 * Find the Delaunay triangle of the (plate-frame) lattice containing direction (x, y, z), searching
 * the fans of j (the nearest vertex) and then of its neighbours. Writes triV / bary.
 */
function containingTriangle(sm: SimMesh, j: number, x: number, y: number, z: number): boolean {
  if (testFan(sm, j, x, y, z)) return true;
  const { adjOffset, adj } = sm;
  for (let q = adjOffset[j], e = adjOffset[j + 1]; q < e; q++) if (testFan(sm, adj[q], x, y, z)) return true;
  return false;
}

/**
 * Display fields: elev / age / orogeny interpolated barycentrically inside the top plate's lattice at
 * M_kᵀ s_i (owned vertices only, renormalized) — removes lattice-snap jitter — plus trench offsets.
 */
function interpolateFields(state: SimState, elev: Float32Array, age: Float32Array, orogeny: Float32Array): void {
  const { n, top, src, slots, trench } = state;
  const { xyz, toExt } = state.sm;
  for (let i = 0; i < n; i++) {
    const P = slots[top[i]] as PlateSlot;
    const j = src[i];
    const m = P.m;
    const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
    const lx = m[0] * x + m[3] * y + m[6] * z;
    const ly = m[1] * x + m[4] * y + m[7] * z;
    const lz = m[2] * x + m[5] * y + m[8] * z;
    let e = P.elev[j], a = P.age[j], o = P.orogeny[j];
    if (containingTriangle(state.sm, walkFrom(state.sm, lx, ly, lz, j), lx, ly, lz)) {
      let ws = 0, se = 0, sa = 0, so = 0;
      for (let c = 0; c < 3; c++) {
        const v = triV[c];
        if (!P.owned[v]) continue;
        const w = bary[c];
        ws += w;
        se += w * P.elev[v];
        sa += w * P.age[v];
        so += w * P.orogeny[v];
      }
      if (ws > 1e-9) {
        e = se / ws;
        a = sa / ws;
        o = so / ws;
      }
    }
    const out = toExt[i];
    elev[out] = e + trench[i];
    age[out] = a;
    orogeny[out] = o;
  }
}

/** World-frame snapshot of the current state (freshly allocated arrays). */
export function buildSnapshot(state: SimState, id: number): WorldSnapshot {
  const { n, top, src, slots } = state;
  const { toExt, ext } = state.sm;
  const { order, index } = compactSlots(state);
  // Output arrays use the caller's (external) cell numbering.
  const plate = new Int16Array(n);
  const crust = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const e = toExt[i];
    plate[e] = index[top[i]];
    crust[e] = (slots[top[i]] as PlateSlot).crust[src[i]];
  }
  const elev = new Float32Array(n);
  const age = new Float32Array(n);
  const orogeny = new Float32Array(n);
  interpolateFields(state, elev, age, orogeny);
  const specs = compactSpecs(state, order);
  return {
    id,
    time: state.time,
    n,
    plate,
    elev,
    crust,
    age,
    boundary: classifyBoundaries(ext, plate, specs),
    orogeny,
    plates: computePlateInfos(ext, plate, crust, specs),
    hotspots: cloneHotspots(state.hotspots),
  };
}

/** World-frame draft: raw lattice values of the top plate (no display interpolation or trenches). */
export function buildDraft(state: SimState): WorldDraft {
  const { n, top, src, slots } = state;
  const { order, index } = compactSlots(state);
  const plate = new Int16Array(n);
  const crust = new Uint8Array(n);
  const elev = new Float32Array(n);
  const age = new Float32Array(n);
  const orogeny = new Float32Array(n);
  const toExt = state.sm.toExt;
  for (let i = 0; i < n; i++) {
    const P = slots[top[i]] as PlateSlot;
    const j = src[i];
    const e = toExt[i];
    plate[e] = index[top[i]];
    crust[e] = P.crust[j];
    elev[e] = P.elev[j];
    age[e] = P.age[j];
    orogeny[e] = P.orogeny[j];
  }
  return {
    n,
    plate,
    crust,
    elev,
    age,
    orogeny,
    plates: compactSpecs(state, order),
    hotspots: cloneHotspots(state.hotspots),
    time: state.time,
    seed: state.params.seed,
    nextPlateId: state.nextPlateId,
    stepIndex: state.stepIndex,
    revision: 0,
  };
}

/** Summary statistics of the current state (raw lattice values of the top plates, no trenches). */
export function buildStats(state: SimState, lastStepMs: number): TectonicStats {
  const { n, top, src, slots, counters } = state;
  let land = 0, cont = 0, sum = 0, max = -Infinity, min = Infinity;
  for (let i = 0; i < n; i++) {
    const P = slots[top[i]] as PlateSlot;
    const j = src[i];
    const h = P.elev[j];
    if (h > 0) land++;
    if (P.crust[j] === CRUST_CONTINENTAL) cont++;
    sum += h;
    if (h > max) max = h;
    if (h < min) min = h;
  }
  let plates = 0;
  for (const p of slots) if (p) plates++;
  return {
    time: state.time,
    steps: state.stepIndex,
    lastStepMs,
    plateCount: plates,
    landFraction: land / n,
    continentalFraction: cont / n,
    meanElevation: sum / n,
    maxElevation: max,
    minElevation: min,
    continentalCreated: counters.continentalCreated,
    continentalDestroyed: counters.continentalDestroyed,
    subductedCells: counters.subductedCells,
    ridgeCells: counters.ridgeCells,
    rifts: counters.rifts,
    merges: counters.merges,
  };
}
