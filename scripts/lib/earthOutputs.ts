/**
 * Files written by scripts/earth.ts for one Earth climate run: report.txt / report.json and a set of
 * reference images (Köppen with reference cities, T, P, SST, currents, winds, pressure, sea ice,
 * snow, clouds) under <out>/climate/.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KOPPEN_CLASSES, koppenIdFromCode } from '../../src/climate/koppen';
import type { ClimateResult, RGB } from '../../src/core/types';
import { blendPixel, drawMarker, writePng, type Image } from '../png';
import { renderClimateLayer, type ClimateImageLayer } from './climateImages';
import { formatEarthReport, metricsToJson, type EarthMetrics } from './earthMetrics';

/** [layer, month (−1 = annual), file stem] */
export const EARTH_IMAGE_JOBS: ReadonlyArray<readonly [ClimateImageLayer, number, string]> = [
  ['koppen', -1, 'koppen'],
  ['temperature', -1, 'temp_annual'], ['temperature', 0, 'temp_jan'], ['temperature', 6, 'temp_jul'],
  ['precipitation', -1, 'precip_annual'], ['precipitation', 0, 'precip_jan'], ['precipitation', 6, 'precip_jul'],
  ['sst', 0, 'sst_jan'], ['sst', 6, 'sst_jul'],
  ['currents', 0, 'currents_jan'], ['currents', 6, 'currents_jul'],
  ['wind', 0, 'wind_jan'], ['wind', 6, 'wind_jul'],
  ['pressure', 0, 'pressure_jan'], ['pressure', 6, 'pressure_jul'],
  ['seaIce', 2, 'seaice_mar'], ['seaIce', 8, 'seaice_sep'],
  ['snow', 0, 'snow_jan'], ['cloud', 0, 'cloud_jan'], ['cloud', 6, 'cloud_jul'],
];

export interface EarthOutputInfo {
  fast: boolean;
  computeMs: number;
}

/** Write report.txt, report.json and the reference images; returns the report text. */
export function writeEarthOutputs(out: string, c: ClimateResult, m: EarthMetrics, info: EarthOutputInfo, scale = 3): string {
  mkdirSync(out, { recursive: true });
  const report = formatEarthReport(m);
  writeFileSync(join(out, 'report.txt'), report + '\n');
  writeFileSync(
    join(out, 'report.json'),
    JSON.stringify({ size: [c.w, c.h], fast: info.fast, computeMs: info.computeMs, timings: c.timings, stats: c.stats, metrics: metricsToJson(m) }, null, 2),
  );
  const k = Math.max(1, Math.round(scale));
  const dir = join(out, 'climate');
  for (const [layer, month, name] of EARTH_IMAGE_JOBS) {
    const img = renderClimateLayer(layer, c, month, c.w * k, c.h * k);
    if (layer === 'koppen') drawCities(img, m);
    writePng(join(dir, `${name}.png`), img);
  }
  return report;
}

/** Cities: fill = observed class color; ring = green (code hit), yellow (group hit), red (miss). */
function drawCities(img: Image, m: EarthMetrics): void {
  const ring: RGB[] = [[230, 30, 30], [250, 210, 30], [30, 220, 60]];
  for (const r of m.cities) {
    const hit = r.codeHit ? 2 : r.groupHit ? 1 : 0;
    const x = ((r.city.lon + 180) / 360) * img.width - 0.5;
    const y = ((90 - r.city.lat) / 180) * img.height - 0.5;
    for (let dy = -5; dy <= 5; dy++) {
      for (let dx = -5; dx <= 5; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > 3.2 && d <= 5) blendPixel(img, x + dx, y + dy, ring[hit]);
      }
    }
    const id = koppenIdFromCode(r.city.koppen);
    drawMarker(img, r.city.lat, r.city.lon, 3, id > 0 ? KOPPEN_CLASSES[id].color : [255, 0, 255]);
  }
}
