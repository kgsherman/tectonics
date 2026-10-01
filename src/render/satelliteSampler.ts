/**
 * Static per-pixel lookup from the display raster into a (padded) climate grid, with a
 * low-frequency isotropic domain warp (world frame, ~1.5 climate cells) so climate-cell and class
 * boundaries become organic instead of following the grid. Also carries a world-frame texture
 * noise per pixel (sea-ice floes, cloud-free haze variation).
 *
 * Attribute grids sampled through it are padded by one column / row before and two after (columns
 * wrap, rows clamp), so both the bilinear corners (idx, idx+1, idx+stride, idx+stride+1) and the
 * 4×4 cubic B-spline footprint (from idx − stride − 1, see bspline16) are always inside the grid.
 */
import { createNoise3 } from '../core/noise';
import type { PaintCache } from './paintCache';
import { rasterGeometry } from './paintGeometry';
import { CH_COAST, CH_HILL, sampleDetail } from './terrainDetail';
import type { DetailTexture } from './terrainDetail';

/** Warp amplitude scale in climate cells (noise ≈ ±0.8 ⇒ ≈ ±2 cells peak, ≈ 1–1.5 cells typical). */
const WARP_CELLS = 2.6;
/** Warp feature size in climate cells. */
const WARP_FEATURE_CELLS = 4;
/** Warp raster samples per climate cell (the warp is smooth; it is B-spline interpolated per pixel). */
const WARP_RASTER = 1.5;

export interface ClimateSampler {
  w: number;
  h: number;
  cw: number;
  ch: number;
  /** cw + 3: row stride of padded attribute grids. */
  stride: number;
  /** Per pixel: padded-grid index of the top-left bilinear corner (cell (r0, c0) at (r0 + 1, c0 + 1)). */
  idx: Int32Array;
  /** Per pixel: bilinear weights toward the next row / next column, ×65535. */
  wr: Uint16Array;
  wc: Uint16Array;
  /**
   * Per pixel world-frame texture noise, ≈[-1,1] × 127: 1.6·CH_HILL + 0.8·CH_COAST. Both channels are
   * now fine octaves of the same fbm (0.99-correlated), so this is ≈ 0.91 × `fine`, not a mid-scale noise.
   */
  tex: Int8Array;
  /** Per pixel world-frame fine noise only, ≈[-1,1] × 127. */
  fine: Int8Array;
}

export function getClimateSampler(w: number, h: number, cw: number, ch: number, seed: number, detail: DetailTexture, cache: PaintCache): ClimateSampler {
  const s = Math.floor(seed) | 0;
  return cache.getOrBuild(`climsampler|${w}x${h}|${cw}x${ch}|${s}|${detail.n}`, () => buildSampler(w, h, cw, ch, s, detail, cache));
}

