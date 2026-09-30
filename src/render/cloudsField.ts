/**
 * CPU evaluation of the cloud field (pure, DOM-free): the same model as the globe shader
 * (shadersClouds.ts, whose constants come from here) without the time-varying flow map. Used by the
 * 2D map's static cloud layer, by tests and by headless previews.
 *
 * Model (per point p on the unit sphere):
 *  1. cyclone templates (comma cloud: cold-front band, warm-conveyor shield, dry slot, cold sector)
 *     are evaluated in a swirled frame and the noise domain is swirled with them;
 *  2. domain-warped fbm from the tileable noise volume: a synoptic shape fetch and mesoscale detail
 *     fetches at scale ratios of ≈ 4 (two octaves each), anisotropic (stretched east–west), mixed per
 *     regime (deep convection clumps up, shallow cumulus thins out, stratocumulus flattens);
 *  3. the normalized noise z (≈ N(0,1)) plus the cyclone bias is compared with the coverage
 *     threshold z_thr = Φ⁻¹(1 − f): the cloudy area fraction follows the climate's coverage f, and the
 *     excess above the threshold sets a continuous optical depth (thin edges, bright cores).
 */
import { CLOUD_NOISE_STD, sampleCloudNoise, sampleCloudNoiseR, type CloudNoiseVolume } from './cloudsNoise';
import { CYCLONE_COUNT, CYCLONE_STRIDE } from './cloudsModel';

/* Shared constants (interpolated into the GLSL source). */
/** Tiles per unit length for the domain-warp fetch (GBA channels; wavelengths ≈ 4200 / 2100 km). */
export const WARP_SCALE = 0.5;
/** Warp displacement (unit-sphere units) per standard deviation of the warp channels. */
export const WARP_AMP = 0.05;
/** Tiles per unit length for the shape fetch (R: wavelengths ≈ 1000 / 500 km). */
export const SHAPE_SCALE = 1.6;
/** Frequency ratio between successive fetches (≈ 4 = two octaves; non-integer avoids tile alignment). */
export const DETAIL_RATIO = 3.9;
/** Amplitude ratio between successive fetches (two fbm octaves of CLOUD_NOISE_GAIN). */
export const FETCH_GAIN = 0.6;
/** Mesoscale detail amplitude relative to the synoptic shape (boosted near cloud edges). */
export const DETAIL_AMP = 0.55;
/** Small-scale warp of the detail fetch by the shape fetch's GBA channels (tile units per σ). */
export const DETAIL_WARP = 0.05;
/** Optical depth per σ of noise excess above the coverage threshold. */
export const TAU_PER_SIGMA = 0.85;
/** Opacity of the thickest cloud (a little ground always shows through). */
export const ALPHA_MAX = 0.95;
/** Optical depth reached right past the cloud edge (crisp outlines instead of fuzzy blobs). */
export const EDGE_TAU = 0.3;
/** Fraction of the cyclone swirl applied to the noise domain (the rest only bends the template). */
export const NOISE_SWIRL = 0.4;
/** Noise-domain compression along the polar axis (features elongated east–west). */
export const ANISO = 1.8;
/**
 * Autocorrelation of the noise at noise-domain separation d (fits of the measured statistics, see
 * tests/polish.clouds.test.ts): shape nb ≈ exp(−d²/L²), detail nd ≈ exp(−d/λ). The globe's two flow
 * phases sample the same noise a small offset apart, so their crossfade must be renormalized with this
 * correlation, not as if they were independent (that inflated the contrast by up to ~40 %, pulsing
 * the cloud cover twice per flow cycle in calm air).
 */
export const SHAPE_CORR_LENGTH = 0.13;
export const DETAIL_CORR_LENGTH = 0.03;

const OFF_W = [0.31, 0.57, 0.13];
const OFF_B = [0.71, 0.23, 0.47];
const OFF_D = [0.19, 0.83, 0.61];
const OFF_E = [0.53, 0.07, 0.89];
const OFF_F = [0.97, 0.41, 0.29];
/** Rotation applied between successive fetches (decorrelates the scales, hides the lattice). */
const ROT = [0.0, 0.8, 0.6, -0.8, 0.36, -0.48, -0.6, -0.48, 0.64];

