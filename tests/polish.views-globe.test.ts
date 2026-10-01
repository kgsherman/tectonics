/**
 * Polish (views-globe): zoom-robust surface rendering — sub-texel coast reconstruction, procedural
 * detail gating, shared relief response, GPU map base inputs. The GPU paths are verified visually in
 * the browser (scratch/views-globe/harness.html); here we pin the pure logic and the shader contracts.
 */
import { describe, expect, it } from 'vitest';
import { Color, Vector2, Vector3 } from 'three';
import { GlobeSurface, LIGHT_RELIEF } from '../src/render/globeSurface';
import { MAP_BASE_FRAGMENT } from '../src/render/mapGl';
import { hillshade, reliefShade } from '../src/render/mapShading';
import {
  GLSL_RELIEF_RESPONSE, GLSL_TERRAIN_DETAIL, GLSL_TERRAIN_RECON,
} from '../src/render/shadersCommon';
import { SURFACE_FRAGMENT } from '../src/render/shadersSurface';
import { DetailFader, heightSignature } from '../src/render/viewDetail';

describe('relief shade response (globe, GPU map and CPU map share one curve)', () => {
  it('is exactly 1 on flat ground and bounded to [0.3, 1.35)', () => {
    expect(reliefShade(1)).toBe(1);
    for (let rel = -3; rel <= 4; rel += 0.01) {
      const s = reliefShade(rel);
      expect(s).toBeGreaterThanOrEqual(0.3);
      expect(s).toBeLessThan(1.35);
    }
  });

  it('is continuous and monotonic (no kinks that read as plastic banding)', () => {
    let prev = reliefShade(-3);
    for (let rel = -3 + 1e-3; rel <= 4; rel += 1e-3) {
      const s = reliefShade(rel);
      expect(s).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(s - prev).toBeLessThan(2e-3);
      prev = s;
    }
    // Slopes match on both sides of rel = 1 (0.85 below, 0.45 above would be a kink; the smooth
    // highlight branch starts at slope 0.45 and the linear shadow branch has slope 0.85).
    expect((reliefShade(1) - reliefShade(1 - 1e-6)) / 1e-6).toBeCloseTo(0.85, 3);
    expect((reliefShade(1 + 1e-6) - reliefShade(1)) / 1e-6).toBeCloseTo(0.45, 3);
  });

  it('the CPU hillshade uses it (shadowed flank rolls off above the floor)', () => {
    const w = 360, h = 180;
    const hm = new Float32Array(w * h);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) hm[r * w + c] = Math.max(0, 6000 - 3000 * Math.abs(c - 180));
    const s = hillshade(hm, w, h, 0);
    let min = Infinity;
    for (const v of s) min = Math.min(min, v);
    expect(min).toBeGreaterThanOrEqual(0.3);
    expect(min).toBeLessThan(0.45);
  });

  it('the GLSL copy is the same curve', () => {
    expect(GLSL_RELIEF_RESPONSE).toContain('1.0 + 0.35 * (1.0 - exp(-1.2857 * (rel - 1.0)))');
    expect(GLSL_RELIEF_RESPONSE).toContain('0.3 + 0.2 * exp((s - 0.5) * 5.0)');
  });
});

describe('procedural detail gating', () => {
  it('height signatures are equal for identical rasters and differ on changes', () => {
    const a = Float32Array.from({ length: 2048 * 1024 }, (_, i) => Math.sin(i * 0.001) * 3000);
    const b = a.slice();
    expect(heightSignature(a)).toBe(heightSignature(b));
    b[0] += 50;
    expect(heightSignature(a)).not.toBe(heightSignature(b));
  });

  it('shows detail for a static world and hides it while heights keep changing (playback)', () => {
    const f = new DetailFader(1000, 500);
    f.noteHeights(1, 0);
    // First height map of a view: detail immediately (not motion).
    expect(f.value(0)).toBe(1);
    expect(f.animating(0)).toBe(false);
    // Identical resend (month change): nothing changes.
    expect(f.noteHeights(1, 100)).toBe(false);
    expect(f.value(100)).toBe(1);
    // Playback: a new height map every 50 ms keeps the detail off (world-anchored noise would swim).
    for (let t = 200; t <= 2000; t += 50) {
      f.noteHeights(t, t);
      expect(f.value(t)).toBe(0);
      expect(f.animating(t)).toBe(true);
    }
    // Paused: fades back in after the hold, smoothly, then settles.
    expect(f.value(2000 + 999)).toBe(0);
    const mid = f.value(2000 + 1250);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
    expect(f.value(2000 + 1500)).toBe(1);
    expect(f.animating(2000 + 1501)).toBe(false);
    f.reset();
    expect(f.value(0)).toBe(1);
  });

  it('is exactly constant through the hold, so views redraw only while the value moves', () => {
    const f = new DetailFader(1000, 500);
    f.noteHeights(1, 0);
    f.noteHeights(2, 100);
    const held = new Set<number>();
    for (let t = 100; t <= 1100; t += 7) held.add(f.value(t));
    expect([...held]).toEqual([0]);
    expect(f.animating(1100)).toBe(true);
    expect(f.value(1300)).toBeGreaterThan(0);
  });
});

