import { EARTH_RADIUS_KM, MAX_PLATES } from '../core/constants';
import { tangentBasis } from '../core/math3';
import { Rng } from '../core/rng';
import type { PlateSpec, Quat, RGB, SphereMesh, Vec3, WorldDraft } from '../core/types';
import { CRUST_CONTINENTAL, CRUST_OCEANIC } from '../core/types';
import { oceanDepthForAge, plateColor, plateName } from './genCommon';
import { analyzeContinents } from './genContinents';
import { labelComponents } from './genGraph';
import { boundaryKinematics } from './genKinematics';
import { omegaWithPoleAngle, plateStats } from './genMotion';
import { oceanAges } from './genOceanAge';
import { MARGIN_RISE_DEPTH, passiveMarginRise } from './genRelief';

// finalizeDraft: make a hand-edited draft simulation-ready (SPEC §5). Reuses the generator's
// kinematics, ocean-age and margin code so edited and generated worlds look alike.

/** Disconnected plate fragments smaller than this merge into a neighbouring plate. */
export const MIN_FRAGMENT_CELLS = 20;
/** Plates slower than this (km/Myr) count as "not moving" and get a default motion. */
const ZERO_MOTION_KM_MYR = 0.5;
/** Default motion speed range for motionless plates, km/Myr. */
const DEFAULT_SPEED: [number, number] = [30, 60];
/** Continental cells below this elevation are treated as unset (e.g. crust flipped without relief). */
const IMPLAUSIBLE_CONTINENTAL_ELEV = -1000;

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

function validate(mesh: SphereMesh, d: WorldDraft, keep?: Uint8Array): void {
  const n = mesh.n;
  if (d.n !== n) throw new Error(`finalizeDraft: draft.n (${d.n}) does not match mesh.n (${n})`);
  for (const [name, a] of [['plate', d.plate], ['crust', d.crust], ['elev', d.elev], ['age', d.age]] as const) {
    if (a.length !== n) throw new Error(`finalizeDraft: draft.${name} has length ${a.length}, expected ${n}`);
  }
  if (d.orogeny && d.orogeny.length !== n) throw new Error('finalizeDraft: draft.orogeny has the wrong length');
  if (keep && keep.length !== n) throw new Error(`finalizeDraft: keepElevation has length ${keep.length}, expected ${n}`);
  if (d.plates.length === 0 || d.plates.length > MAX_PLATES) throw new Error(`finalizeDraft: plates.length must be 1..${MAX_PLATES}`);
  for (const p of d.plates) {
    const w = p.omega;
    if (!(w && w.length === 3 && Number.isFinite(w[0]) && Number.isFinite(w[1]) && Number.isFinite(w[2]))) {
      throw new Error(`finalizeDraft: plate ${p.id} has a non-finite omega`);
    }
  }
  for (let i = 0; i < n; i++) {
    const k = d.plate[i];
    if (!(k >= 0 && k < d.plates.length)) throw new Error(`finalizeDraft: cell ${i} has invalid plate index ${k}`);
  }
}

/**
 * Relabel plates so each is one connected region: the largest component of every plate keeps its
 * spec; other components with ≥ MIN_FRAGMENT_CELLS cells become new plates (same motion and frame,
 * new id/name/color) while the plate cap allows, largest first; the rest merge into neighbours.
 * Plates without cells are dropped; a duplicated id gets a fresh one (the sim requires unique ids).
 */
