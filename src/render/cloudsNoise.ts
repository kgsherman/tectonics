/**
 * Tileable 3D noise volume for the cloud layer (pure, DOM-free; shared by the globe shader, which
 * uploads it as an RGBA8 Data3DTexture with REPEAT wrapping, and by the CPU map/preview renderer).
 *
 * Every channel is periodic multi-octave B-spline noise: white noise on a coarse periodic lattice,
 * smoothed with the separable cubic B-spline (C² continuous, no gradient-noise grid creases). Channels:
 *  - R: two fbm octaves, lattice periods 4 and 8 per tile (amplitude ratio CLOUD_NOISE_GAIN). Only
 *    smooth content (≥ 8 voxels per lattice cell): the shader magnifies this texture a lot, and
 *    thresholding trilinearly interpolated near-Nyquist content would print the texel grid. The full
 *    cloud spectrum is built from several fetches at scale ratios of 4 (two octaves each);
 *  - G, B, A: three independent low-frequency fields (periods 3 and 6) used as a 3D domain-warp vector.
 * Each channel is normalized to mean 0.5 and standard deviation CLOUD_NOISE_STD (±3.2σ fills 0..255).
 */
import { Rng } from '../core/rng';

/** Voxels per tile edge. */
export const CLOUD_NOISE_SIZE = 64;
/** Standard deviation of every channel in [0, 1] texel units (mean 0.5). */
export const CLOUD_NOISE_STD = 127 / 3.2 / 255;
/** fbm amplitude ratio between successive octaves (fractal cloud edges, perimeter dimension ≈ 1.35). */
export const CLOUD_NOISE_GAIN = 0.55;

const SHAPE_PERIODS = [4, 8];
const WARP_PERIODS = [3, 6];

export interface CloudNoiseVolume {
  size: number;
  /** size³·4 bytes, x fastest, then y, then z. */
  data: Uint8Array;
}

/** Cubic B-spline weights for fractional position f. */
function bspline(f: number, w: Float64Array): void {
  const f2 = f * f, f3 = f2 * f;
  const g = 1 - f;
  w[0] = (g * g * g) / 6;
  w[1] = (3 * f3 - 6 * f2 + 4) / 6;
  w[2] = (-3 * f3 + 3 * f2 + 3 * f + 1) / 6;
  w[3] = f3 / 6;
}

/** Derivatives of the cubic B-spline weights with respect to f. */
function bsplineDeriv(f: number, w: Float64Array): void {
  const g = 1 - f;
  w[0] = -0.5 * g * g;
  w[1] = 1.5 * f * f - 2 * f;
  w[2] = -1.5 * f * f + f + 0.5;
  w[3] = 0.5 * f * f;
}

interface AxisWeights {
  idx: Int32Array;
  wts: Float64Array;
}

/** Per-voxel lattice indices and (derivative) weights along one axis (same for x, y, z). */
function axisWeights(size: number, L: number, deriv: boolean): AxisWeights {
  const idx = new Int32Array(size * 4);
  const wts = new Float64Array(size * 4);
  const w = new Float64Array(4);
  for (let v = 0; v < size; v++) {
    const t = ((v + 0.5) * L) / size - 0.5;
    const i = Math.floor(t);
    if (deriv) bsplineDeriv(t - i, w);
    else bspline(t - i, w);
    for (let k = 0; k < 4; k++) {
      idx[v * 4 + k] = (((i - 1 + k) % L) + L) % L;
      wts[v * 4 + k] = w[k];
    }
  }
  return { idx, wts };
}

/**
 * One periodic octave: `period` lattice cells per tile, B-spline smoothed to size³ voxels, added
 * with weight `amp` into `out` (size³ floats). Separable: x, then y, then z.
 */
function addOctave(out: Float32Array, size: number, period: number, amp: number, rng: Rng): void {
  const L = period;
  const g = new Float32Array(L * L * L);
  for (let i = 0; i < g.length; i++) g[i] = rng.next() * 2 - 1;
  const b = axisWeights(size, L, false);
  addSpline(out, g, size, L, amp, b, b, b);
}

