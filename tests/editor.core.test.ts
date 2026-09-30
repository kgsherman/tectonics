import { describe, expect, it } from 'vitest';
import { DEG, EARTH_RADIUS_KM, MAX_PLATES } from '../src/core/constants';
import { angleBetween, cross3, dot3, latLonToVec, omegaFromDirection } from '../src/core/math3';
import { nearestCell } from '../src/core/sphereMesh';
import type { SphereMesh, Vec3, WorldDraft } from '../src/core/types';
import { CRUST_CONTINENTAL, CRUST_OCEANIC } from '../src/core/types';
import { EditorCore } from '../src/editor/editorCore';
import { ARROW_RAD_PER_KM_MYR, HISTORY_MIN_STEPS, MIN_FRAGMENT_CELLS } from '../src/editor/editorConstants';
import { labelComponents, plateAnchors } from '../src/editor/topology';
import { motionAt, omegaFromDrag, omegaFromMotion, arrowHead } from '../src/editor/motion';
import { blankDraft, cloneDraft, oceanDepthForAge, plateColor } from '../src/tectonics/draft';
import { smallMesh, twoPlateDraft } from './helpers/fixtures';

const mesh = smallMesh(12000);
const ll = (latDeg: number, lonDeg: number): Vec3 => latLonToVec(latDeg * DEG, lonDeg * DEG);
const km = (x: number) => x / EARTH_RADIUS_KM;

function cellPoint(m: SphereMesh, i: number): Vec3 {
  return [m.xyz[3 * i], m.xyz[3 * i + 1], m.xyz[3 * i + 2]];
}

/** Draft with plate 0 everywhere except a cap (plate 1) of the given radius centred at c. */
function capDraft(m: SphereMesh, c: Vec3, radiusDeg: number, extra?: (i: number, p: Vec3) => number | undefined): WorldDraft {
  const d = blankDraft(m, 5);
  d.plates.push({ id: 2, name: 'Cap', color: plateColor(1), omega: omegaFromDirection(c, 1, 0, 40) });
  d.plates[0].omega = omegaFromDirection(ll(-30, 90), 0, 1, 25);
  d.nextPlateId = 3;
  for (let i = 0; i < m.n; i++) {
    const p = cellPoint(m, i);
    d.plate[i] = angleBetween(p, c) < radiusDeg * DEG ? 1 : 0;
    if (extra) d.plate[i] = extra(i, p) ?? d.plate[i];
  }
  return d;
}

/** Stable fingerprint of the whole edit state for undo/redo comparisons. */
function fingerprint(core: EditorCore): string {
  const d = core.draft;
  let h = 0;
  const mix = (v: number) => {
    h = (Math.imul(h ^ (v | 0), 2654435761) + 0x9e3779b9) | 0;
  };
  for (let i = 0; i < d.n; i++) {
    mix(d.plate[i]);
    mix(d.crust[i]);
    mix(Math.round(d.elev[i] * 100));
    mix(Math.round(d.age[i] * 100));
    mix(core.state.userElev[i] | (core.state.sourceRelief[i] << 1) | (core.state.brushRelief[i] << 2));
  }
  const plates = d.plates.map((p) => `${p.id}:${p.name}:${p.color.join(',')}:${p.omega.map((w) => w.toExponential(9)).join(',')}`).join('|');
  return `${h}|${d.nextPlateId}|${plates}|${[...core.state.dirtyPlates].sort((a, b) => a - b).join(',')}`;
}

function stroke(core: EditorCore, points: Array<Vec3 | null>, tool: Parameters<EditorCore['beginStroke']>[0], opts: Parameters<EditorCore['beginStroke']>[1]) {
  core.beginStroke(tool, opts);
  for (const p of points) core.strokeTo(p);
  return core.endStroke();
}

function checkInvariants(core: EditorCore): void {
  const d = core.draft;
  expect(d.plates.length).toBeGreaterThanOrEqual(1);
  expect(d.plates.length).toBeLessThanOrEqual(core.cap);
  const ids = new Set(d.plates.map((p) => p.id));
  expect(ids.size).toBe(d.plates.length);
  for (const id of ids) expect(id).toBeLessThan(d.nextPlateId);
  for (let i = 0; i < d.n; i++) {
    expect(d.plate[i] >= 0 && d.plate[i] < d.plates.length).toBe(true);
    expect(Number.isFinite(d.elev[i]) && Number.isFinite(d.age[i])).toBe(true);
  }
  for (const p of d.plates) expect(p.omega.every(Number.isFinite)).toBe(true);
}

