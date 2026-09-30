import { describe, expect, it } from 'vitest';
import { DEG } from '../src/core/constants';
import { angleBetween, latLonToVec, vecToLatLon } from '../src/core/math3';
import { nearestCell } from '../src/core/sphereMesh';
import type { Vec3 } from '../src/core/types';
import { dabCells, slerp, StrokeInterpolator } from '../src/editor/stroke';
import { smallMesh } from './helpers/fixtures';

const ll = (latDeg: number, lonDeg: number): Vec3 => latLonToVec(latDeg * DEG, lonDeg * DEG);

describe('slerp', () => {
  it('hits the endpoints, stays on the unit sphere and moves at constant angular speed', () => {
    const a = ll(10, 20), b = ll(-35, 100);
    const theta = angleBetween(a, b);
    expect(angleBetween(slerp(a, b, 0), a)).toBeLessThan(1e-9);
    expect(angleBetween(slerp(a, b, 1), b)).toBeLessThan(1e-9);
    for (let t = 0; t <= 1; t += 0.125) {
      const p = slerp(a, b, t);
      expect(Math.hypot(...p)).toBeCloseTo(1, 12);
      expect(angleBetween(a, p)).toBeCloseTo(t * theta, 9);
    }
  });
});

describe('StrokeInterpolator', () => {
  it('places dabs at most `step` apart along the great circle', () => {
    const step = 2 * DEG;
    const it = new StrokeInterpolator(step, 'uniform');
    const dabs: Vec3[] = [];
    const a = ll(0, 0), b = ll(30, 40);
    it.moveTo(a, dabs);
    it.moveTo(b, dabs);
    expect(dabs.length).toBe(1 + Math.floor(angleBetween(a, b) / step));
    for (let k = 1; k < dabs.length; k++) expect(angleBetween(dabs[k - 1], dabs[k])).toBeCloseTo(step, 9);
    // Every dab lies on the a-b great circle: its normal is perpendicular to the dab.
    const nx = a[1] * b[2] - a[2] * b[1], ny = a[2] * b[0] - a[0] * b[2], nz = a[0] * b[1] - a[1] * b[0];
    for (const d of dabs) expect(Math.abs(d[0] * nx + d[1] * ny + d[2] * nz)).toBeLessThan(1e-9);
  });

  it('carries the remainder so many small moves give the same even spacing', () => {
    const step = 1.5 * DEG;
    const it = new StrokeInterpolator(step, 'uniform');
    const dabs: Vec3[] = [];
    for (let k = 0; k <= 200; k++) it.moveTo(ll(5, k * 0.1), dabs);
    expect(dabs.length).toBeGreaterThan(10);
    for (let k = 1; k < dabs.length; k++) expect(angleBetween(dabs[k - 1], dabs[k])).toBeCloseTo(step, 6);
  });

  it("'cover' mode also dabs at every sample so the brush reaches the cursor", () => {
    const it = new StrokeInterpolator(5 * DEG, 'cover');
    const dabs: Vec3[] = [];
    it.moveTo(ll(0, 0), dabs);
    it.moveTo(ll(0, 1), dabs);
    expect(dabs.length).toBe(2);
    expect(angleBetween(dabs[1], ll(0, 1))).toBeLessThan(1e-12);
  });

  it('crosses the antimeridian the short way', () => {
    const it = new StrokeInterpolator(0.5 * DEG, 'uniform');
    const dabs: Vec3[] = [];
    it.moveTo(ll(10, 179), dabs);
    it.moveTo(ll(10, -179), dabs);
    expect(dabs.length).toBeGreaterThanOrEqual(4);
    expect(dabs.length).toBeLessThanOrEqual(5);
    for (const d of dabs) expect(Math.abs(vecToLatLon(d[0], d[1], d[2]).lon)).toBeGreaterThan(178.9 * DEG);
  });

  it('crosses the pole along the great circle', () => {
    const it = new StrokeInterpolator(1 * DEG, 'uniform');
    const dabs: Vec3[] = [];
    it.moveTo(ll(80, 0), dabs);
    it.moveTo(ll(80, 180), dabs);
    const maxLat = Math.max(...dabs.map((d) => vecToLatLon(d[0], d[1], d[2]).lat));
    expect(maxLat).toBeGreaterThan(89 * DEG);
    expect(dabs.length).toBeGreaterThanOrEqual(20);
  });

  it('breaks the stroke on null picks (no dabs bridging the gap)', () => {
    const it = new StrokeInterpolator(1 * DEG, 'cover');
    const dabs: Vec3[] = [];
    it.moveTo(ll(0, 0), dabs);
    it.moveTo(null, dabs);
    expect(it.drawing).toBe(false);
    it.moveTo(ll(0, 60), dabs);
    expect(dabs.length).toBe(2);
    expect(angleBetween(dabs[1], ll(0, 60))).toBeLessThan(1e-12);
  });

  it('restarts instead of interpolating across a near-antipodal jump', () => {
    const it = new StrokeInterpolator(1 * DEG);
    const dabs: Vec3[] = [];
    it.moveTo(ll(0, 0), dabs);
    it.moveTo(ll(0, 179.5), dabs);
    expect(dabs.length).toBe(2);
  });
});

describe('dabCells', () => {
  const mesh = smallMesh(12000);

  it('always includes the cell nearest to the centre, even for tiny radii', () => {
    for (const [la, lo] of [[0, 0], [89.9, 10], [-45, 179.99], [12.3, -77.7]]) {
      const c = ll(la, lo);
      const cells = dabCells(mesh, c, 1e-7, []);
      expect(cells).toContain(nearestCell(mesh, c[0], c[1], c[2]));
    }
  });

  it('uses at least one mesh spacing as radius and nothing beyond the radius', () => {
    const c = ll(20, 30);
    const tiny = dabCells(mesh, c, 1e-7, []);
    expect(tiny.length).toBeGreaterThanOrEqual(3);
    const r = 6 * DEG;
    const cells = dabCells(mesh, c, r, []);
    for (const i of cells) {
      const p: Vec3 = [mesh.xyz[3 * i], mesh.xyz[3 * i + 1], mesh.xyz[3 * i + 2]];
      expect(angleBetween(p, c)).toBeLessThanOrEqual(r + 1e-9);
    }
    // Area check: expected ≈ cap area / cell area.
    const expected = (2 * Math.PI * (1 - Math.cos(r))) / mesh.cellArea;
    expect(cells.length / expected).toBeGreaterThan(0.85);
    expect(cells.length / expected).toBeLessThan(1.15);
  });
});
