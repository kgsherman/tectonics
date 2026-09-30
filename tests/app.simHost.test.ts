/**
 * Sim/paint worker logic end to end in Node (small mesh): generate → paint → play with frame
 * backpressure → pause → keyframes/scrub/branch → climate input & climate delivery → coalescing,
 * transfer rules and error replies. Also the main-thread clients against in-process fake workers.
 */
import { describe, expect, it } from 'vitest';
import { CancelledError, ClimateClient, type PortPair } from '../src/app/climateClient';
import { SimClient, type WorkerLike } from '../src/app/simClient';
import { DEFAULT_CLIMATE_PARAMS } from '../src/climate/climate';
import type { ClimateInput, ClimateResult, SphereMesh, WorldDraft } from '../src/core/types';
import { DEFAULT_GENERATE_PARAMS } from '../src/tectonics/generate';
import { DEFAULT_TECTONIC_PARAMS } from '../src/tectonics/sim';
import { ClimateHost } from '../src/worker/climateHost';
import { KeyframeStore } from '../src/worker/keyframes';
import type { ClimateEvent, ClimatePortMessage, DisplaySettings, FrameMessage, SimEvent, WorldLoaded } from '../src/worker/protocol';
import { SimHost } from '../src/worker/simHost';
import { zonalClimate } from './helpers/fixtures';

const DISPLAY: DisplaySettings = {
  layer: 'plates', month: -1, overlays: { boundaries: true, graticule: false, coastlines: true }, seaLevel: 0, detail: 1,
  fullWidth: 128, fullHeight: 64, previewWidth: 64, previewHeight: 32,
};
const GEN = { ...DEFAULT_GENERATE_PARAMS, seed: 5, plateCount: 6 };

function harness() {
  const events: Array<{ msg: SimEvent; transfer: Transferable[] }> = [];
  const queue: Array<() => void> = [];
  const host = new SimHost({
    post: (msg, transfer) => events.push({ msg, transfer: transfer ?? [] }),
    schedule: (fn) => queue.push(fn),
    now: () => performance.now(),
    keyframes: new KeyframeStore(1, 1e9),
  });
  const flush = (): void => {
    for (let guard = 0; queue.length && guard < 200; guard++) queue.shift()!();
  };
  const take = <T extends SimEvent['type']>(type: T) => {
    const out = events.filter((e) => e.msg.type === type) as Array<{ msg: Extract<SimEvent, { type: T }>; transfer: Transferable[] }>;
    return out;
  };
  const reply = (reqId: number) => events.find((e) => e.msg.type === 'reply' && e.msg.reqId === reqId)?.msg as Extract<SimEvent, { type: 'reply' }> | undefined;
  const clear = (): void => void events.splice(0);
  return { host, events, queue, flush, take, reply, clear };
}

