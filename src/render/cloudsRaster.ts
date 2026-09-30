/**
 * Equirectangular cloud raster for the 2D map (pure, DOM-free): the globe's cloud model (cloudsField.ts)
 * without animation, at map resolution and a fraction of the cost:
 *  - the climate-independent noise (synoptic shape, mesoscale detail and a hillshade-like relief
 *    term) is computed once per raster size and cached;
 *  - per cloud spec only the regime grid, a quarter-resolution cyclone bias field and one cheap pass
 *    per pixel (threshold → optical depth → opacity) run (a few tens of ms at 1024×512).
 * No noise-domain swirl for the cyclones (their comma templates still shape the clouds).
 */
import type { CloudSpec } from '../core/types';
import {
  ALPHA_MAX, combineNoise, coverageThreshold, cycloneEffect, detailStage, opticalDepth, shapeStage,
} from './cloudsField';
import { analyzeCloudClimate, buildCloudRegimeGrid, CYCLONE_COUNT, CYCLONE_STRIDE, cycloneStates } from './cloudsModel';
import { cloudNoiseVolume, type CloudNoiseVolume } from './cloudsNoise';

export interface CloudNoiseRaster {
  w: number;
  h: number;
  /** Synoptic shape noise per pixel (≈ N(0,1)). */
  nb: Float32Array;
  /** Mesoscale detail noise per pixel (≈ N(0,1)). */
  nd: Float32Array;
  /** Brightness factor from the synoptic noise lit from the map's up-left (≈ 0.75…1.15). */
  relief: Float32Array;
}

/**
 * Static noise raster (row 0 north, column 0 at −180°); cache it. The smooth shape stage (warp and
 * synoptic noise, ≥ 500 km features) runs at half resolution and is interpolated; only the detail
 * fetch runs per pixel (~30–45 ms at 1024×512).
 */
export function buildCloudNoiseRaster(w: number, h: number, vol: CloudNoiseVolume = cloudNoiseVolume()): CloudNoiseRaster {
  const n = w * h;
  const nb = new Float32Array(n), nd = new Float32Array(n), relief = new Float32Array(n);
  const tmp = new Float32Array(4);
  const hw = Math.max(4, w >> 1), hh = Math.max(2, h >> 1);
  const S = 7;
  const half = new Float64Array(hw * hh * S);
  const st = new Float64Array(S);
  for (let r = 0; r < hh; r++) {
    const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / hh;
    const cl = Math.cos(lat), z = Math.sin(lat);
    for (let c = 0; c < hw; c++) {
      const lon = -Math.PI + ((c + 0.5) * 2 * Math.PI) / hw;
      shapeStage(vol, cl * Math.cos(lon), cl * Math.sin(lon), z, tmp, st);
      half.set(st, (r * hw + c) * S);
    }
  }
  const ax = axisTable(w, hw, true), ay = axisTable(h, hh, false);
  for (let r = 0; r < h; r++) {
    const r0 = ay.i0[r] * hw, r1 = ay.i1[r] * hw, tr = ay.t[r];
    for (let c = 0; c < w; c++) {
      const c0 = ax.i0[c], c1 = ax.i1[c], tc = ax.t[c];
      const o00 = (r0 + c0) * S, o01 = (r0 + c1) * S, o10 = (r1 + c0) * S, o11 = (r1 + c1) * S;
      const w00 = (1 - tc) * (1 - tr), w01 = tc * (1 - tr), w10 = (1 - tc) * tr, w11 = tc * tr;
      for (let k = 0; k < S; k++) st[k] = w00 * half[o00 + k] + w01 * half[o01 + k] + w10 * half[o10 + k] + w11 * half[o11 + k];
      nb[r * w + c] = st[3];
      nd[r * w + c] = detailStage(vol, st, tmp, false);
    }
  }
  // Relief: the synoptic noise as a cloud-top height lit from the north-west (like the map's hillshade).
  const k = 0.35 * (w / 1024);
  for (let r = 0; r < h; r++) {
    const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
    const kx = k / Math.max(0.2, Math.cos(lat));
    const rn = Math.max(0, r - 1) * w, rs = Math.min(h - 1, r + 1) * w, ro = r * w;
    for (let c = 0; c < w; c++) {
      const cw = c === 0 ? w - 1 : c - 1, ce = c === w - 1 ? 0 : c + 1;
      const dx = (nb[ro + ce] - nb[ro + cw]) * kx; // eastward slope
      const dy = (nb[rn + c] - nb[rs + c]) * k; // northward slope
      // Surfaces rising toward the light (north-west) are lit: slope · (−1, +1)/√2.
      const s = (-dx + dy) * 0.7071;
      relief[ro + c] = Math.min(1.15, Math.max(0.75, 1 + s));
    }
  }
  return { w, h, nb, nd, relief };
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

/**
 * Cyclone bias (σ units) on a (w/BIAS_DIV)×(h/BIAS_DIV) grid, each storm evaluated only inside its
 * latitude/longitude bounding box.
 */
export function cycloneBiasField(cyc: Float32Array, bw: number, bh: number): Float32Array {
  const bias = new Float32Array(bw * bh);
  const e = new Float64Array(4);
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
        bias[r * bw + c] += e[0];
      }
    }
  }
  return bias;
}

export interface CloudRasterStats {
  /** Area-weighted mean opacity. */
  meanAlpha: number;
  /** Area fraction with opacity > 0.1. */
  cloudFraction: number;
}

/**
 * Paints the clouds of `spec` into `out` (w·h·4 RGBA, straight alpha): white-grey cloud (thin cloud
 * greyer, relief from the static raster) with opacity × `opacity`. Returns area-weighted statistics.
 * `time` picks the cyclone snapshot (seconds on the globe's animation clock).
 */
