/**
 * Polish 2 (views-2): stall-free texture updates (one texture per raster size, change detection,
 * fast premultiply, GPU height mips), adaptive detail gating, relief cue, crisp overlay
 * magnification and class-edge reconstruction contracts, map GPU context recovery contracts.
 * GPU output is verified visually in the browser (scratch/views-2); here we pin the pure logic.
 */
import { describe, expect, it } from 'vitest';
import { Color, Vector3 } from 'three';
import { GlobeSurface, LIGHT_RELIEF } from '../src/render/globeSurface';
import { HeightTextureSlot, RgbaTextureSlot } from '../src/render/globeTextures';
import { MAP_BASE_FRAGMENT, MAP_OVERLAY_FRAGMENT } from '../src/render/mapGl';
import * as mapShading from '../src/render/mapShading';
import { GLSL_OVERLAY_SHARP, GLSL_RELIEF_RESPONSE, GLSL_TERRAIN_RECON } from '../src/render/shadersCommon';
import { SURFACE_FRAGMENT } from '../src/render/shadersSurface';
import { copyIfChanged, premultiply, SizeCache } from '../src/render/viewBuffers';
import { DetailFader } from '../src/render/viewDetail';
import { HeightField } from '../src/render/viewHeight';

function rgbaImage(w: number, h: number, seed: number): Uint8ClampedArray {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < a.length; i++) a[i] = (i * 31 + seed * 17) & 255;
  return a;
}

describe('change-detecting copies', () => {
  it('copyIfChanged reports identical data and copies differences found anywhere', () => {
    const n = 4096;
    const src = Float32Array.from({ length: n }, (_, i) => Math.sin(i) * 1000);
    const dst = new Float32Array(n);
    expect(copyIfChanged(src, dst, n)).toBe(true);
    expect(Array.from(dst)).toEqual(Array.from(src));
    expect(copyIfChanged(src, dst, n)).toBe(false);
    src[n - 1] += 0.5; // a change in the last element (after a long identical prefix)
    expect(copyIfChanged(src, dst, n)).toBe(true);
    expect(dst[n - 1]).toBe(src[n - 1]);
    // Bitwise: NaN compares equal to itself (no spurious uploads for NaN-holding rasters).
    src[3] = NaN;
    copyIfChanged(src, dst, n);
    expect(copyIfChanged(src, dst, n)).toBe(false);
    // RGBA bytes compare as 32-bit words.
    const a = rgbaImage(16, 8, 1), b = new Uint8ClampedArray(a.length);
    expect(copyIfChanged(a, b, 16 * 8)).toBe(true);
    expect(copyIfChanged(a, b, 16 * 8)).toBe(false);
    a[a.length - 2] ^= 1;
    expect(copyIfChanged(a, b, 16 * 8)).toBe(true);
    expect(b[b.length - 2]).toBe(a[a.length - 2]);
  });

  it('premultiply rounds rgb·a/255 exactly and keeps opaque/transparent pixels as-is', () => {
    const src = new Uint8ClampedArray([200, 100, 50, 128, 255, 255, 255, 0, 10, 20, 30, 255, 255, 128, 1, 1]);
    const dst = new Uint8Array(16).fill(7);
    premultiply(src, dst, 4);
    expect(Array.from(dst)).toEqual([100, 50, 25, 128, 0, 0, 0, 0, 10, 20, 30, 255, 1, 1, 0, 1]);
    // Every (x, a) pair against the reference Math.round(x·a/255).
    const all = new Uint8ClampedArray(256 * 256 * 4), out = new Uint8Array(all.length);
    for (let a = 0; a < 256; a++) for (let x = 0; x < 256; x++) {
      const i = 4 * (a * 256 + x);
      all[i] = x;
      all[i + 3] = a;
    }
    premultiply(all, out, 256 * 256);
    for (let a = 0; a < 256; a++) for (let x = 0; x < 256; x++) {
      expect(out[4 * (a * 256 + x)]).toBe(a === 0 ? 0 : Math.round((x * a) / 255));
    }
  });

  it('SizeCache keeps the most recent sizes and releases evicted entries', () => {
    const released: string[] = [];
    const c = new SizeCache<string>(2, (v) => released.push(v));
    expect(c.get(1024, 512, () => 'a').fresh).toBe(true);
    expect(c.get(2048, 1024, () => 'b').fresh).toBe(true);
    expect(c.get(1024, 512, () => 'x')).toEqual({ value: 'a', fresh: false });
    c.get(4096, 2048, () => 'c'); // evicts the least recently used (2048×1024)
    expect(released).toEqual(['b']);
    expect(c.values()).toEqual(['c', 'a']);
    c.clear();
    expect(released).toEqual(['b', 'c', 'a']);
    expect(c.size).toBe(0);
  });
});

