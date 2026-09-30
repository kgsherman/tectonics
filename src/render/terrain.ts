/**
 * Display height map: smoothed mesh elevation + procedural detail sampled in each plate's material
 * frame (SPEC §7). Layer-independent; cached per (mesh.n, snapshot.id, size, seed, detail, quality,
 * sea level).
 */
import * as _constants from '../core/constants';
import * as _grid from '../core/grid';
import * as _math3 from '../core/math3';
import type { MeshGridMap, PaintOptions, SphereMesh, WorldSnapshot } from '../core/types';
import * as _types from '../core/types';
import type { PaintCache } from './paintCache';
import * as _paintGeometry from './paintGeometry';
import * as _terrainBase from './terrainBase';
import * as _terrainDetail from './terrainDetail';
import type { DetailTexture } from './terrainDetail';

// Imported values are copied into module constants: some module runners (vitest / vite-node SSR)
// compile named imports into namespace property reads, which would otherwise sit in per-pixel loops.
const { EARTH_RADIUS_KM } = _constants;
const { meshToGrid } = _grid;
const { quatToMat3 } = _math3;
const { CRUST_CONTINENTAL } = _types;
const { rasterGeometry } = _paintGeometry;
const { blurMetric, scratchFloat32 } = _terrainBase;
const {
  CH_COAST, CH_HILL, CH_LITH, CH_RIDGE, DETAIL_CHANNELS, EQ_K, HILL_IN_COAST, buildDetailTexture,
  detailResolution, sampleDetail,
} = _terrainDetail;

/** Elevation used when there is no snapshot (neutral open ocean). */
export const NEUTRAL_OCEAN_DEPTH = -3000;
/** Base-blur σ as a fraction of the mesh spacing. */
const BASE_SIGMA_SPACINGS = 0.6;
/**
 * Preview only: pixels whose base plus a conservative bound on their detail stays this far below
 * the display sea level keep the smooth sea floor (skipping the texture lookups). Coastlines are
 * therefore identical to 'full' at every sea level.
 */
const PREVIEW_DEEP_SKIP_M = -1500;

/**
 * Coastline breakup: the fbm displaces contour lines horizontally by up to L km (first-order domain
 * warp Δh = L·|∇b|·noise — rotation-invariant, so it moves with the plate) plus a small vertical
 * term, concentrated around the display sea level. L grows with the coastal slope and with the regional
 * (lithology) ruggedness: low plains get smooth coasts, steep or rugged coasts get rias, fjords and
 * skerries. The bump around sea level widens with the displacement so steep coasts get their full
 * breakup while lowland interiors stay free of spurious pits.
 */
const COAST_SHIFT_MIN_KM = 90;
const COAST_SHIFT_MAX_KM = 430;
const COAST_VERTICAL_M = 150;
const COAST_BAND_M = 380;
const COAST_MAX_M = 6000;

export interface HeightField {
  w: number;
  h: number;
  /** Amplified elevation (m). */
  height: Float32Array;
  /** Plate-frame hill noise at the pixel (≈[-1,1]) — terrain-anchored patchiness for colouring. */
  patch: Float32Array;
  /** Plate-frame lithology noise at the pixel (≈[-1,1]) — soil/rock colour variation. */
  lith: Float32Array;
  /** Mountain (ridged) detail at the pixel, m: > 0 on crests, < 0 in valleys. */
  rough: Float32Array;
}

/** Per-mesh-cell fields derived from a snapshot (display copies; never written back). */
interface MeshTerrain {
  /** Laplacian-smoothed elevation (m). */
  elev: Float32Array;
  /** Interleaved [ridge amplitude, hill amplitude] per cell (m). */
  amp: Float32Array;
}

