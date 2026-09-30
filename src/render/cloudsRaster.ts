/**
 * Equirectangular cloud raster for the 2D map (pure, DOM-free; runs in the cloud worker): the globe's
 * cloud model (cloudsField.ts) without animation, at map resolution:
 *  - the climate-independent noise (synoptic shape, cirrus patches and texture variation at half
 *    resolution; the raw detail octaves and cirrus fibres per pixel) is computed once per raster size
 *    and cached;
 *  - per cloud spec: the regime grids, a coarse cyclone field (coverage bias, cirrus, open cells) and
 *    one pass per pixel (regime shaping of the octaves → threshold → optical depth → opacity), then
 *    cloud-top relief from per-pixel finite differences (lit from the north-west like the map's
 *    hillshade) and sRGB-encoded colours as on the globe in relief lighting.
 * No noise-domain swirl for the cyclones (their comma templates still shape the clouds).
 */
import type { CloudSpec } from '../core/types';
import {
  ALPHA_MAX, CELL_SCALE, cellFade, cellStage, cellularTexture, cirrusAlphaThr, cirrusFibre, closedCells, combineNoise, coverageThreshold, cycloneEffect, detailOctaves, detailParams,
  detailPlain, detailSum, newDetailShaping, octaveFade, OPEN_CELL_SCALE, openCells, opticalDepth, SHAPE_STAGE_SIZE, shapeStage,
} from './cloudsField';
import { analyzeCloudClimate, buildCloudGrids, CYCLONE_COUNT, CYCLONE_STRIDE, cycloneStates } from './cloudsModel';
import { CLOUD_CELL_EDGE_RANGE, cloudCellVolume, cloudDetailVolume, cloudNoiseVolume, type CloudNoiseVolume } from './cloudsNoise';

/** Detail octaves resolved on the map raster (the finer ones are sub-pixel at 2048 × 1024). */
const RASTER_OCTAVES = 2;
/** Quantization of the raw octave rasters (σ units → Int16). */
const Q = 4096;

export interface CloudNoiseRaster {
  w: number;
  h: number;
  /** Synoptic shape noise per pixel (≈ N(0,1)). */
  nb: Float32Array;
  /** Half-resolution cirrus patch and texture-variation noise (≈ N(0,1)), hw × hh. */
  hw: number;
  hh: number;
  cp: Float32Array;
  va: Float32Array;
  /** Raw detail octaves per pixel (σ·Q), RASTER_OCTAVES of them. */
  oct: Int16Array[];
  /** Raw cirrus fibre noise per pixel (σ·Q). */
  nc: Int16Array;
  /** Footprint fade of each octave at this raster's resolution. */
  fade: number[];
  /** Mesoscale cells per pixel: distance to the cell border (× 255 / CLOUD_CELL_EDGE_RANGE), cell id (× 255). */
  cellEdge: Uint8Array;
  cellId: Uint8Array;
  /** The same for the (larger) open cells. */
  openEdge: Uint8Array;
  cellFade: number;
  openFade: number;
}

/**
 * Static noise raster (row 0 north, column 0 at −180°); cache it. The smooth shape stage (warp and
 * synoptic noise, ≥ 500 km features) runs at half resolution and is interpolated; the detail fetches
 * run per pixel (~0.3–0.6 s at 2048 × 1024: build it off the main thread).
 */
