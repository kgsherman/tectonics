/**
 * Real-thread playback pipeline at n = 100k (SPEC §10: ≥ 20 display fps): the sim worker and one
 * or two paint workers run as Node worker threads with the browser workers' code, the test thread
 * plays the main thread (acks frames on arrival like the app, replays arrivals through its
 * PlaybackSequencer). Painting a 1024×512 satellite frame is the slower stage, so a helper painter
 * (every other frame) should lift the frame rate; frames must still be shown in order, once each.
 * Timings are noisy on a shared machine: the rate check is relative (or the 20 fps target).
 */
import { MessageChannel, Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { computeClimate, DEFAULT_CLIMATE_PARAMS } from '../../src/climate/climate';
import type { ClimateInput } from '../../src/core/types';
import { DEFAULT_GENERATE_PARAMS } from '../../src/tectonics/generate';
import { DEFAULT_TECTONIC_PARAMS } from '../../src/tectonics/sim';
import { PlaybackSequencer, requestTarget, type DisplaySettings, type SimEvent, type SimRequest } from '../../src/worker/protocol';

const DISPLAY: DisplaySettings = {
  layer: 'satellite', month: -1, overlays: { boundaries: false, graticule: false, coastlines: false }, seaLevel: 0, detail: 1,
  fullWidth: 2048, fullHeight: 1024, previewWidth: 1024, previewHeight: 512,
};

interface RunResult {
  fps: number;
  shown: number;
  backwards: number;
  gaps: number;
  paintMs: number;
  simMs: number;
}

async function runPipeline(helpers: number, seconds: number): Promise<RunResult> {
  const spawn = (role: string): Worker =>
    new Worker(new URL('./app.pipelineWorker.ts', import.meta.url), { execArgv: ['--import', 'tsx'], workerData: { role } });
  const sim = spawn('sim');
  const painters = Array.from({ length: 1 + helpers }, () => spawn('paint'));
  const listeners: Array<(e: SimEvent) => void> = [];
  for (const w of [sim, ...painters]) w.on('message', (e: SimEvent) => listeners.forEach((l) => l(e)));
  let reqId = 1;
  // SimClient's routing: slot-addressed acks / channels, paint requests to every painter.
  const send = (m: Record<string, unknown>, transfer: unknown[] = []): number => {
    const id = reqId++;
    const msg = { reqId: id, ...m } as unknown as SimRequest;
    if (requestTarget(msg.type) !== 'paint') sim.postMessage(msg, transfer as never);
    else {
      const slot = msg.type === 'frameAck' || msg.type === 'connectClimate' ? msg.painter ?? 0 : msg.type === 'connectSim' ? msg.index ?? 0 : 0;
      painters[slot].postMessage(msg, transfer as never);
    }
    return id;
  };
  const until = (pred: (e: SimEvent) => boolean): Promise<SimEvent> => new Promise((res) => {
    const l = (e: SimEvent): void => {
      if (!pred(e)) return;
      listeners.splice(listeners.indexOf(l), 1);
      res(e);
    };
    listeners.push(l);
  });
  try {
    painters.forEach((_, index) => {
      const ch = new MessageChannel();
      send({ type: 'connectPaint', epoch: 0, port: ch.port1, index, reqId: 0 }, [ch.port1]);
      send({ type: 'connectSim', epoch: 0, port: ch.port2, index, reqId: 0 }, [ch.port2]);
    });
    const gid = send({ type: 'generate', epoch: 1, meshN: 100_000, params: { ...DEFAULT_GENERATE_PARAMS, seed: 1 }, tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY });
    await until((e) => e.type === 'reply' && e.reqId === gid);
    await until((e) => e.type === 'frame' && e.quality === 'full');
    // A fast live climate to every painter (as the climate worker delivers it).
    const params = { ...DEFAULT_CLIMATE_PARAMS, gridW: 180, gridH: 90, fast: true };
    const cid = send({ type: 'climateInput', epoch: 1, params });
    const rep = (await until((e) => e.type === 'reply' && e.reqId === cid)) as { data: ClimateInput };
    const climate = computeClimate(rep.data, params);
    painters.forEach((_, painter) => {
      const cc = new MessageChannel();
      send({ type: 'connectClimate', epoch: 1, port: cc.port1, painter, reqId: 0 }, [cc.port1]);
      cc.port2.postMessage({ type: 'climate', climate });
    });
    await until((e) => e.type === 'frame' && e.kind === 'still' && e.climateId === climate.id);

    const arrivals: Array<{ t: number; seq: number; time: number; paintMs: number; from?: number }> = [];
    const sim_: number[] = [];
    let acking = true;
    listeners.push((e) => {
      if (e.type === 'frame' && e.kind === 'play') {
        if (acking) send({ type: 'frameAck', epoch: 1, frameId: e.frameId, painter: e.painter, reqId: 0 });
        arrivals.push({ t: performance.now(), seq: e.showSeq ?? 0, time: e.time, paintMs: e.paintMs, from: e.playFrom });
      } else if (e.type === 'status' && e.playing) sim_.push(e.perf.lastStepMs + (e.perf.lastSnapshotMs ?? 0));
    });
    send({ type: 'play', epoch: 1, stepsPerFrame: 1, display: DISPLAY });
    await new Promise((r) => setTimeout(r, seconds * 1000));
    acking = false;
    send({ type: 'pause', epoch: 2, display: DISPLAY });
    await until((e) => e.type === 'frame' && e.kind === 'still' && e.epoch === 2);

    // What the main thread shows: arrivals through its sequencer (holds for late frames, never steps back).
    const seqr = new PlaybackSequencer<{ epoch: number; showSeq: number; time: number; playFrom?: number }>();
    const shown: number[] = [];
    const checks: number[] = [];
    let i = 0;
    while (i < arrivals.length || seqr.size) {
      const t = Math.min(i < arrivals.length ? arrivals[i].t : Infinity, ...checks, Infinity);
      if (!Number.isFinite(t)) break;
      for (let k = checks.length - 1; k >= 0; k--) if (checks[k] <= t) checks.splice(k, 1);
      while (i < arrivals.length && arrivals[i].t <= t) seqr.push({ epoch: 1, showSeq: arrivals[i].seq, time: arrivals[i].time, playFrom: arrivals[i].from }, arrivals[i++].t);
      for (let f = seqr.take(t); f; f = seqr.take(t)) shown.push(f.time);
      const w = seqr.waitMs(t);
      if (w !== null && w > 0) checks.push(t + w);
    }
    let backwards = 0, gaps = 0;
    for (let k = 1; k < shown.length; k++) {
      if (shown[k] <= shown[k - 1]) backwards++;
      else if (shown[k] - shown[k - 1] > 1 + 1e-6) gaps++;
    }
    const warm = arrivals.slice(3);
    const med = (v: number[]): number => [...v].sort((a, b) => a - b)[v.length >> 1] ?? 0;
    return {
      fps: (warm.length - 1) / ((warm[warm.length - 1].t - warm[0].t) / 1000), shown: shown.length, backwards, gaps,
      paintMs: med(warm.map((f) => f.paintMs)), simMs: med(sim_),
    };
  } finally {
    await sim.terminate();
    for (const p of painters) await p.terminate();
  }
}

describe('playback pipeline on real threads (n = 100k)', () => {
  it('a helper painter lifts the frame rate; frames stay in order, once each', async () => {
    const single = await runPipeline(0, 6);
    const helped = await runPipeline(1, 6);
    const fmt = (r: RunResult): string =>
      `${r.fps.toFixed(1)} frames/s (paint ${r.paintMs.toFixed(0)} ms, sim ${r.simMs.toFixed(0)} ms; shown ${r.shown}, backwards ${r.backwards}, gaps ${r.gaps})`;
    console.log(`[app pipeline] 1 painter: ${fmt(single)} · 2 painters: ${fmt(helped)}`);
    for (const r of [single, helped]) {
      expect(r.backwards).toBe(0);
      expect(r.gaps).toBeLessThanOrEqual(Math.ceil(0.03 * r.shown));
    }
    expect(single.gaps).toBe(0);
    // Either the target frame rate, or a clear gain over one painter (a saturated machine has no spare core).
    expect(helped.fps >= 20 || helped.fps > 1.15 * single.fps).toBe(true);
  }, 240_000);
});
