/**
 * Third polish pass of the satellite painter (painter): organic vegetation / snow mosaics with no
 * grid structure at any scale, and plausible high plateaus.
 *  - no climate-grid structure: the thresholded attributes are C² (cubic B-spline) fields sampled
 *    through a C¹ domain warp — no creases along climate-cell or warp-raster lines — and a climate
 *    whose attributes jump from cell to cell adds no spectral energy at the climate-cell frequency;
 *  - mosaic edges are anti-aliased (patch scores are smooth at the pixel scale; thresholds are
 *    widened by the thermal sweep on steep ground): few hard one-pixel steps, on plains and on
 *    rugged snowy mountains alike;
 *  - the valley-line field (drainage network) is drawn from smoothed polylines, not from runs of
 *    routing cells (no axis-aligned staircase);
 *  - continental interiors stay green into early summer (snowmelt and soil moisture), Mediterranean
 *    summers turn golden;
 *  - deep pits of rugged plateaus hold small lakes (incised outlets); dry high plateaus read as brown
 *    alpine steppe rather than dark wet tundra.
 */
import { describe, expect, it } from 'vitest';
import { classifyKoppen } from '../src/climate/koppen';
import { buildMeshGridMap, gridLat, meshToGrid, resampleGrid } from '../src/core/grid';
import type { ClimateResult, PaintOptions, WorldSnapshot } from '../src/core/types';
import { CRUST_CONTINENTAL, CRUST_OCEANIC } from '../src/core/types';
import { PaintCache, paintHeightMap, paintLayer } from '../src/render/paint';
import { drainageLines } from '../src/render/rivers';
import { routeDrainage } from '../src/render/riversRoute';
import { A_COVER, A_GRASS, LAND_K, buildSatelliteGrid, satelliteClimateOf } from '../src/render/satelliteBiome';
import type { SatelliteClimate } from '../src/render/satelliteBiome';
import { PX_COVER, PX_K, fillLand } from '../src/render/satellitePixels';
import { getClimateSampler } from '../src/render/satelliteSampler';
import { detailTexture, getHeightField, heightFieldKey } from '../src/render/terrain';
import { smallMesh, syntheticSnapshot, zonalClimate } from './helpers/fixtures';

const mesh = smallMesh(20000);
const W = 1024, H = 512;

function opts(over: Partial<PaintOptions> = {}): PaintOptions {
  return { width: W, height: H, month: 6, seaLevel: 0, hillshade: false, seed: 4, quality: 'full', rivers: false, ...over };
}

function angle(lat: number, lon: number, lat0: number, lon0: number): number {
  const c = Math.sin(lat) * Math.sin(lat0) + Math.cos(lat) * Math.cos(lat0) * Math.cos(lon - lon0);
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

/** Snapshot with an elevation (and optional orogeny) function of (lat, lon). */
function worldFrom(id: number, elevAt: (lat: number, lon: number) => number, oro?: (lat: number, lon: number) => number): WorldSnapshot {
  const base = syntheticSnapshot(mesh, 3, 4);
  const n = mesh.n;
  const elev = new Float32Array(n), crust = new Uint8Array(n), orogeny = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    elev[i] = elevAt(mesh.lat[i], mesh.lon[i]);
    crust[i] = elev[i] > -1000 ? CRUST_CONTINENTAL : CRUST_OCEANIC;
    orogeny[i] = oro ? oro(mesh.lat[i], mesh.lon[i]) : 0;
  }
  return { ...base, id, elev, crust, orogeny, age: new Float32Array(n).fill(300) };
}

/**
 * Fixture climate (180×90) with prescribed monthly sea-level temperature and precipitation per
 * cell (lapsed to the cell's own land surface, as the model reports it); Köppen recomputed.
 */