describe('plate brush', () => {
  it('paints along the stroke, assigns a default motion to a new plate, and undo/redo are exact', () => {
    const core = new EditorCore(mesh, blankDraft(mesh, 3), { source: 'blank' });
    const f0 = fingerprint(core);
    const add = core.addPlate();
    expect(add.ok).toBe(true);
    expect(core.plates.length).toBe(2);
    expect(core.plates[1].omega).toEqual([0, 0, 0]);
    const f1 = fingerprint(core);
    const res = stroke(core, [ll(0, -20), ll(0, 20)], 'plate', { radius: km(500), plate: 1 });
    expect(res.ok).toBe(true);
    const counts = core.counts();
    expect(counts[1]).toBeGreaterThan(50);
    // Cells along the stroke's path belong to the new plate.
    for (let lon = -20; lon <= 20; lon += 2) expect(core.plateAt(ll(0, lon))).toBe(1);
    expect(core.plateAt(ll(0, 40))).toBe(0);
    // Default motion 30–60 km/Myr (continental-free plate) at its anchor.
    const m = core.plateMotion(1);
    expect(m).not.toBeNull();
    expect(m!.speed).toBeGreaterThan(29);
    expect(m!.speed).toBeLessThan(61);
    const f2 = fingerprint(core);
    checkInvariants(core);
    expect(core.undo()).toBe(true);
    expect(fingerprint(core)).toBe(f1);
    expect(core.undo()).toBe(true);
    expect(fingerprint(core)).toBe(f0);
    expect(core.undo()).toBe(false);
    expect(core.redo()).toBe(true);
    expect(core.redo()).toBe(true);
    expect(fingerprint(core)).toBe(f2);
    expect(core.redo()).toBe(false);
  });

  it('crosses the antimeridian the short way and breaks on null picks', () => {
    const core = new EditorCore(mesh, capDraft(mesh, ll(-60, 0), 10));
    // Both painted strips are detached from the cap; they stay the brush's plate (no new plates).
    stroke(core, [ll(30, 170), ll(30, -170), null, ll(-10, 170), ll(-10, -170)], 'plate', { radius: km(500), plate: 1 });
    expect(core.plates.length).toBe(2);
    expect(core.plateAt(ll(30, 180))).toBe(1);
    expect(core.plateAt(ll(-10, 180))).toBe(1);
    // Neither the long way round nor the gap between the two segments was painted.
    expect(core.plateAt(ll(30, 0))).toBe(0);
    expect(core.plateAt(ll(10, 180))).toBe(0);
    expect(core.plateAt(ll(10, 170))).toBe(0);
  });

  it('always paints the nearest cell, even with a tiny brush', () => {
    const core = new EditorCore(mesh, capDraft(mesh, ll(0, 0), 20));
    const p = ll(45, 45);
    core.beginStroke('plate', { radius: 1e-9, plate: 1 });
    core.strokeTo(p);
    expect(core.draft.plate[nearestCell(mesh, p[0], p[1], p[2])]).toBe(1);
    // Painted cells keep the brush's plate, even a one-cell detached island (it merges only on "Simulate").
    const res = core.endStroke();
    expect(res.ok).toBe(true);
    expect(res.message).not.toMatch(/merged|tidied/);
    expect(core.draft.plate[nearestCell(mesh, p[0], p[1], p[2])]).toBe(1);
    expect(core.pieces().pieces[1]).toBe(2);
    expect(core.pieces().tiny[1]).toBe(1);
    expect(core.finalize(3).plate[nearestCell(mesh, p[0], p[1], p[2])]).toBe(0);
    // Next to the plate the same tiny dab sticks.
    const q = ll(0, 20.5);
    const qi = nearestCell(mesh, q[0], q[1], q[2]);
    const before = core.draft.plate[qi];
    const target = before === 1 ? 0 : 1;
    stroke(core, [q], 'plate', { radius: 1e-9, plate: target });
    expect(core.draft.plate[qi]).toBe(target);
  });

  it('cancel restores the state before the stroke', () => {
    const core = new EditorCore(mesh, capDraft(mesh, ll(0, 0), 20));
    const f0 = fingerprint(core);
    core.beginStroke('plate', { radius: km(800), plate: 1 });
    core.strokeTo(ll(40, 40));
    core.strokeTo(ll(40, 80));
    expect(fingerprint(core)).not.toBe(f0);
    core.cancel();
    expect(fingerprint(core)).toBe(f0);
    expect(core.canUndo).toBe(false);
  });
});

