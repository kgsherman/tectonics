/**
 * Polish 2 (app-2): hidden-tab-safe frame scheduling, first-run hint ticks that follow the real
 * action, the displayed time following the frames on screen, flow glyphs vs current particles, and
 * the paint worker's idle release of the painter's scratch memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimateCoordinator } from '../src/app/climateCoordinator';
import { displaySettings, flowGlyphs } from '../src/app/display';
import { wireStoreEffects, type EffectHost } from '../src/app/effects';
import { FrameTask, type FrameEnv } from '../src/app/frameTask';
import type { HoverController } from '../src/app/hoverController';
import { arcDegrees, dragRotated, ROTATE_TICK_DEG } from '../src/app/onboarding';
import { displayedTime, initialState, reduce, type Action, type AppState } from '../src/app/state';
import { createStore, type Store } from '../src/app/store';
import type { ViewSync } from '../src/app/viewSync';
import type { TectonicStats } from '../src/core/types';
import { DEFAULT_GENERATE_PARAMS } from '../src/tectonics/generate';
import { DEFAULT_TECTONIC_PARAMS } from '../src/tectonics/sim';
import { FramePainter } from '../src/worker/framePainter';
import { InlinePipeline } from '../src/worker/inlinePipeline';
import { KeyframeStore } from '../src/worker/keyframes';
import { PlaybackSequencer, type DisplaySettings, type FrameMessage, type SimEvent } from '../src/worker/protocol';
import { ClimateHost } from '../src/worker/climateHost';
import { SimClient, type WorkerLike } from '../src/app/simClient';
import { defaultPaintHelpers } from '../src/app/workers';
import { PlaybackPresenter } from '../src/app/playbackPresenter';
import { DEFAULT_CLIMATE_PARAMS } from '../src/climate/climate';
import { zonalClimate } from './helpers/fixtures';
import { PaintCache } from '../src/render/paint';

const STATS = { steps: 0, time: 0 } as unknown as TectonicStats;

/** Fake browser: rAF, timers and a macrotask queue driven by hand. */
function fakeEnv(opts: { hidden?: boolean; raf?: boolean } = {}) {
  let hidden = opts.hidden ?? false;
  const rafs = new Map<number, () => void>();
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const macro: Array<() => void> = [];
  let id = 0;
  const env: FrameEnv = {
    raf: opts.raf === false ? undefined : (cb) => {
      rafs.set(++id, cb);
      return id;
    },
    caf: (i) => void rafs.delete(i),
    setTimeout: (fn, ms) => {
      timers.set(++id, { fn, ms });
      return id;
    },
    clearTimeout: (i) => void timers.delete(i as number),
    macrotask: (fn) => void macro.push(fn),
    hidden: () => hidden,
  };
  return {
    env,
    rafs, timers, macro,
    setHidden: (h: boolean) => (hidden = h),
    frame: () => {
      const cbs = [...rafs.values()];
      rafs.clear();
      cbs.forEach((f) => f());
    },
    fireTimers: () => {
      const ts = [...timers.values()];
      timers.clear();
      ts.forEach((t) => t.fn());
    },
    runMacro: () => macro.splice(0).forEach((f) => f()),
  };
}

