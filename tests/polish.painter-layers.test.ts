/**
 * Data-layer quality: smooth land-aware climate sampling, per-pixel Köppen from interpolated
 * statistics, smooth plate boundaries with consistent type colours, colormaps and legends.
 */
import { describe, expect, it } from 'vitest';
import type { ClimateResult, PaintOptions, WorldSnapshot } from '../src/core/types';
import { classifyKoppen, koppenIdFromCode } from '../src/climate/koppen';
import { Rng } from '../src/core/rng';
import { CM_PRECIP_LOG, CM_TEMP, cmapColor } from '../src/render/colormaps';
import { BOUNDARY_COLORS } from '../src/render/overlay';
import { cellCategories, pixelCategories } from '../src/render/layersCategory';
import { KS_N, classifyPixels, classifyStats, koppenStats } from '../src/render/layersKoppen';
import { pressureCentres } from '../src/render/layersClimate';
import { COAST_Q, coastDistance, extendField, splineSample } from '../src/render/layersSample';
import { PaintCache, getLegend, paintHeightMap, paintLayer, paintOverlay } from '../src/render/paint';
import type { HeightField } from '../src/render/terrain';
import { BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT, BOUNDARY_TRANSFORM } from '../src/core/types';
import { snapshotFromDraft } from '../src/tectonics/draft';
import { smallMesh, syntheticSnapshot, twoPlateDraft, zonalClimate } from './helpers/fixtures';

function opts(over: Partial<PaintOptions> = {}): PaintOptions {
  return { width: 512, height: 256, month: 6, seaLevel: 0, hillshade: false, seed: 5, quality: 'full', ...over };
}

describe('Köppen statistics classifier', () => {
  it('equals classifyKoppen for random climates, with and without a uniform lapse offset', () => {
    const rng = new Rng(11);
    const st = new Float32Array(KS_N);
    const T = new Float32Array(12), P = new Float32Array(12), T2 = new Float32Array(12);
    let n = 0;
    for (let trial = 0; trial < 20000; trial++) {
      const mean = rng.float(-30, 32), amp = rng.float(0, 25), pBase = Math.exp(rng.float(-1, 6));
      const southern = rng.float(0, 1) < 0.5;
      for (let m = 0; m < 12; m++) {
        T[m] = mean + amp * Math.cos(((m - 6.5) * Math.PI) / 6) * (southern ? -1 : 1) + rng.float(-2, 2);
        P[m] = Math.max(0, pBase * (1 + rng.float(-0.9, 2) * Math.cos(((m - rng.float(0, 12)) * Math.PI) / 6)));
      }
      koppenStats(T, P, southern, st, 0);
      expect(classifyStats(st, 0, 0)).toBe(classifyKoppen(T, P, southern));
      const dT = rng.float(-15, 5);
      for (let m = 0; m < 12; m++) T2[m] = T[m] + dT;
      // The summer half is decided by the (unshifted) seasonal contrast: identical for T2.
      expect(classifyStats(st, 0, dT)).toBe(classifyKoppen(T2, P, southern));
      n++;
    }
    expect(n).toBe(20000);
  });
});

/** Minimal climate result for sampler / classifier tests. */
function fakeClimate(w: number, h: number, temp: (r: number, c: number, m: number) => number, precip: (r: number, c: number, m: number) => number): ClimateResult {
  const N = w * h;
  const t = new Float32Array(12 * N), p = new Float32Array(12 * N);
  for (let m = 0; m < 12; m++) for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    t[m * N + r * w + c] = temp(r, c, m);
    p[m * N + r * w + c] = precip(r, c, m);
  }
  return {
    id: 4711, w, h, temp: t, precip: p, land: new Uint8Array(N).fill(1), elev: new Float32Array(N).fill(0),
    params: { seaLevel: 0 },
  } as unknown as ClimateResult;
}

