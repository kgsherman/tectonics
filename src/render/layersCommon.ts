/**
 * Shared helpers for the data layers: unwarped bilinear climate sampling tables (rivers), relief
 * shading of a finished image, linear-light blending, anti-aliased coastline and contour lines, and
 * the neutral no-data rendering.
 */
import * as _colormaps from './colormaps';
import type { PaintCache } from './paintCache';
import type { HeightField } from './terrain';
import * as _layersSample from './layersSample';
import * as _terrainShade from './terrainShade';

// Imported values are copied into module constants: some module runners (vitest / vite-node SSR)
// compile named imports into namespace property reads, which would otherwise sit in per-pixel loops.
const { CM_BATHY, SRGB_TO_LINEAR, encodeSrgb, cmapIndex } = _colormaps;
const { gradientScales, hillshade, shadeExaggeration } = _terrainShade;
const { COAST_Q, coastDistance } = _layersSample;

/** Per-row / per-column bilinear tables from a w×h raster into a cw×ch climate grid (no warp). */
export interface GridLookup {
  r0: Int32Array;
  r1: Int32Array;
  tr: Float32Array;
  c0: Int32Array;
  c1: Int32Array;
  tc: Float32Array;
}

export function gridLookup(w: number, h: number, cw: number, ch: number, cache: PaintCache): GridLookup {
  return cache.getOrBuild(`gridlookup|${w}x${h}|${cw}x${ch}`, () => {
    const r0 = new Int32Array(h), r1 = new Int32Array(h), tr = new Float32Array(h);
    for (let r = 0; r < h; r++) {
      let fr = ((r + 0.5) * ch) / h - 0.5;
      if (fr < 0) fr = 0;
      else if (fr > ch - 1) fr = ch - 1;
      const a = Math.min(ch - 1, Math.floor(fr));
      r0[r] = a;
      r1[r] = Math.min(ch - 1, a + 1);
      tr[r] = fr - a;
    }
    const c0 = new Int32Array(w), c1 = new Int32Array(w), tc = new Float32Array(w);
    for (let c = 0; c < w; c++) {
      let fc = ((c + 0.5) * cw) / w - 0.5;
      if (fc < 0) fc += cw;
      const a = Math.floor(fc) % cw;
      c0[c] = a;
      c1[c] = a + 1 < cw ? a + 1 : 0;
      tc[c] = fc - Math.floor(fc);
    }
    return { r0, r1, tr, c0, c1, tc };
  });
}

/**
 * Bilinear sample of a monthly (12·N) or single (N) grid field onto the raster.
 * month ∈ 0..11 selects a slice; month < 0 averages the 12 months (annual mean) unless `annual`
 * (an N-sized annual field) is provided.
 */
export function sampleField(
  field: Float32Array, cw: number, ch: number, month: number, lk: GridLookup, w: number, h: number, annual?: Float32Array,
): Float32Array {
  const N = cw * ch;
  let src: Float32Array;
  if (field.length === N) src = field;
  else if (month >= 0) src = field.subarray(month * N, (month + 1) * N);
  else if (annual) src = annual;
  else {
    src = new Float32Array(N);
    for (let m = 0; m < 12; m++) for (let i = 0; i < N; i++) src[i] += field[m * N + i] / 12;
  }
  const out = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    const a = lk.r0[r] * cw, b = lk.r1[r] * cw, t = lk.tr[r];
    for (let c = 0; c < w; c++) {
      const c0 = lk.c0[c], c1 = lk.c1[c], u = lk.tc[c];
      const top = src[a + c0] + (src[a + c1] - src[a + c0]) * u;
      const bot = src[b + c0] + (src[b + c1] - src[b + c0]) * u;
      out[r * w + c] = top + (bot - top) * t;
    }
  }
  return out;
}

/** Shading factors are quantized to 1/SHADE_Q steps over [0, 2) for a byte → byte table. */
const SHADE_Q = 160;
const SHADE_LEVELS = 2 * SHADE_Q;
/** SHADE_LUT[fi·256 + v] = sRGB byte of (linear(v) · fi / SHADE_Q). */
const SHADE_LUT = (() => {
  const t = new Uint8Array(SHADE_LEVELS * 256);
  for (let fi = 0; fi < SHADE_LEVELS; fi++) {
    const f = fi / SHADE_Q;
    for (let v = 0; v < 256; v++) t[fi * 256 + v] = encodeSrgb(SRGB_TO_LINEAR[v] * f);
  }
  return t;
})();

/** Quantized relief shading per pixel (hs·HS_Q, hs = hillshade factor, 1 on flat ground). */
const HS_Q = 100;
const hsMemo = new WeakMap<HeightField, Uint8Array>();

