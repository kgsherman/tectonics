import { describe, expect, it } from 'vitest';
import { buildMeshGridMap, meshToGrid, resampleGrid } from '../../src/core/grid';
import { createSphereMesh } from '../../src/core/sphereMesh';
import type { LayerId, PaintOptions, PaintSources, WorldSnapshot } from '../../src/core/types';
import { LAYER_LABELS, PaintCache, paintLayer, paintOverlay } from '../../src/render/paint';
import { syntheticSnapshot, zonalClimate } from '../helpers/fixtures';

/** SPEC §7 budgets (ms) and the shared-machine slack factor used for assertions. */
const SLACK = 2;
const PREVIEW_MS = 35;
const FULL_COLD_MS = 2500;
const MONTH_1024_MS = 150;
const MONTH_2048_MS = 500;

const now = () => globalThis.performance?.now?.() ?? Date.now();
const median = (a: number[]) => a.slice().sort((x, y) => x - y)[a.length >> 1];

const mesh = createSphereMesh(100_000);
const snap = syntheticSnapshot(mesh, 3, 12);
const map = buildMeshGridMap(mesh, 1440, 720);
const climate = zonalClimate(360, 180, resampleGrid(meshToGrid(map, snap.elev), 1440, 720, 360, 180));

function opts(over: Partial<PaintOptions>): PaintOptions {
  return { width: 1024, height: 512, month: 6, seaLevel: 0, hillshade: false, seed: 1, quality: 'preview', ...over };
}

let nextId = 10_000;
/** Same data under a new identity: forces the per-snapshot work (height field) like a playback frame. */
function freshSnapshot(): WorldSnapshot {
  return { ...snap, id: nextId++ };
}

describe('painter performance (100k mesh)', () => {
  it(`preview frame (new snapshot) ≤ ${PREVIEW_MS} ms at 1024×512 for any layer (warm static caches)`, () => {
    const cache = new PaintCache();
    const layers = Object.keys(LAYER_LABELS) as LayerId[];
    for (const layer of layers) paintLayer(layer, { mesh, snapshot: snap, climate }, opts({}), cache); // warm-up
    const report: string[] = [];
    let worst = 0;
    for (const layer of layers) {
      const t: number[] = [];
      for (let i = 0; i < 7; i++) {
        const src: PaintSources = { mesh, snapshot: freshSnapshot(), climate };
        const t0 = now();
        paintLayer(layer, src, opts({}), cache);
        t.push(now() - t0);
      }
      const m = median(t);
      worst = Math.max(worst, m);
      report.push(`${layer}=${m.toFixed(1)}`);
    }
    // Layer switch on the same snapshot (height field cached).
    const same: number[] = [];
    for (const layer of layers) {
      const t0 = now();
      paintLayer(layer, { mesh, snapshot: snap, climate }, opts({}), cache);
      same.push(now() - t0);
    }
    const t0 = now();
    paintOverlay({ boundaries: true, graticule: true, coastlines: true }, { mesh, snapshot: snap, climate }, opts({}), cache);
    const overlay = now() - t0;
    console.log(`[perf] preview 1024 new-snapshot medians (ms): ${report.join(' ')}`);
    console.log(`[perf] preview 1024 same-snapshot layer switch median ${median(same).toFixed(1)} ms; overlay ${overlay.toFixed(1)} ms`);
    expect(worst).toBeLessThan(PREVIEW_MS * SLACK);
  });

  it(`full 2048×1024 satellite cold ≤ ${FULL_COLD_MS} ms`, () => {
    const cache = new PaintCache();
    const t0 = now();
    paintLayer('satellite', { mesh, snapshot: snap, climate }, opts({ width: 2048, height: 1024, quality: 'full', hillshade: true }), cache);
    const cold = now() - t0;
    console.log(`[perf] full 2048 satellite cold ${cold.toFixed(0)} ms (incl. grid map, detail texture, rivers)`);
    expect(cold).toBeLessThan(FULL_COLD_MS * SLACK);
  });

  it(`month change with warm caches ≤ ${MONTH_1024_MS} ms @1024 and ≤ ${MONTH_2048_MS} ms @2048`, () => {
    const cache = new PaintCache();
    const res: string[] = [];
    for (const [w, h, budget] of [[1024, 512, MONTH_1024_MS], [2048, 1024, MONTH_2048_MS]] as const) {
      const o = (month: number) => opts({ width: w, height: h, quality: 'full', hillshade: true, month });
      paintLayer('satellite', { mesh, snapshot: snap, climate }, o(0), cache);
      const t: number[] = [];
      for (let m = 1; m <= 5; m++) {
        const t0 = now();
        paintLayer('satellite', { mesh, snapshot: snap, climate }, o(m), cache);
        t.push(now() - t0);
      }
      res.push(`${w}: ${median(t).toFixed(0)} ms`);
      expect(median(t)).toBeLessThan(budget * SLACK);
    }
    console.log(`[perf] month change (full, warm) medians — ${res.join(', ')}`);
  });
});
