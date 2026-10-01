/**
 * Second polish pass on the clouds ("photographic" look at the default globe zoom, no main-thread
 * stalls): detail volume with analytic gradients, regime shaping, octave band-limiting, the cloud
 * worker client and jobs, asynchronous GlobeClouds updates, the map raster's crispness.
 */
import { Color, PerspectiveCamera, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudSpec } from '../src/core/types';
import {
  CELL_SCALE, cellFade, CIRRUS_TAU, cirrusAlpha, closedCells, combineNoise, coverageThreshold, cycloneTemplate, DETAIL_SCALES,
  detailOctaves, detailParams, detailPlain, detailSum, newDetailShaping, OCTAVE_FADE_PX, octaveFade, OPEN_CELL_SCALE, openCells,
  opticalDepth, REGIME_OFFSET_CU, REGIME_OFFSET_CV, REGIME_OFFSET_SC, SHAPE_STAGE_SIZE, shapeOctave, shapeStage,
} from '../src/render/cloudsField';
import { GlobeClouds } from '../src/render/cloudsGlobe';
import { runCloudJob, type CloudJob } from '../src/render/cloudsJobs';
import { buildCloudGrids, COVER_REFERENCE_DENSITY, coverageFraction } from '../src/render/cloudsModel';
import {
  buildCloudCellVolume, buildCloudDetailVolume, CLOUD_CELL_EDGE_RANGE, CLOUD_DETAIL_GRAD_K, CLOUD_DETAIL_PERIOD, CLOUD_NOISE_STD,
  cloudCellVolume, cloudDetailVolume, cloudNoiseVolume, sampleCloudNoise,
} from '../src/render/cloudsNoise';
import { buildCloudNoiseRaster, rasterizeClouds } from '../src/render/cloudsRaster';
import { CloudWorkerClient, setCloudWorkerFactory } from '../src/render/cloudsWorkerClient';
import { CLOUDS_FRAGMENT } from '../src/render/shadersClouds';

const DEG = Math.PI / 180;

/** Earth-like synthetic climate (as in polish.clouds.test.ts), optionally with zonal structure. */
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

let seed = 99;
const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);

/** Raw detail octaves and shape-stage values at random points on the sphere. */
function samples(N: number): { st: Float64Array[]; oct: Float64Array[] } {
  const vol = cloudNoiseVolume(), dvol = cloudDetailVolume();
  const tmp = new Float32Array(4);
  const st: Float64Array[] = [], oct: Float64Array[] = [];
  for (let i = 0; i < N; i++) {
    const z = 2 * rnd() - 1, t = 2 * Math.PI * rnd(), r = Math.sqrt(1 - z * z);
    const s = shapeStage(vol, r * Math.cos(t), r * Math.sin(t), z, tmp, new Float64Array(SHAPE_STAGE_SIZE));
    const o = new Float64Array(4);
    detailOctaves(dvol, s, tmp, o, 4);
    st.push(s);
    oct.push(o);
  }
  return { st, oct };
}

