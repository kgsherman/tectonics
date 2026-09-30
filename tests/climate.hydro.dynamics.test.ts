/**
 * SPEC §6.4 asymmetries of the idealized continent (40° wide, 60°S–70°N, 3 km ridge near its west
 * coast) with the real dynamics (computeDynamics, climate-dynamics module) feeding the hydrology,
 * classified with the model's own temperatures. Complements climate.hydro.test.ts, whose analytic
 * zonal fixture has no subtropical highs, monsoons or maritime coastal temperatures.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CLIMATE_PARAMS } from '../src/climate/climate';
import { computeDynamics } from '../src/climate/dyn';
import { computeHydrology } from '../src/climate/hydrology';
import type { DynamicsResult, HydrologyResult } from '../src/climate/internal';
import { KOPPEN_CLASSES, classifyKoppen } from '../src/climate/koppen';
import { idealContinentElevation } from './helpers/fixtures';

const W = 180;
const H = 90;
const N = W * H;
const lat = (r: number) => 90 - ((r + 0.5) * 180) / H;
const lon = (c: number) => -180 + ((c + 0.5) * 360) / W;

let dyn: DynamicsResult;
let hy: HydrologyResult;

function annual(i: number): number {
  let s = 0;
  for (let m = 0; m < 12; m++) s += hy.precip[m * N + i];
  return s;
}

function code(i: number): string {
  const t = new Float32Array(12);
  const p = new Float32Array(12);
  for (let m = 0; m < 12; m++) {
    t[m] = dyn.temp[m * N + i];
    p[m] = hy.precip[m * N + i];
  }
  return KOPPEN_CLASSES[classifyKoppen(t, p, i >= N / 2)].code;
}

/** Land cells inside a box given for the northern hemisphere, mirrored when `south`. */
function cells(la0: number, la1: number, lo0: number, lo1: number, south: boolean): number[] {
  const [a, b] = south ? [-la1, -la0] : [la0, la1];
  const out: number[] = [];
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (dyn.land[i] && lat(r) >= a && lat(r) <= b && lon(c) >= lo0 && lon(c) <= lo1) out.push(i);
    }
  }
  if (out.length === 0) throw new Error('empty box');
  return out;
}

const meanP = (ids: number[]) => ids.reduce((s, i) => s + annual(i), 0) / ids.length;
const WEST = [-20, -18] as const;
const EAST = [16, 20] as const;

beforeAll(() => {
  const params = { ...DEFAULT_CLIMATE_PARAMS, gridW: W, gridH: H };
  dyn = computeDynamics({ w: W, h: H, elev: idealContinentElevation(W, H) }, params);
  hy = computeHydrology(dyn);
});

describe.each([false, true])('idealized continent with real dynamics (south=%s)', (south) => {
  it('closes the water balance', () => {
    expect(hy.stats.waterBalanceError).toBeLessThan(0.05);
  });

  it('east coast 25–35° gets ≥ 3× the west coast', () => {
    expect(meanP(cells(25, 35, ...EAST, south))).toBeGreaterThanOrEqual(3 * meanP(cells(25, 35, ...WEST, south)));
  });

  it('west coast 20–30° is arid (group B)', () => {
    for (const i of cells(20, 30, ...WEST, south)) expect(code(i)[0]).toBe('B');
  });

  it('west coast 35–42° has a Mediterranean (Cs) regime', () => {
    const codes = cells(35, 42, ...WEST, south).map(code);
    const cs = codes.filter((k) => k.startsWith('Cs')).length;
    expect(cs / codes.length).toBeGreaterThanOrEqual(0.5);
  });

  it('west coast 45–60° is fully humid; oceanic (Cfb/Cfc) where winters are maritime (45–48°)', () => {
    // Poleward of ~48° the dynamics' coldest month nears 0 °C on this ocean world without a gyre- or
    // overturning-warmed eastern ocean (the C/D boundary), but the coast stays far milder than the
    // interior at the same latitude; the hydrology's part is the fully humid, no-dry-season regime.
    for (const i of cells(45, 60, ...WEST, south)) {
      const k = code(i);
      expect(k[0] === 'E' || k[1] === 'f').toBe(true);
    }
    for (const i of cells(45, 48, ...WEST, south)) expect(['Cfb', 'Cfc']).toContain(code(i));
    const coldest = (i: number): number => {
      let t = Infinity;
      for (let m = 0; m < 12; m++) t = Math.min(t, dyn.temp[m * N + i]);
      return t;
    };
    const coast = cells(48, 52, ...WEST, south);
    const interior = cells(48, 52, -2, 6, south);
    const mean = (xs: number[]): number => xs.reduce((s, i) => s + coldest(i), 0) / xs.length;
    for (const i of coast) expect(coldest(i)).toBeGreaterThan(-3);
    expect(mean(coast)).toBeGreaterThan(mean(interior) + 3);
  });

  it('interior 45–50° (≥ 1500 km inland) gets ≤ 0.5× the west coast', () => {
    expect(meanP(cells(45, 50, -2, 6, south))).toBeLessThanOrEqual(0.5 * meanP(cells(45, 50, ...WEST, south)));
  });

  it('the lee of the 3 km ridge gets ≤ 0.5× its windward side', () => {
    expect(meanP(cells(40, 55, -13, -9, south))).toBeLessThanOrEqual(0.5 * meanP(cells(40, 55, -20, -15.5, south)));
  });
});

describe('seasonal cycle with real dynamics', () => {
  it('the land ITCZ shifts ≥ 10° over the year', () => {
    const lats: number[] = [];
    for (let m = 0; m < 12; m++) {
      let best = -1;
      let at = 0;
      for (let r = 0; r < H; r++) {
        if (Math.abs(lat(r)) > 30) continue;
        let s = 0;
        let k = 0;
        for (let c = 0; c < W; c++) {
          const i = r * W + c;
          if (!dyn.land[i]) continue;
          s += hy.precip[m * N + i];
          k++;
        }
        if (k > 0 && s / k > best) {
          best = s / k;
          at = lat(r);
        }
      }
      lats.push(at);
    }
    expect(Math.max(...lats) - Math.min(...lats)).toBeGreaterThanOrEqual(10);
  });
});
