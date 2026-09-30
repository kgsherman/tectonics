import { describe, expect, it } from 'vitest';
import { buildMeshGridMap, gridLat, gridLon, gridToMesh, latToRow, lonToCol, meshToGrid, resampleGrid, sampleGrid } from '../src/core/grid';
import {
  angleBetween, cross3, dot3, latLonToVec, length3, omegaFromDirection, quatFromAxisAngle, quatMul, quatRotate,
  quatToMat3, mat3MulVec, mat3TMulVec, tangentBasis, vecToLatLon, velocityAt,
} from '../src/core/math3';
import { createNoise3, fbm3, ridged3 } from '../src/core/noise';
import { Rng, hashString } from '../src/core/rng';
import { cellsWithinRadius, createSphereMesh, nearestCell, neighborsOf } from '../src/core/sphereMesh';
import { EARTH_RADIUS_KM } from '../src/core/constants';
import type { Vec3 } from '../src/core/types';

describe('math3', () => {
  it('lat/lon round trip', () => {
    for (const [la, lo] of [[0, 0], [0.5, 1], [-1.2, -3], [1.5, 2.9]]) {
      const v = latLonToVec(la, lo);
      const r = vecToLatLon(v[0], v[1], v[2]);
      expect(r.lat).toBeCloseTo(la, 10);
      expect(r.lon).toBeCloseTo(lo, 10);
    }
  });
  it('quaternion composition matches sequential rotation and matrix form', () => {
    const q1 = quatFromAxisAngle([0, 0, 1], 0.7);
    const q2 = quatFromAxisAngle([1, 0, 0], -0.3);
    const v: Vec3 = [0.3, -0.4, 0.866];
    const seq = quatRotate(q2, quatRotate(q1, v));
    const comb = quatRotate(quatMul(q2, q1), v);
    for (let k = 0; k < 3; k++) expect(comb[k]).toBeCloseTo(seq[k], 12);
    const m = quatToMat3(q1);
    const o = [0, 0, 0];
    mat3MulVec(m, v[0], v[1], v[2], o);
    const back = [0, 0, 0];
    mat3TMulVec(m, o[0], o[1], o[2], back);
    for (let k = 0; k < 3; k++) expect(back[k]).toBeCloseTo(v[k], 12);
  });
  it('omegaFromDirection yields the requested surface velocity', () => {
    const p = latLonToVec(0.4, -1.1);
    const w = omegaFromDirection(p, 1, 1, 50);
    const v = velocityAt(w, p);
    expect(length3(v) * EARTH_RADIUS_KM).toBeCloseTo(50, 6);
    const { east, north } = tangentBasis(p);
    expect(dot3(v, east)).toBeGreaterThan(0);
    expect(dot3(v, east)).toBeCloseTo(dot3(v, north), 10);
    expect(dot3(w, p)).toBeCloseTo(0, 12);
  });
  it('tangentBasis is orthonormal and never NaN at poles', () => {
    for (const p of [[0, 0, 1], [0, 0, -1], latLonToVec(0.2, 0.3)] as Vec3[]) {
      const { east, north } = tangentBasis(p);
      expect(length3(east)).toBeCloseTo(1, 10);
      expect(length3(north)).toBeCloseTo(1, 10);
      expect(dot3(east, north)).toBeCloseTo(0, 10);
      expect(dot3(east, p)).toBeCloseTo(0, 10);
      expect(Number.isNaN(east[0] + north[0])).toBe(false);
    }
    const c = cross3([1, 0, 0], [0, 1, 0]);
    expect(c).toEqual([0, 0, 1]);
    expect(angleBetween([1, 0, 0], [0, 1, 0])).toBeCloseTo(Math.PI / 2, 12);
  });
});

