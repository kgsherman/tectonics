/**
 * App pipeline budgets at n = 100k (SPEC.md §10). Playback is a two-stage pipeline — sim worker
 * (step + snapshot + clone to the paint worker) ∥ paint worker (preview paint + height map +
 * overlay) — so the frame period is the slower stage, not the sum: ≥ 5 steps/s needs both stages
 * ≤ 200 ms. Also: paused full-quality month change ≤ 500 ms at 2048×1024 (height map not resent),
 * climate input build and the structured clones that cross threads stay small. Budgets carry the
 * usual 1.5–2× slack for a shared machine.
 */
import { describe, expect, it } from 'vitest';
import { computeClimate, DEFAULT_CLIMATE_PARAMS } from '../../src/climate/climate';
import type { ClimateInput } from '../../src/core/types';
import { DEFAULT_GENERATE_PARAMS } from '../../src/tectonics/generate';
import { DEFAULT_TECTONIC_PARAMS } from '../../src/tectonics/sim';
import { InlinePipeline } from '../../src/worker/inlinePipeline';
import type { DisplaySettings, FrameMessage, SimEvent } from '../../src/worker/protocol';

const now = (): number => performance.now();

const DISPLAY: DisplaySettings = {
  layer: 'satellite', month: -1, overlays: { boundaries: true, graticule: false, coastlines: false }, seaLevel: 0, detail: 1,
  fullWidth: 2048, fullHeight: 1024, previewWidth: 1024, previewHeight: 512,
};

const median = (v: number[]): number => [...v].sort((a, b) => a - b)[v.length >> 1];

describe('app worker pipeline perf (n = 100k)', () => {
  it('meets playback, repaint and transfer budgets', () => {
    const events: SimEvent[] = [];
    const queue: Array<() => void> = [];
    const host = new InlinePipeline({ post: (m) => events.push(m), schedule: (fn) => queue.push(fn), now });
    const drain = (): void => {
      for (let g = 0; queue.length && g < 10_000; g++) queue.shift()!();
    };

    let t = now();
    host.handle({ type: 'generate', reqId: 1, epoch: 1, meshN: 100_000, params: { ...DEFAULT_GENERATE_PARAMS, seed: 7 }, tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY });
    const generateMs = now() - t;
    drain(); // first-look preview + full frame (cold caches)

    // Climate: input for the live grid, then a fast climate delivered to the paint worker.
    const params = { ...DEFAULT_CLIMATE_PARAMS, gridW: 360, gridH: 180 };
    t = now();
    host.handle({ type: 'climateInput', reqId: 2, epoch: 1, params });
    const inputMs = now() - t;
    const reply = events.find((e) => e.type === 'reply' && e.reqId === 2) as { data: ClimateInput };
    const climate = computeClimate(reply.data, { ...params, fast: true });
    t = now();
    const cloned = structuredClone(climate);
    const climateCloneMs = now() - t;
    expect(cloned.temp.length).toBe(climate.temp.length);
    drain(); // source registration reaches the paint worker
    expect(host.receiveClimate(climate)).toBe(true);
    drain();

    // Playback: 12 frames of 1 step, acking each frame as the main thread does.
    events.length = 0;
    host.handle({ type: 'play', reqId: 3, epoch: 1, stepsPerFrame: 1, display: DISPLAY });
    const paintMs: number[] = [];
    const simMs: number[] = [];
    for (let guard = 0; paintMs.length < 12 && guard < 1000; guard++) {
      const fn = queue.shift();
      if (!fn) break;
      fn();
      for (const e of events.splice(0)) {
        if (e.type === 'frame' && e.kind === 'play') {
          paintMs.push(e.paintMs);
          host.handle({ type: 'frameAck', reqId: 0, epoch: 1, frameId: e.frameId });
        } else if (e.type === 'status' && e.playing) {
          simMs.push(e.perf.lastStepMs + (e.perf.lastSnapshotMs ?? 0));
        }
      }
    }
    expect(paintMs.length).toBe(12);
    const paintStage = median(paintMs);
    const simStage = simMs.length ? median(simMs) : 0;

    // Pause, then month changes at full quality with warm caches.
    host.handle({ type: 'pause', reqId: 4, epoch: 2, display: DISPLAY });
    drain();
    const monthTimes: number[] = [];
    let heightResent = 0;
    for (let m = 0; m < 4; m++) {
      events.length = 0;
      host.handle({ type: 'paint', reqId: 10 + m, epoch: 2, display: { ...DISPLAY, month: m }, quality: 'full', parts: 'all' });
      t = now();
      drain();
      monthTimes.push(now() - t);
      const f = events.find((e): e is FrameMessage => e.type === 'frame')!;
      if (f.heightMap) heightResent++;
    }
    const monthMs = Math.min(...monthTimes.slice(1));

    // What crosses to the main thread on pause: a snapshot clone.
    events.length = 0;
    host.handle({ type: 'step', reqId: 20, epoch: 2, steps: 1, display: DISPLAY });
    const snapEv = events.find((e) => e.type === 'snapshot') as Extract<SimEvent, { type: 'snapshot' }>;
    t = now();
    structuredClone(snapEv.snapshot);
    const snapshotCloneMs = now() - t;
    drain();

    const period = Math.max(paintStage, simStage + snapshotCloneMs);
    console.log(
      `[app perf] generate ${generateMs.toFixed(0)} ms · climateInput ${inputMs.toFixed(0)} ms · ` +
        `playback: sim stage ${simStage.toFixed(0)} ms ∥ paint stage ${paintStage.toFixed(0)} ms → ≈${(1000 / period).toFixed(1)} frames/s ` +
        `(serial would be ${(1000 / (simStage + paintStage)).toFixed(1)}) · month repaint 2048² ${monthMs.toFixed(0)} ms ` +
        `(height map resent ${heightResent}/4) · clone snapshot ${snapshotCloneMs.toFixed(1)} ms / climate ${climateCloneMs.toFixed(1)} ms`,
    );
    expect(Math.max(paintStage, simStage)).toBeLessThan(200 * 1.5); // ≥ 5 steps/s with 1 step per frame
    expect(heightResent).toBe(0);
    expect(monthMs).toBeLessThan(500 * 2);
    expect(inputMs).toBeLessThan(250 * 2);
    expect(snapshotCloneMs).toBeLessThan(25 * 2);
    expect(climateCloneMs).toBeLessThan(60 * 2);
  }, 180_000);
});
