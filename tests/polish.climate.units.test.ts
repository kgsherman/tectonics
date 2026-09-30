/**
 * Polish-phase climate mechanisms (unit level): interhemispheric overturning (energy-neutral, only
 * with a single-hemisphere channel), cloud regimes, ice-phase precipitation onset, terrain-blocked
 * moisture diffusion and the snow-surface inversion.
 */
import { describe, expect, it } from 'vitest';
import { makeGrid } from '../src/climate/dynGrid';
import { overturningHeating } from '../src/climate/energyOverturning';
import { cloudCover } from '../src/climate/hydroCloud';
import { HYDRO_TUNING } from '../src/climate/hydroTuning';
import { ImplicitDiffusion } from '../src/climate/moistureDiffusion';
import { makeHydroGrid } from '../src/climate/moistureGrid';
import { iceToWaterSaturation } from '../src/climate/moistureThermo';
import { applySurfaceInversion } from '../src/climate/surfaceInversion';
import { ebmTuning } from '../src/climate/tuning';
import { DEFAULT_CLIMATE_PARAMS } from '../src/climate/climate';

const DEG = Math.PI / 180;

function withTuning<T>(key: keyof typeof ebmTuning, value: number, f: () => T): T {
  const old = ebmTuning[key];
  (ebmTuning as Record<string, number>)[key] = value;
  try {
    return f();
  } finally {
    (ebmTuning as Record<string, number>)[key] = old as number;
  }
}

describe('interhemispheric overturning', () => {
  const g = makeGrid(90, 45);
  const R2 = 6.371e6 ** 2;
  /** Land mask: a meridional continent from `south` to the north pole (optionally a second one to the south pole). */
  const mask = (south: number, toSouthPole: boolean): Uint8Array => {
    const land = new Uint8Array(g.n);
    for (let j = 0; j < g.ny; j++) {
      const lat = g.lat[j] / DEG;
      for (let c = 0; c < g.nx; c++) {
        const lon = g.lon[c] / DEG;
        if (Math.abs(lon) < 20 && (lat > south || toSouthPole)) land[j * g.nx + c] = 1;
      }
    }
    return land;
  };

  it('warms the closed hemisphere and cools the channel hemisphere, conserving energy', () => {
    const land = mask(-45, false); // open channel south of 45°S, basins closed in the north
    const q = withTuning('overturningPW', 0.5, () => overturningHeating(g, land));
    expect(q).not.toBeNull();
    let total = 0;
    let north = 0;
    let south = 0;
    for (let j = 0; j < g.ny; j++) {
      for (let c = 0; c < g.nx; c++) {
        const i = j * g.nx + c;
        if (land[i]) expect(q![i]).toBe(0);
        const flux = q![i] * g.area[j] * R2;
        total += flux;
        if (g.lat[j] > 0) north += flux;
        else south += flux;
      }
    }
    expect(Math.abs(total)).toBeLessThan(1e-6 * 0.5e15);
    expect(north).toBeCloseTo(0.5e15, -10);
    expect(south).toBeCloseTo(-0.5e15, -10);
  });

  it('is off without a channel, with channels in both hemispheres, and at zero strength', () => {
    expect(withTuning('overturningPW', 0.5, () => overturningHeating(g, mask(-45, true)))).toBeNull();
    expect(withTuning('overturningPW', 0.5, () => overturningHeating(g, new Uint8Array(g.n)))).toBeNull();
    expect(withTuning('overturningPW', 0, () => overturningHeating(g, mask(-45, false)))).toBeNull();
  });
});

describe('cloud regimes', () => {
  const t = HYDRO_TUNING;
  it('thins humid layer cloud under subsidence and adds storm-track cloud', () => {
    expect(cloudCover(0.7, 0, 0, 1, t, -1.2)).toBeLessThan(cloudCover(0.7, 0, 0, 1, t, 0) - 0.2);
    expect(cloudCover(0.5, 0.5, 0, 1, t, 0, 1)).toBeGreaterThan(cloudCover(0.5, 0.5, 0, 1, t, 0, 0) + 0.2);
  });
  it('builds stratocumulus over cool water under subsidence but not over warm water', () => {
    const cool = cloudCover(0.4, 0, 4, 1, t, -1, 0, 16);
    const warm = cloudCover(0.4, 0, 4, 1, t, -1, 0, 28);
    expect(cool).toBeGreaterThan(0.5);
    expect(warm).toBeLessThan(cool - 0.3);
  });
  it('needs water: a dry column is clear even in a storm track, over cold water or at the pole', () => {
    // (moisture = 0 gives rh = 0 and P = 0 everywhere: a planet without water has no clouds)
    expect(cloudCover(0, 0, 4, 1, t, -1, 1.5, 16)).toBeLessThan(1e-9);
    expect(cloudCover(0, 0, 0, 1, t, 0, 1.5, -5)).toBeLessThan(1e-9);
    // Ordinary oceanic columns keep their regimes.
    expect(cloudCover(0.6, 0, 4, 1, t, -1, 0, 16)).toBeGreaterThan(0.6);
  });
  it('keeps deserts clear and deep convection cloudy', () => {
    expect(cloudCover(0.25, 0.1, 0, 0, t, -1, 0, 30)).toBeLessThan(0.15);
    expect(cloudCover(0.8, 12, 0, 0, t, 1.5, 0, 26)).toBeGreaterThan(0.7);
  });
});