function climateWith(snap: WorldSnapshot, tAt: (i: number, lat: number, m: number) => number, pAt: (i: number, lat: number, m: number) => number, id: number): ClimateResult {
  const w = 180, h = 90;
  const map = buildMeshGridMap(mesh, 4 * w, 4 * h);
  const c = structuredClone(zonalClimate(w, h, resampleGrid(meshToGrid(map, snap.elev), 4 * w, 4 * h, w, h)));
  const N = w * h;
  const tt = new Float32Array(12), pp = new Float32Array(12);
  for (let i = 0; i < N; i++) {
    const lat = (gridLat(h, Math.floor(i / w)) * 180) / Math.PI;
    for (let m = 0; m < 12; m++) {
      tt[m] = tAt(i, lat, m);
      pp[m] = pAt(i, lat, m);
    }
    const lapse = c.land[i] ? 0.0065 * Math.max(0, c.elev[i]) : 0;
    let ta = 0, pa = 0;
    for (let m = 0; m < 12; m++) {
      c.temp[m * N + i] = tt[m] - lapse;
      c.precip[m * N + i] = pp[m];
      c.evap[m * N + i] = Math.min(pp[m] * 0.6, Math.max(0, tt[m]) * 5);
      ta += tt[m] - lapse;
      pa += pp[m];
    }
    c.tempAnnual[i] = ta / 12;
    c.precipAnnual[i] = pa;
    const k = classifyKoppen(tt, pp, lat < 0);
    c.koppenAll[i] = k;
    c.koppen[i] = c.land[i] ? k : 0;
  }
  return { ...c, id };
}

/** Per-cell hash in [0, 1). */
function hash01(i: number): number {
  let h = Math.imul(i ^ 0x5bd1e995, 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

const lum = (a: Uint8ClampedArray, p: number) => 0.2126 * a[4 * p] + 0.7152 * a[4 * p + 1] + 0.0722 * a[4 * p + 2];

// ---- spectra -----------------------------------------------------------------------------------

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + half] * cr - im[i + k + half] * ci, vi = re[i + k + half] * ci + im[i + k + half] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Power spectrum of a Hann-windowed, mean-removed N×N luminance crop at (x0, y0). */
function power(L: Float32Array, x0: number, y0: number, N: number): Float64Array {
  const re = new Float64Array(N * N), im = new Float64Array(N * N);
  let mean = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) mean += L[(y0 + y) * W + ((x0 + x) % W)];
  mean /= N * N;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const hw = (0.5 - 0.5 * Math.cos((2 * Math.PI * (x + 0.5)) / N)) * (0.5 - 0.5 * Math.cos((2 * Math.PI * (y + 0.5)) / N));
      re[y * N + x] = (L[(y0 + y) * W + ((x0 + x) % W)] - mean) * hw;
    }
  }
  const rr = new Float64Array(N), ri = new Float64Array(N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) { rr[x] = re[y * N + x]; ri[x] = im[y * N + x]; }
    fft(rr, ri);
    for (let x = 0; x < N; x++) { re[y * N + x] = rr[x]; im[y * N + x] = ri[x]; }
  }
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) { rr[y] = re[y * N + x]; ri[y] = im[y * N + x]; }
    fft(rr, ri);
    for (let y = 0; y < N; y++) { re[y * N + x] = rr[y]; im[y * N + x] = ri[y]; }
  }
  const P = new Float64Array(N * N);
  for (let i = 0; i < N * N; i++) P[i] = re[i] * re[i] + im[i] * im[i];
  return P;
}

/**
 * Spectral bump at frequency fc (cycles per crop): mean power in the ring fc·[0.9, 1.1] over the
 * geometric mean of the rings fc·[0.65, 0.8] and fc·[1.25, 1.5] (≈ 1 for a smooth spectrum); with
 * axisOnly, only frequencies within 12° of the image axes (grid-aligned squares).
 */
function bump(P: Float64Array, N: number, fc: number, axisOnly: boolean): number {
  const ring = (lo: number, hi: number) => {
    let s = 0, n = 0;
    for (let v = 0; v < N; v++) {
      for (let u = 0; u < N; u++) {
        const fu = u < N / 2 ? u : u - N, fv = v < N / 2 ? v : v - N;
        const r = Math.hypot(fu, fv);
        if (r < lo * fc || r > hi * fc) continue;
        if (axisOnly) {
          const a = Math.atan2(Math.abs(fv), Math.abs(fu));
          if (Math.min(a, Math.PI / 2 - a) > (12 * Math.PI) / 180) continue;
        }
        s += P[v * N + u];
        n++;
      }
    }
    return s / Math.max(1, n);
  };
  return ring(0.9, 1.1) / Math.sqrt(ring(0.65, 0.8) * ring(1.25, 1.5));
}

