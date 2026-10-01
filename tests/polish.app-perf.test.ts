/**
 * Polish (app-perf): the sim ⇄ paint worker pipeline and its main-thread client.
 *  - credits: the sim runs at most one snapshot ahead of the paint worker, which takes snapshots only
 *    while fewer than two frames are unacknowledged;
 *  - unchanged height maps / overlays are not resent within an epoch (month & layer changes);
 *  - relayed display settings never override newer direct ones (DisplaySettings.seq);
 *  - exports wait for the first state; SimClient routes requests to the owning worker;
 *  - RateMeter; first-run hint persistence.
 */
import { describe, expect, it } from 'vitest';
import { overallClimateProgress } from '../src/app/climateQueue';
import { resolveLighting } from '../src/app/lighting';
import { FIRST_RUN_KEY, hintComplete, loadHintState, markHintDone, saveHintState } from '../src/app/onboarding';
import { SimClient, type WorkerLike } from '../src/app/simClient';
import { DEFAULT_SETTINGS, initialState, reduce, worldParamsKey } from '../src/app/state';
import { createStore } from '../src/app/store';
import type { RightPanel } from '../src/app/ui/rightPanel';
import type { Viewport } from '../src/app/ui/viewport';
import { ViewSync } from '../src/app/viewSync';
import { zonalClimate } from './helpers/fixtures';
import type { TectonicStats } from '../src/core/types';
import { RateMeter } from '../src/app/rateMeter';
import { DEFAULT_GENERATE_PARAMS } from '../src/tectonics/generate';
import { DEFAULT_TECTONIC_PARAMS } from '../src/tectonics/sim';
import { InlinePipeline } from '../src/worker/inlinePipeline';
import { KeyframeStore } from '../src/worker/keyframes';
import { requestTarget, type DisplaySettings, type FrameMessage, type SimEvent, type SimRequest } from '../src/worker/protocol';

const DISPLAY: DisplaySettings = {
  layer: 'plates', month: -1, overlays: { boundaries: true, graticule: false, coastlines: false }, seaLevel: 0, detail: 1,
  fullWidth: 96, fullHeight: 48, previewWidth: 48, previewHeight: 24,
};
const GEN = { ...DEFAULT_GENERATE_PARAMS, seed: 3, plateCount: 5 };

function pipeline() {
  const events: SimEvent[] = [];
  const queue: Array<() => void> = [];
  const host = new InlinePipeline({
    post: (m) => events.push(m), schedule: (fn) => queue.push(fn), now: () => performance.now(), keyframes: new KeyframeStore(1, 1e9),
  });
  const flush = (): void => {
    for (let g = 0; queue.length && g < 500; g++) queue.shift()!();
  };
  const frames = (): FrameMessage[] => events.filter((e): e is FrameMessage => e.type === 'frame');
  const lastStatus = () => events.filter((e) => e.type === 'status').pop() as Extract<SimEvent, { type: 'status' }>;
  const clear = (): void => void events.splice(0);
  const load = (): void => {
    host.handle({ type: 'generate', reqId: 1, epoch: 1, meshN: 2500, params: GEN, tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY });
    flush();
    clear();
  };
  return { host, events, flush, frames, lastStatus, clear, load };
}

