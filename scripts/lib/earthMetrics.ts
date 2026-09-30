/**
 * Earth validation metrics for a ClimateResult computed on buildEarthClimateInput (SPEC §6.4):
 * zonal-mean temperature vs observations, global precipitation, Köppen group areas over land vs
 * Beck et al. (2018) and reference-city hit rates.
 */
import {
  EARTH_GLOBAL_PRECIP_MM, EARTH_KOPPEN_GROUP_TARGETS, EARTH_ZONAL_MEAN_TEMP, REFERENCE_CITIES, type ReferenceCity,
} from '../../src/climate/earthInput';
import { classifyKoppen, KOPPEN_CLASSES } from '../../src/climate/koppen';
import { LAPSE_RATE } from '../../src/core/constants';
import type { ClimateResult } from '../../src/core/types';
import { areaMean, cellAt, rowAreaWeights, rowLatDeg } from './gridUtil';

export type Group = 'A' | 'B' | 'C' | 'D' | 'E';
export const GROUPS: readonly Group[] = ['A', 'B', 'C', 'D', 'E'];

export interface ZonalBand {
  latTop: number;
  latBottom: number;
  model: number;
  observed: number;
}

export interface CityResult {
  city: ReferenceCity;
  /**
   * Model class with the 12 monthly temperatures lapse-corrected from the cell's surface height to
   * the station elevation (city.elev; the cell height when unknown). Primary validation measure.
   */
  code: string;
  groupHit: boolean;
  codeHit: boolean;
  /** Model class of the raw grid cell (koppen / koppenAll), no elevation correction. */
  cellCode: string;
  cellGroupHit: boolean;
  cellCodeHit: boolean;
  /** Grid cell used and whether the city's own cell was ocean (a land neighbour was used). */
  cell: number;
  movedToLand: boolean;
  /** Cell elevation (m). */
  elev: number;
  /** Annual mean / coldest / warmest month T at station elevation (°C); annual P of the cell (mm). */
  tempAnnual: number;
  tempMin: number;
  tempMax: number;
  precipAnnual: number;
}

export interface EarthMetrics {
  zonal: ZonalBand[];
  /** RMSE of zonal-mean annual T over the 18 bands (°C), cos-latitude weighted. */
  zonalRmse: number;
  globalMeanTemp: number;
  /** Area-weighted global-mean precipitation (mm/yr). */
  globalPrecip: number;
  /** Köppen group shares of the land area (%). */
  groupAreas: Record<Group, number>;
  /** Σ|model − target| over the 5 groups (percentage points). */
  groupAreaError: number;
  cities: CityResult[];
  /** Hit rates at station elevation (CityResult.code). */
  groupHitRate: number;
  codeHitRate: number;
  /** Hit rates of the raw grid cells (CityResult.cellCode). */
  cellGroupHitRate: number;
  cellCodeHitRate: number;
  /** Per observed group: [hits, total] (station elevation). */
  groupHitsByGroup: Record<Group, [number, number]>;
  /** Weighted sum of normalized errors (lower is better); see scoreOf(). */
  score: number;
}

const groupOf = (id: number): Group | null => {
  const g = KOPPEN_CLASSES[id]?.group;
  return g && g !== 'ocean' ? g : null;
};

/** Zonal-mean annual temperature per 10° band (area-weighted over all cells). */
export function zonalMeanTemperature(c: ClimateResult): ZonalBand[] {
  const { w, h } = c;
  const aw = rowAreaWeights(h);
  const sum = new Float64Array(18), area = new Float64Array(18);
  for (let r = 0; r < h; r++) {
    const b = Math.min(17, Math.floor((90 - rowLatDeg(h, r)) / 10));
    for (let col = 0; col < w; col++) {
      sum[b] += aw[r] * c.tempAnnual[r * w + col];
      area[b] += aw[r];
    }
  }
  return EARTH_ZONAL_MEAN_TEMP.map((obs, b) => ({
    latTop: 90 - 10 * b,
    latBottom: 80 - 10 * b,
    model: area[b] > 0 ? sum[b] / area[b] : NaN,
    observed: obs,
  }));
}

/** Köppen group shares of the land area (%), from `koppen` (0 = ocean). */
export function koppenGroupAreas(c: ClimateResult): Record<Group, number> {
  const { w, h } = c;
  const aw = rowAreaWeights(h);
  const acc: Record<Group, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  let total = 0;
  for (let r = 0; r < h; r++) {
    for (let col = 0; col < w; col++) {
      const g = groupOf(c.koppen[r * w + col]);
      if (!g) continue;
      acc[g] += aw[r];
      total += aw[r];
    }
  }
  for (const g of GROUPS) acc[g] = total > 0 ? (100 * acc[g]) / total : 0;
  return acc;
}

