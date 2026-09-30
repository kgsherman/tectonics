import { describe, expect, it } from 'vitest';
import { MAX_PLATES } from '../src/core/constants';
import type { GenerateParams, SphereMesh, WorldSnapshot } from '../src/core/types';
import { CRUST_CONTINENTAL } from '../src/core/types';
import { classifyBoundaries, computePlateInfos } from '../src/tectonics/draft';
import { DEFAULT_GENERATE_PARAMS, generateRandomDraft } from '../src/tectonics/generate';
import { TectonicSim } from '../src/tectonics/sim';
import { settleDebug } from '../src/tectonics/simDirty';
import { substepCount } from '../src/tectonics/simKinematics';
import { walkFrom, type SimMesh } from '../src/tectonics/simMesh';
import { OWNED_BLOCK, type PlateSlot, type SimState } from '../src/tectonics/simState';
import { smallMesh, twoPlateDraft } from './helpers/fixtures';

const world = (mesh: SphereMesh, seed: number, extra: Partial<GenerateParams> = {}) =>
  generateRandomDraft(mesh, { ...DEFAULT_GENERATE_PARAMS, seed, plateCount: 16, ...extra });
const stateOf = (s: TectonicSim): SimState => (s as unknown as { state: SimState }).state;

/**
 * Reference display interpolation (the pre-optimization algorithm): walk to the nearest lattice cell,
 * then test every triangle of its fan and of its neighbours' fans for containment.
 */
function referenceElev(state: SimState): Float32Array {
  const sm: SimMesh = state.sm;
  const { xyz, vtOff, vtTri, adjOffset, adj, toExt } = sm;
  const tris = sm.mesh.triangles;
  const out = new Float32Array(state.n);
  const fan = (v: number, x: number, y: number, z: number): number[] | null => {
    for (let q = vtOff[v]; q < vtOff[v + 1]; q++) {
      const t = vtTri[q];
      const a = tris[3 * t], b = tris[3 * t + 1], c = tris[3 * t + 2];
      const w = [
        x * (xyz[3 * b + 1] * xyz[3 * c + 2] - xyz[3 * b + 2] * xyz[3 * c + 1]) + y * (xyz[3 * b + 2] * xyz[3 * c] - xyz[3 * b] * xyz[3 * c + 2]) + z * (xyz[3 * b] * xyz[3 * c + 1] - xyz[3 * b + 1] * xyz[3 * c]),
        x * (xyz[3 * c + 1] * xyz[3 * a + 2] - xyz[3 * c + 2] * xyz[3 * a + 1]) + y * (xyz[3 * c + 2] * xyz[3 * a] - xyz[3 * c] * xyz[3 * a + 2]) + z * (xyz[3 * c] * xyz[3 * a + 1] - xyz[3 * c + 1] * xyz[3 * a]),
        x * (xyz[3 * a + 1] * xyz[3 * b + 2] - xyz[3 * a + 2] * xyz[3 * b + 1]) + y * (xyz[3 * a + 2] * xyz[3 * b] - xyz[3 * a] * xyz[3 * b + 2]) + z * (xyz[3 * a] * xyz[3 * b + 1] - xyz[3 * a + 1] * xyz[3 * b]),
      ];
      if (w.every((v2) => v2 >= -1e-12)) return [a, b, c, ...w];
    }
    return null;
  };
  for (let i = 0; i < state.n; i++) {
    const P = state.slots[state.top[i]] as PlateSlot;
    const m = P.m;
    const x0 = xyz[3 * i], y0 = xyz[3 * i + 1], z0 = xyz[3 * i + 2];
    const x = m[0] * x0 + m[3] * y0 + m[6] * z0, y = m[1] * x0 + m[4] * y0 + m[7] * z0, z = m[2] * x0 + m[5] * y0 + m[8] * z0;
    const j = walkFrom(sm, x, y, z, state.src[i]);
    let hit = fan(j, x, y, z);
    for (let q = adjOffset[j]; q < adjOffset[j + 1] && !hit; q++) hit = fan(adj[q], x, y, z);
    let e = P.elev[state.src[i]];
    if (hit) {
      let ws = 0, se = 0;
      for (let c = 0; c < 3; c++) {
        if (!P.owned[hit[c]]) continue;
        ws += Math.max(0, hit[3 + c]);
        se += Math.max(0, hit[3 + c]) * P.elev[hit[c]];
      }
      if (ws > 0) e = se / ws;
    }
    out[toExt[i]] = e + state.trench[i];
  }
  return out;
}

