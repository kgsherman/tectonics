/**
 * Procedural surface detail gating (pure, DOM-free).
 *
 * The GPU detail noise (albedo/normal micro-relief and coast breakup, visible only when zoomed in) is
 * anchored to the planet frame. While the tectonic playback streams new height maps every frame the
 * coasts move with the plates, so world-anchored detail would swim relative to them. The fader hides
 * the detail while the height map keeps changing and fades it back in once the surface has been
 * static for a moment (paused world, month changes that resend identical heights).
 */

/** Cheap order-sensitive signature of a height map (≈4k samples; identical rasters → equal values). */
export function heightSignature(data: ArrayLike<number>, n = data.length): number {
  if (n <= 0) return 0;
  const step = Math.max(1, Math.floor(n / 4096));
  let hsh = 2166136261 ^ n;
  for (let i = 0; i < n; i += step) {
    // Quantize to 1 cm so float noise-free resends compare equal.
    const q = Math.round((data[i] as number) * 100) | 0;
    hsh = Math.imul(hsh ^ q, 16777619);
  }
  return hsh >>> 0;
}

export class DetailFader {
  private signature = -1;
  /** Time (ms) of the last height change; −∞ = never changed (detail fully on). */
  private changedAt = -Infinity;

  /**
   * @param holdMs detail stays hidden this long after the latest height change
   * @param fadeMs then fades in over this long
   */
  constructor(private readonly holdMs = 1200, private readonly fadeMs = 600) {}

  /** Records a (possibly unchanged) height map; returns true if it differs from the previous one. */
  noteHeights(signature: number, nowMs: number): boolean {
    if (signature === this.signature) return false;
    const first = this.signature === -1;
    this.signature = signature;
    // The first height map of a view is not "motion": show detail immediately.
    if (!first) this.changedAt = nowMs;
    return true;
  }

  /** Clears the history (height map removed). */
  reset(): void {
    this.signature = -1;
    this.changedAt = -Infinity;
  }

  /** Detail strength 0..1 at `nowMs`. */
  value(nowMs: number): number {
    const t = (nowMs - this.changedAt - this.holdMs) / this.fadeMs;
    if (!(t > 0)) return 0;
    if (t >= 1) return 1;
    return t * t * (3 - 2 * t);
  }

  /** True while the value will still change (callers keep rendering until it settles). */
  animating(nowMs: number): boolean {
    return nowMs - this.changedAt < this.holdMs + this.fadeMs;
  }
}