export const FIELD_GLSL_CONSTANTS = {
  OFF_W, OFF_B, OFF_D, OFF_E, OFF_F, ROT,
};

/** Normalization of the detail sum n1 + g·n2 (+ g²·n3). */
const DETAIL_NORM2 = 1 / Math.sqrt(1 + FETCH_GAIN * FETCH_GAIN);

const INV_STD = 1 / CLOUD_NOISE_STD;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Cyclone template in its own frame (x downstream, y poleward, units of the radius; low at the
 * origin): comma head poleward of the low, cold-front tail trailing equatorward and upstream from the
 * triple point, warm-conveyor cloud ahead of the front, dry slot intruding from the upstream side and
 * a clearer cold sector behind the front. The swirl then wraps the head and dry slot around the low.
 * Mirrored in GLSL.
 */
export function cycloneTemplate(x: number, y: number): number {
  const s = Math.max(0, 0.1 - y);
  const xc = 0.3 - 0.32 * s - 0.1 * s * s;
  const bx = (x - xc) / (0.26 + 0.07 * s);
  const tail = Math.exp(-bx * bx) * smoothstep(-0.2, 0.2, 0.25 - y) * (1 - smoothstep(1.5, 2.5, s));
  const hx = (x - 0.15) / 0.95, hy = (y - 0.42) / 0.55;
  const head = Math.exp(-(hx * hx + hy * hy));
  const wx = (x - 0.85) / 0.55, wy = (y - 0.05) / 0.75;
  const warm = Math.exp(-(wx * wx + wy * wy));
  // Dry slot: elongated from the upstream-equatorward side into the centre.
  const u = (x + y) * 0.7071, v = (x - y) * 0.7071;
  const du = (u + 0.55) / 0.55, dv = (v - 0.05) / 0.28;
  const dry = Math.exp(-(du * du + dv * dv));
  const cx = (x + 1.4) / 1.1, cy = (y + 0.8) / 1.1;
  const cold = Math.exp(-(cx * cx + cy * cy));
  // The constant keeps the mean bias over the storm ~0 (cyclones organize cloud, not add it).
  return 1.9 * tail + 1.6 * head + 0.9 * warm - 1.8 * dry - 0.8 * cold - 0.16;
}

/** Swirl angle profile (fraction of the centre swirl) at template radius r. */
export function swirlProfile(r: number): number {
  return Math.exp(-r * r * 1.6);
}

export interface CloudSample {
  /** Opacity 0..1 (ALPHA_MAX·(1 − exp(−τ))). */
  alpha: number;
  /** Optical depth. */
  tau: number;
}

export interface CloudFieldInputs {
  vol: CloudNoiseVolume;
  /** RGBA8 regime grid from buildCloudRegimeGrid. */
  grid: Uint8Array;
  gw: number;
  gh: number;
  /** cycloneStates output (or null for none). */
  cyclones: Float32Array | null;
}

/**
 * Sum of the cyclone biases (σ units) at unit vector p → out[0], and (when `swirl`) the swirl
 * displacement of the noise domain → out[1..3]; `only` ≥ 0 evaluates that one cyclone. Mirrors
 * cyclones() in GLSL.
 */
