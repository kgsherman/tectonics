/**
 * Input preparation for the dynamics: the climate input on the output grid (gridW×gridH, resampled
 * if the input has another size), its aggregation onto the core grid, and warm-start states.
 */
import { LAPSE_RATE } from '../core/constants';
import type { ClimateInput, ClimateParams } from '../core/types';
import { makeBilinearStencil, makeGrid, makeOverlapRegrid, overlapAverage, applyBilinear, type LatLonGrid } from './dynGrid';
import { syncOceanAirT, type EbmModel, type EbmState } from './energy';
import { ebmTuning } from './tuning';

/** Climate input on the output grid. */
export interface OutputSurface {
  w: number;
  h: number;
  elev: Float32Array;
  landFraction: Float32Array;
  land: Uint8Array;
  /** max(0, elev − seaLevel) on land, 0 on ocean. */
  surfaceHeight: Float32Array;
}

/** Core-grid surface description. */
export interface CoreSurface {
  g: LatLonGrid;
  landFraction: Float64Array;
  land: Uint8Array;
  /** Mean land surface height above sea level (m) of the land part; 0 for ocean cells. */
  height: Float64Array;
}


/** Bring the input onto the output grid (params.gridW × gridH). */
export function prepareOutputSurface(input: ClimateInput, params: ClimateParams): OutputSurface {
  const w = Math.max(4, Math.round(params.gridW));
  const h = Math.max(2, Math.round(params.gridH));
  if (!(input.w > 0 && input.h > 0) || input.elev.length < input.w * input.h) {
    throw new Error(`climate input has invalid size ${input.w}x${input.h} (elev length ${input.elev.length})`);
  }
  const N = w * h;
  const srcN = input.w * input.h;
  const srcLf = new Float64Array(srcN);
  const srcElev = new Float64Array(srcN);
  for (let i = 0; i < srcN; i++) {
    const e = input.elev[i];
    if (!Number.isFinite(e)) throw new Error(`climate input elevation is not finite at cell ${i} (${e})`);
    srcElev[i] = e;
    const lf = input.landFraction ? input.landFraction[i] : e > params.seaLevel ? 1 : 0;
    if (!Number.isFinite(lf)) throw new Error(`climate input landFraction is not finite at cell ${i} (${lf})`);
    srcLf[i] = Math.min(1, Math.max(0, lf));
  }
  const elev = new Float32Array(N);
  const landFraction = new Float32Array(N);
  if (input.w === w && input.h === h) {
    for (let i = 0; i < N; i++) {
      elev[i] = srcElev[i];
      landFraction[i] = srcLf[i];
    }
  } else if (input.w >= w && input.h >= h) {
    // Downsample: land-aware means (land elevation over land parts, sea floor over sea parts).
    const R = makeOverlapRegrid(input.w, input.h, w, h);
    const lf = overlapAverage(R, srcLf, null, new Float64Array(N));
    const seaW = new Float64Array(srcN);
    for (let i = 0; i < srcN; i++) seaW[i] = 1 - srcLf[i];
    const eLand = overlapAverage(R, srcElev, srcLf, new Float64Array(N), NaN);
    const eSea = overlapAverage(R, srcElev, seaW, new Float64Array(N), NaN);
    for (let i = 0; i < N; i++) {
      landFraction[i] = lf[i];
      // The chosen side always has positive weight (lf ≥ 0.5 resp. 1 − lf > 0.5).
      elev[i] = lf[i] >= 0.5 ? eLand[i] : eSea[i];
    }
  } else {
    const S = makeBilinearStencil(input.w, input.h, w, h);
    applyBilinear(S, srcElev, 0, elev, 0);
    applyBilinear(S, srcLf, 0, landFraction, 0);
  }
  const land = new Uint8Array(N);
  const surfaceHeight = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    land[i] = landFraction[i] >= 0.5 ? 1 : 0;
    surfaceHeight[i] = land[i] ? Math.max(0, elev[i] - params.seaLevel) : 0;
  }
  return { w, h, elev, landFraction, land, surfaceHeight };
}

/** Aggregate the output surface onto the nx×ny core grid (conservative area overlap). */
export function prepareCoreSurface(out: OutputSurface, nx: number, ny: number): CoreSurface {
  const g = makeGrid(nx, ny);
  const R = makeOverlapRegrid(out.w, out.h, nx, ny);
  const lf = overlapAverage(R, out.landFraction, null, new Float64Array(g.n));
  const hLand = overlapAverage(R, out.surfaceHeight, out.landFraction, new Float64Array(g.n), 0);
  const land = new Uint8Array(g.n);
  const height = new Float64Array(g.n);
  for (let i = 0; i < g.n; i++) {
    land[i] = lf[i] >= 0.5 ? 1 : 0;
    height[i] = land[i] ? hLand[i] : 0;
  }
  return { g, landFraction: lf, land, height };
}

/** Fields of a previous result used to warm-start (ClimateResult or DynamicsResult). */
export interface WarmFields {
  w: number;
  h: number;
  temp: Float32Array;
  sst: Float32Array;
  seaIce: Float32Array;
  land: Uint8Array;
  elev: Float32Array;
  params: ClimateParams;
}

