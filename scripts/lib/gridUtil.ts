/** Small lat-lon grid helpers shared by the headless scripts (row 0 = north, see SPEC §2). */

const DEG = Math.PI / 180;

/** Latitude (degrees) of the center of row r in an h-row grid. */
export const rowLatDeg = (h: number, r: number): number => 90 - ((r + 0.5) * 180) / h;

/** Relative cell area (cos φ) per row. */
export function rowAreaWeights(h: number): Float64Array {
  const wts = new Float64Array(h);
  for (let r = 0; r < h; r++) wts[r] = Math.cos(rowLatDeg(h, r) * DEG);
  return wts;
}

/** Area-weighted mean of a w×h field (optionally restricted by a weight/mask per cell). */
export function areaMean(field: ArrayLike<number>, w: number, h: number, mask?: ArrayLike<number>): number {
  const aw = rowAreaWeights(h);
  let s = 0, a = 0;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const m = mask ? mask[i] : 1;
      if (!m) continue;
      s += aw[r] * m * field[i];
      a += aw[r] * m;
    }
  }
  return a > 0 ? s / a : NaN;
}

/** One month (0..11) of a 12·w·h monthly field as a view, or the annual mean (month < 0) as a copy. */
export function monthSlice(field: Float32Array, n: number, month: number): Float32Array {
  if (month >= 0) return field.subarray(month * n, (month + 1) * n);
  const out = new Float32Array(n);
  for (let m = 0; m < 12; m++) {
    const o = m * n;
    for (let i = 0; i < n; i++) out[i] += field[o + i] / 12;
  }
  return out;
}

/** Nearest-cell resample of a w×h grid to W×H (categorical-safe). */
export function resampleNearest<T extends Float32Array | Uint8Array | Int32Array>(field: T, w: number, h: number, W: number, H: number): T {
  const Ctor = field.constructor as { new (n: number): T };
  const out = new Ctor(W * H);
  for (let y = 0; y < H; y++) {
    const r = Math.min(h - 1, Math.floor(((y + 0.5) * h) / H));
    for (let x = 0; x < W; x++) {
      const c = Math.min(w - 1, Math.floor(((x + 0.5) * w) / W));
      out[y * W + x] = field[r * w + c];
    }
  }
  return out;
}

/** Nearest cell index of (lat, lon) degrees on a w×h grid. */
export function cellAt(w: number, h: number, latDeg: number, lonDeg: number): number {
  let r = Math.floor(((90 - latDeg) / 180) * h);
  if (r < 0) r = 0;
  else if (r >= h) r = h - 1;
  let c = Math.floor(((lonDeg + 180) / 360) * w) % w;
  if (c < 0) c += w;
  return r * w + c;
}

/** Parse "WxH" (e.g. "1024x512"), or a bare width "W" meaning W×(W/2) (equirectangular). */
export function parseSize(s: string): [number, number] {
  const t = s.trim();
  const single = /^(\d+)$/.exec(t);
  if (single) {
    const w = Number(single[1]);
    if (w >= 2) return [w, Math.max(1, Math.round(w / 2))];
  }
  const m = /^(\d+)x(\d+)$/i.exec(t);
  if (!m) throw new Error(`bad size "${s}" (expected WxH, e.g. 1024x512, or a width W for W×W/2)`);
  return [Number(m[1]), Number(m[2])];
}