describe('FrameTask (scrub / hover coalescing that never stalls)', () => {
  it('runs once on the next animation frame when visible, coalescing repeated schedules', () => {
    const f = fakeEnv();
    let runs = 0;
    const task = new FrameTask(() => runs++, f.env);
    task.schedule();
    task.schedule();
    expect(f.rafs.size).toBe(1);
    expect(f.timers.size).toBe(1); // fallback armed
    f.frame();
    expect(runs).toBe(1);
    expect(f.timers.size).toBe(0); // fallback cancelled
    f.fireTimers();
    expect(runs).toBe(1);
    expect(task.scheduled).toBe(false);
    expect(task.rafStalled).toBe(false);
  });

  it('falls back to a timer when animation frames stop, then stops waiting for them until they resume', () => {
    const f = fakeEnv();
    let runs = 0;
    const task = new FrameTask(() => runs++, f.env, 100);
    task.schedule();
    expect([...f.timers.values()][0].ms).toBe(100);
    f.fireTimers();
    expect(runs).toBe(1);
    expect(task.rafStalled).toBe(true);
    // Visible but not painting (occluded window): the next runs go straight to a macrotask.
    task.schedule();
    expect(f.timers.size).toBe(0);
    expect(f.macro.length).toBe(1);
    f.runMacro();
    expect(runs).toBe(2);
    // The late animation frame does not run it again, and marks rAF as alive.
    f.frame();
    expect(runs).toBe(2);
    expect(task.rafStalled).toBe(false);
    task.schedule();
    expect(f.rafs.size).toBe(1);
    f.frame();
    expect(runs).toBe(3);
  });

  it('uses an unthrottled macrotask while the page is hidden (rAF is paused there)', () => {
    const f = fakeEnv({ hidden: true });
    let runs = 0;
    const task = new FrameTask(() => runs++, f.env);
    task.schedule();
    task.schedule();
    expect(f.rafs.size).toBe(0);
    expect(f.macro.length).toBe(1);
    f.runMacro();
    expect(runs).toBe(1);
    // Visible again: back to animation frames.
    f.setHidden(false);
    task.schedule();
    expect(f.rafs.size).toBe(1);
  });

  it('can be cancelled, and works without rAF at all (Node)', () => {
    const f = fakeEnv({ raf: false });
    let runs = 0;
    const task = new FrameTask(() => runs++, f.env);
    task.schedule();
    expect([...f.timers.values()][0].ms).toBe(0);
    task.cancel();
    f.fireTimers();
    expect(runs).toBe(0);
    task.schedule();
    f.fireTimers();
    expect(runs).toBe(1);
  });
});

describe('first-run hint: "Drag to rotate" ticks only when the view moved', () => {
  const deg = Math.PI / 180;
  it('measures arcs and needs a real camera move', () => {
    expect(arcDegrees({ lat: 0, lon: 0 }, { lat: 0, lon: 90 * deg })).toBeCloseTo(90, 6);
    expect(arcDegrees({ lat: 89 * deg, lon: 0 }, { lat: 89 * deg, lon: 180 * deg })).toBeCloseTo(2, 4); // across the pole
    expect(arcDegrees({ lat: 0, lon: 179.5 * deg }, { lat: 0, lon: -179.5 * deg })).toBeCloseTo(1, 4); // across the antimeridian
    const start = { lat: 10 * deg, lon: 20 * deg };
    expect(dragRotated(start, start)).toBe(false); // click / paint stroke: camera did not move
    expect(dragRotated(start, { lat: 10 * deg, lon: 20 * deg + 0.5 * deg })).toBe(false); // jitter
    expect(dragRotated(start, { lat: 10 * deg + (ROTATE_TICK_DEG + 0.1) * deg, lon: 20 * deg })).toBe(true);
    expect(dragRotated(null, start)).toBe(false); // no view
  });
});

describe('displayed time follows the frames on screen', () => {
  it('counts every live frame, ignores keyframe frames and resets with a new world', () => {
    let s: AppState = reduce(initialState(), { type: 'worldLoaded', meshN: 1000, seed: 1, time: 0, stats: STATS });
    // The sim reports a time ahead of the picture (pipelined playback).
    s = reduce(s, { type: 'status', playing: true, time: 7, steps: 7, perf: s.runtime.perf });
    expect(displayedTime(s.runtime)).toBe(7); // nothing shown yet: sim time
    s = reduce(s, { type: 'frameShown', time: 5 });
    expect(displayedTime(s.runtime)).toBe(5);
    expect(reduce(s, { type: 'frameShown', time: 5 })).toBe(s); // no-op when unchanged
    s = reduce(s, { type: 'history', keyframes: [{ time: 0, steps: 0 }, { time: 5, steps: 5 }], intervalMyr: 5, viewing: 0 });
    expect(displayedTime(s.runtime)).toBe(0); // viewing a keyframe
    s = reduce(s, { type: 'history', keyframes: [{ time: 0, steps: 0 }, { time: 5, steps: 5 }], intervalMyr: 5, viewing: null });
    expect(displayedTime(s.runtime)).toBe(5);
    s = reduce(s, { type: 'worldLoaded', meshN: 1000, seed: 2, time: 0, stats: STATS });
    expect(s.runtime.shownTime).toBeNull();
    expect(displayedTime(s.runtime)).toBe(0);
  });
});