describe('SimHost', () => {
  it('generates, paints, plays with backpressure, pauses, scrubs and branches', () => {
    const t = harness();
    t.host.handle({ type: 'generate', reqId: 1, epoch: 1, meshN: 4000, params: GEN, tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY });
    const rep = t.reply(1)!;
    expect(rep.ok).toBe(true);
    const loaded = (rep as { data: WorldLoaded }).data;
    expect(loaded.meshN).toBe(4000);
    expect(loaded.time).toBe(0);
    expect(t.take('mesh')).toHaveLength(1);
    expect(t.take('snapshot')).toHaveLength(1);
    expect(t.take('snapshot')[0].transfer).toHaveLength(0); // retained by the sim → cloned, never transferred

    // First look (preview) then the full-quality frame.
    t.flush();
    const stills = t.take('frame').map((e) => e.msg as FrameMessage);
    expect(stills.map((f) => f.quality)).toEqual(['preview', 'full']);
    const full = stills[1];
    expect(full.width).toBe(128);
    expect(full.rgba!.length).toBe(128 * 64 * 4);
    expect(full.heightMap!.length).toBe(128 * 64);
    expect(full.overlay!.length).toBe(128 * 64 * 4);
    expect(full.epoch).toBe(1);
    const fullEv = t.take('frame')[1];
    expect(fullEv.transfer).toContain(full.rgba!.buffer);
    expect(fullEv.transfer).toContain(full.heightMap!.buffer);

    // Play: at most two unacknowledged frames.
    t.clear();
    t.host.handle({ type: 'play', reqId: 2, epoch: 1, stepsPerFrame: 2, display: DISPLAY });
    t.flush();
    let frames = t.take('frame').map((e) => e.msg as FrameMessage);
    expect(frames).toHaveLength(2);
    expect(frames.every((f) => f.kind === 'play' && f.quality === 'preview' && f.width === 64)).toBe(true);
    expect(frames[1].time).toBeGreaterThan(frames[0].time);
    t.host.handle({ type: 'frameAck', reqId: 0, epoch: 1, frameId: frames[0].frameId });
    t.flush();
    frames = t.take('frame').map((e) => e.msg as FrameMessage);
    expect(frames).toHaveLength(3);

    // Pause (new epoch) → full-quality still tagged with the pause request.
    t.clear();
    t.host.handle({ type: 'pause', reqId: 3, epoch: 2, display: DISPLAY });
    t.flush();
    const paused = t.take('frame').map((e) => e.msg as FrameMessage);
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({ kind: 'still', quality: 'full', reqId: 3, epoch: 2 });
    const status = t.take('status').pop()!.msg;
    expect(status.playing).toBe(false);
    expect(status.time).toBe(6);
    const hist = t.take('history').pop()!.msg;
    expect(hist.keyframes.map((k) => k.time)).toEqual([0, 2, 4, 6]);

    // Late acks after pause are harmless and do not restart playback.
    t.host.handle({ type: 'frameAck', reqId: 0, epoch: 2, frameId: frames[2].frameId });
    t.flush();
    expect(t.take('frame')).toHaveLength(1);

    // Scrub to keyframe 1, then branch from it.
    t.clear();
    t.host.handle({ type: 'showKeyframe', reqId: 4, epoch: 3, index: 1, display: DISPLAY });
    expect(t.take('snapshot')[0].msg).toMatchObject({ keyframe: 1 });
    expect(t.take('snapshot')[0].msg.snapshot.time).toBe(2);
    t.flush();
    const kfFrames = t.take('frame').map((e) => e.msg as FrameMessage);
    expect(kfFrames.every((f) => f.keyframe === 1 && f.time === 2)).toBe(true);
    t.host.handle({ type: 'playFromKeyframe', reqId: 5, epoch: 4, index: 1, display: DISPLAY });
    expect((t.reply(5) as { data: WorldLoaded }).data.time).toBe(2);
    expect(t.take('history').pop()!.msg.keyframes.map((k) => k.time)).toEqual([0, 2]);

    // Step while paused.
    t.clear();
    t.host.handle({ type: 'step', reqId: 6, epoch: 4, steps: 3, display: DISPLAY });
    expect(t.take('status').pop()!.msg.time).toBe(5);
    t.flush();
    expect(t.take('frame').pop()!.msg).toMatchObject({ reqId: 6, quality: 'full', time: 5 });
  });

  it('coalesces still paints latest-wins and supersedes paints during playback', () => {
    const t = harness();
    t.host.handle({ type: 'generate', reqId: 1, epoch: 1, meshN: 4000, params: GEN, tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY });
    t.flush();
    t.clear();
    t.host.handle({ type: 'paint', reqId: 10, epoch: 1, display: { ...DISPLAY, layer: 'elevation' }, quality: 'full', parts: 'all' });
    t.host.handle({ type: 'paint', reqId: 11, epoch: 1, display: { ...DISPLAY, layer: 'crust' }, quality: 'full', parts: 'overlay' });
    expect(t.take('superseded').map((e) => e.msg.reqId)).toEqual([10]);
    t.flush();
    const frames = t.take('frame').map((e) => e.msg as FrameMessage);
    expect(frames).toHaveLength(1);
    // Parts merge: the superseded request needed the base too.
    expect(frames[0]).toMatchObject({ reqId: 11, layer: 'crust' });
    expect(frames[0].rgba).not.toBeNull();

    // Overlay-only repaint.
    t.clear();
    t.host.handle({ type: 'paint', reqId: 12, epoch: 1, display: { ...DISPLAY, overlays: { boundaries: false, graticule: true, coastlines: false } }, quality: 'full', parts: 'overlay' });
    t.flush();
    const ov = t.take('frame')[0].msg as FrameMessage;
    expect(ov.rgba).toBeNull();
    expect(ov.overlay).toBeNull(); // graticule is drawn by the views
    expect(ov.overlayRepainted).toBe(true);

    t.clear();
    t.host.handle({ type: 'play', reqId: 13, epoch: 1, stepsPerFrame: 1, display: DISPLAY });
    t.host.handle({ type: 'paint', reqId: 14, epoch: 1, display: { ...DISPLAY, layer: 'crustAge' }, quality: 'full', parts: 'all' });
    expect(t.take('superseded').map((e) => e.msg.reqId)).toEqual([14]);
    t.flush();
    expect((t.take('frame')[0].msg as FrameMessage).layer).toBe('crustAge');
  });

  it('builds climate inputs, accepts climates for this world only and repaints with them', () => {
    const t = harness();
    t.host.handle({ type: 'generate', reqId: 1, epoch: 1, meshN: 4000, params: GEN, tectonic: DEFAULT_TECTONIC_PARAMS, display: { ...DISPLAY, layer: 'temperature' } });
    t.flush();
    const params = { ...DEFAULT_CLIMATE_PARAMS, gridW: 36, gridH: 18, fast: true };
    t.host.handle({ type: 'climateInput', reqId: 2, epoch: 1, params });
    const r = t.reply(2)!;
    expect(r.ok).toBe(true);
    const input = (r as { data: ClimateInput }).data;
    expect(input.elev.length).toBe(36 * 18);
    expect(input.sourceId).toBeGreaterThan(0);
    expect(t.events.find((e) => e.msg === r)!.transfer).toContain(input.elev.buffer);

    const base = zonalClimate(36, 18);
    t.clear();
    expect(t.host.receiveClimate({ ...base, id: 500, sourceSnapshotId: 123456789 })).toBe(false);
    expect(t.take('climateApplied')).toHaveLength(0);
    const climate: ClimateResult = { ...base, id: 501, sourceSnapshotId: input.sourceId!, sourceTime: 0 };
    expect(t.host.receiveClimate(climate)).toBe(true);
    expect(t.take('climateApplied')[0].msg).toMatchObject({ climateId: 501 });
    t.flush();
    const f = t.take('frame').pop()!.msg as FrameMessage;
    expect(f.climateId).toBe(501);
    expect(f.layer).toBe('temperature');
  });

  it('replies with errors instead of throwing, and exports images', () => {
    const t = harness();
    t.host.handle({ type: 'getDraft', reqId: 1, epoch: 0 });
    const r = t.reply(1)!;
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/no world/i);
    t.host.handle({ type: 'play', reqId: 0, epoch: 0, stepsPerFrame: 1, display: DISPLAY });
    expect(t.take('error')).toHaveLength(1);

    t.host.handle({ type: 'generate', reqId: 2, epoch: 1, meshN: 4000, params: GEN, tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY });
    t.host.handle({ type: 'getDraft', reqId: 3, epoch: 1 });
    const d = (t.reply(3) as { data: WorldDraft }).data;
    expect(d.n).toBe(4000);
    expect(t.events.find((e) => e.msg.type === 'reply' && e.msg.reqId === 3)!.transfer).toContain(d.plate.buffer);
    t.host.handle({ type: 'exportImage', reqId: 4, epoch: 1, display: { ...DISPLAY, overlays: { boundaries: false, graticule: true, coastlines: false } }, width: 96, height: 48 });
    const img = (t.reply(4) as { data: { rgba: Uint8ClampedArray; overlay: Uint8ClampedArray | null } }).data;
    expect(img.rgba.length).toBe(96 * 48 * 4);
    expect(img.overlay!.length).toBe(96 * 48 * 4);
    t.host.handle({ type: 'generate', reqId: 5, epoch: 1, meshN: 7, params: GEN, tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY });
    expect(t.reply(5)!.ok).toBe(false);
  });
});

