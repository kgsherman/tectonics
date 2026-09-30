import { describe, expect, it } from 'vitest';
import { Color, NoColorSpace, SRGBColorSpace, Vector3 } from 'three';
import { DEG } from '../src/core/constants';
import { GlobeSurface, LIGHT_RELIEF } from '../src/render/globeSurface';
import { buildFloatMips } from '../src/render/globeTextures';
import { SURFACE_FRAGMENT } from '../src/render/shadersSurface';
import { applyShade, cloudAlpha, hillshade, nightShade } from '../src/render/mapShading';
import { HeightField } from '../src/render/viewHeight';
import { PLANET_RADIUS_M, reliefDisplacement } from '../src/render/viewUtil';

describe('map hillshade', () => {
  it('is exactly 1 on flat ground and on seas below sea level', () => {
    const w = 64, h = 32;
    const flat = new Float32Array(w * h).fill(500);
    for (const v of hillshade(flat, w, h, 0)) expect(v).toBeCloseTo(1, 12);
    const bumpySea = Float32Array.from({ length: w * h }, (_, i) => -4000 + 1000 * Math.sin(i));
    for (const v of hillshade(bumpySea, w, h, 0)) expect(v).toBeCloseTo(1, 12);
  });

  it('lights slopes facing the north-west and shadows slopes facing the south-east', () => {
    const w = 360, h = 180;
    // A ridge along a meridian: west flank faces west (lit), east flank faces east (shadowed).
    const hm = new Float32Array(w * h);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) hm[r * w + c] = Math.max(0, 3000 - 400 * Math.abs(c - 180));
    const s = hillshade(hm, w, h, 0);
    const row = 90 * w;
    expect(s[row + 177]).toBeGreaterThan(1.05);
    expect(s[row + 183]).toBeLessThan(0.95);
    for (const v of s) {
      expect(v).toBeGreaterThanOrEqual(0.28);
      expect(v).toBeLessThanOrEqual(1.35);
    }
  });

  it('applyShade keeps neutral pixels and alpha, darkens in linear light', () => {
    const rgba = new Uint8ClampedArray([200, 100, 50, 255, 200, 100, 50, 128]);
    const out = new Uint8ClampedArray(8);
    applyShade(rgba, 2, 1, new Float32Array([1, 0.5]), 2, 1, out);
    expect(Array.from(out.subarray(0, 4))).toEqual([200, 100, 50, 255]);
    expect(out[7]).toBe(128);
    // Half the linear light of sRGB 200 is ~sRGB 146, not 100.
    expect(out[4]).toBeGreaterThan(140);
    expect(out[4]).toBeLessThan(152);
  });
});

describe('night shade and clouds', () => {
  it('is clear at the subsolar point and dark at the antipode', () => {
    const w = 72, h = 36;
    const img = nightShade(w, h, 20 * DEG, 30 * DEG);
    const idx = (latD: number, lonD: number): number => {
      const r = Math.round((90 - latD) / 5 - 0.5), c = Math.round((lonD + 180) / 5 - 0.5);
      return 4 * (r * w + c) + 3;
    };
    expect(img[idx(20, 30)]).toBeLessThan(10);
    expect(img[idx(-20, -150)]).toBeGreaterThan(220);
    // Northern summer: the north polar cap stays lit, the south one is dark.
    expect(img[idx(87, -150)]).toBeLessThan(img[idx(-87, 30)]);
  });

  it('cloud alpha covers roughly `cover` of the area and nothing at zero cover', () => {
    const w = 256, h = 128;
    const uni = Float32Array.from({ length: w * h }, (_, i) => ((i * 0.6180339887) % 1));
    for (const cov of [0, 0.3, 0.7]) {
      const img = cloudAlpha(new Float32Array(4).fill(cov), 2, 2, uni, w, h, 1);
      let covered = 0;
      for (let i = 3; i < img.length; i += 4) if (img[i] > 60) covered++;
      expect(Math.abs(covered / (w * h) - cov)).toBeLessThan(0.08);
    }
  });
});

describe('height helpers', () => {
  it('mip chain preserves the mean and halves dimensions down to 1×1', () => {
    const w = 64, h = 32;
    const src = Float32Array.from({ length: w * h }, (_, i) => Math.sin(i * 0.1) * 1000 + 200);
    const mips = buildFloatMips(src, w, h);
    expect(mips.map((m) => `${m.width}x${m.height}`)).toEqual(['64x32', '32x16', '16x8', '8x4', '4x2', '2x1', '1x1']);
    const mean = (a: Float32Array): number => a.reduce((s, v) => s + v, 0) / a.length;
    expect(mips[6].data[0]).toBeCloseTo(mean(src), 2);
    // Reuse recycles buffers and yields identical results.
    const again = buildFloatMips(src, w, h, mips);
    expect(again[3].data).toBe(mips[3].data);
    expect(again[6].data[0]).toBeCloseTo(mean(src), 2);
  });

  it('HeightField samples, bounds and displaces consistently', () => {
    const hf = new HeightField();
    expect(hf.at(0, 0)).toBeNaN();
    expect(hf.displacementAt(1, 0, 0, 0, 12)).toBe(0);
    const w = 36, h = 18;
    const data = new Float32Array(w * h).fill(-3000);
    data[9 * w + 18] = 5000;
    hf.set(data, w, h);
    data.fill(0); // caller may reuse its buffer: the field keeps its own copy
    expect(hf.maxElev).toBe(5000);
    expect(hf.maxDisplacement(0, 12)).toBeCloseTo((12 * 5000) / PLANET_RADIUS_M, 15);
    const lat = Math.PI / 2 - (9.5 * Math.PI) / h, lon = -Math.PI + (18.5 * 2 * Math.PI) / w;
    expect(hf.at(lat, lon)).toBeCloseTo(5000, 3);
    const v = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    expect(hf.displacementAt(v[0], v[1], v[2], 1000, 12)).toBeCloseTo(reliefDisplacement(5000, 1000, 12), 12);
    expect(hf.displacementAt(1, 0, 0, 0, 12)).toBe(0);
  });
});

describe('globe surface textures', () => {
  it('base is an sRGB texture; overlay is raw premultiplied sRGB decoded once, in the shader', () => {
    const shared = { uLightMode: { value: LIGHT_RELIEF }, uSunDir: { value: new Vector3(1, 0, 0) }, uAtmoColor: { value: new Color() } };
    const surface = new GlobeSurface(shared, 1);
    surface.setBase(new Uint8ClampedArray(2 * 1 * 4).fill(200), 2, 1);
    const overlay = new Uint8ClampedArray([200, 100, 50, 128, 255, 255, 255, 0]);
    surface.setOverlay(overlay, 2, 1);
    expect(surface.base.texture!.colorSpace).toBe(SRGBColorSpace);
    // The shader un-premultiplies and applies srgbToLinear itself: an sRGB texture format would make
    // the GPU decode first (double decode: darker, hue-shifted boundaries/graticule).
    expect(SURFACE_FRAGMENT).toContain('srgbToLinear(o.rgb / o.a)');
    expect(surface.overlay.texture!.colorSpace).toBe(NoColorSpace);
    const data = surface.overlay.texture!.image.data as Uint8Array;
    expect(Array.from(data)).toEqual([100, 50, 25, 128, 0, 0, 0, 0]);
    overlay.fill(0); // the caller may reuse its buffer
    expect(data[0]).toBe(100);
    surface.dispose();
  });
});
