/**
 * Plate editor polish (editor-ux): strokes never change the plate list, "Simulate" keeps multi-piece
 * plates whole, motion-arrow hit testing and drag feel, straight-line split continuation, coastline
 * hygiene and the painted-continent relief.
 */
import { describe, expect, it } from 'vitest';
import { DEG, EARTH_RADIUS_KM } from '../src/core/constants';
import { angleBetween, latLonToVec } from '../src/core/math3';
import { nearestCell } from '../src/core/sphereMesh';
import type { Vec3, WorldPointerEvent } from '../src/core/types';
import { CRUST_CONTINENTAL, CRUST_OCEANIC } from '../src/core/types';
import { hygieneLimits } from '../src/editor/coastHygiene';
import { EditorCore } from '../src/editor/editorCore';
import { ARROW_RAD_PER_KM_MYR, MIN_FRAGMENT_CELLS } from '../src/editor/editorConstants';
import type { InteractionHost, MotionReadout, ToolSettings } from '../src/editor/interaction';
import { PointerInteraction, SNAP_BEARING_DEG, SNAP_SPEED_KM_MYR } from '../src/editor/interaction';
import {
  arrowHead, compassPoint, distanceToArc, dragMotion, formatMotion, hitArrow, leverHead, motionAt, omegaFromMotion, rotateFromTo,
} from '../src/editor/motion';
import type { OpResult } from '../src/editor/opResult';
import { extendCut } from '../src/editor/paths';
import { continentProfile } from '../src/editor/relief';
import { labelComponents } from '../src/editor/topology';
import { piecesBadge } from '../src/editor/ui/plateList';
import { blankDraft, plateColor } from '../src/tectonics/draft';
import { smallMesh, twoPlateDraft } from './helpers/fixtures';

const mesh = smallMesh(12000);
const ll = (latDeg: number, lonDeg: number): Vec3 => latLonToVec(latDeg * DEG, lonDeg * DEG);
const km = (x: number) => x / EARTH_RADIUS_KM;
const cellAt = (p: Vec3) => nearestCell(mesh, p[0], p[1], p[2]);

function stroke(core: EditorCore, points: Array<Vec3 | null>, tool: Parameters<EditorCore['beginStroke']>[0], opts: Parameters<EditorCore['beginStroke']>[1]) {
  core.beginStroke(tool, opts);
  for (const p of points) core.strokeTo(p);
  return core.endStroke();
}

/** Two plates: plate 1 is a cap of radius 25° at (0, 0). */
function capWorld() {
  const d = blankDraft(mesh, 5);
  d.plates[0].omega = omegaFromMotion(ll(0, 180), 40, 90, 0);
  d.plates.push({ id: 2, name: 'Cap', color: plateColor(1), omega: omegaFromMotion(ll(0, 0), 50, 0, 0) });
  d.nextPlateId = 3;
  for (let i = 0; i < mesh.n; i++) {
    const p: Vec3 = [mesh.xyz[3 * i], mesh.xyz[3 * i + 1], mesh.xyz[3 * i + 2]];
    d.plate[i] = angleBetween(p, ll(0, 0)) < 25 * DEG ? 1 : 0;
  }
  return d;
}

