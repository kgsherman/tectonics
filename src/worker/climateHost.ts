/**
 * Climate worker logic (SPEC.md §10): runs computeClimate, one job at a time. Cancellation is done
 * by the main thread (terminate + respawn), so a job simply runs to completion here. The result is
 * kept as the next warm start and therefore leaves the worker by structured clone — once to the
 * main thread and once to each paint worker (primary and playback helpers) over its MessageChannel.
 */
import { computeClimate } from '../climate/climate';
import type { ClimateResult } from '../core/types';
import { errorMessage, type ClimateEvent, type ClimatePortMessage, type ClimateRequest, type PostFn } from './protocol';

export interface ClimateHostEnv {
  post: PostFn<ClimateEvent>;
  now: () => number;
}

interface PortLike {
  postMessage(msg: ClimatePortMessage): void;
}

/** Minimum progress change between two progress events (keeps the channel quiet). */
const PROGRESS_STEP = 0.02;

export class ClimateHost {
  /** Climate → paint channels by painter slot. */
  private ports: PortLike[] = [];
  private last: ClimateResult | null = null;

  constructor(private readonly env: ClimateHostEnv) {}

  handle(msg: ClimateRequest): void {
    switch (msg.type) {
      case 'connect':
        this.ports[msg.painter ?? 0] = msg.port;
        return;
      case 'compute':
        this.compute(msg);
        return;
      default: {
        const never: never = msg;
        throw new Error(`climate worker: unknown request ${JSON.stringify((never as { type?: unknown }).type)}`);
      }
    }
  }

  private compute(msg: Extract<ClimateRequest, { type: 'compute' }>): void {
    const { reqId, params } = msg;
    const t0 = this.env.now();
    let lastStage = '';
    let lastFraction = -1;
    const onProgress = (stage: string, fraction: number): void => {
      if (stage === lastStage && fraction - lastFraction < PROGRESS_STEP && fraction < 1) return;
      lastStage = stage;
      lastFraction = fraction;
      this.env.post({ type: 'progress', reqId, stage, fraction });
    };
    try {
      const prev = this.last;
      const warm = msg.warm && prev && prev.w === Math.round(params.gridW) && prev.h === Math.round(params.gridH) ? prev : null;
      const climate = computeClimate(msg.input, params, onProgress, warm);
      this.last = climate;
      const ms = this.env.now() - t0;
      for (const port of this.ports) port?.postMessage({ type: 'climate', climate });
      this.env.post({ type: 'result', reqId, climate, purpose: msg.purpose, ms });
    } catch (e) {
      this.env.post({ type: 'error', reqId, message: errorMessage(e) });
    }
  }
}
