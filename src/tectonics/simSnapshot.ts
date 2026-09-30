import { EARTH_RADIUS_KM, MAX_PLATES } from '../core/constants';
import { quatIdentity, quatMul } from '../core/math3';
import type { Hotspot, PlateInfo, PlateSpec, Quat, RGB, TectonicStats, Vec3, WorldDraft, WorldSnapshot } from '../core/types';
import { BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT, BOUNDARY_TRANSFORM, CRUST_CONTINENTAL } from '../core/types';
import { clonePlateSpec } from './draft';
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
 * Per-cell outputs in one pass (external numbering): plate / crust of the top plate; elev / age /
 * orogeny interpolated barycentrically inside the top plate's lattice at p = M_kᵀ s_i (owned vertices
 * only, renormalized — removes lattice-snap jitter) plus trench offsets; the boundary class; per-slot
 * sums for the plate infos (xyz sums, cell and continental counts, first external cell).
 *
 * Point location: src[i] is the exact nearest lattice vertex j of p (the world pass just found it), and
 * the lattice adjacency is a CCW cycle, so the containing Delaunay triangle is normally the sector
 * (j, a, b) of j's fan where p·(s_j × s_q) = (p × s_j)·s_q turns from + to −. Those two dot products are
 * the (unnormalized) barycentric weights of b and a, and p·(s_a × s_b) that of j: a few dot products per
 * cell instead of a triangle walk. When p lies beyond the fan (j not a vertex of the containing
 * triangle, rare) an exact search over the fans of j and its neighbours takes over.
 */
function fillCells(
  state: SimState, index: Int16Array, plate: Int16Array, crust: Uint8Array, elev: Float32Array, age: Float32Array,
  orogeny: Float32Array, boundary: Uint8Array, sums: Float64Array,
): void {
  const { n, top, src, slots, trench } = state;
  const sm = state.sm;
  const { xyz, toExt, adjOffset, adj, fanOk } = sm;
  for (let i = 0; i < n; i++) {
    const k = top[i];
    const P = slots[k] as PlateSlot;
    const j = src[i];
    const m = P.m;
    const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
    const lx = m[0] * x + m[3] * y + m[6] * z;
    const ly = m[1] * x + m[4] * y + m[7] * z;
    const lz = m[2] * x + m[5] * y + m[8] * z;
    const pe = P.elev, pa = P.age, po = P.orogeny, owned = P.owned;
    let e = pe[j], a = pa[j], o = po[j];
    let located = false;
    if (fanOk[j]) {
      const xj = xyz[3 * j], yj = xyz[3 * j + 1], zj = xyz[3 * j + 2];
      const cx = ly * zj - lz * yj, cy = lz * xj - lx * zj, cz = lx * yj - ly * xj;
      const q0 = adjOffset[j], q1 = adjOffset[j + 1];
      let va = adj[q0];
      let ax = xyz[3 * va], ay = xyz[3 * va + 1], az = xyz[3 * va + 2];
      let dPrev = cx * ax + cy * ay + cz * az;
      for (let q = q0; q < q1; q++) {
        const vb = adj[q + 1 < q1 ? q + 1 : q0];
        const bx = xyz[3 * vb], by = xyz[3 * vb + 1], bz = xyz[3 * vb + 2];
        const dNext = cx * bx + cy * by + cz * bz;
        if (dPrev >= 0 && dNext <= 0) {
          const wj = lx * (ay * bz - az * by) + ly * (az * bx - ax * bz) + lz * (ax * by - ay * bx);
          const w0 = wj > 0 ? wj : 0;
          const s = w0 + dPrev - dNext;
          if (wj >= -1e-12 && s > 0) {
            located = true;
            let ws = 0, se = 0, sa = 0, so = 0;
            if (owned[j]) {
              ws += w0;
              se += w0 * pe[j];
              sa += w0 * pa[j];
              so += w0 * po[j];
            }
            if (owned[va]) {
              ws -= dNext;
              se -= dNext * pe[va];
              sa -= dNext * pa[va];
              so -= dNext * po[va];
            }
            if (owned[vb]) {
              ws += dPrev;
              se += dPrev * pe[vb];
              sa += dPrev * pa[vb];
              so += dPrev * po[vb];
            }
            if (ws > 1e-9 * s) {
              e = se / ws;
              a = sa / ws;
              o = so / ws;
            }
          }
          break;
        }
        va = vb;
        ax = bx;
        ay = by;
        az = bz;
        dPrev = dNext;
      }
    }
    if (!located && containingTriangle(sm, walkFrom(sm, lx, ly, lz, j), lx, ly, lz)) {
      let ws = 0, se = 0, sa = 0, so = 0;
      for (let c = 0; c < 3; c++) {
        const v = triV[c];
        if (!owned[v]) continue;
        const w = bary[c];
        ws += w;
        se += w * pe[v];
        sa += w * pa[v];
        so += w * po[v];
      }
      if (ws > 1e-9) {
        e = se / ws;
        a = sa / ws;
        o = so / ws;
      }
    }
    const out = toExt[i];
    const cr = P.crust[j];
    plate[out] = index[k];
    crust[out] = cr;
    elev[out] = e + trench[i];
    age[out] = a;
    orogeny[out] = o;
    const q = 6 * k;
    sums[q] += x;
    sums[q + 1] += y;
    sums[q + 2] += z;
    sums[q + 3]++;
    if (cr === CRUST_CONTINENTAL) sums[q + 4]++;
    if (out < sums[q + 5]) sums[q + 5] = out;
    const a1 = adjOffset[i + 1];
    let qf = adjOffset[i];
    while (qf < a1 && top[adj[qf]] === k) qf++;
    if (qf < a1) boundary[out] = classifyCell(state, i, qf);
  }
}