describe('topology maintenance', () => {
  // Strokes never create or remove plates (they used to auto-split detached pieces into new plates
  // and delete painted-over plates; the plate list now only changes through explicit tools).
  it('cutting a plate in two keeps both halves on the plate; painting a plate over leaves it empty', () => {
    // Northern plate cut by a meridional band of the southern plate over the pole.
    const core = new EditorCore(mesh, twoPlateDraft(mesh, 'transform'));
    const north = core.plates[1];
    const res = stroke(core, [ll(0, 0), ll(90, 0), ll(0, 180)], 'plate', { radius: km(400), plate: 0 });
    expect(res.ok).toBe(true);
    expect(res.created.length).toBe(0);
    expect(core.plates.length).toBe(2);
    expect(core.plates[1].id).toBe(north.id);
    expect(core.plateAt(ll(45, 90))).toBe(1);
    expect(core.plateAt(ll(45, -90))).toBe(1);
    expect(core.pieces().pieces[1]).toBe(2);
    checkInvariants(core);
    // Paint the northern plate over completely: it stays in the list, empty, until deleted.
    const res2 = stroke(core, [ll(90, 0)], 'plate', { radius: 95 * DEG, plate: 0 });
    expect(res2.removed.length).toBe(0);
    expect(res2.message).toMatch(/now empty/);
    expect(core.plates.length).toBe(2);
    expect(core.counts()[1]).toBe(0);
    checkInvariants(core);
    expect(core.removeEmptyPlates().ok).toBe(true);
    expect(core.plates.map((p) => p.id)).toEqual([core.plates[0].id]);
    expect(core.removeEmptyPlates().ok).toBe(false);
  });

  it('tidies slivers the stroke cut off other plates, never pieces of the brush plate or distant ones', () => {
    // Plate 1: a main cap plus a large island and a tiny island inside plate 0, far from the stroke.
    const bigIsland = ll(-40, 120), tinyIsland = ll(-10, -100);
    const tinyCells = new Set<number>();
    const t0 = nearestCell(mesh, tinyIsland[0], tinyIsland[1], tinyIsland[2]);
    tinyCells.add(t0);
    for (let e = mesh.adjOffset[t0]; e < mesh.adjOffset[t0 + 1]; e++) tinyCells.add(mesh.adj[e]);
    expect(tinyCells.size).toBeLessThan(MIN_FRAGMENT_CELLS);
    const d = capDraft(mesh, ll(40, 0), 25, (i, p) => (tinyCells.has(i) || angleBetween(p, bigIsland) < 10 * DEG ? 1 : undefined));
    const core = new EditorCore(mesh, d);
    const res = stroke(core, [ll(-70, -60)], 'plate', { radius: km(100), plate: 0 });
    expect(res.created.length).toBe(0);
    expect(core.plates.length).toBe(2);
    // Distant pieces are left alone.
    for (const i of tinyCells) expect(core.draft.plate[i]).toBe(1);
    expect(core.plateAt(bigIsland)).toBe(1);
    expect(core.pieces().pieces[1]).toBe(3);
    // Painting over the cap's edge never adds plates (sliver tidying: see polish.editor-ux.test.ts).
    const before = core.counts()[1];
    const res2 = stroke(core, [ll(40, 25 / Math.cos(40 * DEG) - 5.5), ll(47, 22), ll(33, 22)], 'plate', { radius: km(250), plate: 0 });
    expect(res2.created.length).toBe(0);
    expect(core.plates.length).toBe(2);
    expect(core.counts()[1]).toBeLessThan(before);
    // Finalize keeps the island as part of plate 1 and merges only the tiny one.
    const fin = core.finalize(5);
    expect(fin.plates.length).toBe(2);
    const fi = nearestCell(mesh, bigIsland[0], bigIsland[1], bigIsland[2]);
    expect(fin.plates[fin.plate[fi]].id).toBe(core.plates[1].id);
    for (const i of tinyCells) expect(fin.plate[i]).toBe(0);
  });

  it('deleting a plate merges it into the neighbour with the longest shared boundary', () => {
    // Plate 1: cap at 30°N, radius 35° → mostly surrounded by plate 0, slightly touching plate 2 (south of 0°).
    const d = capDraft(mesh, ll(30, 0), 35);
    for (let i = 0; i < mesh.n; i++) if (mesh.xyz[3 * i + 2] < -Math.sin(3 * DEG) && d.plate[i] !== 1) d.plate[i] = 2;
    d.plates.push({ id: 3, name: 'South', color: plateColor(2), omega: [0, 0, 0.004] });
    d.nextPlateId = 4;
    const core = new EditorCore(mesh, d);
    const capCells: number[] = [];
    for (let i = 0; i < mesh.n; i++) if (core.draft.plate[i] === 1) capCells.push(i);
    const res = core.deletePlate(1);
    expect(res.ok).toBe(true);
    expect(core.plates.length).toBe(2);
    expect(core.plates.map((p) => p.id)).toEqual([1, 3]);
    for (const i of capCells) expect(core.draft.plate[i]).toBe(0);
    checkInvariants(core);
    expect(core.deletePlate(0).ok).toBe(true);
    expect(core.plates.length).toBe(1);
    expect(core.deletePlate(0).ok).toBe(false);
  });
});