describe('SimHost world loading', () => {
  it('loads edited drafts, rebuilds the mesh on resolution change and applies tectonic params', () => {
    const t = harness();
    t.host.handle({ type: 'generate', reqId: 1, epoch: 1, meshN: 4000, params: GEN, tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY });
    t.host.handle({ type: 'generateDraft', reqId: 2, epoch: 1, params: { ...GEN, seed: 9, plateCount: 4 } });
    const d = (t.reply(2) as { data: WorldDraft }).data;
    expect(d.plates.length).toBeGreaterThanOrEqual(3);
    t.clear();
    t.host.handle({ type: 'loadDraft', reqId: 3, epoch: 2, draft: d, tectonic: { ...DEFAULT_TECTONIC_PARAMS, dt: 2 }, display: DISPLAY });
    const loaded = (t.reply(3) as { data: WorldLoaded }).data;
    expect(loaded.seed).toBe(9);
    expect(t.take('mesh')).toHaveLength(0); // same resolution: mesh reused
    expect(t.take('history').pop()!.msg.keyframes).toHaveLength(1);
    t.host.handle({ type: 'step', reqId: 4, epoch: 2, steps: 1, display: DISPLAY });
    expect(t.take('status').pop()!.msg.time).toBe(2); // dt from the load request
    t.host.handle({ type: 'setTectonicParams', reqId: 5, epoch: 2, params: { ...DEFAULT_TECTONIC_PARAMS, dt: 0.5 } });
    t.host.handle({ type: 'step', reqId: 6, epoch: 2, steps: 2, display: DISPLAY });
    expect(t.take('status').pop()!.msg.time).toBe(3);
    t.host.handle({ type: 'setTectonicParams', reqId: 7, epoch: 2, params: { ...DEFAULT_TECTONIC_PARAMS, dt: -1 } });
    expect(t.reply(7)!.ok).toBe(false);
    // The rejected parameters were not kept: branching from history still works.
    t.host.handle({ type: 'playFromKeyframe', reqId: 71, epoch: 2, index: 0, display: DISPLAY });
    expect(t.reply(71)!.ok).toBe(true);

    t.clear();
    t.host.handle({ type: 'generate', reqId: 8, epoch: 3, meshN: 2000, params: GEN, tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY });
    expect(t.take('mesh')[0].msg.meshN).toBe(2000);
    expect((t.reply(8) as { data: WorldLoaded }).data.meshN).toBe(2000);
  });
});