function reliefShade(hf: HeightField, cache: PaintCache): Uint8Array {
  let q = hsMemo.get(hf);
  if (q) return q;
  const { w, h, height } = hf;
  const gs = gradientScales(w, h, cache);
  const ex = shadeExaggeration(gs);
  q = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    const row = r * w;
    const rowN = (r > 0 ? r - 1 : 0) * w, rowS = (r < h - 1 ? r + 1 : h - 1) * w;
    const invDx = gs.invDx[r];
    for (let c = 0; c < w; c++) {
      const gx = (height[row + (c + 1 < w ? c + 1 : 0)] - height[row + (c > 0 ? c - 1 : w - 1)]) * invDx;
      const gy = (height[rowN + c] - height[rowS + c]) * gs.invDy;
      const v = (hillshade(gx, gy, ex) * HS_Q + 0.5) | 0;
      q[row + c] = v > 255 ? 255 : v;
    }
  }
  hsMemo.set(hf, q);
  return q;
}

/**
 * Multiply an sRGB image by relief shading (in linear light): strength `land` where H > sea,
 * `ocean` below. The per-pixel shading is memoized per height field, so repainting layers of the
 * same surface only pays for the colour lookups.
 */
export function applyHillshade(rgba: Uint8ClampedArray, hf: HeightField, sea: number, land: number, ocean: number, cache: PaintCache): void {
  if (land <= 0 && ocean <= 0) return;
  const { height } = hf;
  const hs = reliefShade(hf, cache);
  // hs level → shading-LUT row, for each surface.
  const rowL = new Int32Array(256), rowO = new Int32Array(256);
  for (let v = 0; v < 256; v++) {
    for (const [k, row] of [[land, rowL], [ocean, rowO]] as const) {
      const f = 1 + k * (v / HS_Q - 1);
      let fi = (f * SHADE_Q + 0.5) | 0;
      fi = fi < 0 ? 0 : fi >= SHADE_LEVELS ? SHADE_LEVELS - 1 : fi;
      row[v] = k > 0 && fi !== SHADE_Q ? fi << 8 : -1;
    }
  }
  const lut = SHADE_LUT;
  for (let p = 0, n = hs.length; p < n; p++) {
    const base = height[p] > sea ? rowL[hs[p]] : rowO[hs[p]];
    if (base < 0) continue;
    const o = 4 * p;
    rgba[o] = lut[base + rgba[o]];
    rgba[o + 1] = lut[base + rgba[o + 1]];
    rgba[o + 2] = lut[base + rgba[o + 2]];
  }
}

/** Neutral no-data rendering: grey land, slate-blue sea by depth, anti-aliased coasts (for climate layers without climate). */
export function paintNeutral(hf: HeightField, sea: number): Uint8ClampedArray {
  const { w, h, height } = hf;
  const qd = coastDistance(hf, sea);
  const rgba = new Uint8ClampedArray(4 * w * h);
  const lin = SRGB_TO_LINEAR;
  for (let p = 0; p < w * h; p++) {
    const H = height[p], o = 4 * p, q = qd[p];
    // Land grey brightening with altitude; desaturated bathymetry at sea.
    const g = 150 + Math.min(40, Math.max(0, H - sea) / 100);
    const i = 3 * cmapIndex(CM_BATHY, Math.max(0, sea - H));
    const l = 0.3 * CM_BATHY.lut[i] + 0.59 * CM_BATHY.lut[i + 1] + 0.11 * CM_BATHY.lut[i + 2];
    const sr = 0.55 * l + 0.45 * CM_BATHY.lut[i] * 0.6;
    const sg = 0.55 * l + 0.45 * CM_BATHY.lut[i + 1] * 0.6;
    const sb = 0.55 * l + 0.45 * CM_BATHY.lut[i + 2] * 0.7;
    if (q >= COAST_Q / 2) { rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; }
    else if (q <= -COAST_Q / 2) { rgba[o] = sr; rgba[o + 1] = sg; rgba[o + 2] = sb; }
    else {
      const a = 0.5 + q / COAST_Q, b = 1 - a, gl = lin[Math.round(g)];
      rgba[o] = encodeSrgb(a * gl + b * lin[Math.round(sr)]);
      rgba[o + 1] = encodeSrgb(a * gl + b * lin[Math.round(sg)]);
      rgba[o + 2] = encodeSrgb(a * gl + b * lin[Math.round(sb)]);
    }
    rgba[o + 3] = 255;
  }
  return rgba;
}

/** Blend sRGB (r, g, b) into pixel p of an opaque image with weight t, in linear light. */
export function mixInto(rgba: Uint8ClampedArray, p: number, r: number, g: number, b: number, t: number): void {
  if (!(t > 0)) return;
  const o = 4 * p;
  const L = SRGB_TO_LINEAR;
  rgba[o] = encodeSrgb(L[rgba[o]] + (L[r] - L[rgba[o]]) * t);
  rgba[o + 1] = encodeSrgb(L[rgba[o + 1]] + (L[g] - L[rgba[o + 1]]) * t);
  rgba[o + 2] = encodeSrgb(L[rgba[o + 2]] + (L[b] - L[rgba[o + 2]]) * t);
}