/** Smoothstep of a normalized argument. */
function ss(t: number): number {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/**
 * Per mesh cell: one Laplacian smoothing step of the elevation (λ = ½) and the mountainousness /
 * roughness amplitudes from elevation, orogeny, mesh-scale relief and crust age (one neighbour pass
 * for both, then one smoothing pass of the amplitudes).
 */
function buildMeshTerrain(mesh: SphereMesh, s: WorldSnapshot): MeshTerrain {
  const { n, adjOffset, adj } = mesh;
  const src = s.elev;
  const elev = new Float32Array(n);
  const raw = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    const e = src[i];
    const a0 = adjOffset[i], a1 = adjOffset[i + 1];
    let sum = 0, rel = 0;
    for (let k = a0; k < a1; k++) {
      const v = src[adj[k]];
      sum += v;
      rel += (v - e) * (v - e);
    }
    const deg = a1 - a0;
    const inv = deg > 0 ? 1 / deg : 0;
    elev[i] = deg > 0 ? 0.5 * (e + sum * inv) : e;
    const relief = Math.sqrt(rel * inv);
    const oro = s.orogeny[i] > 0 ? s.orogeny[i] : 0;
    const age = s.age[i] > 0 ? s.age[i] : 0;
    // Land / continental relief: recent orogeny, high elevation and steep mesh-scale relief.
    const mOro = oro / (1100 + oro);
    const mElev = 0.85 * ss((e - 400) * (1 / 3400));
    const mRel = (0.7 * relief) / (900 + relief);
    const landR = 3000 * Math.max(mOro, mElev, mRel) + 160;
    const landH = 35 + 0.07 * landR + 90 * ss((e - 200) * (1 / 1800));
    // Ocean floor: rough young ridge flanks, abyssal hills smoothed by sediment with age.
    const oceanR = 650 / (1 + age * 0.1) + (120 * relief) / (700 + relief) + 60;
    const oceanH = 170 / (1 + age * (1 / 70)) + 70;
    // Continental crust or anything near/above sea level behaves like land.
    const t = s.crust[i] === CRUST_CONTINENTAL ? 1 : ss((e + 2500) * (1 / 2200));
    raw[2 * i] = t * landR + (1 - t) * oceanR;
    raw[2 * i + 1] = t * landH + (1 - t) * oceanH;
  }
  // One smoothing pass (λ = ½) on both amplitudes.
  const amp = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    const a0 = adjOffset[i], a1 = adjOffset[i + 1];
    let sr = 0, sh = 0;
    for (let k = a0; k < a1; k++) {
      const j = 2 * adj[k];
      sr += raw[j];
      sh += raw[j + 1];
    }
    const inv = a1 > a0 ? 1 / (a1 - a0) : 0;
    amp[2 * i] = a1 > a0 ? 0.5 * (raw[2 * i] + sr * inv) : raw[2 * i];
    amp[2 * i + 1] = a1 > a0 ? 0.5 * (raw[2 * i + 1] + sh * inv) : raw[2 * i + 1];
  }
  return { elev, amp };
}

export function detailTexture(seed: number, w: number, cache: PaintCache): DetailTexture {
  const n = detailResolution(w);
  const s = Math.floor(seed) | 0;
  return cache.getOrBuild(`detail|${s}|${n}`, () => buildDetailTexture(s, n));
}

function meshTerrain(mesh: SphereMesh, s: WorldSnapshot, cache: PaintCache): MeshTerrain {
  return cache.getOrBuild(`meshterrain|${mesh.n}|${s.id}`, () => buildMeshTerrain(mesh, s));
}

export function detailAmount(opts: PaintOptions): number {
  const d = opts.detail ?? 1;
  if (!Number.isFinite(d)) throw new Error(`paint: detail must be finite (got ${d})`);
  return Math.max(0, Math.min(2, d));
}

export function qualityOf(opts: PaintOptions): 'preview' | 'full' {
  return opts.quality === 'preview' ? 'preview' : 'full';
}

export function heightFieldKey(mesh: SphereMesh, s: WorldSnapshot | null, opts: PaintOptions): string {
  const seed = Math.floor(opts.seed) | 0;
  // Sea level is part of the surface: the coastline breakup and the preview deep-sea skip are
  // centred on the display coastline.
  return `height|${mesh.n}|${s ? s.id : 'none'}|${opts.width}x${opts.height}|${seed}|${detailAmount(opts)}|${qualityOf(opts)}|${opts.seaLevel}`;
}

/** Height field (cached). The returned arrays are shared cache state: never transfer them. */
export function getHeightField(mesh: SphereMesh, s: WorldSnapshot | null, opts: PaintOptions, cache: PaintCache): HeightField {
  return cache.getOrBuild(heightFieldKey(mesh, s, opts), () => buildHeightField(mesh, s, opts, cache));
}

