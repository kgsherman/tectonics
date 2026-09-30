/**
 * Scheduling policy for climate jobs (SPEC.md §10): one job runs at a time, at most one waits
 * (latest wins). A preemptive submission (user changed parameters, pressed Compute, paused) cancels
 * the running job — the caller terminates and respawns the climate worker. Live-climate jobs during
 * playback never preempt. A job may chain a follow-up (fast preview → full refinement), which is
 * dropped if a newer job was queued meanwhile.
 */
import type { ClimatePurpose } from '../worker/protocol';

export interface ClimateJob {
  purpose: ClimatePurpose;
  fast: boolean;
  gridW: number;
  gridH: number;
  /** Started automatically when this job completes, unless a newer job is waiting. */
  then?: ClimateJob;
}

export type SubmitDecision =
  | { action: 'start'; job: ClimateJob }
  | { action: 'cancelAndStart'; job: ClimateJob }
  | { action: 'queued' };

export class ClimateQueue {
  private runningJob: ClimateJob | null = null;
  private pendingJob: ClimateJob | null = null;

  get running(): ClimateJob | null {
    return this.runningJob;
  }

  get pending(): ClimateJob | null {
    return this.pendingJob;
  }

  get idle(): boolean {
    return this.runningJob === null;
  }

  submit(job: ClimateJob, preempt: boolean): SubmitDecision {
    if (!this.runningJob) {
      this.runningJob = job;
      this.pendingJob = null;
      return { action: 'start', job };
    }
    if (preempt) {
      this.runningJob = job;
      this.pendingJob = null;
      return { action: 'cancelAndStart', job };
    }
    this.pendingJob = job;
    return { action: 'queued' };
  }

  /** The running job finished (or failed): returns the next job to start, if any (now running). */
  finish(): ClimateJob | null {
    const next = this.pendingJob ?? this.runningJob?.then ?? null;
    this.pendingJob = null;
    this.runningJob = next;
    return next;
  }

  /** Forget everything (new world loaded, worker restarted). Returns true if a job was running. */
  clear(): boolean {
    const was = this.runningJob !== null;
    this.runningJob = null;
    this.pendingJob = null;
    return was;
  }
}

/** Live (fast) climate is due when the sim advanced `interval` Myr since the last live request. */
export function liveClimateDue(time: number, lastRequestTime: number | null, intervalMyr: number): boolean {
  if (lastRequestTime === null) return true;
  return Math.abs(time - lastRequestTime) >= intervalMyr - 1e-9;
}

/**
 * Overall progress of a climate job from the model's per-stage progress (each stage reports 0..1):
 * stages weighted by their typical share of the run time, so the bar never jumps back.
 */
const STAGE_SPANS: Record<string, [number, number]> = {
  input: [0, 0.03], dynamics: [0.03, 0.51], hydrology: [0.51, 0.97], koppen: [0.97, 1], done: [1, 1],
};

export function overallClimateProgress(stage: string, fraction: number): number {
  const span = STAGE_SPANS[stage];
  const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  if (!span) return f;
  return span[0] + (span[1] - span[0]) * f;
}