describe('flow glyphs vs current particles', () => {
  function effects() {
    const calls: string[] = [];
    const store: Store<AppState, Action> = createStore(initialState(), reduce);
    const host: EffectHost = {
      requestPaint: (parts) => calls.push(`paint:${parts}`),
      viewSync: { viewProps: () => {}, weather: () => {}, legend: () => {} } as unknown as ViewSync,
      hover: { refresh: () => {} } as unknown as HoverController,
      climate: { request: () => {}, busy: false } as unknown as ClimateCoordinator,
      setViewKind: (k) => k,
      enterEditor: () => {},
      exitEditor: () => {},
      sendTectonicParams: () => {},
      sendSpeed: () => {},
    };
    wireStoreEffects(store, host, null);
    store.dispatch({ type: 'worldLoaded', meshN: 1000, seed: 1, time: 0, stats: STATS });
    return { store, take: () => calls.splice(0) };
  }
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('drops the currents arrows under current particles, with exactly one repaint per change', () => {
    const { store, take } = effects();
    expect(flowGlyphs(store.getState())).toBe(true);
    store.dispatch({ type: 'patchView', patch: { particles: 'currents' } });
    expect(take()).toEqual([]); // satellite layer: no glyphs to drop
    expect(displaySettings(store.getState()).flowGlyphs).toBe(true);
    store.dispatch({ type: 'patchView', patch: { layer: 'currents' } });
    expect(take()).toEqual(['paint:all']); // the layer change itself, not a second repaint
    expect(displaySettings(store.getState()).flowGlyphs).toBe(false);
    store.dispatch({ type: 'patchView', patch: { particles: 'wind' } });
    expect(take()).toEqual(['paint:all']); // arrows come back
    expect(displaySettings(store.getState()).flowGlyphs).toBe(true);
    store.dispatch({ type: 'patchView', patch: { particles: 'off' } });
    expect(take()).toEqual([]); // still drawn: nothing to repaint
  });

  it('passes the hint to the painter and always draws glyphs in exports', () => {
    const fp = new FramePainter(new PaintCache(), () => 0);
    const d: DisplaySettings = {
      layer: 'currents', month: 0, overlays: { boundaries: false, graticule: false, coastlines: false }, seaLevel: 0, detail: 1,
      fullWidth: 64, fullHeight: 32, previewWidth: 32, previewHeight: 16, flowGlyphs: false,
    };
    expect(fp.options(d, 32, 16, 'preview', 1).flowGlyphs).toBe(false);
    expect(fp.options({ ...d, flowGlyphs: undefined }, 32, 16, 'preview', 1).flowGlyphs).toBe(true);
  });
});

describe('paint worker releases the painter scratch memory when idle', () => {
  const DISPLAY: DisplaySettings = {
    layer: 'plates', month: -1, overlays: { boundaries: false, graticule: false, coastlines: false }, seaLevel: 0, detail: 1,
    fullWidth: 64, fullHeight: 32, previewWidth: 32, previewHeight: 16,
  };

  it('arms after still frames, never during playback, and a new paint restarts the countdown', () => {
    const events: SimEvent[] = [];
    const queue: Array<() => void> = [];
    const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
    let released = 0;
    const pipe = new InlinePipeline({
      post: (m) => events.push(m), schedule: (fn) => queue.push(fn), now: () => 0, keyframes: new KeyframeStore(1, 1e9),
      releaseScratch: () => {
        released++;
        return 1234;
      },
      idleReleaseMs: 5000,
      later: (fn, ms) => {
        const t = { fn, ms, live: true };
        timers.push(t);
        return () => void (t.live = false);
      },
    });
    const paint = pipe.paint;
    const flush = (): void => {
      for (let g = 0; queue.length && g < 500; g++) queue.shift()!();
    };
    const live = () => timers.filter((t) => t.live);
    const fire = (): void => live().forEach((t) => {
      t.live = false;
      t.fn();
    });

    pipe.handle({ type: 'generate', reqId: 1, epoch: 1, meshN: 1500, params: { ...DEFAULT_GENERATE_PARAMS, seed: 2, plateCount: 4 }, tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY });
    flush();
    expect(events.filter((e): e is FrameMessage => e.type === 'frame').length).toBeGreaterThan(0);
    expect(live()).toHaveLength(1);
    expect(live()[0].ms).toBe(5000);
    // Playback: painting continuously, the countdown is off.
    pipe.handle({ type: 'play', reqId: 2, epoch: 1, stepsPerFrame: 1, display: DISPLAY });
    flush();
    expect(live()).toHaveLength(0);
    pipe.handle({ type: 'pause', reqId: 3, epoch: 2, display: DISPLAY });
    flush();
    expect(live()).toHaveLength(1);
    // A repaint before the timeout restarts it.
    paint.handle({ type: 'paint', reqId: 4, epoch: 2, display: { ...DISPLAY, layer: 'crust' }, quality: 'full', parts: 'all' });
    flush();
    expect(live()).toHaveLength(1);
    expect(timers.filter((t) => !t.live).length).toBeGreaterThanOrEqual(2);
    fire();
    expect(released).toBe(1);
    expect(paint.lastReleasedBytes).toBe(1234);
    // Painting still works after the release.
    paint.handle({ type: 'paint', reqId: 5, epoch: 2, display: { ...DISPLAY, month: 3 }, quality: 'full', parts: 'all' });
    flush();
    const last = events.filter((e): e is FrameMessage => e.type === 'frame').pop()!;
    expect(last.reqId).toBe(5);
  });
});