describe('sim ⇄ paint pipeline', () => {
  it('keeps the sim exactly one snapshot ahead of the frames it cannot yet paint', () => {
    const t = pipeline();
    t.load();
    t.host.handle({ type: 'play', reqId: 2, epoch: 1, stepsPerFrame: 1, display: DISPLAY });
    t.flush();
    // Two frames in flight (gate), the third snapshot computed and waiting for a frame slot.
    expect(t.frames().map((f) => f.time)).toEqual([1, 2]);
    expect(t.frames().every((f) => f.kind === 'play' && f.width === 48)).toBe(true);
    const ids = t.frames().map((f) => f.frameId);
    t.clear();
    t.host.handle({ type: 'frameAck', reqId: 0, epoch: 1, frameId: ids[0] });
    t.host.handle({ type: 'frameAck', reqId: 0, epoch: 1, frameId: ids[1] });
    t.flush();
    expect(t.frames().map((f) => f.time)).toEqual([3, 4]);
    t.clear();
    t.host.handle({ type: 'pause', reqId: 3, epoch: 2, display: DISPLAY });
    t.flush();
    // The pause shows the live state: one step beyond the last playback frame.
    expect(t.lastStatus().time).toBe(5);
    expect(t.frames()).toHaveLength(1);
    expect(t.frames()[0]).toMatchObject({ kind: 'still', quality: 'full', time: 5, reqId: 3, epoch: 2 });
    // Acks for frames of the finished playback do not restart anything.
    t.clear();
    t.host.handle({ type: 'frameAck', reqId: 0, epoch: 2, frameId: ids[1] + 1 });
    t.flush();
    expect(t.frames()).toHaveLength(0);
    expect(t.lastStatus()).toBeUndefined();
  });

  it('does not resend an unchanged height map or overlay within an epoch', () => {
    const t = pipeline();
    t.host.handle({ type: 'generate', reqId: 1, epoch: 1, meshN: 2500, params: GEN, tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY });
    t.flush();
    const first = t.frames();
    expect(first.map((f) => f.quality)).toEqual(['preview', 'full']);
    expect(first.every((f) => f.heightMap !== null && f.overlayRepainted && f.overlay !== null)).toBe(true);
    const paint = (reqId: number, epoch: number, d: Partial<DisplaySettings>): FrameMessage => {
      t.clear();
      t.host.handle({ type: 'paint', reqId, epoch, display: { ...DISPLAY, ...d }, quality: 'full', parts: 'all' });
      t.flush();
      const f = t.frames();
      expect(f).toHaveLength(1);
      return f[0];
    };
    // Month and layer: new base image only.
    let f = paint(10, 1, { month: 3 });
    expect(f.rgba).not.toBeNull();
    expect(f.heightMap).toBeNull();
    expect(f.overlayRepainted).toBe(false);
    f = paint(11, 1, { month: 3, layer: 'crustAge' });
    expect(f.heightMap).toBeNull();
    expect(f.layer).toBe('crustAge');
    // Overlay flags change the overlay only.
    f = paint(12, 1, { month: 3, layer: 'crustAge', overlays: { boundaries: true, graticule: false, coastlines: true } });
    expect(f.heightMap).toBeNull();
    expect(f.overlayRepainted).toBe(true);
    expect(f.overlay).not.toBeNull();
    // Sea level changes the surface: everything is resent.
    f = paint(13, 1, { seaLevel: 200 });
    expect(f.heightMap).not.toBeNull();
    expect(f.overlayRepainted).toBe(true);
    // A new epoch (the main thread may have dropped frames): resend even when unchanged.
    f = paint(14, 2, { seaLevel: 200 });
    expect(f.heightMap).not.toBeNull();
    expect(f.epoch).toBe(2);
  });

  it('keeps the newest display settings when a relayed copy arrives late', () => {
    const t = pipeline();
    t.load();
    // Direct paint request (newer) first, then a pause whose relayed display is older.
    t.host.handle({ type: 'paint', reqId: 5, epoch: 1, display: { ...DISPLAY, layer: 'crust', seq: 10 }, quality: 'full', parts: 'all' });
    t.host.handle({ type: 'pause', reqId: 6, epoch: 2, display: { ...DISPLAY, layer: 'plates', seq: 9 } });
    t.flush();
    const f = t.frames().pop()!;
    expect(f.layer).toBe('crust');
    expect(f.epoch).toBe(2);
  });

  it('defers an export until the paint worker has a state, and replies from the paint side', () => {
    const t = pipeline();
    t.host.handle({ type: 'generate', reqId: 1, epoch: 1, meshN: 2500, params: GEN, tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY });
    t.host.handle({ type: 'exportImage', reqId: 2, epoch: 1, display: DISPLAY, width: 64, height: 32 });
    expect(t.events.some((e) => e.type === 'reply' && e.reqId === 2)).toBe(false);
    t.flush();
    const r = t.events.find((e) => e.type === 'reply' && e.reqId === 2) as { ok: boolean; data: { rgba: Uint8ClampedArray } };
    expect(r.ok).toBe(true);
    expect(r.data.rgba.length).toBe(64 * 32 * 4);
  });

  it('routes each request to the worker that owns it', () => {
    const kinds: Array<[string, SimRequest['type']]> = [];
    const fake = (name: string): WorkerLike => ({
      onmessage: null, onerror: null, terminate() {},
      postMessage(msg: unknown) {
        kinds.push([name, (msg as SimRequest).type]);
      },
    });
    const simW = fake('sim');
    const paintW = fake('paint');
    const client = new SimClient(simW, paintW, () => ({ port1: {} as MessagePort, port2: {} as MessagePort }));
    expect(kinds).toEqual([['sim', 'connectPaint'], ['paint', 'connectSim']]);
    kinds.length = 0;
    client.send({ type: 'frameAck', epoch: 1, frameId: 3 });
    client.send({ type: 'setSpeed', epoch: 1, stepsPerFrame: 2 });
    client.send({ type: 'paint', epoch: 1, display: DISPLAY, quality: 'full', parts: 'all' });
    void client.request({ type: 'getDraft', epoch: 1 });
    expect(kinds).toEqual([['paint', 'frameAck'], ['sim', 'setSpeed'], ['paint', 'paint'], ['sim', 'getDraft']]);
    for (const t of ['connectClimate', 'exportImage', 'frameAck', 'paint', 'connectSim'] as const) expect(requestTarget(t)).toBe('paint');
    for (const t of ['generate', 'play', 'pause', 'step', 'showKeyframe', 'climateInput', 'connectPaint'] as const) expect(requestTarget(t)).toBe('sim');
    // A reply from the paint worker resolves a paint-side request.
    const got: unknown[] = [];
    client.request({ type: 'exportImage', epoch: 1, display: DISPLAY, width: 2, height: 1 }).then((v) => got.push(v));
    const reqId = 3 + 3; // connectPaint 1, connectSim 2, frameAck 3, setSpeed 4, paint 5, getDraft 6 → export 7
    paintW.onmessage!({ data: { type: 'reply', reqId: reqId + 1, ok: true, data: 'img' } } as MessageEvent);
    return Promise.resolve().then(() => expect(got).toEqual(['img']));
  });
});

