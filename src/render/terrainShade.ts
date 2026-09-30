/**
 * Metric gradients of the height map and relief shading helpers (equirectangular, lon wraps).
 */
import { EARTH_RADIUS_KM } from '../core/constants';
import type { PaintCache } from './paintCache';
import { blurMetric } from './terrainBase';

export interface GradientScales {
  w: number;
  h: number;
  /** Per row: 1 / (2·Δx) in 1/m (central difference east–west; Δx shrinks with cos(lat)). */
  invDx: Float64Array;
  /** 1 / (2·Δy) in 1/m. */
  invDy: number;
  /** Equatorial pixel size, km. */
  pixelKm: number;
  /**
   * Slope normalisation (Δ/10 km)^0.4: the RMS slope of fractal terrain measured over a baseline Δ
   * falls like Δ^(H−1); multiplying by this makes slope thresholds resolution independent.
   */
  slopeNorm: number;
}

export function gradientScales(w: number, h: number, cache: PaintCache): GradientScales {
  return cache.getOrBuild(`gradscales|${w}x${h}`, () => {
    const R = EARTH_RADIUS_KM * 1000;
    const dLat = Math.PI / h, dLon = (2 * Math.PI) / w;
    const invDx = new Float64Array(h);
    for (let r = 0; r < h; r++) {
      const cl = Math.cos(Math.PI / 2 - (r + 0.5) * dLat);
      invDx[r] = 1 / (2 * dLon * Math.max(1e-4, cl) * R);
    }
    const pixelKm = (dLon * R) / 1000;
    return { w, h, invDx, invDy: 1 / (2 * dLat * R), pixelKm, slopeNorm: Math.pow(pixelKm / 10, 0.4) };
  });
}

/** Light from the north-west, 40° above the horizon (east, north, up). */
const SUN_ALT = (40 * Math.PI) / 180;
const LX = -Math.cos(SUN_ALT) * Math.SQRT1_2;
const LY = Math.cos(SUN_ALT) * Math.SQRT1_2;
const LZ = Math.sin(SUN_ALT);

/**
 * Relief shading factor (1 on flat ground) for a metric gradient (gx east, gy north; m/m) with
 * vertical exaggeration `ex`. Range ≈ [0, 1/sin(40°)].
 */
export function hillshade(gx: number, gy: number, ex: number): number {
  const nx = -ex * gx, ny = -ex * gy;
  const d = (nx * LX + ny * LY + LZ) / Math.sqrt(nx * nx + ny * ny + 1);
  return d > 0 ? d / LZ : 0;
}

/** Vertical exaggeration for relief shading at a given pixel size (coarser pixels need more). */
export function shadeExaggeration(g: GradientScales): number {
  return 4 * g.slopeNorm;
}

/**
 * Soft multi-directional relief shading (MDOW-style: four light azimuths around the north-west,
 * 45° altitude) of slopes measured on a lightly smoothed surface (and partly the raw one, for
 * crisp crests), with vertical exaggeration growing on high / rugged terrain, times an
 * ambient-occlusion-like term from the height relative to its ~5-px neighbourhood mean (valleys and
 * basins darker, crests a touch brighter). Mountain ranges read clearly, plains stay subtle.
 * Land only (sea pixels = 1). Factor per pixel, 1 on flat open ground; cached per height field
 * (key = the height-field cache key). Stored as Uint8: factor = value × RELIEF_SHADE_SCALE.
 */
export function reliefShadeField(height: Float32Array, w: number, h: number, sea: number, key: string, cache: PaintCache): Uint8Array {
  return cache.getOrBuild(`reliefshade|${key}|${sea}`, () => buildReliefShade(height, w, h, sea, cache));
}

