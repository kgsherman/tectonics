/**
 * Static procedural detail in a plate's MATERIAL frame, baked into an equi-angular cube map.
 *
 * The height map samples it at R(rotation_k)ᵀ·p for the plate(s) under each pixel, so the detail
 * travels with the plates. Octaves are band-limited to the texel size; octaves with frequency
 * ≤ SPLIT_F are evaluated on a fixed-resolution coarse cube (COARSE_N, independent of the output
 * size) and upsampled, so the low octaves — which decide the coastline shapes — are identical for
 * every output resolution and quality.
 *
 * Channels (dimensionless):
 *   CH_RIDGE  ridged multifractal, ≈[0, 1], mean DetailTexture.ridgeMean (mountains)
 *   CH_HILL   octaves > SPLIT_F of a (weakly, isotropically) domain-warped fbm, ≈[-1, 1] (hills,
 *             abyssal hills, vegetation patchiness); a softer band limit keeps ~2-texel features
 *   CH_COAST  the same fine octaves (same noise values) with a whiter spectrum (COAST_GAIN), ≈[-1, 1]:
 *             coastline breakup — many small headlands, coves and skerries per unit of displaced
 *             area, rather than broad shifts of the simulated coast.
 *   CH_LITH   very-low-frequency fbm, ≈[-1, 1] (lithology / soil colour variation)
 */
import { createNoise3 } from '../core/noise';
import type { Noise3 } from '../core/noise';

export const DETAIL_CHANNELS = 4;
export const CH_RIDGE = 0;
export const CH_HILL = 1;
export const CH_COAST = 2;
export const CH_LITH = 3;

/** Fixed resolution of the coarse (low-octave) cube, per face edge. */
const COARSE_N = 128;
/** Octaves with frequency ≤ SPLIT_F (features/radian) live on the coarse cube. */
const SPLIT_F = 15;
const LACUNARITY = 2.03;
/** Equi-angular cube approximation: t = u + K·u·(1 − |u|) ≈ (4/π)·atan(u). */
export const EQ_K = 0.3476;

interface OctaveSet {
  f0: number;
  gain: number;
  octaves: number;
}
const FBM: OctaveSet = { f0: 2.6, gain: 0.6, octaves: 8 };
/** Gain of the fine (> SPLIT_F) octaves: whiter than the coarse ones so pixel-scale texture survives. */
const FINE_GAIN = 0.74;
/** Gain of the fine octaves in CH_COAST (whiter still: crisp, fractal coastlines). */
const COAST_GAIN = 0.88;
const RIDGE: OctaveSet = { f0: 7, gain: 0.6, octaves: 7 };
/** Gain of the fine ridged octaves (sharper pixel-scale ridges/valleys in mountain belts). */
const RIDGE_FINE_GAIN = 0.8;
/** Ridged cascade: next-octave weight = clamp(RIDGE_W0 + RIDGE_W1·s) (softer than Musgrave's 2·s). */
const RIDGE_W0 = 0.35;
const RIDGE_W1 = 1.4;
const LITH: OctaveSet = { f0: 3.5, gain: 0.5, octaves: 3 };
const WARP_F = [1.8, 3.9];
const WARP_AMP = [0.075, 0.03];
/**
 * Fraction of the (low-frequency) domain warp applied to the FINE octaves. The full warp stretches
 * pixel-scale noise up to ~4:1 where its Jacobian shears ("brushed" hair-like streaks in the land
 * texture, comb teeth on coasts perpendicular to the streaks); a fraction keeps the fine octaves
 * gently swirled but isotropic (≤ ~1.4:1). The coarse octaves keep the full warp.
 */
const FINE_WARP = 0.22;
const RIDGE_FINE_WARP = 0.45;

