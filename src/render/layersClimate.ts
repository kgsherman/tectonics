/**
 * Climate data layers: temperature (lapse-corrected to the displayed surface, 0 °C isotherm),
 * precipitation (log), pressure (isobars every 4 hPa, H / L centres), SST (+ sea ice), wind speed,
 * ocean currents (speed × warm/cold SST-anomaly tint, flow streamlets) and Köppen classes.
 *
 * Sampling (see layersSample): climate fields are split into land-extended and sea-extended grids,
 * cubic-B-spline resampled to the raster, and chosen per pixel by the height map (land iff
 * height > sea), with anti-aliased coasts from the height map's signed distance to sea level. So
 * the land/sea contrast of a field follows the high-resolution coastline instead of 1° cells.
 */
import * as _constants from '../core/constants';
import type { ClimateResult, PaintOptions, RGB } from '../core/types';
import * as _koppen from '../climate/koppen';
import * as _colormaps from './colormaps';
import * as _layersCommon from './layersCommon';
import * as _layersGlyphs from './layersGlyphs';
import * as _layersKoppen from './layersKoppen';
import * as _layersSample from './layersSample';
import type { PaintCache } from './paintCache';
import type { HeightField } from './terrain';

// Imported values are copied into module constants: some module runners (vitest / vite-node SSR)
// compile named imports into namespace property reads, which would otherwise sit in per-pixel loops.
const { LAPSE_RATE } = _constants;
const { KOPPEN_CLASSES } = _koppen;
const {
  CM_BATHY, CM_PRECIP_LOG, CM_PRESSURE, CM_SST, CM_TEMP, CM_WIND, CURRENT_LUT, SRGB_TO_LINEAR, cmapIndex, currentIndex, encodeSrgb,
} = _colormaps;
const { applyHillshade, drawCoastOutline, drawContours, putLut, putMixed } = _layersCommon;
const { AlphaLayer, drawStreamlets, drawText } = _layersGlyphs;
const { classifyPixels } = _layersKoppen;
const { COAST_Q, coastDistance, monthSlice, sampleSurfaces, scratchF32, splineSample } = _layersSample;

/** Quantized coast distance at or beyond which a pixel is purely land / sea (d ≥ 0.5 px). */
const HALF = COAST_Q / 2;

/** Relief-shading strength on land for the data layers (subtle context, legend colours dominate). */
const SHADE_LAND = 0.4;
/** Peak opacity of the coastline ink on continuous-field layers. */
const COAST_ALPHA = 0.55;

/** Per climate cell land reference height above the climate's sea level (m; 0 for ocean cells). */
function refHeight(c: ClimateResult, cache: PaintCache): Float32Array {
  return cache.getOrBuild(`href|${c.id}`, () => {
    const out = new Float32Array(c.w * c.h);
    const sea = c.params.seaLevel;
    for (let i = 0; i < out.length; i++) out[i] = c.land[i] ? Math.max(0, c.elev[i] - sea) : 0;
    return out;
  });
}

/** Scale for pixel-size-dependent strokes (1 at 2048 px wide). */
function strokeScale(w: number): number {
  return Math.max(0.6, Math.min(1.6, w / 2048));
}

