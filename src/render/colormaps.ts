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
/**
 * Air temperature (°C): diverging about 0 °C (near-white), cold side purple → blue → pale blue,
 * warm side cream → yellow → orange → red → maroon. Stops every 10 °C (legend = stops).
 */
export const CM_TEMP = colormap([
  s(-50, [42, 10, 60]), s(-40, [80, 34, 128]), s(-30, [58, 72, 176]), s(-20, [44, 124, 212]), s(-10, [124, 188, 234]),
  s(0, [244, 244, 238]), s(10, [252, 214, 110]), s(20, [246, 142, 56]), s(30, [206, 48, 40]), s(40, [124, 10, 52]),
  s(50, [60, 4, 40]),
]);
/** Sea-surface temperature (°C), "thermal"-style: lightness rises monotonically with temperature. */
export const CM_SST = colormap([
  s(-2, [14, 26, 66]), s(4, [34, 58, 140]), s(10, [96, 70, 162]), s(16, [166, 72, 142]),
  s(22, [226, 96, 88]), s(27, [248, 160, 66]), s(32, [250, 234, 140]),
]);
/**
 * Precipitation on log10(mm/month): diverging about the semi-arid pivot (~30 mm, pale cream) —
 * dry side browns, wet side green → teal → blue → purple.
 */
export const CM_PRECIP_LOG = colormap([
  s(0, [112, 72, 38]), s(Math.log10(3), [158, 108, 60]), s(1, [200, 158, 98]), s(Math.log10(30), [234, 222, 172]),
  s(2, [148, 204, 150]), s(Math.log10(300), [60, 160, 168]), s(3, [42, 94, 180]), s(Math.log10(4000), [66, 28, 124]),
]);
/** Sea-level pressure anomaly (hPa relative to 1013): blue lows, white 1013, red highs. */
export const CM_PRESSURE = colormap([
  s(-32, [22, 38, 108]), s(-24, [36, 70, 150]), s(-16, [58, 112, 190]), s(-8, [140, 180, 226]), s(0, [242, 241, 236]),
  s(8, [240, 186, 150]), s(16, [214, 106, 76]), s(24, [170, 48, 50]), s(32, [112, 16, 34]),
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
/**
 * Ocean-current speed (m/s), neutral lightness ramp (the currents layer tints it warm / cold by the
 * SST anomaly — see currentColor).
 */
export const CM_CURRENT = colormap([
  s(0, [10, 18, 34]), s(0.05, [22, 36, 60]), s(0.15, [46, 66, 96]), s(0.3, [84, 106, 136]),
  s(0.6, [150, 168, 190]), s(1.2, [226, 232, 238]),
]);

/** Warm / cold tints of the currents layer (sRGB, applied in OKLab chroma by currentLut). */
export const CURRENT_WARM: RGB = [236, 92, 52];
export const CURRENT_COLD: RGB = [58, 150, 250];
/** SST anomaly (°C) giving the full warm / cold tint. */
export const CURRENT_ANOM_FULL = 3;

/**
 * Bivariate currents LUT: rows = SST anomaly bins (−FULL..+FULL, `na` bins), columns = speed bins
 * of CM_CURRENT. Lightness follows the speed ramp; hue/chroma go to the warm or cold tint with
 * |anomaly| (fading out for slow water). Uint8Array(3·na·CM_CURRENT.n).
 */
export const CURRENT_ANOM_BINS = 33;
export const CURRENT_LUT = (() => {
  const na = CURRENT_ANOM_BINS, ns = CM_CURRENT.n;
  const out = new Uint8Array(3 * na * ns);
  const warm = linToOklab(SRGB_TO_LINEAR[CURRENT_WARM[0]], SRGB_TO_LINEAR[CURRENT_WARM[1]], SRGB_TO_LINEAR[CURRENT_WARM[2]]);
  const cold = linToOklab(SRGB_TO_LINEAR[CURRENT_COLD[0]], SRGB_TO_LINEAR[CURRENT_COLD[1]], SRGB_TO_LINEAR[CURRENT_COLD[2]]);
  for (let ai = 0; ai < na; ai++) {
    const t = (2 * ai) / (na - 1) - 1; // −1 cold .. +1 warm
    const tint = t > 0 ? warm : cold;
    const k = Math.abs(t);
    for (let si = 0; si < ns; si++) {
      const sp = CM_CURRENT.min + ((CM_CURRENT.max - CM_CURRENT.min) * si) / (ns - 1);
      const base = linToOklab(SRGB_TO_LINEAR[CM_CURRENT.lut[3 * si]], SRGB_TO_LINEAR[CM_CURRENT.lut[3 * si + 1]], SRGB_TO_LINEAR[CM_CURRENT.lut[3 * si + 2]]);
      // Tint strength grows with |anomaly| and with speed (still water stays neutral).
      const g = k * Math.pow(Math.min(1, Math.max(0, (sp - 0.015) / 0.2)), 0.7);
      const L = base[0] + (Math.max(base[0], 0.5 * (base[0] + tint[0])) - base[0]) * g;
      const a = base[1] + (tint[1] - base[1]) * g;
      const b = base[2] + (tint[2] - base[2]) * g;
      const lin = oklabToLin(L, a, b);
      const o = 3 * (ai * ns + si);
      out[o] = encodeSrgb(Math.max(0, lin[0]));
      out[o + 1] = encodeSrgb(Math.max(0, lin[1]));
      out[o + 2] = encodeSrgb(Math.max(0, lin[2]));
    }
  }
  return out;
})();

/** Byte offset into CURRENT_LUT for a speed (m/s) and SST anomaly (°C). */
export function currentIndex(speed: number, anom: number): number {
  let ai = Math.round(((anom / CURRENT_ANOM_FULL + 1) * (CURRENT_ANOM_BINS - 1)) / 2);
  ai = ai < 0 ? 0 : ai >= CURRENT_ANOM_BINS ? CURRENT_ANOM_BINS - 1 : ai;
  return 3 * (ai * CM_CURRENT.n + cmapIndex(CM_CURRENT, speed));
}
