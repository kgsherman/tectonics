/**
 * Transparent overlay (straight alpha): plate boundaries coloured by type, graticule, and
 * coastlines traced on the same height map as the base image (anti-aliased by the height-map
 * signed distance to sea level).
 */
import type { MeshGridMap, OverlayFlags, PaintOptions, RGB, SphereMesh, WorldSnapshot } from '../core/types';
import * as _types from '../core/types';
import * as _layersCommon from './layersCommon';
import type { PaintCache } from './paintCache';
import type { HeightField } from './terrain';

// Imported values are copied into module constants: some module runners (vitest / vite-node SSR)
// compile named imports into namespace property reads, which would otherwise sit in per-pixel loops.
const { BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT, BOUNDARY_NONE, BOUNDARY_TRANSFORM } = _types;
const { oneHotCategory } = _layersCommon;

export const BOUNDARY_COLORS: Record<number, RGB> = {
  [BOUNDARY_CONVERGENT]: [236, 64, 52],
  [BOUNDARY_DIVERGENT]: [250, 212, 60],
  [BOUNDARY_TRANSFORM]: [240, 240, 240],
};
const COAST_RGB: RGB = [255, 255, 255];
const GRATICULE_RGB: RGB = [255, 255, 255];
/** Graticule spacing (degrees); the equator is drawn stronger. */
export const GRATICULE_DEG = 30;

function smooth(a: number, b: number, x: number): number {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/** "Over" compositing of a straight-alpha colour onto a straight-alpha buffer. */
function blend(out: Uint8ClampedArray, p: number, c: RGB, a: number): void {
  if (a <= 0) return;
  const o = 4 * p;
  const da = out[o + 3] / 255;
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  for (let q = 0; q < 3; q++) out[o + q] = (c[q] * a + out[o + q] * da * (1 - a)) / oa;
  out[o + 3] = oa * 255;
}

function drawBoundaries(out: Uint8ClampedArray, map: MeshGridMap, mesh: SphereMesh, s: WorldSnapshot): void {
  const { w, h, tri, bary } = map;
  const npx = w * h;
  const cat = new Int32Array(npx);
  const margin = new Float32Array(npx);
  oneHotCategory(map, mesh, s.plate, cat, margin);
  // Line half-width ≈ 1.1 px expressed in barycentric margin units (margin grows ~1 per half-triangle).
  const spacingPx = (mesh.spacing * w) / (2 * Math.PI);
  const ew = Math.min(0.95, 2.2 / Math.max(0.5, spacingPx));
  for (let p = 0; p < npx; p++) {
    const m = margin[p];
    if (m >= ew) continue;
    // Boundary type: the heaviest triangle vertex that is classified as a boundary cell.
    const k = 3 * p;
    let type = BOUNDARY_NONE, bw = -1;
    for (let q = 0; q < 3; q++) {
      const t = s.boundary[tri[k + q]];
      if (t !== BOUNDARY_NONE && bary[k + q] > bw) {
        bw = bary[k + q];
        type = t;
      }
    }
    if (type === BOUNDARY_NONE) type = BOUNDARY_TRANSFORM;
    blend(out, p, BOUNDARY_COLORS[type] ?? BOUNDARY_COLORS[BOUNDARY_TRANSFORM], 0.95 * (1 - smooth(0.35 * ew, ew, m)));
  }
}

function drawGraticule(out: Uint8ClampedArray, w: number, h: number): void {
  const step = (GRATICULE_DEG * Math.PI) / 180;
  const pxLat = Math.PI / h, pxLon = (2 * Math.PI) / w;
  for (let r = 0; r < h; r++) {
    const lat = Math.PI / 2 - (r + 0.5) * pxLat;
    const fl = lat / step;
    const dLat = Math.abs(fl - Math.round(fl)) * step / pxLat;
    const equator = Math.round(fl) === 0;
    const aLat = (equator ? 0.55 : 0.32) * (1 - smooth(0.25, 0.9, dLat));
    for (let c = 0; c < w; c++) {
      const lon = -Math.PI + (c + 0.5) * pxLon;
      const fo = lon / step;
      const dLon = Math.abs(fo - Math.round(fo)) * step / pxLon;
      // Meridians stop short of the poles (they converge into a blob there).
      const aLon = Math.abs(lat) < (80 * Math.PI) / 180 ? 0.32 * (1 - smooth(0.25, 0.9, dLon)) : 0;
      const a = Math.max(aLat, aLon);
      if (a > 0.004) blend(out, r * w + c, GRATICULE_RGB, a);
    }
  }
}

function drawCoastlines(out: Uint8ClampedArray, hf: HeightField, sea: number): void {
  const { w, h, height } = hf;
  for (let r = 0; r < h; r++) {
    const row = r * w;
    const rowN = (r > 0 ? r - 1 : 0) * w, rowS = (r < h - 1 ? r + 1 : h - 1) * w;
    for (let c = 0; c < w; c++) {
      const p = row + c;
      const e = height[p] - sea;
      // Distance (px) from the pixel centre to the sea-level contour ≈ |e| / |∇e|_px.
      const gx = 0.5 * (height[row + (c + 1 < w ? c + 1 : 0)] - height[row + (c > 0 ? c - 1 : w - 1)]);
      const gy = 0.5 * (height[rowN + c] - height[rowS + c]);
      const g = Math.sqrt(gx * gx + gy * gy);
      if (g <= 0) continue;
      const d = Math.abs(e) / g;
      if (d < 1.2) blend(out, p, COAST_RGB, 0.85 * (1 - smooth(0.3, 1.2, d)));
    }
  }
}

export function buildOverlay(
  flags: OverlayFlags, mesh: SphereMesh, snap: WorldSnapshot | null, hf: HeightField | null, opts: PaintOptions, cache: PaintCache,
): Uint8ClampedArray {
  const w = opts.width, h = opts.height;
  const out = new Uint8ClampedArray(4 * w * h);
  if (flags.graticule) drawGraticule(out, w, h);
  if (flags.coastlines && hf) drawCoastlines(out, hf, opts.seaLevel);
  if (flags.boundaries && snap) drawBoundaries(out, cache.getGridMap(mesh, w, h), mesh, snap);
  return out;
}
