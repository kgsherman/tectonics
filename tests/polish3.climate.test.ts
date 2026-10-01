/**
 * Polish 3, climate: level-referenced moisture transport onto high plateaus, a column temperature
 * smoothed over the free-tropospheric scale (no grid-scale streaks over the polar oceans), glacier
 * topology settled deterministically inside the cold pass 1 (identical for warm and cold starts),
 * ice sheets only where they have room for a dome, and winter sea ice / Arctic ice caps / Tibet on
 * Earth.
 */
import { describe, expect, it } from 'vitest';
import type { ClimateInput, ClimateResult } from '../src/core/types';
import { computeClimate, DEFAULT_CLIMATE_PARAMS, type ClimateResultWithHydro } from '../src/climate/climate';
import { makeGrid } from '../src/climate/dynGrid';
import { buildEarthClimateInput } from '../src/climate/earthInput';
import { makeEbmModel, makeState } from '../src/climate/energy';
import { applyIceFlow, applyIceSurface } from '../src/climate/energyIce';
import { ebmTuning } from '../src/climate/tuning';
import { HYDRO_TUNING } from '../src/climate/hydroTuning';
import { KOPPEN_CLASSES } from '../src/climate/koppen';
import { ImplicitDiffusion } from '../src/climate/moistureDiffusion';
import { allocForcingScratch, allocMonthForcing, computeMonthForcing, computeStaticForcing } from '../src/climate/moistureForcing';
import { makeHydroGrid } from '../src/climate/moistureGrid';
import { computeEarthMetrics } from '../scripts/lib/earthMetrics';
import { zonalDynamics } from './helpers/fixtures';

const DEG = Math.PI / 180;

