/**
 * Change-detecting buffer copies for the views (pure, DOM-free).
 *
 * The app re-sends identical rasters often (month changes resend the height map, overlays stay the
 * same across layer/month changes, pause re-sends the last frame). Copying with a comparison lets the
 * views skip texture uploads, mip rebuilds and re-shading for unchanged data at almost no cost: the
 * comparison runs on 32-bit words and stops at the first difference (then a bulk copy finishes).
 */

/** True on little-endian hosts (every browser/Node target in practice); RGBA words are then 0xAABBGGRR. */
export const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function words(a: ArrayBufferView, n: number): Uint32Array | null {
  return a.byteOffset % 4 === 0 ? new Uint32Array(a.buffer, a.byteOffset, n) : null;
}

/**
 * Copies `n` 32-bit elements (floats or RGBA pixels) from src into dst; returns true if dst changed.
 * Bitwise comparison (NaN-safe; −0 and +0 count as different).
 */
export function copyIfChanged(
  src: Float32Array | Uint8Array | Uint8ClampedArray, dst: Float32Array | Uint8Array | Uint8ClampedArray, n32: number,
): boolean {
  const s = words(src, n32), d = words(dst, n32);
  if (s && d) {
    for (let i = 0; i < n32; i++) {
      if (s[i] !== d[i]) {
        d.set(s.subarray(i, n32), i);
        return true;
      }
    }
    return false;
  }
  // Unaligned views (never produced by the app): byte-wise fallback.
  const sb = new Uint8Array(src.buffer, src.byteOffset, 4 * n32), db = new Uint8Array(dst.buffer, dst.byteOffset, 4 * n32);
  for (let i = 0; i < sb.length; i++) {
    if (sb[i] !== db[i]) {
      db.set(sb.subarray(i), i);
      return true;
    }
  }
  return false;
}

/**
 * Premultiplies straight-alpha RGBA8 (`n` pixels) into dst: rgb·a/255 rounded, alpha kept. Opaque
 * and fully transparent pixels (nearly all overlay pixels) take a single 32-bit move.
 */
export function premultiply(src: Uint8ClampedArray | Uint8Array, dst: Uint8Array, n: number): void {
  const s = LITTLE_ENDIAN ? words(src, n) : null, d = LITTLE_ENDIAN ? words(dst, n) : null;
  if (s && d) {
    for (let i = 0; i < n; i++) {
      const v = s[i];
      const a = v >>> 24;
      if (a === 255) d[i] = v;
      else if (a === 0) d[i] = 0;
      else {
        // round(x·a/255) == floor((x·a + 127)/255) for integer x·a.
        const r = (((v & 255) * a + 127) / 255) | 0;
        const g = ((((v >>> 8) & 255) * a + 127) / 255) | 0;
        const b = ((((v >>> 16) & 255) * a + 127) / 255) | 0;
        d[i] = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
      }
    }
    return;
  }
  for (let i = 0; i < 4 * n; i += 4) {
    const a = src[i + 3];
    for (let k = 0; k < 3; k++) dst[i + k] = ((src[i + k] * a + 127) / 255) | 0;
    dst[i + 3] = a;
  }
}

/**
 * Small most-recently-used cache of per-size resources (the views keep one texture per raster size:
 * playback previews at 1024×512 and paused frames at 2048×1024 alternate without reallocating GPU
 * storage). Evicted entries are passed to `release`.
 */
export class SizeCache<T> {
  private readonly entries: Array<{ w: number; h: number; value: T }> = [];

  constructor(private readonly capacity: number, private readonly release: (value: T) => void) {}

  /** The entry for w×h (moved to the front), created by `make` when absent. */
  get(w: number, h: number, make: () => T): { value: T; fresh: boolean } {
    const k = this.entries.findIndex((e) => e.w === w && e.h === h);
    if (k >= 0) {
      const [e] = this.entries.splice(k, 1);
      this.entries.unshift(e);
      return { value: e.value, fresh: false };
    }
    const e = { w, h, value: make() };
    this.entries.unshift(e);
    while (this.entries.length > this.capacity) this.release(this.entries.pop()!.value);
    return { value: e.value, fresh: true };
  }

  get size(): number {
    return this.entries.length;
  }

  values(): T[] {
    return this.entries.map((e) => e.value);
  }

  clear(): void {
    for (const e of this.entries.splice(0)) this.release(e.value);
  }
}
