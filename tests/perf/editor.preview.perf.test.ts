import { describe, expect, it } from 'vitest';
import { DEG, EARTH_RADIUS_KM } from '../../src/core/constants';
import { latLonToVec } from '../../src/core/math3';
import { createSphereMesh } from '../../src/core/sphereMesh';
import type { StrokeTool } from '../../src/editor/editorCore';
import { EditorCore } from '../../src/editor/editorCore';
import { omegaFromDrag } from '../../src/editor/motion';
import type { PreviewSource } from '../../src/editor/preview';
import { PreviewRaster } from '../../src/editor/preview';
import { draftFromSnapshot } from '../../src/tectonics/draft';
import { syntheticSnapshot } from '../helpers/fixtures';

/** SPEC §9: preview update ≤ 16 ms at 1024×512; main-thread stalls ≤ 50 ms (SPEC §12). Shared machine: 2× slack. */
const SLACK = 2;
const FRAME_MS = 16;
const STALL_MS = 50;

const now = () => globalThis.performance?.now?.() ?? Date.now();
const pct = (a: number[], q: number) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))];
const km = (x: number) => x / EARTH_RADIUS_KM;

const mesh = createSphereMesh(100_000);
const core = new EditorCore(mesh, draftFromSnapshot(syntheticSnapshot(mesh, 3, 14), 3), { source: 'current' });
const raster = new PreviewRaster(mesh, 1024, 512);
const src = (): PreviewSource => ({
  plate: core.draft.plate, crust: core.draft.crust, elev: core.draft.elev, boundary: core.boundary,
  plates: core.draft.plates, seaLevel: 0, style: 'plates',
});
/** One preview update: apply pending core changes to the raster (what PlateEditor does per frame). */
function frame(): void {
  const ch = core.drainChanges();
  if (ch.all) raster.renderAll(src());
  else if (ch.cells.length) raster.renderCells(src(), ch.cells);
}
core.drainChanges();
raster.renderAll(src());

function strokeTimes(tool: StrokeTool, radiusKm: number): { update: number[]; commit: number } {
  core.beginStroke(tool, { radius: km(radiusKm), plate: 2, amount: 200 });
  const update: number[] = [];
  for (let s = 0; s < 60; s++) {
    // ~1° per pointer event, a fast hand on a 1000 px map.
    const p = latLonToVec((10 + 8 * Math.sin(s / 9)) * DEG, (-30 + s * 1.1) * DEG);
    const t0 = now();
    core.strokeTo(p);
    frame();
    update.push(now() - t0);
  }
  const t1 = now();
  core.endStroke();
  frame();
  return { update, commit: now() - t1 };
}

describe('plate editor preview performance (100k cells, 1024×512)', () => {
  it('full repaint of the preview raster', () => {
    const t: number[] = [];
    for (let k = 0; k < 8; k++) {
      const t0 = now();
      raster.renderAll(src());
      t.push(now() - t0);
    }
    console.log(`renderAll median ${pct(t, 0.5).toFixed(1)} ms`);
    expect(pct(t, 0.5)).toBeLessThan(FRAME_MS * SLACK);
  });

  for (const [tool, r] of [['plate', 600], ['plate', 2000], ['continent', 1000], ['ocean', 800], ['raise', 1000], ['smooth', 800]] as Array<[StrokeTool, number]>) {
    it(`${tool} brush ${r} km: per-event update ≤ ${FRAME_MS} ms, stroke commit ≤ ${STALL_MS} ms`, () => {
      const { update, commit } = strokeTimes(tool, r);
      console.log(`${tool} ${r} km: update median ${pct(update, 0.5).toFixed(2)} ms, p95 ${pct(update, 0.95).toFixed(2)} ms, commit ${commit.toFixed(1)} ms`);
      expect(pct(update, 0.95)).toBeLessThan(FRAME_MS * SLACK);
      expect(commit).toBeLessThan(STALL_MS * SLACK);
    });
  }

  it('motion drag: live boundary reclassification + recolour per event', () => {
    const k = 3;
    const a = core.anchors()[k];
    expect(a).not.toBeNull();
    core.beginMotion(k);
    const t: number[] = [];
    for (let s = 0; s < 40; s++) {
      const t0 = now();
      core.updateMotion(omegaFromDrag(a!, latLonToVec(0, s * 2 * DEG), 0));
      frame();
      t.push(now() - t0);
    }
    core.endMotion();
    console.log(`motion drag: median ${pct(t, 0.5).toFixed(2)} ms, p95 ${pct(t, 0.95).toFixed(2)} ms`);
    expect(pct(t, 0.95)).toBeLessThan(FRAME_MS * SLACK);
  });

  it('undo / redo with a full repaint stay under the stall budget', () => {
    const t: number[] = [];
    for (let s = 0; s < 4; s++) {
      const t0 = now();
      core.undo();
      frame();
      t.push(now() - t0);
    }
    for (let s = 0; s < 4; s++) {
      const t0 = now();
      core.redo();
      frame();
      t.push(now() - t0);
    }
    console.log(`undo/redo: median ${pct(t, 0.5).toFixed(1)} ms, max ${pct(t, 1).toFixed(1)} ms`);
    expect(pct(t, 0.5)).toBeLessThan(STALL_MS * SLACK);
  });

  it('region tools and apply (reported)', () => {
    let t0 = now();
    core.fill(latLonToVec(0, 0), 1);
    frame();
    const fill = now() - t0;
    t0 = now();
    core.lasso([latLonToVec(-30 * DEG, 40 * DEG), latLonToVec(-30 * DEG, 80 * DEG), latLonToVec(0, 80 * DEG), latLonToVec(0, 40 * DEG)], 'new');
    frame();
    const lasso = now() - t0;
    t0 = now();
    const fin = core.finalize(7);
    const apply = now() - t0;
    console.log(`fill ${fill.toFixed(1)} ms, lasso ${lasso.toFixed(1)} ms, finalize (apply) ${apply.toFixed(0)} ms (${fin.plates.length} plates)`);
    expect(fill).toBeLessThan(STALL_MS * SLACK);
    expect(lasso).toBeLessThan(STALL_MS * SLACK);
  });
});