describe('strokes never create or remove plates', () => {
  it('an island painted with plate X stays plate X (same id, colour), and the list says "2 pieces"', () => {
    const core = new EditorCore(mesh, capWorld());
    const ids = core.plates.map((p) => p.id);
    const res = stroke(core, [ll(-40, 120), ll(-40, 135)], 'plate', { radius: km(500), plate: 1 });
    expect(res.ok).toBe(true);
    expect(res.created).toEqual([]);
    expect(core.plates.map((p) => p.id)).toEqual(ids);
    expect(core.plateAt(ll(-40, 128))).toBe(1);
    expect(core.pieces().pieces[1]).toBe(2);
    expect(core.pieces().tiny[1]).toBe(0);
    expect(piecesBadge(2, 0)?.text).toBe('2 pieces');
    expect(piecesBadge(1, 0)).toBeNull();
    expect(piecesBadge(3, 1)?.title).toMatch(/One small piece/);
  });

  it('fill and lasso into a plate keep detached pieces on that plate', () => {
    const core = new EditorCore(mesh, capWorld());
    core.addPlate();
    // Lasso a region far from the cap into the cap plate: a second piece, no new plate.
    const loop: Vec3[] = [];
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * 2 * Math.PI;
      loop.push(ll(40 + 10 * Math.sin(a), -120 + 13 * Math.cos(a)));
    }
    const res = core.lasso(loop, 1);
    expect(res.ok).toBe(true);
    expect(core.plates.length).toBe(3);
    expect(core.plateAt(ll(40, -120))).toBe(1);
    expect(core.pieces().pieces[1]).toBe(2);
    // Fill the cap's main piece with the new plate: the lassoed piece stays with the cap plate.
    expect(core.fill(ll(0, 0), 2).ok).toBe(true);
    expect(core.plateAt(ll(40, -120))).toBe(1);
    expect(core.plates.length).toBe(3);
  });

  it('stray slivers a stroke cuts off another plate are tidied into their surroundings', () => {
    const m40 = smallMesh(40000);
    const at = (p: Vec3) => nearestCell(m40, p[0], p[1], p[2]);
    const d = blankDraft(m40, 5);
    d.plates.push({ id: 2, name: 'Cap', color: plateColor(1), omega: omegaFromMotion(ll(0, 0), 50, 0, 0) });
    d.nextPlateId = 3;
    // Cap of 25° at (0, 0) with a thin neck along the equator to a small blob at (0, 34).
    for (let i = 0; i < m40.n; i++) {
      const p: Vec3 = [m40.xyz[3 * i], m40.xyz[3 * i + 1], m40.xyz[3 * i + 2]];
      const lon = Math.atan2(p[1], p[0]) / DEG, lat = Math.asin(p[2]) / DEG;
      if (angleBetween(p, ll(0, 0)) < 25 * DEG || angleBetween(p, ll(0, 34)) < 1.5 * DEG || (Math.abs(lat) < 0.6 && lon > 24 && lon < 34)) d.plate[i] = 1;
    }
    const core = new EditorCore(m40, d);
    expect(core.pieces().pieces[1]).toBe(1);
    const blob = at(ll(0, 34));
    // Cut the neck with the ocean plate's brush: the blob is left detached and small → tidied.
    const res = stroke(core, [ll(0, 28)], 'plate', { radius: km(150), plate: 0 });
    expect(res.message).toMatch(/tidied/);
    expect(core.draft.plate[blob]).toBe(0);
    expect(core.pieces().pieces[1]).toBe(1);
    expect(core.plates.length).toBe(2);
  });

  it('painting a plate over entirely leaves it in the list, empty; "Remove empty" is explicit', () => {
    const core = new EditorCore(mesh, capWorld());
    const res = stroke(core, [ll(0, 0)], 'plate', { radius: 40 * DEG, plate: 0 });
    expect(res.removed).toEqual([]);
    expect(res.message).toMatch(/Cap is now empty/);
    expect(core.plates.length).toBe(2);
    expect(core.counts()[1]).toBe(0);
    const rm = core.removeEmptyPlates();
    expect(rm.ok).toBe(true);
    expect(rm.removed).toEqual([2]);
    expect(core.plates.length).toBe(1);
    core.undo();
    expect(core.plates.length).toBe(2);
  });
});

