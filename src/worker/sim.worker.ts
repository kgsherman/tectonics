/// <reference lib="webworker" />
/** Sim/paint worker entry (SPEC.md §10). Logic lives in SimHost. */
import { errorMessage, type SimEvent, type SimRequest } from './protocol';
import { SimHost } from './simHost';

const scope = self as unknown as DedicatedWorkerGlobalScope;

/** Macrotask scheduling via a private MessageChannel (setTimeout(0) is clamped to ≥ 4 ms when nested). */
const channel = new MessageChannel();
const queue: Array<() => void> = [];
channel.port1.onmessage = () => {
  const fn = queue.shift();
  fn?.();
};
function schedule(fn: () => void): void {
  queue.push(fn);
  channel.port2.postMessage(0);
}

const host = new SimHost({
  post: (msg: SimEvent, transfer?: Transferable[]) => scope.postMessage(msg, transfer ?? []),
  schedule,
  now: () => performance.now(),
});

scope.onmessage = (e: MessageEvent<SimRequest>) => {
  try {
    host.handle(e.data);
  } catch (err) {
    scope.postMessage({ type: 'error', reqId: e.data?.reqId ?? 0, message: errorMessage(err) } satisfies SimEvent);
  }
};
