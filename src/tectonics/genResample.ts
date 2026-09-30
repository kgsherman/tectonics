import { MAX_PLATES } from '../core/constants';
import { nearestCell, vertexTriangles } from '../core/sphereMesh';
import type { PlateSpec, Quat, RGB, SphereMesh, Vec3, WorldDraft } from '../core/types';
import { enforceConnectivity } from './genCommon';

// resampleDraft: carry a draft to a mesh of another resolution. Categorical fields (plate, crust)
// take the nearest source cell; continuous fields (elev, age, orogeny) are interpolated
// barycentrically inside the containing source triangle using only vertices of the same crust type
// (so coastal cells never blend continental and abyssal values). Plates that vanish are compacted
// away and every plate is made connected again.

function clonePlate(p: PlateSpec): PlateSpec {
  const o: PlateSpec = {
    id: p.id,
    name: p.name,
    color: [p.color[0], p.color[1], p.color[2]] as RGB,
    omega: [p.omega[0], p.omega[1], p.omega[2]] as Vec3,
  };
  if (p.frame) o.frame = [p.frame[0], p.frame[1], p.frame[2], p.frame[3]] as Quat;
  return o;
}

/** Barycentric weights of (x, y, z) in triangle t; writes tri/w and returns true if it contains the point. */
function inTriangle(mesh: SphereMesh, t: number, x: number, y: number, z: number, tri: Int32Array, w: Float64Array): boolean {
  const { xyz, triangles } = mesh;
  const a = triangles[3 * t], b = triangles[3 * t + 1], c = triangles[3 * t + 2];
  const ax = xyz[3 * a], ay = xyz[3 * a + 1], az = xyz[3 * a + 2];
  const bx = xyz[3 * b], by = xyz[3 * b + 1], bz = xyz[3 * b + 2];
  const cx = xyz[3 * c], cy = xyz[3 * c + 1], cz = xyz[3 * c + 2];
  // w_a ∝ p·(b×c), w_b ∝ p·(c×a), w_c ∝ p·(a×b).
  const wa = x * (by * cz - bz * cy) + y * (bz * cx - bx * cz) + z * (bx * cy - by * cx);
  const wb = x * (cy * az - cz * ay) + y * (cz * ax - cx * az) + z * (cx * ay - cy * ax);
  const wc = x * (ay * bz - az * by) + y * (az * bx - ax * bz) + z * (ax * by - ay * bx);
  if (wa < -1e-12 || wb < -1e-12 || wc < -1e-12) return false;
  const sum = wa + wb + wc;
  if (!(sum > 0)) return false;
  tri[0] = a; tri[1] = b; tri[2] = c;
  w[0] = Math.max(0, wa) / sum; w[1] = Math.max(0, wb) / sum; w[2] = Math.max(0, wc) / sum;
  return true;
}

/**
 * Locate the source triangle containing direction (x, y, z) among the triangles around `near` and its
 * neighbours (writes tri/w); false if none contains it.
 */
function locate(mesh: SphereMesh, vt: { off: Int32Array; tri: Int32Array }, near: number, x: number, y: number, z: number, tri: Int32Array, w: Float64Array): boolean {
  const { adjOffset, adj } = mesh;
  for (let k = vt.off[near]; k < vt.off[near + 1]; k++) if (inTriangle(mesh, vt.tri[k], x, y, z, tri, w)) return true;
  for (let e = adjOffset[near]; e < adjOffset[near + 1]; e++) {
    const v = adj[e];
    for (let k = vt.off[v]; k < vt.off[v + 1]; k++) if (inTriangle(mesh, vt.tri[k], x, y, z, tri, w)) return true;
  }
  return false;
}

