/**
 * CPU evaluation of the cloud field (pure, DOM-free): the same model as the globe shader
 * (shadersClouds.ts, whose constants come from here) without the time-varying flow map. Used by the
 * 2D map's static cloud layer (cloudsRaster.ts), by tests and by headless previews.
 *
 * Model (per point p on the unit sphere):
 *  1. cyclone templates (comma cloud: cold-front band with a sharp trailing edge, warm-conveyor
 *     shield, dry slot, cold sector) are evaluated in a swirled frame; they bias the coverage, add
 *     cirrus over the head / warm conveyor and open cells in the cold sector, and swirl the noise;
 *  2. noise: a large-scale domain warp and a synoptic shape fetch from the smooth volume (stretched
 *     east–west), then 2–4 detail octaves (ratio 2.6) from the detail volume, each warped a little
 *     by the previous one's gradient and shaped per regime between plain fbm, billows (soft |n|:
 *     cumulus, convective cores, closed cells) and ridges (open cells), with a regime-dependent
 *     spectrum (coarse-octave weight and gain: clumpy convection, fields of small cumulus, finely
 *     cellular decks). The detail follows only DETAIL_SWIRL of the storms' swirl, the cirrus none;
 *  3. the normalized noise z (≈ N(0,1)) plus the cyclone bias is compared with the coverage
 *     threshold z_thr = Φ⁻¹(1 − f): the cloudy area fraction follows the climate's coverage f, and the
 *     excess above the threshold (relative to a reference that grows in overcast climates, with only
 *     part of the detail noise) sets a continuous, log-normally textured optical depth that rises
 *     from zero at the outline: soft, detailed edges and thin translucent cloud over most of the
 *     cloudy area, bright opaque cloud only well inside (fronts, storm centres, convective cores),
 *     thicker in cloudier climates (the aux grid's thickness);
 *  4. a thin, wispy veil around and under the cloud masses; upper cloud: anvils (translucent sheets
 *     around deep-convective cores, under their tops) and cirrus (an independent thin veil: patches
 *     from the shape fetch's B channel, streaks from a zonally stretched detail fetch).
 */
import {
  CLOUD_CELL_EDGE_RANGE, CLOUD_CELL_PERIOD, CLOUD_DETAIL_GRAD_K, CLOUD_DETAIL_PERIOD, CLOUD_NOISE_STD, cloudDetailVolume, sampleCloudNoise,
  type CloudNoiseVolume,
} from './cloudsNoise';
import { CYCLONE_COUNT, CYCLONE_STRIDE, THICK_MAX } from './cloudsModel';

/* Shared constants (interpolated into the GLSL source). */
/** Tiles per unit length for the domain-warp fetch (GBA channels; wavelengths ≈ 4200 / 2100 km). */
export const WARP_SCALE = 0.5;
/** Warp displacement (unit-sphere units) per standard deviation of the warp channels. */
export const WARP_AMP = 0.05;
/** Tiles per unit length for the shape fetch (R: wavelengths ≈ 1000 / 500 km). */
export const SHAPE_SCALE = 1.6;
/** Detail amplitude relative to the synoptic shape (scaled per regime and near cloud edges). */
export const DETAIL_AMP = 0.78;
/**
 * Warp of the first detail fetch by the shape fetch's GBA channels (tile units per σ). Kept small:
 * its strain (~7 σ per unit of domain × warp) stretches the detail into smeared strokes.
 */
export const DETAIL_WARP = 0.02;
/**
 * Optical depth at the reference excess (excessRef: opacity ≈ 0.6 there at the reference thickness,
 * plain regime). It grows as (excess / reference)^TAU_POW from zero at the coverage threshold, so
 * cloud edges are soft (translucent wisps fading into clear air, their outline detailed by the detail
 * noise) and most of the cloudy area is thin; only large excesses (well inside cloud masses: fronts,
 * storm centres, convective cores) become bright and opaque.
 */
export const TAU_SCALE = 0.85;
export const TAU_POW = 2.5;
/**
 * Reference excess (σ) for a climate coverage threshold zthr (without the cyclones' bias):
 * EXCESS_REF − EXCESS_REF_K·min(zthr, 0). Where the climate is cloudy (negative threshold) the excess
 * runs high everywhere, and measured from the threshold alone overcast regions would be one opaque
 * mass: the reference grows there instead, so a storm track stays a mix of thin and thick cloud
 * (~1/3 opaque); fair-weather regions keep their scattered clouds thin.
 */
export const EXCESS_REF = 1.4;
export const EXCESS_REF_K = 0.7;
/**
 * Share of a positive cyclone bias (σ) added to the reference excess: a storm widens its cloud by the
 * whole bias but thickens it by less, so comma heads and bands are brighter than the cloud around them
 * yet keep thin parts and texture instead of turning into uniform opaque masses.
 */
export const BIAS_REF = 0.35;
/**
 * Share of the detail noise in the excess that sets the optical depth (the full detail still shapes
 * the cloud outline): thick and thin parts follow the synoptic and mesoscale structure (bright bands
 * and cores, thin sheets between them) instead of pixel-scale detail, which a steep optical-depth curve
 * turned into glitter.
 */
export const TAU_DETAIL = 0.4;
/** Least share of the full excess kept for the optical depth inside the outline (detail-made fringes). */
export const TAU_EDGE = 0.35;

/**
 * Excess driving the optical depth: exS (the excess with only TAU_DETAIL of the detail noise) inside
 * the cloud outline (ex > 0), at least TAU_EDGE·ex. Mirrored in GLSL.
 */
export function tauExcess(ex: number, exS: number): number {
  return ex > 0 ? Math.max(exS, TAU_EDGE * ex) : 0;
}

/** Reference excess (σ) for the climate coverage threshold zthr (see EXCESS_REF). Mirrored in GLSL. */
export function excessRef(zthr: number): number {
  return EXCESS_REF - EXCESS_REF_K * Math.min(zthr, 0);
}
/** Extra optical depth of organized frontal / comma cloud (× organized()) and of deep convection (× cv). */
export const TAU_FRONT = 0.3;
export const TAU_CONVECTIVE = 1.2;
/** Log-normal optical-depth variability per σ of detail noise (mottled mid-thick cloud). */
export const TAU_TEXTURE = 1.0;
/** Opacity of the thickest cloud (a little ground always shows through). */
export const ALPHA_MAX = 0.95;