/**
 * Hard pixel steps: neighbour luminance jumps above `hi` per jump above `lo` (edges), over land
 * pixels (both neighbours land) in rows r0..r1.
 */
function hardSteps(a: Uint8ClampedArray, hm: Float32Array, lo: number, hi: number, r0 = 1, r1 = H - 2): number {
  let big = 0, edge = 0;
  for (let r = r0; r < r1; r++) {
    for (let c = 0; c < W - 1; c++) {
      const p = r * W + c;
      if (!(hm[p] > 0 && hm[p + 1] > 0 && hm[p + W] > 0)) continue;
      const L = lum(a, p);
      for (const d of [Math.abs(lum(a, p + 1) - L), Math.abs(lum(a, p + W) - L)]) {
        if (d > lo) edge++;
        if (d > hi) big++;
      }
    }
  }
  expect(edge).toBeGreaterThan(1000);
  return big / edge;
}

// ---- tests -------------------------------------------------------------------------------------

/** p99 / mean of |second differences| (spikes = gradient kinks). */
function kinkiness(v: ArrayLike<number>): number {
  const d: number[] = [];
  for (let i = 1; i + 1 < v.length; i++) d.push(Math.abs(v[i - 1] - 2 * v[i] + v[i + 1]));
  d.sort((a, b) => a - b);
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  return d[Math.floor(0.99 * d.length)] / mean;
}

