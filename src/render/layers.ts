/**
 * Tectonic data layers: elevation (hypsometric + hillshade), plates, crust type and ocean crust
 * age (Müller-style, with 20 Myr isochrons). Land vs sea always comes from the height map, with
 * anti-aliased coasts; plate and crust boundaries are smooth contours of Gaussian-voted barycentric
 * memberships (layersCategory), anti-aliased.
 */
import type { PaintOptions, RGB, SphereMesh, WorldSnapshot } from '../core/types';
import * as _types from '../core/types';
import * as _colormaps from './colormaps';
import * as _layersCategory from './layersCategory';
import * as _layersCommon from './layersCommon';
import * as _layersSample from './layersSample';
import type { PaintCache } from './paintCache';
import type { HeightField } from './terrain';

// Imported values are copied into module constants: some module runners (vitest / vite-node SSR)
// compile named imports into namespace property reads, which would otherwise sit in per-pixel loops.
const { CRUST_CONTINENTAL } = _types;
const { CM_AGE, CM_BATHY, CM_HYPSO, SRGB_TO_LINEAR, cmapIndex, encodeSrgb } = _colormaps;
const { getCellCategories, pixelCategories, snapshotMemo } = _layersCategory;
const { applyHillshade, drawContours, paintNeutral, putLut, putMixed } = _layersCommon;
const { COAST_Q, coastDistance, scratchF32 } = _layersSample;

const HALF = COAST_Q / 2;
const L = SRGB_TO_LINEAR;

