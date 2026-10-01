/**
 * Fourth polish pass of the satellite painter (painter): vegetation that reads as orbital imagery
 * rather than military camouflage.
 *  - the forest mosaic's contrast depends on the tree fraction: a closed humid canopy is nearly
 *    continuous (rare, faint openings), intermediate cover (savanna, forest-steppe) carries the
 *    strongest mosaic;
 *  - patches come at every scale (fractal patch noise: the luminance structure function keeps rising
 *    out to tens of pixels instead of saturating at one blob size), with soft edges where the cover
 *    is intermediate (tree-density gradients, few hard one-pixel steps);
 *  - the mosaic is mean-preserving: the wooded area follows the climate's tree fraction;
 *  - a muted palette (no saturated map greens);
 *  - riparian (gallery) forest lines the rivers through dry steppe;
 *  - temperate and boreal trees keep their leaves through a dry summer month (only frost-free
 *    climates are drought-deciduous).
 */
import { describe, expect, it } from 'vitest';
import { classifyKoppen } from '../src/climate/koppen';
import { buildMeshGridMap, gridLat, meshToGrid, resampleGrid } from '../src/core/grid';
import type { ClimateResult, PaintOptions, WorldSnapshot } from '../src/core/types';
import { CRUST_CONTINENTAL, CRUST_OCEANIC } from '../src/core/types';
import { PaintCache, paintHeightMap, paintLayer } from '../src/render/paint';
import { A_TREE, LAND_K, PAL, buildSatelliteGrid } from '../src/render/satelliteBiome';
import type { SatelliteClimate } from '../src/render/satelliteBiome';
import { encodeSrgb } from '../src/render/colormaps';
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

function worldFrom(id: number, elevAt: (lat: number, lon: number) => number): WorldSnapshot {
  const base = syntheticSnapshot(mesh, 3, 4);
  const n = mesh.n;
  const elev = new Float32Array(n), crust = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    elev[i] = elevAt(mesh.lat[i], mesh.lon[i]);
    crust[i] = elev[i] > -1000 ? CRUST_CONTINENTAL : CRUST_OCEANIC;
  }
  return { ...base, id, elev, crust, orogeny: new Float32Array(n), age: new Float32Array(n).fill(300) };
}

