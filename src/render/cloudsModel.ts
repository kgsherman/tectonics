/**
 * Cloud weather model shared by the globe shader (shadersClouds.ts) and the CPU map renderer
 * (cloudsField.ts). Pure and DOM-free.
 *
 * Input: CloudSpec — monthly climate cloud cover × the app's display density (default 0.4, see
 * src/app/climateFields.ts `cloudSpec`) plus the monthly wind. From it we derive:
 *  - a coverage fraction per climate cell (`coverageFraction`): the fraction of the area that is cloud,
 *    used as a probability threshold on domain-warped fbm (never as an opacity);
 *  - regime weights from latitude, cover and the low-level wind divergence (marine stratocumulus,
 *    deep convection, shallow cumulus) packed with the coverage in an RGBA8 grid
 *    (`buildCloudRegimeGrid`);
 *  - storm-track latitudes and the planet's rotation sense (`analyzeCloudClimate`);
 *  - extratropical cyclones living in the storm tracks (`cycloneStates`): a wave train per hemisphere
 *    (evenly spaced, drifting east together: storms never merge); each is born as an open frontal
 *    wave, winds up into a comma and an occluded spiral while drifting poleward, weakens over dry
 *    climates, then decays and is reborn (stateless: a pure function of time).
 */
import type { CloudSpec } from '../core/types';

/* ------------------------------------------------------------------ */
/* Coverage                                                            */
/* ------------------------------------------------------------------ */

/**
 * The app hands us `model cover × density` with density 0.4 as the realistic default; dividing by
 * this recovers the model's cover at the default, and larger densities push toward overcast.
 */
export const COVER_REFERENCE_DENSITY = 0.4;
/**
 * Coverage curve of the effective model cover x (Weibull: CAP·(1 − exp(−(x/S)^P))): scale, shape and
 * cap. Gentle at both ends so the density slider reads roughly linearly (see coverageFraction).
 */
const COVER_S = 0.74;
const COVER_P = 1.5;
const COVER_CAP = 0.98;

/**
 * Coverage fraction (0..1) for a received cover value (model cover × density): the fraction of the
 * area with any cloud at all (most of it thin, see cloudThickness / opticalDepth). 0 → 0, monotone,
 * saturating. At the default density the model's typical cover (≈ 0.63 globally, 0.72 over oceans,
 * 0.45 over land, 0.9 in storm tracks) maps to ≈ 0.54 (0.64 / 0.33 / 0.8) cloud fraction; density 0.1
 * leaves a few wisps over the wettest regions, 0.25 is light, 0.7 overcast-ish and 1 stormy (≈ 90 %,
 * capped: organized weather keeps some gaps, not a white ball).
 */
export function coverageFraction(cover: number): number {
  if (!(cover > 0)) return 0;
  const x = cover / COVER_REFERENCE_DENSITY;
  return COVER_CAP * (1 - Math.exp(-Math.pow(x / COVER_S, COVER_P)));
}

/** Effective model cover at which clouds have their reference thickness (the global mean at the default density). */
export const THICK_REF = 0.63;
/** Growth exponent and range of the thickness (the aux grid's B channel stores thickness / THICK_MAX). */
export const THICK_EXP = 1.5;
export const THICK_MIN = 0.5;
export const THICK_MAX = 6;

/**
 * Optical-thickness factor of the clouds for an effective model cover x (cover / reference density):
 * (x / THICK_REF)^THICK_EXP, clamped. Cloudier climates (and higher densities) bring thicker, brighter
 * cloud, not only more of it (the density slider keeps adding visible cloud once the coverage
 * saturates); dry regions keep thin, translucent wisps. The shader reads it from the aux grid.
 */
export function cloudThickness(x: number): number {
  return x > 0 ? Math.min(THICK_MAX, Math.max(THICK_MIN, Math.pow(x / THICK_REF, THICK_EXP))) : THICK_MIN;
}

/** Table of coverageFraction over [0, 2.5] (cover values are clamped there), 1/1024 steps. */
const LUT_N = 2560;
let lut: Float32Array | null = null;

function coverageLut(c: number): number {
  if (!lut) {
    lut = new Float32Array(LUT_N + 2);
    for (let i = 0; i <= LUT_N + 1; i++) lut[i] = coverageFraction(i / 1024);
  }
  const x = c * 1024;
  if (!(x > 0)) return 0;
  const i = x >= LUT_N ? LUT_N : Math.floor(x);
  const t = Math.min(1, x - i);
  return lut[i] + t * (lut[i + 1] - lut[i]);
}