/**
 * Opacity of low cloud of optical depth τ: ALPHA_MAX·(1 − (1 + τ/2)^−2), ≈ τ for thin cloud but
 * saturating more slowly than 1 − e^−τ (as a cloud's reflectance does), so thick cores and decks keep
 * their optical-depth texture instead of flattening into uniform white. Mirrored in GLSL.
 */
export function cloudOpacity(tau: number): number {
  if (!(tau > 0)) return 0;
  const q = 1 + 0.5 * tau;
  return ALPHA_MAX * (1 - 1 / (q * q));
}
/**
 * Cloud brightness (before lighting) from the optical depth τ: THIN_BRIGHT for thin veils, rising as
 * 1 − exp(−BRIGHT_K·τ) toward white (thin cloud reads as a pale translucent veil over the ground, not
 * a grey haze; thick cores are white yet still mottled by their optical-depth texture).
 */
export const THIN_BRIGHT = 0.75;
export const BRIGHT_K = 0.35;
/**
 * Contrast of the storms' coverage bias (× the comma template): clear dry slots and a broken cold
 * sector against the bright frontal band and head, so the comma reads even in overcast storm tracks.
 */
export const CYCLONE_BIAS_GAIN = 1.35;
/** Fraction of the cyclone swirl applied to the noise domain (the rest only bends the template). */
export const NOISE_SWIRL = 0.4;
/**
 * Fraction of that swirl the mesoscale detail follows (the synoptic shape takes all of it): the
 * comma's bands wind up, while the cumulus and cells inside keep their own shapes instead of being
 * drawn out into brush strokes around the low. Cirrus fibres take none (swirled fibres fanned out
 * into straight "light beams" around storms).
 */
export const DETAIL_SWIRL = 0.3;
/** Noise-domain compression along the polar axis for the synoptic shape (zonally elongated weather). */
export const ANISO = 1.6;
/**
 * Detail octaves (detail volume, CLOUD_DETAIL_PERIOD lattice cells per tile): tiles per unit of the
 * noise domain, ratio 2.6 (lattice cells ≈ 0.020, 0.0077, 0.0030, 0.0011 rad ≈ 130, 49, 19, 7 km).
 * Each fades in with zoom between 0.75 and 1.4 px per cell: at the default globe zoom the first two
 * are resolved and the third mostly (pixel-scale speckle of cumulus fields), all four in close-ups.
 */
export const DETAIL_SCALES = [3.1, 3.1 * 2.6, 3.1 * 2.6 ** 2, 3.1 * 2.6 ** 3];
/**
 * Octave band-limiting: an octave fades in between OCTAVE_FADE_PX[0] and [1] pixels per lattice cell.
 * The B-spline noise keeps little energy below ~2.5 cells per wavelength and the fetch LOD filters
 * the rest, so an octave is safe from ~0.75 px per cell (below it would alias, and would still cost
 * a full-rate fetch per flow phase).
 */
export const OCTAVE_FADE_PX = [0.75, 1.4];

/** Footprint fade (0..1) of detail octave k for a pixel footprint of `px` radians. Mirrored in GLSL. */
export function octaveFade(px: number, k: number): number {
  const ppc = 1 / (px * DETAIL_SCALES[k] * CLOUD_DETAIL_PERIOD);
  return smoothstep(OCTAVE_FADE_PX[0], OCTAVE_FADE_PX[1], ppc);
}

/** Default amplitude ratio between detail octaves (per-regime values in detailParams). */
export const DETAIL_GAIN = 0.58;
/** 1/√(Σ gain^2k) over the four detail octaves at DETAIL_GAIN. */
export const DETAIL_NORM = 1 / Math.sqrt(1 + DETAIL_GAIN ** 2 + DETAIL_GAIN ** 4 + DETAIL_GAIN ** 6);
/** Detail amplitude inside cloud (fraction of DETAIL_AMP) and its extra near the threshold. */
export const DETAIL_FLOOR = 0.45;
export const DETAIL_EDGE_BOOST = 1.0;
/**
 * Warp of each finer detail octave by the previous one's gradient (lattice cells per σ/cell). Small:
 * at 0.2 its strain (~0.2 × the coarser octave's curvature, ≈ 50 %) drew every octave into swirled,
 * painterly strokes; a little still breaks the lattice alignment between octaves.
 */
export const DETAIL_GRAD_WARP = 0.06;
/** Zonal stretch of the detail (1: isotropic; streaks only in cirrus). */
export const DETAIL_ANISO = 1.0;
/**
 * Billows use a soft |n| = √(n² + ε²) (rounded creases: no pixel-sharp shading lines); its mean and
 * 1/std for n ~ N(0,1) keep the shaping zero-mean, unit variance.
 */
export const BILLOW_EPS = 0.3;
export const BILLOW_MEAN = 0.8869;
export const BILLOW_INV_SD = 1 / 0.5508;
/**
 * Cirrus: zonal stretch (fibres ≈ 4× longer than wide: ~0.03 × 0.007 rad), detail-volume tiles per
 * unit, and peak opacity of the veil.
 */
export const CIRRUS_ANISO = 4;
export const CIRRUS_SCALE = 2.2;
export const CIRRUS_TAU = 0.3;
/**
 * Cirrus fibre warp by the shape fetch's GBA channels (tile units per σ): gently curved fibres. At 0.2
 * the warp's strain (~0.9) turned fibres every which way (straight beams in random directions).
 */
export const CIRRUS_WARP = 0.06;
/** Mean strand weight (E[smoothstep(0.2, 1.3, n)] for n ~ N(0,1)): the veil where the fibres are sub-pixel. */
export const CIRRUS_STRAND_MEAN = 0.235;
/**
 * Anvils: a smooth translucent sheet spreading ANVIL_SPREAD σ (of the synoptic noise) beyond the
 * deep-convective cores, with soft edges and peak opacity ANVIL_TAU (the cores inside stay the only
 * bright, opaque part of a convective cluster).
 */