describe('rng & noise', () => {
  it('is deterministic and in range', () => {
    const a = new Rng(42), b = new Rng(42), c = new Rng(43);
    const sa = Array.from({ length: 5 }, () => a.next());
    const sb = Array.from({ length: 5 }, () => b.next());
    const sc = Array.from({ length: 5 }, () => c.next());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    const r = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      const k = r.int(3, 9);
      expect(k).toBeGreaterThanOrEqual(3);
      expect(k).toBeLessThan(9);
    }
    const f1 = new Rng(5).fork(1).next();
    const f2 = new Rng(5).fork(1).next();
    const f3 = new Rng(5).fork(2).next();
    expect(f1).toBe(f2);
    expect(f1).not.toBe(f3);
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });
  it('noise is seeded, bounded, and varied', () => {
    const n1 = createNoise3(1), n2 = createNoise3(1), n3 = createNoise3(2);
    let min = Infinity, max = -Infinity, diff = 0;
    const r = new Rng(3);
    for (let i = 0; i < 20000; i++) {
      const x = r.float(-10, 10), y = r.float(-10, 10), z = r.float(-10, 10);
      const v = n1(x, y, z);
      expect(v).toBe(n2(x, y, z));
      diff += Math.abs(v - n3(x, y, z));
      min = Math.min(min, v);
      max = Math.max(max, v);
      const f = fbm3(n1, x, y, z, 5);
      expect(Math.abs(f)).toBeLessThanOrEqual(1.05);
      const rg = ridged3(n1, x, y, z, 5);
      expect(rg).toBeGreaterThanOrEqual(0);
      expect(rg).toBeLessThanOrEqual(1.0001);
    }
    expect(min).toBeLessThan(-0.7);
    expect(max).toBeGreaterThan(0.7);
    expect(max).toBeLessThanOrEqual(1.01);
    expect(diff / 20000).toBeGreaterThan(0.1);
  });
});

describe('sphereMesh', () => {
  const mesh = createSphereMesh(20000);
  it('has a valid closed spherical Delaunay triangulation', () => {
    const nt = mesh.triangles.length / 3;
    expect(nt).toBe(2 * mesh.n - 4);
    // Orientation: all CCW from outside.
    const { xyz, triangles } = mesh;
    for (let t = 0; t < nt; t++) {
      const a = triangles[3 * t], b = triangles[3 * t + 1], c = triangles[3 * t + 2];
      const det =
        xyz[3 * a] * (xyz[3 * b + 1] * xyz[3 * c + 2] - xyz[3 * b + 2] * xyz[3 * c + 1]) +
        xyz[3 * a + 1] * (xyz[3 * b + 2] * xyz[3 * c] - xyz[3 * b] * xyz[3 * c + 2]) +
        xyz[3 * a + 2] * (xyz[3 * b] * xyz[3 * c + 1] - xyz[3 * b + 1] * xyz[3 * c]);
      expect(det).toBeGreaterThan(0);
    }
    // Adjacency symmetric, degree >= 3, no self loops / duplicates.
    for (let i = 0; i < mesh.n; i++) {
      const nb = neighborsOf(mesh, i);
      expect(nb.length).toBeGreaterThanOrEqual(3);
      expect(new Set(nb).size).toBe(nb.length);
      for (const j of nb) {
        expect(j).not.toBe(i);
        expect(Array.from(neighborsOf(mesh, j))).toContain(i);
      }
    }
    expect(mesh.spacing).toBeGreaterThan(0.9 * Math.sqrt((4 * Math.PI) / mesh.n));
    expect(mesh.spacing).toBeLessThan(1.2 * Math.sqrt((4 * Math.PI) / mesh.n));
  });

  it('nearestCell is exact (with and without hints)', () => {
    const rng = new Rng(11);
    const { xyz, n } = mesh;
    for (let q = 0; q < 3000; q++) {
      const [x, y, z] = rng.unitVector();
      let best = -1, bd = -2;
      for (let i = 0; i < n; i++) {
        const d = xyz[3 * i] * x + xyz[3 * i + 1] * y + xyz[3 * i + 2] * z;
        if (d > bd) {
          bd = d;
          best = i;
        }
      }
      const got = nearestCell(mesh, x, y, z);
      const gotD = xyz[3 * got] * x + xyz[3 * got + 1] * y + xyz[3 * got + 2] * z;
      expect(gotD).toBeCloseTo(bd, 12);
      const hinted = nearestCell(mesh, x * 3, y * 3, z * 3, rng.int(0, n));
      const hd = xyz[3 * hinted] * x + xyz[3 * hinted + 1] * y + xyz[3 * hinted + 2] * z;
      expect(hd).toBeCloseTo(bd, 12);
      void best;
    }
  });

  it('cellsWithinRadius matches brute force', () => {
    const rng = new Rng(5);
    for (let q = 0; q < 30; q++) {
      const c = rng.unitVector();
      const r = rng.float(0.005, 0.4);
      const got = new Set(cellsWithinRadius(mesh, c, r));
      const cosR = Math.cos(r);
      let expected = 0;
      for (let i = 0; i < mesh.n; i++) {
        const d = mesh.xyz[3 * i] * c[0] + mesh.xyz[3 * i + 1] * c[1] + mesh.xyz[3 * i + 2] * c[2];
        if (d >= cosR) {
          expected++;
          expect(got.has(i)).toBe(true);
        }
      }
      expect(got.size).toBe(expected);
    }
  });

  it('builds 100k cells fast enough', () => {
    const t0 = performance.now();
    const big = createSphereMesh(100_000);
    const ms = performance.now() - t0;
    expect(big.triangles.length / 3).toBe(2 * big.n - 4);
    expect(ms).toBeLessThan(2500);
  });
});

