/**
 * Climate data layers: temperature (lapse-corrected to the displayed surface), precipitation (log),
 * pressure (with isobars), SST (+ sea ice), wind speed, ocean currents (speed shading, warm/cold by
 * SST anomaly vs the zonal ocean mean, arrow glyphs) and Köppen classes. All land/sea decisions come
 * from the height map; climate data are sampled bilinearly (unwarped) except Köppen (warped nearest,
 * matching the satellite biome boundaries).
 */
import * as _constants from '../core/constants';
import * as _grid from '../core/grid';
import type { ClimateResult, PaintOptions, RGB } from '../core/types';
import * as _koppen from '../climate/koppen';
import * as _colormaps from './colormaps';
import * as _layersCommon from './layersCommon';
import type { PaintCache } from './paintCache';
import * as _satelliteSampler from './satelliteSampler';
import * as _terrain from './terrain';
import type { HeightField } from './terrain';

// Imported values are copied into module constants: some module runners (vitest / vite-node SSR)
// compile named imports into namespace property reads, which would otherwise sit in per-pixel loops.
const { LAPSE_RATE } = _constants;
const { gridLat } = _grid;
const { KOPPEN_CLASSES, classifyKoppen } = _koppen;
const {
  CM_BATHY, CM_CURRENT, CM_PRECIP_LOG, CM_PRESSURE, CM_SST, CM_TEMP, CM_WIND, SRGB_TO_LINEAR,
  cmapIndex, encodeSrgb,
} = _colormaps;
const { applyHillshade, gridLookup, putLut, sampleField } = _layersCommon;
const { getClimateSampler } = _satelliteSampler;
const { detailTexture } = _terrain;

