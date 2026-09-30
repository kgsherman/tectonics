/**
 * Display height map: smoothed mesh elevation + procedural detail sampled in each plate's material
 * frame (SPEC §7). Layer-independent; cached per (mesh.n, snapshot.id, size, seed, detail, quality,
 * sea level).
 */
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
const { meshToGrid } = _grid;
const { quatToMat3 } = _math3;
const { CRUST_CONTINENTAL } = _types;
const { rasterGeometry } = _paintGeometry;
const { blurMetric, scratchFloat32, scratchUint8 } = _terrainBase;
const {
  CH_COAST, CH_HILL, CH_LITH, CH_RIDGE, DETAIL_CHANNELS, EQ_K, buildDetailTexture,
  detailResolution, sampleDetail,
} = _terrainDetail;

/** Elevation used when there is no snapshot (neutral open ocean). */
export const NEUTRAL_OCEAN_DEPTH = -3000;
/** Base-blur σ as a fraction of the mesh spacing. */
const BASE_SIGMA_SPACINGS = 0.6;
/**
 * Half-resolution base smoothing needs at least this σ in (full-resolution) pixels: its prefilter
 * and upsampling alone smooth by ≈ 1 px.
 */
const HALF_RES_MIN_SIGMA_PX = 0.9;
/**
 * Preview only: sea pixels at least this far below the display sea level whose coast distance puts
 * them out of reach of the coastline noise keep the smooth sea floor (skipping the texture lookups).
 * Coastlines are therefore identical to 'full' at every sea level.
 */
const PREVIEW_DEEP_SKIP_M = -1500;

/**
 * Coastline (SPEC §7, "land iff height > sea level"). The coast position is decided per mesh cell,
 * not by the smoothed elevation: along each land–sea edge the coast crosses where the compressed
 * indicator T(x) = x / (|x| + COAST_T_M), x = e − sea, changes sign — near the cell boundary
 * whatever the magnitudes (+50 m plains next to −4000 m abysses no longer drown, shelves next to
 * high ground no longer surface; the simulated land area is preserved). A signed distance to that
 * coast (mesh spacings, ring-limited BFS) is interpolated barycentrically, and the drawn coastline is
 * its zero contour after adding bounded, plate-anchored fractal noise (whiter fbm; inverted ridges
 * give fjords and rias on mountainous coasts): organic at every scale, yet never more than a couple
 * of spacings from the simulated coast and never an island in the open sea.
 * The displayed elevation keeps its magnitude from the smoothed base, forced onto the coastline's
 * side, and all vertical detail (hills, ridges) goes through a C¹ sign-preserving compression toward
 * a coastal floor, so it never floods low plains or raises islands on shelves.
 */
const COAST_T_M = 30;
/** Coast distance field range (mesh spacings); beyond it the coast cannot reach. */
const COAST_DMAX = 3.5;
/** Distance bias (spacings): dilates land slightly (thin peninsulas and islands survive the triangulation). */
const COAST_BIAS = 0.1;
/** Coastline noise amplitude (spacings) for smooth and rugged coasts. */
const COAST_A_SMOOTH = 0.5;
const COAST_A_RUGGED = 3.5;
/** Weights of the coastline (whiter fine fbm) and hill noise channels in the coast displacement. */
const COAST_W_COAST = 1.0;
const COAST_W_HILL = 0.3;
/** Fjords / rias: inverted ridged noise (narrow inlets along valley lines) on mountainous coasts. */
const COAST_W_FJORD = 2;
/** Soft limit of the coastline displacement (spacings), well inside COAST_DMAX. */
const COAST_NMAX = 2.2;
/** Coastal floor (m): land at least this high, sea floors at least this deep, ≥ 2 px from the coast. */
const COAST_RAMP_M = 36;
/** Floor fractions for pixels 4-adjacent / diagonal-adjacent to the other side of the coastline. */
const RAMP_ORTHO = 1 / 3;
const RAMP_DIAG = 0.6;
/** Within 2 px of the coastline |height − sea| ≤ NEAR_SHORE_CAP × floor. */
const NEAR_SHORE_CAP = 2.5;
/** Pixels ≥ 2 px from the coast only get a slope floor when their base is this close to sea level. */
const SLOPE_FLOOR_CHECK_M = 600;
const COAST_EPS_M = 0.5;
/** Height above the coastal floor (m) at which half of the vertical detail is kept. */
const RELIEF_BASE_M = 120;
/** Fraction of the vertical detail kept below the coastline (before the depth damping). */
const SEA_DETAIL = 0.35;

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
  /**
   * A second plate-frame texture noise, independent of `patch`: CH_HILL of the detail texture at a
   * fixed rotation of the material-frame direction, (x, y, z) → (y, z, x), as 2.5·hill ×127 (the
   * climate sampler's `fine` encoding; its `tex` is 0.99-correlated, ≈ 0.91× this). Land colour
   * mosaics use it rather than the sampler's world-frame noises, which stay put while the plates
   * move (the forest / snow patches would crawl over the land during playback). 0 on sea pixels
   * that no coastline noise can reach.
   */
  pfine: Int8Array;
}

