/**
 * Typed message protocol between the main thread and the three workers (SPEC.md §10).
 *
 *  main ⇄ sim worker         SimRequest / SimEvent (requests routed by `requestTarget`)
 *  main ⇄ paint worker       the paint-side SimRequests (paint, frameAck, exportImage, …) / SimEvent
 *  sim ⇄ paint worker        SimToPaint / PaintToSim over a MessageChannel
 *  main ⇄ climate worker     ClimateRequest / ClimateEvent
 *  climate → paint worker    ClimatePortMessage over a MessageChannel
 *
 * Playback is a two-stage pipeline: the sim worker steps and posts each new snapshot (structured
 * clone; the sim keeps its memoized copy) to a paint worker, which paints it while the sim computes
 * the next step. Credits keep it tight: the sim steps again only once a paint worker has *taken*
 * its last snapshot (PaintToSim 'taken'), and a paint worker takes a snapshot only while fewer
 * than FrameGate.max of its frames are unacknowledged by the main thread (frameAck).
 *
 * Painter slots: slot 0 is the primary paint worker (stills, exports, playback); optional helper
 * slots 1..k paint playback frames only, so painting — the slower stage at 100k cells — runs on
 * several threads. The sim hands successive playback snapshots to whichever painter is free (round
 * robin); frames carry their painter slot (acks go back to it) and the sim's show sequence number,
 * so the main thread shows them in order and never an older state after a newer one (PlaybackSequencer).
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
  /**
   * Draw the flow glyphs of the currents layer (arrow streamlets). False while animated current
   * particles show the same flow over it: particles and glyphs would overlap. Undefined = true.
   * Exports always draw them (particles are not exported).
   */
  flowGlyphs?: boolean;
  /**
   * Creation order on the main thread. Display settings reach the paint worker on two paths (directly
   * with paint requests, and relayed by the sim worker with pause/step/scrub): the paint worker keeps
   * the newest by `seq`, so a relayed older copy never overrides a newer direct one. Undefined = always
   * accepted (tests, tools).
   */
  seq?: number;
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
  /** Frames per second over the last second of playback (the main thread counts the frames it shows). */
  framesPerSec: number;
  /** Wall time of one simulation step, ms. */
  lastStepMs: number;
  /** Paint time of the last frame (paint worker), ms. */
  lastPaintMs: number;
  /** Building the world snapshot after a step (sim worker), ms. */
  lastSnapshotMs?: number;
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
  /** main → paint worker `painter` (slot, default 0): its end of a climate → paint channel. */
  | (Req & { type: 'connectClimate'; port: MessagePort; painter?: number })
  /** main → sim worker: its end of the sim ⇄ paint channel of painter slot `index` (default 0). */
  | (Req & { type: 'connectPaint'; port: MessagePort; index?: number })
  /** main → paint worker: its end of the sim ⇄ paint channel; `index` is its painter slot (0 = primary, default). */
  | (Req & { type: 'connectSim'; port: MessagePort; index?: number })
  /** main → sim worker: helper painter `index` (≥ 1) died; stop handing it playback snapshots. */
  | (Req & { type: 'dropPainter'; index: number })
  | (Req & { type: 'generate'; meshN: number; params: GenerateParams; tectonic: TectonicParams; display: DisplaySettings })
  | (Req & { type: 'loadDraft'; draft: WorldDraft; tectonic: TectonicParams; display: DisplaySettings })
  | (Req & { type: 'generateDraft'; params: GenerateParams })
  | (Req & { type: 'getDraft' })
  | (Req & { type: 'play'; stepsPerFrame: number; display: DisplaySettings })
  | (Req & { type: 'pause'; display: DisplaySettings })
  | (Req & { type: 'step'; steps: number; display: DisplaySettings })
  | (Req & { type: 'setSpeed'; stepsPerFrame: number })
  /** A playback frame was received; routed to the painter slot that painted it (default 0). */
  | (Req & { type: 'frameAck'; frameId: number; painter?: number })
  | (Req & { type: 'setTectonicParams'; params: TectonicParams })
  | (Req & { type: 'paint'; display: DisplaySettings; quality: PaintQuality; parts: PaintParts })
  | (Req & { type: 'showKeyframe'; index: number | null; display: DisplaySettings })
  | (Req & { type: 'playFromKeyframe'; index: number; display: DisplaySettings })
  | (Req & { type: 'climateInput'; params: ClimateParams })
  | (Req & { type: 'exportImage'; display: DisplaySettings; width: number; height: number });

export type SimRequestType = SimRequest['type'];

