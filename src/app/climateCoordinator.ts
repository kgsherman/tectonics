/**
 * Runs climate jobs: ClimateQueue policy → climate input from the sim worker (for the displayed
 * state) → ClimateClient (climate worker) → result to the app. The paint worker receives its own
 * copy over the MessageChannel and repaints by itself.
 */
import type { ClimateParams, ClimateResult } from '../core/types';
import type { ClimatePurpose } from '../worker/protocol';
import { CancelledError, type ClimateClient } from './climateClient';
import { ClimateQueue, liveClimateDue, overallClimateProgress, type ClimateJob } from './climateQueue';
import { CLIMATE_GRID_FULL, CLIMATE_GRID_LIVE } from './schema';
import type { SimClient } from './simClient';
import type { Action, AppState } from './state';
import type { Store } from './store';

export interface ClimateCoordinatorDeps {
  store: Store<AppState, Action>;
  sim: SimClient;
  climate: ClimateClient;
  epoch: () => number;
  onResult: (climate: ClimateResult, ms: number) => void;
  onError: (message: string) => void;
}

function makeJob(purpose: ClimatePurpose): ClimateJob {
  const full: ClimateJob = { purpose: 'full', fast: false, gridW: CLIMATE_GRID_FULL.w, gridH: CLIMATE_GRID_FULL.h };
  const fast = { fast: true, gridW: CLIMATE_GRID_LIVE.w, gridH: CLIMATE_GRID_LIVE.h };
  switch (purpose) {
    case 'full':
      return full;
    case 'refine':
      // Quick fast look first, then the full-resolution climate.
      return { purpose, ...fast, then: full };
    case 'live':
    case 'scrub':
      return { purpose, ...fast };
  }
}

export class ClimateCoordinator {
  private readonly queue = new ClimateQueue();
  /** Warm-start allowed (the climate worker's previous result belongs to this world). */
  private warm = false;
  private lastLiveTime: number | null = null;

  constructor(private readonly d: ClimateCoordinatorDeps) {}

  get busy(): boolean {
    return !this.queue.idle;
  }

  /** Submit a job. `preempt` cancels a running job (terminate + respawn of the climate worker). */
  request(purpose: ClimatePurpose, preempt: boolean): void {
    if (!this.d.store.getState().runtime.worldLoaded) return;
    const decision = this.queue.submit(makeJob(purpose), preempt);
    if (decision.action === 'queued') return;
    if (decision.action === 'cancelAndStart') this.d.climate.cancel();
    void this.run(decision.job);
  }

  /** Called with playback status: a fast climate every `liveIntervalMyr`. */
  playbackTick(time: number): void {
    const s = this.d.store.getState().settings.climate;
    if (!s.live || !liveClimateDue(time, this.lastLiveTime, s.liveIntervalMyr)) return;
    this.lastLiveTime = time;
    this.request('live', false);
  }

  /** A different world was loaded (or history branched): drop everything in flight. */
  resetWorld(): void {
    if (this.queue.clear()) this.d.climate.cancel();
    this.warm = false;
    this.lastLiveTime = null;
  }

  /**
   * History branched ("Play from here"): jobs in flight or waiting may be for states of the
   * discarded future, so drop them (warm start stays valid: same world). Live cadence restarts.
   */
  branch(): void {
    this.lastLiveTime = null;
    if (!this.queue.clear()) return;
    this.d.climate.cancel();
    this.d.store.dispatch({ type: 'climateIdle' });
  }

  private params(job: ClimateJob): ClimateParams {
    const st = this.d.store.getState().settings;
    const c = st.climate;
    return {
      gridW: job.gridW, gridH: job.gridH, fast: job.fast, seaLevel: st.seaLevel,
      axialTilt: c.axialTilt, solarMultiplier: c.solarMultiplier, globalTempOffset: c.globalTempOffset,
      moisture: c.moisture, oceanCurrents: c.oceanCurrents, retrograde: c.retrograde,
    };
  }

  private async run(job: ClimateJob): Promise<void> {
    const { store } = this.d;
    store.dispatch({ type: 'climateStarted', purpose: job.purpose });
    const params = this.params(job);
    try {
      const input = await this.d.sim.request({ type: 'climateInput', epoch: this.d.epoch(), params });
      if (this.queue.running !== job) return; // superseded while the input was built
      store.dispatch({ type: 'climateProgress', stage: 'input', fraction: overallClimateProgress('input', 1) });
      const out = await this.d.climate.compute(input, params, job.purpose, this.warm, (stage, fraction) => {
        if (this.queue.running === job) store.dispatch({ type: 'climateProgress', stage, fraction: overallClimateProgress(stage, fraction) });
      });
      if (this.queue.running !== job) return;
      this.warm = true;
      this.d.onResult(out.climate, out.ms);
    } catch (e) {
      if (e instanceof CancelledError || this.queue.running !== job) return;
      const msg = e instanceof Error ? e.message : String(e);
      store.dispatch({ type: 'climateFailed', error: msg });
      this.d.onError(msg);
    }
    const next = this.queue.finish();
    if (next) void this.run(next);
    else if (store.getState().runtime.climate.phase === 'computing') store.dispatch({ type: 'climateIdle' });
  }
}
