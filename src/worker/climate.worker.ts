/// <reference lib="webworker" />
/** Climate worker entry: computeClimate only (SPEC.md §10). Logic lives in ClimateHost. */
import { ClimateHost } from './climateHost';
import { errorMessage, type ClimateEvent, type ClimateRequest } from './protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

const host = new ClimateHost({
  post: (msg: ClimateEvent, transfer?: Transferable[]) => scope.postMessage(msg, transfer ?? []),
  now: () => performance.now(),
});

scope.onmessage = (e: MessageEvent<ClimateRequest>) => {
  try {
    host.handle(e.data);
  } catch (err) {
    scope.postMessage({ type: 'error', reqId: e.data?.reqId ?? 0, message: errorMessage(err) } satisfies ClimateEvent);
  }
};