export function buildCloudNoiseRaster(
  w: number, h: number, vol: CloudNoiseVolume = cloudNoiseVolume(), dvol: CloudNoiseVolume = cloudDetailVolume(),
  cvol: CloudNoiseVolume = cloudCellVolume(),
): CloudNoiseRaster {
  const n = w * h;
  const nb = new Float32Array(n), nc = new Int16Array(n);
  // Cells only where resolved at this raster's resolution (closed cells are sub-pixel at ≤ 2048 px).
  const cf0 = cellFade(Math.PI / h), of0 = cellFade(Math.PI / h, CELL_SCALE * OPEN_CELL_SCALE);
  const closedOn = cf0 > 0.02, openOn = of0 > 0.02;
  const cellEdge = new Uint8Array(closedOn ? n : 0), cellId = new Uint8Array(closedOn ? n : 0), openEdge = new Uint8Array(openOn ? n : 0);
  const cell = new Float64Array(2);
  const oct: Int16Array[] = [];
  for (let k = 0; k < RASTER_OCTAVES; k++) oct.push(new Int16Array(n));
  const tmp = new Float32Array(4);
  const hw = Math.max(4, w >> 1), hh = Math.max(2, h >> 1);
  const S = SHAPE_STAGE_SIZE;
  const half = new Float64Array(hw * hh * S);
  const st = new Float64Array(S);
  const cp = new Float32Array(hw * hh), va = new Float32Array(hw * hh);
  for (let r = 0; r < hh; r++) {
    const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / hh;
    const cl = Math.cos(lat), z = Math.sin(lat);
    for (let c = 0; c < hw; c++) {
      const lon = -Math.PI + ((c + 0.5) * 2 * Math.PI) / hw;
      shapeStage(vol, cl * Math.cos(lon), cl * Math.sin(lon), z, tmp, st);
      half.set(st, (r * hw + c) * S);
      cp[r * hw + c] = st[7];
      va[r * hw + c] = st[8];
    }
  }
  const ax = axisTable(w, hw, true), ay = axisTable(h, hh, false);
  const o = new Float64Array(RASTER_OCTAVES);
  const q = (x: number): number => Math.max(-32767, Math.min(32767, Math.round(x * Q)));
  for (let r = 0; r < h; r++) {
    const r0 = ay.i0[r] * hw, r1 = ay.i1[r] * hw, tr = ay.t[r];
    for (let c = 0; c < w; c++) {
      const c0 = ax.i0[c], c1 = ax.i1[c], tc = ax.t[c];
      const o00 = (r0 + c0) * S, o01 = (r0 + c1) * S, o10 = (r1 + c0) * S, o11 = (r1 + c1) * S;
      const w00 = (1 - tc) * (1 - tr), w01 = tc * (1 - tr), w10 = (1 - tc) * tr, w11 = tc * tr;
      for (let k = 0; k < S; k++) st[k] = w00 * half[o00 + k] + w01 * half[o01 + k] + w10 * half[o10 + k] + w11 * half[o11 + k];
      const i = r * w + c;
      nb[i] = st[3];
      detailOctaves(dvol, st, tmp, o, RASTER_OCTAVES);
      for (let k = 0; k < RASTER_OCTAVES; k++) oct[k][i] = q(o[k]);
      nc[i] = q(cirrusFibre(dvol, st, tmp));
      if (closedOn) {
        cellStage(cvol, st, tmp, cell);
        cellEdge[i] = Math.min(255, Math.round((cell[0] / CLOUD_CELL_EDGE_RANGE) * 255));
        cellId[i] = Math.round(cell[1] * 255);
      }
      if (openOn) {
        cellStage(cvol, st, tmp, cell, CELL_SCALE * OPEN_CELL_SCALE);
        openEdge[i] = Math.min(255, Math.round((cell[0] / CLOUD_CELL_EDGE_RANGE) * 255));
      }
    }
  }
  // Footprint fades as on the globe (a raster pixel spans π/h).
  const fade: number[] = [];
  for (let k = 0; k < RASTER_OCTAVES; k++) fade.push(octaveFade(Math.PI / h, k));
  return {
    w, h, nb, hw, hh, cp, va, oct, nc, fade, cellEdge, cellId, openEdge,
    cellFade: closedOn ? cf0 : 0, openFade: openOn ? of0 : 0,
  };
}

