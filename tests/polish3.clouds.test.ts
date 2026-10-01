/**
 * Third polish pass on the clouds (satellite realism at the default globe zoom; sharp zoomed maps):
 * no painterly strokes (small warps, detail and cirrus decoupled from the storms' swirl), regime
 * spectra (speckled cumulus fields, uniform cellular decks, clumpy convection with anvils), crisp
 * cloud bodies, streak-free cirrus, and the zoomed map's window rasters.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { CloudSpec } from '../src/core/types';
import {
  ANVIL_SPREAD, ANVIL_TAU, anvilAlpha, CIRRUS_TAU, CIRRUS_WARP, cirrusAlpha, coverageThreshold, cycloneEffect, DETAIL_GRAD_WARP,
  DETAIL_SWIRL, DETAIL_WARP, detailOctaves, detailParams, detailSum, detailTexture, newDetailShaping, octaveFade, opticalDepth, cloudOpacity,
  excessRef, SHAPE_STAGE_SIZE, shapeStage,
} from '../src/render/cloudsField';
import { COVER_REFERENCE_DENSITY, CYCLONE_COUNT, CYCLONE_STRIDE } from '../src/render/cloudsModel';
import { cloudDetailVolume, cloudNoiseVolume } from '../src/render/cloudsNoise';
import { buildCloudNoiseRaster, rasterizeClouds, WORLD_WINDOW, type CloudRasterWindow } from '../src/render/cloudsRaster';
import { runCloudJob } from '../src/render/cloudsJobs';
import { MAP_CLOUD_MAX_LEVEL, MapClouds, mapCloudTileLevel, mapCloudTileRes, mapCloudTileWindow } from '../src/render/cloudsMap';
import { setCloudWorkerFactory } from '../src/render/cloudsWorkerClient';
import { CLOUDS_FRAGMENT, CLOUDS_VERTEX } from '../src/render/shadersClouds';
import { mapMinScale, type MapTransform } from '../src/render/viewMapTransform';

const DEG = Math.PI / 180;

/** Earth-like synthetic climate (as in the earlier cloud tests), optionally with zonal structure. */
function syntheticSpec(w: number, h: number, density = COVER_REFERENCE_DENSITY, zonal = 0): CloudSpec {
  const n = w * h;
  const cover = new Float32Array(n), u = new Float32Array(n), v = new Float32Array(n);
  for (let r = 0; r < h; r++) {
    const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
    const a = Math.abs(lat) / DEG;
    const m = 0.5 + 0.3 * Math.exp(-((a - 5) ** 2) / 60) + 0.25 * Math.exp(-((a - 52) ** 2) / 150) - 0.05 * Math.exp(-((a - 25) ** 2) / 50);
    const west = 8 * Math.exp(-((a - 45) ** 2) / 120) - 5 * Math.exp(-((a - 12) ** 2) / 80);
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const z = 1 + zonal * Math.sin((c / w) * 6 * Math.PI + r * 0.3);
      cover[i] = Math.min(1, m * z) * density;
      u[i] = west * (1 + 0.5 * zonal * Math.cos((c / w) * 10 * Math.PI));
      v[i] = -Math.sign(lat) * 2 * Math.exp(-((a - 15) ** 2) / 60) + zonal * 3 * Math.sin((c / w) * 8 * Math.PI);
    }
  }
  return { w, h, cover, u, v };
}

/**
 * Structure-tensor coherence (0 isotropic … 1 parallel streaks) of a scalar field sampled on an n × n
 * grid of the tangent plane at (lat, lon), spacing `step` radians, averaged over 5×5 windows.
 */
