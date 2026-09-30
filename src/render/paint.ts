/**
 * Painter public API (SPEC §7): pure RGBA painting of every layer, the display height map and the
 * overlay. No DOM; runs in workers and Node. Implementation lives in the private render/* helpers.
 */
import type {
  ClimateResult, LayerId, LegendSpec, OverlayFlags, PaintOptions, PaintResult, PaintSources,
} from '../core/types';
import { paintCrust, paintCrustAge, paintElevation, paintPlates } from './layers';
import { paintCurrents, paintKoppen, paintPressure, paintPrecipitation, paintSst, paintTemperature, paintWind } from './layersClimate';
import { paintNeutral } from './layersCommon';
import { buildLegend } from './legend';
import { buildOverlay } from './overlay';
import { PaintCache } from './paintCache';
import { checkSize } from './paintGeometry';
import { normalizeMonth, paintSatellite } from './satellite';
import { getHeightField } from './terrain';

export { PaintCache } from './paintCache';

function checkOptions(opts: PaintOptions): void {
  checkSize(opts.width, opts.height);
  if (!Number.isFinite(opts.seaLevel)) throw new Error(`paint: seaLevel must be finite (got ${opts.seaLevel})`);
  if (!Number.isFinite(opts.seed)) throw new Error(`paint: seed must be finite (got ${opts.seed})`);
  normalizeMonth(opts.month);
}

function checkSources(src: PaintSources): void {
  const s = src.snapshot;
  if (s && s.n !== src.mesh.n) throw new Error(`paint: snapshot.n (${s.n}) ≠ mesh.n (${src.mesh.n})`);
  if (s) {
    for (const k of ['plate', 'elev', 'crust', 'age', 'boundary', 'orogeny'] as const) {
      const a = s[k];
      if (!a || a.length !== s.n) throw new Error(`paint: snapshot.${k} must have n = ${s.n} values`);
    }
  }
  const c = src.climate;
  if (c) checkClimate(c);
}

function checkClimate(c: ClimateResult): void {
  const N = c.w * c.h;
  if (!(c.w >= 2 && c.h >= 2)) throw new Error(`paint: climate grid ${c.w}×${c.h} too small`);
  const monthly: Array<keyof ClimateResult> = ['temp', 'precip', 'evap', 'pressure', 'windU', 'windV', 'sst', 'seaIce', 'currentU', 'currentV'];
  for (const k of monthly) {
    const a = c[k] as Float32Array;
    if (!a || a.length !== 12 * N) throw new Error(`paint: climate.${String(k)} must have 12·w·h values`);
  }
  for (const k of ['land', 'elev', 'koppenAll', 'koppen', 'tempAnnual', 'precipAnnual'] as Array<keyof ClimateResult>) {
    const a = c[k] as ArrayLike<number>;
    if (!a || a.length !== N) throw new Error(`paint: climate.${String(k)} must have w·h values`);
  }
}

/**
 * Paint one base layer into an opaque equirectangular RGBA image (row 0 = north).
 * Land vs. sea at display resolution is decided ONLY by the amplified height map vs opts.seaLevel
 * (never by the climate grid's land mask). Layers needing climate data fall back to a neutral
 * elevation-based rendering when src.climate is null. Pure: no DOM (works in workers and Node).
 * result.heightMap is filled for 'satellite' and 'elevation' (identical to paintHeightMap).
 */
export function paintLayer(layer: LayerId, src: PaintSources, opts: PaintOptions, cache?: PaintCache): PaintResult {
  checkOptions(opts);
  checkSources(src);
  const pc = cache ?? new PaintCache();
  const { mesh, snapshot: snap, climate } = src;
  const hf = getHeightField(mesh, snap, opts, pc);
  const month = normalizeMonth(opts.month);
  let rgba: Uint8ClampedArray;
  switch (layer) {
    case 'satellite': rgba = paintSatellite(mesh, snap, climate, opts, pc); break;
    case 'elevation': rgba = paintElevation(hf, opts, pc); break;
    case 'plates': rgba = paintPlates(mesh, snap, hf, opts, pc); break;
    case 'crust': rgba = paintCrust(mesh, snap, hf, opts, pc); break;
    case 'crustAge': rgba = paintCrustAge(mesh, snap, hf, opts, pc); break;
    case 'temperature': rgba = climate ? paintTemperature(climate, hf, opts, month, pc) : paintNeutral(hf, opts.seaLevel); break;
    case 'precipitation': rgba = climate ? paintPrecipitation(climate, hf, opts, month, pc) : paintNeutral(hf, opts.seaLevel); break;
    case 'pressure': rgba = climate ? paintPressure(climate, hf, opts, month, pc) : paintNeutral(hf, opts.seaLevel); break;
    case 'sst': rgba = climate ? paintSst(climate, hf, opts, month, pc) : paintNeutral(hf, opts.seaLevel); break;
    case 'wind': rgba = climate ? paintWind(climate, hf, opts, month, pc) : paintNeutral(hf, opts.seaLevel); break;
    case 'currents': rgba = climate ? paintCurrents(climate, hf, opts, month, pc) : paintNeutral(hf, opts.seaLevel); break;
    case 'koppen': rgba = climate ? paintKoppen(climate, hf, opts, pc) : paintNeutral(hf, opts.seaLevel); break;
    default: throw new Error(`paintLayer: unknown layer '${String(layer)}'`);
  }
  const result: PaintResult = { width: opts.width, height: opts.height, rgba };
  if (layer === 'satellite' || layer === 'elevation') result.heightMap = hf.height.slice();
  return result;
}

/**
 * Layer-independent display surface elevation (m), width×height, row 0 = north: smoothed mesh
 * elevation + plate-frame-anchored procedural detail (coastline breakup centred on opts.seaLevel).
 * Cached by (mesh.n, snapshot.id, size, seed, detail, quality, sea level). Returns a fresh copy
 * (safe to transfer).
 */
export function paintHeightMap(src: PaintSources, opts: PaintOptions, cache?: PaintCache): Float32Array {
  checkOptions(opts);
  checkSources(src);
  return getHeightField(src.mesh, src.snapshot, opts, cache ?? new PaintCache()).height.slice();
}

/**
 * Transparent RGBA overlay (plate boundaries colored by type, graticule, coastlines).
 * Coastlines are traced on the same height map as paintHeightMap for the same (src, opts), so they
 * match the base image exactly.
 */
export function paintOverlay(flags: OverlayFlags, src: PaintSources, opts: PaintOptions, cache?: PaintCache): Uint8ClampedArray {
  checkOptions(opts);
  checkSources(src);
  const pc = cache ?? new PaintCache();
  const hf = flags.coastlines ? getHeightField(src.mesh, src.snapshot, opts, pc) : null;
  return buildOverlay(flags, src.mesh, src.snapshot, hf, opts, pc);
}

/** Legend for a layer (null if none). */
export function getLegend(layer: LayerId, src: PaintSources, opts: PaintOptions): LegendSpec | null {
  return buildLegend(layer, src, opts);
}

/** Human-readable layer names for the UI, in display order. */
export const LAYER_LABELS: Record<LayerId, string> = {
  satellite: 'Satellite',
  elevation: 'Elevation',
  plates: 'Plates',
  crust: 'Crust type',
  crustAge: 'Crust age',
  temperature: 'Temperature',
  precipitation: 'Precipitation',
  pressure: 'Pressure',
  sst: 'Sea surface temp.',
  wind: 'Wind speed',
  currents: 'Ocean currents',
  koppen: 'Köppen climate',
};