/** Paint a split field: land pixels from `landV`, sea pixels from `seaV`, anti-aliased at the coast. */
function paintSplit(
  rgba: Uint8ClampedArray, qd: Int8Array, landV: Float32Array, seaV: Float32Array,
  lutL: Uint8Array, idxL: (v: number) => number, lutS: Uint8Array, idxS: (v: number) => number,
): void {
  for (let p = 0, n = qd.length; p < n; p++) {
    const q = qd[p];
    if (q >= HALF) putLut(rgba, p, lutL, idxL(landV[p]));
    else if (q <= -HALF) putLut(rgba, p, lutS, idxS(seaV[p]));
    else putMixed(rgba, p, lutL, idxL(landV[p]), lutS, idxS(seaV[p]), 0.5 + q / COAST_Q);
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Temperature                                                                                   */
/* ------------------------------------------------------------------------------------------- */

export function paintTemperature(c: ClimateResult, hf: HeightField, opts: PaintOptions, month: number, cache: PaintCache): Uint8ClampedArray {
  const { w, h, height } = hf;
  const N = c.w * c.h, npx = w * h;
  const sea = opts.seaLevel;
  const src = monthSlice(c.temp, N, month, c.tempAnnual);
  // Land: temperature reduced to sea level (T + Γ·href), re-lapsed to each pixel's displayed height.
  const href = refHeight(c, cache);
  const t0 = scratchF32(2, N);
  for (let i = 0; i < N; i++) t0[i] = src[i] + LAPSE_RATE * href[i];
  const tl = scratchF32(0, npx), ts = scratchF32(1, npx);
  sampleSurfaces(c, t0, w, h, tl, null, cache);
  sampleSurfaces(c, src, w, h, null, ts, cache);
  const qd = coastDistance(hf, sea);
  // Colour and display temperature (for the 0 °C isotherm) per pixel.
  const td = scratchF32(3, npx);
  const rgba = new Uint8ClampedArray(4 * npx);
  const lut = CM_TEMP.lut;
  for (let p = 0; p < npx; p++) {
    const q = qd[p];
    if (q <= -HALF) {
      const v = ts[p];
      td[p] = v;
      putLut(rgba, p, lut, 3 * cmapIndex(CM_TEMP, v));
      continue;
    }
    const e = height[p] - sea;
    const vl = tl[p] - LAPSE_RATE * (e > 0 ? e : 0);
    if (q >= HALF) {
      td[p] = vl;
      putLut(rgba, p, lut, 3 * cmapIndex(CM_TEMP, vl));
      continue;
    }
    const a = 0.5 + q / COAST_Q;
    td[p] = a * vl + (1 - a) * ts[p];
    putMixed(rgba, p, lut, 3 * cmapIndex(CM_TEMP, vl), lut, 3 * cmapIndex(CM_TEMP, ts[p]), a);
  }
  if (opts.hillshade) applyHillshade(rgba, hf, sea, SHADE_LAND, 0, cache);
  const k = strokeScale(w);
  drawContours(rgba, td, w, h, 10, [34, 44, 96], 0.8, 1.1 * k, { only: 0, maxDelta: 8 });
  drawCoastOutline(rgba, qd, COAST_Q, COAST_ALPHA);
  return rgba;
}

/* ------------------------------------------------------------------------------------------- */
/* Precipitation                                                                                 */
/* ------------------------------------------------------------------------------------------- */

export function paintPrecipitation(c: ClimateResult, hf: HeightField, opts: PaintOptions, month: number, cache: PaintCache): Uint8ClampedArray {
  const { w, h } = hf;
  const N = c.w * c.h, npx = w * h;
  // Monthly: mm/month; annual: mm/yr shown on the same colours as the equivalent monthly mean.
  const src = monthSlice(c.precip, N, month, c.precipAnnual);
  const scale = month >= 0 ? 1 : 1 / 12;
  // Log-transform on the grid (smooth interpolation of a log field keeps dry/wet gradients even).
  const lg = scratchF32(2, N);
  for (let i = 0; i < N; i++) lg[i] = Math.log10(Math.max(1, src[i] * scale));
  const pl = scratchF32(0, npx), ps = scratchF32(1, npx);
  sampleSurfaces(c, lg, w, h, pl, ps, cache);
  const qd = coastDistance(hf, opts.seaLevel);
  const rgba = new Uint8ClampedArray(4 * npx);
  const idx = (v: number): number => 3 * cmapIndex(CM_PRECIP_LOG, v);
  paintSplit(rgba, qd, pl, ps, CM_PRECIP_LOG.lut, idx, CM_PRECIP_LOG.lut, idx);
  if (opts.hillshade) applyHillshade(rgba, hf, opts.seaLevel, SHADE_LAND, 0, cache);
  drawCoastOutline(rgba, qd, COAST_Q, COAST_ALPHA);
  return rgba;
}

/* ------------------------------------------------------------------------------------------- */
/* Pressure                                                                                      */
/* ------------------------------------------------------------------------------------------- */

/** Isobar spacing, hPa. */
export const ISOBAR_HPA = 4;
/** Bold isobars every this many hPa. */
export const ISOBAR_BOLD_HPA = 20;

/** Pressure centre on the climate grid. */
export interface PressureCentre {
  row: number;
  col: number;
  high: boolean;
  value: number;
}

/**
 * Local sea-level-pressure maxima / minima: cells that are extreme within `radiusDeg` (great circle)
 * and stand out from the mean of that neighbourhood by ≥ `minProm` hPa. Poleward of 70° is ignored.
 */
export function pressureCentres(p: Float32Array, cw: number, ch: number, radiusDeg = 18, minProm = 1.5): PressureCentre[] {
  const out: PressureCentre[] = [];
  const dLat = 180 / ch, dLon = 360 / cw;
  const rr = Math.max(1, Math.round(radiusDeg / dLat));
  const cosR = Math.cos((radiusDeg * Math.PI) / 180);
  const latOf = (r: number): number => ((90 - (r + 0.5) * dLat) * Math.PI) / 180;
  const cosDc = new Float64Array(cw);
  for (let dc = 0; dc < cw; dc++) cosDc[dc] = Math.cos((dc * dLon * Math.PI) / 180);
  for (let r = 1; r < ch - 1; r++) {
    const phi = latOf(r);
    if (Math.abs(phi) > (70 * Math.PI) / 180) continue;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const rc = Math.min(Math.floor(cw / 2), Math.ceil(rr / Math.max(0.2, cp)));
    for (let c = 0; c < cw; c++) {
      const i = r * cw + c;
      const v = p[i];
      // Cheap 8-neighbour prefilter.
      let ge = true, le = true;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const u = p[(r + dr) * cw + ((c + dc + cw) % cw)];
          if (u > v) ge = false;
          if (u < v) le = false;
        }
      }
      if (!ge && !le) continue;
      let isMax = ge, isMin = le, sum = 0, n = 0;
      for (let dr = -rr; dr <= rr && (isMax || isMin); dr++) {
        const r2 = r + dr;
        if (r2 < 0 || r2 >= ch) continue;
        const phi2 = latOf(r2);
        const s2 = Math.sin(phi2), c2 = Math.cos(phi2);
        for (let dc = -rc; dc <= rc; dc++) {
          if (sp * s2 + cp * c2 * cosDc[dc < 0 ? -dc : dc] < cosR) continue;
          const j = r2 * cw + ((((c + dc) % cw) + cw) % cw);
          const u = p[j];
          sum += u;
          n++;
          // Ties broken by index so a plateau yields one centre.
          if (u > v || (u === v && j < i)) isMax = false;
          if (u < v || (u === v && j < i)) isMin = false;
        }
      }
      if (!isMax && !isMin) continue;
      const mean = sum / Math.max(1, n);
      if (isMax && v - mean >= minProm) out.push({ row: r, col: c, high: true, value: v });
      else if (isMin && mean - v >= minProm) out.push({ row: r, col: c, high: false, value: v });
    }
  }
  return out;
}