function coherence(field: (x: number, y: number, z: number) => number, lat: number, lon: number, n: number, step: number): number {
  const cl = Math.cos(lat);
  const p = [cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat)];
  const e = [-Math.sin(lon), Math.cos(lon), 0];
  const no = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), cl];
  const f = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = (i - n / 2) * step, b = (j - n / 2) * step;
      const q = [p[0] + a * e[0] + b * no[0], p[1] + a * e[1] + b * no[1], p[2] + a * e[2] + b * no[2]];
      const l = Math.hypot(q[0], q[1], q[2]);
      f[j * n + i] = field(q[0] / l, q[1] / l, q[2] / l);
    }
  }
  let num = 0, den = 0;
  for (let j = 3; j < n - 3; j += 2) {
    for (let i = 3; i < n - 3; i += 2) {
      let xx = 0, yy = 0, xy = 0;
      for (let dj = -2; dj <= 2; dj++) {
        for (let di = -2; di <= 2; di++) {
          const k = (j + dj) * n + i + di;
          const gx = (f[k + 1] - f[k - 1]) / 2, gy = (f[k + n] - f[k - n]) / 2;
          xx += gx * gx;
          yy += gy * gy;
          xy += gx * gy;
        }
      }
      num += Math.sqrt((xx - yy) ** 2 + 4 * xy * xy);
      den += xx + yy;
    }
  }
  return num / den;
}