export const ANVIL_SPREAD = 0.55;
export const ANVIL_TAU = 0.45;
/** Width (σ of the synoptic noise) of the anvils' soft outer edge (~15 px at the default zoom). */
export const ANVIL_SOFT = 0.4;
/**
 * Mesoscale cellular convection (cell volume, CLOUD_CELL_PERIOD cells per tile): tiles per unit
 * (cells ≈ 0.0072 rad ≈ 46 km: closed stratocumulus cells, open cells), the warp of the cell lattice
 * by the shape fetch (tile units per σ: irregular cells), and the footprint fade (px per cell).
 */
export const CELL_SCALE = 17.3;
export const CELL_WARP = 0.1;
/**
 * Warp of the cell lattice by the second detail octave's gradient (tile units per σ/cell, ≈ 0.25 cell
 * per σ): wobbly, organic cell walls instead of straight Voronoi polygons (a chicken-wire net).
 */
export const CELL_DETAIL_WARP = 0.03;
export const CELL_FADE_PX = [2.0, 4.0];
/** Open cells are about twice as large as closed ones (scale factor on CELL_SCALE). */
export const OPEN_CELL_SCALE = 0.5;
/**
 * Autocorrelation of the noise at noise-domain separation d (fits of the measured statistics, see
 * tests/polish.clouds.test.ts): shape nb ≈ exp(−d²/L²), detail nd ≈ exp(−d/λ). The globe's two flow
 * phases sample the same noise a small offset apart, so their crossfade must be renormalized with this
 * correlation, not as if they were independent (that inflated the contrast by up to ~40 %, pulsing
 * the cloud cover twice per flow cycle in calm air).
 */
export const SHAPE_CORR_LENGTH = 0.13;
export const DETAIL_CORR_LENGTH = 0.022;

const OFF_W = [0.31, 0.57, 0.13];
const OFF_B = [0.71, 0.23, 0.47];
const OFF_D = [0.19, 0.83, 0.61];
const OFF_E = [0.53, 0.07, 0.89];
const OFF_F = [0.97, 0.41, 0.29];
const OFF_G = [0.37, 0.61, 0.79];
const OFF_C = [0.83, 0.17, 0.33];
const OFF_H = [0.11, 0.73, 0.52];
/** Rotation applied between successive fetches (decorrelates the scales, hides the lattice). */
const ROT = [0.0, 0.8, 0.6, -0.8, 0.36, -0.48, -0.6, -0.48, 0.64];

export const FIELD_GLSL_CONSTANTS = {
  OFF_W, OFF_B, OFF_D, OFF_E, OFF_F, OFF_G, OFF_C, OFF_H, ROT,
};

const INV_STD = 1 / CLOUD_NOISE_STD;
/** Detail z scale relative to the (shape-anisotropic) noise domain. */
const DANISO_Z = DETAIL_ANISO / ANISO;
const CIRRUS_Z = CIRRUS_ANISO / ANISO;
/** Gradient channel (byte/255 − 0.5) → next-octave warp in tile units. */
const GRAD_WARP = DETAIL_GRAD_WARP / CLOUD_DETAIL_PERIOD / CLOUD_DETAIL_GRAD_K;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Cyclone template in its own frame (x downstream, y poleward, units of the radius; low at the
 * origin): comma head poleward of the low, cold-front tail trailing equatorward and upstream from the
 * triple point (sharp on its cold, trailing side), warm-conveyor cloud ahead of the front, dry slot
 * intruding from the upstream side and a clearer cold sector behind the front. The swirl then wraps
 * the head and dry slot around the low. Returns the coverage bias (σ units); `aux` (optional)
 * receives [cirrus, open cells]. Mirrored in GLSL.
 */
export function cycloneTemplate(x: number, y: number, aux?: Float64Array): number {
  const s = Math.max(0, 0.1 - y);
  const xc = 0.3 - 0.32 * s - 0.1 * s * s;
  let bx = (x - xc) / (0.26 + 0.07 * s);
  bx *= bx < 0 ? 1.6 : 0.8;
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
  if (aux) {
    aux[0] = 0.6 * head + 0.8 * warm;
    // Open cells: the core of the cold sector behind the front.
    const ox = (x + 1.25) / 0.95, oy = (y + 0.95) / 0.95;
    aux[1] = Math.exp(-(ox * ox + oy * oy));
  }
  // The constant keeps the mean bias over the storm ~0 (cyclones organize cloud, not add it).
  return 1.9 * tail + 1.6 * head + 0.9 * warm - 1.8 * dry - 0.8 * cold - 0.16;
}

/** Swirl angle profile (fraction of the centre swirl) at template radius r. */
export function swirlProfile(r: number): number {
  return Math.exp(-r * r * 1.6);
}

export interface CloudSample {
  /** Opacity 0..1 of low/mid cloud and cirrus combined. */
  alpha: number;
  /** Optical depth of the low/mid cloud. */
  tau: number;
  /** Opacity of the cirrus veil alone. */
  cirrus: number;
}

export interface CloudFieldInputs {
  vol: CloudNoiseVolume;
  /** Detail volume (defaults to the shared one). */
  dvol?: CloudNoiseVolume;
  /** Cell volume (none: no mesoscale cells). */
  cvol?: CloudNoiseVolume;
  /** Pixel footprint (radians) for the cell fade (default: resolved). */
  px?: number;
  /** RGBA8 regime grid from buildCloudRegimeGrid. */
  grid: Uint8Array;
  /**
   * RGBA8 auxiliary grid (cirrus, open cells, thickness) from buildCloudGrids; none: no cirrus / open
   * cells, reference thickness.
   */
  aux?: Uint8Array;
  gw: number;
  gh: number;
  /** cycloneStates output (or null for none). */
  cyclones: Float32Array | null;
}

const scratchAux = new Float64Array(2);

