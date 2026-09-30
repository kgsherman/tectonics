/**
 * Climate orchestrator (SPEC §6.3): snapshot → climate input, dynamics (dyn.ts) → hydrology
 * (hydrology.ts) → Köppen classification, statistics and a value-keyed id.
 */
import { buildMeshGridMap, meshToGrid } from '../core/grid';
import type { ClimateInput, ClimateParams, ClimateResult, KoppenGroup, MeshGridMap, SphereMesh, WorldSnapshot } from '../core/types';
import { computeDynamics } from './dyn';
import { computeHydrology } from './hydrology';
import type { DynamicsResult, HydrologyResult } from './internal';
import { KOPPEN_CLASSES, classifyKoppen } from './koppen';
import { nearestValidIndex } from './numerics';
import { applySurfaceInversion } from './surfaceInversion';

const now = (): number => globalThis.performance?.now?.() ?? Date.now();

export const DEFAULT_CLIMATE_PARAMS: ClimateParams = {
  gridW: 360,
  gridH: 180,
  axialTilt: 23.44,
  solarMultiplier: 1,
  globalTempOffset: 0,
  seaLevel: 0,
  moisture: 1,
  oceanCurrents: 1,
  retrograde: false,
  fast: false,
};

/**
 * A ClimateResult as produced by computeClimate: it additionally carries the hydrology's column
 * relative humidity so a later call can warm-start the moisture solver (not part of the contract;
 * absent on results from other producers).
 */
interface ClimateResultWithHydro extends ClimateResult {
  hydroRh?: Float32Array;
}

/* ------------------------------------------------------------------ */
/* Snapshot → climate input                                            */
/* ------------------------------------------------------------------ */

/** Grid maps per mesh (meshes are immutable) and supersampled size, most recently used last. */
const gridMapCache = new WeakMap<SphereMesh, Map<string, MeshGridMap>>();
/** Sizes kept per mesh (a 1440×720 map is ~28 MB; the app uses a live and a full size). */
const GRID_MAPS_PER_MESH = 2;

function cachedGridMap(mesh: SphereMesh, w: number, h: number): MeshGridMap {
  let perMesh = gridMapCache.get(mesh);
  if (!perMesh) {
    perMesh = new Map();
    gridMapCache.set(mesh, perMesh);
  }
  const key = `${w}x${h}`;
  let map = perMesh.get(key);
  if (map) perMesh.delete(key);
  else {
    map = buildMeshGridMap(mesh, w, h);
    while (perMesh.size >= GRID_MAPS_PER_MESH) perMesh.delete(perMesh.keys().next().value!);
  }
  perMesh.set(key, map);
  return map;
}

/**
 * Resample a tectonic snapshot's elevation onto the climate grid (params.gridW x gridH) with
 * land-aware supersampling: the snapshot is interpolated onto a k-times finer grid, sub-samples
 * are classified against params.seaLevel, landFraction = area-weighted land share, and elev is the
 * mean land elevation where landFraction ≥ 0.5, else the mean sea-floor elevation.
 */
export function climateInputFromSnapshot(mesh: SphereMesh, snapshot: WorldSnapshot, params: ClimateParams): ClimateInput {
  const W = Math.max(4, Math.round(params.gridW));
  const H = Math.max(2, Math.round(params.gridH));
  if (snapshot.n !== mesh.n || snapshot.elev.length < mesh.n) {
    throw new Error(`climateInputFromSnapshot: snapshot has ${snapshot.n} cells, mesh has ${mesh.n}`);
  }
  const k = Math.max(2, Math.min(4, Math.floor(1440 / W)));
  const fw = W * k;
  const fh = H * k;
  const map = cachedGridMap(mesh, fw, fh);
  const fine = meshToGrid(map, snapshot.elev);
  const sea = params.seaLevel;
  const elev = new Float32Array(W * H);
  const landFraction = new Float32Array(W * H);
  const rowW = new Float64Array(fh);
  for (let r = 0; r < fh; r++) rowW[r] = Math.cos(Math.PI / 2 - ((r + 0.5) * Math.PI) / fh);
  for (let R = 0; R < H; R++) {
    for (let C = 0; C < W; C++) {
      let lw = 0, ls = 0, sw = 0, ss = 0;
      for (let a = 0; a < k; a++) {
        const r = R * k + a;
        const wr = rowW[r];
        const base = r * fw + C * k;
        for (let b = 0; b < k; b++) {
          const e = fine[base + b];
          if (e > sea) {
            lw += wr;
            ls += wr * e;
          } else {
            sw += wr;
            ss += wr * e;
          }
        }
      }
      const i = R * W + C;
      const lf = lw / (lw + sw);
      landFraction[i] = lf;
      elev[i] = lf >= 0.5 ? ls / lw : ss / sw;
    }
  }
  return { w: W, h: H, elev, landFraction, sourceId: snapshot.id, time: snapshot.time };
}

