import { describe, expect, it } from 'vitest';
import { EARTH_RADIUS_KM, MAX_PLATES } from '../src/core/constants';
import { angleBetween, latLonToVec, quatMul } from '../src/core/math3';
import { nearestCell } from '../src/core/sphereMesh';
import type { GenerateParams, SphereMesh, TectonicParams, Vec3, WorldDraft } from '../src/core/types';
import { BOUNDARY_CONVERGENT, CRUST_CONTINENTAL } from '../src/core/types';
import { cloneDraft, draftFromSnapshot } from '../src/tectonics/draft';
import { DEFAULT_GENERATE_PARAMS, generateRandomDraft } from '../src/tectonics/generate';
import { DEFAULT_TECTONIC_PARAMS, TectonicSim } from '../src/tectonics/sim';
import {
  countOceanicSpecks, countPlateSpecks, ringDistance, snapshotInvariantError,
} from '../src/tectonics/simDiagnostics';
import type { SimState } from '../src/tectonics/simState';
import { smallMesh, syntheticSnapshot, twoPlateDraft } from './helpers/fixtures';

const DEG = Math.PI / 180;

/** Random world from the generator (synthetic fixture while the generator is still a stub). */
function randomDraft(mesh: SphereMesh, seed: number, plateCount = 12, extra: Partial<GenerateParams> = {}): WorldDraft {
  try {
    return generateRandomDraft(mesh, { ...DEFAULT_GENERATE_PARAMS, seed, plateCount, ...extra });
  } catch (e) {
    if (!(e instanceof Error) || !/not implemented/.test(e.message)) throw e;
    return draftFromSnapshot(syntheticSnapshot(mesh, seed, plateCount), seed);
  }
}

const cellVec = (mesh: SphereMesh, i: number): Vec3 => [mesh.xyz[3 * i], mesh.xyz[3 * i + 1], mesh.xyz[3 * i + 2]];
const count = (a: ArrayLike<number>, f: (v: number, i: number) => boolean): number => {
  let c = 0;
  for (let i = 0; i < a.length; i++) if (f(a[i], i)) c++;
  return c;
};

describe('TectonicSim construction', () => {
  const mesh = smallMesh(8000);

  it('reproduces the draft exactly at t = 0', () => {
    const draft = randomDraft(mesh, 4);
    const sim = new TectonicSim(mesh, draft);
    const s = sim.snapshot();
    expect(Array.from(s.plate)).toEqual(Array.from(draft.plate));
    expect(Array.from(s.crust)).toEqual(Array.from(draft.crust));
    expect(s.plates.map((p) => p.id)).toEqual(draft.plates.map((p) => p.id));
    // Elevation is the draft's except for (transient, display-only) trench offsets, which only deepen.
    expect(count(s.elev, (v, i) => v > draft.elev[i] + 1e-3)).toBe(0);
    expect(count(s.elev, (v, i) => Math.abs(v - draft.elev[i]) > 1e-3)).toBeLessThan(0.05 * mesh.n);
    expect(count(s.age, (v, i) => Math.abs(v - draft.age[i]) > 1e-3)).toBe(0);
    expect(s.time).toBe(draft.time);
    expect(snapshotInvariantError(mesh, s, 24)).toBeNull();
  });

  it('does not retain the draft and validates its input', () => {
    const draft = twoPlateDraft(mesh, 'cap');
    const copy = cloneDraft(draft);
    const sim = new TectonicSim(mesh, draft, { riftRate: 0 });
    draft.elev.fill(123);
    draft.plate.fill(0);
    sim.step(2);
    expect(sim.snapshot().plates.length).toBe(2);
    expect(Array.from(copy.plate)).not.toEqual(Array.from(draft.plate));
    const bad = cloneDraft(copy);
    bad.plate[5] = 7;
    expect(() => new TectonicSim(mesh, bad)).toThrow(/out of range/);
    const nan = cloneDraft(copy);
    nan.elev[3] = NaN;
    expect(() => new TectonicSim(mesh, nan)).toThrow(/non-finite/);
    expect(() => new TectonicSim(mesh, copy, { dt: 0 })).toThrow(/dt/);
  });

  it('uses the draft seed unless params override it', () => {
    const draft = twoPlateDraft(mesh, 'cap');
    expect(new TectonicSim(mesh, draft).params.seed).toBe(draft.seed);
    expect(new TectonicSim(mesh, draft, { seed: 99 }).params.seed).toBe(99);
  });
});

