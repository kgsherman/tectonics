/**
 * Typed message protocol between the main thread and the two workers (SPEC.md §10).
 *
 *  main ⇄ sim/paint worker   SimRequest / SimEvent
 *  main ⇄ climate worker     ClimateRequest / ClimateEvent
 *  climate → sim worker      ClimatePortMessage over a MessageChannel
 *
 * Every request carries `reqId` (0 = fire-and-forget) and `epoch`. The main thread bumps its epoch
 * whenever the displayed state changes under it — pause (also on editor entry during playback),
 * step, scrub, branch, load — always together with a request carrying the new epoch (the worker
 * tags frames with the highest epoch it has seen), and drops frames tagged with an older epoch.
 *
 * Transfer rules (SPEC §2.1): only freshly painted buffers (frame rgba / heightMap / overlay,
 * exported images) and freshly built climate inputs are transferred. Anything a producer keeps
 * (sim snapshots, keyframes, cached climates, the worker's mesh) leaves a thread by structured clone.
 */
import type {
  ClimateInput, ClimateParams, ClimateResult, GenerateParams, LayerId, OverlayFlags, SphereMesh, TectonicParams,
  TectonicStats, WorldDraft, WorldSnapshot,
} from '../core/types';

/* ------------------------------------------------------------------ */
/* Shared payloads                                                      */
/* ------------------------------------------------------------------ */

/** Everything the painter needs to know about what is on screen. */
export interface DisplaySettings {
  layer: LayerId;
  /** 0..11, or -1 for the annual view. */
  month: number;
  overlays: OverlayFlags;
  seaLevel: number;
  /** Terrain detail amplification 0..2. */
  detail: number;
  /** Paused / full-quality frame size. */
  fullWidth: number;
  fullHeight: number;
  /** Playback (preview-quality) frame size. */
  previewWidth: number;
  previewHeight: number;
}

export type PaintQuality = 'preview' | 'full';

/** 'all' repaints base + height + overlay; 'overlay' only the overlay (base unchanged). */
export type PaintParts = 'all' | 'overlay';

export interface KeyframeInfo {
  time: number;
  steps: number;
}

export interface PerfStats {
  /** Simulation steps per second over the last second of playback. */
  stepsPerSec: number;
  /** Frames produced per second over the last second of playback. */
  framesPerSec: number;
  lastStepMs: number;
  lastPaintMs: number;
}

/** Why a climate was computed (drives UI labels and scheduling). */
export type ClimatePurpose = 'live' | 'full' | 'refine' | 'scrub';

/* ------------------------------------------------------------------ */
/* main → sim worker                                                    */
/* ------------------------------------------------------------------ */

interface Req {
  reqId: number;
  epoch: number;
}

export type SimRequest =
  | (Req & { type: 'connectClimate'; port: MessagePort })
  | (Req & { type: 'generate'; meshN: number; params: GenerateParams; tectonic: TectonicParams; display: DisplaySettings })
  | (Req & { type: 'loadDraft'; draft: WorldDraft; tectonic: TectonicParams; display: DisplaySettings })
  | (Req & { type: 'generateDraft'; params: GenerateParams })
  | (Req & { type: 'getDraft' })
  | (Req & { type: 'play'; stepsPerFrame: number; display: DisplaySettings })
  | (Req & { type: 'pause'; display: DisplaySettings })
  | (Req & { type: 'step'; steps: number; display: DisplaySettings })
  | (Req & { type: 'setSpeed'; stepsPerFrame: number })
  | (Req & { type: 'frameAck'; frameId: number })
  | (Req & { type: 'setTectonicParams'; params: TectonicParams })
  | (Req & { type: 'paint'; display: DisplaySettings; quality: PaintQuality; parts: PaintParts })
  | (Req & { type: 'showKeyframe'; index: number | null; display: DisplaySettings })
  | (Req & { type: 'playFromKeyframe'; index: number; display: DisplaySettings })
  | (Req & { type: 'climateInput'; params: ClimateParams })
  | (Req & { type: 'exportImage'; display: DisplaySettings; width: number; height: number });

export type SimRequestType = SimRequest['type'];

/** Reply payload per request type (requests that reply). */
export interface SimReplyMap {
  connectClimate: null;
  generate: WorldLoaded;
  loadDraft: WorldLoaded;
  generateDraft: WorldDraft;
  getDraft: WorldDraft;
  play: null;
  pause: null;
  step: null;
  setSpeed: null;
  frameAck: null;
  setTectonicParams: null;
  paint: null;
  showKeyframe: null;
  playFromKeyframe: WorldLoaded;
  climateInput: ClimateInput;
  exportImage: ExportedImage;
}

export interface WorldLoaded {
  meshN: number;
  seed: number;
  time: number;
  stats: TectonicStats;
}

export interface ExportedImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  overlay: Uint8ClampedArray | null;
  time: number;
}

/* ------------------------------------------------------------------ */
/* sim worker → main                                                    */
/* ------------------------------------------------------------------ */

export interface FrameMessage {
  type: 'frame';
  /** Monotonic per worker. Playback frames must be acknowledged with frameAck. */
  frameId: number;
  /** reqId of the paint/pause/step/... request that produced it; 0 for playback frames. */
  reqId: number;
  epoch: number;
  kind: 'play' | 'still';
  quality: PaintQuality;
  layer: LayerId;
  month: number;
  width: number;
  height: number;
  /** Null when only the overlay was repainted. */
  rgba: Uint8ClampedArray | null;
  heightMap: Float32Array | null;
  /** Null when no overlay flag is set (or the overlay was not repainted). */
  overlay: Uint8ClampedArray | null;
  overlayRepainted: boolean;
  snapshotId: number;
  time: number;
  /** Climate used for painting (0 = none). */
  climateId: number;
  /** Keyframe index being shown, or null for the live state. */
  keyframe: number | null;
  paintMs: number;
}

