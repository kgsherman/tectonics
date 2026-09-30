import { describe, expect, it } from 'vitest';
import type { CloudSpec } from '../src/core/types';
import {
  ALPHA_MAX, ANISO, cloudNoise, combineNoise, coverageThreshold, cycloneEffect, cycloneTemplate, DETAIL_CORR_LENGTH, detailStage,
  noiseDrift, opticalDepth, SHAPE_CORR_LENGTH, SHAPE_STAGE_SIZE, shapeStage, swirlProfile,
} from '../src/render/cloudsField';
import {
  analyzeCloudClimate, buildCloudRegimeGrid, COVER_REFERENCE_DENSITY, coverageFraction, createCycloneMemo, CYCLONE_COUNT,
  CYCLONE_STRIDE, cycloneStates, windDivergence,
} from '../src/render/cloudsModel';
import {
  buildCloudNoiseVolume, CLOUD_NOISE_STD, cloudDetailVolume, cloudNoiseVolume, sampleCloudNoise, sampleCloudNoiseR,
} from '../src/render/cloudsNoise';
import { buildCloudNoiseRaster, rasterizeClouds } from '../src/render/cloudsRaster';
import { CLOUDS_FRAGMENT, CLOUDS_VERTEX } from '../src/render/shadersClouds';

const DEG = Math.PI / 180;

/** Earth-like synthetic climate: westerlies peaking at ±45°, trades, cover by latitude × `level`. */
function syntheticSpec(w: number, h: number, level = 1, density = COVER_REFERENCE_DENSITY, retrograde = false): CloudSpec {
  const n = w * h;
  const cover = new Float32Array(n), u = new Float32Array(n), v = new Float32Array(n);
  for (let r = 0; r < h; r++) {
    const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
    const a = Math.abs(lat) / DEG;
    // Model-like cover: ITCZ 0.8, subtropics 0.5, storm tracks 0.75, poles 0.55.
    const m = 0.5 + 0.3 * Math.exp(-((a - 5) ** 2) / 60) + 0.25 * Math.exp(-((a - 52) ** 2) / 150) - 0.05 * Math.exp(-((a - 25) ** 2) / 50);
    const west = 8 * Math.exp(-((a - 45) ** 2) / 120) - 5 * Math.exp(-((a - 12) ** 2) / 80);
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      cover[i] = Math.min(1, m * level) * density;
      u[i] = retrograde ? -west : west;
      v[i] = -Math.sign(lat) * 2 * Math.exp(-((a - 15) ** 2) / 60);
    }
  }
  return { w, h, cover, u, v };
}

describe('noise volume', () => {
  it('is deterministic, tileable and normalized', () => {
    const a = buildCloudNoiseVolume(32, 7), b = buildCloudNoiseVolume(32, 7), c = buildCloudNoiseVolume(32, 8);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    expect(Buffer.from(a.data).equals(Buffer.from(c.data))).toBe(false);
    const vol = cloudNoiseVolume();
    const s0 = new Float32Array(4), s1 = new Float32Array(4);
    for (const [x, y, z] of [[0.13, 0.71, 0.4], [0.9, 0.05, 0.33]]) {
      sampleCloudNoise(vol, x, y, z, s0);
      sampleCloudNoise(vol, x + 1, y - 2, z + 3, s1);
      for (let k = 0; k < 4; k++) expect(s1[k]).toBeCloseTo(s0[k], 5);
      expect(sampleCloudNoiseR(vol, x, y, z)).toBeCloseTo(s0[0], 5);
    }
    for (let ch = 0; ch < 4; ch++) {
      let s = 0, s2 = 0;
      const n = vol.data.length / 4;
      for (let i = 0; i < n; i++) {
        const x = vol.data[4 * i + ch] / 255;
        s += x;
        s2 += x * x;
      }
      const mean = s / n, sd = Math.sqrt(s2 / n - mean * mean);
      expect(mean).toBeCloseTo(0.5, 1);
      expect(sd).toBeGreaterThan(CLOUD_NOISE_STD * 0.9);
      expect(sd).toBeLessThan(CLOUD_NOISE_STD * 1.1);
    }
  });
});

