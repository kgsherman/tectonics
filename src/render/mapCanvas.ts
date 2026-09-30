/** Small Canvas 2D helpers for the map view. */

/** Full-size absolutely positioned layer canvas. */
export function makeLayerCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  Object.assign(c.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', display: 'block' });
  return c;
}

export function context2d(c: HTMLCanvasElement, settings?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', settings);
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  return ctx;
}

/** Offscreen canvas holding an RGBA image (drawn scaled into the map). */
export class ImageCanvas {
  readonly canvas = document.createElement('canvas');
  private readonly ctx = context2d(this.canvas);
  private image: ImageData | null = null;

  /** Copies rgba (w*h*4) into the canvas. */
  put(rgba: Uint8ClampedArray, w: number, h: number): void {
    this.pixels(w, h).set(rgba.subarray(0, w * h * 4));
    this.commit();
  }

  /** Writable pixel buffer of size w×h (call commit() after editing). */
  pixels(w: number, h: number): Uint8ClampedArray {
    if (this.canvas.width !== w || this.canvas.height !== h || !this.image) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.image = this.ctx.createImageData(w, h);
    }
    return this.image.data;
  }

  commit(): void {
    if (this.image) this.ctx.putImageData(this.image, 0, 0);
  }

  /** Frees the backing store. */
  release(): void {
    this.canvas.width = this.canvas.height = 0;
    this.image = null;
  }
}