/** Bilinear lookup tables from raster pixels to grid cells along one axis. */
interface Axis {
  i0: Int32Array;
  i1: Int32Array;
  t: Float32Array;
}

function axisTable(n: number, gn: number, wrap: boolean): Axis {
  const i0 = new Int32Array(n), i1 = new Int32Array(n), t = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let f = ((i + 0.5) * gn) / n - 0.5;
    if (wrap) {
      if (f < 0) f += gn;
      const a = Math.floor(f);
      i0[i] = a % gn;
      i1[i] = (a + 1) % gn;
      t[i] = f - a;
    } else {
      f = Math.min(gn - 1, Math.max(0, f));
      const a = Math.floor(f);
      i0[i] = a;
      i1[i] = Math.min(gn - 1, a + 1);
      t[i] = f - a;
    }
  }
  return { i0, i1, t };
}

const BIAS_DIV = 6;

export interface CycloneFields {
  /** Coverage bias (σ units). */
  bias: Float32Array;
  /** Cirrus and open-cell contributions. */
  ci: Float32Array;
  op: Float32Array;
}

/**
 * Cyclone effects on a bw × bh grid, each storm evaluated only inside its latitude/longitude
 * bounding box.
 */
export function cycloneFields(cyc: Float32Array, bw: number, bh: number): CycloneFields {
  const bias = new Float32Array(bw * bh), ci = new Float32Array(bw * bh), op = new Float32Array(bw * bh);
  const e = new Float64Array(6);
  for (let k = 0; k < CYCLONE_COUNT; k++) {
    const o = k * CYCLONE_STRIDE;
    if (cyc[o + 4] <= 0.001) continue;
    const lat0 = Math.asin(Math.max(-1, Math.min(1, cyc[o + 2])));
    const lon0 = Math.atan2(cyc[o + 1], cyc[o]);
    const ext = 2.7 * cyc[o + 3];
    const la = Math.max(-Math.PI / 2, lat0 - ext), lb = Math.min(Math.PI / 2, lat0 + ext);
    const r0 = Math.max(0, Math.floor(((Math.PI / 2 - lb) / Math.PI) * bh - 0.5));
    const r1 = Math.min(bh - 1, Math.ceil(((Math.PI / 2 - la) / Math.PI) * bh - 0.5));
    const maxAbsLat = Math.max(Math.abs(la), Math.abs(lb));
    const dLon = maxAbsLat > 1.5 ? Math.PI : Math.min(Math.PI, ext / Math.cos(maxAbsLat));
    const c0 = Math.floor(((lon0 - dLon + Math.PI) / (2 * Math.PI)) * bw - 0.5);
    const c1 = Math.ceil(((lon0 + dLon + Math.PI) / (2 * Math.PI)) * bw - 0.5);
    for (let r = r0; r <= r1; r++) {
      const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / bh;
      const cl = Math.cos(lat), z = Math.sin(lat);
      for (let cc = c0; cc <= Math.min(c1, c0 + bw - 1); cc++) {
        const c = ((cc % bw) + bw) % bw;
        const lon = -Math.PI + ((c + 0.5) * 2 * Math.PI) / bw;
        cycloneEffect(cyc, cl * Math.cos(lon), cl * Math.sin(lon), z, e, false, k);
        const i = r * bw + c;
        bias[i] += e[0];
        ci[i] += e[4];
        op[i] += e[5];
      }
    }
  }
  return { bias, ci, op };
}

/** Cyclone coverage bias only (see cycloneFields). */
export function cycloneBiasField(cyc: Float32Array, bw: number, bh: number): Float32Array {
  return cycloneFields(cyc, bw, bh).bias;
}

export interface CloudRasterStats {
  /** Area-weighted mean opacity. */
  meanAlpha: number;
  /** Area fraction with opacity > 0.1. */
  cloudFraction: number;
}

/** Linear [0, 1.25] → sRGB byte (1/1024 steps). */
let srgbLut: Uint8Array | null = null;