/**
 * Adds amp · Σ g_ijk Bx(x − i) By(y − j) Bz(z − k) (per-axis weights: value or derivative) over the
 * periodic L³ lattice g into out (size³). Separable: x, then y, then z.
 */
function addSpline(
  out: Float32Array, g: Float32Array, size: number, L: number, amp: number, wx: AxisWeights, wy: AxisWeights, wz: AxisWeights,
): void {
  let { idx, wts } = wx;
  // Pass x: [lz][ly][x]
  const ax = new Float32Array(L * L * size);
  for (let lz = 0; lz < L; lz++) {
    for (let ly = 0; ly < L; ly++) {
      const src = (lz * L + ly) * L;
      const dst = (lz * L + ly) * size;
      for (let x = 0; x < size; x++) {
        const o = x * 4;
        ax[dst + x] = wts[o] * g[src + idx[o]] + wts[o + 1] * g[src + idx[o + 1]]
          + wts[o + 2] * g[src + idx[o + 2]] + wts[o + 3] * g[src + idx[o + 3]];
      }
    }
  }
  // Pass y: [lz][y][x]
  ({ idx, wts } = wy);
  const ay = new Float32Array(L * size * size);
  for (let lz = 0; lz < L; lz++) {
    for (let y = 0; y < size; y++) {
      const o = y * 4;
      const s0 = (lz * L + idx[o]) * size, s1 = (lz * L + idx[o + 1]) * size;
      const s2 = (lz * L + idx[o + 2]) * size, s3 = (lz * L + idx[o + 3]) * size;
      const w0 = wts[o], w1 = wts[o + 1], w2 = wts[o + 2], w3 = wts[o + 3];
      const dst = (lz * size + y) * size;
      for (let x = 0; x < size; x++) ay[dst + x] = w0 * ax[s0 + x] + w1 * ax[s1 + x] + w2 * ax[s2 + x] + w3 * ax[s3 + x];
    }
  }
  // Pass z: [z][y][x]
  ({ idx, wts } = wz);
  const plane = size * size;
  for (let z = 0; z < size; z++) {
    const o = z * 4;
    const s0 = idx[o] * plane, s1 = idx[o + 1] * plane, s2 = idx[o + 2] * plane, s3 = idx[o + 3] * plane;
    const w0 = wts[o] * amp, w1 = wts[o + 1] * amp, w2 = wts[o + 2] * amp, w3 = wts[o + 3] * amp;
    const dst = z * plane;
    for (let i = 0; i < plane; i++) out[dst + i] += w0 * ay[s0 + i] + w1 * ay[s1 + i] + w2 * ay[s2 + i] + w3 * ay[s3 + i];
  }
}

