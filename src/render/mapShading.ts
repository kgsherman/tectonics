/**
 * CPU shading for the 2D map (pure; operates on typed arrays):
 *  - relief hillshade from the height map, matching the globe's 'relief' mode (light 35° above the
 *    horizon from the north-west, 1.0 on flat ground, seas flat at the display sea level);
 *  - day/night shading for 'sun' mode from the solar zenith angle;
 *  - cloud alpha from a cover field and a static noise field (same thresholding as the globe).
 */
import { PLANET_RADIUS_M, SHADE_EXAGGERATION } from './viewUtil';

const SIN_ALT = Math.sin((35 * Math.PI) / 180);
const COS_ALT = Math.cos((35 * Math.PI) / 180);

const SRGB_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  SRGB_TO_LIN[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
const LIN_LUT_SIZE = 4096;
const LIN_TO_SRGB = new Uint8Array(LIN_LUT_SIZE + 1);
for (let i = 0; i <= LIN_LUT_SIZE; i++) {
  const v = i / LIN_LUT_SIZE;
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  LIN_TO_SRGB[i] = Math.round(Math.min(1, Math.max(0, s)) * 255);
}

/**
 * Per-pixel relief shade factor (1 = flat) for a w×h row-0-north height map. Heights below
 * `seaLevel` are clamped to it so seas render flat.
 */
export function hillshade(height: Float32Array, w: number, h: number, seaLevel: number, exaggeration = SHADE_EXAGGERATION): Float32Array {
  const n = w * h;
  const out = new Float32Array(n);
  // Sea-clamped copy so the stencil loop is branch-free.
  const hc = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = height[i];
    hc[i] = v > seaLevel ? v : seaLevel;
  }
  const dLat = Math.PI / h, dLon = (2 * Math.PI) / w;
  // Light toward the north-west: (east, north, up), pre-divided by sin(alt) so flat ground = 1.
  const lx = (-COS_ALT * Math.SQRT1_2) / SIN_ALT, ly = (COS_ALT * Math.SQRT1_2) / SIN_ALT;
  const k = exaggeration / PLANET_RADIUS_M;
  for (let r = 0; r < h; r++) {
    const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
    const cosLat = Math.max(Math.cos(lat), 0.5 * dLat);
    const rn = r > 0 ? r - 1 : 0, rs = r < h - 1 ? r + 1 : h - 1;
    // Gradients per radian of arc (m) times k: dimensionless exaggerated slopes.
    const ky = k / ((rs - rn) * dLat);
    const kx = k / (2 * dLon * cosLat);
    const row = r * w, rowN = rn * w, rowS = rs * w;
    for (let c = 0; c < w; c++) {
      const ce = c + 1 < w ? c + 1 : 0, cw = c > 0 ? c - 1 : w - 1;
      const gx = (hc[row + ce] - hc[row + cw]) * kx;
      const gy = (hc[rowN + c] - hc[rowS + c]) * ky;
      const rel = (1 - gx * lx - gy * ly) / Math.sqrt(gx * gx + gy * gy + 1);
      // Same response as the globe shader: full shadows, compressed highlights.
      out[row + c] = rel < 1 ? Math.max(0.28, 1 + 0.85 * (rel - 1)) : Math.min(1.35, 1 + 0.45 * (rel - 1));
    }
  }
  return out;
}

/**
 * Multiplies an sRGB RGBA image (iw×ih) by a shade field (sw×sh, nearest sampling) in linear light.
 * Writes into `out` (may alias `rgba`).
 */
export function applyShade(
  rgba: Uint8ClampedArray, iw: number, ih: number, shade: Float32Array, sw: number, sh: number, out: Uint8ClampedArray,
): void {
  const colMap = new Int32Array(iw);
  for (let c = 0; c < iw; c++) colMap[c] = Math.min(sw - 1, Math.floor(((c + 0.5) * sw) / iw));
  const top = LIN_LUT_SIZE;
  for (let r = 0; r < ih; r++) {
    const srow = Math.min(sh - 1, Math.floor(((r + 0.5) * sh) / ih)) * sw;
    let i = 4 * r * iw;
    for (let c = 0; c < iw; c++, i += 4) {
      const f = shade[srow + colMap[c]] * top;
      const a = SRGB_TO_LIN[rgba[i]] * f, b = SRGB_TO_LIN[rgba[i + 1]] * f, d = SRGB_TO_LIN[rgba[i + 2]] * f;
      out[i] = LIN_TO_SRGB[a < top ? a | 0 : top];
      out[i + 1] = LIN_TO_SRGB[b < top ? b | 0 : top];
      out[i + 2] = LIN_TO_SRGB[d < top ? d | 0 : top];
      out[i + 3] = rgba[i + 3];
    }
  }
}