/** Requests the paint worker handles; every other request goes to the sim worker. */
const PAINT_REQUESTS: ReadonlySet<SimRequestType> = new Set<SimRequestType>(['connectClimate', 'connectSim', 'paint', 'frameAck', 'exportImage']);

export function requestTarget(type: SimRequestType): 'sim' | 'paint' {
  return PAINT_REQUESTS.has(type) ? 'paint' : 'sim';
}

/** Reply payload per request type (requests that reply). */
export interface SimReplyMap {
  connectClimate: null;
  connectPaint: null;
  connectSim: null;
  dropPainter: null;
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
  /**
   * Null when unchanged: the display height map depends only on the snapshot, size, quality, sea level
   * and detail, so month and layer changes do not resend (or re-upload) it. Within one epoch the main
   * thread applies every frame, so "unchanged" always refers to a height map it holds.
   */
  heightMap: Float32Array | null;
  /** Null when no overlay flag is set (or the overlay was not repainted). */
  overlay: Uint8ClampedArray | null;
  /** False when the overlay is unchanged (keep the previous one); `overlay` is then null. */
  overlayRepainted: boolean;
  snapshotId: number;
  time: number;
  /** Climate used for painting (0 = none). */
  climateId: number;
  /** Keyframe index being shown, or null for the live state. */
  keyframe: number | null;
  paintMs: number;
  /** Painter slot that painted it (0 = primary); frameAck goes back to it. Undefined = 0. */
  painter?: number;
  /** The sim's show sequence number of the painted state (playback order; 0 for direct repaints). */
  showSeq?: number;
  /** Playback frames: show sequence number of this playback's first frame (the order starts there). */
  playFrom?: number;
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
/* sim worker ⇄ paint worker                                            */
/* ------------------------------------------------------------------ */

/** A state for the paint worker to put on screen. */
export interface ShowMessage {
  type: 'show';
  /** Monotonic per sim worker; echoed by 'taken'. */
  seq: number;
  epoch: number;
  /** Main-thread request that produced it (pause, step, …), 0 for playback and automatic repaints. */
  reqId: number;
  kind: 'play' | 'still';
  /** Structured clone of the sim's (memoized) snapshot or of a history keyframe. */
  snapshot: WorldSnapshot;
  /** Keyframe index on screen, null for the live state. */
  keyframe: number | null;
  /** Display settings relayed from the main-thread request, null when unchanged since the last show. */
  display: DisplaySettings | null;
  quality: PaintQuality;
  parts: PaintParts;
  /** Paint a quick preview before the full-quality frame (first look after load / scrub). */
  previewFirst: boolean;
  /** Playback: `seq` of this playback's first snapshot (frames are shown in order from there). */
  playFrom?: number;
}

export type SimToPaint =
  /** A new world: mesh is set when its resolution changed (structured clone), seed drives the painter's detail. */
  | { type: 'world'; epoch: number; meshN: number; mesh: SphereMesh | null; seed: number }
  | ShowMessage
  /**
   * Playback started: every painter stops still work now, before its first playback snapshot
   * arrives (with helpers, the first snapshots may go to another painter).
   */
  | { type: 'start'; epoch: number }
  /** Playback stopped: drop a pending playback snapshot. */
  | { type: 'stop'; epoch: number }
  /** A climate input was built from snapshot `snapshotId` (time `time`): climates for it belong to this world. */
  | { type: 'climateSource'; snapshotId: number; time: number }
  /** History branched at `time`: climates and climate sources of later states are void. */
  | { type: 'branch'; time: number };

/** The paint worker started painting playback snapshot `seq`: the sim may step again. */
export type PaintToSim = { type: 'taken'; seq: number };

/* ------------------------------------------------------------------ */
/* climate worker                                                       */
/* ------------------------------------------------------------------ */

export type ClimateRequest =
  /** A climate → paint channel for painter slot `painter` (default 0); results go to every connected painter. */
  | { type: 'connect'; reqId: number; epoch: number; port: MessagePort; painter?: number }
  | {
      type: 'compute'; reqId: number; epoch: number; input: ClimateInput; params: ClimateParams; purpose: ClimatePurpose;
      /** Warm-start from the worker's previous result (same world evolving); false right after a new world loads. */
      warm: boolean;
    };

export type ClimateEvent =
  | { type: 'progress'; reqId: number; stage: string; fraction: number }
  | { type: 'result'; reqId: number; climate: ClimateResult; purpose: ClimatePurpose; ms: number }
  | { type: 'error'; reqId: number; message: string };

/** climate worker → paint worker (MessageChannel). */
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
 * Used by the paint worker; acks for frames sent before a reset are ignored.
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
 * Main-thread playback sequencing: with several painters, playback frames can arrive out of order
 * (a helper finishes frame k+1 before the primary finishes k). Frames are shown in show order
 * within an epoch: a frame whose predecessor is missing waits up to `holdMs` for it (then it is
 * shown anyway: the predecessor is late or lost); a frame older than one already shown is dropped
 * (time never steps backwards). A new epoch starts afresh.
 */
export class PlaybackSequencer<F extends { epoch: number; showSeq?: number; playFrom?: number }> {
  private epoch = -Infinity;
  private last = -Infinity;
  /** A frame of this epoch was taken (before that, the first frame may wait longer: see START_HOLD_MS). */
  private started = false;
  private buf: Array<{ f: F; seq: number; at: number }> = [];
  /** Frames dropped: older than a frame already shown (or overflowing the buffer). */
  dropped = 0;
  /** Frames shown without their predecessor (it never came within `holdMs`). */
  gaps = 0;

