import { describe, expect, it } from 'vitest';
import { EARTH_RADIUS_KM, MAX_PLATES } from '../src/core/constants';
import { createSphereMesh } from '../src/core/sphereMesh';
import type { GenerateParams, SphereMesh, WorldDraft } from '../src/core/types';
import { CRUST_CONTINENTAL } from '../src/core/types';
import { computePlateInfos, oceanDepthForAge } from '../src/tectonics/draft';
import { DEFAULT_GENERATE_PARAMS, generateRandomDraft } from '../src/tectonics/generate';
import { boundaryKinematics } from '../src/tectonics/genKinematics';
import { labelComponents } from '../src/tectonics/genGraph';
import { CONTINENTAL_PLATE_FRACTION, continentClusters } from '../src/tectonics/genMotion';

const mesh = createSphereMesh(40000);
const MODES: GenerateParams['continentMode'][] = ['scattered', 'supercontinent', 'archipelago'];

const cache = new Map<string, WorldDraft>();
function gen(p: Partial<GenerateParams> = {}): WorldDraft {
  const key = JSON.stringify(p);
  let d = cache.get(key);
  if (!d) {
    d = generateRandomDraft(mesh, { ...DEFAULT_GENERATE_PARAMS, ...p });
    cache.set(key, d);
  }
  return d;
}

function continentalFraction(d: WorldDraft): number {
  let c = 0;
  for (let i = 0; i < d.n; i++) c += d.crust[i] === CRUST_CONTINENTAL ? 1 : 0;
  return c / d.n;
}

function isBoundaryCell(m: SphereMesh, plate: Int16Array, i: number): boolean {
  for (let e = m.adjOffset[i]; e < m.adjOffset[i + 1]; e++) if (plate[m.adj[e]] !== plate[i]) return true;
  return false;
}