function smooth(a: number, b: number, x: number): number {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/** Per climate cell land reference height above the climate's sea level (m; 0 for ocean cells). */
function refHeight(c: ClimateResult, cache: PaintCache): Float32Array {
  return cache.getOrBuild(`href|${c.id}`, () => {
    const out = new Float32Array(c.w * c.h);
    const sea = c.params.seaLevel;
    for (let i = 0; i < out.length; i++) out[i] = c.land[i] ? Math.max(0, c.elev[i] - sea) : 0;
    return out;
  });
}

/** Grey land for layers that describe the ocean (SST, currents), relief-shaded later. */
const LAND_GREY: RGB = [88, 88, 86];

export function paintTemperature(c: ClimateResult, hf: HeightField, opts: PaintOptions, month: number, cache: PaintCache): Uint8ClampedArray {
  const { w, h, height } = hf;
  const lk = gridLookup(w, h, c.w, c.h, cache);
  const t = sampleField(c.temp, c.w, c.h, month, lk, w, h, c.tempAnnual);
  const href = sampleField(refHeight(c, cache), c.w, c.h, -1, lk, w, h);
  const sea = opts.seaLevel;
  const rgba = new Uint8ClampedArray(4 * w * h);
  for (let p = 0; p < w * h; p++) {
    // Sea-level-reduced temperature re-lapsed to the displayed surface height.
    const hp = height[p] > sea ? height[p] - sea : 0;
    putLut(rgba, p, CM_TEMP.lut, 3 * cmapIndex(CM_TEMP, t[p] + LAPSE_RATE * (href[p] - hp)));
  }
  if (opts.hillshade) applyHillshade(rgba, hf, sea, 0.55, 0, cache);
  return rgba;
}

export function paintPrecipitation(c: ClimateResult, hf: HeightField, opts: PaintOptions, month: number, cache: PaintCache): Uint8ClampedArray {
  const { w, h } = hf;
  const lk = gridLookup(w, h, c.w, c.h, cache);
  // Monthly: mm/month; annual: mm/yr shown on the same colours as the equivalent monthly mean.
  const pr = sampleField(c.precip, c.w, c.h, month, lk, w, h, c.precipAnnual);
  const scale = month >= 0 ? 1 : 1 / 12;
  const rgba = new Uint8ClampedArray(4 * w * h);
  for (let p = 0; p < w * h; p++) {
    const v = Math.log10(Math.max(1, pr[p] * scale));
    putLut(rgba, p, CM_PRECIP_LOG.lut, 3 * cmapIndex(CM_PRECIP_LOG, v));
  }
  if (opts.hillshade) applyHillshade(rgba, hf, opts.seaLevel, 0.55, 0, cache);
  return rgba;
}

/** Isobar spacing, hPa. */
export const ISOBAR_HPA = 4;

export function paintPressure(c: ClimateResult, hf: HeightField, opts: PaintOptions, month: number, cache: PaintCache): Uint8ClampedArray {
  const { w, h, height } = hf;
  const lk = gridLookup(w, h, c.w, c.h, cache);
  const pr = sampleField(c.pressure, c.w, c.h, month, lk, w, h);
  const sea = opts.seaLevel;
  const rgba = new Uint8ClampedArray(4 * w * h);
  for (let r = 0; r < h; r++) {
    const rowN = (r > 0 ? r - 1 : 0) * w, rowS = (r < h - 1 ? r + 1 : h - 1) * w, row = r * w;
    for (let cc = 0; cc < w; cc++) {
      const p = row + cc;
      const v = pr[p];
      const i3 = 3 * cmapIndex(CM_PRESSURE, v - 1013);
      // Anti-aliased isobars: distance to the nearest level in pixels = |Δlevel| / |∇level|.
      const f = v / ISOBAR_HPA;
      const d = Math.abs(f - Math.round(f));
      const gx = (pr[row + (cc + 1 < w ? cc + 1 : 0)] - pr[row + (cc > 0 ? cc - 1 : w - 1)]) * 0.5 / ISOBAR_HPA;
      const gy = (pr[rowN + cc] - pr[rowS + cc]) * 0.5 / ISOBAR_HPA;
      const g = Math.sqrt(gx * gx + gy * gy) + 1e-6;
      const line = 1 - smooth(0.35, 1.1, d / g);
      const land = height[p] > sea ? 0.9 : 1;
      const k = (1 - 0.5 * line) * land;
      const o = 4 * p;
      rgba[o] = CM_PRESSURE.lut[i3] * k;
      rgba[o + 1] = CM_PRESSURE.lut[i3 + 1] * k;
      rgba[o + 2] = CM_PRESSURE.lut[i3 + 2] * k;
      rgba[o + 3] = 255;
    }
  }
  if (opts.hillshade) applyHillshade(rgba, hf, sea, 0.45, 0, cache);
  return rgba;
}

export function paintSst(c: ClimateResult, hf: HeightField, opts: PaintOptions, month: number, cache: PaintCache): Uint8ClampedArray {
  const { w, h, height } = hf;
  const lk = gridLookup(w, h, c.w, c.h, cache);
  const sst = sampleField(c.sst, c.w, c.h, month, lk, w, h);
  const ice = sampleField(c.seaIce, c.w, c.h, month, lk, w, h);
  const sea = opts.seaLevel;
  const rgba = new Uint8ClampedArray(4 * w * h);
  for (let p = 0; p < w * h; p++) {
    const o = 4 * p;
    if (height[p] > sea) {
      rgba[o] = LAND_GREY[0]; rgba[o + 1] = LAND_GREY[1]; rgba[o + 2] = LAND_GREY[2]; rgba[o + 3] = 255;
      continue;
    }
    const i3 = 3 * cmapIndex(CM_SST, sst[p]);
    const k = smooth(0.15, 0.85, ice[p]);
    rgba[o] = CM_SST.lut[i3] + (228 - CM_SST.lut[i3]) * k;
    rgba[o + 1] = CM_SST.lut[i3 + 1] + (234 - CM_SST.lut[i3 + 1]) * k;
    rgba[o + 2] = CM_SST.lut[i3 + 2] + (240 - CM_SST.lut[i3 + 2]) * k;
    rgba[o + 3] = 255;
  }
  applyHillshade(rgba, hf, sea, opts.hillshade ? 0.8 : 0, 0, cache);
  return rgba;
}

export function paintWind(c: ClimateResult, hf: HeightField, opts: PaintOptions, month: number, cache: PaintCache): Uint8ClampedArray {
  const { w, h, height } = hf;
  const lk = gridLookup(w, h, c.w, c.h, cache);
  const u = sampleField(c.windU, c.w, c.h, month, lk, w, h);
  const v = sampleField(c.windV, c.w, c.h, month, lk, w, h);
  const sea = opts.seaLevel;
  const rgba = new Uint8ClampedArray(4 * w * h);
  for (let p = 0; p < w * h; p++) {
    const i3 = 3 * cmapIndex(CM_WIND, Math.sqrt(u[p] * u[p] + v[p] * v[p]));
    const k = height[p] > sea ? 0.82 : 1;
    const o = 4 * p;
    rgba[o] = CM_WIND.lut[i3] * k;
    rgba[o + 1] = CM_WIND.lut[i3 + 1] * k;
    rgba[o + 2] = CM_WIND.lut[i3 + 2] * k;
    rgba[o + 3] = 255;
  }
  if (opts.hillshade) applyHillshade(rgba, hf, sea, 0.6, 0, cache);
  return rgba;
}

/** Zonal mean SST over ocean cells per climate row (falls back to all cells, then neighbours). */
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

const WARM: RGB = [236, 104, 58];
const COLD: RGB = [70, 190, 236];

export function paintCurrents(c: ClimateResult, hf: HeightField, opts: PaintOptions, month: number, cache: PaintCache): Uint8ClampedArray {
  const { w, h, height } = hf;
  const lk = gridLookup(w, h, c.w, c.h, cache);
  const u = sampleField(c.currentU, c.w, c.h, month, lk, w, h);
  const v = sampleField(c.currentV, c.w, c.h, month, lk, w, h);
  const N = c.w * c.h;
  let sstM: Float32Array;
  if (month >= 0) sstM = c.sst.subarray(month * N, (month + 1) * N);
  else {
    sstM = new Float32Array(N);
    for (let m = 0; m < 12; m++) for (let i = 0; i < N; i++) sstM[i] += c.sst[m * N + i] / 12;
  }
  const zm = zonalOceanMean(sstM, c);
  const anomGrid = new Float32Array(N);
  for (let i = 0; i < N; i++) anomGrid[i] = sstM[i] - zm[Math.floor(i / c.w)];
  const anom = sampleField(anomGrid, c.w, c.h, -1, lk, w, h);
  const sea = opts.seaLevel;
  const rgba = new Uint8ClampedArray(4 * w * h);
  for (let p = 0; p < w * h; p++) {
    const o = 4 * p;
    if (height[p] > sea) {
      rgba[o] = LAND_GREY[0]; rgba[o + 1] = LAND_GREY[1]; rgba[o + 2] = LAND_GREY[2]; rgba[o + 3] = 255;
      continue;
    }
    const s = Math.sqrt(u[p] * u[p] + v[p] * v[p]);
    const i3 = 3 * cmapIndex(CM_CURRENT, s);
    const a = anom[p];
    const tint = a > 0 ? WARM : COLD;
    const k = 0.8 * smooth(0.02, 0.35, s) * smooth(0.3, 3, Math.abs(a));
    rgba[o] = CM_CURRENT.lut[i3] + (tint[0] - CM_CURRENT.lut[i3]) * k;
    rgba[o + 1] = CM_CURRENT.lut[i3 + 1] + (tint[1] - CM_CURRENT.lut[i3 + 1]) * k;
    rgba[o + 2] = CM_CURRENT.lut[i3 + 2] + (tint[2] - CM_CURRENT.lut[i3 + 2]) * k;
    rgba[o + 3] = 255;
  }
  applyHillshade(rgba, hf, sea, opts.hillshade ? 0.8 : 0, 0, cache);
  drawCurrentGlyphs(rgba, u, v, hf, sea);
  return rgba;
}

/** Blend a white-ish anti-aliased segment into the image (distance-based coverage, lon wraps). */
function drawSegment(rgba: Uint8ClampedArray, w: number, h: number, x0: number, y0: number, x1: number, y1: number, alpha: number, width: number): void {
  const minX = Math.floor(Math.min(x0, x1) - width - 1), maxX = Math.ceil(Math.max(x0, x1) + width + 1);
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - width - 1)), maxY = Math.min(h - 1, Math.ceil(Math.max(y0, y1) + width + 1));
  const dx = x1 - x0, dy = y1 - y0;
  const l2 = dx * dx + dy * dy || 1e-9;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      let t = ((px - x0) * dx + (py - y0) * dy) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - (x0 + t * dx), ey = py - (y0 + t * dy);
      const d = Math.sqrt(ex * ex + ey * ey);
      const cov = alpha * (1 - smooth(width * 0.5 - 0.5, width * 0.5 + 0.5, d));
      if (cov <= 0) continue;
      const xx = ((x % w) + w) % w;
      const o = 4 * (y * w + xx);
      for (let q = 0; q < 3; q++) {
        const lin = SRGB_TO_LINEAR[rgba[o + q]];
        rgba[o + q] = encodeSrgb(lin + (0.9 - lin) * cov);
      }
    }
  }
}