/* ------------------------------------------------------------------ */
/* Climate analysis                                                    */
/* ------------------------------------------------------------------ */

export interface CloudClimate {
  /** +1: westerlies in mid-latitudes (Earth-like rotation), −1: retrograde (easterlies). */
  rotation: number;
  /** Storm-track latitude (radians, positive) per hemisphere [north, south]. */
  stormLat: [number, number];
  /** Storm-track zonal wind (m/s, in the prograde sense, ≥ 0) per hemisphere. */
  stormWind: [number, number];
}

const DEG = Math.PI / 180;

/** Zonal-mean zonal wind (m/s) per row. */
function zonalMeanU(spec: CloudSpec): Float64Array {
  const { w, h } = spec;
  const out = new Float64Array(h);
  if (!spec.u) return out;
  for (let r = 0; r < h; r++) {
    let s = 0, k = 0;
    for (let c = 0; c < w; c++) {
      const v = spec.u[r * w + c];
      if (Number.isFinite(v)) {
        s += v;
        k++;
      }
    }
    out[r] = k > 0 ? s / k : 0;
  }
  return out;
}

/** Rotation sense and storm tracks from the monthly wind (defaults: ±50°, weak, prograde). */
export function analyzeCloudClimate(spec: CloudSpec): CloudClimate {
  const { h } = spec;
  const um = zonalMeanU(spec);
  const latOf = (r: number): number => Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
  let mid = 0;
  for (let r = 0; r < h; r++) {
    const a = Math.abs(latOf(r));
    if (a > 30 * DEG && a < 65 * DEG) mid += um[r] * Math.cos(a);
  }
  const rotation = mid < 0 ? -1 : 1;
  const stormLat: [number, number] = [50 * DEG, 50 * DEG];
  const stormWind: [number, number] = [0, 0];
  for (let hemi = 0; hemi < 2; hemi++) {
    let best = -Infinity, bestLat = 50 * DEG, sw = 0, swl = 0;
    for (let r = 0; r < h; r++) {
      const lat = latOf(r);
      if ((hemi === 0) !== (lat > 0)) continue;
      const a = Math.abs(lat);
      if (a < 30 * DEG || a > 70 * DEG) continue;
      // Light smoothing over ±1 row.
      const v = rotation * (um[Math.max(0, r - 1)] + 2 * um[r] + um[Math.min(h - 1, r + 1)]) / 4;
      if (v > best) {
        best = v;
        bestLat = a;
      }
      // Wind-weighted mean latitude of the westerly belt (more robust than the arg-max alone).
      const wv = Math.max(0, v);
      sw += wv;
      swl += wv * a;
    }
    // No westerly belt at all (calm or odd climates): keep the Earth-like default.
    if (!(sw > 0)) continue;
    const centroid = swl / sw;
    stormLat[hemi] = Math.min(62 * DEG, Math.max(38 * DEG, 0.5 * (bestLat + centroid)));
    stormWind[hemi] = Math.max(0, best);
  }
  return { rotation, stormLat, stormWind };
}

/* ------------------------------------------------------------------ */
/* Regime grid                                                         */
/* ------------------------------------------------------------------ */

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Separable [1 2 1]/4 blur, longitude wrapping, rows clamped; `passes` times. */
function blur121(f: Float32Array, w: number, h: number, passes: number, tmp: Float32Array): void {
  for (let p = 0; p < passes; p++) {
    for (let r = 0; r < h; r++) {
      const o = r * w;
      for (let c = 0; c < w; c++) {
        const l = c === 0 ? w - 1 : c - 1, rr = c === w - 1 ? 0 : c + 1;
        tmp[o + c] = 0.25 * (f[o + l] + 2 * f[o + c] + f[o + rr]);
      }
    }
    for (let r = 0; r < h; r++) {
      const a = Math.max(0, r - 1) * w, b = r * w, d = Math.min(h - 1, r + 1) * w;
      for (let c = 0; c < w; c++) f[b + c] = 0.25 * (tmp[a + c] + 2 * tmp[b + c] + tmp[d + c]);
    }
  }
}