/** The city's own cell if land, else the nearest land cell among its 8 neighbours, else its own cell. */
function cityCell(c: ClimateResult, city: ReferenceCity): { cell: number; moved: boolean } {
  const { w, h } = c;
  const own = cellAt(w, h, city.lat, city.lon);
  if (c.land[own]) return { cell: own, moved: false };
  const r0 = Math.floor(own / w), c0 = own % w;
  const fr = ((90 - city.lat) / 180) * h - 0.5, fc = ((city.lon + 180) / 360) * w - 0.5;
  let best = Infinity, cell = own;
  for (let dr = -1; dr <= 1; dr++) {
    const r = r0 + dr;
    if (r < 0 || r >= h) continue;
    for (let dc = -1; dc <= 1; dc++) {
      const i = r * w + ((c0 + dc + w) % w);
      if (!c.land[i]) continue;
      const d = (r - fr) ** 2 + (c0 + dc - fc) ** 2;
      if (d < best) {
        best = d;
        cell = i;
      }
    }
  }
  return { cell, moved: cell !== own };
}

/**
 * Model class at a city (see cityCell): the raw cell class, and the class after lapse-correcting the
 * monthly temperatures to the station elevation and re-running classifyKoppen.
 */
export function evaluateCity(c: ClimateResult, city: ReferenceCity): CityResult {
  const { w, h } = c;
  const n = w * h;
  const { cell, moved } = cityCell(c, city);
  const cellId = c.land[cell] ? c.koppen[cell] || c.koppenAll[cell] : c.koppenAll[cell];
  const cellCode = KOPPEN_CLASSES[cellId]?.code ?? '?';
  // Temperatures refer to the land surface height on land cells and to sea level over ocean.
  const sea = c.params.seaLevel;
  const cellHeight = c.land[cell] ? Math.max(0, c.elev[cell] - sea) : 0;
  const stationHeight = Math.max(0, (city.elev ?? c.elev[cell]) - sea);
  const dT = LAPSE_RATE * (cellHeight - stationHeight);
  const t12 = new Float32Array(12), p12 = new Float32Array(12);
  let tMin = Infinity, tMax = -Infinity, tSum = 0;
  for (let m = 0; m < 12; m++) {
    const t = c.temp[m * n + cell] + dT;
    t12[m] = t;
    p12[m] = c.precip[m * n + cell];
    tSum += t;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  const code = KOPPEN_CLASSES[classifyKoppen(t12, p12, city.lat < 0)]?.code ?? '?';
  const obsGroup = city.koppen[0];
  return {
    city, code, cellCode, cell, movedToLand: moved,
    groupHit: code[0] === obsGroup,
    codeHit: code === city.koppen,
    cellGroupHit: cellCode[0] === obsGroup,
    cellCodeHit: cellCode === city.koppen,
    elev: c.elev[cell],
    tempAnnual: tSum / 12,
    tempMin: tMin,
    tempMax: tMax,
    precipAnnual: c.precipAnnual[cell],
  };
}

/**
 * Composite score (lower is better): zonal T RMSE / 3 °C + |P − 1000| / 150 mm + group-area L1 / 30 pp
 * + 2·(1 − group hit rate) + (1 − code hit rate). Each term ≈ 1 at the edge of "acceptable".
 */
export function scoreOf(m: Pick<EarthMetrics, 'zonalRmse' | 'globalPrecip' | 'groupAreaError' | 'groupHitRate' | 'codeHitRate'>): number {
  return (
    m.zonalRmse / 3 +
    Math.abs(m.globalPrecip - EARTH_GLOBAL_PRECIP_MM) / 150 +
    m.groupAreaError / 30 +
    2 * (1 - m.groupHitRate) +
    (1 - m.codeHitRate)
  );
}

export function computeEarthMetrics(c: ClimateResult, cities: readonly ReferenceCity[] = REFERENCE_CITIES): EarthMetrics {
  const zonal = zonalMeanTemperature(c);
  let se = 0, sw = 0;
  for (const b of zonal) {
    const wgt = Math.cos(((b.latTop + b.latBottom) / 2) * (Math.PI / 180));
    se += wgt * (b.model - b.observed) ** 2;
    sw += wgt;
  }
  const groupAreas = koppenGroupAreas(c);
  let groupAreaError = 0;
  for (const g of GROUPS) groupAreaError += Math.abs(groupAreas[g] - EARTH_KOPPEN_GROUP_TARGETS[g]);
  const results = cities.map((city) => evaluateCity(c, city));
  const groupHitsByGroup = { A: [0, 0], B: [0, 0], C: [0, 0], D: [0, 0], E: [0, 0] } as Record<Group, [number, number]>;
  for (const r of results) {
    const g = r.city.koppen[0] as Group;
    groupHitsByGroup[g][1]++;
    if (r.groupHit) groupHitsByGroup[g][0]++;
  }
  const rate = (f: (r: CityResult) => boolean): number => results.filter(f).length / Math.max(1, results.length);
  const partial = {
    zonalRmse: Math.sqrt(se / sw),
    globalPrecip: areaMean(c.precipAnnual, c.w, c.h),
    groupAreaError,
    groupHitRate: rate((r) => r.groupHit),
    codeHitRate: rate((r) => r.codeHit),
  };
  return {
    zonal,
    globalMeanTemp: areaMean(c.tempAnnual, c.w, c.h),
    groupAreas,
    cities: results,
    cellGroupHitRate: rate((r) => r.cellGroupHit),
    cellCodeHitRate: rate((r) => r.cellCodeHit),
    groupHitsByGroup,
    ...partial,
    score: scoreOf(partial),
  };
}

/* ------------------------------ text report ------------------------------ */

const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : String(v));
const pad = (s: string | number, n: number): string => String(s).padStart(n);
const padR = (s: string | number, n: number): string => String(s).padEnd(n);