describe('"Simulate this world" keeps the drawn plates', () => {
  it('a multi-piece plate stays one plate; tiny pieces merge; empty plates are dropped', () => {
    const core = new EditorCore(mesh, capWorld());
    stroke(core, [ll(-40, 120), ll(-40, 135)], 'plate', { radius: km(500), plate: 1 });
    // A one-cell speck of plate 1 far away.
    const speck = ll(50, -60);
    stroke(core, [speck], 'plate', { radius: 1e-9, plate: 1 });
    expect(core.pieces().pieces[1]).toBe(3);
    expect(core.pieces().tiny[1]).toBe(1);
    core.addPlate(); // empty
    const { draft: fin, mergedPieces, droppedEmpty } = core.finalizeWithReport(4);
    expect(mergedPieces).toBe(1);
    expect(droppedEmpty).toBe(1);
    expect(fin.plates.map((p) => p.id)).toEqual([1, 2]);
    expect(fin.plates[1].color).toEqual(core.plates[1].color);
    const island = cellAt(ll(-40, 128));
    expect(fin.plate[island]).toBe(1);
    expect(fin.plate[cellAt(speck)]).toBe(0);
    // Two components for plate 1 (cap + island), one for plate 0.
    const comps = labelComponents(mesh, fin.plate);
    expect(comps.label.filter((k) => k === 1).length).toBe(2);
    expect(comps.label.filter((k) => k === 0).length).toBe(1);
  });

  it('keeps every large piece on its plate even at the plate cap (no flooding into neighbours)', () => {
    // 32 plates (MAX_PLATES) and plate 0 in ten large pieces: finalizeDraft alone could not split them
    // off (cap) and would flood them into the surrounding plates.
    const core = new EditorCore(mesh, blankDraft(mesh, 3));
    const seeds: Vec3[] = [];
    for (let k = 0; k < 32; k++) {
      const z = 1 - (2 * (k + 0.5)) / 32, r = Math.sqrt(1 - z * z), a = k * 2.399963;
      seeds.push([r * Math.cos(a), r * Math.sin(a), z]);
    }
    expect(core.applySeeds(seeds, 0.2).ok).toBe(true);
    expect(core.plates.length).toBe(32);
    for (const p of [ll(0, 60), ll(0, 120), ll(0, 180), ll(0, -60), ll(0, -120), ll(45, 90), ll(-45, 90), ll(45, -90), ll(-45, -90)]) {
      stroke(core, [p], 'plate', { radius: km(750), plate: 0 });
    }
    expect(core.pieces().pieces[0]).toBeGreaterThan(5);
    expect(core.pieces().tiny[0]).toBe(0);
    const id0 = core.plates[0].id;
    const cells0 = core.counts()[0];
    const { draft: fin, mergedPieces } = core.finalizeWithReport(7);
    expect(mergedPieces).toBe(0);
    expect(fin.plates.length).toBe(32);
    const k0 = fin.plates.findIndex((p) => p.id === id0);
    let c = 0;
    for (let i = 0; i < fin.n; i++) if (fin.plate[i] === k0) c++;
    expect(c).toBe(cells0);
  });

  it('pieces of a motionless plate share one default motion', () => {
    const d = capWorld();
    d.plates[1].omega = [0, 0, 0];
    const core = new EditorCore(mesh, d);
    stroke(core, [ll(-40, 120), ll(-40, 135)], 'plate', { radius: km(500), plate: 1 });
    const fin = core.finalize(8);
    expect(fin.plates.length).toBe(2);
    const w = fin.plates[1].omega;
    expect(Math.hypot(w[0], w[1], w[2]) * EARTH_RADIUS_KM).toBeGreaterThan(20);
  });
});

describe('split continues straight to the plate edges', () => {
  it('a single stroke cuts a whole-sphere plate into two plates with their own motions', () => {
    const core = new EditorCore(mesh, blankDraft(mesh, 2), { source: 'blank' });
    const res = core.split([ll(20, -40), ll(0, -35), ll(-20, -38)]);
    expect(res.ok).toBe(true);
    expect(core.plates.length).toBe(2);
    const c = core.counts();
    expect(Math.min(c[0], c[1]) / mesh.n).toBeGreaterThan(0.2);
    for (let k = 0; k < 2; k++) expect(core.plateMotion(k)!.speed).toBeGreaterThan(20);
  });

  it('only the plates actually cut get default motions, not a still neighbour the line touches', () => {
    const d = twoPlateDraft(mesh, 'transform');
    d.plates[0].omega = [0, 0, 0]; // the southern plate stands still
    d.plates[1].omega = [0, 0, 0];
    const core = new EditorCore(mesh, d);
    // A short line in the northern plate: extended along the meridian down to the equator (one step
    // into the southern plate), it cuts only the northern plate.
    expect(core.split([ll(20, 0), ll(60, 0)]).ok).toBe(true);
    expect(core.plates.length).toBe(3);
    expect(core.plates[0].omega).toEqual([0, 0, 0]);
    expect(core.plateMotion(1)!.speed).toBeGreaterThan(20);
    expect(core.plateMotion(2)!.speed).toBeGreaterThan(20);
  });

  it('a line that already crosses the plate is not extended into the neighbouring plates', () => {
    const d = twoPlateDraft(mesh, 'transform');
    const line = [ll(-10, 20), ll(50, 20), ll(-10, 25)];
    const ext = extendCut(mesh, d.plate, line);
    expect(ext.length).toBe(line.length);
  });

  it('extends from inside the plate and stops at its edge', () => {
    const d = twoPlateDraft(mesh, 'transform');
    const ext = extendCut(mesh, d.plate, [ll(30, 0), ll(50, 0)]).filter((p): p is Vec3 => p !== null);
    expect(ext.length).toBeGreaterThan(2);
    // Both ends now lie within ~2 cells of the plate boundary (the equator for this fixture).
    const endLat = (p: Vec3) => Math.asin(p[2]) / DEG;
    const lats = [endLat(ext[0]), endLat(ext[ext.length - 1])];
    for (const la of lats) expect(Math.abs(la)).toBeLessThan(3 * mesh.spacing / DEG + 1);
  });
});

