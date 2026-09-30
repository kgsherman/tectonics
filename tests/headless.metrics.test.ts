import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildEarthClimateInput, EARTH_ZONAL_MEAN_TEMP, REFERENCE_CITIES } from '../src/climate/earthInput';
import { koppenIdFromCode } from '../src/climate/koppen';
import { CLIMATE_IMAGE_LAYERS, renderClimateLayer } from '../scripts/lib/climateImages';
import { computeEarthMetrics, evaluateCity, formatEarthReport, GROUPS, metricsToJson, scoreOf } from '../scripts/lib/earthMetrics';
import { LAPSE_RATE } from '../src/core/constants';
import { EARTH_IMAGE_JOBS, writeEarthOutputs } from '../scripts/lib/earthOutputs';
import { climateStats } from '../scripts/lib/headlessPipeline';
import { zonalClimate } from './helpers/fixtures';

const W = 180, H = 90;
const earth = buildEarthClimateInput(W, H);
const base = () => zonalClimate(W, H, earth.elev);

describe('Earth metrics', () => {
  it('produces finite, consistent metrics for an analytic climate', () => {
    const m = computeEarthMetrics(base());
    expect(m.zonal.length).toBe(18);
    for (const b of m.zonal) expect(Number.isFinite(b.model)).toBe(true);
    expect(Number.isFinite(m.zonalRmse)).toBe(true);
    expect(m.globalPrecip).toBeGreaterThan(0);
    const total = GROUPS.reduce((s, g) => s + m.groupAreas[g], 0);
    expect(total).toBeCloseTo(100, 6);
    expect(m.cities.length).toBe(REFERENCE_CITIES.length);
    expect(m.groupHitRate).toBeGreaterThanOrEqual(0);
    expect(m.groupHitRate).toBeLessThanOrEqual(1);
    expect(m.score).toBeCloseTo(scoreOf(m), 12);
    const text = formatEarthReport(m);
    expect(text).toContain('Zonal-mean annual temperature');
    expect(text).toContain('Reference cities');
    expect(JSON.parse(JSON.stringify(metricsToJson(m))).cities.length).toBe(REFERENCE_CITIES.length);
  });

  it('scores a climate that matches the observations perfectly', () => {
    const c = base();
    // Zonal T equal to the observed band means; every city cell carries its observed class.
    for (let r = 0; r < H; r++) {
      const lat = 90 - ((r + 0.5) * 180) / H;
      const band = Math.min(17, Math.floor((90 - lat) / 10));
      for (let col = 0; col < W; col++) c.tempAnnual[r * W + col] = EARTH_ZONAL_MEAN_TEMP[band];
    }
    for (const city of REFERENCE_CITIES) {
      const id = koppenIdFromCode(city.koppen);
      const r = Math.min(H - 1, Math.floor(((90 - city.lat) / 180) * H));
      const col = Math.floor(((city.lon + 180) / 360) * W) % W;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = Math.min(H - 1, Math.max(0, r + dr));
          const i = rr * W + ((col + dc + W) % W);
          c.koppenAll[i] = id;
          if (c.land[i]) c.koppen[i] = id;
        }
      }
    }
    // Neighbouring cities can share cells, so a few raw-cell classes get overwritten.
    const m = computeEarthMetrics(c);
    expect(m.zonalRmse).toBeLessThan(1e-4);
    expect(m.cellGroupHitRate).toBeGreaterThan(0.95);
    expect(m.cellCodeHitRate).toBeGreaterThan(0.9);
  });

  it('lapse-corrects city temperatures to the station elevation', () => {
    const c = base();
    const city = { name: 'Test', lat: 32.5, lon: 88.5, koppen: 'ET', elev: 0 };
    const i = Math.floor(((90 - city.lat) / 180) * H) * W + Math.floor(((city.lon + 180) / 360) * W);
    expect(c.land[i]).toBe(1);
    c.elev[i] = 4000;
    const hi = evaluateCity(c, { ...city, elev: 4000 });
    const lo = evaluateCity(c, city);
    expect(hi.tempAnnual).toBeCloseTo(c.tempAnnual[i], 4); // station at the cell height: unchanged
    expect(lo.tempAnnual - hi.tempAnnual).toBeCloseTo(4000 * LAPSE_RATE, 3);
    expect(hi.cellCode).toBe(lo.cellCode);
  });

  it('renders every climate layer without NaN (magenta) pixels', () => {
    const c = base();
    for (const layer of CLIMATE_IMAGE_LAYERS) {
      for (const month of [-1, 0, 6]) {
        const img = renderClimateLayer(layer, c, month, 2 * W, 2 * H);
        expect(img.width).toBe(2 * W);
        let magenta = 0;
        for (let i = 0; i < img.width * img.height; i++) {
          if (img.rgba[4 * i] === 255 && img.rgba[4 * i + 1] === 0 && img.rgba[4 * i + 2] === 255) magenta++;
        }
        expect(magenta, `${layer} month ${month}`).toBe(0);
      }
    }
  });

  it('summarizes climate stats for stats.json', () => {
    const s = climateStats(base());
    const total = Object.values(s.koppenGroupAreas).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(100, 0);
    expect(Number.isFinite(s.globalMeanTemp)).toBe(true);
  });

  it('writes the earth.ts report and images', () => {
    const out = 'scratch/headless/tests/earth';
    rmSync(out, { recursive: true, force: true });
    const c = base();
    const m = computeEarthMetrics(c);
    const text = writeEarthOutputs(out, c, m, { fast: true, computeMs: 0 }, 2);
    expect(readFileSync(join(out, 'report.txt'), 'utf8').trim()).toBe(text.trim());
    const json = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    expect(json.metrics.cities.length).toBe(REFERENCE_CITIES.length);
    for (const [, , name] of EARTH_IMAGE_JOBS) expect(existsSync(join(out, 'climate', `${name}.png`)), name).toBe(true);
  });
});