function smooth(a: number, b: number, x: number): number {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/** Stroke scale for pixel-size-dependent line widths (1 at 2048 px wide). */
function strokeScale(w: number): number {
  return Math.max(0.6, Math.min(1.6, w / 2048));
}

export function paintElevation(hf: HeightField, opts: PaintOptions, cache: PaintCache): Uint8ClampedArray {
  const { w, h, height } = hf;
  const sea = opts.seaLevel;
  const qd = coastDistance(hf, sea);
  const rgba = new Uint8ClampedArray(4 * w * h);
  const hl = CM_HYPSO.lut, bl = CM_BATHY.lut;
  for (let p = 0; p < w * h; p++) {
    const e = height[p] - sea;
    const q = qd[p];
    if (q >= HALF) putLut(rgba, p, hl, 3 * cmapIndex(CM_HYPSO, e));
    else if (q <= -HALF) putLut(rgba, p, bl, 3 * cmapIndex(CM_BATHY, -e));
    // Coast pixels: the two ramps at their sea-level ends, mixed by land coverage.
    else putMixed(rgba, p, hl, 3 * cmapIndex(CM_HYPSO, e > 0 ? e : 0), bl, 3 * cmapIndex(CM_BATHY, e < 0 ? -e : 0), 0.5 + q / COAST_Q);
  }
  if (opts.hillshade) applyHillshade(rgba, hf, sea, 0.8, 0.35, cache);
  return rgba;
}

/** Linear-light RGB accumulator helpers. */
const acc = new Float64Array(3);
function addLin(c: ArrayLike<number>, i: number, wgt: number): void {
  acc[0] += wgt * L[c[i]];
  acc[1] += wgt * L[c[i + 1]];
  acc[2] += wgt * L[c[i + 2]];
}
function writeAcc(rgba: Uint8ClampedArray, p: number, dim: number): void {
  const o = 4 * p;
  rgba[o] = encodeSrgb(acc[0] * dim);
  rgba[o + 1] = encodeSrgb(acc[1] * dim);
  rgba[o + 2] = encodeSrgb(acc[2] * dim);
  rgba[o + 3] = 255;
}

/** Elevation bins of the per-plate land / sea shade tables. */
const SHADE_BINS = 64;
const LAND_TOP = 4000, SEA_BOTTOM = 5000;

/**
 * Per plate (plus a grey slot): sRGB shades on land (lighter with altitude, bins over 0..LAND_TOP)
 * then at sea (darker with depth, bins over 0..SEA_BOTTOM). Layout [plate][land 0 | sea 1][bin][rgb].
 */
function plateShades(colors: Uint8Array, np: number): Uint8Array {
  const t = new Uint8Array((np + 1) * 2 * SHADE_BINS * 3);
  for (let k = 0; k <= np; k++) {
    const r0 = colors[3 * k], g0 = colors[3 * k + 1], b0 = colors[3 * k + 2];
    for (let b = 0; b < SHADE_BINS; b++) {
      const u = b / (SHADE_BINS - 1);
      const tl = 0.22 + 0.18 * smooth(0, 1, u);
      const fs = 0.72 - 0.22 * smooth(0, 1, u);
      const oL = ((k * 2) * SHADE_BINS + b) * 3, oS = ((k * 2 + 1) * SHADE_BINS + b) * 3;
      t[oL] = r0 + (255 - r0) * tl; t[oL + 1] = g0 + (255 - g0) * tl; t[oL + 2] = b0 + (255 - b0) * tl;
      t[oS] = r0 * fs; t[oS + 1] = g0 * fs; t[oS + 2] = b0 * fs;
    }
  }
  return t;
}

/** Offset into plateShades for plate k at elevation e (m relative to sea level) on land or at sea. */
function shadeIndex(k: number, e: number, land: boolean): number {
  let b = land ? (e * (SHADE_BINS - 1)) / LAND_TOP : (-e * (SHADE_BINS - 1)) / SEA_BOTTOM;
  b = b <= 0 ? 0 : b >= SHADE_BINS - 1 ? SHADE_BINS - 1 : (b + 0.5) | 0;
  return ((k * 2 + (land ? 0 : 1)) * SHADE_BINS + b) * 3;
}

export function paintPlates(
  mesh: SphereMesh, snap: WorldSnapshot | null, hf: HeightField, opts: PaintOptions, cache: PaintCache,
): Uint8ClampedArray {
  if (!snap) return paintNeutral(hf, opts.seaLevel);
  const { w, h, height } = hf;
  const map = cache.getGridMap(mesh, w, h);
  const npx = w * h;
  const np = snap.plates.length;
  // With normals: the boundary overlay of the same frame then reuses this resolution as is.
  const pc = pixelCategories(map, getCellCategories(mesh, snap.plate, `plate|${snap.id}`, cache), true);
  const colors = new Uint8Array(3 * (np + 1));
  for (let k = 0; k < np; k++) colors.set(snap.plates[k].color, 3 * k);
  colors.set([128, 128, 128], 3 * np);
  const sea = opts.seaLevel;
  const qd = coastDistance(hf, sea);
  const lineHalf = 0.55 * strokeScale(w);
  const shades = plateShades(colors, np);
  const rgba = new Uint8ClampedArray(4 * npx);
  const { k1: K1, k2: K2, dist } = pc;
  for (let p = 0; p < npx; p++) {
    let k = K1[p];
    if (k < 0 || k >= np) k = np;
    const e = height[p] - sea;
    const q = qd[p];
    const d = dist[p];
    const wPlate = d >= 0.5 || K2[p] < 0 ? 1 : 0.5 + d;
    const aLand = q >= HALF ? 1 : q <= -HALF ? 0 : 0.5 + q / COAST_Q;
    // Thin dark boundary line (box-filtered coverage).
    let cov = lineHalf + 0.5 - d;
    cov = cov <= 0 ? 0 : cov > 1 ? 1 : cov;
    if (wPlate === 1 && cov === 0 && (aLand === 1 || aLand === 0)) {
      // Interior pixel: one plate, one surface.
      putLut(rgba, p, shades, shadeIndex(k, e, aLand === 1));
      continue;
    }
    acc[0] = acc[1] = acc[2] = 0;
    // Plate fill: winner (and runner-up within half a pixel of the boundary), land/sea mixed at coasts.
    let k2 = K2[p];
    if (k2 < 0 || k2 >= np) k2 = np;
    for (let side = 0; side < 2; side++) {
      const wk = side === 0 ? wPlate : 1 - wPlate;
      if (wk <= 0) continue;
      const kk = side === 0 ? k : k2;
      if (aLand > 0) addLin(shades, shadeIndex(kk, e, true), wk * aLand);
      if (aLand < 1) addLin(shades, shadeIndex(kk, e, false), wk * (1 - aLand));
    }
    writeAcc(rgba, p, 1 - 0.55 * cov);
  }
  if (opts.hillshade) applyHillshade(rgba, hf, sea, 0.7, 0.25, cache);
  return rgba;
}

const CONT_LAND: RGB = [196, 164, 112];
const CONT_SEA: RGB = [132, 122, 104];
const OCEANIC: RGB = [62, 96, 142];

/** Crust colour for (continental?, e) as sRGB bytes into out[o..]. */
function crustShade(continental: boolean, e: number, out: Uint8Array, o: number): void {
  if (continental) {
    const c = e > 0 ? CONT_LAND : CONT_SEA;
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
    return;
  }
  const f = e > 0 ? 1.35 : 1 - 0.3 * smooth(0, 6000, -e);
  out[o] = Math.min(255, OCEANIC[0] * f); out[o + 1] = Math.min(255, OCEANIC[1] * f); out[o + 2] = Math.min(255, OCEANIC[2] * f);
}

export function paintCrust(
  mesh: SphereMesh, snap: WorldSnapshot | null, hf: HeightField, opts: PaintOptions, cache: PaintCache,
): Uint8ClampedArray {
  if (!snap) return paintNeutral(hf, opts.seaLevel);
  const { w, h, height } = hf;
  const map = cache.getGridMap(mesh, w, h);
  const npx = w * h;
  const pc = pixelCategories(map, getCellCategories(mesh, snap.crust, `crust|${snap.id}`, cache));
  const sea = opts.seaLevel;
  const qd = coastDistance(hf, sea);
  const rgba = new Uint8ClampedArray(4 * npx);
  const tmp = new Uint8Array(6);
  for (let p = 0; p < npx; p++) {
    const e = height[p] - sea;
    const q = qd[p];
    const d = pc.dist[p];
    const cont = pc.k1[p] === CRUST_CONTINENTAL;
    const wk = d >= 0.5 || pc.k2[p] < 0 ? 1 : 0.5 + d;
    const aLand = q >= HALF ? 1 : q <= -HALF ? 0 : 0.5 + q / COAST_Q;
    if (wk === 1 && (aLand === 1 || aLand === 0)) {
      crustShade(cont, aLand === 1 ? (e > 0 ? e : 1) : e <= 0 ? e : 0, tmp, 0);
      const o = 4 * p;
      rgba[o] = tmp[0]; rgba[o + 1] = tmp[1]; rgba[o + 2] = tmp[2]; rgba[o + 3] = 255;
      continue;
    }
    acc[0] = acc[1] = acc[2] = 0;
    for (let side = 0; side < 2; side++) {
      const ws = side === 0 ? wk : 1 - wk;
      if (ws <= 0) continue;
      const c = side === 0 ? cont : !cont;
      if (aLand > 0) { crustShade(c, e > 0 ? e : 1, tmp, 0); addLin(tmp, 0, ws * aLand); }
      if (aLand < 1) { crustShade(c, e <= 0 ? e : 0, tmp, 3); addLin(tmp, 3, ws * (1 - aLand)); }
    }
    writeAcc(rgba, p, 1);
  }
  if (opts.hillshade) applyHillshade(rgba, hf, sea, 0.7, 0.3, cache);
  return rgba;
}

/** Continental crust greys in the age layer (land / submerged). */
const AGE_CONT_LAND = 176;
const AGE_CONT_SEA = 128;
/** Isochron spacing (Myr). */
export const ISOCHRON_MYR = 20;

/**
 * Display copy of the ocean-crust age: two Laplacian passes (λ = ½) over oceanic neighbours only,
 * which removes the mesh-scale sawtooth of ridges and isochrons, then extended onto continental
 * cells (mean of their oceanic neighbours, else the last pass value) so the per-pixel barycentric
 * interpolation needs no crust test. Memoized per snapshot.
 */
function smoothedOceanAge(mesh: SphereMesh, snap: WorldSnapshot): Float32Array {
  return snapshotMemo(`agesmooth|${mesh.n}|${snap.id}`, () => smoothOceanAge(mesh, snap.crust, snap.age));
}

/**
 * The work of smoothedOceanAge as a plain top-level function over a precomputed oceanic mask (it
 * runs once per playback frame on the crust-age layer; as a closure with per-neighbour crust tests
 * it cost ~3× more).
 */
function smoothOceanAge(mesh: SphereMesh, crust: ArrayLike<number>, age: ArrayLike<number>): Float32Array {
  const { n, adjOffset, adj } = mesh;
  // ocean[i] = 1 on oceanic crust; reused below as the "known" mask of the continental extension.
  const ocean = new Uint8Array(n);
  for (let i = 0; i < n; i++) ocean[i] = crust[i] === CRUST_CONTINENTAL ? 0 : 1;
  let a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = age[i];
  let b = new Float32Array(n);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const ai = a[i];
      if (ocean[i] === 0) { b[i] = ai; continue; }
      let s = 0, m = 0;
      for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e; q++) {
        const j = adj[q];
        if (ocean[j] !== 0) { s += a[j]; m++; }
      }
      b[i] = m > 0 ? 0.5 * ai + (0.5 * s) / m : ai;
    }
    const t = a; a = b; b = t;
  }
  // Extend two rings into the continents (mean of already-known neighbours); deeper cells are
  // never interpolated into sea-floor pixels and get 0.
  const known = ocean;
  const added = new Int32Array(n);
  for (let ring = 0; ring < 2; ring++) {
    let na = 0;
    for (let i = 0; i < n; i++) {
      if (known[i] !== 0) continue;
      let s = 0, m = 0;
      for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e; q++) {
        const j = adj[q];
        if (known[j] !== 0) { s += a[j]; m++; }
      }
      if (m > 0) { b[i] = s / m; added[na++] = i; }
    }
    for (let k = 0; k < na; k++) { const i = added[k]; a[i] = b[i]; known[i] = 1; }
  }
  for (let i = 0; i < n; i++) if (known[i] === 0) a[i] = 0;
  return a;
}