describe('playback helper painters (paint stage on several threads)', () => {
  const DISPLAY: DisplaySettings = {
    layer: 'plates', month: -1, overlays: { boundaries: true, graticule: false, coastlines: false }, seaLevel: 0, detail: 1,
    fullWidth: 64, fullHeight: 32, previewWidth: 32, previewHeight: 16,
  };

  function pipeline(helpers: number) {
    const events: SimEvent[] = [];
    const queue: Array<() => void> = [];
    const host = new InlinePipeline({
      post: (m) => events.push(m), schedule: (fn) => queue.push(fn), now: () => 0, keyframes: new KeyframeStore(1, 1e9), helpers,
    });
    const flush = (limit = 2000): void => {
      for (let g = 0; queue.length && g < limit; g++) queue.shift()!();
    };
    const frames = (): FrameMessage[] => events.filter((e): e is FrameMessage => e.type === 'frame');
    host.handle({
      type: 'generate', reqId: 1, epoch: 1, meshN: 1500, params: { ...DEFAULT_GENERATE_PARAMS, seed: 4, plateCount: 5 },
      tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY,
    });
    flush();
    return { host, events, queue, flush, frames, clear: () => void events.splice(0) };
  }

  it('hands playback snapshots to free painters in turn; stills and replies stay with the primary', () => {
    const t = pipeline(1);
    expect(t.host.sim.painterCount).toBe(2);
    expect(t.host.painters[1].painterSlot).toBe(1);
    // World load: only the primary shows frames (the helper warms up quietly).
    expect(t.frames().length).toBeGreaterThan(0);
    expect(t.frames().every((f) => (f.painter ?? 0) === 0)).toBe(true);
    t.clear();
    t.host.handle({ type: 'play', reqId: 2, epoch: 1, stepsPerFrame: 1, display: DISPLAY });
    const shown: FrameMessage[] = [];
    const drive = (rounds: number): void => {
      // Main thread: ack each frame to the painter that sent it.
      for (let round = 0; round < rounds; round++) {
        t.flush(50);
        for (const f of t.frames().filter((x) => x.kind === 'play' && !shown.includes(x))) {
          shown.push(f);
          t.host.handle({ type: 'frameAck', reqId: 0, epoch: 1, frameId: f.frameId, painter: f.painter });
        }
      }
    };
    drive(12);
    expect(shown.length).toBeGreaterThanOrEqual(8);
    const byPainter = [0, 1].map((p) => shown.filter((f) => (f.painter ?? 0) === p).length);
    expect(Math.min(...byPainter)).toBeGreaterThan(0);
    // Every state exactly once, and show order = time order (no duplicates, no gaps).
    const ordered = [...shown].sort((a, b) => a.showSeq! - b.showSeq!);
    ordered.forEach((f, i) => expect(f.time).toBe(i + 1));
    expect(new Set(shown.map((f) => f.playFrom))).toEqual(new Set([ordered[0].showSeq]));
    // A layer change during playback: helpers get the settings, only the primary answers.
    t.clear();
    t.host.handle({ type: 'paint', reqId: 30, epoch: 1, display: { ...DISPLAY, layer: 'crust', seq: 99 }, quality: 'full', parts: 'all' });
    expect(t.events.filter((e) => e.type === 'superseded')).toEqual([{ type: 'superseded', reqId: 30 }]);
    drive(8);
    const late = t.frames().filter((f) => f.kind === 'play').slice(-2);
    expect(late.map((f) => f.layer)).toEqual(['crust', 'crust']);
    expect(new Set(late.map((f) => f.painter ?? 0)).size).toBe(2);
    // Pause: one full still, from the primary, for the live state.
    t.clear();
    t.host.handle({ type: 'pause', reqId: 40, epoch: 2, display: { ...DISPLAY, layer: 'crust', seq: 100 } });
    t.flush();
    const stills = t.frames().filter((f) => f.epoch === 2);
    expect(stills).toHaveLength(1);
    expect(stills[0]).toMatchObject({ kind: 'still', quality: 'full', painter: 0, reqId: 40 });
    const live = t.events.filter((e) => e.type === 'status').pop() as Extract<SimEvent, { type: 'status' }>;
    expect(stills[0].time).toBe(live.time);
  });

  it('a climate reaches every painter; only the primary reports it and repaints', () => {
    const t = pipeline(1);
    t.clear();
    t.host.handle({ type: 'climateInput', reqId: 50, epoch: 1, params: { ...DEFAULT_CLIMATE_PARAMS, gridW: 24, gridH: 12 } });
    t.flush();
    const rep = t.events.find((e) => e.type === 'reply' && e.reqId === 50) as { data: { sourceId: number; time: number } };
    const c = { ...zonalClimate(24, 12), id: 777, sourceSnapshotId: rep.data.sourceId, sourceTime: rep.data.time };
    t.clear();
    expect(t.host.receiveClimate(c)).toBe(true);
    t.flush();
    expect(t.events.filter((e) => e.type === 'climateApplied')).toHaveLength(1);
    const stills = t.frames();
    expect(stills.every((f) => (f.painter ?? 0) === 0)).toBe(true);
  });

  it('the main-thread sequencer shows frames in order, waits briefly for a late one and never steps back', () => {
    const sq = new PlaybackSequencer<{ epoch: number; showSeq: number; id: string; playFrom?: number }>(50);
    const f = (showSeq: number, epoch = 1) => ({ epoch, showSeq, id: epoch + ':' + showSeq });
    sq.push(f(10), 0);
    expect(sq.take(0)?.id).toBe('1:10'); // first frame of an epoch: immediately
    sq.push(f(12), 5); // 11 is still being painted elsewhere
    expect(sq.take(5)).toBeNull();
    expect(sq.waitMs(5)).toBe(50);
    sq.push(f(11), 20); // arrives in time
    expect(sq.take(20)?.id).toBe('1:11');
    expect(sq.take(20)?.id).toBe('1:12');
    sq.push(f(14), 30); // 13 is lost
    expect(sq.take(60)).toBeNull();
    expect(sq.take(81)?.id).toBe('1:14');
    expect(sq.gaps).toBe(1);
    sq.push(f(13), 90); // too late: older than what is on screen
    expect(sq.take(90)).toBeNull();
    expect(sq.dropped).toBe(1);
    expect(sq.hasShown(1)).toBe(true); // a still of epoch 1 arriving now is older than the picture
    sq.push(f(2, 2), 100); // new epoch (pause / scrub): starts afresh
    expect(sq.hasShown(2)).toBe(false);
    expect(sq.take(100)?.id).toBe('2:2');
    sq.push(f(3, 1), 110); // stale epoch
    expect(sq.size).toBe(0);
    // Knowing the playback's first frame: an overtaking second frame waits for it.
    const first = { epoch: 3, showSeq: 21, id: '3:21', playFrom: 20 };
    sq.push(first, 200);
    expect(sq.take(200)).toBeNull();
    sq.push({ epoch: 3, showSeq: 20, id: '3:20', playFrom: 20 }, 210);
    expect(sq.take(210)?.id).toBe('3:20');
    expect(sq.take(210)?.id).toBe('3:21');
  });

  it('routes acks and climate channels to the named painter; paint requests reach helpers without a reply id', () => {
    const posted: Array<[string, string, number]> = [];
    const fake = (name: string): WorkerLike => ({
      onmessage: null, onerror: null, terminate() {},
      postMessage(msg: unknown) {
        const m = msg as { type: string; reqId: number };
        posted.push([name, m.type, m.reqId]);
      },
    });
    const client = new SimClient(fake('sim'), fake('p0'), () => ({ port1: {} as MessagePort, port2: {} as MessagePort }), [fake('p1')]);
    expect(client.painterCount).toBe(2);
    expect(posted.map(([w, t]) => w + ':' + t)).toEqual(['sim:connectPaint', 'p0:connectSim', 'sim:connectPaint', 'p1:connectSim']);
    posted.length = 0;
    client.send({ type: 'frameAck', epoch: 1, frameId: 7, painter: 1 });
    client.send({ type: 'frameAck', epoch: 1, frameId: 8 });
    client.send({ type: 'connectClimate', epoch: 1, port: {} as MessagePort, painter: 1 });
    const id = client.send({ type: 'paint', epoch: 1, display: DISPLAY, quality: 'full', parts: 'all' });
    client.send({ type: 'exportImage', epoch: 1, display: DISPLAY, width: 4, height: 2 });
    expect(posted.map(([w, t]) => w + ':' + t)).toEqual(['p1:frameAck', 'p0:frameAck', 'p1:connectClimate', 'p0:paint', 'p1:paint', 'p0:exportImage']);
    expect(posted[3][2]).toBe(id);
    expect(posted[4][2]).toBe(0);
  });

  it('the climate worker delivers each result to every painter channel', () => {
    const got: string[] = [];
    const host = new ClimateHost({ post: () => {}, now: () => 0 });
    host.handle({ type: 'connect', reqId: 0, epoch: 0, port: { postMessage: () => got.push('p0') } as unknown as MessagePort });
    host.handle({ type: 'connect', reqId: 0, epoch: 0, port: { postMessage: () => got.push('p1') } as unknown as MessagePort, painter: 1 });
    const input = { w: 36, h: 18, elev: new Float32Array(36 * 18).fill(-3000), sourceId: 5, time: 0 };
    host.handle({
      type: 'compute', reqId: 1, epoch: 0, input, params: { ...DEFAULT_CLIMATE_PARAMS, gridW: 36, gridH: 18, fast: true }, purpose: 'live', warm: false,
    });
    expect(got).toEqual(['p0', 'p1']);
  });

  it('uses one helper on machines with spare cores and memory, overridable by URL', () => {
    expect(defaultPaintHelpers(8, 8)).toBe(1);
    expect(defaultPaintHelpers(4, 8)).toBe(0);
    expect(defaultPaintHelpers(12, 2)).toBe(0);
    expect(defaultPaintHelpers(undefined, undefined)).toBe(0);
    expect(defaultPaintHelpers(8, 8, '0')).toBe(0);
    expect(defaultPaintHelpers(2, 1, '2')).toBe(2);
    expect(defaultPaintHelpers(8, 8, '9')).toBe(3);
    expect(defaultPaintHelpers(8, 8, 'x')).toBe(1);
  });
});

