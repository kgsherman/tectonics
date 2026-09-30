/**
 * Fast editor preview raster (SPEC §9): equirectangular RGBA where every pixel shows its nearest
 * mesh cell. A cell → pixel inverse index lets edits recolor only the pixels of changed cells, and
 * plate boundaries are drawn in the same pass (pixel edges between different plates, coloured by
 * boundary type), so a brush dab costs well under a millisecond. Pure: no DOM.
 */
import { gridLat, gridLon } from '../core/grid';
import { nearestCell } from '../core/sphereMesh';
import type { PlateSpec, RGB, SphereMesh } from '../core/types';
import { BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT, BOUNDARY_NONE, BOUNDARY_TRANSFORM } from '../core/types';
import { CM_BATHY, CM_HYPSO, cmapIndex } from '../render/colormaps';

export type PreviewStyle = 'plates' | 'relief';

/** Boundary line colours (same hues as the painter's boundary overlay). */
export const PREVIEW_BOUNDARY_COLORS: Record<number, RGB> = {
  [BOUNDARY_NONE]: [30, 34, 40],
  [BOUNDARY_CONVERGENT]: [236, 64, 52],
  [BOUNDARY_DIVERGENT]: [250, 212, 60],
  [BOUNDARY_TRANSFORM]: [240, 240, 240],
};

export interface PreviewSource {
  plate: Int16Array;
  crust: Uint8Array;
  elev: Float32Array;
  /** BOUNDARY_* per cell. */
  boundary: Uint8Array;
  plates: PlateSpec[];
  seaLevel: number;
  style: PreviewStyle;
  /** Optional per-cell highlight (tool paths); non-zero = highlighted. */
  highlight?: Uint8Array | null;
}