describe('motion arrows', () => {
  const anchor = ll(10, 20);
  const w = omegaFromMotion(anchor, 50, 90, 0.001);
  const head = arrowHead(anchor, w);

  it('hit test: head first, then the outer shaft; the tail third belongs to the plate', () => {
    const handles = [{ plate: 3, anchor, head }];
    const tol = 0.8 * DEG;
    expect(hitArrow(handles, rotateFromTo(anchor, anchor, head), tol)).toEqual({ plate: 3, part: 'head' });
    const mid = latLonToVec(10 * DEG, 20 * DEG + 0.6 * (15 * DEG) / Math.cos(10 * DEG));
    expect(hitArrow(handles, mid, tol)?.part).toBe('shaft');
    const nearTail = latLonToVec(10 * DEG, 20 * DEG + 0.1 * (15 * DEG) / Math.cos(10 * DEG));
    expect(hitArrow(handles, nearTail, tol)).toBeNull();
    expect(hitArrow(handles, ll(-20, 20), tol)).toBeNull();
    expect(distanceToArc(ll(0, 0), ll(0, -10), ll(0, 10))).toBeLessThan(1e-9);
    expect(distanceToArc(ll(5, 0), ll(0, -10), ll(0, 10)) / DEG).toBeCloseTo(5, 3);
    expect(distanceToArc(ll(0, 20), ll(0, -10), ll(0, 10)) / DEG).toBeCloseTo(10, 3);
  });

  it('dragging keeps the grab offset (no jump) and Shift snaps bearing and speed', () => {
    // A grab just beside the head, not moved: the motion is unchanged.
    const grab = ll(10.3, 20 + 15.2 / Math.cos(10 * DEG));
    const h0 = rotateFromTo(grab, head, grab);
    expect(angleBetween(h0, head)).toBeLessThan(1e-9);
    const m = dragMotion(anchor, head);
    expect(m.speed).toBeCloseTo(50, 6);
    expect(m.bearing).toBeCloseTo(90, 6);
    const snapped = dragMotion(anchor, ll(14, 34), SNAP_BEARING_DEG, SNAP_SPEED_KM_MYR);
    expect(snapped.bearing % SNAP_BEARING_DEG).toBeCloseTo(0, 9);
    expect(snapped.speed % SNAP_SPEED_KM_MYR).toBeCloseTo(0, 9);
    // Lever: grabbing the shaft half way and moving it to where the head was doubles the speed.
    const midShaft = latLonToVec(10 * DEG, 20 * DEG + 0.5 * (15 * DEG) / Math.cos(10 * DEG));
    const lv = leverHead(anchor, midShaft, head, head);
    expect(lv.dist / ARROW_RAD_PER_KM_MYR).toBeGreaterThan(90);
    expect(Math.abs(lv.bearing - 90)).toBeLessThan(3);
    expect(formatMotion(45, 90)).toBe('4.5 cm/yr → 90° E');
    expect(compassPoint(359)).toBe('N');
    expect(formatMotion(0, 10)).toBe('stationary');
  });
});

