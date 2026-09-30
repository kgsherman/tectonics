/**
 * Satellite palette (sRGB tuned against Blue Marble / Sentinel-2 cloudless mosaics), stored in
 * linear light for blending: snow, tundra, rock, sea ice, lagoons, lithology-indexed desert ramps
 * and depth-indexed ocean ramps.
 */
import type { RGB } from '../core/types';
import { SRGB_TO_LINEAR, toLinear } from './colormaps';

const L = (c: RGB) => toLinear(c);
export const SNOW = L([236, 240, 246]);
/** Tundra / alpine meadow: brown-olive when dry, mossy green-olive when humid. */
export const TUNDRA_DRY = L([126, 116, 88]);
export const TUNDRA_WET = L([98, 110, 72]);
export const ROCK_DRY = L([122, 108, 94]);
export const ROCK_WET = L([92, 92, 90]);
export const SEA_ICE = L([226, 232, 240]);
/** Lagoons / small enclosed water: warm (greener) and cold. */
export const LAGOON_WARM = L([30, 76, 88]);
export const LAGOON_COLD = L([26, 58, 72]);
/** Thermal mottling amplitude (°C per unit of plate-frame patch noise). */
export const MOTTLE_C = 3.5;

/** 64-entry linear-RGB ramps indexed by lithology noise in [-1, 1]. */
function lithRamp(stops: Array<[number, RGB]>): Float32Array {
  const n = 64;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const v = -1 + (2 * i) / (n - 1);
    let k = 0;
    while (k < stops.length - 2 && v > stops[k + 1][0]) k++;
    const [v0, c0] = stops[k], [v1, c1] = stops[k + 1];
    const t = Math.max(0, Math.min(1, (v - v0) / (v1 - v0)));
    for (let q = 0; q < 3; q++) out[3 * i + q] = SRGB_TO_LINEAR[c0[q]] * (1 - t) + SRGB_TO_LINEAR[c1[q]] * t;
  }
  return out;
}

/** Hot deserts by lithology: dark rock, red-brown gravel, ochre, pale erg, near-white sand. */
export const HOT_DESERT = lithRamp([
  [-1, [96, 84, 74]], [-0.55, [118, 98, 82]], [-0.3, [168, 116, 80]], [-0.08, [194, 156, 114]],
  [0.15, [212, 186, 144]], [0.45, [222, 202, 160]], [1, [230, 216, 184]],
]);
/** Cold deserts: dark basalt/gravel → grey-brown → pale grey-beige. */
export const COLD_DESERT = lithRamp([
  [-1, [92, 88, 84]], [-0.4, [112, 104, 94]], [0, [160, 146, 124]], [0.4, [190, 178, 156]], [1, [206, 196, 178]],
]);

/**
 * Ocean colour ramps by depth (index ∝ sqrt(d / DEPTH_MAX)), linear RGB, interpolated on a log
 * depth scale between stops: warm (carbonate turquoise shelves) and cold (darker green-blue
 * shelves), both ending in deep navy.
 */
export const DEPTH_N = 512;
export const DEPTH_MAX = 6000;
function depthRamp(stops: Array<[number, RGB]>): Float32Array {
  const out = new Float32Array(3 * DEPTH_N);
  for (let i = 0; i < DEPTH_N; i++) {
    const u = i / (DEPTH_N - 1);
    const d = DEPTH_MAX * u * u;
    let k = 0;
    while (k < stops.length - 2 && d > stops[k + 1][0]) k++;
    const [d0, c0] = stops[k], [d1, c1] = stops[k + 1];
    const t = Math.max(0, Math.min(1, (Math.log(1 + d / 5) - Math.log(1 + d0 / 5)) / (Math.log(1 + d1 / 5) - Math.log(1 + d0 / 5))));
    for (let q = 0; q < 3; q++) out[3 * i + q] = SRGB_TO_LINEAR[c0[q]] * (1 - t) + SRGB_TO_LINEAR[c1[q]] * t;
  }
  return out;
}
export const OCEAN_WARM = depthRamp([
  [0, [44, 118, 136]], [15, [36, 108, 138]], [60, [26, 88, 132]], [200, [17, 60, 110]], [1000, [11, 36, 84]],
  [3000, [7, 25, 66]], [6000, [5, 19, 55]],
]);
export const OCEAN_COLD = depthRamp([
  [0, [38, 86, 98]], [15, [32, 78, 98]], [60, [23, 64, 94]], [200, [15, 47, 84]], [1000, [10, 33, 68]],
  [3000, [9, 26, 56]], [6000, [7, 21, 47]],
]);