describe('level-referenced moisture transport', () => {
  it('eddies only mix the vapour above the higher surface (mass conserved)', () => {
    const g = makeHydroGrid(90, 45);
    const K = new Float64Array(g.n).fill(3e6);
    const height = new Float64Array(g.n);
    for (let j = 0; j < g.h; j++) for (let c = 40; c < 60; c++) height[j * g.w + c] = 4500;
    const run = (H: number): Float64Array => {
      const d = new ImplicitDiffusion(g);
      d.setup(K, 6 * 3600, height, 0, H, 1000);
      const W = new Float64Array(g.n);
      for (let j = 0; j < g.h; j++) for (let c = 0; c < g.w; c++) W[j * g.w + c] = height[j * g.w + c] > 0 ? 2 : 20;
      for (let s = 0; s < 1000; s++) d.apply(W);
      return W;
    };
    const mass = (W: Float64Array): number => {
      let m = 0;
      for (let j = 0; j < g.h; j++) for (let c = 0; c < g.w; c++) m += W[j * g.w + c] * g.rowArea[j];
      return m;
    };
    const plain = run(0);
    const level = run(2200);
    const j = g.h >> 1;
    // Whole-column mixing floods the plateau with lowland water; level-referenced mixing settles at
    // the vapour profile: W_plateau ≈ W_lowland·e^{−(4500 − 1000)/2200}.
    expect(plain[j * g.w + 50] / plain[j * g.w + 10]).toBeGreaterThan(0.8);
    const ratio = level[j * g.w + 50] / level[j * g.w + 10];
    expect(ratio).toBeGreaterThan(0.8 * Math.exp(-3500 / 2200));
    expect(ratio).toBeLessThan(1.25 * Math.exp(-3500 / 2200));
    const W0 = new Float64Array(g.n);
    for (let jj = 0; jj < g.h; jj++) for (let c = 0; c < g.w; c++) W0[jj * g.w + c] = height[jj * g.w + c] > 0 ? 2 : 20;
    expect(mass(level)).toBeCloseTo(mass(W0), 9);
  });

  it('keeps a Tibet-like plateau dry next to a monsoon lowland', () => {
    const W = 180;
    const H = 90;
    const N = W * H;
    const elev = new Float32Array(N);
    for (let r = 0; r < H; r++) {
      const la = 90 - ((r + 0.5) * 180) / H;
      for (let c = 0; c < W; c++) {
        const lo = -180 + ((c + 0.5) * 360) / W;
        let e = -4000;
        if (la > -40 && la < 60 && lo > -40 && lo < 40) {
          e = 300;
          if (la > 28 && la < 40 && lo > 0 && lo < 30) e = 4800;
          else if (la > 25 && la <= 28 && lo > 0 && lo < 30) e = 2500;
        }
        elev[r * W + c] = e;
      }
    }
    const lf = Float32Array.from(elev, (e) => (e > 0 ? 1 : 0));
    const c = computeClimate({ w: W, h: H, elev, landFraction: lf, sourceId: 5, time: 0 }, { ...DEFAULT_CLIMATE_PARAMS, gridW: W, gridH: H });
    const mean = (la0: number, la1: number, lo0: number, lo1: number, f: (i: number) => number): number => {
      let s = 0, k = 0;
      for (let r = 0; r < H; r++) {
        const la = 90 - ((r + 0.5) * 180) / H;
        if (la < la0 || la > la1) continue;
        for (let col = 0; col < W; col++) {
          const lo = -180 + ((col + 0.5) * 360) / W;
          if (lo < lo0 || lo > lo1 || !c.land[r * W + col]) continue;
          s += f(r * W + col);
          k++;
        }
      }
      return s / k;
    };
    const plateau = mean(30, 38, 4, 26, (i) => c.precipAnnual[i]);
    const foot = mean(15, 24, 4, 26, (i) => c.precipAnnual[i]);
    const summer = mean(30, 38, 4, 26, (i) => c.precip[5 * N + i] + c.precip[6 * N + i] + c.precip[7 * N + i]);
    const polar = mean(30, 38, 4, 26, (i) => (KOPPEN_CLASSES[c.koppen[i]].group === 'E' ? 1 : 0));
    console.log(`idealized plateau: P ${plateau.toFixed(0)} mm (JJA ${((100 * summer) / plateau).toFixed(0)} %), monsoon foot ${foot.toFixed(0)} mm, E share ${polar.toFixed(2)}`);
    expect(plateau).toBeLessThan(400);
    expect(plateau).toBeLessThan(0.3 * foot);
    expect(summer).toBeGreaterThan(0.4 * plateau);
    expect(polar).toBeGreaterThan(0.9);
  });

  it('smooths the column temperature: sea-ice-scale surface wiggles do not reach W_sat', () => {
    const W = 360;
    const H = 180;
    const dyn = zonalDynamics(W, H);
    const N = W * H;
    // A 2-cell sawtooth of ±1.5 K in the July surface air over the polar ocean (70–85°N).
    for (let r = 5; r < 20; r++) for (let c = 0; c < W; c++) dyn.temp[6 * N + r * W + c] += c % 4 < 2 ? 1.5 : -1.5;
    const g = makeHydroGrid(W, H);
    const st = computeStaticForcing(g, dyn, HYDRO_TUNING);
    const f = allocMonthForcing(N);
    computeMonthForcing(g, dyn, st, 6, 4 * 3600, HYDRO_TUNING, allocForcingScratch(g), f);
    let worst = 0;
    for (let r = 8; r < 18; r++) {
      let lo = Infinity, hi = -Infinity;
      for (let c = 60; c < 120; c++) {
        lo = Math.min(lo, f.wsat[r * W + c]);
        hi = Math.max(hi, f.wsat[r * W + c]);
      }
      worst = Math.max(worst, (hi - lo) / hi);
    }
    // Without smoothing ±1.5 K moves W_sat by ≈ ±5 % from cell to cell.
    expect(worst).toBeLessThan(0.01);
  });
});

/** Glacier mask (landIce ≥ 0.5 on land). */
const glaciers = (c: ClimateResult): Uint8Array => {
  const ice = (c as ClimateResultWithHydro).landIce!;
  return Uint8Array.from(ice, (v, i) => (c.land[i] && v >= 0.5 ? 1 : 0));
};