describe('pointer interaction (motion tool)', () => {
  function setup() {
    const core = new EditorCore(mesh, capWorld());
    const settings: ToolSettings = {
      tool: 'motion', brushKm: 300, continentMode: 'land', raiseMode: 'raise', raiseAmount: 100, lassoTarget: 'new', seedRoughness: 0.5, style: 'plates',
    };
    const done: OpResult[] = [];
    const readouts: Array<MotionReadout | null> = [];
    const cursors: Array<string | null> = [];
    let selected = 0;
    const host: InteractionHost = {
      core, settings, seeds: [], view: () => null, selectedIndex: () => selected, select: (k) => (selected = k),
      seedsChanged: () => {}, highlight: () => {}, changed: () => {}, opDone: (r) => done.push(r), motionDrag: () => {},
      setCursor: () => {}, hover: () => {}, motionReadout: (r) => readouts.push(r), pointerCursor: (c) => cursors.push(c),
    };
    return { core, ia: new PointerInteraction(host), done, readouts, cursors };
  }
  const ev = (type: WorldPointerEvent['type'], at: [number, number], buttons: number, x: number, shiftKey = false): WorldPointerEvent => ({
    type, point: { lat: at[0] * DEG, lon: at[1] * DEG }, clientX: x, clientY: 0, buttons, shiftKey, altKey: false, ctrlKey: false,
  });

  it('a click selects without touching the motion; a drag from the plate draws a new arrow', () => {
    const { core, ia, done, readouts } = setup();
    const before = core.plates[1].omega.slice();
    ia.handle(ev('down', [5, 5], 1, 100));
    ia.handle(ev('move', [5, 5.01], 1, 102)); // under the drag slop
    ia.handle(ev('up', [5, 5.01], 0, 102));
    expect(core.plates[1].omega).toEqual(before);
    expect(done.at(-1)?.message).toMatch(/drag its arrow/);
    expect(core.canUndo).toBe(false);
    // Draw mode: pressing on the plate body and dragging 6° north gives a 20 km/Myr northward arrow.
    const a = core.anchors()[1]!;
    const aLat = Math.asin(a[2]) / DEG, aLon = Math.atan2(a[1], a[0]) / DEG;
    const start: [number, number] = [aLat - 12, aLon + 3];
    ia.handle(ev('down', start, 1, 100));
    ia.handle(ev('move', [start[0] + 3, start[1]], 1, 130));
    ia.handle(ev('move', [start[0] + 6, start[1]], 1, 160, true));
    expect(readouts.at(-1)?.text).toMatch(/snapped/);
    ia.handle(ev('up', [start[0] + 6, start[1]], 0, 160));
    const m = motionAt(core.plates[1].omega, a);
    expect(m.speed).toBeCloseTo(20, 0);
    expect(Math.min(m.bearing, 360 - m.bearing)).toBeLessThan(1e-6);
    expect(readouts.at(-1)).toBeNull();
    expect(core.canUndo).toBe(true);
  });
});

describe('painted continents', () => {
  it('have a shelf ring, a coastal plain and inland relief; no pinholes or specks', () => {
    const core = new EditorCore(mesh, blankDraft(mesh, 11), { source: 'blank' });
    stroke(core, [ll(0, -30), ll(10, 0), ll(0, 30)], 'continent', { radius: km(1600) });
    const d = core.draft;
    let cont = 0, land = 0, high = 0, coast = 0, coastWet = 0;
    for (let i = 0; i < mesh.n; i++) {
      if (d.crust[i] !== CRUST_CONTINENTAL) continue;
      cont++;
      if (d.elev[i] > 0) land++;
      if (d.elev[i] > 800) high++;
      let edge = false;
      for (let e = mesh.adjOffset[i]; e < mesh.adjOffset[i + 1]; e++) if (d.crust[mesh.adj[e]] === CRUST_OCEANIC) edge = true;
      if (edge) {
        coast++;
        if (d.elev[i] < 0) coastWet++;
      }
    }
    expect(cont).toBeGreaterThan(500);
    expect(coastWet).toBe(coast); // the edge of the continental crust is always shelf
    expect(land / cont).toBeGreaterThan(0.6);
    expect(land / cont).toBeLessThan(0.95);
    expect(high).toBeGreaterThan(0); // uplands / plateaus / old belts
    // Hygiene: no enclosed ocean pinholes and no one-cell land specks around the stroke.
    const comps = labelComponents(mesh, Int16Array.from(d.crust));
    const lim = hygieneLimits(km(1600), mesh.spacing);
    comps.size.forEach((s, c) => {
      if (comps.label[c] === CRUST_OCEANIC) expect(s).toBeGreaterThan(lim.pinhole);
      else expect(s).toBeGreaterThan(2);
    });
  });

  it('profile: shelf at the outer ring, gentle coastal plain, bounded relief', () => {
    const flat = { low: 0, mid: 0, und: 0, up: 0, ridge: 0, gate: 0 };
    expect(continentProfile(70, 70, flat)).toBeLessThan(0);
    const plain = continentProfile(70 + 150, 70, flat);
    expect(plain).toBeGreaterThan(0);
    expect(plain).toBeLessThan(300);
    const inland = continentProfile(900, 70, flat);
    expect(inland).toBeGreaterThan(plain);
    const peak = continentProfile(900, 70, { low: 1, mid: 1, und: 1, up: 1, ridge: 1, gate: 1 });
    expect(peak).toBeLessThanOrEqual(3200);
    expect(continentProfile(900, 70, { ...flat, low: -1, mid: -1 })).toBeGreaterThan(-210);
    expect(MIN_FRAGMENT_CELLS).toBe(20);
  });
});
