/**
 * Fifth polish pass on the clouds (visual QA against DSCOVR/EPIC full-disk imagery):
 *  - extratropical cyclones: a wave train per hemisphere (no storms merging into blobs), winding up
 *    into occluded spirals, weaker over dry continents; frontal / comma cloud bright and continuous;
 *  - deep convection organized into clusters (mesoscale convective systems) with clear gaps, textured
 *    at the fine scales, instead of an even band of cotton wool; thinner anvils and veil (less haze);
 *  - cirrus as streaks (a coarse streak octave resolved at the default zoom and in the map's world
 *    raster, fine fibres up close) instead of smooth airbrushed ovals;
 *  - stratocumulus decks without billow creases (worm-like strands).
 */
import { describe, expect, it } from 'vitest';
import type { CloudSpec } from '../src/core/types';
import {
  CIRRUS_COARSE, CIRRUS_SCALE, CIRRUS_STRAND_MEAN, cirrusFades, cirrusFibre, CLUSTER_MEAN, CLUSTER_SCALE, CLUSTER_WARP, cellStage,
  clusterBias, clusterCore, detailParams, newDetailShaping, ORGANIZED_COARSE, SHAPE_STAGE_SIZE, shapeStage, tauDetail, TAU_DETAIL,
} from '../src/render/cloudsField';
import {
  analyzeCloudClimate, buildCloudGrids, COVER_REFERENCE_DENSITY, CYCLONE_COUNT, CYCLONE_STRIDE, CYCLONE_SWIRL_MAX, CYCLONES_PER_HEMISPHERE,
  cycloneStates,
} from '../src/render/cloudsModel';
import { cloudCellVolume, cloudDetailVolume, cloudNoiseVolume } from '../src/render/cloudsNoise';
import { buildCloudNoiseRaster, rasterizeClouds } from '../src/render/cloudsRaster';
import { CLOUDS_FRAGMENT } from '../src/render/shadersClouds';

const DEG = Math.PI / 180;

/** Earth-like synthetic climate (as polish.clouds.test.ts): westerlies at ±45°, trades, ITCZ. */
function syntheticSpec(w: number, h: number, density = COVER_REFERENCE_DENSITY, dryLon?: [number, number]): CloudSpec {
  const n = w * h;
  const cover = new Float32Array(n), u = new Float32Array(n), v = new Float32Array(n);
  for (let r = 0; r < h; r++) {
    const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
    const a = Math.abs(lat) / DEG;
    const m = 0.5 + 0.3 * Math.exp(-((a - 5) ** 2) / 60) + 0.25 * Math.exp(-((a - 52) ** 2) / 150) - 0.05 * Math.exp(-((a - 25) ** 2) / 50);
    const west = 8 * Math.exp(-((a - 45) ** 2) / 120) - 5 * Math.exp(-((a - 12) ** 2) / 80);
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const lon = -180 + ((c + 0.5) * 360) / w;
      const dry = dryLon && lon >= dryLon[0] && lon < dryLon[1];
      cover[i] = Math.min(1, dry ? 0.15 : m) * density;
      u[i] = west;
      v[i] = -Math.sign(lat) * 2 * Math.exp(-((a - 15) ** 2) / 60);
    }
  }
  return { w, h, cover, u, v };
}

/** Uniform points on the sphere (Fibonacci lattice). */
function* sphere(n: number): Generator<[number, number, number]> {
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * (i + 0.5)) / n, c = Math.sqrt(1 - z * z), lon = i * ga;
    yield [c * Math.cos(lon), c * Math.sin(lon), z];
  }
}