/**
 * Sum of the cyclone biases (σ units) at unit vector p → out[0], and (when `swirl`) the swirl
 * displacement of the noise domain → out[1..3]; cirrus and open-cell contributions → out[4], out[5]
 * (when out is long enough); `only` ≥ 0 evaluates that one cyclone. Mirrors cyclones() in GLSL.
 */
export function cycloneEffect(
  cyc: Float32Array, px: number, py: number, pz: number, out: Float64Array, swirl = true, only = -1,
): Float64Array {
  let bias = 0, qx = 0, qy = 0, qz = 0, ci = 0, op = 0;
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
    bias += CYCLONE_BIAS_GAIN * inten * env * cycloneTemplate(xs, ys, scratchAux);
    ci += inten * env * scratchAux[0];
    op += inten * env * scratchAux[1];
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
  if (out.length >= 6) {
    out[4] = ci;
    out[5] = op;
  }
  return out;
}

/** Floats written by shapeStage. */
export const SHAPE_STAGE_SIZE = 9;

/**
 * First stage of the cloud noise at noise-domain point q (unit sphere plus any swirl): anisotropy and
 * the globe's time-0 noise offset, the large-scale warp and the synoptic shape fetch. Writes
 * [wx, wy, wz, nb, gx, gy, gz, cp, va] to out (SHAPE_STAGE_SIZE floats): warped coordinates, shape
 * noise nb ≈ N(0,1), the first detail fetch's warp (tile units), and the shape fetch's independent
 * B and A channels (≈ N(0,1)): cirrus patches and the texture variation. All smooth at ≥ 500 km
 * scales (safe to interpolate from a coarser grid).
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
  out[7] = (tmp[2] - 0.5) * INV_STD;
  out[8] = (tmp[3] - 0.5) * INV_STD;
  return out;
}

const OFFS = [OFF_D, OFF_E, OFF_F, OFF_G];

/**
 * Raw detail octaves n1..n4 (σ units, unshaped) at a shapeStage point → out[0..octaves−1]: fetches
 * rotated, 2.6× finer and warped by the previous one's gradient. Mirrors phaseDetail()'s fetches.
 * `grad2` (optional, ≥ 2 octaves) receives the second octave's gradient (σ per lattice cell, detail
 * domain): the cell lattice's warp (cellStage).
 */
export function detailOctaves(
  dvol: CloudNoiseVolume, st: Float64Array, tmp: Float32Array, out: Float64Array | Float32Array, octaves = 3,
  grad2: Float64Array | null = null,
): void {
  let ax = st[0], ay = st[1], az = st[2] * DANISO_Z;
  let gx = st[4], gy = st[5], gz = st[6];
  for (let k = 0; k < octaves; k++) {
    const bx = ROT[0] * ax + ROT[3] * ay + ROT[6] * az;
    const by = ROT[1] * ax + ROT[4] * ay + ROT[7] * az;
    const bz = ROT[2] * ax + ROT[5] * ay + ROT[8] * az;
    ax = bx;
    ay = by;
    az = bz;
    const s = DETAIL_SCALES[k], o = OFFS[k];
    sampleCloudNoise(dvol, ax * s + gx + o[0], ay * s + gy + o[1], az * s + gz + o[2], tmp);
    out[k] = (tmp[0] - 0.5) * INV_STD;
    if (k === 1 && grad2) {
      grad2[0] = (tmp[1] - 0.5) / CLOUD_DETAIL_GRAD_K;
      grad2[1] = (tmp[2] - 0.5) / CLOUD_DETAIL_GRAD_K;
      grad2[2] = (tmp[3] - 0.5) / CLOUD_DETAIL_GRAD_K;
    }
    gx = (tmp[1] - 0.5) * GRAD_WARP;
    gy = (tmp[2] - 0.5) * GRAD_WARP;
    gz = (tmp[3] - 0.5) * GRAD_WARP;
  }
}

/** Raw cirrus fibre noise (σ units) at a shapeStage point (mirror of the shader's cirrus fetch). */
export function cirrusFibre(dvol: CloudNoiseVolume, st: Float64Array, tmp: Float32Array): number {
  const ax = st[0], ay = st[1], az = st[2] * CIRRUS_Z;
  const bx = ROT[0] * ax + ROT[3] * ay + ROT[6] * az;
  const by = ROT[1] * ax + ROT[4] * ay + ROT[7] * az;
  const bz = ROT[2] * ax + ROT[5] * ay + ROT[8] * az;
  // st[4..6] carry the shape fetch's GBA × INV_STD·DETAIL_WARP.
  const k = CIRRUS_WARP / DETAIL_WARP;
  sampleCloudNoise(
    dvol, bx * CIRRUS_SCALE + st[4] * k + OFF_C[0], by * CIRRUS_SCALE + st[5] * k + OFF_C[1], bz * CIRRUS_SCALE + st[6] * k + OFF_C[2], tmp,
  );
  return (tmp[0] - 0.5) * INV_STD;
}

/**
 * Cell-volume sample at a shapeStage point → out: [edge (distance to the cell border, cell units),
 * id (0..1 per cell), centre distance F1 (cell units)]. `g2` (optional): the second detail octave's
 * gradient (detailOctaves' grad2), which wobbles the cell walls. Mirrors the shader's cell fetch
 * (without the flow map).
 */
export function cellStage(
  cvol: CloudNoiseVolume, st: Float64Array, tmp: Float32Array, out: Float64Array | number[], scale = CELL_SCALE,
  g2: ArrayLike<number> | null = null,
): void {
  const ax = st[0], ay = st[1], az = st[2] * DANISO_Z;
  const bx = ROT[0] * ax + ROT[3] * ay + ROT[6] * az;
  const by = ROT[1] * ax + ROT[4] * ay + ROT[7] * az;
  const bz = ROT[2] * ax + ROT[5] * ay + ROT[8] * az;
  const k = CELL_WARP / DETAIL_WARP; // st[4..6] carry the shape GBA × INV_STD·DETAIL_WARP
  const wx = g2 ? g2[0] * CELL_DETAIL_WARP : 0, wy = g2 ? g2[1] * CELL_DETAIL_WARP : 0, wz = g2 ? g2[2] * CELL_DETAIL_WARP : 0;
  sampleCloudNoise(
    cvol, bx * scale + st[4] * k + wx + OFF_H[0], by * scale + st[5] * k + wy + OFF_H[1], bz * scale + st[6] * k + wz + OFF_H[2], tmp,
  );
  out[0] = tmp[0] * CLOUD_CELL_EDGE_RANGE;
  out[1] = tmp[2];
  if (out.length > 2) out[2] = tmp[1] * 1.2;
}