/** Arrow glyphs on a roughly equal-area lattice over the ocean; length ∝ speed (saturating). */
function drawCurrentGlyphs(rgba: Uint8ClampedArray, u: Float32Array, v: Float32Array, hf: HeightField, sea: number): void {
  const { w, h, height } = hf;
  const S = Math.max(10, Math.round(w / 90));
  for (let gy = S / 2, gi = 0; gy < h; gy += S, gi++) {
    const r = Math.floor(gy);
    const cl = Math.cos(Math.PI / 2 - ((r + 0.5) * Math.PI) / h);
    if (cl < 0.12) continue;
    const step = S / cl;
    const n = Math.max(1, Math.floor(w / step));
    // Stagger alternate glyph rows by half a step.
    const off = (gi & 1) === 0 ? 0 : 0.5;
    for (let k = 0; k < n; k++) {
      const x = ((k + off) * w) / n;
      const c = Math.floor(x) % w;
      const p = r * w + c;
      if (height[p] > sea) continue;
      const uu = u[p], vv = v[p];
      const s = Math.sqrt(uu * uu + vv * vv);
      if (s < 0.025) continue;
      // Map direction on the equirectangular raster: east scales by 1/cos(lat).
      let dx = uu / cl, dy = -vv;
      const dl = Math.sqrt(dx * dx + dy * dy);
      dx /= dl;
      dy /= dl;
      const len = S * 0.9 * Math.min(1, 0.25 + s / 0.35);
      const x0 = x - 0.5 * len * dx, y0 = gy - 0.5 * len * dy;
      const x1 = x + 0.5 * len * dx, y1 = gy + 0.5 * len * dy;
      const a = 0.12 + 0.73 * smooth(0.025, 0.35, s);
      drawSegment(rgba, w, h, x0, y0, x1, y1, a, 1.1);
      const hl = Math.min(4, 0.35 * len);
      const ca = Math.cos(0.5), sa = Math.sin(0.5);
      drawSegment(rgba, w, h, x1, y1, x1 - hl * (dx * ca - dy * sa), y1 - hl * (dy * ca + dx * sa), a, 1.1);
      drawSegment(rgba, w, h, x1, y1, x1 - hl * (dx * ca + dy * sa), y1 - hl * (dy * ca - dx * sa), a, 1.1);
    }
  }
}

