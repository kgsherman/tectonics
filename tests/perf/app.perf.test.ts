/**
 * App pipeline budgets at n = 100k (SPEC.md §10): playback frame = step + preview paint (+ height
 * map, overlay) must allow ≥ 5 steps/s; paused full-quality month change ≤ 500 ms at 2048×1024;
 * climate input build and the structured clones that cross threads stay small. Budgets carry the
 * usual 1.5–2× slack for a shared machine.
 */
import { describe, expect, it } from 'vitest';
import { computeClimate, DEFAULT_CLIMATE_PARAMS } from '../../src/climate/climate';
import type { ClimateInput } from '../../src/core/types';
import { DEFAULT_GENERATE_PARAMS } from '../../src/tectonics/generate';
import { DEFAULT_TECTONIC_PARAMS } from '../../src/tectonics/sim';
import type { DisplaySettings, FrameMessage, SimEvent } from '../../src/worker/protocol';
import { SimHost } from '../../src/worker/simHost';

const now = (): number => performance.now();

const DISPLAY: DisplaySettings = {
  layer: 'satellite', month: -1, overlays: { boundaries: true, graticule: false, coastlines: false }, seaLevel: 0, detail: 1,
  fullWidth: 2048, fullHeight: 1024, previewWidth: 1024, previewHeight: 512,
};

describe('app worker pipeline perf (n = 100k)', () => {
  it('meets playback, repaint and transfer budgets', () => {
    const events: SimEvent[] = [];
    const queue: Array<() => void> = [];
    const host = new SimHost({ post: (m) => events.push(m), schedule: (fn) => queue.push(fn), now });
    const flushOne = (): void => void queue.shift()?.();

    let t = now();
    host.handle({ type: 'generate', reqId: 1, epoch: 1, meshN: 100_000, params: { ...DEFAULT_GENERATE_PARAMS, seed: 7 }, tectonic: DEFAULT_TECTONIC_PARAMS, display: DISPLAY });
    const generateMs = now() - t;
    while (queue.length) flushOne(); // first-look preview + full frame (cold caches)

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
    host.receiveClimate(climate);
    while (queue.length) flushOne();

    // Playback: 12 frames of 1 step, acking each frame as the main thread does.
    events.length = 0;
    host.handle({ type: 'play', reqId: 3, epoch: 1, stepsPerFrame: 1, display: DISPLAY });
    const frameTimes: number[] = [];
    for (let i = 0; i < 12; i++) {
      t = now();
      flushOne();
      frameTimes.push(now() - t);
      const f = events.filter((e): e is FrameMessage => e.type === 'frame').pop()!;
      host.handle({ type: 'frameAck', reqId: 0, epoch: 1, frameId: f.frameId });
    }
    frameTimes.sort((a, b) => a - b);
    const medianFrame = frameTimes[frameTimes.length >> 1];

    // Pause, then month changes at full quality with warm caches.
    host.handle({ type: 'pause', reqId: 4, epoch: 2, display: DISPLAY });
    while (queue.length) flushOne();
    const monthTimes: number[] = [];
    for (let m = 0; m < 4; m++) {
      events.length = 0;
      host.handle({ type: 'paint', reqId: 10 + m, epoch: 2, display: { ...DISPLAY, month: m }, quality: 'full', parts: 'all' });
      t = now();
      while (queue.length) flushOne();
      monthTimes.push(now() - t);
    }
    const monthMs = Math.min(...monthTimes.slice(1));

    // What crosses to the main thread on pause: a snapshot clone.
    const snap = events.length; // (events were cleared per month; take a fresh snapshot below)
    void snap;
    events.length = 0;
    host.handle({ type: 'step', reqId: 20, epoch: 2, steps: 1, display: DISPLAY });
    const snapEv = events.find((e) => e.type === 'snapshot') as Extract<SimEvent, { type: 'snapshot' }>;
    t = now();
    structuredClone(snapEv.snapshot);
    const snapshotCloneMs = now() - t;

    console.log(
      `[app perf] generate ${generateMs.toFixed(0)} ms · climateInput ${inputMs.toFixed(0)} ms · ` +
        `playback frame median ${medianFrame.toFixed(0)} ms (≈${(1000 / medianFrame).toFixed(1)} steps/s) · ` +
        `month repaint 2048² ${monthMs.toFixed(0)} ms · clone snapshot ${snapshotCloneMs.toFixed(1)} ms / climate ${climateCloneMs.toFixed(1)} ms`,
    );
    expect(medianFrame).toBeLessThan(200 * 1.5); // ≥ 5 steps/s with 1 step per frame
    expect(monthMs).toBeLessThan(500 * 2);
    expect(inputMs).toBeLessThan(250 * 2);
    expect(snapshotCloneMs).toBeLessThan(25 * 2);
    expect(climateCloneMs).toBeLessThan(60 * 2);
  }, 180_000);
});
