/**
 * Views perf (Node, CPU parts only; GPU/canvas costs are measured in the browser demo).
 * Budgets carry ~2× slack for the shared test machine.
 */
import { describe, expect, it } from 'vitest';
import type { VectorFieldSpec } from '../../src/core/types';
import { buildFloatMips } from '../../src/render/globeTextures';
import { applyShade, cloudAlpha, hillshade, nightShade } from '../../src/render/mapShading';
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

  it('map shading: hillshade+apply 1024×512 ≤ 15 ms, 2048×1024 ≤ 50 ms (no stall > 50 ms); night ≤ 5 ms; clouds ≤ 12 ms', () => {
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
    const uni = Float32Array.from({ length: 512 * 256 }, (_, i) => (i * 0.618) % 1);
    const cover = Float32Array.from({ length: 360 * 180 }, (_, i) => (i % 97) / 97);
    const cloudOut = new Uint8ClampedArray(512 * 256 * 4);
    const cloudMs = best(10, () => cloudAlpha(cover, 360, 180, uni, 512, 256, 0.85, cloudOut));
    console.log(`nightShade 360x180: ${nightMs.toFixed(2)} ms; cloudAlpha 512x256: ${cloudMs.toFixed(2)} ms`);
    expect(nightMs).toBeLessThanOrEqual(5);
    expect(cloudMs).toBeLessThanOrEqual(12);
  });
});
