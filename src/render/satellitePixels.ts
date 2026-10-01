/**
 * Per-pixel cache of the satellite's climate attributes (preview-sized rasters). The attribute grids
 * and the warped sampler are world-frame and static per (climate, month, raster, seed), so during
 * tectonic playback — a new snapshot every frame, the same climate for many frames — the 4-tap
 * bilinear interpolation of ~20 channels per pixel is done once and each frame reads one compact
 * record per pixel instead. Values are 16-bit fixed point (colours / fractions × 65535,
 * temperatures (T + 100) × 400).
 *
 * Records are filled lazily by the painter (fillLand / fillOcean the first time a pixel is painted
 * as land / sea), so a new climate or month costs no separate full-raster pass: the first frame
 * interpolates only what it paints, as the uncached path does. The painter always reads the
 * decoded record, so the output never depends on which frame filled it.
 */
import type { PaintCache } from './paintCache';
import * as _satelliteBiome from './satelliteBiome';
import type { ClimateSampler } from './satelliteSampler';
import * as _satelliteSampler from './satelliteSampler';

const {
  A_COVER, A_DESERT, A_EVER, A_GRASS, A_HIDED, A_HOT, A_PANN, A_SHEET, A_SNOWSUP, A_SOIL, A_TREE, A_TREES, A_TSNOW, A_TWARM,
  A_WET, A_WINDE, A_WINDN, LAND_K, O_ICE, O_SST, OCEAN_K,
} = _satelliteBiome;
const { bspline16, bsplineWeights } = _satelliteSampler;

/** Record layout (Uint16 per pixel). */
export const PX_SOIL = 0; // 3
export const PX_GRASS = 3; // 3
export const PX_TREE = 6; // 3
export const PX_COVER = 9;
export const PX_TREES = 10;
export const PX_TWARM = 11;
export const PX_TSNOW = 12;
export const PX_SNOWSUP = 13;
export const PX_DESERT = 14;
export const PX_HOT = 15;
export const PX_WET = 16;
export const PX_SHEET = 17;
export const PX_ICE = 18;
export const PX_SST = 19;
export const PX_PANN = 20;
export const PX_EVER = 21;
export const PX_HIDED = 22;
export const PX_WINDE = 23;
export const PX_WINDN = 24;
export const PX_K = 25;
/** Encoding scales: fractions / linear colours, temperatures ((T − PX_T0) × ENC_T), precipitation (m/yr), winds. */
const ENC_U = 65535;
const ENC_T = 400;
const ENC_P = 65535 / 8;
const ENC_W = 65535 / 2;
/** Decoding of PX_PANN (m/yr) and of the wind components (x·PX_W − 1). */
export const PX_P = 1 / ENC_P;
export const PX_W = 1 / ENC_W;
/** Decoding: fractions / linear colours, temperatures. */
export const PX_U = 1 / ENC_U;
export const PX_T = 1 / ENC_T;
export const PX_T0 = -100;
/** PixelAttributes.ok bits: land / ocean part of the record filled. */
export const PX_OK_LAND = 1;
export const PX_OK_OCEAN = 2;

/** Largest raster (pixels) whose attributes are cached (the preview size). */
const MAX_PIXELS = 1024 * 512;

/**
 * Land channels: record slot, grid attribute, and the fixed-point encoding x = (v − off)·scale
 * (typed tables: no per-channel branching in the fill loop).
 */
const LAND_DST = Int32Array.from([
  PX_SOIL, PX_SOIL + 1, PX_SOIL + 2, PX_GRASS, PX_GRASS + 1, PX_GRASS + 2, PX_TREE, PX_TREE + 1, PX_TREE + 2,
  PX_COVER, PX_TREES, PX_TWARM, PX_TSNOW, PX_SNOWSUP, PX_DESERT, PX_HOT, PX_WET, PX_SHEET,
  PX_PANN, PX_EVER, PX_HIDED, PX_WINDE, PX_WINDN,
]);
const LAND_SRC = Int32Array.from([
  A_SOIL, A_SOIL + 1, A_SOIL + 2, A_GRASS, A_GRASS + 1, A_GRASS + 2, A_TREE, A_TREE + 1, A_TREE + 2,
  A_COVER, A_TREES, A_TWARM, A_TSNOW, A_SNOWSUP, A_DESERT, A_HOT, A_WET, A_SHEET,
  A_PANN, A_EVER, A_HIDED, A_WINDE, A_WINDN,
]);
const LAND_OFF = Float64Array.from(LAND_DST, (d) => (d === PX_TWARM || d === PX_TSNOW ? PX_T0 : d === PX_WINDE || d === PX_WINDN ? -1 : 0));
const LAND_SCALE = Float64Array.from(LAND_DST, (d) => (
  d === PX_TWARM || d === PX_TSNOW ? ENC_T : d === PX_PANN ? ENC_P : d === PX_WINDE || d === PX_WINDN ? ENC_W : ENC_U
));
const NL = LAND_DST.length;