describe('vegetation mosaics are organic: no grid structure, anti-aliased edges', () => {
  // All-land 500 m continent; warm tropics everywhere; precipitation jumps from cell to cell
  // (semi-arid savanna … humid forest): the worst case for climate-cell structure leaking through.
  const snap = worldFrom(91001, () => 500);
  const warm = (_i: number, _lat: number, m: number) => 22 + 3 * Math.cos((2 * Math.PI * m) / 12);
  const climate = climateWith(snap, warm, (i) => 25 + 110 * hash01(i), 91002);
  const uniform = climateWith(snap, warm, () => 70, 91003);
  const cellPx = W / climate.w;

  it('thresholded attributes are C² across climate cells (B-spline), and the warp has no raster creases', () => {
    const grid = buildSatelliteGrid(satelliteClimateOf(climate), 6);
    const cache = new PaintCache();
    const smp = getClimateSampler(W, H, grid.cw, grid.ch, 4, detailTexture(4, W, cache), cache);
    // (1) The interpolant alone: a straight sweep across 40 cells, cover from the pixel-record fill
    // vs a plain bilinear read of the same grid (creases at every cell line).
    const rec = new Uint16Array(PX_K);
    const bs: number[] = [], bl: number[] = [];
    const r0 = 40, lStride = smp.stride * LAND_K;
    for (let k = 0; k < 40 * 16; k++) {
      const x = 20 + k / 16, c0 = Math.floor(x), fc = x - c0, fr = 0.37;
      const i00 = (r0 + 1) * smp.stride + c0 + 1;
      fillLand(rec, 0, grid.land, i00, smp.stride, fr, fc);
      bs.push(rec[PX_COVER] / 65535);
      const q = i00 * LAND_K, g = grid.land, a = A_COVER;
      bl.push((1 - fr) * ((1 - fc) * g[q + a] + fc * g[q + LAND_K + a]) + fr * ((1 - fc) * g[q + lStride + a] + fc * g[q + lStride + LAND_K + a]));
    }
    // (2) The warp: continuous grid column of the sampling position along pixel rows.
    const st = smp.stride, xs: number[] = [];
    let kw = 0;
    for (const r of [150, 200, 256, 300, 350]) {
      const row: number[] = [];
      let prev = NaN;
      for (let c = 0; c < W; c++) {
        const p = r * W + c;
        let x = (smp.idx[p] % st) - 1 + smp.wc[p] / 65535;
        if (prev === prev) {
          while (x - prev > grid.cw / 2) x -= grid.cw;
          while (prev - x > grid.cw / 2) x += grid.cw;
        }
        row.push(x);
        prev = x;
      }
      kw = Math.max(kw, kinkiness(row));
      xs.push(...row);
    }
    const kb = kinkiness(bs), kl = kinkiness(bl);
    console.log(`[polish3] |Δ²| p99/mean: cover B-spline ${kb.toFixed(2)}, bilinear ${kl.toFixed(2)}; warp positions ${kw.toFixed(2)}`);
    expect(xs.length).toBe(5 * W);
    expect(kb).toBeLessThan(4);
    expect(kb).toBeLessThan(0.5 * kl);
    // Bilinear upsampling of the warp raster: ≈ 7.5 (kinks at every raster column).
    expect(kw).toBeLessThan(4.5);
  });

  for (const quality of ['full', 'preview'] as const) {
    it(`no climate-cell spectral energy and few hard pixel steps (${quality})`, () => {
      const o = opts({ quality });
      /** Mean spectral bump at the climate-cell frequency (ring, axes) over 128-px crops within ±50°. */
      const bumps = (c: ClimateResult) => {
        const cache = new PaintCache();
        const src = { mesh, snapshot: snap, climate: c };
        const hm = paintHeightMap(src, o, cache);
        const rgba = paintLayer('satellite', src, o, cache).rgba;
        const L = new Float32Array(W * H);
        for (let p = 0; p < W * H; p++) L[p] = lum(rgba, p);
        const N = 128;
        let ring = 0, axis = 0, n = 0;
        for (let y0 = 96; y0 + N <= H - 96; y0 += N / 2) {
          for (let x0 = 0; x0 < W; x0 += N / 2) {
            const P = power(L, x0, y0, N);
            ring += bump(P, N, N / cellPx, false);
            axis += bump(P, N, N / cellPx, true);
            n++;
          }
        }
        return { ring: ring / n, axis: axis / n, rgba, hm, L };
      };
      const pa = bumps(climate), un = bumps(uniform);
      // Mosaic contrast (P90 − P10 of land luminance) and hard steps relative to it.
      const vals: number[] = [];
      for (let r = 96; r < H - 96; r++) for (let c = 0; c < W; c += 3) vals.push(pa.L[r * W + c]);
      vals.sort((a, b) => a - b);
      const C = vals[Math.floor(0.9 * vals.length)] - vals[Math.floor(0.1 * vals.length)];
      const hard = hardSteps(pa.rgba, pa.hm, 0.15 * C, 0.6 * C, 96, H - 96);
      console.log(`[polish3] ${quality}: climate-cell bump ring ${pa.ring.toFixed(2)} / uniform climate ${un.ring.toFixed(2)}, axes ${pa.axis.toFixed(2)} / ${un.axis.toFixed(2)}; contrast ${C.toFixed(1)}, hard steps ${hard.toFixed(3)}`);
      expect(C).toBeGreaterThan(8);
      // Cell-to-cell climate jumps add no energy at the cell frequency (the texture's own spectrum
      // is the uniform-climate reference).
      expect(pa.ring - un.ring).toBeLessThan(0.12);
      expect(pa.axis - un.axis).toBeLessThan(0.12);
      // Hard one-pixel steps across mosaic edges (previous pass: ≈ 0.39 — pixel-scale camouflage).
      expect(hard).toBeLessThan(0.25);
    });
  }

  it('valley lines follow the drainage as smooth curves, not axis-aligned runs of routing cells', () => {
    // Hilly humid continent: dense dendritic drainage.
    const hills = worldFrom(93001, (la, lo) => {
      const d = angle(la, lo, 0.3, 0.5);
      return d < 1.2 ? 400 + 900 * (1 - d / 1.2) : -3500;
    });
    const c = climateWith(hills, () => 15, () => 90, 93002);
    const o = opts({ rivers: true });
    const cache = new PaintCache();
    const hf = getHeightField(mesh, hills, o, cache);
    const lines = drainageLines(heightFieldKey(mesh, hills, o), hf, c, o, cache);
    // Gradient-energy fraction within 5° of the pixel axes (isotropic: 10/90 ≈ 0.11; the bilinear
    // upsampled routing-cell field of the previous pass: ≈ 0.30).
    let axis = 0, all = 0, on = 0;
    for (let r = 2; r < H - 2; r++) {
      for (let q = 1; q < W - 1; q++) {
        const p = r * W + q;
        if (lines[p] > 0) on++;
        const gx = lines[p + 1] - lines[p - 1], gy = lines[p + W] - lines[p - W];
        const g2 = gx * gx + gy * gy;
        if (g2 === 0) continue;
        const a = (Math.atan2(Math.abs(gy), Math.abs(gx)) * 180) / Math.PI;
        if (Math.min(a, 90 - a) < 5) axis += g2;
        all += g2;
      }
    }
    console.log(`[polish3] valley lines: ${on} px, axis-aligned gradient energy ${(axis / all).toFixed(3)} (isotropic 0.111)`);
    expect(on).toBeGreaterThan(5000);
    expect(axis / all).toBeLessThan(0.17);
  });

  it('snowlines and treelines on rugged mountains are anti-aliased, not pixel blocks', () => {
    // Rugged orogenic massif (pixel-scale ridges of hundreds of metres) with the spring snowline
    // crossing its flanks.
    const mtn = worldFrom(93003, (la, lo) => {
      const d = angle(la, lo, 0.8, 0.5);
      return d < 0.9 ? 1500 + 1800 * (1 - d / 0.9) : -3500;
    }, (la, lo) => (angle(la, lo, 0.8, 0.5) < 0.9 ? 2500 : 0));
    const c = climateWith(mtn, (_i, _lat, m) => 12 + 10 * Math.cos((2 * Math.PI * (m - 6)) / 12), () => 70, 93004);
    for (const month of [0, 4]) {
      const o = opts({ month });
      const cache = new PaintCache();
      const hm = paintHeightMap({ mesh, snapshot: mtn, climate: c }, o, cache);
      const rgba = paintLayer('satellite', { mesh, snapshot: mtn, climate: c }, o, cache).rgba;
      const hard = hardSteps(rgba, hm, 12, 60);
      console.log(`[polish3] rugged mountains, month ${month}: hard steps ${hard.toFixed(3)}`);
      // Previous pass: 0.57 (January) / 0.42 (May).
      expect(hard).toBeLessThan(0.33);
    }
  });
});

