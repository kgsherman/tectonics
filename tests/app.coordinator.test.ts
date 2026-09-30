/** ClimateCoordinator against fake sim/climate clients: preemption, chaining and history branching. */
import { describe, expect, it } from 'vitest';
import { CancelledError, type ClimateClient, type ClimateOutcome } from '../src/app/climateClient';
import { ClimateCoordinator } from '../src/app/climateCoordinator';
import type { SimClient } from '../src/app/simClient';
import { initialState, reduce, type Action, type AppState } from '../src/app/state';
import { createStore } from '../src/app/store';
import type { ClimateInput, ClimateParams, ClimateResult } from '../src/core/types';
import { zonalClimate } from './helpers/fixtures';

const stats = {
  time: 0, steps: 0, lastStepMs: 0, plateCount: 12, landFraction: 0.3, continentalFraction: 0.35, meanElevation: -2000,
  maxElevation: 5000, minElevation: -9000, continentalCreated: 0, continentalDestroyed: 0, subductedCells: 0, ridgeCells: 0,
  rifts: 0, merges: 0,
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function setup() {
  const store = createStore<AppState, Action>(initialState(), reduce);
  store.dispatch({ type: 'worldLoaded', meshN: 4000, seed: 1, time: 0, stats });
  let nextId = 1;
  const jobs: Array<{ params: ClimateParams; resolve: (o: ClimateOutcome) => void; reject: (e: Error) => void; cancelled: boolean }> = [];
  let running: (typeof jobs)[number] | null = null;
  const sim = {
    request: async () => ({ w: 4, h: 2, elev: new Float32Array(8), sourceId: 1, time: 0 }) as ClimateInput,
  } as unknown as SimClient;
  const climate = {
    compute: (_input: ClimateInput, params: ClimateParams) =>
      new Promise<ClimateOutcome>((resolve, reject) => {
        const j = { params, resolve, reject, cancelled: false };
        jobs.push(j);
        running = j;
      }),
    cancel: () => {
      if (!running) return false;
      running.cancelled = true;
      running.reject(new CancelledError());
      running = null;
      return true;
    },
  } as unknown as ClimateClient;
  const applied: ClimateResult[] = [];
  const coord = new ClimateCoordinator({
    store, sim, climate, epoch: () => 1, onError: () => {},
    // As the App does: record the result in the store.
    onResult: (c, ms) => {
      applied.push(c);
      store.dispatch({ type: 'climateDone', id: c.id, sourceTime: c.sourceTime, sourceSnapshotId: c.sourceSnapshotId, fast: c.params.fast, ms, stats: c.stats });
    },
  });
  const finish = (j: (typeof jobs)[number]): void => {
    if (running === j) running = null;
    const c = zonalClimate(j.params.gridW, j.params.gridH);
    j.resolve({ climate: { ...c, id: nextId++, params: j.params }, ms: 1 });
  };
  return { store, coord, jobs, applied, finish };
}

describe('ClimateCoordinator', () => {
  it('refine runs fast then full; a preempting request cancels the running job', async () => {
    const t = setup();
    t.coord.request('refine', true);
    await tick();
    expect(t.jobs).toHaveLength(1);
    expect(t.jobs[0].params.fast).toBe(true);
    t.finish(t.jobs[0]);
    await tick();
    expect(t.applied).toHaveLength(1);
    expect(t.jobs).toHaveLength(2);
    expect(t.jobs[1].params.fast).toBe(false);
    t.coord.request('full', true);
    expect(t.jobs[1].cancelled).toBe(true);
    await tick();
    expect(t.jobs).toHaveLength(3);
    t.finish(t.jobs[2]);
    await tick();
    expect(t.applied).toHaveLength(2);
    expect(t.store.getState().runtime.climate.phase).toBe('ready');
  });

  it('branch() drops the running and pending jobs and leaves the status idle', async () => {
    const t = setup();
    t.coord.request('full', false);
    await tick();
    t.coord.request('scrub', false); // pending
    expect(t.store.getState().runtime.climate.phase).toBe('computing');
    t.coord.branch();
    expect(t.jobs[0].cancelled).toBe(true);
    await tick();
    expect(t.jobs).toHaveLength(1); // the pending job was dropped too
    expect(t.applied).toHaveLength(0);
    expect(t.coord.busy).toBe(false);
    expect(t.store.getState().runtime.climate.phase).toBe('none');
    // A new request after the branch runs normally.
    t.coord.request('full', false);
    await tick();
    t.finish(t.jobs[1]);
    await tick();
    expect(t.applied).toHaveLength(1);
  });
});