/** Fixture climate (180×90): monthly sea-level T / P per cell (lapsed to the cell's land surface). */
function climateWith(
  snap: WorldSnapshot, tAt: (i: number, lat: number, lon: number, m: number) => number,
  pAt: (i: number, lat: number, lon: number, m: number) => number, id: number,
): ClimateResult {
  const w = 180, h = 90;
  const map = buildMeshGridMap(mesh, 4 * w, 4 * h);
  const c = structuredClone(zonalClimate(w, h, resampleGrid(meshToGrid(map, snap.elev), 4 * w, 4 * h, w, h)));
  const N = w * h;
  const tt = new Float32Array(12), pp = new Float32Array(12);
  for (let i = 0; i < N; i++) {
    const r = Math.floor(i / w), q = i % w;
    const lat = gridLat(h, r), lon = ((q + 0.5) / w) * 2 * Math.PI - Math.PI;
    for (let m = 0; m < 12; m++) {
      tt[m] = tAt(i, lat, lon, m);
      pp[m] = pAt(i, lat, lon, m);
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

const lum = (a: Uint8ClampedArray, p: number) => 0.2126 * a[4 * p] + 0.7152 * a[4 * p + 1] + 0.0722 * a[4 * p + 2];

/** Land pixels between ±45° latitude, at least 2 px from any sea pixel. */
function inland(hm: Float32Array): Uint8Array {
  const ok = new Uint8Array(W * H);
  for (let r = 2; r < H - 2; r++) {
    if (Math.abs((gridLat(H, r) * 180) / Math.PI) > 45) continue;
    for (let c = 2; c < W - 2; c++) {
      let land = true;
      for (let dr = -2; dr <= 2 && land; dr++) for (let dc = -2; dc <= 2 && land; dc++) if (!(hm[(r + dr) * W + c + dc] > 0)) land = false;
      if (land) ok[r * W + c] = 1;
    }
  }
  return ok;
}

interface TextureStats {
  n: number;
  std: number;
  /** Structure function S(r) = <(L(x + r) − L(x))²>, r = 1, 2, 4, 8, 16, 32 px. */
  S: number[];
  /** Hard one-pixel steps: |ΔL| > 0.6·C per |ΔL| > 0.15·C (C = P90 − P10). */
  hard: number;
}

function textureStats(rgba: Uint8ClampedArray, ok: Uint8Array): TextureStats {
  const L = new Float32Array(W * H);
  const vals: number[] = [];
  let s = 0, s2 = 0;
  for (let p = 0; p < W * H; p++) {
    if (!ok[p]) continue;
    L[p] = lum(rgba, p);
    vals.push(L[p]);
    s += L[p];
    s2 += L[p] * L[p];
  }
  const n = vals.length;
  vals.sort((a, b) => a - b);
  const C = vals[Math.floor(0.9 * n)] - vals[Math.floor(0.1 * n)];
  const S: number[] = [];
  for (const d of [1, 2, 4, 8, 16, 32]) {
    let a = 0, m = 0;
    for (let p = 0; p < W * H - d * W; p++) {
      if (!ok[p]) continue;
      for (const o of [p + d, p + d * W]) {
        if (!ok[o]) continue;
        a += (L[o] - L[p]) ** 2;
        m++;
      }
    }
    S.push(a / m);
  }
  let big = 0, edge = 0;
  for (let p = 0; p < W * H - W; p++) {
    if (!ok[p]) continue;
    for (const o of [p + 1, p + W]) {
      if (!ok[o]) continue;
      const d = Math.abs(L[o] - L[p]);
      if (d > 0.15 * C) edge++;
      if (d > 0.6 * C) big++;
    }
  }
  const mean = s / n;
  return { n, std: Math.sqrt(s2 / n - mean * mean), S, hard: big / Math.max(1, edge) };
}

/** HSV saturation of an sRGB colour. */
function saturation(r: number, g: number, b: number): number {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx > 0 ? (mx - mn) / mx : 0;
}

describe('vegetation mosaics: cover-dependent, multi-scale, soft, muted', () => {
  // A 500 m continent over most of the globe (gentle hills from the detail noise), rivers off.
  const land = worldFrom(94001, (la, lo) => (angle(la, lo, 0, 0.4) < 1.7 ? 500 : -3500));
  const warm = (_i: number, _lat: number, _lon: number, m: number) => 25 + 2 * Math.cos((2 * Math.PI * (m - 6)) / 12);
  // Humid temperate forest (Cfb: ~90 % tree cover, the rest openings) everywhere.
  const forest = climateWith(land, (_i, _lat, _lon, m) => 11 + 7 * Math.cos((2 * Math.PI * (m - 6)) / 12), () => 95, 94002);
  // Savanna (Aw): a long wet season (AMJJAS) and a dry one — about 40 % tree cover.
  const savanna = climateWith(land, warm, (_i, _lat, _lon, m) => (m >= 3 && m <= 8 ? 150 : 15), 94003);
  const paint = (c: ClimateResult) => {
    const cache = new PaintCache();
    const src = { mesh, snapshot: land, climate: c };
    const hm = paintHeightMap(src, opts(), cache);
    return { rgba: paintLayer('satellite', src, opts(), cache).rgba, ok: inland(hm) };
  };
  const fp = paint(forest), sp = paint(savanna);
  const fs = textureStats(fp.rgba, fp.ok), sv = textureStats(sp.rgba, sp.ok);
  const fmt = (t: TextureStats) => `std ${t.std.toFixed(1)}, S(1..32) ${t.S.map((v) => v.toFixed(0)).join('/')}, hard ${t.hard.toFixed(3)}`;
  console.log(`[polish4] closed forest: ${fmt(fs)}\n[polish4] savanna: ${fmt(sv)}`);

  it('a near-closed humid canopy is nearly continuous; intermediate cover carries the strongest mosaic', () => {
    expect(fs.n).toBeGreaterThan(20000);
    expect(sv.n).toBeGreaterThan(20000);
    // Previous pass: forest std 12.0, S(8) 285 vs the savanna's 464, hard steps 0.145 — openings
    // punched through the canopy at full contrast with crisp edges (camouflage).
    expect(fs.std).toBeLessThan(9);
    // Patch-scale variance (r = 8 px) of the canopy is small next to the savanna's.
    expect(fs.S[3]).toBeLessThan(0.45 * sv.S[3]);
    expect(fs.hard).toBeLessThan(0.06);
  });

  it('savanna patches come at every scale: the structure function keeps rising past the blob size', () => {
    // A band-pass patch noise saturates by ~8 px (previous pass: S(32) / S(8) = 0.99); a fractal one
    // keeps adding variance at larger separations (in a uniform climate: the noise alone).
    const rise = sv.S[5] / sv.S[3];
    console.log(`[polish4] savanna S(32)/S(8) ${rise.toFixed(2)}, S(8)/S(2) ${(sv.S[3] / sv.S[1]).toFixed(2)}`);
    expect(rise).toBeGreaterThan(1.08);
  });

  it('edges are soft where the cover is intermediate (tree-density gradients, not cut-out stands)', () => {
    // Previous pass: 0.12 of the savanna's luminance edges were hard one-pixel steps.
    expect(sv.hard).toBeLessThan(0.04);
  });

  it('the palette is muted: no saturated map greens', () => {
    // sRGB chroma (max − min) of every green vegetation endmember (previous pass: lush grass 68,
    // steppe grass 62).
    for (const [name, c] of Object.entries(PAL)) {
      const v = [encodeSrgb(c[0]), encodeSrgb(c[1]), encodeSrgb(c[2])];
      if (v[1] < v[0]) continue; // straw, dormant and leaf-off browns
      expect(Math.max(...v) - Math.min(...v), name).toBeLessThan(52);
    }
    // Painted savanna: mean HSV saturation of the land.
    let ss = 0, n = 0;
    for (let p = 0; p < W * H; p++) {
      if (!sp.ok[p]) continue;
      ss += saturation(sp.rgba[4 * p], sp.rgba[4 * p + 1], sp.rgba[4 * p + 2]);
      n++;
    }
    console.log(`[polish4] savanna mean saturation ${(ss / n).toFixed(3)}`);
    expect(ss / n).toBeLessThan(0.42);
  });
});

describe('riparian forest and phenology', () => {
  it('rivers crossing a dry steppe are lined with riparian (gallery) forest', () => {
    // A wet upland in the west drains east across a semi-arid steppe lowland to the sea.
    const lon0 = 0.4;
    const world = worldFrom(94011, (la, lo) => {
      const d = angle(la, lo, 0.35, lon0);
      if (d > 1.1) return -3500;
      const west = lon0 - lo;
      return 250 + Math.max(0, 2200 * west) + 400 * (1 - d / 1.1);
    });
    const c = climateWith(
      world, (_i, _lat, _lon, m) => 13 + 11 * Math.cos((2 * Math.PI * (m - 6)) / 12),
      (_i, _lat, lon) => (lon < lon0 - 0.35 ? 140 : 22), 94012,
    );
    const o = opts({ rivers: true });
    const cache = new PaintCache();
    const src = { mesh, snapshot: world, climate: c };
    const on = paintLayer('satellite', src, o, cache).rgba;
    const off = paintLayer('satellite', src, { ...o, rivers: false }, cache).rgba;
    // Changed steppe pixels (east of the wet upland): decompose each change into a pull toward a dark
    // riparian green and one toward river water (least squares on the two directions).
    const RIP = [56, 80, 44], WATER = [34, 58, 78];
    let rip = 0, changed = 0;
    for (let r = 0; r < H; r++) {
      for (let q = 0; q < W; q++) {
        const lon = ((q + 0.5) / W) * 2 * Math.PI - Math.PI;
        if (lon < lon0 - 0.25) continue;
        const p = r * W + q;
        const d = [0, 1, 2].map((k) => on[4 * p + k] - off[4 * p + k]);
        if (Math.hypot(d[0], d[1], d[2]) < 5) continue;
        changed++;
        const u = [0, 1, 2].map((k) => RIP[k] - off[4 * p + k]), v = [0, 1, 2].map((k) => WATER[k] - off[4 * p + k]);
        const uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2], vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
        const uv = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
        const ud = u[0] * d[0] + u[1] * d[1] + u[2] * d[2], vd = v[0] * d[0] + v[1] * d[1] + v[2] * d[2];
        const det = uu * vv - uv * uv;
        if (!(det > 1e-6)) continue;
        const a = (ud * vv - vd * uv) / det, b = (vd * uu - ud * uv) / det;
        if (a > 0.1 && a > 2 * b) rip++;
      }
    }
    console.log(`[polish4] dry-steppe rivers: ${changed} px changed, ${rip} riparian-green`);
    expect(changed).toBeGreaterThan(300);
    // Previous pass: riparian strips only in deserts (none here).
    expect(rip).toBeGreaterThan(0.25 * changed);
  });

  it('temperate trees stay green through a dry summer month; frost-free dry seasons shed leaves', () => {
    /** One-attribute-grid climate (4×2 cells, all land). */
    const uniform = (T: number[], P: number[]): SatelliteClimate => {
      const w = 4, h = 2, N = w * h;
      const temp = new Float32Array(12 * N), precip = new Float32Array(12 * N);
      for (let m = 0; m < 12; m++) for (let i = 0; i < N; i++) { temp[m * N + i] = T[m]; precip[m * N + i] = P[m]; }
      const k = classifyKoppen(Float32Array.from(T), Float32Array.from(P), false);
      return {
        w, h, land: new Uint8Array(N).fill(1), elev: new Float32Array(N), temp, precip,
        seaIce: new Float32Array(12 * N), sst: new Float32Array(12 * N).fill(10), koppenAll: new Uint8Array(N).fill(k), seaLevel: 0,
      };
    };
    /** Canopy green − red (linear) in month m. */
    const canopy = (c: SatelliteClimate, m: number) => {
      const g = buildSatelliteGrid(c, m);
      return g.land[LAND_K + A_TREE + 1] - g.land[LAND_K + A_TREE];
    };
    // Continental forest-steppe (Dfa-like) with a dry July; a tropical savanna in its dry season.
    const cont = uniform([-16, -13, -5, 5, 15, 22, 25, 22, 14, 4, -7, -14], [30, 30, 35, 40, 30, 22, 18, 22, 35, 45, 40, 32]);
    const trop = uniform([24, 25, 27, 28, 28, 27, 26, 26, 27, 27, 26, 24], [2, 2, 30, 90, 180, 210, 210, 200, 170, 90, 5, 2]);
    const july = canopy(cont, 6), dry = canopy(trop, 1), wet = canopy(trop, 6);
    console.log(`[polish4] canopy green−red (linear): continental dry July ${july.toFixed(3)}, tropical dry season ${dry.toFixed(3)} / wet ${wet.toFixed(3)}`);
    expect(july).toBeGreaterThan(0.02);
    expect(dry).toBeLessThan(0.6 * wet);
  });
});