/**
 * Write the coverage-weighted mix (linear light) of a land colour (lutL at iL) and a sea colour
 * (lutS at iS) into pixel p; a = land coverage 0..1.
 */
export function putMixed(rgba: Uint8ClampedArray, p: number, lutL: Uint8Array, iL: number, lutS: Uint8Array, iS: number, a: number): void {
  const o = 4 * p;
  const L = SRGB_TO_LINEAR, b = 1 - a;
  rgba[o] = encodeSrgb(a * L[lutL[iL]] + b * L[lutS[iS]]);
  rgba[o + 1] = encodeSrgb(a * L[lutL[iL + 1]] + b * L[lutS[iS + 1]]);
  rgba[o + 2] = encodeSrgb(a * L[lutL[iL + 2]] + b * L[lutS[iS + 2]]);
  rgba[o + 3] = 255;
}

/** Coastline ink of the data layers (thin dark line on the height-map coast). */
export const COAST_INK: readonly [number, number, number] = [16, 20, 28];

/**
 * Draw an anti-aliased coastline of peak opacity `alpha` (≈ 1.3 px wide) from the quantized coast
 * distance field (see layersSample.coastDistance).
 */
export function drawCoastOutline(rgba: Uint8ClampedArray, qd: Int8Array, qPerPx: number, alpha: number): void {
  const lim = 1.1 * qPerPx;
  const [r, g, b] = COAST_INK;
  for (let p = 0, n = qd.length; p < n; p++) {
    const q = qd[p];
    if (q >= lim || q <= -lim) continue;
    // Line centred on the coast (d = 0), half-width 0.65 px, box-filtered.
    const d = Math.abs(q) / qPerPx;
    let cov = 0.65 + 0.5 - d;
    if (cov <= 0) continue;
    if (cov > 1) cov = 1;
    mixInto(rgba, p, r, g, b, alpha * cov);
  }
}

/**
 * Anti-aliased contour lines of a raster field every `spacing` units (or only the level `only`):
 * distance to the nearest level in px = |Δ| / |∇f|. Bold levels (multiples of boldEvery, when > 0)
 * are drawn wider and darker.
 */
export function drawContours(
  rgba: Uint8ClampedArray, f: Float32Array, w: number, h: number, spacing: number, ink: readonly [number, number, number],
  alpha: number, width: number,
  opts: { only?: number; maxDelta?: number; boldEvery?: number; boldAlpha?: number; boldWidth?: number; mask?: (p: number) => boolean } = {},
): void {
  const [ir, ig, ib] = ink;
  const boldEvery = opts.boldEvery ?? 0;
  // Pixels further than maxDelta (field units) from a level are skipped before the gradient.
  const maxDelta = opts.maxDelta ?? Infinity;
  for (let r = 0; r < h; r++) {
    const row = r * w;
    const rowN = (r > 0 ? r - 1 : 0) * w, rowS = (r < h - 1 ? r + 1 : h - 1) * w;
    for (let c = 0; c < w; c++) {
      const p = row + c;
      const v = f[p];
      let level: number;
      if (opts.only !== undefined) level = opts.only;
      else level = Math.round(v / spacing) * spacing;
      const dv = Math.abs(v - level);
      if (dv > maxDelta) continue;
      if (opts.mask && !opts.mask(p)) continue;
      const gx = 0.5 * (f[row + (c + 1 < w ? c + 1 : 0)] - f[row + (c > 0 ? c - 1 : w - 1)]);
      const gy = 0.5 * (f[rowN + c] - f[rowS + c]);
      const g2 = gx * gx + gy * gy;
      const bold = boldEvery > 0 && Math.abs(level / boldEvery - Math.round(level / boldEvery)) < 1e-6;
      const hw = 0.5 * (bold ? opts.boldWidth ?? width * 1.6 : width);
      // Skip quickly when further than hw + 0.5 px (written so a non-finite field value or
      // gradient skips the pixel instead of blending NaN coverage).
      if (!(dv * dv < (hw + 0.5) * (hw + 0.5) * g2)) continue;
      const d = dv / Math.sqrt(g2);
      let cov = hw + 0.5 - d;
      if (cov > 1) cov = 1;
      if (hw < 0.5) cov *= 2 * hw;
      mixInto(rgba, p, ir, ig, ib, (bold ? opts.boldAlpha ?? alpha * 1.4 : alpha) * cov);
    }
  }
}

/** Write an sRGB LUT colour into an RGBA buffer at pixel p. */
export function putLut(rgba: Uint8ClampedArray, p: number, lut: Uint8Array, i3: number): void {
  const o = 4 * p;
  rgba[o] = lut[i3];
  rgba[o + 1] = lut[i3 + 1];
  rgba[o + 2] = lut[i3 + 2];
  rgba[o + 3] = 255;
}