describe('detail volume', () => {
  it('is deterministic, normalized, unsaturated, and stores the analytic gradient of its value', () => {
    const a = buildCloudDetailVolume(32, 8, 5), b = buildCloudDetailVolume(32, 8, 5);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    const vol = cloudDetailVolume();
    const n = vol.data.length / 4;
    let s = 0, s2 = 0, sat = 0;
    for (let i = 0; i < n; i++) {
      const x = vol.data[4 * i] / 255;
      s += x;
      s2 += x * x;
      for (let c = 0; c < 4; c++) if (vol.data[4 * i + c] === 0 || vol.data[4 * i + c] === 255) sat++;
    }
    const mean = s / n, sd = Math.sqrt(s2 / n - mean * mean);
    expect(mean).toBeCloseTo(0.5, 1);
    expect(Math.abs(sd / CLOUD_NOISE_STD - 1)).toBeLessThan(0.1);
    expect(sat / (4 * n)).toBeLessThan(1e-3);
    // Gradient channels vs central differences of the (trilinear) value: equal up to interpolation.
    const o = new Float32Array(4), p = new Float32Array(4), q = new Float32Array(4);
    let err = 0, mag = 0;
    const h = 0.002;
    for (let k = 0; k < 400; k++) {
      const x = rnd(), y = rnd(), z = rnd();
      sampleCloudNoise(vol, x, y, z, o);
      for (let axis = 0; axis < 3; axis++) {
        const d = [0, 0, 0];
        d[axis] = h;
        sampleCloudNoise(vol, x + d[0], y + d[1], z + d[2], p);
        sampleCloudNoise(vol, x - d[0], y - d[1], z - d[2], q);
        const fd = (p[0] - q[0]) / (2 * h) / CLOUD_NOISE_STD / CLOUD_DETAIL_PERIOD;
        const an = (o[1 + axis] - 0.5) / CLOUD_DETAIL_GRAD_K;
        err += (fd - an) ** 2;
        mag += an * an;
      }
    }
    expect(Math.sqrt(err / mag)).toBeLessThan(0.2);
  });
});

describe('cell volume (mesoscale cellular convection)', () => {
  it('is a deterministic, tileable Worley honeycomb with per-cell ids', () => {
    const a = buildCloudCellVolume(16, 4, 3), b = buildCloudCellVolume(16, 4, 3);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    const vol = cloudCellVolume();
    const o = new Float32Array(4), p = new Float32Array(4);
    for (let k = 0; k < 50; k++) {
      const x = rnd(), y = rnd(), z = rnd();
      sampleCloudNoise(vol, x, y, z, o);
      sampleCloudNoise(vol, x + 1, y - 1, z + 2, p);
      for (let c = 0; c < 4; c++) expect(p[c]).toBeCloseTo(o[c], 5);
    }
    // Borders (F2 − F1 ≈ 0) are thin: a small fraction of the volume; ids vary between cells.
    let border = 0, idMin = 255, idMax = 0;
    const n = vol.data.length / 4;
    for (let i = 0; i < n; i++) {
      if ((vol.data[4 * i] / 255) * CLOUD_CELL_EDGE_RANGE < 0.05) border++;
      idMin = Math.min(idMin, vol.data[4 * i + 2]);
      idMax = Math.max(idMax, vol.data[4 * i + 2]);
    }
    expect(border / n).toBeGreaterThan(0.02);
    expect(border / n).toBeLessThan(0.25);
    expect(idMax - idMin).toBeGreaterThan(200);
  });

  it('darkens closed-cell borders, rings open cells, and only where resolved', () => {
    // Walls (edge 0, ~0.6 cell from the centre) thinner than the domed centres (polish 3: softer walls).
    expect(closedCells(0, 0.5, 1, 1, 0.6)).toBeLessThan(0.75); // border
    expect(closedCells(0.4, 0.5, 1, 1, 0.1)).toBeGreaterThan(0.95); // interior
    expect(closedCells(0, 0.5, 0, 1)).toBe(1); // no stratocumulus
    expect(openCells(0.02, 1, 1)).toBeGreaterThan(0.1); // ring: cloudier
    expect(openCells(0.02, 1, 1, 0, 1)).toBeGreaterThan(0.4); // lumps along the ring
    expect(openCells(0.5, 1, 1)).toBeLessThan(-0.7); // centre: clear
    expect(openCells(0.02, 0, 1)).toBe(0);
    // ~46 km closed cells: sub-pixel at the default zoom on a DPR-1 screen, resolved in close-ups;
    // open cells (2× larger) already show at the default zoom.
    expect(cellFade(0.0029)).toBeLessThan(0.2);
    expect(cellFade(0.0012)).toBe(1);
    expect(cellFade(0.0029, CELL_SCALE * OPEN_CELL_SCALE)).toBeGreaterThan(0.8);
  });
});