/** Footprint fade of cells at `scale` (tiles per unit) for a pixel footprint of `px` radians. Mirrored in GLSL. */
export function cellFade(px: number, scale = CELL_SCALE): number {
  return smoothstep(CELL_FADE_PX[0], CELL_FADE_PX[1], 1 / (px * scale * CLOUD_CELL_PERIOD));
}

/**
 * Closed stratocumulus cells: optical-depth factor (thin, darker walls; domed, brighter centres, f1 =
 * distance to the cell centre in cell units; per-cell brightness variation), weighted by the
 * stratocumulus regime `sc` and the footprint fade. Mirrored in GLSL.
 */
export function closedCells(edge: number, id: number, sc: number, fade: number, f1 = 0.3): number {
  const cell = (0.72 + 0.28 * smoothstep(0.0, 0.25, edge)) * (0.85 + 0.3 * id) * (1.1 - 0.4 * Math.min(1, f1 * f1));
  return 1 + sc * fade * (cell - 1);
}

/**
 * Open cells: coverage excess (σ) added by cloudy rings along the cell borders around clear centres,
 * weighted by the open-cell regime and the footprint fade; `soft` widens the ring edge (cell units)
 * for antialiasing, the detail noise `nd` breaks the rings up. Mirrored in GLSL.
 */
export function openCells(edge: number, open: number, fade: number, soft = 0, nd = 0): number {
  const ring = 1 - smoothstep(0.05, 0.3 + soft, edge);
  // Lumpy, broken rings (cumulus along the cell walls), not a continuous net.
  return open * fade * (1.3 * ring * (0.75 + 0.35 * Math.min(1.5, Math.max(-1.5, nd))) - 0.85);
}

/** Texture parameters of a regime mix (see detailParams). */
export interface DetailShaping {
  /** Linear / billow weights of the two coarse and the fine octaves (see shapeOctave). */
  lc: number;
  bc: number;
  lf: number;
  bf: number;
  /** Amplitude ratio between the finer octaves (2 → 3 → 4). */
  gain: number;
  /** Detail amplitude factor. */
  amp: number;
  /**
   * Weight of the coarse (first, ~130 km) octave relative to the second: 1 in frontal / convective
   * cloud (red spectrum: clumps), low in cumulus fields and stratocumulus decks (the texture lives at
   * the finest resolved scales: speckle, cells).
   */
  coarse: number;
  /** Detail amplitude floor inside the cloud (fraction of DETAIL_AMP; see combineNoise). */
  floor: number;
}

export function newDetailShaping(): DetailShaping {
  return { lc: 1, bc: 0, lf: 1, bf: 0, gain: DETAIL_GAIN, amp: 1, coarse: 1, floor: DETAIL_FLOOR };
}

/** Linear and billow weights for shaping parameter beta (−1 ridges … 0 plain … +1 billows). */
function shaping(beta: number, out: DetailShaping, fine: boolean): void {
  const ab = Math.abs(beta);
  const inv = 1 / Math.sqrt((1 - ab) * (1 - ab) + ab * ab);
  if (fine) {
    out.lf = (1 - ab) * inv;
    out.bf = beta * BILLOW_INV_SD * inv;
  } else {
    out.lc = (1 - ab) * inv;
    out.bc = beta * BILLOW_INV_SD * inv;
  }
}

const clamp1 = (x: number): number => Math.min(1, Math.max(-1, x));

/**
 * Texture parameters per regime (mirror detailParams() in GLSL): billows for convection, cumulus and
 * closed stratocumulus cells, ridges for open cells; clumpy (low gain, full coarse octave) convection,
 * speckled cumulus fields (high gain, weak coarse octave, strong detail throughout: fields of small
 * clouds rather than blobs with fringes) and finely cellular, otherwise uniform stratocumulus decks;
 * `vary` (≈ N(0,1), the shape fetch's A channel) mixes smooth sheets and broken fields.
 */
export function detailParams(sc: number, cv: number, cu: number, open: number, vary: number, out: DetailShaping): DetailShaping {
  shaping(clamp1(0.05 + 0.6 * cv + 0.45 * cu + 0.15 * sc - 0.5 * open), out, false);
  shaping(clamp1(0.15 + 0.35 * cv + 0.65 * cu + 0.85 * sc - 1.6 * open), out, true);
  out.gain = Math.min(1, Math.max(0.4, 0.62 - 0.15 * cv + 0.4 * cu + 0.3 * sc + 0.2 * open + 0.06 * vary));
  out.amp = (1 - 0.1 * cv + 0.8 * cu + 0.4 * open - 0.2 * sc) * Math.min(1.5, Math.max(0.55, 1 + 0.3 * vary));
  out.coarse = Math.min(1, Math.max(0.3, 1 - 0.65 * cu - 0.3 * open - 0.55 * sc));
  out.floor = DETAIL_FLOOR + 0.55 * Math.min(1, cu + open);
  return out;
}

/** One shaped octave (zero mean, ~unit variance for n ~ N(0,1)). Mirrors shapeOctave() in GLSL. */
export function shapeOctave(n: number, lin: number, bil: number): number {
  return lin * n + bil * (Math.sqrt(n * n + BILLOW_EPS * BILLOW_EPS) - BILLOW_MEAN);
}

/** 1/√(Σ a_k²) for octave amplitudes [coarse, g, g², g³]. */
function detailNorm(coarse: number, g: number): number {
  const g2 = g * g;
  return 1 / Math.sqrt(coarse * coarse + g2 * (1 + g2 * (1 + g2)));
}

