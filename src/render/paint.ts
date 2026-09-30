import type {
  LayerId, LegendSpec, MeshGridMap, OverlayFlags, PaintOptions, PaintResult, PaintSources, SphereMesh,
} from '../core/types';

// CONTRACT STUB — implemented by the painter owner. Keep the exported signatures.
const NI = (): never => {
  throw new Error('not implemented');
};

/**
 * Holds reusable, expensive intermediates keyed by VALUE identity (never object identity):
 * `${mesh.n}|${snapshot.id}|${climate?.id}|${w}x${h}|${seed}|${detail}|...` — MeshGridMaps per
 * resolution, smoothed/amplified terrain, static detail textures, climate-derived attribute grids,
 * river networks. One instance per thread. Memory bounded in BYTES (default ≤ 192 MB, LRU).
 * Never retains PaintResult buffers (those are handed to the caller and may be transferred).
 */
export class PaintCache {
  constructor(maxBytes?: number) {
    void maxBytes;
  }
  /** Get (building if needed) the MeshGridMap for a mesh at w×h. */
  getGridMap(mesh: SphereMesh, w: number, h: number): MeshGridMap { return NI(); }
  /** Seed the cache with a map built elsewhere (e.g. transferred from another thread). */
  adoptGridMap(mesh: SphereMesh, map: MeshGridMap): void { return NI(); }
  clear(): void { return NI(); }
}

/**
 * Paint one base layer into an opaque equirectangular RGBA image (row 0 = north).
 * Land vs. sea at display resolution is decided ONLY by the amplified height map vs opts.seaLevel
 * (never by the climate grid's land mask). Layers needing climate data fall back to a neutral
 * elevation-based rendering when src.climate is null. Pure: no DOM (works in workers and Node).
 * result.heightMap is filled for 'satellite' and 'elevation' (identical to paintHeightMap).
 */
export function paintLayer(layer: LayerId, src: PaintSources, opts: PaintOptions, cache?: PaintCache): PaintResult { return NI(); }

/**
 * Layer-independent display surface elevation (m), width×height, row 0 = north: smoothed mesh
 * elevation + plate-frame-anchored procedural detail. Cached by (mesh.n, snapshot.id, size, seed,
 * detail, quality). Returns a fresh copy (safe to transfer).
 */
export function paintHeightMap(src: PaintSources, opts: PaintOptions, cache?: PaintCache): Float32Array { return NI(); }

/**
 * Transparent RGBA overlay (plate boundaries colored by type, graticule, coastlines).
 * Coastlines are traced on the same height map as paintHeightMap for the same (src, opts), so they
 * match the base image exactly.
 */
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
  currents: 'Ocean currents',
  koppen: 'Köppen climate',
};