/**
 * Horizontal wind divergence (1e-6 s⁻¹) on the grid, blurred: > 0 subsidence (subtropical highs),
 * < 0 convergence (ITCZ, subpolar lows). Zero without wind.
 */
export function windDivergence(spec: CloudSpec, tmp?: Float32Array): Float32Array {
  const { w, h } = spec;
  const n = w * h;
  const div = new Float32Array(n);
  const U = spec.u, V = spec.v;
  if (!U || !V) return div;
  const R = 6.371e6, dl = (2 * Math.PI) / w, dp = Math.PI / h;
  const g = (a: Float32Array, i: number): number => {
    const v = a[i];
    return Number.isFinite(v) ? v : 0;
  };
  for (let r = 0; r < h; r++) {
    const lat = Math.PI / 2 - (r + 0.5) * dp;
    const cl = Math.max(0.05, Math.cos(lat));
    const rn = Math.max(0, r - 1), rs = Math.min(h - 1, r + 1);
    const latn = Math.PI / 2 - (rn + 0.5) * dp, lats = Math.PI / 2 - (rs + 0.5) * dp;
    const cn = Math.cos(latn), cs = Math.cos(lats);
    for (let c = 0; c < w; c++) {
      const e = r * w + ((c + 1) % w), wv = r * w + ((c - 1 + w) % w);
      const dudx = (g(U, e) - g(U, wv)) / (2 * dl * R * cl);
      const dvdy = (g(V, rn * w + c) * cn - g(V, rs * w + c) * cs) / ((latn - lats) * R * cl);
      div[r * w + c] = (dudx + dvdy) * 1e6;
    }
  }
  blur121(div, w, h, 3, tmp && tmp.length === n ? tmp : new Float32Array(n));
  return div;
}

/**
 * RGBA8 grid (w·h·4, row 0 north) for the shader / CPU renderer:
 *  R = coverage fraction (lightly blurred so the climate grid's coastlines don't print);
 *  G = marine stratocumulus (subtropical subsidence yet high cover — typically cold eastern ocean
 *      basins under equatorward flow): flat, thin, finely cellular decks;
 *  B = deep convection (tropics under low-level convergence with high cover): thick, bright clusters;
 *  A = shallow cumulus (subsidence elsewhere in the tropics/subtropics, and fair-weather regimes):
 *      small, thin popcorn cells.
 */
export function buildCloudRegimeGrid(spec: CloudSpec, out?: Uint8Array): Uint8Array {
  return regimeGrid(spec, out, null, null);
}

/** Regime grid; optionally also returns the blurred cover and the divergence (for the aux grid). */
function regimeGrid(spec: CloudSpec, out: Uint8Array | undefined, covOut: Float32Array | null, divOut: Float32Array | null): Uint8Array {
  const { w, h } = spec;
  const n = w * h;
  const img = out && out.length === n * 4 ? out : new Uint8Array(n * 4);
  const cov = covOut ?? new Float32Array(n);
  const tmp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = spec.cover[i];
    cov[i] = v === v ? Math.min(2.5, Math.max(0, v)) : 0;
  }
  blur121(cov, w, h, 2, tmp);
  const div = windDivergence(spec, tmp);
  if (divOut) divOut.set(div);
  for (let r = 0; r < h; r++) {
    const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
    const a = Math.abs(lat);
    const hs = lat >= 0 ? 1 : -1;
    const subtropics = smoothstep(6 * DEG, 14 * DEG, a) * (1 - smoothstep(34 * DEG, 44 * DEG, a));
    const tropics = 1 - smoothstep(18 * DEG, 30 * DEG, a);
    const lowLat = 1 - smoothstep(35 * DEG, 48 * DEG, a);
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const x = cov[i] / COVER_REFERENCE_DENSITY;
      const f = coverageLut(cov[i]);
      const vv = spec.v ? spec.v[i] : 0;
      const eq = Number.isFinite(vv) ? -vv * hs : 0; // equatorward wind (m/s)
      const sub = smoothstep(0.2, 2.2, div[i]);
      const con = smoothstep(0.2, 2.5, -div[i]);
      const sc = subtropics * sub * smoothstep(0.55, 0.8, x) * smoothstep(-0.5, 2, eq);
      const cv = tropics * con * smoothstep(0.45, 0.8, x);
      const cu = lowLat * sub * (1 - sc);
      const o = 4 * i;
      img[o] = Math.round(255 * f);
      img[o + 1] = Math.round(255 * sc);
      img[o + 2] = Math.round(255 * cv);
      img[o + 3] = Math.round(255 * cu);
    }
  }
  return img;
}

