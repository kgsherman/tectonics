/**
 * Fourth polish pass on the globe clouds and the sun glint (QA: clouds at the default density were
 * opaque, hard-edged and hid half the globe; the glint was a broad grey haze disc):
 *  - "Blue Marble" clouds: about half the area has some cloud, most of it thin and translucent; bright
 *    opaque cloud only where the excess over the coverage threshold is large (fronts, storm centres,
 *    convective cores); soft edges with detailed outlines; a perceptually even density slider;
 *  - a small, warm-white, wind-roughened sun glint on open water only, dimmed by the cloud cover.
 */
import { Color, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import type { CloudSpec } from '../src/core/types';
import {
  ALPHA_MAX, BIAS_REF, cloudOpacity, combineNoise, coverageThreshold, EXCESS_REF, excessRef, opticalDepth, TAU_DETAIL, TAU_EDGE,
  tauExcess, VEIL_ALPHA, veilAlpha,
} from '../src/render/cloudsField';
import { GlobeClouds } from '../src/render/cloudsGlobe';
import {
  buildCloudGrids, cloudThickness, COVER_REFERENCE_DENSITY, coverageFraction, THICK_MAX, THICK_MIN, THICK_REF,
} from '../src/render/cloudsModel';
import { buildCloudNoiseRaster, rasterizeClouds } from '../src/render/cloudsRaster';
import { setCloudWorkerFactory } from '../src/render/cloudsWorkerClient';
import { createSharedUniforms } from '../src/render/globeSurface';
import { DEPTH_N, LAGOON_WARM, OCEAN_COLD, OCEAN_WARM, SEA_ICE, SEA_ICE_THIN } from '../src/render/satellitePalette';
import { CLOUDS_FRAGMENT } from '../src/render/shadersClouds';
import { SURFACE_FRAGMENT } from '../src/render/shadersSurface';

const DEG = Math.PI / 180;

/**
 * Earth-like synthetic monthly cloud cover × density with dry and wet longitudes (model cover from
 * ~0.25 in subtropical highs to ~0.95 in storm tracks and the ITCZ) and Earth-like winds.
 */
function syntheticSpec(w: number, h: number, density = COVER_REFERENCE_DENSITY): CloudSpec {
  const n = w * h;
  const cover = new Float32Array(n), u = new Float32Array(n), v = new Float32Array(n);
  for (let r = 0; r < h; r++) {
    const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
    const a = Math.abs(lat) / DEG;
    const m = 0.5 + 0.3 * Math.exp(-((a - 5) ** 2) / 60) + 0.25 * Math.exp(-((a - 52) ** 2) / 150) - 0.15 * Math.exp(-((a - 25) ** 2) / 50);
    const west = 8 * Math.exp(-((a - 45) ** 2) / 120) - 5 * Math.exp(-((a - 12) ** 2) / 80);
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const lon = (c / w) * 2 * Math.PI;
      const model = Math.min(0.97, Math.max(0.15, m + 0.2 * Math.sin(3 * lon + 0.05 * r) + 0.08 * Math.sin(7 * lon - 0.11 * r)));
      cover[i] = Math.min(1, model * density);
      u[i] = west;
      v[i] = -Math.sign(lat) * 2 * Math.exp(-((a - 15) ** 2) / 60) + 2 * Math.sin(4 * lon);
    }
  }
  return { w, h, cover, u, v };
}

/** Area-weighted opacity statistics of an equirect RGBA cloud raster. */
function alphaStats(rgba: Uint8ClampedArray, w: number, h: number): { mean: number; any: number; bright: number; thin: number } {
  let sw = 0, s = 0, any = 0, bright = 0, thin = 0;
  for (let r = 0; r < h; r++) {
    const wt = Math.cos(Math.PI / 2 - ((r + 0.5) * Math.PI) / h);
    for (let c = 0; c < w; c++) {
      const a = rgba[4 * (r * w + c) + 3] / 255;
      sw += wt;
      s += a * wt;
      if (a > 0.03) any += wt;
      if (a > 0.5) bright += wt;
      if (a > 0.03 && a <= 0.5) thin += wt;
    }
  }
  return { mean: s / sw, any: any / sw, bright: bright / sw, thin: thin / sw };
}