describe('regime shaping', () => {
  const { st, oct } = samples(4000);

  it('keeps every shaping zero-mean and ~unit-variance (plain, billows, ridges)', () => {
    for (const beta of [-1, -0.5, 0, 0.5, 1]) {
      // Use detailParams' own mapping through a synthetic regime reaching beta on the fine octaves.
      const sh = newDetailShaping();
      const ab = Math.abs(beta), inv = 1 / Math.sqrt((1 - ab) ** 2 + ab * ab);
      sh.lf = (1 - ab) * inv;
      sh.bf = (beta / 0.5508) * inv;
      let s = 0, s2 = 0;
      for (const o of oct) {
        const v = shapeOctave(o[2], sh.lf, sh.bf);
        s += v;
        s2 += v * v;
      }
      const m = s / oct.length, sd = Math.sqrt(s2 / oct.length - m * m);
      expect(Math.abs(m)).toBeLessThan(0.15);
      expect(sd).toBeGreaterThan(0.8);
      expect(sd).toBeLessThan(1.2);
    }
  });

  it('maps regimes to billows / ridges and clumpy / speckled gains', () => {
    const sh = newDetailShaping();
    const conv = detailParams(0, 1, 0, 0, 0, { ...sh });
    const cu = detailParams(0, 0, 1, 0, 0, { ...sh });
    const sc = detailParams(1, 0, 0, 0, 0, { ...sh });
    const open = detailParams(0, 0, 0, 1, 0, { ...sh });
    const plain = detailParams(0, 0, 0, 0, 0, { ...sh });
    expect(conv.bc).toBeGreaterThan(0.5); // cauliflower convection
    expect(cu.bf).toBeGreaterThan(0.5); // popcorn cumulus
    expect(sc.bf).toBeGreaterThan(0.8); // closed cells
    expect(open.bf).toBeLessThan(-0.8); // open cells (ridges)
    expect(conv.gain).toBeLessThan(plain.gain); // clumpy
    expect(cu.gain).toBeGreaterThan(plain.gain); // speckled
    for (const p of [conv, cu, sc, open, plain]) {
      expect(p.gain).toBeGreaterThanOrEqual(0.4);
      expect(p.gain).toBeLessThanOrEqual(1);
      expect(p.amp).toBeGreaterThan(0.4);
      expect(p.amp).toBeLessThan(2.2);
    }
  });

  it('still thresholds at the requested cloud fraction for every regime', () => {
    const regimes: [number, number, number, number][] = [[0, 0, 0, 0], [0, 1, 0, 0], [1, 0, 0, 0], [0, 0, 0, 1]];
    const sh = newDetailShaping();
    for (const [sc, cv, cu, open] of regimes) {
      for (const f of [0.3, 0.6]) {
        const zthr = coverageThreshold(f);
        let k = 0;
        for (let i = 0; i < st.length; i++) {
          detailParams(sc, cv, cu, open, st[i][8], sh);
          const nd = detailSum(oct[i], 3, sh);
          // The regime offsets are deliberate; compare against them removed.
          const z = combineNoise(st[i][3], nd, zthr, sc, cv, cu, sh.amp, 0, sh.floor) - REGIME_OFFSET_SC * sc - REGIME_OFFSET_CV * cv - REGIME_OFFSET_CU * cu;
          if (z > zthr) k++;
        }
        expect(Math.abs(k / st.length - f)).toBeLessThan(0.09);
      }
    }
  });

  it('textures optical depth log-normally, gently in stratiform and frontal cloud', () => {
    const { oct: o2 } = samples(1);
    expect(o2.length).toBe(1);
    const ratio = (sc: number, cu: number, bias: number): number => opticalDepth(1, sc, 0, cu, 0.3, 1, bias) / opticalDepth(1, sc, 0, cu, 0.3, -1, bias);
    expect(ratio(0, 1, 0)).toBeGreaterThan(ratio(0, 0, 0)); // cumulus mottled more than stratiform
    expect(ratio(0, 0, 1.5)).toBeLessThan(ratio(0, 0, 0)); // organized frontal cloud smoother
    expect(ratio(0, 0, 0)).toBeGreaterThan(1.2);
    // detailPlain is the unshaped sum with the same normalization.
    expect(detailPlain([1, 0, 0, 0], 4, 0.5)).toBeCloseTo(1 / Math.sqrt(1 + 0.25 + 0.0625 + 0.015625), 6);
  });
});

