import { describe, expect, it } from 'vitest';
import { EARTH_RADIUS_KM } from '../src/core/constants';
import { angleBetween, cross3, dot3, latLonToVec } from '../src/core/math3';
import { Rng } from '../src/core/rng';
import type { SphereMesh, Vec3, WorldDraft } from '../src/core/types';
import { CRUST_CONTINENTAL, CRUST_OCEANIC } from '../src/core/types';
import { oceanDepthForAge, plateColor } from '../src/tectonics/draft';
import { TectonicSim } from '../src/tectonics/sim';
import { buildWorldFields } from '../src/tectonics/simFronts';
import { maybeInitiateSubduction } from '../src/tectonics/simInitiation';
import { simMeshOf } from '../src/tectonics/simMesh';
import type { SimState } from '../src/tectonics/simState';
import { smallMesh, twoPlateDraft } from './helpers/fixtures';

const DEG = Math.PI / 180;
const cellVec = (mesh: SphereMesh, i: number): Vec3 => [mesh.xyz[3 * i], mesh.xyz[3 * i + 1], mesh.xyz[3 * i + 2]];
const stateOf = (sim: TectonicSim): SimState => (sim as unknown as { state: SimState }).state;

describe('tectonic processes', () => {
  const mesh = smallMesh(20000);
  const n = mesh.n;

  it('ocean–ocean convergence: the older plate subducts and an island arc grows on the younger one', () => {
    const draft = twoPlateDraft(mesh, 'cap', { speed: 50 });
    // Young cap (20 Myr) converging on old sea floor (120 Myr).
    for (let i = 0; i < n; i++) {
      draft.age[i] = draft.plate[i] === 1 ? 20 : 120;
      draft.elev[i] = oceanDepthForAge(draft.age[i]);
    }
    const sim = new TectonicSim(mesh, draft, { riftRate: 0 });
    sim.step(40);
    const d = sim.toDraft();
    const s = sim.snapshot();
    const moved = (40 * 50) / EARTH_RADIUS_KM;
    const leading = latLonToVec(0, moved + 35 * DEG);
    let arcOnCap = 0, arcOnRest = 0, deepest = 0;
    for (let i = 0; i < n; i++) {
      if (angleBetween(cellVec(mesh, i), leading) > 15 * DEG) continue;
      if (d.elev[i] > -1000) {
        if (d.plate[i] === 1) arcOnCap++;
        else arcOnRest++;
      }
      deepest = Math.min(deepest, s.elev[i]);
    }
    expect(arcOnCap).toBeGreaterThan(3);
    expect(arcOnRest).toBe(0);
    expect(deepest).toBeLessThan(-6500);
    expect(sim.stats().subductedCells).toBeGreaterThan(300);
  });

  it('riftRate 0 never creates plates; a high rate splits plates along a new ridge', () => {
    const quiet = new TectonicSim(mesh, twoPlateDraft(mesh, 'cap'), { riftRate: 0 });
    quiet.step(60);
    expect(quiet.stats().rifts).toBe(0);
    expect(quiet.stats().plateCount).toBe(2);

    // One large continental plate at rest: a rift must open a young ocean inside it.
    const draft = twoPlateDraft(mesh, 'cap', { capRadiusDeg: 70, capCrust: CRUST_CONTINENTAL, speed: 0 });
    draft.plates[1].omega = [0, 0, 0];
    const sim = new TectonicSim(mesh, draft, { riftRate: 400, maxPlates: 3, mergePlates: false });
    sim.step(30);
    const st = sim.stats();
    expect(st.rifts).toBeGreaterThanOrEqual(1);
    expect(st.plateCount).toBe(3);
    const d = sim.toDraft();
    const youngOcean = d.age.filter((a, i) => a < 25 && d.crust[i] === CRUST_OCEANIC).length;
    expect(youngOcean).toBeGreaterThan(30);
  });

  it('old passive margins can founder into a new subduction zone', () => {
    // One plate: a continent (cap) surrounded by 200 Myr old ocean, all at rest.
    const draft: WorldDraft = twoPlateDraft(mesh, 'cap', { capRadiusDeg: 40, capCrust: CRUST_CONTINENTAL, age: 200 });
    draft.plate.fill(0);
    draft.plates = [{ id: 1, name: 'Solo', color: plateColor(0), omega: [0, 0, 0] }];
    draft.nextPlateId = 2;
    const sim = new TectonicSim(mesh, draft, { riftRate: 1000 });
    const state = stateOf(sim);
    buildWorldFields(state);
    let created = false;
    for (let t = 0; t < 20 && !created; t++) created = maybeInitiateSubduction(state, new Rng(t), 1);
    expect(created).toBe(true);
    const live = state.slots.filter((p) => p !== null);
    expect(live.length).toBe(2);
    const ocean = live.find((p) => p!.spec.id === 2)!;
    const cont = live.find((p) => p!.spec.id === 1)!;
    // The detached plate is oceanic and moves toward the continent (cap centre at lon 0, lat 0).
    let oc = 0, cc = 0;
    for (let j = 0; j < n; j++) {
      if (!ocean.owned[j]) continue;
      if (ocean.crust[j] === CRUST_CONTINENTAL) cc++;
      else oc++;
    }
    expect(cc).toBe(0);
    expect(oc).toBeGreaterThan(0.01 * n);
    // Somewhere along the margin the detached ocean moves toward the continent (its centre: lat 0, lon 0).
    const rel: Vec3 = [ocean.spec.omega[0] - cont.spec.omega[0], ocean.spec.omega[1] - cont.spec.omega[1], ocean.spec.omega[2] - cont.spec.omega[2]];
    const centre = latLonToVec(0, 0);
    let maxClosing = 0;
    for (let i = 0; i < n; i++) {
      const p = cellVec(mesh, i);
      if (Math.abs(angleBetween(p, centre) - 40 * DEG) > 2 * DEG) continue;
      const v = cross3(rel, p);
      const inward: Vec3 = [centre[0] - p[0], centre[1] - p[1], centre[2] - p[2]];
      const il = Math.hypot(...inward);
      maxClosing = Math.max(maxClosing, (dot3(v, inward) / il) * EARTH_RADIUS_KM);
    }
    expect(maxClosing).toBeGreaterThan(15);
    // Stepping on: the ocean is consumed at the margin and a cordillera rises on the continent edge.
    sim.step(40);
    expect(sim.stats().subductedCells).toBeGreaterThan(100);
    expect(sim.stats().maxElevation).toBeGreaterThan(1500);
  });

  it('builds per-mesh neighbourhood tables consistently', () => {
    const sm = simMeshOf(mesh);
    expect(simMeshOf(mesh)).toBe(sm);
    // The sim works in an internal, spatially renumbered cell order: toExt / toInt are inverse
    // permutations and the internal mesh is the caller's mesh relabelled.
    expect(sm.ext).toBe(mesh);
    for (let k = 0; k < n; k++) expect(sm.toInt[sm.toExt[k]]).toBe(k);
    for (const k of [0, 17, 5000, n - 1]) {
      const e = sm.toExt[k];
      for (let c = 0; c < 3; c++) expect(sm.mesh.xyz[3 * k + c]).toBe(mesh.xyz[3 * e + c]);
      const extNbrs = Array.from(mesh.adj.subarray(mesh.adjOffset[e], mesh.adjOffset[e + 1]), (a) => sm.toInt[a]).sort((a, b) => a - b);
      const intNbrs = Array.from(sm.adj.subarray(sm.adjOffset[k], sm.adjOffset[k + 1])).sort((a, b) => a - b);
      expect(intNbrs).toEqual(extNbrs);
    }
    // Neighbourhood disks (internal numbering) contain the first ring and not the cell itself.
    for (const i of [0, 17, 5000, n - 1]) {
      const ring = new Set(Array.from(sm.disk.subarray(sm.diskOffset[i], sm.diskOffset[i + 1])));
      expect(ring.has(i)).toBe(false);
      for (let q = sm.adjOffset[i]; q < sm.adjOffset[i + 1]; q++) expect(ring.has(sm.adj[q])).toBe(true);
      expect(sm.ring2End[i]).toBeGreaterThan(sm.diskOffset[i]);
      expect(sm.ring2End[i]).toBeLessThan(sm.diskOffset[i + 1]);
      for (let q = sm.diskOffset[i]; q < sm.diskOffset[i + 1]; q++) {
        expect(sm.diskW[q]).toBeGreaterThan(0);
        expect(sm.diskW[q]).toBeLessThanOrEqual(1);
      }
    }
  });
});
