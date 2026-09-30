import { describe, expect, it } from 'vitest';
import { EARTH_RADIUS_KM, MAX_PLATES } from '../src/core/constants';
import { latLonToVec, omegaFromDirection } from '../src/core/math3';
import { createSphereMesh } from '../src/core/sphereMesh';
import type { PlateSpec, SphereMesh, Vec3, WorldDraft } from '../src/core/types';
import { CRUST_CONTINENTAL, CRUST_OCEANIC } from '../src/core/types';
import {
  blankDraft, cloneDraft, computePlateInfos, enforceConnectivity, finalizeDraft, oceanDepthForAge, plateColor, resampleDraft,
} from '../src/tectonics/draft';
import { DEFAULT_GENERATE_PARAMS, generateRandomDraft } from '../src/tectonics/generate';

const mesh = createSphereMesh(12000);

function spec(id: number, omega: Vec3 = [0, 0, 0]): PlateSpec {
  return { id, name: `P${id}`, color: plateColor(id), omega };
}

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

/**
 * Plate 0 = two polar caps (|lat| > 50°, disconnected), plate 1 = the band between them plus a small
 * enclave of plate 1 cells near the north pole (a < 20-cell fragment), plate 2 = unused.
 */
function capsDraft(): WorldDraft {
  const d = blankDraft(mesh, 3);
  d.plates = [spec(1, omegaFromDirection(latLonToVec(1.2, 0), 1, 0, 40)), spec(2, omegaFromDirection(latLonToVec(0, 1), 0, 1, 50)), spec(7)];
  d.nextPlateId = 8;
  const pole = latLonToVec(1.45, 0.3);
  let enclave = 0;
  for (let i = 0; i < mesh.n; i++) {
    d.plate[i] = Math.abs(mesh.lat[i]) > (50 * Math.PI) / 180 ? 0 : 1;
    const x = mesh.xyz[3 * i], y = mesh.xyz[3 * i + 1], z = mesh.xyz[3 * i + 2];
    if (enclave < 8 && x * pole[0] + y * pole[1] + z * pole[2] > Math.cos(0.02)) {
      d.plate[i] = 1;
      enclave++;
    }
  }
  return d;
}