function amplitudeSum(o: OctaveSet, from: (f: number) => boolean): number {
  let s = 0;
  for (let k = 0, f = o.f0, a = 1; k < o.octaves; k++, f *= LACUNARITY, a *= o.gain) if (from(f)) s += a;
  return s;
}
const FBM_HIGH_NORM = (() => {
  // Fine octaves restart at amplitude 1 and decay with FINE_GAIN.
  let s = 0, a = 1;
  for (let k = 0, f = FBM.f0; k < FBM.octaves; k++, f *= LACUNARITY) {
    if (f <= SPLIT_F) continue;
    s += a;
    a *= FINE_GAIN;
  }
  return s;
})();
const COAST_NORM = (() => {
  let s = 0, a = 1;
  for (let k = 0, f = FBM.f0; k < FBM.octaves; k++, f *= LACUNARITY) {
    if (f <= SPLIT_F) continue;
    s += a;
    a *= COAST_GAIN;
  }
  return s;
})();
const RIDGE_NORM = (() => {
  // Coarse octaves decay with RIDGE.gain, fine ones continue with RIDGE_FINE_GAIN.
  let s = 0, a = 1;
  for (let k = 0, f = RIDGE.f0; k < RIDGE.octaves; k++, f *= LACUNARITY) {
    s += a;
    a *= f <= SPLIT_F ? RIDGE.gain : RIDGE_FINE_GAIN;
  }
  return s;
})();
const LITH_NORM = amplitudeSum(LITH, () => true);

// Coarse channels.
const K_RSUM = 0, K_RW = 1, K_LITH = 2, K_WX = 3, K_WY = 4, K_WZ = 5;
const COARSE_CH = 6;

export interface DetailTexture {
  /** Texels per face edge (without the 1-texel border). */
  n: number;
  /** n + 2. */
  stride: number;
  /** 6·stride²·DETAIL_CHANNELS floats, layout ((face·stride + j)·stride + i)·C + ch. */
  data: Float32Array;
  /** Highest noise frequency (features/radian) represented. */
  fmax: number;
  /**
   * Mean of CH_RIDGE over the texture. Fine ridged octaves carry a positive mean, so it depends on
   * the resolution; subtracting it keeps mountain detail zero-mean at every resolution.
   */
  ridgeMean: number;
  /** Extremes over the texture: max(CH_RIDGE) − ridgeMean, max |CH_COAST|, max |CH_HILL|. */
  ridgeUp: number;
  coastAbs: number;
  hillAbs: number;
}

/** Face resolution used for an output raster of width w (texel ≈ equatorial pixel). */
export function detailResolution(w: number): number {
  return Math.max(64, Math.min(640, Math.round(w / 4)));
}

export function tFromU(u: number): number {
  return u + EQ_K * u * (1 - Math.abs(u));
}

export function uFromT(t: number): number {
  const a = Math.abs(t);
  const u = (1 + EQ_K - Math.sqrt((1 + EQ_K) * (1 + EQ_K) - 4 * EQ_K * a)) / (2 * EQ_K);
  return t < 0 ? -u : u;
}

/** Octave weight: 1 well below the texel Nyquist frequency, fading to 0 at fmax. */
function octaveWeight(f: number, fmax: number): number {
  if (f <= 0.5 * fmax) return 1;
  if (f >= fmax) return 0;
  const x = (fmax - f) / (0.5 * fmax);
  return x * x * (3 - 2 * x);
}

/**
 * Softer band limit for the texture-only hill octaves: an octave just above the nominal limit keeps
 * part of its amplitude (features of ~2 texels), so land textures stay crisp down to the pixel.
 */
function hillOctaveWeight(f: number, fmax: number): number {
  const lo = 0.6 * fmax, hi = 1.4 * fmax;
  if (f <= lo) return 1;
  if (f >= hi) return 0;
  const x = (hi - f) / (hi - lo);
  return x * x * (3 - 2 * x);
}

/** Unit direction of cube face `face` at gnomonic coordinates (u, v). */
function faceDir(face: number, u: number, v: number, out: Float64Array): void {
  let x: number, y: number, z: number;
  switch (face) {
    case 0: x = 1; y = u; z = v; break;
    case 1: x = -1; y = u; z = v; break;
    case 2: x = u; y = 1; z = v; break;
    case 3: x = u; y = -1; z = v; break;
    case 4: x = u; y = v; z = 1; break;
    default: x = u; y = v; z = -1; break;
  }
  const l = 1 / Math.sqrt(x * x + y * y + z * z);
  out[0] = x * l;
  out[1] = y * l;
  out[2] = z * l;
}