export function rasterizeClouds(
  raster: CloudNoiseRaster, spec: CloudSpec, opacity: number, out: Uint8ClampedArray, time = 0,
): CloudRasterStats {
  const { w, h, nb, nd, relief } = raster;
  const gw = spec.w, gh = spec.h;
  const grid = buildCloudRegimeGrid(spec);
  // Per-cell threshold (bilinear in threshold space is close enough and saves a log per pixel).
  const zthrGrid = new Float32Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) zthrGrid[i] = coverageThreshold(grid[4 * i] / 255);
  const climate = analyzeCloudClimate(spec);
  const cyc = cycloneStates(time, spec, climate, new Float32Array(CYCLONE_COUNT * CYCLONE_STRIDE));
  const bw = Math.max(8, Math.floor(w / BIAS_DIV)), bh = Math.max(4, Math.floor(h / BIAS_DIV));
  const bias = cycloneBiasField(cyc, bw, bh);
  const cx = axisTable(w, gw, true), cy = axisTable(h, gh, false);
  const bx = axisTable(w, bw, true), by = axisTable(h, bh, false);
  const op = Math.max(0, Math.min(1, opacity));
  const px32 = new Uint32Array(out.buffer, out.byteOffset, w * h);
  // Per-cell channels as floats, then per raster row the vertically interpolated grid rows: the
  // per-pixel work is a 2-tap horizontal lerp.
  const n = gw * gh;
  const fG = new Float32Array(n), scG = new Float32Array(n), cvG = new Float32Array(n), cuG = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    fG[i] = grid[4 * i] / 255;
    scG[i] = grid[4 * i + 1] / 255;
    cvG[i] = grid[4 * i + 2] / 255;
    cuG[i] = grid[4 * i + 3] / 255;
  }
  const fRow = new Float32Array(gw), zRow = new Float32Array(gw), scRow = new Float32Array(gw), cvRow = new Float32Array(gw), cuRow = new Float32Array(gw);
  const bRow = new Float32Array(bw);
  let sa = 0, sf = 0, sw = 0;
  for (let r = 0; r < h; r++) {
    const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
    const aLat = Math.abs(lat), area = Math.cos(lat);
    const g0 = cy.i0[r] * gw, g1 = cy.i1[r] * gw, tr = cy.t[r];
    for (let c = 0; c < gw; c++) {
      fRow[c] = fG[g0 + c] + tr * (fG[g1 + c] - fG[g0 + c]);
      zRow[c] = zthrGrid[g0 + c] + tr * (zthrGrid[g1 + c] - zthrGrid[g0 + c]);
      scRow[c] = scG[g0 + c] + tr * (scG[g1 + c] - scG[g0 + c]);
      cvRow[c] = cvG[g0 + c] + tr * (cvG[g1 + c] - cvG[g0 + c]);
      cuRow[c] = cuG[g0 + c] + tr * (cuG[g1 + c] - cuG[g0 + c]);
    }
    const b0 = by.i0[r] * bw, b1 = by.i1[r] * bw, tb = by.t[r];
    for (let c = 0; c < bw; c++) bRow[c] = bias[b0 + c] + tb * (bias[b1 + c] - bias[b0 + c]);
    let rowA = 0, rowF = 0;
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const c0 = cx.i0[c], c1 = cx.i1[c], tc = cx.t[c];
      // No coverage, no cloud (the globe shader discards the same way).
      if (fRow[c0] + tc * (fRow[c1] - fRow[c0]) < 0.004) {
        px32[i] = 0;
        continue;
      }
      const d0 = bx.i0[c], d1 = bx.i1[c];
      const zthr = zRow[c0] + tc * (zRow[c1] - zRow[c0]) - (bRow[d0] + bx.t[c] * (bRow[d1] - bRow[d0]));
      const nbv = nb[i];
      // Early out: no detail mix can lift the shape noise this far (|a·nd| ≲ 2.5 σ).
      if (nbv + 2.5 < zthr) {
        px32[i] = 0;
        continue;
      }
      const sc = scRow[c0] + tc * (scRow[c1] - scRow[c0]);
      const cv = cvRow[c0] + tc * (cvRow[c1] - cvRow[c0]);
      const cu = cuRow[c0] + tc * (cuRow[c1] - cuRow[c0]);
      const ndv = nd[i];
      const ex = combineNoise(nbv, ndv, zthr, sc, cv, cu) - zthr;
      const tau = opticalDepth(ex, sc, cv, cu, aLat, ndv);
      if (tau <= 0) {
        px32[i] = 0;
        continue;
      }
      const e = 1 - Math.exp(-tau);
      const al = ALPHA_MAX * e;
      rowA += al;
      if (al > 0.1) rowF++;
      // Thin cloud reflects less than thick cloud (as on the globe, slightly simplified); faintly
      // blue-white.
      const v = 250 * (0.7 + 0.3 * e) * relief[i];
      const rr = v > 255 ? 255 : v | 0;
      const gg = v * 1.01 > 255 ? 255 : (v * 1.01) | 0;
      const bb = v * 1.04 > 255 ? 255 : (v * 1.04) | 0;
      px32[i] = ((((255 * al * op + 0.5) | 0) << 24) | (bb << 16) | (gg << 8) | rr) >>> 0;
    }
    sa += (rowA / w) * area;
    sf += (rowF / w) * area;
    sw += area;
  }
  return { meanAlpha: sw > 0 ? sa / sw : 0, cloudFraction: sw > 0 ? sf / sw : 0 };
}
