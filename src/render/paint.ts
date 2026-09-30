import type { LayerId, LegendSpec, OverlayFlags, PaintOptions, PaintResult, PaintSources } from '../core/types';

// CONTRACT STUB — implemented by the painter owner. Keep the exported signatures.
const NI = (): never => {
  throw new Error('not implemented');
};

/**
 * Holds reusable, expensive intermediates keyed by their inputs (MeshGridMaps per resolution,
 * amplified terrain per (snapshot identity, size, seed, detail), river networks, ...).
 * One instance per thread; safe to reuse across calls. Must bound its memory (LRU of a few entries).
 */
export class PaintCache {
  clear(): void { return NI(); }
}

/**
 * Paint one base layer into an opaque equirectangular RGBA image (row 0 = north).
 * Layers needing climate data fall back to a neutral 'no climate data' rendering
 * (elevation-based grey) when src.climate is null. Pure: no DOM (works in workers and Node).
 * For 'satellite' and 'elevation', result.heightMap is filled with amplified elevation.
 */
export function paintLayer(layer: LayerId, src: PaintSources, opts: PaintOptions, cache?: PaintCache): PaintResult { return NI(); }

/** Transparent RGBA overlay (plate boundaries colored by type, graticule, coastlines). */
export function paintOverlay(flags: OverlayFlags, src: PaintSources, opts: PaintOptions, cache?: PaintCache): Uint8ClampedArray { return NI(); }

/** Legend for a layer (null if none). */
export function getLegend(layer: LayerId, src: PaintSources, opts: PaintOptions): LegendSpec | null { return NI(); }

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
  koppen: 'Köppen climate',
};
