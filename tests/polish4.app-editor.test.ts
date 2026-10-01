/**
 * Polish 4 (app-editor): land % at the current sea level, fine slider values (23.44° tilt),
 * adaptive playback frames, plate-editor arrows that stay where the user set them (and show up on
 * the visible side of the globe), and the saved-world restore policy.
 */
import { describe, expect, it } from 'vitest';
import { landFractionAt } from '../src/app/landStats';
import {
  CLIMATE_SPECS, fineDigits, fineValue, parseNumberInput, SEA_LEVEL_SPEC, snapSliderValue, stepSliderValue, WORLD_SPECS,
} from '../src/app/schema';
import { sanitizeSettings } from '../src/app/settings';
import { DEFAULT_SETTINGS, initialState, reduce, shownLandFraction } from '../src/app/state';
import {
  fmtAgo, isReproducible, memoryWorldStore, startupDecision, validateSavedWorld, type SavedWorldMeta,
} from '../src/app/worldStore';
import { DEG } from '../src/core/constants';
import { angleBetween, dot3, latLonToVec } from '../src/core/math3';
import type { TectonicStats, Vec3, WorldPointerEvent } from '../src/core/types';
import { EditorCore } from '../src/editor/editorCore';
import { MotionHandles, type HandleVisibility } from '../src/editor/handles';
import type { InteractionHost, ToolSettings } from '../src/editor/interaction';
import { PointerInteraction } from '../src/editor/interaction';
import { arrowHead, motionAt, omegaFromMotion } from '../src/editor/motion';
import type { OpResult } from '../src/editor/opResult';
import { boundaryDistance, plateAnchors, plateInteriorPoints } from '../src/editor/topology';
import { blankDraft, plateColor } from '../src/tectonics/draft';
import { DEFAULT_GENERATE_PARAMS, generateRandomDraft } from '../src/tectonics/generate';
import { DEFAULT_TECTONIC_PARAMS } from '../src/tectonics/sim';
import { InlinePipeline } from '../src/worker/inlinePipeline';
import { KeyframeStore } from '../src/worker/keyframes';
import type { DisplaySettings, FrameMessage, SimEvent } from '../src/worker/protocol';
import { adaptiveStepsPerFrame, MAX_SNAPSHOT_SHARE, TARGET_FRAME_MS } from '../src/worker/simHost';
import { smallMesh } from './helpers/fixtures';

const mesh = smallMesh(12000);
const ll = (latDeg: number, lonDeg: number): Vec3 => latLonToVec(latDeg * DEG, lonDeg * DEG);

/* ------------------------------------------------------------------ */
/* 1. Land % at the sea level                                          */
/* ------------------------------------------------------------------ */