export type SimEvent =
  | { type: 'reply'; reqId: number; ok: true; data: unknown }
  | { type: 'reply'; reqId: number; ok: false; error: string }
  | { type: 'mesh'; meshN: number; mesh: SphereMesh }
  | FrameMessage
  | { type: 'snapshot'; epoch: number; snapshot: WorldSnapshot; stats: TectonicStats; keyframe: number | null }
  | { type: 'history'; keyframes: KeyframeInfo[]; intervalMyr: number; bytes: number; viewing: number | null }
  | { type: 'status'; playing: boolean; time: number; steps: number; perf: PerfStats }
  | { type: 'climateApplied'; climateId: number; sourceTime: number }
  | { type: 'superseded'; reqId: number }
  | { type: 'error'; reqId: number; message: string };

/* ------------------------------------------------------------------ */
/* climate worker                                                       */
/* ------------------------------------------------------------------ */

export type ClimateRequest =
  | { type: 'connect'; reqId: number; epoch: number; port: MessagePort }
  | {
      type: 'compute'; reqId: number; epoch: number; input: ClimateInput; params: ClimateParams; purpose: ClimatePurpose;
      /** Warm-start from the worker's previous result (same world evolving); false right after a new world loads. */
      warm: boolean;
    };

export type ClimateEvent =
  | { type: 'progress'; reqId: number; stage: string; fraction: number }
  | { type: 'result'; reqId: number; climate: ClimateResult; purpose: ClimatePurpose; ms: number }
  | { type: 'error'; reqId: number; message: string };

/** climate worker → sim worker (MessageChannel). */
export type ClimatePortMessage = { type: 'climate'; climate: ClimateResult };

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/** Minimal postMessage signature shared by Worker, DedicatedWorkerGlobalScope and MessagePort. */
export type PostFn<M> = (msg: M, transfer?: Transferable[]) => void;

/**
 * Distinct ArrayBuffers backing the given (fresh) typed arrays, for a transfer list. Nulls are
 * skipped; views sharing one buffer yield it once (transferring twice throws DataCloneError).
 */
export function transferList(...arrays: Array<ArrayBufferView | null | undefined>): Transferable[] {
  const out: Transferable[] = [];
  for (const a of arrays) {
    if (!a) continue;
    const b = a.buffer;
    if (!(b instanceof ArrayBuffer) || b.byteLength === 0) continue;
    if (!out.includes(b)) out.push(b);
  }
  return out;
}

/** Transfer list for a ClimateInput built fresh for this message. */
export function climateInputTransfers(input: ClimateInput): Transferable[] {
  return transferList(input.elev, input.landFraction);
}

/** Human-readable message from anything thrown. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** True when a message tagged `epoch` belongs to an older state than `current` and must be dropped. */
export function isStaleEpoch(epoch: number, current: number): boolean {
  return epoch < current;
}

/**
 * Backpressure for playback frames: at most `max` unacknowledged frames in flight.
 * Used by the sim worker; acks for frames sent before a reset are ignored.
 */
export class FrameGate {
  private inFlight = new Set<number>();

  constructor(readonly max: number = 2) {
    if (!(max >= 1)) throw new Error(`FrameGate: max must be ≥ 1 (got ${max})`);
  }

  get pending(): number {
    return this.inFlight.size;
  }

  canSend(): boolean {
    return this.inFlight.size < this.max;
  }

  sent(frameId: number): void {
    this.inFlight.add(frameId);
  }

  /** Returns true if the ack released a frame this gate was tracking. */
  ack(frameId: number): boolean {
    return this.inFlight.delete(frameId);
  }

  reset(): void {
    this.inFlight.clear();
  }
}

/**
 * Latest-wins coalescing with one request in flight: `submit` sends immediately when idle,
 * otherwise replaces the pending request; `complete` (for the in-flight id) sends the pending one.
 * Used on the main thread for paint requests (the worker coalesces too).
 */
export class LatestWins<T> {
  private inFlightId = 0;
  private pending: T | null = null;

  /**
   * `send` dispatches a request and returns its reqId. `merge` combines a new request with the
   * pending one (default: the new one replaces it).
   */
  constructor(
    private readonly send: (req: T) => number,
    private readonly merge: (pending: T, next: T) => T = (_p, n) => n,
  ) {}

  get busy(): boolean {
    return this.inFlightId !== 0;
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  submit(req: T): void {
    if (this.inFlightId === 0) this.inFlightId = this.send(req);
    else this.pending = this.pending === null ? req : this.merge(this.pending, req);
  }

  /** The request `reqId` finished (successfully, superseded or failed). Unknown ids are ignored. */
  complete(reqId: number): void {
    if (reqId === 0 || reqId !== this.inFlightId) return;
    this.inFlightId = 0;
    const next = this.pending;
    this.pending = null;
    if (next !== null) this.inFlightId = this.send(next);
  }

  /** Forget the in-flight request (e.g. its worker died) and drop the pending one. */
  reset(): void {
    this.inFlightId = 0;
    this.pending = null;
  }
}