function sameSnapshot(a: WorldSnapshot, b: WorldSnapshot): boolean {
  for (let i = 0; i < a.n; i++) {
    if (a.plate[i] !== b.plate[i] || a.crust[i] !== b.crust[i] || a.elev[i] !== b.elev[i] || a.age[i] !== b.age[i] || a.orogeny[i] !== b.orogeny[i]) return false;
  }
  return true;
}

describe('tectonics perf polish 2: snapshot', () => {
  const mesh = smallMesh(20000);

  it('matches the reference interpolation, classifyBoundaries and computePlateInfos', () => {
    const sim = new TectonicSim(mesh, world(mesh, 3), { riftRate: 5 });
    for (let round = 0; round < 3; round++) {
      sim.step(25);
      const s = sim.snapshot();
      const ref = referenceElev(stateOf(sim));
      let maxDiff = 0;
      for (let i = 0; i < mesh.n; i++) maxDiff = Math.max(maxDiff, Math.abs(s.elev[i] - ref[i]));
      expect(maxDiff, `t=${sim.time}`).toBeLessThan(0.01);
      expect(Array.from(s.boundary)).toEqual(Array.from(classifyBoundaries(mesh, s.plate, s.plates)));
      const infos = computePlateInfos(mesh, s.plate, s.crust, s.plates);
      expect(s.plates.length).toBe(infos.length);
      s.plates.forEach((p, k) => {
        const q = infos[k];
        expect(p.id).toBe(q.id);
        expect(p.area).toBe(q.area);
        expect(p.continentalFraction).toBe(q.continentalFraction);
        for (let c = 0; c < 3; c++) expect(Math.abs(p.centroid[c] - q.centroid[c])).toBeLessThan(1e-9);
        expect(Math.abs(p.speed - q.speed)).toBeLessThan(1e-6);
        expect(p.rotation).toEqual(q.rotation);
      });
    }
  });

  it('stays memoized and interpolates within the value range of the lattice', () => {
    const sim = new TectonicSim(mesh, world(mesh, 5));
    sim.step(10);
    const a = sim.snapshot();
    expect(sim.snapshot()).toBe(a);
    const st = stateOf(sim);
    let lo = Infinity, hi = -Infinity;
    for (const P of st.slots) {
      if (!P) continue;
      for (let j = 0; j < st.n; j++) {
        if (!P.owned[j]) continue;
        lo = Math.min(lo, P.elev[j]);
        hi = Math.max(hi, P.elev[j]);
      }
    }
    for (let i = 0; i < mesh.n; i++) {
      expect(Number.isFinite(a.elev[i])).toBe(true);
      expect(a.elev[i]).toBeLessThanOrEqual(hi + 1e-3);
      expect(a.elev[i]).toBeGreaterThanOrEqual(Math.min(lo, -11000) - 8000);
    }
  });
});

describe('tectonics perf polish 2: exact step accelerations', () => {
  const mesh = smallMesh(20000);

  it('first-substep single-candidate path and pull hints reproduce the reference passes bit for bit', () => {
    // speedScale 1.8 on this coarse mesh: two substeps per step (the common case at 100k cells).
    const draft = world(mesh, 8);
    const params = { speedScale: 1.8, riftRate: 6 };
    const fast = new TectonicSim(mesh, draft, params);
    const reference = new TectonicSim(mesh, draft, params);
    expect(substepCount(stateOf(fast), 1).count).toBe(2);
    try {
      for (let t = 0; t < 40; t++) {
        fast.step();
        settleDebug.fullScans = true;
        settleDebug.noDeepSkip = true;
        reference.step();
        settleDebug.fullScans = false;
        settleDebug.noDeepSkip = false;
        if (t % 8 === 7) expect(sameSnapshot(fast.snapshot(), reference.snapshot()), `step ${t}`).toBe(true);
      }
    } finally {
      settleDebug.fullScans = false;
      settleDebug.noDeepSkip = false;
    }
    const { lastStepMs: _a, ...sa } = fast.stats();
    const { lastStepMs: _b, ...sb } = reference.stats();
    expect(sa).toEqual(sb);
  });

  it('keeps the per-block owned counts exact through rifts, merges, terranes and consumption', () => {
    const sim = new TectonicSim(mesh, world(mesh, 2), { riftRate: 12 });
    const check = (): void => {
      const st = stateOf(sim);
      let live = 0;
      for (let k = 0; k < MAX_PLATES; k++) {
        const P = st.slots[k];
        if (!P) continue;
        live++;
        let owned = 0;
        for (let b = 0; b < P.blockOwned.length; b++) {
          let c = 0;
          for (let j = b * OWNED_BLOCK; j < (b + 1) * OWNED_BLOCK; j++) c += P.owned[j];
          expect(P.blockOwned[b], `slot ${k} block ${b} t=${sim.time}`).toBe(c);
          owned += c;
        }
        expect(owned).toBe(P.ownedCount);
        for (let j = st.n; j < P.owned.length; j++) expect(P.owned[j]).toBe(0);
      }
      expect(live).toBeGreaterThan(1);
    };
    for (let t = 0; t < 4; t++) {
      sim.step(30);
      check();
    }
    expect(sim.stats().rifts + sim.stats().merges).toBeGreaterThan(2);
  });
});

