/// <reference lib="webworker" />
/** Sim worker entry (SPEC.md §10): tectonics, history, climate inputs. Logic lives in SimHost. */
import { errorMessage, type SimEvent, type SimRequest } from './protocol';
import { macrotaskScheduler } from './schedule';
import { SimHost } from './simHost';

const scope = self as unknown as DedicatedWorkerGlobalScope;

const host = new SimHost({
  post: (msg: SimEvent, transfer?: Transferable[]) => scope.postMessage(msg, transfer ?? []),
  schedule: macrotaskScheduler(),
  now: () => performance.now(),
});

scope.onmessage = (e: MessageEvent<SimRequest>) => {
  try {
    host.handle(e.data);
  } catch (err) {
    scope.postMessage({ type: 'error', reqId: e.data?.reqId ?? 0, message: errorMessage(err) } satisfies SimEvent);
  }
};