/**
 * Detail noise nd ≈ N(0,1) from raw octaves (detailOctaves), shaped per regime, octave amplitudes
 * [coarse, g, g², g³], with per-octave footprint fades (1 = resolved; null: all resolved). Mirrors the
 * sum in phaseDetail().
 */
export function detailSum(oct: ArrayLike<number>, octaves: number, sh: DetailShaping, fade: ArrayLike<number> | null = null): number {
  const g = sh.gain;
  let d = 0, a = sh.coarse;
  for (let k = 0; k < octaves; k++) {
    const f = fade ? fade[k] : 1;
    const v = k < 2 ? shapeOctave(oct[k], sh.lc, sh.bc) : shapeOctave(oct[k], sh.lf, sh.bf);
    d += a * f * v;
    a = k === 0 ? g : a * g;
  }
  return d * detailNorm(sh.coarse, g);
}

/** Unshaped detail sum (same octaves and amplitudes as detailSum; `coarse` = 1: a geometric fbm). */
export function detailPlain(oct: ArrayLike<number>, octaves: number, gain: number, fade: ArrayLike<number> | null = null, coarse = 1): number {
  let d = 0, a = coarse;
  for (let k = 0; k < octaves; k++) {
    d += a * (fade ? fade[k] : 1) * oct[k];
    a = k === 0 ? gain : a * gain;
  }
  return d * detailNorm(coarse, gain);
}

/**
 * Optical-depth texture noise (≈ N(0,1) when resolved): mostly the finer octaves (2–4, amplitude
 * ratio `gain`), little of the coarse one. Brightness mottling at the finest resolved scales, as in
 * satellite imagery; the coarse octave's ~130 km light and shade read as brush strokes. Mirrored in
 * GLSL.
 */
export function detailTexture(oct: ArrayLike<number>, octaves: number, gain: number, fade: ArrayLike<number> | null = null): number {
  let fine = 0, a = 1;
  for (let k = 1; k < octaves; k++) {
    fine += a * (fade ? fade[k] : 1) * oct[k];
    a *= gain;
  }
  const g2 = gain * gain;
  return 0.35 * (fade ? fade[0] : 1) * oct[0] + (0.94 * fine) / Math.sqrt(1 + g2 * (1 + g2));
}

const plainShaping = newDetailShaping();
const scratchOct = new Float64Array(4);

/**
 * Detail noise nd ≈ N(0,1) from a shapeStage result: `octaves` detail fetches, plain (unshaped) by
 * default. Mirrors phaseDetail() in GLSL (without the flow map).
 */
export function detailStage(
  dvol: CloudNoiseVolume, st: Float64Array, tmp: Float32Array, octaves = 3, sh: DetailShaping = plainShaping,
): number {
  detailOctaves(dvol, st, tmp, scratchOct, octaves);
  return detailSum(scratchOct, octaves, sh);
}

const scratchStage = new Float64Array(SHAPE_STAGE_SIZE);

/**
 * Synoptic shape noise nb → out[0] and plain mesoscale detail nd → out[1] (both ≈ N(0,1)) at
 * noise-domain point q (see shapeStage / detailStage).
 */