/* ------------------------------------------------------------------ */
/* Main-thread clients over in-process fake workers                     */
/* ------------------------------------------------------------------ */

const later = (fn: () => void): void => void setTimeout(fn, 0);

function fakeSimWorker(): WorkerLike {
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(msg: unknown, transfer?: Transferable[]) {
      const m = structuredClone(msg, { transfer: transfer ?? [] }) as Parameters<SimHost['handle']>[0];
      later(() => host.handle(m));
    },
    terminate() {},
  };
  const host = new SimHost({
    post: (m, tr) => {
      const c = structuredClone(m, { transfer: tr ?? [] });
      later(() => worker.onmessage?.({ data: c } as MessageEvent));
    },
    schedule: later,
    now: () => performance.now(),
  });
  return worker;
}

describe('SimClient ↔ SimHost', () => {
  it('resolves typed replies, streams events and rejects failures', async () => {
    const client = new SimClient(fakeSimWorker());
    const meshes: SphereMesh[] = [];
    const frames: FrameMessage[] = [];
    client.on('mesh', (e) => meshes.push(e.mesh));
    client.on('frame', (e) => frames.push(e));
    await expect(client.request({ type: 'getDraft', epoch: 0 })).rejects.toThrow(/no world/i);
    const loaded = await client.request({ type: 'generate', epoch: 1, meshN: 4000, params: GEN, tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY });
    expect(loaded.meshN).toBe(4000);
    expect(meshes).toHaveLength(1);
    expect(meshes[0].n).toBe(4000);
    const draft = await client.request({ type: 'getDraft', epoch: 1 });
    expect(draft.plate.length).toBe(4000);
    await new Promise((r) => setTimeout(r, 50));
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(client.pendingCount).toBe(0);
    client.dispose();
    await expect(client.request({ type: 'getDraft', epoch: 1 })).rejects.toThrow(/disposed/);
  });
});