/* ------------------------------------------------------------------ */
/* Full climate                                                         */
/* ------------------------------------------------------------------ */

function checkParams(p: ClimateParams): void {
  const finite: Array<keyof ClimateParams> = ['gridW', 'gridH', 'axialTilt', 'solarMultiplier', 'globalTempOffset', 'seaLevel', 'moisture', 'oceanCurrents'];
  for (const key of finite) {
    if (!Number.isFinite(p[key] as number)) throw new Error(`computeClimate: params.${key} must be finite (got ${String(p[key])})`);
  }
  if (p.gridW < 4 || p.gridH < 2) throw new Error(`computeClimate: grid ${p.gridW}x${p.gridH} too small`);
  if (p.axialTilt < 0 || p.axialTilt > 90) throw new Error(`computeClimate: axialTilt ${p.axialTilt} outside 0..90°`);
  if (p.solarMultiplier < 0 || p.moisture < 0 || p.oceanCurrents < 0) throw new Error('computeClimate: multipliers must be ≥ 0');
}

/**
 * Full monthly climate (SPEC.md §6): insolation → coupled seasonal energy balance (land, mixed-layer
 * ocean, sea ice) → pressure & winds → wind-driven ocean currents & upwelling → SST/air temperature
 * with advection → moisture transport & precipitation (computeHydrology) → Köppen.
 * Pure and deterministic: same (input, params, warmStart) ⇒ same result.
 * `warmStart` (a previous result on the same w×h grid) initializes the iterative solvers so `fast`
 * mode converges toward the full solution; ignored if the grid size differs.
 */
export function computeClimate(
  input: ClimateInput,
  params: ClimateParams,
  onProgress?: (stage: string, fraction: number) => void,
  warmStart?: ClimateResult | null,
): ClimateResult {
  const t0 = now();
  checkParams(params);
  const P: ClimateParams = { ...params, gridW: Math.round(params.gridW), gridH: Math.round(params.gridH) };
  const warm = warmStart && warmStart.w === P.gridW && warmStart.h === P.gridH ? (warmStart as ClimateResultWithHydro) : null;

  onProgress?.('dynamics', 0);
  const dyn = computeDynamics(input, P, warm, (f) => onProgress?.('dynamics', f));
  const tDyn = now();

  onProgress?.('hydrology', 0);
  const hydroWarm: HydrologyResult | null =
    warm && warm.hydroRh && warm.hydroRh.length === warm.precip.length
      ? { precip: warm.precip, evap: warm.evap, snow: warm.snow, cloud: warm.cloud, rh: warm.hydroRh, timings: {}, stats: {} }
      : null;
  const hydro = computeHydrology(dyn, hydroWarm, (f) => onProgress?.('hydrology', f));
  const tHydro = now();

  onProgress?.('koppen', 0);
  const result = assemble(input, P, dyn, hydro, warm);
  const tEnd = now();
  result.timings = {
    ...dyn.timings,
    ...hydro.timings,
    dynamics: tDyn - t0,
    hydrology: tHydro - tDyn,
    koppen: tEnd - tHydro,
    total: tEnd - t0,
  };
  onProgress?.('done', 1);
  return result;
}