describe('no painterly strokes', () => {
  const vol = cloudNoiseVolume(), dvol = cloudDetailVolume();
  const tmp = new Float32Array(4), st = new Float64Array(SHAPE_STAGE_SIZE), oct = new Float64Array(4);
  const sh = newDetailShaping();
  /** The mesoscale detail sum (3 octaves, plain regime) at a unit vector. */
  const detail = (x: number, y: number, z: number): number => {
    shapeStage(vol, x, y, z, tmp, st);
    detailOctaves(dvol, st, tmp, oct, 3);
    return detailSum(oct, 3, sh);
  };

  it('keeps the warps small (their strain drew the detail into brush strokes)', () => {
    expect(DETAIL_GRAD_WARP).toBeLessThanOrEqual(0.08);
    expect(DETAIL_WARP).toBeLessThanOrEqual(0.03);
    // Cirrus: the 9×-stretched streaks stay coherent and just bend (0.06 ran ruler-straight; with the
    // old 4× fibres 0.2 sent them every which way).
    expect(CIRRUS_WARP).toBeLessThanOrEqual(0.2);
    // The detail texture is statistically isotropic (streaks would score ≳ 0.6).
    const samples = [[10, 20], [-35, 140], [50, -60], [0, -150]].map(([la, lo]) => coherence(detail, la * DEG, lo * DEG, 64, 0.0025));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeLessThan(0.5);
  });

  it('follows only part of the storms’ swirl with the detail and none with the cirrus fibres', () => {
    expect(DETAIL_SWIRL).toBeGreaterThanOrEqual(0);
    expect(DETAIL_SWIRL).toBeLessThanOrEqual(0.5);
    expect(CLOUDS_FRAGMENT).toContain('qd0 = qw0 - DETAIL_UNSWIRL * dispA');
    // Cirrus fibres sample the unswirled domain (swirled fibres fanned out into straight beams).
    expect(CLOUDS_FRAGMENT).toContain('ROT * ((qw0 - dispA) * CIRRUS3)');
    expect(CLOUDS_FRAGMENT).not.toMatch(/undefined|NaN|\$\{/);
    expect(CLOUDS_VERTEX).toContain('CYCLONE_BIAS_GAIN');
  });

  it('keeps the map raster free of east–west or diagonal streaks', () => {
    const w = 1024, h = 512;
    const raster = buildCloudNoiseRaster(w, h);
    const out = new Uint8ClampedArray(w * h * 4);
    rasterizeClouds(raster, syntheticSpec(180, 90, COVER_REFERENCE_DENSITY, 0.5), 1, out);
    let gx = 0, gy = 0, gd1 = 0, gd2 = 0;
    const a = (r: number, c: number): number => out[4 * (r * w + c) + 3];
    for (let r = h / 8; r < (7 * h) / 8; r++) {
      const cl = Math.cos(Math.PI / 2 - ((r + 0.5) * Math.PI) / h);
      for (let c = 1; c < w - 1; c++) {
        gx += Math.abs(a(r, c + 1) - a(r, c - 1)) / cl;
        gy += Math.abs(a(r + 1, c) - a(r - 1, c));
        gd1 += Math.abs(a(r + 1, c + 1) - a(r - 1, c - 1));
        gd2 += Math.abs(a(r + 1, c - 1) - a(r - 1, c + 1));
      }
    }
    // First pass: 1.44 (east–west brush streaks); isotropic ≈ 1.
    expect(gy / gx).toBeLessThan(1.15);
    expect(gy / gx).toBeGreaterThan(0.87);
    expect(Math.max(gd1, gd2) / Math.min(gd1, gd2)).toBeLessThan(1.1);
  });
});

describe('regime spectra', () => {
  it('puts cumulus, stratocumulus and convective texture at the finest scales (clusters make the clumps)', () => {
    const sh = newDetailShaping();
    const cu = { ...detailParams(0, 0, 1, 0, 0, sh) };
    const sc = { ...detailParams(1, 0, 0, 0, 0, sh) };
    const cv = { ...detailParams(0, 1, 0, 0, 0, sh) };
    const plain = { ...detailParams(0, 0, 0, 0, 0, sh) };
    // Share of the detail variance in the coarse (~130 km) octave.
    const coarseShare = (p: { coarse: number; gain: number }): number => {
      const g2 = p.gain * p.gain;
      return (p.coarse * p.coarse) / (p.coarse * p.coarse + g2 * (1 + g2 * (1 + g2)));
    };
    expect(coarseShare(cu)).toBeLessThan(0.1);
    expect(coarseShare(sc)).toBeLessThan(0.15);
    // Convection (polish 5): crisp cauliflower towers at the fine scales; its ~300 km clumps come from
    // the convective clusters (clusterCore), not from a red noise spectrum (soft cotton-wool puffs).
    expect(coarseShare(cv)).toBeLessThan(0.15);
    expect(coarseShare(plain)).toBeGreaterThan(coarseShare(cv) * 3);
    expect(coarseShare(plain)).toBeGreaterThan(coarseShare(cu) * 3);
    // Cumulus fields are broken throughout (a higher detail floor), not blobs with fringes.
    expect(cu.floor).toBeGreaterThan(plain.floor + 0.4);
    expect(cu.amp).toBeGreaterThan(plain.amp * 1.5);
  });

  it('shows pixel-scale speckle at the default zoom without aliasing sub-pixel octaves', () => {
    const px = 0.0029; // default zoom, DPR 1
    expect(octaveFade(px, 2)).toBeGreaterThan(0.2);
    expect(octaveFade(px, 3)).toBe(0);
    // The texture noise is ≈ unit variance and dominated by the finer octaves.
    let s2 = 0, fine = 0;
    const N = 20000;
    let seed = 7;
    const g = (): number => {
      // Box–Muller from an LCG.
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const u1 = (seed + 1) / 4294967297;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos((2 * Math.PI * seed) / 4294967296);
    };
    for (let i = 0; i < N; i++) {
      const o = [g(), g(), g(), g()];
      const t = detailTexture(o, 4, 0.8);
      s2 += t * t;
      fine += t * (t - 0.35 * o[0]);
    }
    expect(Math.sqrt(s2 / N)).toBeGreaterThan(0.85);
    expect(Math.sqrt(s2 / N)).toBeLessThan(1.15);
    expect(fine / s2).toBeGreaterThan(0.8);
  });
});

describe('cloud bodies, anvils and cirrus', () => {
  it('fades cloud in from a soft, translucent outline; opaque only well inside (polish 4)', () => {
    // (Polish 3 made cloud opaque right behind a crisp outline: QA found the globe hidden under
    // opaque, hard-edged blobs.)
    const alpha = (ex: number, cu = 0): number => cloudOpacity(opticalDepth(ex, 0, 0, cu, 0.5, 0, 0, 1, 1, excessRef(0)));
    expect(alpha(0.12)).toBeLessThan(0.05); // soft edge
    expect(alpha(0.5)).toBeLessThan(0.15); // translucent margin
    expect(alpha(1.4)).toBeGreaterThan(0.35);
    expect(alpha(2.5)).toBeGreaterThan(0.75); // bright cores
    // Shallow cumulus stays thin and translucent (grey speckle).
    expect(alpha(1.4, 1)).toBeLessThan(0.3);
    // Monotone.
    let prev = 0;
    for (let ex = 0.01; ex < 3; ex += 0.05) {
      const a = alpha(ex);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
  });

  it('spreads soft-edged, translucent anvils around convective cores only, densest next to them', () => {
    const zthr = coverageThreshold(0.5);
    expect(anvilAlpha(zthr + 1, zthr, 0, 0)).toBe(0); // no convection, no anvil
    expect(anvilAlpha(zthr - ANVIL_SPREAD - 0.3, zthr, 1, 0)).toBe(0); // beyond the spread
    const outer = anvilAlpha(zthr - ANVIL_SPREAD + 0.3, zthr, 1, 0);
    expect(outer).toBeGreaterThan(0.1); // inside: a translucent sheet
    expect(outer).toBeLessThan(0.3);
    expect(anvilAlpha(zthr + 2, zthr, 1, 0)).toBeLessThanOrEqual(ANVIL_TAU + 1e-9);
    expect(anvilAlpha(zthr + 2, zthr, 1, 0)).toBeGreaterThan(0.35);
  });

  it('keeps cirrus a thin, striated veil (streaks, not smoke loops)', () => {
    let max = 0, min = 1;
    for (let nc = -3; nc <= 3; nc += 0.1) {
      const a = cirrusAlpha(0.9, 2, nc);
      max = Math.max(max, a);
      min = Math.min(min, a);
    }
    expect(max).toBeLessThanOrEqual(CIRRUS_TAU + 1e-9);
    expect(max).toBeGreaterThan(0.2);
    // Striation: bright strands where the fibre noise is high, the veil thinner between.
    expect(min).toBeLessThan(0.5 * max);
    expect(cirrusAlpha(0.9, 2, 1.2)).toBeGreaterThan(cirrusAlpha(0.9, 2, 0));
    expect(cirrusAlpha(0.9, 2, 0)).toBeGreaterThanOrEqual(cirrusAlpha(0.9, 2, -1.2));
    // Sub-pixel fibres: their mean.
    expect(cirrusAlpha(0.9, 2, 1.2, 0)).toBeCloseTo(cirrusAlpha(0.9, 2, -1.2, 0), 9);
  });

  it('carves clearer dry slots into overcast storm tracks (stronger comma contrast)', () => {
    const cyc = new Float32Array(CYCLONE_COUNT * CYCLONE_STRIDE);
    // One storm at 45°N, 0°E: radius 0.25, full intensity, no swirl.
    cyc.set([Math.cos(45 * DEG), 0, Math.sin(45 * DEG), 0.25, 1, 0, 1, 1], 0);
    const e = new Float64Array(6);
    let min = 0, max = 0;
    for (let la = 30; la <= 60; la += 1) {
      for (let lo = -25; lo <= 25; lo += 1) {
        const p = [Math.cos(la * DEG) * Math.cos(lo * DEG), Math.cos(la * DEG) * Math.sin(lo * DEG), Math.sin(la * DEG)];
        cycloneEffect(cyc, p[0], p[1], p[2], e);
        min = Math.min(min, e[0]);
        max = Math.max(max, e[0]);
      }
    }
    // Dry slot: at 80 % coverage the threshold rises past +1σ (mostly clear).
    expect(coverageThreshold(0.8) - min).toBeGreaterThan(1.1);
    expect(max).toBeGreaterThan(2);
  });
});

describe('zoomed map window rasters', () => {
  const spec = syntheticSpec(180, 90, COVER_REFERENCE_DENSITY, 0.5);

  it('resolve every octave the zoom shows and match the world raster where they overlap', () => {
    // 8× on a 1600 × 1000 map: ~2000 px per radian.
    const res = 8 * mapMinScale(1600, 1000);
    const win: CloudRasterWindow = { lon0: -0.2, lon1: 0.2, lat0: 0.25, lat1: 0.45 };
    const w = Math.round((win.lon1 - win.lon0) * res), h = Math.round((win.lat1 - win.lat0) * res);
    const r = buildCloudNoiseRaster(w, h, undefined, undefined, undefined, win);
    expect(r.oct.length).toBe(4);
    expect(r.wraps).toBe(false);
    const world = buildCloudNoiseRaster(1536, 768);
    expect(world.oct.length).toBe(2);
    expect(world.wraps).toBe(true);
    expect(world.win).toEqual(WORLD_WINDOW);
    const a = new Uint8ClampedArray(w * h * 4), b = new Uint8ClampedArray(1536 * 768 * 4);
    rasterizeClouds(r, spec, 1, a);
    rasterizeClouds(world, spec, 1, b);
    // Same clouds: the window's mean opacity ≈ the world raster's over the same area.
    let sa = 0, sb = 0, nb = 0;
    for (let i = 3; i < a.length; i += 4) sa += a[i];
    const c0 = Math.round(((win.lon0 + Math.PI) / (2 * Math.PI)) * 1536), c1 = Math.round(((win.lon1 + Math.PI) / (2 * Math.PI)) * 1536);
    const r0 = Math.round(((Math.PI / 2 - win.lat1) / Math.PI) * 768), r1 = Math.round(((Math.PI / 2 - win.lat0) / Math.PI) * 768);
    for (let rr = r0; rr < r1; rr++) for (let cc = c0; cc < c1; cc++, nb++) sb += b[4 * (rr * 1536 + cc) + 3];
    expect(Math.abs(sa / (w * h) - sb / nb) / 255).toBeLessThan(0.12);
    // Sharper: much more pixel-to-pixel detail than the world raster stretched to the same size.
    let hiA = 0;
    for (let rr = 1; rr < h - 1; rr++) for (let cc = 1; cc < w - 1; cc++) hiA += Math.abs(a[4 * (rr * w + cc) + 3] - a[4 * (rr * w + cc + 1) + 3]);
    let hiB = 0;
    for (let rr = r0; rr < r1; rr++) for (let cc = c0; cc < c1 - 1; cc++) hiB += Math.abs(b[4 * (rr * 1536 + cc) + 3] - b[4 * (rr * 1536 + cc + 1) + 3]);
    // Per window pixel: the stretched world raster changes once per ~8 px (and bilinearly smoothed).
    const perA = hiA / ((h - 2) * (w - 2)), perB = hiB / ((r1 - r0) * (c1 - c0 - 1)) / (w / (c1 - c0));
    expect(perA).toBeGreaterThan(2 * perB);
  });

  it('are jobs of the cloud worker (window noise cached for the view)', () => {
    const win: CloudRasterWindow = { lon0: 3, lon1: 3.6, lat0: -0.5, lat1: -0.2 }; // crosses the date line
    const job = { kind: 'raster' as const, spec, w: 240, h: 120, opacity: 0.8, time: 0, win };
    const t0 = performance.now();
    const a = runCloudJob(job).result;
    const cold = performance.now() - t0;
    // Best of several cached runs, so one scheduler hiccup under a loaded parallel suite cannot flip it.
    let cached = Infinity;
    let b = a;
    for (let k = 0; k < 4; k++) {
      const t = performance.now();
      b = runCloudJob(job).result;
      cached = Math.min(cached, performance.now() - t);
    }
    expect(a.kind).toBe('raster');
    if (a.kind !== 'raster' || b.kind !== 'raster') return;
    expect(a.win).toEqual(win);
    expect(Buffer.from(a.rgba.buffer).equals(Buffer.from(b.rgba.buffer))).toBe(true);
    expect(cached).toBeLessThan(cold); // noise raster reused
  });
});

describe('MapClouds tiles (host wiring: setView + drawCopy)', () => {
  /** Minimal DOM canvas stand-in recording drawImage calls. */
  class FakeCtx {
    calls: { img: unknown; args: number[] }[] = [];
    setTransform(): void {}
    clearRect(): void {}
    putImageData(): void {}
    save(): void {}
    restore(): void {}
    beginPath(): void {}
    rect(): void {}
    clip(): void {}
    drawImage(img: unknown, ...args: number[]): void { this.calls.push({ img, args }); }
  }
  class FakeCanvas {
    width = 0;
    height = 0;
    ctx = new FakeCtx();
    getContext(): FakeCtx { return this.ctx; }
  }
  const g = globalThis as unknown as { document?: unknown; ImageData?: unknown };
  const hadDoc = 'document' in g, hadImageData = 'ImageData' in g;
  afterEach(() => {
    setCloudWorkerFactory(null);
    if (!hadDoc) delete g.document;
    if (!hadImageData) delete g.ImageData;
  });
  const fake = (): void => {
    g.document = { createElement: () => new FakeCanvas() };
    g.ImageData = class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} };
    setCloudWorkerFactory(null);
  };
  const W = 400, H = 250;
  const fit = mapMinScale(W, H);
  const at = (zoom: number, centerLon = 0.3, centerLat = 0.4): MapTransform => ({ width: W, height: H, centerLon, centerLat, scale: zoom * fit });
  /** drawCopy of the world copy the transform centres; the tile draws (source rect + destination). */
  const draw = (clouds: MapClouds, t: MapTransform, ctx = new FakeCtx()): { world: number; tiles: number[][] } => {
    ctx.calls.length = 0;
    const rx = t.width / 2 - (t.centerLon + Math.PI) * t.scale, ry = t.height / 2 - (Math.PI / 2 - t.centerLat) * t.scale;
    clouds.drawCopy(ctx as unknown as CanvasRenderingContext2D, rx, ry, 2 * Math.PI * t.scale, Math.PI * t.scale);
    return { world: ctx.calls.filter((c) => c.img === clouds.canvas).length, tiles: ctx.calls.filter((c) => c.img !== clouds.canvas).map((c) => c.args) };
  };
  /** The tiles' destinations cover the viewport. */
  const coversViewport = (tiles: number[][]): boolean => {
    for (let y = 1; y < H; y += 20) {
      for (let x = 1; x < W; x += 20) {
        if (!tiles.some((a) => x >= a[4] && x <= a[4] + a[6] && y >= a[5] && y <= a[5] + a[7])) return false;
      }
    }
    return true;
  };

  it('chooses the tile level from the screen resolution, always finer than the world raster', () => {
    const worldRes = 1536 / (2 * Math.PI);
    expect(mapCloudTileRes(mapCloudTileLevel(1, worldRes))).toBeGreaterThan(worldRes); // zoomed out: still tiles
    let prev = 0;
    for (let need = 100; need < 40000; need *= 1.3) {
      const l = mapCloudTileLevel(need, worldRes);
      expect(l).toBeGreaterThanOrEqual(prev);
      expect(l).toBeLessThanOrEqual(MAP_CLOUD_MAX_LEVEL);
      if (l < MAP_CLOUD_MAX_LEVEL) expect(mapCloudTileRes(l)).toBeGreaterThanOrEqual(0.85 * need);
      prev = l;
    }
    const w = mapCloudTileWindow(3, 0, 0);
    expect(w.lon0).toBeCloseTo(-Math.PI, 12);
    expect(w.lat1).toBeCloseTo(Math.PI / 2, 12);
    expect(w.lat1 - w.lat0).toBeCloseTo(Math.PI / 8, 12);
    expect(w.lon1 - w.lon0).toBeCloseTo(Math.PI / 8, 12);
  });

  it('tiles the view once it settles, prefetches the neighbouring levels, and changes the picture only at zoom breakpoints', async () => {
    fake();
    let updates = 0;
    const clouds = new MapClouds(() => { updates++; });
    const idle = async (): Promise<void> => {
      for (let i = 0; i < 1500 && clouds.pending; i++) await new Promise((r) => setTimeout(r, 10));
    };
    clouds.set(syntheticSpec(72, 36));
    await idle();
    expect(updates).toBe(1);
    // Zoom 8 (level 3): nothing until the view rests, then the visible tiles, then the prefetch
    // (level 4 under the view, level 2 around it).
    const t8 = at(8);
    clouds.setView(t8, 1);
    expect(clouds.pending).toBe(true);
    expect(draw(clouds, t8).tiles.length).toBe(0);
    await idle();
    expect(clouds.lastDetailMs).toBeGreaterThan(0);
    clouds.setView(t8, 1);
    expect(clouds.pending).toBe(false); // the same view: nothing new
    const d8 = draw(clouds, t8);
    expect(d8.world).toBe(1); // the world raster under the tiles
    expect(coversViewport(d8.tiles)).toBe(true);
    for (const a of d8.tiles) expect(a.slice(0, 4)).toEqual([1, 1, 256, 256]); // drawn without the apron
    // One level on screen (the prefetched levels are not drawn over it).
    const size8 = new Set(d8.tiles.map((a) => Math.round(a[6])));
    expect(size8.size).toBe(1);
    const n = clouds.tileCount;
    expect(n).toBeGreaterThan(5 * d8.tiles.length); // the view's tiles + 4× finer + the coarser ones
    // Zooming in a breakpoint (zoom 16: level 4) or out (zoom 4: level 2): already made, drawn at once,
    // before the view has even settled.
    for (const z of [16, 4]) {
      const t = at(z);
      clouds.setView(t, 1);
      const d = draw(clouds, t);
      expect(coversViewport(d.tiles)).toBe(true);
      expect(new Set(d.tiles.map((a) => Math.round(a[6]))).size).toBe(1);
      await idle();
    }
    // Back to zoom 8: cached; nothing to compute.
    clouds.setView(t8, 1);
    await new Promise((r) => setTimeout(r, 300));
    clouds.setView(t8, 1);
    expect(draw(clouds, t8).tiles.length).toBe(d8.tiles.length);
    clouds.dispose();
    expect(clouds.tileCount).toBe(0);
  });

  it('lets other levels stand in only where the view’s own tiles are missing', async () => {
    fake();
    const clouds = new MapClouds(() => {});
    const idle = async (): Promise<void> => {
      for (let i = 0; i < 1500 && clouds.pending; i++) await new Promise((r) => setTimeout(r, 10));
    };
    clouds.set(syntheticSpec(72, 36));
    await idle();
    const t8 = at(8);
    clouds.setView(t8, 1);
    await idle();
    // Panned east (zoom 8): before the view's own tiles land, the cached tiles of the neighbouring
    // levels (the coarser prefetch spans twice the view) stand in where they exist.
    const tp = at(8, 0.3 + 0.6, 0.4);
    clouds.setView(tp, 1);
    const before = draw(clouds, tp);
    expect(before.tiles.length).toBeGreaterThan(0);
    await idle();
    const after = draw(clouds, tp);
    expect(coversViewport(after.tiles)).toBe(true);
    const own = new Set(after.tiles.map((a) => Math.round(a[6])));
    expect(own.size).toBe(1);
    // Before: stand-ins of the prefetched coarser level where the view's own tiles were missing.
    expect(before.tiles.some((a) => !own.has(Math.round(a[6])))).toBe(true);
    clouds.dispose();
  });

  it('tiles zoomed-out views too, snaps tile edges to device pixels, and drops nothing on a date-line pan', async () => {
    fake();
    const clouds = new MapClouds(() => {});
    const idle = async (): Promise<void> => {
      for (let i = 0; i < 900 && clouds.pending; i++) await new Promise((r) => setTimeout(r, 10));
    };
    clouds.set(syntheticSpec(72, 36));
    await idle();
    // Zoom 2 across the date line.
    const t = at(2, Math.PI - 0.1, -0.2);
    clouds.setView(t, 1);
    await idle();
    class DprCtx extends FakeCtx {
      getTransform(): { a: number; b: number; c: number; d: number; e: number; f: number } {
        return { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 };
      }
    }
    const ctx = new DprCtx();
    // The centred world copy and the one east of it (the view straddles both).
    const rx = t.width / 2 - (t.centerLon + Math.PI) * t.scale + 0.3, ry = t.height / 2 - (Math.PI / 2 - t.centerLat) * t.scale + 0.2;
    const ww = 2 * Math.PI * t.scale;
    const all: number[][] = [];
    for (const k of [0, 1]) {
      ctx.calls.length = 0;
      clouds.drawCopy(ctx as unknown as CanvasRenderingContext2D, rx + k * ww, ry, ww, Math.PI * t.scale);
      all.push(...ctx.calls.filter((c) => c.img !== clouds.canvas).map((c) => c.args));
    }
    expect(coversViewport(all)).toBe(true);
    for (const a of all) for (const v of a.slice(4)) expect(Math.abs(v * 2 - Math.round(v * 2))).toBeLessThan(1e-6);
    // Neighbouring tiles share their edges exactly (no gap, no overlap).
    const xs = new Set(all.map((a) => a[4]));
    for (const a of all) {
      const right = a[4] + a[6];
      if (right < W) expect(xs.has(right)).toBe(true);
    }
    clouds.dispose();
  });

  it('keeps the previous clouds’ tiles until the new world raster lands, then remakes the view’s tiles', async () => {
    fake();
    let updates = 0;
    const clouds = new MapClouds(() => { updates++; });
    const idle = async (): Promise<void> => {
      for (let i = 0; i < 900 && clouds.pending; i++) await new Promise((r) => setTimeout(r, 10));
    };
    clouds.set(syntheticSpec(72, 36));
    await idle();
    const t = at(8);
    clouds.setView(t, 1);
    await idle();
    const n = clouds.tileCount;
    const before = draw(clouds, t).tiles.length;
    // New clouds (season playback in HD): the old tiles stay on screen meanwhile.
    clouds.set(syntheticSpec(72, 36, COVER_REFERENCE_DENSITY * 0.8));
    expect(draw(clouds, t).tiles.length).toBe(before);
    await idle();
    clouds.setView(t, 1);
    await idle();
    expect(clouds.pending).toBe(false);
    expect(clouds.tileCount).toBe(n); // the old ones freed, the view's remade
    expect(draw(clouds, t).tiles.length).toBe(before);
    // Standard clouds: no tiles at all.
    clouds.set({ ...syntheticSpec(72, 36), quality: 'standard' });
    await idle();
    expect(clouds.tileCount).toBe(0);
    clouds.setView(t, 1);
    expect(clouds.pending).toBe(false);
    // Disposed: late results are dropped, no callbacks.
    clouds.set(syntheticSpec(72, 36));
    clouds.setView(t, 1);
    const u = updates;
    clouds.dispose();
    await new Promise((r) => setTimeout(r, 1500));
    expect(updates).toBe(u);
    expect(clouds.tileCount).toBe(0);
  });
});