/** Internal consistency: every live plate's ownedCount equals its owned lattice cells. */
function ownedCountError(sim: TectonicSim): string | null {
  const state = (sim as unknown as { state: SimState }).state;
  for (const p of state.slots) {
    if (!p) continue;
    let c = 0;
    for (let j = 0; j < state.n; j++) c += p.owned[j];
    if (c !== p.ownedCount) return `slot ${p.slot}: ownedCount ${p.ownedCount} but owns ${c} cells`;
  }
  return null;
}

describe('TectonicSim invariants on random worlds', () => {
  const mesh = smallMesh(10000);

  it('keeps every invariant at every step (incl. high rift rate and extreme parameters)', () => {
    const configs: Array<{ seed: number; plates?: number; gen?: Partial<GenerateParams>; params: Partial<TectonicParams>; draft?: WorldDraft }> = [
      { seed: 1, params: {} },
      { seed: 2, params: { riftRate: 40, maxPlates: 14 } },
      { seed: 3, params: { speedScale: 3, dt: 4, erosion: 0, hotspotActivity: 3 } },
      { seed: 4, plates: 3, gen: { continentalFraction: 0.7 }, params: {} },
      { seed: 5, plates: 30, gen: { continentMode: 'archipelago' }, params: { mergePlates: false } },
      { seed: 6, gen: { continentalFraction: 0.05, continentMode: 'supercontinent' }, params: { dt: 5, riftRate: 30 } },
      // MAX_PLATES plates: slot 31 exercises the sign bit of every bitmask.
      { seed: 9, params: { mergePlates: false }, draft: draftFromSnapshot(syntheticSnapshot(mesh, 9, MAX_PLATES), 9) },
    ];
    for (const { seed, plates, gen, params, draft: given } of configs) {
      const draft = given ?? randomDraft(mesh, seed, plates ?? 12, gen);
      const sim = new TectonicSim(mesh, draft, params);
      const cap = Math.min(MAX_PLATES, Math.max(sim.params.maxPlates, draft.plates.length));
      for (let t = 0; t < 40; t++) {
        sim.step();
        const s = sim.snapshot();
        const err = snapshotInvariantError(mesh, s, cap);
        expect(err, `seed ${seed} step ${t}`).toBeNull();
        expect(ownedCountError(sim), `seed ${seed} step ${t}`).toBeNull();
        const st = sim.stats();
        expect(Object.values(st).every(Number.isFinite)).toBe(true);
        expect(st.plateCount).toBe(s.plates.length);
      }
    }
  });

  it('keeps plate ownership counts exact through specks, merges and rifts over 150 Myr', () => {
    // Regression: speck hand-over released lattice cells shared by two world cells twice.
    for (const seed of [1, 3]) {
      const sim = new TectonicSim(mesh, randomDraft(mesh, seed, 16));
      for (let t = 0; t < 150; t += 10) {
        sim.step(10);
        expect(ownedCountError(sim), `seed ${seed} t ${t}`).toBeNull();
      }
    }
  });

  it('stays finite on odd but accepted inputs and rejects malformed hotspots', () => {
    const base = randomDraft(mesh, 11);
    // Negative crust ages and inert / negative-strength plumes.
    const odd = cloneDraft(base);
    for (let i = 0; i < odd.n; i++) odd.age[i] = odd.crust[i] === CRUST_CONTINENTAL ? -1e6 : odd.age[i];
    odd.hotspots = [
      { pos: [0, 0, 1], strength: -1, radius: 0.05 },
      { pos: [1, 0, 0], strength: 1, radius: 0 },
    ];
    const sim = new TectonicSim(mesh, odd, { riftRate: 0 });
    sim.step(40);
    const st = sim.stats();
    expect(Object.values(st).every(Number.isFinite)).toBe(true);
    expect(st.minElevation).toBeGreaterThanOrEqual(-11000);
    expect(st.maxElevation).toBeLessThanOrEqual(10000);
    const bad = cloneDraft(base);
    bad.hotspots = [{ pos: [0, 0, 1], strength: NaN, radius: 0.05 }];
    expect(() => new TectonicSim(mesh, bad)).toThrow(/hotspot/);
    const badTime = cloneDraft(base);
    badTime.time = Infinity;
    expect(() => new TectonicSim(mesh, badTime)).toThrow(/time/);
  });

  it('clamps plate speeds before moving and keeps params behind validation', () => {
    const draft = twoPlateDraft(mesh, 'transform');
    const sim = new TectonicSim(mesh, draft, { riftRate: 0, dt: undefined });
    expect(sim.params.dt).toBe(DEFAULT_TECTONIC_PARAMS.dt);
    // The getter hands out a copy: mutating it cannot bypass validation.
    sim.params.dt = -5;
    expect(sim.params.dt).toBe(DEFAULT_TECTONIC_PARAMS.dt);
    sim.setParams({ erosion: undefined, riftRate: 0 });
    expect(sim.params.erosion).toBe(DEFAULT_TECTONIC_PARAMS.erosion);
    // A 2000 km/Myr motion is capped (150 km/Myr) before the plates move.
    const id = sim.snapshot().plates[1].id;
    sim.setPlateOmega(id, [0, 0, 2000 / EARTH_RADIUS_KM]);
    sim.step();
    const p = sim.snapshot().plates[1];
    expect(Math.hypot(...p.omega) * EARTH_RADIUS_KM).toBeLessThanOrEqual(150 + 1e-6);
    const ang = 2 * Math.acos(Math.min(1, Math.abs(p.rotation[3])));
    expect(ang).toBeLessThanOrEqual((150 * 1.0001) / EARTH_RADIUS_KM);
  });
});