describe('losing a helper painter is not fatal', () => {
  it('drops the slot and keeps playing on the primary', () => {
    const posted: Array<[string, string]> = [];
    const workers: Record<string, WorkerLike> = {};
    const fake = (name: string): WorkerLike => (workers[name] = {
      onmessage: null, onerror: null, terminate() {
        posted.push([name, 'terminate']);
      },
      postMessage(msg: unknown) {
        posted.push([name, (msg as { type: string }).type]);
      },
    });
    const client = new SimClient(fake('sim'), fake('p0'), () => ({ port1: {} as MessagePort, port2: {} as MessagePort }), [fake('p1')]);
    const crashes: string[] = [];
    const errors: string[] = [];
    client.onCrash((m) => crashes.push(m));
    client.on('error', (e) => errors.push(e.message));
    posted.length = 0;
    workers.p1.onerror!({ message: '', preventDefault() {} } as unknown as ErrorEvent);
    expect(crashes).toEqual([]);
    expect(client.isCrashed).toBe(false);
    expect(posted).toEqual([['p1', 'terminate'], ['sim', 'dropPainter']]);
    expect(errors[0]).toMatch(/paint helper 1.*fewer/);
    expect(client.painterCount).toBe(1);
    // The primary's failure still is.
    workers.p0.onerror!({ message: 'boom', preventDefault() {} } as unknown as ErrorEvent);
    expect(crashes).toEqual(['boom']);
  });

  it('the sim stops handing snapshots to a dropped slot', () => {
    const events: SimEvent[] = [];
    const queue: Array<() => void> = [];
    const DISPLAY: DisplaySettings = {
      layer: 'plates', month: -1, overlays: { boundaries: false, graticule: false, coastlines: false }, seaLevel: 0, detail: 1,
      fullWidth: 32, fullHeight: 16, previewWidth: 32, previewHeight: 16,
    };
    const host = new InlinePipeline({ post: (m) => events.push(m), schedule: (fn) => queue.push(fn), now: () => 0, keyframes: new KeyframeStore(1, 1e9), helpers: 1 });
    const flush = (): void => {
      for (let g = 0; queue.length && g < 2000; g++) queue.shift()!();
    };
    host.handle({ type: 'generate', reqId: 1, epoch: 1, meshN: 1200, params: { ...DEFAULT_GENERATE_PARAMS, seed: 6, plateCount: 4 }, tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY });
    flush();
    host.handle({ type: 'dropPainter', reqId: 2, epoch: 1, index: 1 });
    expect(host.sim.painterCount).toBe(1);
    events.length = 0;
    host.handle({ type: 'play', reqId: 3, epoch: 1, stepsPerFrame: 1, display: DISPLAY });
    for (let round = 0; round < 6; round++) {
      flush();
      for (const f of events.filter((e): e is FrameMessage => e.type === 'frame' && e.kind === 'play')) {
        host.handle({ type: 'frameAck', reqId: 0, epoch: 1, frameId: f.frameId, painter: f.painter });
      }
    }
    const play = events.filter((e): e is FrameMessage => e.type === 'frame' && e.kind === 'play');
    expect(play.length).toBeGreaterThan(3);
    expect(play.every((f) => (f.painter ?? 0) === 0)).toBe(true);
  });
});

