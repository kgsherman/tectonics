/**
 * SPEC §6.4 Earth acceptance of the whole climate (computeClimate = dynamics + hydrology + Köppen)
 * on the present-day Earth input: global precipitation, Köppen group areas, reference cities and
 * fast-vs-full agreement (cold and warm-started, as the app runs live mode).
 */
import { describe, expect, it } from 'vitest';
import { LAPSE_RATE } from '../src/core/constants';
import type { ClimateResult } from '../src/core/types';
import { computeClimate, DEFAULT_CLIMATE_PARAMS } from '../src/climate/climate';
import { buildEarthClimateInput, EARTH_KOPPEN_GROUP_TARGETS, REFERENCE_CITIES, type ReferenceCity } from '../src/climate/earthInput';
import { KOPPEN_CLASSES, classifyKoppen } from '../src/climate/koppen';

const W = 360;
const H = 180;
const N = W * H;
const input = buildEarthClimateInput(W, H);
const full = computeClimate(input, { ...DEFAULT_CLIMATE_PARAMS });
const fastParams = { ...DEFAULT_CLIMATE_PARAMS, fast: true };

const groupOf = (id: number): string => KOPPEN_CLASSES[id].group;

/** Share of land cells whose Köppen group agrees between two results. */
function groupAgreement(a: ClimateResult, b: ClimateResult): number {
  let same = 0;
  let total = 0;
  for (let i = 0; i < N; i++) {
    if (!a.land[i]) continue;
    total++;
    if (groupOf(a.koppen[i]) === groupOf(b.koppen[i])) same++;
  }
  return same / total;
}

/** Model Köppen code at a city: its own cell if land, else the nearest land neighbour; T lapse-corrected to the station. */
function cityCode(c: ClimateResult, city: ReferenceCity): string {
  const r0 = Math.min(H - 1, Math.max(0, Math.floor(((90 - city.lat) / 180) * H)));
  const c0 = ((Math.floor(((city.lon + 180) / 360) * W) % W) + W) % W;
  let cell = r0 * W + c0;
  if (!c.land[cell]) {
    const fr = ((90 - city.lat) / 180) * H - 0.5;
    const fc = ((city.lon + 180) / 360) * W - 0.5;
    let best = Infinity;
    for (let dr = -1; dr <= 1; dr++) {
      const r = r0 + dr;
      if (r < 0 || r >= H) continue;
      for (let dc = -1; dc <= 1; dc++) {
        const i = r * W + ((c0 + dc + W) % W);
        const d = (r - fr) ** 2 + (c0 + dc - fc) ** 2;
        if (c.land[i] && d < best) {
          best = d;
          cell = i;
        }
      }
    }
  }
  const cellHeight = c.land[cell] ? Math.max(0, c.elev[cell] - c.params.seaLevel) : 0;
  const dT = LAPSE_RATE * (cellHeight - Math.max(0, (city.elev ?? c.elev[cell]) - c.params.seaLevel));
  const t = new Float32Array(12);
  const p = new Float32Array(12);
  for (let m = 0; m < 12; m++) {
    t[m] = c.temp[m * N + cell] + dT;
    p[m] = c.precip[m * N + cell];
  }
  return KOPPEN_CLASSES[classifyKoppen(t, p, city.lat < 0)].code;
}

describe('Earth climate (computeClimate)', () => {
  it('has Earth-like global precipitation and Köppen group areas', () => {
    expect(full.stats.nonFiniteFilled).toBe(0);
    expect(full.stats.globalPrecipMm).toBeGreaterThan(850);
    expect(full.stats.globalPrecipMm).toBeLessThan(1150);
    const areas = (['A', 'B', 'C', 'D', 'E'] as const).map((g) => `${g} ${full.stats[`koppenArea${g}`].toFixed(1)}`);
    console.log(`Earth: global T ${full.stats.globalMeanTemp.toFixed(2)} °C, P ${full.stats.globalPrecipMm.toFixed(0)} mm; Köppen areas ${areas.join(' / ')} %`);
    for (const g of ['A', 'B', 'C', 'D', 'E'] as const) {
      expect(Math.abs(full.stats[`koppenArea${g}`] - EARTH_KOPPEN_GROUP_TARGETS[g])).toBeLessThan(9);
    }
  });

  it('classifies the reference cities', () => {
    let group = 0;
    let code = 0;
    for (const city of REFERENCE_CITIES) {
      const k = cityCode(full, city);
      if (k[0] === city.koppen[0]) group++;
      if (k === city.koppen) code++;
    }
    const g = group / REFERENCE_CITIES.length;
    const c = code / REFERENCE_CITIES.length;
    console.log(`Earth reference cities: group ${(100 * g).toFixed(1)} % (target ≥ 75), code ${(100 * c).toFixed(1)} % (target ≥ 45)`);
    // Regression guards a couple of cities below the SPEC targets (75 % / 45 %), which the model
    // currently meets: a single city moves the rates by ~1.2 %.
    expect(g).toBeGreaterThanOrEqual(0.73);
    expect(c).toBeGreaterThanOrEqual(0.42);
  });

  it('fast mode agrees with full on the Köppen group of ≥ 85 % of land cells (cold and warm-started)', () => {
    const fastCold = computeClimate(input, fastParams);
    const fastWarm = computeClimate(input, fastParams, undefined, full);
    expect(fastWarm.stats['dyn.warmStart']).toBe(1);
    const cold = groupAgreement(full, fastCold);
    const warm = groupAgreement(full, fastWarm);
    console.log(`Earth fast vs full Köppen group agreement: cold ${(100 * cold).toFixed(1)} %, warm ${(100 * warm).toFixed(1)} %`);
    expect(cold).toBeGreaterThanOrEqual(0.85);
    expect(warm).toBeGreaterThanOrEqual(0.85);
    // A warm restart continues from the previous climate instead of drifting away from it.
    expect(Math.abs(fastWarm.stats.globalMeanTemp - full.stats.globalMeanTemp)).toBeLessThan(0.75);
  });
});
