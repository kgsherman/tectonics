/** Events per second over a sliding window (frames shown on the main thread during playback). */
export class RateMeter {
  private times: number[] = [];

  constructor(private readonly windowMs = 1500) {}

  /** Record one event at time `t` (ms). */
  tick(t: number): void {
    this.times.push(t);
    this.trim(t);
  }

  /** Events per second at time `t`; 0 until two events fall inside the window. */
  rate(t: number): number {
    this.trim(t);
    const n = this.times.length;
    if (n < 2) return 0;
    const span = Math.max(t, this.times[n - 1]) - this.times[0];
    return span > 0 ? (1000 * (n - 1)) / span : 0;
  }

  reset(): void {
    this.times = [];
  }

  private trim(t: number): void {
    let i = 0;
    while (i < this.times.length && t - this.times[i] > this.windowMs) i++;
    if (i) this.times.splice(0, i);
  }
}
