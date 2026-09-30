/**
 * Paints what the paint worker sends to the main thread: the layer image, the display height
 * map and the overlay for a frame, or an export image. All returned buffers are freshly allocated
 * by the painter (PaintCache never retains them), so they can be transferred.
 */
import type { OverlayFlags, PaintOptions, PaintSources } from '../core/types';
import { PaintCache, paintHeightMap, paintLayer, paintOverlay } from '../render/paint';
import type { DisplaySettings, ExportedImage, PaintParts, PaintQuality } from './protocol';

/**
 * PaintOptions plus painter hints outside the frozen contract (optional; a painter that does not
 * know a hint ignores it).
 */
export interface PaintOptionsExt extends PaintOptions {
  /** Currents layer: draw the arrow streamlets (default true). */
  flowGlyphs?: boolean;
}

export interface PaintedFrame {
  width: number;
  height: number;
  rgba: Uint8ClampedArray | null;
  heightMap: Float32Array | null;
  overlay: Uint8ClampedArray | null;
  ms: number;
}

export class FramePainter {
  constructor(
    readonly cache: PaintCache,
    private readonly now: () => number,
  ) {}

  options(d: DisplaySettings, width: number, height: number, quality: PaintQuality, seed: number): PaintOptionsExt {
    return {
      width, height, month: d.month, seaLevel: d.seaLevel, hillshade: false, seed, detail: d.detail, rivers: quality === 'full', quality,
      flowGlyphs: d.flowGlyphs !== false,
    };
  }

  /** Frame size for a quality. */
  static size(d: DisplaySettings, quality: PaintQuality): { width: number; height: number } {
    return quality === 'full' ? { width: d.fullWidth, height: d.fullHeight } : { width: d.previewWidth, height: d.previewHeight };
  }

  /**
   * Base + height map (parts 'all') and the boundaries/coastlines overlay (the views draw the
   * graticule). `want` skips the height map / overlay when the receiver already holds them
   * (`overlayRepainted` is then false).
   */
  frame(
    src: PaintSources, d: DisplaySettings, quality: PaintQuality, parts: PaintParts, seed: number,
    want: { height: boolean; overlay: boolean } = { height: true, overlay: true },
  ): PaintedFrame & { overlayRepainted: boolean } {
    const { width, height } = FramePainter.size(d, quality);
    const opts = this.options(d, width, height, quality, seed);
    const t0 = this.now();
    let rgba: Uint8ClampedArray | null = null;
    let heightMap: Float32Array | null = null;
    if (parts === 'all') {
      const res = paintLayer(d.layer, src, opts, this.cache);
      rgba = res.rgba;
      if (want.height) heightMap = res.heightMap ?? paintHeightMap(src, opts, this.cache);
    }
    const flags: OverlayFlags = { boundaries: d.overlays.boundaries, coastlines: d.overlays.coastlines, graticule: false };
    const overlay = want.overlay && (flags.boundaries || flags.coastlines) ? paintOverlay(flags, src, opts, this.cache) : null;
    return { width, height, rgba, heightMap, overlay, overlayRepainted: want.overlay, ms: this.now() - t0 };
  }

  /** Full-quality equirectangular export of the current layer; the overlay includes the graticule. */
  exportImage(src: PaintSources, d: DisplaySettings, width: number, height: number, seed: number): ExportedImage {
    // A still image has no particles: always draw the flow glyphs.
    const opts = this.options({ ...d, flowGlyphs: true }, width, height, 'full', seed);
    const { rgba } = paintLayer(d.layer, src, opts, this.cache);
    const flags: OverlayFlags = { ...d.overlays };
    const overlay = flags.boundaries || flags.coastlines || flags.graticule ? paintOverlay(flags, src, opts, this.cache) : null;
    return { width, height, rgba, overlay, time: src.snapshot?.time ?? 0 };
  }
}