describe('smooth sampling', () => {
  const cache = new PaintCache();
  it('B-spline resampling reproduces constants and linear ramps, and does not overshoot a step', () => {
    const cw = 36, ch = 18, W = 360, H = 180;
    const flat = new Float32Array(cw * ch).fill(7);
    const out = splineSample(flat, cw, ch, W, H, new Float32Array(W * H), cache);
    for (let i = 0; i < out.length; i += 97) expect(out[i]).toBeCloseTo(7, 4);
    // Linear in latitude (rows away from the clamped poles).
    const ramp = new Float32Array(cw * ch);
    for (let r = 0; r < ch; r++) for (let c = 0; c < cw; c++) ramp[r * cw + c] = r;
    splineSample(ramp, cw, ch, W, H, out, cache);
    for (let r = 30; r < 150; r++) expect(out[r * W + 17]).toBeCloseTo(((r + 0.5) * ch) / H - 0.5, 3);
    const step = new Float32Array(cw * ch);
    for (let r = 0; r < ch; r++) for (let c = 0; c < cw; c++) step[r * cw + c] = c < cw / 2 ? 0 : 10;
    splineSample(step, cw, ch, W, H, out, cache);
    let lo = Infinity, hi = -Infinity;
    for (const v of out) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    expect(lo).toBeGreaterThanOrEqual(-1e-4);
    expect(hi).toBeLessThanOrEqual(10 + 1e-4);
  });

  it('extends a surface type a few rings across the coast and leaves distant cells alone', () => {
    const w = 20, h = 10, N = w * h;
    const src = new Float32Array(N), keep = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const c = i % w;
      keep[i] = c < 5 ? 1 : 0;
      src[i] = c < 5 ? 100 : -50;
    }
    const out = extendField(src, w, h, keep, 1, 3, new Float32Array(N), new Uint8Array(N));
    for (let r = 0; r < h; r++) {
      expect(out[r * w + 2]).toBe(100); // kept
      expect(out[r * w + 5]).toBeCloseTo(100, 4); // ring 1
      expect(out[r * w + 7]).toBeCloseTo(100, 4); // ring 3
      expect(out[r * w + 11]).toBe(-50); // far: source value
      expect(out[r * w + 19]).toBeCloseTo(100, 4); // lon wraps: ring 1 on the west side
    }
  });

  it('coast distance has exactly the land/sea sign and measures pixels on a ramp', () => {
    const w = 64, h = 32;
    const height = new Float32Array(w * h);
    // Sea level crosses at x = 20.25 px from the left pixel centres: height = 100·(c − 20.25).
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) height[r * w + c] = 100 * (c - 20.25) * (c < 48 ? 1 : 0) - (c >= 48 ? 500 : 0);
    const hf = { w, h, height } as unknown as HeightField;
    const qd = coastDistance(hf, 0);
    for (let p = 0; p < w * h; p++) expect(qd[p] > 0).toBe(height[p] > 0);
    const r = 10;
    expect(qd[r * w + 20] / COAST_Q).toBeCloseTo(-0.25, 1);
    expect(qd[r * w + 21] / COAST_Q).toBeCloseTo(0.75, 1);
  });
});