describe('band-limiting (anti-aliasing contract shared by the shader and the map raster)', () => {
  it('resolves the mesoscale octaves at the default globe zoom and fades sub-pixel ones', () => {
    // Default zoom (distance 4), 984×846 canvas: ≈ 0.0029 rad per pixel at the disk centre (DPR 1).
    const px1 = 0.0029, px2 = px1 / 2;
    expect(octaveFade(px1, 0)).toBe(1);
    expect(octaveFade(px1, 1)).toBe(1);
    // The third (~1 px per cell) partly: pixel-scale speckle in cumulus fields (polish 3).
    expect(octaveFade(px1, 2)).toBeGreaterThan(0.2);
    expect(octaveFade(px1, 2)).toBeLessThan(0.8);
    expect(octaveFade(px1, 3)).toBe(0);
    expect(octaveFade(px2, 2)).toBe(1); // high-DPI: the third octave in full
    expect(octaveFade(px2, 3)).toBeLessThan(0.05);
    expect(octaveFade(0.0006, 3)).toBeGreaterThan(0.2); // close-ups: all four
    // Ratio between octaves is constant (self-similar fbm, no tile alignment: non-integer).
    for (let k = 1; k < DETAIL_SCALES.length; k++) expect(DETAIL_SCALES[k] / DETAIL_SCALES[k - 1]).toBeCloseTo(2.6, 6);
    expect(CLOUDS_FRAGMENT).toContain(`smoothstep(${OCTAVE_FADE_PX[0]}, ${OCTAVE_FADE_PX[1]}, ppc)`);
  });
});