export function cycloneEffect(
  cyc: Float32Array, px: number, py: number, pz: number, out: Float64Array, swirl = true, only = -1,
): Float64Array {
  let bias = 0, qx = 0, qy = 0, qz = 0;
  const k0 = only >= 0 ? only : 0, k1 = only >= 0 ? only + 1 : CYCLONE_COUNT;
  for (let k = k0; k < k1; k++) {
    const o = k * CYCLONE_STRIDE;
    const inten = cyc[o + 4];
    if (inten <= 0.001) continue;
    const cx = cyc[o], cy = cyc[o + 1], cz = cyc[o + 2], R = cyc[o + 3];
    const cd = px * cx + py * cy + pz * cz;
    if (cd < Math.cos(2.7 * R)) continue;
    // Local east/north at the centre.
    const ch = Math.max(1e-4, Math.sqrt(cx * cx + cy * cy));
    const ex = -cy / ch, ey = cx / ch;
    const nx = (-cz * cx) / ch, ny = (-cz * cy) / ch, nz = ch;
    const dx = px - cx * cd, dy = py - cy * cd, dz = pz - cz * cd;
    const mx = cyc[o + 6], my = cyc[o + 7];
    const x = (mx * (dx * ex + dy * ey)) / R;
    const y = (my * (dx * nx + dy * ny + dz * nz)) / R;
    const r = Math.sqrt(x * x + y * y);
    const th = cyc[o + 5] * swirlProfile(r) * inten;
    const cs = Math.cos(th), sn = Math.sin(th);
    // Sample the template at the un-swirled position (rotate by −θ).
    const xs = cs * x + sn * y, ys = -sn * x + cs * y;
    const env = 1 - smoothstep(1.9, 2.6, r);
    bias += inten * env * cycloneTemplate(xs, ys);
    if (swirl) {
      const ddx = mx * (xs - x) * R * NOISE_SWIRL, ddy = my * (ys - y) * R * NOISE_SWIRL;
      qx += ddx * ex + ddy * nx;
      qy += ddx * ey + ddy * ny;
      qz += ddy * nz;
    }
  }
  out[0] = bias;
  out[1] = qx;
  out[2] = qy;
  out[3] = qz;
  return out;
}

/**
 * First stage of the cloud noise at noise-domain point q (unit sphere plus any swirl): anisotropy and
 * the globe's time-0 noise offset, the large-scale warp and the synoptic shape fetch. Writes
 * [wx, wy, wz, nb, gx, gy, gz] to out: warped coordinates, shape noise nb ≈ N(0,1) and the small warp
 * for the first detail fetch. All smooth at ≥ 500 km scales (safe to interpolate from a coarser grid).
 */
export function shapeStage(vol: CloudNoiseVolume, qx: number, qy: number, qz: number, tmp: Float32Array, out: Float64Array): Float64Array {
  // Zonal anisotropy (weather is stretched along the westerlies / trades), then the same noise-space
  // offset the globe shows at animation time 0.
  qx += DRIFT0[0];
  qy += DRIFT0[1];
  qz = qz * ANISO + DRIFT0[2];
  // Domain warp.
  sampleCloudNoise(vol, qx * WARP_SCALE + OFF_W[0], qy * WARP_SCALE + OFF_W[1], qz * WARP_SCALE + OFF_W[2], tmp);
  const wx = qx + WARP_AMP * (tmp[1] - 0.5) * INV_STD;
  const wy = qy + WARP_AMP * (tmp[2] - 0.5) * INV_STD;
  const wz = qz + WARP_AMP * (tmp[3] - 0.5) * INV_STD;
  // Synoptic shape.
  sampleCloudNoise(vol, wx * SHAPE_SCALE + OFF_B[0], wy * SHAPE_SCALE + OFF_B[1], wz * SHAPE_SCALE + OFF_B[2], tmp);
  const k = INV_STD * DETAIL_WARP;
  out[0] = wx;
  out[1] = wy;
  out[2] = wz;
  out[3] = (tmp[0] - 0.5) * INV_STD;
  out[4] = (tmp[1] - 0.5) * k;
  out[5] = (tmp[2] - 0.5) * k;
  out[6] = (tmp[3] - 0.5) * k;
  return out;
}

/**
 * Second stage: mesoscale detail nd ≈ N(0,1) from a shapeStage result — fetches rotated, 3.9× finer
 * and warped by the previous one. `fine` = false stops after the first detail fetch (the second's
 * 30–65 km features are sub-pixel on a 1024-wide map). Mirrors phaseDetail() in GLSL (without the
 * wind streaks).
 */