function buildHeightField(mesh: SphereMesh, s: WorldSnapshot | null, opts: PaintOptions, cache: PaintCache): HeightField {
  const w = opts.width, h = opts.height;
  const npx = w * h;
  const height = new Float32Array(npx);
  const patch = new Float32Array(npx);
  const lith = new Float32Array(npx);
  const rough = new Float32Array(npx);
  if (!s) {
    height.fill(NEUTRAL_OCEAN_DEPTH);
    return { w, h, height, patch, lith, rough };
  }
  if (s.n !== mesh.n) throw new Error(`paint: snapshot.n (${s.n}) ≠ mesh.n (${mesh.n})`);
  const map = cache.getGridMap(mesh, w, h);
  const mt = meshTerrain(mesh, s, cache);
  const tex = detailTexture(opts.seed, w, cache);
  // Scratch slot 0: the interpolated/blurred base is only needed while composing.
  const base = meshToGrid(map, mt.elev, scratchFloat32(0, npx));
  blurMetric(base, w, h, BASE_SIGMA_SPACINGS * mesh.spacing);
  const sea = opts.seaLevel;
  const skipBelow = qualityOf(opts) === 'preview' ? sea + PREVIEW_DEEP_SKIP_M : -Infinity;
  const out: HeightField = { w, h, height, patch, lith, rough };
  composeDetail(map, s, mt, tex, base, detailAmount(opts), sea, skipBelow, cache, out);
  return out;
}

/** Rotation matrices R (material → world, row-major) per plate; slot np = identity for invalid plates. */
function plateMatrices(s: WorldSnapshot): Float64Array {
  const np = s.plates.length;
  const m = new Float64Array(9 * (np + 1));
  const tmp = new Float64Array(9);
  for (let k = 0; k <= np; k++) {
    const q = k < np ? s.plates[k].rotation : [0, 0, 0, 1];
    const l = Math.hypot(q[0], q[1], q[2], q[3]);
    if (!(l > 0) || !Number.isFinite(l)) throw new Error(`paint: plate ${k} has an invalid rotation quaternion`);
    quatToMat3([q[0] / l, q[1] / l, q[2] / l, q[3] / l], tmp);
    m.set(tmp, 9 * k);
  }
  return m;
}

/** Per-vertex plate slot (0..np, np for out-of-range indices). */
function plateSlots(s: WorldSnapshot): Uint8Array {
  const np = s.plates.length;
  const out = new Uint8Array(s.n);
  for (let i = 0; i < s.n; i++) {
    const k = s.plate[i];
    out[i] = k >= 0 && k < np ? k : np;
  }
  return out;
}

