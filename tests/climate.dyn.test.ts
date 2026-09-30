import { describe, expect, it } from 'vitest';
import type { ClimateParams } from '../src/core/types';
import { computeDynamics } from '../src/climate/dyn';
import type { DynamicsResult } from '../src/climate/internal';
import { FIXTURE_CLIMATE_PARAMS, idealContinentElevation } from './helpers/fixtures';

const W = 90;
const H = 45;
const N = W * H;
const P = (over: Partial<ClimateParams> = {}): ClimateParams => ({ ...FIXTURE_CLIMATE_PARAMS, ...over });
const latOf = (r: number): number => 90 - ((r + 0.5) * 180) / H;
const rowOf = (lat: number): number => Math.min(H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * H)));
const colOf = (lon: number): number => Math.floor(((lon + 180) / 360) * W) % W;
const at = (f: Float32Array, m: number, lat: number, lon: number): number => f[m * N + rowOf(lat) * W + colOf(lon)];

const annual = (d: DynamicsResult, r: number, c: number): number => {
  let s = 0;
  for (let m = 0; m < 12; m++) s += d.temp[m * N + r * W + c] / 12;
  return s;
};

const MONTHLY = ['temp', 'sst', 'seaIce', 'pressure', 'windU', 'windV', 'steerU', 'steerV', 'ascent', 'baroclinic', 'currentU', 'currentV', 'upwelling'] as const;

function expectSane(d: DynamicsResult): void {
  expect(d.w).toBe(W);
  expect(d.h).toBe(H);
  for (const k of MONTHLY) {
    const f = d[k];
    expect(f.length).toBe(12 * N);
    for (let i = 0; i < f.length; i++) {
      if (!Number.isFinite(f[i])) throw new Error(`${k}[${i}] = ${f[i]}`);
    }
  }
  for (let i = 0; i < 12 * N; i++) {
    const c = i % N;
    expect(d.temp[i]).toBeGreaterThan(-95);
    expect(d.temp[i]).toBeLessThan(60);
    expect(d.sst[i]).toBeGreaterThanOrEqual(-1.8 - 1e-6);
    expect(d.seaIce[i]).toBeGreaterThanOrEqual(0);
    expect(d.seaIce[i]).toBeLessThanOrEqual(1);
    expect(d.pressure[i]).toBeGreaterThan(940);
    expect(d.pressure[i]).toBeLessThan(1070);
    expect(Math.hypot(d.windU[i], d.windV[i])).toBeLessThanOrEqual(30.001);
    expect(Math.hypot(d.currentU[i], d.currentV[i])).toBeLessThanOrEqual(2.5001);
    expect(d.upwelling[i]).toBeGreaterThanOrEqual(0);
    if (d.land[c]) {
      expect(d.currentU[i]).toBe(0);
      expect(d.upwelling[i]).toBe(0);
    }
  }
}