/** Equi-angular t-coordinates (−1..1 inside the face) of the n + 2 bordered texel centres. */
function texelTs(n: number): Float64Array {
  const t = new Float64Array(n + 2);
  for (let i = 0; i < n + 2; i++) t[i] = ((i - 0.5) * 2) / n - 1;
  return t;
}

interface Noises {
  fbm: Noise3;
  ridge: Noise3;
  lith: Noise3;
  wx: Noise3;
  wy: Noise3;
  wz: Noise3;
}

function makeNoises(seed: number): Noises {
  const s = (Math.floor(seed) * 7919) | 0;
  return {
    fbm: createNoise3(s + 101),
    ridge: createNoise3(s + 202),
    lith: createNoise3(s + 404),
    wx: createNoise3(s + 505),
    wy: createNoise3(s + 606),
    wz: createNoise3(s + 707),
  };
}

/** Coarse cube: octaves ≤ SPLIT_F of every channel plus the domain warp. */
function buildCoarse(nz: Noises): Float32Array {
  const n = COARSE_N;
  const stride = n + 2;
  const data = new Float32Array(6 * stride * stride * COARSE_CH);
  const d = new Float64Array(3);
  const us = texelTs(n).map(uFromT);
  for (let face = 0; face < 6; face++) {
    for (let j = 0; j < stride; j++) {
      for (let i = 0; i < stride; i++) {
        faceDir(face, us[i], us[j], d);
        const x = d[0], y = d[1], z = d[2];
        let wx = 0, wy = 0, wz = 0;
        for (let k = 0; k < WARP_F.length; k++) {
          const f = WARP_F[k], a = WARP_AMP[k];
          wx += a * nz.wx(x * f + k * 5.1, y * f, z * f);
          wy += a * nz.wy(x * f, y * f + k * 5.1, z * f);
          wz += a * nz.wz(x * f, y * f, z * f + k * 5.1);
        }
        const X = x + wx, Y = y + wy, Z = z + wz;
        let rsum = 0, rw = 1;
        for (let o = 0, f = RIDGE.f0, a = 1; o < RIDGE.octaves && f <= SPLIT_F; o++, f *= LACUNARITY, a *= RIDGE.gain) {
          // Ridged multifractal (Musgrave): sharp crests, each octave weighted by the previous one.
          let s = 1 - Math.abs(nz.ridge(X * f + o * 31.7, Y * f + o * 7.3, Z * f - o * 13.1));
          s *= s * rw;
          rw = RIDGE_W0 + RIDGE_W1 * s > 1 ? 1 : RIDGE_W0 + RIDGE_W1 * s;
          rsum += s * a;
        }
        let lsum = 0;
        for (let o = 0, f = LITH.f0, a = 1; o < LITH.octaves; o++, f *= LACUNARITY, a *= LITH.gain) {
          lsum += a * nz.lith(x * f + o * 11.3, y * f + o * 3.1, z * f - o * 8.9);
        }
        const q = ((face * stride + j) * stride + i) * COARSE_CH;
        data[q + K_RSUM] = rsum;
        data[q + K_RW] = rw;
        data[q + K_LITH] = lsum / LITH_NORM;
        data[q + K_WX] = wx;
        data[q + K_WY] = wy;
        data[q + K_WZ] = wz;
      }
    }
  }
  return data;
}

/** First octave index of `o` above SPLIT_F, its frequency and amplitude. */
function fineStart(o: OctaveSet): { k: number; f: number; a: number } {
  let k = 0, f = o.f0, a = 1;
  while (k < o.octaves && f <= SPLIT_F) {
    k++;
    f *= LACUNARITY;
    a *= o.gain;
  }
  return { k, f, a };
}