/** Box blur of half-width r along longitude (wrapping) then latitude (clamped), `passes` times. */
function boxBlur(f: Float32Array, w: number, h: number, r: number, passes: number, tmp: Float32Array): void {
  const k = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    for (let row = 0; row < h; row++) {
      const o = row * w;
      let s = 0;
      for (let d = -r; d <= r; d++) s += f[o + ((d % w) + w) % w];
      for (let c = 0; c < w; c++) {
        tmp[o + c] = s * k;
        s += f[o + (c + r + 1) % w] - f[o + ((c - r) % w + w) % w];
      }
    }
    for (let c = 0; c < w; c++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += tmp[Math.min(h - 1, Math.max(0, d)) * w + c];
      for (let row = 0; row < h; row++) {
        f[row * w + c] = s * k;
        s += tmp[Math.min(h - 1, row + r + 1) * w + c] - tmp[Math.max(0, row - r) * w + c];
      }
    }
  }
}

export interface CloudGrids {
  w: number;
  h: number;
  /** buildCloudRegimeGrid (coverage, stratocumulus, deep convection, shallow cumulus). */
  regime: Uint8Array;
  /**
   * RGBA8 auxiliary regimes: R = cirrus (anvil outflow around deep convection, jet-stream cirrus in
   * the storm tracks, a thin background), G = open-cell cumulus (cold-air outbreaks: equatorward flow
   * in the mid-latitudes), B = cloud thickness (cloudThickness / THICK_MAX), A = 0 (reserved).
   */
  aux: Uint8Array;
  /** Advection wind (m/s): the monthly wind smoothed to synoptic scales (little flow-map strain). */
  flowU: Float32Array;
  flowV: Float32Array;
  climate: CloudClimate;
}

/**
 * Everything the cloud renderers derive from a CloudSpec, in one pass (runs in the cloud worker):
 * regime and auxiliary grids, smoothed advection wind and the climate analysis.
 */
export function buildCloudGrids(spec: CloudSpec): CloudGrids {
  const { w, h } = spec;
  const n = w * h;
  const cov = new Float32Array(n), div = new Float32Array(n), tmp = new Float32Array(n);
  const regime = regimeGrid(spec, undefined, cov, div);
  const climate = analyzeCloudClimate(spec);
  // Cirrus: anvil outflow spreads ~1000 km around deep convection; jet cirrus along the storm tracks.
  const conv = new Float32Array(n);
  for (let i = 0; i < n; i++) conv[i] = regime[4 * i + 2] / 255;
  const cellDeg = 360 / w;
  const rr = Math.max(1, Math.round(4 / cellDeg));
  boxBlur(conv, w, h, rr, 2, tmp);
  const aux = new Uint8Array(n * 4);
  const U = spec.u, V = spec.v;
  for (let r = 0; r < h; r++) {
    const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
    const a = Math.abs(lat);
    const hs = lat >= 0 ? 1 : -1;
    const track = climate.stormLat[lat >= 0 ? 0 : 1];
    const jet = Math.exp(-(((a - track + 4 * DEG) / (11 * DEG)) ** 2));
    const midLat = smoothstep(30 * DEG, 40 * DEG, a) * (1 - smoothstep(62 * DEG, 72 * DEG, a));
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const x = cov[i] / COVER_REFERENCE_DENSITY;
      const f = regime[4 * i] / 255;
      const ci = Math.min(1, 0.35 * conv[i] + jet * smoothstep(0.35, 0.8, x) * 0.35 + 0.03 * smoothstep(0.3, 0.7, x));
      const vv = V ? V[i] : 0;
      const eq = Number.isFinite(vv) ? -vv * hs : 0;
      const open = midLat * smoothstep(0.5, 3, eq) * smoothstep(0.15, 0.4, f) * (1 - smoothstep(0.75, 0.95, f)) * smoothstep(-0.5, 1.5, div[i] + 1);
      aux[4 * i] = Math.round(255 * ci);
      aux[4 * i + 1] = Math.round(255 * Math.min(1, open));
      aux[4 * i + 2] = Math.round((255 * cloudThickness(x)) / THICK_MAX);
    }
  }
  const flowU = new Float32Array(n), flowV = new Float32Array(n);
  if (U && V) {
    for (let i = 0; i < n; i++) {
      const u = U[i], v = V[i];
      flowU[i] = Number.isFinite(u) ? u : 0;
      flowV[i] = Number.isFinite(v) ? v : 0;
    }
    const rw = Math.max(1, Math.round(3 / cellDeg));
    boxBlur(flowU, w, h, rw, 2, tmp);
    boxBlur(flowV, w, h, rw, 2, tmp);
  }
  return { w, h, regime, aux, flowU, flowV, climate };
}