const HIGH_INK: RGB = [128, 18, 30];
const LOW_INK: RGB = [18, 42, 128];
const HALO: RGB = [250, 250, 248];

export function paintPressure(c: ClimateResult, hf: HeightField, opts: PaintOptions, month: number, cache: PaintCache): Uint8ClampedArray {
  const { w, h } = hf;
  const N = c.w * c.h, npx = w * h;
  const src = monthSlice(c.pressure, N, month);
  // Sea-level pressure is continuous across coasts: one smooth field.
  const pr = splineSample(src, c.w, c.h, w, h, scratchF32(0, npx), cache);
  const rgba = new Uint8ClampedArray(4 * npx);
  const lut = CM_PRESSURE.lut;
  for (let p = 0; p < npx; p++) putLut(rgba, p, lut, 3 * cmapIndex(CM_PRESSURE, pr[p] - 1013));
  if (opts.hillshade) applyHillshade(rgba, hf, opts.seaLevel, 0.3, 0, cache);
  const qd = coastDistance(hf, opts.seaLevel);
  drawCoastOutline(rgba, qd, COAST_Q, 0.35);
  const k = strokeScale(w);
  drawContours(rgba, pr, w, h, ISOBAR_HPA, [30, 34, 44], 0.6, 0.9 * k, { boldEvery: ISOBAR_BOLD_HPA, boldAlpha: 0.8, boldWidth: 1.7 * k });
  const centres = cache.getOrBuild(`pcentres|${c.id}|${month}`, () => pressureCentres(src, c.w, c.h), () => 64);
  drawPressureCentres(rgba, centres, c.w, c.h, w, h);
  return rgba;
}

