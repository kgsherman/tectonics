/**
 * The sim and paint workers' logic wired together in one thread: same message routing
 * (`requestTarget`), same channel semantics (structured clone, delivery in a later task). Used by
 * the Node tests and tools (the app always runs the two real workers).
 */
import type { ClimateResult } from '../core/types';
import type { ClimateShelf } from './climateShelf';
import type { KeyframeStore } from './keyframes';
import { PaintHost, type PortLike } from './paintHost';
import { requestTarget, type PostFn, type SimEvent, type SimRequest } from './protocol';
import { SimHost } from './simHost';
import type { PaintCache } from '../render/paint';

export interface InlineEnv {
  post: PostFn<SimEvent>;
  schedule: (fn: () => void) => void;
  now: () => number;
  keyframes?: KeyframeStore;
  climates?: ClimateShelf;
  paintCache?: PaintCache;
}

/** Two connected in-process ports: postMessage structured-clones and delivers in a later task. */
export function inlineChannel(schedule: (fn: () => void) => void): [PortLike, PortLike] {
  const make = (): PortLike & { peer?: PortLike } => ({ onmessage: null });
  const a = make();
  const b = make();
  const wire = (from: PortLike, to: PortLike): void => {
    from.postMessage = (msg: unknown) => {
      const data = structuredClone(msg);
      schedule(() => to.onmessage?.({ data } as MessageEvent));
    };
  };
  wire(a, b);
  wire(b, a);
  return [a, b];
}

export class InlinePipeline {
  readonly sim: SimHost;
  readonly paint: PaintHost;

  constructor(env: InlineEnv) {
    this.sim = new SimHost({ post: env.post, schedule: env.schedule, now: env.now, keyframes: env.keyframes });
    this.paint = new PaintHost({ post: env.post, schedule: env.schedule, now: env.now, climates: env.climates, paintCache: env.paintCache });
    const [toPaint, toSim] = inlineChannel(env.schedule);
    this.sim.connectPaint(toPaint);
    this.paint.handle({ type: 'connectSim', reqId: 0, epoch: 0, port: toSim as unknown as MessagePort });
  }

  /** Route a main-thread request to the worker that owns it. */
  handle(msg: SimRequest): void {
    if (requestTarget(msg.type) === 'paint') this.paint.handle(msg);
    else this.sim.handle(msg);
  }

  /** A climate from the climate worker (it is delivered to the paint worker). */
  receiveClimate(c: ClimateResult): boolean {
    return this.paint.receiveClimate(c);
  }
}
