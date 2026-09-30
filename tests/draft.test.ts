import { describe, expect, it } from 'vitest';
import { latLonToVec, omegaFromDirection } from '../src/core/math3';
import { createSphereMesh } from '../src/core/sphereMesh';
import { Rng } from '../src/core/rng';
import {
  blankDraft, classifyBoundaries, cloneDraft, compactDraft, computePlateInfos, oceanDepthForAge, plateColor, plateName,
  snapshotFromDraft, voronoiPlates,
} from '../src/tectonics/draft';
import { BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT, BOUNDARY_NONE, type PlateSpec } from '../src/core/types';

const mesh = createSphereMesh(12000);

describe('draft helpers', () => {
  it('ocean depth is monotonic and continuous', () => {
    expect(oceanDepthForAge(0)).toBeCloseTo(-2600, 0);
    let prev = 0;
    for (let a = 0; a <= 200; a += 0.5) {
      const d = oceanDepthForAge(a);
      expect(d).toBeLessThanOrEqual(prev + 1e-9);
      prev = d;
    }
    expect(Math.abs(oceanDepthForAge(19.999) - oceanDepthForAge(20.001))).toBeLessThan(5);
    expect(oceanDepthForAge(200)).toBeGreaterThan(-5700);
  });

  it('colors and names are deterministic and distinct', () => {
    const cs = new Set(Array.from({ length: 40 }, (_, k) => plateColor(k).join(',')));
    expect(cs.size).toBe(40);
    expect(plateName(3, 9)).toBe(plateName(3, 9));
    expect(plateName(3, 9)).toMatch(/Plate$/);
  });

  it('voronoiPlates produces connected regions covering the sphere', () => {
    const rng = new Rng(3);
    const seeds = Array.from({ length: 10 }, () => rng.unitVector());
    const lab = voronoiPlates(mesh, seeds, 0.7, 5);
    const counts = new Array(10).fill(0);
    for (let i = 0; i < mesh.n; i++) {
      expect(lab[i]).toBeGreaterThanOrEqual(0);
      expect(lab[i]).toBeLessThan(10);
      counts[lab[i]]++;
    }
    expect(counts.filter((c) => c > 0).length).toBeGreaterThanOrEqual(9);
    // connectivity: BFS per label reaches all its cells
    for (let k = 0; k < 10; k++) {
      if (counts[k] === 0) continue;
      const start = lab.indexOf(k);
      const seen = new Uint8Array(mesh.n);
      const q = [start];
      seen[start] = 1;
      let reached = 0;
      while (q.length) {
        const i = q.pop()!;
        reached++;
        for (let a = mesh.adjOffset[i]; a < mesh.adjOffset[i + 1]; a++) {
          const j = mesh.adj[a];
          if (!seen[j] && lab[j] === k) {
            seen[j] = 1;
            q.push(j);
          }
        }
      }
      expect(reached).toBe(counts[k]);
    }
  });

  it('classifies convergent and divergent boundaries', () => {
    // Plate 0 = western hemisphere (lon < 0), plate 1 = eastern. Boundary at lon 0 and lon 180.
    const plate = new Int16Array(mesh.n);
    for (let i = 0; i < mesh.n; i++) plate[i] = mesh.lon[i] < 0 ? 0 : 1;
    const p0 = latLonToVec(0, -Math.PI / 2);
    const p1 = latLonToVec(0, Math.PI / 2);
    // Both move east: at lon 0 plate 0 (west) moves east toward plate 1 which moves east equally => transform-ish/none.
    // Make plate 0 move east (toward lon 0 boundary) and plate 1 move west (toward it): convergent at lon 0.
    const plates: PlateSpec[] = [
      { id: 1, name: 'a', color: [1, 2, 3], omega: omegaFromDirection(p0, 1, 0, 50) },
      { id: 2, name: 'b', color: [1, 2, 3], omega: omegaFromDirection(p1, -1, 0, 50) },
    ];
    const b = classifyBoundaries(mesh, plate, plates);
    let conv0 = 0, div0 = 0;
    for (let i = 0; i < mesh.n; i++) {
      if (Math.abs(mesh.lat[i]) > 0.5) continue;
      if (Math.abs(mesh.lon[i]) < 0.05) {
        if (b[i] === BOUNDARY_CONVERGENT) conv0++;
        if (b[i] === BOUNDARY_DIVERGENT) div0++;
      }
      if (Math.abs(mesh.lon[i]) > 0.3 && Math.abs(mesh.lon[i]) < 2.8) expect(b[i]).toBe(BOUNDARY_NONE);
    }
    expect(conv0).toBeGreaterThan(10);
    expect(div0).toBe(0);
    const infos = computePlateInfos(mesh, plate, new Uint8Array(mesh.n), plates);
    expect(infos[0].area).toBeCloseTo(0.5, 1);
    expect(infos[0].speed).toBeGreaterThan(20);
  });

  it('snapshot/blank/clone/compact behave', () => {
    const d = blankDraft(mesh, 4);
    expect(d.plates.length).toBe(1);
    const s = snapshotFromDraft(mesh, d);
    expect(s.plates[0].area).toBeCloseTo(1, 5);
    const c = cloneDraft(d);
    c.elev[0] = 123;
    expect(d.elev[0]).not.toBe(123);
    c.plates.push({ id: 9, name: 'x', color: [0, 0, 0], omega: [0, 0, 0] });
    c.plates.push({ id: 10, name: 'y', color: [0, 0, 0], omega: [0, 0, 0] });
    for (let i = 0; i < 100; i++) c.plate[i] = 2;
    const k = compactDraft(c);
    expect(k.plates.map((p) => p.id)).toEqual([1, 10]);
    expect(k.plate[0]).toBe(1);
    expect(k.plate[500]).toBe(0);
  });
});