describe('RateMeter', () => {
  it('reports events per second over its window', () => {
    const m = new RateMeter(1000);
    expect(m.rate(0)).toBe(0);
    for (let t = 0; t <= 1000; t += 100) m.tick(t);
    expect(m.rate(1000)).toBeCloseTo(10, 5);
    // Old events leave the window.
    expect(m.rate(5000)).toBe(0);
    m.reset();
    m.tick(0);
    m.tick(50);
    expect(m.rate(50)).toBeCloseTo(20, 5);
  });
});

describe('first-run hint state', () => {
  const mem = () => {
    const data = new Map<string, string>();
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };

  it('starts fresh, ticks steps off once, completes and is remembered', () => {
    const storage = mem();
    let st = loadHintState(storage);
    expect(st).toEqual({ dismissed: false, done: [] });
    expect(hintComplete(st)).toBe(false);
    st = markHintDone(st, 'play');
    expect(markHintDone(st, 'play')).toBe(st); // idempotent
    st = markHintDone(markHintDone(st, 'plates'), 'rotate');
    expect(st.done).toEqual(['rotate', 'play', 'plates']);
    expect(hintComplete(st)).toBe(true);
    saveHintState(storage, st);
    expect(hintComplete(loadHintState(storage))).toBe(true);
    // Dismissed with nothing done also counts as complete.
    saveHintState(storage, { dismissed: true, done: [] });
    expect(hintComplete(loadHintState(storage))).toBe(true);
  });

  it('survives corrupt or unavailable storage', () => {
    const storage = mem();
    storage.setItem(FIRST_RUN_KEY, '{nope');
    expect(loadHintState(storage)).toEqual({ dismissed: false, done: [] });
    storage.setItem(FIRST_RUN_KEY, JSON.stringify({ dismissed: 'yes', done: ['play', 'bogus', 3] }));
    expect(loadHintState(storage)).toEqual({ dismissed: false, done: ['play'] });
    expect(loadHintState(null).done).toEqual([]);
    expect(saveHintState(null, { dismissed: true, done: [] })).toBe(false);
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(loadHintState(throwing).dismissed).toBe(false);
    expect(saveHintState(throwing, { dismissed: true, done: [] })).toBe(false);
  });
});

