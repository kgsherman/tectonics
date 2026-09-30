import { describe, expect, it } from 'vitest';
import { applyStencil, buildStencil } from '../src/climate/dynAdvect';
import { makeBilinearStencil, makeGrid, makeOverlapRegrid, overlapAverage, applyBilinear, globalMean } from '../src/climate/dynGrid';
import { dailyInsolation, declinationAt, insolationTable } from '../src/climate/insolation';
import { makeCyclicWork, nearestValidIndex, smoothField, solveCyclic, solveTridiag } from '../src/climate/numerics';

function denseSolve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    [M[k], M[p]] = [M[p], M[k]];
    for (let i = k + 1; i < n; i++) {
      const f = M[i][k] / M[k][k];
      for (let j = k; j <= n; j++) M[i][j] -= f * M[k][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

describe('tridiagonal solvers', () => {
  it('Thomas matches a dense solve', () => {
    const n = 9;
    const a = Float64Array.from({ length: n }, (_, i) => -1 - 0.1 * i);
    const c = Float64Array.from({ length: n }, (_, i) => -0.5 + 0.05 * i);
    const b = Float64Array.from({ length: n }, (_, i) => 4 + Math.sin(i));
    const d = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 1.3));
    const x = new Float64Array(n);
    solveTridiag(a, b, c, d, x, n, new Float64Array(n));
    const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (j === i ? b[i] : j === i - 1 ? a[i] : j === i + 1 ? c[i] : 0)));
    const ref = denseSolve(A, Array.from(d));
    for (let i = 0; i < n; i++) expect(x[i]).toBeCloseTo(ref[i], 10);
  });

  it('periodic (Sherman–Morrison) solve matches a dense solve', () => {
    const n = 12;
    const a = Float64Array.from({ length: n }, (_, i) => -1.2 + 0.03 * i);
    const c = Float64Array.from({ length: n }, (_, i) => -0.8 - 0.02 * i);
    const b = Float64Array.from({ length: n }, (_, i) => 3.5 + 0.2 * Math.cos(i));
    const d = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + 0.3);
    const x = new Float64Array(n);
    solveCyclic(a, b, c, d, x, n, makeCyclicWork(n));
    const A = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      A[i][i] = b[i];
      A[i][(i + n - 1) % n] += a[i];
      A[i][(i + 1) % n] += c[i];
    }
    const ref = denseSolve(A, Array.from(d));
    for (let i = 0; i < n; i++) expect(x[i]).toBeCloseTo(ref[i], 10);
  });
});

describe('grid operators', () => {
  it('smoothing keeps constants and (approximately) the global mean', () => {
    const g = makeGrid(90, 45);
    const f = new Float64Array(g.n).fill(3.25);
    smoothField(g, f, 800, 3);
    for (let i = 0; i < g.n; i++) expect(f[i]).toBeCloseTo(3.25, 12);
    const h = new Float64Array(g.n);
    for (let i = 0; i < g.n; i++) h[i] = Math.sin(i * 0.37) * 10;
    const before = globalMean(g, h);
    smoothField(g, h, 600, 3);
    expect(Math.abs(globalMean(g, h) - before)).toBeLessThan(0.3);
  });

  it('overlap regrid is exact for nested grids and conserves constants', () => {
    const R = makeOverlapRegrid(8, 4, 4, 2);
    const src = new Float64Array(32).fill(7);
    const out = overlapAverage(R, src, null, new Float64Array(8));
    for (const v of out) expect(v).toBeCloseTo(7, 12);
    const B = makeBilinearStencil(4, 2, 16, 8);
    const up = new Float32Array(128);
    applyBilinear(B, new Float64Array(8).fill(-2), 0, up, 0);
    for (const v of up) expect(v).toBeCloseTo(-2, 6);
  });

  it('nearest-valid index finds the closest valid cell across the date line', () => {
    const w = 36, h = 18;
    const valid = new Uint8Array(w * h);
    valid[9 * w + 0] = 1; // just east of −180°
    valid[2 * w + 18] = 1;
    const near = nearestValidIndex(w, h, valid);
    expect(near[9 * w + 35]).toBe(9 * w + 0); // wraps across the antimeridian
    expect(near[3 * w + 18]).toBe(2 * w + 18);
    expect(near[9 * w + 0]).toBe(9 * w + 0);
    expect(nearestValidIndex(w, h, new Uint8Array(w * h))[5]).toBe(-1);
  });

  it('semi-Lagrangian stencil advects a zonal field in 3D without NaN at the poles', () => {
    const g = makeGrid(72, 36);
    const u = new Float64Array(g.n).fill(20);
    const v = new Float64Array(g.n).fill(5);
    const st = buildStencil(g, u, v, 0, 1, 86400, 1, 24);
    expect(st.nSub).toBeGreaterThan(1);
    const f = new Float64Array(g.n);
    for (let j = 0; j < g.ny; j++) for (let c = 0; c < g.nx; c++) f[j * g.nx + c] = Math.cos(g.lon[c]);
    const out = new Float64Array(g.n);
    applyStencil(st, f, out);
    for (const x of out) expect(Number.isFinite(x)).toBe(true);
    // Weights are convex: no new extrema.
    for (const x of out) expect(Math.abs(x)).toBeLessThanOrEqual(1 + 1e-6);
    // Eastward wind: the value at a cell comes from the west (phase shift eastward).
    const j = 18;
    const c = 20;
    expect(out[j * g.nx + c]).not.toBeCloseTo(f[j * g.nx + c], 3);
  });
});

describe('insolation', () => {
  it('global mean is S/4 and the annual equatorial mean is ~417 W/m²', () => {
    const g = makeGrid(36, 90);
    const tab = insolationTable(g, 72, 23.44, 1);
    let glob = 0;
    const eq = 44;
    let eqMean = 0;
    for (let k = 0; k < 72; k++) {
      for (let j = 0; j < g.ny; j++) glob += (tab[k * g.ny + j] * g.rowWeight[j] * g.nx) / 72;
      eqMean += tab[k * g.ny + eq] / 72;
    }
    expect(glob).toBeCloseTo(1361 / 4, 0);
    expect(eqMean).toBeGreaterThan(405);
    expect(eqMean).toBeLessThan(425);
  });

  it('handles polar night/day and any tilt', () => {
    expect(dailyInsolation(1361, 1, 0, Math.sin(-0.4), Math.cos(-0.4))).toBe(0);
    const polarDay = dailyInsolation(1361, Math.sin(1.5), Math.cos(1.5), Math.sin(0.4), Math.cos(0.4));
    expect(polarDay).toBeGreaterThan(500);
    for (const tilt of [0, 45, 90]) {
      const g = makeGrid(8, 30);
      const tab = insolationTable(g, 72, tilt, 1);
      for (const q of tab) {
        expect(Number.isFinite(q)).toBe(true);
        expect(q).toBeGreaterThanOrEqual(0);
      }
    }
    expect(declinationAt(0.5, 0)).toBe(0);
    // NH summer solstice near late June.
    expect(declinationAt(172 / 365.24, (23.44 * Math.PI) / 180)).toBeGreaterThan(0.4);
  });
});