function buildSampler(w: number, h: number, cw: number, ch: number, seed: number, detail: DetailTexture, cache: PaintCache): ClimateSampler {
  if (!(cw >= 2 && ch >= 2)) throw new Error(`climate grid too small (${cw}×${ch})`);
  const geo = rasterGeometry(w, h, cache);
  const npx = w * h;
  const idx = new Int32Array(npx);
  const wr = new Uint16Array(npx);
  const wc = new Uint16Array(npx);
  const tex = new Int8Array(npx);
  const fine = new Int8Array(npx);
  const stride = cw + 3;

  // Warp offsets on a coarse raster (the warp is smooth), upsampled per pixel with the cubic
  // B-spline: a bilinear upsample would put gradient kinks into the sampling positions along every
  // raster line (straight, axis-aligned creases in every thresholded field).
  const gw = Math.max(8, Math.min(w, Math.ceil(cw * WARP_RASTER)));
  const gh = Math.max(4, Math.min(h, Math.ceil(ch * WARP_RASTER)));
  const warpE = new Float32Array(gw * gh);
  const warpN = new Float32Array(gw * gh);
  const ne = createNoise3((seed * 2654435761) ^ 0x3a7e);
  const nn = createNoise3((seed * 2246822519) ^ 0x51c9);
  const f = ch / (WARP_FEATURE_CELLS * Math.PI);
  for (let r = 0; r < gh; r++) {
    const la = Math.PI / 2 - ((r + 0.5) * Math.PI) / gh;
    const cl = Math.cos(la), sl = Math.sin(la);
    for (let c = 0; c < gw; c++) {
      const lo = -Math.PI + ((c + 0.5) * 2 * Math.PI) / gw;
      const x = cl * Math.cos(lo), y = cl * Math.sin(lo), z = sl;
      const i = r * gw + c;
      warpE[i] = ne(x * f, y * f, z * f) + 0.5 * ne(x * 2.1 * f + 7, y * 2.1 * f, z * 2.1 * f);
      warpN[i] = nn(x * f, y * f, z * f) + 0.5 * nn(x * 2.1 * f, y * 2.1 * f + 7, z * 2.1 * f);
    }
  }

  // Separable B-spline tables into the coarse warp raster: per column 4 raster columns (wrapping) and
  // weights, per row 4 raster rows (clamped) and weights.
  const gcI = new Int32Array(4 * w), gcW = new Float64Array(4 * w), colBase = new Float64Array(w);
  for (let c = 0; c < w; c++) {
    const gc = ((c + 0.5) * gw) / w - 0.5;
    const gcf = Math.floor(gc);
    bsplineWeights(gc - gcf, gcW, 4 * c);
    for (let k = 0; k < 4; k++) gcI[4 * c + k] = (((gcf - 1 + k) % gw) + gw) % gw;
    colBase[c] = ((c + 0.5) * cw) / w - 0.5;
  }
  const grO = new Int32Array(4), grW = new Float64Array(4);
  // World-frame texture noise: the static detail cube sampled through a fixed rotation (so it is
  // uncorrelated with any plate's material-frame detail).
  const smp = new Float64Array(4);
  const R = [0.36, 0.48, -0.8, -0.8, 0.6, 0, 0.48, 0.64, 0.6];
  const dLonC = (2 * Math.PI) / cw;
  const maxDc = cw / 4;
  for (let r = 0; r < h; r++) {
    const cl = geo.cosLat[r], sl = geo.sinLat[r];
    const la = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
    const gr = ((r + 0.5) * gh) / h - 0.5;
    const grf = Math.floor(gr);
    bsplineWeights(gr - grf, grW, 0);
    for (let k = 0; k < 4; k++) {
      const rr = grf - 1 + k;
      grO[k] = (rr < 0 ? 0 : rr > gh - 1 ? gh - 1 : rr) * gw;
    }
    const o0 = grO[0], o1 = grO[1], o2 = grO[2], o3 = grO[3];
    const v0 = grW[0], v1 = grW[1], v2 = grW[2], v3 = grW[3];
    const baseRow = ((Math.PI / 2 - la) / Math.PI) * ch - 0.5;
    // East offset in columns: metric warp ⇒ divide by cos(lat) (capped near the poles).
    const colScale = (WARP_CELLS * (Math.PI / ch)) / (Math.max(0.05, cl) * dLonC);
    for (let c = 0; c < w; c++) {
      const p = r * w + c;
      let e = 0, nv = 0;
      for (let k = 0; k < 4; k++) {
        const g = gcI[4 * c + k], u = gcW[4 * c + k];
        e += u * (v0 * warpE[o0 + g] + v1 * warpE[o1 + g] + v2 * warpE[o2 + g] + v3 * warpE[o3 + g]);
        nv += u * (v0 * warpN[o0 + g] + v1 * warpN[o1 + g] + v2 * warpN[o2 + g] + v3 * warpN[o3 + g]);
      }
      let fr = baseRow - WARP_CELLS * nv;
      let dc = colScale * e;
      if (dc > maxDc) dc = maxDc;
      else if (dc < -maxDc) dc = -maxDc;
      let fc = colBase[c] + dc;
      if (fc < 0) fc += cw;
      else if (fc >= cw) fc -= cw;
      if (fr < 0) fr = 0;
      else if (fr > ch - 1) fr = ch - 1;
      let r0 = fr | 0;
      if (r0 > ch - 1) r0 = ch - 1;
      let c0 = fc | 0;
      if (c0 > cw - 1) c0 = cw - 1;
      idx[p] = (r0 + 1) * stride + c0 + 1;
      const tr0 = fr - r0, tc0 = fc - c0;
      wr[p] = ((tr0 < 1 ? tr0 : 1) * 65535 + 0.5) | 0;
      wc[p] = ((tc0 < 1 ? tc0 : 1) * 65535 + 0.5) | 0;
      const x = cl * geo.cosLon[c], y = cl * geo.sinLon[c];
      sampleDetail(detail, R[0] * x + R[1] * y + R[2] * sl, R[3] * x + R[4] * y + R[5] * sl, R[6] * x + R[7] * y + R[8] * sl, smp, 0);
      const t = (1.6 * smp[CH_HILL] + 0.8 * smp[CH_COAST]) * 127;
      tex[p] = t > 127 ? 127 : t < -127 ? -127 : Math.round(t);
      const tf = 2.5 * smp[CH_HILL] * 127;
      fine[p] = tf > 127 ? 127 : tf < -127 ? -127 : Math.round(tf);
    }
  }
  return { w, h, cw, ch, stride, idx, wr, wc, tex, fine };
}

