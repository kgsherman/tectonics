import { describe, expect, it } from 'vitest';
import type { ClimateResult } from '../src/core/types';
import { climateInputFromSnapshot, computeClimate, DEFAULT_CLIMATE_PARAMS } from '../src/climate/climate';
import { KOPPEN_CLASSES, classifyKoppen } from '../src/climate/koppen';
import { FIXTURE_CLIMATE_PARAMS, idealContinentElevation, smallMesh, syntheticSnapshot } from './helpers/fixtures';

const W = 90;
const H = 45;
const N = W * H;

const FIELDS_12 = ['temp', 'precip', 'evap', 'snow', 'cloud', 'pressure', 'windU', 'windV', 'sst', 'seaIce', 'currentU', 'currentV'] as const;
const FIELDS_1 = ['landFraction', 'elev', 'tempAnnual', 'precipAnnual'] as const;

function expectComplete(r: ClimateResult): void {
  expect(r.w).toBe(W);
  expect(r.h).toBe(H);
  for (const k of FIELDS_12) {
    expect(r[k].length).toBe(12 * N);
    for (let i = 0; i < r[k].length; i++) if (!Number.isFinite(r[k][i])) throw new Error(`${k}[${i}] not finite`);
  }
  for (const k of FIELDS_1) {
    expect(r[k].length).toBe(N);
    for (let i = 0; i < N; i++) expect(Number.isFinite(r[k][i])).toBe(true);
  }
  expect(r.id).not.toBe(0);
  expect(r.stats.nonFiniteFilled).toBe(0);
  for (let i = 0; i < N; i++) {
    expect(r.koppenAll[i]).toBeGreaterThan(0);
    expect(r.koppenAll[i]).toBeLessThan(KOPPEN_CLASSES.length);
    expect(r.koppen[i]).toBe(r.land[i] ? r.koppenAll[i] : 0);
  }
}

describe('computeClimate', () => {
  const input = { w: W, h: H, elev: idealContinentElevation(W, H), sourceId: 42, time: 7 };
  const params = { ...FIXTURE_CLIMATE_PARAMS };
  const r = computeClimate(input, params);

  it('fills every field, classifies Köppen and echoes the source', () => {
    expectComplete(r);
    expect(r.sourceSnapshotId).toBe(42);
    expect(r.sourceTime).toBe(7);
    expect(r.params).toEqual(params);
    // Köppen of a cell equals the classifier applied to its own monthly T/P.
    const i = 20 * W + 45;
    const t = Array.from({ length: 12 }, (_, m) => r.temp[m * N + i]);
    const p = Array.from({ length: 12 }, (_, m) => r.precip[m * N + i]);
    expect(r.koppenAll[i]).toBe(classifyKoppen(t, p, false));
    expect(r.tempAnnual[i]).toBeCloseTo(t.reduce((a, b) => a + b, 0) / 12, 4);
  });

  it('reports statistics, including Köppen group areas over land', () => {
    const s = r.stats;
    expect(s.globalMeanTemp).toBeGreaterThan(5);
    expect(s.globalMeanTemp).toBeLessThan(25);
    const groups = s.koppenAreaA + s.koppenAreaB + s.koppenAreaC + s.koppenAreaD + s.koppenAreaE;
    expect(groups).toBeCloseTo(100, 3);
    expect(Number.isFinite(s.pMinusEError)).toBe(true);
    expect(s.zonalMeanTemp5).toBeGreaterThan(s.zonalMeanTemp75);
    expect(r.timings.total).toBeGreaterThan(0);
  });

  it('is deterministic and keys ids by value', () => {
    const again = computeClimate(input, params);
    expect(again.id).toBe(r.id);
    for (let i = 0; i < 12 * N; i += 97) expect(again.temp[i]).toBe(r.temp[i]);
    const other = computeClimate(input, { ...params, axialTilt: 30 });
    expect(other.id).not.toBe(r.id);
  });

  it('warm-starts from a previous result', () => {
    const warm = computeClimate(input, params, undefined, r);
    expectComplete(warm);
    expect(warm.stats['dyn.warmStart']).toBe(1);
    expect(warm.id).not.toBe(r.id);
  });

  it('reports progress through the stages', () => {
    const stages: string[] = [];
    computeClimate(input, { ...params, gridW: 72, gridH: 36 }, (stage) => {
      if (stages[stages.length - 1] !== stage) stages.push(stage);
    });
    expect(stages).toEqual(['dynamics', 'hydrology', 'koppen', 'done']);
  });

  it('stays complete and finite for extreme worlds and parameters', () => {
    const lat = (r: number): number => 90 - ((r + 0.5) * 180) / H;
    const mostlyLand = new Float32Array(N);
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const lon = -180 + ((c + 0.5) * 360) / W;
        const sea = (lat(r) > -35 && lat(r) < -5) || (lon > 100 && lon < 170 && lat(r) > 10 && lat(r) < 50) || lat(r) < -75;
        mostlyLand[r * W + c] = sea ? -3000 : 400 + 10 * Math.abs(lat(r));
      }
    }
    const cases: Array<[Float32Array, Partial<typeof params>]> = [
      [input.elev, { axialTilt: 0 }],
      [input.elev, { axialTilt: 90, retrograde: true }],
      [new Float32Array(N).fill(-3000), {}],
      [new Float32Array(N).fill(800), {}],
      [mostlyLand, { solarMultiplier: 1.3, oceanCurrents: 0 }],
    ];
    for (const [elev, over] of cases) expectComplete(computeClimate({ w: W, h: H, elev }, { ...params, ...over }));
  });

  it('rejects invalid parameters and inputs loudly', () => {
    expect(() => computeClimate(input, { ...params, axialTilt: Number.NaN })).toThrow();
    expect(() => computeClimate(input, { ...params, axialTilt: 120 })).toThrow();
    const bad = input.elev.slice();
    bad[17] = Number.NaN;
    expect(() => computeClimate({ ...input, elev: bad }, params)).toThrow(/not finite/);
  });
});

describe('climateInputFromSnapshot', () => {
  it('supersamples land fraction and land-aware elevation', () => {
    const mesh = smallMesh(4000);
    const snap = syntheticSnapshot(mesh, 3);
    const params = { ...DEFAULT_CLIMATE_PARAMS, gridW: 90, gridH: 45 };
    const input = climateInputFromSnapshot(mesh, snap, params);
    expect(input.w).toBe(90);
    expect(input.h).toBe(45);
    expect(input.sourceId).toBe(snap.id);
    expect(input.time).toBe(snap.time);
    let coastal = 0;
    let land = 0;
    for (let i = 0; i < 90 * 45; i++) {
      const lf = input.landFraction![i];
      expect(lf).toBeGreaterThanOrEqual(0);
      expect(lf).toBeLessThanOrEqual(1);
      expect(Number.isFinite(input.elev[i])).toBe(true);
      // Land-aware: the elevation is on the land side exactly when the cell is mostly land.
      if (lf >= 0.5) expect(input.elev[i]).toBeGreaterThan(params.seaLevel);
      else expect(input.elev[i]).toBeLessThanOrEqual(params.seaLevel);
      if (lf > 0 && lf < 1) coastal++;
      if (lf >= 0.5) land++;
    }
    expect(coastal).toBeGreaterThan(0);
    expect(land).toBeGreaterThan(0);
    // A higher sea level floods land.
    const flooded = climateInputFromSnapshot(mesh, snap, { ...params, seaLevel: 1500 });
    let land2 = 0;
    for (let i = 0; i < 90 * 45; i++) if (flooded.landFraction![i] >= 0.5) land2++;
    expect(land2).toBeLessThan(land);
  });
});