function splitComponents(mesh: SphereMesh, plateIn: Int16Array, specs: PlateSpec[], nextId: number, seed: number): { plate: Int16Array; plates: PlateSpec[]; nextPlateId: number } {
  const { n, adjOffset, adj } = mesh;
  const comps = labelComponents(mesh, plateIn);
  const nc = comps.size.length;
  // Largest component per original plate.
  const main = new Int32Array(specs.length).fill(-1);
  for (let c = 0; c < nc; c++) {
    const k = comps.key[c];
    if (main[k] < 0 || comps.size[c] > comps.size[main[k]] || (comps.size[c] === comps.size[main[k]] && c < main[k])) main[k] = c;
  }
  const newLabel = new Int32Array(nc).fill(-1);
  const plates: PlateSpec[] = [];
  const usedIds = new Set<number>();
  let id = nextId;
  for (let k = 0; k < specs.length; k++) {
    if (main[k] < 0) continue; // no cells: compacted away
    newLabel[main[k]] = plates.length;
    const spec = clonePlate(specs[k]);
    if (usedIds.has(spec.id)) spec.id = id++;
    usedIds.add(spec.id);
    plates.push(spec);
  }
  // Extra fragments, largest first, while under the cap.
  const extras: number[] = [];
  for (let c = 0; c < nc; c++) if (newLabel[c] < 0 && comps.size[c] >= MIN_FRAGMENT_CELLS) extras.push(c);
  extras.sort((a, b) => comps.size[b] - comps.size[a] || a - b);
  for (const c of extras) {
    if (plates.length >= MAX_PLATES) break;
    const parent = specs[comps.key[c]];
    const spec = clonePlate(parent);
    spec.id = id++;
    spec.name = plateName(plates.length, seed + spec.id);
    spec.color = plateColor(spec.id - 1);
    newLabel[c] = plates.length;
    plates.push(spec);
  }
  // Remaining small fragments: flood-fill from labelled neighbours (majority label). Each cell is
  // queued at most once, so the n-slot queue cannot overflow.
  const plate = new Int16Array(n);
  const queue = new Int32Array(n);
  const queued = new Uint8Array(n);
  let tail = 0;
  for (let i = 0; i < n; i++) plate[i] = newLabel[comps.comp[i]];
  for (let i = 0; i < n; i++) {
    if (plate[i] >= 0) continue;
    for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
      if (plate[adj[e]] >= 0) {
        queue[tail++] = i;
        queued[i] = 1;
        break;
      }
    }
  }
  let head = 0;
  while (head < tail) {
    const i = queue[head++];
    if (plate[i] >= 0) continue;
    let best = -1, bestCount = 0;
    for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
      const l = plate[adj[e]];
      if (l < 0) continue;
      let c = 0;
      for (let f = adjOffset[i]; f < adjOffset[i + 1]; f++) if (plate[adj[f]] === l) c++;
      if (c > bestCount || (c === bestCount && l < best)) { bestCount = c; best = l; }
    }
    plate[i] = best;
    for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
      const j = adj[e];
      if (plate[j] < 0 && !queued[j]) {
        queued[j] = 1;
        queue[tail++] = j;
      }
    }
  }
  return { plate, plates, nextPlateId: id };
}

/** Random default motion (30–60 km/Myr, Euler pole 60–90° from the centroid) for motionless plates. */
function fillZeroMotions(mesh: SphereMesh, plate: Int16Array, crust: Uint8Array, plates: PlateSpec[], seed: number): void {
  const st = plateStats(mesh, plate, crust, plates.length);
  const root = new Rng(seed);
  plates.forEach((p, k) => {
    if (Math.hypot(p.omega[0], p.omega[1], p.omega[2]) * EARTH_RADIUS_KM >= ZERO_MOTION_KM_MYR) return;
    const rng = root.fork(p.id);
    const c: Vec3 = [st.centroid[3 * k], st.centroid[3 * k + 1], st.centroid[3 * k + 2]];
    const { east, north } = tangentBasis(c);
    const a = rng.float(0, 2 * Math.PI);
    const d: Vec3 = [
      east[0] * Math.cos(a) + north[0] * Math.sin(a),
      east[1] * Math.cos(a) + north[1] * Math.sin(a),
      east[2] * Math.cos(a) + north[2] * Math.sin(a),
    ];
    const pole = (rng.float(60, 90) * Math.PI) / 180;
    p.omega = omegaWithPoleAngle(c, d, rng.float(DEFAULT_SPEED[0], DEFAULT_SPEED[1]), pole, rng.bool() ? 1 : -1);
  });
}

