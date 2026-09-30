/**
 * Main-thread client of the sim and paint workers, presented as one endpoint: request/reply promises
 * keyed by reqId (one id space; each request goes to the worker that owns it, `requestTarget`),
 * typed event subscriptions over both workers' events, and worker-crash handling (pending requests
 * reject, crash handlers fire). With a paint worker, the constructor also links the two workers with
 * a MessageChannel; without one, the single worker must handle every request (an InlinePipeline).
 */
import {
  errorMessage, requestTarget, type SimEvent, type SimReplyMap, type SimRequest, type SimRequestType,
} from '../worker/protocol';
import type { PortPair } from './climateClient';

/** The part of Worker the clients use (tests substitute an in-process fake). */
export interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  onmessageerror?: ((e: MessageEvent) => void) | null;
  terminate(): void;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A request as the caller writes it: reqId is assigned by the client. */
export type Outgoing = DistributiveOmit<SimRequest, 'reqId'>;
type EventOf<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  type: SimRequestType;
}

export class SimClient {
  private nextReqId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<(e: SimEvent) => void>>();
  private readonly crashHandlers = new Set<(message: string) => void>();
  private disposed = false;
  private crashed = false;

  constructor(
    private readonly worker: WorkerLike,
    private readonly paintWorker: WorkerLike | null = null,
    createChannel: () => PortPair = () => new MessageChannel(),
  ) {
    this.listen(worker, 'simulation');
    if (paintWorker) {
      this.listen(paintWorker, 'paint');
      const ch = createChannel();
      this.send({ type: 'connectPaint', epoch: 0, port: ch.port1 }, [ch.port1]);
      this.send({ type: 'connectSim', epoch: 0, port: ch.port2 }, [ch.port2]);
    }
  }

  private listen(w: WorkerLike, name: string): void {
    w.onmessage = (e: MessageEvent) => this.receive(e.data as SimEvent);
    w.onerror = (e: ErrorEvent) => {
      e.preventDefault?.();
      const msg = e.message || `the ${name} worker failed to start or crashed`;
      this.crashed = true;
      this.failAll(new Error(msg));
      for (const h of [...this.crashHandlers]) h(msg);
    };
    w.onmessageerror = () => this.emit({ type: 'error', reqId: 0, message: 'a worker message could not be deserialized' });
  }

  /** Send a request and await its typed reply. */
  request<M extends Outgoing>(msg: M, transfer?: Transferable[]): Promise<SimReplyMap[M['type']]> {
    const reqId = this.nextReqId++;
    return new Promise<SimReplyMap[M['type']]>((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('simulation worker disposed'));
        return;
      }
      this.pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, type: msg.type });
      this.post({ ...msg, reqId } as unknown as SimRequest, transfer, reqId);
    });
  }

  /** Fire-and-forget; returns the assigned reqId (frames/superseded events echo it). */
  send(msg: Outgoing, transfer?: Transferable[]): number {
    const reqId = this.nextReqId++;
    this.post({ ...msg, reqId } as unknown as SimRequest, transfer, 0);
    return reqId;
  }

  on<T extends SimEvent['type']>(type: T, handler: (e: EventOf<T>) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const h = handler as (e: SimEvent) => void;
    set.add(h);
    return () => set!.delete(h);
  }

  /** The worker died (failed to load, or an uncaught error escaped it): its state is gone. */
  onCrash(handler: (message: string) => void): () => void {
    this.crashHandlers.add(handler);
    return () => this.crashHandlers.delete(handler);
  }

  get isCrashed(): boolean {
    return this.crashed;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failAll(new Error('simulation worker disposed'));
    for (const w of [this.worker, this.paintWorker]) {
      if (!w) continue;
      w.onmessage = null;
      w.onerror = null;
      w.terminate();
    }
  }

  private post(msg: SimRequest, transfer: Transferable[] | undefined, awaitedId: number): void {
    if (this.disposed) return;
    const target = this.paintWorker && requestTarget(msg.type) === 'paint' ? this.paintWorker : this.worker;
    try {
      target.postMessage(msg, transfer ?? []);
    } catch (e) {
      const p = awaitedId ? this.pending.get(awaitedId) : undefined;
      if (p) {
        this.pending.delete(awaitedId);
        p.reject(new Error(`could not send ${msg.type}: ${errorMessage(e)}`));
      } else {
        this.emit({ type: 'error', reqId: msg.reqId, message: `could not send ${msg.type}: ${errorMessage(e)}` });
      }
    }
  }

  private receive(ev: SimEvent): void {
    if (ev.type === 'reply') {
      const p = this.pending.get(ev.reqId);
      if (!p) {
        // A fire-and-forget request (send) failed: surface it (listeners release its reqId).
        if (!ev.ok) this.emit({ type: 'error', reqId: ev.reqId, message: ev.error });
        return;
      }
      this.pending.delete(ev.reqId);
      if (ev.ok) p.resolve(ev.data);
      else p.reject(new Error(ev.error));
      return;
    }
    this.emit(ev);
  }

  private emit(ev: SimEvent): void {
    const set = this.handlers.get(ev.type);
    if (!set) return;
    for (const h of [...set]) {
      try {
        h(ev);
      } catch (e) {
        console.error(`worldgen: ${ev.type} handler failed`, e);
      }
    }
  }

  private failAll(err: Error): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(err);
  }
}