/**
 * Night-side darkening as a black RGBA layer (alpha = 1 − light) for subsolar point
 * (declination, sunLon): full light near the subsolar point, soft terminator, dim night.
 */
export function nightShade(w: number, h: number, declination: number, sunLon: number, out?: Uint8ClampedArray): Uint8ClampedArray {
  const img = out && out.length === w * h * 4 ? out : new Uint8ClampedArray(w * h * 4);
  const sd = Math.sin(declination), cd = Math.cos(declination);
  const cosDl = new Float64Array(w);
  for (let c = 0; c < w; c++) cosDl[c] = Math.cos(-Math.PI + ((c + 0.5) * 2 * Math.PI) / w - sunLon);
  for (let r = 0; r < h; r++) {
    const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
    const a = Math.sin(lat) * sd, b = Math.cos(lat) * cd;
    for (let c = 0; c < w; c++) {
      const mu = a + b * cosDl[c];
      const t = Math.min(1, Math.max(0, (mu + 0.1) / 0.22));
      const day = t * t * (3 - 2 * t);
      const light = 0.07 + day * (0.35 + 0.6 * Math.sqrt(mu > 0 ? mu : 0));
      const i = 4 * (r * w + c);
      img[i] = 2;
      img[i + 1] = 4;
      img[i + 2] = 12;
      img[i + 3] = Math.round(255 * Math.min(1, Math.max(0, 1 - light)));
    }
  }
  return img;
}

/**
 * Cloud RGBA (white, alpha) at w×h from a cover grid (cw×ch, bilinear) and a matching uniformized
 * noise field `uni` (w×h, values ~uniform in [0,1]): covered where uni > 1 − cover.
 */
export function cloudAlpha(
  cover: Float32Array, cw: number, ch: number, uni: Float32Array, w: number, h: number, opacity: number, out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const img = out && out.length === w * h * 4 ? out : new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) {
    let fr = ((r + 0.5) * ch) / h - 0.5;
    if (fr < 0) fr = 0;
    else if (fr > ch - 1) fr = ch - 1;
    const r0 = Math.floor(fr), r1 = Math.min(ch - 1, r0 + 1), tr = fr - r0;
    for (let c = 0; c < w; c++) {
      let fc = ((c + 0.5) * cw) / w - 0.5;
      if (fc < 0) fc += cw;
      const c0 = Math.floor(fc) % cw, c1 = (c0 + 1) % cw, tc = fc - Math.floor(fc);
      const v00 = cover[r0 * cw + c0], v01 = cover[r0 * cw + c1], v10 = cover[r1 * cw + c0], v11 = cover[r1 * cw + c1];
      let cov = (v00 * (1 - tc) + v01 * tc) * (1 - tr) + (v10 * (1 - tc) + v11 * tc) * tr;
      cov = cov === cov ? Math.min(1, Math.max(0, cov)) : 0;
      const thr = 1 - cov;
      const u = uni[r * w + c];
      // Same shaping as the globe shader: edge at the coverage threshold, thickness from the noise.
      const x = Math.min(1, Math.max(0, (u - (thr - 0.035)) / 0.085));
      const y = Math.min(1, Math.max(0, (u - 0.12) / 0.83));
      const alpha = x * x * (3 - 2 * x) * (0.42 + 0.58 * y * y * (3 - 2 * y)) * opacity;
      const i = 4 * (r * w + c);
      img[i] = img[i + 1] = img[i + 2] = 255;
      img[i + 3] = cov < 0.004 ? 0 : Math.round(255 * alpha);
    }
  }
  return img;
}