/** Scale of reliefShadeField values (factor = stored × RELIEF_SHADE_SCALE, 1 ≡ 160). */
export const RELIEF_SHADE_SCALE = 1 / 160;
/** Light azimuths (degrees clockwise from north) and weights of the multi-directional hillshade. */
const MD_AZ = [225, 270, 315, 360];
const MD_W = [0.15, 0.25, 0.45, 0.15];
const MD_ALT = (45 * Math.PI) / 180;
/** Base vertical exaggeration (× slopeNorm) and its extra on high / rugged terrain. */
const RS_EX = 5;
const RS_EX_MTN = 30;
/** Shading strength on plains / mountains. */
const RS_K_PLAIN = 0.55;
const RS_K_MTN = 1;
/** Ambient occlusion: darkening per unit of (h − local mean) / RS_AO_M, and its cap. */
const RS_AO_M = 450;
const RS_AO_K = 0.3;

/** Land surface clamped at sea level (the sea is flat for shading purposes). */
function atSea(v: number, sea: number): number {
  return v > sea ? v : sea;
}

function buildReliefShade(height: Float32Array, w: number, h: number, sea: number, cache: PaintCache): Uint8Array {
  const n = w * h;
  const gs = gradientScales(w, h, cache);
  const px = Math.PI / h;
  // Neighbourhood surface (land clamped at sea level), ~5 px Gaussian, computed at half resolution
  // (2×2 box means, blurred, bilinearly read back): the reference for the ambient occlusion and the
  // large-scale relief. Even rasters only; tiny / odd ones blur at full resolution.
  const half = (w & 1) === 0 && (h & 1) === 0 && w >= 64;
  const w2 = half ? w >> 1 : w, h2 = half ? h >> 1 : h;
  const b2 = new Float32Array(w2 * h2);
  if (half) {
    for (let r2 = 0; r2 < h2; r2++) {
      for (let c2 = 0; c2 < w2; c2++) {
        const p = 2 * r2 * w + 2 * c2;
        const a = height[p], b = height[p + 1], c = height[p + w], d = height[p + w + 1];
        b2[r2 * w2 + c2] = 0.25 * ((a > sea ? a : sea) + (b > sea ? b : sea) + (c > sea ? c : sea) + (d > sea ? d : sea));
      }
    }
    blurMetric(b2, w2, h2, Math.sqrt(25 - 1) * px);
  } else {
    for (let p = 0; p < n; p++) b2[p] = height[p] > sea ? height[p] : sea;
    blurMetric(b2, w, h, 5 * px);
  }
  const Lx = new Float64Array(4), Ly = new Float64Array(4);
  const cz = Math.cos(MD_ALT), sz = Math.sin(MD_ALT);
  for (let k = 0; k < 4; k++) {
    const az = (MD_AZ[k] * Math.PI) / 180;
    Lx[k] = cz * Math.sin(az);
    Ly[k] = cz * Math.cos(az);
  }
  const out = new Uint8Array(n);
  const ex0 = RS_EX * gs.slopeNorm, exM = RS_EX_MTN * gs.slopeNorm;
  // Half-resolution neighbour-surface reads: bilinear (sample r2 sits between rows 2·r2 and 2·r2 + 1).
  const bRow = new Float64Array(w2);
  for (let r = 0; r < h; r++) {
    const row = r * w;
    const rN = r > 0 ? r - 1 : 0, rS = r < h - 1 ? r + 1 : h - 1;
    const rowN = rN * w, rowS = rS * w;
    const rowNN = (r > 1 ? r - 2 : 0) * w, rowSS = (r < h - 2 ? r + 2 : h - 1) * w;
    const invDx = gs.invDx[r], invDy = gs.invDy;
    // This row of the neighbourhood surface.
    if (half) {
      const r2 = r >> 1;
      const rb = (r & 1) === 0 ? (r2 > 0 ? r2 - 1 : 0) : r2 + 1 < h2 ? r2 + 1 : h2 - 1;
      const oa = r2 * w2, ob = rb * w2;
      for (let c2 = 0; c2 < w2; c2++) bRow[c2] = 0.75 * b2[oa + c2] + 0.25 * b2[ob + c2];
    } else {
      for (let c = 0; c < w; c++) bRow[c] = b2[row + c];
    }
    // Vertical large-scale slope from the half-resolution rows above / below.
    const rU = half ? ((r >> 1) > 0 ? (r >> 1) - 1 : 0) * w2 : rN * w, rD = half ? ((r >> 1) + 1 < h2 ? (r >> 1) + 1 : h2 - 1) * w2 : rS * w;
    const bScaleY = half ? 0.25 : 0.5;
    for (let c = 0; c < w; c++) {
      const p = row + c;
      const hp = height[p];
      if (!(hp > sea)) {
        out[p] = 160;
        continue;
      }
      const ce = c + 1 < w ? c + 1 : 0, cw = c > 0 ? c - 1 : w - 1;
      const ce2 = c + 2 < w ? c + 2 : c + 2 - w, cw2 = c >= 2 ? c - 2 : c - 2 + w;
      // Slopes: a soft (5-px, Sobel-smoothed) estimate blended with the crisp central difference.
      const cxRaw = atSea(height[row + ce], sea) - atSea(height[row + cw], sea), cyRaw = atSea(height[rowN + c], sea) - atSea(height[rowS + c], sea);
      const sx = 0.25 * (atSea(height[rowN + ce2], sea) - atSea(height[rowN + cw2], sea) + 2 * (atSea(height[row + ce2], sea) - atSea(height[row + cw2], sea)) + atSea(height[rowS + ce2], sea) - atSea(height[rowS + cw2], sea)) * 0.5;
      const sy = 0.25 * (atSea(height[rowNN + cw], sea) - atSea(height[rowSS + cw], sea) + 2 * (atSea(height[rowNN + c], sea) - atSea(height[rowSS + c], sea)) + atSea(height[rowNN + ce], sea) - atSea(height[rowSS + ce], sea)) * 0.5;
      const gx = (0.6 * sx + 0.4 * cxRaw) * invDx;
      const gy = (0.6 * sy + 0.4 * cyRaw) * invDy;
      // Mountainousness: altitude of the neighbourhood and its large-scale slope.
      let bp: number, bx: number;
      if (half) {
        const c2 = c >> 1;
        const cb = (c & 1) === 0 ? (c2 > 0 ? c2 - 1 : w2 - 1) : c2 + 1 < w2 ? c2 + 1 : 0;
        bp = 0.75 * bRow[c2] + 0.25 * bRow[cb];
        bx = (bRow[c2 + 1 < w2 ? c2 + 1 : 0] - bRow[c2 > 0 ? c2 - 1 : w2 - 1]) * 0.5 * invDx;
      } else {
        bp = bRow[c];
        bx = (bRow[ce] - bRow[cw]) * invDx;
      }
      const cc = half ? c >> 1 : c;
      const by = (b2[rU + cc] - b2[rD + cc]) * bScaleY * 2 * invDy;
      let mtn = (bp - sea - 300) * (1 / 2500);
      const big = Math.sqrt(bx * bx + by * by) * gs.slopeNorm * (1 / 0.03);
      if (big > mtn) mtn = big;
      mtn = mtn < 0 ? 0 : mtn > 1 ? 1 : mtn * mtn * (3 - 2 * mtn);
      const ex = ex0 + exM * mtn;
      const nx = -ex * gx, ny = -ex * gy;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      let s = 0;
      for (let k = 0; k < 4; k++) {
        const d = (nx * Lx[k] + ny * Ly[k] + sz) * inv;
        s += MD_W[k] * (d > 0 ? d : 0);
      }
      s *= 1 / sz;
      const k = RS_K_PLAIN + (RS_K_MTN - RS_K_PLAIN) * mtn;
      let f = 1 + k * (s - 1);
      // Ambient occlusion: valleys below the local mean darker, crests slightly brighter — within
      // the uplands only (lowland plains at the foot of a range are not valleys of it).
      let a = (hp - bp) * (1 / RS_AO_M);
      a = a < -1 ? -1 : a > 1 ? 1 : a;
      let up = (hp - sea - 400) * (1 / 1400);
      up = up < 0 ? 0 : up > 1 ? 1 : up * up * (3 - 2 * up);
      f *= 1 + RS_AO_K * (a < 0 ? a : 0.35 * a) * up * (0.4 + 0.6 * mtn);
      out[p] = ((f < 0.35 ? 0.35 : f > 1.45 ? 1.45 : f) * 160 + 0.5) | 0;
    }
  }
  return out;
}