function assemble(input: ClimateInput, params: ClimateParams, dyn: DynamicsResult, hydro: HydrologyResult, warm: ClimateResult | null): ClimateResultWithHydro {
  const { w, h } = dyn;
  const N = w * h;
  const stats: Record<string, number> = {};
  let filled = 0;
  const monthly = (name: string, f: Float32Array): Float32Array => {
    filled += fillNonFinite(f, w, h, 12, name);
    return f;
  };
  const temp = monthly('temp', dyn.temp);
  const precip = monthly('precip', hydro.precip);
  const evap = monthly('evap', hydro.evap);
  const snow = monthly('snow', hydro.snow);
  const cloud = monthly('cloud', hydro.cloud);
  const pressure = monthly('pressure', dyn.pressure);
  const windU = monthly('windU', dyn.windU);
  const windV = monthly('windV', dyn.windV);
  const sst = monthly('sst', dyn.sst);
  const seaIce = monthly('seaIce', dyn.seaIce);
  const currentU = monthly('currentU', dyn.currentU);
  const currentV = monthly('currentV', dyn.currentV);
  stats.nonFiniteFilled = filled;
  // Near-surface temperature under snow-surface inversions (diagnostic; after the hydrology, which
  // works with the boundary-layer air mass).
  applySurfaceInversion(temp, snow, dyn.land, w, h, params, dyn.surfaceHeight, cloud);

  // Köppen (every cell) and annual means.
  const koppen = new Uint8Array(N);
  const koppenAll = new Uint8Array(N);
  const tempAnnual = new Float32Array(N);
  const precipAnnual = new Float32Array(N);
  const tt = new Float64Array(12);
  const pp = new Float64Array(12);
  for (let r = 0; r < h; r++) {
    const southern = r >= h / 2;
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      let ts = 0;
      let ps = 0;
      for (let m = 0; m < 12; m++) {
        tt[m] = temp[m * N + i];
        pp[m] = Math.max(0, precip[m * N + i]);
        ts += tt[m];
        ps += pp[m];
      }
      tempAnnual[i] = ts / 12;
      precipAnnual[i] = ps;
      const k = classifyKoppen(tt, pp, southern);
      koppenAll[i] = k;
      koppen[i] = dyn.land[i] ? k : 0;
    }
  }

  collectStats(w, h, dyn, temp, evap, tempAnnual, precipAnnual, koppen, stats);
  for (const [k, v] of Object.entries(dyn.stats)) stats[`dyn.${k}`] = v;
  for (const [k, v] of Object.entries(hydro.stats)) stats[`hydro.${k}`] = v;

  return {
    id: climateId(input, params, warm),
    sourceSnapshotId: input.sourceId ?? 0,
    sourceTime: input.time ?? 0,
    w,
    h,
    params: { ...params },
    land: dyn.land,
    landFraction: dyn.landFraction,
    elev: dyn.elev,
    temp,
    precip,
    evap,
    snow,
    cloud,
    pressure,
    windU,
    windV,
    sst,
    seaIce,
    currentU,
    currentV,
    koppen,
    koppenAll,
    tempAnnual,
    precipAnnual,
    timings: {},
    stats,
    hydroRh: hydro.rh,
  };
}

/**
 * Replace non-finite values of each monthly slice by the nearest finite value of the same month
 * (safety net; the count is reported in stats.nonFiniteFilled). A month with no finite value at
 * all is an upstream failure and throws.
 */
function fillNonFinite(f: Float32Array, w: number, h: number, months: number, name: string): number {
  const N = w * h;
  let total = 0;
  for (let m = 0; m < months; m++) {
    const off = m * N;
    let bad = 0;
    for (let i = 0; i < N; i++) if (!Number.isFinite(f[off + i])) bad++;
    if (bad === 0) continue;
    if (bad === N) throw new Error(`computeClimate: field ${name} month ${m} has no finite values`);
    const valid = new Uint8Array(N);
    for (let i = 0; i < N; i++) valid[i] = Number.isFinite(f[off + i]) ? 1 : 0;
    const near = nearestValidIndex(w, h, valid);
    for (let i = 0; i < N; i++) if (!valid[i]) f[off + i] = f[off + near[i]];
    total += bad;
  }
  return total;
}