describe('coverage mapping', () => {
  it('maps cover × density to a monotone, saturating coverage fraction', () => {
    expect(coverageFraction(0)).toBe(0);
    expect(coverageFraction(NaN)).toBe(0);
    let prev = 0;
    for (let c = 0.01; c <= 1; c += 0.01) {
      const f = coverageFraction(c);
      expect(f).toBeGreaterThanOrEqual(prev);
      expect(f).toBeLessThanOrEqual(1);
      prev = f;
    }
    const ref = COVER_REFERENCE_DENSITY;
    // Typical model cover (0.63 global, 0.72 ocean, 0.45 land) at the realistic default density.
    expect(coverageFraction(0.63 * ref)).toBeGreaterThan(0.4);
    expect(coverageFraction(0.63 * ref)).toBeLessThan(0.65);
    expect(coverageFraction(0.72 * ref)).toBeGreaterThan(0.6);
    expect(coverageFraction(0.45 * ref)).toBeLessThan(0.25);
    // Slider: 0.1 ≈ clear, 1 = stormy.
    expect(coverageFraction(0.63 * 0.1)).toBeLessThan(0.02);
    expect(coverageFraction(0.63 * 1)).toBeGreaterThan(0.9);
    expect(coverageFraction(2.5)).toBeLessThan(0.97); // soft cap: stormy keeps some gaps
  });

  it('thresholds normalized noise at the requested area fraction', () => {
    const vol = cloudNoiseVolume();
    const tmp = new Float32Array(4), out = new Float64Array(2);
    const N = 6000;
    const nb = new Float64Array(N), nd = new Float64Array(N);
    let seed = 12345;
    const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < N; i++) {
      const z = 2 * rnd() - 1, t = 2 * Math.PI * rnd(), r = Math.sqrt(1 - z * z);
      cloudNoise(vol, r * Math.cos(t), r * Math.sin(t), z, tmp, out);
      nb[i] = out[0];
      nd[i] = out[1];
    }
    for (const f of [0.2, 0.5, 0.8]) {
      const zthr = coverageThreshold(f);
      let k = 0;
      for (let i = 0; i < N; i++) if (combineNoise(nb[i], nd[i], zthr, 0, 0, 0) > zthr) k++;
      expect(Math.abs(k / N - f)).toBeLessThan(0.08);
    }
  });
});

describe('flow-map crossfade', () => {
  it('uses correlation lengths that match the noise autocorrelation (no contrast pulsing)', () => {
    // The globe blends two phases of the same noise a small offset d apart and renormalizes with
    // ρ(d): shape ≈ exp(−d²/L²), detail ≈ exp(−d/λ). A wrong ρ makes contrast and coverage pulse.
    const vol = cloudNoiseVolume(), dvol = cloudDetailVolume();
    const tmp = new Float32Array(4), s1 = new Float64Array(SHAPE_STAGE_SIZE), s2 = new Float64Array(SHAPE_STAGE_SIZE);
    let seed = 7;
    const rnd = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const N = 3000;
    for (const d of [0.02, 0.06, 0.12]) {
      let bb = 0, b1 = 0, b2 = 0, dd = 0, d1 = 0, d2 = 0;
      for (let i = 0; i < N; i++) {
        const z = 2 * rnd() - 1, t = 2 * Math.PI * rnd(), r = Math.sqrt(1 - z * z);
        const uz = 2 * rnd() - 1, ut = 2 * Math.PI * rnd(), ur = Math.sqrt(1 - uz * uz);
        // Separation in the anisotropic noise domain (shapeStage scales z by ANISO itself).
        shapeStage(vol, r * Math.cos(t), r * Math.sin(t), z, tmp, s1);
        const x1 = s1[3], n1 = detailStage(dvol, s1, tmp);
        shapeStage(vol, r * Math.cos(t) + d * ur * Math.cos(ut), r * Math.sin(t) + d * ur * Math.sin(ut), z + (d * uz) / ANISO, tmp, s2);
        const x2 = s2[3], n2 = detailStage(dvol, s2, tmp);
        bb += x1 * x2; b1 += x1 * x1; b2 += x2 * x2; dd += n1 * n2; d1 += n1 * n1; d2 += n2 * n2;
      }
      expect(Math.abs(bb / Math.sqrt(b1 * b2) - Math.exp(-((d / SHAPE_CORR_LENGTH) ** 2)))).toBeLessThan(0.06);
      expect(Math.abs(dd / Math.sqrt(d1 * d2) - Math.exp(-d / DETAIL_CORR_LENGTH))).toBeLessThan(0.12);
    }
    expect(CLOUDS_FRAGMENT).toContain('INV_SHAPE_CORR2');
  });
});