export function paintCrustAge(
  mesh: SphereMesh, snap: WorldSnapshot | null, hf: HeightField, opts: PaintOptions, cache: PaintCache,
): Uint8ClampedArray {
  if (!snap) return paintNeutral(hf, opts.seaLevel);
  const { w, h, height } = hf;
  const map = cache.getGridMap(mesh, w, h);
  const npx = w * h;
  const pc = pixelCategories(map, getCellCategories(mesh, snap.crust, `crust|${snap.id}`, cache));
  const { tri, bary } = map;
  const age = smoothedOceanAge(mesh, snap);
  const sea = opts.seaLevel;
  const qd = coastDistance(hf, sea);
  const lut = CM_AGE.lut;
  const ageF = scratchF32(0, npx);
  const rgba = new Uint8ClampedArray(4 * npx);
  const grey = new Uint8Array(6);
  grey.fill(AGE_CONT_LAND, 0, 3);
  grey.fill(AGE_CONT_SEA, 3, 6);
  for (let p = 0; p < npx; p++) {
    const d = pc.dist[p];
    const cont = pc.k1[p] === CRUST_CONTINENTAL;
    const wk = d >= 0.5 || pc.k2[p] < 0 ? 1 : 0.5 + d;
    const q = qd[p];
    const aLand = q >= HALF ? 1 : q <= -HALF ? 0 : 0.5 + q / COAST_Q;
    const wCont = cont ? wk : 1 - wk;
    if (wCont === 1 && (aLand === 1 || aLand === 0)) {
      // Continental interior: no age needed (isochrons stay clear of the crust boundary; −10 is
      // far from every level, so the contour pass skips these pixels cheaply).
      ageF[p] = -10;
      putLut(rgba, p, grey, aLand === 1 ? 0 : 3);
      continue;
    }
    // Age interpolated barycentrically; continental vertices carry the ocean-extended age
    // (their own ages are unrelated to the sea floor).
    const k = 3 * p;
    const a = bary[k] * age[tri[k]] + bary[k + 1] * age[tri[k + 1]] + bary[k + 2] * age[tri[k + 2]];
    ageF[p] = a;
    if (wCont === 0) { putLut(rgba, p, lut, 3 * cmapIndex(CM_AGE, a)); continue; }
    acc[0] = acc[1] = acc[2] = 0;
    addLin(grey, 0, wCont * aLand);
    addLin(grey, 3, wCont * (1 - aLand));
    if (wCont < 1) addLin(lut, 3 * cmapIndex(CM_AGE, a), 1 - wCont);
    writeAcc(rgba, p, 1);
  }
  if (opts.hillshade) applyHillshade(rgba, hf, sea, 0.6, 0.3, cache);
  // Isochrons are a full-quality refinement (playback previews keep to the colour ramp).
  if (opts.quality !== 'preview') {
    const k1 = pc.k1, dist = pc.dist;
    drawContours(rgba, ageF, w, h, ISOCHRON_MYR, [24, 20, 36], 0.3, 0.8 * strokeScale(w), {
      maxDelta: 2.5,
      mask: (p) => k1[p] !== CRUST_CONTINENTAL && dist[p] > 1.5 && ageF[p] > ISOCHRON_MYR / 2,
    });
  }
  return rgba;
}