export function detailStage(vol: CloudNoiseVolume, st: Float64Array, tmp: Float32Array, fine = true): number {
  const wx = st[0], wy = st[1], wz = st[2];
  const s1 = SHAPE_SCALE * DETAIL_RATIO;
  const ax = ROT[0] * wx + ROT[3] * wy + ROT[6] * wz;
  const ay = ROT[1] * wx + ROT[4] * wy + ROT[7] * wz;
  const az = ROT[2] * wx + ROT[5] * wy + ROT[8] * wz;
  const dx = ax * s1 + st[4] + OFF_D[0], dy = ay * s1 + st[5] + OFF_D[1], dz = az * s1 + st[6] + OFF_D[2];
  if (!fine) return (sampleCloudNoiseR(vol, dx, dy, dz) - 0.5) * INV_STD;
  sampleCloudNoise(vol, dx, dy, dz, tmp);
  const n1 = (tmp[0] - 0.5) * INV_STD;
  const k = INV_STD * DETAIL_WARP;
  const gx = (tmp[1] - 0.5) * k, gy = (tmp[2] - 0.5) * k, gz = (tmp[3] - 0.5) * k;
  const s2 = s1 * DETAIL_RATIO;
  const bx = ROT[0] * ax + ROT[3] * ay + ROT[6] * az;
  const by = ROT[1] * ax + ROT[4] * ay + ROT[7] * az;
  const bz = ROT[2] * ax + ROT[5] * ay + ROT[8] * az;
  const n2 = (sampleCloudNoiseR(vol, bx * s2 + gx + OFF_E[0], by * s2 + gy + OFF_E[1], bz * s2 + gz + OFF_E[2]) - 0.5) * INV_STD;
  return (n1 + FETCH_GAIN * n2) * DETAIL_NORM2;
}

const scratchStage = new Float64Array(7);

/**
 * Synoptic shape noise nb → out[0] and mesoscale detail nd → out[1] (both ≈ N(0,1)) at noise-domain
 * point q (see shapeStage / detailStage).
 */
export function cloudNoise(
  vol: CloudNoiseVolume, qx: number, qy: number, qz: number, tmp: Float32Array, out: Float64Array, fine = true,
): Float64Array {
  const st = shapeStage(vol, qx, qy, qz, tmp, scratchStage);
  out[0] = st[3];
  out[1] = detailStage(vol, st, tmp, fine);
  return out;
}

/**
 * Noise-space offset of flow-map cycle k (globe): a slow, bounded Lissajous path (≤ ~0.04 per cycle
 * and axis). Mirrored by noiseDrift() in GLSL.
 */
export function noiseDrift(k: number, out: number[] = [0, 0, 0]): number[] {
  out[0] = 0.2 * (Math.sin(k * 0.071) + Math.sin(k * 0.113 + 1.3));
  out[1] = 0.2 * (Math.sin(k * 0.083 + 2.1) + Math.sin(k * 0.127 + 0.4));
  out[2] = 0.2 * (Math.sin(k * 0.067 + 4.2) + Math.sin(k * 0.109 + 5.1));
  return out;
}

/** At animation time 0 the globe shows only its second flow phase, at cycle −0.5 (no displacement). */
const DRIFT0 = noiseDrift(-0.5);

const scratchCyc = new Float64Array(4);
const scratchNoise = new Float64Array(2);

/**
 * Evaluates the cloud field at unit vector (px, py, pz) (SPEC axes: z north) with latitude `lat`
 * and longitude `lon` (radians, consistent with p). `tmp` is a 4-float scratch buffer.
 */