describe('Blue Marble clouds (CPU model shared with the shader)', () => {
  const W = 512, H = 256;
  const raster = buildCloudNoiseRaster(W, H);
  const out = new Uint8ClampedArray(W * H * 4);
  const at = (d: number): ReturnType<typeof alphaStats> => {
    rasterizeClouds(raster, syntheticSpec(180, 90, d), 1, out);
    return alphaStats(out, W, H);
  };

  it('covers about half the globe at the default density, mostly with thin, translucent cloud', () => {
    const s = at(COVER_REFERENCE_DENSITY);
    expect(s.any).toBeGreaterThan(0.4);
    expect(s.any).toBeLessThan(0.6);
    // Bright, opaque cloud on ~15–25 % (cores, fronts, storm centres), the rest of the cloud thin.
    expect(s.bright).toBeGreaterThan(0.08);
    expect(s.bright).toBeLessThan(0.28);
    expect(s.thin).toBeGreaterThan(s.bright);
    // The polish-3 look: ~90 % of the cloudy area was opaque.
    expect(s.bright / s.any).toBeLessThan(0.5);
  });

  it('makes the density slider perceptually even: none at 0, light at 0.25, stormy at 1, steady steps', () => {
    const ds = [0, 0.25, 0.4, 0.55, 0.7, 0.85, 1];
    const st = ds.map(at);
    expect(st[0].any).toBe(0);
    expect(st[1].any).toBeGreaterThan(0.15); // light: scattered, mostly thin
    expect(st[1].any).toBeLessThan(0.4);
    expect(st[1].bright).toBeLessThan(0.1);
    expect(st[4].any).toBeGreaterThan(0.65); // overcast-ish
    expect(st[6].any).toBeGreaterThan(0.8); // stormy
    expect(st[6].bright).toBeGreaterThan(0.4);
    // Mean opacity rises at a steady rate from light to stormy (the polish-3 curve jumped between
    // 0.1 and 0.4 and flattened above 0.55).
    const steps: number[] = [];
    for (let k = 2; k < ds.length; k++) steps.push((st[k].mean - st[k - 1].mean) / (ds[k] - ds[k - 1]));
    for (const s of steps) expect(s).toBeGreaterThan(0.25);
    expect(Math.max(...steps) / Math.min(...steps)).toBeLessThan(2.2);
  });

  it('softens edges: opacity rises from zero at the coverage threshold (no edge step)', () => {
    const ref = excessRef(0);
    expect(cloudOpacity(opticalDepth(1e-3, 0, 0, 0, 0.5, 0, 0, 1, 1, ref))).toBeLessThan(1e-4);
    // Continuous and convex near the edge: a translucent margin, not a step.
    const a = (ex: number): number => cloudOpacity(opticalDepth(ex, 0, 0, 0, 0.5, 0, 0, 1, 1, ref));
    expect(a(0.2) - a(0.1)).toBeLessThan(a(0.4) - a(0.3));
    expect(a(0.3)).toBeLessThan(0.05);
  });

  it('keeps overcast climates a mix of thin and thick cloud (reference excess grows with the coverage)', () => {
    expect(excessRef(coverageThreshold(0.5))).toBeCloseTo(EXCESS_REF, 6);
    expect(excessRef(coverageThreshold(0.9))).toBeGreaterThan(excessRef(coverageThreshold(0.6)));
    expect(excessRef(coverageThreshold(0.2))).toBe(EXCESS_REF);
    // Fraction of an overcast (f = 0.9) region with opacity > 0.5 for z ~ N(0,1), plain regime.
    const opaqueShare = (f: number): number => {
      const zt = coverageThreshold(f), ref = excessRef(zt);
      let k = 0;
      const N = 2000;
      for (let i = 0; i < N; i++) {
        const p = (i + 0.5) / N, z = Math.log(p / (1 - p)) / 1.702;
        if (cloudOpacity(opticalDepth(z - zt, 0, 0, 0, 0.8, 0, 0, 1, cloudThickness(0.9), ref)) > 0.5) k++;
      }
      return k / N;
    };
    expect(opaqueShare(0.9)).toBeGreaterThan(0.1);
    expect(opaqueShare(0.9)).toBeLessThan(0.5);
    // A storm widens its cloud by its whole bias but thickens it by less.
    const zt = coverageThreshold(0.5), ref = excessRef(zt);
    const tauBias = opticalDepth(1.5, 0, 0, 0, 0.8, 0, 1, 1, 1, ref);
    expect(tauBias).toBeLessThan(opticalDepth(1.5, 0, 0, 0, 0.8, 0, 0, 1, 1, ref) * 1.3);
    expect(BIAS_REF).toBeGreaterThan(0);
  });

  it('thickens cloud with the climate cloudiness, clamped, stored in the aux grid', () => {
    expect(cloudThickness(THICK_REF)).toBeCloseTo(1, 6);
    expect(cloudThickness(0)).toBe(THICK_MIN);
    expect(cloudThickness(100)).toBe(THICK_MAX);
    let prev = 0;
    for (let x = 0.05; x < 3; x += 0.05) {
      const t = cloudThickness(x);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
    const spec = syntheticSpec(72, 36);
    const g = buildCloudGrids(spec);
    for (let i = 0; i < spec.cover.length; i += 97) {
      expect((g.aux[4 * i + 2] / 255) * THICK_MAX).toBeGreaterThanOrEqual(THICK_MIN - 0.02);
    }
    // Wetter cells carry thicker cloud.
    let iw = 0, id = 0;
    for (let i = 0; i < spec.cover.length; i++) {
      if (spec.cover[i] > spec.cover[iw]) iw = i;
      if (spec.cover[i] < spec.cover[id]) id = i;
    }
    expect(g.aux[4 * iw + 2]).toBeGreaterThan(g.aux[4 * id + 2]);
  });

  it('drives the optical depth by the smoother excess (detail shapes the outline, not glitter)', () => {
    expect(tauExcess(-0.1, 0.5)).toBe(0);
    expect(tauExcess(0.4, -0.2)).toBeCloseTo(TAU_EDGE * 0.4, 9);
    expect(tauExcess(1, 0.8)).toBe(0.8);
    // combineNoise with TAU_DETAIL of the detail: the excess moves by only part of the detail.
    const zt = coverageThreshold(0.5);
    const full = combineNoise(0.3, 1.5, zt, 0, 0, 0) - combineNoise(0.3, 0, zt, 0, 0, 0);
    const part = combineNoise(0.3, TAU_DETAIL * 1.5, zt, 0, 0, 0) - combineNoise(0.3, 0, zt, 0, 0, 0);
    expect(part).toBeCloseTo(TAU_DETAIL * full, 9);
  });

  it('adds a thin veil around cloud masses, none in fair-weather cumulus or dry climates', () => {
    const zt = coverageThreshold(0.5);
    expect(veilAlpha(zt - 2, zt, 0, 0)).toBe(0); // far from cloud
    expect(veilAlpha(zt + 0.5, zt, 1, 0)).toBe(0); // cumulus: distinct puffs in clear air
    // Dry climates: faint at the thinnest cloud the grids carry (THICK_MIN), full in cloudy ones.
    expect(veilAlpha(zt + 2, zt, 0, 0, THICK_MIN)).toBeLessThan(0.3 * VEIL_ALPHA);
    expect(veilAlpha(zt + 2, zt, 0, 0, THICK_MIN)).toBeLessThan(0.3 * veilAlpha(zt + 2, zt, 0, 0, 1) + 1e-9);
    expect(veilAlpha(zt + 2, zt, 0, 0, 0.6)).toBeLessThan(veilAlpha(zt + 2, zt, 0, 0, 1));
    let prev = 0, maxJump = 0;
    for (let nb = zt - 1.5; nb < zt + 2; nb += 0.02) {
      const a = veilAlpha(nb, zt, 0, 0);
      expect(a).toBeLessThanOrEqual(VEIL_ALPHA + 1e-9);
      maxJump = Math.max(maxJump, Math.abs(a - prev));
      prev = a;
    }
    expect(prev).toBeGreaterThan(0.3 * VEIL_ALPHA);
    // Wispy inside: the texture noise streaks it.
    expect(veilAlpha(zt + 1, zt, 0, 0, 1, 1.5)).toBeGreaterThan(2 * veilAlpha(zt + 1, zt, 0, 0, 1, -1.5));
    expect(maxJump).toBeLessThan(0.01); // a soft ramp, no step
  });

  it('saturates opacity slowly (thick cores keep their texture)', () => {
    expect(cloudOpacity(0)).toBe(0);
    expect(cloudOpacity(0.05)).toBeCloseTo(0.05 * ALPHA_MAX, 2);
    expect(cloudOpacity(50)).toBeLessThanOrEqual(ALPHA_MAX);
    expect(cloudOpacity(10) - cloudOpacity(3)).toBeGreaterThan(0.08);
  });

  it('mirrors the CPU model in the globe shader', () => {
    expect(CLOUDS_FRAGMENT).not.toMatch(/undefined|NaN|\$\{|EDGE_TAU|edgeW/);
    expect(CLOUDS_FRAGMENT).toContain('pow(exT / (exRef + BIAS_REF * max(bias, 0.0)), TAU_POW) * thickness');
    expect(CLOUDS_FRAGMENT).toContain('float thickness = aux.b * THICK_MAX;');
    expect(CLOUDS_FRAGMENT).toContain('alpha = ALPHA_MAX * (1.0 - 1.0 / (q * q));');
    expect(CLOUDS_FRAGMENT).toMatch(/float exT = max\(ex - \([\d.]+ - [\d.]+ \* cv\) \* amp \* ia \* nd, [\d.]+ \* ex\);/);
    expect(CLOUDS_FRAGMENT).toContain('* (1.0 - cu) * sstep(0.3, 0.9, thickness)');
    expect(CLOUDS_FRAGMENT).toContain('float wisps = 0.1 + 0.9 * sstep(-0.6, 1.0, 0.3 * n1 + ndt);');
    // Shadows only under optically thick cloud.
    expect(CLOUDS_FRAGMENT).toContain('sstep(0.3, 1.5, zs / exRef) * min(1.0, thickness)');
    // Coverage still thresholds the noise at the requested fraction (the soft opacity is on top).
    expect(coverageFraction(0)).toBe(0);
  });
});

/** Parses a `const float NAME = value;` from GLSL source. */
function glslFloat(src: string, name: string): number {
  const m = new RegExp(`const float ${name} = ([\\d.eE+-]+);`).exec(src);
  if (!m) throw new Error(`no ${name}`);
  return Number(m[1]);
}

describe('sun glint', () => {
  const share = glslFloat(SURFACE_FRAGMENT, 'GLINT_SLOPE_SHARE');
  const gain = glslFloat(SURFACE_FRAGMENT, 'GLINT_GAIN');
  const peak = glslFloat(SURFACE_FRAGMENT, 'GLINT_PEAK');
  /** JS mirror of sunGlint() for a facet tilted by `theta` from the half vector (sun and view 27° off the normal). */
  const glint = (theta: number, wind: number): number => {
    const m2 = share * (0.003 + 0.00512 * wind);
    const nh = Math.cos(theta), nh2 = nh * nh;
    const beck = (m: number): number => Math.exp((nh2 - 1) / (nh2 * m)) / (Math.PI * m * nh2 * nh2);
    const D = 0.6 * beck(0.5 * m2) + 0.4 * beck(1.5 * m2);
    const F = 0.02 + 0.98 * (1 - Math.cos(27 * DEG)) ** 5;
    const spec = (Math.PI * D * F) / (4 * Math.cos(27 * DEG));
    return peak * (1 - Math.exp((-gain * spec) / peak));
  };
  const halfWidth = (wind: number): number => {
    const p = glint(0, wind);
    let t = 0;
    while (glint(t, wind) > 0.5 * p) t += 0.001;
    return t;
  };

  it('is a small, bright-ish (unsaturated) spot that widens and dims with the wind', () => {
    const p6 = glint(0, 6);
    expect(p6).toBeGreaterThan(0.2); // bright-ish over a ~0.03 ocean
    expect(p6).toBeLessThan(0.75 * peak); // never the flat-topped, saturated disc
    expect(halfWidth(6)).toBeLessThan(4 * DEG); // was ~7.5° (a disc ~18 % of the globe's radius)
    expect(halfWidth(12)).toBeGreaterThan(halfWidth(3));
    expect(glint(0, 12)).toBeLessThan(glint(0, 3));
    // No haze: at 3× the half width the glint is gone.
    expect(glint(3 * halfWidth(6), 6)).toBeLessThan(0.02 * p6);
  });

  it('is warm white, on open water only, roughened by the cloud layer wind and dimmed by its cover', () => {
    const tint = /const vec3 GLINT_TINT = vec3\(([\d.]+), ([\d.]+), ([\d.]+)\);/.exec(SURFACE_FRAGMENT)!.slice(1).map(Number);
    expect(tint[0]).toBeGreaterThan(tint[1]);
    expect(tint[1]).toBeGreaterThan(tint[2]);
    expect(tint[2]).toBeGreaterThan(0.5);
    expect(SURFACE_FRAGMENT).toMatch(/if \(ocean > 0\.0\)/);
    // Not on sea ice, yet full strength over all open water, bright turquoise shelves included (a
    // luminance test dimmed it there): the mask tests the albedo's darkest channel (whiteness).
    expect(SURFACE_FRAGMENT).toContain('float albedoMin = min(col.r, min(col.g, col.b));');
    const mask = /\(1\.0 - smoothstep\(([\d.]+), ([\d.]+), albedoMin\)\)/.exec(SURFACE_FRAGMENT);
    expect(mask).not.toBeNull();
    const [lo, hi] = [Number(mask![1]), Number(mask![2])];
    const waterMask = (rgb: ArrayLike<number>): number => {
      const x = Math.min(1, Math.max(0, (Math.min(rgb[0], rgb[1], rgb[2]) - lo) / (hi - lo)));
      return 1 - x * x * (3 - 2 * x);
    };
    const depth = (ramp: Float32Array, i: number): number[] => [ramp[3 * i], ramp[3 * i + 1], ramp[3 * i + 2]];
    for (let i = 0; i < DEPTH_N; i += 7) {
      expect(waterMask(depth(OCEAN_WARM, i))).toBe(1);
      expect(waterMask(depth(OCEAN_COLD, i))).toBe(1);
    }
    expect(waterMask(LAGOON_WARM)).toBe(1);
    expect(waterMask(SEA_ICE_THIN)).toBe(0);
    expect(waterMask(SEA_ICE)).toBe(0);
    expect(SURFACE_FRAGMENT).toContain('wind = sqrt(dot(w, w) + GLINT_GUST * GLINT_GUST);');
    expect(SURFACE_FRAGMENT).toContain('(1.0 - 0.7 * cover) * sunGlint(n0, V, uSunDir, wind) * GLINT_TINT');
    expect(SURFACE_FRAGMENT).not.toContain('min(spec, 0.6)');
  });

  it('gets the cloud grids from GlobeClouds through the shared uniforms', async () => {
    setCloudWorkerFactory(null);
    const shared = createSharedUniforms(new Color(0.3, 0.5, 1));
    expect(shared.uCloudOn.value).toBe(0);
    const clouds = new GlobeClouds(shared);
    clouds.set(syntheticSpec(72, 36));
    for (let i = 0; i < 200 && clouds.busy; i++) await new Promise((r) => setTimeout(r, 10));
    expect(shared.uCloudOn.value).toBe(2);
    expect(shared.uCloudGrid.value).not.toBeNull();
    expect(shared.uCloudWind.value).not.toBeNull();
    // Without wind: coverage only (the glint keeps a constant roughness).
    const s = syntheticSpec(72, 36);
    clouds.set({ w: s.w, h: s.h, cover: s.cover });
    for (let i = 0; i < 200 && clouds.busy; i++) await new Promise((r) => setTimeout(r, 10));
    expect(shared.uCloudOn.value).toBe(1);
    clouds.set(null);
    expect(shared.uCloudOn.value).toBe(0);
    expect(shared.uCloudGrid.value).toBeNull();
    clouds.dispose();
    expect(new Vector3().copy(shared.uSunDir.value).length()).toBeCloseTo(1, 6);
  });
});
