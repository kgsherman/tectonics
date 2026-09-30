/**
 * Views perf (Node, CPU parts only; GPU/canvas costs are measured in the browser demo).
 * Budgets carry ~2× slack for the shared test machine.
 */
import { describe, expect, it } from 'vitest';
import type { VectorFieldSpec } from '../../src/core/types';
import { buildFloatMips, HeightTextureSlot, RgbaTextureSlot } from '../../src/render/globeTextures';
import { applyShade, hillshade, nightShade } from '../../src/render/mapShading';
import { ParticleSystem } from '../../src/render/particles';
import { HeightField } from '../../src/render/viewHeight';

const now = (): number => globalThis.performance?.now?.() ?? Date.now();

function best(runs: number, f: (k: number) => void): number {
  let b = Infinity;
  for (let k = 0; k < runs; k++) {
    const t = now();
    f(k);
    b = Math.min(b, now() - t);
  }
  return b;
}

function windField(w: number, h: number): VectorFieldSpec {
  const u = new Float32Array(w * h), v = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
    for (let c = 0; c < w; c++) {
      u[r * w + c] = 9 * Math.cos(3 * lat) + 2 * Math.sin(c * 0.07);
      v[r * w + c] = 2 * Math.sin(2 * lat) + Math.cos(r * 0.11);
    }
  }
  return { kind: 'wind', w, h, u, v };
}

function terrain(w: number, h: number): Float32Array {
  return Float32Array.from({ length: w * h }, (_, i) => 3000 * Math.sin(i * 0.013) * Math.cos(i * 0.0007) - 500);
}

describe('views perf', () => {
  it('particle step: 8k particles ≤ 4 ms (≥45 fps leaves ~22 ms per frame)', () => {
    const ps = new ParticleSystem(windField(360, 180), { count: 8000, seed: 3 });
    const hf = new HeightField();
    hf.set(terrain(1024, 512), 1024, 512);
    ps.setBlocked((x, y, z) => hf.atVec(x, y, z) > 0);
    for (let k = 0; k < 30; k++) ps.step(1 / 60);
    const ms = best(20, () => ps.step(1 / 60));
    console.log(`particle step 8k (with land mask): ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThanOrEqual(4);
  });

  it('height map ingest: CPU mips 2048×1024 ≤ 10 ms, HeightField copy ≤ 10 ms', () => {
    const w = 2048, h = 1024;
    const src = terrain(w, h);
    let mips = buildFloatMips(src, w, h);
    const mipMs = best(5, () => {
      mips = buildFloatMips(src, w, h, mips);
    });
    const hf = new HeightField();
    const copyMs = best(5, () => hf.set(src, w, h));
    console.log(`buildFloatMips 2048x1024: ${mipMs.toFixed(1)} ms; HeightField.set: ${copyMs.toFixed(1)} ms`);
    expect(mipMs).toBeLessThanOrEqual(10);
    expect(copyMs).toBeLessThanOrEqual(10);
  });

  it('globe texture slots 2048×1024: new frame ≤ 12 ms (overlay premultiply) / 8 ms (height, GPU mips); identical resend ≤ 8 ms', () => {
    const w = 2048, h = 1024, n = w * h;
    const overlay = new Uint8ClampedArray(4 * n);
    // Sparse lines of partial alpha (typical overlay: most pixels transparent).
    for (let i = 0; i < n; i += 37) { overlay[4 * i] = 255; overlay[4 * i + 3] = 150 + (i % 100); }
    const heights = terrain(w, h);
    const ov = new RgbaTextureSlot(false, true, 1);
    const hs = new HeightTextureSlot(1, true);
    ov.set(overlay, w, h);
    hs.set(heights, w, h);
    const ovNew = best(5, (k) => { overlay[4 * k + 3] ^= 1; ov.set(overlay, w, h); });
    const hNew = best(5, (k) => { heights[k] += 1; hs.set(heights, w, h); });
    const ovSame = best(5, () => ov.set(overlay, w, h));
    const hSame = best(5, () => hs.set(heights, w, h));
    console.log(`slots 2048: overlay new ${ovNew.toFixed(1)} / same ${ovSame.toFixed(1)} ms; height new ${hNew.toFixed(1)} / same ${hSame.toFixed(1)} ms`);
    expect(ovNew).toBeLessThanOrEqual(12);
    expect(hNew).toBeLessThanOrEqual(8);
    expect(ovSame).toBeLessThanOrEqual(8);
    expect(hSame).toBeLessThanOrEqual(8);
    ov.dispose();
    hs.dispose();
  });

  it('map shading: hillshade+apply 1024×512 ≤ 15 ms, 2048×1024 ≤ 50 ms (no stall > 50 ms); night ≤ 5 ms', () => {
    for (const [w, h, budget] of [[1024, 512, 15], [2048, 1024, 50]] as const) {
      const hm = terrain(w, h);
      const rgba = new Uint8ClampedArray(w * h * 4).fill(120);
      const out = new Uint8ClampedArray(w * h * 4);
      const ms = best(4, () => applyShade(rgba, w, h, hillshade(hm, w, h, 0), w, h, out));
      console.log(`hillshade+applyShade ${w}x${h}: ${ms.toFixed(1)} ms`);
      expect(ms).toBeLessThanOrEqual(budget);
    }
    const nightOut = new Uint8ClampedArray(360 * 180 * 4);
    const nightMs = best(10, (k) => nightShade(360, 180, 0.3, k * 0.01, nightOut));
    console.log(`nightShade 360x180: ${nightMs.toFixed(2)} ms`);
    expect(nightMs).toBeLessThanOrEqual(5);
  });
});