describe('region tools', () => {
  it('fill replaces the connected region under the cursor', () => {
    const core = new EditorCore(mesh, capDraft(mesh, ll(0, 0), 25));
    core.addPlate();
    const res = core.fill(ll(0, 0), 2);
    expect(res.ok).toBe(true);
    // The cap plate lost all its cells and stays in the list, empty; the new plate took them.
    expect(core.plates.length).toBe(3);
    expect(core.counts()[1]).toBe(0);
    expect(core.plateAt(ll(0, 0))).toBe(2);
    expect(core.plateAt(ll(0, 90))).toBe(0);
    expect(core.fill(ll(0, 0), 2).ok).toBe(false);
  });

  it('split along a stroke that crosses a plate edge to edge', () => {
    const core = new EditorCore(mesh, twoPlateDraft(mesh, 'transform'));
    const north = core.plates[1];
    const res = core.split([ll(-1, 0), ll(90, 0), ll(-1, 180)]);
    expect(res.ok).toBe(true);
    expect(core.plates.length).toBe(3);
    const counts = core.counts();
    expect(Math.abs(counts[1] - counts[2]) / (counts[1] + counts[2])).toBeLessThan(0.1);
    expect(core.plates[2].omega).toEqual(north.omega);
    expect(core.plateAt(ll(45, 90))).not.toBe(core.plateAt(ll(45, -90)));
    checkInvariants(core);
  });

  it('a short cut extends straight to the plate edges (and is refused without extension)', () => {
    const core = new EditorCore(mesh, twoPlateDraft(mesh, 'transform'));
    const res0 = core.split([ll(20, 0), ll(60, 0)], { extend: false });
    expect(res0.ok).toBe(false);
    expect(core.plates.length).toBe(2);
    expect(core.canUndo).toBe(false);
    // Default: the line continues along its great circle (the 0°/180° meridian) to the equator.
    const res = core.split([ll(20, 0), ll(60, 0)]);
    expect(res.ok).toBe(true);
    expect(core.plates.length).toBe(3);
    expect(core.plateAt(ll(45, 90))).not.toBe(core.plateAt(ll(45, -90)));
    // The southern plate is untouched.
    expect(core.plateAt(ll(-45, 90))).toBe(core.plateAt(ll(-45, -90)));
  });

  it('lasso creates a new plate from the enclosed cells', () => {
    const core = new EditorCore(mesh, blankDraft(mesh, 2));
    const c = ll(10, 30);
    const loop: Vec3[] = [];
    for (let k = 0; k < 72; k++) {
      const a = (k / 72) * 2 * Math.PI;
      loop.push(latLonToVec((10 + 20 * Math.sin(a)) * DEG, (30 + (20 * Math.cos(a)) / Math.cos(10 * DEG)) * DEG));
    }
    const res = core.lasso(loop, 'new');
    expect(res.ok).toBe(true);
    expect(core.plates.length).toBe(2);
    expect(core.plateAt(c)).toBe(1);
    expect(core.plateAt(ll(10, 80))).toBe(0);
    const area = core.counts()[1] / mesh.n;
    const expected = (1 - Math.cos(20 * DEG)) / 2;
    expect(area / expected).toBeGreaterThan(0.85);
    expect(area / expected).toBeLessThan(1.2);
    expect(core.plateMotion(1)!.speed).toBeGreaterThan(15);
    // Lasso into an existing plate.
    const small: Vec3[] = [ll(-15, 25), ll(-15, 35), ll(-5, 35), ll(-5, 25)];
    expect(core.lasso(small, 1).ok).toBe(true);
    expect(core.plateAt(ll(-12, 30))).toBe(1);
  });

  it('seeds become Voronoi plates with fresh unique ids', () => {
    const core = new EditorCore(mesh, blankDraft(mesh, 4));
    const seeds = [ll(0, 0), ll(0, 90), ll(0, 180), ll(0, -90), ll(80, 0), ll(-80, 0)];
    const res = core.applySeeds(seeds, 0.4);
    expect(res.ok).toBe(true);
    expect(core.plates.length).toBe(6);
    seeds.forEach((s, k) => expect(core.plateAt(s)).toBe(k));
    expect(core.plates[0].id).toBeGreaterThanOrEqual(2);
    checkInvariants(core);
    expect(labelComponents(mesh, core.draft.plate).size.length).toBe(6);
    for (let k = 0; k < 6; k++) expect(core.plateMotion(k)!.speed).toBeGreaterThan(15);
  });

  it('smooth removes single-cell jaggies', () => {
    const d = capDraft(mesh, ll(0, 0), 30);
    // Sprinkle isolated plate-0 cells into the cap interior.
    let sprinkled = 0;
    for (let i = 0; i < mesh.n; i += 37) {
      if (d.plate[i] === 1 && angleBetween(cellPoint(mesh, i), ll(0, 0)) < 20 * DEG) {
        d.plate[i] = 0;
        sprinkled++;
      }
    }
    expect(sprinkled).toBeGreaterThan(5);
    const core = new EditorCore(mesh, d);
    core.smoothAll();
    expect(labelComponents(mesh, core.draft.plate).size.length).toBe(2);
  });
});

