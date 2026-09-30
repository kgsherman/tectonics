import { describe, expect, it } from 'vitest';
import { EARTH_RADIUS_KM } from '../src/core/constants';
import { angleBetween, latLonToVec } from '../src/core/math3';
import { nearestCell } from '../src/core/sphereMesh';
import type { GenerateParams, SphereMesh, Vec3, WorldSnapshot } from '../src/core/types';
import { CRUST_CONTINENTAL, CRUST_OCEANIC } from '../src/core/types';
import { oceanDepthForAge } from '../src/tectonics/draft';
import { DEFAULT_GENERATE_PARAMS, generateRandomDraft } from '../src/tectonics/generate';
import { TectonicSim } from '../src/tectonics/sim';
import { MARGIN_COLUMN_M, MARGIN_INTERVAL } from '../src/tectonics/simConstants';
import { settleDebug } from '../src/tectonics/simDirty';
import { accreteMargins } from '../src/tectonics/simMargins';
import { RegionDijkstra } from '../src/tectonics/simDijkstra';
import { simMeshOf, walkFrom, walkNearest, type SimMesh } from '../src/tectonics/simMesh';
import { markUnowned, type PlateSlot, type SimState } from '../src/tectonics/simState';
import { smallMesh, twoPlateDraft } from './helpers/fixtures';

const DEG = Math.PI / 180;
const cellVec = (mesh: SphereMesh, i: number): Vec3 => [mesh.xyz[3 * i], mesh.xyz[3 * i + 1], mesh.xyz[3 * i + 2]];
const count = (a: ArrayLike<number>, f: (v: number, i: number) => boolean): number => {
  let c = 0;
  for (let i = 0; i < a.length; i++) if (f(a[i], i)) c++;
  return c;
};
const world = (mesh: SphereMesh, seed: number, extra: Partial<GenerateParams> = {}) =>
  generateRandomDraft(mesh, { ...DEFAULT_GENERATE_PARAMS, seed, plateCount: 16, ...extra });

function sameSnapshot(a: WorldSnapshot, b: WorldSnapshot): boolean {
  for (let i = 0; i < a.n; i++) {
    if (a.plate[i] !== b.plate[i] || a.crust[i] !== b.crust[i] || a.elev[i] !== b.elev[i] || a.age[i] !== b.age[i]) return false;
  }
  return true;
}

/** Share of plate-boundary cells that are one-cell protrusions (≥ 4 foreign neighbours). */
function protrusionShare(mesh: SphereMesh, plate: Int16Array): number {
  let boundary = 0, protruding = 0;
  for (let i = 0; i < mesh.n; i++) {
    let k = 0;
    for (let q = mesh.adjOffset[i]; q < mesh.adjOffset[i + 1]; q++) if (plate[mesh.adj[q]] !== plate[i]) k++;
    if (k === 0) continue;
    boundary++;
    if (k >= 4) protruding++;
  }
  return protruding / Math.max(1, boundary);
}