describe('per-pixel Köppen', () => {
  it('class boundaries follow smooth contours instead of climate-cell steps', () => {
    // 10° cells; the polar boundary (warmest month 0 °C, ET | EF) runs diagonally across the grid.
    const cw = 36, ch = 18, W = 720, H = 360;
    const c = fakeClimate(cw, ch, (r, col, m) => -6 + 0.9 * (col - 18) - 0.9 * (r - 9) + 2 * Math.cos(((m - 6) * Math.PI) / 6), () => 30);
    const height = new Float32Array(W * H).fill(10);
    const qd = new Int8Array(W * H).fill(120);
    const cls = classifyPixels(c, height, 0, W, H, qd, 0, new PaintCache());
    const ET = koppenIdFromCode('ET'), EF = koppenIdFromCode('EF');
    const xs: number[] = [];
    for (let r = 100; r < 260; r++) {
      let x = -1;
      for (let col = 200; col < 700; col++) {
        const a = cls[r * W + col], b = cls[r * W + col + 1];
        expect(a === ET || a === EF).toBe(true);
        if (a !== b) { x = col; break; }
      }
      if (x >= 0) xs.push(x);
    }
    expect(xs.length).toBeGreaterThan(100);
    // A 45° diagonal: the transition moves by ~1 px per row, never by a cell (20 px) at once.
    let maxJump = 0;
    for (let i = 1; i < xs.length; i++) maxJump = Math.max(maxJump, Math.abs(xs[i] - xs[i - 1]));
    expect(maxJump).toBeLessThanOrEqual(3);
  });

  it('lapse-corrects to the pixel height (alpine belts on a massif)', () => {
    const cw = 36, ch = 18, W = 360, H = 180;
    const c = fakeClimate(cw, ch, () => 26, () => 150);
    const height = new Float32Array(W * H).fill(100);
    for (let r = 80; r < 100; r++) for (let col = 170; col < 190; col++) height[r * W + col] = 5500;
    const cls = classifyPixels(c, height, 0, W, H, new Int8Array(W * H).fill(120), 0, new PaintCache());
    expect(cls[90 * W + 180]).toBe(koppenIdFromCode('EF'));
    expect(cls[40 * W + 40]).toBe(koppenIdFromCode('Af'));
  });
});

