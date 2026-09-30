/** Worker factories (Vite bundles `new Worker(new URL(…), { type: 'module' })` as module workers). */
import type { AppWorkers } from './controller';

export const browserWorkers: AppWorkers = {
  sim: () => new Worker(new URL('../worker/sim.worker.ts', import.meta.url), { type: 'module', name: 'worldgen-sim' }),
  paint: () => new Worker(new URL('../worker/paint.worker.ts', import.meta.url), { type: 'module', name: 'worldgen-paint' }),
  climate: () => new Worker(new URL('../worker/climate.worker.ts', import.meta.url), { type: 'module', name: 'worldgen-climate' }),
};
