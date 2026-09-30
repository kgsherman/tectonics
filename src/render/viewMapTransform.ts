/**
 * 2D equirectangular map transform (pure): pan, zoom toward a point, horizontal wrap, vertical clamp.
 *
 * Screen x grows east, y grows south. A geo point is drawn at
 *   x = width/2 + (lon' − centerLon)·scale,  y = height/2 − (lat − centerLat)·scale
 * where lon' is the copy of lon (lon + 2πk) nearest to centerLon. The world repeats every 2π·scale px.
 */
import type { GeoPoint } from '../core/types';

const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI / 2;

/** Largest zoom relative to the fit-the-world scale. */
export const MAP_MAX_ZOOM = 48;

export interface MapTransform {
  /** Viewport size, CSS px. */
  width: number;
  height: number;
  /** Geo point at the viewport center (centerLon unbounded while panning; wrapped by mapClamp). */
  centerLon: number;
  centerLat: number;
  /** CSS px per radian. */
  scale: number;
}

/** Scale at which the whole world fits in the viewport. */
export function mapMinScale(width: number, height: number): number {
  return Math.max(1e-6, Math.min(width / TWO_PI, height / Math.PI));
}

/** Clamps zoom to [fit, fit·MAP_MAX_ZOOM], keeps the view inside the poles and wraps centerLon into (−π, π]. */
export function mapClamp(t: MapTransform): MapTransform {
  const minS = mapMinScale(t.width, t.height);
  const scale = Math.min(minS * MAP_MAX_ZOOM, Math.max(minS, t.scale));
  const halfH = t.height / 2 / scale;
  const latLimit = HALF_PI - halfH;
  const centerLat = latLimit <= 0 ? 0 : Math.max(-latLimit, Math.min(latLimit, t.centerLat));
  let lon = (t.centerLon + Math.PI) % TWO_PI;
  if (lon < 0) lon += TWO_PI;
  lon -= Math.PI;
  if (lon <= -Math.PI) lon += TWO_PI;
  return { width: t.width, height: t.height, centerLon: lon, centerLat, scale };
}

/** Screen position of the copy of (lat, lon) nearest the viewport center. */
export function mapProject(t: MapTransform, lat: number, lon: number): { x: number; y: number } {
  const lu = lon + TWO_PI * Math.round((t.centerLon - lon) / TWO_PI);
  return { x: t.width / 2 + (lu - t.centerLon) * t.scale, y: t.height / 2 - (lat - t.centerLat) * t.scale };
}

/** Screen x of an already-unwrapped longitude (no copy selection). */
export function mapLonToX(t: MapTransform, lon: number): number {
  return t.width / 2 + (lon - t.centerLon) * t.scale;
}

export function mapLatToY(t: MapTransform, lat: number): number {
  return t.height / 2 - (lat - t.centerLat) * t.scale;
}

/** Geo point under a viewport position (lon wrapped into (−π, π]); null beyond the poles. */
export function mapUnproject(t: MapTransform, x: number, y: number): GeoPoint | null {
  const lat = t.centerLat - (y - t.height / 2) / t.scale;
  if (!(lat >= -HALF_PI && lat <= HALF_PI)) return null;
  let lon = (t.centerLon + (x - t.width / 2) / t.scale + Math.PI) % TWO_PI;
  if (lon < 0) lon += TWO_PI;
  lon -= Math.PI;
  if (lon <= -Math.PI) lon += TWO_PI;
  return { lat, lon };
}

/** Pans by a screen delta (content follows the pointer). */
export function mapPan(t: MapTransform, dx: number, dy: number): MapTransform {
  return mapClamp({ ...t, centerLon: t.centerLon - dx / t.scale, centerLat: t.centerLat + dy / t.scale });
}

/** Zooms by `factor` keeping the geo point under viewport position (x, y) fixed (as far as clamping allows). */
export function mapZoomAt(t: MapTransform, x: number, y: number, factor: number): MapTransform {
  const minS = mapMinScale(t.width, t.height);
  const scale = Math.min(minS * MAP_MAX_ZOOM, Math.max(minS, t.scale * factor));
  // Unclamped geo coordinates under the cursor (latitude may lie beyond the poles in letterbox areas).
  const lonAt = t.centerLon + (x - t.width / 2) / t.scale;
  const latAt = t.centerLat - (y - t.height / 2) / t.scale;
  return mapClamp({
    ...t,
    scale,
    centerLon: lonAt - (x - t.width / 2) / scale,
    centerLat: latAt + (y - t.height / 2) / scale,
  });
}

/**
 * Integer copy offsets k such that world copy k (longitudes [−π, π) + 2πk, placed relative to the
 * center copy) intersects the viewport horizontally.
 */
export function mapWorldCopies(t: MapTransform): number[] {
  const worldW = TWO_PI * t.scale;
  const x0 = mapLonToX(t, -Math.PI); // left edge of copy 0
  const kMin = Math.ceil((0 - x0 - worldW) / worldW + 1e-9);
  const kMax = Math.floor((t.width - x0) / worldW - 1e-9);
  const out: number[] = [];
  for (let k = kMin; k <= kMax; k++) out.push(k);
  return out;
}

/** Screen rectangle of world copy k: x, y of the north-west corner and size. */
export function mapWorldRect(t: MapTransform, k: number): { x: number; y: number; w: number; h: number } {
  const w = TWO_PI * t.scale;
  return { x: mapLonToX(t, -Math.PI) + k * w, y: mapLatToY(t, HALF_PI), w, h: Math.PI * t.scale };
}
