/** Tiny ring buffer of timings (ms) with percentile summaries, for the editor's frame budget checks. */
export interface PerfSummary {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

export class PerfRing {
  private readonly buf: Float64Array;
  private n = 0;
  private at = 0;

  constructor(size: number) {
    this.buf = new Float64Array(Math.max(1, size));
  }

  push(ms: number): void {
    this.buf[this.at] = ms;
    this.at = (this.at + 1) % this.buf.length;
    if (this.n < this.buf.length) this.n++;
  }

  clear(): void {
    this.n = 0;
    this.at = 0;
  }

  summary(): PerfSummary {
    const n = this.n;
    if (n === 0) return { count: 0, mean: 0, p50: 0, p95: 0, max: 0 };
    const v = Array.from(this.buf.subarray(0, n)).sort((a, b) => a - b);
    const q = (f: number) => v[Math.min(n - 1, Math.max(0, Math.round(f * (n - 1))))];
    const round = (x: number) => Math.round(x * 100) / 100;
    return { count: n, mean: round(v.reduce((s, x) => s + x, 0) / n), p50: round(q(0.5)), p95: round(q(0.95)), max: round(v[n - 1]) };
  }
}