describe('globe texture slots: one texture per size, uploads only on change', () => {
  it('play/pause alternation reuses both textures (no reallocation) and skips identical resends', () => {
    const slot = new RgbaTextureSlot(true, false, 1);
    const small = rgbaImage(64, 32, 1), big = rgbaImage(128, 64, 2);
    expect(slot.set(small, 64, 32)).toBe(true);
    const texSmall = slot.texture!;
    slot.set(big, 128, 64);
    const texBig = slot.texture!;
    expect(texBig).not.toBe(texSmall);
    let disposed = 0;
    texSmall.addEventListener('dispose', () => disposed++);
    texBig.addEventListener('dispose', () => disposed++);
    const uploads0 = slot.uploads;
    for (let k = 0; k < 3; k++) {
      small[0] = k; // playback frames differ
      expect(slot.set(small, 64, 32)).toBe(true);
      expect(slot.texture).toBe(texSmall);
      big[0] = k;
      expect(slot.set(big, 128, 64)).toBe(true);
      expect(slot.texture).toBe(texBig);
    }
    expect(disposed).toBe(0);
    expect(slot.uploads - uploads0).toBe(6);
    // Identical resend (pause re-push / month change with the same raster): no upload.
    const v = texBig.version;
    expect(slot.set(big, 128, 64)).toBe(false);
    expect(texBig.version).toBe(v);
    expect(slot.uploads - uploads0).toBe(6);
    // A third size evicts the least recently used one.
    slot.set(rgbaImage(32, 16, 3), 32, 16);
    expect(disposed).toBe(1);
    slot.dispose();
    expect(disposed).toBe(2);
  });

  it('premultiplying slots detect changes on the straight-alpha source', () => {
    const slot = new RgbaTextureSlot(false, true, 1);
    const ov = new Uint8ClampedArray([200, 100, 50, 128, 255, 255, 255, 0]);
    slot.set(ov, 2, 1);
    expect(Array.from(slot.texture!.image.data as Uint8Array)).toEqual([100, 50, 25, 128, 0, 0, 0, 0]);
    const u = slot.uploads;
    slot.set(ov.slice(), 2, 1);
    expect(slot.uploads).toBe(u);
    ov[4] = 0; // invisible (alpha 0) but different source bytes: still re-derived, never stale
    slot.set(ov, 2, 1);
    expect(slot.uploads).toBe(u + 1);
    slot.dispose();
  });

  it('height slot: GPU mips (no CPU chain), per-size textures, pole means, unchanged data not re-sent', () => {
    const gpu = new HeightTextureSlot(1, true);
    const h1 = Float32Array.from({ length: 64 * 32 }, (_, i) => (i < 64 ? 100 : i >= 64 * 31 ? -300 : i));
    gpu.set(h1, 64, 32);
    const t = gpu.texture!;
    expect(t.generateMipmaps).toBe(true);
    expect(t.mipmaps.length).toBe(0);
    expect(gpu.poleNorth).toBe(100);
    expect(gpu.poleSouth).toBe(-300);
    const v = t.version;
    gpu.set(h1.slice(), 64, 32);
    expect(t.version).toBe(v);
    gpu.set(new Float32Array(32 * 16), 32, 16);
    expect(gpu.poleNorth).toBe(0);
    h1[500] += 1;
    gpu.set(h1, 64, 32);
    expect(gpu.texture).toBe(t);
    expect(t.version).toBe(v + 1);
    expect(gpu.poleNorth).toBe(100);
    gpu.dispose();

    const cpu = new HeightTextureSlot(1, false);
    cpu.set(h1, 64, 32);
    expect(cpu.texture!.generateMipmaps).toBe(false);
    expect((cpu.texture!.mipmaps as unknown[]).length).toBe(7);
    cpu.dispose();
  });

  it('GlobeSurface keeps overlay textures when the overlay is toggled off and back on', () => {
    const shared = { uLightMode: { value: LIGHT_RELIEF }, uSunDir: { value: new Vector3(1, 0, 0) }, uAtmoColor: { value: new Color() } };
    const s = new GlobeSurface(shared, 1, true);
    const u = s.mesh.material.uniforms;
    const ov = rgbaImage(16, 8, 4);
    s.setOverlay(ov, 16, 8);
    const tex = s.overlay.texture;
    const uploads = s.overlay.uploads;
    s.setOverlay(null, 0, 0);
    expect(u.uHasOverlay.value).toBe(0);
    s.setOverlay(ov, 16, 8);
    expect(u.uHasOverlay.value).toBe(1);
    expect(s.overlay.texture).toBe(tex);
    expect(s.overlay.uploads).toBe(uploads);
    expect(u.uOverlaySize.value.toArray()).toEqual([16, 8]);
    expect(s.hasHeight).toBe(false);
    s.setHeight(new Float32Array(16 * 8), 16, 8);
    expect(s.hasHeight).toBe(true);
    s.dispose();
  });

  it('HeightField.set reports identical maps (the views skip upload, mips and relief work)', () => {
    const hf = new HeightField();
    const a = Float32Array.from({ length: 36 * 18 }, (_, i) => i - 100);
    expect(hf.set(a, 36, 18)).toBe(true);
    expect(hf.set(a.slice(), 36, 18)).toBe(false);
    expect(hf.maxElev).toBe(36 * 18 - 101);
    a[7] = 1e4;
    expect(hf.set(a, 36, 18)).toBe(true);
    expect(hf.maxElev).toBe(1e4);
    // Same values at another size is a change.
    expect(hf.set(a, 18, 36)).toBe(true);
  });
});

