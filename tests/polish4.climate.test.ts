/**
 * Polish 4, climate: large polar supercontinents glaciate and stay cold (EF/ET poleward of ~75°,
 * a tundra / taiga fringe) instead of baking in the polar summer, while a mid-latitude continent
 * keeps its hot summers; the ice-sheet core of a cold start survives the uncoupled pass 1; a melting
 * glacier keeps its snow albedo while its seasonal snow lasts; the snow-surface inversion weakens in
 * extremely cold air masses; fast mode reaches the same glacier state as full mode.
 */
import { describe, expect, it } from 'vitest';
import type { ClimateInput, ClimateResult } from '../src/core/types';
import { computeClimate, DEFAULT_CLIMATE_PARAMS, type ClimateResultWithHydro } from '../src/climate/climate';
import { makeGrid } from '../src/climate/dynGrid';
import { makeEbmModel, makeState } from '../src/climate/energy';
import { applyIceFlow } from '../src/climate/energyIce';
import { KOPPEN_CLASSES } from '../src/climate/koppen';
import { applySurfaceInversion } from '../src/climate/surfaceInversion';
import { ebmTuning } from '../src/climate/tuning';

const W = 180;
const H = 90;
const N = W * H;
const latOf = (r: number): number => 90 - ((r + 0.5) * 180) / H;
const lonOf = (c: number): number => -180 + ((c + 0.5) * 360) / W;

function world(f: (lat: number, lon: number) => number, id: number): ClimateInput {
  const elev = new Float32Array(N);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) elev[r * W + c] = f(latOf(r), lonOf(c));
  return { w: W, h: H, elev, landFraction: Float32Array.from(elev, (e) => (e > 0 ? 1 : 0)), sourceId: id, time: 0 };
}

/** Area-weighted land statistics of a latitude band [lat0, lat1). */
function band(c: ClimateResult, lat0: number, lat1: number, lon0 = -180, lon1 = 180) {
  const ice = (c as ClimateResultWithHydro).landIce!;
  let area = 0, warm = 0, cold = 0, e = 0, ef = 0, gl = 0, d = 0;
  for (let r = 0; r < H; r++) {
    const lat = latOf(r);
    if (lat < lat0 || lat >= lat1) continue;
    const wr = Math.cos((lat * Math.PI) / 180);
    for (let col = 0; col < W; col++) {
      const lon = lonOf(col);
      const i = r * W + col;
      if (!c.land[i] || lon < lon0 || lon > lon1) continue;
      let mx = -Infinity, mn = Infinity;
      for (let m = 0; m < 12; m++) {
        mx = Math.max(mx, c.temp[m * N + i]);
        mn = Math.min(mn, c.temp[m * N + i]);
      }
      area += wr;
      warm += wr * mx;
      cold += wr * mn;
      gl += wr * ice[i];
      const code = KOPPEN_CLASSES[c.koppen[i]].code;
      if (code[0] === 'E') e += wr;
      if (code === 'EF') ef += wr;
      if (code[0] === 'D') d += wr;
    }
  }
  return { warm: warm / area, cold: cold / area, E: e / area, EF: ef / area, D: d / area, glacier: gl / area };
}

// A Pangaea-like supercontinent over the South Pole (land poleward of 52°S, 600 m at its rim rising
// to 1200 m) and a small northern mid-latitude continent: the QA case (Pangaea at the pole), which
// before had +17 °C polar summers, no ice and D climates to the pole.
const polar = world((lat, lon) => (lat < -52 ? 600 + 600 * Math.min(1, (-52 - lat) / 30) : lat > 30 && lat < 60 && lon > -40 && lon < 60 ? 300 : -4000), 41);