function composeDetail(
  map: MeshGridMap, s: WorldSnapshot, mt: MeshTerrain, tex: DetailTexture, base: Float32Array, amount: number,
  sea: number, skipBelow: number, cache: PaintCache, out: HeightField,
): void {
  const { height, patch, lith, rough } = out;
  const { w, h, tri, bary } = map;
  const geo = rasterGeometry(w, h, cache);
  const { cosLat, sinLat, cosLon, sinLon } = geo;
  const M = plateMatrices(s);
  const slot = plateSlots(s);
  const amp = mt.amp;
  const smp = new Float64Array(DETAIL_CHANNELS);
  const acc = new Float64Array(DETAIL_CHANNELS);
  const ks = new Int32Array(3);
  const ws = new Float64Array(3);
  const invDy = 1 / (2 * geo.dLat * EARTH_RADIUS_KM);
  const td = tex.data, tn = tex.n, tStride = tex.stride, thn = 0.5 * tex.n;
  const ridgeMean = tex.ridgeMean, ridgeUp = tex.ridgeUp, hillAbs = tex.hillAbs;
  const coastBound = 1.1 * tex.coastAbs + 1.45 * HILL_IN_COAST * tex.hillAbs;
  let curPlate = -1, m0 = 0, m1 = 0, m2 = 0, m3 = 0, m4 = 0, m5 = 0, m6 = 0, m7 = 0, m8 = 0;
  for (let r = 0; r < h; r++) {
    const cl = cosLat[r], sl = sinLat[r];
    const invDx = 1 / (2 * geo.dLon * Math.max(1e-4, cl) * EARTH_RADIUS_KM);
    const row = r * w;
    const rowN = (r > 0 ? r - 1 : 0) * w, rowS = (r < h - 1 ? r + 1 : h - 1) * w;
    for (let c = 0; c < w; c++) {
      const p = row + c;
      const b = base[p];
      // Height above the display sea level (the coastline breakup is centred on it).
      const bs = b - sea;
      const k3 = 3 * p;
      const va = tri[k3], vb = tri[k3 + 1], vc = tri[k3 + 2];
      const wa = bary[k3], wb = bary[k3 + 1], wc = bary[k3 + 2];
      const ar = wa * amp[2 * va] + wb * amp[2 * vb] + wc * amp[2 * vc];
      const ah = wa * amp[2 * va + 1] + wb * amp[2 * vb + 1] + wc * amp[2 * vc + 1];
      // Base slope (m/km) → horizontal contour displacement near sea level.
      const gx = (base[row + (c + 1 < w ? c + 1 : 0)] - base[row + (c > 0 ? c - 1 : w - 1)]) * invDx;
      const gy = (base[rowN + c] - base[rowS + c]) * invDy;
      const slope = Math.sqrt(gx * gx + gy * gy);
      if (b < skipBelow) {
        // Conservative bound of the detail (channel extremes of this texture, maximal coast
        // shift). Deep pixels that cannot reach skipBelow keep the smooth base.
        let sMax = COAST_SHIFT_MAX_KM * slope;
        if (sMax > COAST_MAX_M) sMax = COAST_MAX_M;
        const bwM = COAST_BAND_M + 0.7 * sMax;
        const bbM = 1 + (bs * bs) / (bwM * bwM);
        let bound = amount * (ar * ridgeUp + ((COAST_VERTICAL_M + sMax) / (bbM * bbM)) * coastBound + ah * hillAbs);
        // The variance-preserving blend across plate boundaries (Σw·x / √Σw²) can amplify each
        // channel by up to √(plates in the triangle) ≤ √3.
        if (slot[va] !== slot[vb] || slot[va] !== slot[vc]) bound *= 1.7320508075688772;
        if (b + bound < skipBelow) {
          height[p] = b;
          continue;
        }
      }
      const pa = slot[va], pb = slot[vb], pc = slot[vc];
      const x = cl * cosLon[c], y = cl * sinLon[c], z = sl;
      let ridge: number, hill: number, coast: number, li: number;
      if (pa === pb && pa === pc) {
        // Single plate (the common case): sampleDetail() inlined by hand (V8 does not inline it and
        // the call doubles the cost). Material-frame direction Rᵀ·p → equi-angular cube texel.
        if (pa !== curPlate) {
          // Consecutive pixels mostly share a plate: keep its matrix in registers.
          const o = 9 * pa;
          m0 = M[o]; m1 = M[o + 1]; m2 = M[o + 2]; m3 = M[o + 3]; m4 = M[o + 4];
          m5 = M[o + 5]; m6 = M[o + 6]; m7 = M[o + 7]; m8 = M[o + 8];
          curPlate = pa;
        }
        const mx = m0 * x + m3 * y + m6 * z;
        const my = m1 * x + m4 * y + m7 * z;
        const mz = m2 * x + m5 * y + m8 * z;
        const ax = mx < 0 ? -mx : mx, ay = my < 0 ? -my : my, az = mz < 0 ? -mz : mz;
        let face: number, u: number, v: number;
        if (ax >= ay && ax >= az) {
          face = mx > 0 ? 0 : 1;
          const inv = 1 / ax;
          u = my * inv;
          v = mz * inv;
        } else if (ay >= az) {
          face = my > 0 ? 2 : 3;
          const inv = 1 / ay;
          u = mx * inv;
          v = mz * inv;
        } else {
          face = mz > 0 ? 4 : 5;
          const inv = 1 / az;
          u = mx * inv;
          v = my * inv;
        }
        const su = (u + EQ_K * u * (1 - (u < 0 ? -u : u)) + 1) * thn + 0.5;
        const sv = (v + EQ_K * v * (1 - (v < 0 ? -v : v)) + 1) * thn + 0.5;
        let i0 = su | 0, j0 = sv | 0;
        if (i0 > tn) i0 = tn;
        if (j0 > tn) j0 = tn;
        const fu = su - i0, fv = sv - j0;
        const q00 = ((face * tStride + j0) * tStride + i0) << 2;
        const q10 = q00 + (tStride << 2);
        const f00 = (1 - fu) * (1 - fv), f01 = fu * (1 - fv), f10 = (1 - fu) * fv, f11 = fu * fv;
        ridge = f00 * td[q00] + f01 * td[q00 + 4] + f10 * td[q10] + f11 * td[q10 + 4];
        hill = f00 * td[q00 + 1] + f01 * td[q00 + 5] + f10 * td[q10 + 1] + f11 * td[q10 + 5];
        coast = f00 * td[q00 + 2] + f01 * td[q00 + 6] + f10 * td[q10 + 2] + f11 * td[q10 + 6];
        li = f00 * td[q00 + 3] + f01 * td[q00 + 7] + f10 * td[q10 + 3] + f11 * td[q10 + 7];
      } else {
        // Distinct plates in this triangle with their summed barycentric weights.
        let m = 1;
        ks[0] = pa;
        ws[0] = wa;
        if (pb === pa) ws[0] += wb;
        else { ks[m] = pb; ws[m] = wb; m++; }
        if (pc === ks[0]) ws[0] += wc;
        else if (m === 2 && pc === ks[1]) ws[1] += wc;
        else { ks[m] = pc; ws[m] = wc; m++; }
        acc.fill(0);
        let w2 = 0;
        for (let q = 0; q < m; q++) {
          const o = 9 * ks[q], wq = ws[q];
          sampleDetail(tex,
            M[o] * x + M[o + 3] * y + M[o + 6] * z,
            M[o + 1] * x + M[o + 4] * y + M[o + 7] * z,
            M[o + 2] * x + M[o + 5] * y + M[o + 8] * z, smp, 0);
          acc[CH_RIDGE] += wq * (smp[CH_RIDGE] - ridgeMean);
          acc[CH_HILL] += wq * smp[CH_HILL];
          acc[CH_COAST] += wq * smp[CH_COAST];
          acc[CH_LITH] += wq * smp[CH_LITH];
          w2 += wq * wq;
        }
        // Variance-preserving blend of independent noise fields across the plate boundary.
        const inv = w2 > 0 ? 1 / Math.sqrt(w2) : 0;
        ridge = acc[CH_RIDGE] * inv + ridgeMean;
        hill = acc[CH_HILL] * inv;
        coast = acc[CH_COAST] * inv;
        li = acc[CH_LITH] * inv;
      }
      // Regional coastline character from lithology: smooth sandy coasts ↔ rugged rias/skerries.
      let rug = (li + 0.15) * (1 / 0.45);
      rug = rug < 0 ? 0 : rug > 1 ? 1 : rug * rug * (3 - 2 * rug);
      let steep = (slope - 3) * (1 / 12);
      steep = steep < 0 ? 0 : steep > 1 ? 1 : steep * steep * (3 - 2 * steep);
      const L = COAST_SHIFT_MIN_KM + (COAST_SHIFT_MAX_KM - COAST_SHIFT_MIN_KM) * (steep > 0.8 * rug ? steep : 0.8 * rug);
      let shift = L * slope;
      if (shift > COAST_MAX_M) shift = COAST_MAX_M;
      const bw = COAST_BAND_M + 0.7 * shift;
      const bb = 1 + (bs * bs) / (bw * bw);
      const ac = (COAST_VERTICAL_M + shift) / (bb * bb);
      const mountain = amount * ar * (ridge - ridgeMean);
      const breakup = ac * (coast * (0.75 + 0.35 * rug) + HILL_IN_COAST * hill * (0.35 + 1.1 * rug));
      height[p] = b + mountain + amount * (breakup + ah * hill);
      rough[p] = mountain;
      patch[p] = hill;
      lith[p] = li;
    }
  }
}