describe('shader source', () => {
  it('interpolates every constant and uses no GLSL ES 3.0 reserved word as an identifier', () => {
    expect(CLOUDS_FRAGMENT).not.toMatch(/undefined|NaN|\$\{/);
    for (const u of ['uGrid', 'uAux', 'uGridPrev', 'uAuxPrev', 'uWind', 'uWindPrev', 'uMix', 'uNoise', 'uDetail', 'uCells']) {
      expect(CLOUDS_FRAGMENT).toContain(` ${u};`);
    }
    // Reserved for future use / keywords in GLSL ES 3.00 (a compile error, invisible to Node tests).
    const reserved = [
      'patch', 'sample', 'input', 'output', 'filter', 'active', 'common', 'partition', 'resource', 'noperspective', 'subroutine',
      'superp', 'attribute', 'varying', 'texture', 'packed', 'goto', 'inline', 'noinline', 'public', 'static', 'extern', 'external',
      'interface', 'long', 'short', 'double', 'half', 'fixed', 'unsigned', 'sizeof', 'cast', 'namespace', 'using', 'union', 'enum',
      'typedef', 'template', 'this', 'class', 'volatile', 'asm', 'buffer', 'shared', 'coherent', 'restrict', 'readonly', 'writeonly',
    ];
    const decl = /\b(?:float|int|bool|vec[234]|ivec[234]|mat[234])\s+([A-Za-z_]\w*)/g;
    expect([...'float patch = 1.0;'.matchAll(decl)].map((m) => m[1])).toEqual(['patch']); // the guard itself works
    for (const m of CLOUDS_FRAGMENT.matchAll(decl)) expect(reserved).not.toContain(m[1]);
  });
});

describe('cyclone template extras and cirrus', () => {
  it('adds cirrus over the comma head and open cells in the cold sector', () => {
    const aux = new Float64Array(2);
    cycloneTemplate(0.15, 0.45, aux);
    expect(aux[0]).toBeGreaterThan(0.5);
    cycloneTemplate(-1.4, -0.8, aux);
    expect(aux[1]).toBeGreaterThan(0.9);
    // The cold front's trailing (cold) edge is sharper than its warm side.
    const y = -0.8, s = 0.1 - y, xc = 0.3 - 0.32 * s - 0.1 * s * s, wid = 0.26 + 0.07 * s;
    const cold = cycloneTemplate(xc - 0.8 * wid, y) - cycloneTemplate(xc - 1.2 * wid, y);
    const warm = cycloneTemplate(xc + 0.8 * wid, y) - cycloneTemplate(xc + 1.2 * wid, y);
    expect(Math.abs(cold)).toBeGreaterThan(Math.abs(warm));
  });

  it('keeps cirrus a thin veil and absent where its coverage is', () => {
    expect(cirrusAlpha(0, 3, 3)).toBe(0);
    let max = 0;
    for (let cp = -3; cp <= 3; cp += 0.25) for (let nc = -3; nc <= 3; nc += 0.25) max = Math.max(max, cirrusAlpha(0.9, cp, nc));
    expect(max).toBeLessThanOrEqual(CIRRUS_TAU + 1e-9);
    expect(max).toBeGreaterThan(0.2);
  });
});

describe('cloud worker client (in-thread fallback without Worker support)', () => {
  afterEach(() => setCloudWorkerFactory(null));

  const spec = syntheticSpec(72, 36);

  it('runs jobs asynchronously and coalesces a channel to its latest job', async () => {
    const client = new CloudWorkerClient(null);
    expect(client.threaded).toBe(false);
    const a = client.run({ kind: 'grids', spec }, 'c');
    const b = client.run({ kind: 'grids', spec }, 'c');
    const c = client.run({ kind: 'grids', spec: syntheticSpec(36, 18) }, 'c');
    const other = client.run({ kind: 'grids', spec }, 'other');
    expect(client.busy).toBe(3); // a and `other` in flight, c pending (b replaced)
    const [ra, rb, rc, ro] = await Promise.all([a, b, c, other]);
    expect(ra?.w).toBe(72); // in flight when replaced: still delivered (newer than the display)
    expect(rb).toBeNull(); // replaced while pending
    expect(rc?.w).toBe(36);
    expect(ro?.w).toBe(72);
    expect(client.busy).toBe(0);
  });

  it('falls back to the calling thread when the worker fails, re-running its jobs', async () => {
    let posted = 0;
    class FailingWorker {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: { message: string; preventDefault?: () => void }) => void) | null = null;
      onmessageerror: (() => void) | null = null;
      postMessage(): void {
        posted++;
        setTimeout(() => this.onerror?.({ message: 'boom' }), 0);
      }
      terminate(): void {}
    }
    const warn = console.warn;
    console.warn = () => {};
    try {
      const client = new CloudWorkerClient(() => new FailingWorker() as unknown as Worker);
      const r = await client.run({ kind: 'grids', spec }, 'x');
      expect(posted).toBe(1);
      expect(r?.kind).toBe('grids');
      expect(client.threaded).toBe(false);
    } finally {
      console.warn = warn;
    }
  });

  it('round-trips jobs through a worker-like message channel (structured-clone contract)', async () => {
    class LoopbackWorker {
      onmessage: ((e: { data: unknown }) => void) | null = null;
      onerror = null;
      onmessageerror = null;
      postMessage(msg: { id: number; job: CloudJob }): void {
        const job = structuredClone(msg.job);
        setTimeout(() => {
          const { result } = runCloudJob(job, true);
          this.onmessage?.({ data: structuredClone({ id: msg.id, result }) });
        }, 0);
      }
      terminate(): void {}
    }
    const client = new CloudWorkerClient(() => new LoopbackWorker() as unknown as Worker);
    const [v, g] = await Promise.all([client.run({ kind: 'volumes' }, 'v'), client.run({ kind: 'grids', spec }, 'g')]);
    expect(client.threaded).toBe(true);
    expect(v?.noise.data.length).toBe(64 ** 3 * 4);
    expect(v?.detail.data.length).toBe(64 ** 3 * 4);
    expect(v?.cells.data.length).toBe(64 ** 3 * 4);
    expect(g?.regime.length).toBe(72 * 36 * 4);
  });
});

