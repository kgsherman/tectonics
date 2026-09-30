/**
 * Node worker-thread entry for the real-thread pipeline benchmark (app.pipeline.perf.test.ts): the
 * same SimHost / PaintHost code as the browser's sim and paint workers, selected by workerData.role.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { PaintHost } from '../../src/worker/paintHost';
import type { SimRequest } from '../../src/worker/protocol';
import { macrotaskScheduler } from '../../src/worker/schedule';
import { SimHost } from '../../src/worker/simHost';

const port = parentPort!;
const env = {
  post: (m: unknown, t?: Transferable[]) => port.postMessage(m, (t ?? []) as never),
  schedule: macrotaskScheduler(),
  now: () => performance.now(),
};
const host = (workerData as { role: 'sim' | 'paint' }).role === 'sim' ? new SimHost(env) : new PaintHost(env);
port.on('message', (m: SimRequest) => host.handle(m));