describe('extratropical cyclones (polish 5)', () => {
  const spec = syntheticSpec(180, 90);
  const clim = analyzeCloudClimate(spec);
  const N = CYCLONE_COUNT * CYCLONE_STRIDE;

  it('travel as a wave train: storms of a hemisphere keep their spacing instead of merging', () => {
    let minSep = Infinity;
    for (let t = 0; t < 1500; t += 7) {
      const s = cycloneStates(t, spec, clim, new Float32Array(N));
      for (let hemi = 0; hemi < 2; hemi++) {
        for (let a = 0; a < CYCLONES_PER_HEMISPHERE; a++) {
          for (let b = a + 1; b < CYCLONES_PER_HEMISPHERE; b++) {
            const oa = (hemi * CYCLONES_PER_HEMISPHERE + a) * CYCLONE_STRIDE, ob = (hemi * CYCLONES_PER_HEMISPHERE + b) * CYCLONE_STRIDE;
            if (s[oa + 4] < 0.2 || s[ob + 4] < 0.2) continue;
            const dot = s[oa] * s[ob] + s[oa + 1] * s[ob + 1] + s[oa + 2] * s[ob + 2];
            // Separation in units of the larger storm's radius.
            minSep = Math.min(minSep, Math.acos(Math.min(1, dot)) / Math.max(s[oa + 3], s[ob + 3]));
          }
        }
      }
    }
    // Comma heads and fronts lie within ~1.5 radii of the low: neighbours never share them. (Polish 4:
    // independently drifting storms were within 1.5 radii of one another 87 % of the time, down to
    // 0.09 radii: merged into shapeless blobs.)
    expect(minSep).toBeGreaterThan(1.5);
  });

  it('wind up into occluded spirals when mature and weaken over dry climates', () => {
    expect(CYCLONE_SWIRL_MAX).toBeGreaterThanOrEqual(3);
    // A dry sector (a desert continent) across all longitudes the storms pass through over time.
    const dry = syntheticSpec(180, 90, COVER_REFERENCE_DENSITY, [-60, 60]);
    let wet = 0, arid = 0, kw = 0, ka = 0;
    for (let t = 0; t < 1500; t += 5) {
      const s = cycloneStates(t, dry, clim, new Float32Array(N));
      const ref = cycloneStates(t, spec, clim, new Float32Array(N));
      for (let k = 0; k < CYCLONE_COUNT; k++) {
        const o = k * CYCLONE_STRIDE;
        if (ref[o + 4] < 0.2) continue;
        const lon = Math.atan2(s[o + 1], s[o]) / DEG;
        const ratio = s[o + 4] / ref[o + 4];
        if (lon > -50 && lon < 50) {
          arid += ratio;
          ka++;
        } else if (lon < -70 || lon > 70) {
          wet += ratio;
          kw++;
        }
      }
    }
    expect(wet / kw).toBeGreaterThan(0.95);
    expect(arid / ka).toBeLessThan(0.6);
  });
});

describe('deep-convective clusters (polish 5)', () => {
  it('are a zero-mean coverage bias: bright cores, clearer gaps, varied sizes', () => {
    const vol = cloudNoiseVolume(), cvol = cloudCellVolume();
    const tmp = new Float32Array(4), st = new Float64Array(SHAPE_STAGE_SIZE), cell = new Float64Array(3);
    let s = 0, n = 0, cores = 0;
    for (const [x, y, z] of sphere(20000)) {
      shapeStage(vol, x, y, z, tmp, st);
      cellStage(cvol, st, tmp, cell, CLUSTER_SCALE, null, CLUSTER_WARP);
      const c = clusterCore(cell[2], st[8]);
      s += c;
      n++;
      if (c > 0.5) cores++;
    }
    expect(Math.abs(s / n - CLUSTER_MEAN)).toBeLessThan(0.02);
    expect(cores / n).toBeGreaterThan(0.15);
    expect(cores / n).toBeLessThan(0.35);
    // Cores raise the coverage (negative threshold shift), gaps lower it; none outside convection.
    expect(clusterBias(1, 1)).toBeGreaterThan(1);
    expect(clusterBias(1, 0)).toBeLessThan(-0.3);
    expect(clusterBias(0, 1)).toBe(0);
    // Bigger clusters where the size noise is high.
    expect(clusterCore(0.5, 1.5)).toBeGreaterThan(clusterCore(0.5, -1.5));
    expect(clusterCore(0, 0)).toBe(1);
    // Towers keep more of the detail in their optical depth (cauliflower tops).
    expect(tauDetail(1)).toBeGreaterThan(tauDetail(0));
    expect(tauDetail(0)).toBe(TAU_DETAIL);
  });

  it('turn the convective band into clusters and gaps instead of an even grey haze (map raster)', () => {
    // A tropical climate: convergent trades onto a cloudy ITCZ.
    const w = 180, h = 90, n = w * h;
    const cover = new Float32Array(n), u = new Float32Array(n), v = new Float32Array(n);
    for (let r = 0; r < h; r++) {
      const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h, a = Math.abs(lat) / DEG;
      for (let c = 0; c < w; c++) {
        const i = r * w + c;
        cover[i] = Math.min(1, 0.45 + 0.5 * Math.exp(-(a * a) / 60)) * COVER_REFERENCE_DENSITY;
        u[i] = -5 * Math.exp(-((a - 12) ** 2) / 80);
        v[i] = -Math.sign(lat) * 3 * Math.exp(-((a - 10) ** 2) / 60);
      }
    }
    const spec: CloudSpec = { w, h, cover, u, v };
    const g = buildCloudGrids(spec);
    const W = 768, H = 384;
    const out = new Uint8ClampedArray(W * H * 4);
    rasterizeClouds(buildCloudNoiseRaster(W, H), spec, 1, out);
    let k = 0, clear = 0, haze = 0, opaque = 0;
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const gi = Math.floor((r / H) * h) * w + Math.floor((c / W) * w);
        if (g.regime[4 * gi + 2] < 0.6 * 255) continue;
        const al = out[4 * (r * W + c) + 3] / 255;
        k++;
        if (al < 0.05) clear++;
        else if (al > 0.6) opaque++;
        else haze++;
      }
    }
    expect(k).toBeGreaterThan(5000);
    // Polish 4: 13 % clear, 61 % grey haze, 26 % opaque.
    expect(clear / k).toBeGreaterThan(0.18);
    expect(haze / k).toBeLessThan(0.56);
    expect(opaque / k).toBeGreaterThan(0.22);
  });
});