function srgbByte(x: number): number {
  if (!srgbLut) {
    srgbLut = new Uint8Array(1281);
    for (let i = 0; i <= 1280; i++) {
      const c = Math.min(1, i / 1024);
      const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
      srgbLut[i] = Math.round(255 * s);
    }
  }
  const i = (x * 1024 + 0.5) | 0;
  return srgbLut[i < 0 ? 0 : i > 1280 ? 1280 : i];
}

/** Cloud-top relief height per σ of synoptic noise and of (thickness-weighted) detail, in map pixels. */
const RELIEF_SHAPE = 0.8;
const RELIEF_DETAIL = 0.35;

/**
 * Paints the clouds of `spec` into `out` (w·h·4 RGBA, straight alpha): cloud as on the globe in relief
 * lighting (thin cloud grey and translucent, mottled mid-thick cloud, bright cores, cloud-top relief
 * lit from the north-west, cirrus veils), with opacity × `opacity`. Returns area-weighted statistics.
 * `time` picks the cyclone snapshot (seconds on the globe's animation clock).
 */
export function rasterizeClouds(
  raster: CloudNoiseRaster, spec: CloudSpec, opacity: number, out: Uint8ClampedArray, time = 0,
): CloudRasterStats {
  const { w, h, nb, hw, hh, cp, va, oct, nc, fade, cellEdge, cellId, openEdge, cellFade: cf0, openFade: of0 } = raster;
  const gw = spec.w, gh = spec.h;
  const grids = buildCloudGrids(spec);
  const grid = grids.regime, aux = grids.aux;
  const climate = grids.climate ?? analyzeCloudClimate(spec);
  const cyc = cycloneStates(time, spec, climate, new Float32Array(CYCLONE_COUNT * CYCLONE_STRIDE));
  const bw = Math.max(8, Math.floor(w / BIAS_DIV)), bh = Math.max(4, Math.floor(h / BIAS_DIV));
  const cf = cycloneFields(cyc, bw, bh);
  const cx = axisTable(w, gw, true), cy = axisTable(h, gh, false);
  const bx = axisTable(w, bw, true), by = axisTable(h, bh, false);
  const hx = axisTable(w, hw, true), hy = axisTable(h, hh, false);
  const op = Math.max(0, Math.min(1, opacity));
  // Per-cell channels as floats (threshold in threshold space: bilinear there is close enough and
  // saves a log per pixel), then per raster row the vertically interpolated grid rows: the per-pixel
  // work is a 2-tap horizontal lerp.
  const n = gw * gh;
  const CH = 7; // f, zthr, sc, cv, cu, cirrus, open
  const cells = new Float32Array(n * CH);
  for (let i = 0; i < n; i++) {
    const o = i * CH;
    const f = grid[4 * i] / 255;
    cells[o] = f;
    cells[o + 1] = coverageThreshold(f);
    cells[o + 2] = grid[4 * i + 1] / 255;
    cells[o + 3] = grid[4 * i + 2] / 255;
    cells[o + 4] = grid[4 * i + 3] / 255;
    cells[o + 5] = aux[4 * i] / 255;
    cells[o + 6] = aux[4 * i + 1] / 255;
  }
  const rowG = new Float32Array(gw * CH);
  const rowB = new Float32Array(bw * 3);
  const rowH = new Float32Array(hw * 2);
  // First pass: optical depth, cirrus opacity and cloud-top height per pixel.
  const tauA = new Float32Array(w * h), cirA = new Float32Array(w * h), hgt = new Float32Array(w * h);
  const sh = newDetailShaping();
  // Coverage threshold of the cirrus fraction (0..1, 1/1023 steps; a log per pixel otherwise).
  const thrLut = new Float32Array(1024);
  for (let k = 0; k < 1024; k++) thrLut[k] = coverageThreshold(k / 1023);
  const o2 = new Float64Array(oct.length);
  const invQ = 1 / Q;
  for (let r = 0; r < h; r++) {
    const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
    const aLat = Math.abs(lat);
    const g0 = cy.i0[r] * gw * CH, g1 = cy.i1[r] * gw * CH, tr = cy.t[r];
    for (let k = 0; k < gw * CH; k++) rowG[k] = cells[g0 + k] + tr * (cells[g1 + k] - cells[g0 + k]);
    const b0 = by.i0[r] * bw, b1 = by.i1[r] * bw, tb = by.t[r];
    for (let c = 0; c < bw; c++) {
      rowB[3 * c] = cf.bias[b0 + c] + tb * (cf.bias[b1 + c] - cf.bias[b0 + c]);
      rowB[3 * c + 1] = cf.ci[b0 + c] + tb * (cf.ci[b1 + c] - cf.ci[b0 + c]);
      rowB[3 * c + 2] = cf.op[b0 + c] + tb * (cf.op[b1 + c] - cf.op[b0 + c]);
    }
    const h0 = hy.i0[r] * hw, h1 = hy.i1[r] * hw, th = hy.t[r];
    for (let c = 0; c < hw; c++) {
      rowH[2 * c] = cp[h0 + c] + th * (cp[h1 + c] - cp[h0 + c]);
      rowH[2 * c + 1] = va[h0 + c] + th * (va[h1 + c] - va[h0 + c]);
    }
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const c0 = cx.i0[c] * CH, c1 = cx.i1[c] * CH, tc = cx.t[c];
      const f = rowG[c0] + tc * (rowG[c1] - rowG[c0]);
      tauA[i] = 0;
      cirA[i] = 0;
      hgt[i] = nb[i];
      // No coverage, no cloud (the globe shader discards the same way).
      if (f < 0.004) continue;
      const d0 = bx.i0[c] * 3, d1 = bx.i1[c] * 3, tbx = bx.t[c];
      const bias = rowB[d0] + tbx * (rowB[d1] - rowB[d0]);
      const zthr = rowG[c0 + 1] + tc * (rowG[c1 + 1] - rowG[c0 + 1]) - bias;
      const nbv = nb[i];
      hgt[i] = nbv + bias;
      const e0 = hx.i0[c] * 2, e1 = hx.i1[c] * 2, the = hx.t[c];
      const cirrus = Math.min(1, rowG[c0 + 5] + tc * (rowG[c1 + 5] - rowG[c0 + 5]) + 0.5 * (rowB[d0 + 1] + tbx * (rowB[d1 + 1] - rowB[d0 + 1])));
      // Low cloud (skipped where no detail mix can lift the shape noise to the threshold).
      let exLow = nbv - zthr;
      if (nbv >= zthr - 2.8) {
        const sc = rowG[c0 + 2] + tc * (rowG[c1 + 2] - rowG[c0 + 2]);
        const cv = rowG[c0 + 3] + tc * (rowG[c1 + 3] - rowG[c0 + 3]);
        const cu = rowG[c0 + 4] + tc * (rowG[c1 + 4] - rowG[c0 + 4]);
        const open = Math.min(1, rowG[c0 + 6] + tc * (rowG[c1 + 6] - rowG[c0 + 6]) + (rowB[d0 + 2] + tbx * (rowB[d1 + 2] - rowB[d0 + 2])));
        const vary = rowH[e0 + 1] + the * (rowH[e1 + 1] - rowH[e0 + 1]);
        detailParams(sc, cv, cu, open, vary, sh);
        for (let k = 0; k < o2.length; k++) o2[k] = oct[k][i] * invQ;
        const ndv = detailSum(o2, o2.length, sh, fade);
        let ex = combineNoise(nbv, ndv, zthr, sc, cv, cu, sh.amp, bias) - zthr;
        let cells = 1;
        if (cf0 > 0 && sc > 0.02 && ex > -1.5) cells = closedCells(cellEdge[i] * (CLOUD_CELL_EDGE_RANGE / 255), cellId[i] / 255, sc, cf0);
        if (of0 > 0 && open > 0.02 && ex > -1.5) ex += openCells(openEdge[i] * (CLOUD_CELL_EDGE_RANGE / 255), open, of0, 0.3, ndv);
        exLow = ex;
        const tau = opticalDepth(ex, sc, cv, cu, aLat, cellularTexture(detailPlain(o2, o2.length, sh.gain, fade), ndv, sc, open), bias, cells);
        tauA[i] = tau;
        const depth = tau > 0 ? Math.min(1, tau / 1.5) * (0.6 + 0.5 * cv + 0.3 * cu) : 0;
        hgt[i] = nbv + bias + (RELIEF_DETAIL / RELIEF_SHAPE) * ndv * depth;
      }
      // Cirrus (not over optically thick low cloud, as on the globe).
      if (cirrus > 0.02 && exLow < 1.6) {
        const cpv = rowH[e0] + the * (rowH[e1] - rowH[e0]);
        const t = Math.max(0, Math.min(1, (exLow - 1.1) / 0.5));
        cirA[i] = cirrusAlphaThr(thrLut[(cirrus * 1023 + 0.5) | 0], cpv, nc[i] * invQ) * (1 - t * t * (3 - 2 * t));
      }
    }
  }
  // Second pass: relief (north-west light, per-pixel finite differences), colour, opacity.
  const px32 = new Uint32Array(out.buffer, out.byteOffset, w * h);
  let sa = 0, sf = 0, sw = 0;
  for (let r = 0; r < h; r++) {
    const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
    const area = Math.cos(lat);
    const kx = (RELIEF_SHAPE * 0.25) / Math.max(0.2, area);
    const rn = Math.max(0, r - 1) * w, rs = Math.min(h - 1, r + 1) * w, ro = r * w;
    let rowA = 0, rowF = 0;
    for (let c = 0; c < w; c++) {
      const i = ro + c;
      const tau = tauA[i], aC = cirA[i];
      if (tau <= 0 && aC <= 0) {
        px32[i] = 0;
        continue;
      }
      const al = ALPHA_MAX * (1 - Math.exp(-tau));
      const aTot = aC + al * (1 - aC);
      rowA += aTot;
      if (aTot > 0.1) rowF++;
      let relief = 1;
      if (tau > 0) {
        const cw = c === 0 ? w - 1 : c - 1, ce = c === w - 1 ? 0 : c + 1;
        const dx = (hgt[ro + ce] - hgt[ro + cw]) * kx; // eastward slope
        const dy = (hgt[rn + c] - hgt[rs + c]) * RELIEF_SHAPE * 0.25; // northward slope
        // Surfaces rising toward the light (north-west, 60° up) are lit.
        relief = Math.min(1.3, Math.max(0.6, 1 + (-dx + dy) * 0.6124));
      }
      const bright = (0.66 + 0.34 * (1 - Math.exp(-0.55 * tau))) * relief;
      // Cirrus over the low cloud (as on the globe).
      const lowW = al * (1 - aC);
      const k = aTot > 0 ? 1 / aTot : 0;
      const lr = (0.9 * aC + 0.93 * bright * lowW) * k;
      const lg = (0.93 * aC + 0.95 * bright * lowW) * k;
      const lb = (0.98 * aC + 0.98 * bright * lowW) * k;
      px32[i] = ((((255 * aTot * op + 0.5) | 0) << 24) | (srgbByte(lb) << 16) | (srgbByte(lg) << 8) | srgbByte(lr)) >>> 0;
    }
    sa += (rowA / w) * area;
    sf += (rowF / w) * area;
    sw += area;
  }
  return { meanAlpha: sw > 0 ? sa / sw : 0, cloudFraction: sw > 0 ? sf / sw : 0 };
}