describe('large polar supercontinent', () => {
  const full = computeClimate(polar, { ...DEFAULT_CLIMATE_PARAMS, gridW: W, gridH: H });

  it('carries an ice sheet with polar-desert summers near the pole', () => {
    const pole = band(full, -90, -80);
    const inner = band(full, -80, -75);
    console.log(`polar supercontinent: 80–90°S warmest month ${pole.warm.toFixed(1)} °C, coldest ${pole.cold.toFixed(1)} °C, glacier ${(100 * pole.glacier).toFixed(0)} %; 75–80°S warmest ${inner.warm.toFixed(1)} °C, E ${(100 * inner.E).toFixed(0)} %`);
    expect(pole.glacier).toBeGreaterThan(0.95);
    expect(pole.EF).toBeGreaterThan(0.95);
    expect(pole.warm).toBeLessThan(-5);
    expect(inner.E).toBeGreaterThan(0.95);
    expect(inner.warm).toBeLessThan(0);
    // Extremely cold, but within the bounds of the Antarctic plateau's monthly means.
    expect(pole.cold).toBeGreaterThan(-95);
  });

  it('has a tundra / taiga fringe and a hot-summer mid-latitude interior', () => {
    const fringe = band(full, -70, -60);
    const rim = band(full, -60, -52);
    const north = band(full, 40, 55, -30, 50);
    console.log(`fringe 60–70°S warmest ${fringe.warm.toFixed(1)} °C (E ${(100 * fringe.E).toFixed(0)} %, glacier ${(100 * fringe.glacier).toFixed(0)} %); rim 52–60°S warmest ${rim.warm.toFixed(1)} °C; northern continent warmest ${north.warm.toFixed(1)} °C`);
    expect(fringe.glacier).toBeLessThan(0.3);
    expect(fringe.warm).toBeGreaterThan(0);
    expect(fringe.warm).toBeLessThan(12);
    expect(rim.warm).toBeGreaterThan(fringe.warm);
    expect(rim.E + rim.D).toBeGreaterThan(0.95);
    expect(north.warm).toBeGreaterThan(20);
  });

  it('glaciates in fast mode too, on a 3° core grid', () => {
    const fast = computeClimate(polar, { ...DEFAULT_CLIMATE_PARAMS, gridW: W, gridH: H, fast: true });
    const pole = band(fast, -90, -75);
    console.log(`fast: 75–90°S warmest ${pole.warm.toFixed(1)} °C, glacier ${(100 * pole.glacier).toFixed(0)} %, E ${(100 * pole.E).toFixed(0)} %`);
    expect(pole.glacier).toBeGreaterThan(0.95);
    expect(pole.E).toBeGreaterThan(0.95);
    expect(pole.warm).toBeLessThan(0);
  });

  it('keeps the same ice sheet on warm restarts', () => {
    const warm = computeClimate(polar, { ...DEFAULT_CLIMATE_PARAMS, gridW: W, gridH: H }, undefined, full);
    const a = (full as ClimateResultWithHydro).landIce!;
    const b = (warm as ClimateResultWithHydro).landIce!;
    let diff = 0;
    for (let i = 0; i < N; i++) if ((a[i] >= 0.5) !== (b[i] >= 0.5)) diff++;
    expect(diff).toBe(0);
    expect(Math.abs(band(warm, -90, -80).warm - band(full, -90, -80).warm)).toBeLessThan(2);
  });
});

describe('mid-latitude continent', () => {
  // A 60°-wide continent from 25°N to 65°N: no ice anywhere, so none of the glacier changes apply.
  // Reference values from the polish-3 model (identical within rounding).
  const mid = world((lat, lon) => (lat > 25 && lat < 65 && lon > -30 && lon < 30 ? 400 : -4000), 42);
  const c = computeClimate(mid, { ...DEFAULT_CLIMATE_PARAMS, gridW: W, gridH: H });

  it('keeps its hot continental summers and cold winters unchanged', () => {
    const interior = band(c, 45, 55, -15, 15);
    const south = band(c, 30, 40, -15, 15);
    console.log(`mid-latitude interior 45–55°N: warmest ${interior.warm.toFixed(2)} °C, coldest ${interior.cold.toFixed(2)} °C; 30–40°N warmest ${south.warm.toFixed(2)} °C`);
    expect(interior.warm).toBeCloseTo(MID_REF.interiorWarm, 1);
    expect(interior.cold).toBeCloseTo(MID_REF.interiorCold, 1);
    expect(south.warm).toBeCloseTo(MID_REF.southWarm, 1);
    expect(interior.glacier).toBe(0);
    expect(c.stats.koppenAreaE).toBeCloseTo(MID_REF.koppenE, 1);
    expect(c.stats.koppenAreaD).toBeCloseTo(MID_REF.koppenD, 1);
  });
});