function drawPressureCentres(rgba: Uint8ClampedArray, centres: PressureCentre[], cw: number, ch: number, w: number, h: number): void {
  if (centres.length === 0) return;
  const size = Math.max(8, Math.round(h / 58));
  const stroke = Math.max(1.4, size / 6.5);
  // One coverage layer, reused: halos first (all centres), then the ink of highs and of lows.
  const passes: Array<{ halo: boolean; high: boolean | null; rgb: RGB }> = [
    { halo: true, high: null, rgb: HALO }, { halo: false, high: true, rgb: HIGH_INK }, { halo: false, high: false, rgb: LOW_INK },
  ];
  for (const pass of passes) {
    const layer = new AlphaLayer(w, h, 0);
    let any = false;
    for (const cc of centres) {
      if (pass.high !== null && cc.high !== pass.high) continue;
      any = true;
      const x = ((cc.col + 0.5) * w) / cw, y = ((cc.row + 0.5) * h) / ch;
      const label = cc.high ? 'H' : 'L';
      const val = String(Math.round(cc.value));
      const vy = y + 0.95 * size;
      const extra = pass.halo ? 2.6 : 0;
      const alpha = pass.halo ? 0.75 : 1;
      drawText(layer, label, x, y - 0.25 * size, size, stroke + extra, alpha);
      drawText(layer, val, x, vy, 0.55 * size, 0.62 * stroke + (pass.halo ? 2.2 : 0), alpha);
    }
    if (any) layer.composite(rgba, pass.rgb);
  }
}

/* ------------------------------------------------------------------------------------------- */
/* SST, wind, currents                                                                           */
/* ------------------------------------------------------------------------------------------- */

/** Grey land for layers that describe the ocean (SST, currents), relief-shaded when asked. */
const LAND_GREY: RGB = [112, 112, 108];
const LAND_LUT = new Uint8Array(LAND_GREY);
const SEA_ICE: RGB = [232, 238, 244];

export function paintSst(c: ClimateResult, hf: HeightField, opts: PaintOptions, month: number, cache: PaintCache): Uint8ClampedArray {
  const { w, h } = hf;
  const N = c.w * c.h, npx = w * h;
  const sst = scratchF32(0, npx), ice = scratchF32(1, npx);
  sampleSurfaces(c, monthSlice(c.sst, N, month), w, h, null, sst, cache);
  sampleSurfaces(c, monthSlice(c.seaIce, N, month, undefined, 11), w, h, null, ice, cache);
  const qd = coastDistance(hf, opts.seaLevel);
  const rgba = new Uint8ClampedArray(4 * npx);
  const lut = CM_SST.lut, L = SRGB_TO_LINEAR;
  const iceL = [L[SEA_ICE[0]], L[SEA_ICE[1]], L[SEA_ICE[2]]], landL = [L[LAND_GREY[0]], L[LAND_GREY[1]], L[LAND_GREY[2]]];
  for (let p = 0; p < npx; p++) {
    const q = qd[p];
    if (q >= HALF) { putLut(rgba, p, LAND_LUT, 0); continue; }
    const i3 = 3 * cmapIndex(CM_SST, sst[p]);
    const k = smooth(0.15, 0.85, ice[p]);
    const a = q <= -HALF ? 0 : 0.5 + q / COAST_Q;
    const o = 4 * p;
    for (let ch = 0; ch < 3; ch++) {
      const s = L[lut[i3 + ch]] + (iceL[ch] - L[lut[i3 + ch]]) * k;
      rgba[o + ch] = encodeSrgb(s + (landL[ch] - s) * a);
    }
    rgba[o + 3] = 255;
  }
  applyHillshade(rgba, hf, opts.seaLevel, opts.hillshade ? 0.8 : 0, 0, cache);
  drawCoastOutline(rgba, qd, COAST_Q, 0.4);
  return rgba;
}