/** Human-readable multi-section report. */
export function formatEarthReport(m: EarthMetrics): string {
  const L: string[] = [];
  L.push('Zonal-mean annual temperature (°C)');
  L.push('  band        model   obs    diff');
  for (const b of m.zonal) {
    const band = `${pad(b.latTop, 3)}..${pad(b.latBottom, 3)}`;
    L.push(`  ${padR(band, 10)} ${pad(f1(b.model), 6)} ${pad(f1(b.observed), 6)} ${pad(f1(b.model - b.observed), 6)}`);
  }
  L.push(`  RMSE (cos-weighted): ${f1(m.zonalRmse)} °C   global mean T: ${f1(m.globalMeanTemp)} °C`);
  L.push('');
  L.push(`Global-mean precipitation: ${f1(m.globalPrecip)} mm/yr (target ${EARTH_GLOBAL_PRECIP_MM} ± 150)`);
  L.push('');
  L.push('Köppen group share of land (%)');
  L.push('  group  model  target  diff');
  for (const g of GROUPS) {
    const t = EARTH_KOPPEN_GROUP_TARGETS[g];
    L.push(`  ${padR(g, 5)} ${pad(f1(m.groupAreas[g]), 6)} ${pad(t, 7)} ${pad(f1(m.groupAreas[g] - t), 6)}`);
  }
  L.push(`  L1 error: ${f1(m.groupAreaError)} pp`);
  L.push('');
  L.push(`Reference cities (T lapse-corrected to station elevation): group hit ${f1(100 * m.groupHitRate)}% (target ≥ 75), ` +
    `full code ${f1(100 * m.codeHitRate)}% (target ≥ 45)`);
  L.push(`  raw grid cell: group hit ${f1(100 * m.cellGroupHitRate)}%, full code ${f1(100 * m.cellCodeHitRate)}%`);
  L.push(`  by group: ${GROUPS.map((g) => `${g} ${m.groupHitsByGroup[g][0]}/${m.groupHitsByGroup[g][1]}`).join('  ')}`);
  L.push('');
  L.push('  city                 obs   model cell   cell_z stn_z  T_ann  T_min  T_max  P_ann   (T at station elevation)');
  for (const r of m.cities) {
    const mark = r.codeHit ? '==' : r.groupHit ? '~ ' : 'XX';
    L.push(
      `  ${padR(r.city.name, 20)} ${padR(r.city.koppen, 5)} ${padR(r.code, 5)} ${padR(r.cellCode, 5)} ${pad(Math.round(r.elev), 6)} ` +
        `${pad(r.city.elev ?? '', 5)} ${pad(f1(r.tempAnnual), 6)} ${pad(f1(r.tempMin), 6)} ${pad(f1(r.tempMax), 6)} ` +
        `${pad(Math.round(r.precipAnnual), 6)}  ${mark}${r.movedToLand ? ' (land nbr)' : ''}`,
    );
  }
  L.push('');
  L.push(`Composite score (lower is better): ${m.score.toFixed(3)}`);
  return L.join('\n');
}

/** Compact JSON-friendly form (cities flattened). */
export function metricsToJson(m: EarthMetrics): Record<string, unknown> {
  return {
    score: m.score,
    zonalRmse: m.zonalRmse,
    globalMeanTemp: m.globalMeanTemp,
    globalPrecip: m.globalPrecip,
    groupAreas: m.groupAreas,
    groupAreaError: m.groupAreaError,
    groupHitRate: m.groupHitRate,
    codeHitRate: m.codeHitRate,
    cellGroupHitRate: m.cellGroupHitRate,
    cellCodeHitRate: m.cellCodeHitRate,
    groupHitsByGroup: m.groupHitsByGroup,
    zonal: m.zonal,
    cities: m.cities.map((r) => ({
      name: r.city.name, lat: r.city.lat, lon: r.city.lon, stationElev: r.city.elev, observed: r.city.koppen,
      model: r.code, modelCell: r.cellCode, groupHit: r.groupHit, codeHit: r.codeHit,
      cellGroupHit: r.cellGroupHit, cellCodeHit: r.cellCodeHit, movedToLand: r.movedToLand, cellElev: r.elev,
      tempAnnual: r.tempAnnual, tempMin: r.tempMin, tempMax: r.tempMax, precipAnnual: r.precipAnnual,
    })),
  };
}
