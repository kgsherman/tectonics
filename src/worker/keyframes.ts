/**
 * History keyframes for the timeline scrubber (SPEC.md §10 "History").
 *
 * A snapshot is recorded every `interval` Myr. Memory is capped in bytes: when the store exceeds
 * its budget every other keyframe is dropped (indices 1, 3, 5, …) and the interval doubles, so the
 * surviving keyframes stay evenly spaced at the new interval and recording continues seamlessly.
 * Snapshots are kept by reference (the sim allocates fresh arrays per snapshot) and must leave the
 * worker by structured clone.
 */
import type { WorldDraft, WorldSnapshot } from '../core/types';
import type { KeyframeInfo } from './protocol';

export interface Keyframe {
  time: number;
  /** Sim step count at this keyframe (resume RNG position). */
  steps: number;
  snapshot: WorldSnapshot;
  /**
   * Exact sim state at this keyframe (`sim.toDraft()`), used by "Play from here". The display
   * snapshot is not a faithful resume source: its elevation carries transient trench offsets
   * (down to −7.5 km) and sub-cell interpolation that would be baked into the new sim's crust.
   * Optional so callers without a sim (tests, older data) fall back to draftFromSnapshot.
   */
  draft?: WorldDraft;
  bytes: number;
}

export const DEFAULT_KEYFRAME_INTERVAL_MYR = 5;
export const DEFAULT_KEYFRAME_BUDGET_BYTES = 256 * 1024 * 1024;
/** Tolerance for float accumulation of `time` (dt = 0.1 steps etc.). */
const TIME_EPS = 1e-6;

/** Approximate retained size of a draft (typed arrays + plate records). */
export function draftBytes(d: WorldDraft): number {
  return (
    d.plate.byteLength + d.crust.byteLength + d.elev.byteLength + d.age.byteLength + (d.orogeny?.byteLength ?? 0) +
    256 * d.plates.length + 64 * d.hotspots.length + 128
  );
}

/** Approximate retained size of a snapshot (typed arrays + plate records). */
export function snapshotBytes(s: WorldSnapshot): number {
  return (
    s.plate.byteLength + s.elev.byteLength + s.crust.byteLength + s.age.byteLength + s.boundary.byteLength +
    s.orogeny.byteLength + 256 * s.plates.length + 64 * s.hotspots.length + 128
  );
}

export class KeyframeStore {
  private frames: Keyframe[] = [];
  private intervalMyr: number;
  private totalBytes = 0;

  constructor(
    private readonly baseInterval = DEFAULT_KEYFRAME_INTERVAL_MYR,
    readonly budgetBytes = DEFAULT_KEYFRAME_BUDGET_BYTES,
  ) {
    if (!(baseInterval > 0)) throw new Error(`KeyframeStore: interval must be > 0 (got ${baseInterval})`);
    if (!(budgetBytes > 0)) throw new Error(`KeyframeStore: budget must be > 0 (got ${budgetBytes})`);
    this.intervalMyr = baseInterval;
  }

  get interval(): number {
    return this.intervalMyr;
  }

  get count(): number {
    return this.frames.length;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  /** True when a keyframe at `time` is due (store empty, or ≥ interval since the last one). */
  isDue(time: number): boolean {
    const last = this.frames[this.frames.length - 1];
    return !last || time >= last.time + this.intervalMyr - TIME_EPS;
  }

  /**
   * Record `snapshot()` if a keyframe is due at `time`. The provider is only called when needed
   * (building a snapshot is not free). Returns true if a keyframe was added.
   */
  offer(time: number, steps: number, snapshot: () => WorldSnapshot, draft?: () => WorldDraft): boolean {
    if (!this.isDue(time)) return false;
    this.add(time, steps, snapshot(), draft?.());
    return true;
  }

  /** Unconditionally append (times must be non-decreasing), then enforce the byte budget. */
  add(time: number, steps: number, snapshot: WorldSnapshot, draft?: WorldDraft): void {
    const last = this.frames[this.frames.length - 1];
    if (last && time < last.time - TIME_EPS) {
      throw new Error(`KeyframeStore.add: time ${time} precedes the last keyframe (${last.time})`);
    }
    const bytes = snapshotBytes(snapshot) + (draft ? draftBytes(draft) : 0);
    this.frames.push({ time, steps, snapshot, draft, bytes });
    this.totalBytes += bytes;
    this.enforceBudget();
  }

  at(index: number): Keyframe {
    const k = this.frames[index];
    if (!k) throw new Error(`KeyframeStore: no keyframe ${index} (have ${this.frames.length})`);
    return k;
  }

  /** Keep keyframes 0..index (inclusive); drop the later ones ("Play from here" branches history). */
  truncateAfter(index: number): void {
    if (index < -1) index = -1;
    const dropped = this.frames.splice(index + 1);
    for (const k of dropped) this.totalBytes -= k.bytes;
  }

  clear(): void {
    this.frames = [];
    this.totalBytes = 0;
    this.intervalMyr = this.baseInterval;
  }

  list(): KeyframeInfo[] {
    return this.frames.map((k) => ({ time: k.time, steps: k.steps }));
  }

  /** Index of the keyframe closest in time (−1 if empty). */
  nearestIndex(time: number): number {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < this.frames.length; i++) {
      const d = Math.abs(this.frames[i].time - time);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  private enforceBudget(): void {
    while (this.totalBytes > this.budgetBytes && this.frames.length > 2) {
      const kept: Keyframe[] = [];
      let bytes = 0;
      for (let i = 0; i < this.frames.length; i += 2) {
        kept.push(this.frames[i]);
        bytes += this.frames[i].bytes;
      }
      this.frames = kept;
      this.totalBytes = bytes;
      this.intervalMyr *= 2;
    }
  }
}
