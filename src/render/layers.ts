/**
 * Tectonic data layers: elevation (hypsometric + hillshade), plates, crust type and ocean crust
 * age. Land vs sea always comes from the height map.
 */
import type { PaintOptions, RGB, SphereMesh, WorldSnapshot } from '../core/types';
import * as _types from '../core/types';
import * as _colormaps from './colormaps';
import * as _layersCommon from './layersCommon';
import type { PaintCache } from './paintCache';
import type { HeightField } from './terrain';

// Imported values are copied into module constants: some module runners (vitest / vite-node SSR)
// compile named imports into namespace property reads, which would otherwise sit in per-pixel loops.
const { CRUST_CONTINENTAL } = _types;
const { CM_AGE, CM_BATHY, CM_HYPSO, cmapIndex } = _colormaps;
const { applyHillshade, oneHotCategory, paintNeutral, putLut } = _layersCommon;

function smooth(a: number, b: number, x: number): number {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

export function paintElevation(hf: HeightField, opts: PaintOptions, cache: PaintCache): Uint8ClampedArray {
  const { w, h, height } = hf;
  const sea = opts.seaLevel;
  const rgba = new Uint8ClampedArray(4 * w * h);
  const hl = CM_HYPSO.lut, bl = CM_BATHY.lut;
  for (let p = 0; p < w * h; p++) {
    const e = height[p] - sea;
    if (e > 0) putLut(rgba, p, hl, 3 * cmapIndex(CM_HYPSO, e));
    else putLut(rgba, p, bl, 3 * cmapIndex(CM_BATHY, -e));
  }
  if (opts.hillshade) applyHillshade(rgba, hf, sea, 0.8, 0.35, cache);
  return rgba;
}

/** Plate-boundary line width in barycentric-margin units for this raster (≈ 1 px). */
function edgeWidth(mesh: SphereMesh, w: number): number {
  const spacingPx = (mesh.spacing * w) / (2 * Math.PI);
  return Math.min(0.9, 1.6 / Math.max(0.5, spacingPx));
}

export function paintPlates(
  mesh: SphereMesh, snap: WorldSnapshot | null, hf: HeightField, opts: PaintOptions, cache: PaintCache,
): Uint8ClampedArray {
  if (!snap) return paintNeutral(hf, opts.seaLevel);
  const { w, h, height } = hf;
  const map = cache.getGridMap(mesh, w, h);
  const npx = w * h;
  const cat = new Int32Array(npx);
  const margin = new Float32Array(npx);
  oneHotCategory(map, mesh, snap.plate, cat, margin);
  const np = snap.plates.length;
  const colors = new Uint8Array(3 * (np + 1));
  for (let k = 0; k < np; k++) colors.set(snap.plates[k].color, 3 * k);
  colors.set([128, 128, 128], 3 * np);
  const ew = edgeWidth(mesh, w);
  const sea = opts.seaLevel;
  const rgba = new Uint8ClampedArray(4 * npx);
  for (let p = 0; p < npx; p++) {
    let k = cat[p];
    if (k < 0 || k >= np) k = np;
    const e = height[p] - sea;
    let r = colors[3 * k], g = colors[3 * k + 1], b = colors[3 * k + 2];
    if (e > 0) {
      // Land: lighter, slightly brighter with altitude.
      const t = 0.22 + 0.18 * smooth(0, 4000, e);
      r += (255 - r) * t; g += (255 - g) * t; b += (255 - b) * t;
    } else {
      const f = 0.72 - 0.22 * smooth(0, 5000, -e);
      r *= f; g *= f; b *= f;
    }
    const edge = 1 - 0.6 * (1 - smooth(0, ew, margin[p]));
    const o = 4 * p;
    rgba[o] = r * edge;
    rgba[o + 1] = g * edge;
    rgba[o + 2] = b * edge;
    rgba[o + 3] = 255;
  }
  if (opts.hillshade) applyHillshade(rgba, hf, sea, 0.7, 0.25, cache);
  return rgba;
}

const CONT_LAND: RGB = [196, 164, 112];
const CONT_SEA: RGB = [132, 122, 104];
const OCEANIC: RGB = [62, 96, 142];

export function paintCrust(
  mesh: SphereMesh, snap: WorldSnapshot | null, hf: HeightField, opts: PaintOptions, cache: PaintCache,
): Uint8ClampedArray {
  if (!snap) return paintNeutral(hf, opts.seaLevel);
  const { w, h, height } = hf;
  const map = cache.getGridMap(mesh, w, h);
  const npx = w * h;
  const cat = new Int32Array(npx);
  oneHotCategory(map, mesh, snap.crust, cat);
  const sea = opts.seaLevel;
  const rgba = new Uint8ClampedArray(4 * npx);
  for (let p = 0; p < npx; p++) {
    const e = height[p] - sea;
    let c: RGB;
    let f = 1;
    if (cat[p] === CRUST_CONTINENTAL) c = e > 0 ? CONT_LAND : CONT_SEA;
    else {
      c = OCEANIC;
      f = e > 0 ? 1.35 : 1 - 0.3 * smooth(0, 6000, -e);
    }
    const o = 4 * p;
    rgba[o] = c[0] * f;
    rgba[o + 1] = c[1] * f;
    rgba[o + 2] = c[2] * f;
    rgba[o + 3] = 255;
  }
  if (opts.hillshade) applyHillshade(rgba, hf, sea, 0.7, 0.3, cache);
  return rgba;
}

export function paintCrustAge(
  mesh: SphereMesh, snap: WorldSnapshot | null, hf: HeightField, opts: PaintOptions, cache: PaintCache,
): Uint8ClampedArray {
  if (!snap) return paintNeutral(hf, opts.seaLevel);
  const { w, h, height } = hf;
  const map = cache.getGridMap(mesh, w, h);
  const npx = w * h;
  const cat = new Int32Array(npx);
  oneHotCategory(map, mesh, snap.crust, cat);
  const { tri, bary } = map;
  const { age, crust } = snap;
  const sea = opts.seaLevel;
  const lut = CM_AGE.lut;
  const rgba = new Uint8ClampedArray(4 * npx);
  for (let p = 0; p < npx; p++) {
    const o = 4 * p;
    if (cat[p] === CRUST_CONTINENTAL) {
      // Continental crust: neutral greys (Müller-style maps show ocean floor only).
      const g = height[p] > sea ? 178 : 128;
      rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = 255;
      continue;
    }
    // Age interpolated over the oceanic vertices only (continental ages are unrelated).
    const k = 3 * p;
    let s = 0, ws = 0;
    for (let q = 0; q < 3; q++) {
      const v = tri[k + q];
      if (crust[v] !== CRUST_CONTINENTAL) {
        s += bary[k + q] * age[v];
        ws += bary[k + q];
      }
    }
    putLut(rgba, p, lut, 3 * cmapIndex(CM_AGE, ws > 0 ? s / ws : 0));
  }
  if (opts.hillshade) applyHillshade(rgba, hf, sea, 0.6, 0.3, cache);
  return rgba;
}
