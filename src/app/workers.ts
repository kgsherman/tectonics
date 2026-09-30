/** Worker factories (Vite bundles `new Worker(new URL(…), { type: 'module' })` as module workers). */
import type { AppWorkers } from './controller';

/**
 * Playback helper paint workers: one when the machine has cores and memory to spare (painting a
 * 1024×512 frame is the slowest pipeline stage at 100k cells; a helper paints every other frame).
 * `?paintHelpers=N` (0–3) overrides it, for diagnostics and benchmarks.
 */
export function defaultPaintHelpers(
  cores: number | undefined, memoryGb: number | undefined, override: string | null = null,
): number {
  if (override !== null && override.trim() !== '' && Number.isFinite(Number(override))) {
    return Math.max(0, Math.min(3, Math.floor(Number(override))));
  }
  return (cores ?? 4) >= 6 && (memoryGb ?? 8) >= 4 ? 1 : 0;
}

const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
const query = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;

export const browserWorkers: AppWorkers = {
  sim: () => new Worker(new URL('../worker/sim.worker.ts', import.meta.url), { type: 'module', name: 'worldgen-sim' }),
  paint: (slot = 0) => new Worker(new URL('../worker/paint.worker.ts', import.meta.url), {
    type: 'module', name: slot ? `worldgen-paint-helper-${slot}` : 'worldgen-paint',
  }),
  climate: () => new Worker(new URL('../worker/climate.worker.ts', import.meta.url), { type: 'module', name: 'worldgen-climate' }),
  paintHelpers: defaultPaintHelpers(nav?.hardwareConcurrency, nav?.deviceMemory, query?.get('paintHelpers') ?? null),
};