/** Number of connected components of plate k. */
function componentsOf(m: SphereMesh, plate: Int16Array, k: number): number {
  const seen = new Uint8Array(m.n);
  let comps = 0;
  for (let s = 0; s < m.n; s++) {
    if (plate[s] !== k || seen[s]) continue;
    comps++;
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      for (let e = m.adjOffset[i]; e < m.adjOffset[i + 1]; e++) {
        const j = m.adj[e];
        if (!seen[j] && plate[j] === k) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
  }
  return comps;
}

function expectFiniteDraft(d: WorldDraft): void {
  for (let i = 0; i < d.n; i++) {
    if (!Number.isFinite(d.elev[i]) || !Number.isFinite(d.age[i])) throw new Error(`non-finite at ${i}`);
    if (d.orogeny && !Number.isFinite(d.orogeny[i])) throw new Error(`non-finite orogeny at ${i}`);
    if (d.plate[i] < 0 || d.plate[i] >= d.plates.length) throw new Error(`bad plate index at ${i}`);
  }
  for (const p of d.plates) for (const w of p.omega) expect(Number.isFinite(w)).toBe(true);
}

describe('generateRandomDraft', () => {
  it('is deterministic and seed-dependent', () => {
    const a = generateRandomDraft(mesh, { ...DEFAULT_GENERATE_PARAMS, seed: 5 });
    const b = generateRandomDraft(mesh, { ...DEFAULT_GENERATE_PARAMS, seed: 5 });
    expect(Array.from(a.plate)).toEqual(Array.from(b.plate));
    expect(Array.from(a.crust)).toEqual(Array.from(b.crust));
    expect(Array.from(a.elev)).toEqual(Array.from(b.elev));
    expect(Array.from(a.age)).toEqual(Array.from(b.age));
    expect(a.plates).toEqual(b.plates);
    expect(a.hotspots).toEqual(b.hotspots);
    const c = gen({ seed: 6 });
    let diff = 0;
    for (let i = 0; i < mesh.n; i++) if (a.crust[i] !== c.crust[i]) diff++;
    expect(diff).toBeGreaterThan(mesh.n * 0.05);
  });

  it('sets the draft bookkeeping fields', () => {
    const d = gen();
    expect(d.n).toBe(mesh.n);
    expect(d.time).toBe(0);
    expect(d.stepIndex).toBe(0);
    expect(d.revision).toBe(0);
    expect(d.seed).toBe(DEFAULT_GENERATE_PARAMS.seed);
    for (const p of d.plates) expect(p.frame).toBeUndefined();
    expectFiniteDraft(d);
  });

  it('honours plateCount, clamped to [3, MAX_PLATES - 2], with unique ids', () => {
    for (const [asked, expected] of [[1, 3], [3, 3], [12, 12], [30, 30], [45, MAX_PLATES - 2]]) {
      const d = gen({ plateCount: asked, seed: 3 });
      expect(d.plates.length).toBe(expected);
      const used = new Set<number>();
      for (let i = 0; i < d.n; i++) used.add(d.plate[i]);
      expect(used.size).toBe(expected);
      const ids = d.plates.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(d.nextPlateId).toBeGreaterThan(Math.max(...ids));
    }
  });

  it('every plate is one connected region', () => {
    for (const mode of MODES) {
      const d = gen({ continentMode: mode, seed: 2 });
      for (let k = 0; k < d.plates.length; k++) expect(componentsOf(mesh, d.plate, k)).toBe(1);
    }
  });

  it('matches the continental fraction within ±0.03 in every mode', () => {
    for (const mode of MODES) {
      for (const f of [0.05, 0.2, 0.35, 0.55, 0.7]) {
        const d = gen({ continentMode: mode, continentalFraction: f, seed: 11 });
        expect(Math.abs(continentalFraction(d) - f)).toBeLessThanOrEqual(0.03);
      }
    }
    const none = gen({ continentalFraction: 0 });
    expect(continentalFraction(none)).toBe(0);
    expectFiniteDraft(none);
  });

  it('continent layout per mode: scattered 3–7 continents, one supercontinent + fragments, many islands', () => {
    /** Areas (fraction of the sphere) of the connected continental masses, descending. */
    const masses = (d: WorldDraft): number[] => {
      const mask = new Uint8Array(d.n);
      for (let i = 0; i < d.n; i++) mask[i] = d.crust[i] === CRUST_CONTINENTAL ? 1 : 0;
      return labelComponents(mesh, mask, mask).size.map((s) => s / d.n).sort((a, b) => b - a);
    };
    for (let seed = 1; seed <= 10; seed++) {
      // Continents = masses of at least 1% of the sphere (islands and terranes aside).
      const scattered = masses(gen({ continentMode: 'scattered', seed })).filter((a) => a >= 0.01).length;
      expect(scattered, `scattered seed ${seed}`).toBeGreaterThanOrEqual(3);
      expect(scattered, `scattered seed ${seed}`).toBeLessThanOrEqual(7);
      const sc = masses(gen({ continentMode: 'supercontinent', seed }));
      expect(sc[0], `supercontinent seed ${seed}`).toBeGreaterThan(0.7 * 0.35);
      const arch = masses(gen({ continentMode: 'archipelago', seed }));
      expect(arch[0], `archipelago seed ${seed}`).toBeLessThan(0.2);
      expect(arch.length, `archipelago seed ${seed}`).toBeGreaterThanOrEqual(12);
    }
  });

  it('realistic plate size spread: a few large, several medium, a few small', () => {
    for (const mode of MODES) {
      for (const seed of [1, 2]) {
        const d = gen({ continentMode: mode, seed });
        const areas = computePlateInfos(mesh, d.plate, d.crust, d.plates).map((p) => p.area).sort((a, b) => b - a);
        expect(areas[0]).toBeLessThan(0.35);
        expect(areas[0]).toBeGreaterThan(0.1);
        expect(areas[areas.length - 1]).toBeGreaterThan(0.003);
        expect(areas[areas.length - 1]).toBeLessThan(0.04);
        expect(areas.filter((a) => a > 0.08).length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('plate boundaries avoid continental crust', () => {
    for (const mode of MODES) {
      for (const seed of [1, 2, 3]) {
        const d = gen({ continentMode: mode, seed });
        let b = 0, bc = 0;
        for (let i = 0; i < d.n; i++) {
          if (!isBoundaryCell(mesh, d.plate, i)) continue;
          b++;
          if (d.crust[i] === CRUST_CONTINENTAL) bc++;
        }
        // Random boundaries would be ~35% continental; ours stay well below.
        expect(bc / b).toBeLessThan(0.6 * continentalFraction(d));
      }
    }
  });

  it('plate speeds follow §5 and continent-sharing plates move together', () => {
    for (const mode of MODES) {
      for (const seed of [1, 4]) {
        for (const plateSpeed of [50, 25]) {
          const d = gen({ continentMode: mode, seed, plateSpeed });
          const scale = plateSpeed / 50;
          const infos = computePlateInfos(mesh, d.plate, d.crust, d.plates);
          const cluster = continentClusters(mesh, d.plate, d.crust, d.plates.length);
          const size = new Map<number, number>();
          for (const c of cluster) size.set(c, (size.get(c) ?? 0) + 1);
          let steepPoles = 0, singles = 0;
          infos.forEach((p, k) => {
            if ((size.get(cluster[k]) ?? 0) > 1) {
              expect(p.speed).toBeGreaterThan(5 * scale);
              expect(p.speed).toBeLessThan(50 * scale);
              return;
            }
            singles++;
            const [lo, hi] = p.continentalFraction >= CONTINENTAL_PLATE_FRACTION ? [15, 40] : [40, 100];
            expect(p.speed).toBeGreaterThanOrEqual(lo * scale - 0.5);
            expect(p.speed).toBeLessThanOrEqual(hi * scale + 0.5);
            const w = p.omega;
            const wl = Math.hypot(w[0], w[1], w[2]);
            const pole = (Math.acos(Math.abs(w[0] * p.centroid[0] + w[1] * p.centroid[1] + w[2] * p.centroid[2]) / wl) * 180) / Math.PI;
            expect(pole).toBeGreaterThan(34);
            if (pole >= 59.9) steepPoles++;
          });
          if (singles >= 4) expect(steepPoles / singles).toBeGreaterThanOrEqual(0.5);
          // Relative speed across every continent–continent boundary < 10 km/Myr.
          for (let i = 0; i < d.n; i++) {
            if (d.crust[i] !== CRUST_CONTINENTAL) continue;
            const a = d.plate[i];
            for (let e = mesh.adjOffset[i]; e < mesh.adjOffset[i + 1]; e++) {
              const j = mesh.adj[e];
              const b = d.plate[j];
              if (b === a || d.crust[j] !== CRUST_CONTINENTAL) continue;
              const wa = d.plates[a].omega, wb = d.plates[b].omega;
              const x = mesh.xyz[3 * i], y = mesh.xyz[3 * i + 1], z = mesh.xyz[3 * i + 2];
              const wx = wb[0] - wa[0], wy = wb[1] - wa[1], wz = wb[2] - wa[2];
              const v = Math.hypot(wy * z - wz * y, wz * x - wx * z, wx * y - wy * x) * EARTH_RADIUS_KM;
              expect(v).toBeLessThan(10);
            }
          }
        }
      }
    }
  });

  it('ocean crust is youngest at the divergent boundaries and depth follows age', () => {
    for (const mode of MODES) {
      const d = gen({ continentMode: mode, seed: 1 });
      const kin = boundaryKinematics(mesh, d.plate, d.plates.map((p) => p.omega));
      let ridgeAge = 0, ridgeN = 0, oceanAge = 0, oceanN = 0, featureCells = 0;
      for (let i = 0; i < d.n; i++) {
        if (d.crust[i] === CRUST_CONTINENTAL) continue;
        expect(d.age[i]).toBeGreaterThanOrEqual(0);
        expect(d.age[i]).toBeLessThanOrEqual(180); // SPEC §5: 0–180 Myr
        oceanAge += d.age[i];
        oceanN++;
        if (kin.diverge[i] > 15) {
          ridgeAge += d.age[i];
          ridgeN++;
        }
        const base = oceanDepthForAge(d.age[i]);
        // Features (hotspot swells/seamounts, continental rise) only ever raise the floor.
        expect(d.elev[i]).toBeGreaterThanOrEqual(base - 1);
        if (d.elev[i] > base + 50) featureCells++;
      }
      expect(ridgeN).toBeGreaterThan(20);
      expect(ridgeAge / ridgeN).toBeLessThan(10);
      expect(ridgeAge / ridgeN).toBeLessThan(0.15 * (oceanAge / oceanN));
      expect(oceanAge / oceanN).toBeGreaterThan(30);
      // Passive-margin rises and hotspot swells touch a minority of the sea floor.
      expect(featureCells / oceanN).toBeLessThan(0.4);
    }
  });

  it('continents: 70–80% emergent, shelves, plausible relief', () => {
    for (const mode of MODES) {
      const d = gen({ continentMode: mode, seed: 2 });
      let cont = 0, contLand = 0, shelf = 0, high = 0, oceanIslands = 0, maxE = -Infinity, minE = Infinity;
      for (let i = 0; i < d.n; i++) {
        maxE = Math.max(maxE, d.elev[i]);
        minE = Math.min(minE, d.elev[i]);
        if (d.crust[i] !== CRUST_CONTINENTAL) {
          if (d.elev[i] > 0) oceanIslands++; // hotspot volcanoes only
          continue;
        }
        cont++;
        if (d.elev[i] > 0) contLand++;
        else if (d.elev[i] > -400) shelf++;
        if (d.elev[i] > 2000) high++;
        expect(d.age[i]).toBeGreaterThan(0);
      }
      expect(oceanIslands / d.n).toBeLessThan(0.002);
      expect(contLand / cont).toBeGreaterThanOrEqual(0.68);
      expect(contLand / cont).toBeLessThanOrEqual(0.82);
      expect((contLand + shelf) / cont).toBeGreaterThan(0.99);
      expect(high / cont).toBeGreaterThan(0.002);
      expect(high / cont).toBeLessThan(0.15);
      expect(maxE).toBeLessThan(7000);
      expect(minE).toBeGreaterThan(-7000);
    }
  });

  it('places the requested hotspots', () => {
    const d = gen({ hotspotCount: 13, seed: 8 });
    expect(d.hotspots.length).toBe(13);
    for (const h of d.hotspots) {
      expect(Math.hypot(...h.pos)).toBeCloseTo(1, 6);
      expect(h.strength).toBeGreaterThanOrEqual(0.5);
      expect(h.strength).toBeLessThanOrEqual(1.5);
      expect(h.radius).toBeGreaterThanOrEqual((1.5 * Math.PI) / 180);
      expect(h.radius).toBeLessThanOrEqual((3 * Math.PI) / 180);
    }
    expect(gen({ hotspotCount: 0 }).hotspots.length).toBe(0);
  });

  it('handles extreme parameters without NaN', () => {
    const cases: Array<Partial<GenerateParams>> = [
      { plateSpeed: 0 },
      { boundaryRoughness: 0 },
      { boundaryRoughness: 1, plateCount: 30 },
      { continentalFraction: 0.7, continentMode: 'supercontinent', plateCount: 3 },
      { continentalFraction: 0.05, continentMode: 'archipelago', plateCount: 30 },
    ];
    for (const c of cases) {
      const d = gen(c);
      expectFiniteDraft(d);
      if (c.plateSpeed === 0) for (const p of d.plates) expect(Math.hypot(...p.omega)).toBe(0);
    }
  });

  it('works on tiny meshes (every plate present, finite) and is independent of the mesh instance', () => {
    const tiny = createSphereMesh(500);
    for (const mode of MODES) {
      for (const plateCount of [3, 30]) {
        const d = generateRandomDraft(tiny, { ...DEFAULT_GENERATE_PARAMS, continentMode: mode, plateCount });
        const used = new Set<number>();
        for (let i = 0; i < d.n; i++) used.add(d.plate[i]);
        expect(used.size).toBe(plateCount);
        expectFiniteDraft(d);
      }
    }
    const other = generateRandomDraft(createSphereMesh(40000), { ...DEFAULT_GENERATE_PARAMS });
    expect(Array.from(other.elev)).toEqual(Array.from(gen().elev));
  });

  it('rejects invalid parameters', () => {
    expect(() => generateRandomDraft(mesh, { ...DEFAULT_GENERATE_PARAMS, seed: Number.NaN })).toThrow();
    expect(() => generateRandomDraft(mesh, { ...DEFAULT_GENERATE_PARAMS, continentMode: 'pangaea' as never })).toThrow();
  });
});