describe('cloud jobs', () => {
  it('derive regime / aux grids, a smoothed advection wind and the climate in one pass', () => {
    const spec = syntheticSpec(180, 90, COVER_REFERENCE_DENSITY, 0.6);
    // Grid-scale wind noise (as climate grids have near coasts / orography).
    for (let i = 0; i < spec.v!.length; i++) spec.v![i] += (rnd() - 0.5) * 4;
    const g = buildCloudGrids(spec);
    expect(g.regime.length).toBe(180 * 90 * 4);
    expect(g.aux.length).toBe(180 * 90 * 4);
    expect(g.climate.rotation).toBe(1);
    // Smoothed flow: much less grid-scale variation (flow-map strain) than the raw wind.
    const rough = (a: Float32Array): number => {
      let s = 0;
      for (let r = 0; r < 90; r++) for (let c = 0; c < 180; c++) s += Math.abs(a[r * 180 + ((c + 1) % 180)] - a[r * 180 + c]);
      return s;
    };
    expect(rough(g.flowV)).toBeLessThan(0.5 * rough(spec.v!));
    // Cirrus: more around the ITCZ's deep convection than in the subtropical highs.
    const band = (a: number, b: number): number => {
      let s = 0, k = 0;
      for (let r = 0; r < 90; r++) {
        const lat = Math.abs(90 - (r + 0.5) * 2);
        if (lat < a || lat >= b) continue;
        for (let c = 0; c < 180; c++) s += g.aux[4 * (r * 180 + c)];
        k += 180;
      }
      return s / k / 255;
    };
    expect(band(0, 10)).toBeGreaterThan(band(20, 30) + 0.05);
    // Coverage channel identical to the regime grid's contract.
    const i = 45 * 180 + 17;
    expect(Math.abs(g.regime[4 * i] / 255 - coverageFraction(spec.cover[i]))).toBeLessThan(0.1);
  });
});