describe('TectonicSim kinematic scenarios', () => {
  const mesh = smallMesh(20000);
  const n = mesh.n;

  it('transform boundary: < 0.5% of cells lost and no young-crust band in 100 Myr', () => {
    const draft = twoPlateDraft(mesh, 'transform');
    const sim = new TectonicSim(mesh, draft, { riftRate: 0 });
    sim.step(100);
    const st = sim.stats();
    expect(st.subductedCells + st.continentalDestroyed).toBeLessThan(0.005 * n);
    const d = sim.toDraft();
    const eq = count(mesh.lat, (lat) => Math.abs(lat) < 5 * DEG);
    const young = count(d.age, (a, i) => a < 20 && Math.abs(mesh.lat[i]) < 5 * DEG);
    expect(young).toBeLessThan(0.02 * eq);
    // The fault stays on the equator.
    const wrong = count(d.plate, (k, i) => k !== (mesh.xyz[3 * i + 2] >= 0 ? 1 : 0));
    expect(wrong).toBeLessThan(0.005 * n);
  });

  it('moving continental cap: ridge behind, subduction and cordillera ahead, continent preserved', () => {
    const draft = twoPlateDraft(mesh, 'cap', { capCrust: CRUST_CONTINENTAL });
    const cont0 = count(draft.crust, (c) => c === CRUST_CONTINENTAL);
    const sim = new TectonicSim(mesh, draft, { riftRate: 0 });
    sim.step(60);
    const d = sim.toDraft();
    const s = sim.snapshot();
    const st = sim.stats();
    // Cap centre after 60 Myr at 50 km/Myr eastward along the equator.
    const moved = (60 * 50) / EARTH_RADIUS_KM;
    const centre = latLonToVec(0, moved);
    const trailing = latLonToVec(0, moved - 35 * DEG);
    const leading = latLonToVec(0, moved + 35 * DEG);
    // Trailing edge: fresh ridge crust (< 5 Myr) behind the cap (slab pull sets the other plate moving
    // too, so the ridge need not follow the cap; it must lie west of the cap's trailing edge).
    const ridge = count(d.age, (a, i) => a < 5 && d.crust[i] !== CRUST_CONTINENTAL && Math.abs(mesh.lat[i]) < 30 * DEG &&
      mesh.lon[i] < moved - 35 * DEG && mesh.lon[i] > -80 * DEG);
    expect(ridge).toBeGreaterThan(20);
    expect(angleBetween(trailing, centre)).toBeCloseTo(35 * DEG, 6);
    // Leading edge: the oceanic plate is consumed, the continental cap keeps its crust.
    expect(st.subductedCells).toBeGreaterThan(500);
    const cont = count(d.crust, (c) => c === CRUST_CONTINENTAL);
    expect(Math.abs(cont / cont0 - 1)).toBeLessThan(0.05);
    // Cordillera near the leading edge; trench offshore.
    let maxFront = -Infinity, minTrench = Infinity;
    for (let i = 0; i < n; i++) {
      const a = angleBetween(cellVec(mesh, i), leading);
      if (a > 12 * DEG) continue;
      if (d.crust[i] === CRUST_CONTINENTAL) maxFront = Math.max(maxFront, d.elev[i]);
      else minTrench = Math.min(minTrench, s.elev[i]);
    }
    expect(maxFront).toBeGreaterThan(2500);
    expect(minTrench).toBeLessThan(-6500);
    // The cap interior far from the front stays low.
    const interior = count(d.elev, (h, i) => d.crust[i] === CRUST_CONTINENTAL && angleBetween(cellVec(mesh, i), centre) < 10 * DEG && h > 1500);
    expect(interior).toBe(0);
  });

  it('spreading is symmetric: the ridge sits mid-way in the new crust', () => {
    const draft = twoPlateDraft(mesh, 'cap', { capCrust: CRUST_CONTINENTAL });
    const sim = new TectonicSim(mesh, draft, { riftRate: 0 });
    sim.step(60);
    const d = sim.toDraft();
    // Along the equator behind the cap: the youngest crust lies between the two plates' old crust,
    // with young crust on both plates.
    let youngOnCap = 0, youngOnRest = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(mesh.lat[i]) > 10 * DEG || d.crust[i] === CRUST_CONTINENTAL || d.age[i] > 30) continue;
      if (d.plate[i] === 1) youngOnCap++;
      else youngOnRest++;
    }
    expect(youngOnCap).toBeGreaterThan(20);
    expect(youngOnRest).toBeGreaterThan(20);
    expect(youngOnCap / youngOnRest).toBeGreaterThan(0.5);
    expect(youngOnCap / youngOnRest).toBeLessThan(2);
  });

  it('a continent on a rotating plate keeps its area (±3%) without speckles over 100 Myr', () => {
    const draft = twoPlateDraft(mesh, 'cap', { capRadiusDeg: 40 });
    const c0 = latLonToVec(0, 0);
    for (let i = 0; i < n; i++) {
      if (angleBetween(cellVec(mesh, i), c0) < 22 * DEG) {
        draft.crust[i] = CRUST_CONTINENTAL;
        draft.elev[i] = 400;
      }
    }
    // Spin about the cap centre (50 km/Myr at the rim) plus a slow drift.
    draft.plates[1].omega = [50 / EARTH_RADIUS_KM / Math.sin(40 * DEG), 0, 4 / EARTH_RADIUS_KM];
    const sim = new TectonicSim(mesh, draft, { riftRate: 0 });
    const cont0 = count(draft.crust, (c) => c === CRUST_CONTINENTAL);
    for (let t = 0; t < 100; t += 10) {
      sim.step(10);
      const s = sim.snapshot();
      const cont = count(s.crust, (c) => c === CRUST_CONTINENTAL);
      expect(Math.abs(cont / cont0 - 1)).toBeLessThan(0.03);
      expect(countOceanicSpecks(mesh, s.crust)).toBeLessThan(Math.max(1, 0.001 * cont0));
      expect(countPlateSpecks(mesh, s.plate)).toBe(0);
    }
  });

  it('continental collision builds a high belt, stops convergence and welds the plates', () => {
    const draft = twoPlateDraft(mesh, 'cap', { capCrust: CRUST_CONTINENTAL, restCrust: CRUST_CONTINENTAL, speed: 40, capRadiusDeg: 25 });
    const sim = new TectonicSim(mesh, draft, { riftRate: 0 });
    let peak = 0;
    for (let t = 0; t < 30; t++) {
      sim.step();
      peak = Math.max(peak, sim.stats().maxElevation);
    }
    expect(peak).toBeGreaterThan(3500);
    sim.step(70);
    const st = sim.stats();
    expect(st.merges).toBeGreaterThanOrEqual(1);
    expect(st.plateCount).toBe(1);
    expect(st.continentalDestroyed).toBeGreaterThan(0);
  });

  it('a hotspot under a moving plate leaves an age-progressive island chain', () => {
    const draft = twoPlateDraft(mesh, 'transform', { speed: 60 });
    draft.hotspots = [{ pos: latLonToVec(30 * DEG, 0), strength: 1.2, radius: 0.035 }];
    const sim = new TectonicSim(mesh, draft, { riftRate: 0 });
    sim.step(40);
    const s = sim.snapshot();
    const at = (lonDeg: number): number => {
      const v = latLonToVec(30 * DEG, lonDeg * DEG);
      return s.elev[nearestCell(mesh, v[0], v[1], v[2])];
    };
    const base = at(-20);
    // The plate moves east: volcanoes are carried east of the plume and subside/erode with age.
    expect(at(5)).toBeGreaterThan(base + 4000);
    expect(at(12)).toBeGreaterThan(base + 3000);
    expect(at(20)).toBeGreaterThan(base + 2000);
    expect(at(-5)).toBeLessThan(base + 500);
  });
});