describe('glacier topology is deterministic', () => {
  it('deep winter snow on bare land at the last topology boundary does not freeze in as glacier', () => {
    const g = makeGrid(36, 18);
    const land = new Uint8Array(g.n);
    for (let j = 2; j < 6; j++) for (let c = 10; c < 20; c++) land[j * g.nx + c] = 1;
    const M = makeEbmModel(g, land, new Float64Array(g.n), { ...DEFAULT_CLIMATE_PARAMS }, 6);
    const S = makeState(g.n);
    const i = 3 * g.nx + 14;
    M.iceYears = ebmTuning.glacierTopologyYears;
    M.iceUpdates = 1; // the last topology update of the run
    // Snow-free last summer (minY = 0), but a deep pack at the (northern mid-winter) boundary.
    S.M[i] = 0.5 * (ebmTuning.glacierMassHigh + ebmTuning.glacierMassMax);
    M.minY[i] = 0;
    M.accY[i] = 900;
    M.ablY[i] = 1100;
    applyIceFlow(M, S);
    expect(M.iceMask[i]).toBe(0);
    applyIceSurface(M, S);
    expect(M.iceRaise[i]).toBe(0);
    // Held from now on: the mask stays bare however much snow the cell carries.
    for (let y = 0; y < 3; y++) {
      S.M[i] = ebmTuning.glacierMassMax;
      applyIceFlow(M, S);
      expect(M.iceMask[i]).toBe(0);
    }
  });

  it('warm starts and run lengths give the same glacier margins', () => {
    const W = 180;
    const H = 90;
    const input: ClimateInput = buildEarthClimateInput(W, H);
    const full = { ...DEFAULT_CLIMATE_PARAMS, gridW: W, gridH: H };
    const fast = { ...full, fast: true };
    const cold = computeClimate(input, full);
    const warm = computeClimate(input, full, undefined, cold);
    const coldFast = computeClimate(input, fast);
    const warmFast = computeClimate(input, fast, undefined, cold);
    const warmFast2 = computeClimate(input, fast, undefined, warmFast);
    const a = glaciers(cold);
    const b = glaciers(warm);
    const cf = glaciers(coldFast);
    let n = 0;
    for (let i = 0; i < a.length; i++) n += a[i];
    expect(n).toBeGreaterThan(100); // Antarctica and Greenland
    expect(Array.from(b)).toEqual(Array.from(a));
    expect(Array.from(glaciers(warmFast))).toEqual(Array.from(cf));
    expect(Array.from(glaciers(warmFast2))).toEqual(Array.from(cf));
  });
});