  /** `holdMs` may be retuned to the frame interval (PlaybackPresenter: ≈ 3 frames). */
  constructor(public holdMs = 150, readonly maxBuffered = 4) {}

  get size(): number {
    return this.buf.length;
  }

  push(f: F, now: number): void {
    if (f.epoch > this.epoch) {
      this.epoch = f.epoch;
      this.last = -Infinity;
      this.started = false;
      this.dropped += this.buf.length;
      this.buf = [];
    } else if (f.epoch < this.epoch) {
      this.dropped++;
      return;
    }
    const seq = f.showSeq ?? 0;
    // Knowing where this playback starts, its first frame waits for a predecessor like any other.
    if (this.last === -Infinity && f.playFrom !== undefined && f.playFrom <= seq) this.last = f.playFrom - 1;
    if (seq <= this.last || this.buf.some((b) => b.seq === seq)) {
      this.dropped++;
      return;
    }
    let i = this.buf.length;
    while (i > 0 && this.buf[i - 1].seq > seq) i--;
    this.buf.splice(i, 0, { f, seq, at: now });
    this.trim();
  }

  /**
   * More than `maxBuffered` frames wait: whatever the head waits for has taken too long. A missing
   * predecessor is given up (late or lost: a gap), so the head can be shown now; while the display
   * cannot keep up, the oldest frames are skipped. (Dropping a head that waits for its predecessor
   * would restart the hold with every arrival — the next head is younger — so a late or lost first
   * frame froze the whole playback.) One slot of slack keeps a predecessor that just arrived into a
   * full buffer.
   */
  private trim(): void {
    if (this.buf.length <= this.maxBuffered) return;
    const head = this.buf[0];
    if (this.last !== -Infinity && head.seq !== this.last + 1) {
      this.gaps++;
      this.last = head.seq - 1;
    }
    while (this.buf.length > this.maxBuffered + 1) {
      this.last = this.buf.shift()!.seq;
      this.dropped++;
    }
  }

  /** The next frame to show now, or null (nothing buffered, or its predecessor may still come). */
  take(now: number): F | null {
    const wait = this.waitMs(now);
    if (wait === null || wait > 0) return null;
    const b = this.buf.shift()!;
    if (this.last !== -Infinity && b.seq !== this.last + 1) this.gaps++;
    this.last = b.seq;
    this.started = true;
    return b.f;
  }

  /** Milliseconds until the head frame may be shown (0 = now), null when nothing is buffered. */
  waitMs(now: number): number | null {
    const b = this.buf[0];
    if (!b) return null;
    if (this.last === -Infinity || b.seq === this.last + 1) return 0;
    // The first frame of a playback may wait longer: the painter of its predecessor can still be
    // finishing a still frame when playback starts.
    const hold = this.started ? this.holdMs : Math.max(this.holdMs, PlaybackSequencer.START_HOLD_MS);
    return Math.max(0, hold - (now - b.at));
  }

  /** Longest wait for a playback's first frame (ms). */
  static readonly START_HOLD_MS = 400;

  /** Forget buffered frames (a still replaced the picture). */
  clear(): void {
    this.buf = [];
  }

  /**
   * A playback frame of `epoch` is on screen or queued for it: a still of that epoch arriving now
   * was painted before playback started (a helper's frames can overtake it) and is older.
   */
  hasShown(epoch: number): boolean {
    return epoch === this.epoch && this.last !== -Infinity;
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