/** Normalizes `f` to mean 0.5 / std CLOUD_NOISE_STD and writes it into channel `ch` of `rgba`. */
function writeChannel(f: Float32Array, rgba: Uint8Array, ch: number): void {
  let s = 0, s2 = 0;
  for (let i = 0; i < f.length; i++) {
    s += f[i];
    s2 += f[i] * f[i];
  }
  const mean = s / f.length;
  const sd = Math.sqrt(Math.max(1e-12, s2 / f.length - mean * mean));
  const k = (CLOUD_NOISE_STD * 255) / sd;
  for (let i = 0; i < f.length; i++) {
    const v = 127.5 + (f[i] - mean) * k;
    rgba[4 * i + ch] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
}

/** Builds the volume (deterministic for a seed; ~20–40 ms for 64³). */
export function buildCloudNoiseVolume(size = CLOUD_NOISE_SIZE, seed = 0xc10d5): CloudNoiseVolume {
  const rng = new Rng(seed);
  const data = new Uint8Array(size * size * size * 4);
  const f = new Float32Array(size * size * size);
  let amp = 1;
  for (const p of SHAPE_PERIODS) {
    if (p * 2 > size) break;
    addOctave(f, size, p, amp, rng);
    amp *= CLOUD_NOISE_GAIN;
  }
  writeChannel(f, data, 0);
  for (let ch = 1; ch < 4; ch++) {
    f.fill(0);
    let a = 1;
    for (const p of WARP_PERIODS) {
      addOctave(f, size, p, a, rng);
      a *= 0.5;
    }
    writeChannel(f, data, ch);
  }
  return { size, data };
}

let shared: CloudNoiseVolume | null = null;

/** Lazily built shared volume (the globe texture and the map rasterizer use the same one). */
export function cloudNoiseVolume(): CloudNoiseVolume {
  shared ??= buildCloudNoiseVolume();
  return shared;
}

/* ------------------------------------------------------------------ */
/* Detail volume (value + analytic gradient)                           */
/* ------------------------------------------------------------------ */

/** Voxels per tile edge of the detail volume. */
export const CLOUD_DETAIL_SIZE = 64;
/**
 * Lattice cells per tile of the detail volume: 4 voxels per cell, so one fetch carries crisp
 * content (one octave) while trilinear reconstruction stays smooth, and a tile spans 16 features
 * (the finest fetches repeat far less visibly than the 8-cell shape tile).
 */
export const CLOUD_DETAIL_PERIOD = 16;
/**
 * Gradient encoding: byte = 127.5 + 255·CLOUD_DETAIL_GRAD_K·g, with g = ∂n/∂(lattice cell) of the
 * normalized value n (σ units); ±5 σ per cell fills the byte range (the gradient's std is ≈ 1.2).
 */
export const CLOUD_DETAIL_GRAD_K = 0.1;

/**
 * Tileable detail noise (deterministic for a seed; ~60–120 ms for 64³, build it off the main thread):
 * one octave of periodic B-spline noise (CLOUD_DETAIL_PERIOD cells per tile) with its analytic
 * gradient. R: value (mean 0.5, std CLOUD_NOISE_STD); G, B, A: ∂/∂x, ∂/∂y, ∂/∂z per lattice cell in
 * σ units (see CLOUD_DETAIL_GRAD_K). The globe uses the gradient for cloud-top lighting (no
 * screen-space derivatives: they shade pixel-scale detail in 2×2 blocks) and to warp finer fetches.
 */
export function buildCloudDetailVolume(size = CLOUD_DETAIL_SIZE, period = CLOUD_DETAIL_PERIOD, seed = 0xde7a11): CloudNoiseVolume {
  const rng = new Rng(seed);
  const L = period;
  const g = new Float32Array(L * L * L);
  for (let i = 0; i < g.length; i++) g[i] = rng.next() * 2 - 1;
  const b = axisWeights(size, L, false), d = axisWeights(size, L, true);
  const n = size * size * size;
  const v = new Float32Array(n), gx = new Float32Array(n), gy = new Float32Array(n), gz = new Float32Array(n);
  addSpline(v, g, size, L, 1, b, b, b);
  addSpline(gx, g, size, L, 1, d, b, b);
  addSpline(gy, g, size, L, 1, b, d, b);
  addSpline(gz, g, size, L, 1, b, b, d);
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    s += v[i];
    s2 += v[i] * v[i];
  }
  const mean = s / n;
  const sd = Math.sqrt(Math.max(1e-12, s2 / n - mean * mean));
  const data = new Uint8Array(n * 4);
  const kv = (CLOUD_NOISE_STD * 255) / sd, kg = (CLOUD_DETAIL_GRAD_K * 255) / sd;
  const q = (x: number): number => (x < 0 ? 0 : x > 255 ? 255 : Math.round(x));
  for (let i = 0; i < n; i++) {
    const o = 4 * i;
    data[o] = q(127.5 + (v[i] - mean) * kv);
    data[o + 1] = q(127.5 + gx[i] * kg);
    data[o + 2] = q(127.5 + gy[i] * kg);
    data[o + 3] = q(127.5 + gz[i] * kg);
  }
  return { size, data };
}

/* ------------------------------------------------------------------ */
/* Cell volume (Worley)                                                */
/* ------------------------------------------------------------------ */