export function paintWind(c: ClimateResult, hf: HeightField, opts: PaintOptions, month: number, cache: PaintCache): Uint8ClampedArray {
  const { w, h } = hf;
  const N = c.w * c.h, npx = w * h;
  // Speed per cell (interpolating u, v would under-read speeds where the flow turns).
  const sp = scratchF32(2, N);
  if (month >= 0) {
    const u = monthSlice(c.windU, N, month), v = monthSlice(c.windV, N, month);
    for (let i = 0; i < N; i++) sp[i] = Math.sqrt(u[i] * u[i] + v[i] * v[i]);
  } else {
    sp.fill(0);
    for (let m = 0; m < 12; m++) {
      const o = m * N;
      for (let i = 0; i < N; i++) sp[i] += Math.sqrt(c.windU[o + i] ** 2 + c.windV[o + i] ** 2) / 12;
    }
  }
  const wl = scratchF32(0, npx), ws = scratchF32(1, npx);
  sampleSurfaces(c, sp, w, h, wl, ws, cache);
  const qd = coastDistance(hf, opts.seaLevel);
  const rgba = new Uint8ClampedArray(4 * npx);
  const idx = (x: number): number => 3 * cmapIndex(CM_WIND, x);
  paintSplit(rgba, qd, wl, ws, CM_WIND.lut, idx, CM_WIND.lut, idx);
  if (opts.hillshade) applyHillshade(rgba, hf, opts.seaLevel, SHADE_LAND, 0, cache);
  drawCoastOutline(rgba, qd, COAST_Q, COAST_ALPHA);
  return rgba;
}

/** Zonal mean over ocean cells per climate row (falls back to all cells). */
function zonalOceanMean(field: Float32Array, c: ClimateResult): Float64Array {
  const zm = new Float64Array(c.h);
  for (let r = 0; r < c.h; r++) {
    let s = 0, n = 0, sa = 0;
    for (let q = 0; q < c.w; q++) {
      const i = r * c.w + q;
      sa += field[i];
      if (!c.land[i]) { s += field[i]; n++; }
    }
    zm[r] = n > 0 ? s / n : sa / c.w;
  }
  return zm;
}