describe('moisture physics', () => {
  it('ice saturation lies below water saturation below 0 °C', () => {
    expect(iceToWaterSaturation(5)).toBe(1);
    expect(iceToWaterSaturation(-10)).toBeCloseTo(0.905, 2);
    expect(iceToWaterSaturation(-30)).toBeCloseTo(0.744, 2);
  });

  it('terrain blocking keeps a ridge from mixing moisture across it (mass conserved)', () => {
    const g = makeHydroGrid(90, 45);
    const K = new Float64Array(g.n).fill(3e6);
    const height = new Float64Array(g.n);
    for (let j = 0; j < g.h; j++) for (let c = 43; c < 47; c++) height[j * g.w + c] = 4000;
    const run = (h: Float64Array | null): Float64Array => {
      const d = new ImplicitDiffusion(g);
      d.setup(K, 6 * 3600, h, 1500);
      const W = new Float64Array(g.n);
      for (let j = 0; j < g.h; j++) for (let c = 30; c < 43; c++) W[j * g.w + c] = 30;
      for (let s = 0; s < 40; s++) d.apply(W);
      return W;
    };
    const free = run(null);
    const blocked = run(height);
    let lee = 0, leeFree = 0, mass = 0, massFree = 0;
    for (let j = 0; j < g.h; j++) {
      for (let c = 0; c < g.w; c++) {
        const i = j * g.w + c;
        mass += blocked[i] * g.rowArea[j];
        massFree += free[i] * g.rowArea[j];
        if (c >= 47 && c < 55) {
          lee += blocked[i];
          leeFree += free[i];
        }
      }
    }
    expect(lee).toBeLessThan(0.5 * leeFree);
    expect(mass).toBeCloseTo(massFree, 6);
  });
});

describe('snow-surface inversion', () => {
  it('cools snow-covered land in the polar night only', () => {
    const w = 4, h = 4, N = w * h;
    const temp = new Float32Array(12 * N).fill(-20);
    const snow = new Float32Array(12 * N).fill(1);
    const land = new Uint8Array(N).fill(1);
    land[1] = 0;
    withTuning('inversionMax', 10, () => applySurfaceInversion(temp, snow, land, w, h, DEFAULT_CLIMATE_PARAMS));
    // Row 0 is the northernmost (≈67.5°N): January dark → strong inversion; July bright → none.
    expect(temp[0]).toBeLessThan(-26);
    expect(temp[6 * N]).toBeCloseTo(-20, 5);
    expect(temp[1]).toBe(-20); // ocean untouched
  });

  it('is a clear-sky phenomenon: overcast winters stay mixed', () => {
    const w = 4, h = 4, N = w * h;
    const run = (cloudCover: number): Float32Array => {
      const temp = new Float32Array(12 * N).fill(-20);
      const snow = new Float32Array(12 * N).fill(1);
      const cloud = new Float32Array(12 * N).fill(cloudCover);
      applySurfaceInversion(temp, snow, new Uint8Array(N).fill(1), w, h, DEFAULT_CLIMATE_PARAMS, undefined, cloud);
      return temp;
    };
    const clear = run(ebmTuning.inversionCloudClear - 0.1);
    const overcast = run(ebmTuning.inversionCloudOvercast + 0.05);
    const none = new Float32Array(12 * N).fill(-20);
    applySurfaceInversion(none, new Float32Array(12 * N).fill(1), new Uint8Array(N).fill(1), w, h, DEFAULT_CLIMATE_PARAMS);
    expect(clear[0]).toBeCloseTo(none[0], 5); // full inversion under clear skies
    expect(clear[0]).toBeLessThan(-23);
    expect(overcast[0]).toBe(-20);
  });
});