/** Voxels per tile edge of the cell volume. */
export const CLOUD_CELL_SIZE = 64;
/** Jittered feature points per tile edge (8 voxels per cell). */
export const CLOUD_CELL_PERIOD = 8;
/** F2 − F1 (in cell units) that maps to byte 255 in the R channel. */
export const CLOUD_CELL_EDGE_RANGE = 0.6;

/**
 * Tileable cellular (Worley) noise for mesoscale cellular convection (deterministic; ~40–80 ms for
 * 64³, build it off the main thread). One jittered feature point per lattice cell, periodic.
 * R: F2 − F1 (distance to the cell border, 0 on it; cell units / CLOUD_CELL_EDGE_RANGE, clamped),
 * G: F1 (distance to the cell's centre, cell units / 1.2), B: a random value per cell (brightness
 * variation between cells), A: unused (0). Slices of 3D Voronoi cells are convex polygons: the
 * honeycomb of closed stratocumulus cells and the rings of open cells.
 */
export function buildCloudCellVolume(size = CLOUD_CELL_SIZE, period = CLOUD_CELL_PERIOD, seed = 0xce11): CloudNoiseVolume {
  const rng = new Rng(seed);
  const P = period;
  const pts = new Float32Array(P * P * P * 3);
  const ids = new Float32Array(P * P * P);
  for (let i = 0; i < P * P * P; i++) {
    pts[3 * i] = 0.1 + 0.8 * rng.next();
    pts[3 * i + 1] = 0.1 + 0.8 * rng.next();
    pts[3 * i + 2] = 0.1 + 0.8 * rng.next();
    ids[i] = rng.next();
  }
  const data = new Uint8Array(size * size * size * 4);
  const scale = P / size;
  for (let z = 0; z < size; z++) {
    const pz = (z + 0.5) * scale, cz = Math.floor(pz);
    for (let y = 0; y < size; y++) {
      const py = (y + 0.5) * scale, cy = Math.floor(py);
      for (let x = 0; x < size; x++) {
        const px = (x + 0.5) * scale, cx = Math.floor(px);
        let f1 = 1e9, f2 = 1e9, id1 = 0;
        for (let dz = -1; dz <= 1; dz++) {
          const kz = cz + dz, wz = ((kz % P) + P) % P;
          for (let dy = -1; dy <= 1; dy++) {
            const ky = cy + dy, wy = ((ky % P) + P) % P;
            for (let dx = -1; dx <= 1; dx++) {
              const kx = cx + dx, wx = ((kx % P) + P) % P;
              const c = (wz * P + wy) * P + wx;
              const ex = kx + pts[3 * c] - px, ey = ky + pts[3 * c + 1] - py, ez = kz + pts[3 * c + 2] - pz;
              const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
              if (d < f1) {
                f2 = f1;
                f1 = d;
                id1 = ids[c];
              } else if (d < f2) {
                f2 = d;
              }
            }
          }
        }
        const o = 4 * ((z * size + y) * size + x);
        data[o] = Math.min(255, Math.round((255 * (f2 - f1)) / CLOUD_CELL_EDGE_RANGE));
        data[o + 1] = Math.min(255, Math.round((255 * f1) / 1.2));
        data[o + 2] = Math.round(255 * id1);
      }
    }
  }
  return { size, data };
}

let sharedCells: CloudNoiseVolume | null = null;

/** Lazily built shared cell volume (prefer receiving it from the cloud worker in the browser). */
export function cloudCellVolume(): CloudNoiseVolume {
  sharedCells ??= buildCloudCellVolume();
  return sharedCells;
}

let sharedDetail: CloudNoiseVolume | null = null;

/** Lazily built shared detail volume (prefer receiving it from the cloud worker in the browser). */
export function cloudDetailVolume(): CloudNoiseVolume {
  sharedDetail ??= buildCloudDetailVolume();
  return sharedDetail;
}

/** Installs a detail volume built elsewhere (e.g. by the cloud worker) as the shared one. */
export function setCloudDetailVolume(vol: CloudNoiseVolume): void {
  sharedDetail = vol;
}