describe('finalizeDraft', () => {
  it('splits disconnected plates, merges tiny fragments, compacts and keeps ids unique', () => {
    const d = capsDraft();
    const f = finalizeDraft(mesh, d, 9);
    expect(f.plates.length).toBe(3);
    for (let k = 0; k < f.plates.length; k++) expect(componentsOf(mesh, f.plate, k)).toBe(1);
    const ids = f.plates.map((p) => p.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).not.toContain(7); // unused plate compacted away
    expect(f.nextPlateId).toBeGreaterThan(Math.max(...ids));
    // The split-off cap moves with its parent.
    const child = f.plates.find((p) => p.id >= 8)!;
    expect(child.omega).toEqual(d.plates[0].omega);
    // Enclave cells were absorbed by the surrounding cap.
    const k0 = f.plate[mesh.n - 1];
    for (let i = 0; i < mesh.n; i++) if (mesh.lat[i] > 1.3) expect(f.plate[i]).toBe(f.plate[0]);
    expect(k0).toBeGreaterThanOrEqual(0);
  });

  it('leaves the input untouched and bumps the revision', () => {
    const d = capsDraft();
    d.revision = 4;
    const before = cloneDraft(d);
    const keep = new Uint8Array(mesh.n);
    const f = finalizeDraft(mesh, d, 9, keep);
    expect(d).toEqual(before);
    expect(f.revision).toBe(5);
    expect(f.plate).not.toBe(d.plate);
  });

  it('gives motionless plates a 30–60 km/Myr default motion, deterministically', () => {
    const d = capsDraft();
    d.plates[0].omega = [0, 0, 0];
    const f = finalizeDraft(mesh, d, 21);
    const g = finalizeDraft(mesh, d, 21);
    expect(f.plates.map((p) => p.omega)).toEqual(g.plates.map((p) => p.omega));
    const infos = computePlateInfos(mesh, f.plate, f.crust, f.plates);
    // Plate 1 (the two caps) had no motion; its split-off cap inherits that and also gets a default.
    const defaulted = infos.filter((p) => p.id === 1 || p.id >= 8);
    expect(defaulted.length).toBe(2);
    for (const p of defaulted) {
      expect(p.speed).toBeGreaterThanOrEqual(29.99);
      expect(p.speed).toBeLessThanOrEqual(60.01);
    }
    // Moving plates keep their motion.
    const band = f.plates.find((p) => p.id === 2)!;
    expect(band.omega).toEqual(d.plates[1].omega);
  });

  it('synthesizes ocean ages from divergent boundaries and depths from age (keepElevation respected)', () => {
    // Two hemispheres spreading apart at 60 km/Myr along the equator.
    const d = blankDraft(mesh, 2);
    const speed = 30 / EARTH_RADIUS_KM;
    d.plates = [spec(1, [0, speed, 0]), spec(2, [0, -speed, 0])];
    d.nextPlateId = 3;
    for (let i = 0; i < mesh.n; i++) d.plate[i] = mesh.xyz[3 * i + 2] >= 0 ? 0 : 1;
    const keep = new Uint8Array(mesh.n);
    for (let i = 0; i < mesh.n; i += 7) {
      keep[i] = 1;
      d.elev[i] = -1234;
    }
    const f = finalizeDraft(mesh, d, 1, keep);
    let ridge = 0, ridgeAge = 0;
    for (let i = 0; i < mesh.n; i++) {
      expect(Number.isFinite(f.age[i])).toBe(true);
      expect(f.age[i]).toBeGreaterThanOrEqual(0);
      if (keep[i]) {
        // Kept cells keep their whole ocean floor: elevation and age.
        expect(f.elev[i]).toBe(-1234);
        expect(f.age[i]).toBe(60);
        continue;
      }
      expect(f.age[i]).toBeLessThanOrEqual(180);
      expect(f.elev[i]).toBeCloseTo(oceanDepthForAge(f.age[i]), 3);
      const lon = mesh.lon[i];
      // ω = ±y: the hemispheres separate on the x < 0 side of the equator (and converge at x > 0).
      if (Math.abs(mesh.lat[i]) < 0.015 && Math.cos(lon) < -0.5) {
        ridge++;
        ridgeAge += f.age[i];
      }
      // Age grows away from the ridge: ~ distance / half-rate (30 km/Myr).
      if (Math.cos(lon) < -0.9 && Math.abs(mesh.lat[i]) > 0.2 && Math.abs(mesh.lat[i]) < 0.3) {
        const km = Math.abs(mesh.lat[i]) * EARTH_RADIUS_KM;
        expect(f.age[i]).toBeGreaterThan((0.6 * km) / 30);
        expect(f.age[i]).toBeLessThan((1.4 * km) / 30);
      }
    }
    expect(ridge).toBeGreaterThan(10);
    expect(ridgeAge / ridge).toBeLessThan(3);
  });

  it('fills continental cells lacking relief with a coastal profile and keeps plausible ones', () => {
    const d = blankDraft(mesh, 4);
    d.plates = [spec(1, omegaFromDirection(latLonToVec(0, 0), 1, 0, 30))];
    const c = latLonToVec(0.3, 1);
    for (let i = 0; i < mesh.n; i++) {
      const x = mesh.xyz[3 * i], y = mesh.xyz[3 * i + 1], z = mesh.xyz[3 * i + 2];
      if (x * c[0] + y * c[1] + z * c[2] > Math.cos(0.5)) {
        d.crust[i] = CRUST_CONTINENTAL;
        d.elev[i] = x > 0.2 ? 777 : -4000; // part with relief, part raw ocean depth
      }
    }
    const f = finalizeDraft(mesh, d, 2);
    let shelf = 0, land = 0;
    for (let i = 0; i < mesh.n; i++) {
      if (f.crust[i] !== CRUST_CONTINENTAL) {
        expect(f.elev[i]).toBeLessThan(-1000);
        continue;
      }
      if (d.elev[i] === 777) expect(f.elev[i]).toBe(777);
      else {
        expect(f.elev[i]).toBeGreaterThan(-200);
        expect(f.elev[i]).toBeLessThan(420);
        if (f.elev[i] < 0) shelf++;
        else land++;
      }
    }
    expect(shelf).toBeGreaterThan(0);
    expect(land).toBeGreaterThan(shelf);
  });

  it('reassigns large leftover regions completely (no BFS queue overflow)', () => {
    // enforceConnectivity: label 0 = both polar caps (|lat| > 5°), so ~46% of the cells (the smaller
    // cap) must be refilled from the band; label 1 = the band.
    const lab = new Int16Array(mesh.n);
    for (let i = 0; i < mesh.n; i++) lab[i] = Math.abs(mesh.lat[i]) > (5 * Math.PI) / 180 ? 0 : 1;
    enforceConnectivity(mesh, lab, 2);
    expect(componentsOf(mesh, lab, 0)).toBe(1);
    expect(componentsOf(mesh, lab, 1)).toBe(1);
    // finalizeDraft at the plate cap: plate 0 = both caps; the second cap cannot become a plate.
    const d = blankDraft(mesh, 1);
    d.plates = Array.from({ length: MAX_PLATES }, (_, k) => spec(k + 1, omegaFromDirection(latLonToVec(0, k), 1, 0, 20)));
    d.nextPlateId = MAX_PLATES + 1;
    for (let i = 0; i < mesh.n; i++) {
      if (Math.abs(mesh.lat[i]) > (5 * Math.PI) / 180) d.plate[i] = 0;
      else d.plate[i] = 1 + Math.min(MAX_PLATES - 2, Math.floor(((mesh.lon[i] + Math.PI) / (2 * Math.PI)) * (MAX_PLATES - 1)));
    }
    const f = finalizeDraft(mesh, d, 1);
    expect(f.plates.length).toBe(MAX_PLATES);
    for (let i = 0; i < mesh.n; i++) expect(f.plate[i] >= 0 && f.plate[i] < f.plates.length).toBe(true);
    for (let k = 0; k < f.plates.length; k++) expect(componentsOf(mesh, f.plate, k)).toBe(1);
  });

  it('respects the plate cap when splitting', () => {
    const d = blankDraft(mesh, 5);
    // 31 plates in stripes of longitude, then plate 0 also owns 10 far-apart islands (≥ 20 cells each).
    d.plates = Array.from({ length: 31 }, (_, k) => spec(k + 1, omegaFromDirection(latLonToVec(0, k), 1, 0, 20)));
    d.nextPlateId = 32;
    for (let i = 0; i < mesh.n; i++) d.plate[i] = Math.min(30, Math.floor(((mesh.lon[i] + Math.PI) / (2 * Math.PI)) * 31));
    for (let q = 0; q < 10; q++) {
      const c = latLonToVec(0.8 * Math.sin(q), Math.PI * (0.1 + 0.08 * q));
      for (let i = 0; i < mesh.n; i++) {
        const x = mesh.xyz[3 * i], y = mesh.xyz[3 * i + 1], z = mesh.xyz[3 * i + 2];
        if (x * c[0] + y * c[1] + z * c[2] > Math.cos(0.09)) d.plate[i] = 0;
      }
    }
    const f = finalizeDraft(mesh, d, 3);
    expect(f.plates.length).toBeLessThanOrEqual(MAX_PLATES);
    for (let k = 0; k < f.plates.length; k++) expect(componentsOf(mesh, f.plate, k)).toBe(1);
    expect(new Set(f.plates.map((p) => p.id)).size).toBe(f.plates.length);
  });

  it('is nearly idempotent on generated worlds', () => {
    const g = generateRandomDraft(mesh, { ...DEFAULT_GENERATE_PARAMS, seed: 3 });
    const f = finalizeDraft(mesh, g, 3);
    expect(f.plates.map((p) => p.omega)).toEqual(g.plates.map((p) => p.omega));
    expect(Array.from(f.plate)).toEqual(Array.from(g.plate));
    let same = 0, ocean = 0;
    for (let i = 0; i < mesh.n; i++) {
      if (g.crust[i] === CRUST_CONTINENTAL) {
        expect(f.elev[i]).toBe(g.elev[i]);
        continue;
      }
      ocean++;
      if (Math.abs(f.age[i] - g.age[i]) < 1e-4) same++;
    }
    expect(same / ocean).toBeGreaterThan(0.99);
  });

  it('rejects malformed drafts', () => {
    const d = blankDraft(mesh, 1);
    d.plate[5] = 3;
    expect(() => finalizeDraft(mesh, d, 1)).toThrow(/invalid plate index/);
    expect(() => finalizeDraft(mesh, blankDraft(createSphereMesh(500)), 1)).toThrow(/does not match/);
    const w = blankDraft(mesh, 1);
    w.plates[0].omega = [Number.NaN, 0, 0];
    expect(() => finalizeDraft(mesh, w, 1)).toThrow(/omega/);
  });

  it('never keeps non-finite values and makes plate ids unique', () => {
    const d = capsDraft();
    d.plates[1].id = d.plates[0].id; // duplicated id
    d.orogeny = new Float32Array(mesh.n);
    const keep = new Uint8Array(mesh.n).fill(1);
    for (let i = 0; i < mesh.n; i += 11) {
      d.elev[i] = Number.NaN;
      d.age[i] = Number.NaN;
      d.orogeny[i] = Number.POSITIVE_INFINITY;
    }
    d.crust[22] = CRUST_CONTINENTAL;
    const f = finalizeDraft(mesh, d, 5, keep);
    for (let i = 0; i < mesh.n; i++) {
      expect(Number.isFinite(f.elev[i]) && Number.isFinite(f.age[i]) && Number.isFinite(f.orogeny![i])).toBe(true);
      if (i % 11 !== 0) expect(f.elev[i]).toBe(d.elev[i]); // finite kept cells untouched
    }
    const ids = f.plates.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(f.nextPlateId).toBeGreaterThan(Math.max(...ids));
  });
});