describe('TectonicSim on a random world (300 Myr)', () => {
  const mesh = smallMesh(20000);
  const n = mesh.n;

  it('keeps continents, land and relief in Earth-like bounds with belts at convergent margins', () => {
    for (const seed of [1, 2]) {
      const draft = randomDraft(mesh, seed, 12);
      const sim = new TectonicSim(mesh, draft);
      const s0 = sim.stats();
      sim.step(300);
      const st = sim.stats();
      const s = sim.snapshot();
      expect(st.continentalFraction / s0.continentalFraction, `seed ${seed}`).toBeGreaterThan(0.6);
      expect(st.continentalFraction / s0.continentalFraction, `seed ${seed}`).toBeLessThan(1.4);
      expect(st.landFraction).toBeGreaterThan(0.15);
      expect(st.landFraction).toBeLessThan(0.5);
      expect(st.maxElevation).toBeGreaterThan(3000);
      expect(st.maxElevation).toBeLessThan(9000);
      expect(st.plateCount).toBeGreaterThanOrEqual(4);
      // High ground concentrates near convergent boundaries (within ~1000 km).
      const rings = Math.ceil(1000 / (mesh.spacing * EARTH_RADIUS_KM));
      const dist = ringDistance(mesh, (i) => s.boundary[i] === BOUNDARY_CONVERGENT, rings);
      const high = count(s.elev, (h) => h > 2500);
      const highNear = count(s.elev, (h, i) => h > 2500 && dist[i] <= rings);
      expect(high).toBeGreaterThan(0.001 * n);
      expect(highNear / high).toBeGreaterThan(0.5);
      expect(countOceanicSpecks(mesh, s.crust)).toBeLessThan(0.001 * count(s.crust, (c) => c === CRUST_CONTINENTAL) + 5);
      expect(countPlateSpecks(mesh, s.plate)).toBeLessThan(0.002 * n);
    }
  });
});