describe('plate boundaries', () => {
  const mesh = smallMesh(20000);
  const cap = snapshotFromDraft(mesh, twoPlateDraft(mesh, 'cap', { capRadiusDeg: 35 }));
  const W = 1024, H = 512;
  const o = opts({ width: W, height: H });

  it('are smooth: the east edge of a 35° cap follows the circle to sub-pixel accuracy', () => {
    const ov = paintOverlay({ boundaries: true, graticule: false, coastlines: false }, { mesh, snapshot: cap, climate: null }, o, new PaintCache());
    const dev: number[] = [];
    const R = (35 * Math.PI) / 180;
    for (let r = Math.round(H * 0.36); r < Math.round(H * 0.64); r++) {
      const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / H;
      const lonEdge = Math.acos(Math.cos(R) / Math.cos(lat));
      const xe = ((lonEdge + Math.PI) / (2 * Math.PI)) * W - 0.5;
      // Alpha-weighted centroid of the line's core (alpha ≥ 50%) around the expected position.
      let s = 0, sw = 0;
      for (let c = Math.floor(xe) - 8; c <= Math.ceil(xe) + 8; c++) {
        const a = ov[4 * (r * W + c) + 3] / 255;
        const wgt = Math.max(0, a - 0.5);
        s += wgt * c;
        sw += wgt;
      }
      expect(sw).toBeGreaterThan(0);
      dev.push(s / sw - xe);
    }
    const mean = dev.reduce((a, b) => a + b, 0) / dev.length;
    const rms = Math.sqrt(dev.reduce((a, b) => a + (b - mean) ** 2, 0) / dev.length);
    let rough = 0;
    for (let i = 1; i + 1 < dev.length; i++) rough += (dev[i + 1] - 2 * dev[i] + dev[i - 1]) ** 2;
    rough = Math.sqrt(rough / (dev.length - 2));
    expect(Math.abs(mean)).toBeLessThan(1.5);
    expect(rms).toBeLessThan(0.6);
    expect(rough).toBeLessThan(0.35);
  });

  it('colour the cap by relative motion: convergent ahead (east), divergent behind (west), transform on the flanks', () => {
    const ov = paintOverlay({ boundaries: true, graticule: false, coastlines: false }, { mesh, snapshot: cap, climate: null }, o, new PaintCache());
    const near = (target: readonly number[], r0: number, c0: number): number => {
      // Best match among core pixels in a window.
      let best = Infinity;
      for (let r = r0 - 6; r <= r0 + 6; r++) for (let c = c0 - 6; c <= c0 + 6; c++) {
        const i = 4 * (r * W + c);
        if (ov[i + 3] < 200) continue;
        best = Math.min(best, Math.hypot(ov[i] - target[0], ov[i + 1] - target[1], ov[i + 2] - target[2]));
      }
      return best;
    };
    const px = (latDeg: number, lonDeg: number): [number, number] => [Math.round(((90 - latDeg) / 180) * H), Math.round(((lonDeg + 180) / 360) * W)];
    const [re, ce] = px(0, 35), [rw, cwp] = px(0, -35), [rn, cn] = px(35, 0);
    expect(near(BOUNDARY_COLORS[BOUNDARY_CONVERGENT], re, ce)).toBeLessThan(30);
    expect(near(BOUNDARY_COLORS[BOUNDARY_DIVERGENT], rw, cwp)).toBeLessThan(30);
    expect(near(BOUNDARY_COLORS[BOUNDARY_TRANSFORM], rn, cn)).toBeLessThan(30);
  });

  it('draws boundaries only near plate boundaries (synthetic world)', () => {
    const snap = syntheticSnapshot(mesh, 3);
    const cache = new PaintCache();
    const o2 = opts();
    const bnd = paintOverlay({ boundaries: true, graticule: false, coastlines: false }, { mesh, snapshot: snap, climate: null }, o2, cache);
    const map = cache.getGridMap(mesh, o2.width, o2.height);
    let near = 0, total = 0;
    for (let p = 0; p < o2.width * o2.height; p++) {
      if (bnd[4 * p + 3] < 128) continue;
      total++;
      const v = map.nearest[p];
      const pl = new Set([snap.plate[map.tri[3 * p]], snap.plate[map.tri[3 * p + 1]], snap.plate[map.tri[3 * p + 2]]]);
      let other = pl.size > 1;
      for (let q = mesh.adjOffset[v]; q < mesh.adjOffset[v + 1] && !other; q++) if (snap.plate[mesh.adj[q]] !== snap.plate[v]) other = true;
      if (other) near++;
    }
    expect(total).toBeGreaterThan(100);
    expect(near / total).toBeGreaterThan(0.95);
  });

  it('per-pixel categories agree with the cells away from boundaries', () => {
    const snap = syntheticSnapshot(mesh, 4);
    const map = new PaintCache().getGridMap(mesh, 512, 256);
    const pc = pixelCategories(map, cellCategories(mesh, snap.plate));
    let agree = 0;
    for (let p = 0; p < 512 * 256; p++) if (pc.k1[p] === snap.plate[map.nearest[p]]) agree++;
    expect(agree / (512 * 256)).toBeGreaterThan(0.97);
  });
});