/**
 * Copy a cw×ch interleaved (k channels) grid into a padded (cw+3)×(ch+3) grid: padded cell (R, C)
 * holds source cell (clamp(R − 1), wrap(C − 1)).
 */
export function padGrid(src: Float32Array, cw: number, ch: number, k: number): Float32Array {
  const stride = cw + 3;
  const out = new Float32Array(stride * (ch + 3) * k);
  for (let r = 0; r < ch + 3; r++) {
    const sr = r < 1 ? 0 : r - 1 > ch - 1 ? ch - 1 : r - 1;
    for (let c = 0; c < stride; c++) {
      const sc = c < 1 ? cw - 1 : c - 1 >= cw ? c - 1 - cw : c - 1;
      const so = (sr * cw + sc) * k, dO = (r * stride + c) * k;
      for (let q = 0; q < k; q++) out[dO + q] = src[so + q];
    }
  }
  return out;
}

/**
 * Cubic B-spline weights of a fractional position t ∈ [0, 1) for the samples at −1, 0, 1, 2, into
 * out[o..o+3] (C² interpolant: no gradient kinks along the grid lines — thresholded fields such as
 * cover fractions show no cell outlines).
 */
export function bsplineWeights(t: number, out: Float64Array, o: number): void {
  const t2 = t * t, t3 = t2 * t;
  out[o] = (1 - 3 * t + 3 * t2 - t3) * (1 / 6);
  out[o + 1] = (3 * t3 - 6 * t2 + 4) * (1 / 6);
  out[o + 2] = (-3 * t3 + 3 * t2 + 3 * t + 1) * (1 / 6);
  out[o + 3] = t3 * (1 / 6);
}

/**
 * Cubic B-spline sample of channel `a` of a padded interleaved grid (k channels, row stride rs
 * values = stride·k) whose 4×4 footprint starts at value index q (= (idx − stride − 1)·k), with
 * weights bw[0..3] (rows) and bw[4..7] (columns).
 */
export function bspline16(g: Float32Array, q: number, rs: number, k: number, a: number, bw: Float64Array): number {
  const c0 = bw[4], c1 = bw[5], c2 = bw[6], c3 = bw[7];
  let s = 0;
  for (let i = 0, qi = q + a; i < 4; i++, qi += rs) {
    s += bw[i] * (c0 * g[qi] + c1 * g[qi + k] + c2 * g[qi + 2 * k] + c3 * g[qi + 3 * k]);
  }
  return s;
}
