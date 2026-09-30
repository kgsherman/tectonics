/**
 * Vector annotations for the data layers, rasterized with analytic anti-aliasing: an alpha layer
 * that max-accumulates segment coverage (no double-blending where segments of one stroke meet),
 * flow streamlets with arrow heads, and a tiny stroke font (H, L, digits) for pressure centres.
 */
import * as _colormaps from './colormaps';

// Imported values are copied into module constants: some module runners (vitest / vite-node SSR)
// compile named imports into namespace property reads, which would otherwise sit in per-pixel loops.
const { SRGB_TO_LINEAR, encodeSrgb } = _colormaps;

/** Scratch coverage buffers by slot (painting is synchronous; a layer lives within one paint call). */
const alphaPool: Float32Array[] = [];

/** Drops the coverage pool (between paint calls only); returns the bytes released. */
export function releaseGlyphScratch(): number {
  let bytes = 0;
  for (const b of alphaPool) bytes += b ? b.byteLength : 0;
  alphaPool.length = 0;
  return bytes;
}

/** Max-accumulated coverage over a w×h raster (lon wraps); composited once onto an image. */
export class AlphaLayer {
  readonly a: Float32Array;
  private y0 = Infinity;
  private y1 = -Infinity;
  /** Layers alive at the same time must use different slots. */
  constructor(readonly w: number, readonly h: number, slot = 0) {
    const n = w * h;
    let a = alphaPool[slot];
    if (!a || a.length !== n) {
      a = new Float32Array(n);
      alphaPool[slot] = a;
    } else a.fill(0);
    this.a = a;
  }