/* ------------------------------------------------------------------ */
/* Cyclones                                                            */
/* ------------------------------------------------------------------ */

/** Cyclone slots per hemisphere. */
export const CYCLONES_PER_HEMISPHERE = 6;
export const CYCLONE_COUNT = 2 * CYCLONES_PER_HEMISPHERE;
/** Floats per cyclone in `cycloneStates` output: [x, y, z, radius, intensity, swirl, mirrorX, mirrorY]. */
export const CYCLONE_STRIDE = 8;
/** Life cycle length (animation seconds). */
export const CYCLONE_LIFE = 150;
/** Cloud drift: radians of arc per second per (m/s) of wind (10 m/s ≈ 0.29°/s: a gentle time-lapse). */
export const CLOUD_FLOW = 0.0005;
/**
 * Eastward (prograde) drift of the storms in longitude (radians per animation second): 12 m/s along a
 * 50° storm track. All storms of a hemisphere share it (a wave train), so they keep their spacing and
 * never run into one another.
 */
export const CYCLONE_DRIFT = (12 * CLOUD_FLOW) / Math.cos(50 * Math.PI / 180);
/**
 * Swirl (radians of rotation at the low's centre) of the comma template over a storm's life: an open
 * wave at birth, wound up into an occluded spiral (the dry slot wrapping into the centre) when mature.
 */
export const CYCLONE_SWIRL_MIN = 0.4;
export const CYCLONE_SWIRL_MAX = 4.0;