describe('Earth: sea ice, Arctic ice caps and Tibet', () => {
  const W = 360;
  const H = 180;
  const N = W * H;
  const c = computeClimate(buildEarthClimateInput(W, H), { ...DEFAULT_CLIMATE_PARAMS });
  const latOf = (r: number): number => 90 - (r + 0.5);
  const lonOf = (col: number): number => -180 + col + 0.5;

  /** Sea-ice extent (≥ 15 %, open-ocean share of each cell), million km². */
  const extent = (m: number, north: boolean): number => {
    let a = 0;
    for (let r = 0; r < H; r++) {
      const lat = latOf(r);
      if (north ? lat < 0 : lat > 0) continue;
      const km2 = 6371 ** 2 * DEG * (Math.sin((lat + 0.5) * DEG) - Math.sin((lat - 0.5) * DEG));
      for (let col = 0; col < W; col++) {
        const i = r * W + col;
        if (c.seaIce[m * N + i] >= 0.15) a += (1 - c.landFraction[i]) * km2;
      }
    }
    return a / 1e6;
  };
  const shares = (la0: number, la1: number, lo0: number, lo1: number, minH = -Infinity) => {
    const ice = (c as ClimateResultWithHydro).landIce!;
    let tot = 0, gl = 0, ef = 0, e = 0, p = 0;
    for (let r = 0; r < H; r++) {
      const lat = latOf(r);
      if (lat < la0 || lat > la1) continue;
      const wr = Math.cos(lat * DEG);
      for (let col = 0; col < W; col++) {
        const lon = lonOf(col);
        const i = r * W + col;
        if (lon < lo0 || lon > lo1 || !c.land[i] || c.elev[i] < minH) continue;
        tot += wr;
        if (ice[i] >= 0.5) gl += wr;
        const code = KOPPEN_CLASSES[c.koppen[i]].code;
        if (code === 'EF') ef += wr;
        if (code[0] === 'E') e += wr;
        p += wr * c.precipAnnual[i];
      }
    }
    return { glacier: gl / tot, EF: ef / tot, E: e / tot, P: p / tot };
  };

  it('keeps the calibration', () => {
    const m = computeEarthMetrics(c);
    console.log(`Earth: zonal RMSE ${m.zonalRmse.toFixed(2)} °C, P ${m.globalPrecip.toFixed(0)} mm, Köppen L1 ${m.groupAreaError.toFixed(1)} pp, cities ${(100 * m.groupHitRate).toFixed(1)} / ${(100 * m.codeHitRate).toFixed(1)} %`);
    expect(m.zonalRmse).toBeLessThan(1.2);
    expect(m.groupAreaError).toBeLessThan(5);
    expect(m.groupHitRate).toBeGreaterThanOrEqual(0.84);
    expect(m.codeHitRate).toBeGreaterThan(0.451);
    expect(Math.abs(m.globalPrecip - 1050)).toBeLessThan(60);
  });

  it('has winter sea ice within the observed extents', () => {
    const shSep = extent(8, false);
    const nhMar = extent(2, true);
    console.log(`Earth winter sea-ice extent: SH Sep ${shSep.toFixed(1)} M km² (incl. ≈ 2 M km² of ice shelves), NH Mar ${nhMar.toFixed(1)} M km²`);
    expect(shSep).toBeLessThan(20);
    expect(shSep).toBeGreaterThan(16);
    expect(nhMar).toBeGreaterThan(13);
    expect(nhMar).toBeLessThan(17);
  });

  it('gives the Arctic islands ice caps, not ice sheets', () => {
    const caa = shares(72, 83, -125, -72);
    const sval = shares(76.5, 81, 10, 34);
    const green = shares(60, 83, -55, -20);
    console.log(`Earth glacier cover: Canadian Arctic ${(100 * caa.glacier).toFixed(0)} % (EF ${(100 * caa.EF).toFixed(0)} %), Svalbard ${(100 * sval.glacier).toFixed(0)} % (EF ${(100 * sval.EF).toFixed(0)} %), Greenland ${(100 * green.glacier).toFixed(0)} %`);
    expect(caa.glacier).toBeLessThan(0.4);
    expect(caa.EF).toBeLessThan(0.25);
    expect(sval.glacier).toBeLessThan(0.7);
    expect(sval.E).toBeGreaterThan(0.95);
    expect(green.glacier).toBeGreaterThan(0.85);
  });

  it('keeps the Tibetan plateau a cold, dry tundra with summer rain', () => {
    const tib = shares(27, 39, 75, 104, 3500);
    let jja = 0, tot = 0;
    for (let r = 0; r < H; r++) {
      const lat = latOf(r);
      if (lat < 27 || lat > 39) continue;
      for (let col = 0; col < W; col++) {
        const lon = lonOf(col);
        const i = r * W + col;
        if (lon < 75 || lon > 104 || !c.land[i] || c.elev[i] < 3500) continue;
        jja += c.precip[5 * N + i] + c.precip[6 * N + i] + c.precip[7 * N + i];
        tot += c.precipAnnual[i];
      }
    }
    console.log(`Earth Tibet (> 3500 m): P ${tib.P.toFixed(0)} mm, JJA ${((100 * jja) / tot).toFixed(0)} %, E ${(100 * tib.E).toFixed(0)} %`);
    expect(tib.P).toBeLessThan(450);
    expect(tib.P).toBeGreaterThan(100);
    expect(jja / tot).toBeGreaterThan(0.33);
    expect(tib.E).toBeGreaterThan(0.85);
  });
});