  /** Anti-aliased segment of the given full width (px) and peak alpha (≤ 1). */
  segment(x0: number, y0: number, x1: number, y1: number, width: number, alpha: number): void {
    const hw = 0.5 * width;
    const { w, h, a } = this;
    const minX = Math.floor(Math.min(x0, x1) - hw - 1), maxX = Math.ceil(Math.max(x0, x1) + hw + 1);
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - hw - 1)), maxY = Math.min(h - 1, Math.ceil(Math.max(y0, y1) + hw + 1));
    if (minY < this.y0) this.y0 = minY;
    if (maxY > this.y1) this.y1 = maxY;
    const dx = x1 - x0, dy = y1 - y0;
    const l2 = dx * dx + dy * dy || 1e-9;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        let t = ((px - x0) * dx + (py - y0) * dy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - (x0 + t * dx), ey = py - (y0 + t * dy);
        const d = Math.sqrt(ex * ex + ey * ey);
        // Box-filtered coverage of a line of half-width hw at distance d.
        let cov = hw + 0.5 - d;
        if (cov <= 0) continue;
        if (cov > 1) cov = 1;
        if (hw < 0.5) cov *= 2 * hw;
        const v = alpha * cov;
        const i = y * w + (((x % w) + w) % w);
        if (v > a[i]) a[i] = v;
      }
    }
  }

  /** Polyline through xs/ys[0..n) with a per-vertex alpha ramp (alpha0 at the first vertex). */
  polyline(xs: ArrayLike<number>, ys: ArrayLike<number>, n: number, width: number, alpha0: number, alpha1: number): void {
    for (let i = 0; i + 1 < n; i++) {
      const t = n > 2 ? (i + 1) / (n - 1) : 1;
      this.segment(xs[i], ys[i], xs[i + 1], ys[i + 1], width, alpha0 + (alpha1 - alpha0) * t);
    }
  }

  /** Blend `rgb` into an opaque sRGB image by the accumulated coverage (linear light). */
  composite(rgba: Uint8ClampedArray, rgb: readonly [number, number, number]): void {
    if (this.y1 < this.y0) return;
    const { w, a } = this;
    const lr = SRGB_TO_LINEAR[rgb[0]], lg = SRGB_TO_LINEAR[rgb[1]], lb = SRGB_TO_LINEAR[rgb[2]];
    for (let i = this.y0 * w, e = (this.y1 + 1) * w; i < e; i++) {
      const k = a[i];
      if (k <= 0) continue;
      const o = 4 * i;
      rgba[o] = encodeSrgb(SRGB_TO_LINEAR[rgba[o]] + (lr - SRGB_TO_LINEAR[rgba[o]]) * k);
      rgba[o + 1] = encodeSrgb(SRGB_TO_LINEAR[rgba[o + 1]] + (lg - SRGB_TO_LINEAR[rgba[o + 1]]) * k);
      rgba[o + 2] = encodeSrgb(SRGB_TO_LINEAR[rgba[o + 2]] + (lb - SRGB_TO_LINEAR[rgba[o + 2]]) * k);
    }
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Streamlets                                                                                    */
/* ------------------------------------------------------------------------------------------- */

/** Deterministic hash → [0, 1). */
function hash01(i: number, j: number, s: number): number {
  let x = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(s, 0x9e3779b1);
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

export interface StreamletStyle {
  /** Seed spacing (px, at the equator; widened by 1/cos φ toward the poles). */
  spacing: number;
  /** Speed (field units) below which no glyph is drawn / tracing stops. */
  minSpeed: number;
  /** Speed at which a glyph reaches its full length. */
  fullSpeed: number;
  /** Line width (px). */
  width: number;
  /** Peak alpha at the head of a fast streamlet. */
  alpha: number;
}

/**
 * Short streamlets traced through a raster vector field (u east, v north; e.g. m/s) from jittered
 * seeds, tapering in alpha from tail to head, with an arrow head. `valid(p)` limits tracing (e.g. to
 * sea pixels). Lengths grow with speed (saturating at fullSpeed).
 */
export function drawStreamlets(
  layer: AlphaLayer, u: Float32Array, v: Float32Array, valid: (p: number) => boolean, st: StreamletStyle,
): void {
  const { w, h } = layer;
  const S = st.spacing;
  const MAXV = 40;
  const xs = new Float64Array(2 * MAXV + 1), ys = new Float64Array(2 * MAXV + 1);
  const bx = new Float64Array(MAXV + 1), by = new Float64Array(MAXV + 1);
  const cosRow = new Float64Array(h);
  for (let r = 0; r < h; r++) cosRow[r] = Math.max(0.05, Math.cos(Math.PI / 2 - ((r + 0.5) * Math.PI) / h));
  const sample = (x: number, y: number, out: Float64Array): boolean => {
    const r = Math.floor(y);
    if (r < 0 || r >= h) return false;
    const c = ((Math.floor(x) % w) + w) % w;
    const p = r * w + c;
    if (!valid(p)) return false;
    const uu = u[p], vv = v[p];
    const s = Math.sqrt(uu * uu + vv * vv);
    if (!(s >= st.minSpeed)) return false;
    // Pixel-space direction (x east, y south); east scales by 1/cos φ on the equirectangular raster.
    const dx = uu / cosRow[r], dy = -vv;
    const dl = Math.sqrt(dx * dx + dy * dy);
    out[0] = dx / dl;
    out[1] = dy / dl;
    out[2] = s;
    return true;
  };
  const d0 = new Float64Array(3), d1 = new Float64Array(3);
  const step = Math.max(1, S / 14);
  let gi = 0;
  for (let gy = S / 2; gy < h; gy += S, gi++) {
    const cl = cosRow[Math.min(h - 1, Math.floor(gy))];
    if (cl < 0.1) continue;
    const n = Math.max(1, Math.floor((w * cl) / S));
    for (let k = 0; k < n; k++) {
      const x = ((k + 0.5 + 0.7 * (hash01(k, gi, 1) - 0.5)) * w) / n;
      const y = gy + 0.7 * S * (hash01(k, gi, 2) - 0.5);
      if (!sample(x, y, d0)) continue;
      const speed = d0[2];
      const len = S * (0.45 + 0.8 * Math.min(1, speed / st.fullSpeed));
      const nSteps = Math.min(MAXV, Math.max(2, Math.round(len / step)));
      const half = nSteps >> 1;
      // Trace backward (tail) then forward (head) with midpoint (RK2) steps.
      let nb = 0;
      let cx = x, cy = y;
      for (let i = 0; i < half; i++) {
        if (!sample(cx, cy, d0)) break;
        if (!sample(cx - 0.5 * step * d0[0], cy - 0.5 * step * d0[1], d1)) break;
        cx -= step * d1[0];
        cy -= step * d1[1];
        bx[nb] = cx; by[nb++] = cy;
      }
      let m = 0;
      for (let i = nb - 1; i >= 0; i--) { xs[m] = bx[i]; ys[m++] = by[i]; }
      xs[m] = x; ys[m++] = y;
      cx = x; cy = y;
      for (let i = 0; i < nSteps - half; i++) {
        if (!sample(cx, cy, d0)) break;
        if (!sample(cx + 0.5 * step * d0[0], cy + 0.5 * step * d0[1], d1)) break;
        cx += step * d1[0];
        cy += step * d1[1];
        xs[m] = cx; ys[m++] = cy;
      }
      if (m < 3) continue;
      const a = st.alpha * (0.35 + 0.65 * Math.min(1, speed / st.fullSpeed));
      layer.polyline(xs, ys, m, st.width, 0.08 * a, a);
      // Arrow head along the last segment direction.
      let hx = xs[m - 1] - xs[m - 3], hy = ys[m - 1] - ys[m - 3];
      const hl = Math.sqrt(hx * hx + hy * hy) || 1;
      hx /= hl; hy /= hl;
      const L = Math.min(0.3 * S, 1.6 + 1.2 * st.width + 0.08 * len);
      const ca = Math.cos(0.42), sa = Math.sin(0.42);
      const tx = xs[m - 1], ty = ys[m - 1];
      layer.segment(tx, ty, tx - L * (hx * ca - hy * sa), ty - L * (hy * ca + hx * sa), st.width, a);
      layer.segment(tx, ty, tx - L * (hx * ca + hy * sa), ty - L * (hy * ca - hx * sa), st.width, a);
    }
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Stroke font                                                                                   */
/* ------------------------------------------------------------------------------------------- */

/** Glyph strokes on a 4×6 design grid (y down); each stroke is a polyline [x0, y0, x1, y1, ...]. */
const FONT: Record<string, number[][]> = {
  H: [[0, 0, 0, 6], [4, 0, 4, 6], [0, 3, 4, 3]],
  L: [[0, 0, 0, 6, 4, 6]],
  '0': [[1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0]],
  '1': [[1, 1.2, 2.4, 0, 2.4, 6], [1, 6, 3.8, 6]],
  '2': [[0, 1, 1, 0, 3, 0, 4, 1, 4, 2.2, 0, 6, 4, 6]],
  '3': [[0, 0.8, 1, 0, 3, 0, 4, 1, 4, 2, 3, 3, 1.6, 3], [3, 3, 4, 4, 4, 5, 3, 6, 1, 6, 0, 5.2]],
  '4': [[3, 6, 3, 0, 0, 4, 4.2, 4]],
  '5': [[4, 0, 0.3, 0, 0, 3, 3, 2.8, 4, 3.8, 4, 5, 3, 6, 1, 6, 0, 5.2]],
  '6': [[3.6, 0.3, 3, 0, 1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 3, 3, 1, 3, 0, 4]],
  '7': [[0, 0, 4, 0, 1.6, 6]],
  '8': [[1, 3, 0, 2, 0, 1, 1, 0, 3, 0, 4, 1, 4, 2, 3, 3, 1, 3, 0, 4, 0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 3, 3]],
  '9': [[4, 2, 3, 3, 1, 3, 0, 2, 0, 1, 1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0.4, 5.7]],
};

/** Advance per character in design units. */
const ADVANCE = 5.6;

/**
 * Draw `text` centred at (cx, cy) with cap height `size` px and stroke `width` px into a layer.
 * Unknown characters are skipped (their advance is kept).
 */
export function drawText(layer: AlphaLayer, text: string, cx: number, cy: number, size: number, width: number, alpha: number): void {
  const k = size / 6;
  const total = (text.length - 1) * ADVANCE + 4;
  let ox = cx - 0.5 * total * k;
  const oy = cy - 3 * k;
  for (const ch of text) {
    const strokes = FONT[ch];
    if (strokes) {
      for (const s of strokes) {
        for (let i = 0; i + 3 < s.length; i += 2) {
          layer.segment(ox + s[i] * k, oy + s[i + 1] * k, ox + s[i + 2] * k, oy + s[i + 3] * k, width, alpha);
        }
      }
    }
    ox += ADVANCE * k;
  }
}
