import { gridLat, gridLon } from '../core/grid';
import type { PaintCache } from './paintCache';

/** Per-size trigonometric tables of an equirectangular raster (row 0 = north, col 0 = lon −π). */
export interface RasterGeometry {
  w: number;
  h: number;
  cosLat: Float64Array;
  sinLat: Float64Array;
  cosLon: Float64Array;
  sinLon: Float64Array;
  /** Angular pixel height (rad). */
  dLat: number;
  /** Angular pixel width at the equator (rad). */
  dLon: number;
}

export function rasterGeometry(w: number, h: number, cache: PaintCache): RasterGeometry {
  return cache.getOrBuild(`geom|${w}x${h}`, () => buildGeometry(w, h));
}

function buildGeometry(w: number, h: number): RasterGeometry {
  const cosLat = new Float64Array(h);
  const sinLat = new Float64Array(h);
  const cosLon = new Float64Array(w);
  const sinLon = new Float64Array(w);
  for (let r = 0; r < h; r++) {
    const la = gridLat(h, r);
    cosLat[r] = Math.cos(la);
    sinLat[r] = Math.sin(la);
  }
  for (let c = 0; c < w; c++) {
    const lo = gridLon(w, c);
    cosLon[c] = Math.cos(lo);
    sinLon[c] = Math.sin(lo);
  }
  return { w, h, cosLat, sinLat, cosLon, sinLon, dLat: Math.PI / h, dLon: (2 * Math.PI) / w };
}

/** Validate a requested raster size (positive integers, bounded) or throw. */
export function checkSize(w: number, h: number): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2 || w > 16384 || h > 8192) {
    throw new Error(`paint: invalid raster size ${w}×${h}`);
  }
}