/**
 * Build the detail texture with face resolution n for a seed. Deterministic; the coarse octaves do
 * not depend on n.
 */
export function buildDetailTexture(seed: number, n: number): DetailTexture {
  if (!Number.isInteger(n) || n < 8) throw new Error(`buildDetailTexture: bad face resolution ${n}`);
  const nz = makeNoises(seed);
  const coarse = buildCoarse(nz);
  const stride = n + 2;
  const cStride = COARSE_N + 2;
  const C = DETAIL_CHANNELS;
  const data = new Float32Array(6 * stride * stride * C);
  // Texel size (π/2)/n; simplex features span ~2/f, so ~3 texels per feature at fmax.
  const fmax = n / Math.PI;
  const ts = texelTs(n);
  const us = ts.map(uFromT);
  // Coarse bilinear coordinates per texel index (same face parameterization).
  const ci = new Int32Array(stride);
  const cf = new Float64Array(stride);
  for (let i = 0; i < stride; i++) {
    const s = (ts[i] + 1) * 0.5 * COARSE_N + 0.5;
    const i0 = Math.min(COARSE_N, Math.max(0, Math.floor(s)));
    ci[i] = i0;
    cf[i] = Math.min(1, Math.max(0, s - i0));
  }
  // Fine octave tables (frequency, amplitude × band-limit weight).
  const fbmF: number[] = [], fbmA: number[] = [], fbmC: number[] = [], ridF: number[] = [], ridA: number[] = [], ridK: number[] = [];
  {
    let { k, f } = fineStart(FBM);
    let a = 1;
    let ac = 1;
    for (; k < FBM.octaves; k++, f *= LACUNARITY, a *= FINE_GAIN, ac *= COAST_GAIN) {
      const wh = hillOctaveWeight(f, fmax), w = octaveWeight(f, fmax);
      if (wh <= 0) break;
      fbmF.push(f);
      fbmA.push((wh * a) / FBM_HIGH_NORM);
      fbmC.push((w * ac) / COAST_NORM);
    }
    ({ k, f, a } = fineStart(RIDGE));
    for (; k < RIDGE.octaves; k++, f *= LACUNARITY, a *= RIDGE_FINE_GAIN) {
      const w = octaveWeight(f, fmax);
      if (w <= 0) break;
      ridF.push(f);
      ridA.push(w * a);
      ridK.push(k);
    }
  }
  const fbmK0 = fineStart(FBM).k;
  const d = new Float64Array(3);
  const cs = new Float64Array(COARSE_CH);
  for (let face = 0; face < 6; face++) {
    for (let j = 0; j < stride; j++) {
      const j0 = ci[j], fv = cf[j];
      for (let i = 0; i < stride; i++) {
        faceDir(face, us[i], us[j], d);
        const i0 = ci[i], fu = cf[i];
        const q00 = ((face * cStride + j0) * cStride + i0) * COARSE_CH;
        const q01 = q00 + COARSE_CH;
        const q10 = q00 + cStride * COARSE_CH;
        const q11 = q10 + COARSE_CH;
        const w00 = (1 - fu) * (1 - fv), w01 = fu * (1 - fv), w10 = (1 - fu) * fv, w11 = fu * fv;
        for (let k = 0; k < COARSE_CH; k++) {
          cs[k] = w00 * coarse[q00 + k] + w01 * coarse[q01 + k] + w10 * coarse[q10 + k] + w11 * coarse[q11 + k];
        }
        const X = d[0] + FINE_WARP * cs[K_WX], Y = d[1] + FINE_WARP * cs[K_WY], Z = d[2] + FINE_WARP * cs[K_WZ];
        let hsum = 0, csum = 0;
        for (let m = 0; m < fbmF.length; m++) {
          const f = fbmF[m], o = fbmK0 + m;
          const v = nz.fbm(X * f + o * 17.13, Y * f - o * 9.71, Z * f + o * 5.37);
          hsum += fbmA[m] * v;
          csum += fbmC[m] * v;
        }
        const XR = d[0] + RIDGE_FINE_WARP * cs[K_WX], YR = d[1] + RIDGE_FINE_WARP * cs[K_WY], ZR = d[2] + RIDGE_FINE_WARP * cs[K_WZ];
        let rsum = cs[K_RSUM], rw = cs[K_RW];
        for (let m = 0; m < ridF.length; m++) {
          const f = ridF[m], o = ridK[m];
          let s = 1 - Math.abs(nz.ridge(XR * f + o * 31.7, YR * f + o * 7.3, ZR * f - o * 13.1));
          s *= s * rw;
          rw = RIDGE_W0 + RIDGE_W1 * s > 1 ? 1 : RIDGE_W0 + RIDGE_W1 * s;
          rsum += ridA[m] * s;
        }
        const q = ((face * stride + j) * stride + i) * C;
        data[q + CH_RIDGE] = rsum / RIDGE_NORM;
        data[q + CH_HILL] = hsum;
        data[q + CH_COAST] = csum;
        data[q + CH_LITH] = cs[K_LITH];
      }
    }
  }
  let rs = 0, rMax = 0, cAbs = 0, hAbs = 0;
  for (let q = 0; q < data.length; q += C) {
    const rv = data[q + CH_RIDGE], cv = Math.abs(data[q + CH_COAST]), hv = Math.abs(data[q + CH_HILL]);
    rs += rv;
    if (rv > rMax) rMax = rv;
    if (cv > cAbs) cAbs = cv;
    if (hv > hAbs) hAbs = hv;
  }
  const ridgeMean = rs / (data.length / C);
  return { n, stride, data, fmax, ridgeMean, ridgeUp: rMax - ridgeMean, coastAbs: cAbs, hillAbs: hAbs };
}