/**
 * Coastal profile for continental cells without a usable elevation: −180 m (shelf) on the outermost
 * ring of cells, rising to ~+400 m inland. `fromCoastCellKm` is measured from the coastal cell centres
 * so every resolution gets a shelf ring.
 */
function continentalProfile(fromCoastCellKm: number): number {
  return -180 + 580 * (1 - Math.exp(-fromCoastCellKm / 220));
}

/**
 * See draft.ts `finalizeDraft`. Returns a new draft; the input is not modified.
 *  - Compacts plates and splits disconnected plate components (fragments < MIN_FRAGMENT_CELLS merge).
 *  - Motionless plates get a random 30–60 km/Myr motion (deterministic in `seed` and plate id).
 *  - Oceanic crust age from the divergent boundaries of the (final) motions; oceanic elevation =
 *    oceanDepthForAge(age) plus a continental rise on passive margins. Oceanic cells flagged in
 *    keepElevation keep their floor as is: elevation and (when valid, ≥ 0) age, so kept depths stay
 *    consistent with their ages (e.g. an unedited plate of a simulated world).
 *  - Continental cells without a plausible elevation (< −1000 m or non-finite) get a shelf-to-plateau
 *    coastal profile; non-positive / non-finite continental ages get a default old age.
 *  - Non-finite values are never kept (keepElevation is ignored there; orogeny → 0).
 */
export function finalizeDraftImpl(mesh: SphereMesh, draft: WorldDraft, seed: number, keepElevation?: Uint8Array): WorldDraft {
  validate(mesh, draft, keepElevation);
  const n = mesh.n;
  const maxId = Math.max(0, ...draft.plates.map((p) => p.id));
  const split = splitComponents(mesh, draft.plate, draft.plates, Math.max(draft.nextPlateId ?? 0, maxId + 1), seed);
  const { plate, plates } = split;
  const crust = draft.crust.slice();
  // Every consumer tests crust === CRUST_CONTINENTAL: any other value is oceanic crust.
  for (let i = 0; i < n; i++) if (crust[i] !== CRUST_CONTINENTAL) crust[i] = CRUST_OCEANIC;
  fillZeroMotions(mesh, plate, crust, plates, seed);
  const omega = plates.map((p) => p.omega);
  const kin = boundaryKinematics(mesh, plate, omega);
  const noiseSeed = new Rng(seed).fork(0).int(0, 0x7fffffff);
  const oceanAge = oceanAges(mesh, plate, crust, kin, noiseSeed);
  const continents = analyzeContinents(mesh, crust);
  const elev = draft.elev.slice();
  const age = draft.age.slice();
  const rise = passiveMarginRise(mesh, plate, continents.mask);
  const halfSpacingKm = 0.5 * mesh.spacing * EARTH_RADIUS_KM;
  for (let i = 0; i < n; i++) {
    const keep = keepElevation ? keepElevation[i] !== 0 && Number.isFinite(elev[i]) : false;
    if (crust[i] === CRUST_CONTINENTAL) {
      if (!(age[i] > 0) || !Number.isFinite(age[i])) age[i] = 800;
      if (!keep && !(elev[i] >= IMPLAUSIBLE_CONTINENTAL_ELEV && Number.isFinite(elev[i]))) {
        elev[i] = continentalProfile(Math.max(0, continents.coastKm[i] - halfSpacingKm));
      }
      continue;
    }
    if (keep && age[i] >= 0 && Number.isFinite(age[i])) continue;
    age[i] = oceanAge[i];
    if (!keep) {
      const base = oceanDepthForAge(age[i]);
      elev[i] = base + (MARGIN_RISE_DEPTH - base) * rise[i];
    }
  }
  let orogeny: Float32Array | undefined;
  if (draft.orogeny) {
    orogeny = draft.orogeny.slice();
    for (let i = 0; i < n; i++) if (!Number.isFinite(orogeny[i])) orogeny[i] = 0;
  }
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
    nextPlateId: split.nextPlateId,
    stepIndex: draft.stepIndex ?? 0,
    revision: (draft.revision ?? 0) + 1,
  };
}