/** Per-pixel attribute records (PX_K Uint16 per pixel) and which parts of each are filled. */
export interface PixelAttributes {
  rec: Uint16Array;
  ok: Uint8Array;
}

/**
 * Cached per-pixel attribute records, or null when the raster is larger than the preview size.
 * `gridKey` identifies the attribute grid; the sampler (warp) is identified by its size and seed.
 */
export function pixelAttributes(smp: ClimateSampler, gridKey: string, seed: number, cache: PaintCache): PixelAttributes | null {
  const npx = smp.w * smp.h;
  if (npx > MAX_PIXELS) return null;
  const s = Math.floor(seed) | 0;
  return cache.getOrBuild(`satpix|${gridKey}|${smp.w}x${smp.h}|${smp.cw}x${smp.ch}|${s}`, () => ({
    rec: new Uint16Array(npx * PX_K),
    ok: new Uint8Array(npx),
  }));
}

/**
 * Land attribute channels interpolated with the C² cubic B-spline (the fractions and temperatures
 * that mosaics and belts threshold); the others (colours, winds, blend weights) bilinearly. The full
 * quality path (satellite.ts) uses the same split, so preview and full agree.
 */
export const LAND_BSPLINE = Int32Array.from([A_COVER, A_TREES, A_TWARM, A_TSNOW, A_SNOWSUP, A_DESERT, A_SHEET]);
const IS_BS = Uint8Array.from(LAND_SRC, (a) => (LAND_BSPLINE.includes(a) ? 1 : 0));
const BW = new Float64Array(8);

/**
 * Fill the land part of record `o` (= p·PX_K) from the padded land grid at the sampler position:
 * bilinear corner index i00 (padded cells) with fractional offsets fr (row), fc (column).
 */
export function fillLand(rec: Uint16Array, o: number, LG: Float32Array, i00: number, stride: number, fr: number, fc: number): void {
  const lStride = stride * LAND_K;
  const q00 = i00 * LAND_K, q01 = q00 + LAND_K, q10 = q00 + lStride, q11 = q10 + LAND_K;
  const w00 = (1 - fr) * (1 - fc), w01 = (1 - fr) * fc, w10 = fr * (1 - fc), w11 = fr * fc;
  bsplineWeights(fr, BW, 0);
  bsplineWeights(fc, BW, 4);
  const qb = (i00 - stride - 1) * LAND_K;
  for (let k = 0; k < NL; k++) {
    const a = LAND_SRC[k];
    const v = IS_BS[k] === 1
      ? bspline16(LG, qb, lStride, LAND_K, a, BW)
      : w00 * LG[q00 + a] + w01 * LG[q01 + a] + w10 * LG[q10 + a] + w11 * LG[q11 + a];
    const x = (v - LAND_OFF[k]) * LAND_SCALE[k];
    rec[o + LAND_DST[k]] = x <= 0 ? 0 : x >= 65535 ? 65535 : (x + 0.5) | 0;
  }
}

/** Fill the ocean part (sea ice, SST) of record `o` from the padded ocean grid (corners as fillLand). */
export function fillOcean(
  rec: Uint16Array, o: number, OG: Float32Array, r00: number, oStride: number, w00: number, w01: number, w10: number, w11: number,
): void {
  const r01 = r00 + OCEAN_K, r10 = r00 + oStride, r11 = r10 + OCEAN_K;
  let x = (w00 * OG[r00 + O_ICE] + w01 * OG[r01 + O_ICE] + w10 * OG[r10 + O_ICE] + w11 * OG[r11 + O_ICE]) * ENC_U;
  rec[o + PX_ICE] = x <= 0 ? 0 : x >= 65535 ? 65535 : (x + 0.5) | 0;
  x = (w00 * OG[r00 + O_SST] + w01 * OG[r01 + O_SST] + w10 * OG[r10 + O_SST] + w11 * OG[r11 + O_SST] - PX_T0) * ENC_T;
  rec[o + PX_SST] = x <= 0 ? 0 : x >= 65535 ? 65535 : (x + 0.5) | 0;
}