describe('GlobeClouds updates never block the main thread', () => {
  const shared = {
    uLightMode: { value: 1 }, uSunDir: { value: new Vector3(1, 0, 0) }, uAtmoColor: { value: new Color(0.4, 0.6, 1) },
  };

  it('returns from set() at once, shows the clouds when the worker lands them, crossfades updates', async () => {
    setCloudWorkerFactory(null);
    const clouds = new GlobeClouds(shared as never);
    const big = syntheticSpec(720, 360, COVER_REFERENCE_DENSITY, 0.4);
    const t0 = performance.now();
    clouds.set(big);
    const ms = performance.now() - t0;
    // Copies only: the regime grid for 720×360 alone takes tens of ms (the old synchronous path).
    expect(ms).toBeLessThan(16);
    expect(clouds.active).toBe(false);
    expect(clouds.busy).toBe(true);
    for (let i = 0; i < 200 && clouds.busy; i++) await new Promise((r) => setTimeout(r, 10));
    expect(clouds.active).toBe(true);
    const u = clouds.mesh.material.uniforms;
    expect(u.uMix.value).toBe(1);
    expect(u.uNoise.value).not.toBeNull();
    expect(u.uDetail.value).not.toBeNull();
    // A month change: crossfade from the previous grids.
    clouds.set(syntheticSpec(720, 360, 0.3, 0.4));
    for (let i = 0; i < 200 && clouds.busy; i++) await new Promise((r) => setTimeout(r, 10));
    expect(u.uMix.value).toBe(0);
    expect(u.uGridPrev.value).not.toBe(u.uGrid.value);
    expect(clouds.pending).toBe(true);
    clouds.finishTransition();
    expect(u.uMix.value).toBe(1);
    // set(null) hides at once and drops a result still in flight.
    clouds.set(syntheticSpec(72, 36));
    clouds.set(null);
    expect(clouds.active).toBe(false);
    for (let i = 0; i < 200 && clouds.busy; i++) await new Promise((r) => setTimeout(r, 10));
    expect(clouds.active).toBe(false);
    clouds.dispose();
  });

  it('keeps crossfading forward when updates come faster than the crossfade (season playback)', async () => {
    setCloudWorkerFactory(null);
    let now = 1000;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const clouds = new GlobeClouds(shared as never);
      const u = clouds.mesh.material.uniforms;
      const cam = new PerspectiveCamera();
      const frame = (): void => clouds.mesh.onBeforeRender(null as never, null as never, cam, null as never, null as never, null as never);
      const land = async (): Promise<void> => {
        for (let i = 0; i < 400 && clouds.busy; i++) await new Promise((r) => setTimeout(r, 5));
      };
      // "Months": distinct densities, so every grid differs.
      const months = [0.25, 0.3, 0.35, 0.4, 0.45, 0.5].map((d) => syntheticSpec(72, 36, d, 0.4));
      const grid = (s: CloudSpec): Uint8Array => buildCloudGrids(s).regime;
      const same = (t: { image: { data: Uint8Array } }, g: Uint8Array): boolean => Buffer.from(t.image.data).equals(Buffer.from(g));
      clouds.set(months[0]);
      await land();
      for (let k = 1; k < months.length; k++) {
        clouds.set(months[k]);
        await land();
        // The fade starts from what was on screen (the previous month), never from the first month.
        expect(same(u.uGridPrev.value, grid(months[k - 1]))).toBe(true);
        expect(same(u.uGrid.value, grid(months[k]))).toBe(true);
        expect(u.uMix.value).toBeLessThan(0.05);
        now += 800; // default 0.8 s per month < the 0.9 s crossfade
        frame();
        expect(u.uMix.value).toBeGreaterThan(0.9);
      }
      // Two updates within the first half of a fade (density slider): the target is replaced and the
      // fade runs on (no restart from the start, no jump back).
      now += 2000;
      frame();
      clouds.set(months[0]);
      await land();
      now += 200;
      frame();
      const m1 = u.uMix.value;
      expect(m1).toBeGreaterThan(0.05);
      clouds.set(months[1]);
      await land();
      expect(u.uMix.value).toBeCloseTo(m1, 6);
      expect(same(u.uGridPrev.value, grid(months[months.length - 1]))).toBe(true);
      expect(same(u.uGrid.value, grid(months[1]))).toBe(true);
      clouds.dispose();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('map raster look', () => {
  /** Streaking: mean |∂a/∂north| / mean |∂a/∂east| of the opacity (east scaled by 1/cos φ). */
  function streakiness(rgba: Uint8ClampedArray, w: number, h: number): number {
    let gx = 0, gy = 0;
    for (let r = h / 8; r < (7 * h) / 8; r++) {
      const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
      const cl = Math.cos(lat);
      for (let c = 1; c < w - 1; c++) {
        const a = (rr: number, cc: number): number => rgba[4 * (rr * w + cc) + 3];
        gx += Math.abs(a(r, c + 1) - a(r, c - 1)) / cl;
        gy += Math.abs(a(r + 1, c) - a(r - 1, c));
      }
    }
    return gy / gx;
  }

  it('is not streaked east–west (isotropic detail; streaks only in thin cirrus)', () => {
    const w = 1024, h = 512;
    const raster = buildCloudNoiseRaster(w, h);
    const out = new Uint8ClampedArray(w * h * 4);
    rasterizeClouds(raster, syntheticSpec(180, 90, COVER_REFERENCE_DENSITY, 0.5), 1, out);
    // The first polish pass measured 1.44 on this spec (brush streaks); isotropic texture ≈ 1.
    expect(streakiness(out, w, h)).toBeLessThan(1.25);
  });
});