function collectStats(
  w: number,
  h: number,
  dyn: DynamicsResult,
  temp: Float32Array,
  evap: Float32Array,
  tempAnnual: Float32Array,
  precipAnnual: Float32Array,
  koppen: Uint8Array,
  stats: Record<string, number>,
): void {
  const N = w * h;
  const rowW = new Float64Array(h);
  let wSum = 0;
  for (let r = 0; r < h; r++) {
    rowW[r] = Math.cos(Math.PI / 2 - ((r + 0.5) * Math.PI) / h);
    wSum += rowW[r] * w;
  }
  let gT = 0, lT = 0, lW = 0, oT = 0, oW = 0, gP = 0, gE = 0;
  const groupArea: Record<KoppenGroup, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, ocean: 0 };
  for (let r = 0; r < h; r++) {
    const wr = rowW[r];
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      gT += wr * tempAnnual[i];
      gP += wr * precipAnnual[i];
      let e = 0;
      for (let m = 0; m < 12; m++) e += evap[m * N + i];
      gE += wr * e;
      if (dyn.land[i]) {
        lT += wr * tempAnnual[i];
        lW += wr;
        groupArea[KOPPEN_CLASSES[koppen[i]].group] += wr;
      } else {
        oT += wr * tempAnnual[i];
        oW += wr;
      }
    }
  }
  stats.globalMeanTemp = gT / wSum;
  stats.landMeanTemp = lW > 0 ? lT / lW : 0;
  stats.oceanMeanTemp = oW > 0 ? oT / oW : 0;
  stats.landAreaFraction = lW / wSum;
  stats.globalPrecipMm = gP / wSum;
  stats.globalEvapMm = gE / wSum;
  stats.pMinusEError = gE > 0 ? Math.abs(gP - gE) / gE : 0;
  for (const g of ['A', 'B', 'C', 'D', 'E'] as const) stats[`koppenArea${g}`] = lW > 0 ? (100 * groupArea[g]) / lW : 0;
  // Zonal-mean annual temperature in 10° bands (key: band center latitude).
  for (let lat = -85; lat <= 85; lat += 10) {
    let s = 0, ww = 0;
    for (let r = 0; r < h; r++) {
      const la = 90 - ((r + 0.5) * 180) / h;
      if (la < lat - 5 || la >= lat + 5) continue;
      for (let c = 0; c < w; c++) {
        s += rowW[r] * tempAnnual[r * w + c];
        ww += rowW[r];
      }
    }
    stats[`zonalMeanTemp${lat}`] = ww > 0 ? s / ww : 0;
  }
  // Seasonal extremes of the zonal means (Jan / Jul) as a compact check.
  let jan = 0, jul = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    jan += rowW[r] * temp[r * w + c];
    jul += rowW[r] * temp[6 * N + r * w + c];
  }
  stats.globalMeanTempJan = jan / wSum;
  stats.globalMeanTempJul = jul / wSum;
}

/** 32-bit value hash of the input, params and warm-start id (never 0). */
function climateId(input: ClimateInput, params: ClimateParams, warm: ClimateResult | null): number {
  let h1 = 0x811c9dc5 ^ input.w;
  let h2 = 0x9e3779b9 ^ input.h;
  const mix = (v: number): void => {
    h1 = Math.imul(h1 ^ v, 0x01000193);
    h2 = Math.imul(h2 ^ (v >>> 7) ^ (v << 11), 0x5bd1e995);
  };
  const bits = new Uint32Array(input.elev.buffer, input.elev.byteOffset, input.elev.length);
  for (let i = 0; i < bits.length; i++) mix(bits[i]);
  if (input.landFraction) {
    const lb = new Uint32Array(input.landFraction.buffer, input.landFraction.byteOffset, input.landFraction.length);
    for (let i = 0; i < lb.length; i++) mix(lb[i]);
  }
  const text = JSON.stringify(params) + `|${input.sourceId ?? 0}|${input.time ?? 0}|${warm ? warm.id : 0}`;
  for (let i = 0; i < text.length; i++) mix(text.charCodeAt(i));
  const id = (h1 ^ Math.imul(h2, 0x27d4eb2d)) >>> 0;
  return id === 0 ? 1 : id;
}
