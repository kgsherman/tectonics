/**
 * Static per-pixel lookup from the display raster into a (padded) climate grid, with a
 * low-frequency isotropic domain warp (world frame, ~1.5 climate cells) so climate-cell and class
 * boundaries become organic instead of following the grid. Also carries a world-frame texture
 * noise per pixel (sea-ice floes, cloud-free haze variation).
 *
 * Attribute grids sampled through it are stored with one extra column (copy of column 0) and one
 * extra row (copy of the last row): corner offsets are then idx, idx+1, idx+stride, idx+stride+1.
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

export interface ClimateSampler {
  w: number;
  h: number;
  cw: number;
  ch: number;
  /** cw + 1: row stride of padded attribute grids. */
  stride: number;
  /** Per pixel: padded-grid index of the top-left bilinear corner. */
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
  const stride = cw + 1;

  // Warp offsets on a coarse raster (the warp is smooth), bilinearly upsampled per pixel.
  const gw = Math.max(8, Math.min(w, Math.ceil(cw * 1.5)));
  const gh = Math.max(4, Math.min(h, Math.ceil(ch * 1.5)));
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

  // Separable bilinear tables into the coarse warp raster (per column / per row).
  const gcA = new Int32Array(w), gcB = new Int32Array(w), gcT = new Float64Array(w), colBase = new Float64Array(w);
  for (let c = 0; c < w; c++) {
    const gc = ((c + 0.5) * gw) / w - 0.5;
    const gcf = Math.floor(gc);
    const g0 = ((gcf % gw) + gw) % gw;
    gcA[c] = g0;
    gcB[c] = g0 + 1 < gw ? g0 + 1 : 0;
    gcT[c] = gc - gcf;
    colBase[c] = ((c + 0.5) * cw) / w - 0.5;
  }
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
    const gr0 = Math.max(0, Math.min(gh - 1, Math.floor(gr)));
    const gr1 = Math.min(gh - 1, gr0 + 1);
    const tr = Math.max(0, Math.min(1, gr - gr0));
    const o0 = gr0 * gw, o1 = gr1 * gw;
    const baseRow = ((Math.PI / 2 - la) / Math.PI) * ch - 0.5;
    // East offset in columns: metric warp ⇒ divide by cos(lat) (capped near the poles).
    const colScale = (WARP_CELLS * (Math.PI / ch)) / (Math.max(0.05, cl) * dLonC);
    for (let c = 0; c < w; c++) {
      const p = r * w + c;
      const a0 = gcA[c], a1 = gcB[c], tc = gcT[c];
      const e = (warpE[o0 + a0] + (warpE[o0 + a1] - warpE[o0 + a0]) * tc) * (1 - tr)
        + (warpE[o1 + a0] + (warpE[o1 + a1] - warpE[o1 + a0]) * tc) * tr;
      const nv = (warpN[o0 + a0] + (warpN[o0 + a1] - warpN[o0 + a0]) * tc) * (1 - tr)
        + (warpN[o1 + a0] + (warpN[o1 + a1] - warpN[o1 + a0]) * tc) * tr;
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
      idx[p] = r0 * stride + c0;
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

/** Copy a cw×ch interleaved (k channels) grid into a padded (cw+1)×(ch+1) grid. */
export function padGrid(src: Float32Array, cw: number, ch: number, k: number): Float32Array {
  const stride = cw + 1;
  const out = new Float32Array(stride * (ch + 1) * k);
  for (let r = 0; r <= ch; r++) {
    const sr = r < ch ? r : ch - 1;
    for (let c = 0; c <= cw; c++) {
      const sc = c < cw ? c : 0;
      const so = (sr * cw + sc) * k, dO = (r * stride + c) * k;
      for (let q = 0; q < k; q++) out[dO + q] = src[so + q];
    }
  }
  return out;
}
