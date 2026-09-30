/**
 * Client of the shared cloud worker (cloudsWorker.ts): runs cloudsJobs.ts jobs off the main thread.
 *
 * Jobs go through named channels (one per renderer instance and purpose). A channel has at most one
 * job in flight and one pending: a newer job replaces the pending one (whose promise resolves to
 * null), so a stream of updates (density slider, month playback) never queues up stale work, while
 * the in-flight result is still delivered (it is newer than what is on screen).
 *
 * Without Worker support (Node tests) or after a worker failure, jobs run on the calling thread in a
 * macrotask (still asynchronous, same ordering semantics).
 */
import { runCloudJob, type CloudJob, type CloudJobResult, type ResultOf } from './cloudsJobs';

type Resolve = (r: CloudJobResult | null) => void;

interface Pending {
  job: CloudJob;
  resolve: Resolve;
}

interface Channel {
  /** Id of the job in flight (0 = none). */
  inFlight: number;
  pending: Pending | null;
}

interface InFlight {
  channel: string;
  job: CloudJob;
  resolve: Resolve;
}

type WorkerFactory = () => Worker;

const defaultFactory: WorkerFactory | null = typeof Worker === 'undefined'
  ? null
  : () => new Worker(new URL('./cloudsWorker.ts', import.meta.url), { type: 'module', name: 'worldgen-clouds' });

let factory: WorkerFactory | null = defaultFactory;
let shared: CloudWorkerClient | null = null;

/**
 * Overrides how the cloud worker is created (null: run jobs on the calling thread). Takes effect for
 * clients created afterwards (the shared client is recreated).
 */
export function setCloudWorkerFactory(f: WorkerFactory | null): void {
  factory = f;
  shared?.dispose();
  shared = null;
}

/** The shared client (lazily created). */
export function cloudWorker(): CloudWorkerClient {
  shared ??= new CloudWorkerClient(factory);
  return shared;
}

export class CloudWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly channels = new Map<string, Channel>();
  private readonly inFlight = new Map<number, InFlight>();
  /** Jobs run on the calling thread (no worker, or it failed). */
  private local: boolean;
  /** Jobs completed (for diagnostics / tests). */
  completed = 0;

  constructor(private readonly makeWorker: WorkerFactory | null) {
    this.local = makeWorker === null;
  }

  /** True when jobs run in a worker. */
  get threaded(): boolean {
    return !this.local;
  }

  /** Number of jobs in flight or pending (all channels). */
  get busy(): number {
    let n = this.inFlight.size;
    for (const c of this.channels.values()) if (c.pending) n++;
    return n;
  }

  /**
   * Runs `job` on `channel`. Resolves with its result, or null when a newer job on the same channel
   * replaced it before it started. The job's inputs are copied (structured clone, never
   * transferred: a failed worker's jobs are re-run on the calling thread).
   */
  run<J extends CloudJob>(job: J, channel: string): Promise<ResultOf<J> | null> {
    return new Promise<CloudJobResult | null>((resolve) => {
      let ch = this.channels.get(channel);
      if (!ch) {
        ch = { inFlight: 0, pending: null };
        this.channels.set(channel, ch);
      }
      if (ch.inFlight) {
        ch.pending?.resolve(null);
        ch.pending = { job, resolve };
        return;
      }
      this.dispatch(channel, ch, job, resolve);
    }) as Promise<ResultOf<J> | null>;
  }

  /** Drops the pending job of a channel (resolves it with null); an in-flight job still completes. */
  cancel(channel: string): void {
    const ch = this.channels.get(channel);
    if (ch?.pending) {
      ch.pending.resolve(null);
      ch.pending = null;
    }
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const f of this.inFlight.values()) f.resolve(null);
    this.inFlight.clear();
    for (const c of this.channels.values()) c.pending?.resolve(null);
    this.channels.clear();
  }

  private dispatch(channel: string, ch: Channel, job: CloudJob, resolve: Resolve): void {
    const id = this.nextId++;
    ch.inFlight = id;
    this.inFlight.set(id, { channel, job, resolve });
    const w = this.local ? null : this.ensureWorker();
    if (w) {
      w.postMessage({ id, job });
    } else {
      this.runLocal(id);
    }
  }

  private runLocal(id: number): void {
    setTimeout(() => {
      const f = this.inFlight.get(id);
      if (!f) return;
      let result: CloudJobResult | null = null;
      try {
        result = runCloudJob(f.job).result;
      } catch (err) {
        console.error('cloud job failed', err);
      }
      this.finish(id, result);
    }, 0);
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      const w = this.makeWorker!();
      w.onmessage = (e: MessageEvent<{ id: number; result?: CloudJobResult; error?: string }>) => {
        const { id, result, error } = e.data;
        if (error) console.error('cloud worker job failed:', error);
        this.finish(id, result ?? null);
      };
      w.onerror = (e) => {
        e.preventDefault?.();
        this.fallBack(`cloud worker error: ${e.message}`);
      };
      w.onmessageerror = () => this.fallBack('cloud worker message error');
      this.worker = w;
      return w;
    } catch (err) {
      this.fallBack(`cloud worker unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Worker failed: run everything (including the jobs it had) on the calling thread from now on. */
  private fallBack(reason: string): void {
    if (this.local) return;
    console.warn(`${reason}; computing clouds on the main thread`);
    this.local = true;
    this.worker?.terminate();
    this.worker = null;
    for (const id of this.inFlight.keys()) this.runLocal(id);
  }

  private finish(id: number, result: CloudJobResult | null): void {
    const f = this.inFlight.get(id);
    if (!f) return;
    this.inFlight.delete(id);
    this.completed++;
    const ch = this.channels.get(f.channel);
    f.resolve(result);
    if (!ch || ch.inFlight !== id) return;
    ch.inFlight = 0;
    const next = ch.pending;
    if (next) {
      ch.pending = null;
      this.dispatch(f.channel, ch, next.job, next.resolve);
    }
  }
}
