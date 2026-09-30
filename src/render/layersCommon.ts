/**
 * Shared helpers for the data layers: unwarped bilinear climate sampling tables, relief shading of
 * a finished image, one-hot barycentric categories and the neutral no-data rendering.
 */
import type { MeshGridMap, SphereMesh } from '../core/types';
import * as _colormaps from './colormaps';
import type { PaintCache } from './paintCache';
import type { HeightField } from './terrain';
import * as _terrainShade from './terrainShade';

// Imported values are copied into module constants: some module runners (vitest / vite-node SSR)
// compile named imports into namespace property reads, which would otherwise sit in per-pixel loops.
const { CM_BATHY, SRGB_TO_LINEAR, encodeSrgb, cmapIndex } = _colormaps;
const { gradientScales, hillshade, shadeExaggeration } = _terrainShade;

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

/**
 * Multiply an sRGB image by relief shading (in linear light) where `mask` selects pixels
 * (land: H > sea; `ocean` strength applies below sea level). No-op strength 0.
 */
export function applyHillshade(rgba: Uint8ClampedArray, hf: HeightField, sea: number, land: number, ocean: number, cache: PaintCache): void {
  const { w, h, height } = hf;
  const gs = gradientScales(w, h, cache);
  const ex = shadeExaggeration(gs);
  for (let r = 0; r < h; r++) {
    const row = r * w;
    const rowN = (r > 0 ? r - 1 : 0) * w, rowS = (r < h - 1 ? r + 1 : h - 1) * w;
    const invDx = gs.invDx[r];
    for (let c = 0; c < w; c++) {
      const p = row + c;
      const k = height[p] > sea ? land : ocean;
      if (k <= 0) continue;
      const gx = (height[row + (c + 1 < w ? c + 1 : 0)] - height[row + (c > 0 ? c - 1 : w - 1)]) * invDx;
      const gy = (height[rowN + c] - height[rowS + c]) * gs.invDy;
      const f = 1 + k * (hillshade(gx, gy, ex) - 1);
      const o = 4 * p;
      rgba[o] = encodeSrgb(SRGB_TO_LINEAR[rgba[o]] * f);
      rgba[o + 1] = encodeSrgb(SRGB_TO_LINEAR[rgba[o + 1]] * f);
      rgba[o + 2] = encodeSrgb(SRGB_TO_LINEAR[rgba[o + 2]] * f);
    }
  }
}

/** Smoothed membership of vertex v in category k: ½·[cat(v) = k] + ½·(fraction of neighbours in k). */
function membership(mesh: SphereMesh, cat: ArrayLike<number>, v: number, k: number): number {
  const s = mesh.adjOffset[v], e = mesh.adjOffset[v + 1];
  let n = 0;
  for (let q = s; q < e; q++) if (cat[mesh.adj[q]] === k) n++;
  return (cat[v] === k ? 0.5 : 0) + (e > s ? (0.5 * n) / (e - s) : 0);
}

/**
 * Per pixel: the category (e.g. plate index) with the largest barycentric-interpolated, one-step
 * Laplacian-smoothed membership over the pixel's triangle ("thresholded barycentric one-hot":
 * smooth boundaries without hexagonal nearest-cell jaggies or cell-scale zigzags). Pure triangles
 * keep their category (margin 1). Optionally writes the winning margin (best − second, 0..1).
 */
export function oneHotCategory(map: MeshGridMap, mesh: SphereMesh, cat: ArrayLike<number>, out: Int32Array, margin?: Float32Array): void {
  const { tri, bary } = map;
  const npx = map.w * map.h;
  for (let p = 0, k = 0; p < npx; p++, k += 3) {
    const va = tri[k], vb = tri[k + 1], vc = tri[k + 2];
    const a = cat[va], b = cat[vb], c = cat[vc];
    if (a === b && a === c) {
      out[p] = a;
      if (margin) margin[p] = 1;
      continue;
    }
    const wa = bary[k], wb = bary[k + 1], wc = bary[k + 2];
    let best = a, bw = -1, second = 0;
    for (let q = 0; q < 3; q++) {
      const kk = q === 0 ? a : q === 1 ? b : c;
      if ((q === 1 && kk === a) || (q === 2 && (kk === a || kk === b))) continue;
      const s = wa * membership(mesh, cat, va, kk) + wb * membership(mesh, cat, vb, kk) + wc * membership(mesh, cat, vc, kk);
      if (s > bw) { second = bw < 0 ? 0 : bw; bw = s; best = kk; } else if (s > second) second = s;
    }
    out[p] = best;
    if (margin) margin[p] = bw - second;
  }
}

/** Neutral no-data rendering: grey land, slate-blue sea by depth (for climate layers without climate). */
export function paintNeutral(hf: HeightField, sea: number): Uint8ClampedArray {
  const { w, h, height } = hf;
  const rgba = new Uint8ClampedArray(4 * w * h);
  for (let p = 0; p < w * h; p++) {
    const H = height[p], o = 4 * p;
    if (H > sea) {
      const g = 150 + Math.min(40, (H - sea) / 100);
      rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g;
    } else {
      const i = 3 * cmapIndex(CM_BATHY, sea - H);
      // Desaturated bathymetry.
      const l = 0.3 * CM_BATHY.lut[i] + 0.59 * CM_BATHY.lut[i + 1] + 0.11 * CM_BATHY.lut[i + 2];
      rgba[o] = 0.55 * l + 0.45 * CM_BATHY.lut[i] * 0.6;
      rgba[o + 1] = 0.55 * l + 0.45 * CM_BATHY.lut[i + 1] * 0.6;
      rgba[o + 2] = 0.55 * l + 0.45 * CM_BATHY.lut[i + 2] * 0.7;
    }
    rgba[o + 3] = 255;
  }
  return rgba;
}

/** Write an sRGB LUT colour into an RGBA buffer at pixel p. */
export function putLut(rgba: Uint8ClampedArray, p: number, lut: Uint8Array, i3: number): void {
  const o = 4 * p;
  rgba[o] = lut[i3];
  rgba[o + 1] = lut[i3 + 1];
  rgba[o + 2] = lut[i3 + 2];
  rgba[o + 3] = 255;
}