describe('TectonicSim determinism, resume and outputs', () => {
  const mesh = smallMesh(10000);

  it('step(10) equals ten step(1) calls exactly', () => {
    const draft = randomDraft(mesh, 5);
    const a = new TectonicSim(mesh, draft, { riftRate: 30 });
    const b = new TectonicSim(mesh, draft, { riftRate: 30 });
    a.step(10);
    for (let t = 0; t < 10; t++) b.step(1);
    const sa = a.snapshot(), sb = b.snapshot();
    expect(Array.from(sa.plate)).toEqual(Array.from(sb.plate));
    expect(Array.from(sa.elev)).toEqual(Array.from(sb.elev));
    expect(Array.from(sa.age)).toEqual(Array.from(sb.age));
    expect(sa.plates.map((p) => p.omega)).toEqual(sb.plates.map((p) => p.omega));
    const { lastStepMs: _a, ...stA } = a.stats();
    const { lastStepMs: _b, ...stB } = b.stats();
    expect(stA).toEqual(stB);
  });

  it('resumes from toDraft() without jumps and carries frames, orogeny and counters', () => {
    const draft = randomDraft(mesh, 6);
    const a = new TectonicSim(mesh, draft);
    a.step(30);
    const d = a.toDraft();
    const sa = a.snapshot();
    expect(d.time).toBe(30);
    expect(d.stepIndex).toBe(30);
    expect(d.nextPlateId).toBeGreaterThan(Math.max(...d.plates.map((p) => p.id)));
    expect(d.orogeny).toBeDefined();
    expect(count(d.orogeny as Float32Array, (v) => v > 0)).toBeGreaterThan(0);
    d.plates.forEach((p, k) => {
      expect(p.frame).toBeDefined();
      expect(p.frame).toEqual(sa.plates[k].rotation);
    });
    expect(Array.from(d.plate)).toEqual(Array.from(sa.plate));

    const b = new TectonicSim(mesh, d);
    const sb = b.snapshot();
    expect(Array.from(sb.plate)).toEqual(Array.from(sa.plate));
    expect(Array.from(sb.crust)).toEqual(Array.from(sa.crust));
    // The resumed state is exactly the saved one; the display differs only by the sub-cell
    // interpolation of the rotated lattices (largest at coastlines).
    const d2 = b.toDraft();
    expect(Array.from(d2.elev)).toEqual(Array.from(d.elev));
    expect(Array.from(d2.age)).toEqual(Array.from(d.age));
    expect(Array.from(d2.orogeny as Float32Array)).toEqual(Array.from(d.orogeny as Float32Array));
    const diffs = Array.from(sb.elev, (v, i) => Math.abs(v - sa.elev[i])).sort((x, y) => x - y);
    expect(diffs[Math.floor(0.5 * diffs.length)]).toBeLessThan(60);
    // Rotations continue from the carried frames.
    b.step(1);
    a.step(1);
    const ra = a.snapshot().plates, rb = b.snapshot().plates;
    expect(rb.map((p) => p.id)).toEqual(ra.map((p) => p.id));
    rb.forEach((p, k) => {
      const dq = quatMul(p.rotation, [-ra[k].rotation[0], -ra[k].rotation[1], -ra[k].rotation[2], ra[k].rotation[3]]);
      expect(Math.abs(dq[3])).toBeGreaterThan(Math.cos(0.5 * 1e-3));
    });
    // Statistics keep evolving smoothly.
    a.step(20);
    b.step(20);
    const stA = a.stats(), stB = b.stats();
    expect(Math.abs(stA.landFraction - stB.landFraction)).toBeLessThan(0.03);
    expect(Math.abs(stA.continentalFraction - stB.continentalFraction)).toBeLessThan(0.03);
    expect(stB.time).toBe(stA.time);
  });

  it('memoizes snapshots per step with unique ids and invalidates on edits', () => {
    const draft = randomDraft(mesh, 7);
    const a = new TectonicSim(mesh, draft);
    const b = new TectonicSim(mesh, draft);
    const s1 = a.snapshot();
    expect(a.snapshot()).toBe(s1);
    expect(s1.id).toBeGreaterThan(0);
    expect(b.snapshot().id).not.toBe(s1.id);
    a.step();
    const s2 = a.snapshot();
    expect(s2).not.toBe(s1);
    expect(s2.id).toBe(s1.id + 1);
    // Parameter changes do not alter the current state; plate motion edits do.
    a.setParams({ erosion: 2 });
    expect(a.snapshot()).toBe(s2);
    const id = s2.plates[0].id;
    a.setPlateOmega(id, [0, 0, 30 / EARTH_RADIUS_KM]);
    const s3 = a.snapshot();
    expect(s3).not.toBe(s2);
    expect(s3.id).not.toBe(s2.id);
    expect(s3.plates[0].omega).toEqual([0, 0, 30 / EARTH_RADIUS_KM]);
    a.setPlateOmega(123456, [1, 2, 3]);
    expect(a.snapshot()).toBe(s3);
  });

  it('reports rotation = q ⊗ frame and keeps time / params', () => {
    const draft = twoPlateDraft(mesh, 'transform');
    const frame: [number, number, number, number] = [0, 0, Math.sin(0.2), Math.cos(0.2)];
    draft.plates[1].frame = frame;
    const sim = new TectonicSim(mesh, draft, { riftRate: 0 });
    sim.step(10);
    const p = sim.snapshot().plates[1];
    const ang = (10 * 50) / EARTH_RADIUS_KM;
    const expected = quatMul([0, 0, Math.sin(ang / 2), Math.cos(ang / 2)], frame);
    p.rotation.forEach((v, c) => expect(v).toBeCloseTo(expected[c], 6));
    expect(sim.time).toBe(10);
    sim.setParams({ dt: 2 });
    sim.step();
    expect(sim.time).toBe(12);
    expect(() => sim.setParams({ dt: -1 })).toThrow();
    expect(sim.params.dt).toBe(2);
    expect(DEFAULT_TECTONIC_PARAMS.dt).toBe(1);
  });

  it('rifts plates below the cap and never exceeds it', () => {
    const draft = randomDraft(mesh, 8, 6);
    const sim = new TectonicSim(mesh, draft, { riftRate: 200, maxPlates: 9, mergePlates: false });
    let maxPlates = 0;
    for (let t = 0; t < 40; t++) {
      sim.step();
      maxPlates = Math.max(maxPlates, sim.stats().plateCount);
    }
    const st = sim.stats();
    expect(st.rifts).toBeGreaterThan(0);
    expect(maxPlates).toBeLessThanOrEqual(9);
    const ids = sim.snapshot().plates.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(sim.toDraft().nextPlateId).toBeGreaterThan(Math.max(...ids));
  });
});
