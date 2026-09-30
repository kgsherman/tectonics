/**
 * Sub-pixel anti-aliasing of the land/sea transition. The height field's signed coast distance
 * (HeightField.coastSd) is a continuous field whose zero contour IS the drawn coastline (land iff
 * height > sea level), so each pixel next to the coastline gets its land coverage from a linear
 * model of that field, α = clamp(½ + sd / |∇sd|), and is blended (in linear light) with the colour of
 * its other-class neighbours. The land/sea classification itself is untouched (overlays, masks and
 * the globe's ocean mask still use height > sea level); only the colours along the coast change.
 */
import * as _colormaps from './colormaps';
import type { HeightField } from './terrain';

const { SRGB_TO_LINEAR, encodeSrgb } = _colormaps;

/** Unknown coast distance (pixel far from any coastline). */
const UNKNOWN = -128;

/**
 * Land coverage (0..1) of pixel p from the signed coast distance, or NaN when it cannot be
 * estimated. Exported for other painters that want the same coastline anti-aliasing.
 */
export function coastCoverage(hf: HeightField, p: number): number {
  const { w, coastSd } = hf;
  const s0 = coastSd[p];
  if (s0 === UNKNOWN) return NaN;
  const r = (p / w) | 0, c = p - r * w;
  const pe = r * w + (c + 1 < w ? c + 1 : 0), pw = r * w + (c > 0 ? c - 1 : w - 1);
  const pn = r > 0 ? p - w : p, ps = r < hf.h - 1 ? p + w : p;
  return coverageAt(coastSd, s0, pe, pw, pn, ps);
}

function coverageAt(sd: Int8Array, s0: number, pe: number, pw: number, pn: number, ps: number): number {
  const e = sd[pe], wv = sd[pw], n = sd[pn], s = sd[ps];
  let gx: number, gy: number;
  if (e !== UNKNOWN && wv !== UNKNOWN) gx = 0.5 * (e - wv);
  else if (e !== UNKNOWN) gx = e - s0;
  else if (wv !== UNKNOWN) gx = s0 - wv;
  else gx = 0;
  if (n !== UNKNOWN && s !== UNKNOWN) gy = 0.5 * (n - s);
  else if (n !== UNKNOWN) gy = n - s0;
  else if (s !== UNKNOWN) gy = s0 - s;
  else gy = 0;
  const g = Math.sqrt(gx * gx + gy * gy);
  if (!(g > 0.5)) return NaN;
  const a = 0.5 + s0 / g;
  return a < 0 ? 0 : a > 1 ? 1 : a;
}

/**
 * Blend every pixel next to the coastline (HeightField.coastPx) with its other-class 4-neighbours
 * by its sub-pixel coverage. Reads the un-blended colours (updates are applied after the scan).
 */
export function antialiasCoast(rgba: Uint8ClampedArray, hf: HeightField, sea: number): void {
  const { w, h, height, coastSd, coastPx } = hf;
  const upd: number[] = [];
  // Only the pixels next to the coastline (listed by the height field) can need blending.
  for (let i = 0, ni = coastPx.length; i < ni; i++) {
    const p = coastPx[i];
    const r = (p / w) | 0, c = p - r * w;
    const row = r * w;
    const rowN = r > 0 ? row - w : row, rowS = r < h - 1 ? row + w : row;
    const s0 = coastSd[p];
    if (s0 === UNKNOWN) continue;
    const land = height[p] > sea;
    const pe = row + (c + 1 < w ? c + 1 : 0), pw = row + (c > 0 ? c - 1 : w - 1);
    const pn = rowN + c, ps = rowS + c;
    const a = coverageAt(coastSd, s0, pe, pw, pn, ps);
    if (a !== a) continue;
    // Fraction of the pixel covered by the other class.
    const t = land ? 1 - a : a;
    if (t < 0.02) continue;
    let oR = 0, oG = 0, oB = 0, k = 0;
    for (let kk = 0; kk < 4; kk++) {
      const q = kk === 0 ? pe : kk === 1 ? pw : kk === 2 ? pn : ps;
      if ((height[q] > sea) === land) continue;
      const o = 4 * q;
      oR += SRGB_TO_LINEAR[rgba[o]];
      oG += SRGB_TO_LINEAR[rgba[o + 1]];
      oB += SRGB_TO_LINEAR[rgba[o + 2]];
      k++;
    }
    if (k === 0) continue;
    const inv = 1 / k, o = 4 * p;
    const sR = SRGB_TO_LINEAR[rgba[o]], sG = SRGB_TO_LINEAR[rgba[o + 1]], sB = SRGB_TO_LINEAR[rgba[o + 2]];
    upd.push(p, encodeSrgb(sR + (oR * inv - sR) * t), encodeSrgb(sG + (oG * inv - sG) * t), encodeSrgb(sB + (oB * inv - sB) * t));
  }
  for (let i = 0; i < upd.length; i += 4) {
    const o = 4 * upd[i];
    rgba[o] = upd[i + 1];
    rgba[o + 1] = upd[i + 2];
    rgba[o + 2] = upd[i + 3];
  }
}