describe('app defaults & labels', () => {
  it('auto lighting keeps the flat map in daylight but lights the globe by the month', () => {
    expect(resolveLighting('auto', 'satellite', 6, 23.44, 'globe').mode).toBe('sun');
    expect(resolveLighting('auto', 'satellite', 6, 23.44, 'map')).toEqual({ mode: 'relief' });
    expect(resolveLighting('sun', 'satellite', 6, 23.44, 'map').mode).toBe('sun'); // explicit choice wins
  });

  it('remembers which World settings built the world on screen', () => {
    let s = initialState();
    const key = worldParamsKey(s.settings.world);
    const stats = { ...(s.runtime.stats ?? {}), steps: 0 } as unknown as TectonicStats;
    s = reduce(s, { type: 'worldLoaded', meshN: 100_000, seed: 1, time: 0, stats, paramsKey: key });
    expect(s.runtime.worldParams).toBe(key);
    s = reduce(s, { type: 'patchWorld', patch: { plateCount: 7 } });
    expect(worldParamsKey(s.settings.world)).not.toBe(s.runtime.worldParams);
    // Branching keeps it; an edited world clears it.
    s = reduce(s, { type: 'worldLoaded', meshN: 100_000, seed: 1, time: 5, stats });
    expect(s.runtime.worldParams).toBe(key);
    s = reduce(s, { type: 'worldLoaded', meshN: 100_000, seed: 1, time: 0, stats, paramsKey: '' });
    expect(s.runtime.worldParams).toBe('');
    expect(DEFAULT_SETTINGS.view.cloudDensity).toBe(0.4);
    expect(DEFAULT_SETTINGS.climate.live).toBe(true);
  });
});

describe('climate progress', () => {
  it('maps per-stage progress onto one monotonic bar', () => {
    const seq: Array<[string, number]> = [['input', 1], ['dynamics', 0], ['dynamics', 0.5], ['dynamics', 1], ['hydrology', 0], ['hydrology', 0.6], ['hydrology', 1], ['koppen', 0], ['done', 1]];
    const vals = seq.map(([s, f]) => overallClimateProgress(s, f));
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1]);
    expect(vals[vals.length - 1]).toBe(1);
    expect(overallClimateProgress('dynamics', 0.85)).toBeLessThan(overallClimateProgress('hydrology', 0));
    expect(overallClimateProgress('mystery', 0.4)).toBe(0.4);
    expect(overallClimateProgress('hydrology', NaN)).toBe(overallClimateProgress('hydrology', 0));
  });
});

describe('ViewSync weather', () => {
  it('rebuilds clouds and particles only when their inputs change', () => {
    const calls: string[] = [];
    const viewport = {
      setParticleCount: () => {},
      setVectorField: (f: unknown) => calls.push(f ? 'field' : 'field:null'),
      setClouds: (c: unknown) => calls.push(c ? 'clouds' : 'clouds:null'),
      onCloudsShown: () => () => {},
    } as unknown as Viewport;
    const store = createStore(initialState(), reduce);
    const climate = { ...zonalClimate(24, 12), id: 7 };
    const sync = new ViewSync(store, viewport, {} as RightPanel, { mesh: () => null, snapshot: () => null, climate: () => climate });
    sync.weather();
    expect(calls).toEqual(['field:null', 'clouds']);
    calls.length = 0;
    sync.weather(); // nothing changed
    store.dispatch({ type: 'patchView', patch: { particleCount: 4000 } });
    sync.weather();
    expect(calls).toEqual(['field:null', 'field:null']);
    calls.length = 0;
    store.dispatch({ type: 'setMonth', month: 3 });
    sync.weather();
    expect(calls).toEqual(['field:null', 'clouds']);
    calls.length = 0;
    store.dispatch({ type: 'patchView', patch: { particles: 'wind' } });
    sync.weather();
    sync.weather();
    expect(calls).toEqual(['field']);
    calls.length = 0;
    store.dispatch({ type: 'patchView', patch: { layer: 'plates' } });
    sync.weather();
    expect(calls).toEqual(['clouds:null']);
  });
});
