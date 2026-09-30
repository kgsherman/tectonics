/**
 * Transparent overlay (straight alpha): plate boundaries coloured by type, graticule, and
 * coastlines traced on the same height map as the base image (anti-aliased by the height-map
 * signed distance to sea level).
 */
import * as _constants from '../core/constants';
import type { MeshGridMap, OverlayFlags, PaintOptions, RGB, SphereMesh, WorldSnapshot } from '../core/types';
import * as _types from '../core/types';
import * as _layersCategory from './layersCategory';
import type { PaintCache } from './paintCache';
import type { HeightField } from './terrain';

// Imported values are copied into module constants: some module runners (vitest / vite-node SSR)
// compile named imports into namespace property reads, which would otherwise sit in per-pixel loops.
const { EARTH_RADIUS_KM } = _constants;
const { BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT, BOUNDARY_TRANSFORM } = _types;
const { getCellCategories, pixelCategories } = _layersCategory;

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
function blend(out: Uint8ClampedArray, p: number, c: ArrayLike<number>, a: number): void {
  if (a <= 0) return;
  const o = 4 * p;
  const da = out[o + 3] / 255;
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  for (let q = 0; q < 3; q++) out[o + q] = (c[q] * a + out[o + q] * da * (1 - a)) / oa;
  out[o + 3] = oa * 255;
}

/** Dark halo under the boundary lines (legibility on light and dark bases). */
const HALO_RGB: RGB = [12, 14, 20];

/**
 * Plate boundaries as smooth anti-aliased lines along the zero contour of the Gaussian-voted plate
 * memberships (layersCategory). The type is the sim's rule (relative velocity of the two plates
 * projected on the boundary normal: transform when |v_n| < ½·v_t, else convergent / divergent) but
 * evaluated per pixel with the smoothed boundary normal, so long boundaries keep one consistent
 * colour; colours blend smoothly where the type changes.
 */
function drawBoundaries(out: Uint8ClampedArray, map: MeshGridMap, mesh: SphereMesh, s: WorldSnapshot, cache: PaintCache): void {
  const { w, h } = map;
  const pc = pixelCategories(map, getCellCategories(mesh, s.plate, `plate|${s.id}`, cache), true);
  const np = s.plates.length;
  const k = Math.max(0.6, Math.min(1.6, w / 2048));
  const hw = 0.85 * k, haloHw = hw + 0.9 * k;
  const sinLon = new Float64Array(w), cosLon = new Float64Array(w);
  for (let c = 0; c < w; c++) {
    const lon = -Math.PI + ((c + 0.5) * 2 * Math.PI) / w;
    sinLon[c] = Math.sin(lon);
    cosLon[c] = Math.cos(lon);
  }
  const rho = (2 * h) / w; // Δλ / Δφ of the raster
  const NR = Math.max(2, Math.round(3 * k));
  const tiny = 2 / EARTH_RADIUS_KM;
  const conv = BOUNDARY_COLORS[BOUNDARY_CONVERGENT], div = BOUNDARY_COLORS[BOUNDARY_DIVERGENT], tr = BOUNDARY_COLORS[BOUNDARY_TRANSFORM];
  const col: [number, number, number] = [0, 0, 0];
  for (let r = 0; r < h; r++) {
    const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
    const sp = Math.sin(lat), cp = Math.cos(lat);
    for (let c = 0; c < w; c++) {
      const p = r * w + c;
      const d = pc.dist[p];
      if (d >= haloHw + 0.5) continue;
      const k1 = pc.k1[p], k2 = pc.k2[p];
      // Type weights from the relative motion of k2 w.r.t. k1 across the smoothed normal.
      let tw = 1, convergent = true;
      if (k1 >= 0 && k1 < np && k2 >= 0 && k2 < np) {
        const px = cp * cosLon[c], py = cp * sinLon[c], pz = sp;
        const wa = s.plates[k1].omega, wb = s.plates[k2].omega;
        const wx = wb[0] - wa[0], wy = wb[1] - wa[1], wz = wb[2] - wa[2];
        const vx = wy * pz - wz * py, vy = wz * px - wx * pz, vz = wx * py - wy * px;
        const ve = -vx * sinLon[c] + vy * cosLon[c];
        const vN = -vx * sp * cosLon[c] - vy * sp * sinLon[c] + vz * cp;
        // Boundary normal averaged over a small window (pair-consistent sign) so the type does not
        // flicker with the per-triangle gradient of the interpolated memberships.
        let ax = 0, ay = 0;
        for (let dy = -NR; dy <= NR; dy++) {
          const rr = r + dy;
          if (rr < 0 || rr >= h) continue;
          for (let dx = -NR; dx <= NR; dx++) {
            const q = rr * w + ((c + dx + w) % w);
            if (pc.dist[q] > 3) continue;
            const a1 = pc.k1[q], a2 = pc.k2[q];
            if (a1 === k1 && a2 === k2) { ax += pc.nx[q]; ay += pc.ny[q]; } else if (a1 === k2 && a2 === k1) { ax -= pc.nx[q]; ay -= pc.ny[q]; }
          }
        }
        let ne = ax / (Math.max(0.05, cp) * rho), nn = -ay;
        const nl = Math.sqrt(ne * ne + nn * nn);
        if (nl > 0) {
          ne /= nl;
          nn /= nl;
          const vn = ve * ne + vN * nn; // > 0: k2 moves away from k1
          const vt = Math.abs(ve * nn - vN * ne);
          if (Math.abs(vn) >= tiny || vt >= tiny) {
            tw = 1 - smooth(0.35, 0.65, Math.abs(vn) / Math.max(vt, 1e-12));
            convergent = vn < 0;
          }
        }
      } else {
        const t = s.boundary[map.nearest[p]];
        if (t === BOUNDARY_CONVERGENT || t === BOUNDARY_DIVERGENT) { tw = 0; convergent = t === BOUNDARY_CONVERGENT; }
      }
      const base = convergent ? conv : div;
      col[0] = base[0] + (tr[0] - base[0]) * tw;
      col[1] = base[1] + (tr[1] - base[1]) * tw;
      col[2] = base[2] + (tr[2] - base[2]) * tw;
      let ha = haloHw + 0.5 - d;
      ha = ha > 1 ? 1 : ha;
      blend(out, p, HALO_RGB, 0.45 * ha);
      let ca = hw + 0.5 - d;
      if (ca <= 0) continue;
      ca = ca > 1 ? 1 : ca;
      blend(out, p, col, 0.97 * ca);
    }
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
  if (flags.boundaries && snap) drawBoundaries(out, cache.getGridMap(mesh, w, h), mesh, snap, cache);
  return out;
}