describe('tectonics polish: exact accelerations', () => {
  const mesh = smallMesh(20000);

  it('incremental settle scans and interior skipping reproduce the full passes bit for bit', () => {
    // speedScale 2.5 forces several substeps per step, so the interior skipping is exercised.
    const draft = world(mesh, 5);
    const params = { speedScale: 2.5, riftRate: 20 };
    const fast = new TectonicSim(mesh, draft, params);
    const reference = new TectonicSim(mesh, draft, params);
    try {
      for (let t = 0; t < 30; t++) {
        fast.step();
        settleDebug.fullScans = true;
        settleDebug.noDeepSkip = true;
        reference.step();
        settleDebug.fullScans = false;
        settleDebug.noDeepSkip = false;
        if (t % 10 === 9) expect(sameSnapshot(fast.snapshot(), reference.snapshot()), `step ${t}`).toBe(true);
      }
    } finally {
      settleDebug.fullScans = false;
      settleDebug.noDeepSkip = false;
    }
    const { lastStepMs: _a, ...sa } = fast.stats();
    const { lastStepMs: _b, ...sb } = reference.stats();
    expect(sa).toEqual(sb);
  });

  it('interior skipping stays exact around interior lattice holes', () => {
    // Merges, terrane transfers and speck hand-overs can leave unowned lattice cells inside a plate
    // that no world cell maps onto yet; they open as gaps wherever they surface during a step, so the
    // interior mask must not skip their surroundings. Punch such holes into both sims identically.
    const draft = world(mesh, 3);
    const params = { speedScale: 3, riftRate: 0 };
    const fast = new TectonicSim(mesh, draft, params);
    const reference = new TectonicSim(mesh, draft, params);
    const stateOf = (s: TectonicSim): SimState => (s as unknown as { state: SimState }).state;
    const stepBoth = (): void => {
      fast.step();
      settleDebug.fullScans = true;
      settleDebug.noDeepSkip = true;
      try {
        reference.step();
      } finally {
        settleDebug.fullScans = false;
        settleDebug.noDeepSkip = false;
      }
    };
    for (let t = 0; t < 5; t++) stepBoth();
    const A = stateOf(fast), B = stateOf(reference);
    const { adjOffset, adj, diskOffset, disk } = A.sm;
    const n = A.n;
    // Lattice cells shown at some world cell (per slot): those would be orphans, not hidden holes.
    const shown = new Map<number, Uint8Array>();
    for (let i = 0; i < n; i++) {
      let s = shown.get(A.top[i]);
      if (!s) shown.set(A.top[i], (s = new Uint8Array(n)));
      s[A.src[i]] = 1;
    }
    const used = new Uint8Array(n);
    let holes = 0;
    for (let i = 0; i < n && holes < 40; i += 7) {
      const t = A.top[i];
      let interior = !used[i];
      for (let q = diskOffset[i]; q < diskOffset[i + 1] && interior; q++) interior = A.top[disk[q]] === t && !used[disk[q]];
      if (!interior) continue;
      const P = A.slots[t] as PlateSlot, Q = B.slots[t] as PlateSlot;
      const sh = shown.get(t) as Uint8Array;
      for (let q = adjOffset[A.src[i]]; q < adjOffset[A.src[i] + 1]; q++) {
        const h = adj[q];
        if (!P.owned[h] || sh[h]) continue;
        let surrounded = true;
        for (let r = adjOffset[h]; r < adjOffset[h + 1]; r++) surrounded &&= P.owned[adj[r]] === 1;
        if (!surrounded) continue;
        markUnowned(P, h);
        P.ownedCount--;
        markUnowned(Q, h);
        Q.ownedCount--;
        holes++;
        used[i] = 1;
        for (let r = diskOffset[i]; r < diskOffset[i + 1]; r++) used[disk[r]] = 1;
        break;
      }
    }
    expect(holes).toBeGreaterThan(10);
    for (let t = 0; t < 6; t++) {
      stepBoth();
      expect(sameSnapshot(fast.snapshot(), reference.snapshot()), `step ${t}`).toBe(true);
    }
  });

  it('the inscribed-disk walk returns the exact nearest cell from any start', () => {
    const sm = simMeshOf(mesh);
    let seed = 12345;
    const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let k = 0; k < 2000; k++) {
      const z = 2 * rnd() - 1, phi = 2 * Math.PI * rnd(), r = Math.sqrt(1 - z * z);
      const x = r * Math.cos(phi), y = r * Math.sin(phi);
      const start = Math.floor(rnd() * sm.n);
      const exact = nearestCell(sm.mesh, x, y, z);
      expect(walkFrom(sm, x, y, z, start)).toBe(exact);
      expect(walkNearest(sm.xyz, sm.adjOffset, sm.adj, x, y, z, start)).toBe(exact);
    }
  });

  it('the bucket-queue Dijkstra gives exact shortest region distances', () => {
    const sm: SimMesh = simMeshOf(mesh);
    const n = sm.n;
    const top = new Int16Array(n);
    for (let i = 0; i < n; i++) top[i] = sm.xyz[3 * i + 2] > 0.3 * Math.sin(5 * sm.xyz[3 * i]) ? 1 : 0;
    const sources = Int32Array.from([0, 17, 4000, 9000, 15000, n - 1]);
    const dj = new RegionDijkstra(n);
    dj.run(sm, top, sources, sources.length, 2500);
    // Reference: plain O(n²)-free Dijkstra with a binary heap on (dist, cell).
    const ref = new Float64Array(n).fill(Infinity);
    const heap: Array<[number, number]> = [];
    const push = (d: number, c: number): void => {
      heap.push([d, c]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = (): [number, number] => {
      const topItem = heap[0];
      const last = heap.pop() as [number, number];
      if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return topItem;
    };
    for (const s of sources) {
      ref[s] = 0;
      push(0, s);
    }
    while (heap.length > 0) {
      const [d, c] = pop();
      if (d > ref[c]) continue;
      for (let q = sm.adjOffset[c]; q < sm.adjOffset[c + 1]; q++) {
        const a = sm.adj[q];
        if (top[a] !== top[c]) continue;
        const nd = d + sm.edgeKm[q];
        if (nd > 2500 || nd >= ref[a]) continue;
        ref[a] = nd;
        push(nd, a);
      }
    }
    let reached = 0;
    for (let i = 0; i < n; i++) {
      if (ref[i] === Infinity) expect(dj.dist[i]).toBe(Infinity);
      else {
        reached++;
        expect(Math.abs(dj.dist[i] - ref[i])).toBeLessThan(1e-6);
      }
    }
    expect(dj.reachedCount).toBe(reached);
  });
});

describe('tectonics polish: crustal budget', () => {
  const mesh = smallMesh(20000);

  it('a limited sediment budget is spread over all margins, not taken in cell order', () => {
    // Sim cells are numbered along a space-filling curve, so index order is a spatial order.
    const sim = new TectonicSim(mesh, world(mesh, 4, { continentalFraction: 0.35 }));
    sim.step(5);
    const S = (sim as unknown as { state: SimState }).state;
    const { top, src, slots, n } = S;
    const { adjOffset, adj } = S.sm;
    const contAt = (i: number): boolean => (slots[top[i]] as PlateSlot).crust[src[i]] === CRUST_CONTINENTAL;
    // Passive-margin candidates (as in accreteMargins): oceanic, inside one plate, ≥ 2 continental
    // neighbours; embayments (more continental neighbours) go first.
    let richer = 0;
    const three: number[] = [];
    for (let i = 0; i < n; i++) {
      if (contAt(i)) continue;
      let cont = 0, inside = true;
      for (let q = adjOffset[i]; q < adjOffset[i + 1]; q++) {
        if (top[adj[q]] !== top[i]) inside = false;
        else if (contAt(adj[q])) cont++;
      }
      if (!inside) continue;
      if (cont > 3) richer++;
      else if (cont === 3) three.push(i);
    }
    expect(three.length).toBeGreaterThan(100);
    // Enough sediment for every embayment and half of the three-neighbour margin cells.
    S.sediment = MARGIN_COLUMN_M * (richer + Math.floor(three.length / 2));
    S.marginClock = MARGIN_INTERVAL;
    accreteMargins(S, 0);
    const half = n / 2;
    let lo = 0, hi = 0, loCand = 0, hiCand = 0;
    for (const i of three) {
      if (i < half) loCand++;
      else hiCand++;
      if (!contAt(i)) continue;
      if (i < half) lo++;
      else hi++;
    }
    // Both halves of the sphere's cell order get their share (≈ 1/2; taken in order: ≈ 1 vs ≈ 0).
    expect(lo / loCand).toBeGreaterThan(0.3);
    expect(lo / loCand).toBeLessThan(0.7);
    expect(hi / hiCand).toBeGreaterThan(0.3);
    expect(hi / hiCand).toBeLessThan(0.7);
  });

  it('continental crust stays within ±25% of its initial area over 300 Myr (5%, 35%, 60%)', () => {
    const cases: Array<[number, GenerateParams['continentMode']]> = [[0.05, 'scattered'], [0.35, 'supercontinent'], [0.6, 'archipelago']];
    for (const seed of [1, 2]) {
      for (const [cont, mode] of cases) {
        const sim = new TectonicSim(mesh, world(mesh, seed, { continentalFraction: cont, continentMode: mode }));
        const c0 = sim.stats().continentalFraction;
        for (let t = 0; t < 300; t += 20) {
          sim.step(20);
          const r = sim.stats().continentalFraction / c0;
          expect(r, `seed ${seed} ${cont} ${mode} t=${t + 20}`).toBeGreaterThan(0.75);
          expect(r, `seed ${seed} ${cont} ${mode} t=${t + 20}`).toBeLessThan(1.25);
        }
      }
    }
  });

  it('an ocean world with 30 plates no longer grows continents from its arcs', () => {
    // Before the budget rework 5% continental crust with 30 plates reached 12.6% in 200 Myr.
    const sim = new TectonicSim(mesh, world(mesh, 1, { plateCount: 30, continentalFraction: 0.05 }));
    const c0 = sim.stats().continentalFraction;
    sim.step(200);
    expect(sim.stats().continentalFraction / c0).toBeLessThan(1.25);
    expect(sim.stats().continentalFraction / c0).toBeGreaterThan(0.75);
  });

  it('island arcs still build islands on oceanic crust', () => {
    const n = mesh.n;
    const draft = twoPlateDraft(mesh, 'cap', { speed: 50 });
    for (let i = 0; i < n; i++) {
      draft.age[i] = draft.plate[i] === 1 ? 20 : 120;
      draft.elev[i] = oceanDepthForAge(draft.age[i]);
    }
    const sim = new TectonicSim(mesh, draft, { riftRate: 0 });
    sim.step(60);
    const d = sim.toDraft();
    const islands = count(d.elev, (h, i) => h > 0 && d.crust[i] === CRUST_OCEANIC && d.plate[i] === 1);
    expect(islands).toBeGreaterThan(3);
  });

  it('a microcontinent docks onto the overriding continent instead of being consumed', () => {
    const draft = twoPlateDraft(mesh, 'cap', { capCrust: CRUST_CONTINENTAL, capRadiusDeg: 30 });
    const f0 = latLonToVec(0, 42 * DEG);
    let fragment = 0;
    for (let i = 0; i < mesh.n; i++) {
      if (angleBetween(cellVec(mesh, i), f0) < 5 * DEG) {
        draft.crust[i] = CRUST_CONTINENTAL;
        draft.elev[i] = 400;
        fragment++;
      }
    }
    const cont0 = count(draft.crust, (c) => c === CRUST_CONTINENTAL);
    const sim = new TectonicSim(mesh, draft, { riftRate: 0 });
    sim.step(40);
    const s = sim.snapshot();
    const restId = draft.plates[0].id;
    const onRest = count(s.crust, (c, i) => c === CRUST_CONTINENTAL && s.plates[s.plate[i]].id === restId);
    expect(fragment).toBeGreaterThan(20);
    expect(onRest).toBeLessThan(0.2 * fragment);
    const cont = count(s.crust, (c) => c === CRUST_CONTINENTAL);
    expect(Math.abs(cont / cont0 - 1)).toBeLessThan(0.05);
  });
});

describe('tectonics polish: long-run liveliness and boundary quality', () => {
  it('plate boundaries stay smooth at cell scale', () => {
    const mesh = smallMesh(20000);
    const sim = new TectonicSim(mesh, world(mesh, 2));
    for (let t = 0; t < 150; t += 50) {
      sim.step(50);
      expect(protrusionShare(mesh, sim.snapshot().plate), `t=${t + 50}`).toBeLessThan(0.02);
    }
  });

  it('keeps 6–24 moving plates through 600 Myr of rifting and welding', () => {
    const mesh = smallMesh(10000);
    const sim = new TectonicSim(mesh, world(mesh, 3));
    let minPlates = Infinity, maxPlates = 0;
    for (let t = 0; t < 600; t += 25) {
      sim.step(25);
      const st = sim.stats();
      minPlates = Math.min(minPlates, st.plateCount);
      maxPlates = Math.max(maxPlates, st.plateCount);
    }
    expect(minPlates).toBeGreaterThanOrEqual(6);
    expect(maxPlates).toBeLessThanOrEqual(24);
    const st = sim.stats();
    expect(st.rifts).toBeGreaterThan(5);
    expect(st.merges).toBeGreaterThan(5);
    const s = sim.snapshot();
    let speed = 0;
    for (const p of s.plates) speed += p.speed * p.area;
    expect(speed).toBeGreaterThan(10);
    expect(Math.hypot(...s.plates[0].omega) * EARTH_RADIUS_KM).toBeLessThanOrEqual(150 + 1e-6);
  });
});