describe('glacier mechanics', () => {
  it('never removes the interior of a cold-start ice sheet, only its margin', () => {
    const g = makeGrid(180, 90);
    const land = new Uint8Array(g.n);
    for (let j = 0; j < g.ny; j++) if (Math.asin(g.sinLat[j]) * (180 / Math.PI) < -50) for (let c = 0; c < g.nx; c++) land[j * g.nx + c] = 1;
    const M = makeEbmModel(g, land, new Float64Array(g.n), { ...DEFAULT_CLIMATE_PARAMS }, 6);
    const S = makeState(g.n);
    const sheet = (i: number): boolean => land[i] === 1 && Math.asin(g.sinLat[(i / g.nx) | 0]) * (180 / Math.PI) < -66;
    for (let i = 0; i < g.n; i++) if (sheet(i)) S.M[i] = ebmTuning.glacierMassMax;
    applyIceFlow(M, S); // cold-start mask
    const before = M.iceMask.slice();
    // A year of strong ablation everywhere (the uncoupled pass-1 summer of a huge continent).
    for (let i = 0; i < g.n; i++) {
      if (!land[i]) continue;
      M.accY[i] = 100;
      M.ablY[i] = before[i] ? 2000 : 100;
      M.potY[i] = before[i] ? 2000 : 5000;
      M.minY[i] = 0;
    }
    // A later pass-1 update (the first one also checks whether the sheet sustains itself at all).
    M.iceYears = 2;
    M.iceUpdates = 1;
    applyIceFlow(M, S);
    let kept = 0, core = 0, margin = 0;
    for (let i = 0; i < g.n; i++) {
      if (!before[i]) continue;
      if (M.iceCoreKm[i] > ebmTuning.glacierCoreKm) {
        core++;
        if (M.iceMask[i]) kept++;
      } else if (!M.iceMask[i]) margin++;
    }
    expect(core).toBeGreaterThan(100);
    expect(kept).toBe(core);
    expect(margin).toBeGreaterThan(0);
  });

  it('releases the core of a sheet that melts out in its own first (ice-albedo) summer', () => {
    // A polar cap under high-obliquity summers: the whole sheet melts out in the first year with
    // melt to spare. Its core is not protected and the mass balance removes it (no ice sheet left
    // under summers that melt it every year). A sheet that loses only its outer core ring that way
    // keeps its protected interior.
    const g = makeGrid(180, 90);
    const land = new Uint8Array(g.n);
    for (let j = 0; j < g.ny; j++) if (Math.asin(g.sinLat[j]) * (180 / Math.PI) < -50) for (let c = 0; c < g.nx; c++) land[j * g.nx + c] = 1;
    const sheet = (i: number): boolean => land[i] === 1 && Math.asin(g.sinLat[(i / g.nx) | 0]) * (180 / Math.PI) < -66;
    const run = (meltedOut: (coreKm: number) => boolean) => {
      const M = makeEbmModel(g, land, new Float64Array(g.n), { ...DEFAULT_CLIMATE_PARAMS }, 6);
      const S = makeState(g.n);
      for (let i = 0; i < g.n; i++) if (sheet(i)) S.M[i] = ebmTuning.glacierMassMax;
      applyIceFlow(M, S); // cold-start mask (M.iceYears = 1 afterwards: the next call is the first update)
      const core = M.iceCoreKm.slice();
      const before = M.iceMask.slice();
      for (let i = 0; i < g.n; i++) {
        if (!land[i]) continue;
        const out = !before[i] || meltedOut(core[i]);
        M.accY[i] = 100;
        M.ablY[i] = out ? 1600 : 300;
        M.potY[i] = out ? 3000 : 0;
        M.minY[i] = out ? 0 : 500;
      }
      applyIceFlow(M, S);
      let coreCells = 0, coreKept = 0;
      for (let i = 0; i < g.n; i++) {
        if (!(core[i] > ebmTuning.glacierCoreKm)) continue;
        coreCells++;
        if (M.iceMask[i]) coreKept++;
      }
      return { coreCells, coreKept };
    };
    const all = run(() => true);
    expect(all.coreCells).toBeGreaterThan(100);
    expect(all.coreKept).toBe(0);
    // Outer core ring (≤ 800 km deep, about a third of the core area) melted out: interior protected.
    const ring = run((d) => d <= 800);
    expect(ring.coreCells).toBe(all.coreCells);
    expect(ring.coreKept).toBe(ring.coreCells);
  });

  it('lets narrow cold-start ice caps vanish entirely', () => {
    const g = makeGrid(180, 90);
    const land = new Uint8Array(g.n);
    const cells: number[] = [];
    // Two 2° cells wide: no cell lies deeper than glacierCoreKm inside the cap.
    for (let j = 10; j < 12; j++) for (let c = 40; c < 50; c++) {
      land[j * g.nx + c] = 1;
      cells.push(j * g.nx + c);
    }
    const M = makeEbmModel(g, land, new Float64Array(g.n), { ...DEFAULT_CLIMATE_PARAMS }, 6);
    const S = makeState(g.n);
    for (const i of cells) S.M[i] = ebmTuning.glacierMassMax;
    applyIceFlow(M, S);
    expect(cells.every((i) => M.iceMask[i] === 1 && M.iceCoreKm[i] <= ebmTuning.glacierCoreKm)).toBe(true);
    for (const i of cells) {
      M.accY[i] = 100;
      M.ablY[i] = 2000;
      M.minY[i] = 0;
    }
    M.iceUpdates = 1;
    applyIceFlow(M, S);
    for (const i of cells) expect(M.iceMask[i]).toBe(0);
  });

  it('weakens the snow-surface inversion in extremely cold air masses', () => {
    const w = 4, h = 18, n = w * h;
    const land = new Uint8Array(n).fill(1);
    const snow = new Float32Array(12 * n).fill(1);
    const mild = new Float32Array(12 * n).fill(-30);
    const cold = new Float32Array(12 * n).fill(-85);
    applySurfaceInversion(mild, snow, land, w, h, DEFAULT_CLIMATE_PARAMS);
    applySurfaceInversion(cold, snow, land, w, h, DEFAULT_CLIMATE_PARAMS);
    // Polar night (July at 85°S): full inversion at −30 °C, roughly halved at −85 °C.
    const k = 6 * n + n - 1;
    expect(ebmTuning.inversionRadiativeRefK).toBeGreaterThan(0);
    const dMild = -30 - mild[k];
    const dCold = -85 - cold[k];
    expect(dMild).toBeGreaterThan(5);
    expect(dCold).toBeGreaterThan(0.3 * dMild);
    expect(dCold).toBeLessThan(0.7 * dMild);
  });
});

/** Polish-3 values of the mid-latitude continent (measured with the previous model). */
const MID_REF = { interiorWarm: 18.944, interiorCold: -7.818, southWarm: 25.835, koppenE: 10.222, koppenD: 37.712 };