describe('resampleDraft', () => {
  const m40 = createSphereMesh(40000);
  const m100 = createSphereMesh(100000);

  function areas(m: SphereMesh, d: WorldDraft): { plate: Map<number, number>; cont: number } {
    const plate = new Map<number, number>();
    let cont = 0;
    for (let i = 0; i < m.n; i++) {
      const id = d.plates[d.plate[i]].id;
      plate.set(id, (plate.get(id) ?? 0) + 1 / m.n);
      if (d.crust[i] === CRUST_CONTINENTAL) cont += 1 / m.n;
    }
    return { plate, cont };
  }

  it('40k → 100k → 40k preserves plate and crust areas within 2%', () => {
    const d0 = generateRandomDraft(m40, { ...DEFAULT_GENERATE_PARAMS, seed: 12 });
    const d1 = resampleDraft(m40, m100, d0);
    const d2 = resampleDraft(m100, m40, d1);
    const a0 = areas(m40, d0), a1 = areas(m100, d1), a2 = areas(m40, d2);
    expect(d1.plates.map((p) => p.id)).toEqual(d0.plates.map((p) => p.id));
    expect(d2.plates.map((p) => p.id)).toEqual(d0.plates.map((p) => p.id));
    for (const [id, a] of a0.plate) {
      expect(Math.abs(a1.plate.get(id)! - a) / a).toBeLessThan(0.02);
      expect(Math.abs(a2.plate.get(id)! - a) / a).toBeLessThan(0.02);
    }
    expect(Math.abs(a1.cont - a0.cont) / a0.cont).toBeLessThan(0.02);
    expect(Math.abs(a2.cont - a0.cont) / a0.cont).toBeLessThan(0.02);
    for (let k = 0; k < d1.plates.length; k++) expect(componentsOf(m100, d1.plate, k)).toBe(1);
    for (let k = 0; k < d2.plates.length; k++) expect(componentsOf(m40, d2.plate, k)).toBe(1);
  });

  it('interpolates within crust type (no coastal blending) and stays finite', () => {
    const d0 = generateRandomDraft(m40, { ...DEFAULT_GENERATE_PARAMS, seed: 4 });
    const d1 = resampleDraft(m40, m100, d0);
    expect(d1.n).toBe(m100.n);
    expect(d1.orogeny?.length).toBe(m100.n);
    let minCont = Infinity, maxOceanAge = 0;
    for (let i = 0; i < d1.n; i++) {
      expect(Number.isFinite(d1.elev[i]) && Number.isFinite(d1.age[i])).toBe(true);
      if (d1.crust[i] === CRUST_CONTINENTAL) minCont = Math.min(minCont, d1.elev[i]);
      else maxOceanAge = Math.max(maxOceanAge, d1.age[i]);
    }
    expect(minCont).toBeGreaterThan(-400);
    expect(maxOceanAge).toBeLessThanOrEqual(200);
    expect(d1.nextPlateId).toBe(d0.nextPlateId);
    expect(d1.hotspots).toEqual(d0.hotspots);
  });

  it('is an exact copy for the same resolution and leaves the input untouched', () => {
    const d0 = generateRandomDraft(mesh, { ...DEFAULT_GENERATE_PARAMS, seed: 2 });
    const before = cloneDraft(d0);
    const d1 = resampleDraft(mesh, mesh, d0);
    expect(d0).toEqual(before);
    expect(Array.from(d1.elev)).toEqual(Array.from(d0.elev));
    expect(Array.from(d1.plate)).toEqual(Array.from(d0.plate));
    expect(d1.elev).not.toBe(d0.elev);
    expect(() => resampleDraft(m40, mesh, d0)).toThrow(/does not match/);
    const bad = cloneDraft(d0);
    bad.plate[7] = bad.plates.length;
    expect(() => resampleDraft(mesh, m40, bad)).toThrow(/invalid plate index/);
    const short = cloneDraft(d0);
    short.elev = short.elev.subarray(1);
    expect(() => resampleDraft(mesh, m40, short)).toThrow(/length/);
  });

  it('drops plates that vanish at the coarser resolution', () => {
    const d = blankDraft(m100, 1);
    d.plates = [spec(1), spec(2)];
    d.nextPlateId = 3;
    d.plate[500] = 1; // one-cell plate
    d.crust.fill(CRUST_OCEANIC);
    const r = resampleDraft(m100, mesh, d);
    for (let k = 0; k < r.plates.length; k++) expect(componentsOf(mesh, r.plate, k)).toBe(1);
    expect(r.plates.length).toBeLessThanOrEqual(2);
    expect(r.nextPlateId).toBe(3);
  });
});