describe('tectonics polish 2: relief liveliness', () => {
  const mesh = smallMesh(20000);

  /** Mean of the highest 1% of continental land cells, and the number of cells above 2 km. */
  const crest = (s: WorldSnapshot): { crest: number; above2: number } => {
    const v: number[] = [];
    for (let i = 0; i < s.n; i++) if (s.crust[i] === CRUST_CONTINENTAL && s.elev[i] > 0) v.push(s.elev[i]);
    v.sort((a, b) => b - a);
    const k = Math.max(1, Math.floor(0.01 * v.length));
    let sum = 0;
    for (let q = 0; q < k; q++) sum += v[q];
    return { crest: sum / k, above2: v.filter((h) => h > 2000).length };
  };

  it('an Andean margin builds a 3.5+ km cordillera that erodes over ~100–200 Myr once subduction stops', () => {
    const draft = twoPlateDraft(mesh, 'cap', { capCrust: CRUST_CONTINENTAL, speed: 50, capRadiusDeg: 40 });
    const sim = new TectonicSim(mesh, draft, { riftRate: 0 });
    sim.step(60);
    const built = crest(sim.snapshot());
    expect(built.crest).toBeGreaterThan(3500);
    expect(built.crest).toBeLessThan(7000);
    for (const p of sim.snapshot().plates) sim.setPlateOmega(p.id, [0, 0, 0]);
    sim.step(40);
    const after40 = crest(sim.snapshot());
    // Still a range 40 Myr later (the previous tuning: 3.3 km crest at 60 Myr, down to 1.9 km with a
    // single cell above 2 km 40 Myr after subduction stopped)...
    expect(after40.crest).toBeGreaterThan(2400);
    expect(after40.above2).toBeGreaterThan(20);
    sim.step(80);
    // ...but worn down to hills after 120 Myr.
    const after120 = crest(sim.snapshot());
    expect(after120.crest).toBeLessThan(1900);
    expect(after120.above2).toBe(0);
  });

  it('keeps an Earth-like land hypsometry with ranges at convergent margins', () => {
    for (const seed of [1, 2]) {
      const sim = new TectonicSim(mesh, world(mesh, seed));
      // Averaged over 150–450 Myr: a single snapshot of a 20k world swings by ±0.1 in these shares
      // (one continental collision plateau can hold a fifth of the land).
      let below1 = 0, above2 = 0, peaks = 0, samples = 0;
      for (const t of [150, 300, 450]) {
        sim.step(t - sim.time);
        const s = sim.snapshot();
        const land: number[] = [];
        for (let i = 0; i < s.n; i++) if (s.elev[i] > 0) land.push(s.elev[i]);
        const share = (h: number): number => land.filter((v) => v > h).length / land.length;
        const top = Math.max(...land);
        expect(top, `seed ${seed} t=${t}`).toBeLessThan(9000);
        below1 += 1 - share(1000);
        above2 += share(2000);
        peaks += top;
        samples++;
      }
      // Earth: ~70% of land below 1 km, ~10% above 2 km, peaks 6–9 km.
      expect(below1 / samples, `seed ${seed}`).toBeGreaterThan(0.5);
      expect(below1 / samples, `seed ${seed}`).toBeLessThan(0.85);
      expect(above2 / samples, `seed ${seed}`).toBeGreaterThan(0.05);
      expect(above2 / samples, `seed ${seed}`).toBeLessThan(0.25);
      expect(peaks / samples, `seed ${seed}`).toBeGreaterThan(4500);
    }
  });
});