describe('optical depth', () => {
  it('is zero outside cloud, steps up at the edge, grows with the excess, thinner in shallow regimes', () => {
    expect(opticalDepth(0, 0, 0, 0, 0.5, 0)).toBe(0);
    expect(opticalDepth(-1, 0, 0, 0, 0.5, 0)).toBe(0);
    const edge = opticalDepth(0.15, 0, 0, 0, 0.5, 0);
    expect(1 - Math.exp(-edge)).toBeGreaterThan(0.2); // crisp outline, not a fuzzy blob
    let prev = 0;
    for (let ex = 0.05; ex < 3; ex += 0.05) {
      const t = opticalDepth(ex, 0, 0, 0, 0.5, 0);
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
    // Thin veils to bright cores: ~0.2–0.35 near the edge, ≥ 0.85 in cores.
    expect(ALPHA_MAX * (1 - Math.exp(-opticalDepth(2.5, 0, 0, 0, 0.5, 0)))).toBeGreaterThan(0.85);
    const mid = opticalDepth(1, 0, 0, 0, 0.5, 0);
    expect(opticalDepth(1, 0, 0, 1, 0.5, 0)).toBeLessThan(0.5 * mid); // shallow cumulus
    expect(opticalDepth(1, 1, 0, 0, 0.5, 0)).toBeLessThan(mid); // stratocumulus
    expect(opticalDepth(1, 0, 0, 0, 1.45, 0)).toBeLessThan(mid); // polar
    expect(opticalDepth(1.5, 0, 1, 0, 0.1, 0)).toBeGreaterThan(opticalDepth(1.5, 0, 0, 0, 0.1, 0)); // deep convection
  });
});

describe('climate analysis and regimes', () => {
  it('finds storm tracks and the rotation sense from the wind', () => {
    const pro = analyzeCloudClimate(syntheticSpec(180, 90));
    expect(pro.rotation).toBe(1);
    for (const lat of pro.stormLat) expect(Math.abs(lat / DEG - 45)).toBeLessThan(5);
    expect(pro.stormWind[0]).toBeGreaterThan(5);
    const retro = analyzeCloudClimate(syntheticSpec(180, 90, 1, COVER_REFERENCE_DENSITY, true));
    expect(retro.rotation).toBe(-1);
    for (const lat of retro.stormLat) expect(Math.abs(lat / DEG - 45)).toBeLessThan(5);
    // No wind: defaults, finite.
    const calm = analyzeCloudClimate({ w: 36, h: 18, cover: new Float32Array(36 * 18) });
    expect(calm.rotation).toBe(1);
    for (const lat of calm.stormLat) expect(lat / DEG).toBeCloseTo(50, 5);
    expect(calm.stormWind).toEqual([0, 0]);
  });

  it('packs coverage and regime weights; zero cover stays clear', () => {
    const spec = syntheticSpec(180, 90);
    const g = buildCloudRegimeGrid(spec);
    expect(g.length).toBe(180 * 90 * 4);
    // Uniform rows: coverage follows coverageFraction of the row's cover.
    const row = 45; // just south of the equator
    const f = g[4 * (row * 180 + 17)] / 255;
    expect(Math.abs(f - coverageFraction(spec.cover[row * 180 + 17]))).toBeLessThan(0.05);
    const zero = buildCloudRegimeGrid({ w: 36, h: 18, cover: new Float32Array(36 * 18) });
    for (let i = 0; i < 36 * 18; i++) expect(zero[4 * i]).toBe(0);
    // Divergence of a purely zonal, longitude-independent flow vanishes.
    const div = windDivergence({ w: 36, h: 18, cover: new Float32Array(36 * 18), u: new Float32Array(36 * 18).fill(5), v: new Float32Array(36 * 18) });
    for (const d of div) expect(Math.abs(d)).toBeLessThan(1e-6);
  });
});

describe('cyclones', () => {
  it('are deterministic, live in the storm tracks and move smoothly', () => {
    const spec = syntheticSpec(180, 90);
    const clim = analyzeCloudClimate(spec);
    const a = cycloneStates(37, spec, clim, new Float32Array(CYCLONE_COUNT * CYCLONE_STRIDE));
    const b = cycloneStates(37, spec, clim, new Float32Array(CYCLONE_COUNT * CYCLONE_STRIDE));
    expect(Array.from(a)).toEqual(Array.from(b));
    const c = cycloneStates(37.1, spec, clim, new Float32Array(CYCLONE_COUNT * CYCLONE_STRIDE));
    let active = 0;
    for (let k = 0; k < CYCLONE_COUNT; k++) {
      const o = k * CYCLONE_STRIDE;
      expect(Math.hypot(a[o], a[o + 1], a[o + 2])).toBeCloseTo(1, 5);
      expect(a[o + 4]).toBeGreaterThanOrEqual(0);
      expect(a[o + 4]).toBeLessThanOrEqual(1);
      const lat = Math.asin(a[o + 2]) / DEG;
      expect(Math.abs(lat)).toBeGreaterThan(30);
      expect(Math.abs(lat)).toBeLessThan(75);
      expect(Math.sign(lat)).toBe(a[o + 7]);
      if (a[o + 4] > 0.05) active++;
      // 0.1 s later: same storm, barely moved (unless reborn exactly now).
      const moved = Math.hypot(c[o] - a[o], c[o + 1] - a[o + 1], c[o + 2] - a[o + 2]);
      expect(moved).toBeLessThan(0.01);
    }
    expect(active).toBeGreaterThanOrEqual(CYCLONE_COUNT / 2);
  });

  it('keep their genesis across cloud-spec changes when memoized (no teleporting on month change)', () => {
    const a = syntheticSpec(180, 90);
    // A different "month": shifted storm track, stronger westerlies and zonally varying cover.
    const b = syntheticSpec(180, 90, 1.1);
    for (let i = 0; i < b.u!.length; i++) b.u![i] *= 1.6;
    for (let r = 0; r < 90; r++) for (let c = 0; c < 180; c++) b.cover[r * 180 + c] *= 0.6 + 0.4 * Math.sin((c / 180) * 6 * Math.PI);
    const ca = analyzeCloudClimate(a), cb = analyzeCloudClimate(b);
    const memo = createCycloneMemo();
    const N = CYCLONE_COUNT * CYCLONE_STRIDE;
    let worstMemo = 0, worstStateless = 0;
    for (let t = 3; t < 900; t += 11) {
      memo.fill(NaN);
      const before = cycloneStates(t, a, ca, new Float32Array(N), memo);
      const after = cycloneStates(t + 0.02, b, cb, new Float32Array(N), memo);
      const stateless = cycloneStates(t + 0.02, b, cb, new Float32Array(N));
      for (let k = 0; k < CYCLONE_COUNT; k++) {
        const o = k * CYCLONE_STRIDE;
        if (Math.min(before[o + 4], after[o + 4]) < 0.2) continue;
        const d = (x: Float32Array): number => Math.hypot(x[o] - before[o], x[o + 1] - before[o + 1], x[o + 2] - before[o + 2]);
        worstMemo = Math.max(worstMemo, d(after));
        worstStateless = Math.max(worstStateless, d(stateless));
      }
    }
    expect(worstMemo).toBeLessThan(0.01);
    expect(worstStateless).toBeGreaterThan(0.05); // the scenario does move storms without the memo
    // A fresh memo reproduces the stateless result.
    const m2 = createCycloneMemo();
    expect(Array.from(cycloneStates(123, b, cb, new Float32Array(N), m2))).toEqual(Array.from(cycloneStates(123, b, cb, new Float32Array(N))));
  });

  it('organize cloud without adding much on average (comma template ~ zero mean)', () => {
    let s = 0, n = 0;
    for (let i = -260; i <= 260; i += 4) {
      for (let j = -260; j <= 260; j += 4) {
        const x = i / 100, y = j / 100, r = Math.hypot(x, y);
        if (r > 2.6) continue;
        const th = 1.5 * swirlProfile(r), cs = Math.cos(th), sn = Math.sin(th);
        const env = 1 - Math.min(1, Math.max(0, (r - 1.9) / 0.7));
        s += env * cycloneTemplate(cs * x + sn * y, -sn * x + cs * y);
        n++;
      }
    }
    expect(Math.abs(s / n)).toBeLessThan(0.06);
    // Comma structure: cloudy head poleward of the low, clear dry slot upstream-equatorward.
    expect(cycloneTemplate(0.15, 0.45)).toBeGreaterThan(1);
    expect(cycloneTemplate(-0.4, -0.35)).toBeLessThan(-0.5);
  });

  it('bias the field only near a storm, mirrored between hemispheres', () => {
    const cyc = new Float32Array(CYCLONE_COUNT * CYCLONE_STRIDE);
    const put = (k: number, lat: number, hs: number): void => {
      const o = k * CYCLONE_STRIDE;
      cyc.set([Math.cos(lat), 0, Math.sin(lat), 0.2, 1, 1.5, 1, hs], o);
    };
    put(0, 50 * DEG, 1);
    put(1, -50 * DEG, -1);
    const e = new Float64Array(4), f = new Float64Array(4);
    // Far away: nothing.
    cycloneEffect(cyc, -1, 0, 0, e);
    expect(e[0]).toBe(0);
    // Mirror symmetry through the equator.
    const lat = 55 * DEG, lon = 0.05;
    cycloneEffect(cyc, Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat), e);
    cycloneEffect(cyc, Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), -Math.sin(lat), f);
    expect(f[0]).toBeCloseTo(e[0], 5);
    expect(f[3]).toBeCloseTo(-e[3], 5);
  });
});

