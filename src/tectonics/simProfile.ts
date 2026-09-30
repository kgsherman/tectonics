/**
 * Optional phase timing of the simulation (diagnostics and perf work; off by default, no cost when
 * off beyond a flag test per phase). Enable with `simProfile.enabled = true`, read `simProfile.ms`.
 */
export const simProfile = {
  enabled: false,
  /** Accumulated wall time per phase label, ms. */
  ms: {} as Record<string, number>,
  /** Number of accumulated samples per label. */
  calls: {} as Record<string, number>,
  reset(): void {
    this.ms = {};
    this.calls = {};
  },
};

const clock = (): number => globalThis.performance?.now?.() ?? Date.now();

/** Start timing (returns 0 when profiling is off). */
export function profStart(): number {
  return simProfile.enabled ? clock() : 0;
}

/** Add the time since `t0` to `label`; returns a fresh start time for chaining. */
export function profLap(label: string, t0: number): number {
  if (!simProfile.enabled) return 0;
  const t = clock();
  simProfile.ms[label] = (simProfile.ms[label] ?? 0) + (t - t0);
  simProfile.calls[label] = (simProfile.calls[label] ?? 0) + 1;
  return t;
}