describe('surface shader contracts', () => {
  it('derives texture coordinates per fragment with a seam-free derivative for mip selection', () => {
    expect(SURFACE_FRAGMENT).toContain('atan(-n0.z, n0.x)');
    expect(SURFACE_FRAGMENT).toContain('dsx.x -= floor(dsx.x + 0.5)');
    expect(SURFACE_FRAGMENT).toContain('textureGrad(uBase, st, dsx, dsy)');
    // No implicit-derivative lookups of the base/height inside the (non-uniform) branches.
    expect(SURFACE_FRAGMENT).not.toMatch(/texture\(uBase|texture\(uHeight/);
  });

  it('reconstructs coasts and colors per class when magnified, with detail fading in by octave', () => {
    expect(SURFACE_FRAGMENT).toContain('reconstructTerrain(');
    expect(GLSL_TERRAIN_RECON).toContain('texelFetch(heightTex');
    expect(GLSL_TERRAIN_RECON).toContain('texelFetch(baseTex');
    // Land iff h > sea at texel level (painter's rule) drives the per-class color split.
    expect(GLSL_TERRAIN_RECON).toContain('v > sea ? 1.0 : 0.0');
    expect(GLSL_TERRAIN_DETAIL).toContain('smoothstep(2.0, 5.0, 1.0 / (freq * pxRad))');
  });

  it('clamps the sharpened (Catmull-Rom) class colours to the central 2×2 texels (no dark rings)', () => {
    // A 2-texel lake on land undershoots by 12.5 % of the step per axis (≈25 % in 2D): in linear light
    // that is black for dark water. The CR colour must stay within its class's central texels.
    // (CR colour sums with the coastal anti-aliased texels down-weighted, polish 3: wlrc / wsrc.)
    expect(GLSL_TERRAIN_RECON).toContain('antiRing(lcr / wlrc, lmin, lmax)');
    expect(GLSL_TERRAIN_RECON).toContain('antiRing(scr / wsrc, smin, smax)');
    expect(GLSL_TERRAIN_RECON.match(/\(i == 1 \|\| i == 2\) && \(j == 1 \|\| j == 2\)/g)?.length).toBe(2);
  });

  it('reconstructs only when base and height share one raster (else a second, blocky coast shows)', () => {
    expect(SURFACE_FRAGMENT).toMatch(/oneRaster = uSameSize > 0\.5 \|\| uHasBase < 0\.5/);
    expect(SURFACE_FRAGMENT).toContain('hasH && oneRaster ?');
    expect(MAP_BASE_FRAGMENT).toContain('hasH && uSameSize > 0.5 ?');
  });

  it('keeps the specular glint on water only and flat-lit layers free of albedo detail', () => {
    expect(SURFACE_FRAGMENT).toMatch(/if \(ocean > 0\.0\)/);
    expect(SURFACE_FRAGMENT).toMatch(/if \(lit\) \{\s*\/\/ Albedo detail/);
  });
});

describe('GPU map base shader', () => {
  it('shares the globe reconstruction, detail and relief response, wrapping longitude itself', () => {
    expect(MAP_BASE_FRAGMENT.startsWith('#version 300 es')).toBe(true);
    expect(MAP_BASE_FRAGMENT).toContain('reconstructTerrain(');
    expect(MAP_BASE_FRAGMENT).toContain('terrainDetail(');
    expect(MAP_BASE_FRAGMENT).toContain('reliefShade(');
    expect(MAP_BASE_FRAGMENT).toContain('fract(lon * (1.0 / TWO_PI) + 0.5)');
    // Same light as the CPU hillshade (north-west, 35°) and sRGB output for the 2D canvas.
    expect(MAP_BASE_FRAGMENT).toContain('normalize(north - east) * COS_ALT');
    expect(MAP_BASE_FRAGMENT).toContain('linearToSrgb(col)');
  });
});

describe('GlobeSurface reconstruction uniforms', () => {
  it('tracks base/height raster sizes (fused 4×4 fetch only when they match) and clamps detail', () => {
    const shared = { uLightMode: { value: LIGHT_RELIEF }, uSunDir: { value: new Vector3(1, 0, 0) }, uAtmoColor: { value: new Color() } };
    const s = new GlobeSurface(shared, 1);
    const u = s.mesh.material.uniforms;
    s.setBase(new Uint8ClampedArray(8 * 4 * 4), 8, 4);
    s.setHeight(new Float32Array(8 * 4), 8, 4);
    expect((u.uBaseSize.value as Vector2).toArray()).toEqual([8, 4]);
    expect((u.uHeightSize.value as Vector2).toArray()).toEqual([8, 4]);
    expect(u.uSameSize.value).toBe(1);
    s.setHeight(new Float32Array(16 * 8), 16, 8);
    expect(u.uSameSize.value).toBe(0);
    s.setBase(new Uint8ClampedArray(16 * 8 * 4), 16, 8);
    expect(u.uSameSize.value).toBe(1);
    // 4096×2048 rasters are accepted as-is (the app may send them).
    s.setBase(new Uint8ClampedArray(4096 * 2048 * 4), 4096, 2048);
    expect((u.uBaseSize.value as Vector2).toArray()).toEqual([4096, 2048]);
    s.setDetail(3);
    expect(s.detail).toBe(1);
    s.setDetail(-1);
    expect(s.detail).toBe(0);
    s.dispose();
  });
});