describe('motion', () => {
  it('omega = (a × v)/R + spin·a reproduces the dragged velocity and keeps spin', () => {
    const a = ll(20, 40);
    const spin = 0.002;
    const w = omegaFromMotion(a, 50, 60, spin);
    const m = motionAt(w, a);
    expect(m.speed).toBeCloseTo(50, 9);
    expect(m.bearing).toBeCloseTo(60, 9);
    expect(m.spin).toBeCloseTo(spin, 12);
    const v = cross3(w, a);
    expect(Math.hypot(...v) * EARTH_RADIUS_KM).toBeCloseTo(50, 9);
    // Dragging the arrow head to its own position reproduces the same omega.
    const head = arrowHead(a, w);
    const w2 = omegaFromDrag(a, head, spin);
    for (let c = 0; c < 3; c++) expect(w2[c]).toBeCloseTo(w[c], 12);
    // Drag east by 8° → 50 km/Myr toward 90°.
    const w3 = omegaFromDrag(ll(0, 0), ll(0, 8), 0);
    const m3 = motionAt(w3, ll(0, 0));
    expect(m3.speed).toBeCloseTo((8 * DEG) / ARROW_RAD_PER_KM_MYR, 6);
    expect(m3.bearing).toBeCloseTo(90, 6);
    expect(dot3(w3, ll(0, 0))).toBeCloseTo(0, 12);
    // Speeds are capped.
    expect(motionAt(omegaFromDrag(ll(0, 0), ll(0, 90), 0), ll(0, 0)).speed).toBeCloseTo(150, 6);
  });

  it('anchors sit deep inside their plates, also for crescent-shaped plates', () => {
    const d = capDraft(mesh, ll(0, 0), 30);
    let anchors = plateAnchors(mesh, d.plate, 2);
    expect(angleBetween(anchors[1]!, ll(0, 0))).toBeLessThan(2 * mesh.spacing);
    // Crescent: cap minus an offset cap → centroid lies outside the plate.
    const hole = ll(0, 12);
    for (let i = 0; i < mesh.n; i++) if (angleBetween(cellPoint(mesh, i), hole) < 26 * DEG) d.plate[i] = 0;
    anchors = plateAnchors(mesh, d.plate, 2);
    const a = anchors[1]!;
    expect(d.plate[nearestCell(mesh, a[0], a[1], a[2])]).toBe(1);
    // Whole-sphere plate: falls back gracefully.
    const one = plateAnchors(mesh, new Int16Array(mesh.n), 1)[0]!;
    expect(Math.hypot(...one)).toBeCloseTo(1, 9);
  });

  it('a motion drag is one undoable step and reclassifies boundaries live', () => {
    const core = new EditorCore(mesh, capDraft(mesh, ll(0, 0), 20));
    core.drainChanges();
    const f0 = fingerprint(core);
    const a = core.anchors()[1]!;
    core.beginMotion(1);
    core.updateMotion(omegaFromDrag(a, ll(0, 5), 0));
    core.updateMotion(omegaFromDrag(a, ll(0, -8), 0));
    const ch = core.drainChanges();
    expect(ch.all).toBe(false);
    expect(ch.cells.length).toBeGreaterThan(0);
    core.endMotion();
    expect(Math.abs(core.plateMotion(1)!.bearing - 270)).toBeLessThan(3);
    expect(core.state.dirtyPlates.has(core.plates[1].id)).toBe(true);
    core.undo();
    expect(fingerprint(core)).toBe(f0);
  });
});

describe('history', () => {
  it('undoes and redoes a mixed sequence of operations exactly', () => {
    const core = new EditorCore(mesh, capDraft(mesh, ll(0, 0), 25), { source: 'current' });
    const prints = [fingerprint(core)];
    const ops: Array<() => unknown> = [
      () => core.addPlate(),
      () => stroke(core, [ll(40, 100), ll(50, 140)], 'plate', { radius: km(600), plate: 2 }),
      () => stroke(core, [ll(-20, -60), ll(-30, -20)], 'continent', { radius: km(900) }),
      () => stroke(core, [ll(-25, -40)], 'ocean', { radius: km(300) }),
      () => stroke(core, [ll(10, 150), ll(10, 170)], 'raise', { radius: km(400), amount: 300 }),
      () => core.fill(ll(0, 0), 0),
      () => core.lasso([ll(-50, 60), ll(-50, 100), ll(-20, 100), ll(-20, 60)], 'new'),
      () => core.randomizeMotions(),
      () => core.renamePlate(0, 'Pacifica'),
      () => core.recolorPlate(0, [10, 20, 30]),
      () => core.split([ll(-90, 0), ll(90, 0)]),
      () => core.deletePlate(1),
      () => core.applySeeds([ll(0, 0), ll(0, 120), ll(0, -120)], 0.5),
    ];
    for (const op of ops) {
      op();
      prints.push(fingerprint(core));
      checkInvariants(core);
    }
    for (let k = ops.length - 1; k >= 0; k--) {
      if (prints[k + 1] === prints[k]) continue;
      expect(core.undo()).toBe(true);
      expect(fingerprint(core)).toBe(prints[k]);
    }
    for (let k = 1; k <= ops.length; k++) {
      if (prints[k] === prints[k - 1]) continue;
      expect(core.redo()).toBe(true);
      expect(fingerprint(core)).toBe(prints[k]);
    }
  });

  it(`keeps at least ${HISTORY_MIN_STEPS} steps`, () => {
    const core = new EditorCore(mesh, blankDraft(mesh, 1));
    for (let k = 0; k < HISTORY_MIN_STEPS + 5; k++) stroke(core, [ll(0, k * 9)], 'raise', { radius: km(300), amount: 100 });
    let undone = 0;
    while (core.undo()) undone++;
    expect(undone).toBeGreaterThanOrEqual(HISTORY_MIN_STEPS);
  });

  it('loading a draft is undoable; reset clears the history', () => {
    const core = new EditorCore(mesh, capDraft(mesh, ll(0, 0), 25));
    const f0 = fingerprint(core);
    core.load(blankDraft(mesh, 9), 'blank', 'Blank world');
    expect(core.plates.length).toBe(1);
    core.undo();
    expect(fingerprint(core)).toBe(f0);
    core.reset(blankDraft(mesh, 2));
    expect(core.canUndo).toBe(false);
    expect(() => core.reset(blankDraft(smallMesh(4000), 1))).toThrow();
  });
});