/**
 * Bilinear sample of all channels at unit direction (x, y, z) in the texture's frame; writes
 * DETAIL_CHANNELS values to out[o..]. Hot path: no allocation.
 */
export function sampleDetail(tex: DetailTexture, x: number, y: number, z: number, out: Float64Array, o: number): void {
  const ax = x < 0 ? -x : x, ay = y < 0 ? -y : y, az = z < 0 ? -z : z;
  let face: number, u: number, v: number;
  if (ax >= ay && ax >= az) {
    face = x > 0 ? 0 : 1;
    const inv = 1 / ax;
    u = y * inv;
    v = z * inv;
  } else if (ay >= az) {
    face = y > 0 ? 2 : 3;
    const inv = 1 / ay;
    u = x * inv;
    v = z * inv;
  } else {
    face = z > 0 ? 4 : 5;
    const inv = 1 / az;
    u = x * inv;
    v = y * inv;
  }
  const n = tex.n, stride = tex.stride;
  const hn = 0.5 * n;
  const su = (u + EQ_K * u * (1 - (u < 0 ? -u : u)) + 1) * hn + 0.5;
  const sv = (v + EQ_K * v * (1 - (v < 0 ? -v : v)) + 1) * hn + 0.5;
  let i0 = su | 0, j0 = sv | 0;
  if (i0 > n) i0 = n;
  if (j0 > n) j0 = n;
  const fu = su - i0, fv = sv - j0;
  const d = tex.data;
  const q00 = ((face * stride + j0) * stride + i0) << 2;
  const q10 = q00 + (stride << 2);
  const a = (1 - fu) * (1 - fv), b = fu * (1 - fv), c = (1 - fu) * fv, e = fu * fv;
  out[o] = a * d[q00] + b * d[q00 + 4] + c * d[q10] + e * d[q10 + 4];
  out[o + 1] = a * d[q00 + 1] + b * d[q00 + 5] + c * d[q10 + 1] + e * d[q10 + 5];
  out[o + 2] = a * d[q00 + 2] + b * d[q00 + 6] + c * d[q10 + 2] + e * d[q10 + 6];
  out[o + 3] = a * d[q00 + 3] + b * d[q00 + 7] + c * d[q10 + 3] + e * d[q10 + 7];
}