export function cloudNoise(
  vol: CloudNoiseVolume, qx: number, qy: number, qz: number, tmp: Float32Array, out: Float64Array, octaves = 3,
  dvol: CloudNoiseVolume = cloudDetailVolume(),
): Float64Array {
  const st = shapeStage(vol, qx, qy, qz, tmp, scratchStage);
  out[0] = st[3];
  out[1] = detailStage(dvol, st, tmp, octaves);
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

const scratchCyc = new Float64Array(6);
const scratchCell = new Float64Array(3);
const scratchSh = newDetailShaping();
const scratchStD = new Float64Array(SHAPE_STAGE_SIZE);
const scratchStC = new Float64Array(SHAPE_STAGE_SIZE);
const scratchG2 = new Float64Array(3);

/**
 * Evaluates the cloud field at unit vector (px, py, pz) (SPEC axes: z north) with latitude `lat`
 * and longitude `lon` (radians, consistent with p). `tmp` is a 4-float scratch buffer. The first
 * `octaves` detail octaves are taken as resolved (default 3).
 */
export function cloudAt(
  inp: CloudFieldInputs, px: number, py: number, pz: number, lat: number, lon: number, tmp: Float32Array, out: CloudSample,
  octaves = 3,
): CloudSample {
  // Regime grids (bilinear, lon wraps).
  const { gw, gh, grid, aux } = inp;
  let fc = ((lon + Math.PI) / (2 * Math.PI)) * gw - 0.5;
  fc = ((fc % gw) + gw) % gw;
  const fr = Math.min(gh - 1, Math.max(0, ((Math.PI / 2 - lat) / Math.PI) * gh - 0.5));
  const c0 = Math.floor(fc), r0 = Math.floor(fr);
  const c1 = (c0 + 1) % gw, r1 = Math.min(gh - 1, r0 + 1);
  const tc = fc - c0, tr = fr - r0;
  const i00 = 4 * (r0 * gw + c0), i01 = 4 * (r0 * gw + c1), i10 = 4 * (r1 * gw + c0), i11 = 4 * (r1 * gw + c1);
  const w00 = (1 - tc) * (1 - tr), w01 = tc * (1 - tr), w10 = (1 - tc) * tr, w11 = tc * tr;
  const at = (g: Uint8Array, ch: number): number => (w00 * g[i00 + ch] + w01 * g[i01 + ch] + w10 * g[i10 + ch] + w11 * g[i11 + ch]) / 255;
  const f = at(grid, 0);
  out.alpha = 0;
  out.tau = 0;
  out.cirrus = 0;
  if (f < 0.004) return out;
  const sc = at(grid, 1), cv = at(grid, 2), cu = at(grid, 3);
  let cirrus = aux ? at(aux, 0) : 0, open = aux ? at(aux, 1) : 0;
  const thickness = aux ? at(aux, 2) * THICK_MAX : 1;
  let bias = 0, qx = px, qy = py, qz = pz;
  if (inp.cyclones) {
    const e = cycloneEffect(inp.cyclones, px, py, pz, scratchCyc);
    bias = e[0];
    qx += e[1];
    qy += e[2];
    qz += e[3];
    if (aux) {
      cirrus = Math.min(1, cirrus + 0.5 * e[4]);
      open = Math.min(1, open + e[5]);
    }
  }
  const dvol = inp.dvol ?? cloudDetailVolume();
  const st = shapeStage(inp.vol, qx, qy, qz, tmp, scratchStage);
  // The detail follows only DETAIL_SWIRL of the storms' swirl, the cirrus fibres none of it (as the
  // shader): undo the rest in the warped coordinates.
  const stD = unswirl(st, qx - px, qy - py, qz - pz, 1 - DETAIL_SWIRL, scratchStD);
  const stC = unswirl(st, qx - px, qy - py, qz - pz, 1, scratchStC);
  const nb = st[3];
  const zthr0 = coverageThreshold(f);
  const zthr = zthr0 - bias;
  let tau = 0, lowEx = nb - zthr, n1 = 0, ndt = 0;
  if (nb > zthr - 2.8) {
    const sh = detailParams(sc, cv, cu, open, st[8], scratchSh);
    detailOctaves(dvol, stD, tmp, scratchOct, octaves, scratchG2);
    n1 = scratchOct[0];
    ndt = detailTexture(scratchOct, octaves, sh.gain);
    const nd = detailSum(scratchOct, octaves, sh);
    let ex = combineNoise(nb, nd, zthr, sc, cv, cu, sh.amp, bias, sh.floor) - zthr;
    // The same excess with only part of the detail (optical depth, see TAU_DETAIL).
    const exD = ex - (combineNoise(nb, TAU_DETAIL * nd, zthr, sc, cv, cu, sh.amp, bias, sh.floor) - zthr);
    let cellTau = 1;
    const g2 = octaves >= 2 ? scratchG2 : null;
    if (inp.cvol && sc > 0.02 && ex > -1.5) {
      cellStage(inp.cvol, stD, tmp, scratchCell, CELL_SCALE, g2);
      cellTau = closedCells(scratchCell[0], scratchCell[1], sc, inp.px ? cellFade(inp.px) : 1, scratchCell[2]);
    }
    if (inp.cvol && open > 0.02 && ex > -1.5) {
      cellStage(inp.cvol, stD, tmp, scratchCell, CELL_SCALE * OPEN_CELL_SCALE, g2);
      ex += openCells(scratchCell[0], open, inp.px ? cellFade(inp.px, CELL_SCALE * OPEN_CELL_SCALE) : 1, 0, nd);
    }
    lowEx = ex;
    tau = opticalDepth(tauExcess(ex, ex - exD), sc, cv, cu, Math.abs(lat), cellularTexture(ndt, nd, sc, open), bias, cellTau, thickness, excessRef(zthr0));
  }
  // Anvils and the thin veil spread under the cloud masses (the cores show through), cirrus veils over
  // them (not over optically thick low cloud, as the shader: invisible there).
  const core = cloudOpacity(tau);
  const anvA = anvilAlpha(nb, zthr, cv, n1, ndt);
  const anv = anvA + veilAlpha(nb, zthr, cu, n1, thickness, ndt) * (1 - anvA);
  const low = core + anv * (1 - core);
  const ci = aux && lowEx < 1.6 ? cirrusAlpha(cirrus, st[7], cirrusFibre(dvol, stC, tmp)) * (1 - smoothstep(1.1, 1.6, lowEx)) : 0;
  out.tau = tau;
  out.cirrus = ci;
  out.alpha = ci + low * (1 - ci);
  return out;
}

/**
 * Shape-stage copy with a fraction `k` of the noise-domain swirl displacement (dx, dy, dz; unit-sphere
 * units, before the anisotropy) removed from the warped coordinates.
 */
function unswirl(st: Float64Array, dx: number, dy: number, dz: number, k: number, out: Float64Array): Float64Array {
  out.set(st);
  out[0] -= k * dx;
  out[1] -= k * dy;
  out[2] -= k * dz * ANISO;
  return out;
}

/**
 * Anvil of deep convection: a smooth, bright sheet around the convective cores (under their tops),
 * spreading ANVIL_SPREAD σ of the synoptic noise beyond their threshold with a soft (ANVIL_SOFT σ),
 * slightly ragged outer edge, thickening toward the cores (peak ANVIL_TAU), weighted by the convective
 * regime `cv`; the coarse detail octave `n1` lobes its outline, the fine texture `ndt` frays it.
 * Mirrored in GLSL.
 */
export function anvilAlpha(nb: number, zthr: number, cv: number, n1: number, ndt = 0): number {
  if (!(cv > 0.02)) return 0;
  const x = nb - zthr + ANVIL_SPREAD + 0.5 * n1 + 0.3 * ndt;
  return ANVIL_TAU * cv * smoothstep(0, ANVIL_SOFT, x) * (0.45 + 0.55 * smoothstep(ANVIL_SOFT, 5 * ANVIL_SOFT, x));
}

/**
 * Thin veil around and under the cloud masses (thin stratiform cloud and haze: cloud systems fade out
 * through a translucent margin instead of ending at their outline): opacity up to VEIL_ALPHA, spreading
 * VEIL_SPREAD σ of the synoptic noise beyond the threshold with a wide soft ramp (VEIL_SOFT σ), lobed
 * by the coarse detail octave n1 (smooth: fine noise in its outline gave crisp, blotchy edges) and
 * streaked inside by the texture noise ndt (wisps, not a uniform grey film over the ground); none in
 * fair-weather cumulus (distinct puffs in clear air), faint in dry climates (thin cloud `thickness`:
 * about a quarter of VEIL_ALPHA at THICK_MIN, full from a thickness of 0.9). Mirrored in GLSL.
 */
export function veilAlpha(nb: number, zthr: number, cu: number, n1: number, thickness = 1, ndt = 0): number {
  const x = nb - zthr + VEIL_SPREAD + 0.35 * n1;
  if (!(x > 0) || !(cu < 1)) return 0;
  const wisps = 0.1 + 0.9 * smoothstep(-0.6, 1.0, 0.3 * n1 + ndt);
  return VEIL_ALPHA * (1 - cu) * smoothstep(0.3, 0.9, thickness) * smoothstep(0, VEIL_SOFT, x) * wisps;
}

/** Veil opacity, spread (σ) and soft ramp width (σ) (see veilAlpha). */
export const VEIL_ALPHA = 0.26;
export const VEIL_SPREAD = 0.75;
export const VEIL_SOFT = 1.0;

/**
 * Detail driving the optical-depth texture: the unshaped sum `plain`, blended toward the shaped
 * `shaped` detail in cellular regimes (bright closed cells, open-cell rings). Mirrored in GLSL.
 */
export function cellularTexture(plain: number, shaped: number, sc: number, open: number): number {
  const t = Math.min(1, Math.max(0, 0.8 * sc + 0.6 * open));
  return plain + t * (shaped - plain);
}

/** Weight of organized frontal / comma cloud from the cyclone coverage bias (σ units). */
export function organized(bias: number): number {
  return smoothstep(0.3, 1.5, bias);
}

/** Noise threshold for a coverage fraction: Φ⁻¹(1 − f) (logistic approximation of the normal CDF). */
export function coverageThreshold(f: number): number {
  const c = Math.min(0.998, Math.max(0.002, f));
  return Math.log((1 - c) / c) / 1.702;
}

/**
 * Normalized cloud noise z from the shape (nb) and detail (nd) noise (both ≈ N(0,1)), for a threshold
 * zthr (already lowered by any cyclone bias). Detail is strongest near the threshold (fractal, eroded
 * edges) and weaker but present inside (textured tops); `am` is the regime's amplitude factor
 * (detailParams), calmer in organized frontal cloud (strong positive cyclone `bias`); shallow-cumulus
 * regimes are biased clearer, stratocumulus and deep convection cloudier. Mirrored in GLSL.
 */
export function combineNoise(
  nb: number, nd: number, zthr: number, sc: number, cv: number, cu: number, am = 1, bias = 0, floor = DETAIL_FLOOR,
): number {
  const x2 = 2 * (nb - zthr) * (nb - zthr);
  // exp(−x2) via its rational Taylor bound (the CPU raster calls this per pixel; within 1e-2).
  const edge = 1 / (1 + x2 * (1 + x2 * (0.5 + x2 * (1 / 6))));
  const a = DETAIL_AMP * (floor + DETAIL_EDGE_BOOST * edge) * am * (1 - 0.45 * organized(bias));
  return (nb + a * nd) / Math.sqrt(1 + a * a) + REGIME_OFFSET_CU * cu + REGIME_OFFSET_SC * sc + REGIME_OFFSET_CV * cv;
}

/**
 * Coverage offsets (σ) per regime: shallow cumulus clearer, stratocumulus cloudier; deep-convective
 * cores a little rarer (their anvils fill in around them).
 */
export const REGIME_OFFSET_CU = -0.2;
export const REGIME_OFFSET_SC = 0.3;
export const REGIME_OFFSET_CV = -0.8;

/**
 * Optical depth for a noise excess ex (σ units above the threshold; ≤ 0 → 0):
 * TAU_SCALE·(ex / exRef)^TAU_POW (exRef: excessRef of the climate threshold), zero at the threshold
 * (soft, translucent edges; thin veils over most of the cloudy area) and super-linear toward bright,
 * opaque cores; × the climate's cloud `thickness` (cloudThickness), thicker in organized frontal /
 * comma cloud (strong positive cyclone `bias`, which also raises the excess) and deep convection,
 * thinner in marine stratocumulus, shallow cumulus and polar regions; log-normal texture from the
 * fine detail noise nd (detailTexture: mottled cumulus / stratocumulus, gentle in stratiform and
 * frontal cloud) and the closed-cell factor `cells` (closedCells). Mirrored in GLSL.
 */
export function opticalDepth(
  ex: number, sc: number, cv: number, cu: number, absLat: number, nd: number, bias = 0, cells = 1, thickness = 1, exRef = 1,
): number {
  if (!(ex > 0)) return 0;
  const org = organized(bias);
  const texture = Math.exp(TAU_TEXTURE * (0.35 + 0.6 * cu + 0.4 * sc + 0.2 * cv) * (1 - 0.3 * org) * nd);
  const regime = (1 - 0.45 * smoothstep(1.05, 1.4, absLat)) * (1 - 0.25 * sc - 0.6 * cu + TAU_CONVECTIVE * cv) * (1 + TAU_FRONT * org);
  return TAU_SCALE * Math.pow(ex / (exRef + BIAS_REF * Math.max(bias, 0)), TAU_POW) * thickness * regime * texture * cells;
}

/**
 * Cirrus veil opacity (mirror of the shader): coverage fraction `cirrus`, patch noise cp (shape
 * fetch B channel) and fibre noise nc; `fade` is the fibres' footprint fade.
 */
export function cirrusAlpha(cirrus: number, cp: number, nc: number, fade = 1): number {
  if (!(cirrus > 0.02)) return 0;
  return cirrusAlphaThr(coverageThreshold(cirrus), cp, nc, fade);
}

/**
 * cirrusAlpha for a precomputed coverage threshold (coverageThreshold of the cirrus fraction): patches
 * whose veil is striated into streaks by the stretched fibre noise (elongated bright strands; their
 * mean where the fibres are sub-pixel). Its zero-crossing ridges would curl into smoke-like loops.
 */
export function cirrusAlphaThr(thr: number, cp: number, nc: number, fade = 1): number {
  const exP = 0.93 * cp - thr;
  if (exP <= -0.6) return 0;
  const n = nc * fade;
  const strand = smoothstep(0.2, 1.3, nc);
  return CIRRUS_TAU * smoothstep(0, 0.9, exP + 0.15 * n) * (0.3 + 0.7 * (CIRRUS_STRAND_MEAN + fade * (strand - CIRRUS_STRAND_MEAN)));
}
