/// <reference lib="webworker" />
/** Paint worker entry (SPEC.md §10): paints the states the sim worker sends. Logic lives in PaintHost. */
import * as painter from '../render/paint';
import { PaintHost } from './paintHost';
import { errorMessage, type SimEvent, type SimRequest } from './protocol';
import { macrotaskScheduler } from './schedule';

const scope = self as unknown as DedicatedWorkerGlobalScope;

/**
 * The painter's scratch-pool release (`releasePaintScratch(): number`), when it provides one: looked
 * up by name so this worker runs with painters that do not have it yet.
 */
const RELEASE_EXPORT = 'releasePaintScratch';
const release = (painter as unknown as Record<string, unknown>)[RELEASE_EXPORT];

const host = new PaintHost({
  post: (msg: SimEvent, transfer?: Transferable[]) => scope.postMessage(msg, transfer ?? []),
  schedule: macrotaskScheduler(),
  now: () => performance.now(),
  releaseScratch: typeof release === 'function' ? () => (release as () => number)() : undefined,
});

scope.onmessage = (e: MessageEvent<SimRequest>) => {
  try {
    host.handle(e.data);
  } catch (err) {
    scope.postMessage({ type: 'error', reqId: e.data?.reqId ?? 0, message: errorMessage(err) } satisfies SimEvent);
  }
};