describe('computeDynamics — idealized continent', () => {
  const d = computeDynamics({ w: W, h: H, elev: idealContinentElevation(W, H) }, P());

  it('returns finite, sane monthly fields on the output grid', () => {
    expectSane(d);
    for (let i = 0; i < N; i++) {
      expect(d.land[i]).toBe(d.elev[i] > 0 ? 1 : 0);
      expect(d.surfaceHeight[i]).toBe(d.land[i] ? Math.max(0, d.elev[i]) : 0);
    }
  });

  it('has continental seasons, a maritime west coast and a lapse-cooled ridge', () => {
    const range = (lat: number, lon: number): number => at(d.temp, 6, lat, lon) - at(d.temp, 0, lat, lon);
    expect(range(50, 0)).toBeGreaterThan(15);
    expect(range(50, 60)).toBeLessThan(range(50, 0));
    expect(Math.abs(range(0, 60))).toBeLessThan(4);
    // Westerlies: the west coast has milder winters than the interior at 45–55°N.
    expect(at(d.temp, 0, 50, -19)).toBeGreaterThan(at(d.temp, 0, 50, 5) + 2);
    // 3 km ridge ≥ 12 K colder than the adjacent lowland.
    expect(at(d.temp, 6, 40, -15)).toBeLessThan(at(d.temp, 6, 40, -8) - 12);
    // NH summer warmer than winter at 40°N, SH opposite.
    expect(at(d.temp, 6, 40, 0)).toBeGreaterThan(at(d.temp, 0, 40, 0));
    expect(at(d.temp, 0, -40, 0)).toBeGreaterThan(at(d.temp, 6, -40, 0));
  });

  it('shifts the land ITCZ ≥ 10° between January and July', () => {
    const itczLat = (m: number, lon: number): number => {
      let best = -Infinity;
      let lat = 0;
      for (let r = 0; r < H; r++) {
        if (Math.abs(latOf(r)) > 35) continue;
        const v = d.ascent[m * N + r * W + colOf(lon)];
        if (v > best) {
          best = v;
          lat = latOf(r);
        }
      }
      return lat;
    };
    expect(itczLat(6, 0) - itczLat(0, 0)).toBeGreaterThanOrEqual(10);
  });

  it('has trades and westerlies of realistic strength over the ocean', () => {
    const zonalU = (lat: number): number => {
      let s = 0;
      for (let m = 0; m < 12; m++) for (let c = 0; c < W; c++) s += d.windU[m * N + rowOf(lat) * W + c] / (12 * W);
      return s;
    };
    expect(zonalU(15)).toBeLessThan(-2);
    expect(zonalU(-15)).toBeLessThan(-2);
    expect(zonalU(47)).toBeGreaterThan(2);
    expect(zonalU(-47)).toBeGreaterThan(2);
  });
});

describe('computeDynamics — symmetry', () => {
  it('aquaplanet at zero tilt is zonally uniform and north/south symmetric', () => {
    const d = computeDynamics({ w: W, h: H, elev: new Float32Array(N).fill(-4000) }, P({ axialTilt: 0 }));
    expectSane(d);
    let maxStd = 0;
    let maxAsym = 0;
    for (let m = 0; m < 12; m += 3) {
      for (let r = 0; r < H; r++) {
        let s = 0, s2 = 0;
        for (let c = 0; c < W; c++) {
          const v = d.temp[m * N + r * W + c];
          s += v;
          s2 += v * v;
        }
        const mean = s / W;
        maxStd = Math.max(maxStd, Math.sqrt(Math.max(0, s2 / W - mean * mean)));
        const mirror = d.temp[m * N + (H - 1 - r) * W + 7];
        maxAsym = Math.max(maxAsym, Math.abs(d.temp[m * N + r * W + 7] - mirror));
      }
    }
    expect(maxStd).toBeLessThan(0.05);
    expect(maxAsym).toBeLessThan(0.3);
    // Trades converge on the equator from both sides symmetrically.
    expect(Math.abs(at(d.windV, 0, 8, 0) + at(d.windV, 0, -8, 0))).toBeLessThan(0.2);
  });

  it('a retrograde planet with a mirrored continent is the mirror image', () => {
    const e = idealContinentElevation(W, H);
    const mirrored = new Float32Array(N);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) mirrored[r * W + c] = e[r * W + (W - 1 - c)];
    const a = computeDynamics({ w: W, h: H, elev: e }, P());
    const b = computeDynamics({ w: W, h: H, elev: mirrored }, P({ retrograde: true }));
    let dT = 0, dU = 0, dV = 0, dP = 0;
    for (let m = 0; m < 12; m++) {
      for (let r = 0; r < H; r++) {
        for (let c = 0; c < W; c++) {
          const i = m * N + r * W + c;
          const j = m * N + r * W + (W - 1 - c);
          dT = Math.max(dT, Math.abs(a.temp[i] - b.temp[j]));
          dP = Math.max(dP, Math.abs(a.pressure[i] - b.pressure[j]));
          dU = Math.max(dU, Math.abs(a.windU[i] + b.windU[j]));
          dV = Math.max(dV, Math.abs(a.windV[i] - b.windV[j]));
        }
      }
    }
    // Exact up to floating-point rounding.
    expect(dT).toBeLessThan(0.05);
    expect(dP).toBeLessThan(0.05);
    expect(dU).toBeLessThan(0.05);
    expect(dV).toBeLessThan(0.05);
    let meanDT = 0;
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) meanDT += Math.abs(annual(a, r, c) - annual(b, r, W - 1 - c)) / N;
    expect(meanDT).toBeLessThan(0.005);
  });
});

