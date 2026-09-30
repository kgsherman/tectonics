/// <reference lib="webworker" />
/** Paint worker entry (SPEC.md §10): paints the states the sim worker sends. Logic lives in PaintHost. */
import { PaintHost } from './paintHost';
import { errorMessage, type SimEvent, type SimRequest } from './protocol';
import { macrotaskScheduler } from './schedule';

const scope = self as unknown as DedicatedWorkerGlobalScope;

const host = new PaintHost({
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
