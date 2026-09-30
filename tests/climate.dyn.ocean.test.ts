import { describe, expect, it } from 'vitest';
import { makeGrid } from '../src/climate/dynGrid';
import { computeOcean, curlRhs, makeOceanContext } from '../src/climate/ocean';
import { makeStommelWork, solveStommel } from '../src/climate/oceanSolver';
import { buildStommelSetup } from '../src/climate/oceanStommel';
import { oceanTuning } from '../src/climate/tuning';

const DEG = Math.PI / 180;

/** A 180°-wide basin (walls at lon ±90°) plus a separate island in the southern ocean band. */
function basinLand(g: ReturnType<typeof makeGrid>, island: boolean): Uint8Array {
  const land = new Uint8Array(g.n);
  for (let j = 0; j < g.ny; j++) {
    for (let c = 0; c < g.nx; c++) {
      const lat = g.lat[j] / DEG;
      const lon = g.lon[c] / DEG;
      if (Math.abs(lon) > 90 && lat > -40) land[j * g.nx + c] = 1;
      if (island && lat < -52 && lat > -60 && Math.abs(lon) < 12) land[j * g.nx + c] = 1;
    }
  }
  return land;
}

/** Idealized zonal winds: easterly trades, westerlies, polar easterlies (m/s), all months. */
function zonalWinds(g: ReturnType<typeof makeGrid>): { U: Float64Array; V: Float64Array } {
  const U = new Float64Array(12 * g.n);
  const V = new Float64Array(12 * g.n);
  for (let m = 0; m < 12; m++) {
    for (let j = 0; j < g.ny; j++) {
      const a = Math.abs(g.lat[j] / DEG);
      const u = a < 30 ? -6 * Math.cos(3 * g.lat[j]) : a < 60 ? 8 * Math.sin(((a - 30) / 30) * Math.PI) : -3 * Math.sin(((a - 60) / 30) * Math.PI);
      for (let c = 0; c < g.nx; c++) U[m * g.n + j * g.nx + c] = u;
    }
  }
  return { U, V };
}

describe('Stommel ocean', () => {
  const g = makeGrid(180, 90);

  it('builds subtropical gyres with western intensification', () => {
    const land = basinLand(g, false);
    const lf = Float64Array.from(land);
    const ctx = makeOceanContext(g, lf, land, false);
    const { U, V } = zonalWinds(g);
    const res = computeOcean(ctx, U, V, null);
    const n = g.n;
    // Row at ~30°N: northward flow along the western boundary, weak southward flow in the interior.
    const j = Math.floor((90 - 29) / 2);
    const westCol = Math.floor((-88 + 180) / 2);
    const midCol = Math.floor((20 + 180) / 2);
    let vWest = 0, vMid = 0;
    for (let m = 0; m < 12; m++) {
      vWest += res.currentV[m * n + j * g.nx + westCol] / 12;
      vMid += res.currentV[m * n + j * g.nx + midCol] / 12;
    }
    expect(vWest).toBeGreaterThan(0.1);
    expect(vMid).toBeLessThan(0);
    expect(Math.abs(vWest)).toBeGreaterThan(5 * Math.abs(vMid));
    // Southern hemisphere mirror: southward western boundary current.
    const js = Math.floor((90 + 29) / 2);
    let vWestS = 0;
    for (let m = 0; m < 12; m++) vWestS += res.currentV[m * n + js * g.nx + westCol] / 12;
    expect(vWestS).toBeLessThan(-0.1);
    for (let i = 0; i < 12 * n; i++) {
      expect(Number.isFinite(res.currentU[i]) && Number.isFinite(res.currentV[i])).toBe(true);
      expect(Math.hypot(res.currentU[i], res.currentV[i])).toBeLessThanOrEqual(oceanTuning.maxCurrent + 1e-9);
      if (land[i % n]) expect(res.currentU[i]).toBe(0);
    }
  });

  it('retrograde rotation intensifies the eastern boundary (mirror symmetry)', () => {
    const land = basinLand(g, false);
    const lf = Float64Array.from(land);
    const { U, V } = zonalWinds(g);
    const pro = computeOcean(makeOceanContext(g, lf, land, false), U, V, null);
    const retro = computeOcean(makeOceanContext(g, lf, land, true), U, V, null);
    // With zonal stress τ_x(φ) the curl is unchanged by λ → −λ, and so is the equation once f → −f:
    // the retrograde streamfunction is the mirror image of the prograde one.
    let maxErr = 0;
    let maxPsi = 0;
    for (let jj = 0; jj < g.ny; jj++) {
      for (let c = 0; c < g.nx; c++) {
        const i = jj * g.nx + c;
        const mirror = jj * g.nx + (g.nx - 1 - c);
        // The basin is symmetric about lon 0 so the mirrored cell is also inside it.
        maxErr = Math.max(maxErr, Math.abs(pro.psi[i] - retro.psi[mirror]));
        maxPsi = Math.max(maxPsi, Math.abs(pro.psi[i]));
      }
    }
    expect(maxPsi).toBeGreaterThan(1e6);
    expect(maxErr / maxPsi).toBeLessThan(0.03);
    // Boundary current now on the eastern side (mirror image: v flips sign) near 30°N.
    const j = Math.floor((90 - 29) / 2);
    const eastCol = Math.floor((88 + 180) / 2);
    let vEast = 0;
    for (let m = 0; m < 12; m++) vEast += retro.currentV[m * g.n + j * g.nx + eastCol] / 12;
    expect(vEast).toBeLessThan(-0.1);
  });

  it('solves island levels from the circulation condition and converges', () => {
    const land = basinLand(g, true);
    const setup = buildStommelSetup(g, land, false);
    expect(setup.nIslands).toBeGreaterThanOrEqual(1);
    const tx = new Float64Array(g.n);
    const ty = new Float64Array(g.n);
    for (let j = 0; j < g.ny; j++) for (let c = 0; c < g.nx; c++) tx[j * g.nx + c] = 0.1 * Math.sin(2 * g.lat[j]) ** 2;
    const rhs = new Float64Array(g.n);
    curlRhs(g, tx, ty, rhs);
    const psi = new Float64Array(g.n);
    const res = solveStommel(setup, rhs, psi, 400, 1e-4, makeStommelWork(setup));
    expect(res.maxDu).toBeLessThan(1e-4);
    // Island cells share one level; the main component (walls) is Ψ = 0.
    const k = 0;
    const v0 = psi[setup.islCells[setup.islCellOff[k]]];
    for (let q = setup.islCellOff[k]; q < setup.islCellOff[k + 1]; q++) expect(psi[setup.islCells[q]]).toBe(v0);
    for (let i = 0; i < g.n; i++) if (setup.comp[i] === 0) expect(psi[i]).toBe(0);
    // Warm restart from the solution stops at once.
    const again = solveStommel(setup, rhs, psi, 400, 1e-3, makeStommelWork(setup));
    expect(again.sweeps).toBeLessThanOrEqual(16);
  });
});
