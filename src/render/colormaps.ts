/**
 * Colour utilities: sRGB ↔ linear conversion tables and perceptually interpolated colormaps
 * (stops interpolated in OKLab, baked into 8-bit LUTs for the hot loops).
 */
import type { RGB } from '../core/types';

/** sRGB 8-bit → linear [0, 1]. */
export const SRGB_TO_LINEAR = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

const ENC_N = 4096;
/** linear [0, 1] quantized to 1/(ENC_N−1) → sRGB 8-bit. */
const LINEAR_TO_SRGB8 = (() => {
  const t = new Uint8Array(ENC_N);
  for (let i = 0; i < ENC_N; i++) {
    const c = i / (ENC_N - 1);
    const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    t[i] = Math.max(0, Math.min(255, Math.round(s * 255)));
  }
  return t;
})();

/** Encode a linear-light value to sRGB 8-bit (clamped). */
export function encodeSrgb(v: number): number {
  const i = (v * (ENC_N - 1) + 0.5) | 0;
  return LINEAR_TO_SRGB8[i <= 0 ? 0 : i >= ENC_N ? ENC_N - 1 : i];
}

/** sRGB 8-bit triple → linear triple. */
export function toLinear(c: RGB): [number, number, number] {
  return [SRGB_TO_LINEAR[c[0]], SRGB_TO_LINEAR[c[1]], SRGB_TO_LINEAR[c[2]]];
}

// --- OKLab (Björn Ottosson) for perceptual interpolation of colormap stops -----------------------

function linToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLin(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Colormap stop: value (any monotone scale) and sRGB colour. */
export interface ColorStop {
  v: number;
  c: RGB;
}

/**
 * Sequential LUT: `n` sRGB entries sampled uniformly over [stops[0].v, stops[last].v], stops
 * interpolated in OKLab. Returns Uint8Array(3n).
 */
export function buildLut(stops: ColorStop[], n = 256): Uint8Array {
  if (stops.length < 2) throw new Error('buildLut: need ≥ 2 stops');
  for (let i = 1; i < stops.length; i++) if (!(stops[i].v > stops[i - 1].v)) throw new Error('buildLut: stop values must increase');
  const labs = stops.map((s) => linToOklab(SRGB_TO_LINEAR[s.c[0]], SRGB_TO_LINEAR[s.c[1]], SRGB_TO_LINEAR[s.c[2]]));
  const v0 = stops[0].v, v1 = stops[stops.length - 1].v;
  const out = new Uint8Array(3 * n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const v = v0 + ((v1 - v0) * i) / (n - 1);
    while (k < stops.length - 2 && v > stops[k + 1].v) k++;
    const t = Math.min(1, Math.max(0, (v - stops[k].v) / (stops[k + 1].v - stops[k].v)));
    const a = labs[k], b = labs[k + 1];
    const lin = oklabToLin(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
    out[3 * i] = encodeSrgb(Math.max(0, lin[0]));
    out[3 * i + 1] = encodeSrgb(Math.max(0, lin[1]));
    out[3 * i + 2] = encodeSrgb(Math.max(0, lin[2]));
  }
  return out;
}

/** A LUT with its value range. */
export interface Colormap {
  stops: ColorStop[];
  lut: Uint8Array;
  n: number;
  min: number;
  max: number;
}

export function colormap(stops: ColorStop[], n = 256): Colormap {
  return { stops, lut: buildLut(stops, n), n, min: stops[0].v, max: stops[stops.length - 1].v };
}

/** LUT entry index (×3 = byte offset) for a value, clamped. */
export function cmapIndex(cm: Colormap, v: number): number {
  const t = (v - cm.min) / (cm.max - cm.min);
  const i = (t * (cm.n - 1) + 0.5) | 0;
  return i <= 0 ? 0 : i >= cm.n ? cm.n - 1 : i;
}

/** sRGB colour of a value (legend / tests). */
export function cmapColor(cm: Colormap, v: number): RGB {
  const i = 3 * cmapIndex(cm, v);
  return [cm.lut[i], cm.lut[i + 1], cm.lut[i + 2]];
}

const s = (v: number, c: RGB): ColorStop => ({ v, c });

// --- Layer colormaps --------------------------------------------------------------------------

/** Land hypsometric tint (m above sea level). */
export const CM_HYPSO = colormap([
  s(0, [74, 122, 70]), s(200, [110, 150, 84]), s(600, [168, 176, 106]), s(1200, [206, 186, 124]),
  s(2000, [184, 146, 98]), s(3000, [150, 116, 88]), s(4200, [168, 158, 152]), s(5500, [236, 236, 240]),
]);
/** Bathymetric tint (m below sea level, positive depth). */
export const CM_BATHY = colormap([
  s(0, [150, 206, 226]), s(150, [104, 170, 212]), s(1000, [58, 118, 182]), s(3000, [32, 78, 148]),
  s(5000, [20, 50, 110]), s(8000, [10, 26, 70]),
]);
/** Air temperature (°C): cold purple-blue → white-ish cyan near 0 → yellow → deep red. */
export const CM_TEMP = colormap([
  s(-45, [48, 18, 84]), s(-30, [66, 64, 170]), s(-15, [52, 132, 216]), s(0, [168, 222, 234]),
  s(10, [168, 214, 120]), s(20, [248, 212, 92]), s(30, [236, 112, 44]), s(40, [176, 28, 38]), s(50, [104, 8, 32]),
]);
/** Sea-surface temperature (°C). */
export const CM_SST = colormap([
  s(-2, [36, 30, 96]), s(4, [42, 86, 170]), s(10, [44, 156, 186]), s(16, [92, 194, 152]),
  s(22, [238, 216, 92]), s(27, [238, 128, 50]), s(32, [168, 30, 42]),
]);
/** Precipitation on log10(mm): dry brown → green → blue → violet. */
export const CM_PRECIP_LOG = colormap([
  s(0, [120, 84, 52]), s(1, [186, 150, 96]), s(1.5, [226, 214, 140]), s(2, [118, 186, 104]),
  s(2.4, [42, 150, 140]), s(2.8, [40, 96, 190]), s(3.2, [72, 40, 150]), s(3.6, [40, 16, 80]),
]);
/** Sea-level pressure anomaly (hPa relative to 1013): blue lows, red highs. */
export const CM_PRESSURE = colormap([
  s(-40, [24, 40, 110]), s(-20, [52, 102, 186]), s(-8, [146, 186, 226]), s(0, [240, 238, 232]),
  s(8, [238, 180, 136]), s(20, [206, 92, 64]), s(40, [120, 20, 36]),
]);
/** Monthly-mean wind speed (m/s). */
export const CM_WIND = colormap([
  s(0, [18, 20, 44]), s(2, [38, 52, 116]), s(4, [40, 104, 164]), s(6, [46, 158, 160]),
  s(8, [104, 196, 118]), s(10, [196, 220, 96]), s(13, [250, 196, 70]), s(16, [240, 118, 60]), s(20, [196, 40, 70]),
]);
/** Ocean crust age (Myr), after Müller et al. (2008): red young → yellow → green → blue → violet. */
export const CM_AGE = colormap([
  s(0, [214, 38, 40]), s(20, [244, 132, 52]), s(40, [246, 214, 74]), s(70, [118, 190, 88]),
  s(100, [60, 160, 190]), s(140, [60, 92, 196]), s(180, [104, 58, 160]), s(250, [70, 40, 96]),
]);
/** Ocean current speed (m/s), background ramp (most resolution below 0.3 m/s). */
export const CM_CURRENT = colormap([
  s(0, [10, 20, 44]), s(0.05, [16, 36, 78]), s(0.15, [26, 64, 120]), s(0.3, [40, 104, 164]),
  s(0.6, [80, 150, 196]), s(1.2, [168, 214, 236]),
]);