describe('ClimateClient', () => {
  function setup() {
    let spawned = 0;
    let terminated = 0;
    const simPorts: unknown[] = [];
    const portMessages: ClimatePortMessage[] = [];
    const spawn = (): WorkerLike => {
      spawned++;
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage(msg: unknown) {
          const m = msg as Parameters<ClimateHost['handle']>[0];
          later(() => host.handle(m));
        },
        terminate() {
          terminated++;
          worker.onmessage = null;
        },
      };
      const host = new ClimateHost({
        post: (m: ClimateEvent) => later(() => worker.onmessage?.({ data: m } as MessageEvent)),
        now: () => performance.now(),
      });
      return worker;
    };
    const channel = (): PortPair => {
      const port1 = { postMessage: (m: ClimatePortMessage) => portMessages.push(m) } as unknown as MessagePort;
      return { port1, port2: {} as MessagePort };
    };
    const client = new ClimateClient(spawn, (p) => simPorts.push(p), channel);
    return { client, stats: () => ({ spawned, terminated, simPorts: simPorts.length, portMessages }) };
  }

  const input = (): ClimateInput => {
    const w = 36, h = 18;
    const elev = new Float32Array(w * h).fill(-3000);
    for (let r = 5; r < 12; r++) for (let c = 10; c < 16; c++) elev[r * w + c] = 400;
    return { w, h, elev, sourceId: 7, time: 3 };
  };
  const params = { ...DEFAULT_CLIMATE_PARAMS, gridW: 36, gridH: 18, fast: true };

  it('computes, reports progress, delivers to the sim port', async () => {
    const { client, stats } = setup();
    const stages: string[] = [];
    const out = await client.compute(input(), params, 'full', false, (s) => stages.push(s));
    expect(out.climate.w).toBe(36);
    expect(out.climate.sourceSnapshotId).toBe(7);
    expect(stages.length).toBeGreaterThan(0);
    expect(stats().portMessages).toHaveLength(1);
    expect(stats().portMessages[0].climate.id).toBe(out.climate.id);
    await expect(client.compute(input(), { ...params, axialTilt: 400 }, 'full', true)).rejects.toThrow(/axialTilt/);
    expect(client.busy).toBe(false);
  });

  it('cancel terminates, respawns and reconnects the sim port', async () => {
    const { client, stats } = setup();
    const p = client.compute(input(), params, 'live', true);
    expect(client.cancel()).toBe(true);
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    expect(stats()).toMatchObject({ spawned: 2, terminated: 1, simPorts: 2 });
    expect(client.cancel()).toBe(false);
    const ok = await client.compute(input(), params, 'live', true);
    expect(ok.climate.h).toBe(18);
    client.dispose();
    await expect(client.compute(input(), params, 'live', true)).rejects.toThrow(/disposed/);
  });
});