/** Per-mesh-cell fields derived from a snapshot (display copies; never written back). */
interface MeshTerrain {
  /** Laplacian-smoothed elevation (m). */
  elev: Float32Array;
  /** Interleaved [ridge amplitude, hill amplitude] per cell (m). */
  amp: Float32Array;
  /** Signed coast distance (mesh spacings, + land), see coastDistance(). */
  coast: Float32Array;
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
function buildMeshTerrain(mesh: SphereMesh, s: WorldSnapshot, sea: number, elen: Float32Array): MeshTerrain {
  const { n, adjOffset, adj } = mesh;
  const src = s.elev;
  const elev = new Float32Array(n);
  const raw = new Float32Array(2 * n);
  const coast = new Float32Array(n);
  const queue = new Int32Array(n);
  const oroA = s.orogeny, ageA = s.age, crustA = s.crust;
  let qn = 0;
  for (let i = 0; i < n; i++) {
    const e = src[i];
    const a0 = adjOffset[i], a1 = adjOffset[i + 1];
    let sum = 0, rel = 0;
    // Coast seeds: distance (spacings) along each land–sea edge to where the compressed indicator
    // T(x) = x / (|x| + COAST_T_M) changes sign.
    const xi = e - sea, landI = xi > 0;
    let best = COAST_DMAX;
    for (let k = a0; k < a1; k++) {
      const v = src[adj[k]];
      sum += v;
      rel += (v - e) * (v - e);
      const xj = v - sea;
      if ((xj > 0) !== landI) {
        const ti = xi / ((xi < 0 ? -xi : xi) + COAST_T_M), tj = xj / ((xj < 0 ? -xj : xj) + COAST_T_M);
        const cand = (ti / (ti - tj)) * elen[k];
        if (cand < best) best = cand;
      }
    }
    coast[i] = best;
    if (best < COAST_DMAX) queue[qn++] = i;
    const deg = a1 - a0;
    const inv = deg > 0 ? 1 / deg : 0;
    elev[i] = deg > 0 ? 0.5 * (e + sum * inv) : e;
    const relief = Math.sqrt(rel * inv);
    const oro = oroA[i] > 0 ? oroA[i] : 0;
    const age = ageA[i] > 0 ? ageA[i] : 0;
    // Land / continental relief: recent orogeny, high elevation and steep mesh-scale relief.
    let m = oro / (1100 + oro);
    let te = (e - 400) * (1 / 3400);
    te = te < 0 ? 0 : te > 1 ? 1 : te * te * (3 - 2 * te);
    if (0.85 * te > m) m = 0.85 * te;
    const mRel = (0.7 * relief) / (900 + relief);
    if (mRel > m) m = mRel;
    const landR = 3000 * m + 160;
    let th = (e - 200) * (1 / 1800);
    th = th < 0 ? 0 : th > 1 ? 1 : th * th * (3 - 2 * th);
    const landH = 35 + 0.07 * landR + 90 * th;
    // Ocean floor: rough young ridge flanks, abyssal hills smoothed by sediment with age.
    const oceanR = 650 / (1 + age * 0.1) + (120 * relief) / (700 + relief) + 60;
    const oceanH = 170 / (1 + age * (1 / 70)) + 70;
    // Continental crust or anything near/above sea level behaves like land.
    let t = 1;
    if (crustA[i] !== CRUST_CONTINENTAL) {
      t = (e + 2500) * (1 / 2200);
      t = t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t);
    }
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
  coastDistance(mesh, src, sea, elen, coast, queue, qn);
  return { elev, amp, coast };
}

export function detailTexture(seed: number, w: number, cache: PaintCache): DetailTexture {
  const n = detailResolution(w);
  const s = Math.floor(seed) | 0;
  return cache.getOrBuild(`detail|${s}|${n}`, () => buildDetailTexture(s, n));
}

function meshTerrain(mesh: SphereMesh, s: WorldSnapshot, sea: number, cache: PaintCache): MeshTerrain {
  return cache.getOrBuild(`meshterrain|${mesh.n}|${s.id}|${sea}`, () => buildMeshTerrain(mesh, s, sea, edgeLengths(mesh, cache)));
}

/**
 * Per mesh cell SIGNED DISTANCE to the coast, in mesh spacings (+ land, − sea), clamped to
 * ±COAST_DMAX, completed in place from the seeds (cells with a neighbour across the coast, distance
 * to the crossing along that edge): distances grow ring by ring (BFS over coastal cells only, edge
 * lengths from the lattice). Barycentric interpolation of this field reproduces the crossing points
 * exactly and, unlike a saturating indicator, keeps growing away from the coast, so noise can move
 * the coastline by a controlled number of spacings without ever raising islands in the open sea.
 */
function coastDistance(
  mesh: SphereMesh, e: Float32Array, sea: number, elen: Float32Array, d: Float32Array, queue: Int32Array, qn: number,
): void {
  const { n, adjOffset, adj } = mesh;
  let head = 0;
  while (head < qn) {
    const i = queue[head++];
    const land = e[i] > sea;
    const di = d[i];
    for (let k = adjOffset[i], a1 = adjOffset[i + 1]; k < a1; k++) {
      const j = adj[k];
      if ((e[j] > sea) !== land) continue;
      const cand = di + elen[k];
      const dj = d[j];
      if (cand < dj) {
        d[j] = cand;
        // First reach (still at the initial COAST_DMAX): enqueue.
        if (dj === COAST_DMAX) queue[qn++] = j;
      }
    }
  }
  for (let i = 0; i < n; i++) if (!(e[i] - sea > 0)) d[i] = -d[i];
}

/** Per adjacency entry: chord length of the edge in mesh spacings (static per mesh). */
function edgeLengths(mesh: SphereMesh, cache: PaintCache): Float32Array {
  return cache.getOrBuild(`edgelen|${mesh.n}`, () => {
    const { n, adjOffset, adj, xyz } = mesh;
    const out = new Float32Array(adj.length);
    const inv = 1 / mesh.spacing;
    for (let i = 0; i < n; i++) {
      for (let k = adjOffset[i]; k < adjOffset[i + 1]; k++) {
        const j = adj[k];
        const dx = xyz[3 * i] - xyz[3 * j], dy = xyz[3 * i + 1] - xyz[3 * j + 1], dz = xyz[3 * i + 2] - xyz[3 * j + 2];
        out[k] = Math.sqrt(dx * dx + dy * dy + dz * dz) * inv;
      }
    }
    return out;
  });
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
  const pfine = new Int8Array(npx);
  if (!s) {
    height.fill(NEUTRAL_OCEAN_DEPTH);
    return { w, h, height, patch, lith, rough, pfine };
  }
  if (s.n !== mesh.n) throw new Error(`paint: snapshot.n (${s.n}) ≠ mesh.n (${mesh.n})`);
  const map = cache.getGridMap(mesh, w, h);
  const mt = meshTerrain(mesh, s, opts.seaLevel, cache);
  const tex = detailTexture(opts.seed, w, cache);
  // Scratch slot 0: the interpolated/blurred base is only needed while composing.
  const base = smoothBase(map, mt.elev, BASE_SIGMA_SPACINGS * mesh.spacing, scratchFloat32(0, npx));
  const sea = opts.seaLevel;
  const skipBelow = qualityOf(opts) === 'preview' ? sea + PREVIEW_DEEP_SKIP_M : -Infinity;
  const out: HeightField = { w, h, height, patch, lith, rough, pfine };
  composeDetail(map, s, mt, mt.coast, tex, base, detailAmount(opts), sea, skipBelow, mesh.spacing, cache, out);
  return out;
}

/**
 * Smooth display base: barycentric mesh elevation blurred by a metric Gaussian of σ (rad). When σ
 * is at least ~1 px the work is done at half resolution — 4× cheaper blur: each half-resolution
 * sample is the 2×2 box mean of the grid map's barycentric values (an anti-alias prefilter: point
 * samples every other pixel alias the mesh-scale facets into a 2-px stipple on steep slopes), then
 * the blur, then a bilinear 2× upsample (¾/¼ taps, centred). Box + upsample add a variance of
 * ≈ 1 px² per axis, which the half-resolution Gaussian leaves out (σ_h² = σ² − 1 px²).
 */
function smoothBase(map: MeshGridMap, field: Float32Array, sigmaRad: number, out: Float32Array): Float32Array {
  const { w, h, tri, bary } = map;
  const px = Math.PI / h;
  if ((w & 1) !== 0 || (h & 1) !== 0 || w < 64 || sigmaRad < HALF_RES_MIN_SIGMA_PX * px) {
    meshToGrid(map, field, out);
    blurMetric(out, w, h, sigmaRad);
    return out;
  }
  const w2 = w >> 1, h2 = h >> 1;
  const half = scratchFloat32(3, w2 * h2);
  for (let r2 = 0; r2 < h2; r2++) {
    const src = 2 * r2 * w, dst = r2 * w2;
    for (let c2 = 0; c2 < w2; c2++) {
      const k0 = 3 * (src + 2 * c2), k1 = k0 + 3, k2 = k0 + 3 * w, k3 = k2 + 3;
      half[dst + c2] = 0.25 * (
        bary[k0] * field[tri[k0]] + bary[k0 + 1] * field[tri[k0 + 1]] + bary[k0 + 2] * field[tri[k0 + 2]] +
        bary[k1] * field[tri[k1]] + bary[k1 + 1] * field[tri[k1 + 1]] + bary[k1 + 2] * field[tri[k1 + 2]] +
        bary[k2] * field[tri[k2]] + bary[k2 + 1] * field[tri[k2 + 1]] + bary[k2 + 2] * field[tri[k2 + 2]] +
        bary[k3] * field[tri[k3]] + bary[k3 + 1] * field[tri[k3 + 1]] + bary[k3 + 2] * field[tri[k3 + 2]]);
    }
  }
  const s2 = sigmaRad * sigmaRad - px * px;
  if (s2 > 0) blurMetric(half, w2, h2, Math.sqrt(s2));
  // Bilinear 2× upsample: half-res sample r2 sits between full rows 2·r2 and 2·r2 + 1.
  const v = new Float64Array(w2);
  for (let r = 0; r < h; r++) {
    const r2 = r >> 1;
    const rb = (r & 1) === 0 ? (r2 > 0 ? r2 - 1 : 0) : r2 + 1 < h2 ? r2 + 1 : h2 - 1;
    const oa = r2 * w2, ob = rb * w2;
    for (let c2 = 0; c2 < w2; c2++) v[c2] = 0.75 * half[oa + c2] + 0.25 * half[ob + c2];
    const row = r * w;
    for (let c2 = 0; c2 < w2; c2++) {
      const vc = 0.75 * v[c2];
      out[row + 2 * c2] = vc + 0.25 * v[c2 > 0 ? c2 - 1 : w2 - 1];
      out[row + 2 * c2 + 1] = vc + 0.25 * v[c2 + 1 < w2 ? c2 + 1 : 0];
    }
  }
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
  map: MeshGridMap, s: WorldSnapshot, mt: MeshTerrain, coastS: Float32Array, tex: DetailTexture, base: Float32Array,
  amount: number, sea: number, skipBelow: number, spacing: number, cache: PaintCache, out: HeightField,
): void {
  const { height, patch, lith, rough, pfine } = out;
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
  const td = tex.data, tn = tex.n, tStride = tex.stride, thn = 0.5 * tex.n;
  const ridgeMean = tex.ridgeMean;
  const aSmooth = amount * COAST_A_SMOOTH, aRange = amount * (COAST_A_RUGGED - COAST_A_SMOOTH);
  // The soft-clamped coastline displacement never exceeds COAST_NMAX: pixels whose coast distance
  // stays below −coastBound are sea whatever the detail.
  const coastBound = COAST_NMAX;
  // Pixels with |coast distance| ≥ farSi: the noise cannot flip them or any pixel of their 3×3
  // neighbourhood (the distance field changes by ≤ ~1 per spacing; a pixel is pxSp spacings).
  const pxSp = Math.PI / h / spacing;
  const farSi = COAST_NMAX + Math.max(0.9, 1.6 * pxSp);
  const npx = w * h;
  const side = scratchUint8(0, npx);
  side.fill(0);
  const dBuf = scratchFloat32(2, npx);
  let curPlate = -1, m0 = 0, m1 = 0, m2 = 0, m3 = 0, m4 = 0, m5 = 0, m6 = 0, m7 = 0, m8 = 0;
  for (let r = 0; r < h; r++) {
    const cl = cosLat[r], sl = sinLat[r];
    const row = r * w;
    for (let c = 0; c < w; c++) {
      const p = row + c;
      const b = base[p];
      const k3 = 3 * p;
      const va = tri[k3], vb = tri[k3 + 1], vc = tri[k3 + 2];
      const wa = bary[k3], wb = bary[k3 + 1], wc = bary[k3 + 2];
      // Signed coast distance (+ bias), in spacings: the coastline is its zero contour after the
      // (bounded) noise displacement is added.
      const si = wa * coastS[va] + wb * coastS[vb] + wc * coastS[vc] + COAST_BIAS;
      if (b < skipBelow && si + coastBound < 0) {
        // Preview: deep sea that no detail can turn into land keeps the smooth sea floor.
        height[p] = b;
        dBuf[p] = NaN; // final already: pass 2 skips it
        continue;
      }
      const ar = wa * amp[2 * va] + wb * amp[2 * vb] + wc * amp[2 * vc];
      const ah = wa * amp[2 * va + 1] + wb * amp[2 * vb + 1] + wc * amp[2 * vc + 1];
      const pa = slot[va], pb = slot[vb], pc = slot[vc];
      const x = cl * cosLon[c], y = cl * sinLon[c], z = sl;
      let ridge: number, hill: number, coast: number, li: number;
      // Second, colour-only noise (HeightField.pfine), fetched for land pixels only: single-plate
      // pixels note its texel block (rq ≥ 0) and bilinear weights here and load it once the pixel
      // is known to be land; boundary pixels blend it right away (hill2) where land is possible.
      let hill2 = 0, rq = -1, gu = 0, gv = 0;
      const maybeLand = si > -farSi;
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
        if (maybeLand) {
          // The second noise samples the rotated direction (my, mz, mx): the same equi-angular
          // coordinates on another face (x-faces → z-faces as is; y-, z-faces → x-, y-faces with u
          // and v swapped).
          if (face < 2) {
            rq = (((face + 4) * tStride + j0) * tStride + i0) << 2;
            gu = fu;
            gv = fv;
          } else {
            rq = (((face - 2) * tStride + i0) * tStride + j0) << 2;
            gu = fv;
            gv = fu;
          }
        }
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
        let w2 = 0, h2s = 0;
        for (let q = 0; q < m; q++) {
          const o = 9 * ks[q], wq = ws[q];
          const mx = M[o] * x + M[o + 3] * y + M[o + 6] * z;
          const my = M[o + 1] * x + M[o + 4] * y + M[o + 7] * z;
          const mz = M[o + 2] * x + M[o + 5] * y + M[o + 8] * z;
          sampleDetail(tex, mx, my, mz, smp, 0);
          acc[CH_RIDGE] += wq * (smp[CH_RIDGE] - ridgeMean);
          acc[CH_HILL] += wq * smp[CH_HILL];
          acc[CH_COAST] += wq * smp[CH_COAST];
          acc[CH_LITH] += wq * smp[CH_LITH];
          if (maybeLand) {
            sampleDetail(tex, my, mz, mx, smp, 0);
            h2s += wq * smp[CH_HILL];
          }
          w2 += wq * wq;
        }
        // Variance-preserving blend of independent noise fields across the plate boundary.
        const inv = w2 > 0 ? 1 / Math.sqrt(w2) : 0;
        ridge = acc[CH_RIDGE] * inv + ridgeMean;
        hill = acc[CH_HILL] * inv;
        coast = acc[CH_COAST] * inv;
        li = acc[CH_LITH] * inv;
        hill2 = h2s * inv;
      }
      const mountain = amount * ar * (ridge - ridgeMean);
      const dd = mountain + amount * ah * hill;
      rough[p] = mountain;
      patch[p] = hill;
      lith[p] = li;
      let hb = b - sea;
      if (si >= farSi || si <= -farSi) {
        // Far from any coastline (the noise cannot reach it, nor its 3×3 neighbourhood): the
        // pass-2 treatment with a full floor, done right away.
        let u: number, d: number, f: number;
        if (si > 0) {
          side[p] = 1;
          if (rq >= 0) {
            const rs = rq + (tStride << 2);
            hill2 = (1 - gv) * ((1 - gu) * td[rq + 1] + gu * td[rq + 5]) + gv * ((1 - gu) * td[rs + 1] + gu * td[rs + 5]);
          }
          const t2 = (2.5 * 127) * hill2;
          pfine[p] = t2 > 127 ? 127 : t2 < -127 ? -127 : t2;
          f = COAST_RAMP_M;
          u = hb - f;
          if (u < COAST_EPS_M) u = COAST_EPS_M;
          d = (dd * u) / (u + RELIEF_BASE_M);
        } else {
          f = -COAST_RAMP_M;
          u = hb - f;
          if (u > -COAST_EPS_M) u = -COAST_EPS_M;
          d = (SEA_DETAIL * dd * u) / (u - RELIEF_BASE_M);
        }
        height[p] = sea + f + ((u > 0) === (d < 0) ? (u * u) / (u - d) : u + d);
        dBuf[p] = NaN;
        continue;
      }
      // Coast character: rugged (rias, skerries) on rugged lithology and along mountain belts,
      // smoother on sedimentary plains.
      let rug = (li + 0.15) * (1 / 0.45);
      rug = rug < 0 ? 0 : rug > 1 ? 1 : rug * rug * (3 - 2 * rug);
      let rm = (ar - 500) * (1 / 1500);
      rm = rm < 0 ? 0 : rm > 1 ? 1 : rm * rm * (3 - 2 * rm);
      if (rm > rug) rug = rm;
      let dn = (aSmooth + aRange * rug) * (COAST_W_COAST * coast + COAST_W_HILL * hill - COAST_W_FJORD * rm * (ridge - ridgeMean));
      dn = dn / (1 + (dn < 0 ? -dn : dn) * (1 / COAST_NMAX));
      const sp = si + dn;
      // Coastal band, pass 1: the side of the coastline and the base relative to the display sea
      // level forced onto it; the vertical detail is applied in pass 2.
      if (sp >= 0) {
        side[p] = 1;
        if (hb < COAST_EPS_M) hb = COAST_EPS_M;
        if (rq >= 0) {
          const rs = rq + (tStride << 2);
          hill2 = (1 - gv) * ((1 - gu) * td[rq + 1] + gu * td[rq + 5]) + gv * ((1 - gu) * td[rs + 1] + gu * td[rs + 5]);
        }
        const t2 = (2.5 * 127) * hill2;
        pfine[p] = t2 > 127 ? 127 : t2 < -127 ? -127 : t2;
      } else if (hb > -COAST_EPS_M) hb = -COAST_EPS_M;
      height[p] = hb;
      dBuf[p] = dd;
    }
  }
  // Pass 2: coastal floor from the pixel's 3×3 neighbourhood (land at least COAST_RAMP_M·(⅓, 0.6,
  // 1) for pixels 1, √2, ≥ 2 px from the other side, sea floors at least as deep), so heights grow
  // ~linearly with the distance to the drawn coastline (clean contour tracing, no noisy near-zero
  // heights). Vertical detail is damped toward base level (coastal plains are flat, shelves are
  // sediment-smoothed) and applied relative to the floor, compressed as u²/(u − d) (C¹ at d = 0,
  // never reaching the floor) when it points toward the sea level: hills never flood lowlands and
  // sea-floor relief never surfaces.
  for (let r = 0; r < h; r++) {
    const row = r * w;
    const rowN = (r > 0 ? r - 1 : 0) * w, rowS = (r < h - 1 ? r + 1 : h - 1) * w;
    for (let c = 0; c < w; c++) {
      const p = row + c;
      let d = dBuf[p];
      if (d !== d) continue; // already final (far from the coast, or preview deep sea)
      const land = side[p];
      const cw = c > 0 ? c - 1 : w - 1, ce = c + 1 < w ? c + 1 : 0;
      let ramp = 1, dist = 2;
      if (side[row + cw] !== land || side[row + ce] !== land || side[rowN + c] !== land || side[rowS + c] !== land) {
        ramp = RAMP_ORTHO;
        dist = 1;
      } else if (side[rowN + cw] !== land || side[rowN + ce] !== land || side[rowS + cw] !== land || side[rowS + ce] !== land) {
        ramp = RAMP_DIAG;
        dist = 1.4142135623730951;
      }
      // Steep coasts: the floor follows the natural slope (m/px) of the smooth base down to the
      // drawn coastline, so heights keep growing ~linearly with the distance from it.
      let fl = COAST_RAMP_M * ramp;
      const hb = height[p];
      if (ramp < 1 || (hb < 0 ? -hb : hb) < SLOPE_FLOOR_CHECK_M) {
        const gx = base[row + ce] - base[row + cw], gy = base[rowN + c] - base[rowS + c];
        const slopeFloor = 0.5 * Math.sqrt(gx * gx + gy * gy) * (dist - 0.5);
        if (slopeFloor > fl) fl = slopeFloor;
      }
      let u: number, f: number;
      if (land) {
        f = fl;
        u = hb - f;
        if (u < COAST_EPS_M) u = COAST_EPS_M;
        d *= u / (u + RELIEF_BASE_M);
      } else {
        f = -fl;
        u = hb - f;
        if (u > -COAST_EPS_M) u = -COAST_EPS_M;
        d *= (SEA_DETAIL * u) / (u - RELIEF_BASE_M);
      }
      let e = f + ((u > 0) === (d < 0) ? (u * u) / (u - d) : u + d);
      if (ramp < 1) {
        // Next to the coastline the profile is symmetric: no cliffs of natural height or depth
        // right at the shore (shallow near-shore water, low shores), heights ~ distance.
        const cap = NEAR_SHORE_CAP * fl;
        if (e > cap) e = cap;
        else if (e < -cap) e = -cap;
      }
      height[p] = sea + e;
    }
  }
}