function smooth(a: number, b: number, x: number): number {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/** Nearest mesh cell for every pixel of a w×h equirectangular grid (row 0 = north). */
export function buildNearestMap(mesh: SphereMesh, w: number, h: number): Int32Array {
  const out = new Int32Array(w * h);
  const cosLon = new Float64Array(w), sinLon = new Float64Array(w);
  for (let c = 0; c < w; c++) {
    const lo = gridLon(w, c);
    cosLon[c] = Math.cos(lo);
    sinLon[c] = Math.sin(lo);
  }
  let rowHint = 0;
  for (let r = 0; r < h; r++) {
    const la = gridLat(h, r);
    const cl = Math.cos(la), sl = Math.sin(la);
    let hint = rowHint;
    for (let c = 0; c < w; c++) {
      hint = nearestCell(mesh, cl * cosLon[c], cl * sinLon[c], sl, hint);
      if (c === 0) rowHint = hint;
      out[r * w + c] = hint;
    }
  }
  return out;
}

export class PreviewRaster {
  readonly w: number;
  readonly h: number;
  /** Opaque RGBA, row 0 = north. Updated in place. */
  readonly rgba: Uint8ClampedArray;
  /** Pixel → nearest cell. */
  readonly nearest: Int32Array;
  private readonly pixOff: Int32Array;
  private readonly pixList: Int32Array;
  private readonly stamp: Int32Array;
  private readonly pixStamp: Int32Array;
  private gen = 0;
  private ring = new Int32Array(4096);
  private readonly col = new Uint8Array(3);

  constructor(mesh: SphereMesh, w: number, h: number, nearest?: Int32Array) {
    if (!(Number.isInteger(w) && Number.isInteger(h) && w >= 8 && h >= 4)) throw new Error(`PreviewRaster: bad size ${w}×${h}`);
    if (nearest && nearest.length !== w * h) throw new Error('PreviewRaster: nearest map has the wrong size');
    this.w = w;
    this.h = h;
    this.rgba = new Uint8ClampedArray(4 * w * h);
    this.nearest = nearest ?? buildNearestMap(mesh, w, h);
    // CSR inverse: cell → its pixels.
    const n = mesh.n;
    const off = new Int32Array(n + 1);
    for (let p = 0; p < w * h; p++) off[this.nearest[p] + 1]++;
    for (let i = 0; i < n; i++) off[i + 1] += off[i];
    const fill = off.slice(0, n);
    const list = new Int32Array(w * h);
    for (let p = 0; p < w * h; p++) list[fill[this.nearest[p]]++] = p;
    this.pixOff = off;
    this.pixList = list;
    this.stamp = new Int32Array(n);
    this.pixStamp = new Int32Array(w * h);
  }

  /** Repaint every pixel. */
  renderAll(src: PreviewSource): void {
    const lut = plateLut(src.plates);
    const { nearest } = this;
    let prevCell = -1;
    for (let p = 0; p < nearest.length; p++) {
      const i = nearest[p];
      if (i !== prevCell) {
        this.cellColor(src, lut, i);
        prevCell = i;
      }
      this.writePixel(src, p, i);
    }
  }

  /**
   * Repaint the pixels of the given cells (each at most once) and every pixel 4-adjacent to them:
   * a pixel's boundary line depends on the plates of its neighbouring pixels, whose cells are not
   * always mesh neighbours of its own cell. Callers pass changed cells plus their mesh 1-ring
   * (whose boundary classes may have changed).
   */
  renderCells(src: PreviewSource, cells: ArrayLike<number>, count = cells.length): void {
    const lut = plateLut(src.plates);
    this.gen++;
    if (this.gen >= 0x7fffffff) {
      this.stamp.fill(0);
      this.pixStamp.fill(0);
      this.gen = 1;
    }
    const g = this.gen;
    const { w, h, pixList, pixOff, pixStamp } = this;
    let ring = this.ring;
    let nr = 0;
    for (let k = 0; k < count; k++) {
      const i = cells[k];
      if (this.stamp[i] === g) continue;
      this.stamp[i] = g;
      this.cellColor(src, lut, i);
      for (let q = pixOff[i]; q < pixOff[i + 1]; q++) {
        const p = pixList[q];
        this.writePixel(src, p, i);
        pixStamp[p] = g;
        if (nr + 4 > ring.length) ring = this.ring = growInt32(ring, nr + 4);
        const r = (p / w) | 0, c = p - r * w;
        ring[nr++] = c > 0 ? p - 1 : p + w - 1;
        ring[nr++] = c < w - 1 ? p + 1 : p - w + 1;
        ring[nr++] = r > 0 ? p - w : p;
        ring[nr++] = r < h - 1 ? p + w : p;
      }
    }
    let prevCell = -1;
    for (let k = 0; k < nr; k++) {
      const p = ring[k];
      if (pixStamp[p] === g) continue;
      pixStamp[p] = g;
      const i = this.nearest[p];
      if (i !== prevCell) {
        this.cellColor(src, lut, i);
        prevCell = i;
      }
      this.writePixel(src, p, i);
    }
  }

  /** Number of pixels showing cell i. */
  pixelCount(i: number): number {
    return this.pixOff[i + 1] - this.pixOff[i];
  }

  /** Base colour of cell i into this.col. */
  private cellColor(src: PreviewSource, lut: Uint8Array, i: number): void {
    const k = src.plate[i];
    const last = lut.length / 3 - 1;
    const kk = k >= 0 && k < last ? k : last;
    let r = lut[3 * kk], g = lut[3 * kk + 1], b = lut[3 * kk + 2];
    const e = src.elev[i] - src.seaLevel;
    if (src.style === 'plates') {
      if (e > 0) {
        // Land: lighter, brighter with altitude (matches the painter's plates layer).
        const t = 0.22 + 0.18 * smooth(0, 4000, e);
        r += (255 - r) * t;
        g += (255 - g) * t;
        b += (255 - b) * t;
      } else {
        const f = 0.72 - 0.22 * smooth(0, 5000, -e);
        r *= f;
        g *= f;
        b *= f;
      }
    } else {
      // Relief: the painter's hypsometric / bathymetric tints (plates are told apart by boundary
      // lines only, exactly like the full-quality elevation render that replaces this preview).
      const cm = e > 0 ? CM_HYPSO : CM_BATHY;
      const o = 3 * cmapIndex(cm, e > 0 ? e : -e);
      r = cm.lut[o];
      g = cm.lut[o + 1];
      b = cm.lut[o + 2];
    }
    if (src.highlight && src.highlight[i]) {
      r += (255 - r) * 0.75;
      g += (255 - g) * 0.75;
      b += (255 - b) * 0.75;
    }
    this.col[0] = r;
    this.col[1] = g;
    this.col[2] = b;
  }

  /** Write pixel p of cell i: the cell colour, or a boundary line where a 4-neighbour pixel is on another plate. */
  private writePixel(src: PreviewSource, p: number, i: number): void {
    const { w, h, nearest } = this;
    const plate = src.plate;
    const a = plate[i];
    const r = (p / w) | 0;
    const c = p - r * w;
    let other = -1;
    const left = c > 0 ? p - 1 : p + w - 1;
    const right = c < w - 1 ? p + 1 : p - w + 1;
    if (plate[nearest[left]] !== a) other = nearest[left];
    else if (plate[nearest[right]] !== a) other = nearest[right];
    else if (r > 0 && plate[nearest[p - w]] !== a) other = nearest[p - w];
    else if (r < h - 1 && plate[nearest[p + w]] !== a) other = nearest[p + w];
    const o = 4 * p;
    const out = this.rgba;
    if (other < 0) {
      out[o] = this.col[0];
      out[o + 1] = this.col[1];
      out[o + 2] = this.col[2];
    } else {
      let cls = src.boundary[i];
      if (cls === BOUNDARY_NONE) cls = src.boundary[other];
      const bc = PREVIEW_BOUNDARY_COLORS[cls] ?? PREVIEW_BOUNDARY_COLORS[BOUNDARY_NONE];
      const t = 0.88;
      out[o] = this.col[0] * (1 - t) + bc[0] * t;
      out[o + 1] = this.col[1] * (1 - t) + bc[1] * t;
      out[o + 2] = this.col[2] * (1 - t) + bc[2] * t;
    }
    out[o + 3] = 255;
  }
}

function growInt32(a: Int32Array, min: number): Int32Array<ArrayBuffer> {
  const b = new Int32Array(Math.max(min, 2 * a.length));
  b.set(a);
  return b;
}

/** Plate colours as a flat LUT with a trailing neutral grey for invalid indices. */
function plateLut(plates: PlateSpec[]): Uint8Array {
  const lut = new Uint8Array(3 * (plates.length + 1));
  for (let k = 0; k < plates.length; k++) lut.set(plates[k].color, 3 * k);
  lut.set([128, 128, 128], 3 * plates.length);
  return lut;
}