describe('SimHost review regressions', () => {
  it('announces the live state as soon as playback starts from a keyframe', () => {
    const t = harness();
    t.host.handle({ type: 'generate', reqId: 1, epoch: 1, meshN: 3000, params: GEN, tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY });
    t.host.handle({ type: 'step', reqId: 2, epoch: 1, steps: 3, display: DISPLAY });
    t.flush();
    t.host.handle({ type: 'showKeyframe', reqId: 3, epoch: 2, index: 0, display: DISPLAY });
    t.flush();
    t.clear();
    // Within the 250 ms push throttle of the scrub: the main thread must still learn viewing = null.
    t.host.handle({ type: 'play', reqId: 4, epoch: 2, stepsPerFrame: 1, display: DISPLAY });
    const hist = t.take('history').map((e) => e.msg);
    expect(hist.length).toBeGreaterThanOrEqual(1);
    expect(hist[0].viewing).toBeNull();
    expect(t.take('snapshot')[0].msg.keyframe).toBeNull();
  });

  it('branching keeps plate ids unique and ignores climates from the discarded future', () => {
    const t = harness();
    t.host.handle({ type: 'generate', reqId: 1, epoch: 1, meshN: 3000, params: { ...GEN, plateCount: 8 }, tectonic: { ...DEFAULT_TECTONIC_PARAMS, riftRate: 60 }, display: DISPLAY });
    t.flush();
    const params = { ...DEFAULT_CLIMATE_PARAMS, gridW: 24, gridH: 12, fast: true };
    // Climate input at t = 0 (kept keyframe) …
    t.host.handle({ type: 'climateInput', reqId: 2, epoch: 1, params });
    const early = (t.reply(2) as { data: ClimateInput }).data;
    t.host.handle({ type: 'step', reqId: 3, epoch: 1, steps: 25, display: DISPLAY });
    t.flush();
    // … and at t = 25 (after the branch point below).
    t.host.handle({ type: 'climateInput', reqId: 4, epoch: 1, params });
    const late = (t.reply(4) as { data: ClimateInput }).data;
    t.host.handle({ type: 'getDraft', reqId: 5, epoch: 1 });
    const before = (t.reply(5) as { data: WorldDraft }).data;
    expect(before.nextPlateId).toBeGreaterThan(Math.max(...before.plates.map((p) => p.id)));

    t.host.handle({ type: 'playFromKeyframe', reqId: 6, epoch: 2, index: 0, display: DISPLAY });
    expect(t.reply(6)!.ok).toBe(true);
    t.host.handle({ type: 'getDraft', reqId: 7, epoch: 2 });
    const after = (t.reply(7) as { data: WorldDraft }).data;
    expect(after.time).toBe(0);
    expect(after.nextPlateId).toBeGreaterThanOrEqual(before.nextPlateId);

    const base = zonalClimate(24, 12);
    expect(t.host.receiveClimate({ ...base, id: 900, sourceSnapshotId: late.sourceId!, sourceTime: late.time ?? 25 })).toBe(false);
    expect(t.host.receiveClimate({ ...base, id: 901, sourceSnapshotId: early.sourceId!, sourceTime: 0 })).toBe(true);
  });

  it('"Play from here" resumes the exact sim state, not the display snapshot (no baked trenches)', () => {
    const t = harness();
    t.host.handle({ type: 'generate', reqId: 1, epoch: 1, meshN: 3000, params: GEN, tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY });
    t.host.handle({ type: 'step', reqId: 2, epoch: 1, steps: 12, display: DISPLAY });
    t.flush();
    t.host.handle({ type: 'getDraft', reqId: 3, epoch: 1 });
    const atKeyframe = (t.reply(3) as { data: WorldDraft }).data;
    const kfIndex = t.take('history').pop()!.msg.keyframes.findIndex((k) => k.time === atKeyframe.time);
    expect(kfIndex).toBeGreaterThan(0);
    t.host.handle({ type: 'step', reqId: 4, epoch: 1, steps: 5, display: DISPLAY });
    t.flush();
    t.host.handle({ type: 'playFromKeyframe', reqId: 5, epoch: 2, index: kfIndex, display: DISPLAY });
    expect(t.reply(5)!.ok).toBe(true);
    t.host.handle({ type: 'getDraft', reqId: 6, epoch: 2 });
    const resumed = (t.reply(6) as { data: WorldDraft }).data;
    expect(resumed.time).toBe(atKeyframe.time);
    expect(resumed.stepIndex).toBe(atKeyframe.stepIndex);
    expect(Array.from(resumed.plate)).toEqual(Array.from(atKeyframe.plate));
    expect(Array.from(resumed.crust)).toEqual(Array.from(atKeyframe.crust));
    expect(Array.from(resumed.elev)).toEqual(Array.from(atKeyframe.elev));
  });

  it('a rejected draft leaves the running world and its seed untouched', () => {
    const t = harness();
    t.host.handle({ type: 'generate', reqId: 1, epoch: 1, meshN: 3000, params: GEN, tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY });
    t.flush();
    t.host.handle({ type: 'getDraft', reqId: 2, epoch: 1 });
    const good = (t.reply(2) as { data: WorldDraft }).data;
    const bad: WorldDraft = { ...good, seed: 4242, plate: new Int16Array(good.n).fill(99) };
    t.host.handle({ type: 'loadDraft', reqId: 3, epoch: 2, draft: bad, tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY });
    expect(t.reply(3)!.ok).toBe(false);
    t.host.handle({ type: 'getDraft', reqId: 4, epoch: 2 });
    expect((t.reply(4) as { data: WorldDraft }).data.seed).toBe(good.seed);
  });
});

describe('SimClient failed fire-and-forget replies', () => {
  it('surfaces them as error events carrying the reqId', () => {
    let onmessage: ((e: MessageEvent) => void) | null = null;
    const worker: WorkerLike = {
      get onmessage() {
        return onmessage;
      },
      set onmessage(h) {
        onmessage = h;
      },
      onerror: null,
      postMessage() {},
      terminate() {},
    };
    const client = new SimClient(worker);
    const errors: Array<{ reqId: number; message: string }> = [];
    client.on('error', (e) => errors.push({ reqId: e.reqId, message: e.message }));
    const id = client.send({ type: 'setSpeed', epoch: 1, stepsPerFrame: 2 });
    onmessage!({ data: { type: 'reply', reqId: id, ok: false, error: 'boom' } } as MessageEvent);
    onmessage!({ data: { type: 'reply', reqId: id + 100, ok: true, data: null } } as MessageEvent);
    expect(errors).toEqual([{ reqId: id, message: 'boom' }]);
  });
});