const KOPPEN_RGB = (() => {
  const t = new Uint8Array(3 * KOPPEN_CLASSES.length);
  KOPPEN_CLASSES.forEach((k, i) => t.set(k.color, 3 * i));
  return t;
})();

export function paintKoppen(c: ClimateResult, hf: HeightField, opts: PaintOptions, cache: PaintCache): Uint8ClampedArray {
  const { w, h, height } = hf;
  const smp = getClimateSampler(w, h, c.w, c.h, opts.seed, detailTexture(opts.seed, w, cache), cache);
  const href = refHeight(c, cache);
  const N = c.w * c.h;
  const sea = opts.seaLevel;
  const rgba = new Uint8ClampedArray(4 * w * h);
  const memo = new Map<number, number>();
  const T12 = new Float32Array(12), P12 = new Float32Array(12);
  const stride = smp.stride;
  const ocean = KOPPEN_CLASSES[0].color;
  for (let p = 0; p < w * h; p++) {
    const o = 4 * p;
    const e = height[p] - sea;
    if (e <= 0) {
      const i3 = 3 * cmapIndex(CM_BATHY, -e);
      // Flat dark ocean, faintly depth-tinted.
      rgba[o] = 0.75 * ocean[0] + 0.25 * CM_BATHY.lut[i3] * 0.5;
      rgba[o + 1] = 0.75 * ocean[1] + 0.25 * CM_BATHY.lut[i3 + 1] * 0.5;
      rgba[o + 2] = 0.75 * ocean[2] + 0.25 * CM_BATHY.lut[i3 + 2] * 0.5;
      rgba[o + 3] = 255;
      continue;
    }
    // Nearest climate cell at the warped position (same organic boundaries as the satellite).
    const pi = smp.idx[p] + (smp.wr[p] >= 32768 ? stride : 0) + (smp.wc[p] >= 32768 ? 1 : 0);
    let row = Math.floor(pi / stride), col = pi - row * stride;
    if (col >= c.w) col = 0;
    if (row >= c.h) row = c.h - 1;
    const cell = row * c.w + col;
    let k = c.koppenAll[cell];
    // Alpine re-classification: lapse the cell's monthly temperatures to the pixel height.
    const dT = LAPSE_RATE * (href[cell] - e);
    if (dT > 1 || dT < -1) {
      const q = Math.max(-128, Math.min(127, Math.round(dT * 2)));
      const key = cell * 256 + q + 128;
      let kk = memo.get(key);
      if (kk === undefined) {
        for (let m = 0; m < 12; m++) {
          T12[m] = c.temp[m * N + cell] + q * 0.5;
          P12[m] = c.precip[m * N + cell];
        }
        kk = classifyKoppen(T12, P12, gridLat(c.h, row) < 0);
        memo.set(key, kk);
      }
      k = kk;
    }
    if (k <= 0 || k >= KOPPEN_CLASSES.length) k = 0;
    rgba[o] = KOPPEN_RGB[3 * k];
    rgba[o + 1] = KOPPEN_RGB[3 * k + 1];
    rgba[o + 2] = KOPPEN_RGB[3 * k + 2];
    rgba[o + 3] = 255;
  }
  if (opts.hillshade) applyHillshade(rgba, hf, sea, 0.5, 0, cache);
  return rgba;
}