describe('computeDynamics — extreme parameters', () => {
  const continent = idealContinentElevation(W, H);
  const mostlyLand = new Float32Array(N);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      // ~70% land: oceans only in a band and a basin.
      const lat = latOf(r);
      const lon = -180 + ((c + 0.5) * 360) / W;
      const sea = (lat > -35 && lat < -5) || (lon > 100 && lon < 170 && lat > 10 && lat < 50) || lat < -75;
      mostlyLand[r * W + c] = sea ? -3000 : 400 + 10 * Math.abs(lat);
    }
  }
  const cases: Array<[string, Float32Array, Partial<ClimateParams>]> = [
    ['tilt 0', continent, { axialTilt: 0 }],
    ['tilt 45', continent, { axialTilt: 45 }],
    ['tilt 90', continent, { axialTilt: 90 }],
    ['no land', new Float32Array(N).fill(-3000), {}],
    ['70% land', mostlyLand, {}],
    ['all land', new Float32Array(N).fill(800), {}],
    ['dim sun', continent, { solarMultiplier: 0.85 }],
    ['bright sun, no currents', continent, { solarMultiplier: 1.2, oceanCurrents: 0 }],
    ['high sea level', continent, { seaLevel: 500 }],
  ];
  for (const [name, elev, over] of cases) {
    it(`stays finite and sane: ${name}`, () => {
      const d = computeDynamics({ w: W, h: H, elev }, P(over));
      expectSane(d);
    });
  }

  it('tilt 90 gives extreme land seasons at high latitude and a warm summer pole', () => {
    const d = computeDynamics({ w: W, h: H, elev: continent }, P({ axialTilt: 90 }));
    expect(at(d.temp, 6, 65, 0)).toBeGreaterThan(at(d.temp, 0, 65, 0) + 40);
    expect(at(d.temp, 6, 65, 0)).toBeGreaterThan(at(d.temp, 6, 0, 0));
  });

  it('repeated warm restarts converge to the cold-start climate instead of drifting', () => {
    const input = { w: W, h: H, elev: continent };
    const params = P({ fast: false });
    const gm = (d: DynamicsResult): number => {
      let s = 0;
      let w = 0;
      for (let r = 0; r < H; r++) {
        const wr = Math.cos((latOf(r) * Math.PI) / 180);
        for (let m = 0; m < 12; m++) for (let c = 0; c < W; c++) s += wr * d.temp[m * N + r * W + c];
        w += 12 * W * wr;
      }
      return s / w;
    };
    const maxDiff = (a: DynamicsResult, b: DynamicsResult): number => {
      let x = 0;
      for (let i = 0; i < 12 * N; i++) x = Math.max(x, Math.abs(a.temp[i] - b.temp[i]));
      return x;
    };
    const cold = computeDynamics(input, params);
    const w1 = computeDynamics(input, params, cold);
    const w2 = computeDynamics(input, params, w1);
    expect(w2.stats.warmStart).toBe(1);
    // Global mean held; restarts change less and less (no drift toward another climate).
    expect(Math.abs(gm(w2) - gm(cold))).toBeLessThan(0.25);
    expect(maxDiff(w2, w1)).toBeLessThan(0.5 * maxDiff(w1, cold) + 1e-3);
    expect(maxDiff(w2, w1)).toBeLessThan(0.3);
    expect(maxDiff(w2, cold)).toBeLessThan(2);
  });

  it('accepts inputs of another size and warm starts', () => {
    const big = idealContinentElevation(180, 90);
    const cold = computeDynamics({ w: 180, h: 90, elev: big }, P());
    expect(cold.w).toBe(W);
    expectSane(cold);
    const warm = computeDynamics({ w: 180, h: 90, elev: big }, P(), { ...cold, temp: cold.temp, sst: cold.sst, seaIce: cold.seaIce });
    expectSane(warm);
    expect(warm.stats.warmStart).toBe(1);
    let diff = 0;
    for (let i = 0; i < 12 * N; i++) diff = Math.max(diff, Math.abs(warm.temp[i] - cold.temp[i]));
    expect(diff).toBeLessThan(12);
  });
});