export function paintCurrents(c: ClimateResult, hf: HeightField, opts: PaintOptions, month: number, cache: PaintCache): Uint8ClampedArray {
  const { w, h, height } = hf;
  const N = c.w * c.h, npx = w * h;
  const sea = opts.seaLevel;
  const u = scratchF32(0, npx), v = scratchF32(1, npx), anom = scratchF32(2, npx);
  sampleSurfaces(c, monthSlice(c.currentU, N, month, undefined, 10), w, h, null, u, cache);
  sampleSurfaces(c, monthSlice(c.currentV, N, month, undefined, 11), w, h, null, v, cache);
  const sstM = monthSlice(c.sst, N, month, undefined, 10);
  const zm = zonalOceanMean(sstM, c);
  const anomGrid = scratchF32(4, N);
  for (let i = 0; i < N; i++) anomGrid[i] = sstM[i] - zm[Math.floor(i / c.w)];
  sampleSurfaces(c, anomGrid, w, h, null, anom, cache);
  const qd = coastDistance(hf, sea);
  const rgba = new Uint8ClampedArray(4 * npx);
  const L = SRGB_TO_LINEAR;
  const landL = [L[LAND_GREY[0]], L[LAND_GREY[1]], L[LAND_GREY[2]]];
  for (let p = 0; p < npx; p++) {
    const q = qd[p];
    if (q >= HALF) { putLut(rgba, p, LAND_LUT, 0); continue; }
    const s = Math.sqrt(u[p] * u[p] + v[p] * v[p]);
    const i3 = currentIndex(s, anom[p]);
    if (q <= -HALF) { putLut(rgba, p, CURRENT_LUT, i3); continue; }
    const a = 0.5 + q / COAST_Q, o = 4 * p;
    for (let ch = 0; ch < 3; ch++) rgba[o + ch] = encodeSrgb(a * landL[ch] + (1 - a) * L[CURRENT_LUT[i3 + ch]]);
    rgba[o + 3] = 255;
  }
  applyHillshade(rgba, hf, sea, opts.hillshade ? 0.8 : 0, 0, cache);
  drawCoastOutline(rgba, qd, COAST_Q, 0.4);
  const k = strokeScale(w);
  const glyphs = new AlphaLayer(w, h, 0);
  drawStreamlets(glyphs, u, v, (p) => height[p] <= sea, {
    spacing: Math.max(12, 28 * k), minSpeed: 0.02, fullSpeed: 0.4, width: Math.max(0.9, 1.1 * k), alpha: 0.85,
  });
  glyphs.composite(rgba, [236, 240, 246]);
  return rgba;
}

function smooth(a: number, b: number, x: number): number {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/* ------------------------------------------------------------------------------------------- */
/* Köppen                                                                                        */
/* ------------------------------------------------------------------------------------------- */

const KOPPEN_RGB = (() => {
  const t = new Uint8Array(3 * KOPPEN_CLASSES.length);
  KOPPEN_CLASSES.forEach((k, i) => t.set(k.color, 3 * i));
  return t;
})();

export function paintKoppen(c: ClimateResult, hf: HeightField, opts: PaintOptions, cache: PaintCache): Uint8ClampedArray {
  const { w, h, height } = hf;
  const sea = opts.seaLevel;
  const npx = w * h;
  const qd = coastDistance(hf, sea);
  // Classify land pixels and the sea pixels within half a pixel of the coast (outer anti-aliasing:
  // land pixels keep exact class colours).
  const cls = classifyPixels(c, height, sea, w, h, qd, -HALF, cache);
  const rgba = new Uint8ClampedArray(4 * npx);
  const ocean = KOPPEN_CLASSES[0].color;
  const L = SRGB_TO_LINEAR;
  for (let p = 0; p < npx; p++) {
    const o = 4 * p;
    const q = qd[p];
    if (q > 0) {
      const k = cls[p];
      rgba[o] = KOPPEN_RGB[3 * k];
      rgba[o + 1] = KOPPEN_RGB[3 * k + 1];
      rgba[o + 2] = KOPPEN_RGB[3 * k + 2];
      rgba[o + 3] = 255;
      continue;
    }
    // Flat dark ocean, faintly depth-tinted.
    const i3 = 3 * cmapIndex(CM_BATHY, sea - height[p]);
    let r = 0.75 * ocean[0] + 0.125 * CM_BATHY.lut[i3];
    let g = 0.75 * ocean[1] + 0.125 * CM_BATHY.lut[i3 + 1];
    let b = 0.75 * ocean[2] + 0.125 * CM_BATHY.lut[i3 + 2];
    if (q > -HALF) {
      const a = 0.5 + q / COAST_Q, k = 3 * cls[p];
      r = encodeSrgb(a * L[KOPPEN_RGB[k]] + (1 - a) * L[Math.round(r)]);
      g = encodeSrgb(a * L[KOPPEN_RGB[k + 1]] + (1 - a) * L[Math.round(g)]);
      b = encodeSrgb(a * L[KOPPEN_RGB[k + 2]] + (1 - a) * L[Math.round(b)]);
    }
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = 255;
  }
  if (opts.hillshade) applyHillshade(rgba, hf, sea, SHADE_LAND, 0, cache);
  return rgba;
}