export function cloudAt(
  inp: CloudFieldInputs, px: number, py: number, pz: number, lat: number, lon: number, tmp: Float32Array, out: CloudSample,
): CloudSample {
  // Regime grid (bilinear, lon wraps).
  const { gw, gh, grid } = inp;
  let fc = ((lon + Math.PI) / (2 * Math.PI)) * gw - 0.5;
  fc = ((fc % gw) + gw) % gw;
  const fr = Math.min(gh - 1, Math.max(0, ((Math.PI / 2 - lat) / Math.PI) * gh - 0.5));
  const c0 = Math.floor(fc), r0 = Math.floor(fr);
  const c1 = (c0 + 1) % gw, r1 = Math.min(gh - 1, r0 + 1);
  const tc = fc - c0, tr = fr - r0;
  const i00 = 4 * (r0 * gw + c0), i01 = 4 * (r0 * gw + c1), i10 = 4 * (r1 * gw + c0), i11 = 4 * (r1 * gw + c1);
  const w00 = (1 - tc) * (1 - tr), w01 = tc * (1 - tr), w10 = (1 - tc) * tr, w11 = tc * tr;
  const f = (w00 * grid[i00] + w01 * grid[i01] + w10 * grid[i10] + w11 * grid[i11]) / 255;
  const sc = (w00 * grid[i00 + 1] + w01 * grid[i01 + 1] + w10 * grid[i10 + 1] + w11 * grid[i11 + 1]) / 255;
  const cv = (w00 * grid[i00 + 2] + w01 * grid[i01 + 2] + w10 * grid[i10 + 2] + w11 * grid[i11 + 2]) / 255;
  const cu = (w00 * grid[i00 + 3] + w01 * grid[i01 + 3] + w10 * grid[i10 + 3] + w11 * grid[i11 + 3]) / 255;
  if (f < 0.004) {
    out.alpha = 0;
    out.tau = 0;
    return out;
  }
  let bias = 0, qx = px, qy = py, qz = pz;
  if (inp.cyclones) {
    const e = cycloneEffect(inp.cyclones, px, py, pz, scratchCyc);
    bias = e[0];
    qx += e[1];
    qy += e[2];
    qz += e[3];
  }
  const nz = cloudNoise(inp.vol, qx, qy, qz, tmp, scratchNoise);
  const nb = nz[0], nd = nz[1];
  const zthr = coverageThreshold(f) - bias;
  const ex = combineNoise(nb, nd, zthr, sc, cv, cu) - zthr;
  const tau = opticalDepth(ex, sc, cv, cu, Math.abs(lat), nd);
  out.tau = tau;
  out.alpha = ALPHA_MAX * (1 - Math.exp(-tau));
  return out;
}

/** Noise threshold for a coverage fraction: Φ⁻¹(1 − f) (logistic approximation of the normal CDF). */
export function coverageThreshold(f: number): number {
  const c = Math.min(0.998, Math.max(0.002, f));
  return Math.log((1 - c) / c) / 1.702;
}

/**
 * Normalized cloud noise z from the shape (nb) and detail (nd) noise (both ≈ N(0,1)), for a threshold
 * zthr (already lowered by any cyclone bias). Detail is strongest near the threshold (fractal, eroded
 * edges; smooth interiors), stronger in deep convection (mesoscale clusters) and weaker in
 * stratocumulus (flat decks); shallow-cumulus regimes are biased clearer, stratocumulus and deep
 * convection cloudier. Mirrored in GLSL.
 */
export function combineNoise(nb: number, nd: number, zthr: number, sc: number, cv: number, cu: number): number {
  const x2 = 2 * (nb - zthr) * (nb - zthr);
  // exp(−x2) via its rational Taylor bound (the CPU raster calls this per pixel; within 1e-2).
  const edge = 1 / (1 + x2 * (1 + x2 * (0.5 + x2 * (1 / 6))));
  const a = DETAIL_AMP * (0.25 + 1.4 * edge) * (1 + 0.8 * cv) * (1 - 0.4 * sc);
  return (nb + a * nd) / Math.sqrt(1 + a * a) - 0.5 * cu + 0.15 * sc + 0.2 * cv;
}

/**
 * Optical depth for a noise excess ex (σ units above the threshold; ≤ 0 → 0): a crisp edge step, then
 * growing super-linearly (thin veils, bright cores; more so in deep convection) and textured by the
 * detail noise nd; thinner in marine stratocumulus, shallow cumulus and polar regions. Mirrored in
 * GLSL (which adds billow texture).
 */
export function opticalDepth(ex: number, sc: number, cv: number, cu: number, absLat: number, nd: number): number {
  if (!(ex > 0)) return 0;
  // Mesoscale texture inside the cloud (cells, billows): the detail noise also modulates thickness.
  const texture = Math.min(1.4, Math.max(0.6, 1 + 0.12 * nd));
  const thick = (1 - 0.45 * smoothstep(1.05, 1.4, absLat)) * (1 - 0.4 * sc - 0.65 * cu + 0.35 * cv);
  const k = 0.6 + 0.3 * cv;
  return (TAU_PER_SIGMA * ex * (1 - k + k * ex) * texture + EDGE_TAU * smoothstep(0, 0.12, ex)) * thick;
}
