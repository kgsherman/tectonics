import { describe, expect, it } from 'vitest';
import { DEG, EARTH_RADIUS_KM } from '../src/core/constants';
import { buildMeshGridMap, gridIndexAt } from '../src/core/grid';
import { latLonToVec } from '../src/core/math3';
import { Rng } from '../src/core/rng';
import type { Vec3 } from '../src/core/types';
import { BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT } from '../src/core/types';
import { classifyCell } from '../src/editor/boundaries';
import { EditorCore } from '../src/editor/editorCore';
import type { PreviewSource, PreviewStyle } from '../src/editor/preview';
import { buildNearestMap, PREVIEW_BOUNDARY_COLORS, PreviewRaster } from '../src/editor/preview';
import { classifyBoundaries, draftFromSnapshot } from '../src/tectonics/draft';
import { smallMesh, syntheticSnapshot, twoPlateDraft } from './helpers/fixtures';

const mesh = smallMesh(12000);
const ll = (latDeg: number, lonDeg: number): Vec3 => latLonToVec(latDeg * DEG, lonDeg * DEG);
const km = (x: number) => x / EARTH_RADIUS_KM;

function source(core: EditorCore, style: PreviewStyle, highlight?: Uint8Array): PreviewSource {
  const d = core.draft;
  return { plate: d.plate, crust: d.crust, elev: d.elev, boundary: core.boundary, plates: d.plates, seaLevel: 0, style, highlight };
}

describe('boundary classification', () => {
  it('classifyCell matches draft.classifyBoundaries on every cell', () => {
    const snap = syntheticSnapshot(mesh, 4, 10);
    const ref = classifyBoundaries(mesh, snap.plate, snap.plates);
    for (let i = 0; i < mesh.n; i++) expect(classifyCell(mesh, snap.plate, snap.plates, i)).toBe(ref[i]);
  });

  it('incremental reclassification after edits equals a full classification', () => {
    const snap = syntheticSnapshot(mesh, 9, 8);
    const core = new EditorCore(mesh, draftFromSnapshot(snap, 3));
    core.drainChanges();
    // A new motionless plate gets a default motion when first painted: its boundaries update too.
    core.addPlate();
    const k = core.plates.length - 1;
    const a = core.anchors()[0]!;
    core.beginStroke('plate', { radius: km(700), plate: k });
    core.strokeTo(a);
    core.endStroke();
    expect(core.plateMotion(k)!.speed).toBeGreaterThan(10);
    core.drainChanges();
    expect(Array.from(core.boundary)).toEqual(Array.from(classifyBoundaries(mesh, core.draft.plate, core.draft.plates)));
    const rng = new Rng(5);
    for (let s = 0; s < 12; s++) {
      const p = rng.unitVector();
      const q = rng.unitVector();
      core.beginStroke('plate', { radius: km(rng.float(150, 900)), plate: rng.int(0, core.plates.length) });
      core.strokeTo(p);
      core.strokeTo([p[0] * 0.8 + q[0] * 0.2, p[1] * 0.8 + q[1] * 0.2, p[2] * 0.8 + q[2] * 0.2]);
      // Mid-stroke: incremental classes are exact too.
      core.drainChanges();
      expect(Array.from(core.boundary)).toEqual(Array.from(classifyBoundaries(mesh, core.draft.plate, core.draft.plates)));
      core.endStroke();
      core.drainChanges();
      expect(Array.from(core.boundary)).toEqual(Array.from(classifyBoundaries(mesh, core.draft.plate, core.draft.plates)));
    }
  });
});

describe('PreviewRaster', () => {
  it('nearest map agrees with the core grid map', () => {
    const map = buildMeshGridMap(mesh, 256, 128);
    expect(Array.from(buildNearestMap(mesh, 256, 128))).toEqual(Array.from(map.nearest));
  });

  it('incremental cell recolouring reproduces a full repaint exactly', () => {
    const snap = syntheticSnapshot(mesh, 2, 9);
    const core = new EditorCore(mesh, draftFromSnapshot(snap, 3));
    const nearest = buildNearestMap(mesh, 360, 180);
    for (const style of ['plates', 'relief'] as PreviewStyle[]) {
      const inc = new PreviewRaster(mesh, 360, 180, nearest);
      core.drainChanges();
      inc.renderAll(source(core, style));
      const rng = new Rng(style === 'plates' ? 1 : 2);
      const tools = ['plate', 'continent', 'ocean', 'raise', 'smooth'] as const;
      for (let s = 0; s < 10; s++) {
        const tool = tools[s % tools.length];
        const p = rng.unitVector();
        core.beginStroke(tool, { radius: km(rng.float(200, 1200)), plate: rng.int(0, core.plates.length), amount: 800 });
        core.strokeTo(p);
        core.strokeTo(rng.unitVector().map((v, c) => p[c] + 0.3 * v) as Vec3);
        const mid = core.drainChanges();
        if (mid.all) inc.renderAll(source(core, style));
        else inc.renderCells(source(core, style), mid.cells);
        core.endStroke();
        const ch = core.drainChanges();
        if (ch.all) inc.renderAll(source(core, style));
        else inc.renderCells(source(core, style), ch.cells);
      }
      const full = new PreviewRaster(mesh, 360, 180, nearest);
      full.renderAll(source(core, style));
      let diff = 0;
      for (let q = 0; q < inc.rgba.length; q++) if (inc.rgba[q] !== full.rgba[q]) diff++;
      expect({ style, diff }).toEqual({ style, diff: 0 });
    }
  });

  it('draws boundary lines coloured by boundary type and highlights tool paths', () => {
    // Cap moving east: convergent leading (east) edge, divergent trailing (west) edge.
    const core = new EditorCore(mesh, twoPlateDraft(mesh, 'cap', { speed: 60, capRadiusDeg: 30 }));
    core.drainChanges();
    const w = 720, h = 360;
    const r = new PreviewRaster(mesh, w, h);
    r.renderAll(source(core, 'plates'));
    const px = (lat: number, lon: number) => {
      const p = gridIndexAt(w, h, lat * DEG, lon * DEG);
      return [r.rgba[4 * p], r.rgba[4 * p + 1], r.rgba[4 * p + 2]];
    };
    const near = (c: number[], ref: number[]) => Math.hypot(c[0] - ref[0], c[1] - ref[1], c[2] - ref[2]) < 60;
    const scan = (lat: number, lo0: number, lo1: number, ref: number[]) => {
      for (let lon = lo0; lon <= lo1; lon += 0.25) if (near(px(lat, lon), ref)) return true;
      return false;
    };
    expect(scan(0, 26, 34, PREVIEW_BOUNDARY_COLORS[BOUNDARY_CONVERGENT])).toBe(true);
    expect(scan(0, -34, -26, PREVIEW_BOUNDARY_COLORS[BOUNDARY_DIVERGENT])).toBe(true);
    // Interior pixels are the plate colour (darkened ocean), not a line.
    expect(near(px(0, 0), PREVIEW_BOUNDARY_COLORS[BOUNDARY_CONVERGENT])).toBe(false);
    const hl = new Uint8Array(mesh.n);
    const c0 = core.cellAt(ll(0, 0));
    hl[c0] = 1;
    const before = px(0, 0);
    r.renderCells(source(core, 'plates', hl), [c0]);
    const after = px(0, 0);
    expect(after[0] + after[1] + after[2]).toBeGreaterThan(before[0] + before[1] + before[2] + 100);
  });
});