describe('detail gating during slow playback', () => {
  it('keeps the detail hidden between frames that arrive slower than the base hold', () => {
    const f = new DetailFader(1200, 600);
    f.noteHeights(1, 0);
    expect(f.value(0)).toBe(1);
    // Heavy world: a new height map every 1.5 s (longer than the 1.2 s base hold).
    let t = 1000;
    for (let k = 2; k < 10; k++, t += 1500) {
      f.noteHeights(k, t);
      if (k > 2) for (let dt = 0; dt < 1500; dt += 100) expect(f.value(t + dt)).toBe(0);
    }
    // Paused after the last frame at t − 1500: fades in once the stretched hold (≤ 4 s) is over.
    const last = t - 1500;
    expect(f.value(last + 3700)).toBe(0);
    expect(f.value(last + 3750 + 600)).toBe(1);
    // A single edit long after the pause uses the base hold again.
    f.noteHeights(99, last + 20000);
    expect(f.value(last + 20000 + 1100)).toBe(0);
    expect(f.value(last + 20000 + 1200 + 600)).toBe(1);
  });
});

describe('shader contracts (polish 2)', () => {
  it('relief cue: light-independent slope darkening and local relief, applied in lit modes on both views', () => {
    expect(GLSL_RELIEF_RESPONSE).toContain('float reliefCue(float tilt, float localRelief)');
    expect(SURFACE_FRAGMENT).toContain('col *= reliefCue(baseTilt');
    expect(MAP_BASE_FRAGMENT).toContain('col *= reliefCue(baseTilt');
    // Zoom-dependent exaggeration of the footprint-filtered relief, identical on both views.
    const boost = 'clamp(1.6 * sqrt(pxRad / texRadH), 1.0, 2.2)';
    expect(SURFACE_FRAGMENT).toContain(boost);
    expect(MAP_BASE_FRAGMENT).toContain(boost);
  });

  it('overlays are magnified crisply on the globe and in the map overlay pass', () => {
    expect(GLSL_OVERLAY_SHARP).toContain('vec4 overlaySharp(sampler2D tex, vec2 size, vec2 st, float pxTex)');
    // Smooth soft-max peak (no texel-shaped plateaus) and threshold at 0.4 of it.
    expect(GLSL_OVERLAY_SHARP).toContain('float peak = p4 / p3;');
    expect(GLSL_OVERLAY_SHARP).toContain('float thr = 0.4 * peak;');
    expect(SURFACE_FRAGMENT).toContain('overlaySharp(uOverlay, uOverlaySize, st, ovTex)');
    expect(MAP_OVERLAY_FRAGMENT.startsWith('#version 300 es')).toBe(true);
    expect(MAP_OVERLAY_FRAGMENT).toContain('overlaySharp(uOverlay, uOverlaySize, st, ovTex)');
  });

  it('rebuilds binary colour edges on land only (lakes, Köppen, snow), gated to two-colour stencils', () => {
    expect(GLSL_TERRAIN_RECON).toContain('vec3 classEdge(');
    expect(GLSL_TERRAIN_RECON).toContain('classEdge(cv, lv, 1.0,');
    expect(GLSL_TERRAIN_RECON).not.toContain('classEdge(cv, lv, 0.0,');
    expect(GLSL_TERRAIN_RECON).toContain('float binary = 1.0 - smoothstep(0.004, 0.03, dev / max(nc, 1.0));');
    // Both callers pass the pixel footprint for the edge anti-aliasing width.
    expect(SURFACE_FRAGMENT).toContain('stw, uSeaLevel, pxRad / texRadH)');
    expect(MAP_BASE_FRAGMENT).toContain('stw, uSeaLevel, pxRad / texRadH)');
  });

  it('the dead CPU cloud-alpha path is gone', () => {
    expect('cloudAlpha' in mapShading).toBe(false);
  });
});