describe('map raster', () => {
  const raster = buildCloudNoiseRaster(256, 128);

  it('grows from clear to overcast with the density slider, ~realistic at the default', () => {
    const out = new Uint8ClampedArray(256 * 128 * 4);
    const frac = (d: number): number => rasterizeClouds(raster, syntheticSpec(180, 90, 1, d), 1, out).cloudFraction;
    const f1 = frac(0.1), f2 = frac(0.2), f4 = frac(0.4), f10 = frac(1);
    expect(f1).toBeLessThan(0.08);
    expect(f2).toBeLessThan(f4);
    expect(f4).toBeGreaterThan(0.4);
    expect(f4).toBeLessThan(0.75);
    expect(f10).toBeGreaterThan(0.85);
    const clear = rasterizeClouds(raster, { w: 36, h: 18, cover: new Float32Array(36 * 18) }, 1, out);
    expect(clear.cloudFraction).toBe(0);
    for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(0);
  });

  it('keeps the ITCZ and storm tracks cloudier than the subtropics', () => {
    const w = 256, h = 128;
    const out = new Uint8ClampedArray(w * h * 4);
    rasterizeClouds(raster, syntheticSpec(180, 90), 1, out);
    const band = (a: number, b: number): number => {
      let s = 0, k = 0;
      for (let r = 0; r < h; r++) {
        const lat = Math.abs(90 - ((r + 0.5) * 180) / h);
        if (lat < a || lat >= b) continue;
        for (let c = 0; c < w; c++) s += out[4 * (r * w + c) + 3] / 255;
        k += w;
      }
      return s / k;
    };
    expect(band(0, 10)).toBeGreaterThan(band(20, 30) + 0.1);
    expect(band(45, 60)).toBeGreaterThan(band(20, 30) + 0.1);
  });
});

describe('shader source', () => {
  it('interpolates every shared constant', () => {
    expect(CLOUDS_FRAGMENT).not.toMatch(/undefined|NaN|\$\{/);
    expect(CLOUDS_FRAGMENT).toContain('uniform sampler3D uNoise');
    // Cyclones are evaluated per vertex (smooth fields; see CLOUDS_VERTEX).
    expect(CLOUDS_VERTEX).toContain(`uniform vec4 uCyc[${2 * CYCLONE_COUNT}]`);
    expect(CLOUDS_VERTEX).not.toMatch(/undefined|NaN|\$\{/);
    // The drift path mirrors noiseDrift().
    expect(noiseDrift(0)[0]).toBeCloseTo(0.2 * Math.sin(1.3), 6);
  });
});