/** Installs a shape/warp volume built elsewhere (e.g. by the cloud worker) as the shared one. */
export function setCloudNoiseVolume(vol: CloudNoiseVolume): void {
  shared = vol;
}

/** The shared volumes if already built (no work). */
export function peekCloudVolumes(): { noise: CloudNoiseVolume | null; detail: CloudNoiseVolume | null } {
  return { noise: shared, detail: sharedDetail };
}

/** Trilinear sample of channel R only (see sampleCloudNoise). */
export function sampleCloudNoiseR(vol: CloudNoiseVolume, x: number, y: number, z: number): number {
  const n = vol.size, d = vol.data;
  const fx = x * n - 0.5, fy = y * n - 0.5, fz = z * n - 0.5;
  const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
  const tx = fx - ix, ty = fy - iy, tz = fz - iz;
  const m = n - 1;
  const x0 = ix & m, x1 = (ix + 1) & m, y0 = (iy & m) * n, y1 = ((iy + 1) & m) * n;
  const z0 = (iz & m) * n * n, z1 = ((iz + 1) & m) * n * n;
  const a = d[4 * (z0 + y0 + x0)] + tx * (d[4 * (z0 + y0 + x1)] - d[4 * (z0 + y0 + x0)]);
  const b = d[4 * (z0 + y1 + x0)] + tx * (d[4 * (z0 + y1 + x1)] - d[4 * (z0 + y1 + x0)]);
  const c = d[4 * (z1 + y0 + x0)] + tx * (d[4 * (z1 + y0 + x1)] - d[4 * (z1 + y0 + x0)]);
  const e = d[4 * (z1 + y1 + x0)] + tx * (d[4 * (z1 + y1 + x1)] - d[4 * (z1 + y1 + x0)]);
  const ab = a + ty * (b - a), ce = c + ty * (e - c);
  return (ab + tz * (ce - ab)) / 255;
}

/**
 * Trilinear sample of all four channels at tile coordinates (x, y, z) (1 unit = one tile; wraps),
 * matching the GPU's REPEAT + LINEAR filtering with texel centres at (i + 0.5)/size.
 * Writes [0, 1] values to out[0..3].
 */
export function sampleCloudNoise(vol: CloudNoiseVolume, x: number, y: number, z: number, out: Float32Array | number[]): void {
  const n = vol.size, d = vol.data;
  const fx = x * n - 0.5, fy = y * n - 0.5, fz = z * n - 0.5;
  const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
  const tx = fx - ix, ty = fy - iy, tz = fz - iz;
  const m = n - 1; // n is a power of two
  const x0 = ix & m, x1 = (ix + 1) & m, y0 = (iy & m) * n, y1 = ((iy + 1) & m) * n;
  const z0 = (iz & m) * n * n, z1 = ((iz + 1) & m) * n * n;
  const i000 = 4 * (z0 + y0 + x0), i100 = 4 * (z0 + y0 + x1), i010 = 4 * (z0 + y1 + x0), i110 = 4 * (z0 + y1 + x1);
  const i001 = 4 * (z1 + y0 + x0), i101 = 4 * (z1 + y0 + x1), i011 = 4 * (z1 + y1 + x0), i111 = 4 * (z1 + y1 + x1);
  const w000 = (1 - tx) * (1 - ty) * (1 - tz), w100 = tx * (1 - ty) * (1 - tz), w010 = (1 - tx) * ty * (1 - tz), w110 = tx * ty * (1 - tz);
  const w001 = (1 - tx) * (1 - ty) * tz, w101 = tx * (1 - ty) * tz, w011 = (1 - tx) * ty * tz, w111 = tx * ty * tz;
  for (let c = 0; c < 4; c++) {
    out[c] = (w000 * d[i000 + c] + w100 * d[i100 + c] + w010 * d[i010 + c] + w110 * d[i110 + c]
      + w001 * d[i001 + c] + w101 * d[i101 + c] + w011 * d[i011 + c] + w111 * d[i111 + c]) / 255;
  }
}