/** Build a Jan 1 core state from a previous result's Dec/Jan means. Returns false if unusable. */
export function warmState(M: EbmModel, core: CoreSurface, warm: WarmFields, S: EbmState): boolean {
  const N = warm.w * warm.h;
  if (warm.temp.length < 12 * N || warm.sst.length < 12 * N || warm.seaIce.length < 12 * N) return false;
  if (warm.land.length < N || warm.elev.length < N || !warm.params) return false;
  const tSl = new Float64Array(N);
  const sst = new Float64Array(N);
  const ice = new Float64Array(N);
  const isLand = new Float64Array(N);
  const isSea = new Float64Array(N);
  const off = warm.params.globalTempOffset || 0;
  for (let i = 0; i < N; i++) {
    const hgt = warm.land[i] ? Math.max(0, warm.elev[i] - warm.params.seaLevel) : 0;
    const t = 0.5 * (warm.temp[i] + warm.temp[11 * N + i]) - off;
    tSl[i] = Number.isFinite(t) ? t + LAPSE_RATE * hgt : 0;
    const s = 0.5 * (warm.sst[i] + warm.sst[11 * N + i]) - off;
    sst[i] = Number.isFinite(s) ? s : 0;
    const a = 0.5 * (warm.seaIce[i] + warm.seaIce[11 * N + i]);
    ice[i] = Number.isFinite(a) ? a : 0;
    isLand[i] = warm.land[i] ? 1 : 0;
    isSea[i] = 1 - isLand[i];
  }
  const g = core.g;
  const R = makeOverlapRegrid(warm.w, warm.h, g.nx, g.ny);
  const tAll = overlapAverage(R, tSl, null, new Float64Array(g.n));
  const tLand = overlapAverage(R, tSl, isLand, new Float64Array(g.n), NaN);
  const tSea = overlapAverage(R, tSl, isSea, new Float64Array(g.n), NaN);
  const sstC = overlapAverage(R, sst, isSea, new Float64Array(g.n), NaN);
  const iceC = overlapAverage(R, ice, isSea, new Float64Array(g.n), NaN);
  // Annual means: surface air temperature (land memory Tann) and ice fraction (how perennial the
  // pack is; the result carries no thickness).
  const annT = new Float64Array(N);
  const iceAnn = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let sum = 0;
    let sumIce = 0;
    for (let m = 0; m < 12; m++) {
      sum += warm.temp[m * N + i];
      sumIce += warm.seaIce[m * N + i];
    }
    annT[i] = Number.isFinite(sum) ? sum / 12 - off : 0;
    iceAnn[i] = Number.isFinite(sumIce) ? sumIce / 12 : 0;
  }
  const annC = overlapAverage(R, annT, null, new Float64Array(g.n));
  const annLand = overlapAverage(R, annT, isLand, new Float64Array(g.n), NaN);
  const iceAnnC = overlapAverage(R, iceAnn, isSea, new Float64Array(g.n), NaN);
  const t = ebmTuning;
  for (let j = 0; j < g.ny; j++) {
    const Co = M.cOcean[j];
    for (let c = 0; c < g.nx; c++) {
      const i = j * g.nx + c;
      if (core.land[i]) {
        S.T[i] = Number.isFinite(tLand[i]) ? tLand[i] : tAll[i];
        S.E[i] = 0;
        S.Ti[i] = 0;
        continue;
      }
      const s = Number.isFinite(sstC[i]) ? sstC[i] : Math.max(t.freezeT, tAll[i]);
      const a = Math.min(1, Number.isFinite(iceC[i]) ? iceC[i] : tAll[i] < t.freezeT - 4 ? 1 : 0);
      const ta = Number.isFinite(tSea[i]) ? tSea[i] : tAll[i];
      if (a > 0.02) {
        // Partial cover: the fraction model's own enthalpy (a = −E/E_full; the former 1.5·a
        // overstated the cover). Full cover: 1–1.5 m, thicker for perennial ice.
        const aAnn = Number.isFinite(iceAnnC[i]) ? Math.min(1, iceAnnC[i]) : a;
        S.E[i] = -M.eFull * (a < 0.98 ? a : 1 + 0.5 * aAnn);
        // Ice-surface temperature from the air over the ice part, bounded (the inversion of the
        // blend amplifies noise when the fraction is small).
        const ti = (ta - (1 - a) * t.freezeT) / a;
        S.Ti[i] = Math.min(t.freezeT, Math.max(Math.min(ta, t.freezeT) - 15, ti));
      } else {
        S.E[i] = Co * Math.max(0, s - t.freezeT);
        S.Ti[i] = t.freezeT;
      }
    }
  }
  syncOceanAirT(M, S);
  // Annual-mean surface temperature memory; land cells take the land part only (it decides ice
  // sheet vs seasonal snow at the coasts).
  for (let i = 0; i < g.n; i++) S.Tann[i] = core.land[i] && Number.isFinite(annLand[i]) ? annLand[i] : annC[i];
  return true;
}