describe('land share follows the sea level', () => {
  const STATS: TectonicStats = {
    time: 0, steps: 0, lastStepMs: 0, plateCount: 12, landFraction: 0.3, continentalFraction: 0.35, meanElevation: -2000,
    maxElevation: 5000, minElevation: -8000, continentalCreated: 0, continentalDestroyed: 0, subductedCells: 0, ridgeCells: 0,
    rifts: 0, merges: 0,
  };

  it('counts cells above the given sea level', () => {
    const elev = new Float32Array([-100, 0, 50, 150, 400, -3000, 1200, 299]);
    expect(landFractionAt(elev, 0)).toBeCloseTo(5 / 8, 12);
    expect(landFractionAt(elev, 300)).toBeCloseTo(2 / 8, 12);
    expect(landFractionAt(elev, -200)).toBeCloseTo(7 / 8, 12);
    expect(landFractionAt(new Float32Array(0), 0)).toBe(0);
  });

  it('the shown land share is the sea-level one once known (else the sim stats)', () => {
    let s = initialState();
    expect(shownLandFraction(s.runtime)).toBeNull();
    s = reduce(s, { type: 'snapshot', snapshotId: 7, stats: STATS });
    expect(shownLandFraction(s.runtime)).toBe(0.3);
    s = reduce(s, { type: 'snapshot', snapshotId: 8, stats: STATS, landFraction: 0.21 });
    expect(shownLandFraction(s.runtime)).toBe(0.21);
    s = reduce(s, { type: 'landFraction', value: 0.4 });
    expect(shownLandFraction(s.runtime)).toBe(0.4);
    // A snapshot without a value keeps the last one (it is recomputed by the controller anyway).
    s = reduce(s, { type: 'snapshot', snapshotId: 9, stats: STATS });
    expect(shownLandFraction(s.runtime)).toBe(0.4);
    expect(reduce(s, { type: 'landFraction', value: 0.4 })).toBe(s);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Fine slider values                                               */
/* ------------------------------------------------------------------ */

describe('sliders reach fine values', () => {
  const tilt = CLIMATE_SPECS.axialTilt;

  it("axial tilt: dragging snaps to Earth's 23.44° nearby, else to 0.5° steps", () => {
    expect(snapSliderValue(tilt, 23.31)).toBe(23.44);
    expect(snapSliderValue(tilt, 23.7)).toBe(23.44);
    expect(snapSliderValue(tilt, 24.2)).toBe(24);
    expect(snapSliderValue(tilt, 30.13)).toBe(30);
    expect(snapSliderValue(tilt, -3)).toBe(0);
    expect(snapSliderValue(tilt, 95)).toBe(90);
  });

  it('arrow keys step through the grid and the snap values', () => {
    expect(stepSliderValue(tilt, 23, 1)).toBe(23.44);
    expect(stepSliderValue(tilt, 23.44, 1)).toBe(23.5);
    expect(stepSliderValue(tilt, 23.5, -1)).toBe(23.44);
    expect(stepSliderValue(tilt, 23.44, -1)).toBe(23);
    // Page keys move 10 steps on the coarse grid (no snap stops).
    expect(stepSliderValue(tilt, 23.44, 1, 10)).toBe(25);
    expect(stepSliderValue(tilt, 90, 1)).toBe(90);
    expect(stepSliderValue(tilt, 0, -1)).toBe(0);
    // Off-grid typed value steps onto the grid; no float noise.
    expect(stepSliderValue(WORLD_SPECS.continentalFraction, 0.355, 1)).toBe(0.36);
    expect(stepSliderValue(CLIMATE_SPECS.solarMultiplier, 1, 1)).toBe(1.005);
  });

  it('typed values keep the fine precision, clamped', () => {
    expect(fineValue(tilt, 23.44)).toBe(23.44);
    expect(fineValue(tilt, 23.4449)).toBe(23.44);
    expect(fineValue(tilt, 120)).toBe(90);
    expect(fineValue(SEA_LEVEL_SPEC, 123.4)).toBe(123);
    expect(fineValue(WORLD_SPECS.plateCount, 7.6)).toBe(8);
    expect(fineValue(CLIMATE_SPECS.globalTempOffset, 1.26)).toBe(1.3);
    expect(fineDigits(tilt)).toBe(2);
    expect(fineDigits(WORLD_SPECS.plateCount)).toBe(0);
  });

  it('parses what people type', () => {
    expect(parseNumberInput('23.44')).toBe(23.44);
    expect(parseNumberInput(' 23,44° ')).toBe(23.44);
    expect(parseNumberInput('−2,000 m')).toBe(-2000);
    expect(parseNumberInput('1,234.5')).toBe(1234.5);
    expect(parseNumberInput('50 mm/yr')).toBe(50);
    expect(parseNumberInput('.5')).toBe(0.5);
    expect(parseNumberInput('35%')).toBe(35);
    expect(parseNumberInput('')).toBeNull();
    expect(parseNumberInput('abc')).toBeNull();
    expect(parseNumberInput('-')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 3. Adaptive playback frames                                         */
/* ------------------------------------------------------------------ */

describe('adaptive playback frames', () => {
  it('fits the frame budget, bounded by the speed and by the snapshot overhead', () => {
    // 160k cells in a browser: ~55 ms steps, ~13 ms snapshots → 2 steps per frame (≈ 8 fps).
    expect(adaptiveStepsPerFrame(20, 55, 13)).toBe(2);
    // Quick steps: the speed setting is the bound.
    expect(adaptiveStepsPerFrame(5, 2, 0.5)).toBe(5);
    expect(adaptiveStepsPerFrame(20, 10, 3)).toBe(12);
    // Unknown costs → the full batch; never below one step.
    expect(adaptiveStepsPerFrame(20, 0, 0)).toBe(20);
    expect(adaptiveStepsPerFrame(20, 500, 10)).toBe(1);
    // Expensive snapshots: frames are spaced so they cost ≤ MAX_SNAPSHOT_SHARE of stepping.
    const k = adaptiveStepsPerFrame(20, 20, 30);
    expect(30 / (k * 20)).toBeLessThanOrEqual(MAX_SNAPSHOT_SHARE + 1e-9);
    expect(TARGET_FRAME_MS).toBeLessThanOrEqual(125);
  });

  const DISPLAY: DisplaySettings = {
    layer: 'plates', month: -1, overlays: { boundaries: false, graticule: false, coastlines: false }, seaLevel: 0, detail: 1,
    fullWidth: 64, fullHeight: 32, previewWidth: 48, previewHeight: 24,
  };

  /**
   * Playback with a clock where every measured interval is 40 ms (slow steps); frames acked on
   * arrival. `switchOffAfter`: after that many frames, "Smooth fast playback" is turned off.
   */
  function play(adaptive: boolean, frames: number, switchOffAfter = Infinity): number[] {
    let clock = 0;
    const queue: Array<() => void> = [];
    const times: number[] = [];
    let host: InlinePipeline;
    const post = (m: SimEvent): void => {
      if (m.type !== 'frame' || m.kind !== 'play') return;
      times.push(m.time);
      queue.push(() => host.handle({ type: 'frameAck', reqId: 0, epoch: 1, frameId: (m as FrameMessage).frameId }));
    };
    host = new InlinePipeline({
      post, schedule: (fn) => queue.push(fn), now: () => (clock += 40), keyframes: new KeyframeStore(1000, 1e9),
      adaptiveFrames: { targetMs: 125, maxSnapshotShare: 1 },
    });
    host.handle({ type: 'generate', reqId: 1, epoch: 1, meshN: 2500, params: { ...DEFAULT_GENERATE_PARAMS, seed: 3, plateCount: 5 }, tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY });
    for (let g = 0; queue.length && g < 2000; g++) queue.shift()!();
    host.handle({ type: 'play', reqId: 2, epoch: 1, stepsPerFrame: 10, display: DISPLAY, adaptiveFrames: adaptive });
    let switched = false;
    for (let g = 0; queue.length && times.length < frames && g < 20000; g++) {
      if (!switched && times.length >= switchOffAfter) {
        switched = true;
        host.handle({ type: 'setSpeed', reqId: 0, epoch: 1, stepsPerFrame: 10, adaptiveFrames: false });
      }
      queue.shift()!();
    }
    host.handle({ type: 'pause', reqId: 3, epoch: 2, display: DISPLAY });
    return times;
  }

  it('slow batches post intermediate frames; full batches only when switched off', () => {
    const full = play(false, 6);
    const adaptive = play(true, 12);
    const steps = (t: number[]) => t.slice(1).map((x, i) => x - t[i]);
    expect(full.length).toBeGreaterThanOrEqual(6);
    expect(steps(full).every((d) => d === 10)).toBe(true);
    expect(adaptive.length).toBeGreaterThanOrEqual(12);
    const d = steps(adaptive).slice(1);
    // ~2 steps per frame (40 ms steps, 125 ms budget), never more than the speed's 10.
    expect(Math.max(...d)).toBeLessThanOrEqual(10);
    expect([...d].sort((a, b) => a - b)[d.length >> 1]).toBeLessThanOrEqual(3);
    // Every step is still simulated (frames only skip showing some of them).
    expect(adaptive.every((t, i) => i === 0 || t > adaptive[i - 1])).toBe(true);
  });

  it('"Smooth fast playback" off switches a running playback to full batches', () => {
    const t = play(true, 14, 6);
    const d = t.slice(1).map((x, i) => x - t[i]);
    expect(d.slice(1, 5).every((x) => x < 10)).toBe(true);
    // After the switch (a batch in progress may finish early), full 10-step batches.
    expect(d.slice(-4).every((x) => x === 10)).toBe(true);
  });

  it('the setting is persisted and sanitized', () => {
    expect(DEFAULT_SETTINGS.smoothPlayback).toBe(true);
    const s = reduce(initialState(), { type: 'setSmoothPlayback', value: false });
    expect(s.settings.smoothPlayback).toBe(false);
    expect(reduce(s, { type: 'setSmoothPlayback', value: false })).toBe(s);
    expect(sanitizeSettings({ smoothPlayback: false }).smoothPlayback).toBe(false);
    expect(sanitizeSettings({ smoothPlayback: 'yes' }).smoothPlayback).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Motion arrows where the user set them, visible when possible     */
/* ------------------------------------------------------------------ */

/** Two plates: plate 1 is a cap of radius 40° at (0, 0). */
function capWorld() {
  const d = blankDraft(mesh, 5);
  d.plates[0].omega = omegaFromMotion(ll(0, 180), 40, 90, 0);
  d.plates.push({ id: 2, name: 'Cap', color: plateColor(1), omega: omegaFromMotion(ll(0, 0), 50, 0, 0.002) });
  d.nextPlateId = 3;
  for (let i = 0; i < mesh.n; i++) {
    const p: Vec3 = [mesh.xyz[3 * i], mesh.xyz[3 * i + 1], mesh.xyz[3 * i + 2]];
    d.plate[i] = angleBetween(p, ll(0, 0)) < 40 * DEG ? 1 : 0;
  }
  return d;
}

/** A globe looking at `center`: points within `capDeg` of it are visible. */
function capView(center: Vec3, capDeg: number): HandleVisibility {
  return { center, good: (p) => dot3(p, center) > Math.cos(capDeg * DEG) };
}

describe('interior points', () => {
  it('lie well inside their plate, spread over it', () => {
    const d = capWorld();
    const pts = plateInteriorPoints(mesh, d.plate, 2);
    const dist = boundaryDistance(mesh, d.plate);
    let maxD = 0;
    for (let i = 0; i < mesh.n; i++) if (d.plate[i] === 1) maxD = Math.max(maxD, dist[i]);
    expect(pts[1].length).toBeGreaterThan(8);
    for (const p of pts[1]) {
      expect(angleBetween(p, ll(0, 0))).toBeLessThan(40 * DEG);
      const i = new EditorCore(mesh, d).cellAt(p);
      expect(dist[i]).toBeGreaterThanOrEqual(Math.round(0.4 * maxD));
    }
    // The anchor (deepest point) agrees with the boundary distances.
    const a = plateAnchors(mesh, d.plate, 2)[1]!;
    expect(angleBetween(a, ll(0, 0))).toBeLessThan(8 * DEG);
  });
});

describe('MotionHandles', () => {
  it('uses the user point, else the anchor; hidden ones move to the visible interior point nearest the view centre', () => {
    const core = new EditorCore(mesh, capWorld());
    const h = new MotionHandles();
    const anchor = core.anchors()[1]!;
    // Looking at the anchor: arrows at the anchors.
    expect(h.layout(core, capView(anchor, 70))[1]).toBe(anchor);
    // Looking 50° east of it: the anchor is hidden (40° visible cap), a stand-in on the visible part of the cap.
    const view = capView(ll(0, 50), 40);
    const t = h.layout(core, view)[1]!;
    expect(t).not.toBe(anchor);
    expect(view.good(t)).toBe(true);
    expect(core.plateAt(t)).toBe(1);
    // Stable while it stays visible (no hopping as the globe turns a little).
    expect(h.layout(core, capView(ll(0, 47), 40))[1]).toBe(t);
    expect(h.stale(core, capView(ll(0, 47), 40))).toBe(false);
    // Back to the anchor when it is visible again.
    expect(h.stale(core, capView(anchor, 70))).toBe(true);
    expect(h.layout(core, capView(anchor, 70))[1]).toBe(anchor);
    // A pinned point wins while it is on the plate and visible.
    const pin = ll(10, 20);
    h.pin(core.plates[1].id, pin);
    expect(h.layout(core, capView(anchor, 70))[1]).toEqual(pin);
    expect(h.preferred(core, 1)).toEqual(pin);
    // No visible part of the plate: the preferred tail is kept (nothing better to show).
    expect(h.layout(core, capView(ll(0, 180), 30))[1]).toEqual(pin);
    h.clear();
    expect(h.preferred(core, 1)).toBe(anchor);
  });

  it('drops a pin that is no longer on its plate', () => {
    const core = new EditorCore(mesh, capWorld());
    const h = new MotionHandles();
    h.pin(core.plates[1].id, ll(0, 90)); // on plate 0, not on the cap
    expect(h.preferred(core, 1)).toBe(core.anchors()[1]);
    expect(h.pinned(core.plates[1].id)).toBeUndefined();
  });
});

describe('motion drags keep the arrow where the user drew it', () => {
  function setup() {
    const core = new EditorCore(mesh, capWorld());
    const handles = new MotionHandles();
    const settings: ToolSettings = {
      tool: 'motion', brushKm: 300, continentMode: 'land', raiseMode: 'raise', raiseAmount: 100, lassoTarget: 'new', seedRoughness: 0.5, style: 'plates',
    };
    const done: OpResult[] = [];
    let selected = 0;
    const host: InteractionHost = {
      core, settings, seeds: [], handles, view: () => null, selectedIndex: () => selected, select: (k) => (selected = k),
      seedsChanged: () => {}, highlight: () => {}, changed: () => handles.layout(core, null), opDone: (r) => done.push(r), motionDrag: () => {},
      setCursor: () => {}, hover: () => {},
    };
    handles.layout(core, null);
    return { core, handles, ia: new PointerInteraction(host), done };
  }
  const ev = (type: WorldPointerEvent['type'], at: [number, number], buttons: number, x: number): WorldPointerEvent => ({
    type, point: { lat: at[0] * DEG, lon: at[1] * DEG }, clientX: x, clientY: 0, buttons, shiftKey: false, altKey: false, ctrlKey: false,
  });

  it('a drawn arrow starts at the press point, sets the motion there and stays there', () => {
    const { core, handles, ia, done } = setup();
    const id = core.plates[1].id;
    const start: [number, number] = [-20, 15];
    ia.handle(ev('down', start, 1, 100));
    ia.handle(ev('move', [start[0] + 3, start[1]], 1, 130));
    ia.handle(ev('move', [start[0] + 6, start[1]], 1, 160));
    ia.handle(ev('up', [start[0] + 6, start[1]], 0, 160));
    const p = ll(start[0], start[1]);
    expect(angleBetween(handles.pinned(id)!, p)).toBeLessThan(1e-9);
    expect(angleBetween(handles.tails[1]!, p)).toBeLessThan(1e-9);
    const m = motionAt(core.plates[1].omega, p);
    expect(m.speed).toBeCloseTo(20, 0);
    expect(Math.min(m.bearing, 360 - m.bearing)).toBeLessThan(0.5);
    // The status line reports the motion where the arrow is.
    expect(done.at(-1)?.message).toMatch(/2\.0 cm\/yr → 0° N/);
    // Grabbing that arrow's head later keeps its tail.
    const head = arrowHead(p, core.plates[1].omega);
    const hl = { lat: Math.asin(head[2]) / DEG, lon: Math.atan2(head[1], head[0]) / DEG };
    ia.handle(ev('down', [hl.lat, hl.lon], 1, 200));
    ia.handle(ev('move', [hl.lat + 3, hl.lon], 1, 240));
    ia.handle(ev('up', [hl.lat + 3, hl.lon], 0, 240));
    expect(angleBetween(handles.pinned(id)!, p)).toBeLessThan(1e-9);
    expect(motionAt(core.plates[1].omega, p).speed).toBeCloseTo(30, 0);
  });

  it('Escape restores the motion and the previous arrow position', () => {
    const { core, handles, ia } = setup();
    const id = core.plates[1].id;
    const omega = core.plates[1].omega.slice();
    ia.handle(ev('down', [-10, -15], 1, 100));
    ia.handle(ev('move', [-4, -15], 1, 140));
    expect(handles.pinned(id)).toBeDefined();
    ia.cancel();
    expect(handles.pinned(id)).toBeUndefined();
    expect(core.plates[1].omega).toEqual(omega);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Saved worlds                                                      */
/* ------------------------------------------------------------------ */

describe('saved world policy', () => {
  const KEY = '[1,100000,12,0.35,"scattered",8,50,0.5]';
  const meta = (o: Partial<SavedWorldMeta> = {}): SavedWorldMeta => ({
    token: 'tab-a', savedAt: 1000, time: 120, meshN: 4000, seed: 1, steps: 120, plates: 12, paramsKey: KEY, ...o,
  });

  it('reloads restore the tab’s own world; fresh visits only offer the latest; reproducible worlds are skipped', () => {
    const base = { navigationType: 'reload', sessionToken: 'tab-a', own: meta(), latest: meta(), currentParamsKey: KEY, fresh: false };
    expect(startupDecision(base)).toEqual({ kind: 'restore', token: 'tab-a' });
    expect(startupDecision({ ...base, navigationType: 'navigate' })).toMatchObject({ kind: 'offer' });
    expect(startupDecision({ ...base, fresh: true })).toEqual({ kind: 'none' });
    // A t = 0 world of the current World-tab settings: generating gives the same world.
    const t0 = meta({ time: 0, steps: 0 });
    expect(isReproducible(t0, KEY)).toBe(true);
    expect(startupDecision({ ...base, own: t0, latest: t0 })).toEqual({ kind: 'none' });
    // …unless the settings changed since, or it was edited ('' params).
    expect(isReproducible(t0, '[2]')).toBe(false);
    expect(isReproducible(meta({ time: 0, steps: 0, paramsKey: '' }), KEY)).toBe(false);
    // Another tab's world is never auto-restored.
    expect(startupDecision({ ...base, own: meta({ token: 'tab-b' }) })).toMatchObject({ kind: 'offer' });
    expect(fmtAgo(30_000)).toBe('just now');
    expect(fmtAgo(5 * 60_000)).toBe('5 min ago');
  });

  it('stores, validates and prunes worlds', async () => {
    const m4 = smallMesh(4000);
    const draft = generateRandomDraft(m4, { ...DEFAULT_GENERATE_PARAMS, seed: 9, plateCount: 6 });
    const store = memoryWorldStore();
    for (let i = 0; i < 5; i++) await store.save({ meta: meta({ token: `t${i}`, savedAt: 100 + i, meshN: 4000 }), draft });
    expect((await store.latest())?.token).toBe('t4');
    expect(await store.load('t0')).toBeNull(); // pruned (3 kept)
    const w = await store.load('t3');
    expect(w?.draft.n).toBe(4000);
    expect(w?.draft.elev).toEqual(draft.elev);
    await store.remove('t4');
    expect((await store.latest())?.token).toBe('t3');
    // Corrupt data never reaches the simulation.
    expect(validateSavedWorld(null)).toBeNull();
    expect(validateSavedWorld({ meta: meta(), draft: { ...draft, elev: new Float32Array(3) } })).toBeNull();
    const badPlate = { ...draft, plate: draft.plate.slice() };
    badPlate.plate[5] = 99;
    expect(validateSavedWorld({ meta: meta(), draft: badPlate })).toBeNull();
    const nanElev = { ...draft, elev: draft.elev.slice() };
    nanElev.elev[3] = Number.NaN;
    expect(validateSavedWorld({ meta: meta(), draft: nanElev })).toBeNull();
    expect(validateSavedWorld({ meta: meta(), draft })?.draft).toBe(draft);
  });
});