describe('climate layers', () => {
  const mesh = smallMesh(20000);
  const snap = syntheticSnapshot(mesh, 3);
  const cache = new PaintCache();
  const o = opts();
  const hm = paintHeightMap({ mesh, snapshot: snap, climate: null }, o, cache);
  const c = zonalClimate(180, 90);

  it('climate colours switch at the height-map coast, not at climate cells (precipitation)', () => {
    // Make land much drier than sea so the switch is visible.
    const c2 = structuredClone(c) as ClimateResult & { id: number };
    c2.id = c.id + 1;
    const N = c2.w * c2.h;
    for (let i = 0; i < N; i++) c2.land[i] = 0;
    for (let m = 0; m < 12; m++) for (let i = 0; i < N; i++) c2.precip[m * N + i] = 200;
    const rgba = paintLayer('precipitation', { mesh, snapshot: snap, climate: c2 }, o, cache).rgba;
    // Uniform field: every pixel away from the coast has the same colour; no 2° blocks anywhere.
    const ref = cmapColor(CM_PRECIP_LOG, Math.log10(200));
    let off = 0, n = 0;
    const qd = coastDistance({ w: o.width, h: o.height, height: hm } as unknown as HeightField, 0);
    for (let p = 0; p < hm.length; p++) {
      if (Math.abs(qd[p]) < 2 * COAST_Q) continue;
      n++;
      if (Math.abs(rgba[4 * p] - ref[0]) + Math.abs(rgba[4 * p + 1] - ref[1]) + Math.abs(rgba[4 * p + 2] - ref[2]) > 3) off++;
    }
    expect(off / n).toBeLessThan(0.001);
  });

  it('temperature legend is diverging about a near-white 0 °C and matches the colormap', () => {
    const lg = getLegend('temperature', { mesh, snapshot: snap, climate: c }, o)!;
    expect(lg.kind).toBe('gradient');
    if (lg.kind !== 'gradient') return;
    const zero = lg.stops.find((s) => s.value === 0)!;
    expect(Math.min(...zero.color)).toBeGreaterThan(225);
    for (const s of lg.stops) expect(s.color).toEqual(cmapColor(CM_TEMP, s.value));
    const cold = cmapColor(CM_TEMP, -20), warm = cmapColor(CM_TEMP, 25);
    expect(cold[2]).toBeGreaterThan(cold[0] + 80);
    expect(warm[0]).toBeGreaterThan(warm[2] + 80);
  });

  it('legends exist for every layer with ascending stops (annual and monthly)', () => {
    for (const month of [-1, 6]) {
      for (const layer of ['temperature', 'precipitation', 'pressure', 'sst', 'wind', 'currents', 'crustAge', 'elevation'] as const) {
        const lg = getLegend(layer, { mesh, snapshot: snap, climate: c }, opts({ month }))!;
        expect(lg.kind).toBe('gradient');
        if (lg.kind !== 'gradient') continue;
        for (let i = 1; i < lg.stops.length; i++) expect(lg.stops[i].value).toBeGreaterThan(lg.stops[i - 1].value);
      }
    }
  });

  it('finds synthetic pressure centres', () => {
    const cw = 72, ch = 36;
    const p = new Float32Array(cw * ch);
    for (let r = 0; r < ch; r++) for (let col = 0; col < cw; col++) {
      const lat = 90 - (r + 0.5) * 5, lon = -180 + (col + 0.5) * 5;
      p[r * cw + col] = 1013 + 12 * Math.exp(-((lat - 30) ** 2 + (lon + 40) ** 2) / 400) - 15 * Math.exp(-((lat + 40) ** 2 + (lon - 90) ** 2) / 300);
    }
    const cs = pressureCentres(p, cw, ch);
    const highs = cs.filter((x) => x.high), lows = cs.filter((x) => !x.high);
    expect(highs.length).toBe(1);
    expect(lows.length).toBe(1);
    expect(Math.abs(90 - (highs[0].row + 0.5) * 5 - 30)).toBeLessThanOrEqual(5);
    expect(Math.abs(90 - (lows[0].row + 0.5) * 5 + 40)).toBeLessThanOrEqual(5);
  });

  it('paints every climate layer at preview size within a sane time and without NaN-black pixels', () => {
    const sources = { mesh, snapshot: snap as WorldSnapshot, climate: c };
    for (const layer of ['temperature', 'precipitation', 'pressure', 'sst', 'wind', 'currents', 'koppen'] as const) {
      for (const month of [-1, 0, 6]) {
        const rgba = paintLayer(layer, sources, opts({ month, quality: 'preview', width: 256, height: 128 }), cache).rgba;
        let black = 0;
        for (let p = 0; p < rgba.length; p += 4) if (rgba[p] === 0 && rgba[p + 1] === 0 && rgba[p + 2] === 0) black++;
        expect(black).toBe(0);
      }
    }
  });
});