describe('grid', () => {
  const mesh = createSphereMesh(8000);
  it('row/col conversions are inverse', () => {
    expect(latToRow(180, gridLat(180, 17))).toBeCloseTo(17, 10);
    expect(lonToCol(360, gridLon(360, 359))).toBeCloseTo(359, 10);
    expect(lonToCol(360, gridLon(360, 0))).toBeCloseTo(0, 10);
  });
  it('mesh->grid interpolation reproduces smooth fields', () => {
    const map = buildMeshGridMap(mesh, 180, 90);
    for (let p = 0; p < 180 * 90; p++) {
      const s = map.bary[3 * p] + map.bary[3 * p + 1] + map.bary[3 * p + 2];
      expect(s).toBeCloseTo(1, 5);
    }
    const fx = new Float32Array(mesh.n);
    for (let i = 0; i < mesh.n; i++) fx[i] = mesh.xyz[3 * i] + 2 * mesh.xyz[3 * i + 2];
    const g = meshToGrid(map, fx);
    let maxErr = 0;
    for (let r = 0; r < 90; r++) {
      for (let c = 0; c < 180; c++) {
        const v = latLonToVec(gridLat(90, r), gridLon(180, c));
        maxErr = Math.max(maxErr, Math.abs(g[r * 180 + c] - (v[0] + 2 * v[2])));
      }
    }
    expect(maxErr).toBeLessThan(0.01);
    // grid -> mesh round trip
    const back = gridToMesh(mesh, g, 180, 90);
    let maxErr2 = 0;
    for (let i = 0; i < mesh.n; i++) maxErr2 = Math.max(maxErr2, Math.abs(back[i] - fx[i]));
    expect(maxErr2).toBeLessThan(0.05);
  });
  it('sampleGrid wraps in longitude and resampleGrid preserves means', () => {
    const w = 8, h = 4;
    const f = new Float32Array(w * h);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) f[r * w + c] = c;
    const east = sampleGrid(f, w, h, gridLat(h, 1), Math.PI - 1e-9);
    expect(east).toBeGreaterThan(3); // between col 7 (7) and col 0 (0)
    const g = new Float32Array(64 * 32).map((_, i) => Math.sin(i * 0.37));
    const down = resampleGrid(g, 64, 32, 16, 8);
    const meanA = g.reduce((a, b) => a + b, 0) / g.length;
    const meanB = down.reduce((a, b) => a + b, 0) / down.length;
    expect(meanB).toBeCloseTo(meanA, 4);
    const up = resampleGrid(g, 64, 32, 128, 64);
    expect(up.length).toBe(128 * 64);
  });
});