describe('plate cap', () => {
  it('never exceeds the cap: add, lasso, split and seeds all respect it', () => {
    const core = new EditorCore(mesh, twoPlateDraft(mesh, 'transform'), { maxPlates: 3 });
    expect(core.addPlate().ok).toBe(true);
    expect(core.addPlate().ok).toBe(false);
    expect(core.lasso([ll(10, 0), ll(10, 20), ll(30, 20), ll(30, 0)], 'new').ok).toBe(false);
    expect(core.applySeeds([ll(0, 0), ll(0, 90), ll(0, 180), ll(0, -90)], 0.3).ok).toBe(false);
    expect(core.split([ll(-1, 0), ll(90, 0), ll(-1, 180)]).ok).toBe(false);
    // Cutting a plate in two with the brush at the cap is fine: strokes never add plates.
    stroke(core, [ll(0, 0), ll(90, 0), ll(0, 180)], 'plate', { radius: km(400), plate: 0 });
    expect(core.plates.length).toBe(3);
    checkInvariants(core);
    expect(new EditorCore(mesh, blankDraft(mesh, 1)).cap).toBe(MAX_PLATES);
  });
});

describe('continent / ocean / relief brushes', () => {
  it('continent brush paints continental crust with a submerged shelf ring and land inside', () => {
    const core = new EditorCore(mesh, blankDraft(mesh, 7), { source: 'blank' });
    stroke(core, [ll(0, -10), ll(0, 10)], 'continent', { radius: km(1500) });
    const d = core.draft;
    let cont = 0, coastBelow = 0, coast = 0, inlandAbove = 0, inland = 0;
    for (let i = 0; i < mesh.n; i++) {
      if (d.crust[i] !== CRUST_CONTINENTAL) continue;
      cont++;
      expect(core.state.brushRelief[i]).toBe(1);
      let nearOcean = false;
      for (let e = mesh.adjOffset[i]; e < mesh.adjOffset[i + 1]; e++) if (d.crust[mesh.adj[e]] === CRUST_OCEANIC) nearOcean = true;
      if (nearOcean) {
        coast++;
        if (d.elev[i] < 0) coastBelow++;
      } else if (angleBetween(cellPoint(mesh, i), ll(0, 0)) < km(700)) {
        inland++;
        if (d.elev[i] > 0) inlandAbove++;
      }
    }
    expect(cont).toBeGreaterThan(300);
    expect(coastBelow / coast).toBeGreaterThan(0.95);
    expect(inlandAbove / inland).toBeGreaterThan(0.9);
    // Coastline is irregular, not a perfect circle: some cells beyond the nominal radius, some missing inside it.
    // Ocean brush restores age-based depth and oceanic crust.
    stroke(core, [ll(0, 0)], 'ocean', { radius: km(400) });
    const c = nearestCell(mesh, 1, 0, 0);
    expect(d.crust[c]).toBe(CRUST_OCEANIC);
    expect(d.elev[c]).toBeCloseTo(oceanDepthForAge(d.age[c]), 3);
    // The new inner coast gets a shelf too (relief recomputed around the edit).
    let innerShelf = 0, innerCoast = 0;
    for (let i = 0; i < mesh.n; i++) {
      if (d.crust[i] !== CRUST_CONTINENTAL) continue;
      const ang = angleBetween(cellPoint(mesh, i), ll(0, 0));
      if (ang > km(700)) continue;
      let nearOcean = false;
      for (let e = mesh.adjOffset[i]; e < mesh.adjOffset[i + 1]; e++) if (d.crust[mesh.adj[e]] === CRUST_OCEANIC) nearOcean = true;
      if (nearOcean) {
        innerCoast++;
        if (d.elev[i] < 0) innerShelf++;
      }
    }
    expect(innerCoast).toBeGreaterThan(5);
    expect(innerShelf / innerCoast).toBeGreaterThan(0.9);
  });

  it('raise/lower sculpt smoothly and are kept by finalize', () => {
    const core = new EditorCore(mesh, blankDraft(mesh, 7), { source: 'blank' });
    const c = ll(20, 20);
    const ci = nearestCell(mesh, c[0], c[1], c[2]);
    const e0 = core.draft.elev[ci];
    stroke(core, [c], 'raise', { radius: km(600), amount: 1000 });
    expect(core.draft.elev[ci] - e0).toBeGreaterThan(900);
    const edge = nearestCell(mesh, ...ll(20, 20 + (550 / EARTH_RADIUS_KM / DEG) / Math.cos(20 * DEG)));
    expect(core.draft.elev[edge] - e0).toBeLessThan(200);
    stroke(core, [c], 'lower', { radius: km(600), amount: 400 });
    expect(core.draft.elev[ci] - e0).toBeGreaterThan(500);
    expect(core.draft.elev[ci] - e0).toBeLessThan(700);
    const mask = core.keepElevationMask();
    expect(mask[ci]).toBe(1);
    const fin = core.finalize(11);
    expect(fin.elev[ci]).toBeCloseTo(core.draft.elev[ci], 3);
  });

  it('source relief is kept only on plates whose outline and motion are untouched', () => {
    const d = capDraft(mesh, ll(0, 0), 25);
    const core = new EditorCore(mesh, d, { source: 'random' });
    const inCap = nearestCell(mesh, 1, 0, 0);
    const outside = nearestCell(mesh, ...ll(0, 120));
    expect(core.keepElevationMask()[inCap]).toBe(1);
    expect(core.keepElevationMask()[outside]).toBe(1);
    const a = core.anchors()[1]!;
    core.beginMotion(1);
    core.updateMotion(omegaFromDrag(a, ll(0, -6), 0));
    core.endMotion();
    expect(core.keepElevationMask()[inCap]).toBe(0);
    expect(core.keepElevationMask()[outside]).toBe(1);
    const blank = new EditorCore(mesh, blankDraft(mesh, 1));
    expect(blank.keepElevationMask().some((v) => v !== 0)).toBe(false);
  });

  it('finalize yields a simulation-ready draft', () => {
    const core = new EditorCore(mesh, blankDraft(mesh, 3), { source: 'blank' });
    core.applySeeds([ll(0, 0), ll(30, 100), ll(-40, -120), ll(70, -30)], 0.5);
    stroke(core, [ll(10, -20), ll(20, 20)], 'continent', { radius: km(1200) });
    const before = cloneDraft(core.draft);
    const fin = core.finalize(99);
    expect(fin.plates.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < fin.n; i++) {
      expect(fin.plate[i] >= 0 && fin.plate[i] < fin.plates.length).toBe(true);
      expect(Number.isFinite(fin.elev[i])).toBe(true);
    }
    // The editor's own draft is untouched.
    expect(core.draft.elev).toEqual(before.elev);
  });
});