describe('phenology and high plateaus', () => {
  /** One-attribute-grid climate: every cell with the same monthly T / P (4×2 cells, all land). */
  function uniform(T: number[], P: number[], elev = 0): SatelliteClimate {
    const w = 4, h = 2, N = w * h;
    const temp = new Float32Array(12 * N), precip = new Float32Array(12 * N);
    for (let m = 0; m < 12; m++) for (let i = 0; i < N; i++) { temp[m * N + i] = T[m]; precip[m * N + i] = P[m]; }
    const k = classifyKoppen(Float32Array.from(T), Float32Array.from(P), false);
    return {
      w, h, land: new Uint8Array(N).fill(1), elev: new Float32Array(N).fill(elev), temp, precip,
      seaIce: new Float32Array(12 * N), sst: new Float32Array(12 * N).fill(10), koppenAll: new Uint8Array(N).fill(k), seaLevel: 0,
    };
  }
  /** Linear-light herbaceous colour of month m: green-minus-red. */
  function grassGreen(c: SatelliteClimate, m: number): number {
    const g = buildSatelliteGrid(c, m);
    const o = LAND_K; // padded grid: cell (0, 1)
    return g.land[o + A_GRASS + 1] - g.land[o + A_GRASS];
  }

  it('continental interiors stay green into early summer on snowmelt and soil water; Mediterranean summers turn golden', () => {
    // Continental: frozen winters with 30 mm/month of snow, a dry-ish warm June (35 mm).
    const cont = uniform([-12, -10, -4, 4, 11, 17, 20, 18, 12, 4, -4, -10], [30, 30, 30, 35, 40, 35, 45, 40, 35, 30, 30, 30]);
    // Mediterranean: wet mild winters, dry hot summers.
    const med = uniform([10, 11, 13, 15, 19, 23, 26, 26, 23, 18, 14, 11], [90, 80, 60, 40, 20, 6, 2, 4, 20, 60, 90, 100]);
    const june = grassGreen(cont, 5), aug = grassGreen(med, 7), jan = grassGreen(med, 0);
    console.log(`[polish3] grass green−red (linear): continental June ${june.toFixed(3)}, Mediterranean August ${aug.toFixed(3)} / January ${jan.toFixed(3)}`);
    expect(june).toBeGreaterThan(0.02);
    expect(aug).toBeLessThan(0);
    expect(jan).toBeGreaterThan(0.02);
  });

  it('deep pits of rugged terrain hold only small lakes (incised outlets); shallow basins keep theirs', () => {
    const w = 128, h = 64;
    const frac = (depth: number) => {
      // A conical pit of the given depth in the top of a 3000 m massif that slopes to the sea.
      const elev = new Float32Array(w * h);
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          const d = Math.hypot(c - 64, (r - 32) * 2);
          elev[r * w + c] = d < 12 ? 3000 - depth * (1 - d / 12) : 3000 - (d - 12) * 60;
        }
      }
      const n = w * h;
      const dr = routeDrainage({
        w, h, elev, sea: 0, runoff: new Float32Array(n).fill(900), lakeEvap: new Float32Array(n).fill(700),
        arid: new Float32Array(n).fill(0.1), minLakeCells: 4,
      });
      // One open basin (humid: inflow above its open-water evaporation); a lake too small to draw
      // is dropped entirely.
      expect(dr.lakes.length).toBeLessThanOrEqual(1);
      if (dr.lakes.length === 0) return 0;
      const lake = dr.lakes[0];
      expect(lake.endorheic).toBe(false);
      return lake.waterCells / lake.cells;
    };
    const shallow = frac(250), deep = frac(1500);
    console.log(`[polish3] lake / basin area: 250 m pit ${shallow.toFixed(3)}, 1500 m pit ${deep.toFixed(3)}`);
    expect(shallow).toBeGreaterThan(0.2);
    expect(deep).toBeLessThan(0.08);
  });

  it('dry high plateaus are brown alpine steppe, wet ones green tundra', () => {
    const plateau = worldFrom(94001, (la, lo) => (angle(la, lo, 0.4, 0.5) < 0.6 ? 4600 : -3500));
    const redness = (pMonth: number, id: number) => {
      // Sea-level summer ≈ 36 °C: the plateau's warmest month is ≈ 6 °C (above the treeline limit).
      const c = climateWith(plateau, (_i, _lat, m) => 26 + 10 * Math.cos((2 * Math.PI * (m - 6)) / 12), () => pMonth, id);
      const o = opts({ month: 6, width: 512, height: 256 });
      const cache = new PaintCache();
      const src = { mesh, snapshot: plateau, climate: c };
      const hm = paintHeightMap(src, o, cache);
      const rgba = paintLayer('satellite', src, o, cache).rgba;
      let s = 0, n = 0;
      for (let p = 0; p < hm.length; p++) {
        if (!(hm[p] > 4000)) continue;
        s += rgba[4 * p] - rgba[4 * p + 1];
        n++;
      }
      expect(n).toBeGreaterThan(500);
      return s / n;
    };
    const dry = redness(22, 94002), wet = redness(90, 94003);
    console.log(`[polish3] plateau R−G (sRGB): dry ${dry.toFixed(1)}, wet ${wet.toFixed(1)}`);
    expect(dry).toBeGreaterThan(wet + 6);
    expect(dry).toBeGreaterThan(0);
  });
});