describe('texture regimes (polish 5)', () => {
  it('keeps organized frontal / comma cloud continuous (no coarse-octave holes)', () => {
    const sh = newDetailShaping();
    const free = { ...detailParams(0, 0, 0, 0, 0, sh) };
    const org = { ...detailParams(0, 0, 0, 0, 0, sh, 1) };
    expect(org.coarse).toBeCloseTo(free.coarse * (1 - ORGANIZED_COARSE), 9);
    expect(org.gain).toBe(free.gain);
  });
});

describe('cirrus streaks (polish 5)', () => {
  it('uses the soft strand weight’s mean where the streaks are sub-pixel', () => {
    let s = 0, wsum = 0;
    for (let x = -6; x <= 6; x += 0.001) {
      const p = Math.exp(-x * x / 2), t = Math.min(1, Math.max(0, (x + 0.8) / 2.4));
      s += p * t * t * (3 - 2 * t);
      wsum += p;
    }
    expect(CIRRUS_STRAND_MEAN).toBeCloseTo(s / wsum, 2);
  });

  it('resolves the coarse streaks at the default globe zoom and in the world raster, fine fibres up close', () => {
    const [c4, f4] = cirrusFades(0.0029); // globe default zoom, DPR 1
    expect(c4).toBeGreaterThan(0.9);
    expect(f4).toBeLessThan(0.1);
    const [cw, fw] = cirrusFades(Math.PI / 768); // map world raster
    expect(cw).toBeGreaterThan(0.5);
    expect(fw).toBe(0);
    const [cc, fc] = cirrusFades(0.0003); // close-up
    expect(cc).toBe(1);
    expect(fc).toBe(1);
    expect(CIRRUS_COARSE).toBeLessThan(1);
    expect(CIRRUS_SCALE * CIRRUS_COARSE).toBeGreaterThan(0.5);
  });

  it('are streaks: the fibre noise varies far faster north–south than east–west', () => {
    const vol = cloudNoiseVolume(), dvol = cloudDetailVolume();
    const tmp = new Float32Array(4), st = new Float64Array(SHAPE_STAGE_SIZE);
    const at = (lat: number, lon: number, fine: number): number => {
      shapeStage(vol, Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat), tmp, st);
      return cirrusFibre(dvol, st, tmp, fine);
    };
    for (const fine of [0, 1]) {
      const d = fine ? 0.0015 : 0.004;
      let ew = 0, ns = 0, k = 0;
      for (let i = 0; i < 400; i++) {
        const lat = (-50 + (i % 20) * 5) * DEG, lon = (-170 + Math.floor(i / 20) * 17) * DEG;
        const c = at(lat, lon, fine);
        ew += (at(lat, lon + d / Math.cos(lat), fine) - c) ** 2;
        ns += (at(lat + d, lon, fine) - c) ** 2;
        k++;
      }
      expect(ns / ew).toBeGreaterThan(4);
    }
  });
});

describe('shader mirrors the polish-5 model', () => {
  it('interpolates the cluster, cirrus-streak and organized-cloud terms', () => {
    expect(CLOUDS_FRAGMENT).not.toMatch(/undefined|NaN|\$\{/);
    expect(CLOUDS_FRAGMENT).toContain('zthr -= cv * CLUSTER_GAIN * (clCore - CLUSTER_MEAN);');
    expect(CLOUDS_FRAGMENT).toContain('cv * CLUSTER_GAIN * CLUSTER_ROUGH * clCore * nd');
    expect(CLOUDS_FRAGMENT).toContain('clCore = 1.0 - sstep(0.15, clamp(0.6 + 0.25 * vary, 0.3, 0.95), kq.g * 1.2);');
    expect(CLOUDS_FRAGMENT).toContain('dq2p.x *= 1.0 - ORGANIZED_COARSE * organized;');
    expect(CLOUDS_FRAGMENT).toContain('float strand = sstep(-0.8, 1.6, nc);');
    expect(CLOUDS_FRAGMENT).toContain('a0 * sc0 + cw0 + OFF_C2');
    expect(CLOUDS_FRAGMENT).toMatch(/const float CLUSTER_MEAN = [\d.]+;/);
  });
});