/** See draft.ts `resampleDraft`. Returns a new draft on mesh `to`; the input is not modified. */
export function resampleDraftImpl(from: SphereMesh, to: SphereMesh, draft: WorldDraft): WorldDraft {
  if (draft.n !== from.n) throw new Error(`resampleDraft: draft.n (${draft.n}) does not match the source mesh (${from.n})`);
  const np = draft.plates.length;
  for (const [name, a] of [['plate', draft.plate], ['crust', draft.crust], ['elev', draft.elev], ['age', draft.age]] as const) {
    if (a.length !== from.n) throw new Error(`resampleDraft: draft.${name} has length ${a.length}, expected ${from.n}`);
  }
  if (draft.orogeny && draft.orogeny.length !== from.n) throw new Error('resampleDraft: draft.orogeny has the wrong length');
  if (np === 0 || np > MAX_PLATES) throw new Error(`resampleDraft: plates.length must be 1..${MAX_PLATES}`);
  for (let i = 0; i < from.n; i++) {
    const k = draft.plate[i];
    if (!(k >= 0 && k < np)) throw new Error(`resampleDraft: cell ${i} has invalid plate index ${k}`);
  }
  const n = to.n;
  const plate = new Int16Array(n);
  const crust = new Uint8Array(n);
  const elev = new Float32Array(n);
  const age = new Float32Array(n);
  const orogeny = draft.orogeny ? new Float32Array(n) : undefined;
  const sameLattice = from.n === to.n; // the Fibonacci lattice is fully determined by n
  const tri = new Int32Array(3);
  const w = new Float64Array(3);
  const vt = vertexTriangles(from);
  for (let i = 0; i < n; i++) {
    const x = to.xyz[3 * i], y = to.xyz[3 * i + 1], z = to.xyz[3 * i + 2];
    // No hint: consecutive Fibonacci cells are ~137.5° of longitude apart, so walking from the previous
    // answer is ~20× slower than the lookup-table start.
    const s = sameLattice ? i : nearestCell(from, x, y, z);
    plate[i] = draft.plate[s];
    crust[i] = draft.crust[s];
    elev[i] = draft.elev[s];
    age[i] = draft.age[s];
    if (orogeny) orogeny[i] = draft.orogeny![s];
    if (sameLattice || !locate(from, vt, s, x, y, z, tri, w)) continue;
    // Interpolate over the triangle's vertices of the same crust type, renormalized.
    let sw = 0, se = 0, sa = 0, so = 0;
    for (let q = 0; q < 3; q++) {
      const v = tri[q];
      if (draft.crust[v] !== crust[i]) continue;
      sw += w[q];
      se += w[q] * draft.elev[v];
      sa += w[q] * draft.age[v];
      if (orogeny) so += w[q] * draft.orogeny![v];
    }
    if (sw > 1e-9) {
      elev[i] = se / sw;
      age[i] = sa / sw;
      if (orogeny) orogeny[i] = so / sw;
    }
  }
  // Compaction: drop plates that received no cells, then make every plate connected.
  const used = new Uint8Array(np);
  for (let i = 0; i < n; i++) used[plate[i]] = 1;
  const remap = new Int16Array(np).fill(-1);
  const plates: PlateSpec[] = [];
  for (let k = 0; k < np; k++) {
    if (!used[k]) continue;
    remap[k] = plates.length;
    plates.push(clonePlate(draft.plates[k]));
  }
  for (let i = 0; i < n; i++) plate[i] = remap[plate[i]];
  enforceConnectivity(to, plate, plates.length);
  return {
    n,
    plate,
    crust,
    elev,
    age,
    orogeny,
    plates,
    hotspots: draft.hotspots.map((h) => ({ pos: [h.pos[0], h.pos[1], h.pos[2]] as Vec3, strength: h.strength, radius: h.radius })),
    time: draft.time,
    seed: draft.seed,
    nextPlateId: Math.max(draft.nextPlateId ?? 0, ...draft.plates.map((p) => p.id + 1), 1),
    stepIndex: draft.stepIndex,
    revision: draft.revision,
  };
}