/**
 * BOUNDARY_* of world cell i whose first foreign neighbour sits at adjacency entry q0: draft.ts
 * classifyBoundaries evaluated in the internal numbering (same neighbour order, identical result).
 */
function classifyCell(state: SimState, i: number, q0: number): number {
  const { top, slots } = state;
  const { xyz, adjOffset, adj } = state.sm;
  const ta = top[i];
  const wa = (slots[ta] as PlateSlot).spec.omega;
  const px = xyz[3 * i], py = xyz[3 * i + 1], pz = xyz[3 * i + 2];
  let normalSum = 0;
  let tangSum = 0;
  let cnt = 0;
  for (let k = q0, a1 = adjOffset[i + 1]; k < a1; k++) {
    const j = adj[k];
    const tb = top[j];
    if (tb === ta) continue;
    let nx = xyz[3 * j] - px, ny = xyz[3 * j + 1] - py, nz = xyz[3 * j + 2] - pz;
    const d = nx * px + ny * py + nz * pz;
    nx -= d * px; ny -= d * py; nz -= d * pz;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const wb = (slots[tb] as PlateSlot).spec.omega;
    const wx = wb[0] - wa[0], wy = wb[1] - wa[1], wz = wb[2] - wa[2];
    const vx = wy * pz - wz * py, vy = wz * px - wx * pz, vz = wx * py - wy * px;
    const vn = vx * nx + vy * ny + vz * nz;
    const tx = vx - vn * nx, ty = vy - vn * ny, tz = vz - vn * nz;
    normalSum += vn;
    tangSum += Math.hypot(tx, ty, tz);
    cnt++;
  }
  const vn = normalSum / cnt;
  const vt = tangSum / cnt;
  const tiny = 2 / EARTH_RADIUS_KM;
  if (Math.abs(vn) < tiny && vt < tiny) return BOUNDARY_TRANSFORM;
  if (Math.abs(vn) < 0.5 * vt) return BOUNDARY_TRANSFORM;
  return vn < 0 ? BOUNDARY_CONVERGENT : BOUNDARY_DIVERGENT;
}

/** draft.ts computePlateInfos from the per-slot sums of fillCells (summed in internal cell order). */
function plateInfos(state: SimState, order: number[], specs: PlateSpec[], sums: Float64Array): PlateInfo[] {
  const { n } = state;
  const xyz = state.sm.ext.xyz;
  return specs.map((p, idx) => {
    const q = 6 * order[idx];
    const count = sums[q + 3], first = sums[q + 5];
    let c: Vec3 = [sums[q], sums[q + 1], sums[q + 2]];
    const l = Math.hypot(c[0], c[1], c[2]);
    if (l > 1e-9 * Math.max(1, count)) c = [c[0] / l, c[1] / l, c[2] / l];
    else if (count > 0) c = [xyz[3 * first], xyz[3 * first + 1], xyz[3 * first + 2]];
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
      area: count / n,
      continentalFraction: count > 0 ? sums[q + 4] / count : 0,
      speed: Math.hypot(vx, vy, vz) * EARTH_RADIUS_KM,
    };
  });
}

/** World-frame snapshot of the current state (freshly allocated arrays, the caller's cell numbering). */
export function buildSnapshot(state: SimState, id: number): WorldSnapshot {
  const { n } = state;
  const { order, index } = compactSlots(state);
  const plate = new Int16Array(n);
  const crust = new Uint8Array(n);
  const elev = new Float32Array(n);
  const age = new Float32Array(n);
  const orogeny = new Float32Array(n);
  const boundary = new Uint8Array(n);
  const sums = new Float64Array(6 * MAX_PLATES);
  for (let k = 0; k < MAX_PLATES; k++) sums[6 * k + 5] = n;
  fillCells(state, index, plate, crust, elev, age, orogeny, boundary, sums);
  const specs = compactSpecs(state, order);
  return {
    id,
    time: state.time,
    n,
    plate,
    elev,
    crust,
    age,
    boundary,
    orogeny,
    plates: plateInfos(state, order, specs, sums),
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