function hash(a: number, b: number, c: number): number {
  let x = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** Bilinear effective model cover (x = cover / reference density) at a lat/lon from the spec. */
export function coverAt(spec: CloudSpec, lat: number, lon: number): number {
  const { w, h } = spec;
  let fc = ((lon + Math.PI) / (2 * Math.PI)) * w - 0.5;
  fc = ((fc % w) + w) % w;
  const fr = Math.min(h - 1, Math.max(0, ((Math.PI / 2 - lat) / Math.PI) * h - 0.5));
  const c0 = Math.floor(fc), r0 = Math.floor(fr);
  const c1 = (c0 + 1) % w, r1 = Math.min(h - 1, r0 + 1);
  const tc = fc - c0, tr = fr - r0;
  const g = (r: number, c: number): number => {
    const v = spec.cover[r * w + c];
    return v === v ? v : 0;
  };
  const v = (g(r0, c0) * (1 - tc) + g(r0, c1) * tc) * (1 - tr) + (g(r1, c0) * (1 - tc) + g(r1, c1) * tc) * tr;
  return v / COVER_REFERENCE_DENSITY;
}

/** Floats per cyclone slot in a genesis memo: [cycle, lat0, lon0, drift, activity, rotation]. */
export const CYCLONE_MEMO_STRIDE = 6;

/**
 * Genesis memo for `cycloneStates` (animated views): each slot keeps the parameters it was born with
 * (genesis latitude/longitude, drift, activity, rotation sense) until its life cycle ends, so a new
 * cloud spec (month change, density slider, a new climate) only affects storms born afterwards
 * instead of teleporting the ones on screen. Empty (NaN) slots are filled on first use.
 */
export function createCycloneMemo(): Float64Array {
  return new Float64Array(CYCLONE_COUNT * CYCLONE_MEMO_STRIDE).fill(NaN);
}

/**
 * Cyclone states at animation time t (seconds). Writes CYCLONE_COUNT × CYCLONE_STRIDE floats:
 * unit-sphere centre in SPEC coordinates (x = cosφcosλ, y = cosφsinλ, z = sinφ), radius (radians of
 * arc), intensity 0..1 (0 = inactive), swirl angle at the centre (radians, ≥ 0: applied in the
 * cyclone's template frame, which is always cyclonic), and the template mirror signs (x: rotation
 * sense, y: hemisphere) that map template axes (x = downstream, y = poleward) to east/north.
 * The storms of a hemisphere form a wave train: slot k is born near the k-th of K evenly spaced
 * longitudes of a frame drifting east at CYCLONE_DRIFT and travels with it, so storms keep their
 * spacing (~60° of longitude) instead of running into one another. A storm is weaker where its
 * climate is dry (it fades over desert continents and strengthens again over the ocean).
 * Stateless (a pure function of t, spec and climate) unless a `memo` (createCycloneMemo) is given:
 * then each storm keeps its genesis parameters for its whole life (continuous across spec changes).
 */
export function cycloneStates(
  t: number, spec: CloudSpec | null, climate: CloudClimate, out: Float32Array, memo?: Float64Array,
): Float32Array {
  const K = CYCLONES_PER_HEMISPHERE;
  for (let hemi = 0; hemi < 2; hemi++) {
    const hs = hemi === 0 ? 1 : -1;
    const track = climate.stormLat[hemi];
    for (let k = 0; k < K; k++) {
      const o = (hemi * K + k) * CYCLONE_STRIDE;
      const phase = (k * 0.618034 + hemi * 0.37) % 1;
      const life = t / CYCLONE_LIFE + phase;
      const cycle = Math.floor(life);
      const age = life - cycle;
      const h1 = hash(hemi * 97 + k, cycle, 1), h2 = hash(hemi * 97 + k, cycle, 2);
      const h3 = hash(hemi * 97 + k, cycle, 3), h4 = hash(hemi * 97 + k, cycle, 4);
      const mo = (hemi * K + k) * CYCLONE_MEMO_STRIDE;
      let lat0: number, lon0: number, drift: number, act: number, rotation: number;
      if (memo && memo[mo] === cycle) {
        lat0 = memo[mo + 1];
        lon0 = memo[mo + 2];
        drift = memo[mo + 3];
        act = memo[mo + 4];
        rotation = memo[mo + 5];
      } else {
        rotation = climate.rotation;
        // Activity: stronger westerlies → stronger, bigger storms (winter hemisphere).
        act = smoothstep(0.5, 6, climate.stormWind[hemi]);
        drift = CYCLONE_DRIFT * rotation;
        lat0 = track - 7 * DEG + 6 * DEG * h2;
        // Genesis at the slot's place in the drifting wave train (a little jitter), at birth time.
        const born = (cycle - phase) * CYCLONE_LIFE;
        lon0 = -Math.PI + ((k + 0.5 + 0.3 * (h1 - 0.5)) / K) * 2 * Math.PI + drift * born + hemi * 0.4;
        lon0 -= 2 * Math.PI * Math.floor((lon0 + Math.PI) / (2 * Math.PI));
        if (memo) {
          memo[mo] = cycle;
          memo[mo + 1] = lat0;
          memo[mo + 2] = lon0;
          memo[mo + 3] = drift;
          memo[mo + 4] = act;
          memo[mo + 5] = rotation;
        }
      }
      const dur = CYCLONE_LIFE;
      const lat = Math.min(72 * DEG, lat0 + 11 * DEG * age);
      const lon = lon0 + drift * age * dur;
      // Weaker over dry climates (deserts, dry continental interiors), full strength over the oceans.
      const moist = spec ? 0.35 + 0.65 * smoothstep(0.25, 0.6, coverAt(spec, hs * lat, lon)) : 1;
      const inten = smoothstep(0, 0.22, age) * (1 - smoothstep(0.62, 1, age)) * (0.55 + 0.45 * act) * (0.75 + 0.25 * h3) * moist;
      const radius = (0.19 + 0.07 * h4) * (0.75 + 0.35 * smoothstep(0, 0.6, age)) * (0.8 + 0.25 * act);
      const swirl = CYCLONE_SWIRL_MIN + (CYCLONE_SWIRL_MAX - CYCLONE_SWIRL_MIN) * smoothstep(0.1, 0.85, age);
      const sl = hs * lat, cl = Math.cos(sl);
      out[o] = cl * Math.cos(lon);
      out[o + 1] = cl * Math.sin(lon);
      out[o + 2] = Math.sin(sl);
      out[o + 3] = radius;
      out[o + 4] = inten;
      out[o + 5] = swirl;
      out[o + 6] = rotation;
      out[o + 7] = hs;
    }
  }
  return out;
}