describe('review regressions', () => {
  it('finalize merges tiny fragments in any order and leaves every plate in one piece', () => {
    // A small island of plate A (FA) half-ringed by a smaller island of plate B (FB): FA is resolved
    // first and borders FB most, then FB itself merges away. Strokes elsewhere leave such pre-existing
    // pieces alone; "Simulate" (finalize) must leave every plate as one region.
    const c0 = ll(0, 0);
    const east: Vec3 = [0, 1, 0], north: Vec3 = [0, 0, 1];
    let checked = 0;
    for (const [r1, r2, sector] of [[3, 3.8, 270], [3, 3.8, 300], [3, 3.8, 330]] as const) {
      const d = blankDraft(mesh, 1);
      d.plates.push({ id: 2, name: 'A', color: plateColor(1), omega: [0, 0, 0.001] });
      d.plates.push({ id: 3, name: 'B', color: plateColor(2), omega: [0, 0.001, 0] });
      d.nextPlateId = 4;
      let fa = 0, fb = 0;
      for (let i = 0; i < mesh.n; i++) {
        const p = cellPoint(mesh, i);
        if (angleBetween(p, ll(60, 0)) < 15 * DEG) d.plate[i] = 1;
        if (angleBetween(p, ll(-60, 0)) < 15 * DEG) d.plate[i] = 2;
        const a = angleBetween(p, c0);
        if (a < r1 * DEG) {
          d.plate[i] = 1;
          fa++;
        } else if (a < r2 * DEG && (Math.atan2(dot3(p, north), dot3(p, east)) / DEG + 360) % 360 < sector) {
          d.plate[i] = 2;
          fb++;
        }
      }
      if (!(fa > fb && fb > 0 && fa < MIN_FRAGMENT_CELLS)) continue;
      checked++;
      const core = new EditorCore(mesh, d);
      stroke(core, [ll(0, 120)], 'plate', { radius: 1e-9, plate: 0 });
      checkInvariants(core);
      const fin = core.finalize(1);
      const comps = labelComponents(mesh, fin.plate);
      expect(new Set(comps.label).size).toBe(comps.label.length);
      expect(fin.plates.length).toBe(3);
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('deleting a plate in several pieces merges each piece into its own neighbour', () => {
    // Plate 1 = two separate caps, one inside plate 0 (north) and one inside plate 2 (south).
    const d = blankDraft(mesh, 3);
    d.plates.push({ id: 2, name: 'Split', color: plateColor(1), omega: [0, 0, 0.002] });
    d.plates.push({ id: 3, name: 'South', color: plateColor(2), omega: [0, 0.002, 0] });
    d.nextPlateId = 4;
    for (let i = 0; i < mesh.n; i++) {
      const p = cellPoint(mesh, i);
      d.plate[i] = p[2] < 0 ? 2 : 0;
      if (angleBetween(p, ll(45, 0)) < 12 * DEG || angleBetween(p, ll(-45, 90)) < 12 * DEG) d.plate[i] = 1;
    }
    const core = new EditorCore(mesh, d);
    const res = core.deletePlate(1);
    expect(res.ok).toBe(true);
    expect(core.plates.map((p) => p.id)).toEqual([1, 3]);
    expect(core.plateAt(ll(45, 0))).toBe(0);
    expect(core.plateAt(ll(-45, 90))).toBe(1);
    expect(labelComponents(mesh, core.draft.plate).label.length).toBe(2);
  });

  it('default motions stay within 30–60 km/Myr, continental plates included', () => {
    const d = capDraft(mesh, ll(0, 0), 25);
    d.crust.fill(CRUST_CONTINENTAL);
    const core = new EditorCore(mesh, d);
    for (let r = 0; r < 6; r++) {
      core.randomizeMotions();
      for (let k = 0; k < core.plates.length; k++) {
        const m = core.plateMotion(k)!;
        expect(m.speed).toBeGreaterThanOrEqual(30 - 1e-9);
        expect(m.speed).toBeLessThanOrEqual(60 + 1e-9);
      }
    }
  });

  it('revision changes with every draft change, mid-stroke and on cancel included', () => {
    const core = new EditorCore(mesh, capDraft(mesh, ll(0, 0), 20));
    const seen = [core.revision];
    const expectNew = () => {
      expect(core.draft.revision).toBe(core.revision);
      expect(seen).not.toContain(core.revision);
      seen.push(core.revision);
    };
    core.beginStroke('plate', { radius: km(600), plate: 1 });
    core.strokeTo(ll(40, 40));
    expectNew();
    expect(core.exportDraft().revision).toBe(core.revision);
    core.strokeTo(ll(40, 60));
    expectNew();
    core.cancel();
    expectNew();
    core.beginMotion(1);
    core.updateMotion(omegaFromDrag(core.anchors()[1]!, ll(0, 8), 0));
    expectNew();
    core.endMotion();
    expectNew();
  });

  it('drawn motions never exceed the simulation speed cap |ω|·R ≤ 150 km/Myr (anchor velocity kept)', () => {
    const a = ll(30, -40);
    const spinBig = 3 * DEG; // 333 km/Myr at 90° from the anchor on its own
    for (const [speed, spin] of [[150, 0.002], [100, spinBig], [0, -spinBig], [40, 0.001]] as const) {
      const w = omegaFromMotion(a, speed, 70, spin);
      expect(Math.hypot(...w) * EARTH_RADIUS_KM).toBeLessThanOrEqual(150 + 1e-9);
      const m = motionAt(w, a);
      expect(m.speed).toBeCloseTo(speed, 9);
      if (speed > 0) expect(m.bearing).toBeCloseTo(70, 9);
    }
    // Small spins are kept exactly.
    expect(motionAt(omegaFromMotion(a, 40, 10, 0.001), a).spin).toBeCloseTo(0.001, 12);
    const drag = omegaFromDrag(a, ll(30, 60), spinBig);
    expect(Math.hypot(...drag) * EARTH_RADIUS_KM).toBeLessThanOrEqual(150 + 1e-9);
  });

  it('rejects drafts with duplicate plate ids or non-finite motions', () => {
    const dup = capDraft(mesh, ll(0, 0), 20);
    dup.plates[1].id = dup.plates[0].id;
    expect(() => new EditorCore(mesh, dup)).toThrow(/duplicate plate id/);
    const bad = capDraft(mesh, ll(0, 0), 20);
    bad.plates[1].omega = [NaN, 0, 0];
    expect(() => new EditorCore(mesh, bad)).toThrow(/non-finite omega/);
    expect(() => new EditorCore(mesh, blankDraft(mesh, 1), { maxPlates: NaN })).toThrow();
  });
});
