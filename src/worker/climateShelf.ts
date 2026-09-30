/**
 * Climates received by the sim/paint worker, bounded in bytes. The newest one paints the live
 * state; a history keyframe is painted with the nearest OLDER climate (by source time), so the
 * scrubber never shows a climate from the future of the frame it displays.
 */
import type { ClimateParams, ClimateResult } from '../core/types';

/** Parameters that change the physics (grid size and fast mode only change fidelity). */
const PHYSICS_KEYS: ReadonlyArray<keyof ClimateParams> = [
  'axialTilt', 'solarMultiplier', 'globalTempOffset', 'seaLevel', 'moisture', 'oceanCurrents', 'retrograde',
];

export function samePhysics(a: ClimateParams, b: ClimateParams): boolean {
  return PHYSICS_KEYS.every((k) => a[k] === b[k]);
}

export const DEFAULT_CLIMATE_SHELF_BYTES = 160 * 1024 * 1024;

/** Sum of the typed-array payload of a climate. */
export function climateBytes(c: ClimateResult): number {
  let s = 1024;
  for (const v of Object.values(c)) if (ArrayBuffer.isView(v)) s += v.byteLength;
  return s;
}

export class ClimateShelf {
  /** Oldest arrival first. */
  private items: Array<{ climate: ClimateResult; bytes: number }> = [];
  private used = 0;

  constructor(readonly budgetBytes = DEFAULT_CLIMATE_SHELF_BYTES) {}

  get count(): number {
    return this.items.length;
  }

  get bytes(): number {
    return this.used;
  }

  /** The most recently added climate (null if none). */
  latest(): ClimateResult | null {
    return this.items.length ? this.items[this.items.length - 1].climate : null;
  }

  /**
   * Add (replacing an entry with the same id), evicting the oldest arrivals beyond the budget. The
   * newest always stays. Climates computed with different planet parameters (tilt, sea level, …)
   * are dropped: after a parameter change the scrubber must not show the old physics.
   */
  add(c: ClimateResult): void {
    this.remove((x) => x.id === c.id || !samePhysics(x.params, c.params));
    const bytes = climateBytes(c);
    this.items.push({ climate: c, bytes });
    this.used += bytes;
    while (this.used > this.budgetBytes && this.items.length > 1) {
      const old = this.items.shift()!;
      this.used -= old.bytes;
    }
  }

  /**
   * Climate for a state at `time`: the one with the greatest sourceTime ≤ time (ties → newest
   * arrival); if every climate is younger, the one closest in time. Null when empty.
   */
  forTime(time: number): ClimateResult | null {
    let best: ClimateResult | null = null;
    for (const { climate } of this.items) {
      if (climate.sourceTime <= time + 1e-6 && (!best || climate.sourceTime >= best.sourceTime)) best = climate;
    }
    if (best) return best;
    let bd = Infinity;
    for (const { climate } of this.items) {
      const d = Math.abs(climate.sourceTime - time);
      if (d < bd) {
        bd = d;
        best = climate;
      }
    }
    return best;
  }

  /** Drop climates computed for states after `time` (history branched at a keyframe). */
  dropAfter(time: number): void {
    this.remove((c) => c.sourceTime > time + 1e-6);
  }

  clear(): void {
    this.items = [];
    this.used = 0;
  }

  private remove(pred: (c: ClimateResult) => boolean): void {
    const keep: typeof this.items = [];
    for (const it of this.items) {
      if (pred(it.climate)) this.used -= it.bytes;
      else keep.push(it);
    }
    this.items = keep;
  }
}