describe('PlaybackPresenter (main-thread frame presentation)', () => {
  type F = { kind: 'play' | 'still'; epoch: number; showSeq?: number; id: string };
  function setup(currentEpoch = 1) {
    let now = 0;
    let epoch = currentEpoch;
    const shown: string[] = [];
    let displayFrameRequested = 0;
    const timers: Array<{ fn: () => void; at: number }> = [];
    const p = new PlaybackPresenter<F>({
      present: (f) => shown.push(f.id),
      isStale: (f) => f.epoch < epoch,
      now: () => now,
      scheduleDisplayFrame: () => void displayFrameRequested++,
      setTimer: (fn, ms) => void timers.push({ fn, at: now + ms }),
    });
    const play = (showSeq: number, e = 1): F => ({ kind: 'play', epoch: e, showSeq, id: `p${e}:${showSeq}` });
    const advance = (ms: number): void => {
      now += ms;
      const due = timers.filter((x) => x.at <= now);
      timers.splice(0, timers.length, ...timers.filter((x) => x.at > now));
      for (const t of due) t.fn();
    };
    return {
      p, shown, play, advance,
      displayFrame: () => p.onDisplayFrame(),
      setEpoch: (e: number) => (epoch = e),
      requested: () => displayFrameRequested,
      pendingTimers: () => timers.length,
    };
  }

  it('shows every frame once, in order, one per display frame', () => {
    const t = setup();
    t.p.receive(t.play(1));
    t.p.receive(t.play(2)); // arrives before the view drew #1
    t.p.receive(t.play(3));
    expect(t.shown).toEqual(['p1:1']);
    t.displayFrame();
    expect(t.shown).toEqual(['p1:1', 'p1:2']);
    t.displayFrame();
    t.displayFrame(); // nothing left: no-op
    expect(t.shown).toEqual(['p1:1', 'p1:2', 'p1:3']);
    expect(t.p.sequencer.dropped).toBe(0);
  });

  it('reorders a late frame from the other painter and never steps back', () => {
    const t = setup();
    t.p.receive(t.play(10));
    t.displayFrame();
    t.p.receive(t.play(12)); // #11 still being painted by the other painter
    expect(t.shown).toEqual(['p1:10']);
    expect(t.pendingTimers()).toBe(1);
    t.advance(20);
    t.p.receive(t.play(11));
    expect(t.shown).toEqual(['p1:10', 'p1:11']);
    t.displayFrame();
    expect(t.shown).toEqual(['p1:10', 'p1:11', 'p1:12']);
    // A lost frame: shown without it once the hold expires, and a late copy is dropped.
    t.displayFrame();
    t.p.receive(t.play(14));
    expect(t.shown).toHaveLength(3);
    t.advance(500);
    expect(t.shown).toEqual(['p1:10', 'p1:11', 'p1:12', 'p1:14']);
    t.displayFrame();
    t.p.receive(t.play(13));
    expect(t.shown).toHaveLength(4);
    expect(t.p.sequencer.dropped).toBe(1);
    expect(t.p.sequencer.gaps).toBe(1);
  });

  it('skips a still overtaken by playback frames, and drops frames buffered before a pause', () => {
    const t = setup();
    t.p.receive({ kind: 'still', epoch: 1, id: 's-before-play' }); // shown: no playback yet
    t.p.receive(t.play(5));
    t.p.receive({ kind: 'still', epoch: 1, id: 's-late' }); // painted before playback began
    expect(t.shown).toEqual(['s-before-play', 'p1:5']);
    t.p.receive(t.play(6)); // waits for the next display frame…
    t.setEpoch(2); // …but the user paused meanwhile
    t.displayFrame();
    expect(t.shown).toEqual(['s-before-play', 'p1:5']);
    t.p.receive({ kind: 'still', epoch: 2, id: 's-pause' });
    expect(t.shown).toEqual(['s-before-play', 'p1:5', 's-pause']);
    expect(t.requested()).toBeGreaterThan(0);
  });

  it('a late or lost first frame does not freeze playback (frames pile up: the wait ends)', () => {
    // The primary paints a full still when playback starts: its first playback frame (#10) comes
    // 1.5 s late while the helper delivers #11, #12, … every 45 ms. Timers may be throttled (hidden tab).
    for (const firstAt of [1500, Infinity]) {
      let now = 0;
      let displayFrame = false;
      const shown: number[] = [];
      const p = new PlaybackPresenter<{ kind: 'play'; epoch: number; showSeq: number; playFrom: number }>({
        present: (f) => shown.push(f.showSeq),
        isStale: () => false,
        now: () => now,
        scheduleDisplayFrame: () => void (displayFrame = true),
        setTimer: () => {}, // never fires
      });
      let seq = 11;
      for (now = 0; now <= 3000; now++) {
        if (now >= 60 && (now - 60) % 45 === 0) p.receive({ kind: 'play', epoch: 1, showSeq: seq++, playFrom: 10 });
        if (now === firstAt) p.receive({ kind: 'play', epoch: 1, showSeq: 10, playFrom: 10 });
        if (now % 16 === 0 && displayFrame) {
          displayFrame = false;
          p.onDisplayFrame();
        }
      }
      expect(shown.length).toBeGreaterThan(0.9 * (seq - 11));
      expect(shown.every((s, i) => i === 0 || s > shown[i - 1])).toBe(true);
      expect(p.sequencer.gaps).toBe(1);
    }
  });

  it('tunes the wait for a late frame to the frame rate', () => {
    const t = setup();
    t.p.setFrameRate(25);
    expect(t.p.sequencer.holdMs).toBe(120);
    t.p.setFrameRate(5);
    expect(t.p.sequencer.holdMs).toBe(400);
    t.p.setFrameRate(60);
    expect(t.p.sequencer.holdMs).toBe(100);
  });
});

describe('flow particles follow a flow layer', () => {
  it('switches wind ⇄ current particles with the wind / currents layers, and leaves other choices alone', () => {
    const store: Store<AppState, Action> = createStore(initialState(), reduce);
    const host = {
      requestPaint: () => {}, viewSync: { viewProps: () => {}, weather: () => {}, legend: () => {} },
      hover: { refresh: () => {} }, climate: { request: () => {}, busy: false }, setViewKind: (k: 'globe' | 'map') => k,
      enterEditor: () => {}, exitEditor: () => {}, sendTectonicParams: () => {}, sendSpeed: () => {},
    } as unknown as EffectHost;
    wireStoreEffects(store, host, null);
    const set = (patch: object): void => store.dispatch({ type: 'patchView', patch });
    const particles = (): string => store.getState().settings.view.particles;
    set({ particles: 'wind' });
    set({ layer: 'currents' });
    expect(particles()).toBe('currents');
    set({ layer: 'wind' });
    expect(particles()).toBe('wind');
    set({ layer: 'satellite' });
    expect(particles()).toBe('wind');
    set({ particles: 'off' });
    set({ layer: 'currents' });
    expect(particles()).toBe('off'); // off stays off
  });
});
