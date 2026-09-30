/**
 * Satellite palette (sRGB tuned against Blue Marble / Sentinel-2 cloudless mosaics), stored in
 * linear light for blending: snow, tundra, rock, sea ice, lagoons, lithology-indexed desert ramps
 * and depth-indexed ocean ramps.
 */
import type { RGB } from '../core/types';
import { SRGB_TO_LINEAR, encodeSrgb, toLinear } from './colormaps';

const L = (c: RGB) => toLinear(c);
export const SNOW = L([236, 240, 246]);
/** Snow in shade (valleys, pole-facing slopes): slightly bluer and darker. */
export const SNOW_SHADE = L([208, 218, 234]);
/** Tundra / alpine meadow: brown-olive when dry, mossy green-olive when humid. */
export const TUNDRA_DRY = L([126, 116, 88]);
export const TUNDRA_WET = L([98, 110, 72]);
/** Glacier ice of ablation zones (bare, blue-grey) and crevassed / debris-laden margins. */
export const ICE_BARE = L([176, 196, 214]);
export const ICE_CREVASSE = L([118, 132, 146]);
/** Accumulation-zone firn of ice sheets: a touch warmer / brighter than fresh seasonal snow in shade. */
export const FIRN = L([240, 243, 248]);
export const ROCK_DRY = L([122, 108, 94]);
export const ROCK_WET = L([92, 92, 90]);
export const SEA_ICE = L([226, 232, 240]);
/** Thin / young sea ice (nilas, grey ice): translucent grey-blue. */
export const SEA_ICE_THIN = L([150, 166, 182]);
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
// The sea floor is invisible from orbit below ~50–100 m: the ramps flatten below ~150 m so narrow
// submarine ridges (crests 100–500 m deep, far from land) do not glow like shelves.
export const OCEAN_WARM = depthRamp([
  [0, [44, 118, 136]], [15, [36, 108, 138]], [60, [24, 82, 128]], [150, [12, 42, 92]], [400, [8, 29, 72]],
  [3000, [7, 25, 66]], [6000, [5, 19, 55]],
]);
export const OCEAN_COLD = depthRamp([
  [0, [38, 86, 98]], [15, [32, 78, 98]], [60, [21, 58, 88]], [150, [11, 36, 70]], [400, [9, 28, 60]],
  [3000, [9, 26, 56]], [6000, [7, 21, 47]],
]);

/** Warmth levels of OCEAN_SRGB. */
export const OCEAN_WARM_N = 64;
/**
 * Open-ocean colours pre-encoded to sRGB: index 3·(depthIndex·OCEAN_WARM_N + warmLevel) (depth index
 * as for OCEAN_WARM / OCEAN_COLD, warmth 0 = cold ramp … OCEAN_WARM_N − 1 = warm ramp).
 */
export const OCEAN_SRGB = (() => {
  const out = new Uint8Array(3 * DEPTH_N * OCEAN_WARM_N);
  for (let d = 0; d < DEPTH_N; d++) {
    for (let k = 0; k < OCEAN_WARM_N; k++) {
      const t = k / (OCEAN_WARM_N - 1);
      const o = 3 * (d * OCEAN_WARM_N + k);
      for (let q = 0; q < 3; q++) out[o + q] = encodeSrgb(OCEAN_COLD[3 * d + q] + (OCEAN_WARM[3 * d + q] - OCEAN_COLD[3 * d + q]) * t);
    }
  }
  return out;
})();

/** Depth step (m) of DEPTH_INDEX. */
export const DEPTH_LUT_STEP = 2;
/** Depth ramp index (∝ sqrt(d / DEPTH_MAX)) per DEPTH_LUT_STEP metres of depth, up to DEPTH_MAX. */
export const DEPTH_INDEX = (() => {
  const n = Math.ceil(DEPTH_MAX / DEPTH_LUT_STEP) + 1;
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const d = Math.min(DEPTH_MAX, (i + 0.5) * DEPTH_LUT_STEP);
    out[i] = Math.min(DEPTH_N - 1, Math.round(Math.sqrt(d / DEPTH_MAX) * (DEPTH_N - 1)));
  }
  return out;
})();
