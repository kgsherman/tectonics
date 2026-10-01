/**
 * The sim and paint workers' logic wired together in one thread: same message routing
 * (`requestTarget`, painter slots as SimClient routes them), same channel semantics (structured
 * clone, delivery in a later task). Used by the Node tests and tools (the app runs real workers).
 */
import type { ClimateResult } from '../core/types';
import type { ClimateShelf } from './climateShelf';
import type { KeyframeStore } from './keyframes';
import { PaintHost, type PaintHostEnv, type PortLike } from './paintHost';
import { requestTarget, type PostFn, type SimEvent, type SimRequest } from './protocol';
import { SimHost, type SimHostEnv } from './simHost';
import type { PaintCache } from '../render/paint';

export interface InlineEnv {
  post: PostFn<SimEvent>;
  schedule: (fn: () => void) => void;
  now: () => number;
  keyframes?: KeyframeStore;
  climates?: ClimateShelf;
  paintCache?: PaintCache;
  /** Paint-side idle release of the painter's scratch memory (see PaintHostEnv). */
  releaseScratch?: PaintHostEnv['releaseScratch'];
  idleReleaseMs?: number;
  later?: PaintHostEnv['later'];
  /** Helper painters (playback only) besides the primary. Default 0. */
  helpers?: number;
  /** Adaptive playback frames (see SimHostEnv). */
  adaptiveFrames?: SimHostEnv['adaptiveFrames'];
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
  /** The primary painter (slot 0). */
  readonly paint: PaintHost;
  /** Every painter by slot (painters[0] === paint). */
  readonly painters: PaintHost[];

  constructor(env: InlineEnv) {
    this.sim = new SimHost({ post: env.post, schedule: env.schedule, now: env.now, keyframes: env.keyframes, adaptiveFrames: env.adaptiveFrames });
    this.paint = new PaintHost({
      post: env.post, schedule: env.schedule, now: env.now, climates: env.climates, paintCache: env.paintCache,
      releaseScratch: env.releaseScratch, idleReleaseMs: env.idleReleaseMs, later: env.later,
    });
    this.painters = [this.paint];
    for (let i = 0; i < (env.helpers ?? 0); i++) {
      this.painters.push(new PaintHost({ post: env.post, schedule: env.schedule, now: env.now }));
    }
    this.painters.forEach((p, index) => {
      const [toPaint, toSim] = inlineChannel(env.schedule);
      this.sim.connectPaint(toPaint, index);
      p.handle({ type: 'connectSim', reqId: 0, epoch: 0, port: toSim as unknown as MessagePort, index });
    });
  }

  /** Route a main-thread request to the worker that owns it (as SimClient does). */
  handle(msg: SimRequest): void {
    if (requestTarget(msg.type) !== 'paint') return this.sim.handle(msg);
    if (msg.type === 'frameAck') return (this.painters[msg.painter ?? 0] ?? this.paint).handle(msg);
    if (msg.type === 'connectClimate') return (this.painters[msg.painter ?? 0] ?? this.paint).handle(msg);
    this.paint.handle(msg);
    // Display settings reach the helpers too (they answer nothing).
    if (msg.type === 'paint') for (const h of this.painters.slice(1)) h.handle({ ...msg, reqId: 0 });
  }

  /** A climate from the climate worker (delivered to every painter; the primary's answer is returned). */
  receiveClimate(c: ClimateResult): boolean {
    for (const h of this.painters.slice(1)) h.receiveClimate(structuredClone(c));
    return this.paint.receiveClimate(c);
  }
}
