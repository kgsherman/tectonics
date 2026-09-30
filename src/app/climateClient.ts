/**
 * Main-thread client of the climate worker. One job at a time (the ClimateQueue decides what runs);
 * cancel = terminate() + respawn (a running computeClimate cannot be interrupted otherwise). Each
 * (re)spawn creates a fresh MessageChannel per painter: port1 → climate worker, port2 → that
 * paint worker (the primary and each playback helper).
 */
import type { ClimateInput, ClimateParams, ClimateResult } from '../core/types';
import { climateInputTransfers, type ClimateEvent, type ClimatePurpose, type ClimateRequest } from '../worker/protocol';
import type { WorkerLike } from './simClient';

export class CancelledError extends Error {
  constructor() {
    super('climate computation cancelled');
    this.name = 'CancelledError';
  }
}

export interface ClimateOutcome {
  climate: ClimateResult;
  ms: number;
}

interface Job {
  reqId: number;
  resolve: (r: ClimateOutcome) => void;
  reject: (e: Error) => void;
  onProgress?: (stage: string, fraction: number) => void;
}

export interface PortPair {
  port1: MessagePort;
  port2: MessagePort;
}

export class ClimateClient {
  private worker: WorkerLike | null = null;
  private job: Job | null = null;
  private nextReqId = 1;
  private disposed = false;

  constructor(
    private readonly spawnWorker: () => WorkerLike,
    /** Hand the other end of a channel to paint worker slot `painter`. */
    private readonly connectSim: (port: MessagePort, painter: number) => void,
    private readonly createChannel: () => PortPair = () => new MessageChannel(),
    /** Paint workers that receive climates (primary + helpers). */
    private readonly painters = 1,
  ) {
    this.spawn();
  }

  get busy(): boolean {
    return this.job !== null;
  }

  compute(
    input: ClimateInput, params: ClimateParams, purpose: ClimatePurpose, warm: boolean,
    onProgress?: (stage: string, fraction: number) => void,
  ): Promise<ClimateOutcome> {
    if (this.disposed) return Promise.reject(new Error('climate worker disposed'));
    if (this.job) return Promise.reject(new Error('a climate job is already running'));
    if (!this.worker) this.spawn();
    const reqId = this.nextReqId++;
    return new Promise<ClimateOutcome>((resolve, reject) => {
      this.job = { reqId, resolve, reject, onProgress };
      const msg: ClimateRequest = { type: 'compute', reqId, epoch: 0, input, params, purpose, warm };
      try {
        this.worker!.postMessage(msg, climateInputTransfers(input));
      } catch (e) {
        this.job = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Abort the running job (terminate + respawn). Returns false when idle. */
  cancel(): boolean {
    const job = this.job;
    if (!job) return false;
    this.job = null;
    this.kill();
    if (!this.disposed) this.spawn();
    job.reject(new CancelledError());
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const job = this.job;
    this.job = null;
    this.kill();
    job?.reject(new CancelledError());
  }

  private spawn(): void {
    const w = this.spawnWorker();
    w.onmessage = (e: MessageEvent) => this.receive(e.data as ClimateEvent);
    w.onerror = (e: ErrorEvent) => {
      e.preventDefault?.();
      const msg = e.message || 'the climate worker failed to start or crashed';
      const job = this.job;
      this.job = null;
      this.kill();
      job?.reject(new Error(msg));
    };
    for (let painter = 0; painter < Math.max(1, this.painters); painter++) {
      const ch = this.createChannel();
      const connect: ClimateRequest = { type: 'connect', reqId: 0, epoch: 0, port: ch.port1, painter };
      w.postMessage(connect, [ch.port1]);
      this.connectSim(ch.port2, painter);
    }
    this.worker = w;
  }

  private kill(): void {
    if (!this.worker) return;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    this.worker = null;
  }

  private receive(ev: ClimateEvent): void {
    const job = this.job;
    if (!job || ev.reqId !== job.reqId) return;
    switch (ev.type) {
      case 'progress':
        job.onProgress?.(ev.stage, ev.fraction);
        return;
      case 'result':
        this.job = null;
        job.resolve({ climate: ev.climate, ms: ev.ms });
        return;
      case 'error':
        this.job = null;
        job.reject(new Error(ev.message));
        return;
    }
  }
}
